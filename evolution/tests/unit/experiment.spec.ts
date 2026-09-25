/**
 * The two-sided experiment's own rules (S4-E §F.2), without a runtime: the
 * frozen identity block and its digest, the mechanical verdicts and their
 * recomputation, the v2 report's self-check, and the ledger family the
 * experiment writes — idempotency, uniqueness and the fold that refuses a
 * hand-forged line.
 *
 * What is *not* here: the runs themselves. Those need a real store, runtime and
 * verifier, and they live in `tests/integration/experiment-runner.spec.ts`.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { EvolutionProposal } from '../../src/evolution.ts'
import type {
  ExperimentSampleRecord,
  ExperimentStartedRecord,
  ExperimentView,
} from '../../src/experiment.ts'
import {
  buildExperimentReport,
  directoryDigest,
  experimentIdOf,
  experimentReportPath,
  experimentSampleKey,
  experimentSampleKeyOf,
  foldExperiments,
} from '../../src/experiment.ts'
import type {
  ExperimentSampleRole,
  ExperimentSide,
  ExperimentCriterionDetail,
  ExperimentSideDetail,
  FrozenExperiment,
  FrozenSample,
} from '../../src/replay.ts'
import {
  assertExperimentReport,
  canonicalJson,
  compareExperimentSides,
  digestOf,
  EXPERIMENT_COMPARER_VERSION,
  frozenDigestOf,
  overallExperimentVerdict,
  protectedInputsDigest,
} from '../../src/replay.ts'

function fixtureCtx() {
  return { reflect: { provide: () => {} }, effect: () => {} } as never
}

async function service(root?: string): Promise<{ svc: EvolutionService; root: string }> {
  const directory = root ?? (await mkdtemp(join(tmpdir(), 'experiment-ledger-')))
  const svc = new EvolutionService(fixtureCtx(), { root: directory, configFile: join(directory, 'config.yml') })
  // Every experiment record names a proposal that exists in the ledger — the
  // orchestrator reads it through `get` before it freezes anything — so the
  // fixtures propose p1 first, exactly as a live call would find it.
  await svc.propose({
    proposalId: 'p1',
    targetType: 'skill',
    targetId: 'fixture-skill',
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the fixture target failure',
    sourceRefs: ['diagnosis:d1'],
  }, 'root-1')
  return { svc, root: directory }
}

const CANDIDATE = { name: 'fixture-skill', sha256: 'a'.repeat(64) }
const HEX = (character: string): string => character.repeat(64)

/* -------------------------------------------------------------------------- *
 * Fixtures: one valid frozen block, and the ledger lines that carry it.
 * -------------------------------------------------------------------------- */

function frozenSample(overrides: Partial<FrozenSample> = {}): FrozenSample {
  return {
    taskId: 't-failure',
    role: 'observed-failure',
    contractDigest: HEX('1'),
    criteria: [{
      criterionId: 'ac1',
      verificationMode: 'deterministic',
      command: 'test -f answer.txt',
      protectedInputsDigest: protectedInputsDigest([]),
    }],
    observed: { outcome: 'failed', runId: 'r-historical' },
    ...overrides,
  }
}

function frozenFixture(overrides: Partial<FrozenExperiment> = {}): FrozenExperiment {
  return {
    proposalId: 'p1',
    repetition: 0,
    candidate: { ...CANDIDATE },
    productionBaseline: { name: CANDIDATE.name, sha256: HEX('2') },
    model: 'scripted:fixture',
    budget: { wallTimeMs: 60_000, maxTokens: 1_000, note: 'fixture budget' },
    samples: [
      frozenSample(),
      frozenSample({ taskId: 't-holdout', role: 'holdout', observed: { outcome: 'verified', runId: 'r-holdout' } }),
    ],
    snapshot: { sourceDir: '/tmp/experiment-snapshot', digest: HEX('3') },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: { baseline: 'none', candidate: 'extraSkillRoots: [sandbox/p1/skills]' },
    ...overrides,
  }
}

function criterion(criterionId: string, verdict: ExperimentCriterionDetail['verdict']): ExperimentCriterionDetail {
  return { criterionId, verdict, verifierId: 'command', verifierVersion: '1' }
}

function side(
  role: ExperimentSampleRole,
  which: ExperimentSide,
  overrides: Partial<ExperimentSideDetail> = {},
): ExperimentSideDetail {
  const verified = overrides.outcome === undefined || overrides.outcome === 'verified'
  return {
    taskId: which === 'baseline' ? `t-${role}-baseline` : `t-${role}-candidate`,
    role,
    side: which,
    outcome: 'verified',
    runId: `r-${which}`,
    reviewRef: `t-${which}#r-${which}`,
    evidenceRefs: [`e-${which}`],
    workspace: `/tmp/workspaces/${role}/${which}`,
    initialDigest: HEX('3'),
    criteria: [criterion('ac1', verified ? 'pass' : 'fail')],
    cost: { status: 'reported', metrics: { tokens: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    ...overrides,
  }
}

/** One valid v2 report: a fixed target failure and a holdout that does not degrade. */
function reportFixture(overrides: Record<string, unknown> = {}) {
  const frozen = frozenFixture()
  const samples = [
    {
      taskId: 't-failure',
      role: 'observed-failure',
      baseline: side('observed-failure', 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
      candidate: side('observed-failure', 'candidate'),
      verdict: 'fixed',
    },
    {
      taskId: 't-holdout',
      role: 'holdout',
      baseline: side('holdout', 'baseline'),
      candidate: side('holdout', 'candidate'),
      verdict: 'maintained',
    },
  ]
  return {
    formatVersion: 2,
    proposalId: 'p1',
    experimentId: 'e1',
    at: '2026-09-26T00:00:00.000Z',
    frozen,
    frozenDigest: frozenDigestOf(frozen),
    samples,
    verdict: 'fixed',
    ...overrides,
  }
}

function startedRecord(frozen: FrozenExperiment, overrides: Partial<ExperimentStartedRecord> = {}): ExperimentStartedRecord {
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(frozen.proposalId, frozenDigest)
  return {
    formatVersion: 1,
    kind: 'experiment_started',
    proposalId: frozen.proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: experimentReportPath(frozen.proposalId, experimentId),
    actor: 'root-1',
    at: '2026-09-26T00:00:00.000Z',
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- *
 * The frozen block and the digests it rests on.
 * -------------------------------------------------------------------------- */

describe('the frozen identity block', () => {
  it('hashes a value independently of key order, so a digest is an identity and not a spelling', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe(canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }))
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }))
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }))
  })

  it('digests a directory by sorted relative path and bytes, links by their target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(root, 'b.txt'), 'second')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'a.txt'), 'first')
    const first = await directoryDigest(root)

    // The order the files were created in is not the order they are digested in.
    const twin = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await mkdir(join(twin, 'nested'))
    await writeFile(join(twin, 'nested', 'a.txt'), 'first')
    await writeFile(join(twin, 'b.txt'), 'second')
    expect(await directoryDigest(twin)).toBe(first)

    // A changed byte is a changed input.
    await writeFile(join(twin, 'nested', 'a.txt'), 'FirsT')
    expect(await directoryDigest(twin)).not.toBe(first)

    // A link is digested by its target text, never followed: a copy keeps it a
    // link (`cp`'s default), so following it would describe bytes the workspace
    // never holds. Two directories whose link texts agree hash equal even when
    // the bytes behind them differ; a real file where the link is hashes
    // differently.
    const linked = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(root, 'plain.txt'), 'plain')
    await symlink('plain.txt', join(linked, 'plain.txt'))
    const moved = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(moved, 'plain.txt'), 'something else entirely')
    const movedLink = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await symlink('plain.txt', join(movedLink, 'plain.txt'))
    expect(await directoryDigest(linked)).toBe(await directoryDigest(movedLink))
    expect(await directoryDigest(linked)).not.toBe(await directoryDigest(root))

    for (const directory of [root, twin, linked, moved, movedLink]) await rm(directory, { recursive: true, force: true })
  })

  it('names the report path and the experiment id from the frozen block alone', () => {
    const frozen = frozenFixture()
    const digest = frozenDigestOf(frozen)
    const id = experimentIdOf(frozen.proposalId, digest)
    expect(id).toMatch(/^[a-f0-9]{16}$/)
    expect(experimentReportPath('p1', id)).toBe(`sandbox/p1/exp-${id}/experiment-report.json`)
    // Any member moving freezes a different experiment.
    expect(experimentIdOf('p1', frozenDigestOf(frozenFixture({ repetition: 1 })))).not.toBe(id)
    expect(experimentIdOf('p1', frozenDigestOf(frozenFixture({ model: 'scripted:other' })))).not.toBe(id)
    expect(experimentIdOf('p1', frozenDigestOf(frozenFixture({ budget: { note: 'smaller' } })))).not.toBe(id)
    expect(experimentIdOf('other', digest)).not.toBe(id)
  })
})

/* -------------------------------------------------------------------------- *
 * The mechanical verdicts.
 * -------------------------------------------------------------------------- */

describe('the mechanical verdicts', () => {
  const failureRole: ExperimentSampleRole = 'observed-failure'

  it('calls a reproduced failure that the candidate passes a fix', () => {
    const baseline = side(failureRole, 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] })
    const candidate = side(failureRole, 'candidate', { outcome: 'verified', criteria: [criterion('ac1', 'pass')] })
    expect(compareExperimentSides(failureRole, baseline, candidate)).toBe('fixed')
  })

  it('distinguishes a failure both sides reproduce from a fix and from an unreproduced baseline', () => {
    const bothFailed = compareExperimentSides(
      failureRole,
      side(failureRole, 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
      side(failureRole, 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
    )
    expect(bothFailed).toBe('both-failed')

    // The baseline did not reproduce the historical failure: nothing was fixed,
    // and no fix can be claimed from a comparison that never showed the failure.
    expect(compareExperimentSides(
      failureRole,
      side(failureRole, 'baseline'),
      side(failureRole, 'candidate'),
    )).toBe('not-fixed')

    // The candidate failed where the baseline did not: unfixed, and worse.
    expect(compareExperimentSides(
      failureRole,
      side(failureRole, 'baseline'),
      side(failureRole, 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
    )).toBe('not-fixed')
  })

  it('calls a regression or holdout sample regressed only when the candidate is worse', () => {
    for (const role of ['observed-regression', 'holdout'] as const) {
      expect(compareExperimentSides(role, side(role, 'baseline'), side(role, 'candidate'))).toBe('maintained')
      // A rank drop.
      expect(compareExperimentSides(
        role,
        side(role, 'baseline'),
        side(role, 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
      )).toBe('regressed')
      // A shared criterion flipping pass → fail, ranks unchanged.
      expect(compareExperimentSides(
        role,
        side(role, 'baseline', { criteria: [criterion('ac1', 'pass'), criterion('ac2', 'pass')] }),
        side(role, 'candidate', { criteria: [criterion('ac1', 'pass'), criterion('ac2', 'fail')] }),
      )).toBe('regressed')
      // An improvement is not a regression.
      expect(compareExperimentSides(
        role,
        side(role, 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
        side(role, 'candidate'),
      )).toBe('maintained')
    }
  })

  it('reads an unsettled side and a changed contract as inconclusive, never as a verdict on the candidate', () => {
    expect(compareExperimentSides(
      failureRole,
      side(failureRole, 'baseline', { outcome: 'cancelled', criteria: [] }),
      side(failureRole, 'candidate'),
    )).toBe('inconclusive')
    expect(compareExperimentSides(
      failureRole,
      side(failureRole, 'baseline', { outcome: 'interrupted', criteria: [], runId: undefined, taskId: undefined }),
      side(failureRole, 'candidate'),
    )).toBe('inconclusive')
    // A criterion that exists on one side only is a different contract, not a pass.
    expect(compareExperimentSides(
      failureRole,
      side(failureRole, 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
      side(failureRole, 'candidate', { criteria: [criterion('ac1', 'pass'), criterion('ac2', 'pass')] }),
    )).toBe('inconclusive')
  })

  it('keeps the six overall verdicts mechanically distinguishable', () => {
    const sample = (role: ExperimentSampleRole, verdict: string) => ({ role, verdict }) as never
    expect(overallExperimentVerdict([sample('observed-failure', 'fixed'), sample('holdout', 'maintained')])).toBe('fixed')
    expect(overallExperimentVerdict([sample('observed-failure', 'fixed'), sample('holdout', 'regressed')])).toBe('fixed-with-regression')
    expect(overallExperimentVerdict([sample('observed-failure', 'not-fixed'), sample('holdout', 'maintained')])).toBe('not-fixed')
    expect(overallExperimentVerdict([sample('observed-failure', 'both-failed'), sample('holdout', 'maintained')])).toBe('both-failed')
    expect(overallExperimentVerdict([sample('observed-failure', 'not-fixed'), sample('holdout', 'regressed')])).toBe('regressed')
    expect(overallExperimentVerdict([sample('observed-failure', 'inconclusive'), sample('holdout', 'maintained')])).toBe('inconclusive')
    // A regression outranks an unfixed target; an unsettled side outranks both.
    expect(overallExperimentVerdict([sample('observed-failure', 'fixed'), sample('observed-regression', 'regressed')])).toBe('fixed-with-regression')
    expect(overallExperimentVerdict([sample('observed-failure', 'both-failed'), sample('holdout', 'regressed')])).toBe('both-failed')
  })
})

/* -------------------------------------------------------------------------- *
 * The v2 report's self-check.
 * -------------------------------------------------------------------------- */

describe('assertExperimentReport', () => {
  it('accepts a report whose verdicts are exactly its evidence', () => {
    expect(() => assertExperimentReport(reportFixture())).not.toThrow()
  })

  it('refuses a report whose sample or overall verdict is not what its details recompute', () => {
    const sample = reportFixture()
    sample.samples[0]!.verdict = 'not-fixed' as never
    expect(() => assertExperimentReport(sample)).toThrow(/does not match its own evidence/)

    const overall = reportFixture()
    overall.verdict = 'fixed-with-regression' as never
    expect(() => assertExperimentReport(overall)).toThrow(/verdict "fixed-with-regression" does not match its samples/)
  })

  it('refuses a frozen block that does not hash to the digest the report names', () => {
    const report = reportFixture()
    report.frozenDigest = HEX('f')
    expect(() => assertExperimentReport(report)).toThrow(/frozenDigest does not match its frozen identity block/)

    const swapped = reportFixture()
    swapped.frozen = frozenFixture({ model: 'scripted:other' })
    expect(() => assertExperimentReport(swapped)).toThrow(/frozenDigest does not match/)
  })

  it('refuses a side that cites the sample\u2019s own historical run as this experiment\u2019s baseline', () => {
    const report = reportFixture()
    report.samples[0]!.baseline.runId = 'r-historical'
    expect(() => assertExperimentReport(report)).toThrow(/the sample's own historical run/)
  })

  it('refuses a side that names the sample\u2019s own task, and two sides sharing one workspace', () => {
    const sameTask = reportFixture()
    sameTask.samples[0]!.baseline.taskId = 't-failure'
    expect(() => assertExperimentReport(sameTask)).toThrow(/the sample's own historical task/)

    const shared = reportFixture()
    shared.samples[0]!.candidate.workspace = shared.samples[0]!.baseline.workspace
    expect(() => assertExperimentReport(shared)).toThrow(/share one workspace/)

    const missingTask = reportFixture()
    missingTask.samples[0]!.baseline.taskId = undefined
    expect(() => assertExperimentReport(missingTask)).toThrow(/settled a run and must name the replayed task/)
  })

  it('refuses a frozen block with no failure sample, no holdout, or an unknown comparer', () => {
    const noFailure = reportFixture()
    noFailure.frozen = frozenFixture({ samples: [frozenSample({ taskId: 't-holdout', role: 'holdout' })] })
    noFailure.frozenDigest = frozenDigestOf(noFailure.frozen)
    expect(() => assertExperimentReport(noFailure)).toThrow(/at least one observed-failure sample/)

    const noHoldout = reportFixture()
    noHoldout.frozen = frozenFixture({ samples: [frozenSample()] })
    noHoldout.frozenDigest = frozenDigestOf(noHoldout.frozen)
    expect(() => assertExperimentReport(noHoldout)).toThrow(/at least one holdout sample/)

    const unknownComparer = reportFixture()
    unknownComparer.frozen = frozenFixture({ comparerVersion: 'experiment-comparer@9' })
    unknownComparer.frozenDigest = frozenDigestOf(unknownComparer.frozen)
    expect(() => assertExperimentReport(unknownComparer)).toThrow(/comparerVersion must be "experiment-comparer@1"/)
  })

  it('refuses a verified side with no criteria, an interrupted side with no reason, and a cost with no explanation', () => {
    const noCriteria = reportFixture()
    noCriteria.samples[1]!.candidate.criteria = []
    expect(() => assertExperimentReport(noCriteria)).toThrow(/verified outcome needs criterion evidence/)

    const interrupted = reportFixture()
    Object.assign(interrupted.samples[1]!.candidate, { outcome: 'interrupted', criteria: [], initialDigest: undefined, reason: undefined, runId: undefined, taskId: undefined })
    interrupted.samples[1]!.verdict = 'inconclusive' as never
    interrupted.verdict = 'inconclusive' as never
    expect(() => assertExperimentReport(interrupted)).toThrow(/must carry the reason it has no terminal run/)

    const noReason = reportFixture()
    noReason.samples[1]!.candidate.cost = { status: 'unknown' } as never
    expect(() => assertExperimentReport(noReason)).toThrow(/must say why the cost is unknown/)
  })

  it('keeps v1 out of it: a v2 report is not a v1 report, whatever it carries', () => {
    const report = reportFixture()
    expect(report.formatVersion).toBe(2)
    expect(() => assertExperimentReport({ ...report, formatVersion: 1 })).toThrow(/formatVersion must be 2/)
  })
})

/* -------------------------------------------------------------------------- *
 * The ledger family: records, keys and the fold.
 * -------------------------------------------------------------------------- */

describe('the experiment ledger family', () => {
  it('records the frozen experiment once, refuses an inconsistent line, and freezes a different experiment under a different id', async () => {
    const { svc, root } = await service()
    const frozen = frozenFixture()
    const record = startedRecord(frozen)
    await svc.recordExperimentStart(record)
    // The same record again — a restarted caller re-deriving the same spec — is
    // one experiment, not two.
    await svc.recordExperimentStart({ ...record, actor: 'root-2', at: '2026-09-26T01:00:00.000Z' })
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.filter(line => line.includes('experiment_started'))).toHaveLength(1)

    const view = await svc.experiment(record.experimentId)
    expect(view.frozenDigest).toBe(record.frozenDigest)
    expect(view.samples).toEqual([])
    expect(await svc.experiments('p1')).toHaveLength(1)

    // A line whose frozen block does not hash to the digest it carries is not a
    // record of anything: the derivation is re-run on the way in.
    await expect(svc.recordExperimentStart({ ...record, frozen: frozenFixture({ model: 'scripted:other' }) }))
      .rejects.toThrow(/digest that does not match its frozen block/)
    expect(await svc.experiments()).toHaveLength(1)

    // A differently frozen experiment is a different experiment: its own id,
    // its own record, and the first one is untouched.
    const other = startedRecord(frozenFixture({ model: 'scripted:other' }))
    expect(other.experimentId).not.toBe(record.experimentId)
    await svc.recordExperimentStart(other)
    expect(await svc.experiments('p1')).toHaveLength(2)
    expect((await svc.experiment(record.experimentId)).frozen.model).toBe('scripted:fixture')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a second record for one sample key, and folds a hand-written duplicate line as an error', async () => {
    const { svc, root } = await service()
    const frozen = frozenFixture()
    const started = startedRecord(frozen)
    await svc.recordExperimentStart(started)
    const key = experimentSampleKeyOf({ proposalId: frozen.proposalId, frozen }, 't-failure', 'baseline')
    const record: ExperimentSampleRecord = {
      formatVersion: 1,
      kind: 'experiment_sample',
      proposalId: frozen.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: frozen.candidate.sha256,
      sampleTaskId: 't-failure',
      side: 'baseline',
      repetition: 0,
      taskId: 't-replay',
      runId: 'r-replay',
      outcome: 'failed',
      reviewRef: 't-replay#r-replay',
      evidenceRefs: ['e-1'],
      criteria: [{ criterionId: 'ac1', verdict: 'fail' }],
      workspace: '/tmp/ws',
      initialDigest: frozen.snapshot.digest,
      cost: { status: 'unknown', reason: 'the fixture reports no metrics' },
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    }
    await svc.recordExperimentSample(record)
    expect((await svc.experiments('p1'))[0]!.samples).toMatchObject([{ experimentId: started.experimentId, outcome: 'failed' }])

    // The same key again — same content or not — is a refusal, not an overwrite.
    await expect(svc.recordExperimentSample({ ...record, outcome: 'verified', at: '2026-09-26T02:00:00.000Z' }))
      .rejects.toThrow(/is recorded twice/)
    expect((await svc.experiment(started.experimentId)).samples).toHaveLength(1)

    // A second service over the same ledger reads the same view.
    const reopened = new EvolutionService(fixtureCtx(), { root, configFile: join(root, 'config.yml') })
    expect((await reopened.experiment(started.experimentId)).samples).toHaveLength(1)
    expect((await reopened.experiments('p1'))[0]!.samples[0]).toMatchObject({ runId: 'r-replay' })
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a sample record that disagrees with the experiment it names', async () => {
    const { svc, root } = await service()
    const frozen = frozenFixture()
    const started = startedRecord(frozen)
    await svc.recordExperimentStart(started)
    const base: ExperimentSampleRecord = {
      formatVersion: 1,
      kind: 'experiment_sample',
      proposalId: frozen.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: frozen.candidate.sha256,
      sampleTaskId: 't-failure',
      side: 'baseline',
      repetition: 0,
      outcome: 'failed',
      evidenceRefs: [],
      criteria: [],
      workspace: '/tmp/ws',
      initialDigest: frozen.snapshot.digest,
      cost: { status: 'unknown', reason: 'the fixture reports no metrics' },
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    }
    await expect(svc.recordExperimentSample({ ...base, preparedContentDigest: HEX('9') }))
      .rejects.toThrow(/candidate content identity that is not the experiment's own/)
    await expect(svc.recordExperimentSample({ ...base, repetition: 3 }))
      .rejects.toThrow(/repetition that is not the experiment's own/)
    await expect(svc.recordExperimentSample({ ...base, sampleTaskId: 't-unknown' }))
      .rejects.toThrow(/which the experiment never froze/)
    await expect(svc.recordExperimentSample({ ...base, initialDigest: undefined }))
      .rejects.toThrow(/must carry the frozen digest its workspace was built from/)
    // Nothing was written by any of the refusals.
    expect((await svc.experiment(started.experimentId)).samples).toHaveLength(0)
    await rm(root, { recursive: true, force: true })
  })

  it('folds an experiment line a hand wrote without the derivation: the digest, the id and the report path are recomputed', async () => {
    const frozen = frozenFixture()
    const proposals = new Map<string, EvolutionProposal>([['p1', { proposalId: 'p1' } as EvolutionProposal]])
    expect(foldExperiments([startedRecord(frozen)], proposals).size).toBe(1)

    const wrongDigest = { ...startedRecord(frozen), frozenDigest: HEX('f') }
    expect(() => foldExperiments([wrongDigest], proposals)).toThrow(/digest that does not match its frozen block/)

    const wrongId = { ...startedRecord(frozen), experimentId: 'aaaaaaaaaaaaaaaa' }
    expect(() => foldExperiments([wrongId], proposals)).toThrow(/id that does not match its frozen identity/)

    const wrongPath = { ...startedRecord(frozen), report: 'sandbox/p1/elsewhere.json' }
    expect(() => foldExperiments([wrongPath], proposals)).toThrow(/names a report path outside its own sandbox/)

    const wrongBudget = { ...startedRecord(frozen), budget: { note: 'another budget' } }
    expect(() => foldExperiments([wrongBudget], proposals)).toThrow(/carries a budget that is not the frozen one/)

    const unknownProposal = { ...startedRecord(frozen), proposalId: 'p9' }
    expect(() => foldExperiments([unknownProposal], proposals)).toThrow(/unknown proposal/)

    // A sample line before its experiment started is not a record of anything.
    expect(() => foldExperiments([{
      kind: 'experiment_sample',
      experimentId: 'e-nowhere',
    } as unknown as { kind: string }], proposals)).toThrow(/names unknown experiment/)
  })

  it('keeps the v1 family readable beside the new one, and the two keys apart', async () => {
    const { svc, root } = await service()
    // The proposal this ledger already carries, walked through the v1 lifecycle.
    await svc.candidate('p1', { skill: 'v2' }, 'root-1', { name: 'fixture-skill', content: '---\nname: fixture-skill\ndescription: x\n---\n\nbody\n' })
    await svc.prepare('p1', 'root-1')
    expect((await svc.get('p1')).status).toBe('prepared')

    const frozen = frozenFixture()
    await svc.recordExperimentStart(startedRecord(frozen))
    const reopened = new EvolutionService(fixtureCtx(), { root, configFile: join(root, 'config.yml') })
    expect((await reopened.get('p1')).status).toBe('prepared')
    expect((await reopened.experiments('p1'))[0]!.frozen.samples).toHaveLength(2)
    await rm(root, { recursive: true, force: true })
  })

  it('builds the report from the records, refuses an incomplete experiment, and writes nothing itself', async () => {
    const frozen = frozenFixture()
    const started = startedRecord(frozen)
    const record = (sampleTaskId: string, sampleSide: ExperimentSide, outcome: ExperimentSampleRecord['outcome']): ExperimentSampleRecord => ({
      formatVersion: 1,
      kind: 'experiment_sample',
      proposalId: frozen.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: frozen.candidate.sha256,
      sampleTaskId,
      side: sampleSide,
      repetition: 0,
      ...(outcome === 'interrupted' ? {} : { taskId: `t-${sampleTaskId}-${sampleSide}`, runId: `r-${sampleTaskId}-${sampleSide}`, initialDigest: frozen.snapshot.digest }),
      outcome,
      evidenceRefs: [],
      criteria: outcome === 'interrupted' || outcome === 'cancelled'
        ? []
        : [{ criterionId: 'ac1', verdict: outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
      workspace: `/tmp/ws/${sampleTaskId}/${sampleSide}`,
      cost: { status: 'unknown', reason: 'the fixture reports no metrics' },
      ...(outcome === 'interrupted' ? { reason: 'the fixture never settled a run' } : {}),
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    })
    const view: ExperimentView = {
      experimentId: started.experimentId,
      proposalId: frozen.proposalId,
      frozen,
      frozenDigest: started.frozenDigest,
      budget: frozen.budget,
      report: started.report,
      at: '2026-09-26T00:00:00.000Z',
      samples: [record('t-failure', 'baseline', 'failed'), record('t-failure', 'candidate', 'verified')],
    }

    // Half an experiment has no report: an incomplete comparison is not evidence.
    expect(() => buildExperimentReport(view)).toThrow(/is incomplete/)

    view.samples.push(
      record('t-holdout', 'baseline', 'verified'),
      record('t-holdout', 'candidate', 'verified'),
    )
    const report = buildExperimentReport(view)
    // The baseline reproduced the historical failure and the candidate passed:
    // a clean fix, with the holdout maintained.
    expect(report.verdict).toBe('fixed')
    expect(report.formatVersion).toBe(2)
    expect(report.samples[0]!.verdict).toBe('fixed')
    expect(report.samples[1]!.verdict).toBe('maintained')
    expect(report.frozenDigest).toBe(started.frozenDigest)
    expect(report.at).toBe('2026-09-26T00:00:00.000Z')

    // The same records rebuild the same report, byte for byte: `at` comes from
    // the records, never from the reading.
    expect(JSON.stringify(buildExperimentReport(view))).toBe(JSON.stringify(report))

    // A baseline that did not reproduce the failure leaves nothing to claim:
    // the same candidate outcome is `not-fixed`, not `fixed`.
    view.samples = [
      record('t-failure', 'baseline', 'verified'),
      record('t-failure', 'candidate', 'verified'),
      record('t-holdout', 'baseline', 'verified'),
      record('t-holdout', 'candidate', 'verified'),
    ]
    const unreproduced = buildExperimentReport(view)
    expect(unreproduced.samples[0]!.verdict).toBe('not-fixed')
    expect(unreproduced.verdict).toBe('not-fixed')

    // A side that never settled is inconclusive, and an interrupted side keeps
    // its reason with the store's own words.
    view.samples = [
      record('t-failure', 'baseline', 'cancelled'),
      record('t-failure', 'candidate', 'interrupted'),
      record('t-holdout', 'baseline', 'verified'),
      record('t-holdout', 'candidate', 'verified'),
    ]
    const inconclusive = buildExperimentReport(view)
    expect(inconclusive.samples[0]!.verdict).toBe('inconclusive')
    expect(inconclusive.verdict).toBe('inconclusive')
    expect(inconclusive.samples[0]!.candidate.reason).toContain('never settled a run')
    expect(inconclusive.samples[0]!.baseline.cost).toEqual({ status: 'unknown', reason: 'the fixture reports no metrics' })
  })

  it('reads a ledger an older build wrote beside the new experiment lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'experiment-ledger-'))
    const line = JSON.stringify({
      formatVersion: 1,
      kind: 'proposed',
      proposalId: 'p-old',
      targetType: 'skill',
      targetId: 'old-skill',
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'hand-written by the older build',
      sourceRefs: ['diagnosis:d1'],
      actor: 'root-1',
      at: '2026-01-01T00:00:00.000Z',
    })
    await writeFile(join(root, 'proposals.jsonl'), `${line}\n`, 'utf8')
    const svc = new EvolutionService(fixtureCtx(), { root, configFile: join(root, 'config.yml') })
    expect((await svc.get('p-old')).status).toBe('proposed')

    // An experiment beside it: the two families fold independently, and neither
    // changes what the other reads.
    await svc.recordExperimentStart(startedRecord(frozenFixture({ proposalId: 'p-old' })))
    const reopened = new EvolutionService(fixtureCtx(), { root, configFile: join(root, 'config.yml') })
    expect((await reopened.get('p-old')).status).toBe('proposed')
    expect(await reopened.experiments()).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  it('keys one sample side by every member the plan fixes, so no two runs can share a key', () => {
    const view = { proposalId: 'p1', frozen: frozenFixture() }
    const key = experimentSampleKeyOf(view, 't-failure', 'baseline')
    expect(experimentSampleKey(key)).toBe(['p1', CANDIDATE.sha256, 't-failure', 'baseline', '0'].join('\0'))
    expect(experimentSampleKey(experimentSampleKeyOf(view, 't-failure', 'candidate'))).not.toBe(experimentSampleKey(key))
    expect(experimentSampleKey(experimentSampleKeyOf(view, 't-holdout', 'baseline'))).not.toBe(experimentSampleKey(key))
    expect(experimentSampleKey(experimentSampleKeyOf({ ...view, frozen: frozenFixture({ repetition: 1 }) }, 't-failure', 'baseline')))
      .not.toBe(experimentSampleKey(key))
  })
})

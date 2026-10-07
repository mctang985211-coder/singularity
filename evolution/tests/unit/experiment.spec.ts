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

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { EvolutionProposal } from '../../src/evolution.ts'
import type { ExperimentView } from '../../src/experiment/freeze.ts'
import type { ExperimentSampleRecord, ExperimentStartedRecord } from '../../src/experiment/spec.ts'
import {
  buildExperimentReport,
  directoryDigest,
  experimentIdOf,
  experimentReportPath,
  experimentSampleKey,
  experimentSampleKeyOf,
  foldExperiments,
} from '../../src/experiment/record.ts'
import type {
  ExperimentSampleRole,
  ExperimentSide,
  ExperimentCriterionDetail,
  ExperimentSideDetail,
  FrozenExperiment,
  FrozenSample,
  ModelSelection,
} from '../../src/replay.ts'
import {
  assertExperimentReport,
  canonicalJson,
  compareExperimentSides,
  digestOf,
  EXPERIMENT_COMPARER_VERSION,
  frozenDigestOf,
  modelSelectionOf,
  overallExperimentVerdict,
  protectedInputsDigest,
} from '../../src/replay.ts'

function fixtureCtx() {
  return { reflect: { provide: () => {} }, effect: () => {} } as never
}

async function service(root?: string, skillRoot?: string): Promise<{ svc: EvolutionService; root: string }> {
  const directory = root ?? (await mkdtemp(join(tmpdir(), 'experiment-ledger-')))
  const svc = new EvolutionService(fixtureCtx(), {
    root: directory,
    ...(skillRoot === undefined ? {} : { skillRoot }),
  })
  // Every experiment record names a proposal that exists in the ledger — the
  // orchestrator reads it through `get` before it freezes anything — so the
  // fixtures propose p1 first, exactly as a live call would find it.
  await svc.propose(
    {
      proposalId: 'p1',
      targetType: 'skill',
      targetId: 'fixture-skill',
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'the fixture target failure',
      sourceRefs: ['diagnosis:d1'],
    },
    'root-1',
  )
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
    criteria: [
      {
        criterionId: 'ac1',
        verificationMode: 'deterministic',
        command: 'test -f answer.txt',
        protectedInputsDigest: protectedInputsDigest([]),
        verifierRef: 'command',
        verifierVersion: '1',
        verifierAnchor: 'registered verifier "command" declares version "1"',
      },
    ],
    observed: { outcome: 'failed', runId: 'r-historical' },
    provider: {
      capabilities: [],
      registryRevision: HEX('4'),
      candidateRegistryRevision: HEX('4'),
      mcpServers: [],
      preset: null,
      skills: [],
    },
    ...overrides,
  }
}

function frozenFixture(overrides: Partial<FrozenExperiment> = {}): FrozenExperiment {
  return {
    proposalId: 'p1',
    repetition: 0,
    candidate: { ...CANDIDATE },
    productionBaseline: { name: CANDIDATE.name, sha256: HEX('2') },
    model: selectionFixture(),
    budget: { maxTokens: 1_000, note: 'fixture budget' },
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

/** The structured selection the fixture freezes, and the one the fixture's service resolves. */
function selectionFixture(model = 'fixture'): ModelSelection {
  return modelSelectionOf({ provider: 'scripted', model })!
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
    cost: {
      status: 'reported',
      metrics: { tokens: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    },
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
    formatVersion: 3,
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

function startedRecord(
  frozen: FrozenExperiment,
  overrides: Partial<ExperimentStartedRecord> = {},
): ExperimentStartedRecord {
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(frozen.proposalId, frozenDigest)
  return {
    formatVersion: 4,
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
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    )
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }))
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }))
  })

  it('digests a directory by sorted relative path and bytes, and a link by the bytes it resolves to', async () => {
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

    // A link is not an input of its own: the snapshot's policy resolves it
    // inside the root, so the digest covers the bytes a workspace built from
    // the snapshot holds. A link and the file it names are the same input
    // whatever its target text spells, the materialized copy a side's run
    // actually gets is that same input too, and the same link text over
    // different bytes is a different input.
    const linked = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(linked, 'plain.txt'), 'plain')
    await symlink('plain.txt', join(linked, 'alias'))
    const spelled = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(spelled, 'plain.txt'), 'plain')
    await symlink('./plain.txt', join(spelled, 'alias'))
    expect(await directoryDigest(spelled)).toBe(await directoryDigest(linked))
    const materialized = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(materialized, 'plain.txt'), 'plain')
    await writeFile(join(materialized, 'alias'), 'plain')
    expect(await directoryDigest(materialized)).toBe(await directoryDigest(linked))
    const retargeted = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(retargeted, 'plain.txt'), 'something else entirely')
    await symlink('plain.txt', join(retargeted, 'alias'))
    expect(await directoryDigest(retargeted)).not.toBe(await directoryDigest(linked))

    for (const directory of [root, twin, linked, spelled, materialized, retargeted]) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses an input snapshot link that escapes the root, loops, or names nothing — never digesting it as text', async () => {
    // The review's counterexample: `shared` is an absolute link to a file
    // outside the snapshot. Digesting the link's text would describe an input
    // no workspace holds, and ignoring the link would let a snapshot with an
    // outside dependency hash equal to the same bytes without it — so the walk
    // refuses by name, and the bytes outside are never touched.
    const outside = await mkdtemp(join(tmpdir(), 'experiment-outside-'))
    const target = join(outside, 'payload.txt')
    await writeFile(target, 'the production bytes\n', 'utf8')
    const root = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await writeFile(join(root, 'payload.txt'), 'the production bytes\n', 'utf8')
    expect(await directoryDigest(root)).toMatch(/^[a-f0-9]{64}$/)
    await symlink(target, join(root, 'shared'))
    await expect(directoryDigest(root)).rejects.toThrow(/outside the snapshot root/)
    expect(await readFile(target, 'utf8')).toBe('the production bytes\n')

    // A link chain that loops…
    const looping = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await symlink('b', join(looping, 'a'))
    await symlink('a', join(looping, 'b'))
    await expect(directoryDigest(looping)).rejects.toThrow(/its target chain loops/)

    // …a link into a directory already on the way here, so the tree it names never ends…
    const ancestor = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await mkdir(join(ancestor, 'nested'))
    await symlink('..', join(ancestor, 'nested', 'up'))
    await expect(directoryDigest(ancestor)).rejects.toThrow(/already on the way here/)

    // …and a link whose target is not there to read.
    const dangling = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
    await symlink('missing.txt', join(dangling, 'gone'))
    await expect(directoryDigest(dangling)).rejects.toThrow(/gone.*cannot be resolved/)

    for (const directory of [outside, root, looping, ancestor, dangling]) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'refuses an input snapshot whose bytes cannot be read, by name',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'experiment-digest-'))
      const secret = join(root, 'secret.txt')
      await writeFile(secret, 'unreadable\n')
      await chmod(secret, 0o000)
      await symlink('secret.txt', join(root, 'alias'))
      await expect(directoryDigest(root)).rejects.toThrow(/alias.*cannot be read/)
      await chmod(secret, 0o600)
      await rm(root, { recursive: true, force: true })
    },
  )

  it('names the report path and the experiment id from the frozen block alone', () => {
    const frozen = frozenFixture()
    const digest = frozenDigestOf(frozen)
    const id = experimentIdOf(frozen.proposalId, digest)
    expect(id).toMatch(/^[a-f0-9]{16}$/)
    expect(experimentReportPath('p1', id)).toBe(`sandbox/p1/exp-${id}/experiment-report.json`)
    // Any member moving freezes a different experiment.
    expect(experimentIdOf('p1', frozenDigestOf(frozenFixture({ repetition: 1 })))).not.toBe(id)
    expect(experimentIdOf('p1', frozenDigestOf(frozenFixture({ model: selectionFixture('other') })))).not.toBe(id)
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
    expect(compareExperimentSides(failureRole, side(failureRole, 'baseline'), side(failureRole, 'candidate'))).toBe(
      'not-fixed',
    )

    // The candidate failed where the baseline did not: unfixed, and worse.
    expect(
      compareExperimentSides(
        failureRole,
        side(failureRole, 'baseline'),
        side(failureRole, 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
      ),
    ).toBe('not-fixed')
  })

  it('calls a regression or holdout sample regressed only when the candidate is worse', () => {
    for (const role of ['observed-regression', 'holdout'] as const) {
      expect(compareExperimentSides(role, side(role, 'baseline'), side(role, 'candidate'))).toBe('maintained')
      // A rank drop.
      expect(
        compareExperimentSides(
          role,
          side(role, 'baseline'),
          side(role, 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
        ),
      ).toBe('regressed')
      // A shared criterion flipping pass → fail, ranks unchanged.
      expect(
        compareExperimentSides(
          role,
          side(role, 'baseline', { criteria: [criterion('ac1', 'pass'), criterion('ac2', 'pass')] }),
          side(role, 'candidate', { criteria: [criterion('ac1', 'pass'), criterion('ac2', 'fail')] }),
        ),
      ).toBe('regressed')
    }
  })

  it('calls a regression or holdout sample whose baseline did not pass inconclusive, never maintained', () => {
    for (const role of ['observed-regression', 'holdout'] as const) {
      const failedBaseline = side(role, 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] })
      const failedCandidate = side(role, 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] })
      // A historical success this run never reproduced, both sides failing: the
      // sample says nothing about the candidate, so it cannot read as
      // `maintained` — the failure is shared, not absent.
      expect(compareExperimentSides(role, failedBaseline, failedCandidate)).toBe('inconclusive')
      // A candidate that passes over a baseline that never passed is no more
      // evidence: there is no reproduced success for the candidate to keep.
      expect(compareExperimentSides(role, failedBaseline, side(role, 'candidate'))).toBe('inconclusive')
      for (const outcome of ['cancelled', 'interrupted'] as const) {
        expect(
          compareExperimentSides(role, side(role, 'baseline', { outcome, criteria: [] }), side(role, 'candidate')),
        ).toBe('inconclusive')
      }
      // A verified baseline keeps the old rule exactly: only a worse candidate
      // is a regression, and a candidate that does not degrade is maintained.
      expect(compareExperimentSides(role, side(role, 'baseline'), failedCandidate)).toBe('regressed')
      expect(compareExperimentSides(role, side(role, 'baseline'), side(role, 'candidate'))).toBe('maintained')
    }
  })

  it('reads an unsettled side and a changed contract as inconclusive, never as a verdict on the candidate', () => {
    expect(
      compareExperimentSides(
        failureRole,
        side(failureRole, 'baseline', { outcome: 'cancelled', criteria: [] }),
        side(failureRole, 'candidate'),
      ),
    ).toBe('inconclusive')
    expect(
      compareExperimentSides(
        failureRole,
        side(failureRole, 'baseline', { outcome: 'interrupted', criteria: [], runId: undefined, taskId: undefined }),
        side(failureRole, 'candidate'),
      ),
    ).toBe('inconclusive')
    // A criterion that exists on one side only is a different contract, not a pass.
    expect(
      compareExperimentSides(
        failureRole,
        side(failureRole, 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] }),
        side(failureRole, 'candidate', { criteria: [criterion('ac1', 'pass'), criterion('ac2', 'pass')] }),
      ),
    ).toBe('inconclusive')
  })

  it('keeps the six overall verdicts mechanically distinguishable', () => {
    const sample = (role: ExperimentSampleRole, verdict: string) => ({ role, verdict }) as never
    expect(overallExperimentVerdict([sample('observed-failure', 'fixed'), sample('holdout', 'maintained')])).toBe(
      'fixed',
    )
    expect(overallExperimentVerdict([sample('observed-failure', 'fixed'), sample('holdout', 'regressed')])).toBe(
      'fixed-with-regression',
    )
    expect(overallExperimentVerdict([sample('observed-failure', 'not-fixed'), sample('holdout', 'maintained')])).toBe(
      'not-fixed',
    )
    expect(overallExperimentVerdict([sample('observed-failure', 'both-failed'), sample('holdout', 'maintained')])).toBe(
      'both-failed',
    )
    expect(overallExperimentVerdict([sample('observed-failure', 'not-fixed'), sample('holdout', 'regressed')])).toBe(
      'regressed',
    )
    expect(
      overallExperimentVerdict([sample('observed-failure', 'inconclusive'), sample('holdout', 'maintained')]),
    ).toBe('inconclusive')
    // A regression outranks an unfixed target; an unsettled side outranks both.
    expect(
      overallExperimentVerdict([sample('observed-failure', 'fixed'), sample('observed-regression', 'regressed')]),
    ).toBe('fixed-with-regression')
    expect(overallExperimentVerdict([sample('observed-failure', 'both-failed'), sample('holdout', 'regressed')])).toBe(
      'both-failed',
    )
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

  it('refuses a report that reads a holdout whose two sides failed as maintained, and recomputes it as inconclusive', () => {
    const masked = reportFixture()
    const failedBaseline = side('holdout', 'baseline', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] })
    const failedCandidate = side('holdout', 'candidate', { outcome: 'failed', criteria: [criterion('ac1', 'fail')] })
    masked.samples[1]!.baseline = failedBaseline as never
    masked.samples[1]!.candidate = failedCandidate as never
    // The report still claims the holdout was maintained: its own evidence says
    // the historical success never reproduced, so the claim is refused.
    expect(() => assertExperimentReport(masked)).toThrow(/does not match its own evidence/)

    // Told honestly about the sample, the report must tell the truth about the
    // experiment too: an overall verdict that stayed `fixed` no longer matches
    // its samples, so the recomputation catches it.
    masked.samples[1]!.verdict = 'inconclusive' as never
    expect(() => assertExperimentReport(masked)).toThrow(/verdict "fixed" does not match its samples/)
    masked.verdict = 'inconclusive' as never
    expect(() => assertExperimentReport(masked)).not.toThrow()
  })

  it('refuses a frozen block that does not hash to the digest the report names', () => {
    const report = reportFixture()
    report.frozenDigest = HEX('f')
    expect(() => assertExperimentReport(report)).toThrow(/frozenDigest does not match its frozen identity block/)

    const swapped = reportFixture()
    swapped.frozen = frozenFixture({ model: selectionFixture('other') })
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
    expect(() => assertExperimentReport(unknownComparer)).toThrow(/comparerVersion must be "experiment-comparer@2"/)

    // The comparison rules themselves moved in this build: the version a
    // pre-rework report names is refused by name, never re-derived under rules
    // its verdicts were not computed with.
    const oldComparer = reportFixture()
    oldComparer.frozen = frozenFixture({ comparerVersion: 'experiment-comparer@1' })
    oldComparer.frozenDigest = frozenDigestOf(oldComparer.frozen)
    expect(() => assertExperimentReport(oldComparer)).toThrow(/comparerVersion must be "experiment-comparer@2"/)
    expect(() => assertExperimentReport(oldComparer)).toThrow(/cannot re-derive/)
  })

  it('refuses a verified side with no criteria, an interrupted side with no reason, and a cost with no explanation', () => {
    const noCriteria = reportFixture()
    noCriteria.samples[1]!.candidate.criteria = []
    expect(() => assertExperimentReport(noCriteria)).toThrow(/verified outcome needs criterion evidence/)

    const interrupted = reportFixture()
    Object.assign(interrupted.samples[1]!.candidate, {
      outcome: 'interrupted',
      criteria: [],
      initialDigest: undefined,
      reason: undefined,
      runId: undefined,
      taskId: undefined,
    })
    interrupted.samples[1]!.verdict = 'inconclusive' as never
    interrupted.verdict = 'inconclusive' as never
    expect(() => assertExperimentReport(interrupted)).toThrow(/must carry the reason it has no terminal run/)

    // A failed side may carry the store's own cause, and — like every reason the
    // report holds — a blank one is refused: a reason that explains nothing is
    // not evidence of why the side failed.
    const explained = reportFixture()
    explained.samples[0]!.baseline.reason = 'the replayed run settled failed: spawn failed'
    expect(() => assertExperimentReport(explained)).not.toThrow()

    const blankCause = reportFixture()
    blankCause.samples[0]!.baseline.reason = ''
    expect(() => assertExperimentReport(blankCause)).toThrow(/\.reason must be a non-empty string when present/)

    const noReason = reportFixture()
    noReason.samples[1]!.candidate.cost = { status: 'unknown' } as never
    expect(() => assertExperimentReport(noReason)).toThrow(/must say why the cost is unknown/)
  })

  it('refuses a report from another build by version, naming the one it saw (K3: the report is v3)', () => {
    const report = reportFixture()
    expect(report.formatVersion).toBe(3)
    // The report grew a frozen provider identity carrying both sides' registry
    // revisions, so a v2 report is a different schema: it is refused by name
    // rather than read with the fields this build expects. The v1 shape the
    // pre-rework build wrote is refused the same way.
    for (const version of [2, 1]) {
      const older = { ...report, formatVersion: version }
      expect(() => assertExperimentReport(older)).toThrow(/formatVersion must be 3/)
      expect(() => assertExperimentReport(older)).toThrow(new RegExp(`got ${version}`))
    }
  })

  it("requires the frozen provider identity to record the candidate side's registry revision (K3)", () => {
    const report = reportFixture()
    const [sample] = report.frozen.samples
    expect(sample!.provider!.candidateRegistryRevision).toBe(HEX('4'))

    // The member is part of the identity, not an optional extra: a block without
    // it cannot say what the candidate side's run had to bind, so it is refused
    // rather than compared against the production value.
    const withoutMember = reportFixture()
    const provider = { ...withoutMember.frozen.samples[0]!.provider } as Record<string, unknown>
    delete provider.candidateRegistryRevision
    withoutMember.frozen = frozenFixture({
      samples: [
        { ...frozenSample(), provider } as unknown as FrozenSample,
        frozenSample({ taskId: 't-holdout', role: 'holdout', observed: { outcome: 'verified', runId: 'r-holdout' } }),
      ],
    })
    withoutMember.frozenDigest = frozenDigestOf(withoutMember.frozen)
    expect(() => assertExperimentReport(withoutMember)).toThrow(/candidateRegistryRevision/)
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
    await expect(
      svc.recordExperimentStart({ ...record, frozen: frozenFixture({ model: selectionFixture('other') }) }),
    ).rejects.toThrow(/digest that does not match its frozen block/)
    expect(await svc.experiments()).toHaveLength(1)

    // A differently frozen experiment is a different experiment: its own id,
    // its own record, and the first one is untouched.
    const other = startedRecord(frozenFixture({ model: selectionFixture('other') }))
    expect(other.experimentId).not.toBe(record.experimentId)
    await svc.recordExperimentStart(other)
    expect(await svc.experiments('p1')).toHaveLength(2)
    expect((await svc.experiment(record.experimentId)).frozen.model).toEqual(selectionFixture())
    await rm(root, { recursive: true, force: true })
  })

  it('announces the frozen experiment once, and not the idempotent repeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'experiment-ledger-'))
    const changes: string[] = []
    const ctx = fixtureCtx() as unknown as { emit: (name: string, payload: { proposalId: string }) => void }
    ctx.emit = (name, payload) => {
      if (name === 'evolution/change') changes.push(payload.proposalId)
    }
    const svc = new EvolutionService(ctx as never, { root })
    await svc.propose(
      {
        proposalId: 'p1',
        targetType: 'skill',
        targetId: 'fixture-skill',
        baseVersion: 'v1',
        level: 'L2',
        rationale: 'the fixture target failure',
        sourceRefs: ['diagnosis:d1'],
      },
      'root-1',
    )
    const record = startedRecord(frozenFixture())
    await svc.recordExperimentStart(record)
    const announced = changes.length
    expect(changes.at(-1)).toBe('p1')
    // The identical repeat writes nothing, so it announces nothing either.
    await svc.recordExperimentStart(record)
    expect(changes).toHaveLength(announced)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a second record for one sample key, and folds a hand-written duplicate line as an error', async () => {
    const { svc, root } = await service()
    const frozen = frozenFixture()
    const started = startedRecord(frozen)
    await svc.recordExperimentStart(started)
    const key = experimentSampleKeyOf({ proposalId: frozen.proposalId, frozen }, 't-failure', 'baseline')
    const record: ExperimentSampleRecord = {
      formatVersion: 4,
      kind: 'experiment_sample',
      proposalId: frozen.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: digestOf(frozen.candidate),
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
    expect((await svc.experiments('p1'))[0]!.samples).toMatchObject([
      { experimentId: started.experimentId, outcome: 'failed' },
    ])

    // The same key again — same content or not — is a refusal, not an overwrite.
    await expect(
      svc.recordExperimentSample({ ...record, outcome: 'verified', at: '2026-09-26T02:00:00.000Z' }),
    ).rejects.toThrow(/is recorded twice/)
    expect((await svc.experiment(started.experimentId)).samples).toHaveLength(1)

    // A second service over the same ledger reads the same view.
    const reopened = new EvolutionService(fixtureCtx(), { root })
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
      formatVersion: 4,
      kind: 'experiment_sample',
      proposalId: frozen.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: digestOf(frozen.candidate),
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
    await expect(svc.recordExperimentSample({ ...base, preparedContentDigest: HEX('9') })).rejects.toThrow(
      /candidate content identity that is not the experiment's own/,
    )
    // The key member is the digest of the *whole* candidate identity (K3): a
    // record keyed by the `SKILL.md` digest alone is not this experiment's key,
    // because a candidate whose sidecar differs is a different experiment.
    await expect(
      svc.recordExperimentSample({ ...base, preparedContentDigest: frozen.candidate!.sha256 }),
    ).rejects.toThrow(/candidate content identity that is not the experiment's own/)
    await expect(svc.recordExperimentSample({ ...base, repetition: 3 })).rejects.toThrow(
      /repetition that is not the experiment's own/,
    )
    await expect(svc.recordExperimentSample({ ...base, sampleTaskId: 't-unknown' })).rejects.toThrow(
      /which the experiment never froze/,
    )
    await expect(svc.recordExperimentSample({ ...base, initialDigest: undefined })).rejects.toThrow(
      /must carry the frozen digest its workspace was built from/,
    )
    // Nothing was written by any of the refusals.
    expect((await svc.experiment(started.experimentId)).samples).toHaveLength(0)
    await rm(root, { recursive: true, force: true })
  })

  it('keys a sample by the complete candidate identity, so the sidecar is part of the key (K3)', async () => {
    const { svc, root } = await service()
    const guidance = frozenFixture()
    const execution = frozenFixture({
      candidate: {
        name: CANDIDATE.name,
        sha256: CANDIDATE.sha256,
        contract: { sha256: HEX('5'), contractDigest: HEX('6') },
      },
    })
    const keyOf = (frozen: FrozenExperiment) =>
      experimentSampleKeyOf({ proposalId: frozen.proposalId, frozen }, 't-failure', 'candidate')
    // Same `SKILL.md` bytes, two objects: the sidecar decides which experiment a
    // sample side belongs to, so the key covers the whole identity and never the
    // file digest alone.
    expect(keyOf(guidance).preparedContentDigest).toBe(digestOf(CANDIDATE))
    expect(keyOf(guidance).preparedContentDigest).not.toBe(CANDIDATE.sha256)
    expect(keyOf(execution).preparedContentDigest).toBe(digestOf(execution.candidate))
    expect(keyOf(execution).preparedContentDigest).not.toBe(keyOf(guidance).preparedContentDigest)
    expect(experimentSampleKey(keyOf(execution))).not.toBe(experimentSampleKey(keyOf(guidance)))

    // And the ledger holds the line to it: the execution experiment refuses the
    // guidance-keyed record by name, and takes its own.
    const started = startedRecord(execution)
    await svc.recordExperimentStart(started)
    const record: ExperimentSampleRecord = {
      formatVersion: 4,
      kind: 'experiment_sample',
      proposalId: execution.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: digestOf(execution.candidate),
      sampleTaskId: 't-failure',
      side: 'candidate',
      repetition: 0,
      outcome: 'verified',
      evidenceRefs: [],
      criteria: [],
      workspace: '/tmp/ws',
      initialDigest: execution.snapshot.digest,
      cost: { status: 'unknown', reason: 'the fixture reports no metrics' },
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    }
    await expect(svc.recordExperimentSample({ ...record, preparedContentDigest: digestOf(CANDIDATE) })).rejects.toThrow(
      /candidate content identity that is not the experiment's own/,
    )
    await svc.recordExperimentSample(record)
    expect((await svc.experiment(started.experimentId)).samples).toHaveLength(1)
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

    // The frozen budget has one optional ceiling. A line still carrying the
    // removed wall clock — or any key this build does not know — is refused by
    // name before it can be read as a budget that was enforced.
    const removedClock = { ...frozen, budget: { maxTokens: 10, wallTimeMs: 60_000 } } as unknown as FrozenExperiment
    expect(() => foldExperiments([startedRecord(removedClock)], proposals)).toThrow(/budget\.wallTimeMs is removed/)
    const unknownBudget = { ...frozen, budget: { maxRuns: 3 } } as unknown as FrozenExperiment
    expect(() => foldExperiments([startedRecord(unknownBudget)], proposals)).toThrow(/budget has unknown key "maxRuns"/)

    const unknownProposal = { ...startedRecord(frozen), proposalId: 'p9' }
    expect(() => foldExperiments([unknownProposal], proposals)).toThrow(/unknown proposal/)

    // A sample line before its experiment started is not a record of anything.
    expect(() =>
      foldExperiments(
        [
          {
            kind: 'experiment_sample',
            experimentId: 'e-nowhere',
          } as unknown as { kind: string },
        ],
        proposals,
      ),
    ).toThrow(/names unknown experiment/)
  })

  it('keeps the v1 family readable beside the new one, and the two keys apart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'experiment-ledger-'))
    const skillRoot = join(root, 'skills')
    // This build prepares a replacement of an existing production SKILL.md, so
    // the fixture walks its candidate only against one that is there.
    await mkdir(join(skillRoot, 'fixture-skill'), { recursive: true })
    await writeFile(
      join(skillRoot, 'fixture-skill', 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: x\n---\n\nbody\n',
    )
    const { svc } = await service(root, skillRoot)
    // The proposal this ledger already carries, walked through the lifecycle.
    await svc.candidate('p1', { skill: 'v2' }, 'root-1', {
      name: 'fixture-skill',
      content: '---\nname: fixture-skill\ndescription: x\n---\n\nbody\n',
    })
    await svc.prepare('p1', 'root-1')
    expect((await svc.get('p1')).status).toBe('prepared')

    const frozen = frozenFixture()
    await svc.recordExperimentStart(startedRecord(frozen))
    const reopened = new EvolutionService(fixtureCtx(), { root, skillRoot })
    expect((await reopened.get('p1')).status).toBe('prepared')
    expect((await reopened.experiments('p1'))[0]!.frozen.samples).toHaveLength(2)
    await rm(root, { recursive: true, force: true })
  })

  it('builds the report from the records, refuses an incomplete experiment, and writes nothing itself', async () => {
    const frozen = frozenFixture()
    const started = startedRecord(frozen)
    const record = (
      sampleTaskId: string,
      sampleSide: ExperimentSide,
      outcome: ExperimentSampleRecord['outcome'],
    ): ExperimentSampleRecord => ({
      formatVersion: 4,
      kind: 'experiment_sample',
      proposalId: frozen.proposalId,
      experimentId: started.experimentId,
      preparedContentDigest: digestOf(frozen.candidate),
      sampleTaskId,
      side: sampleSide,
      repetition: 0,
      ...(outcome === 'interrupted'
        ? {}
        : {
            taskId: `t-${sampleTaskId}-${sampleSide}`,
            runId: `r-${sampleTaskId}-${sampleSide}`,
            initialDigest: frozen.snapshot.digest,
          }),
      outcome,
      evidenceRefs: [],
      criteria:
        outcome === 'interrupted' || outcome === 'cancelled'
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

    view.samples.push(record('t-holdout', 'baseline', 'verified'), record('t-holdout', 'candidate', 'verified'))
    const report = buildExperimentReport(view)
    // The baseline reproduced the historical failure and the candidate passed:
    // a clean fix, with the holdout maintained.
    expect(report.verdict).toBe('fixed')
    expect(report.formatVersion).toBe(3)
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

    // A fixed target beside a holdout whose baseline never reproduced the
    // historical pass: the holdout is inconclusive, and the overall verdict
    // follows it instead of reading as a clean fix.
    view.samples = [
      record('t-failure', 'baseline', 'failed'),
      record('t-failure', 'candidate', 'verified'),
      record('t-holdout', 'baseline', 'failed'),
      record('t-holdout', 'candidate', 'failed'),
    ]
    const masked = buildExperimentReport(view)
    expect(masked.samples.map(item => item.verdict)).toEqual(['fixed', 'inconclusive'])
    expect(masked.verdict).toBe('inconclusive')
    expect(() => assertExperimentReport(masked)).not.toThrow()

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
    expect(inconclusive.samples[0]!.baseline.cost).toEqual({
      status: 'unknown',
      reason: 'the fixture reports no metrics',
    })
  })

  it('folds a hand-written proposal beside the experiment family, each by its own rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'experiment-ledger-'))
    const line = JSON.stringify({
      formatVersion: 4,
      kind: 'proposed',
      proposalId: 'p-old',
      targetType: 'skill',
      targetId: 'old-skill',
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'hand-written proposal',
      sourceRefs: ['diagnosis:d1'],
      actor: 'root-1',
      at: '2026-01-01T00:00:00.000Z',
    })
    await writeFile(join(root, 'proposals.jsonl'), `${line}\n`, 'utf8')
    const svc = new EvolutionService(fixtureCtx(), { root })
    expect((await svc.get('p-old')).status).toBe('proposed')

    // An experiment beside it: the two families fold independently, and neither
    // changes what the other reads.
    await svc.recordExperimentStart(startedRecord(frozenFixture({ proposalId: 'p-old' })))
    const reopened = new EvolutionService(fixtureCtx(), { root })
    expect((await reopened.get('p-old')).status).toBe('proposed')
    expect(await reopened.experiments()).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  it('keys one sample side by every member the plan fixes, so no two runs can share a key', () => {
    const view = { proposalId: 'p1', frozen: frozenFixture() }
    const key = experimentSampleKeyOf(view, 't-failure', 'baseline')
    // The content member is the digest of the complete candidate identity (K3),
    // never the bare `SKILL.md` digest: a candidate whose sidecar differs is a
    // different object and therefore a different key.
    expect(experimentSampleKey(key)).toBe(['p1', digestOf(CANDIDATE), 't-failure', 'baseline', '0'].join('\0'))
    expect(experimentSampleKey(key)).not.toContain(CANDIDATE.sha256)
    expect(experimentSampleKey(experimentSampleKeyOf(view, 't-failure', 'candidate'))).not.toBe(
      experimentSampleKey(key),
    )
    expect(experimentSampleKey(experimentSampleKeyOf(view, 't-holdout', 'baseline'))).not.toBe(experimentSampleKey(key))
    expect(
      experimentSampleKey(
        experimentSampleKeyOf({ ...view, frozen: frozenFixture({ repetition: 1 }) }, 't-failure', 'baseline'),
      ),
    ).not.toBe(experimentSampleKey(key))
    const execution = {
      proposalId: 'p1',
      frozen: frozenFixture({ candidate: { ...CANDIDATE, contract: { sha256: HEX('5'), contractDigest: HEX('6') } } }),
    }
    expect(experimentSampleKey(experimentSampleKeyOf(execution, 't-failure', 'baseline'))).not.toBe(
      experimentSampleKey(key),
    )
  })
})

/**
 * S4-E 收尾: the candidate lifecycle is one file — a mutation this build can
 * materialize, evaluate and promote — and `prepare` only prepares a replacement
 * of a production skill that already exists. Both refusals land before the
 * first write, so a candidate nothing can evaluate never becomes a flow.
 */
describe('the candidate and prepare refusals (S4-E 收尾)', () => {
  it('refuses a candidate that carries nothing to materialize or evaluate', async () => {
    const { svc, root } = await service()
    try {
      await expect(svc.candidate('p1', { skill: '1' }, 'root-1', undefined)).rejects.toThrow(
        'mutation must be an object',
      )
      // No candidate line was written: the proposal is still the record it was.
      expect((await svc.get('p1')).status).toBe('proposed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a prepare whose production Skill does not exist, before writing sandbox or ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'experiment-prepare-refusal-'))
    const svc = new EvolutionService(fixtureCtx(), { root, skillRoot: join(root, 'production') })
    try {
      await svc.propose(
        {
          proposalId: 'p1',
          targetType: 'skill',
          targetId: 'fixture-skill',
          baseVersion: '1',
          level: 'L2',
          rationale: 'replace existing',
          sourceRefs: ['d1'],
        },
        'root-1',
      )
      await svc.candidate('p1', { skill: '1' }, 'root-1', {
        name: 'fixture-skill',
        content: '---\nname: fixture-skill\ndescription: Valid candidate for the missing-production refusal.\n---\nCandidate method.\n',
      })
      const before = await readFile(svc.file, 'utf8')
      const err = await svc.prepare('p1', 'root-1').then(
        () => undefined,
        e => e,
      )
      expect.soft(err, 'a prepare with no production skill to replace must refuse').toBeInstanceOf(Error)
      expect.soft(await readFile(svc.file, 'utf8'), 'the ledger bytes must stay unchanged').toBe(before)
      expect.soft(await readdir(root), 'no sandbox directory may be created').not.toContain('sandbox')
      expect.soft((await svc.get('p1')).status, 'the candidate stays the state it was').toBe('candidate')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------------ *
 * The write boundary and the fold: what the ledger accepts, and where.
 *
 * The independent review's counterexamples (S4-E 收尾): the ledger reads and
 * writes one format — `formatVersion: 4` — and the fold admits only the
 * lifecycle this build's entries write. Each case below takes the entry
 * directly, the shape a forged call or a stale caller takes, and pins that the
 * refusal lands before the first byte changes and leaves the ledger a fresh
 * service can still read.
 * ------------------------------------------------------------------------ */

describe('the ledger write boundary is formatVersion 4 (K3)', () => {
  it('refuses a direct experiment start that declares an old version, before the append', async () => {
    const { svc, root } = await service()
    try {
      const before = await readFile(svc.file, 'utf8')
      const err = await svc
        .recordExperimentStart({ ...startedRecord(frozenFixture()), formatVersion: 1 } as never)
        .then(
          () => undefined,
          e => e,
        )
      expect.soft(err, 'an old-version start must throw before append').toBeInstanceOf(Error)
      expect
        .soft(
          String((err as Error).message),
          'the refusal must name the version it saw and the version this build writes',
        )
        .toMatch(/formatVersion 1[\s\S]*formatVersion 4/)
      expect.soft(await readFile(svc.file, 'utf8'), 'ledger bytes must stay unchanged').toBe(before)
      await expect
        .soft(new EvolutionService(fixtureCtx(), { root }).list(), 'the ledger must remain readable')
        .resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a direct experiment start that declares no version', async () => {
    const { svc, root } = await service()
    try {
      const before = await readFile(svc.file, 'utf8')
      const unversioned = { ...startedRecord(frozenFixture()) } as Record<string, unknown>
      delete unversioned.formatVersion
      const err = await svc.recordExperimentStart(unversioned as never).then(
        () => undefined,
        e => e,
      )
      expect.soft(err, 'an unversioned start must throw before append').toBeInstanceOf(Error)
      expect.soft(String((err as Error).message)).toMatch(/declares formatVersion null/)
      expect.soft(await readFile(svc.file, 'utf8'), 'ledger bytes must stay unchanged').toBe(before)
      await expect
        .soft(new EvolutionService(fixtureCtx(), { root }).list(), 'the ledger must remain readable')
        .resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an old-version start that repeats a recorded identity, instead of the idempotent no-op', async () => {
    const { svc, root } = await service()
    try {
      const frozen = frozenFixture()
      const started = startedRecord(frozen)
      await svc.recordExperimentStart(started)
      const before = await readFile(svc.file, 'utf8')
      const err = await svc.recordExperimentStart({ ...started, formatVersion: 1 } as never).then(
        () => undefined,
        e => e,
      )
      expect.soft(err, 'a repeat at another version is a refusal, not the idempotent return').toBeInstanceOf(Error)
      expect.soft(String((err as Error).message)).toMatch(/formatVersion 1/)
      expect
        .soft(await readFile(svc.file, 'utf8'), 'the recorded line stays the only line for this experiment')
        .toBe(before)
      expect.soft((await svc.experiments('p1')).length, 'no second experiment was opened').toBe(1)
      await expect
        .soft(new EvolutionService(fixtureCtx(), { root }).list(), 'the ledger must remain readable')
        .resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a direct experiment sample that declares an old version, before the append', async () => {
    const { svc, root } = await service()
    try {
      const frozen = frozenFixture(),
        started = startedRecord(frozen)
      await svc.recordExperimentStart(started)
      const before = await readFile(svc.file, 'utf8')
      const err = await svc
        .recordExperimentSample({
          formatVersion: 1,
          kind: 'experiment_sample',
          proposalId: 'p1',
          experimentId: started.experimentId,
          preparedContentDigest: digestOf(frozen.candidate),
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
          cost: { status: 'unknown', reason: 'review fixture' },
          actor: 'root-1',
          at: '2026-09-26T00:00:00.000Z',
        } as never)
        .then(
          () => undefined,
          e => e,
        )
      expect.soft(err, 'an old-version sample must throw before append').toBeInstanceOf(Error)
      expect.soft(String((err as Error).message)).toMatch(/formatVersion 1/)
      expect.soft(await readFile(svc.file, 'utf8'), 'ledger bytes must stay unchanged').toBe(before)
      await expect
        .soft(new EvolutionService(fixtureCtx(), { root }).list(), 'the ledger must remain readable')
        .resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the fold admits only the current lifecycle (S4-E 收尾)', () => {
  const common = { formatVersion: 4, proposalId: 'p1', actor: 'root-1', at: '2026-09-26T00:00:00.000Z' }
  const proposed = (over: Record<string, unknown> = {}) => ({
    ...common,
    kind: 'proposed',
    targetType: 'skill',
    targetId: 'fixture-skill',
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the fixture proposal',
    sourceRefs: ['diagnosis:d1'],
    ...over,
  })
  const candidate = (over: Record<string, unknown> = {}) => ({
    ...common,
    kind: 'candidate',
    versionSet: { skill: 'v2' },
    mutation: { name: 'fixture-skill', content: 'candidate bytes' },
    ...over,
  })
  const prepared = (over: Record<string, unknown> = {}) => ({
    ...common,
    kind: 'prepared',
    sandbox: 'sandbox/p1',
    mechanical: true,
    champion: 'captured',
    skillContent: { name: 'fixture-skill', sha256: 'a'.repeat(64) },
    skillBaseline: { name: 'fixture-skill', sha256: 'b'.repeat(64) },
    files: ['skills/fixture-skill/SKILL.md'],
    ...over,
  })
  const gated = () => ({
    ...common,
    kind: 'gated',
    gate: {
      targetFailureFixed: 'fixed',
      originalAcceptanceMaintained: 'maintained',
      existingRegressionMaintained: 'maintained',
      noUnacceptableSideEffects: 'none',
      holdoutPerformanceAcceptable: 'acceptable',
      resourceCostAcceptable: 'acceptable',
      regressionEvidenceRefs: ['evidence:1'],
    },
  })

  /** The raw bytes a hostile caller could write, and the service that must refuse them. */
  async function forged(
    lines: readonly Record<string, unknown>[],
  ): Promise<{ svc: EvolutionService; root: string; bytes: string }> {
    const root = await mkdtemp(join(tmpdir(), 's4e-fold-refusal-'))
    const bytes = `${lines.map(line => JSON.stringify(line)).join('\n')}\n`
    await writeFile(join(root, 'proposals.jsonl'), bytes)
    return { svc: new EvolutionService(fixtureCtx(), { root }), root, bytes }
  }

  /** One refusal: the entry throws, the message names the defect, the bytes stay put, and a second service agrees. */
  async function refuses(lines: readonly Record<string, unknown>[], expected: RegExp): Promise<void> {
    const { svc, root, bytes } = await forged(lines)
    try {
      const err = await svc.list().then(
        () => undefined,
        e => e,
      )
      expect(err, `a ledger of ${JSON.stringify(lines.map(line => line.kind))} must be refused`).toBeInstanceOf(Error)
      expect(String((err as Error).message)).toMatch(expected)
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8'), 'the refused ledger stays byte for byte').toBe(
        bytes,
      )
      await expect(
        new EvolutionService(fixtureCtx(), { root }).list(),
        'the verdict belongs to the bytes, not one instance',
      ).rejects.toThrow(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('refuses a capability candidate written in the shape a ledger before this build holds', async () => {
    // A6 admits a capability candidate, but only the one-whole-row shape its own
    // lifecycle records: the old `{ name, entry }` mutation is a payload no live
    // entry writes, and the fold refuses it exactly as `candidate` would.
    await refuses(
      [
        proposed({ targetType: 'capability', targetId: 'research' }),
        candidate({ versionSet: { capability: '1' }, mutation: { name: 'research', entry: { preset: 'standard' } } }),
      ],
      /capability-row-invalid/,
    )
  })

  it('refuses a candidate that carries no mutation', async () => {
    await refuses([proposed(), candidate({ mutation: undefined })], /mutation must be an object/)
  })

  it('refuses a prepared record with no candidate content identity', async () => {
    await refuses([proposed(), candidate(), prepared({ skillContent: undefined })], /no valid skillContent identity/)
  })

  it('refuses a prepared record with no production baseline', async () => {
    await refuses([proposed(), candidate(), prepared({ skillBaseline: undefined })], /no valid skillBaseline identity/)
  })

  it('refuses a decided record with no human-approval evidence ref', async () => {
    await refuses(
      [proposed(), candidate(), prepared(), gated(), { ...common, kind: 'decided', decision: 'PROMOTE' }],
      /no human-approval evidence ref/,
    )
  })
})

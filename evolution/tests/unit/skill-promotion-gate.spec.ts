/**
 * The skill promotion gate (S4-E §F.2, EVAL-2/EVAL-3/EVAL-4), driven through the
 * service entry every promotion goes through (`checkPromotion`, which
 * `decide(PROMOTE)` and `apply` call again on their own entries).
 *
 * The fixture composes one real ledger and one real store: a prepared skill
 * candidate, a frozen two-sided experiment recorded through the service's own
 * write path, four settled sides whose tasks, runs, reviews and evidence the
 * store holds, and the experiment report on disk. That is the shape the
 * orchestrator produces; what this file asserts is what the gate does with it —
 * and what each kind of tampering, drift or unmet condition produces instead.
 *
 * The *real* runs are proven elsewhere: `tests/integration/experiment-runner.spec.ts`
 * and `tests/integration/evolution-replay-experiment.spec.ts` drive the tool over
 * the real store, runtime, spawn and verifier. Here the store is a fixture so a
 * forgery, a drift or a verdict can be reached deterministically.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { EvolutionProposal, GateAnswers } from '../../src/evolution.ts'
import type { ExperimentSampleRecord, ExperimentStartedRecord, ExperimentView } from '../../src/experiment.ts'
import { buildExperimentReport, directoryDigest, experimentIdOf, experimentLineage, experimentReportPath } from '../../src/experiment.ts'
import type { ExperimentBudget, FrozenExperiment, FrozenSample, SkillContentIdentity } from '../../src/replay.ts'
import { digestOf, EXPERIMENT_COMPARER_VERSION, frozenDigestOf, protectedInputsDigest } from '../../src/replay.ts'

const PROPOSAL = 's1'
const SKILL = 'verify'
const FAIL_SAMPLE = 't-fail'
const HOLDOUT_SAMPLE = 't-holdout'
const REGRESSION_SAMPLE = 't-regression'
const MODEL = 'p/m'
const VERIFIER_VERSION = '1'
const CANDIDATE = skillText('# the fixed body\n')
const PRODUCTION = '# the production body\n'

function skillText(body: string, name = SKILL): string {
  return `---\nname: ${name}\ndescription: gate fixture skill\n---\n\n${body}`
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function gateAnswers(refs: string[]): GateAnswers {
  return {
    targetFailureFixed: 'the fixture case passes on the candidate',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the regression samples still pass',
    noUnacceptableSideEffects: 'one file changes',
    holdoutPerformanceAcceptable: 'the held-out samples still pass',
    resourceCostAcceptable: 'recorded, not inferred',
    regressionEvidenceRefs: refs,
  }
}

type Settlement = 'verified' | 'failed' | 'cancelled'

interface FixtureOptions {
  /** The observed-failure sample's two sides (default: the failure is reproduced and fixed). */
  failure?: { baseline?: Settlement; candidate?: Settlement }
  /** The holdout sample's two sides (default: both verified). */
  holdout?: { baseline?: Settlement; candidate?: Settlement }
  /** Add a verified sample the candidate must not break, and its two sides. */
  regression?: { baseline?: Settlement; candidate?: Settlement }
  budget?: ExperimentBudget
  /** The model identity the experiment froze (default: the one the service resolves). */
  frozenModel?: string
  /** The model identity the service resolves now (default {@link MODEL}). */
  model?: string
  /** The verifier version the registry reports now (default {@link VERIFIER_VERSION}). */
  verifierVersion?: string
  /** The candidate identity the frozen block names (default: the prepared one). */
  candidateIdentity?: SkillContentIdentity
  /** The production baseline the frozen block names (default: the prepared one). */
  frozenBaseline?: SkillContentIdentity
  /** A protected input the failure sample's criterion declares, written into the snapshot. */
  protectedInput?: { path: string; bytes: string }
  /** Metrics every settled review carries (absent: the cost is reported as unknown). */
  metrics?: Record<string, unknown>
  /** Leave the `storeId` off the experiment record (an older line). */
  omitStoreId?: boolean
}

interface Rows {
  tasks: Record<string, unknown>[]
  runs: Record<string, unknown>[]
  reviews: Record<string, unknown>[]
  evidence: Record<string, unknown>[]
}

/**
 * One whole fixture: the ledger, the store it names, the report on disk, and
 * the pieces a tamper case needs (the sample records, the report path).
 */
async function fixture(options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'skill-promotion-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const workspace = join(root, 'env')
  await mkdir(join(skillRoot, SKILL), { recursive: true })
  await writeFile(join(skillRoot, SKILL, 'SKILL.md'), PRODUCTION)
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  const protectedInput = options.protectedInput ?? { path: 'threshold.txt', bytes: '42\n' }
  await writeFile(join(workspace, protectedInput.path), protectedInput.bytes)

  const rows: Rows = { tasks: [], runs: [], reviews: [], evidence: [] }
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    taskRuntime: { listCapabilities: () => ({ research: { preset: 'standard' } }) },
    task: { openStore: async () => ({ tasks: rows.tasks, runs: rows.runs, reviews: rows.reviews, evidence: rows.evidence, diagnoses: [], obligations: [] }) },
    verifier: {
      ready: async () => {},
      verifierIds: () => ['command', 'composite', 'review'],
      verifierVersions: () => ({ command: options.verifierVersion ?? VERIFIER_VERSION, composite: '1', review: '1' }),
    },
  }
  const svc = new EvolutionService(ctx as never, {
    root,
    skillRoot,
    presetRoot: join(dir, 'presets'),
    configFile: join(dir, 'config.yml'),
    modelIdentity: () => options.model ?? MODEL,
  })
  await svc.propose({
    proposalId: PROPOSAL,
    targetType: 'skill',
    targetId: SKILL,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the production skill never produces the answer the criterion asks for',
    sourceRefs: ['diagnosis:d1'],
  }, 'root-1')
  await svc.candidate(PROPOSAL, { skill: 'v2' }, 'root-1', { name: SKILL, content: CANDIDATE })
  const prepared = await svc.prepare(PROPOSAL, 'root-1')

  // --- the samples, as the store holds their historical contracts -----------
  const samples: FrozenSample[] = []
  const addSample = (input: { taskId: string; role: FrozenSample['role']; criterionId: string; command: string; outcome: 'verified' | 'failed'; protectedInputs?: { path: string; sha256: string }[] }) => {
    const acceptanceCriteria = [{
      criterionId: input.criterionId,
      description: 'works',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: input.command,
      ...(input.protectedInputs === undefined ? {} : { protectedInputs: input.protectedInputs }),
    }]
    rows.tasks.push({
      taskId: input.taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: 't-parent',
      objective: `${input.taskId} objective`,
      depth: 1,
      acceptanceCriteria,
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: input.outcome,
      runIds: [`r-history-${input.taskId}`],
      childTaskIds: [],
    })
    rows.reviews.push({
      taskId: input.taskId,
      runId: `r-history-${input.taskId}`,
      outcome: input.outcome,
      evidenceRefs: [],
      anomalies: [],
      criteria: [{ criterionId: input.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail' }],
    })
    samples.push({
      taskId: input.taskId,
      role: input.role,
      contractDigest: digestOf({ objective: `${input.taskId} objective`, acceptanceCriteria, requiredCapabilities: [] }),
      criteria: [{
        criterionId: input.criterionId,
        verificationMode: 'deterministic',
        command: input.command,
        protectedInputsDigest: protectedInputsDigest(input.protectedInputs ?? []),
      }],
      observed: { outcome: input.outcome, runId: `r-history-${input.taskId}` },
    })
  }
  addSample({
    taskId: FAIL_SAMPLE,
    role: 'observed-failure',
    criterionId: 'ac-fix',
    command: 'test -f fix.txt',
    outcome: 'failed',
    protectedInputs: [{ path: protectedInput.path, sha256: sha256(protectedInput.bytes) }],
  })
  addSample({ taskId: HOLDOUT_SAMPLE, role: 'holdout', criterionId: 'ac-holdout', command: 'test -f holdout.txt', outcome: 'verified' })
  if (options.regression !== undefined) {
    addSample({ taskId: REGRESSION_SAMPLE, role: 'observed-regression', criterionId: 'ac-keep', command: 'test -f keep.txt', outcome: 'verified' })
  }

  // --- the frozen block and the experiment id ------------------------------
  const frozen: FrozenExperiment = {
    proposalId: PROPOSAL,
    repetition: 0,
    candidate: options.candidateIdentity ?? prepared.prepared!.skillContent!,
    productionBaseline: options.frozenBaseline ?? prepared.prepared!.skillBaseline!,
    model: options.frozenModel ?? MODEL,
    budget: { ...(options.budget ?? {}) },
    samples,
    snapshot: { sourceDir: workspace, digest: await directoryDigest(workspace) },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: { baseline: 'none — the baseline runs under the production configuration', candidate: `extraSkillRoots: [sandbox/${PROPOSAL}/skills]` },
  }
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(PROPOSAL, frozenDigest)
  const reportPath = experimentReportPath(PROPOSAL, experimentId)

  // --- the four settled sides, as the store would hold them ----------------
  const sides = { failure: options.failure ?? {}, holdout: options.holdout ?? {}, regression: options.regression ?? {} } as const
  const settle = (sample: FrozenSample, side: 'baseline' | 'candidate', outcome: Settlement) => {
    const lineage = experimentLineage(experimentId, sample.taskId, side)
    const taskId = `t-${sample.taskId}-${side}`
    const runId = `r-${sample.taskId}-${side}`
    const criterionId = sample.criteria[0]!.criterionId
    const verdict = outcome === 'verified' ? 'pass' : outcome === 'failed' ? 'fail' : 'inconclusive'
    rows.tasks.push({
      taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: undefined,
      objective: `[${lineage}] ${sample.taskId}`,
      depth: 1,
      acceptanceCriteria: [{ criterionId, description: 'works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: sample.criteria[0]!.command }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: outcome,
      runIds: [runId],
      childTaskIds: [],
    })
    rows.runs.push({ runId, taskId, sessionId: `s-${runId}`, status: outcome, startedAt: '2026-09-26T00:00:00.000Z' })
    rows.evidence.push({ evidenceId: `e-${runId}`, taskRunId: runId, taskId, artifacts: [], verifierResults: [], claims: [], generatedAt: '2026-09-26T00:00:00.000Z' })
    rows.reviews.push({
      taskId,
      runId,
      outcome,
      evidenceRefs: [`e-${runId}`],
      anomalies: [],
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      criteria: [{ criterionId, verdict, verifierId: 'command', verifierVersion: VERIFIER_VERSION }],
    })
    const record: ExperimentSampleRecord = {
      formatVersion: 1,
      kind: 'experiment_sample',
      proposalId: PROPOSAL,
      experimentId,
      preparedContentDigest: frozen.candidate.sha256,
      sampleTaskId: sample.taskId,
      side,
      repetition: 0,
      taskId,
      runId,
      outcome,
      reviewRef: `${taskId}#${runId}`,
      evidenceRefs: [`e-${runId}`],
      criteria: [{ criterionId, verdict, verifierId: 'command', verifierVersion: VERIFIER_VERSION }],
      workspace: join(root, 'sandbox', PROPOSAL, `exp-${experimentId}`, sample.taskId, side),
      initialDigest: frozen.snapshot.digest,
      cost: options.metrics === undefined
        ? { status: 'unknown', reason: "the run's review record carries no metrics, so no cost was reported for it" }
        : { status: 'reported', metrics: options.metrics as never },
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    }
    return record
  }

  const started: ExperimentStartedRecord = {
    formatVersion: 1,
    kind: 'experiment_started',
    proposalId: PROPOSAL,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: reportPath,
    ...(options.omitStoreId === true ? {} : { storeId: 'sg-t-root-1' }),
    actor: 'root-1',
    at: '2026-09-26T00:00:00.000Z',
  }
  const records: ExperimentSampleRecord[] = []
  for (const sample of samples) {
    const spec = sample.taskId === FAIL_SAMPLE ? sides.failure : sample.taskId === HOLDOUT_SAMPLE ? sides.holdout : sides.regression
    records.push(settle(sample, 'baseline', spec.baseline ?? (sample.taskId === FAIL_SAMPLE ? 'failed' : 'verified')))
    records.push(settle(sample, 'candidate', spec.candidate ?? (sample.taskId === FAIL_SAMPLE ? 'verified' : 'verified')))
  }
  await svc.recordExperimentStart(started)
  for (const record of records) await svc.recordExperimentSample(record)
  const reportAbs = join(root, reportPath)
  await mkdir(join(root, 'sandbox', PROPOSAL, `exp-${experimentId}`), { recursive: true })
  const report = buildExperimentReport(await svc.experiment(experimentId))
  await writeFile(reportAbs, `${JSON.stringify(report, null, 2)}\n`)

  /** A fresh service over the same ledger and store — what a restarted process (or a drift) sees. */
  const reopen = async (overrides: { verifierVersion?: string; model?: string } = {}) => {
    const reopenedCtx = {
      ...ctx,
      verifier: {
        ready: async () => {},
        verifierIds: () => ['command', 'composite', 'review'],
        verifierVersions: () => ({ command: overrides.verifierVersion ?? options.verifierVersion ?? VERIFIER_VERSION, composite: '1', review: '1' }),
      },
    }
    return new EvolutionService(reopenedCtx as never, {
      root,
      skillRoot,
      presetRoot: join(dir, 'presets'),
      configFile: join(dir, 'config.yml'),
      modelIdentity: () => overrides.model ?? options.model ?? MODEL,
    })
  }

  return {
    svc, reopen, root, skillRoot, workspace, rows, reportPath, experimentId, frozen, prepared: prepared.prepared!,
    /** Read the report back from disk, parse it, mutate it, and write it again. */
    async tamperReport(mutate: (report: Record<string, any>) => void) {
      const parsed = JSON.parse(await readFile(reportAbs, 'utf8'))
      mutate(parsed)
      await writeFile(reportAbs, `${JSON.stringify(parsed, null, 2)}\n`)
    },
    /**
     * Rewrite the ledger, and then the report file from the records that are
     * left — what a forger would do: a record pointing somewhere else is only
     * worth writing if the report agrees with it, and the gate's job is to
     * refuse it anyway (the store is what disagrees).
     */
    async tamperLedger(mutate: (records: Record<string, any>[]) => void) {
      const path = join(root, 'proposals.jsonl')
      const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, any>)
      mutate(lines)
      await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
      const service = await reopen()
      const [experiment] = await service.experiments(PROPOSAL)
      if (experiment === undefined) return
      try {
        const rebuilt = buildExperimentReport(experiment)
        await writeFile(reportAbs, `${JSON.stringify(rebuilt, null, 2)}\n`)
      } catch {
        // An experiment a tamper left incomplete has no report to forge: the
        // gate refuses it on completeness before it ever reads the file.
      }
    },
    async ledgerKinds(): Promise<string[]> {
      return (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { kind: string }).kind)
    },
  }
}

/** The refusal message of one call, or `''` when it resolved. */
async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('skill promotion gate: the completed experiment is the evidence (EVAL-2)', () => {
  it('lets a clean fix through the gate, the decision and the two production writes', async () => {
    const f = await fixture()
    const check = await f.svc.checkPromotion(PROPOSAL)
    expect(check.providers).toMatchObject([{ name: SKILL, role: 'guidance' }])
    await f.svc.gate(PROPOSAL, gateAnswers([f.reportPath]), 'root-1')
    await f.svc.decide(PROPOSAL, 'PROMOTE', 'root-1', 'approval:decide')
    const applied = await f.svc.apply(PROPOSAL, 'root-1', 'approval:apply')
    expect(applied.proposal.status).toBe('applied')
    expect(await readFile(join(f.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE)
    await f.svc.rollback(PROPOSAL, 'root-1', 'approval:rollback')
    expect(await readFile(join(f.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(PRODUCTION)
    expect(await f.ledgerKinds()).toEqual(['proposed', 'candidate', 'prepared', 'experiment_started', 'experiment_sample', 'experiment_sample', 'experiment_sample', 'experiment_sample', 'gated', 'decided', 'applied', 'rolledback'])
  })

  it('records an unknown cost without refusing when the frozen budget declares no ceiling', async () => {
    const f = await fixture()
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toBe('')
    const report = JSON.parse(await readFile(join(f.root, f.reportPath), 'utf8'))
    expect(report.samples[0].candidate.cost.status).toBe('unknown')
  })

  it('refuses a skill proposal that holds only the v1 replay report, and one with no experiment at all', async () => {
    const f = await fixture()
    // The historical shape: a v1 report on the ledger, no experiment.
    await f.tamperLedger(lines => {
      const index = lines.findIndex(line => line.kind === 'experiment_started')
      for (let at = lines.length - 1; at >= index; at -= 1) lines.splice(at, 1)
      lines.push({ formatVersion: 1, kind: 'replayed', proposalId: PROPOSAL, report: `sandbox/${PROPOSAL}/replay-report.json`, verdict: 'not-worse', tasks: [], actor: 'root-1', at: '2026-09-26T00:00:00.000Z' })
    })
    const historical = await refusal((await f.reopen()).checkPromotion(PROPOSAL))
    expect(historical).toContain('a historical report is not upgraded')
    expect(historical).toContain('v1 candidate-vs-champion replay report')

    const bare = await fixture()
    await bare.tamperLedger(lines => {
      for (let at = lines.length - 1; at >= 0; at -= 1) if (lines[at]!.kind === 'experiment_started' || lines[at]!.kind === 'experiment_sample') lines.splice(at, 1)
    })
    const none = await refusal((await bare.reopen()).checkPromotion(PROPOSAL))
    expect(none).toContain('carries no two-sided experiment')
  })

  it('refuses an experiment that is missing a side', async () => {
    const f = await fixture()
    await f.tamperLedger(lines => {
      lines.splice(lines.findIndex(line => line.kind === 'experiment_sample'), 1)
    })
    const message = await refusal((await f.reopen()).checkPromotion(PROPOSAL))
    expect(message).toContain('is incomplete')
    expect(message).toContain('resume experiment')
  })

  it('refuses a report whose bytes are not the report its records recompute to', async () => {
    const f = await fixture()
    await f.tamperReport(report => { report.samples[0].candidate.evidenceRefs = ['e-forged'] })
    const message = await refusal((await f.reopen()).checkPromotion(PROPOSAL))
    expect(message).toContain('is not the report its ledger records recompute to')
    // and nothing was decided or applied by the refusal
    expect(await f.ledgerKinds()).not.toContain('decided')
    expect(await readFile(join(f.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(PRODUCTION)
  })

  it('refuses a report that no longer exists under the ledger root', async () => {
    const f = await fixture()
    await rm(join(f.root, f.reportPath))
    expect(await refusal((await f.reopen()).checkPromotion(PROPOSAL))).toContain('cannot be read')
  })

  it('refuses a side that cites the sample\'s own historical run, and one that cites another run', async () => {
    const historical = await fixture()
    await historical.tamperLedger(lines => {
      const record = lines.find(line => line.kind === 'experiment_sample' && line.sampleTaskId === FAIL_SAMPLE && line.side === 'candidate')!
      record.taskId = FAIL_SAMPLE
      record.runId = `r-history-${FAIL_SAMPLE}`
      record.reviewRef = `${FAIL_SAMPLE}#r-history-${FAIL_SAMPLE}`
    })
    expect(await refusal((await historical.reopen()).checkPromotion(PROPOSAL))).toContain('the historical task is the case, not a baseline')

    const other = await fixture()
    await other.tamperLedger(lines => {
      const record = lines.find(line => line.kind === 'experiment_sample' && line.sampleTaskId === FAIL_SAMPLE && line.side === 'candidate')!
      record.runId = `r-${FAIL_SAMPLE}-baseline`
      record.reviewRef = `t-${FAIL_SAMPLE}-baseline#r-${FAIL_SAMPLE}-baseline`
    })
    expect(await refusal((await other.reopen()).checkPromotion(PROPOSAL))).toContain("no run of this experiment's own replay")
  })

  it.each([
    ['another run\'s evidence', 'e-r-t-fail-baseline', 'cites evidence'],
    ['an evidence id nobody holds', 'e-ghost', 'cites evidence'],
  ])('refuses evidenceRefs that name %s', async (_label, ref, expected) => {
    const f = await fixture()
    await f.tamperLedger(lines => {
      const record = lines.find(line => line.kind === 'experiment_sample' && line.sampleTaskId === FAIL_SAMPLE && line.side === 'candidate')!
      record.evidenceRefs = [ref]
    })
    expect(await refusal((await f.reopen()).checkPromotion(PROPOSAL))).toContain(expected)
  })

  it('refuses a store review record that disagrees with the side it settles', async () => {
    const f = await fixture()
    const review = f.rows.reviews.find(item => item.runId === `r-${FAIL_SAMPLE}-candidate`)!
    review.outcome = 'failed'
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('settled "failed"')
  })

  it('refuses a side whose stored review criteria disagree with the report', async () => {
    const f = await fixture()
    const review = f.rows.reviews.find(item => item.runId === `r-${FAIL_SAMPLE}-candidate`)!
    review.criteria = [{ criterionId: 'ac-fix', verdict: 'fail', verifierId: 'command', verifierVersion: VERIFIER_VERSION }]
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('the verdicts a promotion reads are the ones the store recorded')
  })

  it('refuses an experiment that names no task store', async () => {
    const f = await fixture({ omitStoreId: true })
    expect(await refusal((await f.reopen()).checkPromotion(PROPOSAL))).toContain('records no task store')
  })

  it('refuses a frozen candidate identity that is not the prepared one', async () => {
    const f = await fixture({ candidateIdentity: { name: SKILL, sha256: 'b'.repeat(64) } })
    const message = await refusal(f.svc.checkPromotion(PROPOSAL))
    expect(message).toContain('the evidence belongs to different candidate bytes')
  })

  it('refuses a frozen production baseline that is not the one prepare recorded', async () => {
    const f = await fixture({ frozenBaseline: { name: SKILL, sha256: 'c'.repeat(64) } })
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('is not the baseline prepare recorded')
  })

  it('refuses a candidate whose bytes moved after the experiment', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'sandbox', PROPOSAL, 'skills', SKILL, 'SKILL.md'), 'tampered\n')
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('no longer matches the content identity')
  })

  it('refuses a protected input that changed after the experiment', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'threshold.txt'), '41\n')
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('changed since the experiment froze it')
  })

  it('refuses a removed protected input', async () => {
    const f = await fixture()
    await rm(join(f.workspace, 'threshold.txt'))
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('cannot be read in the production workspace')
  })

  it('refuses a sample whose contract changed after the experiment', async () => {
    const f = await fixture()
    const task = f.rows.tasks.find(item => item.taskId === HOLDOUT_SAMPLE)!
    task.objective = 'a different objective now'
    expect(await refusal(f.svc.checkPromotion(PROPOSAL))).toContain('changed since the experiment froze it')
  })

  it('refuses when the registered judge moved to a new version', async () => {
    const f = await fixture()
    const message = await refusal((await f.reopen({ verifierVersion: '2' })).checkPromotion(PROPOSAL))
    expect(message).toContain('the registered instance declares 2 now')
  })

  it('refuses when the judge is no longer registered at all', async () => {
    const f = await fixture()
    const reopened = await f.reopen()
    const ctx = (reopened as unknown as { ctx: { verifier: { verifierIds(): string[] } } }).ctx
    ctx.verifier.verifierIds = () => ['composite', 'review']
    expect(await refusal(reopened.checkPromotion(PROPOSAL))).toContain('which is no longer registered')
  })

  it('refuses when the deployment cannot list its verifier vocabulary', async () => {
    const f = await fixture()
    const reopened = await f.reopen()
    const ctx = (reopened as unknown as { ctx: { verifier: { verifierIds?: () => string[]; ready?(): Promise<void> } } }).ctx
    delete ctx.verifier.verifierIds
    delete ctx.verifier.ready
    expect(await refusal(reopened.checkPromotion(PROPOSAL))).toContain("cannot be listed in this context")
  })

  it('refuses when the model identity moved', async () => {
    const f = await fixture()
    expect(await refusal((await f.reopen({ model: 'p/other' })).checkPromotion(PROPOSAL))).toContain('the experiment froze model "p/m"')
  })

  it('refuses a deployment that cannot resolve a model identity at all', async () => {
    const f = await fixture()
    const bare = new EvolutionService(
      (f.svc as unknown as { ctx: object }).ctx as never,
      { root: f.root, skillRoot: f.skillRoot, modelIdentity: () => undefined },
    )
    expect(await refusal(bare.checkPromotion(PROPOSAL))).toContain('cannot name the model its runs share')
    const unwired = new EvolutionService(
      (f.svc as unknown as { ctx: object }).ctx as never,
      { root: f.root, skillRoot: f.skillRoot },
    )
    expect(await refusal(unwired.checkPromotion(PROPOSAL))).toContain('no model-identity resolver was injected')
  })

  it.each([
    ['both sides fail the target sample', { failure: { baseline: 'failed', candidate: 'failed' } }, 'both sides failed'],
    ['the failure is not reproduced at all', { failure: { baseline: 'verified', candidate: 'verified' } }, 'did not fix the target failure'],
    ['a holdout degrades while the target is fixed', { holdout: { candidate: 'failed' } }, 'a regression or holdout sample degraded'],
    ['the target is unfixed and a regression sample degrades', { failure: { baseline: 'verified', candidate: 'failed' }, regression: { candidate: 'failed' } }, 'degraded and the target failure is not fixed'],
    ['a side never settles', { failure: { candidate: 'cancelled' } }, 'could not settle'],
  ])('refuses when %s', async (_label, options, expected) => {
    const f = await fixture(options as FixtureOptions)
    const message = await refusal(f.svc.checkPromotion(PROPOSAL))
    expect(message).toContain(expected)
    expect(message).toContain('sample ')
    expect(await f.ledgerKinds()).not.toContain('decided')
  })

  it('refuses an unknown cost when the frozen budget declares a ceiling, and allows it without one', async () => {
    const ceiling = await fixture({ budget: { maxTokens: 5_000, note: 'the fixture ceiling' } })
    expect(await refusal(ceiling.svc.checkPromotion(PROPOSAL))).toContain('an unknown cost cannot be shown to fit a ceiling')

    const reported = await fixture({ budget: { maxTokens: 5_000 }, metrics: { tokens: { uncachedInputTokens: 10, outputTokens: 5 } } })
    expect(await refusal(reported.svc.checkPromotion(PROPOSAL))).toBe('')
  })
})

describe('skill promotion gate: apply re-checks the evidence before it writes (EVAL-3)', () => {
  async function decided() {
    const f = await fixture()
    await f.svc.gate(PROPOSAL, gateAnswers([f.reportPath]), 'root-1')
    await f.svc.decide(PROPOSAL, 'PROMOTE', 'root-1', 'approval:decide')
    return f
  }

  it('refuses an apply whose report was edited after the decision, writing nothing', async () => {
    const f = await decided()
    await f.tamperReport(report => { report.samples[0].candidate.cost = { status: 'unknown', reason: 'rewritten' } })
    expect(await refusal(f.svc.apply(PROPOSAL, 'root-1', 'approval:apply'))).toContain('is not the report its ledger records recompute to')
    expect(await f.ledgerKinds()).not.toContain('applied')
    expect(await readFile(join(f.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(PRODUCTION)
  })

  it('refuses an apply whose candidate moved after the decision, writing nothing', async () => {
    const f = await decided()
    await writeFile(join(f.root, 'sandbox', PROPOSAL, 'skills', SKILL, 'SKILL.md'), 'tampered after the decision\n')
    expect(await refusal(f.svc.apply(PROPOSAL, 'root-1', 'approval:apply'))).toContain('no longer matches the content identity')
    expect(await f.ledgerKinds()).not.toContain('applied')
    expect(await readFile(join(f.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(PRODUCTION)
  })

  it('refuses an apply whose production baseline moved after the decision, writing nothing', async () => {
    const f = await decided()
    await writeFile(join(f.skillRoot, SKILL, 'SKILL.md'), '# production moved\n')
    expect(await refusal(f.svc.apply(PROPOSAL, 'root-1', 'approval:apply'))).toContain('changed since prepare')
    expect(await f.ledgerKinds()).not.toContain('applied')
  })

  it('refuses an apply whose experiment stopped standing (judge drift), writing nothing', async () => {
    const f = await decided()
    const drifted = await f.reopen({ verifierVersion: '2' })
    expect(await refusal(drifted.apply(PROPOSAL, 'root-1', 'approval:apply'))).toContain('the registered instance declares 2 now')
    expect(await f.ledgerKinds()).not.toContain('applied')
    expect(await readFile(join(f.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(PRODUCTION)
  })
})

describe('skill promotion gate: the gate answers cite the completed experiment (EVAL-2)', () => {
  it('refuses a skill gate with no experiment, and one whose experiment is incomplete', async () => {
    const bare = await fixture()
    await bare.tamperLedger(lines => {
      for (let at = lines.length - 1; at >= 0; at -= 1) if (lines[at]!.kind === 'experiment_started' || lines[at]!.kind === 'experiment_sample') lines.splice(at, 1)
    })
    expect(await refusal((await bare.reopen()).gate(PROPOSAL, gateAnswers([bare.reportPath]), 'root-1'))).toContain('has no two-sided experiment')

    const incomplete = await fixture()
    await incomplete.tamperLedger(lines => { lines.splice(lines.findIndex(line => line.kind === 'experiment_sample'), 1) })
    expect(await refusal((await incomplete.reopen()).gate(PROPOSAL, gateAnswers([incomplete.reportPath]), 'root-1'))).toContain('is incomplete')
  })

  it('requires the experiment report among the regression evidence refs', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'regression.log'), 'ok')
    expect(await refusal(f.svc.gate(PROPOSAL, gateAnswers(['sandbox/regression.log']), 'root-1'))).toContain('must cite its experiment report')
    const gated = await f.svc.gate(PROPOSAL, gateAnswers([f.reportPath]), 'root-1')
    expect(gated.status).toBe('gated')
  })
})

describe('skill promotion gate: the other target types have no evaluator (EVAL-4)', () => {
  /** A gated capability proposal, the shape the old promotion path used. */
  async function capabilityGated(svc: EvolutionService, id = 'c1') {
    await svc.propose({ proposalId: id, targetType: 'capability', targetId: 'research', baseVersion: 'v1', level: 'L2', rationale: 'the fixture row', sourceRefs: ['diagnosis:d1'] }, 'root-1')
    await svc.candidate(id, { capabilityTable: 'config.yml#doc1' }, 'root-1', { name: 'research', entry: { preset: 'standard' } })
    await svc.prepare(id, 'root-1', { capabilityEntry: { preset: 'standard' } })
    await svc.replay(id, 'root-1', {
      formatVersion: 1,
      proposalId: id,
      targetType: 'capability',
      at: '2026-09-26T00:00:00.000Z',
      mode: 'executed',
      observed: [{
        taskId: 't-case',
        candidateTaskId: 't-case-candidate',
        champion: { taskId: 't-case', outcome: 'verified', criteria: [{ criterionId: 'ac1', verdict: 'pass' }] },
        candidate: { taskId: 't-case-candidate', outcome: 'verified', criteria: [{ criterionId: 'ac1', verdict: 'pass' }] },
        verdictMatch: true,
        criteriaDiff: [],
        relation: 'not-worse',
      }],
      holdout: { executed: false, tasks: [] },
      verdict: 'not-worse',
    })
    await svc.gate(id, gateAnswers([`sandbox/${id}/replay-report.json`]), 'root-1')
  }

  it.each(['capability', 'agent_preset', 'task_definition', 'workflow_policy'] as const)(
    'refuses a %s PROMOTE with no evaluator, leaving the ledger and production untouched',
    async targetType => {
      const f = await fixture()
      await f.svc.propose({ proposalId: 'x1', targetType, targetId: 'x', baseVersion: 'v1', level: 'L2', rationale: 'the fixture target', sourceRefs: ['diagnosis:d1'] }, 'root-1')
      const message = await refusal(f.svc.checkPromotion('x1'))
      expect(message).toContain(`targets "${targetType}", which has no evaluator in this build`)
      expect(await f.ledgerKinds()).not.toContain('decided')
    },
  )

  it('refuses a capability decide and an apply reached from a legacy decided record, writing nothing', async () => {
    const f = await fixture()
    await capabilityGated(f.svc)
    const decideMessage = await refusal(f.svc.decide('c1', 'PROMOTE', 'root-1', 'approval:decide'))
    expect(decideMessage).toContain('has no evaluator in this build')
    expect(await f.ledgerKinds()).not.toContain('decided')

    // The one way an apply can still meet a capability proposal: a ledger the
    // pre-S4-E build decided. It is refused at the service entry, before the
    // write and before any approval this test does not grant.
    const lines = (await readFile(join(f.root, 'proposals.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, any>)
    lines.push({ formatVersion: 1, kind: 'decided', proposalId: 'c1', decision: 'PROMOTE', approvalRef: 'approval:legacy', actor: 'root-1', at: '2026-09-20T00:00:05.000Z' })
    await writeFile(join(f.root, 'proposals.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
    const reopened = await f.reopen()
    expect((await reopened.get('c1')).status).toBe('decided')
    const applyMessage = await refusal(reopened.apply('c1', 'root-1', 'approval:apply'))
    expect(applyMessage).toContain('has no evaluator in this build')
    expect((await reopened.get('c1')).status).toBe('decided')
  })

  it('keeps an old applied capability readable and rollback intact', async () => {
    const f = await fixture()
    const configFile = join((f.svc as unknown as { configFile: string }).configFile)
    await writeFile(configFile, ['- id: task-runtime', '  config:', '    capabilities:', '      research: { preset: changed }', '', '---', 'api:', '  upstream: https://example.invalid', ''].join('\n'))
    await writeFile(join(f.root, 'proposals.jsonl'), [
      { formatVersion: 1, kind: 'proposed', proposalId: 'old1', targetType: 'capability', targetId: 'research', baseVersion: 'v1', level: 'L2', rationale: 'the old record', sourceRefs: ['diagnosis:d0'], actor: 'root-1', at: '2026-09-20T00:00:00.000Z' },
      { formatVersion: 1, kind: 'candidate', proposalId: 'old1', versionSet: { capabilityTable: 'config.yml#doc1' }, mutation: { name: 'research', entry: { preset: 'standard' } }, actor: 'root-1', at: '2026-09-20T00:00:01.000Z' },
      { formatVersion: 1, kind: 'prepared', proposalId: 'old1', sandbox: 'sandbox/old1', mechanical: true, champion: 'captured', championSource: 'config-text', files: ['capability-table.patch.yml'], actor: 'root-1', at: '2026-09-20T00:00:02.000Z' },
      { formatVersion: 1, kind: 'replayed', proposalId: 'old1', report: 'sandbox/old1/replay-report.json', verdict: 'not-worse', tasks: [], actor: 'root-1', at: '2026-09-20T00:00:03.000Z' },
      { formatVersion: 1, kind: 'gated', proposalId: 'old1', gate: gateAnswers(['sandbox/old1/replay-report.json']), actor: 'root-1', at: '2026-09-20T00:00:04.000Z' },
      { formatVersion: 1, kind: 'decided', proposalId: 'old1', decision: 'PROMOTE', approvalRef: 'approval:decide', actor: 'root-1', at: '2026-09-20T00:00:05.000Z' },
      { formatVersion: 1, kind: 'applied', proposalId: 'old1', targets: [`${configFile} — document 1 task-runtime capabilities row "research"`], approvalRef: 'approval:apply', actor: 'root-1', at: '2026-09-20T00:00:06.000Z' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    await mkdir(join(f.root, 'sandbox', 'old1', 'champion'), { recursive: true })
    await writeFile(join(f.root, 'sandbox', 'old1', 'champion', 'capability-table.entry.yml'), '# Champion snapshot — capability "research" as in effect at prepare time\n{"research":{"preset":"standard"}}\n')
    await writeFile(join(f.root, 'sandbox', 'old1', 'champion', 'capability-table.source.txt'), '      research: { preset: standard }\n')

    const reopened = await f.reopen()
    const read = await reopened.get('old1')
    expect(read.status).toBe('applied')
    expect(read.applied?.approvalRef).toBe('approval:apply')
    expect((await reopened.list({ targetType: 'capability' })).map(item => item.proposalId)).toContain('old1')
    const rolledback = await reopened.rollback('old1', 'root-1', 'approval:rollback')
    expect(rolledback.proposal.status).toBe('rolledback')
    expect(await readFile(configFile, 'utf8')).toContain('research: { preset: standard }')
    expect(existsSync(join(f.root, 'proposals.jsonl'))).toBe(true)
  })
})

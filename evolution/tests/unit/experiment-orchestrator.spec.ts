/**
 * The orchestrator's own rules (S4-E §F.2), driven end to end against a stub
 * ledger, store and runtime: what a repeat call does with a key that is already
 * spent, what it does with a key whose run the store still holds, and what it
 * refuses. The *real* deployment's two-sided runs live in
 * `tests/integration/experiment-runner.spec.ts`; this file is about the
 * decisions the orchestrator makes around them, which need scripted outcomes
 * (a terminal run, a run nobody settled, a ledger line that disagrees with the
 * store) to reach deterministically.
 *
 * The stub ledger is not a second implementation: it validates every staged
 * line through the real `foldExperiments`, so a rule the ledger enforces is a
 * rule these cases exercise.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReviewCriterion, ReviewRecord, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal } from '../../src/evolution.ts'
import type {
  ExperimentLedger,
  ExperimentRecord,
  ExperimentSampleRecord,
  ExperimentSources,
  ExperimentView,
} from '../../src/experiment.ts'
import { directoryDigest, experimentLineage, runExperiment } from '../../src/experiment.ts'
import type { FrozenExperiment } from '../../src/replay.ts'
import { foldExperiments, frozenDigestOf } from '../../src/index.ts'

const PROPOSAL = 'p1'
const SKILL = 'fixture-skill'
const CANDIDATE_BYTES = '---\nname: fixture-skill\ndescription: candidate\n---\n\nthe candidate\n'
const CALLER = 's-root' as never

interface Call {
  championTaskId: string
  lineage: string
  workspace?: string
  extraSkillRoots: readonly string[]
}

/** What the scripted runtime answers with, one entry per run it is asked for. */
interface ScriptedOutcome {
  outcome: 'verified' | 'failed' | 'cancelled'
  criteria?: ReviewCriterion[]
  /** `true` for a run whose review record reports no metrics at all — the cost this plane must call unknown. */
  noMetrics?: boolean
}

/** A little world: one prepared skill proposal, one store, one scripted runtime, one ledger. */
async function world(options: { outcomes?: ScriptedOutcome[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'experiment-orchestrator-'))
  const snapshotDir = join(root, 'snapshot')
  await mkdir(join(snapshotDir, 'nested'), { recursive: true })
  await writeFile(join(snapshotDir, 'input.txt'), 'the frozen input\n', 'utf8')
  await writeFile(join(snapshotDir, 'nested', 'threshold.txt'), '42\n', 'utf8')
  const ledgerRoot = join(root, 'ledger')
  const sandbox = join(ledgerRoot, 'sandbox', PROPOSAL)
  await mkdir(join(sandbox, 'skills', SKILL), { recursive: true })
  await writeFile(join(sandbox, 'skills', SKILL, 'SKILL.md'), CANDIDATE_BYTES, 'utf8')

  const proposal = {
    proposalId: PROPOSAL,
    targetType: 'skill',
    targetId: SKILL,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the fixture candidate',
    sourceRefs: ['diagnosis:d1'],
    status: 'prepared',
    prepared: {
      sandbox: `sandbox/${PROPOSAL}`,
      mechanical: true,
      champion: 'captured',
      skillContent: { name: SKILL, sha256: digestOfBytes(CANDIDATE_BYTES) },
      skillBaseline: { name: SKILL, sha256: 'b'.repeat(64) },
      files: [`skills/${SKILL}/SKILL.md`],
    },
    history: [],
  } as unknown as EvolutionProposal

  const tasks: TaskInstance[] = []
  const runs: TaskRun[] = []
  const reviews: ReviewRecord[] = []
  const evidence: unknown[] = []
  const calls: Call[] = []
  const scripted = [...(options.outcomes ?? [])]
  let counter = 0

  const sample = (input: {
    taskId: string
    runId: string
    objective: string
    outcome: 'verified' | 'failed'
    criterionId: string
    command: string
  }) => {
    tasks.push({
      taskId: input.taskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: input.objective,
      depth: 0,
      acceptanceCriteria: [{
        criterionId: input.criterionId,
        description: 'it holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: input.command,
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: input.outcome,
      runIds: [input.runId],
      childTaskIds: [],
    } as unknown as TaskInstance)
    runs.push({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: `s-${input.taskId}`,
      capabilitySnapshot: [],
      status: input.outcome,
      startedAt: '2026-09-26T00:00:00.000Z',
    } as unknown as TaskRun)
    reviews.push({
      taskId: input.taskId,
      runId: input.runId,
      sessionId: `s-${input.taskId}`,
      outcome: input.outcome,
      evidenceRefs: [`e-${input.runId}`],
      anomalies: ['the historical run the sample locates'],
      ...(input.outcome === 'failed' ? { localizedCause: 'the answer file was never produced' } : {}),
      criteria: [{ criterionId: input.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
    } as unknown as ReviewRecord)
  }
  sample({ taskId: 't-fix', runId: 'r-fix-history', objective: 'the answer file is produced', outcome: 'failed', criterionId: 'ac-fix', command: 'test -f fix.txt' })
  sample({ taskId: 't-holdout', runId: 'r-holdout-history', objective: 'the held-out answer file is produced', outcome: 'verified', criterionId: 'ac-hold', command: 'test -f holdout.txt' })

  const snapshot = (): TaskSnapshot => ({
    version: 1,
    id: 'store',
    tasks,
    runs,
    edges: [],
    evidence,
    handoffs: [],
    reviews,
    diagnoses: [],
    obligations: [],
    capabilities: {},
  } as unknown as TaskSnapshot)

  const records: ExperimentRecord[] = []
  const proposals = new Map<string, EvolutionProposal>([[PROPOSAL, proposal]])
  const folded = (): Map<string, ExperimentView> => foldExperiments(records, proposals)
  const ledger: ExperimentLedger = {
    root: ledgerRoot,
    get: async () => proposal,
    readSkillCandidate: async () => Buffer.from(CANDIDATE_BYTES, 'utf8'),
    experiment: async (experimentId: string) => {
      const view = folded().get(experimentId)
      if (view === undefined) throw new Error(`evolution: unknown experiment "${experimentId}"`)
      return view
    },
    experiments: async () => [...folded().values()].reverse(),
    recordExperimentStart: async record => {
      if (folded().has(record.experimentId)) return
      foldExperiments([...records, record], proposals)
      records.push(record)
    },
    recordExperimentSample: async record => {
      foldExperiments([...records, record], proposals)
      records.push(record)
    },
  }

  const sources: ExperimentSources = {
    evolution: ledger,
    graphs: { graphForSession: async () => ({ rootSessionId: 's-root' as never }) },
    task: { openStore: async () => snapshot() },
    taskRuntime: {
      replayTask: async (_storeId: string, championTaskId: string, taskOptions: ReplayTaskOptions): Promise<ReplayRunOutcome> => {
        counter += 1
        const scriptedOutcome = scripted.shift() ?? { outcome: 'verified' as const }
        const taskId = `t-replay-${counter}`
        const runId = `r-replay-${counter}`
        calls.push({
          championTaskId,
          lineage: taskOptions.lineage,
          ...(taskOptions.workspace === undefined ? {} : { workspace: taskOptions.workspace.path }),
          extraSkillRoots: taskOptions.overlay?.extraSkillRoots ?? [],
        })
        tasks.push({
          taskId,
          definitionRef: { taskType: 'root', version: 1 },
          objective: `[${taskOptions.lineage}] a replay of ${championTaskId}`,
          depth: 0,
          acceptanceCriteria: [],
          requestedCapabilities: [],
          decompositionStatus: 'leaf',
          status: scriptedOutcome.outcome,
          runIds: [runId],
          childTaskIds: [],
        } as unknown as TaskInstance)
        runs.push({
          runId,
          taskId,
          sessionId: `s-${taskId}`,
          capabilitySnapshot: [],
          status: scriptedOutcome.outcome,
          startedAt: '2026-09-26T00:00:00.000Z',
        } as unknown as TaskRun)
        reviews.push({
          taskId,
          runId,
          sessionId: `s-${taskId}`,
          outcome: scriptedOutcome.outcome,
          evidenceRefs: [`e-${runId}`],
          anomalies: [taskOptions.lineage],
          criteria: scriptedOutcome.criteria ?? [{ criterionId: 'ac', verdict: 'pass', verifierId: 'command' }],
          ...(scriptedOutcome.noMetrics === true
            ? {}
            : { metrics: { tokens: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
        } as unknown as ReviewRecord)
        evidence.push({ evidenceId: `e-${runId}`, taskRunId: runId, taskId })
        return {
          taskId,
          runId,
          status: scriptedOutcome.outcome,
          criteria: scriptedOutcome.criteria ?? [{ criterionId: 'ac', verdict: 'pass', verifierId: 'command' }],
          ...(taskOptions.workspace === undefined ? {} : { workspace: taskOptions.workspace.path }),
        }
      },
    },
  }

  return {
    root,
    snapshotDir,
    ledgerRoot,
    sources,
    ledger,
    records,
    calls,
    tasks,
    runs,
    reviews,
    proposal,
    spec: (overrides: { model?: string; repetition?: number } = {}) => ({
      proposalId: PROPOSAL,
      samples: [
        { taskId: 't-fix', role: 'observed-failure' as const },
        { taskId: 't-holdout', role: 'holdout' as const },
      ],
      snapshot: { sourceDir: snapshotDir },
      model: overrides.model ?? 'scripted:stub',
      budget: { note: 'the stub budget' },
      repetition: overrides.repetition ?? 0,
    }),
  }
}

function digestOfBytes(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** The recorded sample of one key, as the ledger holds it. */
function recordOf(records: readonly ExperimentRecord[], sampleTaskId: string, side: 'baseline' | 'candidate'): ExperimentSampleRecord {
  const found = records.find((record): record is ExperimentSampleRecord =>
    record.kind === 'experiment_sample' && record.sampleTaskId === sampleTaskId && record.side === side)
  if (found === undefined) throw new Error(`the stub ledger holds no ${sampleTaskId}/${side} record`)
  return found
}

describe('the two-sided orchestrator', () => {
  it('runs both sides from one frozen snapshot, and reuses every key on a repeat call', async () => {
    const w = await world({
      outcomes: [
        { outcome: 'failed', criteria: [{ criterionId: 'ac-fix', verdict: 'fail', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-fix', verdict: 'pass', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-hold', verdict: 'pass', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-hold', verdict: 'pass', verifierId: 'command' }] },
      ],
    })
    const result = await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })

    expect(w.calls).toHaveLength(4)
    expect(result.report.verdict).toBe('fixed')
    expect(result.report.samples.map(item => item.verdict)).toEqual(['fixed', 'maintained'])

    // The baseline side runs under the production configuration and the
    // candidate side under the prepared sandbox's skills root — the one overlay
    // this plane may apply.
    const candidateCalls = w.calls.filter(call => call.extraSkillRoots.length > 0)
    expect(candidateCalls).toHaveLength(2)
    for (const call of candidateCalls) {
      expect(call.extraSkillRoots).toEqual([join(w.ledgerRoot, 'sandbox', PROPOSAL, 'skills')])
    }

    // Both sides' workspaces are built from the frozen snapshot — the build is
    // the bytes' only writer before the run, so the digest still proves it.
    const snapshotDigest = result.report.frozen.snapshot.digest
    for (const sample of result.report.samples) {
      for (const detail of [sample.baseline, sample.candidate]) {
        expect(detail.workspace).toBe(join(w.ledgerRoot, 'sandbox', PROPOSAL, `exp-${result.experimentId}`, sample.taskId, detail.side))
        expect(detail.initialDigest).toBe(snapshotDigest)
        expect(await directoryDigest(detail.workspace!)).toBe(snapshotDigest)
      }
      expect(sample.baseline.workspace).not.toBe(sample.candidate.workspace)
    }

    // The report on disk is the one returned, and the ledger holds it all.
    const onDisk = JSON.parse(await readFile(join(w.ledgerRoot, result.reportPath), 'utf8'))
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(result.report)))
    expect(candidateCalls[0]!.lineage).toBe(experimentLineage(result.experimentId, 't-fix', 'candidate'))

    const repeat = await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    expect(w.calls).toHaveLength(4)
    expect(JSON.stringify(repeat.report)).toBe(JSON.stringify(result.report))
    expect(w.records.filter(record => record.kind === 'experiment_sample')).toHaveLength(4)
    await rm(w.root, { recursive: true, force: true })
  })

  it('refuses a recorded side whose run no run of this experiment created, and re-runs nothing', async () => {
    const w = await world()
    await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    expect(w.calls).toHaveLength(4)

    // A ledger read by a restarted process, claiming the sample's own
    // historical run as this experiment's baseline.
    const tampered = recordOf(w.records, 't-fix', 'baseline')
    tampered.runId = 'r-fix-history'
    tampered.reviewRef = 't-fix#r-fix-history'

    await expect(runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' }))
      .rejects.toThrow(/which no run of this experiment's own replay .* created/)
    expect(w.calls).toHaveLength(4)
    expect(w.records.filter(record => record.kind === 'experiment_sample')).toHaveLength(4)
    await rm(w.root, { recursive: true, force: true })
  })

  it('settles a side whose run the store holds without a record, and never re-runs it', async () => {
    const w = await world()
    await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    const recorded = recordOf(w.records, 't-fix', 'baseline')
    const runId = recorded.runId!

    // A process that died between starting the run and recording it: the run is
    // in the store and never settled, and the ledger has no line for the key.
    w.records.splice(w.records.findIndex(record => record.kind === 'experiment_sample' && record.runId === runId), 1)
    w.runs.find(run => run.runId === runId)!.status = 'running'
    w.reviews.splice(w.reviews.findIndex(review => review.runId === runId), 1)

    const resumed = await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    expect(w.calls).toHaveLength(4)
    const interrupted = resumed.report.samples[0]!.baseline
    expect(interrupted.outcome).toBe('interrupted')
    expect(interrupted.runId).toBe(runId)
    expect(interrupted.reason).toMatch(/holds run .* as running .*never re-runs an in-flight sample/)
    expect(interrupted.cost).toEqual({ status: 'unknown', reason: 'the run never settled, so it reported no cost' })
    expect(resumed.report.verdict).toBe('inconclusive')

    // And once more: the record is what it is, and nothing runs again.
    const again = await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    expect(w.calls).toHaveLength(4)
    expect(JSON.stringify(again.report)).toBe(JSON.stringify(resumed.report))
    await rm(w.root, { recursive: true, force: true })
  })

  it('settles a side whose settled run the store holds without a record, as the store settled it', async () => {
    const w = await world({
      outcomes: [
        { outcome: 'failed', criteria: [{ criterionId: 'ac-fix', verdict: 'fail', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-fix', verdict: 'pass', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-hold', verdict: 'pass', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-hold', verdict: 'pass', verifierId: 'command' }] },
      ],
    })
    await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    const recorded = recordOf(w.records, 't-holdout', 'candidate')
    w.records.splice(w.records.findIndex(record => record.kind === 'experiment_sample' && record.runId === recorded.runId), 1)

    const resumed = await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    // No new run: the terminal record the store holds is recorded as it stands,
    // with the frozen digest its workspace was built from.
    expect(w.calls).toHaveLength(4)
    const recovered = resumed.report.samples[1]!.candidate
    expect(recovered.outcome).toBe('verified')
    expect(recovered.runId).toBe(recorded.runId)
    expect(recovered.reviewRef).toBe(`${recovered.taskId}#${recorded.runId}`)
    expect(recovered.cost).toEqual({ status: 'reported', metrics: expect.objectContaining({ tokens: expect.any(Object) }) })
    expect(resumed.report.verdict).toBe('fixed')
    await rm(w.root, { recursive: true, force: true })
  })

  it('refuses a key another frozen experiment spent, before any ledger write or run', async () => {
    const w = await world()
    await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    const linesBefore = w.records.length

    await expect(runExperiment(w.sources, { spec: w.spec({ model: 'scripted:other' }), caller: CALLER, actor: 'root-1' }))
      .rejects.toThrow(/is already recorded by experiment .* and its record is never overwritten/)
    expect(w.records).toHaveLength(linesBefore)
    expect(w.calls).toHaveLength(4)

    // The explicit new experiment a higher repetition freezes runs its own runs.
    const second = await runExperiment(w.sources, { spec: w.spec({ repetition: 1 }), caller: CALLER, actor: 'root-1' })
    expect(w.calls).toHaveLength(8)
    expect(second.report.frozen.repetition).toBe(1)
    expect(second.experimentId).not.toBe('')
    const frozen: FrozenExperiment = second.report.frozen
    expect(frozenDigestOf(frozen)).toBe(second.report.frozenDigest)
    await rm(w.root, { recursive: true, force: true })
  })

  it('reports the cost a run reported, and unknown — never a zero — when it reported none', async () => {
    const w = await world({
      outcomes: [
        { outcome: 'failed', criteria: [{ criterionId: 'ac-fix', verdict: 'fail', verifierId: 'command' }], noMetrics: true },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-fix', verdict: 'pass', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-hold', verdict: 'pass', verifierId: 'command' }] },
        { outcome: 'verified', criteria: [{ criterionId: 'ac-hold', verdict: 'pass', verifierId: 'command' }] },
      ],
    })
    const result = await runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' })
    // The run that reported nothing is `unknown`, with the reason: not a report
    // of zero tokens, which would be a claim nobody made.
    expect(result.report.samples[0]!.baseline.cost).toEqual({
      status: 'unknown',
      reason: "the run's review record carries no metrics, so no cost was reported for it",
    })
    expect(result.report.samples[0]!.candidate.cost).toEqual({
      status: 'reported',
      metrics: { tokens: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    })
    expect(result.report.verdict).toBe('fixed')
    await rm(w.root, { recursive: true, force: true })
  })

  it('refuses a proposal that is not a prepared single-file skill replacement', async () => {
    const w = await world()
    const prepared = w.proposal.prepared!
    // A candidate prepared against a skill that was not there: this experiment
    // evaluates replacements, and says so instead of inventing a baseline.
    w.proposal.prepared = { ...prepared, champion: 'missing', skillBaseline: undefined }
    await expect(runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' }))
      .rejects.toThrow(/no production skill to replace/)
    expect(w.calls).toHaveLength(0)
    expect(w.records).toHaveLength(0)

    w.proposal.prepared = { ...prepared, skillContent: undefined }
    await expect(runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' }))
      .rejects.toThrow(/carries no candidate content identity/)
    expect(w.records).toHaveLength(0)
    await rm(w.root, { recursive: true, force: true })
  })

  it('refuses a snapshot link that escapes it before the first run, with no ledger line and no workspace', async () => {
    const w = await world()
    const outside = join(w.root, 'outside.txt')
    await writeFile(outside, 'the production bytes\n', 'utf8')
    await symlink(outside, join(w.snapshotDir, 'shared'))

    await expect(runExperiment(w.sources, { spec: w.spec(), caller: CALLER, actor: 'root-1' }))
      .rejects.toThrow(/outside the snapshot root/)

    // Nothing ran, nothing was recorded, no side's workspace was built, and the
    // file the link names was never read or written.
    expect(w.calls).toHaveLength(0)
    expect(w.records).toHaveLength(0)
    expect(await readdir(join(w.ledgerRoot, 'sandbox', PROPOSAL))).toEqual(['skills'])
    expect(await readFile(outside, 'utf8')).toBe('the production bytes\n')
    await rm(w.root, { recursive: true, force: true })
  })
})

/**
 * Running one frozen plan: both sides of every sample, each in its own workspace
 * and each bound to the revision the plan froze. The facts come from the
 * runtime's own sealed execution receipt — never from a re-read of the evidence
 * the runtime already read.
 */

import type { ExecutionReceipt, RunId, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { TERMINAL_RUN_STATUSES } from '@dangosys/dsh-singularity-task'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import { agentOptionsOf, modelSelectionOf } from '../model.ts'
import { digestOf } from '../shared.ts'
import { receiptRefOf } from '../evidence/receipt.ts'
import { materializeSideWorkspace } from '../evidence/snapshot.ts'
import type { EvaluationSources } from './sources.ts'
import type { AdmissionRefusal, EvaluationPlan, ExecutionReceiptRef, PlannedSample, TrialResult } from '../types.ts'

/** What one evaluation call asks for. */
export interface RunInput {
  readonly plan: EvaluationPlan
  readonly evaluationId: string
  readonly actor: string
  readonly signal?: AbortSignal
  readonly maxParallel?: number
}

/** What one run settled as. */
export interface RunResult {
  readonly storeId: string
  readonly trials: readonly TrialResult[]
  readonly receipts: ReadonlyMap<string, ExecutionReceipt>
}

/** The key one side of one sample is addressed by, inside one evaluation. */
export function sideKey(sampleTaskId: string, side: 'baseline' | 'candidate'): string {
  return `${sampleTaskId}\u0000${side}`
}

/** A refused side's own receipt reference: nothing ran, and the reference says exactly that. */
function refusedReceipt(input: {
  sampleTaskId: string
  side: 'baseline' | 'candidate'
  workspace: string
  workspaceDigest: string
  model: string
  revisionId: string
  admission: AdmissionRefusal
}): ExecutionReceiptRef {
  return {
    receiptId: `refused:${input.sampleTaskId}:${input.side}`,
    digest: digestOf({ refused: input.sampleTaskId, side: input.side, admission: input.admission }),
    criteria: [],
    evidenceRefs: [],
    cost: { status: 'unknown', reason: 'no run exists for a side the runtime refused at admission' },
    boundRevision: input.revisionId,
    boundModel: input.model,
    workspace: input.workspace,
    workspaceDigest: input.workspaceDigest,
    complete: false,
    incompleteness: [`admission-refusal: ${input.admission.reason}`],
  }
}

/** The terminal run one replay outcome names, read back from the store. */
function terminalRunOf(snapshot: TaskSnapshot, outcome: ReplayRunOutcome): { runId: RunId; taskId: string } {
  const task = snapshot.tasks.find(item => item.taskId === outcome.taskId)
  if (task === undefined) throw new Error(`the replay created task "${outcome.taskId}", which the store does not hold`)
  const run = snapshot.runs.filter(item => item.taskId === task.taskId).at(-1)
  if (run === undefined) throw new Error(`task "${task.taskId}" holds no run after its replay`)
  return { runId: run.runId, taskId: task.taskId }
}

function outcomeOf(status: string): TrialResult['outcome'] {
  if (status === 'verified') return 'verified'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'interrupted'
}

/** One side of one sample, run to its terminal state and normalized into the one trial schema. */
async function runSide(input: {
  sources: EvaluationSources
  plan: EvaluationPlan
  sample: PlannedSample
  side: 'baseline' | 'candidate'
  storeId: string
  signal?: AbortSignal
}): Promise<{ trial: TrialResult; receipt?: ExecutionReceipt }> {
  const { plan, sample, side } = input
  const sidePlan = plan.sides[side]
  const workspace = await materializeSideWorkspace({
    planInput: plan.input,
    root: `${input.sources.root}/workspaces/${plan.draftId}/${plan.planId}`,
    sampleTaskId: sample.taskId,
    side,
  })
  const model = sidePlan.model
  if (side === 'baseline' && sample.admission !== undefined) {
    return {
      trial: {
        sampleTaskId: sample.taskId,
        side,
        role: sample.role,
        outcome: 'not-admitted',
        receipt: refusedReceipt({
          sampleTaskId: sample.taskId,
          side,
          workspace: workspace.path,
          workspaceDigest: workspace.digest,
          model: `${model.provider}/${model.model}`,
          revisionId: sidePlan.revision.revisionId,
          admission: sample.admission,
        }),
        admission: sample.admission,
        reason: sample.admission.reason,
        actor: input.sources.caller,
        at: new Date().toISOString(),
      },
    }
  }
  const options: ReplayTaskOptions = {
    lineage: `evolution-eval:${plan.draftId}:${sample.taskId}:${side}`,
    workspace: { path: workspace.path, ...(plan.input.rebaseFrom === undefined ? {} : { rebaseFrom: plan.input.rebaseFrom }) },
    agentOptions: agentOptionsOf(model) as ReplayTaskOptions['agentOptions'],
    ...(side === 'candidate' ? { trialCandidateRef: sidePlan.revision.revisionId } : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
  if (side === 'candidate') {
    // The candidate side runs under its own revision's table in every case: the
    // replayed contract requests the rows the candidate adds over the baseline
    // and the overlay's overrides resolve them against the candidate revision's
    // own rows, so the run's receipt shows the asset bound and loaded rather
    // than the plan merely claiming it. A capability draft whose row the
    // contract already required adds no *new* row — the overlay is still what
    // lets the side resolve it from the candidate revision at all.
    const addedRows = plan.sides.candidate.capabilities.filter(row => !plan.sides.baseline.capabilities.includes(row))
    const championSnapshot = await input.sources.tasks.openStore(input.storeId)
    const champion = championSnapshot.tasks.find(item => item.taskId === sample.taskId)
    if (champion === undefined) throw new Error(`sample "${sample.taskId}" is absent from this graph's task store`)
    const candidateRevision = await input.sources.runtime.revision(input.sources.caller, sidePlan.revision.revisionId)
    options.contract = {
      objective: champion.objective,
      acceptanceCriteria: champion.acceptanceCriteria,
      requiredCapabilities: [...new Set([...champion.requestedCapabilities, ...addedRows])].sort(),
    }
    options.overlay = { capabilityOverrides: { ...candidateRevision.capabilityRows } }
  }
  const outcome = await input.sources.runtime.replayTask(input.storeId, sample.taskId, options, input.sources.caller)
  if (outcome.workspace !== undefined && outcome.workspace !== workspace.path) {
    throw new Error(
      `the replay of "${sample.taskId}" reported workspace "${outcome.workspace}" but was given "${workspace.path}"; a side's frozen input and ` +
        'the directory its run went through must be the same directory',
    )
  }
  const snapshot = await input.sources.tasks.openStore(input.storeId)
  const { runId, taskId } = terminalRunOf(snapshot, outcome)
  const run = snapshot.runs.find(item => item.runId === runId)!
  let receipt = await input.sources.tasks.receiptFor(input.storeId, runId)
  if (receipt === undefined && input.sources.tasks.sealReceipt !== undefined) {
    await input.sources.tasks.sealReceipt(input.storeId, taskId, runId)
    receipt = await input.sources.tasks.receiptFor(input.storeId, runId)
  }
  const at = new Date().toISOString()
  if (receipt === undefined) {
    throw new Error(
      `evolution: run "${runId}" of sample "${sample.taskId}" (${side} side) settled without a sealed execution receipt, so the side's own facts ` +
        'cannot be read — a side is measured by the runtime\'s receipt, never by a second reading of its logs',
    )
  }
  const trial: TrialResult = {
    sampleTaskId: sample.taskId,
    side,
    role: sample.role,
    outcome: TERMINAL_RUN_STATUSES.has(run.status) ? outcomeOf(run.status) : 'interrupted',
    receipt: receiptRefOf({
      snapshot,
      receipt,
      workspace: workspace.path,
      workspaceDigest: workspace.digest,
      model,
      revisionId: sidePlan.revision.revisionId,
    }),
    ...(TERMINAL_RUN_STATUSES.has(run.status) ? {} : { reason: `run "${runId}" had not reached a terminal state when the side was read` }),
    actor: input.sources.caller,
    at,
  }
  return { trial, receipt }
}

/**
 * Run every sample side of one frozen plan, bounded by the runtime's own worker
 * limit. A cancelled side stops the further sides of the plan; every side that
 * settled stays recorded.
 */
export async function runEvaluation(sources: EvaluationSources, input: RunInput): Promise<RunResult> {
  const plan = input.plan
  const storeId = await sources.runtime.storeOfSession(sources.caller)
  const pending = plan.samples.flatMap(sample => (['baseline', 'candidate'] as const).map(side => ({ sample, side })))
  const limit = input.maxParallel ?? sources.runtime.maxActiveWorkers()
  if (!Number.isInteger(limit) || limit < 1) throw new Error('evolution: maxParallel must be a positive integer')
  const trials: TrialResult[] = []
  const receipts = new Map<string, ExecutionReceipt>()
  let next = 0
  let stopped = false
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (!stopped && next < pending.length) {
      const { sample, side } = pending[next++]!
      if (input.signal?.aborted) return
      const { trial, receipt } = await runSide({ sources, plan, sample, side, storeId, ...(input.signal === undefined ? {} : { signal: input.signal }) })
      trials.push(trial)
      if (receipt !== undefined) receipts.set(sideKey(sample.taskId, side), receipt)
      if (trial.outcome === 'cancelled') stopped = true
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, pending.length) }, async () => {
      try {
        await worker()
      } catch (error) {
        stopped = true
        failure ??= error
      }
    }),
  )
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure))
  trials.sort((left, right) => (left.sampleTaskId === right.sampleTaskId ? (left.side < right.side ? -1 : 1) : left.sampleTaskId < right.sampleTaskId ? -1 : 1))
  return { storeId, trials, receipts }
}

/** The agent options one plan's model travels as, as the runtime's own shape. */
export function agentOptionsForModel(provider: string, model: string): ReturnType<typeof agentOptionsOf> {
  const selection = modelSelectionOf({ provider, model })
  if (selection === undefined) throw new Error('evolution: a plan side carries no usable model selection')
  return agentOptionsOf(selection)
}

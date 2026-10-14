import { REVIEW_DIGEST } from '../review/protocol.ts'
/** Shared task projection and execution receipts derived from each run's sealed control prefix. */

import { assertEnvelope, digestOf, type Envelope } from '../protocol/envelope.ts'
import { foldSubject } from '../protocol/fold.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import type { BubbleInput } from './bubble.ts'
import type { AcceptanceCriterion, TaskContract } from './contract.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunState, type RunStatus, type RunSubmission, type TaskState,
} from './protocol.ts'

/** One criterion and the verdict it received, as a reader sees it. */
export interface CriterionVerdictView {
  readonly criterionId: string
  readonly statement: string
  /** The implementation this criterion names. */
  readonly verifierRef: string
  readonly verifierVersion: string
  /** The content digest of the implementation the criterion names. */
  readonly implementationDigest: string
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown' | 'unjudged'
  /** The implementation that actually decided it, or `null` while unjudged. */
  readonly decidedBy: string | null
  /** The artifact content the verdict was formed on, or `null` while unjudged. */
  readonly artifactDigest: string | null
  readonly actor: string | null
  readonly detail: string | null
}

export interface RunView {
  readonly runId: string
  readonly status: RunStatus
  /** The trusted role and identity that started it, as the log stamped them. */
  readonly emitter: string
  readonly actor: string
  readonly revision: RevisionRef
  readonly startedAt: string
  readonly finishedAt: string | null
  /** `null` when the failure recorded no reason — never an invented one. */
  readonly failureReason: string | null
  readonly failureCause: NonNullable<RunState['failureCause']> | null
  readonly verdicts: readonly CriterionVerdictView[]
}

/** The whole task as one reader sees it. The UI's contract, and the agent renderer's input. */
export interface TaskView {
  readonly taskId: string
  readonly goal: string
  readonly contractDigest: string
  readonly admittedBy: string
  readonly admittedAt: string
  readonly phase: 'awaiting-run' | 'running' | 'verified' | 'failed'
  readonly criteria: readonly AcceptanceCriterion[]
  readonly runs: readonly RunView[]
}

/** A terminal run's execution facts, recomputed from the log rather than stored. */
export interface ReceiptView {
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: string
  readonly revision: RevisionRef
  /** One past this run's terminal control fact; later facts do not move this bound. */
  readonly cutoff: number
  readonly executor: { readonly emitter: string; readonly actor: string }
  readonly status: 'verified' | 'failed'
  readonly startedAt: string
  readonly finishedAt: string
  readonly submission: RunSubmission | null
  readonly source: RunSubmission['source'] | null
  /** Judged inputs name a recorded verdict; the workspace remains the run's declaration. */
  readonly consumption: {
    readonly basis: typeof DECLARED_BASIS | typeof JUDGED_BASIS
    readonly inputs: readonly BubbleInput[]
    readonly workspace: { readonly kind: string; readonly ref: string } | null
  }
  readonly criteria: readonly {
    readonly criterionId: string
    readonly verifierRef: string
    readonly verifierVersion: string
    readonly implementationDigest: string
    readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown' | 'unjudged'
    readonly artifactDigest: string | null
    readonly actor: string | null
  }[]
}

/** The two bases a receipt can report. Named once here, where the bit is decided. */
const DECLARED_BASIS = 'declared'
const JUDGED_BASIS = 'judged'

function requireContract(state: TaskState): { contract: TaskContract; digest: string; by: string; at: string } {
  const { contract, contractDigest, admittedBy, admittedAt } = state
  if (contract === undefined || contractDigest === undefined || admittedBy === undefined || admittedAt === undefined)
    refuse(
      'illegal-transition',
      `task "${state.taskId}" has facts but no admitted contract; only an admitted task carries runs, so this state is not one the protocol can produce`,
    )
  return { contract, digest: contractDigest, by: admittedBy, at: admittedAt }
}

function verdictOf(run: RunState, criterionId: string): RunState['evidence'][number] | undefined {
  return run.evidence.find((entry) => entry.criterionId === criterionId)
}

function phaseOf(runs: readonly RunState[]): TaskView['phase'] {
  if (runs.length === 0) return 'awaiting-run'
  if (runs.some((run) => run.status === 'running')) return 'running'
  if (runs.some((run) => run.status === 'verified')) return 'verified'
  return 'failed'
}

/** Project one folded task state into the one view every reader shares. */
export function projectTask(state: TaskState): TaskView {
  const { contract, digest, by, at } = requireContract(state)
  const runStates = Object.values(state.runs).sort((left, right) =>
    left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : 0,
  )
  const runs: RunView[] = runStates.map((run) => ({
    runId: run.runId,
    status: run.status,
    emitter: run.emitter,
    actor: run.actor,
    revision: run.revision,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    failureReason: run.failureReason ?? null,
    failureCause: run.failureCause ?? null,
    verdicts: contract.criteria.map((criterion) => {
      const judged = verdictOf(run, criterion.criterionId)
      return {
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        verifierRef: judged?.verifierRef ?? 'independent-review',
        verifierVersion: judged?.verifierVersion ?? '1',
        implementationDigest: judged?.implementationDigest ?? REVIEW_DIGEST,
        verdict: judged?.verdict ?? 'unjudged',
        decidedBy: judged === undefined ? null : `${judged.verifierRef}@${judged.verifierVersion}`,
        artifactDigest: judged?.artifactDigest ?? null,
        actor: judged?.actor ?? null,
        detail: judged?.detail ?? null,
      }
    }),
  }))

  return {
    taskId: state.taskId,
    goal: contract.goal,
    contractDigest: digest,
    admittedBy: by,
    admittedAt: at,
    phase: phaseOf(runStates),
    criteria: contract.criteria,
    runs,
  }
}

/** Validate the supplied log prefix and derive a receipt at this run's terminal control fact. */
export function projectReceipt(
  registry: ProtocolRegistry,
  entries: readonly Envelope[],
  taskId: string,
  runId: string,
): ReceiptView {
  let cutoff: number | undefined
  let previousDigest: string | null = null
  for (const [index, entry] of entries.entries()) {
    const checked = assertEnvelope(entry)
    if (checked.seq !== index)
      refuse('chain-broken', `receipt input is not a contiguous log prefix: position ${index} carries seq ${checked.seq}`,
      )
    if (checked.prevDigest !== previousDigest)
      refuse('chain-broken', `receipt input fact #${checked.seq} does not link to its predecessor`)
    const rule = registry.ruleFor(checked.protocol, checked.version, checked.kind)
    const payload = rule.parse(checked.payload, `${checked.protocol}@${checked.version} ${checked.kind} #${checked.seq}`,
    )
    if (
      checked.protocol === TASK_PROTOCOL && checked.version === TASK_VERSION && checked.subject === taskId &&
      (checked.kind === TASK_KINDS.runVerified || checked.kind === TASK_KINDS.runFailed) &&
      (payload as { readonly runId: string }).runId === runId
    ) cutoff ??= checked.seq + 1
    previousDigest = checked.digest
  }
  const state = foldSubject<TaskState>(registry, entries.slice(0, cutoff), TASK_PROTOCOL, TASK_VERSION, taskId)
  const run = state?.runs[runId]
  if (state === undefined || run === undefined)
    refuse('unknown-run', `the ${entries.length} fact(s) handed in hold no run "${runId}" of task "${taskId}", so there is no receipt to derive`,
    )
  const { contract, digest } = requireContract(state)
  if (run.status === 'running')
    refuse(
      'illegal-transition',
      `run "${runId}" is still running in the ${entries.length} fact(s) handed in; a receipt is what a terminal run leaves behind`,
    )
  if (run.finishedAt === undefined || cutoff === undefined)
    refuse('illegal-transition', `run "${runId}" settled ${run.status} without a settlement time; the log cannot produce that`,
    )

  const judged = run.evidence[0]
  const declared = run.bubble?.inputs ?? []

  return {
    taskId: state.taskId,
    runId,
    contractDigest: digest,
    revision: run.revision,
    cutoff,
    executor: { emitter: run.emitter, actor: run.actor },
    consumption: {
      basis: judged === undefined ? DECLARED_BASIS : JUDGED_BASIS,
      inputs: (judged?.inputDigests ?? declared).map((entry) => ({ name: entry.name, digest: entry.digest })),
      workspace: run.bubble === undefined ? null : { kind: run.bubble.workspace.kind, ref: run.bubble.workspace.ref },
    },
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    submission: run.submission ?? null,
    source: run.submission?.source ?? null,
    criteria: contract.criteria.map((criterion) => {
      const judged = verdictOf(run, criterion.criterionId)
      return {
        criterionId: criterion.criterionId,
        verifierRef: judged?.verifierRef ?? 'independent-review',
        verifierVersion: judged?.verifierVersion ?? '1',
        implementationDigest: judged?.implementationDigest ?? REVIEW_DIGEST,
        verdict: judged?.verdict ?? 'unjudged',
        artifactDigest: judged?.artifactDigest ?? null,
        actor: judged?.actor ?? null,
      }
    }),
  }
}

/** The receipt's content identity: two readers of the same facts agree on this, by construction. */
export function receiptDigest(receipt: ReceiptView): string {
  return digestOf(receipt)
}

/** The agent's reading: plain text, no second shape, everything the view holds and nothing more. */
export function renderTaskForAgent(view: TaskView): string {
  const lines = [
    `Task ${view.taskId} — phase ${view.phase}`,
    `  goal: ${view.goal}`,
    `  contract ${view.contractDigest.slice(0, 12)}… admitted by ${view.admittedBy} at ${view.admittedAt}`,
    `  criteria (${view.criteria.length}):`,
    ...view.criteria.map((criterion) => `    - ${criterion.criterionId}: ${criterion.statement}`),
    `  runs (${view.runs.length}):`,
  ]

  if (view.runs.length === 0) lines.push('    (none yet: this task is admitted and awaiting a run)')

  for (const run of view.runs) {
    lines.push(
      `    - ${run.runId}: ${run.status} by ${run.actor} (role ${run.emitter}) on ${run.revision.environmentId} revision ${run.revision.revisionId} (${run.revision.digest.slice(0, 12)}…)`,
    )
    for (const verdict of run.verdicts) {
      const by =
        verdict.artifactDigest === null
          ? 'unjudged'
          : `${verdict.verdict} by ${verdict.decidedBy} on artifact ${verdict.artifactDigest.slice(0, 12)}…`
      lines.push(`        ${verdict.criterionId}: ${by}${verdict.detail === null ? '' : ` — ${verdict.detail}`}`)
    }
    if (run.failureReason !== null) lines.push(`        failure: ${run.failureReason}`)
  }

  return lines.join('\n')
}

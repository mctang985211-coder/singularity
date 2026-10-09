/**
 * The one read projection for a task, and the two renderings of it.
 *
 * There is exactly one projection per subject, owned here. An agent reads it as text; a UI
 * consumes the same `TaskView` object unchanged. Neither re-derives anything — that is what
 * keeps a second interpretation of the facts from existing, which is how a stack grows a
 * second truth.
 *
 * The **receipt** is where the guarantee ladder pays off. An execution receipt is *derived*
 * from the run's own recorded facts at read time, so it is G4: it is never written, and the
 * log refuses it. The previous system persisted a second scan of the same session facts; here
 * there is nothing to keep in step, and two readers computing the receipt from the same facts
 * produce the same digest by construction.
 *
 * @module singularity-core/task/view
 */

import { digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { AcceptanceCriterion, TaskContract } from './contract.ts'
import type { RevisionRef, RunState, RunStatus, TaskState } from './protocol.ts'

/** One criterion and the verdict it received, as a reader sees it. */
export interface CriterionVerdictView {
  readonly criterionId: string
  readonly statement: string
  readonly verifierRef: string
  readonly verdict: 'pass' | 'fail' | 'unjudged'
  readonly actor: string | null
  readonly detail: string
}

export interface RunView {
  readonly runId: string
  readonly status: RunStatus
  readonly actor: string
  readonly revision: RevisionRef
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly failureReason: string | null
  readonly verdicts: readonly CriterionVerdictView[]
}

/** The whole task as one reader sees it. The UI's contract, and the agent renderer's input. */
export interface TaskView {
  readonly taskId: string
  readonly goal: string
  readonly contractDigest: string
  readonly admittedBy: string
  readonly admittedAt: string
  readonly phase: 'running' | 'verified' | 'failed'
  readonly criteria: readonly AcceptanceCriterion[]
  readonly runs: readonly RunView[]
}

/** A terminal run's execution facts, recomputed from the log rather than stored. */
export interface ReceiptView {
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: string
  readonly revision: RevisionRef
  readonly executor: string
  readonly status: 'verified' | 'failed'
  readonly startedAt: string
  readonly finishedAt: string
  readonly criteria: readonly {
    readonly criterionId: string
    readonly verifierRef: string
    readonly verdict: 'pass' | 'fail' | 'unjudged'
    readonly actor: string | null
  }[]
}

function requireContract(state: TaskState): { contract: TaskContract; digest: string; by: string; at: string } {
  const { contract, contractDigest, admittedBy, admittedAt } = state
  if (contract === undefined || contractDigest === undefined || admittedBy === undefined || admittedAt === undefined)
    refuse(
      'illegal-transition',
      `task "${state.taskId}" has facts but no admitted contract; only an admitted task carries runs, so this state is not one the protocol can produce`,
    )
  return { contract, digest: contractDigest, by: admittedBy, at: admittedAt }
}

function verdictOf(run: RunState, criterionId: string): { verdict: 'pass' | 'fail' | 'unjudged'; actor: string | null; detail: string } {
  const evidence = run.evidence.find(entry => entry.criterionId === criterionId)
  if (evidence === undefined) return { verdict: 'unjudged', actor: null, detail: '' }
  return { verdict: evidence.verdict, actor: evidence.actor, detail: evidence.detail }
}

function phaseOf(runs: readonly RunState[]): TaskView['phase'] {
  if (runs.some(run => run.status === 'running')) return 'running'
  if (runs.some(run => run.status === 'verified')) return 'verified'
  return 'failed'
}

/** Project one folded task state into the one view every reader shares. */
export function projectTask(state: TaskState): TaskView {
  const { contract, digest, by, at } = requireContract(state)
  const runStates = Object.values(state.runs).sort((left, right) =>
    left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : 0,
  )
  const runs: RunView[] = runStates.map(run => ({
    runId: run.runId,
    status: run.status,
    actor: run.actor,
    revision: run.revision,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    failureReason: run.failureReason ?? null,
    verdicts: contract.criteria.map(criterion => {
      const judged = verdictOf(run, criterion.criterionId)
      return {
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        verifierRef: criterion.verifierRef,
        verdict: judged.verdict,
        actor: judged.actor,
        detail: judged.detail,
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

/**
 * Derive one terminal run's execution receipt from the log's own facts.
 *
 * Refuses a run that has not settled: a receipt is what a terminal run leaves behind, and
 * inventing one for a running attempt would be a completion claim nobody made.
 */
export function projectReceipt(state: TaskState, runId: string): ReceiptView {
  const { contract, digest } = requireContract(state)
  const run = state.runs[runId]
  if (run === undefined)
    refuse('unknown-run', `task "${state.taskId}" never started run "${runId}", so it has no receipt`)
  if (run.status === 'running')
    refuse('illegal-transition', `run "${runId}" is still running; a receipt is what a terminal run leaves behind`)
  if (run.finishedAt === undefined)
    refuse('illegal-transition', `run "${runId}" settled ${run.status} without a settlement time; the log cannot produce that`)

  return {
    taskId: state.taskId,
    runId,
    contractDigest: digest,
    revision: run.revision,
    executor: run.actor,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    criteria: contract.criteria.map(criterion => {
      const judged = verdictOf(run, criterion.criterionId)
      return { criterionId: criterion.criterionId, verifierRef: criterion.verifierRef, verdict: judged.verdict, actor: judged.actor }
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
    ...view.criteria.map(criterion => `    - ${criterion.criterionId}: ${criterion.statement} [decided by ${criterion.verifierRef}@${criterion.verifierVersion}]`),
    `  runs (${view.runs.length}):`,
  ]

  for (const run of view.runs) {
    lines.push(
      `    - ${run.runId}: ${run.status} by ${run.actor} on revision ${run.revision.revisionId} (${run.revision.digest.slice(0, 12)}…)`,
    )
    for (const verdict of run.verdicts) {
      const by = verdict.actor === null ? 'unjudged' : `${verdict.verdict} by ${verdict.actor}`
      lines.push(`        ${verdict.criterionId}: ${by}${verdict.detail === '' ? '' : ` — ${verdict.detail}`}`)
    }
    if (run.failureReason !== null) lines.push(`        failure: ${run.failureReason}`)
  }

  return lines.join('\n')
}

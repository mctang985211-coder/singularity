/**
 * The one read projection for a task, and the two renderings of it.
 *
 * There is exactly one projection per subject, owned here. An agent reads it as text; a UI
 * consumes the same `TaskView` object unchanged. Neither re-derives anything — that is what keeps
 * a second interpretation of the facts from existing.
 *
 * The **receipt** is where the guarantee vocabulary pays off. An execution receipt is *derived*
 * from the run's own recorded facts at read time, so it is never written and the protocol declares
 * no kind for it. It carries what the verdicts actually pinned — the verifier implementation and
 * the artifact content it judged — so a later artifact change cannot inherit an old verdict. The
 * facts are its only input: the bound it names is the prefix it was folded from, and its
 * consumption says whether a verdict has been formed on those inputs yet or only declared.
 *
 * A phase is never inferred from absence. A task that has a contract and no run is
 * `awaiting-run`, not `failed`; a failure with no recorded reason reports `null` rather than an
 * invented sentence.
 *
 * @module singularity-core/task/view
 */

import { digestOf, type Envelope } from '../protocol/envelope.ts'
import { foldSubject } from '../protocol/fold.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import type { BubbleInput } from './bubble.ts'
import type { AcceptanceCriterion, TaskContract } from './contract.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunState, type RunStatus, type TaskState } from './protocol.ts'

/** One criterion and the verdict it received, as a reader sees it. */
export interface CriterionVerdictView {
  readonly criterionId: string
  readonly statement: string
  /** The implementation this criterion names. */
  readonly verifierRef: string
  readonly verifierVersion: string
  /** The content digest of the implementation the criterion names. */
  readonly implementationDigest: string
  readonly verdict: 'pass' | 'fail' | 'unjudged'
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
  /**
   * The committed read bound the receipt was derived from: the exclusive bound of the fact prefix
   * this projection folded — one past the sequence number the last fact carries itself — and never
   * a number a caller states beside those facts. A receipt therefore cannot name a bound that does
   * not hold its own evidence: a prefix that stops before the run settled yields no receipt at all,
   * and a bound past the last fact is not expressible. Two readers holding the same prefix agree on
   * it, and re-deriving from that prefix reproduces the receipt, which is what makes "this receipt
   * accounts for exactly these facts" a property a reader checks instead of one it assumes.
   */
  readonly cutoff: number
  readonly executor: { readonly emitter: string; readonly actor: string }
  readonly status: 'verified' | 'failed'
  readonly startedAt: string
  readonly finishedAt: string
  /**
   * What the attempt consumed, and which of the two the receipt can honestly say it is.
   *
   * `'declared'` means nothing has been judged yet: the list is the run's own statement of the
   * inputs it would work on, and a receipt that reported it as read would be dressing a
   * declaration as evidence. `'judged'` means a verdict was formed on exactly these inputs, and
   * the list is read from that verdict's recorded `inputDigests` — the digests the production
   * verifier hashed from the bytes it actually read, not from the bubble.
   *
   * The two lists are the same list by construction: `evidence/produced` is refused unless its
   * inputs are exactly the run's declared ones (`assertInputsBound`), so no log can hold a run
   * whose judged inputs differ from its declaration. The *distinction* is therefore the content
   * here, not a second copy of the values.
   *
   * The workspace has no judged counterpart — no fact records the directory anything actually read
   * — so it stays a declaration on both bases, and is reported as one.
   */
  readonly consumption: {
    readonly basis: 'declared' | 'judged'
    readonly inputs: readonly BubbleInput[]
    readonly workspace: { readonly kind: string; readonly ref: string } | null
  }
  readonly criteria: readonly {
    readonly criterionId: string
    readonly verifierRef: string
    readonly verifierVersion: string
    readonly implementationDigest: string
    readonly verdict: 'pass' | 'fail' | 'unjudged'
    readonly artifactDigest: string | null
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

function verdictOf(run: RunState, criterionId: string): RunState['evidence'][number] | undefined {
  return run.evidence.find(entry => entry.criterionId === criterionId)
}

function phaseOf(runs: readonly RunState[]): TaskView['phase'] {
  if (runs.length === 0) return 'awaiting-run'
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
    emitter: run.emitter,
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
        verifierVersion: criterion.verifierVersion,
        implementationDigest: criterion.implementationDigest,
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

/**
 * Derive one terminal run's execution receipt from the committed facts it is derived from.
 *
 * The facts are the whole input. The task state is folded from the prefix handed in, and the
 * receipt's `cutoff` is that prefix's exclusive bound — one past the sequence number the last fact
 * carries itself — so the two cannot disagree: the old shape took a state and a cutoff as
 * independent arguments, which let a caller pass a head state with `1` and get the seq-4 verdict
 * back under a one-fact claim. A parameter that can be wrong is a parameter that will be, so there
 * is none.
 *
 * Refuses a run that has not settled *within that prefix*: a receipt is what a terminal run leaves
 * behind, and deriving one for an attempt these facts still show running would be a completion
 * claim nobody made.
 */
export function projectReceipt(
  registry: ProtocolRegistry,
  entries: readonly Envelope[],
  taskId: string,
  runId: string,
): ReceiptView {
  const state = foldSubject<TaskState>(registry, entries, TASK_PROTOCOL, TASK_VERSION, taskId)
  const run = state?.runs[runId]
  if (state === undefined || run === undefined)
    refuse('unknown-run', `the ${entries.length} fact(s) handed in hold no run "${runId}" of task "${taskId}", so there is no receipt to derive`)
  const { contract, digest } = requireContract(state)
  if (run.status === 'running')
    refuse(
      'illegal-transition',
      `run "${runId}" is still running in the ${entries.length} fact(s) handed in; a receipt is what a terminal run leaves behind`,
    )
  // Unreachable by construction - the one reducer that settles a run stamps the time together with
  // the status - so this is not a rule that can fire; it is how the receipt reads a settled run's
  // time as a settled value rather than as something a caller might have left out.
  if (run.finishedAt === undefined)
    refuse('illegal-transition', `run "${runId}" settled ${run.status} without a settlement time; the log cannot produce that`)

  // Judged or only declared: the verdict's own record is the honest source for the inputs, and the
  // receipt says which of the two it is reporting. Every verdict of a run is bound to the run's
  // bubble at record time, so `evidence[0]` carries the one judged list there can be.
  const judged = run.evidence[0]
  const declared = run.bubble?.inputs ?? []

  return {
    taskId: state.taskId,
    runId,
    contractDigest: digest,
    revision: run.revision,
    cutoff: entries.length,
    executor: { emitter: run.emitter, actor: run.actor },
    consumption: {
      basis: judged === undefined ? 'declared' : 'judged',
      inputs: (judged?.inputDigests ?? declared).map(entry => ({ name: entry.name, digest: entry.digest })),
      workspace: run.bubble === undefined ? null : { kind: run.bubble.workspace.kind, ref: run.bubble.workspace.ref },
    },
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    criteria: contract.criteria.map(criterion => {
      const judged = verdictOf(run, criterion.criterionId)
      return {
        criterionId: criterion.criterionId,
        verifierRef: criterion.verifierRef,
        verifierVersion: criterion.verifierVersion,
        implementationDigest: criterion.implementationDigest,
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
    ...view.criteria.map(
      criterion =>
        `    - ${criterion.criterionId}: ${criterion.statement} [decided by ${criterion.verifierRef}@${criterion.verifierVersion} implemented by ${criterion.implementationDigest.slice(0, 12)}…]`,
    ),
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

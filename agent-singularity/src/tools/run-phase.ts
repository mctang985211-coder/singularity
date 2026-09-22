import type { SubmissionRecord, TaskRun } from '@dangosys/dsh-singularity-task'

/**
 * The A3 coordination phase of one run, as the two readers of the store render
 * it. Both views come from these functions so `task_read` and `task_status` can
 * never describe the same run differently — the same discipline
 * `renderRunBinding` applies to the "chosen implementation" section.
 *
 * The rendering rule, and why it is a rule: a run created before the phase
 * field existed has *no* phase, and its phase is never guessed. A non-terminal
 * such run is displayed as `needs-recovery` — an old record whose only legal
 * continuation is cancellation (`TaskRuntime.reconcileStore` leaves it exactly
 * as it stands, and admission and submission both refuse it) — while a terminal
 * one renders nothing extra, because a finished run needs no phase. Reporting
 * `active` for it would invite work nobody can admit.
 */

/** The full form: what the record is and what a reader can do about it. */
const NEEDS_RECOVERY =
  'needs-recovery (an old record: it was created before coordination phases, so it has no phase to continue from and cannot ' +
  'decompose, submit or verify — cancel this task tree to recover)'

/** The compact form for `task_status`, whose run part is a cell inside a denser line. */
const NEEDS_RECOVERY_SHORT = 'needs-recovery (old record without a coordination phase)'

/** The submission a run carries, as one clause: who handed it in, when, and what it named. */
function submissionClause(submission: SubmissionRecord): string {
  const evidence = submission.evidenceRefs.length === 0 ? '' : `; evidence [${submission.evidenceRefs.join(', ')}]`
  const notes = submission.notes === undefined ? '' : `; notes: ${submission.notes}`
  return `submitted by ${submission.origin} at ${submission.submittedAt}: "${submission.summary}"${evidence}${notes}`
}

/**
 * The phase, batch, submission and no-progress facts of one run, appended to a
 * `task_read` run line: where this run sits in the protocol, in that order, with
 * the batch id only where a batch exists to name. A phase change and a progress
 * marking rewrite these fields, so this is the run's current position, never a
 * history.
 */
export function runPhaseSuffix(run: TaskRun): string {
  const parts: string[] = []
  if (run.executionPhase !== undefined) {
    parts.push(`phase ${run.executionPhase}`)
    if (run.batchId !== undefined) parts.push(`batch ${run.batchId}`)
    if (run.submission !== undefined) parts.push(submissionClause(run.submission))
  } else if (run.status === 'running') {
    parts.push(NEEDS_RECOVERY)
  }
  if (run.noProgress !== undefined) parts.push(`no-progress round ${run.noProgress.rounds} (${run.noProgress.kind})`)
  return parts.length === 0 ? '' : ` — ${parts.join('; ')}`
}

/** The same fact for `task_status`, whose run part is a cell inside a denser line. */
export function runPhaseCell(run: TaskRun): string {
  if (run.executionPhase !== undefined) return ` — phase ${run.executionPhase}`
  return run.status === 'running' ? ` — ${NEEDS_RECOVERY_SHORT}` : ''
}

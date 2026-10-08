/**
 * A graph's rounds, read from the store alone: which runs are rounds, which
 * attempt a round's request key opened, and the platform diagnosis one settled
 * round is recorded under. Pure — every function takes facts and returns facts.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/rounds
 */

import { isTerminalRunStatus, type Diagnosis, type ReviewRecord, type TaskRun, type TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { recoveryAttemptWithKey } from '@dangosys/dsh-singularity-task-runtime'

/** The store's own root task: the one task that never had a parent. */
export function rootTaskOf(snapshot: TaskSnapshot): { readonly taskId: string } | undefined {
  return snapshot.tasks.find(task => task.parentTaskId === undefined)
}

/** The store's first attempt of the root task: the run that is not a recovery of anything. */
export function firstRootRun(snapshot: TaskSnapshot, rootTaskId: string): TaskRun | undefined {
  return snapshot.runs.find(run => run.taskId === rootTaskId && run.recovery === undefined)
}

/**
 * Every terminal-settled run of the root task, oldest first — the store's own
 * count of business rounds. A round is a settled attempt, verified or not.
 */
export function terminalRootRuns(snapshot: TaskSnapshot, rootTaskId: string): TaskRun[] {
  return snapshot.runs
    .filter(run => run.taskId === rootTaskId && isTerminalRunStatus(run.status))
    .sort((left, right) =>
      left.startedAt < right.startedAt
        ? -1
        : left.startedAt > right.startedAt
          ? 1
          : left.runId < right.runId
            ? -1
            : left.runId > right.runId
              ? 1
              : 0,
    )
}

/** The run one round opened, read from the store's own attempt record by its request key. */
export function roundRunOf(snapshot: TaskSnapshot, rootTaskId: string, requestKey: string): TaskRun | undefined {
  return recoveryAttemptWithKey(snapshot, rootTaskId, requestKey)
}

/** The review record of one run, as the store holds it. */
export function reviewOfRun(snapshot: TaskSnapshot, runId: string): ReviewRecord | undefined {
  return snapshot.reviews.find(review => review.runId === runId)
}

/** The platform diagnosis one round's run is recorded under: the epoch is in the id, so a restart is a new round. */
export function roundDiagnosisId(graphId: string, epoch: number, businessRound: number): string {
  return `rsi-${graphId}-e${epoch}-round-${businessRound}`
}

/** The request key that opens one round. One key names one attempt. */
export function roundRequestKey(graphId: string, epoch: number, businessRound: number): string {
  return `rsi-${graphId}-e${epoch}-round-${businessRound}`
}

/**
 * The platform's own diagnosis for one round. `proposals: []` says the driver
 * records no suggestion — the supervisor investigates; the diagnosis exists so
 * the next round's recovery has a store record to name.
 */
export function roundDiagnosis(input: {
  readonly diagnosisId: string
  readonly taskId: string
  readonly graphId: string
  readonly graphName: string
  readonly epoch: number
  readonly businessRound: number
  readonly rounds: number
  readonly objective: string
  readonly run: TaskRun
  readonly review?: ReviewRecord
  readonly producedBySessionId: string
}): Diagnosis {
  const verified = input.run.status === 'verified'
  const finalRound = input.businessRound >= input.rounds
  return {
    diagnosisId: input.diagnosisId,
    taskId: input.taskId,
    observedFailure: verified
      ? `Round ${input.businessRound} of graph "${input.graphName}" (${input.graphId}) verified: the root task's run ` +
        `"${input.run.runId}" settled verified under the store's own acceptance criteria.`
      : input.review?.localizedCause ??
        `Round ${input.businessRound} of graph "${input.graphName}" (${input.graphId}) settled ${input.run.status}: ` +
          `the root task's run "${input.run.runId}" did not pass the store's own acceptance criteria.`,
    scope: `the root task ${input.taskId} of this store; graph ${input.graphId} runs a platform RSI loop of ${input.rounds} round(s)`,
    localizedCause: finalRound
      ? `The platform RSI loop reviews round ${input.businessRound}'s library experience before completing this graph: ${input.objective}.`
      : verified
        ? `The platform RSI loop continues this graph's verified goal with round ${input.businessRound + 1}: ${input.objective}.`
        : `The platform RSI loop hands round ${input.businessRound}'s ${input.run.status} attempt to its supervisor, which ` +
          `investigates the cause and prepares the method change round ${input.businessRound + 1} (mode "recovery") consumes: ${input.objective}.`,
    evidenceRefs: input.review?.evidenceRefs ?? [],
    reviewRefs: [`${input.taskId}#${input.run.runId}`],
    confidence: 'high',
    proposals: [],
    producedBy: { kind: 'agent', sessionId: input.producedBySessionId },
  }
}

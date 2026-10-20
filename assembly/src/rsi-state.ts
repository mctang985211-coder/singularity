import type { TaskState } from '../../src/task/protocol.ts'

/** A projection of Task facts, shared by admission, prompt exposure and recovery. */
export function rsiState(task: TaskState) {
  if (task.search === undefined) return undefined
  const run = task.runs[task.search.runId]!
  const remainingSlots = task.search.maxProposals - (task.search.batches ?? []).reduce((n, batch) => n + batch.slots.length, 0)
  const batch = task.search.batches?.find(batch => !batch.settled)
  const round = task.rounds?.find(round => round.status === 'pending')
  const phase = run.status !== 'running' ? run.status === 'verified' ? 'completed' : 'failed'
    : run.stage !== 'working' ? 'reporting'
    : batch !== undefined ? 'screening' : round !== undefined ? 'evaluating' : 'ready'
  return { phase, remainingSlots, canPropose: phase === 'ready' && remainingSlots > 0,
    canSubmit: phase === 'ready',
    pending: batch ? { kind: 'batch' as const, batchId: batch.batchId }
      : round ? { kind: 'evaluation' as const, roundId: round.roundId } : null,
    next: phase === 'screening' || phase === 'evaluating' || phase === 'reporting'
      ? 'End this turn. The host owns pending work and will resume you with its committed outcome.'
      : phase === 'ready' ? remainingSlots > 0
        ? 'Read evidence and relevant assets; propose one mechanism, or submit an honest final report.'
        : 'Proposal budget exhausted. Submit the final report with actual outcomes and limitations.'
      : 'This search is terminal.' }
}

export function rsiToolReason(task: TaskState, name: string): string | undefined {
  const state = rsiState(task)
  if (state === undefined) return undefined
  if (name === 'singularity_propose_method' && !state.canPropose)
    return `RSI ${state.phase}: ${state.next}`
  if (name === 'singularity_submit' && !state.canSubmit)
    return `RSI ${state.phase}: ${state.next}`
  if (['write', 'edit'].includes(name) && state.phase !== 'ready')
    return `RSI ${state.phase}: authoring is closed. ${state.next}`
  return undefined
}

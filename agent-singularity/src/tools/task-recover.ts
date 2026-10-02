/** `task_recover` (A6, plan §F.4): open one root task's **new attempt** — a recovery of a failed source, or an improvement round on a verified one — for a diagnosis that was handed to this session. @module @dangosys/dsh-singularity-agent/tools/task-recover */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId, type TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { RecoveryCoordinationOutcome } from '@dangosys/dsh-singularity-evolution'
import { handoffSourceOf } from '../coordination/handoff-rules.ts'
import { message, sessionId, text, undeclaredParameters } from '../shared.ts'

/** The two modes this tool accepts: the default recovery of a failed source, and the improvement round a verified source accepts. */
type RecoverMode = 'recovery' | 'improve'

const DECLARED_PARAMETERS = ['sourceDiagnosisId', 'requestKey', 'mode'] as const

/** What one answer says: the attempt, the run it opened or already had, and what the coordination checked. */
function renderOutcome(outcome: RecoveryCoordinationOutcome): string {
  return [
    `task_recover: ${outcome.attempt === 'started' ? 'a new attempt was opened' : 'this key already named an attempt'} for diagnosis ` +
      `${outcome.sourceDiagnosisId} — run ${outcome.runId} (session ${outcome.sessionId}) is ${outcome.status}`,
    `hand-off: delegated by session ${outcome.handoff.actor} to supervisor ${outcome.handoff.sessionId}`,
    ...outcome.coordination.map(line => `- ${line}`),
    outcome.reusedMembers.length === 0
      ? 'the attempt re-runs the work; no already-verified sibling was cited'
      : `the attempt reads ${outcome.reusedMembers.length} already-verified sibling member(s) at position(s) ` +
        `${outcome.reusedMembers.map(member => member.childIndex).join(', ')}`,
    ...(outcome.unboundMembers.length === 0
      ? []
      : [`${outcome.unboundMembers.length} position(s) whose passed sibling could not be bound are done again, with the reasons on the attempt's own record: ` +
        outcome.unboundMembers.map(entry => `#${entry.childIndex} (${entry.reasons.join('; ')})`).join(', ')]),
    'the original acceptance criteria judge the new attempt, the old failure stays readable, and the store total it spends is the same one',
  ].join('\n')
}

export function defineTaskRecoverTool(ctx: Context) {
  return defineTool({
    name: 'task_recover',
    description:
      'Open a new attempt at a root goal (a new root Run/Session in the same store), for ONE recorded Diagnosis of that ' +
      'same store. Available to the trusted supervisor coordination session a hand-off was delegated to and to no one else: the ' +
      'caller is read from the live session and checked against the delegation the deployment recorded, so a root, a worker, a ' +
      'reviewer or another graph\'s supervisor cannot use it, and no authorization is ever passed as an argument. mode selects ' +
      'the round: the default "recovery" opens the failed source\'s new attempt; a verified source accepts only "improve", one ' +
      'improvement round judged by the same original acceptance criteria. Every rule is ' +
      're-checked below this tool: the source\'s recovery/improvement cap and the store\'s facts are re-read, the evolution ' +
      'plane verifies that every shared change this diagnosis stands on is approved and ' +
      'applied (an unapproved, undecided or rolled-back proposal means nothing is opened), and the task runtime re-reads the ' +
      'store\'s own facts — the failed source, the original contract and criteria, the providers the attempt needs now, the ' +
      'ceilings in force and the attempt\'s own idempotency — before it writes. An in-flight run is never hot-swapped, and a ' +
      'second key while an attempt of the same diagnosis is in flight is refused by name. Repeating the same call returns the ' +
      'attempt that key already names instead of starting another; a pure artifact gap needs no proposal and no approval.',
    parameters: {
      sourceDiagnosisId: { type: 'string', required: true, description: 'The recorded Diagnosis this attempt is for' },
      requestKey: {
        type: 'string',
        required: true,
        description: 'Non-empty key of this attempt: one key names one attempt, and a repeat of it returns that attempt',
      },
      mode: {
        type: 'string',
        description: 'The round to open: "recovery" (default) for a failed source, "improve" for a verified source',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS, 'task_recover')
      if (undeclared !== undefined) return undeclared
      const mode = (args.mode ?? 'recovery') as RecoverMode
      if (mode !== 'recovery' && mode !== 'improve') {
        return `task_recover rejected: mode ${JSON.stringify(args.mode)} is not "recovery" or "improve"; nothing was read and nothing was started`
      }
      const caller = sessionId(exec, 'task_recover')
      try {
        const refusal = mode === 'recovery' ? await verifiedSourceRefusal(ctx, caller, args.sourceDiagnosisId) : undefined
        if (refusal !== undefined) return refusal
        const request = {
          sourceDiagnosisId: args.sourceDiagnosisId,
          requestKey: args.requestKey,
          ...(mode === 'improve' ? { mode: 'improve' as const } : {}),
        } as Parameters<typeof ctx.evolution.coordinateRecovery>[0]
        const outcome = await ctx.evolution.coordinateRecovery(request, { sessionId: caller, signal: exec.signal })
        return renderOutcome(outcome)
      } catch (error) {
        return `task_recover rejected: ${message(error)}`
      }
    },
  })
}

/** The named refusal a recovery of a verified source gets, telling the caller to ask again with mode "improve"; `undefined` when the source is not verified (the plane decides everything else). */
async function verifiedSourceRefusal(ctx: Context, caller: ReturnType<typeof sessionId>, diagnosisId: string): Promise<string | undefined> {
  const graph = await ctx.graphs.graphForSession(caller)
  const storeId = rootTaskStoreId(graph.rootSessionId)
  const snapshot: TaskSnapshot = await ctx.task.openStore(storeId)
  const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === diagnosisId)
  if (diagnosis === undefined) return undefined
  const source = handoffSourceOf(diagnosis)
  const review = snapshot.reviews.find(item => item.taskId === source.taskId && (item.runId ?? null) === source.runId)
  if (review?.outcome !== 'verified') return undefined
  return [
    `task_recover rejected: review source ${source.taskId}#${source.runId ?? 'no-run'} passed its review (verified), and a verified`,
    'source is not recovered — it accepts one improvement round instead. Call task_recover again with mode: "improve" to open the',
    'improvement attempt under the original acceptance criteria, or close the hand-off; nothing was read further and nothing was started.',
  ].join(' ')
}

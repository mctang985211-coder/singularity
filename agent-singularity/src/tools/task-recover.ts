/** `task_recover` (A6, plan §F.4): open one failed root task's **new attempt** for a diagnosis that was handed to this session. @module @dangosys/dsh-singularity-agent/tools/task-recover */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task'
import type { RecoveryCoordinationOutcome } from '@dangosys/dsh-singularity-evolution'
import { message, sessionId, text } from '../shared.ts'

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
      'Open a new attempt at a failed root goal (a new root Run/Session in the same store), for ONE recorded Diagnosis of that ' +
      'same store. Available to the trusted supervisor coordination session a hand-off was delegated to and to no one else: the ' +
      'caller is read from the live session and checked against the delegation the deployment recorded, so a root, a worker, a ' +
      'reviewer or another graph\'s supervisor cannot use it, and no authorization is ever passed as an argument. Every rule is ' +
      're-checked below this tool: the evolution plane verifies that a capability change this diagnosis stands on is approved and ' +
      'applied (an unapproved, undecided or rolled-back capability means nothing is opened), and the task runtime re-reads the ' +
      'store\'s own facts — the failed source, the original contract and criteria, the providers the attempt needs now, the ' +
      'ceilings in force and the attempt\'s own idempotency — before it writes. A successful source is never recovered (a ' +
      '"faster or cheaper" suggestion has no frozen comparator in this build), an in-flight run is never hot-swapped, and a ' +
      'second key while an attempt of the same diagnosis is in flight is refused by name. Repeating the same call returns the ' +
      'attempt that key already names instead of starting another; a pure artifact gap needs no proposal and no approval.',
    parameters: {
      sourceDiagnosisId: { type: 'string', required: true, description: 'The recorded Diagnosis this attempt is for' },
      requestKey: {
        type: 'string',
        required: true,
        description: 'Non-empty key of this attempt: one key names one attempt, and a repeat of it returns that attempt',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'task_recover')
      try {
        const outcome = await ctx.evolution.coordinateRecovery(
          { sourceDiagnosisId: args.sourceDiagnosisId, requestKey: args.requestKey },
          { sessionId: caller, signal: exec.signal },
        )
        return renderOutcome(outcome)
      } catch (error) {
        return `task_recover rejected: ${message(error)}`
      }
    },
  })
}

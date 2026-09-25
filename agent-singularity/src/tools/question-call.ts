/**
 * The identity one question call starts from (A4 §F.1): the live caller it runs
 * for, and the registration id of the call itself.
 *
 * Both halves are the caller's own and neither is a parameter: the session comes
 * from the live agent the tool is dispatched for, and the call id is the
 * dispatch's own registration id — the `tool/call` event the runtime reads the
 * question/answer body back from before the store records anything. A call with
 * no registration id has no body to cite, so it is refused here rather than
 * recorded as a question whose text nobody wrote.
 * @module dsh-singularity-agent/tools/question-call
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** The caller's own session, and the registration id of the call it is making. */
export interface QuestionCall {
  /** The caller's Session — where the cited body must live, and the identity every derived fact is attributed to. */
  readonly caller: SessionId
  /** The registration id of this call: the `tool/call` the runtime reads the body back from. */
  readonly callId: string
}

/** The caller's own session. A call with no live agent has no identity to ask or answer with. */
export function questionCaller(exec: ToolRunContext, tool: string): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${tool}: missing agent id`)
  return id
}

/**
 * The identity a question call runs under. The registration id is required, not
 * defaulted: the whole protocol rests on the body being read back from the
 * caller's own message, so a call that cannot name its own `tool/call` is
 * refused by name before anything is written or sent.
 */
export function questionCall(exec: ToolRunContext, tool: string): QuestionCall {
  const caller = questionCaller(exec, tool)
  const callId = exec.callId
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new Error(
      `${tool}: this call carries no registration id, so the body it would record cannot be cited; ` +
      'a question or an answer is only ever recorded from the message the caller itself wrote',
    )
  }
  return { caller, callId }
}

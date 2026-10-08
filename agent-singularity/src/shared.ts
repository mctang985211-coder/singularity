import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ProjectedRead } from '@dangosys/dsh-singularity-context'

export const text = (value: string) => [{ type: 'text' as const, text: value }]

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The caller's own session id: the read domain and every write attribution come from it, never from an argument. */
export function sessionId(exec: ToolRunContext, tool: string): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${tool}: missing agent id`)
  return id
}

/** Refuse a call that carries a key the tool does not declare, naming the keys rather than ignoring them. */
export function undeclaredParameters(
  args: Record<string, unknown>,
  declared: readonly string[],
  toolName: string,
  detail = 'and has no argument that approves, decides, or stands in for a review',
  closing = 'nothing was read and nothing was changed.',
): string | undefined {
  const undeclared = Object.keys(args).filter(key => !declared.includes(key))
  if (undeclared.length === 0) return undefined
  return [
    `${toolName} rejected: undeclared parameter${undeclared.length === 1 ? '' : 's'} ${undeclared.map(key => `"${key}"`).join(', ')} —`,
    `this tool accepts ${declared.join(', ')} ${detail};`,
    closing,
  ].join(' ')
}

/** Why an approval outcome did not grant: the one wording every human-gate tool reports. */
export function denialReason(
  outcome: Exclude<ApprovalOutcome, 'allowed-once'>,
  wording: { readonly cancelled?: string; readonly unavailable?: string } = {},
): string {
  if (outcome === 'rejected') return 'the human rejected it'
  if (outcome === 'cancelled') return wording.cancelled ?? 'the request was cancelled before the human decided'
  return wording.unavailable ?? 'no approval answerer available'
}

/** The `hitl_approve` answer: only `allowed-once` grants, every other outcome fails closed to a rejection. */
export function approvalAnswer(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case 'allowed-once': return 'approve'
    case 'rejected': return 'reject'
    case 'cancelled': return 'reject (cancelled before the human decided)'
    case 'unavailable': return 'reject (no approval answerer available)'
  }
}

/** One context read as one tool answer: the text when it answered, the named refusal with its detail when it refused. */
export function adaptRead(tool: string, result: ProjectedRead): string {
  if (result.ok) return result.text
  return `${tool} ${result.refusal}:\n${result.detail}`
}

/** The store one proposal call belongs to, from the caller's own trusted binding — never from an argument. */
export async function proposalStoreFor(ctx: Context, session: SessionId): Promise<string> {
  const resolution = await ctx.singularityContext.resolveCaller(session)
  if (resolution.kind === 'worker' || resolution.kind === 'root') return resolution.storeId
  throw new Error(`task-runtime: no task run is bound to session "${session}"`)
}

/** The caller's own session, and the registration id of the call it is making. */
export interface QuestionCall {
  readonly caller: SessionId
  readonly callId: string
}

/** The identity a question call runs under; a call with no live agent or no registration id has no body to cite. */
export function questionCall(exec: ToolRunContext, tool: string): QuestionCall {
  const caller = sessionId(exec, tool)
  const callId = exec.callId
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new Error(
      `${tool}: this call carries no registration id, so the body it would record cannot be cited; ` +
      'a question or an answer is only ever recorded from the message the caller itself wrote',
    )
  }
  return { caller, callId }
}

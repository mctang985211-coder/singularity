/**
 * The shape the three context-backed tools share (A2 §D): every one of them is
 * a thin adapter over `ctx.singularityContext` — the tool carries a schema, the
 * caller's live session id, and the rendering of one {@link ProjectedRead}. No
 * filtering, no cross-record selection and no rendering of records lives here;
 * those are the read core's, so the tool view and the assembled view cannot
 * drift apart.
 * @module dsh-singularity-agent/tools/projected-read
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ProjectedRead } from '@dangosys/dsh-singularity-context'

/**
 * The caller's own session id — the only identity a context read ever gets,
 * because the read domain comes from the live caller, never from an argument.
 */
export function callerSessionId(exec: ToolRunContext, tool: string): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${tool}: missing agent id`)
  return id
}

/**
 * One read as one tool answer: the text when the read answered, and the named
 * refusal with its detail when it refused. A refusal is a result, not a throw —
 * `not-activated`, `unbound`, `cross-graph` and the rest are answers the model
 * has to be told, in the same text style the tool's other rejections use.
 */
export function adaptRead(tool: string, result: ProjectedRead): string {
  if (result.ok) return result.text
  return `${tool} ${result.refusal}:\n${result.detail}`
}

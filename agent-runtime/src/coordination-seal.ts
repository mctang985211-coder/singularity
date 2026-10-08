/**
 * The seal a concluded coordination session wears: a completion closes writing,
 * at execution time, so nothing — a preset, an MCP server, a resume — can raise
 * the surface back afterwards. Reads, evidence and findings stay available.
 *
 * @module @dangosys/dsh-singularity-agent-runtime/coordination-seal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** What one refused write on a concluded coordination session answers with. */
export const COORDINATION_WRITE_DENIAL =
  'singularity: this coordination session has completed its work; writes are closed — reads, evidence and findings remain available'

/** What a concluded coordination session may still call: the read-only surface, and its own completion tool for idempotence. */
export const COORDINATION_SEALED_ALLOW: readonly string[] = [
  'task_review_pack',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'task_template_list',
  'method_list',
  'skill',
  'read',
  'glob',
  'grep',
  'supervisor_complete',
  'reviewer_complete',
]

/** The sessions this process has sealed, by session id. */
const sealed = new Set<string>()

/** Mark one coordination session concluded: every later write is refused at execution time. */
export function sealCoordinationSession(sessionId: string): void {
  sealed.add(String(sessionId))
}

/** Whether one session has been sealed by this process. */
export function isCoordinationSealed(sessionId: string): boolean {
  return sealed.has(String(sessionId))
}

/** Install the seal check on one coordination agent's own scope. */
export function guardCoordinationWrites(agentCtx: Context, agent: Agent, allow: readonly string[]): void {
  const allowed = new Set(allow)
  agentCtx.tools.guard(execution =>
    isCoordinationSealed(agent.id) && !allowed.has(execution.name) ? COORDINATION_WRITE_DENIAL : undefined,
  )
}

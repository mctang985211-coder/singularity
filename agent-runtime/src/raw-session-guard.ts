/** The four raw cross-session readers, denied at execution for every agent this runtime owns (A2 §D).
 * @module @dangosys/dsh-singularity-agent-runtime/raw-session-guard */

import type { Context } from '@deepseek-ai/cordis'

/** The four raw cross-session readers no Singularity role may execute. */
export const RAW_SESSION_READ_TOOLS: readonly string[] = [
  'session_event_read',
  'session_event_trace',
  'session_trace',
  'session_search',
]

/** The one denial reason every sealed call reports, by name. */
export const RAW_SESSION_READ_DENIAL = 'singularity: raw cross-session reads are sealed; use context_read'

/** Deny the four readers on one agent's own scope, for the agent's whole life. */
export function sealRawSessionReads(agentCtx: Context): void {
  agentCtx.tools.guard(execution =>
    RAW_SESSION_READ_TOOLS.includes(execution.name) ? RAW_SESSION_READ_DENIAL : undefined,
  )
}

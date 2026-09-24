/**
 * The raw cross-session readers, sealed (A2 §D).
 *
 * DSH's session-query tools authorize by cwd, which is wider than a graph's
 * read domain: a worker whose cwd matches the root's could read the root's
 * session log outright, and a preset or MCP grant merge could put the tools
 * back on a surface the baselines took them off. So the four names are denied
 * at execution, per agent, for every agent this runtime owns — createRoot,
 * resumeRoot and spawn all install the same guard in the agent's own setup.
 *
 * The mechanism is `tools.guard` and not another allow-list edit on purpose:
 * a guard is evaluated after every `tools/pre-execute` listener and can only
 * ever deny, so listener ordering, a grant merge, or a preset plane cannot turn
 * the seal back into permission. The tool-face side of the same rule is the
 * baselines (`task-runtime/src/capability.ts`, `tools/review-agent.ts`), which
 * simply no longer name these tools; this guard is the backstop that makes the
 * rule hold on every other surface (an un-granted spawn, an MCP-mounted alias).
 * History is read with `context_read`, which authorizes by the caller's graph
 * domain instead of a cwd.
 * @module @dangosys/dsh-singularity-agent-runtime/raw-session-guard
 */

import type { Context } from '@deepseek-ai/cordis'

/** The four raw cross-session readers no Singularity role may execute. */
export const RAW_SESSION_READ_TOOLS: readonly string[] = [
  'session_event_read',
  'session_event_trace',
  'session_trace',
  'session_search',
]

/** The one denial reason every sealed call reports, by name. */
export const RAW_SESSION_READ_DENIAL =
  'singularity: raw cross-session reads are sealed; use context_read'

/**
 * Deny the four readers on one agent's own scope, for the agent's whole life.
 * Registered through the agent's scoped context, so it travels with the agent
 * and touches no sibling; a scope chain re-evaluation cannot lift it, because
 * a guard has no allow answer.
 */
export function sealRawSessionReads(agentCtx: Context): void {
  agentCtx.tools.guard(execution =>
    RAW_SESSION_READ_TOOLS.includes(execution.name) ? RAW_SESSION_READ_DENIAL : undefined,
  )
}

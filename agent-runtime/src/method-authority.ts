/**
 * Publication authority is a fact about the orchestration role, never a
 * capability a composition may declare. A capability that names one of these
 * tools is a deployment error and is refused by name; a preset plane cannot add
 * one either, and the execution-time seal refuses the call on any agent the
 * grant did not authorise.
 *
 * @module @dangosys/dsh-singularity-agent-runtime/method-authority
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkerGrant } from './types.ts'

/** The two tools that move a library's effective environment pointer. */
export const METHOD_AUTHORITY_TOOLS: readonly string[] = ['method_publish', 'method_rollback']

/** What a call to one of them answers on an agent that does not hold the authority. */
export const METHOD_AUTHORITY_DENIAL =
  'singularity: publish and rollback rest with the round supervisor (auto) or the answered publication approval (manual); ' +
  'draft a candidate with method_draft and let it be evaluated'

/** Whether the tool is one the authority seal watches. */
export function isMethodAuthorityTool(name: string): boolean {
  return METHOD_AUTHORITY_TOOLS.includes(name)
}

/** Refuse a grant whose capability plane names an authority tool. */
export function assertNoMethodAuthorityGrant(grant: WorkerGrant): void {
  const declared = grant.capabilities
    .filter(capability => capability.tools.some(isMethodAuthorityTool))
    .map(capability => capability.capability)
  if (declared.length === 0) return
  throw new Error(
    `agent-runtime: capabilit${declared.length > 1 ? 'ies' : 'y'} ${declared.map(name => `"${name}"`).join(', ')} ` +
      `declares ${METHOD_AUTHORITY_TOOLS.join(' / ')}, which no capability may grant; ${METHOD_AUTHORITY_DENIAL}`,
  )
}

/** The authority one resolved grant carries: true only when its own allow-list holds such a tool. */
export function grantCarriesMethodAuthority(allow: readonly string[]): boolean {
  return allow.some(isMethodAuthorityTool)
}

/** Deny the two pointer tools at execution time unless this agent was granted them. */
export function sealMethodAuthority(agentCtx: Context, allow: boolean): void {
  if (allow) return
  agentCtx.tools.guard(execution => (isMethodAuthorityTool(execution.name) ? METHOD_AUTHORITY_DENIAL : undefined))
}

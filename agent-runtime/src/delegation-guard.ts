/** Business delegation stays in the Task/Run tree, including when a preset adds native agent tools. */
import type { Context } from '@deepseek-ai/cordis'

export const TASK_DELEGATION_DENIAL =
  'singularity: delegate through task_decompose; native subagent/workflow delegation has no Task contract or Run'

/** The native delegation tools in the supported DSH presets, including optional external providers. */
export function isNativeDelegationTool(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_') || name === 'workflow' || name === 'ralph'
}

/** Local tools can escape schema restriction; enforce the same rule at execution on create and resume. */
export function sealNativeDelegation(agentCtx: Context): void {
  agentCtx.tools.guard(execution => isNativeDelegationTool(execution.name) ? TASK_DELEGATION_DENIAL : undefined)
}

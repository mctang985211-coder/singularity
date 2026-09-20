/**
 * The worker contract, projected into the worker's system prompt.
 *
 * The gap this closes (guide §4.2 #6): a worker met its contract exactly once,
 * as the spawn prompt — a user message that compaction is free to shadow. After
 * a fold and a fresh prompt, nothing kept the objective and the acceptance
 * criteria in front of the model.
 *
 * Upstream already owns the mechanism, so this module only feeds it. The
 * rendered system prompt IS session surface node 0, and the loop reprojects it
 * on every step — `agent-loop` calls `SystemPromptProjection.project` once per
 * attempt (`thirdparty/deepseek-harness/packages/core/agent-loop/src/agent.ts:365-370`,
 * implementation `packages/core/agent-loop/src/runtime-context.ts:83-98`) — and
 * compaction never selects node 0
 * (`packages/compaction/compaction-basic/src/region.ts:111-112,132`).
 *
 * Two properties follow, and they are what make this idempotent rather than a
 * growing stack of reminders:
 * - An unchanged rendering commits nothing. `project` compares the rendered
 *   prompt against the text already on node 0 and returns an empty update list
 *   when they match (`runtime-context.ts:96`), so a stable contract is written
 *   once and then costs no extra session events.
 * - A lost or rewritten surface is restored with exactly one write. When the
 *   route is an `in-history` one the text is appended as a new system node, and
 *   `startsSeries` collapses older ones; otherwise node 0 is replaced
 *   (`runtime-context.ts:90-98`). Either way a step can add one copy, never a
 *   second copy of the same reminder.
 *
 * The text comes from the task runtime, which owns the store. Contract data is
 * immutable once a task is admitted, so a section registered at spawn stays
 * correct for the whole run and the loop never sees a change it would have to
 * write.
 * @module @dangosys/dsh-singularity-agent-runtime/contract-reinjection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Section name. Registered into the worker's own scope, so no other agent inherits it. */
export const WORKER_CONTRACT_SECTION = 'singularity:worker-contract'

/**
 * Placement: after the root's own `singularity:root` section (order 70) and
 * well before the tool guidance the composition contributes at order 500+.
 */
export const WORKER_CONTRACT_ORDER = 80

/**
 * Whether a spawn carries text to project. An absent or blank rendering
 * registers nothing: a worker spawned outside the task runtime, and every root
 * agent, keeps exactly the prompt its composition gives it.
 */
export function carriesContract(contract: string | undefined): contract is string {
  return contract !== undefined && contract.trim().length > 0
}

/**
 * The section a worker's contract rides on. `interpolate: false` because the
 * text is literal contract data: an objective or a criterion that happens to
 * contain `{{…}}` must reach the model as written, not be looked up as a prompt
 * variable (and `renderPrompt` throws on an unknown reference).
 */
export function contractSection(text: string): PromptSection {
  return { name: WORKER_CONTRACT_SECTION, order: WORKER_CONTRACT_ORDER, text, interpolate: false }
}

/**
 * Register the contract into one agent's prompt scope, during that agent's
 * setup. Returns whether a section was registered.
 *
 * The registration lives on `agentCtx`, the agent's own scope: it is disposed
 * with the agent and cannot leak into sibling workers or into the root, which
 * is why this is not a global section.
 */
export function installWorkerContract(agentCtx: Context, contract: string | undefined): boolean {
  if (!carriesContract(contract)) return false
  agentCtx.systemPrompt.section(contractSection(contract))
  return true
}

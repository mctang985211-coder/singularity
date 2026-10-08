/**
 * The one model selection this plane freezes with a plan and re-reads before a
 * publish. The deployment resolves the shape it already has; this module turns
 * it into the structured identity both sides run under.
 *
 * @module dsh-singularity-evolution/model
 */

import type { ModelSelection } from './types.ts'

/** Read one selection as the structured identity, or `undefined` when it names no usable route. */
export function modelSelectionOf(
  selection:
    | {
        provider?: unknown
        model?: unknown
        reasoningEffort?: unknown
        maxTokens?: unknown
      }
    | undefined,
): ModelSelection | undefined {
  const provider =
    typeof selection?.provider === 'string' && selection.provider.length > 0 ? selection.provider : undefined
  const model = typeof selection?.model === 'string' && selection.model.length > 0 ? selection.model : undefined
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort =
    typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
      ? selection.reasoningEffort
      : undefined
  const maxTokens =
    typeof selection?.maxTokens === 'number' && Number.isFinite(selection.maxTokens) && selection.maxTokens > 0
      ? selection.maxTokens
      : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    label: `${provider}/${model}`,
  }
}

/** The `AgentOptions` a frozen selection travels as: the four members, verbatim, with no label. */
export function agentOptionsOf(selection: ModelSelection): {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
} {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    ...(selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens }),
  }
}

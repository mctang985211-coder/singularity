/** Graph model pinning: the single graph→agent-options read and the provider/model validation. @module @dangosys/dsh-singularity-graphs/model */

import type { AgentOptions } from '@dangosys/dsh-singularity-agent-runtime'
import type { GraphModel, GraphRecord } from './types.ts'

/** The `ctx.llm` reads model validation uses: registered routes and the models one route serves. */
export interface ModelCatalogReader {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
}

/** Agent options for the model a graph pins, or `undefined` when it follows the deployment default. */
export function graphAgentOptions(graph: Pick<GraphRecord, 'model'>): AgentOptions | undefined {
  const model = graph.model
  if (model === undefined) return undefined
  return {
    provider: model.provider,
    model: model.model,
    ...model.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: model.reasoningEffort as AgentOptions['reasoningEffort'] },
  }
}

/** Refuse a model whose provider route is not registered, or whose route does not advertise that model. */
export async function assertModelServiceable(llm: ModelCatalogReader, model: GraphModel): Promise<void> {
  if (!llm.listProviders().some(route => route.id === model.provider)) {
    throw new Error(`graphs: model.provider "${model.provider}" is not a registered provider route`)
  }
  const models = await llm.listModels(model.provider)
  if (!models.some(entry => entry.id === model.model)) {
    throw new Error(`graphs: model.model "${model.model}" is not served by provider "${model.provider}"`)
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { MODELS_PATH } from '../../constants.ts'
import { fail, guardMethod, messageOf, sendJson } from '../libs/http.ts'

/** The `ctx.llm` reads the model picker serves: registered routes and the models one route serves. */
interface ModelCatalog {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
}

/** The `ctx.agentDefaultModel` read of the deployment default selection. */
interface DefaultModel {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

export function registerModels(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MODELS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      try {
        const llm = ctx.get('llm') as ModelCatalog
        const defaults = ctx.get('agentDefaultModel') as DefaultModel
        const providers = await Promise.all(
          llm.listProviders().map(async route => {
            try {
              const models = await llm.listModels(route.id)
              return {
                id: route.id,
                displayName: route.name,
                models: models.map(model => ({ id: model.id, name: model.name })),
              }
            } catch (error) {
              // One unreachable route answers an empty catalog and its diagnosis; the rest still serve.
              return { id: route.id, displayName: route.name, models: [], error: messageOf(error) }
            }
          }),
        )
        const selection = defaults.currentSelection()
        sendJson(res, 200, {
          providers,
          default: {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          },
        })
      } catch (error) {
        fail(res, error)
      }
    },
  })
}

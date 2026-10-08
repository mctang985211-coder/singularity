/** @module dsh-singularity-graph-web */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@dangosys/dsh-env-builder'
import type {} from '@dangosys/dsh-singularity-graph'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-agent'
import type {} from '@dangosys/dsh-singularity-task'
import { registerEvents, registerGraph, registerHitl, registerLayout } from './web/api/routes.ts'
import { registerGraphEnvs } from './web/api/graph-envs.ts'
import { registerGraphs } from './web/api/graphs.ts'
import { registerMapStatic } from './web/api/map-static.ts'
import { registerMethods, subscribeMethods } from './web/api/methods.ts'
import { registerModels } from './web/api/models.ts'
import { registerRecovery, registerReview, registerTask } from './web/api/task.ts'
import { registerView } from './web/api/view.ts'
import { GraphBroadcast } from './web/libs/broadcast.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'pr-chat/path': (event: unknown) => void
    'pr-chat/sent': (event: unknown) => void
  }
}

export const name = 'graph-web'
export const inject = ['graph', 'layout', 'graphs', 'envBuilder', 'webServer', 'hitl', 'llm', 'agentDefaultModel']

export function apply(ctx: Context): void {
  const broadcast = new GraphBroadcast(ctx)
  ctx.on('graph/change', snapshot => broadcast.publish(snapshot))
  ctx.on('layout/change', snapshot => broadcast.publishLayout(snapshot))
  ctx.on('graphs/change', snapshot => broadcast.publishGraphs(snapshot))
  ctx.on('hitl/change', pending => broadcast.publishEvent('hitl', { pending }))
  ctx.on('task/change', snapshot => broadcast.publishEvent('task', { storeId: snapshot.id }))
  ctx.on('pr-chat/path', event => broadcast.publishEvent('pr-chat/path', event))
  ctx.on('pr-chat/sent', event => broadcast.publishEvent('pr-chat/sent', event))
  ctx.effect(() => {
    const graph = registerGraph(ctx)
    const layout = registerLayout(ctx)
    const graphs = registerGraphs(ctx)
    const view = registerView(ctx)
    const methods = registerMethods(ctx)
    const models = registerModels(ctx)
    const graphEnvs = registerGraphEnvs(ctx)
    const hitl = registerHitl(ctx)
    const task = registerTask(ctx)
    const recovery = registerRecovery(ctx)
    const review = registerReview(ctx)
    const methodEvents = subscribeMethods(ctx, broadcast)
    const events = registerEvents(ctx, broadcast)
    const map = registerMapStatic(ctx)
    return () => {
      graph()
      layout()
      graphs()
      view()
      methods()
      models()
      graphEnvs()
      hitl()
      task()
      recovery()
      review()
      methodEvents()
      events()
      map()
      broadcast.close()
    }
  }, 'web: routes')
}

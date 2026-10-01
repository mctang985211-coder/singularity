import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { isReusableEnv } from '@dangosys/dsh-singularity-graphs'
import { GRAPH_ENVS_PATH, REPO_CHECK_PATH } from '../../constants.ts'
import { guardMethod, readJson, sendJson } from '../libs/http.ts'

export function registerGraphEnvs(ctx: Context): () => void {
  const stopList = ctx.webServer.register({
    kind: 'exact',
    path: GRAPH_ENVS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      const bound = new Set((await ctx.graphs.list()).map(g => g.envId))
      const envs = ctx.envBuilder.store.list().map(env => ({
        id: env.id,
        label: env.label,
        path: env.path,
        componentCount: env.components.length,
        sessionCount: env.sessionIds.length,
        available: isReusableEnv(env, bound),
        bound: bound.has(env.id),
      }))
      sendJson(res, 200, { envs })
    },
  })

  const stopCheck = ctx.webServer.register({
    kind: 'exact',
    path: REPO_CHECK_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'POST')) return
      const body = await readJson<{ repo?: string }>(req)
      if (typeof body.repo !== 'string' || body.repo.trim().length === 0) {
        throw new Error('repo-check: missing repo')
      }
      const parsed = await ctx.envBuilder.assertRepo(body.repo)
      sendJson(res, 200, {
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.dir,
      })
    },
  })

  return () => {
    stopList()
    stopCheck()
  }
}

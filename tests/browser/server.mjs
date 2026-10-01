import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../../map/node_modules/vite/dist/node/index.js'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { EnvStore } from '../../../env-builder/lib/index.js'
import Graph from '../../graph/lib/index.js'
import Layout, { DEFAULT_ROOT } from '../../graph/lib/layout.js'
import Graphs from '../../graphs/lib/index.js'
import { TaskService } from '../../task/lib/index.js'
import { TaskRuntime } from '../../task-runtime/lib/index.js'
import { HitlService } from '../../agent-singularity/lib/index.js'
import UserQuestionService from '../../../../thirdparty/deepseek-harness/packages/interaction/user-questions/lib/index.js'
import { apply as graphWeb } from '../../graph-web/lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'singularity-browser-'))
const ctx = new Context()
const routes = []
const sessions = new Map()
ctx.provide('sessionPersistence', {
  list: async () => [...sessions.values()].map(session => ({ header: session.header })),
  create: async header => {
    const events = []
    const handle = {
      read: async () => ({ events }),
      append: async rows => events.push(...rows),
      flush: async () => {},
      close: async () => {},
    }
    sessions.set(header.id, { header, handle })
    return handle
  },
  open: async id => sessions.get(id).handle,
})
new Graph(ctx)
new Layout(ctx)
new HitlService(ctx)
await ctx.plugin(UserQuestionService)
ctx.provide('envBuilder', { store: new EnvStore(root) })
ctx.provide('agentRuntime', {
  createRoot: async ({ sessionId, scope }) => {
    await ctx.layout.setIn(scope.layoutStoreId, sessionId, DEFAULT_ROOT)
    await ctx.graph.addAgentIn(scope.graphStoreId, { id: sessionId, name: 'Singularity', status: 'idle' }, true)
    return { agent: { id: sessionId } }
  },
  ensureRoot: async id => ({ agent: { id } }),
  prompt: async agent => {
    if ((await ctx.graphs.list()).length > 1) {
      await ctx.graphs.markReady((await ctx.graphs.graphForSession(agent.id)).id)
    }
  },
  stopAgents: async () => {},
  stopGraph: async () => {},
  spawn: async () => {
    throw new Error('fixture: cleanup is outside browser scenarios')
  },
})
new Graphs(ctx)
// graphs activation adopts each new root store through the task plane, so the fixture mounts it.
ctx.provide('sessionQuery', {
  readSurface: async sessionId => {
    const found = sessions.get(sessionId)
    if (found === undefined) throw new Error(`fixture: session "${sessionId}" has no log`)
    const { events } = await found.handle.read()
    return { capturedThroughSeq: events.at(-1)?.seq ?? null }
  },
  readSession: async sessionId => {
    const found = sessions.get(sessionId)
    if (found === undefined) throw new Error(`fixture: session "${sessionId}" has no log`)
    const { events } = await found.handle.read()
    return { session: { id: sessionId }, inheritedEventCount: 0, events }
  },
  readEvent: async () => {
    throw new Error('fixture: reading a single session event is outside browser scenarios')
  },
})
new TaskService(ctx)
new TaskRuntime(ctx, { runBindingRoot: join(root, 'run-bindings') })
ctx.provide('sessions', {})
ctx.provide('webServer', {
  register: route => {
    routes.push(route)
    return () => routes.splice(routes.indexOf(route), 1)
  },
})
graphWeb(ctx)
for (const name of ['Alpha', 'Beta']) {
  const { graph } = await ctx.graphs.create({ createEnv: true, name, repos: [`fixture/${name.toLowerCase()}`] })
  const child = `${graph.id}-worker`
  await ctx.layout.setIn(graph.layoutStoreId, child, { ...DEFAULT_ROOT, x: 380, y: 210 })
  await ctx.graph.commitIn(graph.graphStoreId, [
    { kind: 'agent/add', agent: { id: child, name: `${name} worker`, status: 'idle' } },
    { kind: 'edge/add', edge: { id: child, kind: 'spawn', from: graph.rootSessionId, to: child } },
  ])
  ctx.envBuilder.store.attachSession(graph.envId, child)
}
const server = await createServer({
  configFile: false,
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(
        import.meta.dirname,
        '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js',
      ),
      '@deepseek-ai/dsh-typert-protocol': resolve(
        import.meta.dirname,
        '../../../../thirdparty/deepseek-harness/packages/typert/protocol/lib/index.js',
      ),
      '@deepseek-ai/dsh-api-gateway/client': resolve(
        import.meta.dirname,
        '../../../../thirdparty/deepseek-harness/packages/api/gateway/src/client/index.ts',
      ),
      // canvas-view's bundle requires react; the fixture serves the SPA's own copy.
      react: resolve(import.meta.dirname, '../../map/node_modules/react'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../../../..')] },
  },
  plugins: [
    {
      name: 'singularity-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, 'http://fixture')
          try {
            if (url.pathname === '/__fixture/sessions') {
              // One `session/list` item per graph agent, in the Host row shape the
              // client catalog consumes (agentAvailable included).
              const items = []
              for (const graph of await ctx.graphs.list()) {
                for (const agent of (await ctx.graph.snapshotIn(graph.graphStoreId)).agents) {
                  items.push({ sessionId: agent.id, updatedAt: 1, running: false, blank: true, agentAvailable: true })
                }
              }
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ items }))
              return
            }
            if (url.pathname === '/__fixture/ask' && req.method === 'POST') {
              const graph = await ctx.graphs.get(url.searchParams.get('graphId'))
              void ctx.userQuestions
                .ask({ questions: [{ id: 'fixture-ask', question: 'Which repository?' }] })
                .then(answer => console.log('HITL answer:', answer))
              res.end('ok')
              return
            }
            const route =
              routes.find(route => route.kind === 'exact' && route.path === url.pathname) ??
              routes.find(route => route.kind === 'prefix' && url.pathname.startsWith(route.path + '/'))
            if (route) await route.handler(req, res)
            else next()
          } catch (error) {
            if (res.headersSent) res.destroy(error)
            else {
              res.writeHead(500)
              res.end(String(error))
            }
          }
        })
      },
    },
  ],
})
await server.listen()
console.log('Singularity browser fixture: http://127.0.0.1:5199')
process.on('SIGINT', async () => {
  await server.close()
  await rm(root, { recursive: true })
  process.exit(0)
})

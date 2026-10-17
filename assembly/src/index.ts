import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from './agent.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { loadDomain } from './domain.ts'
import { openDriver } from './driver.ts'
import { createExecution } from './execution.ts'
import { mountBubbleWorld } from './bubble.ts'
import { spawnProcess } from './process.ts'
import { parentMemoryCall, mountMemoryCalls } from './memory-call.ts'
import { methodReviewTools } from './review.ts'
import { improvementTools } from './improvement.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { record as objectRecord, nonEmpty } from './shape.ts'
import { mountProviderCalls } from './provider.ts'

interface RestartRoot { readonly message: UserMessage; readonly options: AgentOptions; readonly cwd?: string }
interface ProviderRun { readonly controlId: string; readonly stopped: boolean; readonly roots: readonly RestartRoot[] }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'singularity/provider': ProviderRun }
}

export const name = 'singularity-assembly'

export const inject = ['agents', 'tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'tokenMeter', 'attachments', 'agentPresets', 'llm']

const CONFIG_MEMBERS = ['controlId', 'domainDir', 'workspaceRoot', 'methodFile'] as const

export const Config = z.object({
  controlId: z.string().required(),
  domainDir: z.string().required(),
  workspaceRoot: z.string().required(),
  methodFile: z.string(),
})

export interface Config {
  /** Deployment identity; one-click restarts mint fresh graph control ids under it. */
  readonly controlId: string
  /** The directory holding this deployment's `task.json` and the verifier its criteria name. */
  readonly domainDir: string
  /** Where task workspaces are built. Named by the deployment, never guessed from the cwd. */
  readonly workspaceRoot: string
  readonly methodFile?: string
}

export function mountCampaignMemory(ctx: Context): void {
  const memory = mountMemoryCalls(ctx)
  ctx.on('llm/stream', async function* (options, next) {
    if (parentMemoryCall.getStore() !== undefined && options.sessionId !== undefined) return yield* memory.stream(options, next)
    return yield* next()
  })
}
export async function apply(ctx: Context, config: Config & Record<string, unknown>): Promise<void> {
  assertClosedKeys(config, CONFIG_MEMBERS, 'the singularity-assembly config')
  const domain = await loadDomain(config.domainDir, spawnProcess)
  const initialMethod = config.methodFile === undefined ? undefined : JSON.parse(await readFile(config.methodFile, 'utf8'))
  const statusId = SessionId(`singularity:provider:${config.controlId}`)
  const statusLog = await ctx.sessionPersistence.stat(statusId) === undefined
    ? await ctx.sessionPersistence.create(Session.create(statusId).header)
    : await ctx.sessionPersistence.open(statusId, 'write')
  ctx.effect(() => () => statusLog.close())
  const history = (await statusLog.read()).events
  let statusSeq = history.length
  const last = history.at(-1)
  let run: ProviderRun = last?.type === 'singularity/provider' ? last.data : { controlId: config.controlId, stopped: false, roots: [] }
  const record = async () => {
    await statusLog.append([{ seq: SessionSeq(statusSeq++), time: Date.now(), type: 'singularity/provider', data: run, ignorable: true }])
    await statusLog.flush()
  }
  const startDriver = () => openDriver({
    initialMethod,
    controlId: run.controlId,
    workspaceRoot: config.workspaceRoot,
    domain,
    persistence: ctx.sessionPersistence,
    projections: ctx.sessionProjections,
    attachments: ctx.attachments,
    seams: ctx as ChildSessionSeams,
    execution: (admission, onTurnFailure) => createExecution(ctx, admission, onTurnFailure),
  })
  let driver = await startDriver()
  let lifetime = new AbortController()
  let stopping: Promise<void> | undefined, restarting: Promise<void> | undefined
  const restartedRoots: AgentHandle[] = []
  if (run.stopped) { lifetime.abort(); driver.stop() }
  ctx.provide('singularity', {
    inheritRsi: async input => {
      const raw = objectRecord(input, 'RSI memory link')
      const agent = ctx.agents.get(SessionId(nonEmpty(raw['sessionId'], 'sessionId')))
      if (agent !== undefined && ctx.agentPresets.serviceFor(agent, 'singularityAgentRole') !== 'root')
        refuse('not-responsible', 'campaign RSI memory requires a live business root recipient')
      await driver.inheritRsi(input)
    },
    forCall: (exec: ToolRunContext) => driver.forCall(exec),
    read: async () => ({ ...await driver.read(), providerStopped: run.stopped }),
    restart: () => {
      if (restarting !== undefined) return restarting
      if (!run.stopped) throw new Error('Only a graph stopped by an unstable provider can be restarted')
      const opening: AgentHandle[] = []
      restarting = (async () => {
        await stopping
        await Promise.all(ctx.agents.list().map(agent => agent.whenIdle()))
        await driver.close()
        run = { ...run, controlId: `${config.controlId}:restart:${randomUUID()}` }
        driver = await startDriver()
        lifetime = new AbortController()
        const roots = run.roots
        for (const root of roots) {
          const handle = await ctx.agents.create({ sessionId: SessionId(`session-${randomUUID()}`), agentOptions: root.options,
            meta: { ...(root.cwd === undefined ? {} : { cwd: root.cwd }), agentPreset: 'singularity-root' },
            setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') },
          })
          opening.push(handle)
        }
        run = { ...run, stopped: false }
        await record()
        restartedRoots.push(...opening)
        for (const [index, handle] of opening.entries())
          handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: roots[index]!.message.content }))
      })().catch(async error => {
        run = { ...run, stopped: true }
        lifetime.abort()
        driver.stop()
        await Promise.all(opening.map(handle => handle.dispose()))
        throw error
      }).finally(() => { restarting = undefined })
      return restarting
    },
    mountSkills: (agent: import('@deepseek-ai/dsh-agent').Agent) => driver.mountSkills(agent),
    world: (agentId: string) => driver.world(agentId),
    memoryContext: (agentId: string) => driver.memoryContext(agentId),
  })
  const routes = new WeakMap<import('@deepseek-ai/dsh-agent').Agent, { provider: string; model: string }>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const prompt = await next()
    if (context.agent !== undefined) {
      const provider = prompt.variables['provider'], model = prompt.variables['model']
      if (typeof provider !== 'string' || typeof model !== 'string') refuse('malformed-declaration', 'Singularity prompt has no exact model route')
      routes.set(context.agent, { provider, model })
      const responsibility = driver.responsibility(String(context.agent.id))
      const reviewTarget = driver.reviewTarget(String(context.agent.id))
      if (reviewTarget !== undefined && reviewTarget.kind !== 'acceptance')
        prompt.tools = prompt.tools.filter(tool => methodReviewTools.has(tool.name))
      if (ctx.agentPresets.serviceFor(context.agent, 'singularityAgentRole') === 'improve')
        prompt.tools = prompt.tools.filter(tool => improvementTools.has(tool.name))
      if (responsibility !== undefined) {
        prompt.contexts.push({ name: 'singularity:responsibility', text: JSON.stringify(responsibility) })
        if (responsibility.waiting !== null) {
          const readable = new Set(['read', 'read_image', 'glob', 'grep', 'singularity_read', 'singularity_memory',
            'singularity_answer', 'singularity_ask_parent', 'singularity_stop_explorations', 'singularity_retry_task'])
          prompt.tools = prompt.tools.filter(tool => readable.has(tool.name))
        }
      }
    }
    return prompt
  })
  const worlds = new WeakMap<import('@deepseek-ai/dsh-agent').Agent, Promise<void>>()
  const ensureWorld = (agent: import('@deepseek-ai/dsh-agent').Agent): Promise<void> => {
    if (ctx.tools.get('singularity_read', agent) === undefined) return Promise.resolve()
    let mounting = worlds.get(agent)
    if (mounting === undefined) {
      mounting = (async () => {
        if (run.stopped && restarting === undefined) return
        await driver.activate(String(agent.session.id))
        const root = ctx.agentPresets.serviceFor(agent, 'singularityAgentRole') === 'root'
        await driver.prepareMemory(agent)
        if (!root) await driver.mountSkills(agent)
        await mountBubbleWorld(agent, () => driver.world(String(agent.id)), root)
      })()
      worlds.set(agent, mounting)
      void mounting.catch(() => { worlds.delete(agent) })
    }
    return mounting
  }
  ctx.on('agent/created', async ({ agent }) => { await ensureWorld(agent)
    return undefined })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (run.stopped) return { kind: 'reject' }
    await ensureWorld(agent)
    const decision = await next()
    if (decision.kind === 'reject' || ctx.tools.get('singularity_read', agent) === undefined) return decision
    signal.throwIfAborted()
    const route = routes.get(agent)
    if (route === undefined) refuse('malformed-declaration', 'native admission requires the assembled model route')
    if (!(await ctx.sessions.flush(agent.session))) refuse('write-not-durable', 'native root session has no durability listener')
    const assignment = await driver.enter(agent, decision.messages, route)
    if (driver.failed(String(agent.id))) return { kind: 'reject' }
    return assignment === undefined ? decision : { ...decision, messages: [...decision.messages, assignment] }
  })
  mountProviderCalls(ctx, () => lifetime.signal, async () => {
    if (run.stopped) return stopping
    const agents = ctx.agents.list()
    const pendingRoots = agents.filter(agent => ctx.agentPresets.serviceFor(agent, 'singularityAgentRole') === 'root')
      .flatMap(agent => {
        const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].findLast(message => message.source.kind === 'user')
        return pending === undefined ? [] : [{ sessionId: String(agent.id), root: { message: pending, options: agent.options,
          ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }) } }]
      })
    run = { ...run, stopped: true }
    lifetime.abort(new Error('provider 不稳定；整张图已结束'))
    driver.stop()
    for (const agent of agents) agent.cancel({ kind: 'parent' })
    ctx.logger.error('provider 不稳定；整张图已结束')
    stopping = (async () => {
      const snapshot = await driver.read()
      const children = new Set(snapshot.plans.flatMap(plan => plan.children.map(child => child.taskId)))
      const rootTasks = snapshot.tasks.filter(task => task.purpose === 'solve' && !children.has(task.taskId) &&
        (task.closure === null || task.rsi?.status === 'pending' || task.rsi?.status === 'running'))
      const roots: RestartRoot[] = pendingRoots.filter(pending => !rootTasks.some(task => task.sessionId === pending.sessionId)).map(pending => pending.root)
      for (const task of rootTasks) {
        const agent = agents.find(agent => String(agent.id) === task.sessionId)!
        const handle = await ctx.sessionPersistence.open(SessionId(task.sessionId!), 'read')
        try {
          const events = (await handle.read()).events
          const message = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
          const header = events.findLast(event => event.type === 'request/header')
          roots.push({ message: message?.type === 'user/message' ? message.data : createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task.goal }] }),
            options: header?.type === 'request/header' ? header.data.header.config : agent.options,
            ...(handle.header.cwd === undefined ? {} : { cwd: handle.header.cwd }) })
        } finally { await handle.close() }
      }
      if (roots.length === 0) throw new Error('Stopped graph has no original root request to restart')
      run = { ...run, roots }
      await record()
    })()
    await stopping
  })
  mountCampaignMemory(ctx)
  ctx.effect(() => async () => {
    lifetime.abort()
    await stopping
    await Promise.all([driver.close(), ...restartedRoots.map(handle => handle.dispose())])
  })
}

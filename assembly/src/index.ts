import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { loadDomain } from './domain.ts'
import { openDriver } from './driver.ts'
import { createExecution } from './execution.ts'
import { mountBubbleWorld } from './bubble.ts'
import { spawnProcess } from './process.ts'
import type { CampaignLimits } from './budget.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { refuse } from '../../src/protocol/refusal.ts'

export const name = 'singularity-assembly'

export const inject = ['agents', 'tools', 'sessions', 'sessionPersistence', 'attachments']

const CONFIG_MEMBERS = ['controlId', 'domainDir', 'workspaceRoot', 'budget'] as const

export const Config = z.object({
  controlId: z.string().required(),
  domainDir: z.string().required(),
  workspaceRoot: z.string().required(),
  budget: z.object({ nativeTokens: z.number().required(), unknownUsageReservations: z.array(z.object({
    sessionId: z.string().required(), seq: z.number().required(), tokens: z.number().required(),
  })) }),
})

export interface Config {
  /** The control id every task fact is written under. Minted once by a deployment, never derived. */
  readonly controlId: string
  /** The directory holding this deployment's `task.json` and the verifier its criteria name. */
  readonly domainDir: string
  /** Where task workspaces are built. Named by the deployment, never guessed from the cwd. */
  readonly workspaceRoot: string
  readonly budget?: CampaignLimits
}
export async function apply(ctx: Context, config: Config & Record<string, unknown>): Promise<void> {
  assertClosedKeys(config, CONFIG_MEMBERS, 'the singularity-assembly config')
  const domain = await loadDomain(config.domainDir, spawnProcess)
  const driver = await openDriver({
    controlId: config.controlId,
    workspaceRoot: config.workspaceRoot,
    ...(config.budget === undefined ? {} : { budget: config.budget }),
    domain,
    persistence: ctx.sessionPersistence,
    attachments: ctx.attachments,
    seams: ctx as ChildSessionSeams,
    execution: (admission, onTurnFailure) => createExecution(ctx, admission, onTurnFailure),
  })
  ctx.provide('singularity', {
    forCall: (exec: ToolRunContext) => driver.forCall(exec),
    read: () => driver.read(),
    skill: (agentId: string) => driver.skill(agentId),
    recordContext: (agentId: string) => driver.recordContext(agentId),
    mountSkills: (agent: import('@deepseek-ai/dsh-agent').Agent) => driver.mountSkills(agent),
    world: (agentId: string) => driver.world(agentId),
    purpose: (agentId: string) => driver.purpose(agentId),
  })
  const routes = new WeakMap<import('@deepseek-ai/dsh-agent').Agent, { provider: string; model: string }>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const prompt = await next()
    if (context.agent !== undefined) {
      const provider = prompt.variables['provider'], model = prompt.variables['model']
      if (typeof provider !== 'string' || typeof model !== 'string') refuse('malformed-declaration', 'Singularity prompt has no exact model route')
      routes.set(context.agent, { provider, model })
      const skill = await driver.skill(String(context.agent.id))
      if (skill !== undefined) prompt.sections.push({ name: 'singularity:method', text: skill, interpolate: false })
    }
    return prompt
  })
  const worlds = new WeakMap<import('@deepseek-ai/dsh-agent').Agent, Promise<void>>()
  const ensureWorld = (agent: import('@deepseek-ai/dsh-agent').Agent): Promise<void> => {
    if (ctx.tools.get('singularity_retry_task', agent) === undefined) return Promise.resolve()
    let mounting = worlds.get(agent)
    if (mounting === undefined) {
      mounting = (async () => {
        await driver.activate(String(agent.session.id))
        await driver.mountSkills(agent)
        await mountBubbleWorld(agent, () => driver.world(String(agent.id)))
      })()
      worlds.set(agent, mounting)
    }
    return mounting
  }
  ctx.on('agent/created', async ({ agent }) => { await ensureWorld(agent); return undefined })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await ensureWorld(agent)
    const decision = await next()
    if (decision.kind === 'reject' || ctx.tools.get('singularity_retry_task', agent) === undefined) return decision
    signal.throwIfAborted()
    const route = routes.get(agent)
    if (route === undefined) refuse('malformed-declaration', 'native admission requires the assembled model route')
    if (!await ctx.sessions.flush(agent.session)) refuse('write-not-durable', 'native root session has no durability listener')
    const assignment = await driver.enter(agent, decision.messages, route)
    return assignment === undefined ? decision : { ...decision, messages: [...decision.messages, assignment] }
  })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const request = await next()
    if (ctx.tools.get('singularity_retry_task', agent) === undefined) return request
    if (!await ctx.sessions.flush(agent.session)) refuse('write-not-durable', 'campaign session has no native durability listener')
    const budget = driver.budget
    let resolved = request
    if (budget !== undefined) {
      await budget.enroll(String(agent.session.id))
      resolved = await (ctx.get('llm') as LlmRuntime).resolveCallConfig(request, signal)
      resolved = { ...resolved, maxTokens: budget.beforeRequest(resolved.maxTokens) }
    }
    await driver.recordContext(String(agent.id))
    return resolved
  })
  if (driver.budget !== undefined) {
    const budget = driver.budget
    const stop = () => {
      for (const session of ctx.sessions.list())
        if (budget.owns(String(session.id))) ctx.agents.get(session.id)?.cancel({ kind: 'parent' }, { keepInbox: true })
    }
    ctx.on('llm/stream', async function* (options, next) {
      if (options.sessionId === undefined || !budget.owns(String(options.sessionId))) return yield* next()
      return yield* budget.stream(options, next, stop)
    })
    ctx.on('session/event', (session, event) => {
      if (budget.owns(String(session.id))) budget.observe(String(session.id), event)
    })
  }
  ctx.effect(() => () => driver.close())
}

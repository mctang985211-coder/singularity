import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'

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
import { ParentMemoryUnavailable } from './parent-memory.ts'
import { methodReviewTools } from './review.ts'
import { improvementTools } from './improvement.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { record as objectRecord, nonEmpty } from './shape.ts'
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
  /** Identity of this deployment's control log. */
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
  const driver = await openDriver({
    initialMethod,
    controlId: config.controlId,
    workspaceRoot: config.workspaceRoot,
    domain,
    persistence: ctx.sessionPersistence,
    projections: ctx.sessionProjections,
    attachments: ctx.attachments,
    seams: ctx as ChildSessionSeams,
    execution: (admission, onTurnFailure) => createExecution(ctx, admission, onTurnFailure),
  })
  ctx.provide('singularity', {
    inheritRsi: async input => {
      const raw = objectRecord(input, 'RSI memory link')
      const agent = ctx.agents.get(SessionId(nonEmpty(raw['sessionId'], 'sessionId')))
      if (agent !== undefined && ctx.agentPresets.serviceFor(agent, 'singularityAgentRole') !== 'root')
        refuse('not-responsible', 'campaign RSI memory requires a live business root recipient')
      await driver.inheritRsi(input)
    },
    cancel: input => driver.cancel(input),
    forCall: (exec: ToolRunContext) => driver.forCall(exec),
    read: () => driver.read(),
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
      if (reviewTarget !== undefined) prompt.contexts.push({ name: 'singularity:review-purpose', text: JSON.stringify({
        purpose: reviewTarget.kind,
        instruction: reviewTarget.kind === 'acceptance'
          ? 'This is acceptance. Read the sealed producer trajectory for execution evidence using singularity_read(kind=trajectory). Loose workspace files are not sealed artifacts, but the sealed source transcript is readable. If necessary, delegate an independent evidence Task using dispatch.evidenceInputs; never call a private host oracle.'
          : reviewTarget.kind === 'proposal'
            ? 'This is a pre-execution proposal screen. Decide whether the changed mechanism is supported and safe to TEST. Transfer and performance are hypotheses here; missing experiment results are not a reason to reject. Compare before and after explicitly; no execution or delegation.'
            : 'This is publication. Judge the frozen independent measurements and release conditions; no execution or delegation.',
      }) })
      if (ctx.agentPresets.serviceFor(context.agent, 'singularityAgentRole') === 'improve')
        prompt.tools = prompt.tools.filter(tool => improvementTools.has(tool.name))
      const search = driver.rsiState(String(context.agent.id))
      if (search !== undefined) {
        prompt.contexts.push({ name: 'singularity:rsi-state', text: JSON.stringify(search) })
        const writable = new Set(['write', 'edit'])
        prompt.tools = prompt.tools.filter(tool =>
          (tool.name !== 'singularity_propose_method' || search.canPropose) &&
          (tool.name !== 'singularity_submit' || search.canSubmit) &&
          (!writable.has(tool.name) || search.phase === 'ready'))
      }
      if (responsibility !== undefined) {
        prompt.contexts.push({ name: 'singularity:responsibility', text: JSON.stringify(responsibility) })
        if (responsibility.waiting !== null) {
          const readable = new Set(['read', 'read_image', 'glob', 'grep', 'singularity_read', 'singularity_memory',
            'singularity_answer', 'singularity_ask_parent', 'singularity_stop_explorations', 'singularity_retry_task',
            ...(responsibility.responsibility.canPlan ? ['singularity_decompose_task'] : [])])
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
        await driver.activate(String(agent.session.id))
        const root = ctx.agentPresets.serviceFor(agent, 'singularityAgentRole') === 'root'
        try { await driver.prepareMemory(agent) }
        catch (error) {
          if (!(error instanceof ParentMemoryUnavailable)) throw error
          ctx.logger.warn('Optional parent background unavailable for %s: %s', agent.id, error)
        }
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
    await ensureWorld(agent)
    const decision = await next()
    if (decision.kind === 'reject' || ctx.tools.get('singularity_read', agent) === undefined) return decision
    signal.throwIfAborted()
    const route = routes.get(agent)
    if (route === undefined) refuse('malformed-declaration', 'native admission requires the assembled model route')
    if (!(await ctx.sessions.flush(agent.session))) refuse('write-not-durable', 'native root session has no durability listener')
    const assignment = await driver.enter(agent, decision.messages, route)
    if (driver.failed(String(agent.id))) return { kind: 'reject' }
    const search = driver.rsiState(String(agent.id))
    if (search !== undefined && search.phase !== 'ready') return { kind: 'reject' }
    return assignment === undefined ? decision : { ...decision, messages: [...decision.messages, assignment] }
  })
  mountCampaignMemory(ctx)
  ctx.effect(() => () => driver.close())
}

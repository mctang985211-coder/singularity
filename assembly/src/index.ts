import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { loadDomain } from './domain.ts'
import { openDriver } from './driver.ts'
import { createExecution } from './execution.ts'
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
  budget: z.object({ rootSolves: z.number().required(), children: z.number().required(), childRuns: z.number().required(), nativeTokens: z.number().required() }),
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
    approvalSeams: { approval: ctx.get('approval') as import('../../src/runtime/approval.ts').ApprovalSeams['approval'], feed: ctx },
    execution: (admission, onTurnFailure) => createExecution(ctx, admission, onTurnFailure),
  })
  ctx.provide('singularity', {
    forCall: (exec: ToolRunContext) => driver.forCall(exec),
    read: () => driver.read(),
    skill: (agentId: string) => driver.skill(agentId),
    observe: (sessionId: string, event: import('@deepseek-ai/dsh-session').SessionEvent) => driver.observe(sessionId, event),
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const prompt = await next()
    if (context.agent !== undefined) {
      const skill = await driver.skill(String(context.agent.id))
      if (skill !== undefined) prompt.sections.push({ name: 'singularity:method', text: skill, interpolate: false })
    }
    return prompt
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'system/message') void driver.observe(String(session.id), event).catch(error => ctx.logger.error(error))
  })
  ctx.on('agent/created', async ({ agent }) => { await driver.activate(String(agent.session.id)); return undefined })
  if (driver.budget !== undefined) {
    const budget = driver.budget
    const stop = () => {
      for (const session of ctx.sessions.list())
        if (budget.owns(String(session.id))) ctx.agents.get(session.id)?.cancel({ kind: 'parent' }, { keepInbox: true })
    }
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      const request = await next()
      if (ctx.tools.get('singularity_propose_task', agent) === undefined) return request
      if (!await ctx.sessions.flush(agent.session)) refuse('write-not-durable', 'campaign session has no native durability listener')
      await budget.enroll(String(agent.session.id))
      const resolved = await (ctx.get('llm') as LlmRuntime).resolveCallConfig(request, signal)
      return { ...resolved, maxTokens: budget.beforeRequest(resolved.maxTokens) }
    })
    ctx.on('llm/stream', async function* (options, next) {
      if (options.sessionId === undefined || !budget.owns(String(options.sessionId))) return yield* next()
      return yield* budget.stream(options, next, stop)
    })
    ctx.on('session/event', (session, event) => {
      if (budget.owns(String(session.id))) budget.observe(String(session.id), event)
    })
    ctx.on('agent/request-error', ({ agent }, next) => budget.owns(String(agent.session.id)) ? Promise.resolve(undefined) : next())
  }
  ctx.effect(() => () => driver.close())
}

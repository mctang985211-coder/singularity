/** Capability grants: turn what a capability declared into tools, skills and MCP servers a worker can load.
 * @module @dangosys/dsh-singularity-agent-runtime/grants */

import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Context, EventOptions } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { messageOf } from './messages.ts'
import type { WorkerGrant } from './types.ts'
import { isNativeDelegationTool, TASK_DELEGATION_DENIAL } from './delegation-guard.ts'
import {
  findSkillFile,
  listSkillFiles,
  readSkillFile,
  skillRootsFor,
  toRuntimeSkill,
  type RuntimeSkill,
} from './skill-file.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'task-skills': { readonly kind: 'task-skills'; readonly form: 'instructions'; readonly names: readonly string[] }
  }
}

/** Deliver the Run's explicitly bound methods before its first model action. */
function installBoundSkillInstructions(local: Context, definitions: readonly RuntimeSkill[]): void {
  const methods = definitions.filter(skill => skill.invocation?.modelInvocable !== false)
  if (methods.length === 0) return
  local.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.some(message => message.source.kind === 'task-skills')) return decision
    // pre-step messages are newly claimed input, not the model's complete
    // history. Inspect the native visible surface so resume retains the body
    // and compaction can restore it when its original node leaves the surface.
    const visible = agent.session.surface.nodes.some(seq => {
      const event = agent.session.eventAt(seq)
      return event?.type === 'user/message' && event.data.source.kind === 'task-skills'
        && event.data.source.names.length === methods.length
        && methods.every(skill => event.data.source.kind === 'task-skills' && event.data.source.names.includes(skill.name))
    })
    if (visible) return decision
    signal.throwIfAborted()
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'task-skills', form: 'instructions', names: methods.map(skill => skill.name) },
      content: [{ type: 'text', text: methods.map(skill => renderSkillContent({ ...skill, provider: 'runtime' })).join('\n\n') }],
    })] }
  })
}

/** Structural view of the skill service (`ctx.skills`), read softly so this package needs no dependency on it. */
interface SkillRegistryLike {
  get(name: string, options?: { scope?: unknown; cwd?: string }): Promise<RuntimeSkill | undefined>
  register(skill: RuntimeSkill): () => void
}

function skillRegistry(agentCtx: Context): SkillRegistryLike | undefined {
  return agentCtx.get('skills') as SkillRegistryLike | undefined
}

/** Names one tools view offers, minus the reserved PTC transport the filter may never name. */
function visibleToolNames(agentCtx: Context, scope?: Agent): Set<string> {
  return new Set(
    agentCtx.tools
      .schemas(scope)
      .map(schema => schema.name)
      .filter(name => name !== RUN_CODE_NAME),
  )
}

/** Refuse a grant whose capability-declared tools the worker's composition does not offer. */
function assertCapabilityTools(grant: WorkerGrant, visible: ReadonlySet<string>): void {
  const missing = grant.capabilities
    .map(capability => ({
      capability: capability.capability,
      tools: capability.tools.filter(tool => !visible.has(tool)),
    }))
    .filter(entry => entry.tools.length > 0)
  if (missing.length === 0) return
  const known = [...visible].sort().join(', ') || '(none)'
  const detail = missing
    .map(
      entry =>
        `"${entry.capability}" grants unavailable tool${entry.tools.length > 1 ? 's' : ''} ${entry.tools.map(tool => `"${tool}"`).join(', ')}`,
    )
    .join('; ')
  throw new Error(
    `agent-runtime: capabilit${missing.length > 1 ? 'ies' : 'y'} ${detail}; this worker's visible tools: ${known}`,
  )
}

/** The tool surface one worker's grant resolves to, plus what its composition could not offer. */
export interface ResolvedGrant {
  /** Sorted allow-list handed to `tools.restrict`: capability plane ∪ baseline plane ∪ preset plane. */
  readonly allow: readonly string[]
  /** Baseline names this composition does not offer; never fatal, the composition mounted nothing to take away. */
  readonly baselineUnavailable: readonly string[]
}

/** Compute the allow-list one grant resolves to; throws when a capability tool is not visible. */
export function resolveGrant(agentCtx: Context, agent: Agent, grant: WorkerGrant): ResolvedGrant {
  const visible = visibleToolNames(agentCtx, agent)
  for (const capability of grant.capabilities) {
    const bypasses = capability.tools.filter(isNativeDelegationTool)
    if (bypasses.length > 0)
      throw new Error(`agent-runtime: capability "${capability.capability}" declares native delegation tools [${bypasses.join(', ')}]; ${TASK_DELEGATION_DENIAL}`)
  }
  assertCapabilityTools(grant, visible)
  const allow = new Set<string>()
  for (const capability of grant.capabilities) for (const tool of capability.tools) allow.add(tool)
  for (const tool of grant.baseline) if (visible.has(tool) && !isNativeDelegationTool(tool)) allow.add(tool)
  // A preset's own plane is what the composition contributes beyond the global layer; keeping it is how a
  // capability that named its preset keeps that preset's own tools, which no label could enumerate.
  if (grant.keepPresetTools) {
    const global = visibleToolNames(agentCtx)
    for (const tool of visible) if (!global.has(tool) && !isNativeDelegationTool(tool)) allow.add(tool)
  }
  return {
    allow: [...allow].sort(),
    baselineUnavailable: [...new Set(grant.baseline.filter(tool => !visible.has(tool)))].sort(),
  }
}

/** The graph's live methods; execution workers instead receive their Run's frozen grant. */
export interface GraphSkillCatalogOptions {
  readonly skillRoots: readonly string[]
  readonly readLibrary?: () => Promise<{ skills: readonly { name: string; status: string }[] }>
}

/** A separate registry prevents host providers from merging into the agent's catalog. */
async function isolatedSkills(agentCtx: Context): Promise<Context> {
  const local = agentCtx.isolate('skills')
  await local.plugin(SkillRegistry, {})
  return local
}

/** Keep native catalog middleware outside the host's same-name catalog cleanup. */
const ScopedSkillTool = {
  name: 'singularity-scoped-skill',
  inject: ToolSkill.inject,
  apply(ctx: Context) {
    const native = ctx.extend({
      on(name: string, listener: (...args: any[]) => any, options?: boolean | EventOptions) {
        return ctx.on(name as keyof import('@deepseek-ai/cordis').Events, listener, {
          ...(typeof options === 'boolean' ? { prepend: options } : options),
          ...(name === 'agent/pre-step' ? { prepend: true } : {}),
        })
      },
    })
    ToolSkill.apply(native)
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const allowed = new Set((await ctx.skills.list({ scope: agent, cwd: agent.session.header.cwd, signal }))
        .filter(skill => skill.invocation.userInvocable).map(skill => skill.name))
      const seen = new Set<string>()
      const messages = decision.messages.slice().reverse().filter(message => {
        if (message.source.kind !== 'skill-invocation') return true
        const name = message.source.name
        if (!allowed.has(name) || seen.has(name)) return false
        seen.add(name)
        return true
      }).reverse()
      return { ...decision, messages }
    }, { prepend: true })
  },
}

/** Use the native loader/catalog with only this graph's active method roots. */
export async function installGraphSkillCatalog(
  agentCtx: Context,
  options: GraphSkillCatalogOptions,
  exposeTool = true,
): Promise<Context> {
  const local = await isolatedSkills(agentCtx)
  let invalidate!: () => void
  let files!: FileSystemSkillProvider
  const skills = local.get('skills') as SkillRegistry
  skills.registerProvider(control => {
    invalidate = control.invalidate
    files = new FileSystemSkillProvider(local, control, {
      providerName: 'singularity-graph', includeDefaultRoots: false,
      customSkillDirs: [...options.skillRoots], watch: false,
    })
    return {
      name: files.name,
      async list(lookup) {
        const observation = await files.list(lookup)
        const candidates = Array.isArray(observation) ? observation : observation.candidates
        const latest = options.readLibrary === undefined ? undefined
          : new Map((await options.readLibrary()).skills.map(row => [row.name, row.status]))
        const visible = candidates.filter(candidate => latest === undefined || latest.get(candidate.name) !== 'retired')
        return Array.isArray(observation) ? visible : { ...observation, candidates: visible }
      },
      get: (candidate, lookup) => files.get(candidate, lookup),
    }
  })
  // Library reviews change the index without changing SKILL.md. Refresh at the
  // native catalog boundary so writes and retirement are visible next step.
  local.on('agent/pre-step', (_event, next) => { invalidate(); return next() })
  if (exposeTool) await local.plugin(ScopedSkillTool)
  return local
}

/** Resolve only explicitly granted names before detaching the host registry. */
async function frozenGrantSkills(agentCtx: Context, agent: Agent, grant: WorkerGrant): Promise<RuntimeSkill[]> {
  const granted = new Map<string, string>()
  for (const capability of grant.capabilities)
    for (const name of capability.skills) if (!granted.has(name)) granted.set(name, capability.capability)
  const roots = grant.skillRoots ?? []
  const host = skillRegistry(agentCtx)
  if (host === undefined && (granted.size > 0 || roots.length > 0)) {
    const requested = roots.length > 0 ? `skill overlay roots [${roots.join(', ')}] were requested`
      : `capabilities [${[...new Set(granted.values())].join(', ')}] grant skills [${[...granted.keys()].join(', ')}]`
    throw new Error(`agent-runtime: ${requested} but the deployment provides no skill registry (ctx.skills)`)
  }
  const definitions = new Map<string, RuntimeSkill>()
  for (const root of roots) {
    let files: { name: string; file: string }[]
    try { files = await listSkillFiles(root) } catch (error) {
      throw new Error(`agent-runtime: skill overlay root "${root}" is not readable: ${messageOf(error)}`)
    }
    for (const { name, file } of files)
      if (granted.has(name) && !definitions.has(name)) definitions.set(name, await readSkillFile(file, name))
  }
  const cwd = agent.session.header.cwd
  for (const [name, capability] of granted) {
    if (definitions.has(name)) continue
    const discovered = await host!.get(name, { scope: agent, cwd })
    if (discovered !== undefined) { definitions.set(name, toRuntimeSkill(discovered)); continue }
    const file = await findSkillFile(name, cwd)
    if (file === undefined)
      throw new Error(`agent-runtime: capability "${capability}" grants skill "${name}" but no SKILL.md for it is reachable; searched ${(await skillRootsFor(cwd)).join(', ')}`)
    definitions.set(name, await readSkillFile(file, name))
  }
  return [...definitions.values()]
}

/** Mount every MCP server one grant declares, one mcp-client instance per spec, fail-closed on startup. */
async function mountMcpServers(agentCtx: Context, agent: Agent, grant: WorkerGrant): Promise<void> {
  for (const spec of grant.mcpServers ?? []) {
    try {
      await agentCtx.plugin(McpClient, {
        transport: 'stdio',
        serverName: spec.serverName,
        command: spec.command,
        args: [...spec.args],
        env: { ...spec.env },
        cwd: spec.cwd,
        ...(spec.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: spec.toolCallTimeoutMs }),
        failOnStartupError: true,
      })
    } catch (error) {
      throw new Error(
        `agent-runtime: MCP server "${spec.serverName}" (command: ${spec.command}) failed to start for agent "${agent.id}": ${messageOf(error)}`,
      )
    }
  }
}

/** Apply one worker's grant: restrict tools, register skills, mount MCP servers — all fail-closed. */
export async function applyWorkerGrant(
  agentCtx: Context,
  agent: Agent,
  grant: WorkerGrant,
  graphCatalog?: GraphSkillCatalogOptions,
): Promise<void> {
  const { allow } = resolveGrant(agentCtx, agent, grant)
  // An empty allow-list is the honest outcome of a composition that offers none of the declared tools.
  try {
    agentCtx.tools.restrict({ allow })
  } catch (error) {
    const capabilities = grant.capabilities.map(capability => capability.capability)
    throw new Error(
      `agent-runtime: could not restrict agent "${agent.id}" to [${allow.join(', ')}] for capabilit${capabilities.length === 1 ? 'y' : 'ies'} [${capabilities.join(', ')}]: ${messageOf(error)}`,
    )
  }
  if (graphCatalog !== undefined) await installGraphSkillCatalog(agentCtx, graphCatalog, allow.includes('skill'))
  else {
    const definitions = await frozenGrantSkills(agentCtx, agent, grant)
    const local = await isolatedSkills(agentCtx)
    const skills = local.get('skills') as SkillRegistry
    for (const definition of definitions) skills.register(definition)
    if (allow.includes('skill')) await local.plugin(ScopedSkillTool)
    installBoundSkillInstructions(local, definitions)
  }
  await mountMcpServers(agentCtx, agent, grant)
}

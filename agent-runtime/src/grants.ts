/** Capability grants: turn what a capability declared into tools, skills and MCP servers a worker can load.
 * @module @dangosys/dsh-singularity-agent-runtime/grants */

import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { messageOf } from './messages.ts'
import type { WorkerGrant } from './types.ts'
import {
  findSkillFile,
  listSkillFiles,
  readSkillFile,
  skillRootsFor,
  toRuntimeSkill,
  type RuntimeSkill,
} from './skill-file.ts'

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
  assertCapabilityTools(grant, visible)
  const allow = new Set<string>()
  for (const capability of grant.capabilities) for (const tool of capability.tools) allow.add(tool)
  for (const tool of grant.baseline) if (visible.has(tool)) allow.add(tool)
  // A preset's own plane is what the composition contributes beyond the global layer; keeping it is how a
  // capability that named its preset keeps that preset's own tools, which no label could enumerate.
  if (grant.keepPresetTools) {
    const global = visibleToolNames(agentCtx)
    for (const tool of visible) if (!global.has(tool)) allow.add(tool)
  }
  return {
    allow: [...allow].sort(),
    baselineUnavailable: [...new Set(grant.baseline.filter(tool => !visible.has(tool)))].sort(),
  }
}

/** Register every skill one grant's extra roots carry into the worker's own layer (the replay overlay), first. */
async function applySkillRoots(agentCtx: Context, grant: WorkerGrant): Promise<Set<string>> {
  const roots = grant.skillRoots ?? []
  const overlaid = new Set<string>()
  if (roots.length === 0) return overlaid
  const skills = skillRegistry(agentCtx)
  if (skills === undefined) {
    throw new Error(
      `agent-runtime: skill overlay roots [${roots.join(', ')}] were requested but the deployment provides no skill registry (ctx.skills)`,
    )
  }
  for (const root of roots) {
    let files: { name: string; file: string }[]
    try {
      files = await listSkillFiles(root)
    } catch (error) {
      throw new Error(`agent-runtime: skill overlay root "${root}" is not readable: ${messageOf(error)}`)
    }
    for (const { name, file } of files) {
      if (overlaid.has(name)) continue
      skills.register(await readSkillFile(file, name))
      overlaid.add(name)
    }
  }
  return overlaid
}

/** Grant one worker's capability skills; overlay-registered names are skipped so the overlay body wins. */
async function grantSkills(
  agentCtx: Context,
  agent: Agent,
  grant: WorkerGrant,
  overlaid: ReadonlySet<string>,
): Promise<void> {
  const granted = new Map<string, string>()
  for (const capability of grant.capabilities) {
    for (const skill of capability.skills)
      if (!granted.has(skill) && !overlaid.has(skill)) granted.set(skill, capability.capability)
  }
  if (granted.size === 0) return
  const skills = skillRegistry(agentCtx)
  if (skills === undefined) {
    throw new Error(
      `agent-runtime: capabilities [${[...new Set(granted.values())].join(', ')}] grant skills [${[...granted.keys()].join(', ')}] but the deployment provides no skill registry (ctx.skills)`,
    )
  }
  const cwd = agent.session.header.cwd
  for (const [name, capability] of granted) {
    const discovered = await skills.get(name, { scope: agent, cwd })
    if (discovered !== undefined) {
      skills.register(toRuntimeSkill(discovered))
      continue
    }
    const file = await findSkillFile(name, cwd)
    if (file === undefined) {
      const roots = await skillRootsFor(cwd)
      throw new Error(
        `agent-runtime: capability "${capability}" grants skill "${name}" but no SKILL.md for it is reachable; searched ${roots.join(', ')}`,
      )
    }
    skills.register(await readSkillFile(file, name))
  }
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
export async function applyWorkerGrant(agentCtx: Context, agent: Agent, grant: WorkerGrant): Promise<void> {
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
  await grantSkills(agentCtx, agent, grant, await applySkillRoots(agentCtx, grant))
  await mountMcpServers(agentCtx, agent, grant)
}

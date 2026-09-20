/**
 * Capability grants: turn what a capability declared into what the worker can
 * actually see and load.
 *
 * Three axes, all fail-closed:
 * - Tools — one `tools.restrict({ allow })` on the worker's own scoped context,
 *   computed as capability plane ∪ baseline plane, plus the mounted preset's
 *   plane when the capability named its own preset. Restriction filters the
 *   INHERITED surface (the global layer and every ancestor layer, which is
 *   where presets register), never the worker's own layer.
 * - Skills — every granted skill is registered into the worker's own skill
 *   layer, so the grant holds even where discovery is not mounted.
 * - MCP servers — every granted server is mounted as one mcp-client instance
 *   on the worker's own scope (`mcp__<serverName>__<tool>`), after the
 *   restriction is computed: own-layer registrations are outside what
 *   `restrict` filters, and keeping them out of the allow-list computation is
 *   what stops `keepPresetTools` from feeding unrestrictable names to it.
 *
 * All run inside the agent factory's `setup` callback, which is the only place
 * an unpublished agent's scoped world can be composed: after
 * `agentPresets.mount` (so the preset's tools are already inherited and
 * therefore restrictable) and before `session/created`, `agent/created`, and
 * the first prompt assembly.
 *
 * Honest boundary on skills: DSH has no per-agent skill hiding. The global
 * filesystem provider keeps every SKILL.md it can discover visible to every
 * agent, and `tool-skill` injects the whole catalog whenever the `skill` tool is
 * visible to that agent. So a skill grant guarantees PRESENCE with the exact
 * body; it cannot make a worker's catalog contain only the granted skills. The
 * one real off switch is dropping `skill` from the surface entirely, which would
 * also make the granted skills unloadable.
 * @module @dangosys/dsh-singularity-agent-runtime/grants
 */

import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { WorkerGrant } from './types.ts'
import { findSkillFile, listSkillFiles, readSkillFile, skillRootsFor, type RuntimeSkill } from './skill-file.ts'

/** Structural view of the skill service (`ctx.skills`), read softly so this package needs no dependency on it. */
interface SkillRegistryLike {
  get(name: string, options?: { scope?: unknown; cwd?: string }): Promise<RuntimeSkill | undefined>
  register(skill: RuntimeSkill): () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    .map(capability => ({ capability: capability.capability, tools: capability.tools.filter(tool => !visible.has(tool)) }))
    .filter(entry => entry.tools.length > 0)
  if (missing.length === 0) return
  const known = [...visible].sort().join(', ') || '(none)'
  const detail = missing
    .map(entry => `"${entry.capability}" grants unavailable tool${entry.tools.length > 1 ? 's' : ''} ${entry.tools.map(tool => `"${tool}"`).join(', ')}`)
    .join('; ')
  throw new Error(`agent-runtime: capabilit${missing.length > 1 ? 'ies' : 'y'} ${detail}; this worker's visible tools: ${known}`)
}

/** The tool surface one worker's grant resolves to, plus what its composition could not offer. */
export interface ResolvedGrant {
  /** Sorted allow-list handed to `tools.restrict`: capability plane ∪ baseline plane ∪ preset plane. */
  readonly allow: readonly string[]
  /**
   * Baseline names this composition does not offer. Never fatal — the
   * composition never mounted them, so the filter has nothing to take away, and
   * demanding them would make composition-specific capabilities (the `bb-verify`
   * node, which mounts no shell) unspawnable.
   */
  readonly baselineUnavailable: readonly string[]
}

/**
 * Compute the allow-list one worker's grant resolves to against the surface its
 * composition offers.
 * @param agentCtx - the unpublished worker's scoped context (the only context `restrict()` accepts).
 * @param agent - the worker the scoped context belongs to.
 * @param grant - the resolved capability grant.
 * @throws when a capability-declared tool is not visible to this worker.
 */
export function resolveGrant(agentCtx: Context, agent: Agent, grant: WorkerGrant): ResolvedGrant {
  const visible = visibleToolNames(agentCtx, agent)
  assertCapabilityTools(grant, visible)
  const allow = new Set<string>()
  for (const capability of grant.capabilities) for (const tool of capability.tools) allow.add(tool)
  for (const tool of grant.baseline) if (visible.has(tool)) allow.add(tool)
  // A preset's own plane is what the composition contributes beyond the global
  // layer; keeping it is how a capability that named its preset keeps that
  // preset's own tools, which no label could enumerate.
  if (grant.keepPresetTools) {
    const global = visibleToolNames(agentCtx)
    for (const tool of visible) if (!global.has(tool)) allow.add(tool)
  }
  return {
    allow: [...allow].sort(),
    baselineUnavailable: [...new Set(grant.baseline.filter(tool => !visible.has(tool)))].sort(),
  }
}

/** One granted skill, pinned into the worker's own skill layer. */
function pinnedSkill(skill: RuntimeSkill): RuntimeSkill {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    ...(skill.invocation === undefined ? {} : { invocation: skill.invocation }),
    source: 'runtime',
    ...(skill.path === undefined ? {} : { path: skill.path }),
    ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
    content: skill.content,
  }
}

/**
 * Register every skill one grant's extra roots carry into the worker's own
 * layer (the replay overlay). Registered BEFORE the granted-skill resolution,
 * so a same-name granted skill keeps the overlay body — the registry is
 * first-wins within a layer, and skipping the name in {@link grantSkills} is
 * what keeps that rule silent instead of warn-logged. Returns the overlaid
 * names. A root that cannot be read throws: a broken overlay path must fail
 * the spawn loudly, never degrade to the production skill unnoticed.
 */
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
      throw new Error(`agent-runtime: skill overlay root "${root}" is not readable: ${message(error)}`)
    }
    for (const { name, file } of files) {
      if (overlaid.has(name)) continue
      skills.register(await readSkillFile(file, name))
      overlaid.add(name)
    }
  }
  return overlaid
}

/**
 * Grant one worker's capability skills.
 *
 * Each granted name is resolved through the deployment's own discovery first —
 * the discovered definition already carries the parsed body, invocation policy,
 * and resource base — and falls back to reading the `SKILL.md` directly when the
 * worker's composition mounts no discovery. Either way the definition is
 * registered into the WORKER's layer, which is what makes the grant hold and
 * what shadows a same-name skill for that worker alone. Names an overlay root
 * already registered are skipped: the overlay body wins.
 */
async function grantSkills(agentCtx: Context, agent: Agent, grant: WorkerGrant, overlaid: ReadonlySet<string>): Promise<void> {
  const granted = new Map<string, string>()
  for (const capability of grant.capabilities) {
    for (const skill of capability.skills) if (!granted.has(skill) && !overlaid.has(skill)) granted.set(skill, capability.capability)
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
      skills.register(pinnedSkill(discovered))
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

/**
 * Mount every MCP server one grant declares, one mcp-client instance per spec
 * on the worker's own scope. Awaiting `ctx.plugin` settles when the instance's
 * initial connect + tool sync finishes; with `failOnStartupError: true` a
 * server that cannot start rejects the mount — and with it the spawn — naming
 * the server, so a dead MCP path can never degrade into a quietly tool-less
 * worker. Disposal rides the worker's own fiber: the instance (and its child
 * process) dies with the agent.
 */
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
        `agent-runtime: MCP server "${spec.serverName}" (command: ${spec.command}) failed to start for agent "${agent.id}": ${message(error)}`,
      )
    }
  }
}

/**
 * Apply one worker's capability grant to its unpublished scoped world.
 * @param agentCtx - the worker's scoped context, minted by the agent factory.
 * @param agent - the worker, identified for error messages.
 * @param grant - the resolved grant from the task runtime.
 * @throws when a capability-declared tool is not visible to the worker, a
 *   declared skill resolves nowhere, an MCP server fails to start, or the
 *   tools registry rejects the filter.
 */
export async function applyWorkerGrant(agentCtx: Context, agent: Agent, grant: WorkerGrant): Promise<void> {
  const { allow } = resolveGrant(agentCtx, agent, grant)
  // An empty allow-list is the honest outcome of a composition that offers none
  // of the declared or baseline tools: fail-closed means the worker gets none.
  try {
    agentCtx.tools.restrict({ allow })
  } catch (error) {
    const capabilities = grant.capabilities.map(capability => capability.capability)
    throw new Error(
      `agent-runtime: could not restrict agent "${agent.id}" to [${allow.join(', ')}] for capabilit${capabilities.length === 1 ? 'y' : 'ies'} [${capabilities.join(', ')}]: ${message(error)}`,
    )
  }
  await grantSkills(agentCtx, agent, grant, await applySkillRoots(agentCtx, grant))
  await mountMcpServers(agentCtx, agent, grant)
}

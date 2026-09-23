import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import * as SkillFilesystem from '../../../../thirdparty/deepseek-harness/packages/skill/skill-filesystem/lib/index.js'
import { createScope, type Scope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import type { Agent, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { WorkerGrant } from '../../agent-runtime/src/types.ts'
import { workerBaseline } from '../../task-runtime/src/capability.ts'

/**
 * The real thing on the tools and skills axes: the deployment's own
 * `ToolRuntime`, `SkillRegistry`, and scope planes (a preset plane is an
 * ancestor scope the agent joins by scope parentage, exactly as a standing
 * preset mount does), driven through `AgentRuntime.spawn` and the real agent
 * factory contract — `setup` runs after the scoped context is minted and before
 * the agent is published, so what is asserted here is what the worker's first
 * prompt would be assembled against. Only `dsh-agent-loop` (the model loop) is
 * replaced: the stub factory mints the scope and awaits `setup`, which is what
 * the loop itself does.
 */

/** Exactly the root agent's allow-list (`agent-runtime/src/index.ts`), so the root setup path is exercised for real. */
const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'skill', 'task_decompose',
  'task_submit_result', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

/** The global-plane machinery every agent inherits: our own tools sit here, as they do in the deployment. `skill` rides the preset plane (PRESET_TOOLS), as `tool-skill` mounts it there. */
const GLOBAL_TOOLS = [...ROOT_TOOLS.filter(name => name !== 'skill'), 'session_search', 'session_event_read', 'session_trace']

/** What the `standard`-style preset contributes on its own plane. */
const PRESET_TOOLS = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'skill', 'job_output', 'job_list', 'job_kill', 'ask_user_question', 'web_fetch', 'subagent_fetchless']

/** The `bb-verify` node's plane: no shell, its own composition-specific tools. */
const VERIFY_PRESET_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'verify_console', 'verify_status']

const ROOT_SESSION = 's-root' as SessionId

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: async () => name,
  }
}

let cwd: string
let previousHome: string | undefined
const contexts: Context[] = []

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'worker-grant-int-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(cwd, 'dsh-home')
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  rmSync(cwd, { recursive: true, force: true })
})

interface Harness {
  ctx: Context
  root: Agent
  visible(agent: Agent): string[]
  reachable(sessionId: SessionId): Agent | undefined
  spawn(grant: WorkerGrant | undefined, presetTools?: readonly string[]): Promise<Agent>
  spawnError(grant: WorkerGrant, presetTools?: readonly string[]): Promise<Error>
}

/** Boot the registry stack, mount one preset plane, and create the root agent through it. `discovery` additionally mounts the real filesystem skill provider, rooted at this test's cwd. */
async function harness(presetTools: readonly string[] = PRESET_TOOLS, discovery = false): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry, {})
  if (discovery) {
    await ctx.plugin(SkillFilesystem, {
      dshHome: join(cwd, 'dsh-home'),
      agentsHome: join(cwd, 'agents-home'),
      watch: false,
    })
  }

  for (const name of GLOBAL_TOOLS) ctx.tools.register(tool(name))
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: vi.fn() })
  ctx.provide('sessions', {})
  ctx.provide('sessionPersistence', { list: async () => [{ header: { id: ROOT_SESSION, agentPreset: 'standard' } }] })
  ctx.provide('layout', { setIn: async () => {} })
  const graphAgents = [{ id: ROOT_SESSION, name: 'Singularity', status: 'idle' as const }]
  ctx.provide('graph', {
    snapshotIn: async () => ({ version: 1, id: 'g', roots: [ROOT_SESSION], agents: [...graphAgents], groups: [], edges: [] }),
    commitIn: async (_store: string, events: { kind: string; agent: (typeof graphAgents)[number] }[]) => {
      for (const event of events) if (event.kind === 'agent/add') graphAgents.push(event.agent)
    },
    setStatusIn: async () => {},
    addAgentIn: async (_store: string, agent: (typeof graphAgents)[number]) => {
      graphAgents.push(agent)
    },
  })

  // A preset's standing mount lives in its own scope; an agent joins it by scope parentage.
  const presetKey = { id: 'preset:standard' }
  let presetScope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { presetScope = createScope(inner, presetKey) }, { inject: ['tools', 'systemPrompt'] }))
  for (const name of presetTools) presetScope.ctx.tools.register(tool(name))
  // The root always rides a standard-style plane — its allow-list names the
  // skill loader, which only this plane offers — even when the worker
  // composition under test (the bb-verify node) does not.
  const rootPresetKey = { id: 'preset:root-standard' }
  await ctx.plugin(Object.assign((inner: Context) => {
    const rootPresetScope = createScope(inner, rootPresetKey)
    for (const name of PRESET_TOOLS) rootPresetScope.ctx.tools.register(tool(name))
  }, { inject: ['tools', 'systemPrompt'] }))

  const runtime = new AgentRuntime(ctx)
  const live = new Map<string, Agent>()
  const scopes: Scope[] = []
  const mint = async (
    sessionId: SessionId,
    setup: ((agentCtx: Context, agent: Agent) => Promise<unknown>) | undefined,
    parent: Agent | undefined,
  ): Promise<Agent> => {
    const agent = {
      id: sessionId,
      followup: vi.fn(),
      cancel: vi.fn(),
      append: vi.fn(),
      session: { id: sessionId, header: { id: sessionId, cwd, agentPreset: 'standard' }, append: vi.fn() },
    } as unknown as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent, { parent: sessionId === ROOT_SESSION ? rootPresetKey : presetKey })
    }, { inject: ['tools', 'systemPrompt'] }))
    scopes.push(scope)
    Object.assign(agent as object, { ctx: scope.ctx, ...(parent === undefined ? {} : { parent }) })
    await setup?.(scope.ctx, agent)
    // Publication is the factory's job (the loop's own factory registers and announces).
    await (ctx.agents.register(agent) as unknown as Promise<void>)
    live.set(sessionId, agent)
    return agent
  }
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, options: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.sessionId, options.setup, undefined), dispose: async () => { live.delete(options.sessionId) } }),
    resume: async (_ownerCtx: Context, options: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.resumeSessionId, options.setup, undefined), dispose: async () => { live.delete(options.resumeSessionId) } }),
  } as never)
  const agents = ctx.agents as unknown as { get(id: SessionId): Agent | undefined }
  await runtime.ensureRoot(ROOT_SESSION, { graphStoreId: 'g', layoutStoreId: 'l' })
  const root = agents.get(ROOT_SESSION)!

  const spawn = async (grant: WorkerGrant | undefined) => {
    const sessionId = `s-child-${live.size}` as SessionId
    const handle = await runtime.spawn(root, {
      sessionId,
      name: 'worker',
      prompt: [{ type: 'text', text: 'do the work' }],
      ...(grant === undefined ? {} : { grant }),
    })
    return { agent: handle.agent, sessionId }
  }

  return {
    ctx,
    root,
    visible: agent => ctx.tools.schemas(agent).map(schema => schema.name).sort(),
    reachable: sessionId => agents.get(sessionId),
    async spawn(grant) {
      const { agent } = await spawn(grant)
      return agent
    },
    async spawnError(grant) {
      try {
        await spawn(grant)
      } catch (error) {
        return error as Error
      }
      throw new Error('spawn unexpectedly succeeded')
    },
  }
}

/** The real baseline the orchestrator forwards (`orchestrate.ts` sends `workerBaseline()`), so this fixture cannot drift from it. */
function grantOf(overrides: Partial<WorkerGrant> = {}): WorkerGrant {
  return {
    capabilities: [],
    baseline: workerBaseline(),
    keepPresetTools: false,
    ...overrides,
  }
}

describe('worker capability grants', () => {
  it('narrows the worker to its declared tools plus the baseline, leaving the rest of the global plane out', async () => {
    const h = await harness()
    const child = await h.spawn(grantOf({ capabilities: [{ capability: 'design-ball', tools: ['read', 'write', 'edit'], skills: [] }] }))

    const names = h.visible(child)
    for (const kept of ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'skill', 'task_decompose', 'capability_list']) {
      expect(names, kept).toContain(kept)
    }
    for (const stripped of ['evolution_decide', 'evolution_propose', 'graph_spawn', 'hitl_ask', 'task_review_pack', 'session_search', 'web_fetch']) {
      expect(names, stripped).not.toContain(stripped)
    }
    // The exact-read tools are baselined; this deployment's full-text search is not.
    expect(names).toContain('session_event_read')
  })

  it('keeps a preset plane only when the capability named its own preset', async () => {
    const h = await harness()
    const dropped = await h.spawn(grantOf({ capabilities: [{ capability: 'design-ball', tools: ['read'], skills: [] }] }))
    expect(h.visible(dropped)).not.toContain('subagent_fetchless')
    expect(h.visible(dropped)).not.toContain('web_fetch')

    const verify = await harness(VERIFY_PRESET_TOOLS)
    const kept = await verify.spawn(grantOf({
      capabilities: [{ capability: 'verify-ball-functional', tools: [], skills: [] }],
      keepPresetTools: true,
    }))
    const keptNames = verify.visible(kept)
    // The composition-specific tools no label could enumerate stay with the composition.
    expect(keptNames).toContain('verify_console')
    expect(keptNames).toContain('verify_status')
    // Baseline names this composition never mounted are simply absent.
    expect(keptNames).not.toContain('bash')
    expect(keptNames).not.toContain('skill')
    // The global plane is still fail-closed: only the baselined part survives.
    expect(keptNames).toContain('session_event_read')
    expect(keptNames).toContain('task_read')
    expect(keptNames).not.toContain('evolution_decide')
    expect(keptNames).not.toContain('task_review_pack')
  })

  it('keeps capability discovery for recursive decomposition without granting graph, HITL, or evolution tools', async () => {
    const h = await harness()
    const names = h.visible(await h.spawn(grantOf()))

    // A worker's own prompt tells it to re-read its contract and the tree, re-decompose, and self-check.
    for (const kept of ['task_read', 'task_status', 'task_decompose', 'task_submit_result', 'task_cancel', 'task_verify', 'capability_list']) {
      expect(names, kept).toContain(kept)
    }
    // Nodes grow by task_decompose through admission, never by reaching for the graph plane:
    // graph_spawn skips admission and returns the child's prose, and the platform surface
    // (HITL, review/diagnosis, evolution) stays the root's.
    for (const stripped of [
      'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve',
      'evolution_propose', 'evolution_candidate', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
      'task_review_pack', 'task_diagnose',
    ]) {
      expect(names, stripped).not.toContain(stripped)
    }
  })

  it('rejects the spawn when a capability declares a tool the composition does not offer, publishing nothing', async () => {
    const h = await harness(VERIFY_PRESET_TOOLS)
    const error = await h.spawnError(grantOf({
      capabilities: [{ capability: 'verify-ball-functional', tools: ['bash'], skills: [] }],
    }))

    expect(error.message).toContain('agent-runtime: capability "verify-ball-functional" grants unavailable tool "bash"')
    expect(error.message).toContain('this worker\'s visible tools: ')
    expect(h.reachable('s-child-0' as SessionId)).toBeUndefined()
  })

  it('registers a granted skill for that worker alone, reading its SKILL.md', async () => {
    const h = await harness()
    mkdirSync(join(cwd, '.agents', 'skills', 'ball-align'), { recursive: true })
    writeFileSync(
      join(cwd, '.agents', 'skills', 'ball-align', 'SKILL.md'),
      '---\nname: ball-align\ndescription: Align a Ball\n---\n# Ball Alignment\nthe body\n',
    )

    const child = await h.spawn(grantOf({
      capabilities: [{ capability: 'design-ball', tools: ['read', 'write'], skills: ['ball-align'] }],
    }))

    const granted = await h.ctx.skills.get('ball-align', { scope: child, cwd })
    expect(granted?.content).toContain('# Ball Alignment')
    expect(granted?.source).toBe('runtime')
    // The grant is a runtime skill in the worker's own layer: nothing else sees it.
    expect(await h.ctx.skills.get('ball-align')).toBeUndefined()
    expect((await h.ctx.skills.list({ scope: child })).map(skill => skill.name)).toEqual(['ball-align'])
  })

  it('rejects the spawn when a granted skill resolves to no SKILL.md', async () => {
    const h = await harness()
    const error = await h.spawnError(grantOf({
      capabilities: [{ capability: 'design-ball', tools: ['read'], skills: ['no-such-skill-anywhere'] }],
    }))
    expect(error.message).toContain('capability "design-ball" grants skill "no-such-skill-anywhere" but no SKILL.md for it is reachable')
  })

  it('leaves an unauthorized spawn (a graph_spawn setup worker) on its full composition surface', async () => {
    const h = await harness()
    const child = await h.spawn(undefined)
    expect(h.visible(child)).toContain('evolution_decide')
    expect(h.visible(child)).toContain('subagent_fetchless')
  })

  it('leaves the root the skill loader, and discovery reaches a repo-level .agents/skills skill', async () => {
    const h = await harness(PRESET_TOOLS, true)
    // The root's allow-list names the preset-plane loader: it stays while the
    // rest of the preset plane is filtered out.
    expect(h.visible(h.root)).toContain('skill')
    expect(h.visible(h.root)).not.toContain('bash')

    // The same lookup the `skill` tool runs: the cwd walk hits the .git marker,
    // and <projectRoot>/.agents/skills is a zero-config discovery root.
    mkdirSync(join(cwd, '.git'), { recursive: true })
    mkdirSync(join(cwd, '.agents', 'skills', 'bb-pipeline'), { recursive: true })
    writeFileSync(
      join(cwd, '.agents', 'skills', 'bb-pipeline', 'SKILL.md'),
      '---\nname: bb-pipeline\ndescription: BB pipeline map\n---\n# BB Pipeline\nthe map\n',
    )
    const skill = await h.ctx.skills.get('bb-pipeline', { cwd, scope: h.root })
    expect(skill?.content).toContain('# BB Pipeline')
  })
})

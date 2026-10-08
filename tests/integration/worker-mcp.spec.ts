import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import { createScope, type Scope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import type { Agent, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { McpServerSpec, WorkerGrant } from '../../agent-runtime/src/types.ts'
import { resolveCapabilities, workerBaseline } from '../../task-runtime/src/capability.ts'
import { authorizedGrant } from '../../task-runtime/src/orchestration/spawn.ts'

/**
 * The MCP grant axis for real: a spawned worker's grant carries a resolved
 * server spec, `applyWorkerGrant` mounts the actual `dsh-mcp-client` on the
 * worker's own scope, and the server is this spec's own minimal fixture
 * (`fixtures/echo-mcp-server.mjs`, a stdio JSON-RPC server with one echo
 * tool — no production server involved). What is asserted is what the
 * worker's first prompt assembles against: the `mcp__echo-fixture__*` surface,
 * restricted to the grant and invisible to the root. The failing-server case
 * proves the fail-loud mount: the spawn rejects before the agent is published.
 */

const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_library', 'task_read', 'capability_list', 'task_template_list', 'context_read', 'skill', 'task_intake', 'task_decompose',
  'task_submit_result', 'task_answer', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'task_budget_extend', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]
const GLOBAL_TOOLS = [...ROOT_TOOLS.filter(name => name !== 'skill'), 'session_search', 'session_event_read', 'session_event_trace', 'session_trace']
const PRESET_TOOLS = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'skill', 'job_output', 'job_list', 'job_kill', 'ask_user_question', 'web_fetch', 'subagent_fetchless']

const ROOT_SESSION = 's-root' as SessionId

/** The fixture server, run under this same Node (plain .mjs, no build step). */
const ECHO_FIXTURE = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url))

function echoSpec(cwd: string): McpServerSpec {
  return { serverName: 'echo-fixture', command: process.execPath, args: [ECHO_FIXTURE], env: {}, cwd }
}

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
  cwd = mkdtempSync(join(tmpdir(), 'worker-mcp-int-'))
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
  visible(agent: Agent): string[]
  call(agent: Agent, name: string, args: unknown): Promise<unknown>
  reachable(sessionId: SessionId): Agent | undefined
  spawn(grant: WorkerGrant): Promise<Agent>
  spawnError(grant: WorkerGrant): Promise<Error>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry, {})

  for (const name of GLOBAL_TOOLS) ctx.tools.register(tool(name))
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: vi.fn() })
  ctx.provide('sessions', {})
  // The confinement seam the stdio MCP transport resolves against: this
  // harness's world is danger-full-access, so the fixture server spawns
  // unchanged and `confine` stays uncalled.
  ctx.provide('sandbox', { confine: () => { throw new Error('this harness spawns MCP servers unconfined') } } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) } as never)
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
  for (const name of PRESET_TOOLS) presetScope.ctx.tools.register(tool(name))

  const runtime = new AgentRuntime(ctx)
  const live = new Map<string, Agent>()
  const mint = async (
    sessionId: SessionId,
    setup: ((agentCtx: Context, agent: Agent) => Promise<unknown>) | undefined,
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
      scope = createScope(inner, agent, { parent: presetKey })
    }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    // Publication is the factory's job (the loop's own factory registers and announces).
    await (ctx.agents.register(agent) as unknown as Promise<void>)
    live.set(sessionId, agent)
    return agent
  }
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, options: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.sessionId, options.setup), dispose: async () => { live.delete(options.sessionId) } }),
    resume: async (_ownerCtx: Context, options: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.resumeSessionId, options.setup), dispose: async () => { live.delete(options.resumeSessionId) } }),
  } as never)
  const agents = ctx.agents as unknown as { get(id: SessionId): Agent | undefined }
  await runtime.ensureRoot(ROOT_SESSION, { graphStoreId: 'g', layoutStoreId: 'l' })
  const root = agents.get(ROOT_SESSION)!

  const spawn = async (grant: WorkerGrant) => {
    const sessionId = `s-child-${live.size}` as SessionId
    const handle = await runtime.spawn(root, {
      sessionId,
      name: 'worker',
      prompt: [{ type: 'text', text: 'do the work' }],
      grant,
    })
    return { agent: handle.agent, sessionId }
  }

  return {
    visible: agent => ctx.tools.schemas(agent).map(schema => schema.name).sort(),
    call: (agent, name, args) => ctx.tools.get(name, agent)!.execute(args, { agent, signal: new AbortController().signal } as never),
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

/** The grant the orchestrator forwards for an MCP-bearing capability (workerBaseline() keeps the fixture honest). */
function grantOf(mcpServers: readonly McpServerSpec[]): WorkerGrant {
  return {
    capabilities: [{ capability: 'echo-test', tools: [], skills: [] }],
    baseline: workerBaseline(),
    keepPresetTools: false,
    mcpServers,
  }
}

describe('worker MCP grant (spawn-level mount)', () => {
  it('resolves a configured external capability and executes its real MCP tool on the worker', async () => {
    const h = await harness()
    const registry = { echo: { serverName: 'echo-fixture', description: 'External echo service', command: process.execPath, args: [ECHO_FIXTURE], cwd } }
    const manifest = resolveCapabilities(['echo-test'], { 'echo-test': { mcpServers: ['echo'] } }, registry)
    const grant = await authorizedGrant({ mcpRegistry: registry } as never, manifest)
    const child = await h.spawn(grant)
    expect(await h.call(child, 'mcp__echo-fixture__echo', { text: 'task capability reached external MCP' })).toEqual({
      content: [{ type: 'text', text: 'echo: task capability reached external MCP' }],
    })

    const names = h.visible(child)
    expect(names).toContain('mcp__echo-fixture__echo')
    // The grant's restriction still holds beside the MCP plane.
    expect(names).toContain('task_read')
    expect(names).not.toContain('evolution_decide')
    expect(names).not.toContain('web_fetch')
    expect(names).not.toContain('subagent_fetchless')
    // Own-layer registrations never leak into the root's inherited view.
    const root = h.reachable(ROOT_SESSION)!
    expect(h.visible(root)).not.toContain('mcp__echo-fixture__echo')
  })

  it('a server that cannot start fails the spawn loudly and publishes nothing', async () => {
    const h = await harness()
    const error = await h.spawnError(grantOf([{ serverName: 'ghost-bb', command: join(cwd, 'no-such-server'), args: [], env: {}, cwd }]))

    expect(error.message).toContain('agent-runtime: MCP server "ghost-bb"')
    expect(error.message).toContain('failed to start for agent')
    expect(h.reachable('s-child-0' as SessionId)).toBeUndefined()
  })

  it('two instances sharing one serverName collide inside the same worker and fail the spawn', async () => {
    const h = await harness()
    const error = await h.spawnError(grantOf([echoSpec(cwd), echoSpec(cwd)]))
    expect(error.message).toMatch(/serverName "echo-fixture" is already in use|failed to start/)
  })
})

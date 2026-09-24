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
import { SingularityAgent } from '../../agent-singularity/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { WorkerGrant } from '../../agent-runtime/src/types.ts'
import { workerBaseline } from '../../task-runtime/src/capability.ts'

/**
 * The real thing on the tools and skills axes: the deployment's own
 * `ToolRuntime`, `SkillRegistry`, and scope planes (a preset plane is an
 * ancestor scope the agent joins by scope parentage, exactly as a standing
 * preset mount does), the deployment's own composition — the real
 * `SingularityAgent` plugin, which is what registers the root/worker surface
 * under test, mounted with its injected siblings stubbed — and the real
 * `AgentRuntime.spawn` driven through the real agent factory contract: `setup`
 * runs after the scoped context is minted and before the agent is published, so
 * what is asserted here is what the worker's first prompt would be assembled
 * against. Only `dsh-agent-loop` (the model loop) is replaced: the stub factory
 * mints the scope and awaits `setup`, which is what the loop itself does.
 *
 * The plugin is mounted rather than a hand-copied name list, so the surface
 * under test is the deployment's registration: with the evolution chain off
 * (the shipped default) the nine `evolution_*` tools do not exist at all and no
 * grant, absence of a grant, or allow-list can conjure them.
 */

/**
 * The global-plane machinery the singularity composition does not own: the
 * deployment's own extras, which a worker inherits beside the plugin's tools.
 * The plugin's surface is registered by the plugin itself — never copied here,
 * or a fixture would keep passing after the assembly moved.
 *
 * The four raw cross-session readers are among these extras on purpose: a
 * deployment's `tool-session-query` mounts them, and the seal this composition
 * puts on them (A2, `agent-runtime/src/raw-session-guard.ts`) is an execution
 * guard — which can only be shown to hold against a surface that would otherwise
 * answer the call.
 */
const EXTRA_GLOBAL_TOOLS = ['session_search', 'session_event_read', 'session_event_trace', 'session_trace']

/** The four raw readers, as `agent-runtime` names them: no Singularity role may execute one. */
const RAW_SESSION_READS = ['session_event_read', 'session_event_trace', 'session_trace', 'session_search'] as const

/** The one denial reason every sealed call reports. */
const RAW_SESSION_SEAL = 'singularity: raw cross-session reads are sealed; use context_read'

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

/** A global-plane stand-in that records that its body ran, so a denial can be told from an answer. */
function ran(name: string, log: string[]): ToolDefinition {
  return { ...tool(name), execute: async () => { log.push(name); return `${name}: fixture answer` } }
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
  /** Every global-plane stand-in body that really ran, by name. */
  readonly executed: readonly string[]
  visible(agent: Agent): string[]
  reachable(sessionId: SessionId): Agent | undefined
  /** Dispatch one call as one agent through the real registry and gate waterfall. */
  call(agent: Agent, name: string): Promise<{ isError: boolean; text: string }>
  /** Register one more tool on an agent's own scope, standing in for a later preset/MCP mount. */
  regrant(agent: Agent, name: string): void
  spawn(grant: WorkerGrant | undefined, presetTools?: readonly string[]): Promise<Agent>
  spawnError(grant: WorkerGrant, presetTools?: readonly string[]): Promise<Error>
}

interface HarnessOptions {
  /** The worker-side preset plane under test. Defaults to the `standard`-style composition. */
  readonly presetTools?: readonly string[]
  /** Mount the real filesystem skill provider, rooted at this test's cwd. */
  readonly discovery?: boolean
  /**
   * The deployment's evolution switch (`SingularityAgent`'s `evolution`). `on`
   * by default because the grant cases are about a grant STRIPPING the chain,
   * which is only observable where the chain exists; a case about the shipped
   * default passes `off` and gets the composition nobody configured.
   */
  readonly evolution?: 'off' | 'on'
}

/**
 * Boot the registry stack, mount one preset plane, mount the real composition,
 * and create the root agent through it.
 */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const presetTools = options.presetTools ?? PRESET_TOOLS
  const discovery = options.discovery ?? false
  const ctx = new Context()
  contexts.push(ctx)
  const executed: string[] = []
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

  for (const name of EXTRA_GLOBAL_TOOLS) ctx.tools.register(ran(name))
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
  // The composition's own injected siblings. They are stubs because none of
  // them decides what this spec asserts — the tool SURFACE the plugin registers
  // is the real registration, and the grant filter runs over it.
  ctx.provide('graphs', { graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: ROOT_SESSION }) } as never)
  ctx.provide('task', {} as never)
  ctx.provide('taskRuntime', {} as never)
  // The read core the root-agent plugin injects (A2). No tool this spec drives
  // reads context — its subjects are the tool surface and the grant filter, both
  // of which are the deployment's own registration — so this sibling provides the
  // one call the plugin makes at load time (registering its reviewer binding
  // source). The read core's consumers are the `context` specs and
  // `tests/integration/context-assembly.spec.ts`.
  ctx.provide('singularityContext', { registerReviewerBindingSource: () => () => {} } as never)
  ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) } as never)
  ctx.provide('approval', { request: async () => 'allowed-once' } as never)

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
  // The deployment's composition, mounted the way the loader mounts it: the
  // plugin registers the root/worker tool surface this spec filters, and the
  // switch decides whether the nine `evolution_*` names exist to be filtered.
  await ctx.plugin(SingularityAgent, { evolution: options.evolution ?? 'on' })
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

  let callSeq = 0
  return {
    ctx,
    root,
    executed,
    visible: agent => ctx.tools.schemas(agent).map(schema => schema.name).sort(),
    reachable: sessionId => agents.get(sessionId),
    async call(agent, name) {
      callSeq += 1
      const answer = await ctx.tools.execute({
        callId: `wg-${callSeq}`,
        name,
        arguments: {},
        agent,
        signal: new AbortController().signal,
      })
      return {
        isError: answer.isError === true,
        text: (answer.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
      }
    },
    regrant(agent, name) {
      const scope = (agent as unknown as { ctx: Context }).ctx
      scope.tools.register(ran(name, executed))
    },
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
    // The four raw cross-session readers are off the surface (A2): the baseline
    // that used to carry the exact-read ones no longer names them, and the one
    // reference reader the worker has instead is `context_read`.
    for (const sealed of RAW_SESSION_READS) expect(names, sealed).not.toContain(sealed)
    expect(names).toContain('context_read')
  })

  it('keeps a preset plane only when the capability named its own preset', async () => {
    const h = await harness()
    const dropped = await h.spawn(grantOf({ capabilities: [{ capability: 'design-ball', tools: ['read'], skills: [] }] }))
    expect(h.visible(dropped)).not.toContain('subagent_fetchless')
    expect(h.visible(dropped)).not.toContain('web_fetch')

    const verify = await harness({ presetTools: VERIFY_PRESET_TOOLS })
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
    // The global plane is still fail-closed: only the baselined part survives,
    // and the raw cross-session readers are not part of it (A2).
    expect(keptNames).toContain('task_read')
    expect(keptNames).toContain('context_read')
    for (const sealed of RAW_SESSION_READS) expect(keptNames, sealed).not.toContain(sealed)
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
      ...RAW_SESSION_READS,
    ]) {
      expect(names, stripped).not.toContain(stripped)
    }
  })

  it('denies the raw cross-session readers at execution, and a later mount cannot put them back', async () => {
    // Two workers of the same composition: one granted (its surface is the
    // baseline) and one un-granted (it inherits the deployment's whole plane,
    // which mounts the four). The seal is an execution guard on each agent's own
    // scope, so the surface is not what decides — the call is, in both cases.
    const h = await harness()
    const granted = await h.spawn(grantOf({ capabilities: [{ capability: 'design-ball', tools: ['read'], skills: [] }] }))
    const ungranted = await h.spawn(undefined)
    expect(h.visible(ungranted)).toContain('session_event_read')

    for (const agent of [granted, ungranted]) {
      for (const name of RAW_SESSION_READS) {
        const denied = await h.call(agent, name)
        expect(denied.isError, name).toBe(true)
        expect(denied.text).toContain(RAW_SESSION_SEAL)
      }
    }
    // None of them reached a body: the stand-in answers its own name, so its
    // absence is the proof that the denial happened before any effect.
    expect(h.executed).toEqual([])

    // A mount that arrives *after* the spawn — a preset plane joining, an MCP
    // server registered on the agent's own scope — cannot lift it: the guard
    // sits on the agent's scope and a guard has no allow answer.
    h.regrant(granted, 'session_event_read')
    const regranted = await h.call(granted, 'session_event_read')
    expect(regranted.isError).toBe(true)
    expect(regranted.text).toContain(RAW_SESSION_SEAL)
    expect(h.executed).toEqual([])

    // What is not sealed still answers: the tool the four were replaced by, whose
    // authorization is the caller's graph domain.
    const other = await h.call(ungranted, 'task_decompose')
    expect(other.text).not.toContain(RAW_SESSION_SEAL)
  })

  it('rejects the spawn when a capability declares a tool the composition does not offer, publishing nothing', async () => {
    const h = await harness({ presetTools: VERIFY_PRESET_TOOLS })
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
    // The composition that registered the chain: an un-granted spawn inherits
    // the global plane, so what it may call is what the deployment registered —
    // and this one registered the nine.
    const h = await harness({ evolution: 'on' })
    const child = await h.spawn(undefined)
    expect(h.visible(child)).toContain('evolution_decide')
    expect(h.visible(child)).toContain('subagent_fetchless')
  })

  it('leaves an unauthorized spawn without the evolution chain on the shipped default composition', async () => {
    // No grant narrows this worker, so its surface is the composition's own:
    // read back from the assembly (the registry the plugin registered into)
    // rather than compared against a name list a fixture keeps by hand.
    const h = await harness({ evolution: 'off' })
    const child = await h.spawn(undefined)
    const names = h.visible(child)
    expect(names.filter(name => name.startsWith('evolution_'))).toEqual([])
    // Everything else the composition carries is still there: the switch gates
    // the chain, not the worker's right to inherit an un-granted surface.
    expect(names).toContain('subagent_fetchless')
    expect(names).toContain('graph_spawn')
    expect(names).toContain('escalate')
  })

  it('leaves the root the skill loader, and discovery reaches a repo-level .agents/skills skill', async () => {
    const h = await harness({ discovery: true })
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

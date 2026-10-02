import { describe, expect, test, vi } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  AgentRuntime,
  RAW_SESSION_READ_DENIAL,
  RAW_SESSION_READ_TOOLS,
  WORKER_KICKOFF_TEXT,
  WORKER_POLICY_TEXT,
} from '../../src/index.ts'

const id = (value: string) => value as SessionId

function agent(value: string): Agent {
  return { id: id(value) } as Agent
}

type Spy = ReturnType<typeof vi.fn>

/**
 * The twenty-two tools every root composition may call; the deployment's
 * evolution switch does not touch them. `context_read` is one of them (A2): the
 * root's reads name records by id, and the raw cross-session readers it replaced
 * were never on this surface — the execution seal covers them
 * (`./agent-runtime.spec.ts`, the guard cases). `task_answer` is one too (A4
 * §F.1): the root is a legal addressee for its children's questions.
 * `task_budget_extend` is the last (K4): raising the tree's own ceiling is the
 * root coordination session's call, and it is deliberately not on any worker's
 * plane.
 */
const ROOT_CORE_TOOLS = [
  'graph_spawn',
  'graph_mark_ready',
  'hitl_ask',
  'hitl_approve',
  'task_read',
  'capability_list',
  'task_template_list',
  'context_read',
  'skill',
  'task_intake',
  'task_decompose',
  'task_submit_result',
  // The root is a legal addressee (A4 §F.1), so its own allow-list carries the
  // answer half of the question protocol and not the asking half.
  'task_answer',
  'task_cancel',
  'task_proposal_read',
  'task_proposal_continue',
  'task_proposal_cancel',
  'task_status',
  'task_verify',
  'task_review_pack',
  'task_review_agent',
  'task_diagnose',
  'task_budget_extend',
]

/** The nine tools `ctx.singularityEvolution.enabled` gates: registered by the deployment, named here only when it is on. */
const EVOLUTION_TOOLS = [
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_rollback',
  'evolution_list',
]

/** The root's allow-list with the chain off — the shipped default, and every composition that mounts no exposure. */
const ROOT_TOOLS_CLOSED = [...ROOT_CORE_TOOLS, 'escalate']

/** The same list with the chain on: the deployment's previous assembly, name for name. */
const ROOT_TOOLS_OPEN = [...ROOT_CORE_TOOLS, ...EVOLUTION_TOOLS, 'escalate']

function context(
  roots: readonly SessionId[],
  status: 'idle' | 'running' = 'idle',
  services: { readonly evolution?: { readonly enabled: boolean } } = {},
) {
  const root = agent('root')
  const created: string[] = []
  const resumed: string[] = []
  const createOptions: unknown[] = []
  const resumeOptions: unknown[] = []
  const added: unknown[] = []
  const statuses: unknown[] = []
  const mounted: unknown[] = []
  const disposers: (() => unknown)[] = []
  const handle = (value: Agent): AgentHandle => ({
    agent: value,
    dispose: async () => {},
  })
  const ctx = {
    reflect: { provide: () => {} },
    provide: () => {},
    // The deployment's evolution switch, as `agent-singularity` provides it on
    // the assembly (`ctx.get('singularityEvolution')`): a context with no such
    // service — this default, and any composition that mounts no singularity
    // agent plugin — answers `undefined`, which the root assembly reads as off.
    get: (name: string) => (name === 'singularityEvolution' ? services.evolution : undefined),
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    agentPresets: {
      defaultId: 'standard',
      mount: async (...args: unknown[]) => {
        mounted.push(args)
      },
    },
    permissionPresets: { set: vi.fn() },
    agents: {
      create: async (options: { sessionId: SessionId }) => {
        created.push(options.sessionId)
        createOptions.push(options)
        return handle(root)
      },
      resume: async (options: { resumeSessionId: SessionId }) => {
        resumed.push(options.resumeSessionId)
        resumeOptions.push(options)
        return handle(root)
      },
      get: () => undefined,
      list: () => [],
    },
    graph: {
      snapshotIn: async () => ({
        version: 1 as const,
        id: 'graph',
        roots,
        agents: roots.map(agentId => ({ id: agentId, name: 'Singularity', status })),
        groups: [],
        edges: [],
      }),
      addAgentIn: async (...args: unknown[]) => {
        added.push(args)
      },
      setStatusIn: async (...args: unknown[]) => {
        statuses.push(args)
      },
    },
    layout: { setIn: async () => {} },
    sessions: {},
    sessionPersistence: {
      list: async () =>
        roots.map(sessionId => ({
          header: { id: sessionId, agentPreset: 'standard' },
        })),
    },
    on: () => {},
    effect: (execute: () => unknown) => {
      const value = execute()
      if (typeof value === 'function') disposers.push(value as () => unknown)
      return async () => {
        if (typeof value === 'function') await value()
      }
    },
  }
  return { ctx, root, created, resumed, createOptions, resumeOptions, added, statuses, mounted, disposers }
}

interface Assembly {
  /** The scoped context the agent factory hands `setup`, with the restrictions and the prompt section it wrote. */
  readonly agentCtx: { tools: { restrict: Spy; guard: Spy; presentAs: Spy }; systemPrompt: { section: Spy } }
  readonly session: { append: Spy }
  /** What `tools.restrict` was called with: the root's actual allow-list. */
  readonly restrict: Spy
  /** What `systemPrompt.section` was called with: the root's actual prompt. */
  readonly section: Spy
  /** What `tools.guard` was called with: the sealed raw-session readers' execution guard. */
  readonly guard: Spy
  readonly presentAs: Spy
}

/** Runs one root assembly's `setup` the way the agent factory does — after the preset mount, before the first prompt. */
async function assemble(options: unknown): Promise<Assembly> {
  const restrict = vi.fn()
  const section = vi.fn()
  const guard = vi.fn()
  const session = { append: vi.fn() }
  const presentAs = vi.fn()
  const agentCtx = { tools: { restrict, guard, presentAs }, systemPrompt: { section } }
  await (options as { setup: (ctx: unknown, agent: unknown) => Promise<void> }).setup(agentCtx, { session })
  return { agentCtx, session, restrict, section, guard, presentAs }
}

/** The prompt text one assembly registered, read back off the section call. */
function promptTextOf(section: Spy): string {
  return ((section.mock.calls[0]?.[0] ?? {}) as { text?: string }).text ?? ''
}

/**
 * The message source one `followup` carried, read back off the spy: the fact that
 * decides whether a session's log holds a request of the person's or the
 * deployment's own voice (A0 §1.10).
 */
function sourceOf(followup: Spy): unknown {
  return (followup.mock.calls[0]?.[0] as { source?: unknown } | undefined)?.source
}

async function spawnContext() {
  const state = context([id('root')])
  const runtime = new AgentRuntime(state.ctx as never)
  const scope = { graphStoreId: 'graph', layoutStoreId: 'layout' }
  await runtime.ensureRoot(id('root'), scope)
  Object.assign(state.root, {
    session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard' } },
  })
  const live = new Map<string, Agent>([['root', state.root]])
  const nodes = [{ id: id('root'), name: 'Root', status: 'idle' as const }]
  const dispose = vi.fn(async (sessionId: string) => {
    live.delete(sessionId)
  })
  const createCalls: { sessionId: string; options: { setup?: (ctx: unknown, agent: unknown) => Promise<void> } }[] = []
  const childSessions = new Map<string, { append: Spy }>()
  Object.assign(state.ctx.agents, {
    get: (sessionId: string) => live.get(sessionId),
    create: async (options: { sessionId: SessionId; setup?: (ctx: unknown, agent: unknown) => Promise<void> }) => {
      createCalls.push({ sessionId: options.sessionId, options })
      const session = { header: { id: options.sessionId }, append: vi.fn() }
      childSessions.set(options.sessionId, session)
      const child = { id: options.sessionId, followup: vi.fn(), session } as unknown as Agent
      live.set(options.sessionId, child)
      return { agent: child, dispose: () => dispose(options.sessionId) }
    },
  })
  Object.assign(state.ctx.graph, {
    snapshotIn: async () => ({ roots: [id('root')], agents: [...nodes], edges: [], groups: [] }),
    commitIn: async (_store: string, events: { kind: string; agent: (typeof nodes)[number] }[]) => {
      for (const event of events) if (event.kind === 'agent/add') nodes.push(event.agent)
    },
  })
  const setLayout = vi.fn(async () => {})
  Object.assign(state.ctx.layout, { setIn: setLayout })
  Object.assign(state.ctx, { parallel: async () => {} })
  const spawn = (name: string) =>
    runtime.spawn(state.root, { sessionId: id(name), name, prompt: [{ type: 'text' as const, text: 'work' }] })
  return { ...state, runtime, scope, live, dispose, spawn, setLayout, nodes, createCalls, childSessions }
}

/**
 * Invoke one recorded spawn's `setup` the way the agent factory does, with a
 * scoped-context stub recording the prompt sections and the tool guard.
 */
async function runSetup(options: { setup?: (ctx: unknown, agent: unknown) => Promise<void> }) {
  const restrict = vi.fn()
  const section = vi.fn()
  const guard = vi.fn()
  const session = { append: vi.fn() }
  await options.setup?.({ tools: { restrict, guard }, systemPrompt: { section } }, { session })
  return { restrict, section, guard, session }
}

/** The denial a registered guard returns for one tool name, or `undefined` when the call is left alone. */
function denialOf(guard: Spy, name: string): string | undefined {
  if (guard.mock.calls.length === 0) throw new Error('no guard was registered')
  for (const [fn] of guard.mock.calls) {
    const reason = (fn as (execution: { name: string }) => string | undefined)({ name })
    if (reason !== undefined) return reason
  }
  return undefined
}

describe('AgentRuntime root lifecycle', () => {
  test('places simultaneous children in distinct slots', async () => {
    const state = await spawnContext()
    await Promise.all([state.spawn('one'), state.spawn('two')])
    const positions = state.setLayout.mock.calls.map(call => JSON.stringify((call as unknown[])[2]))
    expect(new Set(positions).size).toBe(2)
  })

  test('a pending creation does not block another graph', async () => {
    const state = await spawnContext()
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    const create = state.ctx.agents.create
    state.ctx.agents.create = async options => {
      if (options.sessionId === id('child')) await gate
      return create(options)
    }
    const spawning = state.spawn('child')
    let createdOther = false
    const other = state.runtime
      .createRoot({
        sessionId: id('other-root'),
        cwd: '/other',
        scope: { graphStoreId: 'other-graph', layoutStoreId: 'other-layout' },
      })
      .then(handle => {
        createdOther = true
        return handle
      })
    try {
      await vi.waitFor(() => expect(createdOther).toBe(true))
    } finally {
      finish()
      await Promise.all([spawning, other])
    }
  })

  test('does not retain a disposed child handle after environment binding fails', async () => {
    const state = await spawnContext()
    Object.assign(state.ctx, {
      parallel: async () => {
        throw new Error('binding failed')
      },
    })
    await expect(state.spawn('child')).rejects.toThrow('binding failed')
    expect(state.dispose).toHaveBeenCalledTimes(1)
    await state.runtime.stopAgents([id('child')])
    expect(state.dispose).toHaveBeenCalledTimes(1)
    expect(state.statuses).toContainEqual(['graph', id('child'), 'failed'])
  })

  test('graph stop drains a child still being created and rejects later spawns', async () => {
    const state = await spawnContext()
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    const create = state.ctx.agents.create
    state.ctx.agents.create = async options => {
      await gate
      return create(options)
    }
    const spawning = state.spawn('child')
    let stopped = false
    const stopping = state.runtime.stopGraph(state.scope).then(() => {
      stopped = true
    })
    await expect(state.spawn('late')).rejects.toThrow('graph stopping')
    expect(stopped).toBe(false)
    finish()
    await spawning
    await stopping
    expect(state.live.has('child')).toBe(false)
    expect(state.dispose).toHaveBeenCalledExactlyOnceWith('child')
  })

  test('unload waits for an admitted spawn and releases its eventual handle', async () => {
    const state = await spawnContext()
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    const create = state.ctx.agents.create
    state.ctx.agents.create = async options => {
      await gate
      return create(options)
    }
    const spawning = state.spawn('child')
    const closing = state.disposers[0]() as Promise<void>
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    finish()
    await spawning
    await closing
    expect(state.live.has('child')).toBe(false)
    expect(state.dispose).toHaveBeenCalledExactlyOnceWith('child')
    await expect(state.spawn('late')).rejects.toThrow('closing')
  })

  test('unload waits for an admitted graph stop instead of abandoning its pending disposal', async () => {
    const state = await spawnContext()
    await state.spawn('child')
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    state.dispose.mockImplementation(async sessionId => {
      await gate
      state.live.delete(sessionId)
    })
    const stopping = state.runtime.stopGraph(state.scope)
    await vi.waitFor(() => expect(state.dispose).toHaveBeenCalledOnce())
    let closed = false
    const closing = (state.disposers[0]() as Promise<void>).then(() => {
      closed = true
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closed).toBe(false)
    finish()
    await Promise.all([stopping, closing])
    expect(state.dispose).toHaveBeenCalledOnce()
    expect(state.live.has('child')).toBe(false)
  })

  test('spawns ordinary runtime-owned sessions and awaits graph environment binding before prompting', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    Object.assign(state.root, {
      session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard' } },
    })
    const order: string[] = []
    const followup = vi.fn(() => order.push('prompt'))
    const child = { id: id('child'), followup, session: { append: vi.fn() } }
    const create = vi.fn(async (_options: { setup: (ctx: unknown, agent: unknown) => Promise<void> }) => ({
      agent: child,
      dispose: async () => {},
    }))
    Object.assign(state.ctx.agents, { get: () => state.root, create })
    Object.assign(state.ctx.graph, {
      commitIn: async () => {
        order.push('topology')
      },
    })
    Object.assign(state.ctx, {
      parallel: async (event: string, value: unknown) => {
        expect(event).toBe('agentRuntime/spawned')
        expect(value).toEqual({ parentId: id('root'), sessionId: id('child') })
        order.push('bind')
      },
    })
    await runtime.spawn(state.root, {
      sessionId: id('child'),
      name: 'worker',
      prompt: [{ type: 'text', text: 'work' }],
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: {
          cwd: '/environment',
          agentPreset: 'standard',
          parentSession: id('root'),
          isSeeded: false,
          origin: 'subagent',
          delegationDepth: 1,
        },
        setup: expect.any(Function),
      }),
    )
    const childSession = {}
    const childCtx = { tools: { guard: vi.fn() }, systemPrompt: { section: vi.fn() } }
    await create.mock.calls[0][0].setup(childCtx, { session: childSession })
    expect(state.ctx.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(childSession, 'danger-full-access')
    expect(order).toEqual(['topology', 'bind', 'prompt'])
    expect(followup).toHaveBeenCalledOnce()
    // The delegated task is this runtime's own voice — the worker's turn was
    // started by the deployment, not by a person — and it is attributed to its
    // producer: `kind: 'user'` is DSH's host-attested human input marker, and a
    // spawned session that carried it would read as a session somebody spoke to
    // (A0 §1.10).
    expect(sourceOf(followup)).toEqual({ kind: 'runtime-prompt', channel: 'spawn' })
  })

  test('attributes the prompts it writes to its own source, never to the person', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    const followup = vi.fn()
    Object.assign(state.root, {
      session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard' } },
      followup,
    })
    Object.assign(state.ctx.agents, { get: () => state.root })
    Object.assign(state.ctx.graph, {
      snapshotIn: async () => ({ agents: [{ id: id('root'), name: 'Root', status: 'idle' }] }),
    })

    await runtime.prompt(state.root, [{ type: 'text', text: 'Set up Singularity graph g1.' }])

    // The same rule from the other door: the graph's setup text is written by the
    // deployment for its own root, and the log has to say so.
    expect(followup).toHaveBeenCalledOnce()
    expect(sourceOf(followup)).toEqual({ kind: 'runtime-prompt', channel: 'prompt' })
  })

  test('spawn setup applies the capability-granted permission preset instead of the default posture', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    Object.assign(state.root, {
      session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard' } },
    })
    const child = { id: id('child'), followup: vi.fn(), session: { append: vi.fn() } }
    const create = vi.fn(async (_options: { setup: (ctx: unknown, agent: unknown) => Promise<void> }) => ({
      agent: child,
      dispose: async () => {},
    }))
    Object.assign(state.ctx.agents, { get: () => state.root, create })
    Object.assign(state.ctx.graph, { commitIn: async () => {} })
    Object.assign(state.ctx, { parallel: async () => {} })

    await runtime.spawn(state.root, {
      sessionId: id('child'),
      name: 'worker',
      prompt: [{ type: 'text', text: 'work' }],
      permissionPreset: 'workspace-write',
    })

    const childSession = {}
    await create.mock.calls[0]![0].setup(
      { tools: { guard: vi.fn() }, systemPrompt: { section: vi.fn() } },
      { session: childSession },
    )
    expect(state.ctx.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(childSession, 'workspace-write')
  })

  test('publishes the durable subagent descriptor a client addresses the child by', async () => {
    const state = await spawnContext()

    await state.spawn('worker')

    expect(state.childSessions.get('worker')?.append).toHaveBeenCalledWith('subagent/descriptor', {
      version: 3,
      mode: 'one-shot',
      provider: 'singularity-runtime',
      label: 'worker',
    })
  })

  test('stamps a spawned child with its parent lineage and one delegation level deeper', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    Object.assign(state.root, {
      session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard', delegationDepth: 2 } },
    })
    const child = { id: id('child'), followup: vi.fn(), session: { append: vi.fn() } }
    const create = vi.fn(async () => ({ agent: child, dispose: async () => {} }))
    Object.assign(state.ctx.agents, { get: () => state.root, create })
    Object.assign(state.ctx.graph, { commitIn: async () => {} })
    Object.assign(state.ctx, { parallel: async () => {} })

    await runtime.spawn(state.root, {
      sessionId: id('child'),
      name: 'worker',
      prompt: [{ type: 'text', text: 'work' }],
    })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: {
          cwd: '/environment',
          agentPreset: 'standard',
          parentSession: id('root'),
          isSeeded: false,
          origin: 'subagent',
          delegationDepth: 3,
        },
      }),
    )
  })

  test('coalesces concurrent resumes and rejects a changed scope', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    const scope = { graphStoreId: 'graph', layoutStoreId: 'layout' }
    const first = runtime.ensureRoot(id('root'), scope)
    const second = runtime.ensureRoot(id('root'), scope)
    await expect(runtime.ensureRoot(id('root'), { ...scope, graphStoreId: 'other' })).rejects.toThrow('scope mismatch')
    const handles = await Promise.all([first, second])
    expect(handles[0]).toBe(handles[1])
    expect(state.resumed).toEqual(['root'])
  })

  test('does not auto-create a root when the graph is empty', async () => {
    const state = context([])
    new AgentRuntime(state.ctx as never)
    await Promise.resolve()

    expect(state.created).toEqual([])
    expect(state.resumed).toEqual([])
    expect(state.added).toEqual([])
  })

  test('ensureRoot resumes a persisted root without creating a replacement', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })

    expect(state.created).toEqual([])
    expect(state.resumed).toEqual(['root'])
    expect(state.resumeOptions).toEqual([
      {
        resumeSessionId: id('root'),
        agentOptions: { provider: 'default-provider', model: 'default-model' },
        setup: expect.any(Function),
      },
    ])
    const { agentCtx, session, restrict, section } = await assemble(state.resumeOptions[0])
    expect(state.mounted).toEqual([[agentCtx, 'standard']])
    expect(state.ctx.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(session, 'danger-full-access')
    // hitl_approve routes through ctx.approval; the danger-full-access bundle's
    // 'never' policy would auto-reject it, so the root session is pinned to 'ask'.
    expect(session.append).toHaveBeenCalledExactlyOnceWith('approval/policy', { policy: 'ask' })
    // The composition carries no evolution exposure (this context mounts none),
    // so neither its allow-list nor its prompt names the chain: a root that
    // cannot call evolution_propose must not be told to.
    expect(restrict).toHaveBeenCalledWith({ allow: ROOT_TOOLS_CLOSED })
    const prompt = promptTextOf(section)
    expect(section).toHaveBeenCalledWith({
      name: 'singularity:root',
      order: 70,
      text: expect.stringContaining("coordinate the user's complete objective through task workers"),
    })
    expect(prompt).not.toContain('evolution')
    expect(prompt).not.toContain('stay manual')
    expect(prompt).not.toContain('Buckyball')
    // The assumption boundary rides in every root prompt: an assumption records
    // what the contract takes as given and may never settle a condition the
    // user did not confirm (R1 S3 evidence: the quarter was fixed that way).
    expect(prompt).toContain('An assumption is not an answer')
    expect(prompt).toContain('must never settle a condition you could not confirm')
    // …and the question goes to the user, not to the environment (R1 S3
    // evidence: the second attempt normalized a checkout-only source and a
    // quarter rule it never asked about, and delivered nothing).
    expect(prompt).toContain('put the question to the user before accepting the contract')
    expect(prompt).toContain('the environment cannot answer for the user')
    // …the contract is bounded by what the user supported and by what the
    // deployment's verifiers can settle (R1 S3 evidence: the third attempt kept
    // a full-summary goal the answer never supported and left two mandatory
    // criteria to a review that returned inconclusive).
    expect(prompt).toContain("Include only requirements supported by the user's words and answers")
    expect(prompt).toContain('do not make a mandatory criterion depend on a review that may never happen')
    expect(prompt).toContain(
      'Reuse an authoritative checker where it covers the result, keep only criteria for distinct requirements',
    )
    expect(prompt).toContain('use known artifact paths')
    // The budget raise (K4) rides every root prompt — `task_budget_extend` is on
    // every root's allow-list — and it states the facts the model has to act on:
    // a tree that ran out is still reviewable on the reviewer's own allowance,
    // and the ceiling moves only because a person moved it.
    expect(prompt).toContain('call task_budget_extend for a higher whole-total ceiling')
    expect(prompt).toContain("A stopped tree is still reviewable on the reviewer's own allowance")
    expect(prompt).toContain(
      'It re-opens no task, starts nothing by itself, and the runs already counted go on counting',
    )
    // A6 recovery belongs only to the separately granted supervisor hand-off;
    // an ordinary root neither receives the tool nor gets prompted to call it.
    expect(prompt).not.toContain('task_recover')
  })

  test('resumes a root with the full allow-list and the evolution protocol when the deployment turned the chain on', async () => {
    const state = context([id('root')], 'idle', { evolution: { enabled: true } })
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })

    const { restrict, section } = await assemble(state.resumeOptions[0])
    expect(restrict).toHaveBeenCalledWith({ allow: ROOT_TOOLS_OPEN })
    const prompt = promptTextOf(section)
    expect(prompt).toContain('Use evolution_propose and evolution_candidate')
    expect(prompt).toContain('new baseline and candidate runs on frozen inputs, judges, model and budget')
    expect(prompt).toContain('one whole capability row with an optional new execution skill')
    expect(prompt).toContain('Keep the existing role, verifier and capabilities of a skill')
    expect(prompt).toContain('use only authorized tools without changing permissions or presets')
    expect(prompt).toContain('Decisions require human approval')
    expect(prompt).toContain('evolution_apply with a second approval')
    expect(prompt).toContain('Read the ledger with evolution_list')
    expect(prompt).toContain('an existing execution contract is derived at prepare')
    expect(prompt).toContain('A new execution provider needs the capability row that grants it')
    expect(prompt).not.toMatch(/single-file|single file|candidate.vs.champion|v1 replay/i)
    // The domain reference map is a deployed skill, not part of the general root prompt.
    expect(prompt).not.toContain('Buckyball')
  })

  test('reads a context that provides no evolution exposure as the closed composition', async () => {
    const state = context([id('root')])
    const read = vi.fn(() => undefined)
    Object.assign(state.ctx, { get: read })
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })

    // A composition that mounts no singularity agent plugin is read as off —
    // never as "assume the chain is there".
    const { restrict, section } = await assemble(state.resumeOptions[0])
    expect(read).toHaveBeenCalledWith('singularityEvolution')
    const allow = (restrict.mock.calls[0]?.[0] as { allow: readonly string[] }).allow
    expect(allow.filter(name => name.startsWith('evolution_'))).toEqual([])
    expect(allow).toEqual(ROOT_TOOLS_CLOSED)
    expect(promptTextOf(section)).not.toContain('evolution')
  })

  test('carries the intake paragraph in every composition, with the chain still absent when it is off', async () => {
    const closed = context([id('root')])
    const closedRuntime = new AgentRuntime(closed.ctx as never)
    await closedRuntime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    const closedAssembly = await assemble(closed.resumeOptions[0])
    const closedPrompt = promptTextOf(closedAssembly.section)
    const closedAllow = (closedAssembly.restrict.mock.calls[0]?.[0] as { allow: readonly string[] }).allow

    // Accepting the user's own goal is the root's core path, not a deployment
    // option: the tool is on the allow-list and the paragraph is there whatever
    // the evolution switch says — and neither names a tool the closed
    // composition does not carry.
    expect(closedAllow).toContain('task_intake')
    expect(closedPrompt).toContain('call task_intake')
    expect(closedPrompt).toContain('there is no root task')
    expect(closedPrompt).toContain('not activated')
    expect(closedPrompt).toContain('Normalize clear requests yourself')
    expect(closedPrompt).toContain('Nothing you can call approves a contract')
    expect(closedPrompt).not.toContain('evolution')

    const open = context([id('root')], 'idle', { evolution: { enabled: true } })
    const openRuntime = new AgentRuntime(open.ctx as never)
    await openRuntime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    const openAssembly = await assemble(open.resumeOptions[0])
    const openAllow = (openAssembly.restrict.mock.calls[0]?.[0] as { allow: readonly string[] }).allow

    expect(openAllow).toContain('task_intake')
    expect(promptTextOf(openAssembly.section)).toContain('call task_intake')
    expect(promptTextOf(openAssembly.section)).toContain('Use evolution_propose and evolution_candidate')
  })

  test('ensureRoot returns an interrupted running root to idle before resuming it', async () => {
    const state = context([id('root')], 'running')
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })

    expect(state.statuses).toEqual([['graph', id('root'), 'idle']])
    expect(state.resumed).toEqual(['root'])
  })

  test('createRoot adds a Singularity agent with layout geometry', async () => {
    const state = context([])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.createRoot({
      sessionId: id('root'),
      cwd: '/workspace',
      scope: { graphStoreId: 'graph', layoutStoreId: 'layout' },
    })
    expect(state.created).toEqual(['root'])
    expect(state.createOptions).toEqual([
      {
        sessionId: id('root'),
        meta: { cwd: '/workspace', agentPreset: 'standard' },
        agentOptions: { provider: 'default-provider', model: 'default-model' },
        setup: expect.any(Function),
      },
    ])
    const { session, restrict, section } = await assemble(state.createOptions[0])
    expect(state.ctx.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(session, 'danger-full-access')
    expect(session.append).toHaveBeenCalledExactlyOnceWith('approval/policy', { policy: 'ask' })
    // A newly created root is assembled on the same facts as a resumed one: with
    // no exposure mounted, the nine names and the protocol behind them are absent.
    expect(restrict).toHaveBeenCalledWith({ allow: ROOT_TOOLS_CLOSED })
    const prompt = promptTextOf(section)
    expect(prompt).toContain("coordinate the user's complete objective through task workers")
    expect(prompt).not.toContain('evolution')
    expect(prompt).not.toContain('Buckyball')
    expect(state.added).toEqual([['graph', { id: id('root'), name: 'Singularity', status: 'idle' }, true]])
  })

  test('createRoot assembles the evolution chain when the deployment turned it on', async () => {
    const state = context([], 'idle', { evolution: { enabled: true } })
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.createRoot({
      sessionId: id('root'),
      cwd: '/workspace',
      scope: { graphStoreId: 'graph', layoutStoreId: 'layout' },
    })

    const { restrict, section } = await assemble(state.createOptions[0])
    expect(restrict).toHaveBeenCalledWith({ allow: ROOT_TOOLS_OPEN })
    const prompt = promptTextOf(section)
    expect(prompt).toContain('Use evolution_propose and evolution_candidate')
    expect(prompt).toContain('evolution_propose')
    expect(prompt).toContain('Read the ledger with evolution_list')
    expect(prompt).not.toContain('Buckyball')
  })
})

describe('the spawn request contract (A2)', () => {
  test('a taskWorker spawn needs no prompt: the default kickoff starts its turn, attributed to the runtime', async () => {
    const state = await spawnContext()
    await state.runtime.spawn(state.root, { sessionId: id('child'), name: 'worker', taskWorker: true })

    const child = state.live.get('child') as unknown as { followup: Spy }
    expect(child.followup).toHaveBeenCalledOnce()
    const message = child.followup.mock.calls[0]![0] as { content: readonly { text?: string }[]; source: unknown }
    expect(message.content.map(block => block.text ?? '').join('\n')).toBe(WORKER_KICKOFF_TEXT)
    expect(message.source).toEqual({ kind: 'runtime-prompt', channel: 'spawn' })
    expect(WORKER_KICKOFF_TEXT).toContain('task_read')
    expect(WORKER_KICKOFF_TEXT).toContain('task_submit_result')
  })

  test('a taskWorker spawn setup installs the stable worker policy section at order 75', async () => {
    const state = await spawnContext()
    await state.runtime.spawn(state.root, { sessionId: id('child'), name: 'worker', taskWorker: true })
    const { section } = await runSetup(state.createCalls[0]!.options)

    expect(section).toHaveBeenCalledWith({
      name: 'singularity:worker',
      order: 75,
      text: WORKER_POLICY_TEXT,
      interpolate: false,
    })
    // The stable, unconditional rules migrated from the old spawn prompt...
    for (const rule of [
      'Never declare completion yourself',
      'use `task_verify`: it runs the contracted criteria under the verifier deadline',
      'Do not copy an acceptance command into bash or a background job',
      'protected inputs must not be modified',
      'hand it in with `task_submit_result`',
      'Going idle is not a submission',
      '`task_verify` is only a self-check',
    ]) {
      expect(WORKER_POLICY_TEXT).toContain(rule)
    }
    // ...without the sealed raw-session guidance and without the conditional
    // rules (those are the context projection's, and the two never repeat).
    expect(WORKER_POLICY_TEXT).not.toContain('session_event_read')
    expect(WORKER_POLICY_TEXT).not.toContain('session_trace')
    expect(WORKER_POLICY_TEXT).not.toContain('## This task is decomposable')
    expect(WORKER_POLICY_TEXT).not.toContain('waiting for a human review')
  })

  test.each(['reviewer', 'supervisor'] as const)('installs the %s policy; the supervisor can request human approval', async coordinationRole => {
    const state = await spawnContext()
    await state.runtime.spawn(state.root, { sessionId: id('child'), name: coordinationRole, prompt: [{ type: 'text', text: 'source facts' }], agentPreset: 'singularity-coordinator', coordinationRole })
    const { section, session } = await runSetup(state.createCalls[0]!.options)
    expect(section).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: `singularity:${coordinationRole}`, order: 75, interpolate: false }))
    if (coordinationRole === 'supervisor') {
      expect(session.append).toHaveBeenCalledExactlyOnceWith('approval/policy', { policy: 'ask' })
      expect(section.mock.calls[0]![0].text).toContain('evolution_decide and evolution_apply')
    } else {
      expect(session.append).not.toHaveBeenCalled()
      expect(section.mock.calls[0]![0].text).toContain('You do not change files')
    }
  })

  test('a spawn with a prompt but no taskWorker installs no worker policy and no kickoff rewrite', async () => {
    const state = await spawnContext()
    await state.spawn('child')
    const { section } = await runSetup(state.createCalls[0]!.options)
    expect(section).not.toHaveBeenCalled()
    const child = state.live.get('child') as unknown as { followup: Spy }
    const message = child.followup.mock.calls[0]![0] as { content: readonly { text?: string }[] }
    expect(message.content.map(block => block.text ?? '').join('\n')).toBe('work')
  })

  test('a spawn with neither a prompt nor taskWorker is refused before anything is created', async () => {
    const state = await spawnContext()
    await expect(state.runtime.spawn(state.root, { sessionId: id('child'), name: 'worker' })).rejects.toThrow(
      'a spawn request needs a prompt',
    )
    expect(state.live.has('child')).toBe(false)
  })

  test('beforePrompt runs after publication and the spawn announcement, before the first model input', async () => {
    const state = await spawnContext()
    const order: string[] = []
    Object.assign(state.ctx, {
      parallel: async (event: string) => {
        expect(event).toBe('agentRuntime/spawned')
        order.push('spawned')
      },
    })
    const child = { followup: vi.fn(() => order.push('prompt')), session: { append: vi.fn() } }
    state.ctx.agents.create = async (options: { sessionId: SessionId }) => {
      state.live.set(options.sessionId, { id: options.sessionId, ...child } as unknown as Agent)
      return { agent: state.live.get(options.sessionId)!, dispose: () => state.dispose(options.sessionId) }
    }
    await state.runtime.spawn(state.root, {
      sessionId: id('child'),
      name: 'worker',
      taskWorker: true,
      beforePrompt: async () => {
        order.push('beforePrompt')
      },
    })
    expect(order).toEqual(['spawned', 'beforePrompt', 'prompt'])
    expect(child.followup).toHaveBeenCalledOnce()
  })

  test('a beforePrompt failure disposes the handle, marks the node failed, and sends zero model input', async () => {
    const state = await spawnContext()
    const child = { followup: vi.fn(), session: { append: vi.fn() } }
    state.ctx.agents.create = async (options: { sessionId: SessionId }) => {
      state.live.set(options.sessionId, { id: options.sessionId, ...child } as unknown as Agent)
      return { agent: state.live.get(options.sessionId)!, dispose: () => state.dispose(options.sessionId) }
    }
    await expect(
      state.runtime.spawn(state.root, {
        sessionId: id('child'),
        name: 'worker',
        taskWorker: true,
        beforePrompt: async () => {
          throw new Error('the ledger cannot be written')
        },
      }),
    ).rejects.toThrow('the ledger cannot be written')

    expect(child.followup).not.toHaveBeenCalled()
    expect(state.dispose).toHaveBeenCalledExactlyOnceWith('child')
    expect(state.statuses).toContainEqual(['graph', id('child'), 'failed'])
    expect(state.live.has('child')).toBe(false)
    // A retry is not swallowed: the runtime holds no half-spawned child.
    await state.runtime.stopAgents([id('child')])
    expect(state.dispose).toHaveBeenCalledExactlyOnceWith('child')
  })

  test('the raw cross-session readers are denied at execution for a spawned agent, and nothing else is', async () => {
    const state = await spawnContext()
    await state.spawn('child')
    const { guard } = await runSetup(state.createCalls[0]!.options)

    expect(RAW_SESSION_READ_TOOLS).toEqual([
      'session_event_read',
      'session_event_trace',
      'session_trace',
      'session_search',
    ])
    for (const name of RAW_SESSION_READ_TOOLS) expect(denialOf(guard, name)).toBe(RAW_SESSION_READ_DENIAL)
    expect(RAW_SESSION_READ_DENIAL).toContain('context_read')
    for (const other of ['context_read', 'session_history_export', 'task_read', 'bash']) {
      expect(denialOf(guard, other)).toBeUndefined()
    }
  })

  test.each([false, true])('root-local tools obey the coordination allow-list (evolution=%s)', async enabled => {
    const created = context([], 'idle', { evolution: { enabled } })
    const runtime = new AgentRuntime(created.ctx as never)
    await runtime.createRoot({
      sessionId: id('root'),
      cwd: '/workspace',
      scope: { graphStoreId: 'graph', layoutStoreId: 'layout' },
    })
    const resumed = context([id('root')], 'idle', { evolution: { enabled } })
    await new AgentRuntime(resumed.ctx as never).ensureRoot(id('root'), {
      graphStoreId: 'graph',
      layoutStoreId: 'layout',
    })
    for (const assembly of [await assemble(created.createOptions[0]), await assemble(resumed.resumeOptions[0])]) {
      const allowed = enabled ? ROOT_TOOLS_OPEN : ROOT_TOOLS_CLOSED
      expect(assembly.presentAs).toHaveBeenCalledExactlyOnceWith('native')
      for (const name of allowed) expect(denialOf(assembly.guard, name), name).toBeUndefined()
      for (const name of [
        'run_code',
        'subagent',
        'subagent_fork',
        'read',
        'grep',
        'glob',
        'write',
        'edit',
        'bash',
        'jobs',
        'mcp_custom',
      ]) {
        expect(denialOf(assembly.guard, name), name).toContain('delegate engineering work with task_decompose')
      }
      for (const name of EVOLUTION_TOOLS) {
        if (enabled) expect(denialOf(assembly.guard, name), name).toBeUndefined()
        else expect(denialOf(assembly.guard, name), name).toBeDefined()
      }
    }
  })

  test('the same execution seal is installed for a root, created or resumed', async () => {
    const created = context([])
    const createdRuntime = new AgentRuntime(created.ctx as never)
    await createdRuntime.createRoot({
      sessionId: id('root'),
      cwd: '/workspace',
      scope: { graphStoreId: 'graph', layoutStoreId: 'layout' },
    })
    const createdAssembly = await assemble(created.createOptions[0])
    for (const name of RAW_SESSION_READ_TOOLS)
      expect(denialOf(createdAssembly.guard, name)).toBe(RAW_SESSION_READ_DENIAL)
    expect(denialOf(createdAssembly.guard, 'context_read')).toBeUndefined()

    const resumed = context([id('root')])
    const resumedRuntime = new AgentRuntime(resumed.ctx as never)
    await resumedRuntime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    const resumedAssembly = await assemble(resumed.resumeOptions[0])
    for (const name of RAW_SESSION_READ_TOOLS)
      expect(denialOf(resumedAssembly.guard, name)).toBe(RAW_SESSION_READ_DENIAL)
  })
})

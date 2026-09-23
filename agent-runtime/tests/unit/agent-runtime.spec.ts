import { describe, expect, test, vi } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AgentRuntime } from '../../src/index.ts'

const id = (value: string) => value as SessionId

function agent(value: string): Agent {
  return { id: id(value) } as Agent
}

type Spy = ReturnType<typeof vi.fn>

/** The eighteen tools every root composition may call; the deployment's evolution switch does not touch them. */
const ROOT_CORE_TOOLS = [
  'graph_spawn',
  'graph_mark_ready',
  'hitl_ask',
  'hitl_approve',
  'task_read',
  'capability_list',
  'skill',
  'task_decompose',
  'task_submit_result',
  'task_cancel',
  'task_proposal_read',
  'task_proposal_continue',
  'task_proposal_cancel',
  'task_status',
  'task_verify',
  'task_review_pack',
  'task_review_agent',
  'task_diagnose',
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
  readonly agentCtx: { tools: { restrict: Spy }; systemPrompt: { section: Spy } }
  readonly session: { append: Spy }
  /** What `tools.restrict` was called with: the root's actual allow-list. */
  readonly restrict: Spy
  /** What `systemPrompt.section` was called with: the root's actual prompt. */
  readonly section: Spy
}

/** Runs one root assembly's `setup` the way the agent factory does — after the preset mount, before the first prompt. */
async function assemble(options: unknown): Promise<Assembly> {
  const restrict = vi.fn()
  const section = vi.fn()
  const session = { append: vi.fn() }
  const agentCtx = { tools: { restrict }, systemPrompt: { section } }
  await (options as { setup: (ctx: unknown, agent: unknown) => Promise<void> }).setup(agentCtx, { session })
  return { agentCtx, session, restrict, section }
}

/** The prompt text one assembly registered, read back off the section call. */
function promptTextOf(section: Spy): string {
  return ((section.mock.calls[0]?.[0] ?? {}) as { text?: string }).text ?? ''
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
  Object.assign(state.ctx.agents, {
    get: (sessionId: string) => live.get(sessionId),
    create: async ({ sessionId }: { sessionId: SessionId }) => {
      const child = { id: sessionId, followup: vi.fn() } as unknown as Agent
      live.set(sessionId, child)
      return { agent: child, dispose: () => dispose(sessionId) }
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
  return { ...state, runtime, scope, live, dispose, spawn, setLayout }
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
    const child = { id: id('child'), followup }
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
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: {
        cwd: '/environment',
        agentPreset: 'standard',
        parentSession: id('root'),
        isSeeded: false,
        origin: 'subagent',
        delegationDepth: 1,
      },
      setup: expect.any(Function),
    }))
    const childSession = {}
    const childCtx = {}
    await create.mock.calls[0][0].setup(childCtx, { session: childSession })
    expect(state.ctx.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(childSession, 'danger-full-access')
    expect(order).toEqual(['topology', 'bind', 'prompt'])
    expect(followup).toHaveBeenCalledOnce()
  })

  test('spawn setup applies the capability-granted permission preset instead of the default posture', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    Object.assign(state.root, {
      session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard' } },
    })
    const child = { id: id('child'), followup: vi.fn() }
    const create = vi.fn(async () => ({ agent: child, dispose: async () => {} }))
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
    await (create.mock.calls[0][0] as { setup: (ctx: unknown, agent: unknown) => Promise<void> })
      .setup({}, { session: childSession })
    expect(state.ctx.permissionPresets.set).toHaveBeenCalledExactlyOnceWith(childSession, 'workspace-write')
  })

  test('stamps a spawned child with its parent lineage and one delegation level deeper', async () => {
    const state = context([id('root')])
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })
    Object.assign(state.root, {
      session: { header: { id: id('root'), cwd: '/environment', agentPreset: 'standard', delegationDepth: 2 } },
    })
    const child = { id: id('child'), followup: vi.fn() }
    const create = vi.fn(async () => ({ agent: child, dispose: async () => {} }))
    Object.assign(state.ctx.agents, { get: () => state.root, create })
    Object.assign(state.ctx.graph, { commitIn: async () => {} })
    Object.assign(state.ctx, { parallel: async () => {} })

    await runtime.spawn(state.root, {
      sessionId: id('child'),
      name: 'worker',
      prompt: [{ type: 'text', text: 'work' }],
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      meta: {
        cwd: '/environment',
        agentPreset: 'standard',
        parentSession: id('root'),
        isSeeded: false,
        origin: 'subagent',
        delegationDepth: 3,
      },
    }))
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
      text: expect.stringContaining('connect workers, not to implement tasks'),
    })
    expect(prompt).not.toContain('evolution')
    expect(prompt).not.toContain('stay manual')
    expect(prompt).not.toContain('Buckyball')
  })

  test('resumes a root with the full allow-list and the evolution protocol when the deployment turned the chain on', async () => {
    const state = context([id('root')], 'idle', { evolution: { enabled: true } })
    const runtime = new AgentRuntime(state.ctx as never)
    await runtime.ensureRoot(id('root'), { graphStoreId: 'graph', layoutStoreId: 'layout' })

    const { restrict, section } = await assemble(state.resumeOptions[0])
    expect(restrict).toHaveBeenCalledWith({ allow: ROOT_TOOLS_OPEN })
    const prompt = promptTextOf(section)
    expect(prompt).toContain('To carry a diagnosed fix into the evolution track')
    expect(prompt).toContain('L4 and bookkeeping-only types stay manual')
    expect(prompt).toContain('evolution_list reads the ledger')
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
    expect(prompt).toContain('connect workers, not to implement tasks')
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
    expect(prompt).toContain('To carry a diagnosed fix into the evolution track')
    expect(prompt).toContain('evolution_propose')
    expect(prompt).toContain('evolution_list reads the ledger')
    expect(prompt).not.toContain('Buckyball')
  })
})

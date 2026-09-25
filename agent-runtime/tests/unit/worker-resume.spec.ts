/**
 * The worker recovery entry's checks (A4 §F.1's narrow resume): what it reads,
 * what it refuses by name, and what it composes when it does resume.
 *
 * Two layers, and the split is deliberate. `resumeWorkerAgent` in
 * `src/worker-resume.ts` is the decision — which facts are read, which
 * contradictions are refused — and it is driven here over stand-in services so
 * every branch is cheap to reach. `AgentRuntime.resumeWorkerAgent` is the door
 * into the runtime's own handle map and the deployment's shared `workerSetup`,
 * and it is driven here over the same skeleton so the composition a resume
 * produces (mounted preset, permission posture, policy section, grant
 * restriction, execution seal) is asserted through the product's own code, not
 * through a fixture copy of it.
 *
 * The real log, the real agent loop and a real spawn→crash→restart are the
 * counterpart spec's subject (`tests/integration/a4-worker-resume.spec.ts`).
 *
 * Every refusal case asserts the same two things: the code it refuses with, and
 * that the resume door was never reached — a refusal is a read-only decision, so
 * a refused resume may not have touched the session, the graph status or the
 * door at all.
 */

import { describe, expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import { AgentRuntime } from '../../src/index.ts'
import { WORKER_DEFAULT_PERMISSION_PRESET, WorkerResumeRefusal, resumeWorkerAgent } from '../../src/worker-resume.ts'
import type { WorkerResumeDeps, WorkerRole } from '../../src/worker-resume.ts'
import type { WorkerGrant, WorkerResumeRequest } from '../../src/types.ts'

const WORKER = 's-worker' as SessionId
const PARENT = 's-parent' as SessionId
const SCOPE = { graphStoreId: 'sg-g', layoutStoreId: 'sg-l' }

/** The persisted Session header every case starts from: a spawned, run-bound worker. */
function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    id: WORKER,
    createdAt: 1,
    isSeeded: false,
    cwd: '/environment',
    parentSession: PARENT,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'standard',
    ...overrides,
  }
}

/** One permission/preset event: the Session's own durable record of the posture it ran under. */
function permissionEvent(preset: string): { type: string; seq: number; time: number; data: { preset: string } } {
  return { type: 'permission/preset', seq: 0, time: 1, data: { preset } }
}

/** One grant a case uses: a capability naming a real tool, no preset plane, no extra planes. */
function grant(overrides: Partial<WorkerGrant> = {}): WorkerGrant {
  return {
    capabilities: [{ capability: 'design-ball', tools: ['read'], skills: [] }],
    baseline: [],
    keepPresetTools: false,
    ...overrides,
  }
}

/** The Run facts one run-bound worker resume is stated with. */
function run(overrides: Partial<WorkerResumeRequest['run']> = {}): WorkerResumeRequest['run'] {
  return {
    storeId: 'sg-store',
    taskId: 't-child',
    runId: 'r-child',
    sessionId: WORKER,
    agentPreset: 'standard',
    capabilitySnapshot: ['read'],
    ...overrides,
  }
}

/** The request one run-bound worker resume is stated with. */
function request(overrides: Partial<WorkerResumeRequest> = {}): WorkerResumeRequest {
  return {
    sessionId: WORKER,
    scope: SCOPE,
    run: run(),
    grant: grant(),
    permissionPreset: 'danger-full-access',
    taskWorker: true,
    ...overrides,
  }
}

/** One refusal raised by an attempt, or `undefined` when it settled. */
async function refusalOf(attempt: Promise<unknown>): Promise<WorkerResumeRefusal | undefined> {
  const outcome = await attempt.then(() => undefined, (error: unknown) => error)
  expect(outcome).toBeInstanceOf(WorkerResumeRefusal)
  return outcome as WorkerResumeRefusal
}

interface HarnessOptions {
  /** The header the read path answers with; an Error stands in for an unreadable session. */
  readonly header?: Record<string, unknown> | Error
  /** The Session's own events, as the read path returns them. Defaults to one recorded permission. */
  readonly events?: readonly unknown[]
  readonly agents?: readonly { readonly id: SessionId; readonly status: 'idle' | 'running' | 'waiting' | 'done' | 'failed' }[]
  readonly roots?: readonly SessionId[]
  readonly edges?: readonly { readonly kind: string; readonly from: SessionId; readonly to: SessionId }[]
  /** What the graph read does instead of answering. */
  readonly graphError?: Error
  /** A live agent already registered for the session. */
  readonly live?: Agent
  /** What the resume door throws. */
  readonly resumeError?: Error
}

interface Harness {
  readonly runtime: AgentRuntime
  readonly deps: WorkerResumeDeps
  /** Every role the module's setup factory was handed, in order. */
  readonly roles: WorkerRole[]
  /** The `agents.resume` options the entry called the door with, in order. */
  readonly resumeOptions: { resumeSessionId: SessionId; agentOptions?: unknown; setup?: AgentSetup }[]
  /** Every graph status write, in order. */
  readonly statuses: { storeId: string; agentId: SessionId; status: string }[]
  /** The composition the deployment's own `workerSetup` produced, read through stand-in services. */
  readonly composed: {
    readonly mounted: string[]
    readonly permissions: unknown[]
    readonly sections: unknown[]
    readonly restricted: unknown[]
    readonly guarded: number
  }
  readonly handle: AgentHandle
}

/** A deployment skeleton with the services the entry reads replaced by recording stand-ins. */
function harness(options: HarnessOptions = {}): Harness {
  const mounted: string[] = []
  const permissions: unknown[] = []
  const sections: unknown[] = []
  const restricted: unknown[] = []
  const roles: WorkerRole[] = []
  const resumeOptions: Harness['resumeOptions'] = []
  const statuses: Harness['statuses'] = []
  let guarded = 0
  const agent = {
    id: WORKER,
    session: { id: WORKER, header: { id: WORKER, cwd: '/environment', agentPreset: 'standard' }, append: () => {} },
  } as unknown as Agent
  const handle: AgentHandle = { agent, dispose: async () => {} }
  const readHeader = options.header ?? header()
  /** The scoped context the real `workerSetup` writes to, with everything it reaches recorded. */
  const agentCtx = {
    tools: {
      restrict: (filter: unknown) => { restricted.push(filter) },
      guard: () => { guarded += 1 },
      schemas: () => [{ name: 'read' }, { name: 'write' }],
    },
    systemPrompt: { section: (section: unknown) => { sections.push(section) } },
    get: () => undefined,
  }
  const ctx = {
    reflect: { provide: () => {} },
    provide: () => {},
    on: () => {},
    effect: () => () => {},
    get: () => undefined,
    parallel: async () => {},
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    agentPresets: {
      defaultId: 'standard',
      mount: async (_agentCtx: unknown, preset: string) => { mounted.push(preset) },
    },
    permissionPresets: {
      set: (session: unknown, preset: string) => { permissions.push([session, preset]) },
      resolve: () => ({}),
    },
    sessions: {},
    sessionPersistence: { list: async () => [{ header: readHeader }] },
    sessionQuery: {
      readSession: async () => {
        if (readHeader instanceof Error) throw readHeader
        return { session: readHeader, inheritedEventCount: 0, events: options.events ?? [permissionEvent('danger-full-access')] }
      },
    },
    graph: {
      snapshotIn: async () => {
        if (options.graphError !== undefined) throw options.graphError
        return {
          version: 1,
          id: 'g',
          roots: options.roots ?? [PARENT],
          agents: options.agents ?? [{ id: WORKER, name: 'worker', status: 'idle' }],
          groups: [],
          edges: options.edges ?? [{ kind: 'spawn', from: PARENT, to: WORKER }],
        }
      },
      addAgentIn: async () => {},
      commitIn: async () => {},
      setStatusIn: async (storeId: string, agentId: SessionId, status: string) => {
        statuses.push({ storeId, agentId, status })
      },
    },
    layout: { setIn: async () => {} },
    agents: {
      get: () => options.live,
      resume: async (resume: { resumeSessionId: SessionId; agentOptions?: unknown; setup?: AgentSetup }) => {
        resumeOptions.push(resume)
        if (options.resumeError !== undefined) throw options.resumeError
        await resume.setup?.(agentCtx as never, agent)
        return handle
      },
      create: async () => handle,
    },
  }
  const runtime = new AgentRuntime(ctx as never)
  const deps: WorkerResumeDeps = {
    agents: ctx.agents as never,
    sessionQuery: ctx.sessionQuery as never,
    graph: ctx.graph as never,
    // The module's own seam: this spec's stand-in composition records the role it
    // was handed, so a module-level case can assert what the entry decided to
    // rebuild. The real composition is the class-level cases' subject below.
    setup: role => {
      roles.push(role)
      return async () => {}
    },
    agentOptions: { provider: 'p', model: 'm' },
  }
  return {
    runtime,
    deps,
    roles,
    resumeOptions,
    statuses,
    composed: { mounted, permissions, sections, restricted, get guarded() { return guarded } },
    handle,
  }
}

describe('the resume entry’s source checks (A4 §F.1)', () => {
  test('resumes the same Session, states the composition, and reaches the door once', async () => {
    const h = harness()
    const handle = await resumeWorkerAgent(h.deps, request())

    expect(handle).toBe(h.handle)
    expect(h.resumeOptions).toHaveLength(1)
    expect(h.resumeOptions[0]?.resumeSessionId).toBe(WORKER)
    expect(h.resumeOptions[0]?.agentOptions).toEqual({ provider: 'p', model: 'm' })
    expect(h.resumeOptions[0]?.setup).toBeTypeOf('function')
    // The composition is stated from the Session's own record and the caller's
    // declaration: persisted preset, declared permission, worker role, the grant.
    expect(h.roles[0]).toEqual({
      agentPreset: 'standard',
      permissionPreset: 'danger-full-access',
      taskWorker: true,
      grant: expect.objectContaining({ capabilities: [expect.objectContaining({ capability: 'design-ball' })] }),
    })
  })

  test('states the spawn’s default permission posture when the request names none', async () => {
    const h = harness({ events: [] })
    await resumeWorkerAgent(h.deps, request({ permissionPreset: undefined }))

    expect(h.roles[0]?.permissionPreset).toBe(WORKER_DEFAULT_PERMISSION_PRESET)
  })

  test('refuses a Session that does not exist, and never reaches the door', async () => {
    const missing = Object.assign(new Error('session "s-worker" not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    const h = harness({ header: missing })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('session-missing')
    expect(refusal?.message).toContain('never creates one')
    expect(h.resumeOptions).toHaveLength(0)
    expect(h.statuses).toHaveLength(0)
    expect(h.roles).toHaveLength(0)
  })

  test('refuses a Session whose log cannot be read, naming the read failure', async () => {
    const h = harness({ header: new Error('invalid session log at line 4') })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('session-unreadable')
    expect(refusal?.message).toContain('invalid session log at line 4')
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('refuses a Session another live agent owns, before reading anything', async () => {
    const h = harness({ live: { id: WORKER } as Agent })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('ownership-conflict')
    expect(refusal?.message).toContain('already live')
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('names the write-ownership race the door reports as the same retryable conflict', async () => {
    const h = harness({ resumeError: new SessionAlreadyOwnedError(WORKER) })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('ownership-conflict')
    expect(refusal?.message).toContain('retry')
  })

  test('refuses a takeover the session log cannot complete, and never creates a stand-in Session', async () => {
    const h = harness({ resumeError: new Error('invalid persisted inbox splice at session seq 7') })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('takeover-refused')
    expect(refusal?.message).toContain('invalid persisted inbox splice')
  })

  test('refuses a Run that binds another Session', async () => {
    const h = harness()
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request({ run: run({ sessionId: 's-other' as SessionId }) })))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('"s-other"')
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('refuses a Run whose preset is not the one the Session ran under', async () => {
    const h = harness()
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request({ run: run({ agentPreset: 'bb-verify' }) })))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('bb-verify')
  })

  test('refuses a Session whose header names no preset at all', async () => {
    const h = harness({ header: header({ agentPreset: undefined }) })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('names no agent preset')
  })

  test('refuses a grant whose plane is not the one the Run was admitted with', async () => {
    const h = harness()
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request({
      grant: grant({ capabilities: [{ capability: 'design-ball', tools: ['read', 'write'], skills: [] }] }),
    })))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('read, write')
  })

  test('refuses a resume that would drop the plane the Run was admitted with, as readily as one that widens it', async () => {
    const h = harness()
    // The run was admitted with `read`; a resume declaring no grant at all would
    // hand a restricted worker its whole composition surface back.
    const dropped = await refusalOf(resumeWorkerAgent(h.deps, request({ grant: undefined })))
    expect(dropped?.code).toBe('binding-mismatch')
    expect(dropped?.message).toContain('declares []')

    // And the other direction: a Run admitted with nothing must not be resumed
    // with a capability plane it never had.
    const widened = await refusalOf(resumeWorkerAgent(h.deps, request({ run: run({ capabilitySnapshot: [] }) })))
    expect(widened?.code).toBe('binding-mismatch')
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('refuses a granted MCP plane the Run never recorded', async () => {
    const h = harness()
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request({
      grant: grant({ mcpServers: [{ serverName: 'git', command: 'git-mcp', args: [], env: {}, cwd: '' }] }),
    })))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('mcp:git')
  })

  test('refuses an empty declared run identity', async () => {
    const h = harness()
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request({ run: run({ runId: '' }) })))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('empty')
  })

  test('refuses a declared permission preset the Session’s own log contradicts', async () => {
    const h = harness({ events: [permissionEvent('workspace-write')] })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('workspace-write')
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('refuses a Session the graph does not publish as a member', async () => {
    const h = harness({ agents: [] })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('not-in-graph')
    expect(refusal?.message).toContain('never adds one')
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('refuses a member with no delegation facts, and names the root entry for a root', async () => {
    const orphan = harness({ edges: [] })
    expect((await refusalOf(resumeWorkerAgent(orphan.deps, request())))?.code).toBe('member-facts-missing')

    const root = harness({ roots: [WORKER], edges: [] })
    const refusal = await refusalOf(resumeWorkerAgent(root.deps, request()))
    expect(refusal?.code).toBe('member-facts-missing')
    expect(refusal?.message).toContain('ensureRoot')
  })

  test('refuses a Session whose recorded lineage disagrees with the graph’s spawn edge', async () => {
    const h = harness({ edges: [{ kind: 'spawn', from: 's-stranger' as SessionId, to: WORKER }] })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('s-stranger')
  })

  test('refuses a Session whose own record names no parent the graph records', async () => {
    const h = harness({ header: header({ parentSession: undefined }) })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('member-facts-missing')
    expect(refusal?.message).toContain('no parent session')
  })

  test('reports a graph store it cannot read as missing member facts', async () => {
    const h = harness({ graphError: new Error('graph store "sg-g" is locked') })
    const refusal = await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(refusal?.code).toBe('member-facts-missing')
    expect(refusal?.message).toContain('locked')
  })

  test('repairs a node a dead process left running, and leaves an idle node alone', async () => {
    const stale = harness({ agents: [{ id: WORKER, status: 'running' }] })
    await resumeWorkerAgent(stale.deps, request())
    expect(stale.statuses).toEqual([{ storeId: 'sg-g', agentId: WORKER, status: 'idle' }])

    const idle = harness()
    await resumeWorkerAgent(idle.deps, request())
    expect(idle.statuses).toHaveLength(0)
  })

  test('a refusal leaves the graph status untouched', async () => {
    const h = harness({ agents: [{ id: WORKER, status: 'running' }], edges: [] })
    await refusalOf(resumeWorkerAgent(h.deps, request()))

    expect(h.statuses).toHaveLength(0)
  })
})

describe('AgentRuntime.resumeWorkerAgent', () => {
  test('composes the resumed worker through the shared worker setup and registers it in the one handle map', async () => {
    const h = harness()
    const handle = await h.runtime.resumeWorkerAgent(request())

    expect(handle).toBe(h.handle)
    // The deployment's own composition ran: the persisted preset mounted, the
    // declared permission applied, the worker policy section installed, the
    // grant's allow-list restricted, and the raw-session seal registered.
    expect(h.composed.mounted).toEqual(['standard'])
    expect(h.composed.permissions[0]).toEqual([expect.anything(), 'danger-full-access'])
    expect(h.composed.sections[0]).toMatchObject({ name: 'singularity:worker', order: 75 })
    expect(h.composed.restricted[0]).toEqual({ allow: ['read'] })
    expect(h.composed.guarded).toBe(1)
    // The handle is the runtime's own: the stop path finds and disposes it.
    await expect(h.runtime.stopAgents([WORKER])).resolves.toBeUndefined()
  })

  test('leaves a worker that was not declared one without the worker policy section', async () => {
    const h = harness()
    await h.runtime.resumeWorkerAgent(request({ taskWorker: false }))

    expect(h.composed.sections).toHaveLength(0)
  })

  test('a refused resume leaves no trace: not owned, not scoped, not in the handle map', async () => {
    const h = harness({ live: { id: WORKER } as Agent })
    await refusalOf(h.runtime.resumeWorkerAgent(request()))

    // The stop path reads the same maps: a Session the runtime neither owns nor
    // holds a handle for is refused as unowned rather than silently dropped.
    await expect(h.runtime.stopAgents([WORKER])).rejects.toThrow('cannot stop unowned agent')
  })

  test('a refused resume leaves the Session log, the graph status and the door untouched', async () => {
    const h = harness({ agents: [{ id: WORKER, status: 'running' }], edges: [] })
    await refusalOf(h.runtime.resumeWorkerAgent(request()))

    expect(h.statuses).toHaveLength(0)
    expect(h.resumeOptions).toHaveLength(0)
  })

  test('a resumed worker is disposed by the same rule as a spawned one, and the Session can be resumed again', async () => {
    const h = harness()
    await h.runtime.resumeWorkerAgent(request())
    await h.runtime.stopAgents([WORKER])

    // Nothing is left behind by the disposal: the same Session is resumable.
    await expect(h.runtime.resumeWorkerAgent(request())).resolves.toBe(h.handle)
    expect(h.resumeOptions).toHaveLength(2)
  })
})

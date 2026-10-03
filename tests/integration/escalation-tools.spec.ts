import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SingularityAgent } from '../../agent-singularity/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { graphRegistry, mountContextReadCore, sessionQueryReads } from '../support/context-plane.ts'
import { requestedSession } from '../../task-runtime/tests/support/person-request.ts'

const ROOT_SESSION = 's-root'
const STORE = rootTaskStoreId(ROOT_SESSION)

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec?: unknown): unknown
}

/** Stand-in for the tools registry: collects what the plugin registers, so the test drives the real tools. */
function toolRegistry() {
  const tools = new Map<string, RegisteredTool>()
  return {
    tools,
    service: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  }
}

/**
 * Mounts the real root-agent plugin next to the real task plane on one context:
 * `TaskService` / `TaskRuntime` are the production services (the same pair
 * `review-metrics.spec.ts` drives), every dependency of both planes is a
 * sibling stand-in of its own, and the escalation ledger's service is the
 * plugin's own under a stubbed `$DSH_HOME` — so nothing stands in for the tool
 * or the ledger under test.
 */
async function mount(approvalOutcome: string = 'allowed-once') {
  const home = await mkdtemp(join(tmpdir(), 'singularity-escalation-'))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  const registry = toolRegistry()
  const approval = { request: vi.fn(async () => approvalOutcome) }
  const userQuestions = { ask: vi.fn(async () => ({ answers: [{ id: 'hitl-ask', selected: [], custom: 'buckyball' }] })) }

  const sessions = new Map<string, { header: SessionHeader; events: SessionEvent[] }>()
  // The person's request, on the root session's own durable log: what the root
  // contract's origin is read from (A0 §1.10). The rule is the *existence* of a
  // user-sourced message, so one text stands for the request this mount intakes on.
  sessions.set(ROOT_SESSION, requestedSession(ROOT_SESSION, 'ship the release'))
  ctx.provide('sessionPersistence', {
    list: async () => [...sessions.values()].map(item => ({ header: item.header })),
    create: async (header: SessionHeader) => {
      const stored = { header, events: [] as SessionEvent[] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (records: readonly SessionEvent[]) => { stored.events.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
    // The read half the runtime opens to establish a root contract's origin
    // (A0 §1.10): the same handle shape the store's own writes travel through.
    open: async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error(`missing session ${id}`)
      return {
        read: async () => ({ events: stored.events }),
        append: async (records: readonly SessionEvent[]) => { stored.events.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
  } as never)
  ctx.provide('agentRuntime', {
    spawn: async () => ({ agent: { id: 'worker', cancel: () => {}, whenIdle: async () => {} }, dispose: async () => {} }),
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => ({ id: sessionId }) } as never)
  ctx.provide('graphs', graphRegistry({
    graphForSession: async () => ({ id: 'g1', name: 'graph', envId: 'env1', rootSessionId: ROOT_SESSION }),
    members: () => [ROOT_SESSION, ...sessions.keys()],
  }) as never)
  ctx.provide('sessionQuery', sessionQueryReads(sessionId => sessions.get(String(sessionId))?.events) as never)
  ctx.provide('tools', registry.service as never)
  ctx.provide('userQuestions', userQuestions as never)
  ctx.provide('approval', approval as never)

  const task = new TaskService(ctx)
  const runtime = new TaskRuntime(ctx, { capabilities: { ...TASK_GUIDANCE } } as never)
  // The read core the plugin's tools read through (A2), mounted where the
  // deployment's bundle mounts it.
  await mountContextReadCore(ctx)
  await ctx.plugin(SingularityAgent)
  return { tools: registry.tools, approval, task, runtime, home }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

const card = {
  what: 'capability "fly-to-moon" is not granted by the capability registry',
  tried: 'capability_list and the children\'s declared capabilities',
  suggested: 'grant the capability, or mark the child decomposable',
  trigger: 'capability-gap',
  sourceTaskId: 't-root',
}

it('drives escalate onto the ledger through the plugin context, gated by the native approval seam', async () => {
  const { tools, approval, home } = await mount()
  try {
    const escalate = tools.get('escalate')!
    expect(escalate).toBeDefined()

    const raised = (await escalate.execute({ ...card }, exec(ROOT_SESSION))) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect((approval.request.mock.calls[0]![0] as { toolName: string }).toolName).toBe('escalate')
    expect(raised).toContain('recorded [open] trigger: capability-gap')
    expect(raised).toContain('acceptance: all three elements present (what / tried / suggested)')

    // The ledger is the service's own file under $DSH_HOME — the model-visible
    // answer and the persisted line must agree.
    const ledger = await readFile(join(home, 'escalations.jsonl'), 'utf8')
    expect(ledger.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(ledger.trim())).toMatchObject({
      kind: 'raised',
      what: card.what,
      tried: card.tried,
      suggested: card.suggested,
      trigger: 'capability-gap',
      sourceTaskId: 't-root',
      approvalRef: 'approval:call-1',
      actor: ROOT_SESSION,
    })

    const listed = (await escalate.execute({ list: true })) as string
    expect(listed).toContain('escalations (1):')
    expect(listed).toContain(`what: ${card.what}`)
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each(['rejected', 'cancelled', 'unavailable'])(
  'escalate records nothing when the approval comes back %s',
  async outcome => {
    const { tools, approval, home } = await mount(outcome)
    try {
      const raised = (await tools.get('escalate')!.execute({ ...card }, exec(ROOT_SESSION))) as string
      expect(approval.request).toHaveBeenCalledOnce()
      expect(raised).toContain('no escalation recorded')
      await expect(readFile(join(home, 'escalations.jsonl'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it('refuses an incomplete card without asking the human', async () => {
  const { tools, approval, home } = await mount()
  try {
    const raised = (await tools.get('escalate')!.execute(
      { what: card.what, trigger: 'budget-exhausted' },
      exec(ROOT_SESSION),
    )) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(raised).toContain('incomplete L4 card — tried, suggested are missing')
    await expect(readFile(join(home, 'escalations.jsonl'), 'utf8')).rejects.toThrow(/ENOENT/)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('carries a capability gap from the orchestrator feedback to the ledger through escalate', async () => {
  const { tools, task, runtime, home } = await mount()
  try {
    const activated = await runtime.intakeRootContract(STORE, ROOT_SESSION, { requiredCapabilities: ['execute-task'],
      objective: 'ship the release',
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is delivered', command: 'true' }],
    })
    if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
    const rootTaskId = activated.taskId

    // The capability gap, exactly as the root's task_decompose call sees it:
    // the orchestrator's rejection text, which names the L4 exit.
    const feedback = (await tools.get('task_decompose')!.execute({
      reason: 'split the work',
      children: [{
        objective: 'build the thing',
        acceptanceCriteria: [{ description: 'the build works', command: 'true' }],
        requiredCapabilities: ['fly-to-moon'],
      }],
    }, exec(ROOT_SESSION))) as string
    expect(feedback).toContain('task_decompose rejected: task-runtime: admission rejected decomposition')
    expect(feedback).toContain('capability gap: child 0 is missing [fly-to-moon]')
    expect(feedback).toContain('L4 exit (KISS §7): report this to a human with the escalate tool')
    expect(feedback).toContain('what: capabilities [fly-to-moon] are not granted by the capability registry')

    // The gap also raised the in-plane obligation (W27) — a different record for
    // a different reader; the escalation card does not replace or duplicate it.
    expect((await task.snapshotIn(STORE)).obligations).toHaveLength(1)

    // The root turns that feedback into the human-facing card.
    const raised = (await tools.get('escalate')!.execute({
      ...card,
      sourceTaskId: rootTaskId,
      sourceRefs: [`task:${rootTaskId}`],
    }, exec(ROOT_SESSION))) as string
    expect(raised).toContain(`recorded [open] trigger: capability-gap`)

    const ledger = (await readFile(join(home, 'escalations.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger).toHaveLength(1)
    expect(JSON.parse(ledger[0]!)).toMatchObject({
      kind: 'raised',
      trigger: 'capability-gap',
      sourceTaskId: rootTaskId,
      sourceRefs: [`task:${rootTaskId}`],
      approvalRef: 'approval:call-1',
    })
  } finally {
    vi.unstubAllEnvs()
  }
})

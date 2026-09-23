import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt, { renderPrompt } from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry, assembleContextFor } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import { createScope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import SessionStore, { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import { createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { SystemPromptProjection } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/types/runtime-context.js'
import type { Agent, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TaskInstance, TaskRun } from '../../task/src/types.ts'
import { buildHandoff } from '../../task-runtime/src/handoff.ts'
import { renderWorkerContract, WORKER_CONTRACT_OPEN } from '../../task-runtime/src/contract.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'

/**
 * The contract reinjection, end to end on the real seams it uses: the real
 * `systemPrompt` registry (the section is a real registration, assembled for
 * real), the real `AgentRuntime.spawn` setup path, the real `Session` store, and
 * the real `SystemPromptProjection` the agent loop drives on every step.
 *
 * Only `dsh-agent-loop` is replaced — the stub factory mints the agent scope and
 * awaits `setup`, exactly the contract the loop's own factory honours — so what
 * is asserted here is what the model would be sent on an ordinary step and after
 * a fold, not a paraphrase of it.
 *
 * The `SystemPromptProjection` import reaches into the upstream package's emitted
 * files because the class is not on that package's export map (`@deepseek-ai/dsh-agent-loop`
 * exports `.` and `./invariant` only). It is the mechanism under test: a change
 * there should break this test rather than pass silently.
 */

const ROOT_SESSION = 's-root' as SessionId
const NOW = '2026-09-16T00:00:00.000Z'
const SPAWN_PROMPT = 'do the work'

/** The three route/series shapes the loop hands `project` (`agent-loop/src/agent.ts:365-370`). */
const REPLACING = { inHistory: false, startsSeries: false }
const CONTINUING = { inHistory: true, startsSeries: false }
const NEW_SERIES = { inHistory: true, startsSeries: true }

/** Exactly the root agent's allow-list (`agent-runtime/src/index.ts`), so the root setup path runs for real. */
const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'skill', 'task_decompose',
  'task_submit_result', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: async () => name,
  }
}

function task(): TaskInstance {
  return {
    taskId: 'c1',
    definitionRef: { taskType: 'subtask', version: 1 },
    parentTaskId: 'root',
    objective: 'implement the feature',
    depth: 1,
    acceptanceCriteria: [
      { criterionId: 'ac1-1', description: 'unit tests pass', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'pnpm test' },
    ],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'admitted',
    runIds: [],
    childTaskIds: [],
  }
}

function parentRun(): TaskRun {
  return {
    runId: 'r-root',
    taskId: 'root',
    sessionId: ROOT_SESSION,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
  }
}

/** The real block the task runtime hands a spawn, so this test cannot drift from what a worker is sent. */
const CONTRACT = renderWorkerContract(
  task(),
  buildHandoff({
    parentTask: { ...task(), taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' },
    parentRun: parentRun(),
    childTask: task(),
    reason: 'split the work',
    callerSessionId: ROOT_SESSION,
    constraints: ['no network'],
  }),
)

let cwd: string
let previousHome: string | undefined
const contexts: Context[] = []

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'worker-contract-int-'))
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
  /** The system prompt the worker's next step would assemble, rendered as the loop renders it. */
  promptOf(agent: Agent): Promise<string>
  spawn(contract?: string): Promise<Agent>
}

/** Boot the registry stack a worker is created through, with the real session store behind it. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  // `skill` mounts on the preset plane in the deployment (`tool-skill`); the rest are global.
  for (const name of ROOT_TOOLS) if (name !== 'skill') ctx.tools.register(tool(name))
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: vi.fn() })
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

  // A preset's standing mount lives in its own scope; an agent joins it by parentage.
  const presetKey = { id: 'preset:standard' }
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, presetKey).ctx.tools.register(tool('skill')) }, { inject: ['tools', 'systemPrompt'] }))

  const runtime = new AgentRuntime(ctx)
  const mint = async (
    sessionId: SessionId,
    setup: ((agentCtx: Context, agent: Agent) => Promise<unknown>) | undefined,
  ): Promise<Agent> => {
    const agent = {
      id: sessionId,
      followup: vi.fn(),
      cancel: vi.fn(),
      session: { id: sessionId, header: { id: sessionId, cwd, agentPreset: 'standard' }, append: vi.fn() },
    } as unknown as Agent
    let scope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent, { parent: presetKey })
    }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    await (ctx.agents.register(agent) as unknown as Promise<void>)
    return agent
  }
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, options: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.sessionId, options.setup), dispose: async () => {} }),
    resume: async (_ownerCtx: Context, options: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.resumeSessionId, options.setup), dispose: async () => {} }),
  } as never)

  await runtime.ensureRoot(ROOT_SESSION, { graphStoreId: 'g', layoutStoreId: 'l' })
  const root = ctx.agents.get(ROOT_SESSION)!

  let children = 0
  return {
    ctx,
    root,
    async promptOf(agent) {
      const agentCtx = (agent as unknown as { ctx: Context }).ctx
      return renderPrompt(await agentCtx.systemPrompt.assemble(assembleContextFor(agent)))
    },
    async spawn(contract) {
      children += 1
      const handle = await runtime.spawn(root, {
        sessionId: `s-child-${children}` as SessionId,
        name: 'worker',
        prompt: [{ type: 'text', text: SPAWN_PROMPT }],
        ...(contract === undefined ? {} : { contract }),
      })
      return handle.agent
    },
  }
}

describe('the worker contract rides the system prompt', () => {
  it('is registered only for a worker whose spawn carried it', async () => {
    const h = await harness()
    const worker = await h.spawn(CONTRACT)

    const workerPrompt = await h.promptOf(worker)
    expect(workerPrompt).toContain(WORKER_CONTRACT_OPEN)
    expect(workerPrompt).toContain('implement the feature')
    expect(workerPrompt).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test |')
    // One copy, not a stack: this is a section, not an appended reminder.
    expect(workerPrompt.split(WORKER_CONTRACT_OPEN)).toHaveLength(2)

    const bare = await h.spawn()
    expect(await h.promptOf(bare)).not.toContain(WORKER_CONTRACT_OPEN)
  })

  it('never reaches the root agent', async () => {
    const h = await harness()
    await h.spawn(CONTRACT)
    // A root is never handed a contract, so its prompt stays exactly what the
    // composition gave it.
    expect(await h.promptOf(h.root)).not.toContain(WORKER_CONTRACT_OPEN)
  })

  it('registers nothing for a blank contract', async () => {
    const h = await harness()
    const worker = await h.spawn('   \n ')
    expect(await h.promptOf(worker)).not.toContain(WORKER_CONTRACT_OPEN)
  })
})

describe('what the projection does with the contract, step after step', () => {
  async function projected(): Promise<{ session: Session; rendered: string }> {
    const h = await harness()
    const worker = await h.spawn(CONTRACT)
    const rendered = await h.promptOf(worker)
    return { session: h.ctx.sessions.create(SessionId('s-worker')), rendered }
  }

  function commit(session: Session, candidate: ReturnType<SystemPromptProjection['project']>[number] | undefined) {
    if (candidate === undefined) throw new Error('expected a system-prompt commit')
    return session.append('system/message', { turn: 1, step: 1, message: candidate.message }, candidate.intent)
  }

  function appendUser(session: Session, text: string) {
    return session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }

  function textOf(session: Session, index: number): string {
    const block = session.deriveMessages()[index]?.content[0]
    return block?.type === 'text' ? block.text : ''
  }

  it('reserves node 0 once and then writes nothing while the contract is unchanged', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)

    const first = projection.project(rendered, REPLACING)
    expect(first).toHaveLength(1)
    expect(first[0]!.intent).toEqual({ surfaceOp: 'append' })
    commit(session, first[0])
    expect(textOf(session, 0)).toContain(WORKER_CONTRACT_OPEN)

    // Every later step re-projects the same text and commits nothing — which is
    // the whole difference between reinjecting a contract and spamming one.
    expect(projection.project(rendered, REPLACING)).toEqual([])
    expect(session.surface.nodes).toHaveLength(1)
  })

  it('keeps the contract on the surface after a fold shadows the spawn prompt, with no extra write', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)
    commit(session, projection.project(rendered, REPLACING)[0])
    const spawnSeq = appendUser(session, SPAWN_PROMPT).seq
    expect(session.deriveMessages()).toHaveLength(2)

    // Compaction folds the spawn prompt into a checkpoint: the session's only
    // other copy of the contract is gone.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Earlier work summarised.' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: spawnSeq, endSeq: spawnSeq },
      sourceEventSeqs: [spawnSeq],
    })
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
    expect(textOf(session, 1)).toBe('Earlier work summarised.')

    // The surface was replaced, so this step re-projects...
    expect(projection.project(rendered, { inHistory: false, startsSeries: true })).toEqual([])
    // ...and the contract is still the first thing the model reads.
    expect(textOf(session, 0)).toContain(WORKER_CONTRACT_OPEN)
    expect(textOf(session, 0)).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test |')
  })

  it('writes the contract back exactly once when the surface lost it, then goes quiet', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)
    commit(session, projection.project(rendered, REPLACING)[0])

    // A prompt that no longer carries the section leaves node 0 empty: the
    // contract is outside the visible surface.
    const emptied = projection.project('', REPLACING)
    expect(emptied).toHaveLength(1)
    commit(session, emptied[0])
    expect(session.deriveMessages()).toEqual([])

    const restored = projection.project(rendered, REPLACING)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.intent).toMatchObject({ surfaceOp: { op: 'replace' } })
    commit(session, restored[0])
    expect(textOf(session, 0)).toContain(WORKER_CONTRACT_OPEN)
    expect(session.deriveMessages()).toHaveLength(1)

    expect(projection.project(rendered, REPLACING)).toEqual([])
    expect(session.deriveMessages()).toHaveLength(1)
  })

  it('holds on an in-history route too: a changed prompt appends once, a new series collapses back', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)
    commit(session, projection.project(rendered, REPLACING)[0])
    appendUser(session, SPAWN_PROMPT)

    // `in-history` routes read the LAST system node as the effective prompt, so
    // a changed prompt is appended rather than replacing node 0.
    const appended = projection.project(`${rendered}\n\n## Runtime context\n\ncurrent step: 2`, CONTINUING)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.intent).toEqual({ surfaceOp: 'append' })
    commit(session, appended[0])
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user', 'system'])
    expect(textOf(session, 0)).toContain(WORKER_CONTRACT_OPEN)
    expect(textOf(session, 2)).toContain(WORKER_CONTRACT_OPEN)

    // A new series (the surface was replaced) empties the tail rather than
    // leaving two live prompts behind; node 0 already holds this text, so the
    // collapse costs exactly that one write.
    const collapsed = projection.project(rendered, NEW_SERIES)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.intent).toMatchObject({ surfaceOp: { op: 'replace' } })
    for (const update of collapsed) commit(session, update)
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
    expect(textOf(session, 0)).toContain(WORKER_CONTRACT_OPEN)
    expect(projection.project(rendered, NEW_SERIES)).toEqual([])
  })
})

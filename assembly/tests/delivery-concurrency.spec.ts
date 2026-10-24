import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { hostRequire } from '../../scripts/host-config.mjs'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { loadDomain } from '../src/domain.ts'
import { workflowSteps } from '../src/evaluation-cost.ts'
import { spawnProcess } from '../src/process.ts'
import { decompose, propose } from '../src/surfaces.ts'
import { attachmentsAt, testProjections } from './seam.ts'

const { default: SystemPrompt } = (await import(
  hostRequire().resolve('@deepseek-ai/dsh-system-prompt')
)) as typeof import('@deepseek-ai/dsh-system-prompt')

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-concurrency-'))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentRegistry])
    await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const { agent } = await ctx.agents.create({ sessionId: SessionId('parent'), meta: { cwd: directory } })
  return { ctx, directory, agent }
}

const notice = schedulerMessage(
  {
    kind: 'singularity',
    purpose: 'branch-outcome',
    controlId: 'concurrency',
    parentTaskId: 'parent-task',
    taskId: 'child-task',
    runId: 'parent-run',
    factSeq: 1,
  },
  'The independently accepted child has finished.',
)

it('delivers a branch outcome when the parent appends events as its flush completes', async () => {
  const { ctx, agent } = await fixture()
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [] }), {
    surfaceOp: 'append',
  })
  let prefix: readonly SessionEvent[] = []
  const seams: ChildSessionSeams = {
    sessions: {
      flush: async () => {
        const durable = await ctx.sessions.flush(agent.session)
        const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
        try {
          prefix = (await handle.read()).events
        } finally {
          await handle.close()
        }
        // Another turn can advance after the writer drains, before the flush caller resumes.
        agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
        return durable
      },
    } as unknown as SessionStore,
    sessionPersistence: {
      open: async () => ({
        id: agent.session.id,
        // A read is allowed to see only the prefix that the barrier actually flushed.
        read: async (from = 0, count?: number) => ({
          events: prefix.slice(from, count === undefined ? undefined : from + count),
          eventState: 'detached',
        }),
        close: async () => undefined,
      }),
    } as unknown as SessionPersistence,
  }
  let posted = 0
  const post = async () => {
    posted++
    agent.session.append('user/message', notice, { surfaceOp: 'append' })
  }
  expect(await postIdentifiedMessage(seams, agent, notice, post)).toBe('posted')
  expect(await postIdentifiedMessage(seams, agent, notice, post)).toBe('entered')
  expect(posted).toBe(1)
})

it('still refuses a prefix that was already incomplete before the flush', async () => {
  const { ctx, agent } = await fixture()
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [] }), {
    surfaceOp: 'append',
  })
  const seams: ChildSessionSeams = {
    sessions: ctx.sessions,
    sessionPersistence: {
      open: async () => ({ id: agent.session.id, read: async () => ({ events: [] }), close: async () => undefined }),
    } as unknown as SessionPersistence,
  }
  await expect(postIdentifiedMessage(seams, agent, notice, () => undefined)).rejects.toMatchObject({
    refusal: { code: 'write-not-durable' },
  })
})

it('counts an active sibling while another registered Run is still creating its native session', async () => {
  const { ctx, directory, agent } = await fixture()
  const apparatus = await openApparatus(
    'concurrency',
    directory,
    await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
    ctx.sessionPersistence,
    attachmentsAt(directory),
    testProjections,
  )
  cleanups.push(() => apparatus.store.close())
  const caller = {
    agentId: String(agent.id),
    sessionId: String(agent.session.id),
    model: { provider: 'fixture', model: 'test' },
  }
  const contract = (goal: string) => ({
    goal,
    artifact: 'result.txt',
    inputs: [],
    criteria: [{ criterionId: 'done', statement: goal }],
  })
  const root = await propose(apparatus, caller, 'start', {
    contract: contract('Integrate two complete results'),
    learning: false,
  })
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append(
    'user/message',
    schedulerMessage(
      {
        kind: 'singularity',
        controlId: apparatus.controlId,
        parentTaskId: root.taskId,
        factSeq: 0,
        purpose: 'dispatch',
        taskId: root.taskId,
        runId: root.runId,
      },
      'root',
    ),
    { surfaceOp: 'append' },
  )
  await decompose(apparatus, { advance: async () => [] }, caller, {
    taskId: root.taskId,
    children: ['first', 'second'].map(key => ({
      key,
      contract: contract('Produce ' + key),
      dependsOn: [],
      supports: ['done'],
      maxRuns: 1,
      requirement: 'required',
    })),
  })
  const children = taskStateOf(apparatus, root.taskId).decomposition!.children
  const sessionIds: string[] = []
  for (const child of children) {
    const agentId = taskStateOf(apparatus, child.taskId).responsibility!.agentId
    sessionIds.push(agentId)
    declareCaller(apparatus, agentId)
    await startAttempt(
      apparatus,
      { agentId, sessionId: agentId, model: caller.model },
      child.taskId,
      'start',
      root.method,
    )
  }
  const first = (await ctx.agents.create({ sessionId: SessionId(sessionIds[0]!), meta: { cwd: directory } })).agent
  first.session.append('turn/start', { turn: 1 })
  first.session.append('step/start', { turn: 1, step: 1 })
  await ctx.sessions.flush(agent.session)
  await ctx.sessions.flush(first.session)
  expect(await ctx.sessionPersistence.stat(SessionId(sessionIds[1]!))).toBeUndefined()
  const live = (id: string) => ctx.agents.get(SessionId(id))?.session.snapshotEvents()
  expect(await workflowSteps(apparatus, root.taskId, live)).toBe(2)
  expect(await workflowSteps(apparatus, root.taskId)).toBe(2)
  const second = (await ctx.agents.create({ sessionId: SessionId(sessionIds[1]!), meta: { cwd: directory } })).agent
  second.session.append('turn/start', { turn: 1 })
  second.session.append('step/start', { turn: 1, step: 1 })
  await ctx.sessions.flush(second.session)
  expect(await workflowSteps(apparatus, root.taskId, live)).toBe(3)
  expect(await workflowSteps(apparatus, root.taskId)).toBe(3)
  const failure = new Error('storage unavailable')
  await expect(
    workflowSteps(
      {
        ...apparatus,
        persistence: {
          open: async () => {
            throw failure
          },
        } as unknown as SessionPersistence,
      },
      root.taskId,
    ),
  ).rejects.toBe(failure)
})

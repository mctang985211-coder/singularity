import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionSeq, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildSessionRequest } from '../../src/runtime/child-session.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { openApparatus, callerOf, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { createNativeSolve, observeSolve } from '../src/native-solve.ts'
import { explorationOf } from '../src/improvement.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { submit } from '../src/submission.ts'
import { fixtureReview } from './review-fixture.ts'
import { agentFor, attachmentsAt, execFor, fakeExecution, FakePersistence, testProjections } from './seam.ts'
import { nativeTurn } from './usage-fixture.ts'
import { digestOf } from '../../src/protocol/envelope.ts'

const harness = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async original => ({
  ...(await original<object>()), openChildSession: harness.open,
}))
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); harness.open.mockReset() })

it.each(['business', 'runtime', 'cancelled'] as const)('counts a %s failure according to its committed cause, retaining its sealed trace', async cause => {
  const directory = await mkdtemp(join(tmpdir(), 'native-failure-'))
  const apparatus = await openApparatus('native-failure', directory,
    await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess),
    new FakePersistence() as never, attachmentsAt(directory), testProjections)
  cleanup = async () => { await apparatus.store.close(); await rm(directory, { recursive: true, force: true }) }
  const business = agentFor('business', 'business-session')
  const task = await propose(apparatus, callerOf(business), 'root', { goal: 'count' })
  await apparatus.tasks.forAgent('business').failRun({ commandId: 'failed', taskId: task.taskId, runId: task.runId,
    cause, reason: cause === 'business' ? 'required child did not meet its contract' : 'execution unavailable' })
  vi.spyOn(apparatus.persistence, 'open').mockImplementation(async id => ({
    header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }, inheritedEventCount: SessionLogOffset(0),
    read: async () => ({ events: nativeTurn(17) }), close: async () => undefined,
  }) as never)
  const result = await observeSolve(apparatus, task.taskId, task.runId, new AbortController().signal)
  expect(result).toMatchObject({ status: cause === 'business' ? 'no-submission' : 'infrastructure-failure',
    taskId: task.taskId, runId: task.runId, trajectory: { attachmentId: expect.stringMatching(/^sha256:/) } })
})

it.each([
  { complete: true, reused: false }, { complete: false, reused: false },
  { complete: true, reused: true }, { complete: false, reused: true },
])('counts only the current solve and acceptance with complete=$complete, reused=$reused', async ({ complete, reused }) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-cost-'))
  const apparatus = await openApparatus('native-cost', directory,
    await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess),
    new FakePersistence() as never, attachmentsAt(directory), testProjections)
  cleanup = async () => { await apparatus.store.close(); await rm(directory, { recursive: true, force: true }) }
  const business = agentFor('business', 'business-session')
  const root = await propose(apparatus, callerOf(business), 'root', { goal: 'count' })
  const analyst = agentFor('analyst', 'analyst-session')
  await propose(apparatus, callerOf(analyst), 'analysis', { goal: 'improve' },
    { purpose: 'improve', relatedTo: { taskId: root.taskId, runId: root.runId } })
  const method = taskStateOf(apparatus, root.taskId).runs[root.runId]!.revision
  const logs = new Map<string, SessionEvent[]>([['analyst-session', nativeTurn(9_000_000)]])
  const frozenLog = (tokens: number, turn = 1) => [
    ...nativeTurn(complete ? tokens : undefined, 0, turn),
    { seq: 5, time: 5, type: 'tool/call', data: { name: 'singularity_submit' } },
    ...nativeTurn(8_000_000, 6, turn + 1),
  ] as SessionEvent[]
  const readSessions: string[] = []
  vi.spyOn(apparatus.persistence, 'open').mockImplementation(async id => {
    readSessions.push(String(id))
    return { header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
      inheritedEventCount: SessionLogOffset(0), read: async () => ({ events: logs.get(String(id))! }), close: async () => undefined,
    } as never
  })
  harness.open.mockImplementation(async (_seams: unknown, request: ChildSessionRequest) => {
    const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .findLast(task => Object.values(task.runs).at(-1)!.purpose === 'evaluation')!
    const run = Object.values(task.runs).at(-1)!
    const sessionId = task.responsibility!.agentId
    const worker = agentFor(sessionId, sessionId)
    return { sessionId, stop: () => undefined, close: async () => undefined, wait: async () => {
      const current = frozenLog(10, reused ? 3 : 1)
      current.splice(2, 0, { type: 'user/message', data: request.message } as SessionEvent)
      if (reused) {
        // A previous Task has both unreported and very large usage, then its own submission.
        // Neither its bill nor its missing sample belongs to the new dispatch.
        const prefix = [...nativeTurn(undefined), ...nativeTurn(9_000_000, 5, 2),
          { type: 'tool/call', data: { name: 'singularity_submit' } }]
        logs.set(sessionId, [...prefix, ...current].map((event, index) => ({ ...event, seq: SessionSeq(index), time: index })) as SessionEvent[])
      } else logs.set(sessionId, current.map((event, index) => ({ ...event, seq: SessionSeq(index), time: index })))
      await writeFile(join(run.bubble!.workspace.ref, task.contract!.artifact), '35')
      await submit(apparatus, { ...fakeExecution(() => undefined), sealTranscript: async () => {
        const events = logs.get(sessionId)!.slice(0, reused ? 18 : 7), eventCount = events.length
        return { sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }) }
      } }, callerOf(worker), execFor(worker, request.agentId),
        { taskId: task.taskId, path: task.contract!.artifact }, new AbortController().signal, fixtureReview(apparatus))
      if (reused) {
        const later = nativeTurn(7_000_000, 0, 5)
        later.splice(2, 0, { type: 'user/message', data: { ...request.message,
          source: { ...request.message!.source, taskId: 'later-task' } } } as SessionEvent)
        logs.set(sessionId, [...logs.get(sessionId)!, ...later, { type: 'tool/call', data: { name: 'singularity_submit' } }]
          .map((event, index) => ({ ...event, seq: SessionSeq(index), time: index })) as SessionEvent[])
      }
      const review = [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()]
        .find(review => review.target.kind === 'acceptance' && review.target.taskId === task.taskId)!
      logs.set(review.sessionId, frozenLog(20))
    } }
  })
  const solve = createNativeSolve(apparatus, {} as never, analyst, new AbortController().signal)
  for (const overhead of [9_000_000, 900_000_000]) {
    logs.set('analyst-session', [...nativeTurn(overhead), { seq: SessionSeq(5), time: 5, type: 'singularity/memory-call',
      ignorable: true, data: { memoryId: 'previous-rsi-handoff', phase: 'settled', callSeq: 0, dispatched: true, stream: [] } }])
    const result = await solve({ revision: method, operationId: `trial-${overhead}`, started: async () => undefined })
    expect(result).toMatchObject({ quality: 1, met: true, cost: complete ? 30 : null })
    expect(result.costBasis!.sessions.map(session => ({ from: session.from, end: session.end, tokens: session.tokens })))
      .toEqual([{ from: reused ? 12 : 1, end: reused ? 18 : 7, tokens: complete ? 10 : 0 }, { from: 0, end: 6, tokens: complete ? 20 : 0 }])
    expect(result.costBasis!.sessions.every(session => session.complete)).toBe(complete)
    const frozen = JSON.parse((await explorationOf(apparatus, result.taskId, result.runId)).toString('utf8'))
    expect(frozen.summary.usage.tokens).toBe(complete ? 30 : 0)
    expect(frozen.summary.usage.complete).toBe(complete)
    expect(frozen.sessions[0].events).toHaveLength(reused ? 18 : 7)
    expect(frozen.summary.sessions[0].from).toBe(reused ? 12 : 1)
  }
  expect(readSessions).not.toContain('analyst-session')
  expect(readSessions).not.toContain('business-session')
})

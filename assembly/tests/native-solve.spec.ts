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
import { createNativeSolve } from '../src/native-solve.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { submit } from '../src/submission.ts'
import { fixtureReview } from './review-fixture.ts'
import { agentFor, attachmentsAt, execFor, fakeExecution, FakePersistence, testProjections } from './seam.ts'
import { nativeTurn } from './usage-fixture.ts'

const harness = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async original => ({
  ...(await original<object>()), openChildSession: harness.open,
}))
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); harness.open.mockReset() })

it('counts only the independent solve and acceptance once, regardless of RSI usage or post-submission messages', async () => {
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
  const frozenLog = (tokens: number) => [
    ...nativeTurn(tokens),
    { seq: 5, time: 5, type: 'tool/call', data: { name: 'singularity_submit' } },
    ...nativeTurn(8_000_000, 6, 2),
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
      await writeFile(join(run.bubble!.workspace.ref, task.contract!.artifact), '35')
      await submit(apparatus, fakeExecution(() => undefined), callerOf(worker), execFor(worker, request.agentId),
        { taskId: task.taskId, path: task.contract!.artifact }, new AbortController().signal, fixtureReview(apparatus))
      logs.set(sessionId, frozenLog(10))
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
    expect(result).toMatchObject({ quality: 1, met: true, cost: 30 })
    expect(result.costBasis!.sessions.map(session => ({ end: session.end, tokens: session.tokens })))
      .toEqual([{ end: 6, tokens: 10 }, { end: 6, tokens: 20 }])
  }
  expect(readSessions).not.toContain('analyst-session')
  expect(readSessions).not.toContain('business-session')
})

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
import { readTemplate, templateDeclaration } from '../src/template.ts'
import { contractFor } from '../src/inputs.ts'

const harness = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async original => ({
  ...(await original<object>()),
  openChildSession: harness.open,
}))
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  vi.restoreAllMocks()
  harness.open.mockReset()
})

it('scores the frozen non-guard rubric from sealed review evidence without accepting a failed Task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-rubric-'))
  const domain = await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess)
  const original = domain.templates.get(domain.rootTemplate!)!
  const root = await readTemplate(
    domain.dir,
    {
      ...templateDeclaration(original),
      criteria: [
        ...original.criteria,
        { criterionId: 'format', statement: 'the report is decimal text' },
        { criterionId: 'scope', statement: 'protected inputs were preserved' },
      ],
    },
    domain.verifiers,
    'rubric template',
  )
  const apparatus = await openApparatus(
    'native-rubric',
    directory,
    { ...domain, templates: new Map([...domain.templates, [root.id, root]]) },
    new FakePersistence() as never,
    attachmentsAt(directory),
    testProjections,
  )
  cleanup = async () => {
    await apparatus.store.close()
    await rm(directory, { recursive: true, force: true })
  }
  const worker = agentFor('rubric-worker', 'rubric-worker-session')
  const trial = await propose(apparatus, callerOf(worker), 'rubric', {
    contract: contractFor(apparatus.domain, root, root.goal),
  })
  await writeFile(join(trial.workspace, trial.contract.artifact), '999')
  await submit(
    apparatus,
    fakeExecution(() => undefined),
    callerOf(worker),
    execFor(worker, 'submit-rubric'),
    { taskId: trial.taskId, path: trial.contract.artifact },
    new AbortController().signal,
    fixtureReview(apparatus),
  )
  vi.spyOn(apparatus.persistence, 'open').mockImplementation(
    async id =>
      ({
        header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
        read: async () => ({ events: nativeTurn(17) }),
        close: async () => undefined,
      }) as never,
  )
  const signal = new AbortController().signal
  expect(
    await observeSolve(apparatus, trial.taskId, trial.runId, signal, undefined, ['scope'], 'criteria'),
  ).toMatchObject({ quality: 0.5, met: false, guardsMet: true })
  expect(
    await observeSolve(apparatus, trial.taskId, trial.runId, signal, undefined, ['letters'], 'criteria'),
  ).toMatchObject({ quality: 1, met: false, guardsMet: false })
  expect(await observeSolve(apparatus, trial.taskId, trial.runId, signal)).toMatchObject({ quality: 0, met: false })
  const measure = vi.fn(async () => ({ quality: 1.75, metrics: { area: { value: 55, unit: 'um2' } } }))
  const scored = await observeSolve(apparatus, trial.taskId, trial.runId, signal, { digest: 'a'.repeat(64), measure }, [
    'letters',
  ])
  expect(scored).toMatchObject({
    quality: 1.75,
    met: false,
    guardsMet: false,
    measurement: { quality: 1.75, metrics: { area: { value: 55, unit: 'um2' } } },
  })
  expect(measure).toHaveBeenCalledWith('999', signal, {
    taskId: trial.taskId,
    runId: trial.runId,
    contract: trial.contract,
  })
  const ineligible = await observeSolve(
    apparatus,
    trial.taskId,
    trial.runId,
    signal,
    {
      digest: 'a'.repeat(64),
      measure: async () => ({ status: 'business-failure', reason: 'candidate is not synthesizable' }),
    },
    ['scope'],
  )
  expect(ineligible).toMatchObject({
    status: 'business-failure',
    reason: 'candidate is not synthesizable',
    taskId: trial.taskId,
    runId: trial.runId,
    trajectory: { attachmentId: expect.stringMatching(/^sha256:/) },
  })
  expect(ineligible.cost).toBe(scored.cost)
  expect(ineligible.costBasis).toEqual(scored.costBasis)
  expect(ineligible).not.toHaveProperty('quality')
  expect(
    await observeSolve(
      apparatus,
      trial.taskId,
      trial.runId,
      signal,
      {
        digest: 'a'.repeat(64),
        measure: async () => {
          throw Error('EDA unavailable')
        },
      },
      ['scope'],
    ),
  ).toMatchObject({ status: 'infrastructure-failure', reason: expect.stringContaining('EDA unavailable') })
  const unavailableWorker = agentFor('unavailable-worker', 'unavailable-worker-session')
  const unavailable = await propose(apparatus, callerOf(unavailableWorker), 'unavailable-rubric', {
    contract: contractFor(apparatus.domain, root, root.goal),
  })
  await writeFile(join(unavailable.workspace, unavailable.contract.artifact), '35')
  await submit(
    apparatus,
    fakeExecution(() => undefined),
    callerOf(unavailableWorker),
    execFor(unavailableWorker, 'submit-unavailable'),
    { taskId: unavailable.taskId, path: unavailable.contract.artifact },
    signal,
    fixtureReview(apparatus, 'unknown'),
  )
  expect(
    await observeSolve(apparatus, unavailable.taskId, unavailable.runId, signal, undefined, ['scope'], 'criteria'),
  ).toMatchObject({ status: 'review-inconclusive', reason: expect.stringContaining('review is inconclusive') })
  const unmeasured = vi.fn(async () => 1.25)
  const unknown = await observeSolve(
    apparatus,
    unavailable.taskId,
    unavailable.runId,
    signal,
    { digest: 'a'.repeat(64), measure: unmeasured },
    ['scope'],
  )
  expect(unknown).toMatchObject({
    status: 'review-inconclusive',
    reason: expect.stringContaining('letters'),
    costBasis: { sessions: expect.any(Array) },
  })
  expect(unknown).not.toHaveProperty('quality')
  expect(unknown).not.toHaveProperty('measurement')
  expect(unmeasured).not.toHaveBeenCalled()
  const protectedWorker = agentFor('protected-unavailable', 'protected-unavailable-session')
  const protectedTrial = await propose(apparatus, callerOf(protectedWorker), 'protected-unavailable', {
    goal: 'count letters',
  })
  await writeFile(join(protectedTrial.workspace, protectedTrial.contract.artifact), '35')
  await submit(
    apparatus,
    fakeExecution(() => undefined),
    callerOf(protectedWorker),
    execFor(protectedWorker, 'protected-unavailable'),
    { taskId: protectedTrial.taskId, path: protectedTrial.contract.artifact },
    signal,
    (taskId, run, checks) =>
      fixtureReview(apparatus)(
        taskId,
        run,
        checks.map(check => ({ ...check, verdict: 'unknown', detail: 'Protected verifier is unavailable.' })),
      ),
  )
  expect(
    await observeSolve(apparatus, protectedTrial.taskId, protectedTrial.runId, signal, {
      digest: 'a'.repeat(64),
      measure: unmeasured,
    }),
  ).toMatchObject({ status: 'infrastructure-failure', reason: expect.stringContaining('letters') })
  expect(unmeasured).not.toHaveBeenCalled()
})

it('keeps a sealed submission without review evidence unavailable instead of throwing or measuring zero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-missing-review-'))
  const apparatus = await openApparatus(
    'native-missing-review',
    directory,
    await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
    new FakePersistence() as never,
    attachmentsAt(directory),
    testProjections,
  )
  cleanup = async () => {
    await apparatus.store.close()
    await rm(directory, { recursive: true, force: true })
  }
  const worker = agentFor('missing-review-worker', 'missing-review-session')
  const trial = await propose(apparatus, callerOf(worker), 'missing-review', { goal: 'count letters' })
  await writeFile(join(trial.workspace, trial.contract.artifact), '35')
  const signal = new AbortController().signal
  await expect(
    submit(
      apparatus,
      fakeExecution(() => undefined),
      callerOf(worker),
      execFor(worker, 'submit-missing-review'),
      { taskId: trial.taskId, path: trial.contract.artifact },
      signal,
      async (taskId, run) => {
        await apparatus.tasks.forAgent(String(worker.id)).failRun({
          commandId: 'business-stopped-before-review',
          taskId,
          runId: run.runId,
          cause: 'business',
          reason: 'business execution stopped before acceptance',
        })
        throw Error('review service unavailable')
      },
    ),
  ).rejects.toThrow('review service unavailable')
  expect(taskStateOf(apparatus, trial.taskId).runs[trial.runId]).toMatchObject({
    status: 'failed',
    evidence: [],
    submission: { artifactDigest: expect.any(String) },
  })
  vi.spyOn(apparatus.persistence, 'open').mockImplementation(
    async id =>
      ({
        header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
        read: async () => ({ events: nativeTurn(17) }),
        close: async () => undefined,
      }) as never,
  )
  const measure = vi.fn(async () => 0)
  const result = await observeSolve(apparatus, trial.taskId, trial.runId, signal, { digest: 'a'.repeat(64), measure })
  expect(result).toMatchObject({
    status: 'infrastructure-failure',
    reason: expect.stringContaining('letters'),
    trajectory: { attachmentId: expect.stringMatching(/^sha256:/) },
  })
  expect(result).not.toHaveProperty('quality')
  expect(measure).not.toHaveBeenCalled()
})

it('retains recorded usage when a cancelled solve ends without its final billing sample', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-cancelled-cost-'))
  const apparatus = await openApparatus(
    'native-cancelled-cost',
    directory,
    await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
    new FakePersistence() as never,
    attachmentsAt(directory),
    testProjections,
  )
  cleanup = async () => {
    await apparatus.store.close()
    await rm(directory, { recursive: true, force: true })
  }
  const worker = agentFor('cancelled-worker', 'cancelled-session')
  const trial = await propose(apparatus, callerOf(worker), 'cancelled', { goal: 'count letters' })
  await apparatus.tasks.forAgent(String(worker.id)).failRun({
    commandId: 'cancel-interrupted-solve',
    taskId: trial.taskId,
    runId: trial.runId,
    cause: 'cancelled',
    reason: 'operator paused the unfinished solve',
  })
  const events = [...nativeTurn(17), ...nativeTurn(undefined, 5, 2)]
  // This is the same dispatch used by a native solve, before its recorded and interrupted calls.
  events.splice(2, 0, {
    type: 'user/message',
    data: {
      source: { kind: 'singularity', controlId: apparatus.controlId, taskId: trial.taskId, purpose: 'dispatch' },
    },
  } as SessionEvent)
  vi.spyOn(apparatus.persistence, 'open').mockImplementation(
    async id =>
      ({
        header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
        read: async () => ({
          events: events.map((event, index) => ({ ...event, seq: SessionSeq(index), time: index })),
        }),
        close: async () => undefined,
      }) as never,
  )
  const result = await observeSolve(apparatus, trial.taskId, trial.runId, new AbortController().signal)
  expect(result).toMatchObject({
    status: 'infrastructure-failure',
    cost: 17,
    costBasis: { sessions: [{ sessionId: worker.session.id, tokens: 17, complete: false }] },
  })
  expect(result).not.toHaveProperty('quality')
})

it.each(['fail', 'partial'] as const)(
  'retains explicit %s acceptance as a business result with its measured evidence',
  async verdict => {
    const directory = await mkdtemp(join(tmpdir(), 'native-business-review-'))
    const apparatus = await openApparatus(
      'native-business-review',
      directory,
      await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
      new FakePersistence() as never,
      attachmentsAt(directory),
      testProjections,
    )
    cleanup = async () => {
      await apparatus.store.close()
      await rm(directory, { recursive: true, force: true })
    }
    const worker = agentFor('business-review-worker', 'business-review-session')
    const trial = await propose(apparatus, callerOf(worker), 'business-review', {
      contract: {
        goal: 'implement a local module',
        artifact: 'design.v',
        inputs: [],
        criteria: [{ criterionId: 'correct', statement: 'the local module meets its interface' }],
      },
    })
    await writeFile(join(trial.workspace, trial.contract.artifact), 'candidate module')
    const signal = new AbortController().signal
    await submit(
      apparatus,
      fakeExecution(() => undefined),
      callerOf(worker),
      execFor(worker, 'submit-business-review'),
      { taskId: trial.taskId, path: trial.contract.artifact },
      signal,
      fixtureReview(apparatus, verdict),
    )
    vi.spyOn(apparatus.persistence, 'open').mockImplementation(
      async id =>
        ({
          header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
          inheritedEventCount: SessionLogOffset(0),
          read: async () => ({ events: nativeTurn(17) }),
          close: async () => undefined,
        }) as never,
    )
    const measure = vi.fn(async () => ({ quality: 1.25, metrics: { area: { value: 50, unit: 'cells' } } }))
    const result = await observeSolve(apparatus, trial.taskId, trial.runId, signal, { digest: 'a'.repeat(64), measure })
    expect(result).toMatchObject({
      met: false,
      quality: 1.25,
      criteria: [{ criterionId: 'correct', verdict }],
      measurement: { metrics: { area: { value: 50, unit: 'cells' } } },
    })
    expect(result).not.toHaveProperty('status')
    expect(measure).toHaveBeenCalledOnce()
  },
)

it.each(['business', 'runtime', 'cancelled'] as const)(
  'counts a %s failure according to its committed cause, retaining its sealed trace',
  async cause => {
    const directory = await mkdtemp(join(tmpdir(), 'native-failure-'))
    const apparatus = await openApparatus(
      'native-failure',
      directory,
      await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
      new FakePersistence() as never,
      attachmentsAt(directory),
      testProjections,
    )
    cleanup = async () => {
      await apparatus.store.close()
      await rm(directory, { recursive: true, force: true })
    }
    const business = agentFor('business', 'business-session')
    const task = await propose(apparatus, callerOf(business), 'root', { goal: 'count' })
    await apparatus.tasks.forAgent('business').failRun({
      commandId: 'failed',
      taskId: task.taskId,
      runId: task.runId,
      cause,
      reason: cause === 'business' ? 'required child did not meet its contract' : 'execution unavailable',
    })
    vi.spyOn(apparatus.persistence, 'open').mockImplementation(
      async id =>
        ({
          header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
          inheritedEventCount: SessionLogOffset(0),
          read: async () => ({ events: nativeTurn(17) }),
          close: async () => undefined,
        }) as never,
    )
    const result = await observeSolve(apparatus, task.taskId, task.runId, new AbortController().signal)
    expect(result).toMatchObject({
      status: cause === 'business' ? 'no-submission' : 'infrastructure-failure',
      taskId: task.taskId,
      runId: task.runId,
      trajectory: { attachmentId: expect.stringMatching(/^sha256:/) },
    })
  },
)

it.each([
  { complete: true, reused: false, partial: false },
  { complete: false, reused: false, partial: false },
  { complete: false, reused: false, partial: true },
  { complete: true, reused: true, partial: false },
  { complete: false, reused: true, partial: false },
  { complete: false, reused: true, partial: true },
])(
  'counts only the current solve and acceptance with complete=$complete, reused=$reused, partial=$partial',
  async ({ complete, reused, partial }) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-cost-'))
    const apparatus = await openApparatus(
      'native-cost',
      directory,
      await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
      new FakePersistence() as never,
      attachmentsAt(directory),
      testProjections,
    )
    cleanup = async () => {
      await apparatus.store.close()
      await rm(directory, { recursive: true, force: true })
    }
    const business = agentFor('business', 'business-session')
    const root = await propose(apparatus, callerOf(business), 'root', { goal: 'count' })
    const analyst = agentFor('analyst', 'analyst-session')
    await propose(
      apparatus,
      callerOf(analyst),
      'analysis',
      { goal: 'improve' },
      { purpose: 'improve', relatedTo: { taskId: root.taskId, runId: root.runId } },
    )
    const method = taskStateOf(apparatus, root.taskId).runs[root.runId]!.revision
    const logs = new Map<string, SessionEvent[]>([['analyst-session', nativeTurn(9_000_000)]])
    const frozenLog = (tokens: number, turn = 1) =>
      [
        ...nativeTurn(complete || (partial && tokens === 10) ? tokens : undefined, 0, turn),
        { seq: 5, time: 5, type: 'tool/call', data: { name: 'singularity_submit' } },
        ...nativeTurn(8_000_000, 6, turn + 1),
      ] as SessionEvent[]
    const readSessions: string[] = []
    vi.spyOn(apparatus.persistence, 'open').mockImplementation(async id => {
      readSessions.push(String(id))
      return {
        header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
        inheritedEventCount: SessionLogOffset(0),
        read: async () => ({ events: logs.get(String(id))! }),
        close: async () => undefined,
      } as never
    })
    harness.open.mockImplementation(async (_seams: unknown, request: ChildSessionRequest) => {
      const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].findLast(
        task => Object.values(task.runs).at(-1)!.purpose === 'evaluation',
      )!
      const run = Object.values(task.runs).at(-1)!
      const sessionId = task.responsibility!.agentId
      const worker = agentFor(sessionId, sessionId)
      return {
        sessionId,
        stop: () => undefined,
        close: async () => undefined,
        wait: async () => {
          const current = frozenLog(10, reused ? 3 : 1)
          current.splice(2, 0, { type: 'user/message', data: request.message } as SessionEvent)
          if (reused) {
            // A previous Task has both unreported and very large usage, then its own submission.
            // Neither its bill nor its missing sample belongs to the new dispatch.
            const prefix = [
              ...nativeTurn(undefined),
              ...nativeTurn(9_000_000, 5, 2),
              { type: 'tool/call', data: { name: 'singularity_submit' } },
            ]
            logs.set(
              sessionId,
              [...prefix, ...current].map((event, index) => ({
                ...event,
                seq: SessionSeq(index),
                time: index,
              })) as SessionEvent[],
            )
          } else
            logs.set(
              sessionId,
              current.map((event, index) => ({ ...event, seq: SessionSeq(index), time: index })),
            )
          await writeFile(join(run.bubble!.workspace.ref, task.contract!.artifact), '35')
          await submit(
            apparatus,
            {
              ...fakeExecution(() => undefined),
              sealTranscript: async () => {
                const events = logs.get(sessionId)!.slice(0, reused ? 18 : 7),
                  eventCount = events.length
                return { sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }) }
              },
            },
            callerOf(worker),
            execFor(worker, request.agentId),
            { taskId: task.taskId, path: task.contract!.artifact },
            new AbortController().signal,
            fixtureReview(apparatus),
          )
          if (reused) {
            const later = nativeTurn(7_000_000, 0, 5)
            later.splice(2, 0, {
              type: 'user/message',
              data: { ...request.message, source: { ...request.message!.source, taskId: 'later-task' } },
            } as SessionEvent)
            logs.set(
              sessionId,
              [...logs.get(sessionId)!, ...later, { type: 'tool/call', data: { name: 'singularity_submit' } }].map(
                (event, index) => ({ ...event, seq: SessionSeq(index), time: index }),
              ) as SessionEvent[],
            )
          }
          const review = [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find(
            review => review.target.kind === 'acceptance' && review.target.taskId === task.taskId,
          )!
          logs.set(review.sessionId, frozenLog(20))
        },
      }
    })
    const solve = createNativeSolve(apparatus, {} as never, analyst, new AbortController().signal)
    for (const overhead of [9_000_000, 900_000_000]) {
      logs.set('analyst-session', [
        ...nativeTurn(overhead),
        {
          seq: SessionSeq(5),
          time: 5,
          type: 'singularity/memory-call',
          ignorable: true,
          data: { memoryId: 'previous-rsi-handoff', phase: 'settled', callSeq: 0, dispatched: true, stream: [] },
        },
      ])
      const result = await solve({ revision: method, operationId: `trial-${overhead}`, started: async () => undefined })
      expect(result).toMatchObject({ quality: 1, met: true, cost: complete ? 30 : partial ? 10 : 0 })
      const ineligible = await observeSolve(apparatus, result.taskId, result.runId, new AbortController().signal, {
        digest: 'a'.repeat(64),
        measure: async () => ({
          status: 'business-failure',
          reason: 'functional candidate failed physical qualification',
        }),
      })
      expect(ineligible).toMatchObject({
        status: 'business-failure',
        reason: 'functional candidate failed physical qualification',
        taskId: result.taskId,
        runId: result.runId,
        cost: complete ? 30 : partial ? 10 : 0,
        costBasis: result.costBasis,
      })
      expect(ineligible).not.toHaveProperty('quality')
      expect(
        result.costBasis!.sessions.map(session => ({ from: session.from, end: session.end, tokens: session.tokens })),
      ).toEqual([
        { from: reused ? 12 : 1, end: reused ? 18 : 7, tokens: complete || partial ? 10 : 0 },
        { from: 0, end: 6, tokens: complete ? 20 : 0 },
      ])
      expect(result.costBasis!.sessions.every(session => session.complete)).toBe(complete)
      const frozen = JSON.parse((await explorationOf(apparatus, result.taskId, result.runId)).toString('utf8'))
      expect(frozen.summary.usage.tokens).toBe(complete ? 30 : partial ? 10 : 0)
      expect(frozen.summary.usage.complete).toBe(complete)
      expect(frozen.sessions[0].events).toHaveLength(reused ? 18 : 7)
      expect(frozen.summary.sessions[0].from).toBe(reused ? 12 : 1)
    }
    expect(readSessions).not.toContain('analyst-session')
    expect(readSessions).not.toContain('business-session')
  },
)

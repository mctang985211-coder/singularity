import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, expect, it, vi } from 'vitest'
import { digestOf } from '../../src/protocol/envelope.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import type { ChildSessionRequest } from '../../src/runtime/child-session.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { openDriver, type TaskDriver } from '../src/driver.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import type { Admission } from '../src/execution.ts'
import { propose } from '../src/surfaces.ts'
import { submit } from '../src/submission.ts'
import { recordedVerdictDigest } from '../../src/task/protocol.ts'
import { REVIEW_DIGEST } from '../../src/review/protocol.ts'
import type { Apparatus } from '../src/apparatus.ts'
import { fixtureReview } from './review-fixture.ts'
import { agentFor, attachmentsAt, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const harness = vi.hoisted(() => ({ open: vi.fn(), solve: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async (original) => ({
  ...(await original<object>()),
  openChildSession: harness.open,
}))
vi.mock('../src/native-solve.ts', () => ({
  createNativeSolve: (apparatus: Apparatus) => (input: unknown) => harness.solve(apparatus, input),
}))
vi.mock('../src/review.ts', async (original) => ({
  ...(await original<object>()),
  reviewSubject: async (
    apparatus: Apparatus,
    _seams: unknown,
    _parent: unknown,
    _id: unknown,
    subject: { taskId: string; runId: string; checks: never[] },
  ) =>
    fixtureReview(apparatus)(
      subject.taskId,
      apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, subject.taskId)!.runs[subject.runId]!,
      subject.checks,
    ),
}))
const roots: string[] = []
let driver: TaskDriver | undefined
let releaseSolve: (() => void) | undefined
let allowDelivery = true
afterEach(async () => {
  releaseSolve?.()
  releaseSolve = undefined
  await driver?.close().catch(() => undefined)
  driver = undefined
  harness.open.mockReset()
  harness.solve.mockReset()
  allowDelivery = true
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(nativeTokens?: number) {
  const root = await mkdtemp(join(tmpdir(), 'async-rsi-'))
  roots.push(root)
  const medium = new FakePersistence(),
    logs = new Map<string, SessionEvent[]>(),
    agents = new Map<string, Agent>()
  const makeAgent = (id: string): Agent => {
    const log = logs.get(id) ?? []
    logs.set(id, log)
    const agent = agentFor(id, id)
    const live = {
      ...agent,
      session: {
        ...agent.session,
        get seq() {
          return log.length
        },
      },
      followup: (message: UserMessage) => {
        if (!allowDelivery) throw Error('interrupted before outcome delivery')
        log.push({
          seq: SessionSeq(log.length),
          time: log.length,
          type: 'agent/inbox/spliced',
          data: { target: 'next-turn', start: 0, inserted: [message] },
        } as SessionEvent)
      },
      wake: () => undefined,
      cancel: () => undefined,
      whenIdle: async () => undefined,
    } as unknown as Agent
    agents.set(id, live)
    return live
  }
  const parent = makeAgent('business')
  const persistence = {
    ...medium,
    open: async (id: string, access: never) =>
      id.startsWith('singularity:control:')
        ? medium.open(id as never, access)
        : { id, read: async () => ({ events: structuredClone(logs.get(id) ?? []) }), close: async () => undefined },
    create: medium.create.bind(medium),
    list: medium.list.bind(medium),
    stat: medium.stat.bind(medium),
  } as unknown as SessionPersistence
  const seams = {
    agents: { get: (id: string) => agents.get(id) } as never,
    sessions: { flush: async () => true } as never,
    sessionPersistence: persistence,
  }
  harness.open.mockImplementation(async (_seams: unknown, request: ChildSessionRequest) => {
    const id = String(agentSessionIdOf(request.agentId)),
      agent = agents.get(id) ?? makeAgent(id)
    if (request.message !== undefined) await postIdentifiedMessage(seams, agent, request.message)
    return {
      agent,
      agentId: id,
      sessionId: id,
      wait: () =>
        new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true })),
      stop: () => undefined,
      close: async () => undefined,
    }
  })
  const options = {
    controlId: 'async',
    workspaceRoot: root,
    domain: await loadDomain('/home/ROXY/code/singularity-core/deployment/domain/letters', spawnProcess),
    persistence,
    attachments: attachmentsAt(root),
    seams,
    ...(nativeTokens === undefined ? {} : { budget: { nativeTokens } }),
    execution: (admission: Admission) => ({
      ...fakeExecution(admission),
      sealTranscript: async (exec: ReturnType<typeof execFor>) => {
        const sessionId = String(exec.agent!.session.id),
          events = logs.get(sessionId)!,
          eventCount = events.length
        return { sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }) }
      },
    }),
  }
  const mount = async () => (driver = await openDriver(options))
  await mount()
  const enter = async (text: string, id = 'request') => {
    const message = {
      id,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    } as unknown as UserMessage
    const dispatch = await driver!.enter(parent, [message], { provider: 'test', model: 'model-under-test' })
    return dispatch === undefined ? undefined : JSON.parse((dispatch.content[0] as { text: string }).text).assigned
  }
  const call = (agent: Agent, id: string) => driver!.forCall(execFor(agent, id))
  return { root, medium, logs, agents, parent, call, enter, mount }
}
const business = (h: Awaited<ReturnType<typeof fixture>>) =>
  factsOf(h.medium).find((f) => f.kind === 'task/admitted')!.subject
const improving = async () => {
  await vi.waitFor(() => expect(harness.open).toHaveBeenCalled())
  return harness.open.mock.calls.find(([, r]) => r.preset === 'singularity-improve')![1] as ChildSessionRequest
}
it.each(['35', '0'])(
  'returns business result %s before independent asynchronous analysis and closes failure as well as success',
  async (artifact) => {
    const h = await fixture(),
      proposal = await h.enter('count protected letters')
    const summary = await h.call(h.parent, 'read').history() as { method: Record<string, unknown> }
    expect(summary.method).not.toHaveProperty('skills')
    expect(summary.method).not.toHaveProperty('tools')
    await expect(h.call(h.parent, 'round').history({ kind: 'round', ref: 'other-round' }))
      .rejects.toThrow('evaluation results belong to RSI')
    await writeFile(join(proposal.workspace, proposal.artifact), artifact)
    const result = await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.artifact })
    expect(result).toMatchObject({ phase: artifact === '35' ? 'verified' : 'failed' })
    expect(harness.open).not.toHaveBeenCalled()
    const request = await improving()
    expect(request.preset).toBe('singularity-improve')
    expect(factsOf(h.medium).filter((f) => f.kind === 'task/closed')).toMatchObject([
      { payload: { reason: artifact === '35' ? 'accepted' : 'failed' } },
    ])
    expect(
      factsOf(h.medium)
        .filter((f) => f.kind === 'rsi/status')
        .map((f) => (f.payload as { status: string }).status),
    ).toEqual(['pending', 'running'])
    const count = factsOf(h.medium).filter((f) => f.kind === 'run/started').length
    await driver!.close()
    driver = undefined
    await h.mount()
    await driver!.activate('business')
    await vi.waitFor(() => expect(harness.open.mock.calls.length).toBe(2))
    expect(factsOf(h.medium).filter((f) => f.kind === 'run/started')).toHaveLength(count)
    expect(harness.open.mock.calls[1]![1].agentId).toBe(request.agentId)
  },
)
it('records an honest skipped RSI when the business result exhausts the existing campaign budget', async () => {
  const h = await fixture(10),
    proposal = await h.enter('count protected letters')
  await writeFile(join(proposal.workspace, proposal.artifact), '35')
  driver!.budget!.observe('business', {
    type: 'assistant/message',
    seq: SessionSeq(0),
    data: { usage: { totalTokens: 10 } },
  } as SessionEvent)
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.artifact })
  await vi.waitFor(() =>
    expect(
      factsOf(h.medium).some((f) => f.kind === 'rsi/status' && (f.payload as { status: string }).status === 'skipped'),
    ).toBe(true),
  )
  expect(harness.open).not.toHaveBeenCalled()
  expect(factsOf(h.medium).filter((f) => f.kind === 'revision/created')).toHaveLength(1)
})
it('returns the business result before native idle and resumes trajectory sealing with the final turn cost', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  let finish!: () => void
  const turn = new Promise<void>((resolve) => { finish = resolve })
  const idle = vi.spyOn(h.parent, 'whenIdle').mockReturnValue(turn)
  await writeFile(join(proposal.workspace, proposal.artifact), '35')
  expect(await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.artifact }))
    .toMatchObject({ phase: 'verified' })
  await vi.waitFor(() => expect(idle).toHaveBeenCalled())
  expect(harness.open).not.toHaveBeenCalled()
  await driver!.close()
  driver = undefined
  expect(factsOf(h.medium).filter((f) => f.kind === 'rsi/status')).toHaveLength(0)
  h.logs.get('business')!.push({
    seq: SessionSeq(0), time: 1, type: 'assistant/message', data: { usage: { totalTokens: 23 } },
  } as SessionEvent)
  finish()
  await h.mount()
  await driver!.activate('business')
  const request = await improving()
  const trace = JSON.parse((request.message!.content[0] as { text: string }).text)
  expect(trace.summary.sessions).toContainEqual(expect.objectContaining({ sessionId: 'business', tokens: 23 }))
  expect(factsOf(h.medium).filter((f) => f.kind === 'run/started')).toHaveLength(2)
})
it('keeps a failed Run retryable until the root agent finishes its task', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  let finish!: () => void
  vi.spyOn(h.parent, 'whenIdle').mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
  await writeFile(join(proposal.workspace, proposal.artifact), '0')
  expect(await h.call(h.parent, 'bad').submit({ taskId: proposal.taskId, path: proposal.artifact }))
    .toMatchObject({ phase: 'failed' })
  expect(factsOf(h.medium).some((f) => f.kind === 'task/closed')).toBe(false)
  const retry = await h.call(h.parent, 'retry').retry({ taskId: proposal.taskId })
  expect(retry.taskId).toBe(proposal.taskId)
  expect(retry.runId).not.toBe(proposal.runId)
  await writeFile(join(retry.workspace, retry.artifact), '35')
  await h.call(h.parent, 'good').submit({ taskId: retry.taskId, path: retry.artifact })
  finish()
  await improving()
  expect(factsOf(h.medium).filter((f) => f.kind === 'task/closed')).toMatchObject([
    { payload: { runId: retry.runId, reason: 'accepted' } },
  ])
})
it('commits evaluation requests immediately, resumes the same trials and replays a lost outcome notification without another decision', async () => {
  const h = await fixture(),
    proposal = await h.enter('count protected letters')
  await writeFile(join(proposal.workspace, proposal.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.artifact })
  const request = await improving(),
    agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!,
    scope = h.call(agent, 'create')
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  let candidate: unknown
  // Freeze a real method change through the public RSI surface; evaluations below exercise core facts, not provider calls.
  harness.solve.mockImplementation(
    async (
      apparatus: Apparatus,
      input: {
        revision: never
        operationId: string
        started: (run: { taskId: string; runId: string }) => Promise<void>
      },
    ) => {
      const id = String(agentSessionIdOf(input.operationId)),
        trialAgent = h.agents.get(id) ?? agentFor(id, id)
      h.logs.set(id, h.logs.get(id) ?? [])
      const trial = await propose(
        apparatus,
        { agentId: id, sessionId: id, model: { provider: 'test', model: 'model-under-test' } },
        input.operationId,
        { goal: 'count protected letters', method: input.revision },
        { purpose: 'evaluation', relatedTo: { taskId: assigned.taskId, runId: assigned.runId } },
      )
      await input.started({ taskId: trial.taskId, runId: trial.runId })
      if (releaseSolve === undefined)
        await new Promise<void>((resolve) => {
          releaseSolve = resolve
        })
      const state = () => apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, trial.taskId)!
      if (state().runs[trial.runId]!.status === 'running') {
        await writeFile(join(trial.workspace, trial.artifact), '35')
        await submit(
          apparatus,
          fakeExecution(() => undefined),
          { agentId: id, sessionId: id, model: { provider: 'test', model: 'model-under-test' } },
          execFor(trialAgent, 'trial-submit'),
          { taskId: trial.taskId, path: trial.artifact },
          new AbortController().signal,
          fixtureReview(apparatus),
        )
      }
      const run = state().runs[trial.runId]!,
        artifactDigest = run.submission!.artifactDigest,
        criterionId = state().contract!.criteria[0]!.criterionId
      return {
        taskId: trial.taskId,
        runId: trial.runId,
        quality: 1,
        met: true,
        cost: 10,
        artifactDigest,
        inputDigests: run.submission!.inputDigests,
        implementationDigest: REVIEW_DIGEST,
        acceptanceDigest: REVIEW_DIGEST,
        verdict: {
          criterionId,
          evidenceDigest: recordedVerdictDigest(state(), 'fixture', { runId: run.runId, criterionId, artifactDigest }),
          artifactDigest,
        },
      }
    },
  )
  // Access the pinned seed via the role API, then edit only an unprotected domain method field.
  const method = structuredClone(await scope.history({ kind: 'method' })) as {
    reference: never
    assets: { templates: { id: string; applicability?: string }[] }
  }
  method.assets.templates[0]!.applicability = 'Use a single pass for small literal counting tasks.'
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(method.assets))
  candidate = await scope.createMethod({ path: 'candidate.json' })
  const round = { roundId: 'durable-round', round: 1, incumbent: method.reference, candidates: [candidate as never] }
  expect(await scope.evolve(round)).toEqual({ roundId: 'durable-round', status: 'pending' })
  expect(factsOf(h.medium).filter((f) => f.kind === 'rsi/round-requested')).toHaveLength(1)
  expect(await scope.history({ kind: 'method', ref: (candidate as { digest: string }).digest }))
    .toMatchObject({ reference: candidate })
  await vi.waitFor(() => {
    const failed = factsOf(h.medium).find((f) => f.kind === 'rsi/round-settled')
    if (failed) throw Error(JSON.stringify(failed.payload))
    expect(releaseSolve).toBeTypeOf('function')
  })
  expect(factsOf(h.medium).some((f) => f.kind === 'round/decided')).toBe(false)
  releaseSolve!()
  allowDelivery = false
  await vi.waitFor(() => expect(factsOf(h.medium).some((f) => f.kind === 'rsi/round-settled')).toBe(true))
  const decisions = factsOf(h.medium).filter((f) => f.kind === 'round/decided')
  expect(decisions).toHaveLength(1)
  expect(factsOf(h.medium).filter((f) => f.kind === 'trial/recorded')).toHaveLength(2)
  const result = await scope.history({ kind: 'round', ref: round.roundId }) as {
    evaluations: { observed: { detail: string }[] }[]
  }
  expect(result.evaluations).toHaveLength(2)
  for (const evaluation of result.evaluations) {
    const trial = JSON.parse(evaluation.observed[0]!.detail)
    expect(await scope.history({ kind: 'task', ref: trial.taskId })).toMatchObject({ taskId: trial.taskId })
  }
  expect(factsOf(h.medium).filter((f) => f.kind === 'rsi/status' && f.subject !== business(h))).toHaveLength(0)
  await expect(driver!.close()).rejects.toThrow('driver unload failed')
  driver = undefined
  allowDelivery = true
  await h.mount()
  await driver!.activate(String(agent.id))
  await vi.waitFor(() =>
    expect(
      h.logs
        .get(String(agent.id))!
        .some((e) => e.type === 'agent/inbox/spliced' && JSON.stringify(e.data).includes('durable-round')),
    ).toBe(true),
  )
  expect(factsOf(h.medium).filter((f) => f.kind === 'round/decided')).toEqual(decisions)
  expect(factsOf(h.medium).filter((f) => f.kind === 'rsi/round-requested')).toHaveLength(1)
  await writeFile(join(request.cwd, 'report.json'), JSON.stringify({ result: 'no winner', roundId: 'durable-round' }))
  await h.call(agent, 'report').submit({ taskId: assigned.taskId, path: 'report.json' })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast((f) => f.kind === 'rsi/status')!.payload)
    .toMatchObject({ status: 'completed' }))
})

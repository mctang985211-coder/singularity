import { rsiProposal } from './rsi-fixture.ts'
import type { MethodAssets } from '../src/method.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { testProjections } from './seam.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
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
import type { TurnFailureHandler } from '../src/execution.ts'
import { propose } from '../src/surfaces.ts'
import { submit } from '../src/submission.ts'
import { recordedVerdictDigest } from '../../src/task/protocol.ts'
import { REVIEW_DIGEST } from '../../src/review/protocol.ts'
import { openApparatus, type Apparatus } from '../src/apparatus.ts'
import { fixtureReview } from './review-fixture.ts'
import { agentFor, attachmentsAt, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'
import { nativeTurn } from './usage-fixture.ts'

const harness = vi.hoisted(() => ({ open: vi.fn(), solve: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async (original) => ({
  ...(await original<object>()),
  openChildSession: harness.open,
}))
vi.mock('../src/native-solve.ts', async original => ({
  ...(await original<object>()),
  createNativeSolve: (apparatus: Apparatus) => (input: unknown) => harness.solve(apparatus, input),
}))
vi.mock('../src/review.ts', async original => {
  const actual = await original<typeof import('../src/review.ts')>()
  return { ...actual, reviewSubject: async (...args: Parameters<typeof actual.reviewSubject>) => {
    const [apparatus, , , , raw] = args
    const subject = raw as { purpose: string; taskId: string; runId: string; checks: never[] }
    if (subject.purpose !== 'acceptance') return actual.reviewSubject(...args)
    return fixtureReview(apparatus)(subject.taskId,
      apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, subject.taskId)!.runs[subject.runId]!, subject.checks)
  } }
})
const roots: string[] = []
let driver: TaskDriver | undefined
let releaseSolve: (() => void) | undefined
let allowDelivery = true
let screenVerdict = 'pass'
let publicationVerdict = 'pass'
let beforeProposalJudgment: (() => Promise<void>) | undefined
afterEach(async () => {
  releaseSolve?.()
  releaseSolve = undefined
  await driver?.close().catch(() => undefined)
  driver = undefined
  harness.open.mockReset()
  harness.solve.mockReset()
  allowDelivery = true
  screenVerdict = 'pass'
  publicationVerdict = 'pass'
  beforeProposalJudgment = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
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
        : { id, header: { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }, inheritedEventCount: SessionLogOffset(0),
          read: async () => ({ events: structuredClone(logs.get(id) ?? []) }), close: async () => undefined },
    create: medium.create.bind(medium),
    list: medium.list.bind(medium),
    stat: medium.stat.bind(medium),
  } as unknown as SessionPersistence
  const seams = {
    agents: { get: (id: string) => agents.get(id) } as never,
    sessions: { flush: async () => true } as never,
    sessionPersistence: persistence,
  }
  let reportFailure!: TurnFailureHandler
  let admission!: Admission
  harness.open.mockImplementation(async (_seams: unknown, request: ChildSessionRequest) => {
    const id = String(agentSessionIdOf(request.agentId)),
      agent = agents.get(id) ?? makeAgent(id)
    if (request.message !== undefined) await postIdentifiedMessage(seams, agent, request.message)
    if (request.preset === 'singularity-improve') {
      for (const name of ['bash', 'web', 'singularity_decompose_task', 'singularity_answer', 'read_image'])
        expect(admission({ name, agent } as never)).toContain('RSI only')
      for (const name of ['read', 'write', 'edit', 'singularity_read', 'singularity_propose_method', 'singularity_submit'])
        expect(admission({ name, agent } as never)).toBeUndefined()
    }
    return {
      agent,
      agentId: id,
      sessionId: id,
      wait: async () => {
        if (request.preset !== 'singularity-review')
          return new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
        const assignment = JSON.parse((request.message!.content[0] as { text: string }).text)
        if (assignment.purpose === 'proposal' || assignment.purpose === 'publication') {
          expect(driver!.reviewTarget(id)?.kind).toBe(assignment.purpose)
          for (const name of ['bash', 'web', 'singularity_decompose_task', 'singularity_answer'])
            expect(admission({ name, agent } as never)).toContain('Method review')
          for (const name of ['read', 'write', 'singularity_submit'])
            expect(admission({ name, agent } as never)).toBeUndefined()
          await expect(driver!.forCall(execFor(agent, 'no-delegation')).decompose({ taskId: assignment.reviewId, children: [] }))
            .rejects.toThrow('method reviews do not delegate')
          let from = 0, subject = ''
          while (true) {
            const page = await driver!.forCall(execFor(agent, 'subject-page')).history({ kind: 'subject', from,
              count: 8192 }) as { subjectDigest: string; next: number; complete: boolean; text: string }
            expect(page.subjectDigest).toBe(assignment.subjectDigest)
            subject += page.text
            if (page.complete) break
            from = page.next
          }
          expect(subject).toBe(await readFile(join(request.cwd, 'subject.json'), 'utf8'))
          if (assignment.purpose === 'proposal') {
            const frozen = JSON.parse(subject)
            expect(frozen.nativeEvidence).toEqual([{ reference: { sessionId: 'business', eventSeq: 0 }, page: {
              seq: 0, type: logs.get('business')![0]!.type, from: 0, complete: true,
              totalBytes: Buffer.byteLength(JSON.stringify(logs.get('business')![0], null, 2)),
              next: Buffer.byteLength(JSON.stringify(logs.get('business')![0], null, 2)),
              text: JSON.stringify(logs.get('business')![0], null, 2),
            } }])
            await expect(driver!.forCall(execFor(agent, 'review-history')).history({ kind: 'roots' }))
              .rejects.toThrow('working RSI')
            await expect(driver!.forCall(execFor(agent, 'review-trajectory')).history({ kind: 'trajectory', ref: 'business', eventSeq: 0 }))
              .rejects.toThrow('frozen evidence scope')
            await beforeProposalJudgment?.()
          }
        }
        await writeFile(join(request.cwd, 'review.json'), JSON.stringify({ subjectDigest: assignment.subjectDigest,
          findings: assignment.criteria.map((criterion: { criterionId: string }) => ({ criterionId: criterion.criterionId,
            verdict: assignment.purpose === 'publication' ? publicationVerdict : criterion.criterionId === 'proposal-safe' ? screenVerdict : 'pass',
            detail: 'Independent test review', evidence: ['subject.json'] })) }))
        await driver!.forCall(execFor(agent, 'judgment')).submit({ taskId: assignment.reviewId, path: 'review.json' })
      },
      stop: () => undefined,
      close: async () => undefined,
    }
  })
  const options = {
    projections: testProjections,
    controlId: 'async',
    workspaceRoot: root,
    domain: await loadDomain('/home/ROXY/code/singularity-core/deployment/domain/letters', spawnProcess),
    persistence,
    attachments: attachmentsAt(root),
    seams,
    execution: (admit: Admission, onFailure: TurnFailureHandler) => {
      admission = admit
      reportFailure = onFailure
      return {
      ...fakeExecution(admit),
      sealTranscript: async (exec: ReturnType<typeof execFor>) => {
        const sessionId = String(exec.agent!.session.id),
          events = logs.get(sessionId)!,
          eventCount = events.length
        return { sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }) }
      },
      }
    },
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
  return { root, medium, logs, agents, parent, call, enter, mount, reportFailure }
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
    await writeFile(join(proposal.workspace, proposal.contract.artifact), artifact)
    const result = await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
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
it('starts RSI after missing business usage with the unchanged native projection and permits the next root', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  h.logs.get('business')!.push(...nativeTurn(undefined))
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
  const request = await improving()
  const trace = JSON.parse(await readFile(join(request.cwd, 'subject.json'), 'utf8'))
  expect(trace.summary.usage).toEqual({ source: 'token-meter/tokenUsage', tokens: 0 })
  expect(trace.summary.sessions).toContainEqual(expect.objectContaining({ sessionId: 'business', tokenUsage: {
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  } }))
  expect(await h.enter('another protected count', 'next-request')).toMatchObject({ phase: 'running' })
  expect(factsOf(h.medium).filter(f => f.kind === 'rsi/status').map(f => (f.payload as { status: string }).status))
    .toEqual(['pending', 'running'])
})
it('resumes the same unfinished RSI after a startup failure without rerunning the business root or resealing its trace', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  harness.open.mockRejectedValueOnce(new Error('checkpoint source identity unavailable'))
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast(f => f.kind === 'rsi/status')!.payload).toMatchObject({ status: 'failed' }))
  const first = harness.open.mock.calls[0]![1] as ChildSessionRequest
  const starts = factsOf(h.medium).filter(f => f.kind === 'run/started')
  const trace = (factsOf(h.medium).findLast(f => f.kind === 'rsi/status' && (f.payload as { status: string }).status === 'running')!.payload as { trace: { bytes: number } }).trace
  await driver!.close(); driver = undefined
  const control = await openApparatus('async', h.root,
    await loadDomain('/home/ROXY/code/singularity-core/deployment/domain/letters', spawnProcess), h.medium as never,
    attachmentsAt(h.root), testProjections)
  try {
    await expect(control.store.emit({ commandId: 'changed-resume-trace', protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'rsi/status', subject: proposal.taskId, payload: { status: 'running', detail: 'changed trace', trace: { ...trace, bytes: trace.bytes + 1 } } }))
      .rejects.toThrow('invalid RSI transition')
  } finally { await control.store.close() }
  await h.mount()
  await driver!.activate('business')
  await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(2))
  expect(harness.open.mock.calls[1]![1].agentId).toBe(first.agentId)
  expect(factsOf(h.medium).filter(f => f.kind === 'run/started')).toEqual(starts)
  expect(factsOf(h.medium).filter(f => f.kind === 'rsi/status').map(f => (f.payload as { status: string }).status))
    .toEqual(['pending', 'running', 'failed', 'running'])
  expect(factsOf(h.medium).findLast(f => f.kind === 'rsi/status')!.payload).toMatchObject({ status: 'running', trace })
})
it('returns the business result before native idle and resumes trajectory sealing with the final turn cost', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  let finish!: () => void
  const turn = new Promise<void>((resolve) => { finish = resolve })
  const idle = vi.spyOn(h.parent, 'whenIdle').mockReturnValue(turn)
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  expect(await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact }))
    .toMatchObject({ phase: 'verified' })
  await vi.waitFor(() => expect(idle).toHaveBeenCalled())
  expect(harness.open).not.toHaveBeenCalled()
  await driver!.close()
  driver = undefined
  expect(factsOf(h.medium).filter((f) => f.kind === 'rsi/status')).toHaveLength(0)
  h.logs.get('business')!.push(...nativeTurn(23))
  finish()
  await h.mount()
  await driver!.activate('business')
  const request = await improving()
  const dispatch = JSON.parse((request.message!.content[0] as { text: string }).text)
  expect(dispatch).not.toHaveProperty('summary')
  expect(dispatch).toMatchObject({ trace: 'subject.json', contract: { inputs: [{ name: 'subject.json' }] }, method: expect.any(Object) })
  const trace = JSON.parse(await readFile(join(request.cwd, dispatch.trace), 'utf8'))
  expect(trace.summary.sessions).toContainEqual(expect.objectContaining({ sessionId: 'business', tokens: 23 }))
  expect(trace.summary.usage).toEqual({ source: 'token-meter/tokenUsage', tokens: 23 })
  expect(trace).not.toHaveProperty('sessions')
  expect(trace).not.toHaveProperty('history')
  const subjectPage = await h.call(h.agents.get(String(agentSessionIdOf(request.agentId)))!, 'subject')
    .history({ kind: 'subject', count: 8192 }) as { text: string; next: number }
  expect(subjectPage.text).toBe((await readFile(join(request.cwd, 'subject.json'))).subarray(0, subjectPage.next).toString('utf8'))
  expect(await h.call(h.agents.get(String(agentSessionIdOf(request.agentId)))!, 'trajectory')
    .history({ kind: 'trajectory', ref: 'business', from: 0, count: 5 })).toMatchObject(h.logs.get('business')!.slice(0, 5).map(({ seq, time, type }) => ({ seq, time, type })))
  const task = trace.summary.tasks.find((task: { taskId: string }) => task.taskId === proposal.taskId)
  expect(task.contract).toEqual(proposal.contract)
  for (const field of ['goal', 'template', 'inputs', 'criteria']) expect(task).not.toHaveProperty(field)
  for (const run of task.runs) expect(run).not.toHaveProperty('cost')
  expect(factsOf(h.medium).filter((f) => f.kind === 'run/started')).toHaveLength(2)
})
it('keeps a failed Run retryable until the root agent finishes its task', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  let finish!: () => void
  vi.spyOn(h.parent, 'whenIdle').mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '0')
  expect(await h.call(h.parent, 'bad').submit({ taskId: proposal.taskId, path: proposal.contract.artifact }))
    .toMatchObject({ phase: 'failed' })
  expect(factsOf(h.medium).some((f) => f.kind === 'task/closed')).toBe(false)
  const retry = await h.call(h.parent, 'retry').retry({ taskId: proposal.taskId })
  expect(retry.taskId).toBe(proposal.taskId)
  expect(retry.runId).not.toBe(proposal.runId)
  await writeFile(join(retry.workspace, retry.contract.artifact), '35')
  await h.call(h.parent, 'good').submit({ taskId: retry.taskId, path: retry.contract.artifact })
  finish()
  await improving()
  expect(factsOf(h.medium).filter((f) => f.kind === 'task/closed')).toMatchObject([
    { payload: { runId: retry.runId, reason: 'accepted' } },
  ])
})
it('reports actual RSI runtime failures independently of native usage availability', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
  const request = await improving(), sessionId = String(agentSessionIdOf(request.agentId))
  h.logs.get(sessionId)!.push(...nativeTurn(undefined, h.logs.get(sessionId)!.length))
  await h.reportFailure({ sessionId, turn: 1, seq: 1, reason: { kind: 'error', error: { message: 'provider unavailable', code: 'SERVER' } } })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'task/closed'))
    .toContainEqual(expect.objectContaining({ subject: request.agentId, payload: expect.objectContaining({ reason: 'failed' }) }))
  expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload)
    .toMatchObject({ status: 'failed', detail: expect.stringContaining('provider unavailable') })
})
it('rejects invented or inaccessible proposal evidence and unsupported affected Tasks before review or execution', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  h.logs.get('business')!.push(...nativeTurn(100))
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!, scope = h.call(agent, 'evidence')
  const method = await scope.history({ kind: 'method' }) as { assets: MethodAssets }
  const changed = structuredClone(method.assets)
  ;(changed.templates[0] as { applicability: string }).applicability = 'Reuse sufficient frozen evidence.'
  const proposal = rsiProposal(method.assets, changed, root.taskId, 'business')
  for (const [reference, error] of [
    [{ sessionId: 'business', eventSeq: 99999 }, 'outside this readable trajectory'],
    [{ sessionId: 'foreign-session', eventSeq: 0 }, 'frozen evidence scope'],
    [{ sessionId: 'business', eventSeq: 0, rootId: 'active-foreign-root' }, 'closed subject'],
    [{ sessionId: 'business', eventSeq: 0, count: 8193 }, '8192'],
  ] as const) {
    const invalid = { ...proposal, analysis: { ...proposal.analysis,
      failure_modes: [{ ...proposal.analysis.failure_modes[0], evidence: [reference] }] } }
    await writeFile(join(request.cwd, 'invalid.json'), JSON.stringify(invalid))
    await expect(scope.proposeMethod({ path: 'invalid.json' })).rejects.toThrow(error)
  }
  await writeFile(join(request.cwd, 'invalid.json'), JSON.stringify({ ...proposal, edit: { ...proposal.edit, predicted_affected: ['invented-task'] } }))
  await expect(scope.proposeMethod({ path: 'invalid.json' })).rejects.toThrow('Tasks with cited native evidence')
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  await writeFile(join(request.cwd, 'report.json'), '{}')
  await expect(scope.submit({ taskId: assigned.taskId, path: 'report.json' })).rejects.toThrow('no approved published winner')
  expect(factsOf(h.medium).filter(f => f.kind === 'review/started')).toHaveLength(1) // Business acceptance only.
  expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-requested')).toHaveLength(0)
  expect(harness.solve).not.toHaveBeenCalled()
})

it('allocates distinct round numbers when two roots finish proposal screening concurrently', async () => {
  const h = await fixture()
  h.logs.get('business')!.push(...nativeTurn(100))
  const proposals: { scope: ReturnType<typeof h.call>; path: string }[] = []
  for (let index = 0; index < 2; index++) {
    const root = await h.enter('count protected letters', `request-${index}`)
    await writeFile(join(root.workspace, root.contract.artifact), '35')
    await h.call(h.parent, `submit-${index}`).submit({ taskId: root.taskId, path: root.contract.artifact })
    await vi.waitFor(() => expect(harness.open.mock.calls.filter(([, request]) => request.preset === 'singularity-improve')).toHaveLength(index + 1))
    const request = harness.open.mock.calls.filter(([, request]) => request.preset === 'singularity-improve')[index]![1] as ChildSessionRequest
    const agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
    const scope = h.call(agent, `proposal-${index}`)
    const baseline = await scope.history({ kind: 'method' }) as { assets: MethodAssets }
    const candidate = structuredClone(baseline.assets)
    ;(candidate.templates[0] as { applicability: string }).applicability = 'Inspect frozen inputs once before delegation.'
    await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(baseline.assets, candidate, root.taskId, 'business')))
    proposals.push({ scope, path: 'candidate.json' })
  }
  let screened = 0, release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  beforeProposalJudgment = async () => { if (++screened === 2) release(); await ready }
  harness.solve.mockRejectedValue(new Error('test ends after round admission'))
  const results = await Promise.all(proposals.map(({ scope, path }) => scope.proposeMethod({ path })))
  const requests = factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-requested')
  expect(requests.map(fact => (fact.payload as { round: number }).round)).toEqual([1, 2])
  expect(new Set(requests.map(fact => (fact.payload as { roundId: string }).roundId)).size).toBe(2)
  await vi.waitFor(() => expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-settled')).toHaveLength(2))
  expect(await proposals[0]!.scope.proposeMethod({ path: proposals[0]!.path }))
    .toMatchObject({ roundId: (results[0] as { roundId: string }).roundId, status: 'failed' })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-requested')).toEqual(requests)
})
it.each([[false, false], [true, false], [false, true]])('screens, revises no-winner rounds and publishes; root tool change %s, publication rejection %s', async (bindTool, rejectPublication) => {
  const h = await fixture(),
    proposal = await h.enter('count protected letters')
  h.logs.get('business')!.push(...nativeTurn(100))
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
  const request = await improving(),
    agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!,
    scope = h.call(agent, 'create')
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  let candidate: unknown
  let trialCost = 150
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
        await writeFile(join(trial.workspace, trial.contract.artifact), '35')
        await submit(
          apparatus,
          fakeExecution(() => undefined),
          { agentId: id, sessionId: id, model: { provider: 'test', model: 'model-under-test' } },
          execFor(trialAgent, 'trial-submit'),
          { taskId: trial.taskId, path: trial.contract.artifact },
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
        cost: trialCost,
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
    assets: {
      rootTemplate: string
      templates: { id: string; applicability?: string; skills: string[] }[]
      skills: { name: string; description: string; capabilities: string[]; requiredTools: string[]; content: string }[]
      tools: { name: string; source: string }[]
    }
  }
  const baselineAssets = structuredClone(method.assets) as MethodAssets
  const proposalBytes = () => JSON.stringify(rsiProposal(baselineAssets, method.assets as MethodAssets, proposal.taskId, 'business'))
  method.assets.templates[0]!.applicability = 'Use a single pass for small literal counting tasks.'
  if (bindTool) {
    method.assets.templates.find(template => template.id === method.assets.rootTemplate)!.skills.push('trial-helper')
    method.assets.skills.push({ name: 'trial-helper', description: 'Inspect inputs', capabilities: [], requiredTools: ['trial-helper'], content: 'Inspect inputs before delegating.' })
    method.assets.tools.push({ name: 'trial-helper', source: "console.log('inspection')" })
  }
  await writeFile(join(request.cwd, 'candidate.json'), proposalBytes())
  if (bindTool) {
    await expect(scope.proposeMethod({ path: 'candidate.json' })).rejects.toThrow('root-bound Tools')
    expect(harness.solve).not.toHaveBeenCalled()
    expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-requested')).toHaveLength(0)
    return
  }
  screenVerdict = 'fail'
  expect(await scope.proposeMethod({ path: 'candidate.json' })).toMatchObject({ status: 'rejected', reason: expect.any(String) })
  expect(harness.solve).not.toHaveBeenCalled()
  expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-requested')).toHaveLength(0)
  method.assets.templates[0]!.applicability = 'Use a bounded evidence pass before delegation.'
  await writeFile(join(request.cwd, 'candidate.json'), proposalBytes())
  screenVerdict = 'pass'
  const round = await scope.proposeMethod({ path: 'candidate.json' }) as { roundId: string; status: string; revision: unknown }
  candidate = round.revision
  expect(round.status).toBe('pending')
  expect(await scope.proposeMethod({ path: 'candidate.json' })).toMatchObject({ roundId: round.roundId, status: 'pending' })
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
  expect(factsOf(h.medium).find(fact => fact.kind === 'rsi/round-settled')!.payload).toMatchObject({ status: 'completed' })
  expect(await scope.history({ kind: 'method' })).not.toHaveProperty('nextRound')
  const decisions = factsOf(h.medium).filter((f) => f.kind === 'round/decided')
  expect(decisions).toHaveLength(1)
  expect(factsOf(h.medium).filter((f) => f.kind === 'trial/recorded')).toHaveLength(bindTool ? 1 : 2)
  if (bindTool) {
    expect((decisions[0]!.payload as { winner: number | null; outcomes: { reason: string }[] }).winner).toBeNull()
    expect((decisions[0]!.payload as { outcomes: { reason: string }[] }).outcomes[0]!.reason).toContain('method:trial-helper')
  }
  const result = await scope.history({ kind: 'round', ref: round.roundId }) as {
    evaluations: { observed: { detail: string }[] }[]
  }
  expect(result.evaluations).toHaveLength(2)
  for (const evaluation of result.evaluations) {
    if (evaluation.observed.length === 0) continue
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
        .some((e) => e.type === 'agent/inbox/spliced' && JSON.stringify(e.data).includes(round.roundId)),
    ).toBe(true),
  )
  expect(factsOf(h.medium).filter((f) => f.kind === 'round/decided')).toEqual(decisions)
  expect(factsOf(h.medium).filter((f) => f.kind === 'rsi/round-requested')).toHaveLength(1)
  // A no-winner outcome returns to this same owner. A changed method is measured
  // against the same sealed root, then independently approved and published.
  expect((decisions[0]!.payload as { winner: number | null }).winner).toBeNull()
  await writeFile(join(request.cwd, 'report.json'), JSON.stringify({ result: 'no winner' }))
  await expect(h.call(agent, 'premature-report').submit({ taskId: assigned.taskId, path: 'report.json' }))
    .rejects.toThrow('no approved published winner')
  expect(factsOf(h.medium).some(fact => fact.kind === 'run/submitted' && fact.subject === assigned.taskId)).toBe(false)
  trialCost = 50
  publicationVerdict = rejectPublication ? 'fail' : 'pass'
  method.assets.templates[0]!.applicability = 'Reuse sufficient evidence and delegate one bounded implementation.'
  await writeFile(join(request.cwd, 'repaired.json'), proposalBytes())
  let repaired = await h.call(agent, 'repair').proposeMethod({ path: 'repaired.json' }) as { roundId: string; revision: { digest: string } }
  if (rejectPublication) {
    await vi.waitFor(() => expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-settled')).toHaveLength(2))
    expect(factsOf(h.medium).findLast(f => f.kind === 'rsi/round-settled')!.payload).toMatchObject({ status: 'failed' })
    expect(factsOf(h.medium).filter(f => f.kind === 'pointer/switched')).toHaveLength(1)
    await expect(h.call(agent, 'unapproved-report').submit({ taskId: assigned.taskId, path: 'report.json' }))
      .rejects.toThrow('no approved published winner')
    publicationVerdict = 'pass'
    method.assets.templates[0]!.applicability = 'Reuse evidence only after confirming frozen input identity; delegate bounded implementation.'
    await writeFile(join(request.cwd, 'repaired-again.json'), proposalBytes())
    repaired = await h.call(agent, 'repair-again').proposeMethod({ path: 'repaired-again.json' }) as typeof repaired
  }
  await vi.waitFor(() => expect(factsOf(h.medium).filter(f => f.kind === 'pointer/switched')).toHaveLength(2))
  expect(harness.solve).toHaveBeenCalledTimes(rejectPublication ? 3 : 2)
  const outcomes = factsOf(h.medium).filter(f => f.kind === 'rsi/round-settled')
  await vi.waitFor(() => expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-settled')).toHaveLength(rejectPublication ? 3 : 2))
  expect(outcomes[0]!.payload).toMatchObject({ status: 'completed' })
  const observed = factsOf(h.medium).filter(f => f.kind === 'trial/recorded').map(f => f.payload as { cost: number; detail: string })
  expect(observed.map(trial => trial.cost)).toEqual(rejectPublication ? [100, 150, 100, 50, 100, 50] : [100, 150, 100, 50])
  expect(JSON.parse(observed[0]!.detail).taskId).toBe(proposal.taskId)
  expect(JSON.parse(observed[2]!.detail).taskId).toBe(proposal.taskId)
  const reviews = factsOf(h.medium).filter(f => f.kind === 'review/started').map(f => (f.payload as { target: { kind: string } }).target.kind)
  expect(reviews.filter(kind => kind === 'proposal')).toHaveLength(rejectPublication ? 4 : 3)
  expect(reviews.filter(kind => kind === 'publication')).toHaveLength(rejectPublication ? 2 : 1)
  await writeFile(join(request.cwd, 'report.json'), JSON.stringify({ result: 'published', roundId: repaired.roundId }))
  await h.call(agent, 'report').submit({ taskId: assigned.taskId, path: 'report.json' })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast((f) => f.kind === 'rsi/status')!.payload)
    .toMatchObject({ status: 'completed' }))
})

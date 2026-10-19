import { fileURLToPath } from 'node:url'
import { rsiProposal } from './rsi-fixture.ts'
import type { MethodAssets } from '../src/method.ts'
import type { rsiProposalTemplate } from '../src/rsi-proposal.ts'
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
import { structuralEditsOf, structuralEditDetailsOf } from '../../src/strategy/edits.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import type { ChildSessionRequest } from '../../src/runtime/child-session.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { DEFAULT_WORKFLOW_LIMITS } from '../../src/task/budget.ts'
import { parseSuite } from '../../src/measure/suite.ts'
import type { EvolutionOptions } from '../src/evolution.ts'
import { openDriver, type TaskDriver } from '../src/driver.ts'
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import { spawnProcess } from '../src/process.ts'
import type { Admission } from '../src/execution.ts'
import type { TurnFailureHandler } from '../src/execution.ts'
import { propose } from '../src/surfaces.ts'
import { submit } from '../src/submission.ts'
import { recordedVerdictDigest } from '../../src/task/protocol.ts'
import { REVIEW_DIGEST, readFindings } from '../../src/review/protocol.ts'

type RsiMethodRead = { reference: RevisionRef; assets: MethodAssets; proposal: { template: ReturnType<typeof rsiProposalTemplate>; pending: unknown }; cases: { caseId: string }[] }
import { openApparatus, type Apparatus } from '../src/apparatus.ts'
import { fixtureReview } from './review-fixture.ts'
import { agentFor, attachmentsAt, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'
import { nativeTurn } from './usage-fixture.ts'

const { taskReport } = await import(fileURLToPath(new URL('../../scripts/singularity.mjs', import.meta.url)))

const harness = vi.hoisted(() => ({ open: vi.fn(), solve: vi.fn(), profile: vi.fn() }))
// Only driver wiring is under test here. The actual implementation hashes mounted
// declarations and binaries in execution-profile.spec.ts; this fixture makes no host/model claim.
vi.mock('../src/execution-profile.ts', () => ({ executionProfile: harness.profile }))
vi.mock('../../src/runtime/child-session.ts', async (original) => ({
  ...(await original<object>()),
  openChildSession: harness.open,
}))
vi.mock('../src/native-solve.ts', async original => ({
  ...(await original<object>()),
  createNativeSolve: (apparatus: Apparatus, _seams: unknown, _parent: unknown, signal: AbortSignal) => (input: unknown) => {
    signal.throwIfAborted()
    return harness.solve(apparatus, input, signal)
  },
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
  harness.profile.mockReset()
  allowDelivery = true
  screenVerdict = 'pass'
  publicationVerdict = 'pass'
  beforeProposalJudgment = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture({ suite = false, heldout = true } = {}) {
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
  const parent = makeAgent('business'), dispatches: UserMessage[] = []
  const baseDomain = await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess)
  const domain = !suite ? baseDomain : { ...baseDomain, suite: parseSuite({ version: 1, suiteId: 'offline-driver-wiring', failureQuality: 0,
    cases: (heldout ? ['evolve', 'validation', 'heldout'] : ['evolve', 'validation']).flatMap(split =>
      Array.from({ length: split === 'evolve' ? 1 : 3 }, (_, family) => ({
        caseId: `${split}-${family}`, familyId: `${split}-family-${family}`, sourceId: `${split}-source-${family}`,
        split, weight: 1, trials: 2, hardGuards: [],
        contract: contractFor(baseDomain, baseDomain.templates.get(baseDomain.rootTemplate!)!, `Offline wiring case ${split}-${family}`),
      }))) }) }
  harness.profile.mockResolvedValue({ digest: 'a'.repeat(64), complete: true, missing: [], profile: { source: 'offline driver fixture' } })
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
          return request.signal.aborted ? undefined : new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
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
            expect(frozen.edit.changes).toEqual(structuralEditsOf(frozen.baseline, frozen.assets))
            expect(frozen.changes).toEqual(structuralEditDetailsOf(frozen.baseline, frozen.assets))
            const method = await driver!.forCall(execFor(agent, 'review-method')).history({ kind: 'method' })
            expect(method).toMatchObject({ assets: frozen.baseline })
            for (const field of ['proposal', 'reportFormat', 'reportTemplate']) expect(method).not.toHaveProperty(field)
            expect(frozen.nativeEvidence).toEqual([{ reference: expect.objectContaining({ sessionId: 'business', eventSeq: 0 }), page: {
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
        const output = assignment.output.template
        expect(output.subjectDigest).toBe(assignment.subjectDigest)
        expect(readFindings(output.findings).map(f => f.criterionId)).toEqual(assignment.criteria.map((c: { criterionId: string }) => c.criterionId))
        await writeFile(join(request.cwd, assignment.output.path), JSON.stringify({ ...output,
          findings: output.findings.map((finding: { criterionId: string }) => ({ ...finding,
            verdict: assignment.purpose === 'publication' ? publicationVerdict : finding.criterionId === 'proposal-safe' ? screenVerdict : 'pass',
            detail: 'Independent test review', evidence: ['subject.json'] })) }))
        await driver!.forCall(execFor(agent, 'judgment')).submit({ taskId: assignment.reviewId, path: 'review.json' })
      },
      stop: () => undefined,
      close: async () => undefined,
    }
  })
  const attachments = attachmentsAt(root)
  const options = {
    projections: testProjections,
    controlId: 'async',
    workspaceRoot: root,
    domain,
    persistence,
    attachments,
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
    if (dispatch !== undefined) dispatches.push(dispatch)
    return dispatch === undefined ? undefined : JSON.parse((dispatch.content[0] as { text: string }).text).assigned
  }
  const call = (agent: Agent, id: string) => driver!.forCall(execFor(agent, id))
  return { root, medium, logs, agents, parent, call, enter, mount, reportFailure, domain, dispatches, attachments }
}
const business = (h: Awaited<ReturnType<typeof fixture>>) =>
  factsOf(h.medium).find((f) => f.kind === 'task/admitted')!.subject
function businessTurn(h: Awaited<ReturnType<typeof fixture>>, tokens: number | undefined) {
  const log = h.logs.get('business')!, events = nativeTurn(tokens, 0, log.filter(event => event.type === 'turn/start').length + 1)
  events.splice(2, 0, { type: 'user/message', data: h.dispatches.at(-1)! } as SessionEvent)
  log.push(...events.map((event, index) => ({ ...event, seq: SessionSeq(log.length + index), time: log.length + index })))
}
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
  businessTurn(h, undefined)
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
  const request = await improving()
  const trace = JSON.parse(await readFile(join(request.cwd, 'subject.json'), 'utf8'))
  expect(trace.summary.usage).toEqual({ source: 'token-meter/tokenUsage', tokens: 0, complete: false })
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
    await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess), h.medium as never,
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
it.each(['agent/opened', 'task/admitted', 'workflow/limits-frozen'])('recovers RSI startup interrupted before %s without a second business Run or trajectory', async kind => {
  const h = await fixture(), root = await h.enter('count protected letters')
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  h.medium.failAppendOf(kind)
  await vi.waitFor(async () => { await expect(driver!.read()).rejects.toThrow('background RSI delivery failed') })
  const trace = (factsOf(h.medium).find(fact => fact.kind === 'rsi/status' && (fact.payload as { status: string }).status === 'running')!.payload as { trace: unknown }).trace
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/started')).toHaveLength(1)
  expect(harness.open).not.toHaveBeenCalled()
  await driver!.close().catch(() => undefined); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await improving()
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/started')).toHaveLength(2)
  expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'running', trace })
  expect((await driver!.read()).tasks.find(task => task.taskId === root.taskId)).toMatchObject({ closure: { reason: 'accepted' } })
})

it('recovers a closed root whose RSI pending append was interrupted', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  h.medium.failAppendOf('rsi/status')
  await vi.waitFor(() => expect(factsOf(h.medium).filter(fact => fact.kind === 'task/closed')).toHaveLength(1))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/status')).toHaveLength(0)
  await driver!.close().catch(() => undefined); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await improving()
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/started')).toHaveLength(2)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/status').map(fact => (fact.payload as { status: string }).status))
    .toEqual(['pending', 'running'])
})

it('resumes a sealed RSI startup failure even when no analysis Task was created', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const read = h.attachments.readFileStream.bind(h.attachments)
  let fail = true
  vi.spyOn(h.attachments, 'readFileStream').mockImplementation(ref => {
    if (ref.name === 'trajectory.json' && fail) { fail = false; throw Error('temporary source read outage') }
    return read(ref)
  })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'failed' }))
  expect(harness.open).not.toHaveBeenCalled()
  expect(factsOf(h.medium).filter(fact => fact.kind === 'task/admitted')).toHaveLength(1)
  const trace = (factsOf(h.medium).find(fact => fact.kind === 'rsi/status' && (fact.payload as { status: string }).status === 'running')!.payload as { trace: unknown }).trace
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await improving()
  expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'running', trace })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/started')).toHaveLength(2)
})

it('retries a failed first trajectory seal only on explicit activation', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const save = vi.spyOn(h.attachments, 'saveFile').mockRejectedValueOnce(new Error('temporary attachment outage'))
  await vi.waitFor(() => expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'failed' }))
  expect(factsOf(h.medium).some(fact => fact.kind === 'rsi/status' && (fact.payload as { trace?: unknown }).trace !== undefined)).toBe(false)
  expect(harness.open).not.toHaveBeenCalled()
  await driver!.close(); driver = undefined
  await h.mount()
  expect(harness.open).not.toHaveBeenCalled()
  await driver!.activate('business')
  await improving()
  expect(save.mock.calls.filter(([request]) => request.name === 'trajectory.json')).toHaveLength(2)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/status').map(fact => (fact.payload as { status: string }).status))
    .toEqual(['pending', 'failed', 'pending', 'running'])
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/started')).toHaveLength(2)
})

it('enforces the existing step limit on RSI reads and edits across cold recovery', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), id = String(agentSessionIdOf(request.agentId)), agent = h.agents.get(id)!
  const log = h.logs.get(id)!
  const dispatch = log[0]!
  log.push({ seq: SessionSeq(log.length), time: log.length, type: 'user/message',
    data: (dispatch.data as { inserted: UserMessage[] }).inserted[0] } as SessionEvent)
  for (let index = 0; index < DEFAULT_WORKFLOW_LIMITS.maxSteps; index++)
    log.push({ seq: SessionSeq(log.length), time: log.length, type: 'step/start', data: { step: index } } as SessionEvent)
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate(id)
  await driver!.enter(agent, [], { provider: 'test', model: 'model-under-test' })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/failed' && fact.subject === request.agentId))
    .toMatchObject([{ payload: { cause: 'business', reason: expect.stringContaining('step limit') } }])
  expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'failed' })
  await driver!.activate('business')
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/started')).toHaveLength(2)
})

it('returns before native idle and restores costs at the sealed submission cutoff', async () => {
  const h = await fixture(), proposal = await h.enter('count protected letters')
  businessTurn(h, 13)
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
  const log = h.logs.get('business')!
  log.push(...nativeTurn(23, log.length, 2))
  finish()
  await h.mount()
  await driver!.activate('business')
  const request = await improving()
  const dispatch = JSON.parse((request.message!.content[0] as { text: string }).text)
  expect(dispatch).not.toHaveProperty('summary')
  expect(dispatch).toMatchObject({ trace: 'subject.json', contract: { inputs: [{ name: 'subject.json' }] }, method: expect.any(Object) })
  const trace = JSON.parse(await readFile(join(request.cwd, dispatch.trace), 'utf8'))
  expect(trace.summary.sessions).toContainEqual(expect.objectContaining({ sessionId: 'business', tokens: 13 }))
  expect(trace.summary.usage).toEqual({ source: 'token-meter/tokenUsage', tokens: 13, complete: true })
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
it('rejects mistaken RSI submissions without closing search, then admits a legitimate proposal', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const scope = h.call(agent, 'mistaken-submit')
  const { assets } = await scope.history({ kind: 'method' }) as RsiMethodRead
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(assets,
    { ...assets, workflowGuidance: 'Use a bounded evidence pass before delegation.' }, root.taskId, 'business')))
  const before = factsOf(h.medium)
  await expect(scope.submit({ taskId: request.agentId, path: 'candidate.json' })).rejects.toThrow('artifact declared')
  await expect(scope.submit({ taskId: request.agentId, path: 'report.json' })).rejects.toThrow('ENOENT')
  expect(factsOf(h.medium)).toEqual(before)
  expect((await driver!.read()).tasks.find(task => task.taskId === request.agentId)).toMatchObject({
    phase: 'running', search: { maxProposals: 6 }, transfer: null,
  })
  screenVerdict = 'fail'
  expect(await scope.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ status: 'rejected' })
  await writeFile(join(request.cwd, 'report.json'), '{}')
  expect(await h.call(agent, 'correct-report').submit({ taskId: request.agentId, path: 'report.json' }))
    .toMatchObject({ phase: 'verified' })
  expect((await driver!.read()).tasks.find(task => task.taskId === request.agentId)!.search)
    .toMatchObject({ outcome: 'insufficient-evidence' })
})

it('admits a filled runtime JSON template with real evidence and only a workflow edit, without copying frozen assets', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const scope = h.call(agent, 'explicit-workflow')
  const read = await scope.history({ kind: 'method' }) as { assets: MethodAssets; proposal: { template: ReturnType<typeof rsiProposalTemplate> } }
  const template = read.proposal.template
  const index = await scope.history({ kind: 'trajectory', ref: 'business' }) as { seq: number }[]
  const eventSeq = index[0]!.seq
  await scope.history({ kind: 'trajectory', ref: 'business', eventSeq })
  await writeFile(join(request.cwd, 'unfilled.json'), JSON.stringify(template))
  await expect(scope.proposeMethod({ paths: ['unfilled.json'] })).rejects.toThrow('eventSeq')
  const mode = 'repeat_inspection', evidence = [{ sessionId: 'business', eventSeq, rootId: root.taskId }]
  // Fill the host's JSON directly; do not derive the Method or diff via the fixture helper.
  const proposal = { ...template,
    analysis: { ...template.analysis, failure_modes: [{ mode,
      description: 'The same frozen input can be inspected repeatedly without new evidence.',
      needed_instead: 'Reuse evidence only when the input identity matches.', evidence }] },
    edit: { ...template.edit, hypothesis: 'Matching frozen input identities makes evidence reuse safe.', targets_mode: mode,
      why_not_lower_lever: 'A conditional workflow instruction addresses the repeated inspection.',
      trigger_condition: 'An identical frozen input was already inspected.',
      predicted_affected: [root.taskId], changes: [{ asset: 'workflow', target: 'workflowGuidance', value: 'Reuse evidence only when its frozen input identity matches.' }],
      retroactive_check: { corrective: 'Avoid a repeated inspection of an unchanged input.',
        preservative: 'Keep independent acceptance unchanged.', transfer: 'Identity matching applies to unfamiliar inputs.' },
      regression_risk: 'New input identities must receive a fresh inspection.' },
  }
  expect(JSON.stringify(proposal)).not.toContain('<')
  await writeFile(join(request.cwd, 'workflow.json'), JSON.stringify(proposal))
  screenVerdict = 'fail'
  const admitted = await scope.proposeMethod({ paths: ['workflow.json'] })
  expect(admitted).toMatchObject({ admitted: true, slotsConsumed: 1, status: 'rejected', slots: [{ slot: 0, status: 'rejected' }] })
  expect(admitted).not.toHaveProperty('roundId')
  expect(factsOf(h.medium).filter(fact => fact.kind === 'review/started' &&
    (fact.payload as { target: { kind: string } }).target.kind === 'proposal')).toHaveLength(1)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/batch-slot-settled')).toHaveLength(1)
  expect(harness.solve).not.toHaveBeenCalled()
})

it.each(['rsi/batch-slot-settled', 'rsi/batch-ended'])('recovers frozen proposal bytes after interrupted %s without relying on mutable files', async failKind => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const scope = h.call(agent, 'interrupted-screen')
  const { assets } = await scope.history({ kind: 'method' }) as RsiMethodRead
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(assets,
    { ...assets, workflowGuidance: 'Check frozen evidence before delegating implementation.' }, root.taskId, 'business')))
  screenVerdict = 'fail'
  h.medium.failAppendOf(failKind)
  await expect(scope.proposeMethod({ paths: ['candidate.json'] })).rejects.toThrow('write-not-durable')
  const before = factsOf(h.medium), opened = before.find(fact => fact.kind === 'rsi/batch-opened')!
  expect(opened.payload).toMatchObject({ slots: [{ proposal: { attachmentId: expect.stringMatching(/^sha256:/) } }] })
  await rm(join(request.cwd, 'candidate.json'))
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate(String(agent.id))
  const restored = h.call(agent, 'resume-screen')
  expect(await restored.history({ kind: 'method' })).toMatchObject({ proposal: { pending: { kind: 'batch', paths: ['candidate.json'] } } })
  await expect(restored.proposeMethod({ paths: ['a-new-proposal.json'] })).rejects.toThrow('resume the frozen batch')
  expect(await restored.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ status: 'rejected' })
  expect(await restored.history({ kind: 'method' })).toMatchObject({ proposal: { pending: null } })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'review/started')).toEqual(before.filter(fact => fact.kind === 'review/started'))
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/batch-opened')).toEqual([opened])
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/batch-slot-settled')).toHaveLength(1)
  await writeFile(join(request.cwd, 'report.json'), '{}')
  expect(await restored.submit({ taskId: request.agentId, path: 'report.json' })).toMatchObject({ phase: 'verified' })
  expect(harness.solve).not.toHaveBeenCalled()
})

it('rejects invented or inaccessible proposal evidence and unsupported affected Tasks before review or execution', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!, scope = h.call(agent, 'evidence')
  const method = await scope.history({ kind: 'method' }) as RsiMethodRead
  const changed = structuredClone(method.assets)
  ;(changed.templates[0] as { applicability: string }).applicability = 'Reuse sufficient frozen evidence.'
  const proposal = rsiProposal(method.assets, changed, root.taskId, 'business')
  const before = factsOf(h.medium)
  await writeFile(join(request.cwd, 'invalid.json'), JSON.stringify({ ...proposal, analysis: { ...proposal.analysis,
    failure_modes: [{ ...proposal.analysis.failure_modes[0], evidence: [{ sessionId: 'business', eventSeq: 0, count: 8193 }] }] } }))
  await expect(scope.proposeMethod({ paths: ['invalid.json'] })).rejects.toThrow('analysis.failure_modes[0].evidence[0].count')
  expect(factsOf(h.medium)).toEqual(before)
  for (const [reference, error] of [
    [{ sessionId: 'business', eventSeq: 99999 }, 'outside this readable trajectory'],
    [{ sessionId: 'foreign-session', eventSeq: 0 }, 'frozen evidence scope'],
    [{ sessionId: 'business', eventSeq: 0, rootId: 'active-foreign-root' }, 'closed subject'],
  ] as const) {
    const invalid = { ...proposal, analysis: { ...proposal.analysis,
      failure_modes: [{ ...proposal.analysis.failure_modes[0], evidence: [reference] }] } }
    await writeFile(join(request.cwd, 'invalid.json'), JSON.stringify(invalid))
    expect(await scope.proposeMethod({ paths: ['invalid.json'] })).toMatchObject({ status: 'invalid', reason: expect.stringContaining(error) })
  }
  await writeFile(join(request.cwd, 'invalid.json'), JSON.stringify({ ...proposal, edit: { ...proposal.edit, predicted_affected: ['invented-task'] } }))
  expect(await scope.proposeMethod({ paths: ['invalid.json'] })).toMatchObject({ status: 'invalid', reason: expect.stringContaining('Tasks with cited native evidence') })
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  await writeFile(join(request.cwd, 'report.json'), '{}')
  await expect(scope.submit({ taskId: assigned.taskId, path: 'report.json' })).resolves.toMatchObject({ phase: 'verified' })
  expect((await driver!.read()).tasks.find(task => task.taskId === assigned.taskId)!.search).toMatchObject({ outcome: 'insufficient-evidence' })
  expect(factsOf(h.medium).filter(f => f.kind === 'review/started')).toHaveLength(2) // Business and the truthful RSI report.
  expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-requested')).toHaveLength(0)
  expect(harness.solve).not.toHaveBeenCalled()
})

it('allocates campaign-local round numbers when two roots finish screening concurrently', async () => {
  const h = await fixture()
  const proposals: { scope: ReturnType<typeof h.call>; path: string }[] = []
  for (let index = 0; index < 2; index++) {
    const root = await h.enter('count protected letters', `request-${index}`)
    businessTurn(h, 100)
    await writeFile(join(root.workspace, root.contract.artifact), '35')
    await h.call(h.parent, `submit-${index}`).submit({ taskId: root.taskId, path: root.contract.artifact })
    await vi.waitFor(() => expect(harness.open.mock.calls.filter(([, request]) => request.preset === 'singularity-improve')).toHaveLength(index + 1))
    const request = harness.open.mock.calls.filter(([, request]) => request.preset === 'singularity-improve')[index]![1] as ChildSessionRequest
    const agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
    const scope = h.call(agent, `proposal-${index}`)
    const baseline = await scope.history({ kind: 'method' }) as RsiMethodRead
    const candidate = structuredClone(baseline.assets)
    ;(candidate.templates[0] as { applicability: string }).applicability = 'Inspect frozen inputs once before delegation.'
    await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(baseline.assets, candidate, root.taskId, 'business')))
    proposals.push({ scope, path: 'candidate.json' })
  }
  let screened = 0, release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  beforeProposalJudgment = async () => { if (++screened === 2) release(); await ready }
  harness.solve.mockRejectedValue(new Error('test ends after round admission'))
  const results = await Promise.all(proposals.map(({ scope, path }) => scope.proposeMethod({ paths: [path] })))
  const requests = factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-requested')
  expect(requests.map(fact => (fact.payload as { round: number }).round)).toEqual([1, 1])
  expect(new Set(requests.map(fact => (fact.payload as { roundId: string }).roundId)).size).toBe(2)
  await vi.waitFor(() => expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-settled')).toHaveLength(2))
  expect(await proposals[0]!.scope.proposeMethod({ paths: [proposals[0]!.path] }))
    .toMatchObject({ roundId: (results[0] as { roundId: string }).roundId, status: 'failed' })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-requested')).toEqual(requests)
})
it.each([[false, false], [true, false], [false, true]])('handles measured outcomes; publication rejection %s, end without winner %s', async (rejectPublication, finishNegative) => {
  const h = await fixture(),
    proposal = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  await h.call(h.parent, 'submit').submit({ taskId: proposal.taskId, path: proposal.contract.artifact })
  const request = await improving(),
    agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!,
    scope = h.call(agent, 'create')
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  let candidate: unknown
  let evaluationApparatus!: Apparatus
  let trialCost = 150
  const revisionCosts = new Map<string, number>()
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
      evaluationApparatus = apparatus
      const revisionDigest = (input.revision as { digest: string }).digest
      if (!revisionCosts.has(revisionDigest)) revisionCosts.set(revisionDigest, trialCost)
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
        cost: revisionCosts.get(revisionDigest)!,
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
      workflowGuidance: string
      templates: { id: string; applicability?: string; skills: string[] }[]
      skills: { name: string; description: string; capabilities: string[]; requiredTools: string[]; content: string }[]
      tools: { name: string; source: string }[]
    }
  }
  const baselineAssets = structuredClone(method.assets) as MethodAssets
  const proposalBytes = () => JSON.stringify(rsiProposal(baselineAssets, method.assets as MethodAssets, proposal.taskId, 'business'))
  method.assets.templates[0]!.applicability = 'Use a single pass for small literal counting tasks.'
  await writeFile(join(request.cwd, 'candidate.json'), proposalBytes())
  screenVerdict = 'fail'
  expect(await scope.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ status: 'rejected', reason: expect.any(String) })
  expect(harness.solve).not.toHaveBeenCalled()
  expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-requested')).toHaveLength(0)
  method.assets.templates[0]!.applicability = 'Use a bounded evidence pass before delegation.'
  await writeFile(join(request.cwd, 'candidate.json'), proposalBytes())
  screenVerdict = 'pass'
  const round = await scope.proposeMethod({ paths: ['candidate.json'] }) as { roundId: string; status: string; revision: unknown }
  candidate = round.revision
  expect(round.status).toBe('pending')
  expect(await scope.history({ kind: 'method' })).toMatchObject({ proposal: { pending: { kind: 'evaluation', roundId: round.roundId } } })
  const batchFacts = () => factsOf(h.medium).filter(fact => fact.kind.startsWith('rsi/batch-'))
  const beforeNewBatch = batchFacts()
  const fresh = rsiProposal(baselineAssets, { ...baselineAssets, workflowGuidance: 'A fresh proposal must wait for evaluation.' }, proposal.taskId, 'business')
  await writeFile(join(request.cwd, 'too-early.json'), JSON.stringify(fresh))
  await expect(scope.proposeMethod({ paths: ['too-early.json'] })).rejects.toThrow('no candidate slots consumed')
  expect(batchFacts()).toEqual(beforeNewBatch)
  expect(await scope.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ roundId: round.roundId, status: 'pending' })
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
  expect(await scope.history({ kind: 'method' })).toMatchObject({
    reference: method.reference,
    nextRound: { editBudget: 1, remainingSlots: 4, maxBatchSlots: 3, repairsPerSlot: 0,
      untried: ['workflow', 'skill', 'tool'], prune: false, pruneSlot: null,
      historyCutoff: expect.any(Number), reservedSlot: expect.stringContaining('untried asset class') },
    feedback: { edits: [{ revision: candidate, outcome: 'not-selected' }], rejected: [{ slot: 0, status: 'rejected' }] },
    cases: [],
  })
  const decisions = factsOf(h.medium).filter((f) => f.kind === 'round/decided')
  expect(decisions).toHaveLength(1)
  expect(factsOf(h.medium).filter((f) => f.kind === 'trial/recorded')).toHaveLength(2)
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
  if (finishNegative) {
    await writeFile(join(request.cwd, 'report.json'), JSON.stringify({ result: 'no improvement' }))
    await expect(h.call(agent, 'negative-report').submit({ taskId: assigned.taskId, path: 'report.json' })).resolves.toMatchObject({ phase: 'verified' })
    expect((await driver!.read()).tasks.find(task => task.taskId === assigned.taskId)!.search).toMatchObject({ outcome: 'no-improvement' })
    expect(factsOf(h.medium).filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
    return
  }
  trialCost = 50
  publicationVerdict = rejectPublication ? 'fail' : 'pass'
  method.assets.templates[0]!.applicability = 'Reuse sufficient evidence and delegate one bounded implementation.'
  await writeFile(join(request.cwd, 'repaired.json'), proposalBytes())
  let repaired = await h.call(agent, 'repair').proposeMethod({ paths: ['repaired.json'] }) as { roundId: string; revision: { digest: string } }
  if (rejectPublication) {
    await vi.waitFor(() => expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-settled')).toHaveLength(2), { timeout: 5_000 })
    expect(factsOf(h.medium).findLast(f => f.kind === 'rsi/round-settled')!.payload).toMatchObject({ status: 'failed' })
    expect(factsOf(h.medium).filter(f => f.kind === 'pointer/switched')).toHaveLength(1)
    publicationVerdict = 'pass'
    trialCost = 25
    method.assets.templates[0]!.applicability = 'Reuse evidence only after confirming frozen input identity; delegate bounded implementation.'
    await writeFile(join(request.cwd, 'repaired-again.json'), proposalBytes())
    repaired = await h.call(agent, 'repair-again').proposeMethod({ paths: ['repaired-again.json'] }) as typeof repaired
  }
  await vi.waitFor(() => expect(factsOf(h.medium).filter(f => f.kind === 'rsi/round-settled'))
    .toHaveLength(rejectPublication ? 3 : 2), { timeout: 5_000 })
  expect(factsOf(h.medium).findLast(f => f.kind === 'rsi/round-settled')!.payload).toMatchObject({ status: 'completed' })
  expect(factsOf(h.medium).filter(f => f.kind === 'pointer/switched')).toHaveLength(2)
  expect(harness.solve).toHaveBeenCalledTimes(rejectPublication ? 4 : 2)
  const outcomes = factsOf(h.medium).filter(f => f.kind === 'rsi/round-settled')
  expect(outcomes[0]!.payload).toMatchObject({ status: 'completed' })
  const observed = factsOf(h.medium).filter(f => f.kind === 'trial/recorded').map(f => f.payload as { cost: number; detail: string })
  expect(observed.map(trial => trial.cost)).toEqual(rejectPublication ? [100, 150, 100, 50, 50, 25] : [100, 150, 100, 50])
  expect(JSON.parse(observed[0]!.detail).taskId).toBe(proposal.taskId)
  expect(JSON.parse(observed[2]!.detail).taskId).toBe(proposal.taskId)
  const reviews = factsOf(h.medium).filter(f => f.kind === 'review/started').map(f => (f.payload as { target: { kind: string } }).target.kind)
  expect(reviews.filter(kind => kind === 'proposal')).toHaveLength(rejectPublication ? 4 : 3)
  expect(reviews.filter(kind => kind === 'publication')).toHaveLength(rejectPublication ? 2 : 1)
  // A later draft must not erase this search's already committed publication.
  const { createReleaseCommands } = await import('../../src/release/commands.ts')
  await createReleaseCommands({ store: evaluationApparatus.store }).draft({ commandId: 'later-draft', revision: method.reference })
  await writeFile(join(request.cwd, 'report.json'), JSON.stringify({ result: 'published', roundId: repaired.roundId }))
  await h.call(agent, 'report').submit({ taskId: assigned.taskId, path: 'report.json' })
  expect((await driver!.read()).tasks.find(task => task.taskId === assigned.taskId)!.search).toMatchObject({ outcome: 'improved' })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast((f) => f.kind === 'rsi/status')!.payload)
    .toMatchObject({ status: 'completed' }))
})

it('records all rejected proposals within a frozen budget, resumes the same search and reports a negative result', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const scope = h.call(agent, 'rejected-proposals')
  const { assets } = await scope.history({ kind: 'method' }) as RsiMethodRead
  screenVerdict = 'fail'
  for (let index = 0; index < 6; index++) {
    const changed = { ...assets, workflowGuidance: `Unproven mechanism ${index}.` }
    await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(assets, changed, root.taskId, 'business')))
    expect(await scope.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ status: 'rejected' })
  }
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate(String(agent.id))
  const restored = h.call(agent, 'restored')
  const changed = { ...assets, workflowGuidance: 'A seventh mechanism.' }
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(assets, changed, root.taskId, 'business')))
  await expect(restored.proposeMethod({ paths: ['candidate.json'] })).rejects.toThrow('budget exhausted')
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/batch-slot-settled')).toHaveLength(6)
  expect(harness.solve).not.toHaveBeenCalled()
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  await writeFile(join(request.cwd, 'report.json'), JSON.stringify({ result: 'insufficient evidence; all candidates rejected' }))
  await expect(restored.submit({ taskId: assigned.taskId, path: 'report.json' })).resolves.toMatchObject({ phase: 'verified' })
  expect((await driver!.read()).tasks.find(task => task.taskId === assigned.taskId)!.search).toMatchObject({ outcome: 'insufficient-evidence' })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
})

it('screens a generated verifier before materializing or executing its program', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const scope = h.call(agent, 'screen-before-code')
  const { assets } = await scope.history({ kind: 'method' }) as RsiMethodRead
  const changed = { ...assets, tools: [...assets.tools, { name: 'untrusted-check', source: "throw new Error('MUST_NOT_EXECUTE_BEFORE_CRITIC')", verifier: { samples: [
    { name: 'positive', artifactContent: 'pass', inputContent: '', expected: 'pass' as const },
    { name: 'negative', artifactContent: 'fail', inputContent: '', expected: 'fail' as const },
  ] } }] }
  screenVerdict = 'fail'
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(assets, changed, root.taskId, 'business')))
  expect(await scope.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ status: 'rejected' })
  expect(factsOf(h.medium).filter(fact => fact.kind === 'revision/created')).toHaveLength(1)
  expect(harness.solve).not.toHaveBeenCalled()
})

it('settles three frozen slots once under duplicate concurrent calls and cold recovery, without evaluating rejected methods', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const scope = h.call(agent, 'three-slots')
  const { assets } = await scope.history({ kind: 'method' }) as RsiMethodRead
  const proposal = rsiProposal(assets, { ...assets, workflowGuidance: 'Check frozen input identity before reusing established evidence.' }, root.taskId, 'business')
  await writeFile(join(request.cwd, 'inaccessible.json'), JSON.stringify({ ...proposal, analysis: { ...proposal.analysis,
    failure_modes: [{ ...proposal.analysis.failure_modes[0], evidence: [{ sessionId: 'business', eventSeq: 99999 }] }] } }))
  await writeFile(join(request.cwd, 'rejected.json'), JSON.stringify(proposal))
  // Distinct proposal bytes still name the same method, so changing metadata cannot buy another screening draw.
  await writeFile(join(request.cwd, 'duplicate-method.json'), JSON.stringify({ ...proposal,
    edit: { ...proposal.edit, regression_risk: 'Changed input identities must always receive a new inspection.' } }))
  screenVerdict = 'fail'
  const input = { paths: ['inaccessible.json', 'rejected.json', 'duplicate-method.json'] }
  let release!: () => void
  const critic = new Promise<void>(resolve => { release = resolve })
  beforeProposalJudgment = () => critic
  const pending = [scope.proposeMethod(input), scope.proposeMethod(input)]
  await vi.waitFor(() => expect(factsOf(h.medium).filter(fact => fact.kind === 'review/started' &&
    (fact.payload as { target: { kind: string } }).target.kind === 'proposal')).toHaveLength(1))
  release()
  const [first, duplicate] = await Promise.all(pending)
  expect(duplicate).toEqual(first)
  expect(first).toMatchObject({ admitted: true, slotsConsumed: 3, slots: [
    { slot: 0, status: 'invalid' }, { slot: 1, status: 'rejected' }, { slot: 2, status: 'duplicate' },
  ] })
  expect(first).not.toHaveProperty('roundId')
  const batchFacts = () => factsOf(h.medium).filter(fact => fact.kind.startsWith('rsi/batch-'))
  const settled = batchFacts()
  expect(settled.map(fact => fact.kind)).toEqual([
    'rsi/batch-opened', 'rsi/batch-slot-settled', 'rsi/batch-slot-settled', 'rsi/batch-slot-settled', 'rsi/batch-ended',
  ])
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/batch-slot-settled')).toHaveLength(3)
  const reviewCount = factsOf(h.medium).filter(fact => fact.kind === 'review/started').length
  expect(await scope.proposeMethod(input)).toEqual(first)
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate(String(agent.id))
  expect(await h.call(agent, 'restored-batch').proposeMethod(input)).toEqual(first)
  expect(batchFacts()).toEqual(settled)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'review/started')).toHaveLength(reviewCount)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/round-requested')).toHaveLength(0)
  expect(harness.solve).not.toHaveBeenCalled()
})

it.each(['35', '0'])('freezes learning off and closes business result %s without starting RSI after recovery', async artifact => {
  const h = await fixture()
  const domain = await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess)
  const template = domain.templates.get(domain.rootTemplate!)!
  const contract = contractFor(domain, template, 'count protected letters')
  const root = await h.enter(JSON.stringify({ contract, learning: false }))
  await writeFile(join(root.workspace, root.contract.artifact), artifact)
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  await vi.waitFor(() => expect(factsOf(h.medium).filter(fact => fact.kind === 'task/closed'))
    .toMatchObject([{ payload: { reason: artifact === '35' ? 'accepted' : 'failed' } }]))
  expect(factsOf(h.medium).filter(fact => fact.kind === 'learning/configured'))
    .toMatchObject([{ subject: root.taskId, payload: { enabled: false } }])
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/status')).toHaveLength(0)
  expect(harness.open).not.toHaveBeenCalled()
  expect(harness.solve).not.toHaveBeenCalled()
})

it('persists root cancellation without a turn-end event and repeats it idempotently after cold recovery', async () => {
  const h = await fixture(), root = await h.enter('count protected letters')
  const cancel = vi.spyOn(h.parent, 'cancel')
  const expected = { status: 'cancelled', taskId: root.taskId }
  expect(await driver!.cancel({ sessionId: 'business' })).toEqual(expected)
  const facts = factsOf(h.medium)
  expect(facts.filter(fact => fact.kind === 'run/failed')).toMatchObject([
    { subject: root.taskId, payload: { runId: root.runId, cause: 'cancelled' } },
  ])
  expect(facts.filter(fact => fact.kind === 'task/closed')).toMatchObject([
    { subject: root.taskId, payload: { runId: root.runId, reason: 'cancelled' } },
  ])
  expect(await driver!.cancel({ sessionId: 'business' })).toEqual(expected)
  expect(factsOf(h.medium)).toEqual(facts)
  expect(cancel).toHaveBeenCalledTimes(1)
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  expect(await driver!.cancel({ sessionId: 'business' })).toEqual(expected)
  expect(factsOf(h.medium)).toEqual(facts)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'rsi/status')).toHaveLength(0)
  expect(harness.open).not.toHaveBeenCalled()
  expect(harness.solve).not.toHaveBeenCalled()
})

async function suiteCampaign({ heldout = true, validationRegression = false, existing, requestId = 'request',
  guidance = 'Reuse evidence only after checking the frozen input identity.' }: {
  heldout?: boolean; validationRegression?: boolean; existing?: Awaited<ReturnType<typeof fixture>>;
  requestId?: string; guidance?: string
} = {}) {
  const h = existing ?? await fixture({ suite: true, heldout }), root = await h.enter('count protected letters', requestId)
  const businessLog = h.logs.get('business')!
  businessLog.push(...nativeTurn(100, businessLog.length))
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, `${requestId}:suite-business-submit`).submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text) as { taskId: string; runId: string }
  const scope = () => h.call(agent, 'suite-analysis')
  const method = await scope().history({ kind: 'method' }) as RsiMethodRead
  expect(method.cases.map(c => c.caseId)).toEqual(['evolve-0'])
  const changed = structuredClone(method.assets)
  ;(changed as { workflowGuidance: string }).workflowGuidance = guidance
  const candidate = rsiProposal(method.assets, changed, root.taskId, 'business')
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify({ ...candidate, edit: { ...candidate.edit,
    predicted_cases: ['evolve-0'], predicted_families: ['evolve-family-0'] } }))
  const trials: { split: string; revision: string; taskId: string; operationId: string }[] = []
  harness.solve.mockImplementation(async (control: Apparatus, input: Parameters<EvolutionOptions['solve']>[0]) => {
    expect(input.case).toBeDefined()
    expect(input.contract).toEqual(input.case!.contract)
    expect(input.operationId).toBe(`trial:${input.trialKey}`)
    const trialId = String(agentSessionIdOf(input.operationId)), trialAgent = agentFor(trialId, trialId)
    h.logs.set(trialId, [])
    const trial = await propose(control, { agentId: trialId, sessionId: trialId, model: { provider: 'test', model: 'model-under-test' } },
      input.operationId, { contract: input.contract!, method: input.revision },
      { purpose: 'evaluation', relatedTo: { taskId: assigned.taskId, runId: assigned.runId },
        case: { caseId: input.case!.caseId, familyId: input.case!.familyId, split: input.case!.split } })
    await input.started({ taskId: trial.taskId, runId: trial.runId })
    await writeFile(join(trial.workspace, trial.contract.artifact), '35')
    await submit(control, fakeExecution(() => undefined),
      { agentId: trialId, sessionId: trialId, model: { provider: 'test', model: 'model-under-test' } },
      execFor(trialAgent, 'offline-trial-submit'), { taskId: trial.taskId, path: trial.contract.artifact },
      new AbortController().signal, fixtureReview(control))
    const run = control.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, trial.taskId)!.runs[trial.runId]!
    const baseline = input.revision.digest === method.reference.digest
    trials.push({ split: input.case!.split, revision: input.revision.digest, taskId: trial.taskId, operationId: input.operationId })
    return { taskId: trial.taskId, runId: trial.runId, quality: 1, met: true,
      cost: baseline ? 100 : validationRegression && input.case!.split === 'validation' ? 150 : 50,
      artifactDigest: run.submission!.artifactDigest, inputDigests: run.submission!.inputDigests,
      implementationDigest: REVIEW_DIGEST, acceptanceDigest: REVIEW_DIGEST, guardsMet: true }
  })
  const proposal = await scope().proposeMethod({ paths: ['candidate.json'] }) as { roundId: string; revision: RevisionRef }
  expect(proposal).toMatchObject({ status: 'pending', roundId: expect.any(String), revision: expect.any(Object) })
  await vi.waitFor(() => expect(factsOf(h.medium).find(fact => fact.kind === 'rsi/round-settled' && fact.subject === assigned.taskId)).toBeDefined(), { timeout: 10_000 })
  const settled = factsOf(h.medium).find(fact => fact.kind === 'rsi/round-settled' && fact.subject === assigned.taskId)!.payload
  expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'completed' })
  expect(trials.map(t => t.split)).toEqual(['evolve', 'evolve', 'evolve', 'evolve'])
  expect(factsOf(h.medium).filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
  expect(factsOf(h.medium).some(fact => fact.kind === 'rsi/transfer-frozen' && fact.subject === assigned.taskId)).toBe(false)
  return { ...h, request, agent, assigned, scope, method, proposal, trials }
}

it('freezes the suite champion and recovers after measured validation/heldout before publishing exactly once', async () => {
  const h = await suiteCampaign(), validationId = `${h.assigned.taskId}:validation`, heldoutId = `${h.assigned.taskId}:heldout`
  await writeFile(join(h.request.cwd, 'report.json'), JSON.stringify({ result: 'offline wiring fixture, no domain-effect claim' }))
  const beforeInvalid = factsOf(h.medium), solvesBeforeInvalid = harness.solve.mock.calls.length
  await expect(h.scope().submit({ taskId: h.assigned.taskId, path: 'candidate.json' })).rejects.toThrow('artifact declared')
  await rm(join(h.request.cwd, 'report.json'))
  await expect(h.scope().submit({ taskId: h.assigned.taskId, path: 'report.json' })).rejects.toThrow('ENOENT')
  expect(factsOf(h.medium)).toEqual(beforeInvalid)
  expect(harness.solve).toHaveBeenCalledTimes(solvesBeforeInvalid)
  await writeFile(join(h.request.cwd, 'report.json'), '{}')
  h.medium.failAppendOf('rsi/transfer-settled')
  await expect(h.scope().submit({ taskId: h.assigned.taskId, path: 'report.json' })).rejects.toThrow('write-not-durable')
  const beforeRecovery = factsOf(h.medium)
  expect(beforeRecovery.filter(fact => fact.kind === 'rsi/transfer-frozen')).toMatchObject([{ payload: {
    baseline: h.method.reference, champion: h.proposal.revision, suiteDigest: digestOf(h.domain.suite),
    executionProfileDigest: 'a'.repeat(64), roundId: validationId,
  } }])
  expect(beforeRecovery.filter(fact => fact.kind === 'rsi/transfer-started')).toHaveLength(1)
  expect(beforeRecovery.filter(fact => fact.kind === 'rsi/transfer-settled')).toHaveLength(0)
  expect(h.trials.filter(t => t.split === 'validation')).toHaveLength(12)
  expect(h.trials.filter(t => t.split === 'heldout')).toHaveLength(12)
  expect(new Set(h.trials.map(t => t.taskId)).size).toBe(28)
  expect(new Set(h.trials.map(t => t.operationId)).size).toBe(28)
  expect(beforeRecovery.filter(fact => fact.kind === 'round/decided').map(fact => fact.subject))
    .toEqual([h.proposal.roundId, validationId, heldoutId])
  expect(beforeRecovery.filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
  const observed = beforeRecovery.filter(fact => fact.kind === 'trial/recorded')
  const reviews = beforeRecovery.filter(fact => fact.kind === 'review/started')
  await driver!.close().catch(() => undefined); driver = undefined
  await h.mount()
  await driver!.activate(String(h.agent.id))
  const restored = h.call(h.agent, 'restore-transfer')
  expect(await restored.proposeMethod({ paths: ['candidate.json'] })).toMatchObject({ roundId: h.proposal.roundId, status: 'completed' })
  const fresh = rsiProposal(h.method.assets, { ...h.method.assets, workflowGuidance: 'A fresh mechanism after validation is forbidden.' }, h.assigned.taskId, 'business')
  await writeFile(join(h.request.cwd, 'after-freeze.json'), JSON.stringify({ ...fresh, edit: { ...fresh.edit,
    predicted_affected: [(factsOf(h.medium).find(fact => fact.kind === 'task/admitted')!).subject],
    predicted_cases: ['evolve-0'], predicted_families: ['evolve-family-0'] } }))
  await expect(restored.proposeMethod({ paths: ['after-freeze.json'] })).rejects.toThrow(/search ended|frozen|finish/)
  await expect(restored.history({ kind: 'round', ref: validationId })).rejects.toThrow('frozen evidence scope')
  await expect(restored.history({ kind: 'round', ref: heldoutId })).rejects.toThrow('frozen evidence scope')
  for (const split of ['validation', 'heldout']) {
    const trial = h.trials.find(t => t.split === split)!
    await expect(restored.history({ kind: 'task', ref: trial.taskId })).rejects.toThrow('evidence scope')
    await expect(restored.history({ kind: 'artifact', ref: trial.taskId })).rejects.toThrow('evidence scope')
  }
  expect(await restored.submit({ taskId: h.assigned.taskId, path: 'report.json' })).toMatchObject({ phase: 'verified' })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload)
    .toMatchObject({ status: 'completed' }))
  expect(harness.solve).toHaveBeenCalledTimes(28)
  const final = factsOf(h.medium)
  expect(final.filter(fact => fact.kind === 'trial/recorded')).toEqual(observed)
  expect(final.filter(fact => fact.kind === 'review/started').slice(0, reviews.length)).toEqual(reviews)
  expect(final.filter(fact => fact.kind === 'rsi/transfer-frozen')).toHaveLength(1)
  expect(final.filter(fact => fact.kind === 'rsi/transfer-started')).toHaveLength(1)
  expect(final.filter(fact => fact.kind === 'rsi/transfer-settled')).toMatchObject([{ payload: { outcome: 'improved',
    report: { attachmentId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), name: 'transfer-report.json', bytes: expect.any(Number) } } }])
  const published = final.filter(fact => fact.kind === 'pointer/switched')
  expect(published).toHaveLength(2)
  expect(published[1]!.payload).toMatchObject({ to: h.proposal.revision.revisionId })
  expect((await driver!.read()).tasks.find(task => task.taskId === h.assigned.taskId)!.search).toMatchObject({ outcome: 'improved' })
  const publication = harness.open.mock.calls.findLast(([, request]) => request.preset === 'singularity-review' &&
    JSON.parse((request.message.content[0] as { text: string }).text).purpose === 'publication')![1] as ChildSessionRequest
  const subject = JSON.parse(await readFile(join(publication.cwd, 'subject.json'), 'utf8'))
  expect(subject.transfer).toMatchObject({ champion: h.proposal.revision, outcome: 'improved', consumed: true,
    report: { paired: { status: 'improved', costCoverage: 1, families: expect.any(Array) },
      heldout: { status: 'improved', costCoverage: 1 }, claim: expect.stringContaining('no broad domain') } })
  expect(subject.evidence.map((e: { matrix: { split: string } }) => e.matrix.split)).toEqual(['validation', 'validation'])
  const snapshot = await driver!.read()
  expect(snapshot.tasks.find(task => task.taskId === h.assigned.taskId)).toMatchObject({
    transfer: { report: { bytes: expect.any(Number), attachmentId: expect.stringMatching(/^sha256:/) } },
    transferReport: subject.transfer.report,
  })
  const exported = taskReport(snapshot, business(h))
  expect(exported.rounds.map((round: { roundId: string }) => round.roundId)).toEqual([h.proposal.roundId, validationId, heldoutId])
  expect(exported.tasks.find((task: { taskId: string }) => task.taskId === h.assigned.taskId).transferReport).toEqual(subject.transfer.report)
  for (const roundId of [validationId, heldoutId]) {
    const round = exported.rounds.find((item: { roundId: string }) => item.roundId === roundId)
    expect(round.evaluations.map((evaluation: { state: { observed: unknown[] } }) => evaluation.state.observed.length)).toEqual([6, 6])
    expect(round.evaluations[1].paired).toMatchObject({ status: 'improved', costCoverage: 1, families: expect.any(Array) })
  }
  const replacement = await h.enter('next business root after validated publication', 'after-publication')
  expect(replacement.method).toEqual(h.proposal.revision)
  expect(h.method.reference.digest).not.toBe(replacement.method.digest)
  expect(await h.call(h.parent, 'read-published-method').history({ kind: 'method' })).toMatchObject({ method: h.proposal.revision })
  expect(factsOf(h.medium).findLast(fact => fact.kind === 'method/consumed' && fact.subject === replacement.taskId &&
    (fact.payload as { mode: string }).mode === 'read')!.payload)
    .toMatchObject({ revision: h.proposal.revision, mode: 'read' })
}, 30_000)

it('closes an unseen validation cost regression without publishing, resampling or exposing private trial feedback', async () => {
  const h = await suiteCampaign({ heldout: false, validationRegression: true }), validationId = `${h.assigned.taskId}:validation`
  await writeFile(join(h.request.cwd, 'report.json'), JSON.stringify({ result: 'validation did not establish improvement' }))
  expect(await h.scope().submit({ taskId: h.assigned.taskId, path: 'report.json' })).toMatchObject({ phase: 'verified' })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'completed' }))
  expect(h.trials.filter(t => t.split === 'validation')).toHaveLength(12)
  expect(h.trials.filter(t => t.split === 'heldout')).toHaveLength(0)
  const final = factsOf(h.medium)
  expect(final.filter(fact => fact.kind === 'rsi/transfer-settled')).toMatchObject([{ payload: { outcome: 'no-improvement' } }])
  expect(final.filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
  expect((await driver!.read()).tasks.find(task => task.taskId === h.assigned.taskId)!.search).toMatchObject({ outcome: 'no-improvement' })
  expect(harness.open.mock.calls.filter(([, request]) => request.preset === 'singularity-review' &&
    JSON.parse((request.message.content[0] as { text: string }).text).purpose === 'publication')).toHaveLength(0)
  await expect(h.scope().history({ kind: 'round', ref: validationId })).rejects.toThrow('frozen evidence scope')
  await expect(h.scope().history({ kind: 'task', ref: h.trials.find(t => t.split === 'validation')!.taskId })).rejects.toThrow('evidence scope')
  const exported = taskReport(await driver!.read(), business(h))
  expect(exported.tasks.find((task: { taskId: string }) => task.taskId === h.assigned.taskId)).toMatchObject({
    transfer: { outcome: 'no-improvement' },
    transferReport: { paired: { status: 'no-improvement', costCoverage: 1, reason: 'cost coverage or ceiling failed' }, heldout: null },
  })
  expect(exported.rounds.map((round: { roundId: string }) => round.roundId)).toEqual([h.proposal.roundId, validationId])
  const measured = final.filter(fact => fact.kind === 'trial/recorded')
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate(String(h.agent.id))
  expect(factsOf(h.medium).filter(fact => fact.kind === 'trial/recorded')).toEqual(measured)
  expect(harness.solve).toHaveBeenCalledTimes(16)
  const replacement = await h.enter('business root after honest negative result', 'after-negative')
  expect(replacement.method).toEqual(h.method.reference)
}, 30_000)

it.each(['family', 'contract'] as const)('rejects a new validation tranche reusing a previously measured heldout %s', async overlap => {
  const h = await suiteCampaign({ validationRegression: true })
  await writeFile(join(h.request.cwd, 'report.json'), JSON.stringify({ result: 'first independent comparison' }))
  await h.scope().submit({ taskId: h.assigned.taskId, path: 'report.json' })
  await vi.waitFor(() => expect(factsOf(h.medium).findLast(fact => fact.kind === 'rsi/status')!.payload).toMatchObject({ status: 'completed' }))
  expect(h.trials.filter(trial => trial.split === 'heldout')).toHaveLength(12)
  const previous = h.domain.suite!, reused = previous.cases.find(c => c.split === 'heldout')!
  Object.assign(h.domain, { suite: parseSuite({ ...previous, suiteId: 'fresh-suite-with-reused-heldout',
    cases: previous.cases.filter(c => c.split !== 'heldout').map(c => {
      if (c.split === 'evolve') return c
      const fresh = { ...c, caseId: `fresh-${c.caseId}`, familyId: `fresh-${c.familyId}`, sourceId: `fresh-${c.sourceId}`,
        contract: { ...c.contract, goal: `Fresh validation contract ${c.caseId}` } }
      return { ...fresh, ...(c.caseId === 'validation-0' ? overlap === 'family' ? { familyId: reused.familyId } : { contract: reused.contract } : {}) }
    }) }) })
  harness.open.mockClear()
  const fresh = await suiteCampaign({ existing: h, requestId: 'fresh-suite', guidance: 'Check a second independent mechanism before accepting an observation.' })
  await writeFile(join(fresh.request.cwd, 'report.json'), JSON.stringify({ result: 'reused heldout is not untouched validation' }))
  await fresh.scope().submit({ taskId: fresh.assigned.taskId, path: 'report.json' })
  const state = (await driver!.read()).tasks.find(task => task.taskId === fresh.assigned.taskId)!
  expect(state).toMatchObject({ transfer: { consumed: true, outcome: 'insufficient-evidence' },
    transferReport: { status: 'insufficient-evidence', reason: expect.stringContaining('validation tranche was consumed') } })
  expect(fresh.trials.map(trial => trial.split)).toEqual(['evolve', 'evolve', 'evolve', 'evolve'])
  expect(factsOf(h.medium).filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
}, 30_000)

it('keeps old native steps outside the next root budget, then terminates the current root and every descendant at maxSteps', async () => {
  const h = await fixture(), contract = contractFor(h.domain, h.domain.templates.get(h.domain.rootTemplate!)!, 'count protected letters')
  const previous = await h.enter(JSON.stringify({ contract, learning: false }), 'old-root')
  await writeFile(join(previous.workspace, previous.contract.artifact), '35')
  await h.call(h.parent, 'old-root-submit').submit({ taskId: previous.taskId, path: previous.contract.artifact })
  await vi.waitFor(() => expect(factsOf(h.medium).some(fact => fact.kind === 'task/closed' && fact.subject === previous.taskId)).toBe(true))
  const appendSteps = (sessionId: string, count: number) => {
    const log = h.logs.get(sessionId)!
    for (let index = 0; index < count; index++) log.push({ seq: SessionSeq(log.length), time: log.length,
      type: 'step/start', data: { turn: 1, step: index + 1 } })
  }
  appendSteps('business', DEFAULT_WORKFLOW_LIMITS.maxSteps)
  const root = await h.enter(JSON.stringify({ contract, learning: false }), 'fresh-root')
  appendSteps('business', 1)
  const log = h.logs.get('business')!
  log.push({ seq: SessionSeq(log.length), time: log.length, type: 'user/message', surfaceOp: 'append', data: h.dispatches.at(-1)! })
  const childContract = { goal: 'Inspect the first half of the protected input', artifact: 'evidence.txt', inputs: contract.inputs,
    criteria: [{ criterionId: 'partial-evidence', statement: 'Record independently checkable observations for the first half.' }] }
  const child = await h.call(h.parent, 'budget-child').decompose({ taskId: root.taskId, children: [
    { key: 'inspect', contract: childContract, dependsOn: [], supports: contract.criteria.map(c => c.criterionId), maxRuns: 1, requirement: 'required' },
  ] })
  const childId = child.opened[0]!, childAgent = h.agents.get(String(agentSessionIdOf(childId)))!
  const grand = await h.call(childAgent, 'budget-grandchild').decompose({ taskId: childId, children: [
    { key: 'bounded-fact', contract: { ...childContract, goal: 'Check one unresolved boundary in the first half' }, dependsOn: [],
      supports: childContract.criteria.map(c => c.criterionId), maxRuns: 1, requirement: 'required' },
  ] })
  const grandId = grand.opened[0]!, grandAgent = h.agents.get(String(agentSessionIdOf(grandId)))!
  const rootCancel = vi.spyOn(h.parent, 'cancel'), childCancel = vi.spyOn(childAgent, 'cancel'), grandCancel = vi.spyOn(grandAgent, 'cancel')
  expect(await driver!.enter(grandAgent, [], { provider: 'test', model: 'model-under-test' })).toBeUndefined()
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/failed' && fact.subject === root.taskId)).toHaveLength(0)
  appendSteps(String(childAgent.id), DEFAULT_WORKFLOW_LIMITS.maxSteps - 2)
  appendSteps(String(grandAgent.id), 1)
  await driver!.enter(grandAgent, [], { provider: 'test', model: 'model-under-test' })
  const final = factsOf(h.medium), ids = [root.taskId, childId, grandId]
  for (const id of ids) expect(final.filter(fact => fact.kind === 'run/failed' && fact.subject === id)).toHaveLength(1)
  expect(final.find(fact => fact.kind === 'run/failed' && fact.subject === root.taskId)!.payload)
    .toMatchObject({ cause: 'business', reason: expect.stringContaining('workflow step limit') })
  expect(rootCancel).toHaveBeenCalledTimes(1)
  expect(childCancel).toHaveBeenCalled()
  expect(grandCancel).toHaveBeenCalled()
  expect(final.find(fact => fact.kind === 'task/closed' && fact.subject === root.taskId)!.payload).toMatchObject({ reason: 'failed' })
  expect(final.some(fact => fact.kind === 'rsi/status')).toBe(false)
  await expect(h.call(grandAgent, 'after-budget').submit({ taskId: grandId, path: 'evidence.txt' })).rejects.toThrow()
  const failures = final.filter(fact => fact.kind === 'run/failed')
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await driver!.activate(String(childAgent.id))
  await driver!.activate(String(grandAgent.id))
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/failed')).toEqual(failures)
  expect(harness.open.mock.calls.filter(([, request]) => [childId, grandId].includes(request.agentId))).toHaveLength(2)
})

it.each(['pending', 'running'] as const)('cancels %s RSI through the closed business root and never restarts it after recovery', async phase => {
  const h = await fixture(), root = await h.enter('count protected letters')
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'submit-before-cancel').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = phase === 'running' ? await improving() : undefined
  const expected = { status: 'cancelled', taskId: root.taskId }
  expect(await driver!.cancel({ sessionId: 'business' })).toEqual(expected)
  await vi.waitFor(async () => {
    const snapshot = await driver!.read()
    expect(snapshot.tasks.find(task => task.taskId === root.taskId)).toMatchObject({ phase: 'verified', closure: { reason: 'accepted' }, rsi: { status: 'cancelled' } })
    expect(snapshot.tasks.filter(task => task.purpose === 'improve').every(task => task.phase === 'failed')).toBe(true)
  })
  if (request !== undefined) expect(request.signal.aborted).toBe(true)
  const before = factsOf(h.medium), opened = harness.open.mock.calls.length
  expect(await driver!.cancel({ sessionId: 'business' })).toEqual(expected)
  expect(factsOf(h.medium)).toEqual(before)
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(factsOf(h.medium)).toEqual(before)
  expect(harness.open).toHaveBeenCalledTimes(opened)
  expect(harness.solve).not.toHaveBeenCalled()
})

async function cancellableProposal() {
  const h = await fixture(), root = await h.enter('count protected letters')
  businessTurn(h, 100)
  await writeFile(join(root.workspace, root.contract.artifact), '35')
  await h.call(h.parent, 'business-submit').submit({ taskId: root.taskId, path: root.contract.artifact })
  const request = await improving(), agent = h.agents.get(String(agentSessionIdOf(request.agentId)))!
  const assigned = JSON.parse((request.message!.content[0] as { text: string }).text)
  const scope = h.call(agent, 'cancelled-proposal')
  const { assets } = await scope.history({ kind: 'method' }) as RsiMethodRead
  await writeFile(join(request.cwd, 'candidate.json'), JSON.stringify(rsiProposal(assets,
    { ...assets, workflowGuidance: 'Inspect input identities once before repeating an evidence pass.' }, root.taskId, 'business')))
  return { ...h, request, agent, assigned, scope }
}

it('cancels an active proposal review without materializing its method or evaluating it', async () => {
  const h = await cancellableProposal()
  const gate = new Promise<void>(resolve => { releaseSolve = resolve })
  let reviewing = false
  beforeProposalJudgment = () => { reviewing = true; return gate }
  const pending = h.scope.proposeMethod({ paths: ['candidate.json'] }).then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(reviewing).toBe(true))
  await driver!.cancel({ sessionId: 'business' })
  releaseSolve!()
  expect(await pending).toHaveProperty('error')
  const snapshot = await driver!.read()
  expect(snapshot.reviews.filter(review => review.target.kind === 'proposal')).toMatchObject([{ status: 'failed', failure: 'RSI cancelled by user' }])
  expect(snapshot.methods).toHaveLength(1)
  expect(factsOf(h.medium).some(fact => fact.kind === 'rsi/round-requested')).toBe(false)
  expect(harness.solve).not.toHaveBeenCalled()
  const before = factsOf(h.medium), opened = harness.open.mock.calls.length
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await driver!.activate(String(h.agent.id))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(factsOf(h.medium)).toEqual(before)
  expect(harness.open).toHaveBeenCalledTimes(opened)
})

it.each([['evaluation', 'cancelled'], ['validation', 'cancelled'], ['evaluation', 'failed'], ['validation', 'failed']] as const)('stops active %s Runs on RSI %s while preserving the business result', async (phase, ending) => {
  const h = phase === 'validation' ? await suiteCampaign({ heldout: false }) : await cancellableProposal()
  const assigned = h.assigned as { taskId: string; runId: string }
  let evaluationTaskId!: string, childTaskId!: string, signal!: AbortSignal
  const gate = new Promise<void>(resolve => { releaseSolve = resolve })
  harness.solve.mockImplementation(async (control: Apparatus, input: Parameters<EvolutionOptions['solve']>[0], activeSignal: AbortSignal) => {
    signal = activeSignal
    const sessionId = String(agentSessionIdOf(input.operationId))
    const agent = { ...agentFor(sessionId, sessionId), cancel: vi.fn() } as Agent
    h.agents.set(sessionId, agent)
    h.logs.set(sessionId, [])
    const trial = await propose(control, { agentId: sessionId, sessionId, model: { provider: 'test', model: 'model-under-test' } },
      input.operationId, { contract: input.contract ?? control.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, business(h))!.contract!, method: input.revision },
      { purpose: 'evaluation', relatedTo: { taskId: assigned.taskId, runId: assigned.runId } })
    evaluationTaskId = trial.taskId
    await input.started({ taskId: trial.taskId, runId: trial.runId })
    childTaskId = (await h.call(agent, 'cancel-evaluation-child').decompose({ taskId: trial.taskId, children: [
      { key: 'evidence', contract: { goal: 'Inspect a bounded evidence region', artifact: 'partial.txt', inputs: trial.contract.inputs, criteria: trial.contract.criteria }, dependsOn: [],
        supports: trial.contract.criteria.map(c => c.criterionId), maxRuns: 1, requirement: 'required' },
    ] })).opened[0]!
    await gate
    activeSignal.throwIfAborted()
    throw new Error('expected cancellation')
  })
  let pending: Promise<unknown> | undefined
  if (phase === 'validation') {
    await writeFile(join(h.request.cwd, 'report.json'), '{}')
    pending = (h.scope as () => ReturnType<typeof h.call>)().submit({ taskId: assigned.taskId, path: 'report.json' })
      .then(value => ({ value }), error => ({ error }))
  } else {
    await (h.scope as ReturnType<typeof h.call>).proposeMethod({ paths: ['candidate.json'] })
  }
  await vi.waitFor(() => expect(childTaskId, harness.solve.mock.settledResults.map(result => String(result.value)).join('\n')).toBeDefined())
  if (ending === 'cancelled') await driver!.cancel({ sessionId: 'business' })
  else await h.reportFailure({ sessionId: String(h.agent.id), turn: 1, seq: 99,
    reason: { kind: 'error', error: { code: 'SERVER', message: 'native retries exhausted' } } })
  expect(signal.aborted).toBe(true)
  releaseSolve!()
  if (pending !== undefined) expect(await pending).toHaveProperty('error')
  await vi.waitFor(async () => {
    const snapshot = await driver!.read()
    expect(snapshot.tasks.find(task => task.taskId === business(h))).toMatchObject({ phase: 'verified', rsi: { status: ending } })
    for (const taskId of [assigned.taskId, evaluationTaskId, childTaskId])
      expect(snapshot.tasks.find(task => task.taskId === taskId)).toMatchObject({ phase: 'failed' })
  })
  const final = factsOf(h.medium)
  for (const taskId of [assigned.taskId, evaluationTaskId, childTaskId])
    expect(final.findLast(fact => fact.subject === taskId && fact.kind === 'run/failed')!.payload).toMatchObject({ cause: ending === 'cancelled' ? 'cancelled' : 'runtime' })
  expect(final.filter(fact => fact.kind === 'pointer/switched')).toHaveLength(1)
  if (phase === 'validation')
    expect(final.filter(fact => fact.kind === 'rsi/transfer-settled')).toMatchObject([{ payload: { outcome: 'insufficient-evidence' } }])
  else
    expect(final.filter(fact => fact.kind === 'rsi/round-settled')).toMatchObject([{ payload: { status: 'failed',
      error: ending === 'cancelled' ? 'RSI cancelled by user' : expect.stringContaining('RSI analysis Run failed') } }])
  const calls = harness.solve.mock.calls.length, opened = harness.open.mock.calls.length
  await driver!.close(); driver = undefined
  await h.mount()
  await driver!.activate('business')
  await driver!.activate(String(h.agent.id))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(harness.solve).toHaveBeenCalledTimes(calls)
  expect(harness.open).toHaveBeenCalledTimes(opened)
  expect(factsOf(h.medium).filter(fact => fact.kind === 'run/failed')).toEqual(final.filter(fact => fact.kind === 'run/failed'))
}, 30_000)

it('bounds an independent proposal critic by native steps and records its failure without evaluating', async () => {
  const h = await cancellableProposal()
  let critic!: Agent
  const gate = new Promise<void>(resolve => { releaseSolve = resolve })
  beforeProposalJudgment = async () => {
    const review = (await driver!.read()).reviews.find(review => review.target.kind === 'proposal')!
    critic = h.agents.get(review.sessionId)!
    const log = h.logs.get(review.sessionId)!
    for (let index = 0; index < DEFAULT_WORKFLOW_LIMITS.maxSteps; index++)
      log.push({ seq: SessionSeq(log.length), time: log.length, type: 'step/start', data: { turn: 1, step: index + 1 } })
    await gate
  }
  const pending = h.scope.proposeMethod({ paths: ['candidate.json'] })
  await vi.waitFor(() => expect(critic).toBeDefined())
  const cancel = vi.spyOn(critic, 'cancel')
  await driver!.enter(critic, [], { provider: 'test', model: 'model-under-test' })
  releaseSolve!()
  expect(await pending).toMatchObject({ status: 'screen-failed' })
  expect((await driver!.read()).reviews.find(review => review.target.kind === 'proposal')).toMatchObject({ status: 'failed', failure: expect.stringContaining('review step limit') })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(harness.solve).not.toHaveBeenCalled()
})

it('cancels the selected old root RSI while its shared session runs a newer business root', async () => {
  const h = await fixture(), old = await h.enter('count protected letters', 'old-business')
  await writeFile(join(old.workspace, old.contract.artifact), '35')
  await h.call(h.parent, 'old-business-submit').submit({ taskId: old.taskId, path: old.contract.artifact })
  const request = await improving(), next = await h.enter('count protected letters again', 'next-business')
  const cancel = vi.spyOn(h.parent, 'cancel')
  await expect(driver!.cancel({ sessionId: 'different-session', taskId: old.taskId })).rejects.toThrow('business root session')
  await expect(driver!.cancel({ sessionId: String(agentSessionIdOf(request.agentId)), taskId: request.agentId })).rejects.toThrow('business root session')
  expect(await driver!.cancel({ sessionId: 'business', taskId: old.taskId })).toEqual({ status: 'cancelled', taskId: old.taskId })
  expect(request.signal.aborted).toBe(true)
  const snapshot = await driver!.read()
  expect(snapshot.tasks.find(task => task.taskId === old.taskId)).toMatchObject({ phase: 'verified', closure: { reason: 'accepted' }, rsi: { status: 'cancelled' } })
  expect(snapshot.tasks.find(task => task.taskId === next.taskId)).toMatchObject({ phase: 'running', closure: null, rsi: null })
  expect(cancel).not.toHaveBeenCalled()
  await writeFile(join(next.workspace, next.contract.artifact), '35')
  expect(await h.call(h.parent, 'new-business-submit').submit({ taskId: next.taskId, path: next.contract.artifact })).toMatchObject({ phase: 'verified' })
})

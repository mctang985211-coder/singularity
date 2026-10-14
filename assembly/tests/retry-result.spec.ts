import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionAccess, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, expect, it, vi } from 'vitest'

import { openChildSession, type ChildSession } from '../../src/runtime/child-session.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import { createReleaseCommands } from '../../src/release/commands.ts'
import { publishedMethod } from '../src/method.ts'
import { openApparatus, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { createEvolution } from '../src/evolution.ts'
import { sha256 } from '../src/ids.ts'
import { createMethod, loadMethod, methodOfRun } from '../src/method.ts'
import { createNativeSolve } from '../src/native-solve.ts'
import { spawnProcess } from '../src/process.ts'
import { reviewSubject } from '../src/review.ts'
import { decompose, propose, retry } from '../src/surfaces.ts'
import { startAttempt } from '../src/attempt.ts'
import { explorationOf } from '../src/improvement.ts'
import { evaluationCostSummaryOf, taskSessionsOf } from '../src/evaluation-cost.ts'
import { submit } from '../src/submission.ts'
import { agentFor, attachmentsAt, execFor, fakeExecution, FakePersistence } from './seam.ts'

vi.mock('../../src/runtime/child-session.ts', () => ({ openChildSession: vi.fn() }))
const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const signal = new AbortController().signal
const execution = fakeExecution(() => undefined)
const caller = { agentId: 'parent', sessionId: 'parent', model: { provider: 'test', model: 'model-under-test' } }
const parent = agentFor(caller.agentId, caller.sessionId)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.resetAllMocks(); for (const close of cleanups.splice(0)) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-retry-result-'))
  const medium = new FakePersistence()
  const transcripts = new Map<string, readonly SessionEvent[]>()
  const persistence = {
    create: medium.create.bind(medium),
    open: async (id: SessionId, access: SessionAccess) => transcripts.has(id)
      ? { read: async () => ({ events: transcripts.get(id)! }), close: async () => undefined }
      : medium.open(id, access),
  } as unknown as SessionPersistence
  const apparatus = await openApparatus('retry-result', root, await loadDomain(domainDir, spawnProcess), persistence, attachmentsAt(root))
  cleanups.push(async () => { await apparatus.store.close(); await rm(root, { recursive: true, force: true }) })
  return { apparatus, medium, transcripts }
}
const session = (wait: () => Promise<void>): ChildSession => ({
  agentId: 'fixture', sessionId: 'fixture', resumed: false, agent: undefined, delivery: 'posted',
  post: async () => 'posted', wait, stop: () => undefined, close: async () => undefined,
})

it('preserves sealed failed branches in the structural summary and splits complete subtree costs without changing their total', async () => {
  const { apparatus, transcripts } = await fixture()
  const transcript = (tokens: number) => [{ seq: 0, time: 1, type: 'assistant/message', data: { usage: { totalTokens: tokens } } }] as unknown as SessionEvent[]
  const sealedExecution = { ...execution, sealTranscript: async (exec: Parameters<typeof execution.sealTranscript>[0]) => {
    const sessionId = String(exec.agent!.session.id), events = transcripts.get(sessionId)!
    return { sessionId, eventCount: events.length, digest: digestOf({ sessionId, eventCount: events.length, events }) }
  } }
  const root = await propose(apparatus, caller, 'summary-owner', { goal: 'count letters' })
  await decompose(apparatus, { advance: async () => [], close: async () => undefined }, caller, { taskId: root.taskId,
    children: ['bad', 'good'].map(key => ({ key, template: 'count-source', dependsOn: [], supports: ['letters'], maxRuns: 1 })) })
  const children = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].filter(task => task.taskId !== root.taskId)
  for (const [index, child] of children.entries()) {
    const agentId = child.responsibility!.agentId, worker = { ...caller, agentId, sessionId: agentId }
    await startAttempt(apparatus, worker, child.taskId, 'work')
    transcripts.set(agentId, transcript(index === 0 ? 20 : 30))
    await submit(apparatus, sealedExecution, worker, execFor(agentFor(agentId, agentId), 'answer'),
      { taskId: child.taskId, program: `process.stdout.write('${index === 0 ? '0' : '35'}')` }, signal)
  }
  transcripts.set(caller.sessionId, transcript(100))
  await submit(apparatus, sealedExecution, caller, execFor(parent, 'root-answer'), { taskId: root.taskId, program: "process.stdout.write('35')" }, signal)
  const trace = JSON.parse((await explorationOf(apparatus, root.taskId, root.runId)).toString('utf8'))
  expect(trace.summary.tasks).toHaveLength(3)
  const failed = trace.summary.tasks.find((task: { taskId: string }) => task.taskId === children[0]!.taskId).runs[0]
  expect(failed).toMatchObject({ status: 'failed', failureCause: 'acceptance', artifact: { digest: expect.any(String) }, verdicts: [{ verdict: 'fail' }] })
  expect(trace.summary.sessions.reduce((sum: number, held: { tokens: number }) => sum + held.tokens, 0)).toBe(150)
  expect(trace.summary.tasks.find((task: { taskId: string }) => task.taskId === root.taskId).runs[0].status).toBe('verified')
  vi.mocked(openChildSession).mockImplementation(async (_seams, request) => session(async () => {
    if (request.message.source.kind !== 'singularity') throw new Error('missing assignment')
    const agentId = String(agentSessionIdOf(request.agentId)), reviewer = { ...caller, agentId, sessionId: agentId }
    const taskId = request.message.source.taskId, run = taskStateOf(apparatus, taskId).runs[request.message.source.runId]!
    transcripts.set(agentId, transcript(40))
    await submit(apparatus, sealedExecution, reviewer, execFor(agentFor(agentId, agentId), 'review-answer'), { taskId,
      program: JSON.stringify({ subjectDigest: run.bubble!.inputs[0]!.digest, verdict: 'pass', detail: 'admitted exact fixture' }) }, signal)
  }))
  await reviewSubject(apparatus, {}, parent, 'asset-review-cost', { purpose: 'asset-admission' }, signal)
  const basis = { proposal: { sessionId: 'proposer', sessions: [], tokens: 11, share: 11, candidates: [] },
    sessions: [...taskSessionsOf(apparatus, root.taskId)].map(sessionId => ({ sessionId, end: 1, tokens: (transcripts.get(sessionId)![0]!.data as { usage: { totalTokens: number } }).usage.totalTokens })) }
  expect(await evaluationCostSummaryOf(apparatus, basis)).toEqual({ executionTokens: 150, proposalTokens: 11, assetReviewTokens: 40, totalTokens: 201 })
})

it('returns the independently verified review retry and reuses its sealed decision on recovery', async () => {
  const { apparatus, medium } = await fixture()
  let taskId = '', finalRunId = ''
  vi.mocked(openChildSession).mockImplementation(async (_seams, request) => session(async () => {
    if (request.message.source.kind !== 'singularity') throw new Error('missing assignment')
    taskId = request.message.source.taskId
    const reviewer = { ...caller, agentId: String(agentSessionIdOf(request.agentId)), sessionId: String(agentSessionIdOf(request.agentId)) }
    await submit(apparatus, execution, reviewer, execFor(agentFor(reviewer.agentId, reviewer.sessionId), 'bad-json'),
      { taskId, program: '#!/usr/bin/env node\n' }, signal)
    const next = await retry(apparatus, reviewer, 'review-retry', { taskId })
    finalRunId = next.runId
    const subjectDigest = sha256(next.inputContent)
    await submit(apparatus, execution, reviewer, execFor(agentFor(reviewer.agentId, reviewer.sessionId), 'good-json'),
      { taskId, program: JSON.stringify({ subjectDigest, verdict: 'pass', detail: 'verified exact fixture' }) }, signal)
  }))
  const witness = await reviewSubject(apparatus, {}, parent, 'review', { purpose: 'fixture' }, signal)
  expect(witness).toMatchObject({ taskId, runId: finalRunId, verdict: 'pass' })
  expect(Object.values(taskStateOf(apparatus, taskId).runs).map(run => run.status)).toEqual(['failed', 'verified'])
  const cutoff = medium.events.length
  expect(await reviewSubject(apparatus, {}, parent, 'review', { purpose: 'fixture' }, signal)).toEqual(witness)
  expect(medium.events).toHaveLength(cutoff)
  expect(openChildSession).toHaveBeenCalledTimes(1)
})

it.each(['fail', 'partial', 'unknown', 'malformed'])('does not approve a %s review result', async verdict => {
  const { apparatus } = await fixture()
  vi.mocked(openChildSession).mockImplementation(async (_seams, request) => session(async () => {
    if (request.message.source.kind !== 'singularity') throw new Error('missing assignment')
    const reviewer = { ...caller, agentId: String(agentSessionIdOf(request.agentId)), sessionId: String(agentSessionIdOf(request.agentId)) }
    const taskId = request.message.source.taskId
    const run = taskStateOf(apparatus, taskId).runs[request.message.source.runId]!
    const program = verdict === 'malformed' ? '#!/usr/bin/env node\n' : JSON.stringify({
      subjectDigest: run.bubble!.inputs[0]!.digest, verdict, detail: 'not approved',
    })
    await submit(apparatus, execution, reviewer, execFor(agentFor(reviewer.agentId, reviewer.sessionId), 'decision'), { taskId, program }, signal)
  }))
  await expect(reviewSubject(apparatus, {}, parent, 'review', { purpose: 'fixture' }, signal)).rejects.toMatchObject({
    refusal: { code: 'unapproved-revision' },
  })
})

it('publishes only the exact independently reviewed draft and reuses its committed approval', async () => {
  const { apparatus, medium } = await fixture()
  const owner = await propose(apparatus, caller, 'publication-owner', { goal: 'count letters' })
  const revision = methodOfRun(apparatus, taskStateOf(apparatus, owner.taskId).runs[owner.runId]!)!
  const releases = createReleaseCommands({ store: apparatus.store })
  expect(Object.keys(releases).sort()).toEqual(['approveReview', 'draft', 'draftFromDecision', 'publish'])
  const drafted = await releases.draft({ commandId: 'publication-draft', revision })
  vi.mocked(openChildSession).mockImplementation(async (_seams, request) => session(async () => {
    if (request.message.source.kind !== 'singularity') throw new Error('missing assignment')
    const reviewer = { ...caller, agentId: String(agentSessionIdOf(request.agentId)), sessionId: String(agentSessionIdOf(request.agentId)) }
    const taskId = request.message.source.taskId
    const run = taskStateOf(apparatus, taskId).runs[request.message.source.runId]!
    await submit(apparatus, execution, reviewer, execFor(agentFor(reviewer.agentId, reviewer.sessionId), 'publication-decision'),
      { taskId, program: JSON.stringify({ subjectDigest: run.bubble!.inputs[0]!.digest, verdict: 'pass', detail: 'reviewed exact assets and draft' }) }, signal)
  }))
  const witness = await reviewSubject(apparatus, {}, parent, 'publication-review',
    { purpose: 'publication', draft: drafted.payload, assets: (await loadMethod(apparatus, revision)).assets }, signal)
  const request = { commandId: 'publication-approved', environmentId: revision.environmentId, revisionId: revision.revisionId,
    draftDigest: (drafted.payload as { draftDigest: string }).draftDigest, witness }
  await expect(releases.approveReview({ ...request, witness: { ...witness, subjectDigest: '0'.repeat(64) } }))
    .rejects.toMatchObject({ refusal: { code: 'unapproved-revision' } })
  const approved = await releases.approveReview(request)
  const cutoff = medium.events.length
  expect(await releases.approveReview(request)).toEqual(approved)
  expect(medium.events).toHaveLength(cutoff)
  await releases.publish({ commandId: 'publication-published', environmentId: revision.environmentId, expected: '', to: revision.revisionId })
  expect(publishedMethod(apparatus)).toEqual(revision)
})

it('records a verified solve retry against the original evaluation and reaches the candidate without executing the baseline again', async () => {
  const { apparatus, transcripts, medium } = await fixture()
  const owner = await propose(apparatus, caller, 'owner', { goal: 'count letters' })
  const incumbent = methodOfRun(apparatus, taskStateOf(apparatus, owner.taskId).runs[owner.runId]!)!
  const assets = (await loadMethod(apparatus, incumbent)).assets
  const candidate = await createMethod(apparatus, { ...assets, skills: [{ name: 'count', description: 'count', capabilities: [], requiredTools: [], content: 'count ASCII letters' }] })
  const operationId = 'round:bootstrap:trial:0'
  const agentId = String(agentSessionIdOf(`trial-${sha256(`${apparatus.controlId}/${operationId}`).slice(0, 24)}`))
  const solver = { ...caller, agentId, sessionId: agentId }
  const first = await propose(apparatus, solver, operationId, { goal: taskStateOf(apparatus, owner.taskId).contract!.goal, method: incumbent },
    { purpose: 'evaluation', relatedTo: { taskId: owner.taskId, runId: owner.runId } })
  const criterion = taskStateOf(apparatus, first.taskId).contract!.criteria[0]!
  const metric = { measured: { ...criterion, criterionId: 'area' }, unit: 'ratio', direction: 'lower' as const }
  await createMeasureCommands({ store: apparatus.store, registry: apparatus.registry, implementations: [] }).openEvaluation({
    commandId: 'round:bootstrap:open-evaluation', evaluationId: 'round:bootstrap:evaluation', baseline: incumbent, candidate: incumbent,
    run: { taskId: first.taskId, runId: first.runId }, metric, weights: { quality: 1, cost: 0 }, trials: 1, judgement: [criterion],
  })
  await apparatus.tasks.forAgent(agentId).failRun({ commandId: 'first-failed', taskId: first.taskId, runId: first.runId, reason: 'verification interrupted' })
  const next = await retry(apparatus, solver, 'solve-retry', { taskId: first.taskId })
  await submit(apparatus, execution, solver, execFor(agentFor(agentId, agentId), 'counted'), { taskId: first.taskId, program: "process.stdout.write('35')" }, signal)
  transcripts.set(agentId, [{ type: 'assistant/message', data: { usage: { totalTokens: 100 } } }] as unknown as SessionEvent[])
  const measure = vi.fn(async (source: string) => { expect(source).toBe('35'); return 0.97 })
  const native = createNativeSolve(apparatus, {}, parent, signal, { digest: criterion.implementationDigest, measure })
  const reached = vi.fn(async () => { throw new Error('candidate reached') })
  const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry, criterion, metric,
    trials: 1, weights: { quality: 1, cost: 0 }, calibration: { floor: 0, source: 'declared' },
    loadMethod: async revision => (await loadMethod(apparatus, revision)).assets,
    solve: input => input.revision.digest === incumbent.digest ? native(input) : reached(),
  })
  const round = { roundId: 'round', round: 1, incumbent, candidates: [candidate] }
  await expect(evolution.runRound(round)).rejects.toThrow('candidate reached')
  const evaluated = apparatus.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'round:bootstrap:evaluation')!
  expect(evaluated.run).toEqual({ taskId: first.taskId, runId: first.runId })
  expect(JSON.parse(evaluated.observed[0]!.detail!)).toMatchObject({ taskId: first.taskId, runId: next.runId, met: true })
  const cutoff = medium.events.length
  await expect(evolution.runRound(round)).rejects.toThrow('candidate reached')
  expect(medium.events).toHaveLength(cutoff)
  expect(measure).toHaveBeenCalledTimes(1)
  expect(openChildSession).not.toHaveBeenCalled()
})

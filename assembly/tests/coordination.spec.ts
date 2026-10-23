import { fileURLToPath } from 'node:url'
import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { openApparatus, callerOf, declareCaller, taskStateOf } from '../src/apparatus.ts'
import { askParent, answerChild, assertActive, coordinationOf, waitingReason, readScopeOf, workflowDirection } from '../src/coordination.ts'
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import { openDriver } from '../src/driver.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { readArtifact, readTask, readTrajectory } from '../src/read.ts'
import { spawnProcess } from '../src/process.ts'
import { createScheduler } from '../src/scheduler.ts'
import { decompose, propose } from '../src/surfaces.ts'
import { acceptanceSubject } from '../src/review.ts'
import { projectTree } from '../../src/task/tree.ts'
import { submit } from '../src/submission.ts'
import { attachmentsAt, execFor, fakeExecution, FakePersistence, factsOf, nativeRuntime } from './seam.ts'
import { fixtureReview } from './review-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'task-coordination-')); roots.push(root)
  const persistence = new FakePersistence(), runtime = nativeRuntime()
  const domain = await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess)
  const apparatus = await openApparatus('coordination', root, domain, persistence as never, attachmentsAt(root), testProjections)
  const parent = runtime.agent('parent'), caller = callerOf(parent)
  const proposal = await propose(apparatus, caller, 'root', { goal: 'count letters' })
  const scheduler = createScheduler(apparatus, runtime.seams, runtime.open)
  await decompose(apparatus, scheduler, caller, { taskId: proposal.taskId, children: [
    { key: 'investigation', contract: { goal: 'resolve one uncertainty', artifact: 'finding.txt', inputs: [],
      criteria: [{ criterionId: 'finding', statement: 'support or refute the hypothesis with evidence' }] },
      supports: ['letters'], dependsOn: [], maxRuns: 1, requirement: 'required' as const,
      handoff: { decisions: ['Counting semantics are fixed'], hypotheses: ['Punctuation may affect the count'],
        exclusions: ['Do not rebuild measurement'], evidence: [] } },
    { key: 'peer', contract: contractFor(domain, domain.templates.get('extract-letters')!, 'extract ASCII letters'),
      supports: ['letters'], dependsOn: [], maxRuns: 1, requirement: 'required' as const },
  ] })
  const children = taskStateOf(apparatus, proposal.taskId).decomposition!.children
  const child = taskStateOf(apparatus, children[0]!.taskId), peer = taskStateOf(apparatus, children[1]!.taskId)
  const agent = runtime.agents.get(child.responsibility!.agentId)!, childCaller = callerOf(agent)
  const run = Object.values(child.runs).at(-1)!
  return { root, apparatus, domain, persistence, runtime, scheduler, parent, caller, proposal, child, peer, agent, childCaller, run }
}

it('dispatches one contract with scoped handoff and leaves parent responsibilities available on demand', async () => {
  const h = await setup()
  const text = h.runtime.delivered.find((d) => d.sessionId === h.childCaller.sessionId)!.message.content[0]!
  const dispatch = text.type === 'text' && JSON.parse(text.text)
  expect(dispatch).toMatchObject({ assigned: { contract: h.child.contract },
    parent: { id: h.proposal.taskId, runId: h.proposal.runId, supports: ['letters'], dependsOn: [] }, handoff: {
    decisions: ['Counting semantics are fixed'], hypotheses: ['Punctuation may affect the count'],
    exclusions: ['Do not rebuild measurement'], evidence: [],
  } })
  expect(dispatch.assigned).not.toHaveProperty('artifact')
  expect(dispatch.assigned).not.toHaveProperty('methodContext')
  expect(dispatch.assigned).not.toHaveProperty('templates')
  expect(Object.keys(dispatch.parent).sort()).toEqual(['dependsOn', 'id', 'requirement', 'runId', 'supports'])
  expect(Object.keys(dispatch.handoff).sort()).toEqual(['decisions', 'evidence', 'exclusions', 'hypotheses'])
  const task = await readTask(h.apparatus, h.child)
  expect(task.parent).toEqual(dispatch.parent)
  const parent = await readTask(h.apparatus, taskStateOf(h.apparatus, task.parent!.id))
  expect(parent.contract.goal).toBe(h.proposal.contract.goal)
  expect(parent.decomposition!.children.map((child) => child.taskId)).toEqual([h.child.taskId, h.peer.taskId])
  const { visible } = await readScopeOf(h.apparatus, h.childCaller.agentId)
  expect(visible).toEqual(new Set([h.child.taskId, h.peer.taskId, h.proposal.taskId]))
  const unrelated = await propose(h.apparatus, callerOf(h.runtime.agent('unrelated')), 'other', { goal: 'other root' })
  expect((await readScopeOf(h.apparatus, h.childCaller.agentId)).visible!.has(unrelated.taskId)).toBe(false)
  const medium = h.runtime.seams.get!('sessionPersistence') as typeof h.apparatus.persistence
  const reading = { ...h.apparatus, persistence: medium }
  expect(await readTrajectory(reading, h.childCaller.agentId, h.parent.id, 0, 1)).toHaveLength(0)
  await expect(readTrajectory(reading, h.childCaller.agentId, 'unrelated')).rejects.toThrow('outside this task')
  await expect(readTrajectory(reading, h.childCaller.agentId, h.parent.id, 0, 101)).rejects.toThrow('100')
  await h.scheduler.close(); await h.apparatus.store.close()
})

it('keeps dispatch direction independent of ancestor and sibling contract body length', async () => {
  const h = await setup()
  try {
    const states = new Map([...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)]
      .map(([id, state]) => [id, { ...state, contract: { ...state.contract!, goal: `${id}:` + 'long private contract detail '.repeat(2000) } }]))
    const direction = workflowDirection(states, h.child.taskId, 10)
    expect(direction.root.goal).toHaveLength(512)
    expect(direction.root.goalComplete).toBe(false)
    expect(direction.supportPath.every(node => !('goal' in node))).toBe(true)
    expect(direction.interfaces.every(node => !('goal' in node))).toBe(true)
    expect(JSON.stringify(direction).length).toBeLessThan(2500)
  } finally { await h.scheduler.close(); await h.apparatus.store.close() }
})

it('pins questions to the direct parent, blocks execution, and rejects self/peer/foreign answers', async () => {
  const h = await setup()
  const ask = { requestKey: 'scope', question: 'Does punctuation change the count?' }
  const q = await askParent(h.apparatus, h.childCaller, h.child.taskId, ask)
  expect(q).toMatchObject({ runId: h.run.runId, parentRunId: h.proposal.runId, blocking: true })
  expect(() => assertActive(h.apparatus, h.child.taskId)).toThrow('waiting for parent answers')
  const parentCoordination = coordinationOf(h.apparatus, h.proposal.taskId)
  expect(parentCoordination.questionsToAnswer).toHaveLength(1)
  expect(parentCoordination.responsibility).toMatchObject({
    authority: { kind: 'task', taskId: h.proposal.taskId, runId: h.proposal.runId },
    criteriaToAccept: ['letters', 'request'], requiredUnverified: [h.child.taskId, h.peer.taskId],
    executionMode: 'coordinate', canExecute: false, canSubmit: false,
  })
  expect(parentCoordination.responsibility.delegated).toMatchObject([
    { taskId: h.child.taskId, requirement: 'required', supports: ['letters'] },
    { taskId: h.peer.taskId, requirement: 'required', supports: ['letters'] },
  ])
  expect(parentCoordination.responsibility.delegated.every(child => !('goal' in child))).toBe(true)
  expect(coordinationOf(h.apparatus, h.child.taskId).responsibility).toMatchObject({
    authority: { kind: 'task', taskId: h.child.taskId, runId: h.run.runId },
    delegated: [], canExecute: false, canSubmit: false,
  })
  const answer = { questionId: q.questionId, requestKey: 'scope-answer', answer: 'Use the frozen ASCII definition.', resolves: true }
  for (const caller of [h.childCaller, callerOf(h.runtime.agents.get(h.peer.responsibility!.agentId)!),
    callerOf(h.runtime.agent('foreign'))])
    await expect(answerChild(h.apparatus, caller, answer)).rejects.toThrow('direct parent')
  const before = factsOf(h.persistence).length
  expect(await askParent(h.apparatus, h.childCaller, h.child.taskId, ask)).toEqual(q)
  expect(factsOf(h.persistence)).toHaveLength(before)
  await expect(askParent(h.apparatus, h.childCaller, h.child.taskId, { ...ask, question: 'Changed?' })).rejects.toThrow('command-conflict')
  await answerChild(h.apparatus, h.caller, { ...answer, resolves: false })
  expect(waitingReason(h.apparatus, h.child.taskId)).toContain(q.questionId)
  await expect(answerChild(h.apparatus, h.caller, answer)).rejects.toThrow('command-conflict')
  await answerChild(h.apparatus, h.caller, { ...answer, requestKey: 'resolved' })
  expect(waitingReason(h.apparatus, h.child.taskId)).toBeUndefined()
  expect(coordinationOf(h.apparatus, h.child.taskId).responsibility).toMatchObject({
    canExecute: true, canSubmit: true, remaining: { integrateOrReuseArtifact: true },
  })
  expect(waitingReason(h.apparatus, h.proposal.taskId)).toContain('delegated')
  await expect(askParent(h.apparatus, h.caller, h.proposal.taskId, ask)).rejects.toThrow('no parent')
  await h.scheduler.close(); await h.apparatus.store.close()
})

it('keeps monitoring at its committed cut when a question is answered during projection', async () => {
  const h = await setup()
  const question = await askParent(h.apparatus, h.childCaller, h.child.taskId,
    { requestKey: 'scope', question: 'Which definition should I use?' })
  const cut = h.apparatus.store.load()
  const before = coordinationOf(h.apparatus, h.child.taskId, cut)
  const projecting = snapshotOf(h.apparatus)
  await answerChild(h.apparatus, h.caller, { questionId: question.questionId, requestKey: 'answer',
    answer: 'Use the frozen ASCII definition.', resolves: true })
  expect(coordinationOf(h.apparatus, h.child.taskId, cut)).toEqual(before)
  expect(before.waiting).toContain(question.questionId)
  expect(before.responsibility.canExecute).toBe(false)
  expect(coordinationOf(h.apparatus, h.child.taskId)).toMatchObject({
    waiting: null, responsibility: { canExecute: true },
  })
  expect(coordinationOf(h.apparatus, h.proposal.taskId, cut).questionsToAnswer).toHaveLength(1)
  expect(coordinationOf(h.apparatus, h.proposal.taskId).questionsToAnswer).toHaveLength(0)
  const snapshot = await projecting
  expect(snapshot.cutoff).toBe(cut.entries().length)
  expect(snapshot.tasks.find(task => task.taskId === h.child.taskId)!.coordination).toEqual(before)
  await h.scheduler.close(); await h.apparatus.store.close()
})

it('recovers the same question and answer after process loss without repeated facts or inbox insertions', async () => {
  const h = await setup(), ask = { requestKey: 'scope', question: 'Which existing finding should I reuse?' }
  const q = await askParent(h.apparatus, h.childCaller, h.child.taskId, ask)
  // Lose the tool response after the fact; next scheduler reconstructs delivery.
  await h.scheduler.close(); await h.apparatus.store.close()
  const recovered = await openApparatus('coordination', h.root, h.domain, h.persistence as never, attachmentsAt(h.root), testProjections)
  declareCaller(recovered, h.caller.agentId)
  const scheduler = createScheduler(recovered, h.runtime.seams, h.runtime.open)
  await Promise.all([scheduler.advance(h.proposal.taskId), scheduler.advance(h.child.taskId)])
  expect(h.runtime.delivered.filter((d) => d.message.source.kind === 'singularity' && d.message.source.purpose === 'question')).toHaveLength(1)
  const answer = { questionId: q.questionId, requestKey: 'resolved', answer: 'Reuse the cited verified report; retain its digest.', resolves: true }
  await answerChild(recovered, h.caller, answer)
  await scheduler.close(); await recovered.store.close()
  const again = await openApparatus('coordination', h.root, h.domain, h.persistence as never, attachmentsAt(h.root), testProjections)
  declareCaller(again, h.caller.agentId)
  const resumed = createScheduler(again, h.runtime.seams, h.runtime.open)
  await Promise.all([resumed.advance(h.proposal.taskId), resumed.advance(h.child.taskId)])
  await answerChild(again, h.caller, answer)
  await resumed.advance(h.proposal.taskId)
  expect(h.runtime.delivered.filter((d) => d.message.source.kind === 'singularity' && d.message.source.purpose === 'answer')).toHaveLength(1)
  expect(factsOf(h.persistence).filter((f) => f.kind === 'task/question-asked')).toHaveLength(1)
  expect(factsOf(h.persistence).filter((f) => f.kind === 'task/question-answered')).toHaveLength(1)
  expect(waitingReason(again, h.child.taskId)).toBeUndefined()
  await resumed.close(); await again.store.close()
})

it('reuses a verified report as frozen input across responsibility branches and hands evidence back', async () => {
  const h = await setup()
  await writeFile(join(h.run.bubble!.workspace.ref, 'finding.txt'), 'Hypothesis refuted: punctuation is not ASCII letter data.')
  await submit(h.apparatus, fakeExecution(() => undefined), h.childCaller, execFor(h.agent, 'submit'),
    { taskId: h.child.taskId, path: 'finding.txt' }, new AbortController().signal, fixtureReview(h.apparatus))
  const peerCaller = callerOf(h.runtime.agents.get(h.peer.responsibility!.agentId)!)
  const before = factsOf(h.persistence).filter((f) => f.kind === 'revision/created').length
  await decompose(h.apparatus, h.scheduler, peerCaller, { taskId: h.peer.taskId, children: [{ key: 'use-report',
    contract: { goal: 'integrate prior findings', artifact: 'report.txt',
      inputs: [{ name: 'prior.txt', source: { kind: 'artifact', taskId: h.child.taskId } }],
      criteria: [{ criterionId: 'integrated', statement: 'the conclusion cites and uses the prior report' }] },
    handoff: { decisions: ['Reuse the verified negative result'], hypotheses: [], exclusions: [], evidence: [h.child.taskId] },
    dependsOn: [], supports: ['extracted'], maxRuns: 1, requirement: 'required' as const }] })
  const descendant = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .find((t) => t.contract?.goal === 'integrate prior findings')!
  const run = Object.values(descendant.runs).at(-1)!
  expect(descendant.contract!.inputs[0]!.source).toEqual({ kind: 'artifact', taskId: h.child.taskId })
  const accepted = taskStateOf(h.apparatus, h.child.taskId).runs[h.run.runId]!.submission!
  expect(run.bubble!.inputs[0]!.digest).toBe(accepted.artifactDigest)
  expect(await readFile(join(run.bubble!.workspace.ref, 'prior.txt'), 'utf8')).toContain('Hypothesis refuted')
  expect((await readTask(h.apparatus, taskStateOf(h.apparatus, h.child.taskId))).runs[0]!.artifact).toEqual(accepted.files.artifact)
  expect((await readArtifact(h.apparatus, h.child.taskId)).text).toContain('refuted')
  expect((await readScopeOf(h.apparatus, descendant.responsibility!.agentId)).visible!.has(h.child.taskId)).toBe(true)
  expect(factsOf(h.persistence).filter((f) => f.kind === 'revision/created')).toHaveLength(before)
  await h.scheduler.close(); await h.apparatus.store.close()
})

it('enforces the delegation hold on native tools, workspace, method calls and submission at the driver', async () => {
  const h = await setup()
  await h.scheduler.close(); await h.apparatus.store.close()
  let admission!: Parameters<typeof fakeExecution>[0]
  const nativePersistence = h.runtime.seams.get!('sessionPersistence') as typeof h.apparatus.persistence
  const driver = await openDriver({ projections: testProjections, controlId: 'coordination', workspaceRoot: h.root, domain: h.domain,
    persistence: { open: (id, access) => String(id).startsWith('singularity:control:')
      ? h.persistence.open(id, access) : nativePersistence.open(id, access),
    } as typeof h.apparatus.persistence, attachments: attachmentsAt(h.root), seams: h.runtime.seams,
    execution: (guard) => { admission = guard; return fakeExecution(guard) } })
  const call = driver.forCall(execFor(h.parent, 'waiting'))
  expect(admission({ agent: h.parent, name: 'bash' } as never)).toContain('delegated')
  expect(driver.world(h.caller.agentId).writable).toBe(false)
  expect(await call.history()).toMatchObject({ coordination: { waiting: expect.stringContaining('delegated') } })
  await expect(call.runMethod({ taskId: h.proposal.taskId, tool: 'anything' })).rejects.toThrow('delegated')
  await expect(call.submit({ taskId: h.proposal.taskId, path: 'anything' })).rejects.toThrow('delegated')
  await driver.close()
})


it('converges through persistent questions, reviewed child evidence and integration in the same parent Run', async () => {
  const h = await setup()
  const q = await askParent(h.apparatus, h.childCaller, h.child.taskId,
    { requestKey: 'scope', question: 'Should punctuation be excluded?' })
  await answerChild(h.apparatus, h.caller,
    { questionId: q.questionId, requestKey: 'scope', answer: 'Yes, use the frozen ASCII standard.', resolves: true })
  await h.scheduler.advance(h.proposal.taskId)
  await writeFile(join(h.run.bubble!.workspace.ref, 'finding.txt'), 'Punctuation is excluded; a! contains one ASCII letter.')
  await submit(h.apparatus, fakeExecution(() => undefined), h.childCaller, execFor(h.agent, 'finding'),
    { taskId: h.child.taskId, path: 'finding.txt' }, new AbortController().signal, fixtureReview(h.apparatus))
  await h.scheduler.advance(h.proposal.taskId)
  expect(waitingReason(h.apparatus, h.proposal.taskId)).toContain('delegated')
  const peerAgent = h.runtime.agents.get(h.peer.responsibility!.agentId)!, peerCaller = callerOf(peerAgent)
  const asked = await askParent(h.apparatus, peerCaller, h.peer.taskId,
    { requestKey: 'reuse', question: 'Which boundary finding should I use?' })
  await answerChild(h.apparatus, h.caller, { questionId: asked.questionId, requestKey: 'reuse',
    answer: 'Reuse the reviewed punctuation finding.', resolves: true, evidence: [h.child.taskId] })
  await h.scheduler.advance(h.proposal.taskId)
  const finding = await readArtifact(h.apparatus, h.child.taskId)
  expect(finding.status).toBe('verified')
  expect(finding.text).toContain('excluded')
  const peerRun = Object.values(h.peer.runs).at(-1)!
  const extracted = Buffer.from(h.domain.inputs[0]!.bytes).toString().match(/[A-Za-z]/g)!.join('')
  await writeFile(join(peerRun.bubble!.workspace.ref, 'letters.txt'), extracted)
  await submit(h.apparatus, fakeExecution(() => undefined), peerCaller, execFor(peerAgent, 'extracted'),
    { taskId: h.peer.taskId, path: 'letters.txt' }, new AbortController().signal, fixtureReview(h.apparatus))
  await h.scheduler.advance(h.proposal.taskId)
  await h.scheduler.advance(h.proposal.taskId)
  const outcomes = h.runtime.delivered.filter((d) => d.message.source.kind === 'singularity' && d.message.source.purpose === 'plan-outcome')
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]!.message.source).toMatchObject({ parentTaskId: h.proposal.taskId, runId: h.proposal.runId })
  expect(waitingReason(h.apparatus, h.proposal.taskId)).toBeUndefined()
  const accepted = await readArtifact(h.apparatus, h.peer.taskId)
  await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), String(accepted.text.length))
  const result = await submit(h.apparatus, fakeExecution(() => undefined), h.caller, execFor(h.parent, 'integrated'),
    { taskId: h.proposal.taskId, path: h.proposal.contract.artifact }, new AbortController().signal, fixtureReview(h.apparatus))
  expect(result.verdict).toBe('pass')
  const parent = taskStateOf(h.apparatus, h.proposal.taskId)
  expect(Object.keys(parent.runs)).toEqual([h.proposal.runId])
  expect(projectTree(h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION))
    .find((tree) => tree.parentTaskId === h.proposal.taskId)!.complete).toBe(true)
  const subject = await acceptanceSubject(h.apparatus, h.proposal.taskId, parent.runs[h.proposal.runId]!, [])
  expect(subject.contributions.map((child) => child.artifactDigest)).toEqual([
    finding.digest, accepted.digest])
  await h.scheduler.close(); await h.apparatus.store.close()
})

it('permits new planning but rejects execution and retries while responsibilities are pending', async () => {
  const h = await setup(), commands = h.apparatus.tasks.forAgent(h.caller.agentId)
  await commands.admit({ commandId: 'admit:overlapping', taskId: 'overlapping', contract: {
    goal: 'Resolve a separate open interface', artifact: 'interface.txt', inputs: [],
    criteria: [{ criterionId: 'interface', statement: 'Explain the independent interface' }],
  } })
  await expect(commands.decompose({ commandId: 'overlap', parentTaskId: h.proposal.taskId, children: [
    { taskId: 'overlapping', dependsOn: [], supports: ['letters'], maxRuns: 1, requirement: 'required' as const }] }))
    .resolves.toMatchObject({ kind: 'task/decomposed' })
  await h.apparatus.tasks.forAgent(h.caller.agentId).failRun({ commandId: 'parent-failed',
    taskId: h.proposal.taskId, runId: h.proposal.runId, reason: 'parent interrupted' })
  await expect(commands.startRun({ commandId: 'take-back', taskId: h.proposal.taskId, runId: 'take-back',
    revision: h.proposal.method, purpose: 'solve' })).rejects.toThrow('delegated responsibilities')
  await h.scheduler.advance(h.proposal.taskId)
  for (const id of [h.child.taskId, h.peer.taskId]) {
    expect(Object.values(taskStateOf(h.apparatus, id).runs).at(-1)).toMatchObject({ status: 'failed', failureCause: 'runtime' })
  }
  expect(waitingReason(h.apparatus, h.proposal.taskId)).toContain('required delegated responsibilities have not verified')
  await expect(h.apparatus.tasks.forAgent(h.childCaller.agentId).startRun({ commandId: 'orphan', taskId: h.child.taskId,
    runId: 'orphan', revision: h.run.revision, purpose: 'solve' })).rejects.toThrow('parent Run has settled')
  await h.scheduler.close(); await h.apparatus.store.close()
})


it('rejects a second parent and ancestor delegation through the protocol command port', async () => {
  const h = await setup(), commands = h.apparatus.tasks.forAgent(h.childCaller.agentId)
  for (const [taskId, expected] of [[h.peer.taskId, 'already has a direct parent'],
    [h.proposal.taskId, 'ancestor responsibility']] as const) {
    await expect(commands.decompose({ commandId: `invalid-edge:${taskId}`, parentTaskId: h.child.taskId,
      children: [{ taskId, dependsOn: [], supports: ['finding'], maxRuns: 1, requirement: 'required' as const }] })).rejects.toThrow(expected)
  }
  expect(taskStateOf(h.apparatus, h.child.taskId).decomposition).toBeUndefined()
  await h.scheduler.close(); await h.apparatus.store.close()
})

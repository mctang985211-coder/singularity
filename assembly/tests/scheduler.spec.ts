import { testProjections } from './seam.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { projectTree, taskWaitingReason } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, TASK_KINDS, type TaskState } from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { bindCaller, declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { repair } from '../src/repair.ts'
import { startAttempt, workspaceOf } from '../src/attempt.ts'
import { runIdOf } from '../src/ids.ts'
import { createMethod, seedMethod } from '../src/method.ts'
import { templateDeclaration } from '../src/template.ts'
import { readMethodContext } from '../src/method-run.ts'
import { coordinationOf, waitingReason, askParent, answerChild, deliverQuestions } from '../src/coordination.ts'
import { createScheduler, type Scheduler } from '../src/scheduler.ts'
import { schedulerMessage } from '../src/scheduler-message.ts'
import { contractFor } from '../src/inputs.ts'
import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'
import { taskSessionsOf } from '../src/evaluation-cost.ts'
import { spawnProcess } from '../src/process.ts'
import { fixtureReview } from './review-fixture.ts'
import { submit, judgeAndRecord } from '../src/submission.ts'
import { attachmentsAt, execFor, factsOf, fakeExecution, FakePersistence, nativeRuntime } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
const schedulers: Scheduler[] = []
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const contentOf = (message: UserMessage) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')


async function setup(maxRuns = 1, dependent: boolean | 'siblings' = false, skillContent?: string, requirements: readonly ('required' | 'exploration')[] = ['required', 'required']) {
  const root = await mkdtemp(join(tmpdir(), 'assembly-scheduler-'))
  roots.push(root)
  const domain = await loadDomain(domainDir, spawnProcess)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('scheduler', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root), testProjections,
  )
  const runtime = nativeRuntime()
  const method = skillContent === undefined ? await seedMethod(apparatus) : await createMethod(apparatus, {
    rootTemplate: domain.rootTemplate, templates: [...domain.templates.values()].map(templateDeclaration),
    skills: [{ name: 'investigate', description: 'Investigate scoped evidence', capabilities: [], requiredTools: [], content: skillContent }], tools: [],
  })
  const addPlan = async (parentTaskId: string, holder: string, parentSession: string, childTaskId: string, model: string,
    admitChildren = true, childContract?: TaskContract,
  ) => {
    const parent = runtime.agent(parentSession, model)
    await bindCaller(apparatus, { agentId: holder, sessionId: parentSession, model: { provider: 'test', model } })
    const template = domain.templates.get(domain.rootTemplate)!
    const contract = { ...contractFor(domain, template, 'count letters'), ...(skillContent === undefined ? {} : { skills: ['investigate'] }) }
    await apparatus.tasks.admit({ commandId: 'admit:' + parentTaskId, taskId: parentTaskId, contract })
    await apparatus.tasks.assign({ commandId: 'assign:' + parentTaskId, taskId: parentTaskId, agentId: holder })
    await startAttempt(apparatus, { agentId: holder, sessionId: parentSession, model: { provider: 'test', model } }, parentTaskId, 'parent-start:' + parentTaskId,
      method,
    )
    const children: { taskId: string; dependsOn: string[]; supports: string[]; maxRuns: number; requirement: 'required' | 'exploration' }[] = [
      { taskId: childTaskId, dependsOn: [], supports: ['letters'], maxRuns, requirement: requirements[0]! },
    ]
    if (dependent) children.push({ taskId: childTaskId + (dependent === 'siblings' ? '-sibling' : '-dependent'),
      dependsOn: dependent === 'siblings' ? [] : [childTaskId], supports: ['letters'], maxRuns, requirement: requirements[1]!,
      })
    for (const child of admitChildren ? children : []) {
      const childId = String(agentSessionIdOf(child.taskId))
      declareCaller(apparatus, childId)
      await apparatus.agents.open({ commandId: 'open:' + childId, agentId: childId, sessionId: childId, role: 'child' })
      await apparatus.tasks.admit({ commandId: 'admit:' + child.taskId, taskId: child.taskId, contract: childContract ?? contract,
      })
      await apparatus.tasks.assign({ commandId: 'assign:' + child.taskId, taskId: child.taskId, agentId: childId })
    }
    await apparatus.tasks.forAgent(holder).decompose({ commandId: 'plan:' + parentTaskId, parentTaskId, children })
    return parent
  }
  const parent = await addPlan('parent-task', 'holder', 'parent-session', 'child-task', 'model-A')
  const make = (open = runtime.open) => {
    const scheduler = createScheduler(apparatus, runtime.seams, open)
    schedulers.push(scheduler)
    return scheduler
  }
  const answer = async (taskId: string, pass: boolean) => {
    const id = String(agentSessionIdOf(taskId))
    const child = runtime.agents.get(id)!
    const run = Object.values(taskStateOf(apparatus, taskId).runs).at(-1)!
    await writeFile(
      join(run.bubble!.workspace.ref, taskStateOf(apparatus, taskId).contract!.artifact),
      pass ? '35' : '0',
    )
    return await submit(apparatus, fakeExecution(() => undefined), { agentId: id, sessionId: id, model: { provider: 'test', model: 'model-A' } },
      execFor(child, 'submit:' + run.runId), { taskId, path: taskStateOf(apparatus, taskId).contract!.artifact },
      new AbortController().signal,
      fixtureReview(apparatus),
    )
  }
  return { apparatus, parent, medium, root, runtime, make, answer, addPlan }
}

describe('fact-driven child scheduling', () => {
  it('resolves the exact parent session and model from its responsibility before dispatch', async () => {
    const h = await setup()
    const scheduler = h.make()
    expect(await scheduler.advance('parent-task')).toEqual(['child-task'])
    expect(h.runtime.opened[0]).toMatchObject({ parent: h.parent, model: { provider: 'test', model: 'model-A' } })
    const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
    const message = h.runtime.delivered[0]!.message
    expect(contentOf(message)).toContain(run.bubble!.workspace.ref)
    expect(contentOf(message)).toContain('in/source.txt')
    expect(contentOf(message)).not.toContain('singularity_create_method')
    expect(contentOf(message)).not.toContain('Supported TaskTemplates:')
    const dispatch = JSON.parse(contentOf(message))
    expect(Object.keys(dispatch.assigned).sort()).toEqual(['contract', 'method', 'phase', 'runId', 'taskId', 'workspace'])
    expect(Object.keys(dispatch.parent).sort()).toEqual(['dependsOn', 'id', 'requirement', 'runId', 'supports'])
    expect(dispatch).not.toHaveProperty('handoff')
    expect(dispatch.assigned.method).toEqual(run.revision)
    expect(message.source).toMatchObject({ kind: 'singularity', purpose: 'dispatch' })
    expect(h.runtime.opened[0]!.message!.source).toMatchObject({ kind: 'singularity', controlId: 'scheduler', purpose: 'dispatch', parentTaskId: 'parent-task', taskId: 'child-task', runId: run.runId,
      factSeq: factsOf(h.medium).find((fact) => fact.kind === TASK_KINDS.runStarted && fact.subject === 'child-task')!.seq,
    })
  })

  it('advertises bound Skill metadata on demand without placing Skill text in dispatch', async () => {
    const skillContent = 'Private procedural detail for the scoped investigation.'.repeat(100)
    const h = await setup(1, false, skillContent)
    await h.make().advance('parent-task')
    const text = contentOf(h.runtime.delivered[0]!.message)
    expect(text).not.toContain(skillContent)
    expect(text).not.toContain('Private procedural detail')
    const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
    const consumption = run.consumed
    expect(consumption.some(({ method }) => method.startsWith('skill:') || method.startsWith('guidance:'))).toBe(false)
    const directory = await readMethodContext(h.apparatus, 'child-task', run)
    expect(directory.skills).toMatchObject([{ name: 'investigate', description: 'Investigate scoped evidence',
      read: { tool: 'skill', arguments: { name: 'investigate' } } }])
    expect(directory.skills[0]).not.toHaveProperty('content')
    expect(JSON.stringify(directory)).not.toContain('Private procedural detail')
    expect(taskStateOf(h.apparatus, 'child-task').runs[run.runId]!.consumed).toEqual(consumption)
  })

  it('advances B without touching A even when A has no live parent', async () => {
    const h = await setup()
    const b = await h.addPlan('parent-B', 'holder-B', 'session-B', 'child-B', 'model-B')
    h.runtime.agents.delete('parent-session')
    expect(await h.make().advance('parent-B')).toEqual(['child-B'])
    expect(h.runtime.opened).toHaveLength(1)
    expect(h.runtime.opened[0]).toMatchObject({ parent: b, model: { provider: 'test', model: 'model-B' } })
    expect(Object.keys(taskStateOf(h.apparatus, 'child-task').runs)).toHaveLength(0)
  })

  it('returns after posting while the child remains non-idle', async () => {
    const h = await setup()
    expect(await h.make().advance('parent-task')).toEqual(['child-task'])
    expect(h.runtime.delivered).toHaveLength(1)
  })

  it('serializes overlapping advances without a second Run, creation, or instruction', async () => {
    const h = await setup()
    const scheduler = h.make()
    await Promise.all([scheduler.advance('parent-task'), scheduler.advance('parent-task')])
    expect(h.runtime.opened).toHaveLength(1)
    expect(h.runtime.delivered).toHaveLength(1)
    expect(Object.keys(taskStateOf(h.apparatus, 'child-task').runs)).toHaveLength(1)
  })

  it('retries acceptance failure on the live session with a new explicit Run directory and frozen prior submission', async () => {
    const h = await setup(2)
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    const first = await h.answer('child-task', false)
    const run1 = taskStateOf(h.apparatus, 'child-task').runs[first.runId]!
    const oldProgram = await readFile(join(run1.bubble!.workspace.ref, 'report.txt'))
    expect(await scheduler.advance('parent-task')).toEqual(['child-task'])
    const runs = Object.values(taskStateOf(h.apparatus, 'child-task').runs)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ status: 'failed', failureCause: 'acceptance' })
    expect(runs[1]).toMatchObject({ status: 'running', stage: 'working' })
    expect(h.runtime.opened).toHaveLength(1)
    expect(
      JSON.parse(contentOf(h.runtime.delivered[1]!.message)).previous.findings.map((f: { detail: string }) => f.detail)
        .join('\n'),
    ).toBe(first.detail)
    expect(contentOf(h.runtime.delivered[1]!.message)).toContain(runs[1]!.bubble!.workspace.ref)
    expect(runs[1]!.bubble!.workspace.ref).not.toBe(run1.bubble!.workspace.ref)
    expect(await readFile(join(run1.bubble!.workspace.ref, 'report.txt'))).toEqual(oldProgram)
  })

  it('records the live child route for acceptance retries after its parent changes model', async () => {
    const h = await setup(2)
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    const first = await h.answer('child-task', false)
    const route = taskStateOf(h.apparatus, 'child-task').runs[first.runId]!.bubble!.model
    h.runtime.routes.set('parent-session', { provider: 'test', model: 'model-B' })
    await scheduler.advance('parent-task')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs).at(-1)!.bubble!.model).toEqual(route)
    expect(h.runtime.opened).toHaveLength(1)
    expect(Object.values(taskStateOf(h.apparatus, 'parent-task').runs).at(-1)!.status).toBe('running')
  })

  it.each(['exhausted', 'runtime'] as const)('stops %s work and notifies the accurate parent once with terminal provenance', async (cause) => {
    const h = await setup(cause === 'runtime' ? 3 : 1, true)
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    if (cause === 'exhausted') await h.answer('child-task', false)
    else {
      const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
      await h.apparatus.tasks.forAgent(String(agentSessionIdOf('child-task'))).failRun({ commandId: 'runtime', taskId: 'child-task', runId: run.runId, reason: 'provider unavailable' })
    }
    expect(await scheduler.advance('parent-task')).toEqual([])
    expect(await scheduler.advance('parent-task')).toEqual([])
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
    const notice = h.runtime.delivered.find((entry) => entry.sessionId === 'parent-session')!.message
    const terminal = factsOf(h.medium).findLast(
        (fact) => fact.subject === 'child-task' && fact.kind === TASK_KINDS.runFailed,
      )!
    expect(notice.source).toMatchObject({ kind: 'singularity', purpose: 'plan-outcome', parentTaskId: 'parent-task', taskId: 'child-task', factSeq: terminal.seq,
      })
    expect(contentOf(notice)).toContain(cause === 'runtime' ? 'provider unavailable' : 'budget exhausted')
    expect(contentOf(notice)).toContain('child-task-dependent')
    expect(Object.values(taskStateOf(h.apparatus, 'parent-task').runs).at(-1)).toMatchObject({
      status: 'failed', failureCause: 'runtime', failureReason: expect.stringContaining('required delegated responsibilities ended without verification') })
    expect(h.runtime.delivered.filter((entry) => entry.sessionId !== 'parent-session')).toHaveLength(1)
  },
  )

  it('wakes the accurate parent after delegated work verifies without passing its own Run', async () => {
    const h = await setup()
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    await h.answer('child-task', true)
    await scheduler.advance('parent-task')
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
    const notice = h.runtime.delivered.find((entry) => entry.sessionId === 'parent-session')!.message
    expect(contentOf(notice)).toContain('independent')
    expect(Object.values(taskStateOf(h.apparatus, 'parent-task').runs)[0]).toMatchObject({ status: 'running', evidence: [],
    })
    await scheduler.advance('parent-task')
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('reports a branch outcome while siblings run and all outcomes after they settle', async () => {
    const h = await setup(1, 'siblings'), scheduler = h.make()
    await scheduler.advance('parent-task')
    const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
    await h.apparatus.tasks.forAgent(String(agentSessionIdOf('child-task'))).failRun({ commandId: 'runtime', taskId: 'child-task',
      runId: run.runId, reason: 'provider unavailable' })
    await scheduler.advance('parent-task')
    expect(h.runtime.delivered.filter((e) => e.sessionId === 'parent-session')).toMatchObject([{ message: { source: { purpose: 'branch-outcome', taskId: 'child-task' } } }])
    await h.answer('child-task-sibling', true)
    await scheduler.advance('parent-task')
    await scheduler.advance('parent-task')
    const notices = h.runtime.delivered.filter((e) => e.sessionId === 'parent-session' && e.message.source.kind === 'singularity' && e.message.source.purpose === 'plan-outcome')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message.source).toMatchObject({ taskId: 'child-task-sibling' })
    expect(contentOf(notices[0]!.message)).toContain('provider unavailable')
    expect(contentOf(notices[0]!.message)).toContain('artifactDigest')
    expect(contentOf(notices[0]!.message)).toContain('child-task')
  })


  it('selects accepted work, cancels unselected exploration durably and does not resume it after recovery', async () => {
    const h = await setup(2, 'siblings', undefined, ['required', 'exploration']), first = h.make()
    await first.advance('parent-task')
    await h.answer('child-task', true)
    await first.advance('parent-task')
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toMatchObject([
      { message: { source: { purpose: 'branch-outcome', taskId: 'child-task' } } },
    ])
    const tasks = () => h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    expect(taskWaitingReason(tasks(), 'parent-task')).toContain('pending')
    const stop = { commandId: 'select-winner', parentTaskId: 'parent-task', taskIds: ['child-task-sibling'], reason: 'accepted candidate is sufficient' }
    const fact = await h.apparatus.tasks.forAgent('holder').stopExplorations(stop)
    expect(await h.apparatus.tasks.forAgent('holder').stopExplorations(stop)).toEqual(fact)
    await first.advance('parent-task')
    const branch = taskStateOf(h.apparatus, 'child-task-sibling'), run = Object.values(branch.runs).at(-1)!
    expect(run).toMatchObject({ status: 'failed', failureCause: 'runtime', failureReason: expect.stringContaining('accepted candidate is sufficient') })
    expect(h.runtime.stopped).toContain(String(agentSessionIdOf('child-task-sibling')))
    expect(projectTree(tasks()).find(plan => plan.parentTaskId === 'parent-task')!.children)
      .toMatchObject([{ status: 'verified', requirement: 'required' }, { status: 'cancelled', requirement: 'exploration' }])
    expect(taskWaitingReason(tasks(), 'parent-task')).toBeUndefined()
    expect(taskWaitingReason(tasks(), branch.taskId)).toContain('stopped')
    await expect(startAttempt(h.apparatus, { agentId: branch.responsibility!.agentId, sessionId: String(agentSessionIdOf(branch.taskId)),
      model: { provider: 'test', model: 'model-A' } }, branch.taskId, 'forbidden-retry', run.revision)).rejects.toThrow('stopped')
    await first.close()
    const before = h.runtime.opened.length
    await h.make().advance('parent-task')
    expect(h.runtime.opened).toHaveLength(before)
    expect(Object.values(taskStateOf(h.apparatus, branch.taskId).runs)).toHaveLength(1)
    const parentRun = Object.values(taskStateOf(h.apparatus, 'parent-task').runs).at(-1)!
    await writeFile(join(parentRun.bubble!.workspace.ref, 'report.txt'), '35')
    const result = await submit(h.apparatus, fakeExecution(() => undefined),
      { agentId: 'holder', sessionId: 'parent-session', model: { provider: 'test', model: 'model-A' } },
      execFor(h.parent, 'parent-selected-submit'), { taskId: 'parent-task', path: 'report.txt' }, new AbortController().signal, fixtureReview(h.apparatus))
    expect(result.verdict).toBe('pass')
  })

  it('settles cancellation when child close schedules the same parent before flushing', async () => {
    const h = await setup(1, 'siblings', undefined, ['required', 'exploration'])
    let scheduler!: Scheduler
    let closed = false
    scheduler = h.make(async request => {
      const session = await h.runtime.open(request)
      if (request.agentId !== 'child-task-sibling') return session
      return { ...session, close: async () => {
        // Real submit.finally schedules its parent while dispose waits for its turn.
        await scheduler.advance('parent-task')
        await session.close()
        closed = true
      } }
    })
    await scheduler.advance('parent-task')
    await h.answer('child-task', true)
    await h.apparatus.tasks.forAgent('holder').stopExplorations({ commandId: 'stop-during-submit',
      parentTaskId: 'parent-task', taskIds: ['child-task-sibling'], reason: 'required work passed' })
    await scheduler.advance('parent-task')
    await vi.waitFor(() => expect(closed).toBe(true))
    expect(taskWaitingReason(h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), 'parent-task')).toBeUndefined()
    await scheduler.close()
  })

  it('restores a persisted stop before attempting acceptance recovery or opening the cancelled session', async () => {
    const h = await setup(1, 'siblings', undefined, ['required', 'exploration']), first = h.make()
    await first.advance('parent-task')
    const taskId = 'child-task-sibling', task = taskStateOf(h.apparatus, taskId), run = Object.values(task.runs).at(-1)!
    const artifact = await h.apparatus.attachments.saveFile({ name: 'report.txt', data: Buffer.from('35') })
    await h.apparatus.tasks.forAgent(task.responsibility!.agentId).submitRun({ commandId: 'sealed-before-stop', taskId, runId: run.runId,
      submission: { requestId: 'sealed-before-stop', requestDigest: sha256('sealed-before-stop'), artifactDigest: sha256('35'),
        inputDigests: run.bubble!.inputs, files: { artifact, inputs: run.bubble!.inputs.map(input => ({ name: input.name, attachment: input.attachment! })) },
        source: { sessionId: String(agentSessionIdOf(taskId)), eventCount: 0, digest: sha256('source') } } })
    const reviewId = 'pending-cancelled-review', reviewerId = 'pending-reviewer'
    declareCaller(h.apparatus, reviewerId)
    await h.apparatus.agents.open({ commandId: 'pending-reviewer-agent', agentId: reviewerId, sessionId: reviewerId, role: 'review' })
    h.runtime.agent(reviewerId)
    await createReviewCommands(h.apparatus.store).start('pending-review', reviewId, {
      target: { kind: 'acceptance', taskId, runId: run.runId, contractDigest: task.contractDigest!, artifactDigest: sha256('35') },
      subject: await h.apparatus.attachments.saveFile({ name: 'subject.json', data: Buffer.from('{}') }), subjectDigest: sha256('{}'),
      criteria: task.contract!.criteria, agentId: reviewerId, identity: h.apparatus.store.identityOf('agent:' + reviewerId)!, sessionId: reviewerId,
      workspace: join(h.root, 'pending-review'), model: run.bubble!.model, method: run.revision,
    })
    await h.apparatus.tasks.forAgent('holder').stopExplorations({ commandId: 'durable-stop', parentTaskId: 'parent-task', taskIds: [taskId],
      reason: 'use the other candidate' })
    await first.close()
    await h.apparatus.store.close()
    const recovered = await openApparatus('scheduler', h.root, h.apparatus.domain, h.medium as never, attachmentsAt(h.root), testProjections)
    let judgements = 0
    await repair(recovered, async () => { judgements++; return true }, task.responsibility!.agentId)
    expect(judgements).toBe(0)
    expect(taskStateOf(recovered, taskId).runs[run.runId]).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('use the other candidate') })
    declareCaller(recovered, 'holder')
    const scheduler = createScheduler(recovered, h.runtime.seams, h.runtime.open)
    schedulers.push(scheduler)
    const before = h.runtime.opened.length
    expect(waitingReason(recovered, reviewId)).toContain('stopped exploration')
    expect(coordinationOf(recovered, reviewId).responsibility).toMatchObject({ canExecute: false, canSubmit: false })
    await scheduler.advance(reviewId)
    expect(recovered.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!.status).toBe('failed')
    expect(h.runtime.stopped).toContain(reviewerId)
    await scheduler.advance('parent-task')
    expect(h.runtime.opened.slice(before).some(request => request.agentId === taskId || request.agentId === reviewerId)).toBe(false)
    await scheduler.close(); schedulers.splice(schedulers.indexOf(scheduler), 1)
    await recovered.store.close()
  })

  it('cancels delegated descendants and closes their pending question path', async () => {
    const h = await setup(1, 'siblings', undefined, ['required', 'exploration']), scheduler = h.make()
    await scheduler.advance('parent-task')
    const parentId = 'child-task-sibling', holder = String(agentSessionIdOf(parentId))
    const contract = taskStateOf(h.apparatus, parentId).contract!
    const grandchild = 'nested-exploration', grandchildId = String(agentSessionIdOf(grandchild))
    declareCaller(h.apparatus, grandchildId)
    await h.apparatus.agents.open({ commandId: 'nested-agent', agentId: grandchildId, sessionId: grandchildId, role: 'child' })
    const commands = h.apparatus.tasks.forAgent(holder)
    await commands.admit({ commandId: 'nested-admit', taskId: grandchild, contract })
    await commands.assign({ commandId: 'nested-assign', taskId: grandchild, agentId: grandchildId })
    await commands.decompose({ commandId: 'nested-plan', parentTaskId: parentId, children: [
      { taskId: grandchild, dependsOn: [], supports: ['letters'], maxRuns: 2, requirement: 'required' },
    ] })
    await scheduler.advance(parentId)
    const childCaller = { agentId: grandchildId, sessionId: grandchildId, model: { provider: 'test', model: 'model-A' } }
    const question = await askParent(h.apparatus, childCaller, grandchild, { requestKey: 'clarify', question: 'Continue measuring?' })
    await h.apparatus.tasks.forAgent('holder').stopExplorations({ commandId: 'stop-nested', parentTaskId: 'parent-task',
      taskIds: [parentId], reason: 'no additional exploration is needed' })
    await scheduler.advance('parent-task')
    expect(Object.values(taskStateOf(h.apparatus, grandchild).runs).at(-1)!.status).toBe('failed')
    expect(h.runtime.stopped).toContain(grandchildId)
    await expect(askParent(h.apparatus, childCaller, grandchild, { requestKey: 'again', question: 'Can I resume?' })).rejects.toThrow('stopped')
    await expect(answerChild(h.apparatus, { ...childCaller, agentId: holder, sessionId: holder },
      { questionId: question.questionId, requestKey: 'late', answer: 'Continue', resolves: true })).rejects.toThrow('stopped')
    const before = h.runtime.delivered.length
    await deliverQuestions(h.apparatus, h.runtime.seams)
    await scheduler.advance(parentId)
    expect(h.runtime.delivered).toHaveLength(before)
    expect(h.runtime.opened.map(request => request.agentId)).toEqual(['child-task', parentId, grandchild])
  })

  it('stops pending exploration without starting it and refuses to cancel a required dependency', async () => {
    const h = await setup(1, true, undefined, ['exploration', 'required'])
    await expect(h.apparatus.tasks.forAgent('holder').stopExplorations({ commandId: 'invalid-stop', parentTaskId: 'parent-task',
      taskIds: ['child-task'], reason: 'cannot skip required acceptance dependency' })).rejects.toThrow('still depends')
    await expect(h.apparatus.tasks.forAgent('holder').stopExplorations({ commandId: 'required-stop', parentTaskId: 'parent-task',
      taskIds: ['child-task-dependent'], reason: 'cannot cancel required work' })).rejects.toThrow('not a stoppable exploration')
    const independent = await setup(1, 'siblings', undefined, ['required', 'exploration'])
    await independent.apparatus.tasks.forAgent('holder').stopExplorations({ commandId: 'pending-stop', parentTaskId: 'parent-task',
      taskIds: ['child-task-sibling'], reason: 'one candidate route is sufficient' })
    expect(await independent.make().advance('parent-task')).toEqual(['child-task'])
    expect(Object.values(taskStateOf(independent.apparatus, 'child-task-sibling').runs)).toHaveLength(0)
    expect(taskSessionsOf(independent.apparatus, 'parent-task')).not.toContain(String(agentSessionIdOf('child-task-sibling')))
    expect(taskWaitingReason(independent.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), 'parent-task')).toContain('pending')
  })

  it('refuses a plan outcome without a causal terminal instead of inventing notification provenance', async () => {
    const h = await setup()
    await h.addPlan('missing-parent', 'missing-holder', 'missing-session', 'absent-child', 'model-C', false)
    expect(await asyncRefusalOf(() => h.make().advance('missing-parent'))).toMatchObject({ code: 'illegal-transition',
      detail: expect.stringContaining('no admitted contract'),
    })
    expect(h.runtime.delivered).toEqual([])
    expect(h.runtime.opened).toEqual([])
  })

  it.each(['create', 'post'] as const)('records %s failure as runtime, notifies the parent, and returns the dispatch error', async (phase) => {
    const h = await setup(3)
    if (phase === 'post') h.runtime.beforePost((id) => { if (id !== 'parent-session') throw new Error('post failed') })
    const scheduler = h.make(phase === 'create' ? async () => { throw new Error('create failed') } : h.runtime.open,
      )
    await expect(scheduler.advance('parent-task')).rejects.toThrow(phase + ' failed')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]).toMatchObject({ status: 'failed', failureCause: 'runtime',
      })
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
    expect(await scheduler.advance('parent-task')).toEqual([])
    expect(h.runtime.opened).toHaveLength(phase === 'create' ? 0 : 1)
  },
  )

  it('notifies the parent when preparation fails after starting the child Run', async () => {
    const h = await setup(3)
    const runId = runIdOf('scheduler', String(agentSessionIdOf('child-task')), 'child-task:attempt:0')
    const input = join(workspaceOf(h.apparatus, 'child-task', runId), 'in/source.txt')
    await mkdir(dirname(input), { recursive: true })
    await writeFile(input, 'already exists')
    await expect(h.make().advance('parent-task')).rejects.toMatchObject({ taskId: 'child-task', runId })
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ runId, status: 'failed', failureCause: 'runtime' },
    ])
    expect(h.runtime.opened).toEqual([])
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('stops and notifies once when a child input loses its authoritative sealed object', async () => {
    const h = await setup(3)
    const caller = { agentId: 'holder', sessionId: 'parent-session', model: { provider: 'test', model: 'model-A' } }
    const commands = h.apparatus.tasks.forAgent(caller.agentId)
    const template = h.apparatus.domain.templates.get('extract-letters')!
    await commands.admit({ commandId: 'producer-admit', taskId: 'producer', contract: contractFor(h.apparatus.domain, template, template.goal),
    })
    await commands.assign({ commandId: 'producer-assign', taskId: 'producer', agentId: caller.agentId })
    await startAttempt(h.apparatus, caller, 'producer', 'producer-run', await seedMethod(h.apparatus))
    const producerRun = Object.values(taskStateOf(h.apparatus, 'producer').runs).at(-1)!
    await writeFile(
      join(producerRun.bubble!.workspace.ref, 'letters.txt'),
      Buffer.from(h.apparatus.domain.inputs[0]!.bytes)
        .toString()
        .match(/[A-Za-z]/g)!
        .join(''),
    )
    const result = await submit(h.apparatus, fakeExecution(() => undefined), caller, execFor(h.parent, 'producer-submit'), { taskId: 'producer', path: 'letters.txt' },
      new AbortController().signal,
      fixtureReview(h.apparatus),
    )
    expect(result.verdict).toBe('pass')
    const producer = taskStateOf(h.apparatus, 'producer').runs[result.runId]!
    await rm(attachmentsAt(h.root).fileHostPath(producer.submission!.files.artifact))
    const consumer = h.apparatus.domain.templates.get('count-letters')!
    await h.addPlan('artifact-parent', 'artifact-holder', 'artifact-session', 'consumer-task', 'model-A', true,
      contractFor(h.apparatus.domain, consumer, consumer.goal, new Map([['extract-letters', 'producer']])),
    )
    const scheduler = h.make()
    await expect(scheduler.advance('artifact-parent')).rejects.toMatchObject({ taskId: 'consumer-task' })
    expect(await scheduler.advance('artifact-parent')).toEqual([])
    expect(Object.values(taskStateOf(h.apparatus, 'consumer-task').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' },
    ])
    expect(h.runtime.opened).toEqual([])
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'artifact-session')).toHaveLength(1)
  })

  it('rejects a missing recorded parent session before creating a child or starting its Run', async () => {
    const h = await setup()
    h.runtime.agents.delete('parent-session')
    expect(await asyncRefusalOf(() => h.make().advance('parent-task'))).toMatchObject({ code: 'unknown-emitter-role' })
    expect(h.runtime.opened).toHaveLength(0)
    expect(Object.keys(taskStateOf(h.apparatus, 'child-task').runs)).toHaveLength(0)
  })

  it('recovers the same working Run by waking its pending native instruction without another Run or insertion', async () => {
    const h = await setup()
    const first = h.make()
    await first.advance('parent-task')
    const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
    await first.close()
    expect(await h.make().advance('parent-task')).toEqual(['child-task'])
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toEqual([run])
    expect(h.runtime.delivered).toHaveLength(1)
    expect(h.runtime.woken).toEqual([String(agentSessionIdOf('child-task'))])
  })

  it('restores a sealed child for acceptance without waking the executor or creating another Run', async () => {
    const h = await setup(1, true), first = h.make()
    await first.advance('parent-task')
    const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
    const artifact = await h.apparatus.attachments.saveFile({ name: 'report.txt', data: Buffer.from('35') })
    await h.apparatus.tasks.forAgent(taskStateOf(h.apparatus, 'child-task').responsibility!.agentId).submitRun({
      commandId: 'seal-child', taskId: 'child-task', runId: run.runId, submission: {
        requestId: 'seal-child', requestDigest: sha256('seal-child'), artifactDigest: sha256('35'),
        inputDigests: run.bubble!.inputs,
        files: { artifact, inputs: run.bubble!.inputs.map((input) => ({ name: input.name, attachment: input.attachment! })) },
        source: { sessionId: String(agentSessionIdOf('child-task')), eventCount: 0, digest: sha256('source') },
      } })
    await first.close()
    const recovered = h.make(async (request) => {
      const session = await h.runtime.open(request)
      if (request.message === undefined) {
        const held = taskStateOf(h.apparatus, 'child-task').runs[run.runId]!
        await judgeAndRecord(h.apparatus, 'child-task', held, new AbortController().signal, fixtureReview(h.apparatus))
        await h.apparatus.tasks.settle({ commandId: 'recover-settle', taskId: 'child-task', runId: run.runId },
          'agent:' + taskStateOf(h.apparatus, 'child-task').responsibility!.agentId)
      }
      return session
    })
    expect(await recovered.advance('parent-task')).toEqual(['child-task', 'child-task-dependent'])
    expect(h.runtime.opened[1]).not.toHaveProperty('message')
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === String(agentSessionIdOf('child-task')))).toHaveLength(1)
    expect(h.runtime.woken).toEqual([])
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ runId: run.runId, status: 'verified' }])
  })

  it('resumes a pending working Run with its frozen route after its parent changes model', async () => {
    const h = await setup()
    const first = h.make()
    await first.advance('parent-task')
    await first.close()
    h.runtime.routes.set('parent-session', { provider: 'test', model: 'model-B' })
    expect(await h.make().advance('parent-task')).toEqual(['child-task'])
    expect(h.runtime.opened[1]).toMatchObject({ model: { provider: 'test', model: 'model-A' } })
    expect(h.runtime.delivered).toHaveLength(1)
  })

  it('checks the public child options when a pending Run has not produced its first request header', async () => {
    const h = await setup()
    const childId = String(agentSessionIdOf('child-task'))
    h.runtime.headersAbsent.add(childId)
    const first = h.make()
    await first.advance('parent-task')
    await first.close()
    h.runtime.routes.set('parent-session', { provider: 'test', model: 'model-B' })
    expect(await h.make().advance('parent-task')).toEqual(['child-task'])
    expect(h.runtime.opened[1]).toMatchObject({ model: { provider: 'test', model: 'model-A' } })
    expect(h.runtime.delivered).toHaveLength(1)
    expect(h.runtime.woken).toEqual([childId])
  })

  it('stops a recovered working Run when its actual child route differs from the frozen route', async () => {
    const h = await setup(3)
    const first = h.make()
    await first.advance('parent-task')
    await first.close()
    const childId = String(agentSessionIdOf('child-task'))
    h.runtime.routes.set(childId, { provider: 'test', model: 'model-B' })
    await expect(h.make().advance('parent-task')).rejects.toThrow('model route')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' },
    ])
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === childId)).toHaveLength(1)
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('fails an interrupted unprepared Run as runtime without opening a child or starting another Run', async () => {
    const h = await setup(3)
    const revision = Object.values(taskStateOf(h.apparatus, 'parent-task').runs)[0]!.revision
    await h.apparatus.tasks.forAgent(String(agentSessionIdOf('child-task'))).startRun({ purpose: 'solve', commandId: 'interrupted',
      taskId: 'child-task', runId: 'unprepared', revision })
    await expect(h.make().advance('parent-task')).rejects.toThrow('no prepared execution bubble')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ runId: 'unprepared', status: 'failed', failureCause: 'runtime' },
    ])
    expect(h.runtime.opened).toEqual([])
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it.each(['entered', 'claimed'] as const)('recovers entered work and refuses unconfirmed claimed delivery (%s)', async (state) => {
    const h = await setup(3)
    const first = h.make()
    await first.advance('parent-task')
    const id = String(agentSessionIdOf('child-task'))
    const instruction = h.runtime.delivered[0]!.message
    h.runtime.append(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    if (state === 'entered') h.runtime.append(id, 'user/message', instruction)
    await first.close()
    if (state === 'entered') {
      await expect(h.make().advance('parent-task')).resolves.toEqual(['child-task'])
      expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ status: 'running' }])
      return
    }
    await expect(h.make().advance('parent-task')).rejects.toThrow('unconfirmed')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' },
      ])
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === id)).toHaveLength(1)
    expect(h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')).toHaveLength(1)
  },
  )

  it('binds settled evidence to the new parent Run after a retry, without duplicating either notice', async () => {
    const h = await setup(), scheduler = h.make()
    await scheduler.advance('parent-task')
    await h.answer('child-task', true)
    await scheduler.advance('parent-task')
    const first = Object.values(taskStateOf(h.apparatus, 'parent-task').runs).at(-1)!
    await h.apparatus.tasks.forAgent('holder').failRun({ commandId: 'parent-failed', taskId: 'parent-task',
      runId: first.runId, reason: 'integration interrupted' })
    const next = await startAttempt(h.apparatus, { agentId: 'holder', sessionId: 'parent-session',
      model: { provider: 'test', model: 'model-A' } }, 'parent-task', 'parent-retry', first.revision)
    await scheduler.advance('parent-task')
    await scheduler.advance('parent-task')
    const notices = h.runtime.delivered.filter((entry) => entry.sessionId === 'parent-session')
    expect(notices).toHaveLength(2)
    expect(notices.map((entry) => entry.message.source)).toMatchObject([
      { runId: first.runId }, { runId: next.runId }])
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toHaveLength(1)
  })

  it('returns accurate provenance for a parent notification error while the child verdict stays verified', async () => {
    const h = await setup()
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    await h.answer('child-task', true)
    h.runtime.beforePost((id) => { if (id === 'parent-session') throw new Error('parent delivery failed') })
    await expect(scheduler.advance('parent-task')).rejects.toMatchObject({ parentTaskId: 'parent-task', taskId: 'parent-task', runId: null,
      cause: expect.objectContaining({ message: 'parent delivery failed' }),
    })
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]).toMatchObject({ status: 'verified' })
  })

  it('surfaces owned child close failure and stops the handle during unload', async () => {
    const h = await setup()
    const scheduler = h.make(async (request) => ({
      ...(await h.runtime.open(request)), stop: () => { throw new Error('close failed') },
    }))
    await scheduler.advance('parent-task')
    await expect(scheduler.close()).rejects.toThrow('child unload failed')
    schedulers.splice(schedulers.indexOf(scheduler), 1)
  })
})

describe('scheduler messages retain native inbox provenance', () => {
  const source = { kind: 'singularity' as const, purpose: 'dispatch' as const, controlId: 'scheduler', parentTaskId: 'parent-task', taskId: 'child-task', runId: 'r1', factSeq: 10,
  }
  it('posts a new source once and wakes its pending native message without another insertion', async () => {
    const runtime = nativeRuntime()
    const agent = runtime.agent('child-session')
    expect(await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))).toBe('posted')
    expect(await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))).toBe('pending')
    expect(runtime.delivered).toHaveLength(1)
    expect(runtime.woken).toEqual(['child-session'])
  })
  it('recognizes a message already entered after its inbox removal and never posts it again', async () => {
    const runtime = nativeRuntime()
    const agent = runtime.agent('child-session')
    const message = schedulerMessage(source, 'solve')
    await postIdentifiedMessage(runtime.seams, agent, message)
    runtime.append('child-session', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [],
    })
    runtime.append('child-session', 'user/message', message)
    expect(await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))).toBe('entered')
    expect(runtime.delivered).toHaveLength(1)
    expect(runtime.woken).toEqual([])
  })
  it('refuses a claimed message whose entry into a turn is unknown instead of guessing a redelivery', async () => {
    const runtime = nativeRuntime()
    const agent = runtime.agent('child-session')
    await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))
    runtime.append('child-session', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [],
    })
    expect(await asyncRefusalOf(() => postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))),
    )
      .toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('unconfirmed') })
    expect(runtime.delivered).toHaveLength(1)
  })
  it('rejects different content under the same native source without a second insertion', async () => {
    const runtime = nativeRuntime()
    const agent = runtime.agent('child-session')
    await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))
    expect(await asyncRefusalOf(() => postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'different task')),
      ),
    )
      .toMatchObject({ code: 'command-conflict' })
    expect(runtime.delivered).toHaveLength(1)
  })
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildSessionRequest, ChildSession, ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { TASK_KINDS } from '../../src/task/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { bindCaller, declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt, workspaceOf } from '../src/attempt.ts'
import { runIdOf, sha256 } from '../src/ids.ts'
import { domainForRun, seedMethod } from '../src/method.ts'
import { REVIEW_TEMPLATE, SUBJECT_INPUT } from '../src/review.ts'
import { decompose } from '../src/surfaces.ts'
import { createScheduler, type Scheduler } from '../src/scheduler.ts'
import { schedulerMessage } from '../src/scheduler-message.ts'
import { contractFor } from '../src/inputs.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { submit } from '../src/submission.ts'
import { attachmentsAt, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
const schedulers: Scheduler[] = []
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const contentOf = (message: UserMessage) => message.content.map(block => block.type === 'text' ? block.text : '').join('\n')

it('freezes the actual review responsibility and subject in recursively delegated Runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assembly-review-subject-'))
  roots.push(root)
  const apparatus = await openApparatus('review-subject', root, await loadDomain(domainDir, spawnProcess), new FakePersistence() as never, attachmentsAt(root))
  const method = await seedMethod(apparatus)
  const bytes = Buffer.from(JSON.stringify({ artifact: 'the exact result to review' }))
  const input = { ref: SUBJECT_INPUT, bytes, digest: sha256(bytes), sourcePath: '' }
  const domain = { ...apparatus.domain, inputs: [...apparatus.domain.inputs.filter(held => held.ref !== SUBJECT_INPUT), input] }
  const runtime = nativeRuntime()
  runtime.agent('review-session')
  const caller = { agentId: 'review-session', sessionId: 'review-session', model: { provider: 'test', model: 'model-under-test' } }
  await bindCaller(apparatus, caller)
  const template = domain.templates.get(REVIEW_TEMPLATE)!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.admit({ commandId: 'review-admit', taskId: 'review-parent', contract: { ...contractFor(domain, template, template.goal), assets: method } })
  await commands.assign({ commandId: 'review-assign', taskId: 'review-parent', agentId: caller.agentId })
  await startAttempt(apparatus, caller, 'review-parent', 'review-run', method, { domain, purpose: 'review' })
  const scheduler = createScheduler(apparatus, runtime.seams, runtime.open)
  schedulers.push(scheduler)
  const result = await decompose(apparatus, scheduler, caller, { taskId: 'review-parent', children: [{
    key: 'inspect', template: REVIEW_TEMPLATE, dependsOn: [], supports: ['review-approved'], maxRuns: 1,
  }] })
  const child = taskStateOf(apparatus, result.opened[0]!)
  const run = Object.values(child.runs)[0]!
  expect((apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!
    .revisions[run.revision.revisionId]!.manifest as { purpose: string }).purpose).toBe('review')
  expect(child.contract!.inputs[0]!.source).toMatchObject({ digest: input.digest })
  expect(await readFile(join(workspaceOf(apparatus, child.taskId, run.runId), template.input.name), 'utf8')).toBe(bytes.toString('utf8'))
  expect((await domainForRun(apparatus, run)).inputs.find(held => held.ref === SUBJECT_INPUT)?.digest).toBe(input.digest)
  await apparatus.store.close()
})

function nativeRuntime() {
  const agents = new Map<string, Agent>()
  const routes = new Map<string, { provider: string; model: string }>()
  const headersAbsent = new Set<string>()
  const events = new Map<string, SessionEvent[]>()
  const delivered: { sessionId: string; message: UserMessage }[] = []
  const woken: string[] = []
  const stopped: string[] = []
  const opened: ChildSessionRequest[] = []
  let beforePost: ((sessionId: string, message: UserMessage) => void) | undefined
  const append = (id: string, type: 'agent/inbox/spliced' | 'user/message', data: unknown) => {
    const log = events.get(id)!
    log.push({ type, seq: SessionSeq(log.length), time: log.length, data } as SessionEvent)
  }
  const agent = (id: string, model = 'model-under-test'): Agent => {
    events.set(id, events.get(id) ?? [])
    routes.set(id, { provider: 'test', model })
    const created = {
      id: SessionId(id),
      get options() { return routes.get(id)! },
      session: { id: SessionId(id), header: { id: SessionId(id) }, get seq() { return events.get(id)!.length },
        requestHeader: () => headersAbsent.has(id) ? undefined : { config: routes.get(id)! } },
      followup: (message: UserMessage) => {
        beforePost?.(id, message)
        delivered.push({ sessionId: id, message })
        append(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
      },
      wake: () => { woken.push(id) },
      whenIdle: async () => { throw new Error('dispatch must not await child idle') },
      cancel: () => { stopped.push(id) },
    } as unknown as Agent
    agents.set(id, created)
    return created
  }
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => agents.get(id) } as unknown as AgentRegistry,
    sessions: { flush: async () => true },
    sessionPersistence: { open: async (id: string) => ({ id: SessionId(id),
      read: async () => ({ events: structuredClone(events.get(id)!), eventState: 'detached' }), close: async () => undefined }) } as unknown as SessionPersistence,
  }
  const seams: ChildSessionSeams = { get: name => services[name] }
  const open = async (request: ChildSessionRequest): Promise<ChildSession> => {
    opened.push(request)
    const id = String(agentSessionIdOf(request.agentId))
    const live = agents.get(id) ?? agent(id, request.model.model)
    const resumed = events.get(id)!.length > 0
    const post = (message: UserMessage) => postIdentifiedMessage(seams, live, message,
      message => live.followup(message))
    let delivery: ChildSession['delivery']
    if (resumed) delivery = await post(request.message)
    else {
      live.followup(request.message)
      delivery = 'posted'
    }
    return { agentId: id, sessionId: id, resumed, agent: live, delivery,
      post, wait: () => live.whenIdle(), stop: () => live.cancel({ kind: 'parent' }), close: async () => undefined }
  }
  return { agents, routes, headersAbsent, events, delivered, woken, stopped, opened, seams, open, agent, append,
    beforePost: (listener: typeof beforePost) => { beforePost = listener } }
}

async function setup(maxRuns = 1, dependent: boolean | 'siblings' = false) {
  const root = await mkdtemp(join(tmpdir(), 'assembly-scheduler-'))
  roots.push(root)
  const domain = await loadDomain(domainDir, spawnProcess)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('scheduler', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root))
  const runtime = nativeRuntime()
  const addPlan = async (parentTaskId: string, holder: string, parentSession: string, childTaskId: string, model: string,
    admitChildren = true, childContract?: TaskContract) => {
    const parent = runtime.agent(parentSession, model)
    await bindCaller(apparatus, { agentId: holder, sessionId: parentSession, model: { provider: 'test', model } })
    const template = domain.templates.get(domain.rootTemplate)!
    const contract = contractFor(domain, template, 'count letters')
    await apparatus.tasks.admit({ commandId: 'admit:' + parentTaskId, taskId: parentTaskId, contract })
    await apparatus.tasks.assign({ commandId: 'assign:' + parentTaskId, taskId: parentTaskId, agentId: holder })
    await startAttempt(apparatus, { agentId: holder, sessionId: parentSession, model: { provider: 'test', model } }, parentTaskId, 'parent-start:' + parentTaskId)
    const children: { taskId: string; dependsOn: string[]; supports: string[]; maxRuns: number }[] = [
      { taskId: childTaskId, dependsOn: [], supports: ['letters'], maxRuns }]
    if (dependent) children.push({ taskId: childTaskId + (dependent === 'siblings' ? '-sibling' : '-dependent'),
      dependsOn: dependent === 'siblings' ? [] : [childTaskId], supports: ['letters'], maxRuns })
    for (const child of admitChildren ? children : []) {
      const childId = String(agentSessionIdOf(child.taskId))
      declareCaller(apparatus, childId)
      await apparatus.agents.open({ commandId: 'open:' + childId, agentId: childId, sessionId: childId, role: 'child' })
      await apparatus.tasks.admit({ commandId: 'admit:' + child.taskId, taskId: child.taskId, contract: childContract ?? contract })
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
    return await submit(apparatus, fakeExecution(() => undefined), { agentId: id, sessionId: id, model: { provider: 'test', model: 'model-A' } },
      execFor(child, 'submit:' + run.runId), { taskId, program: `process.stdout.write('${pass ? '35' : '0'}')` }, new AbortController().signal)
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
    expect(contentOf(message)).toContain(join(run.bubble!.workspace.ref, 'in/source.txt'))
    expect(contentOf(message)).toContain('Each singularity_submit_program call consumes one attempt')
    expect(contentOf(message)).toContain('Submit only your final answer; never use submission to probe the interface')
    expect(message.source).toMatchObject({ kind: 'singularity', purpose: 'dispatch' })
    expect(h.runtime.opened[0]!.message.source).toMatchObject({ kind: 'singularity', controlId: 'scheduler', purpose: 'dispatch', parentTaskId: 'parent-task', taskId: 'child-task', runId: run.runId,
      factSeq: factsOf(h.medium).find(fact => fact.kind === TASK_KINDS.runStarted && fact.subject === 'child-task')!.seq })
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
    const oldProgram = await readFile(join(run1.bubble!.workspace.ref, 'program.mjs'))
    expect(await scheduler.advance('parent-task')).toEqual(['child-task'])
    const runs = Object.values(taskStateOf(h.apparatus, 'child-task').runs)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ status: 'failed', failureCause: 'acceptance' })
    expect(runs[1]).toMatchObject({ status: 'running', stage: 'working' })
    expect(h.runtime.opened).toHaveLength(1)
    expect(contentOf(h.runtime.delivered[1]!.message)).toContain(first.detail)
    expect(contentOf(h.runtime.delivered[1]!.message)).toContain(runs[1]!.bubble!.workspace.ref)
    expect(runs[1]!.bubble!.workspace.ref).not.toBe(run1.bubble!.workspace.ref)
    expect(await readFile(join(run1.bubble!.workspace.ref, 'program.mjs'))).toEqual(oldProgram)
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
  })

  it.each(['exhausted', 'runtime'] as const)('stops %s work and notifies the accurate parent once with terminal provenance', async cause => {
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
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
    const notice = h.runtime.delivered.find(entry => entry.sessionId === 'parent-session')!.message
    const terminal = factsOf(h.medium).findLast(fact => fact.subject === 'child-task' && fact.kind === TASK_KINDS.runFailed)!
    expect(notice.source).toMatchObject({ kind: 'singularity', purpose: 'plan-outcome', parentTaskId: 'parent-task', taskId: 'child-task', factSeq: terminal.seq })
    expect(contentOf(notice)).toContain(cause === 'runtime' ? 'provider unavailable' : 'budget exhausted')
    expect(contentOf(notice)).toContain('child-task-dependent')
    expect(h.runtime.delivered.filter(entry => entry.sessionId !== 'parent-session')).toHaveLength(1)
  })

  it('wakes the accurate parent after delegated work verifies without passing its own Run', async () => {
    const h = await setup()
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    await h.answer('child-task', true)
    await scheduler.advance('parent-task')
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
    const notice = h.runtime.delivered.find(entry => entry.sessionId === 'parent-session')!.message
    expect(contentOf(notice)).toContain('independent')
    expect(Object.values(taskStateOf(h.apparatus, 'parent-task').runs)[0]).toMatchObject({ status: 'running', evidence: [] })
    await scheduler.advance('parent-task')
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('reports both a failed branch and the later completion of independent siblings with accurate provenance', async () => {
    const h = await setup(1, 'siblings')
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    const run = Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]!
    await h.apparatus.tasks.forAgent(String(agentSessionIdOf('child-task'))).failRun({ commandId: 'runtime', taskId: 'child-task',
      runId: run.runId, reason: 'provider unavailable' })
    await scheduler.advance('parent-task')
    const first = h.runtime.delivered.find(entry => entry.sessionId === 'parent-session')!.message
    await h.answer('child-task-sibling', true)
    await scheduler.advance('parent-task')
    const terminal = factsOf(h.medium).findLast(fact => fact.subject === 'child-task' && fact.kind === TASK_KINDS.runFailed)!
    expect(first.source).toMatchObject({ taskId: 'child-task', runId: run.runId, factSeq: terminal.seq })
    const notices = h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')
    expect(notices).toHaveLength(2)
    expect(notices[0]).toEqual({ sessionId: 'parent-session', message: first })
    expect(notices[1]!.message.source).toMatchObject({ taskId: 'child-task-sibling' })
    expect(contentOf(notices[1]!.message)).toContain('settled')
  })

  it('refuses a plan outcome without a causal terminal instead of inventing notification provenance', async () => {
    const h = await setup()
    await h.addPlan('missing-parent', 'missing-holder', 'missing-session', 'absent-child', 'model-C', false)
    expect(await asyncRefusalOf(() => h.make().advance('missing-parent'))).toMatchObject({ code: 'illegal-transition',
      detail: expect.stringContaining('no terminal fact') })
    expect(h.runtime.delivered).toEqual([])
    expect(h.runtime.opened).toEqual([])
  })

  it.each(['create', 'post'] as const)('records %s failure as runtime, notifies the parent, and returns the dispatch error', async phase => {
    const h = await setup(3)
    if (phase === 'post') h.runtime.beforePost(id => { if (id !== 'parent-session') throw new Error('post failed') })
    const scheduler = h.make(phase === 'create' ? async () => { throw new Error('create failed') } : h.runtime.open)
    await expect(scheduler.advance('parent-task')).rejects.toThrow(phase + ' failed')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]).toMatchObject({ status: 'failed', failureCause: 'runtime' })
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
    expect(await scheduler.advance('parent-task')).toEqual([])
    expect(h.runtime.opened).toHaveLength(phase === 'create' ? 0 : 1)
  })

  it('notifies the parent when preparation fails after starting the child Run', async () => {
    const h = await setup(3)
    const runId = runIdOf('scheduler', String(agentSessionIdOf('child-task')), 'child-task:attempt:0')
    const input = join(workspaceOf(h.apparatus, 'child-task', runId), 'in/source.txt')
    await mkdir(dirname(input), { recursive: true })
    await writeFile(input, 'already exists')
    await expect(h.make().advance('parent-task')).rejects.toMatchObject({ taskId: 'child-task', runId })
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ runId, status: 'failed', failureCause: 'runtime' }])
    expect(h.runtime.opened).toEqual([])
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('stops and notifies once when a child input loses its authoritative sealed object', async () => {
    const h = await setup(3)
    const caller = { agentId: 'holder', sessionId: 'parent-session', model: { provider: 'test', model: 'model-A' } }
    const commands = h.apparatus.tasks.forAgent(caller.agentId)
    const template = h.apparatus.domain.templates.get('extract-letters')!
    await commands.admit({ commandId: 'producer-admit', taskId: 'producer', contract: contractFor(h.apparatus.domain, template, template.goal) })
    await commands.assign({ commandId: 'producer-assign', taskId: 'producer', agentId: caller.agentId })
    await startAttempt(h.apparatus, caller, 'producer', 'producer-run')
    const result = await submit(h.apparatus, fakeExecution(() => undefined), caller, execFor(h.parent, 'producer-submit'), { taskId: 'producer',
      program: "import { readFileSync } from 'node:fs'; process.stdout.write((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).join(''))" }, new AbortController().signal)
    expect(result.verdict).toBe('pass')
    const producer = taskStateOf(h.apparatus, 'producer').runs[result.runId]!
    await rm(attachmentsAt(h.root).fileHostPath(producer.submission!.files.artifact))
    const consumer = h.apparatus.domain.templates.get('count-letters')!
    await h.addPlan('artifact-parent', 'artifact-holder', 'artifact-session', 'consumer-task', 'model-A', true,
      contractFor(h.apparatus.domain, consumer, consumer.goal, 'producer'))
    const scheduler = h.make()
    await expect(scheduler.advance('artifact-parent')).rejects.toMatchObject({ taskId: 'consumer-task' })
    expect(await scheduler.advance('artifact-parent')).toEqual([])
    expect(Object.values(taskStateOf(h.apparatus, 'consumer-task').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' }])
    expect(h.runtime.opened).toEqual([])
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'artifact-session')).toHaveLength(1)
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
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' }])
    expect(h.runtime.delivered.filter(entry => entry.sessionId === childId)).toHaveLength(1)
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('fails an interrupted unprepared Run as runtime without opening a child or starting another Run', async () => {
    const h = await setup(3)
    const revision = Object.values(taskStateOf(h.apparatus, 'parent-task').runs)[0]!.revision
    await h.apparatus.tasks.forAgent(String(agentSessionIdOf('child-task'))).startRun({ commandId: 'interrupted',
      taskId: 'child-task', runId: 'unprepared', revision })
    await expect(h.make().advance('parent-task')).rejects.toThrow('no prepared execution bubble')
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ runId: 'unprepared', status: 'failed', failureCause: 'runtime' }])
    expect(h.runtime.opened).toEqual([])
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it.each(['entered', 'claimed'] as const)('recovers entered work and refuses unconfirmed claimed delivery (%s)', async state => {
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
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' }])
    expect(h.runtime.delivered.filter(entry => entry.sessionId === id)).toHaveLength(1)
    expect(h.runtime.delivered.filter(entry => entry.sessionId === 'parent-session')).toHaveLength(1)
  })

  it('returns accurate provenance for a parent notification error while the child verdict stays verified', async () => {
    const h = await setup()
    const scheduler = h.make()
    await scheduler.advance('parent-task')
    await h.answer('child-task', true)
    h.runtime.beforePost(id => { if (id === 'parent-session') throw new Error('parent delivery failed') })
    await expect(scheduler.advance('parent-task')).rejects.toMatchObject({ parentTaskId: 'parent-task', taskId: 'parent-task', runId: null,
      cause: expect.objectContaining({ message: 'parent delivery failed' }) })
    expect(Object.values(taskStateOf(h.apparatus, 'child-task').runs)[0]).toMatchObject({ status: 'verified' })
  })

  it('surfaces owned child close failure and stops the handle during unload', async () => {
    const h = await setup()
    const scheduler = h.make(async request => ({ ...await h.runtime.open(request), stop: () => { throw new Error('close failed') } }))
    await scheduler.advance('parent-task')
    await expect(scheduler.close()).rejects.toThrow('child unload failed')
    schedulers.splice(schedulers.indexOf(scheduler), 1)
  })
})

describe('scheduler messages retain native inbox provenance', () => {
  const source = { kind: 'singularity' as const, purpose: 'dispatch' as const, controlId: 'scheduler', parentTaskId: 'parent-task', taskId: 'child-task', runId: 'r1', factSeq: 10 }
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
    runtime.append('child-session', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    runtime.append('child-session', 'user/message', message)
    expect(await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))).toBe('entered')
    expect(runtime.delivered).toHaveLength(1)
    expect(runtime.woken).toEqual([])
  })
  it('refuses a claimed message whose entry into a turn is unknown instead of guessing a redelivery', async () => {
    const runtime = nativeRuntime()
    const agent = runtime.agent('child-session')
    await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))
    runtime.append('child-session', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    expect(await asyncRefusalOf(() => postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))))
      .toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('unconfirmed') })
    expect(runtime.delivered).toHaveLength(1)
  })
  it('rejects different content under the same native source without a second insertion', async () => {
    const runtime = nativeRuntime()
    const agent = runtime.agent('child-session')
    await postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'solve'))
    expect(await asyncRefusalOf(() => postIdentifiedMessage(runtime.seams, agent, schedulerMessage(source, 'different task'))))
      .toMatchObject({ code: 'command-conflict' })
    expect(runtime.delivered).toHaveLength(1)
  })
})

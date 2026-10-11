import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { TASK_KINDS } from '../../src/task/protocol.ts'
import { asyncRefusalOf, refusalOf } from '../../tests/fixtures.ts'
import { loadDomain } from '../src/domain.ts'
import { openDriver, type TaskDriver } from '../src/driver.ts'
import { taskIdOf } from '../src/ids.ts'
import { spawnProcess } from '../src/process.ts'
import type { Admission } from '../src/execution.ts'
import { attachmentsAt, agentFor, execFor, factsOf, fakeExecution, FakePersistence, kindsOf, mount, serviceOf } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const EXTRACTING = "import { readFileSync } from 'node:fs'; process.stdout.write((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).join(''))"
const COUNTING = "import { readFileSync } from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))"
let root: string | undefined
let context: Context | undefined
let ownedDriver: TaskDriver | undefined
afterEach(async () => {
  await ownedDriver?.close()
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  context = undefined
  ownedDriver = undefined
  root = undefined
})

async function childrenRuntime() {
  root = await mkdtemp(join(tmpdir(), 'assembly-children-'))
  const medium = new FakePersistence()
  const parent = agentFor('agent-7', 'session-9')
  const agents = new Map<string, Agent>([[parent.session.id, parent]])
  const delivered: { sessionId: string; message: unknown }[] = []
  const logs = new Map<string, SessionEvent[]>()
  const attach = (agent: Agent): Agent => {
    const sessionId = String(agent.session.id)
    const events: SessionEvent[] = []
    logs.set(sessionId, events)
    return Object.assign(agent, {
      session: { ...agent.session, get seq() { return events.length } },
      followup: (message: unknown) => {
        delivered.push({ sessionId, message })
        events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } } as unknown as SessionEvent)
      },
      whenIdle: async () => undefined,
      wake: () => undefined,
      cancel: () => undefined,
    })
  }
  attach(parent)
  const registry = {
    get: (id: string) => agents.get(id),
    create: async (options: CreateAgentOptions) => {
      const sessionId = String(options.sessionId)
      const agent = attach(agentFor(sessionId, sessionId))
      agents.set(sessionId, agent)
      return { agent, dispose: async () => { agents.delete(sessionId) } }
    },
  } as unknown as AgentRegistry
  const services: Readonly<Record<string, unknown>> = {
    agents: registry, sessionPersistence: {
      stat: (id: string) => medium.stat(id as never),
      open: async (id: string) => ({ id, read: async () => ({ events: logs.get(id)!, eventState: 'detached' }), close: async () => undefined }),
    }, sessions: { flush: async () => true }, agentLoop: {}, agentPresets: { composeFrom: () => undefined },
  }
  const seams: ChildSessionSeams = { get: name => services[name] }
  ownedDriver = await openDriver({ controlId: 'lib-1', workspaceRoot: root, domain: await loadDomain(REAL, spawnProcess),
    persistence: medium as unknown as SessionPersistence, attachments: attachmentsAt(root), seams, execution: fakeExecution })
  const driver = ownedDriver
  const call = (agent: Agent, id: string) => driver.forCall(execFor(agent, id))
  return { driver, parent, agents, medium, delivered, call }
}

async function mounted() {
  root = await mkdtemp(join(tmpdir(), 'assembly-ws-'))
  const { ctx, medium } = await mount({ controlId: 'lib-1', domainDir: REAL, workspaceRoot: root })
  context = ctx
  const surface = serviceOf(ctx)
  const agent = agentFor('agent-7', 'session-9')
  const call = (id: string) => surface.forCall(execFor(agent, id))
  return { surface, medium, workspace: root, agent, call }
}

describe('the driver with explicit execution and persistence ports', () => {
  it('keeps Method creation and real history available after a root Run settles', async () => {
    root = await mkdtemp(join(tmpdir(), 'assembly-admission-'))
    const medium = new FakePersistence()
    let admission!: Admission
    ownedDriver = await openDriver({ controlId: 'lib-1', workspaceRoot: root, domain: await loadDomain(REAL, spawnProcess),
      persistence: medium as unknown as SessionPersistence, attachments: attachmentsAt(root), seams: {},
      execution: selected => { admission = selected; return fakeExecution(selected) } })
    const agent = agentFor('agent-7', 'session-9')
    const surface = (id: string) => ownedDriver!.forCall(execFor(agent, id))
    const proposal = await surface('propose').propose({ goal: 'count letters' })
    await surface('submit').submit({ taskId: proposal.taskId, program: COUNTING })
    for (const name of ['singularity_create_method', 'singularity_evolve_method', 'singularity_method_history', 'singularity_release_method'])
      expect(admission({ ...execFor(agent, name), name } as never)).toBeUndefined()
    expect(admission({ ...execFor(agent, 'write'), name: 'write_file' } as never)).toBe('this Run has closed write admission')
    const method = await surface('method').createMethod({ rootTemplate: proposal.rootTemplate, templates: proposal.templates, skill: 'Inspect and count.', tool: COUNTING })
    expect((await surface('history').history()).methods[0]?.reference).toEqual(method)
  })
  it('enforces the root Run cap through the actual proposal port and counts Task reuse', async () => {
    root = await mkdtemp(join(tmpdir(), 'assembly-budget-'))
    const medium = new FakePersistence()
    ownedDriver = await openDriver({ controlId: 'lib-1', workspaceRoot: root, domain: await loadDomain(REAL, spawnProcess),
      persistence: medium as unknown as SessionPersistence, attachments: attachmentsAt(root), seams: {}, execution: fakeExecution,
      budget: { rootSolves: 2, children: 2, childRuns: 2, nativeTokens: 100 } })
    const agent = agentFor('agent-7', 'session-9')
    const surface = (id: string) => ownedDriver!.forCall(execFor(agent, id))
    const first = await surface('first').propose({ goal: 'count letters' })
    await surface('submit-first').submit({ taskId: first.taskId, program: COUNTING })
    const second = await surface('second').propose({ goal: 'count letters' })
    expect(second.taskId).toBe(first.taskId)
    await surface('submit-second').submit({ taskId: second.taskId, program: COUNTING })
    expect((await asyncRefusalOf(() => surface('third').propose({ goal: 'count letters' }))).code).toBe('budget-exhausted')
    expect(ownedDriver.budget?.report().rootSolves).toBe(2)
    expect(factsOf(medium).filter(fact => fact.kind === 'run/started')).toHaveLength(2)
  })
  it('activates only the recorded parent session to recover an already published plan', async () => {
    const { parent, driver, agents, delivered, call } = await childrenRuntime()
    const proposal = await call(parent, 'propose').propose({ goal: 'count letters' })
    agents.delete(String(parent.session.id))
    await expect(call(parent, 'plan').decompose({ taskId: proposal.taskId, children: [
      { key: 'extract', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 },
    ] })).rejects.toThrow('no live recorded parent')
    await driver.activate('unrelated-session')
    expect(delivered).toEqual([])
    agents.set(String(parent.session.id), parent)
    await driver.activate(String(parent.session.id))
    expect(delivered).toHaveLength(1)
  })
  it('starts a complete solve Run and stages its declared protected input in that Run workspace', async () => {
    const { call, medium, workspace } = await mounted()
    const proposal = await call('propose').propose({ goal: 'count the letters' })
    expect(proposal).toMatchObject({ runId: expect.any(String), phase: 'running' })
    expect(proposal.workspace).toBe(join(workspace, 'tasks', proposal.taskId, 'runs', proposal.runId))
    expect(await readFile(join(proposal.workspace, 'in/source.txt'), 'utf8')).toBe(await readFile(join(REAL, 'samples/source.txt'), 'utf8'))
    expect(factsOf(medium).find(fact => fact.kind === TASK_KINDS.runStarted)).toMatchObject({ subject: proposal.taskId, payload: { runId: proposal.runId } })
  })

  it('attributes the caller node to the execution port session identity', async () => {
    const { call, medium } = await mounted()
    await call('propose').propose({ goal: 'g' })
    expect(factsOf(medium)[0]?.payload).toMatchObject({ agentId: 'agent-7', sessionId: 'session-9', role: 'root' })
  })

  it('returns a redelivered proposal without creating a second Run', async () => {
    const { call, medium } = await mounted()
    const first = await call('propose').propose({ goal: 'count the letters' })
    const committed = medium.events.length
    expect(await call('propose').propose({ goal: 'count the letters' })).toEqual(first)
    expect(medium.events.length).toBe(committed)
  })

  it('refuses a plan with no live recorded parent session instead of using the caller as a substitute', async () => {
    const { call, medium } = await mounted()
    const proposal = await call('propose').propose({ goal: 'count the letters' })
    const refusal = await asyncRefusalOf(() => call('plan').decompose({
      taskId: proposal.taskId,
      children: [{ key: 'first', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 }],
    }))
    expect(refusal.code).toBe('unknown-emitter-role')
    expect(factsOf(medium).some(fact => fact.kind === TASK_KINDS.decomposed)).toBe(true)
  })

  it('admits every sub-task a plan names, so the plan can actually run', async () => {
    const { parent, medium, agents, call } = await childrenRuntime()
    const proposal = await call(parent, 'propose').propose({ goal: 'count the letters' })
    const first = taskIdOf('lib-1', proposal.taskId, 'first')
    const second = taskIdOf('lib-1', proposal.taskId, 'second')
    expect(await call(parent, 'plan').decompose({ taskId: proposal.taskId, children: [
      { key: 'first', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 },
      { key: 'second', template: 'count-letters', dependsOn: ['first'], supports: ['letters'], maxRuns: 1 },
    ] })).toMatchObject({ opened: [first] })
    for (const taskId of [first, second])
      expect(factsOf(medium).find(fact => fact.subject === taskId && fact.kind === TASK_KINDS.assigned)?.payload)
        .toMatchObject({ agentId: String(agentSessionIdOf(taskId)) })
    const before = medium.events.length
    expect(await asyncRefusalOf(() => call(parent, 'foreign-submit').submit({ taskId: first, program: COUNTING }))).toMatchObject({ code: 'not-responsible' })
    expect(medium.events.length).toBe(before)
    expect(await call(agents.get(String(agentSessionIdOf(first)))!, 'child-submit').submit({ taskId: first, program: EXTRACTING }))
      .toMatchObject({ taskId: first, verdict: 'pass', phase: 'verified' })
  })

  it('re-scans the plan when a run settles, so a dependency that just verified can start', async () => {
    const { parent, medium, agents, delivered, call } = await childrenRuntime()
    const proposal = await call(parent, 'propose').propose({ goal: 'count the letters' })
    const first = taskIdOf('lib-1', proposal.taskId, 'first')
    const second = taskIdOf('lib-1', proposal.taskId, 'second')
    await call(parent, 'plan').decompose({ taskId: proposal.taskId, children: [
      { key: 'first', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 },
      { key: 'second', template: 'count-letters', dependsOn: ['first'], supports: ['letters'], maxRuns: 1 },
    ] })
    expect(delivered.map(entry => entry.sessionId)).toEqual([String(agentSessionIdOf(first))])
    const firstAnswer = await call(agents.get(String(agentSessionIdOf(first)))!, 'first-submit').submit({ taskId: first, program: EXTRACTING })
    expect(firstAnswer).toMatchObject({ verdict: 'pass', phase: 'verified' })
    expect(firstAnswer.dispatchError).toBeUndefined()
    expect(delivered.map(entry => entry.sessionId)).toEqual([String(agentSessionIdOf(first)), String(agentSessionIdOf(second))])
    expect(JSON.stringify(delivered[1]!.message)).toContain('in/letters.txt')
    const secondRun = factsOf(medium).find(fact => fact.subject === second && fact.kind === TASK_KINDS.runStarted)
    expect(secondRun?.actor).toBe('lib-1:agent:' + String(agentSessionIdOf(second)))
    expect(secondRun?.seq).toBeGreaterThan(factsOf(medium).find(fact => fact.subject === first && fact.kind === TASK_KINDS.runVerified)!.seq)
    const secondBubble = factsOf(medium).find(fact => fact.subject === second && fact.kind === TASK_KINDS.bubbleOpened)!.payload as { workspace: { ref: string }; inputs: unknown[] }
    const extracted = (await readFile(join(REAL, 'samples/source.txt'), 'utf8')).match(/[A-Za-z]/g)!.join('')
    expect(await readFile(join(secondBubble.workspace.ref, 'in/letters.txt'), 'utf8')).toBe(extracted)
    expect(secondBubble.inputs).toEqual([{ name: 'in/letters.txt', digest: sha256(extracted) }])
    const manifest = factsOf(medium).filter(fact => fact.kind === 'revision/created').at(-1)!.payload
    expect(manifest).toMatchObject({ manifest: { inputSources: [{ name: 'in/letters.txt', digest: sha256(extracted),
      source: { kind: 'artifact', taskId: first, runId: firstAnswer.runId } }] } })
    expect(await call(agents.get(String(agentSessionIdOf(second)))!, 'second-submit').submit({ taskId: second, program: COUNTING }))
      .toMatchObject({ taskId: second, verdict: 'pass', phase: 'verified' })
    const plan = (await ownedDriver!.read()).plans[0]!
    expect(plan).toMatchObject({ complete: false, criteria: [{ criterionId: 'letters', satisfiedBy: null }] })
    expect(await call(parent, 'parent-submit').submit({ taskId: proposal.taskId, program: COUNTING }))
      .toMatchObject({ verdict: 'pass', phase: 'verified' })
    expect((await ownedDriver!.read()).plans[0]).toMatchObject({ complete: true,
      criteria: [{ criterionId: 'letters', satisfiedBy: proposal.runId }] })
    const snapshot = await ownedDriver!.read()
    const counted = snapshot.tasks.find(task => task.taskId === second)!
    expect(counted).toMatchObject({ sessionId: String(agentSessionIdOf(second)), template: { id: 'count-letters' }, runs: [{
      inputSources: [{ source: { kind: 'artifact', taskId: first, runId: firstAnswer.runId } }],
      receipt: { source: { sessionId: String(agentSessionIdOf(second)) }, status: 'verified' },
    }] })
  })

  it('settles the proposal Run from the independent verifier output', async () => {
    const { call, medium } = await mounted()
    const proposal = await call('propose').propose({ goal: 'count the letters' })
    const answer = await call('submit').submit({ taskId: proposal.taskId, program: COUNTING })
    expect(answer).toMatchObject({ runId: proposal.runId, verdict: 'pass', phase: 'verified', artifactDigest: sha256('35') })
    expect(kindsOf(medium).slice(-3)).toEqual([TASK_KINDS.runSubmitted, TASK_KINDS.evidenceProduced, TASK_KINDS.runVerified])
  })

  it('pins the actual model route and interpreter bytes before solving', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('worker', 'worker-session', 'm-under-test')
    await surface.forCall(execFor(agent, 'propose')).propose({ goal: 'g' })
    expect(factsOf(medium).find(fact => fact.kind === 'bubble/opened')?.payload).toMatchObject({
      model: { provider: 'test', model: 'm-under-test' },
      tools: [{ name: 'node', version: process.version, implementationDigest: sha256(await readFile(process.execPath)) }],
    })
  })

  it('records an ordinary wrong answer as a failed solve', async () => {
    const { call } = await mounted()
    const proposal = await call('propose').propose({ goal: 'g' })
    expect(await call('submit').submit({ taskId: proposal.taskId, program: "process.stdout.write('0')" })).toMatchObject({ verdict: 'fail', phase: 'failed' })
  })

  it('executes submitted programs in their exact Run workspace', async () => {
    const { call } = await mounted()
    const proposal = await call('cwd-propose').propose({ goal: 'count letters' })
    const program = "process.stdout.write(process.cwd())"
    await call('cwd-submit').submit({ taskId: proposal.taskId, program })
    expect(await readFile(join(proposal.workspace, 'report.txt'), 'utf8')).toBe(proposal.workspace)
  })

  it('cancels the submitted process through the native tool signal', async () => {
    const { surface, call, agent } = await mounted()
    const proposal = await call('cancel-propose').propose({ goal: 'count letters' })
    const controller = new AbortController()
    const pending = surface.forCall({ ...execFor(agent, 'cancel-submit'), signal: controller.signal }).submit({ taskId: proposal.taskId,
      program: "import { writeFileSync } from 'node:fs'; writeFileSync('ready.txt', 'ready'); process.stdout.write('35'); setTimeout(() => {}, 750)" })
    await vi.waitFor(() => access(join(proposal.workspace, 'ready.txt')))
    controller.abort(new Error('user cancelled'))
    expect(await pending).toMatchObject({ phase: 'failed', detail: expect.stringContaining('cancelled') })
  })

  it('pins separate task revisions against the template rather than mutable workspace bytes', async () => {
    const { call, medium } = await mounted()
    const first = await call('first').propose({ goal: 'g' })
    await call('submit-first').submit({ taskId: first.taskId, program: COUNTING })
    const second = await call('second').propose({ goal: 'another goal' })
    const manifests = factsOf(medium).filter(fact => fact.kind === 'revision/created')
      .map(fact => (fact.payload as { manifest: { taskTemplate: {id: string; digest: string}; task: string } }).manifest)
    expect(manifests.map(manifest => manifest.task)).toEqual([first.taskId, second.taskId])
    expect(new Set(manifests.map(manifest => JSON.stringify(manifest.taskTemplate))).size).toBe(1)
  })

  it('reads the settled receipt without committing any new fact', async () => {
    const { call, medium } = await mounted()
    const proposal = await call('propose').propose({ goal: 'g' })
    await call('submit').submit({ taskId: proposal.taskId, program: COUNTING })
    const committed = medium.events.length
    expect(await call('status').status({ taskId: proposal.taskId })).toMatchObject({ phase: 'verified', receipt: { status: 'verified' } })
    expect(medium.events.length).toBe(committed)
  })

  it('records domain judgments and settlements under their trusted apparatus roles', async () => {
    const { call, medium } = await mounted()
    const proposal = await call('propose').propose({ goal: 'g' })
    await call('submit').submit({ taskId: proposal.taskId, program: COUNTING })
    const actorOf = (kind: string) => factsOf(medium).find(fact => fact.kind === kind)?.actor
    expect([actorOf(TASK_KINDS.evidenceProduced), actorOf(TASK_KINDS.runVerified)]).toEqual(['lib-1:verifier:letters@1', 'lib-1:scheduler'])
  })

  it('isolates two concurrent tasks by their responsible callers and Run workspaces', async () => {
    const { call, surface } = await mounted()
    const mine = await call('propose').propose({ goal: 'g' })
    const otherAgent = agentFor('agent-8', 'session-10')
    const other = (id: string) => surface.forCall(execFor(otherAgent, id))
    const theirs = await other('propose').propose({ goal: 'g' })
    const answers = await Promise.all([
      call('submit').submit({ taskId: mine.taskId, program: COUNTING }),
      other('submit').submit({ taskId: theirs.taskId, program: COUNTING }),
    ])
    expect(answers.map(answer => answer.verdict)).toEqual(['pass', 'pass'])
    expect(mine.workspace).not.toBe(theirs.workspace)
  })

  it('refuses a foreign caller read and submission before committing or writing', async () => {
    const { call, surface, medium } = await mounted()
    const proposal = await call('propose').propose({ goal: 'g' })
    const other = surface.forCall(execFor(agentFor('agent-8', 'session-10'), 'foreign'))
    const committed = medium.events.length
    expect((await asyncRefusalOf(() => other.submit({ taskId: proposal.taskId, program: COUNTING }))).code).toBe('not-responsible')
    expect((await asyncRefusalOf(() => other.status({ taskId: proposal.taskId }))).code).toBe('not-responsible')
    expect(medium.events.length).toBe(committed)
    await expect(access(join(proposal.workspace, 'program.mjs'))).rejects.toThrow()
  })

  it('refuses agentless calls before they can submit facts', async () => {
    const { surface, medium } = await mounted()
    expect(refusalOf(() => surface.forCall({ callId: 'missing-agent' } as never)).code).toBe('unknown-emitter-role')
    expect(medium.events).toEqual([])
  })

  it('refuses an unknown task submission', async () => {
    const { call } = await mounted()
    expect((await asyncRefusalOf(() => call('submit').submit({ taskId: 'task-invented', program: COUNTING }))).code).toBe('illegal-transition')
  })

  it('retains the submitted program and produced artifact in the Run workspace', async () => {
    const { call } = await mounted()
    const proposal = await call('propose').propose({ goal: 'g' })
    await call('submit').submit({ taskId: proposal.taskId, program: COUNTING })
    expect(await readFile(join(proposal.workspace, 'report.txt'), 'utf8')).toBe('35')
    expect(await readFile(join(proposal.workspace, 'program.mjs'), 'utf8')).toBe(COUNTING)
  })
})

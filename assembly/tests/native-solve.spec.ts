import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createMessage, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, type SessionEvent, type SessionEventMap, type SessionEventType, type SessionId,
  type SurfaceEventType, type SurfaceIntent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

import { digestOf } from '../../src/protocol/envelope.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { MEASURE_KINDS, type ConstraintCheck, type TrialRecord } from '../../src/measure/protocol.ts'
import { recordedVerdictDigest, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { foldSubjects } from '../../src/protocol/fold.ts'
import { declareTaskProtocol } from '../../src/task/protocol.ts'
import { ProtocolRegistry } from '../../src/protocol/registry.ts'
import type { ControlEventData } from '../../src/control/session-store.ts'
import { loadDomain } from '../src/domain.ts'
import { openDriver, type TaskDriver } from '../src/driver.ts'
import type { Execution } from '../src/execution.ts'
import type { MethodAssets } from '../src/method.ts'
import { tokensOf } from '../src/native-solve.ts'
import { spawnProcess } from '../src/process.ts'
import { attachmentsAt, agentFor, execFor } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const counting = "import { readFileSync } from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))"
const resources: { driver: TaskDriver; context: Context; root: string }[] = []
afterEach(async () => {
  for (const { driver, context, root } of resources.splice(0)) {
    await driver.close()
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

/** Agent-loop ports are doubles; Task/Run execution, verifiers, attachments and JSONL are real. */
async function fixture(withUsage = true, tamperProgram = false) {
  const root = await mkdtemp(join(tmpdir(), 'singularity-native-solve-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const persistence = context.sessionPersistence
  const attachments = attachmentsAt(root)
  const parent = agentFor('parent', 'parent-session')
  const agents = new Map<string, Agent>([[String(parent.id), parent]])
  const handles = new Map<SessionId, SessionHandle>()
  const logs = new Map<SessionId, SessionEvent[]>()
  const sessions = new Map<SessionId, Session>()
  const delivered: UserMessage[] = []
  const disposed: string[] = []
  let driver!: TaskDriver
  async function append<T extends SessionEventType>(id: SessionId, type: T, data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [SurfaceIntent<T>] : []): Promise<SessionEvent<T>> {
    const events = logs.get(id)!
    const event = sessions.get(id)!.append(type, data, ...opts)
    await handles.get(id)!.append([event as SessionEvent])
    await handles.get(id)!.flush()
    events.push(event as SessionEvent)
    return event
  }
  const registry = {
    get: (id: string) => agents.get(id),
    create: async (options: CreateAgentOptions) => {
      const id = options.sessionId!
      handles.set(id, await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }))
      logs.set(id, [])
      sessions.set(id, Session.create(id))
      let pending = Promise.resolve()
      const agent = Object.assign(agentFor(id, id), {
        session: { id, get seq() { return logs.get(id)!.length }, requestHeader: () => parent.session.requestHeader() },
        followup: (message: UserMessage) => {
          delivered.push(message)
          pending = (async () => {
            await append(id, 'turn/start', { turn: 1 })
            await append(id, 'step/start', { turn: 1, step: 1 })
            const source = message.source as { kind: string; taskId: string; runId: string; operationId: string }
            expect(source.kind).toBe('singularity-method-solve')
            const skill = await driver.skill(String(agent.id))
            const system = createMessage({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: skill! }] })
            const observed = await append(id, 'system/message', { turn: 1, step: 1, message: system }, { surfaceOp: 'append' })
            await driver.observe(String(id), observed)
            await append(id, 'user/message', message, { surfaceOp: 'append' })
            const messageData = (step: number, totalTokens: number) => ({ turn: 1, step,
              message: createAssistantMessage({ source: { provider: 'test', model: 'model-under-test' }, content: [{ type: 'text', text: 'controlled agent port' }] }),
              stream: [], ...(withUsage ? { usage: { inputTokens: 2, outputTokens: 3, totalTokens } } : {}),
            })
            await append(id, 'assistant/message', messageData(1, 17), { surfaceOp: 'append' })
            const result = await driver.forCall(execFor(agent, 'run-method')).runMethod({ taskId: source.taskId })
            await append(id, 'step/end', { turn: 1, step: 1 })
            await append(id, 'step/start', { turn: 1, step: 2 })
            await append(id, 'assistant/message', messageData(2, 23), { surfaceOp: 'append' })
            await driver.forCall(execFor(agent, 'submit')).submit({ taskId: source.taskId,
              program: tamperProgram ? `${result.program}\n// altered by the agent loop port` : result.program })
            await append(id, 'step/end', { turn: 1, step: 2 })
            await append(id, 'step/start', { turn: 1, step: 3 })
            await append(id, 'assistant/message', messageData(3, 5), { surfaceOp: 'append' })
            await append(id, 'step/end', { turn: 1, step: 3 })
            await append(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
          })()
        },
        whenIdle: () => pending,
        cancel: () => undefined,
      }) as unknown as Agent
      agents.set(String(agent.id), agent)
      return { agent, dispose: async () => {
        await handles.get(id)!.close()
        handles.delete(id)
        agents.delete(String(agent.id))
        disposed.push(String(id))
      } }
    },
  } as unknown as AgentRegistry
  const services: Readonly<Record<string, unknown>> = { agents: registry, sessionPersistence: persistence,
    sessions: { flush: async () => true }, agentLoop: {}, agentPresets: { composeFrom: () => undefined } }
  const seams: ChildSessionSeams = { get: name => services[name] }
  const execution: Execution = {
    assertCaller: exec => exec.agent!, drain: async () => undefined, close: async () => undefined,
    sealTranscript: async exec => {
      const sessionId = exec.agent!.session.id
      const handle = await persistence.open(sessionId, 'read')
      try {
        const events = (await handle.read()).events
        return { sessionId: String(sessionId), eventCount: events.length, digest: digestOf({ sessionId, eventCount: events.length, events }) }
      } finally { await handle.close() }
    },
  }
  driver = await openDriver({ controlId: 'native-spec', workspaceRoot: root, domain: await loadDomain(domainDir, spawnProcess),
    persistence, attachments, seams, execution: () => execution })
  resources.push({ driver, context, root })
  const domain = JSON.parse(await readFile(join(domainDir, 'task.json'), 'utf8')) as { rootTemplate: string; templates: unknown[] }
  const assets: MethodAssets = { rootTemplate: domain.rootTemplate, templates: domain.templates,
    skill: 'Run this exact method, then submit its source.', tool: "process.stdout.write('0')" }
  const surface = driver.forCall(execFor(parent, 'evolve'))
  const incumbent = await surface.createMethod(assets)
  const good = await surface.createMethod({ ...assets, tool: counting })
  const bad = await surface.createMethod({ ...assets, skill: 'A distinct incorrect candidate.' })
  async function facts() {
    const session = (await persistence.list()).find(entry => String(entry.header.id).startsWith('singularity:control:'))!
    const handle = await persistence.open(session.header.id, 'read')
    try { return (await handle.read()).events.map(event => (event.data as ControlEventData).payload) }
    finally { await handle.close() }
  }
  return { surface, incumbent, good, bad, delivered, logs, disposed, attachments, facts }
}

it('sums exact native assistant totals and refuses absent usage or unknown totals', () => {
  const event = (usage?: TokenUsage) => ({ type: 'assistant/message', data: { ...(usage === undefined ? {} : { usage }) } }) as SessionEvent
  expect(tokensOf([event({ inputTokens: 2, outputTokens: 3, totalTokens: 17, cacheReadTokens: 12 }),
    event({ inputTokens: 5, outputTokens: 7, totalTokens: 23, cacheReadTokens: 11 })])).toBe(40)
  expect(() => tokensOf([])).toThrow('no native model messages')
  expect(() => tokensOf([event()])).toThrow('usage is unknown')
  expect(() => tokensOf([event({ inputTokens: 2, outputTokens: 3 })])).toThrow('usage is unknown')
})

it('binds independently verified sealed submissions to native transcript token costs and verdict citations', async () => {
  const h = await fixture()
  const decision = await h.surface.evolve({ roundId: 'round-1', round: 1, incumbent: h.incumbent, candidates: [h.good, h.bad], explorationSlots: 1 })
  expect(decision.winner).toBe(0)
  expect(decision.slots.map(slot => ({ quality: slot.quality, cost: slot.cost }))).toEqual([{ quality: 1, cost: 45 }, { quality: 0, cost: 45 }])
  expect(h.delivered).toHaveLength(5)
  expect(h.disposed).toHaveLength(5)
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  const facts = await h.facts()
  const tasks = foldSubjects<TaskState>(registry, facts, TASK_PROTOCOL, TASK_VERSION)
  const checks = facts.filter(fact => fact.kind === MEASURE_KINDS.constraintChecked)
  expect(checks).toHaveLength(5)
  for (const fact of checks) {
    const check = fact.payload as ConstraintCheck
    const opened = facts.find(entry => entry.subject === fact.subject && entry.kind === MEASURE_KINDS.evaluationOpened)!.payload as { run: { taskId: string; runId: string } }
    const task = tasks.get(opened.run.taskId)!
    const run = task.runs[opened.run.runId]!
    expect(check.verdict!.evidenceDigest).toBe(recordedVerdictDigest(task, 'native solve spec', {
      runId: run.runId, criterionId: check.verdict!.criterionId, artifactDigest: run.submission!.artifactDigest,
    }))
    expect(check.artifactDigest).toBe(run.submission!.artifactDigest)
    expect(check.implementationDigest).toBe(run.evidence[0]!.implementationDigest)
    const chunks: Uint8Array[] = []
    for await (const chunk of h.attachments.readFileStream(run.submission!.files.artifact)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe(check.met ? '35' : '0')
    expect(run.consumed.map(entry => entry.method)).toEqual(['template', 'skill', 'tool'])
    const source = run.submission!.source
    const events = h.logs.get(source.sessionId as SessionId)!
    expect(source.eventCount).toBeLessThan(events.length)
    const prefix = events.slice(0, source.eventCount)
    expect(source.digest).toBe(digestOf({ sessionId: source.sessionId, eventCount: source.eventCount, events: prefix }))
    const trial = facts.find(entry => entry.subject === fact.subject && entry.kind === MEASURE_KINDS.trialRecorded)!.payload as TrialRecord
    expect(trial.cost).toBe(tokensOf(events))
    expect(trial.artifactDigest).toBe(run.submission!.artifactDigest)
    expect(trial.inputDigests).toEqual(run.submission!.inputDigests)
    const dispatched = h.delivered.find(message => (message.source as { taskId: string }).taskId === task.taskId)!
    expect(dispatched.content.map(part => part.type === 'text' ? part.text : '').join('')).toContain(`Goal: ${task.contract!.goal}`)
  }
  expect(facts.filter(fact => fact.kind === TASK_KINDS.runStarted)).toHaveLength(5)
})

it('refuses unmeasurable native usage after sealing acceptance and releases its child session', async () => {
  const h = await fixture(false)
  await expect(h.surface.evolve({ roundId: 'round-1', round: 1, incumbent: h.incumbent, candidates: [h.good, h.bad], explorationSlots: 1 })).rejects.toThrow('usage is unknown')
  const facts = await h.facts()
  expect(facts.filter(fact => fact.kind === TASK_KINDS.runSubmitted)).toHaveLength(1)
  expect(facts.filter(fact => fact.kind === TASK_KINDS.evidenceProduced)).toHaveLength(1)
  expect((await h.surface.history()).decisions).toEqual([])
  expect(h.disposed).toHaveLength(1)
})

it('allows the solver to produce a different final program while consuming the frozen Method tool', async () => {
  const h = await fixture(true, true)
  const round = await h.surface.evolve({ roundId: 'round-1', round: 1, incumbent: h.incumbent, candidates: [h.good, h.bad], explorationSlots: 1 })
  expect(round.winner).toBe(0)
  expect((await h.surface.history()).decisions).toEqual([round])
  expect(h.disposed).toHaveLength(5)
})

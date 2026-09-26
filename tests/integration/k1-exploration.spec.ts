import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import { createScope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ROOT_PROPOSAL_TASK_ID, rootTaskStoreId, TaskService } from '../../task/src/index.ts'
import { canonicalize } from '../../task/src/contract.ts'
import { batchIdFor } from '../../task/src/proposal.ts'
import type { TaskEvent, TaskInstance, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  OTHER_TOOLS,
  ROOT_TOOLS,
  type ScriptedLoop,
  type ScriptEntry,
} from '../support/scripted-loop.ts'

/**
 * K1 acceptance: one parent that explores, then implements, then hands in its
 * own result.
 *
 * The whole point of the ticket is that this flow is *not* a special mode: it is
 * one parent run admitting more than one batch, with the runtime handing the
 * parent back its execution after each batch ends instead of judging it. So the
 * cases here drive the flow through the deployment's own surfaces — the real DSH
 * loop and the real singularity tools (`task_decompose`, `task_submit_result`,
 * `task_answer`) over the real store, the real batch driver and the real
 * verifier — and read every conclusion back from the store, the session log, or
 * the answer a real tool returned.
 *
 * Two fixtures, for two kinds of window:
 *
 * - {@link startScriptedLoop} (K1-1…K1-3, K1-5 and the loop-side cases of K1-4):
 *   a whole deployment whose model is scripted, with the store, gate, driver and
 *   verifier the deployment's own.
 * - a JSONL boot of this file's own (`bootOver` / `reopen`, the restart side of
 *   K1-4 and the last K1-5 case): the deployment's real `session-persistence-jsonl`
 *   over one directory, crashed and booted again, so "the batch ended but nobody
 *   was told" and "the batch's end was never persisted" are windows a case can
 *   actually stand in rather than assert about.
 *
 * Acceptance rows, and the case that is the evidence for each — every `describe`
 * block below is named for its row, and the case names say what they prove:
 *
 * - **K1-1** — `K1-1:…` › the main scenario (survey batch → implementation batch →
 *   the parent's own submission → the original parent verifier's verdict).
 * - **K1-2** — `K1-2:…` › four refusals: a second batch and an early submission
 *   while one runs; the same request key answered from the record and the re-keyed
 *   revision refused; an empty batch; a late approval.
 * - **K1-3** — `K1-3:…` › the accumulated `childIndex`, the maps that do not
 *   resolve, a failed member, and the parent's own failing independent criterion.
 * - **K1-4** — `K1-4:…` › a terminal run not woken, an open question outliving its
 *   batch, and the three restart windows (batch end not durable, handback durable
 *   with the wake refused, a replay in flight).
 * - **K1-5** — `K1-5:…` › the root budget across two batches in one process and
 *   across a restart. The regression evidence for A4's questions and the parent's
 *   own acceptance is the suite those cases live in
 *   (`a4-question-loop.spec.ts`, `a4-question-recovery.spec.ts`,
 *   `parent-acceptance.spec.ts`), which this file's run re-runs in full.
 */

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))

afterEach(async () => {
  await disposeScriptedLoops()
  for (const boot of live.splice(0)) {
    await Promise.race([boot.dispose(), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })])
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** One child spec carrying exactly the criteria a case is about. */
function child(objective: string, criteria: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { objective, acceptanceCriteria: criteria, ...extra }
}

/** A criterion a command settles — the plain shape every child in this file carries. */
function commandCriterion(criterionId: string, command = 'true'): Record<string, unknown> {
  return { criterionId, description: `${criterionId} holds`, command }
}

/** One batch's `task_decompose` arguments. */
function batch(reason: string, children: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { reason, children }
}

/** The root contract K1-1 runs under: the goal's own check, plus the conjunction over the run's members. */
function rootContract(objective = 'ship the release'): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [
      { criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' },
      { criterionId: 'root-members', description: 'every member of this run verified', mode: 'composite', mandatory: true },
    ],
  }
}

/** The member tasks one run has accumulated, in admission order — what `childIndex` names. */
async function membersOf(h: ScriptedLoop, storeId: string, runId: string): Promise<TaskInstance[]> {
  return await h.task.runMembersIn(storeId, runId)
}

/** One tool call this deployment dispatched, its answer waited for. */
async function answered(h: ScriptedLoop, name: string, ordinal = 0, sessionId: string = String(ROOT)): Promise<{ isError: boolean; text: string }> {
  await vi.waitFor(() => {
    expect(h.calls.filter(call => call.name === name && call.sessionId === sessionId && call.result !== undefined).length).toBeGreaterThan(ordinal)
  })
  const call = h.calls.filter(call => call.name === name && call.sessionId === sessionId)[ordinal]!
  return { isError: call.result!.isError, text: call.result!.text }
}

/** Wait for `count` workers to have been spawned, naming what the store holds when the wait expires. */
async function spawned(h: ScriptedLoop, count: number): Promise<void> {
  try {
    await vi.waitFor(() => expect(h.spawns).toHaveLength(count), { timeout: 20_000, interval: 25 })
  } catch (error) {
    const run = await h.runForSession(ROOT)
    throw new Error(`expected ${count} spawn(s), the root run is ${run.run.status}/${run.run.executionPhase ?? 'no phase'} (${String(error)})`)
  }
}

/** One `user/message` event of one identity on a session's log, as the session itself recorded it. */
function messageOf(h: ScriptedLoop, sessionId: string, messageId: string): { text: string; source: unknown } | undefined {
  const event = h.eventsOf(sessionId).find(candidate => candidate.type === 'user/message' && candidate.data.id === messageId)
  if (event === undefined) return undefined
  const message = event.data as unknown as { content: readonly { type: string; text?: string }[]; source: unknown }
  return { text: message.content.map(block => block.text ?? '').join('\n'), source: message.source }
}

/** Every message identity one session holds, in order — how a case counts deliveries without reading the runtime's memory. */
function messageIds(h: ScriptedLoop, sessionId: string): string[] {
  return h.eventsOf(sessionId).flatMap(event => (event.type === 'user/message' ? [String(event.data.id)] : []))
}

/** Every task event one store appended, read back off the loop's own session log. */
function taskEventsOf(h: ScriptedLoop, storeId: string): TaskEvent[] {
  return h.eventsOf(storeId).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/**
 * The **batch** admissions one store recorded. A store's own root contract is
 * admitted through the same event kind under the reserved envelope task id
 * ({@link ROOT_PROPOSAL_TASK_ID}), and every count here is about batches.
 */
function batchAdmissions(events: readonly TaskEvent[]): TaskEvent[] {
  return events.filter(event => event.kind === 'TaskProposalAdmitted' && event.taskId !== ROOT_PROPOSAL_TASK_ID)
}

/**
 * The batch id the store recorded for one run's `index`-th admitted batch —
 * history, not the run's *current* batch: `run.batchId` is cleared by the batch
 * end that hands the run back `active`, so a probe that races the handback reads
 * the identity from the run's accumulation instead.
 */
async function batchIdOf(h: ScriptedLoop, storeId: string, runId: string, index = 0): Promise<string> {
  let found = ''
  await vi.waitFor(async () => {
    const run = await h.task.runIn(storeId, runId)
    expect(run.batches?.length ?? 0).toBeGreaterThan(index)
    found = run.batches![index]!.batchId
  })
  return found
}

/**
 * One criterion's verdict on the judging run's own evidence — the store's record
 * of what the verifier decided, never the runtime's return value.
 */
async function verdictOf(h: ScriptedLoop, storeId: string, runId: string, criterionId: string): Promise<{ status: string; verifierId?: string; details?: string }> {
  const bundle = (await h.snapshot(storeId)).evidence.filter(item => item.taskRunId === runId)
  const verdict = bundle.flatMap(item => item.verifierResults).find(result => result.criterionId === criterionId)
  if (verdict === undefined) throw new Error(`run "${runId}" holds no verdict about "${criterionId}"`)
  return verdict
}

/**
 * Dispatch one tool call on behalf of a live agent, the way the loop does — the
 * door a case uses when the *gate* is the subject rather than the model's
 * decision to call: the answer (denial included) is the registry's own.
 */
async function dispatchAs(h: ScriptedLoop, sessionId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await h.ctx.tools.execute({
    callId: `k1-${sessionId}-${name}`,
    name,
    arguments: args,
    agent: h.agent(sessionId),
    signal: new AbortController().signal,
  })
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
  }
}

describe('K1-1: exploration, then implementation, then the parent hands in its own result', () => {
  it('carries one parent through an investigation batch and an implementation batch into its own acceptance', async () => {
    // The parent's script is the whole model of the flow: it delegates the
    // survey, waits for the batch end (the message that wakes it), delegates the
    // implementation against the survey's product, waits again, and then hands
    // its own result in. Nothing here is a runtime shortcut — every step is a
    // real tool call the loop dispatched.
    const surveyRead = Promise.withResolvers<void>()
    const implementationRead = Promise.withResolvers<void>()
    let productRef = ''
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          {
            tool: 'task_decompose',
            args: batch('survey the options before committing to one', [
              child('survey the options', [commandCriterion('survey-1')]),
            ]),
          },
          { text: 'root: the survey is running' },
          { waitFor: () => surveyRead.promise },
          {
            tool: 'task_decompose',
            args: () => batch('implement what the survey found', [
              child('implement the chosen option', [
                { ...commandCriterion('implement-1'), requiresArtifact: [productRef] },
              ]),
            ]),
          },
          { text: 'root: the implementation is running' },
          { waitFor: () => implementationRead.promise },
          { tool: 'task_submit_result', args: { summary: 'both rounds delivered, judged by the goal and the members' } },
          { text: 'root: handed in' },
        ]
        : [
          { tool: 'task_submit_result', args: { summary: 'the delegated work holds' } },
          { text: 'worker: handed in' },
        ],
    })
    // The conjunction is declared with the two members it rests on — one entry
    // per batch — so the verdict it reaches is a judgement *about both rounds*,
    // not a "some child verified" answer.
    const contract = rootContract()
    contract.acceptanceCriteria[1] = {
      ...contract.acceptanceCriteria[1]!,
      childEvidence: [{ childIndex: 0 }, { childIndex: 1 }],
    }
    const root = await h.begin(contract)
    const declared = (await h.task.taskIn(root.storeId, root.taskId)).acceptanceCriteria

    // ── the investigation batch ───────────────────────────────────────────────
    const firstAnswer = await answered(h, 'task_decompose', 0)
    expect(firstAnswer.isError).toBe(false)
    expect(firstAnswer.text).toContain('does not wait for the batch')
    await spawned(h, 1)
    const batchOne = await batchIdOf(h, root.storeId, root.runId)
    const outcomesOne = await h.runtime.awaitBatch(root.storeId, batchOne)
    expect(outcomesOne.map(outcome => outcome.status)).toEqual(['verified'])

    // The batch end hands the parent back its execution and judges nothing: the
    // run is `active`, unsubmitted, and the task is not settled.
    const handedBack = await h.task.runIn(root.storeId, root.runId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.submission).toBeUndefined()
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('running')

    // ── the implementation batch, admitted against the survey's product ───────
    // The product the survey left is the reference the implementation's criterion
    // names: the parent reads it off the store (the same identity the batch-end
    // message carries) and the next delegation is declared against it.
    const surveyEvidence = (await h.snapshot(root.storeId)).evidence.find(item => item.taskId === outcomesOne[0]!.taskId)!
    productRef = surveyEvidence.evidenceId
    surveyRead.resolve()

    // The parent was *told*: the batch-end message reached its loop, and the next
    // request the loop assembled carries it — the member's terminal state, its
    // evidence, and the fact that nothing was submitted on the parent's behalf.
    const endOfFirst = `m-batchend-${batchOne}`
    const secondAnswer = await answered(h, 'task_decompose', 1)
    expect(secondAnswer.isError).toBe(false)
    await vi.waitFor(() => expect(h.requestsOf(String(ROOT)).some(request => request.texts.join('\n').includes(`[task-batch-end ${batchOne}]`))).toBe(true))
    const told = h.requestsOf(String(ROOT)).find(request => request.texts.join('\n').includes(`[task-batch-end ${batchOne}]`))!
    expect(told.texts.join('\n')).toContain('nothing was submitted on your behalf')
    expect(told.texts.join('\n')).toContain(`evidence ${surveyEvidence.evidenceId}`)
    // One delivery, claimed once into the session's own history.
    expect(messageIds(h, String(ROOT)).filter(id => id === endOfFirst)).toHaveLength(1)

    await spawned(h, 2)
    const batchTwo = await batchIdOf(h, root.storeId, root.runId, 1)
    expect(batchTwo).not.toBe(batchOne)
    expect(batchTwo).toBe(batchIdFor(root.runId, (await h.task.runIn(root.storeId, root.runId)).batches![1]!.proposalId))
    const outcomesTwo = await h.runtime.awaitBatch(root.storeId, batchTwo)
    // The reference was satisfied by the survey's verified run: the child ran
    // rather than being blocked on the artifact, and no obligation was raised.
    expect(outcomesTwo.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.snapshot(root.storeId)).obligations).toEqual([])

    // The run accumulates both batches' members, in admission order, without
    // renumbering the first batch's.
    const run = await h.task.runIn(root.storeId, root.runId)
    expect(run.batches!.map(entry => entry.batchId)).toEqual([batchOne, batchTwo])
    expect(run.batches!.map(entry => entry.memberTaskIds)).toEqual([
      [outcomesOne[0]!.taskId],
      [outcomesTwo[0]!.taskId],
    ])
    expect((await membersOf(h, root.storeId, root.runId)).map(task => task.taskId))
      .toEqual([outcomesOne[0]!.taskId, outcomesTwo[0]!.taskId])

    // The second batch ended the same way: handed back, told, still unsettled.
    const handedBackAgain = await h.task.runIn(root.storeId, root.runId)
    expect(handedBackAgain.executionPhase).toBe('active')
    expect(handedBackAgain.submission).toBeUndefined()
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('running')
    await vi.waitFor(() => expect(messageOf(h, String(ROOT), `m-batchend-${batchTwo}`)).toBeDefined())

    // ── the parent synthesises and hands in its own result ────────────────────
    implementationRead.resolve()
    const submitted = await answered(h, 'task_submit_result', 0)
    expect(submitted.isError).toBe(false)
    expect(submitted.text).toContain('task_submit_result verified')
    const rootRun = await h.task.runIn(root.storeId, root.runId)
    expect(rootRun.executionPhase).toBe('submitted')
    expect(rootRun.submission).toMatchObject({ origin: 'worker', summary: 'both rounds delivered, judged by the goal and the members' })
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')

    // The verdict is the real composite verifier's, over the run's accumulated
    // members — both of them, from two different batches.
    const rootVerdicts = (await h.snapshot(root.storeId)).evidence
      .filter(item => item.taskRunId === root.runId)
      .flatMap(item => item.verifierResults)
    expect(rootVerdicts.find(result => result.criterionId === 'root-goal')).toMatchObject({ status: 'pass', verifierId: 'command' })
    const members = rootVerdicts.find(result => result.criterionId === 'root-members')!
    expect(members).toMatchObject({ status: 'pass', verifierId: 'composite' })
    // Both entries resolved — to the member each position names, in the batch it
    // was admitted in.
    expect(members.details).toContain(`child #0 (${outcomesOne[0]!.taskId}) verified`)
    expect(members.details).toContain(`child #1 (${outcomesTwo[0]!.taskId}) verified`)

    // The root's own acceptance criteria are the ones it was admitted with: the
    // batches changed what the run had done, never what it is judged by.
    expect(canonicalize((await h.task.taskIn(root.storeId, root.taskId)).acceptanceCriteria)).toBe(canonicalize(declared))

    // No diagnosis and no evolution tool was reached anywhere in the flow: the
    // work is the two batches' own.
    expect(h.calls.filter(call => call.name === 'task_diagnose' || call.name.startsWith('evolution_'))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The restart fixture: a deployment over the real JSONL session log, crashed and
// booted again over the same directory (K1 §5's windows).
// ─────────────────────────────────────────────────────────────────────────────

/** One batch-end message the runtime stated through the relay (K1 §2). */
interface RelayIntent {
  readonly messageId: string
  readonly targetSessionId: string
  readonly text: string
}

interface ReopenOptions {
  /** What one worker body does when its turn runs: returning hands the run in, never returning parks the driver. */
  readonly worker?: (sessionId: string) => Promise<void> | void
  /**
   * How one batch-end delivery is answered. `refused` is a deployment whose relay
   * cannot reach the Session — the window between "the batch ended and the run is
   * active again" and "the parent was told". Defaults to `delivered`.
   */
  readonly relayAnswer?: (intent: RelayIntent, index: number) => 'delivered' | 'refused'
  readonly rootBudget?: Readonly<{ maxRuns?: number }>
}

interface ReopenBoot {
  readonly ctx: Context
  readonly task: TaskService
  readonly runtime: TaskRuntime
  /** Every worker session this boot spawned, in order. */
  readonly spawns: string[]
  /** Every batch-end message this boot delivered, in order. */
  readonly relayed: RelayIntent[]
  snapshot(storeId?: string): Promise<TaskSnapshot>
  events(storeId?: string): Promise<readonly SessionEvent[]>
  /** Simulate process death: the durability barrier, then every handle this boot opened is closed. */
  crash(): Promise<void>
  dispose(): Promise<void>
}

/** The boots and directories a spec must clean up, whichever case left them behind. */
const live: ReopenBoot[] = []
const directories: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-k1-'))
  directories.push(dir)
  return dir
}

/**
 * Boot one deployment over one directory: the real JSONL session log, the real
 * store, gate, batch driver and verifier. The model loop is the one thing
 * replaced (a stub agent whose `whenIdle` runs the scripted body and then hands
 * the run in), and the relay is replaced so a case can decide whether a batch-end
 * message reaches its Session at all.
 */
async function bootOver(dir: string, options: ReopenOptions = {}): Promise<ReopenBoot> {
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
  const ctx = new Context()
  const persistence = new JsonlSessionPersistence(ctx, { root: dir, compression: 'none' })
  // Every handle the store takes, so `crash()` closes exactly what a dying
  // process's descriptors would release.
  const handles: { close: () => Promise<void> }[] = []
  const backend = persistence as unknown as {
    create: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    flush: () => Promise<void>
  }
  const originalCreate = backend.create.bind(persistence)
  const originalOpen = backend.open.bind(persistence)
  backend.create = async (...args: never[]) => {
    const handle = await originalCreate(...args)
    handles.push(handle)
    return handle
  }
  backend.open = async (...args: never[]) => {
    const handle = await originalOpen(...args)
    handles.push(handle)
    return handle
  }

  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry, {})

  const ranTools: string[] = []
  for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
    ctx.tools.register({
      name,
      description: `tool ${name}`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
      execute: async () => {
        ranTools.push(name)
        return `${name}: fixture answer`
      },
    })
  }
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
  ctx.provide('layout', { setIn: async () => {} })
  const graphState = {
    version: 1,
    id: 'g1',
    roots: [String(ROOT)],
    agents: [] as { id: string; name: string; status: string }[],
    groups: [] as unknown[],
    edges: [] as unknown[],
  }
  ctx.provide('graph', {
    snapshotIn: async () => structuredClone(graphState),
    commitIn: async (_storeId: string, events: readonly { kind: string; agent?: { id: string; name: string; status: string }; edge?: unknown }[]) => {
      for (const event of events) {
        if (event.kind === 'agent/add' && event.agent !== undefined) graphState.agents.push(event.agent)
        if (event.kind === 'edge/add' && event.edge !== undefined) graphState.edges.push(event.edge)
      }
    },
    setStatusIn: async () => {},
    addAgentIn: async (_storeId: string, agent: { id: string; name: string; status: string }) => { graphState.agents.push(agent) },
  } as never)
  ctx.provide('graphs', {
    graphForSession: async () => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: String(ROOT),
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    }),
    list: async () => [{
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: String(ROOT),
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    }],
    members: () => [String(ROOT), ...graphState.agents.map(agent => String(agent.id))],
  } as never)

  /** One read handle over the real JSONL log — what `events()` and the session plane below read. */
  const readLog = async (sessionId: string): Promise<readonly SessionEvent[]> => {
    const handle = await (persistence as unknown as {
      open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
    }).open(SessionId(sessionId), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }
  ctx.provide('sessionQuery', {
    readSurface: async (sessionId: string) => ({ capturedThroughSeq: (await readLog(sessionId)).at(-1)?.seq ?? null }),
    readEvent: async (request: { sessionId: string; seq: number; before?: number; after?: number }) => {
      const events = await readLog(String(request.sessionId))
      const target = events.find(event => event.seq === request.seq)
      if (target === undefined) throw new Error(`session "${String(request.sessionId)}" has no event at seq ${request.seq}`)
      const start = Math.max(0, request.seq - (request.before ?? 0))
      const end = Math.min(events.length - 1, request.seq + (request.after ?? 0))
      return { target, events: events.slice(start, end + 1), startSeq: start, endSeq: end }
    },
  } as never)

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: join(dir, 'evidence') })
  await verifier.ready()
  const spawns: string[] = []
  const agentRuntime = new AgentRuntime(ctx)
  const relayed: RelayIntent[] = []
  // The identities this boot's Sessions already hold — the stand-in for the fold
  // the real relay reads out of the target's log, so a second delivery of one
  // message is answered `already-present` instead of stated twice.
  const accepted = new Set<string>()
  let relayCalls = 0
  const relay = agentRuntime as unknown as {
    ensureAgentMessageDelivered?: (intent: { messageId: string; targetSessionId: string; text: string }) => Promise<{ status: string }>
  }
  relay.ensureAgentMessageDelivered = async intent => {
    const record: RelayIntent = {
      messageId: String(intent.messageId),
      targetSessionId: String(intent.targetSessionId),
      text: String(intent.text),
    }
    if (accepted.has(record.messageId)) return { status: 'already-present' }
    const answer = options.relayAnswer?.(record, relayCalls++) ?? 'delivered'
    if (answer === 'refused') return { status: 'refused' }
    relayed.push(record)
    accepted.add(record.messageId)
    return { status: 'delivered' }
  }

  await ctx.plugin(TaskRuntime, {
    capabilities: {},
    ...(options.rootBudget === undefined ? {} : { rootBudget: { ...options.rootBudget } }),
    runBindingRoot: join(home, 'run-bindings'),
  } as Config)
  const runtime = ctx.get('taskRuntime') as TaskRuntime

  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, opts: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(opts.sessionId, opts.setup), dispose: async () => {} }),
    resume: async (_ownerCtx: Context, opts: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(opts.resumeSessionId, opts.setup), dispose: async () => {} }),
  } as never)

  /** Hand one stub agent to the runtime: the scope, the setup hook, and the idle body. */
  async function mint(sessionId: SessionId, setup?: (agentCtx: Context, agent: Agent) => Promise<unknown>): Promise<Agent> {
    let self!: Agent
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: vi.fn(),
      cancel: vi.fn(),
      append: vi.fn(),
      // A body that returns without submitting leaves the run `active` where a
      // submission was due; a body that never returns parks the driver with the
      // child in flight, which is the state a killed process leaves behind.
      whenIdle: async () => { await runWorkerTurn(String(sessionId)) },
      session: { id: String(sessionId), header: { id: String(sessionId), cwd: dir, agentPreset: 'standard' }, append: vi.fn() },
    } as unknown as Agent
    self = agent
    let scope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    await (ctx.agents.register(agent) as unknown as Promise<void>)
    return agent
  }

  /**
   * The idle body: the scripted worker, then the submission a live worker owes.
   * A body that decomposed leaves its run `waiting_children`, and a parent may
   * not submit while its children run — so the fixture waits for the batch it
   * opened to end (the handback a live worker's next turn reads) and hands the
   * result in then.
   */
  async function runWorkerTurn(sessionId: string): Promise<void> {
    await options.worker?.(sessionId)
    const bound = await runtime.runForSession(sessionId).catch(() => undefined)
    if (bound === undefined) return
    if (bound.run.status === 'running' && bound.run.executionPhase === 'waiting_children' && bound.run.batchId !== undefined) {
      await runtime.awaitBatch(bound.storeId, bound.run.batchId)
    }
    const current = await runtime.runForSession(sessionId).catch(() => undefined)
    if (current === undefined || current.run.status !== 'running' || current.run.executionPhase !== 'active') return
    await runtime.submitResult(sessionId, { summary: 'recovery fixture worker finished' })
  }

  const originalSpawn = agentRuntime.spawn.bind(agentRuntime)
  agentRuntime.spawn = async (parent: Agent, request: SpawnRequest) => {
    spawns.push(String(request.sessionId))
    return await originalSpawn(parent, request)
  }
  await agentRuntime.createRoot({ sessionId: SessionId(String(ROOT)), scope: { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }, cwd: dir })

  /** The person's request on the root session's durable log — what a root contract's origin is read from (A0 §1.10). */
  async function recordPersonRequest(): Promise<void> {
    const handle = await openRootLog()
    try {
      const { events } = await handle.read(0)
      if (events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
      await handle.append([personRequest('ship the release', events.length)])
      await backend.flush()
    } finally {
      await handle.close()
    }
  }

  async function openRootLog(): Promise<Awaited<ReturnType<typeof persistence.open>>> {
    try {
      return await persistence.open(SessionId(String(ROOT)), 'write')
    } catch (error) {
      if (!(error instanceof Error) || !/not found/.test(error.message)) throw error
      return await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId(String(ROOT)),
        createdAt: Date.now(),
        isSeeded: false,
        cwd: dir,
        agentPreset: 'standard',
      } as unknown as SessionHeader)
    }
  }
  await recordPersonRequest()

  const boot: ReopenBoot = {
    ctx,
    task,
    runtime,
    spawns,
    relayed,
    snapshot: async (storeId = STORE) => await task.snapshotIn(storeId),
    events: async (storeId = STORE) => await readLog(String(storeId)),
    crash: async () => {
      const index = live.indexOf(boot)
      if (index >= 0) live.splice(index, 1)
      await backend.flush()
      for (const handle of handles.splice(0)) await handle.close()
    },
    dispose: async () => {
      const index = live.indexOf(boot)
      if (index >= 0) live.splice(index, 1)
      await ctx.fiber.dispose()
    },
  }
  live.push(boot)
  return boot
}

/**
 * Boot again over the same directory and adopt the store the way the deployment
 * does: the activation's recovery barrier (`adoptRoot`), which is what runs the
 * recovery pass over the facts the crashed process left.
 */
async function reopen(dir: string, options: ReopenOptions = {}): Promise<ReopenBoot> {
  const next = await bootOver(dir, options)
  await next.runtime.adoptRoot(STORE, String(ROOT))
  return next
}

/** Every task event one store logged, as the JSONL reader holds it. */
function taskEvents(events: readonly SessionEvent[]): TaskEvent[] {
  return events.flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** The run one task holds, or a failure naming the task. */
function runOf(snapshot: TaskSnapshot, taskId: string): TaskSnapshot['runs'][number] {
  const run = snapshot.runs.find(candidate => candidate.taskId === taskId)
  if (run === undefined) throw new Error(`the store holds no run for task "${taskId}"`)
  return run
}

/** The root task one store holds, activated through the real intake. */
async function activateRoot(boot: ReopenBoot): Promise<{ taskId: string; runId: string }> {
  const activated = await boot.runtime.intakeRootContract(STORE, String(ROOT), rootContract())
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { taskId: activated.taskId, runId: activated.runId }
}

/** One admitted batch driven to its end, read back from the store. */
async function runBatch(boot: ReopenBoot, objective: string, criterionId = 'child-1'): Promise<{ batchId: string; childTaskIds: string[]; outcomes: readonly { status: string }[] }> {
  const { taskId, runId } = await rootOf(boot)
  const admitted = await boot.runtime.decomposeAndRun(STORE, taskId, runId, String(ROOT), {
    reason: `delegate ${objective}`,
    children: [child(objective, [commandCriterion(criterionId)])],
  } as unknown as DecomposeSpec)
  if (admitted.status !== 'admitted') throw new Error(`the batch was not admitted: ${admitted.detail}`)
  const outcomes = await boot.runtime.awaitBatch(STORE, admitted.batchId)
  return { batchId: admitted.batchId, childTaskIds: [...admitted.childTaskIds], outcomes }
}

/** The store's own root task and run — what every batch in these cases belongs to. */
async function rootOf(boot: ReopenBoot): Promise<{ taskId: string; runId: string }> {
  const snapshot = await boot.snapshot()
  const task = snapshot.tasks.find(candidate => candidate.parentTaskId === undefined)
  if (task === undefined) throw new Error('the store holds no root task')
  const run = runOf(snapshot, task.taskId)
  return { taskId: task.taskId, runId: run.runId }
}

/**
 * One terminal champion written straight through the store — the record a replay
 * descends from, so the replay's subject is the historical shape rather than a
 * fixture invention.
 */
async function writeChampion(boot: ReopenBoot): Promise<{ taskId: string; runId: string }> {
  const taskId = 't-champion'
  const runId = 'r-champion'
  await boot.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'champion work',
    depth: 0,
    acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, String(ROOT))
  await boot.task.admitTaskIn(STORE, taskId, String(ROOT), { decompositionStatus: 'leaf' })
  await boot.task.startRunIn(STORE, {
    runId,
    taskId,
    sessionId: 's-champion',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, String(ROOT))
  await boot.task.markRunStatusIn(STORE, taskId, runId, 'verifying', String(ROOT))
  await boot.task.recordEvidenceIn(STORE, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'command' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, String(ROOT))
  await boot.task.markRunStatusIn(STORE, taskId, runId, 'verified', String(ROOT))
  return { taskId, runId }
}

describe('K1-2: one batch at a time, one proposal at a time, and a request answered rather than repeated', () => {
  it('refuses a second batch, an early submission and a re-keyed revision while the first batch runs', async () => {
    const release = Promise.withResolvers<void>()
    const waited = Promise.withResolvers<void>()
    const survey = batch('survey the options', [child('survey the options', [commandCriterion('survey-1')])])
    const implementation = batch('a second batch while the first runs', [child('implement the option', [commandCriterion('implement-1')])])
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: { ...survey, requestKey: 'k-survey' } },
          // While the children run: the same tools the parent used a moment ago
          // are closed to it, by the phase the admission put it in.
          { tool: 'task_decompose', args: implementation },
          { tool: 'task_submit_result', args: { summary: 'too early: the children still run' } },
          { text: 'root: the survey is running' },
          { waitFor: () => waited.promise },
          // The next two entries run in the turn the batch-end message wakes: the
          // record is what answers the first, and the second never takes it over.
          { tool: 'task_decompose', args: { ...survey, requestKey: 'k-survey' } },
          { tool: 'task_decompose', args: { ...implementation, requestKey: 'k-survey' } },
          { text: 'root: done probing' },
        ]
        : [
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'the survey holds' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(rootContract())

    // The first batch: admitted, and its child is in flight for as long as the
    // probes below take.
    const first = await answered(h, 'task_decompose', 0)
    expect(first.isError).toBe(false)
    await spawned(h, 1)
    const batchOne = await batchIdOf(h, root.storeId, root.runId)
    expect(first.text).toContain(`batch ${batchOne}`)

    // (1) While the children run, the run is in no state to decide anything.
    // Through the tool surface the phase closes both entries…
    const secondTool = await answered(h, 'task_decompose', 1)
    expect(secondTool.isError).toBe(true)
    expect(secondTool.text).toContain('waiting_children')
    expect(secondTool.text).toContain('"task_decompose" is denied')
    const earlyTool = await answered(h, 'task_submit_result', 0)
    expect(earlyTool.isError).toBe(true)
    expect(earlyTool.text).toContain('waiting_children')
    expect(earlyTool.text).toContain('"task_submit_result" is denied')
    // …and the runtime refuses the same two entries by name when they are called
    // directly, which is the rule beneath the tool surface.
    await expect(h.runtime.submitResult(ROOT, { summary: 'too early' })).rejects.toThrow(/waiting on its child batch/)
    await expect(h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, implementation as unknown as DecomposeSpec))
      .rejects.toThrow(/is in phase "waiting_children"/)
    expect((await h.task.runIn(root.storeId, root.runId)).submission).toBeUndefined()

    // The batch ends on its own schedule: the child verified, the run is active
    // again, and nothing was submitted on its behalf.
    release.resolve()
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchOne)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.task.runIn(root.storeId, root.runId)).executionPhase).toBe('active')
    waited.resolve()

    // (2) The same request key with the same content is answered from the record:
    // the same batch, no second admission, no second child, no second spawn.
    const repeat = await answered(h, 'task_decompose', 2)
    expect(repeat.text).toContain(`batch ${batchOne}`)
    expect(repeat.isError).toBe(false)
    expect((await h.snapshot(root.storeId)).tasks.filter(task => task.parentTaskId !== undefined)).toHaveLength(1)

    // (3) The same key with other content is refused by name: a revision is new
    // content under a new key, and it never takes over the stored request.
    const revision = await answered(h, 'task_decompose', 3)
    expect(revision.isError).toBe(false)
    expect(revision.text).toContain('task_decompose rejected')
    expect(revision.text).toContain('is already bound to proposal')
    expect(revision.text).toContain('a revision is new content under a new key')

    // Nothing any probe said changed the store: one child, one run of it, one
    // worker, one admission — and nobody was asked anything (policy off).
    const probed = await h.snapshot(root.storeId)
    expect(probed.tasks).toHaveLength(2)
    expect(probed.runs).toHaveLength(2)
    expect(h.spawns).toHaveLength(1)
    expect(probed.proposals!.all.filter(proposal => proposal.kind !== 'root')).toHaveLength(1)
    expect(batchAdmissions(taskEventsOf(h, root.storeId))).toHaveLength(1)
    expect(h.review.asks).toHaveLength(0)

    // The parent's own submission is admitted exactly once from here.
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'the survey was worth it' })
    expect(submitted.status).toBe('verified')
    const after = await h.snapshot(root.storeId)
    expect(after.evidence.filter(item => item.taskRunId === root.runId)).toHaveLength(1)
    expect(after.reviews.filter(item => item.taskId === root.taskId)).toHaveLength(1)
  })

  it('refuses an empty batch with nothing written anywhere', async () => {
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'delegate the work to nobody', children: [] } },
          { text: 'root: the empty batch was refused' },
        ]
        : [],
    })
    const root = await h.begin(rootContract())
    const before = await h.snapshot(root.storeId)

    const refused = await answered(h, 'task_decompose', 0)
    expect(refused.text).toContain('task_decompose rejected')
    expect(refused.text).toContain('at least one child')

    const after = await h.snapshot(root.storeId)
    expect(after.tasks.map(task => task.taskId)).toEqual(before.tasks.map(task => task.taskId))
    expect(after.runs.map(run => run.runId)).toEqual(before.runs.map(run => run.runId))
    expect(after.proposals?.all.filter(proposal => proposal.kind !== 'root')).toEqual([])
    expect(h.spawns).toEqual([])
    expect(h.review.asks).toEqual([])
    expect(taskEventsOf(h, root.storeId).filter(event => event.kind === 'TaskDecomposed')).toEqual([])
    // The run is still the run that may decide its own work: a refusal is not a
    // phase change.
    expect((await h.task.runIn(root.storeId, root.runId)).executionPhase).toBe('active')
  })

  it('records a late approval as expired when the run handed its result in before the person decided', async () => {
    const handedIn = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: batch('survey the options', [child('survey the options', [commandCriterion('survey-1')])]) },
          { waitFor: () => handedIn.promise },
          { text: 'root: this run is done either way' },
        ]
        : [],
    })
    const root = await h.begin(rootContract())
    const pending = await answered(h, 'task_decompose', 0)
    expect(pending.isError).toBe(false)
    expect(pending.text).toContain('waiting for a review')
    const proposalId = /proposal (p-[0-9a-f]{64})/.exec(pending.text)![1]!
    expect(h.review.batchAsks).toHaveLength(1)

    // The run hands its own result in while the person still has the batch: it
    // leaves the phase an approval could still dispatch from. With no member
    // admitted, its own conjunction finds nothing to rest on — what this case is
    // about is that the run's acceptance already ran, not what it decided.
    const settled = await h.runtime.submitResult(ROOT, { summary: 'the run did not wait for the review' })
    expect(settled.status).toBe('failed')
    handedIn.resolve()

    // The person approves — and the approval is too late to dispatch anything.
    h.review.answerBatch(0, 'allowed-once')
    await vi.waitFor(async () => {
      expect((await h.runtime.proposalIn(root.storeId, proposalId)).status).toBe('expired')
    })
    const expired = await h.runtime.proposalIn(root.storeId, proposalId)
    expect(expired.decision?.outcome).toBe('expired')
    expect(expired.decision?.reason).toContain('the approval arrived after the batch could be dispatched')
    // The reason names what ended the run: the submission this case made.
    expect(expired.decision?.reason).toContain('is failed')
    expect(expired.consumption).toBeUndefined()

    // Nothing was admitted, nobody was spawned, and the verdict the run already
    // earned stands — a late approval is not a second acceptance.
    const after = await h.snapshot(root.storeId)
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(h.spawns).toEqual([])
    expect(batchAdmissions(taskEventsOf(h, root.storeId))).toEqual([])
    expect(after.evidence.filter(item => item.taskRunId === root.runId)).toHaveLength(1)
    expect(after.reviews.filter(item => item.taskId === root.taskId)).toHaveLength(1)
  })
})

describe('K1-3: the evidence a parent rests on is the run\'s accumulated membership', () => {
  /**
   * One loop that admits two batches of two children each and hands the parent's
   * result in. The criteria the parent is judged by are the case's own, so the
   * same flow serves the positive map and every failing map.
   */
  async function twoBatches(criteria: Record<string, unknown>[], options: { failFirstChild?: boolean } = {}): Promise<{
    h: ScriptedLoop
    root: { storeId: string; taskId: string; runId: string }
    members: string[]
    batches: string[]
  }> {
    const afterFirst = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          {
            tool: 'task_decompose',
            args: batch('survey the options', [
              child('survey the first option', [commandCriterion('survey-1', options.failFirstChild === true ? 'false' : 'true')]),
              child('survey the second option', [commandCriterion('survey-2')]),
            ]),
          },
          { text: 'root: the survey is running' },
          { waitFor: () => afterFirst.promise },
          {
            tool: 'task_decompose',
            args: batch('implement what the survey found', [
              child('implement the first option', [commandCriterion('implement-1')]),
              child('implement the second option', [commandCriterion('implement-2')]),
            ]),
          },
          { text: 'root: the implementation is running' },
          { tool: 'task_submit_result', args: { summary: 'both rounds are on the record' } },
          { text: 'root: handed in' },
        ]
        : [
          { tool: 'task_submit_result', args: { summary: 'the delegated work holds' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin({ objective: 'ship the release', acceptanceCriteria: criteria as never })
    await answered(h, 'task_decompose', 0)
    await spawned(h, 2)
    const firstBatch = await batchIdOf(h, root.storeId, root.runId)
    await h.runtime.awaitBatch(root.storeId, firstBatch)
    afterFirst.resolve()
    await answered(h, 'task_decompose', 1)
    await spawned(h, 4)
    const secondBatch = await batchIdOf(h, root.storeId, root.runId, 1)
    await h.runtime.awaitBatch(root.storeId, secondBatch)
    const members = (await membersOf(h, root.storeId, root.runId)).map(task => task.taskId)
    expect(members).toHaveLength(4)
    return { h, root, members, batches: [firstBatch, secondBatch] }
  }

  it('resolves every map entry against the run\'s accumulated position, across two batches', async () => {
    // The two batches each carry a local member #0; the run's positions are 0–3,
    // so a map that names criterion `implement-1` at position 2 is the proof that
    // positions are the run's, not a batch's.
    const { h, root, members } = await twoBatches([
      { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
      {
        criterionId: 'root-members',
        description: 'each round delivered what the root goal rests on',
        mode: 'composite',
        mandatory: true,
        childEvidence: [
          { childIndex: 0, criterionId: 'survey-1' },
          { childIndex: 1, criterionId: 'survey-2' },
          { childIndex: 2, criterionId: 'implement-1' },
          { childIndex: 3, criterionId: 'implement-2' },
        ],
      },
    ])
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'both rounds consulted' })
    expect(submitted.status).toBe('verified')
    const verdict = await verdictOf(h, root.storeId, root.runId, 'root-members')
    expect(verdict).toMatchObject({ status: 'pass', verifierId: 'composite' })
    // Each position resolved to the member that really sits there — the two
    // batches' local firsts are at 0 and 2, and they are different tasks.
    expect(verdict.details).toContain(`child #0 (${members[0]})`)
    expect(verdict.details).toContain(`child #1 (${members[1]})`)
    expect(verdict.details).toContain(`child #2 (${members[2]})`)
    expect(verdict.details).toContain(`child #3 (${members[3]})`)
  })

  it('refuses a map that reads a batch-local position or names a member this run never admitted', async () => {
    const { h, root } = await twoBatches([
      { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
      {
        criterionId: 'map-batch-local',
        description: 'the second batch\'s first member, read as if positions restarted',
        mode: 'composite',
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'implement-1' }],
      },
      {
        criterionId: 'map-absent-member',
        description: 'a member this run never admitted',
        mode: 'composite',
        mandatory: true,
        childEvidence: [{ childIndex: 4, criterionId: 'survey-1' }],
      },
    ])
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'the maps are judged as declared' })
    expect(submitted.status).toBe('failed')

    const local = await verdictOf(h, root.storeId, root.runId, 'map-batch-local')
    expect(local.status).toBe('fail')
    expect(local.details).toContain('child #0')
    expect(local.details).toContain('has no criterion "implement-1"')

    const absent = await verdictOf(h, root.storeId, root.runId, 'map-absent-member')
    expect(absent.status).toBe('fail')
    expect(absent.details).toContain('child #4 does not exist')
    expect(absent.details).toContain('the run\'s batches have admitted 4 members')
  })

  it('refuses a map whose entries name records that are not that member\'s', async () => {
    // `twoBatches` is one store's own tree, so the records these entries name are
    // real records of this deployment — the delegating task's own criterion, and a
    // criterion no task declares. Neither can stand for the member a position
    // names: a map is judged against the judged run's members, and no other
    // record substitutes for one. (Cross-*graph* record refusals are asserted by
    // name in `context-assembly.spec.ts` and by the verifier's own unit cases.)
    const { h, root, members } = await twoBatches([
      { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
      {
        criterionId: 'map-delegator-criterion',
        description: 'the delegating task\'s own criterion, read as if it were the member\'s',
        mode: 'composite',
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'root-goal' }],
      },
      {
        criterionId: 'map-undeclared',
        description: 'a criterion no task in this tree declares',
        mode: 'composite',
        mandatory: true,
        childEvidence: [{ childIndex: 1, criterionId: 'not-declared-anywhere' }],
      },
    ])
    expect(members[0]).toBeDefined()
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'the map is judged against this run' })
    expect(submitted.status).toBe('failed')

    const delegator = await verdictOf(h, root.storeId, root.runId, 'map-delegator-criterion')
    expect(delegator.status).toBe('fail')
    expect(delegator.details).toContain(`child #0 (${members[0]})`)
    expect(delegator.details).toContain('has no criterion "root-goal"')

    const undeclared = await verdictOf(h, root.storeId, root.runId, 'map-undeclared')
    expect(undeclared.status).toBe('fail')
    expect(undeclared.details).toContain('has no criterion "not-declared-anywhere"')
  })

  it('refuses a map that names a member whose own run failed', async () => {
    const { h, root, members } = await twoBatches([
      { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
      {
        criterionId: 'root-members',
        description: 'the first round\'s member carried the result',
        mode: 'composite',
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'survey-1' }],
      },
    ], { failFirstChild: true })
    // The parent could still delegate again after a batch whose member failed:
    // the failed member stays where it is, and the later batch appends.
    expect(members).toHaveLength(4)
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'the first round did not hold' })
    expect(submitted.status).toBe('failed')
    const verdict = await verdictOf(h, root.storeId, root.runId, 'root-members')
    expect(verdict.status).toBe('fail')
    // The failed member is named as the reason, with its own state: a map resting
    // on it does not make the parent pass.
    expect(verdict.details).toContain(members[0]!)
    expect(verdict.details).toContain('(failed)')
  })

  it('fails the parent when its own independent criterion fails, however well the members did', async () => {
    const { h, root, members } = await twoBatches([
      { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
      {
        criterionId: 'root-members',
        description: 'every member of this run verified',
        mode: 'composite',
        mandatory: true,
      },
      {
        criterionId: 'root-interface',
        description: 'the combined interface is numerically consistent',
        command: 'false',
      },
    ])
    const submitted = await h.runtime.submitResult(ROOT, { summary: 'the members are green; the interface is not' })
    expect(submitted.status).toBe('failed')
    // Every member verified — and the parent is still refused, by its own check.
    expect(await membersOf(h, root.storeId, root.runId)).toHaveLength(members.length)
    expect((await verdictOf(h, root.storeId, root.runId, 'root-members')).status).toBe('pass')
    const independent = await verdictOf(h, root.storeId, root.runId, 'root-interface')
    expect(independent).toMatchObject({ status: 'fail', verifierId: 'command', exitCode: 1 })
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('failed')
  })
})

describe('K1-4: the windows a restart opens around a batch end', () => {
  it('leaves a terminal run alone: the batch end does not wake it, and a re-delivery is skipped with no side effect', async () => {
    const release = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: batch('survey the options', [child('survey the options', [commandCriterion('survey-1')])]) },
          { text: 'root: the survey is running' },
        ]
        : [
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'the survey holds' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(rootContract())
    await answered(h, 'task_decompose', 0)
    await spawned(h, 1)
    const batchId = await batchIdOf(h, root.storeId, root.runId)
    release.resolve()
    expect((await h.runtime.awaitBatch(root.storeId, batchId)).map(outcome => outcome.status)).toEqual(['verified'])

    // The batch ended and the parent was told — once.
    const endId = `m-batchend-${batchId}`
    await vi.waitFor(() => expect(messageOf(h, String(ROOT), endId)).toBeDefined())
    expect(messageIds(h, String(ROOT)).filter(id => id === endId)).toHaveLength(1)

    // The run is cancelled after the fact: the batch it ended is now a fact about
    // a run that can no longer act on it.
    await h.task.markRunStatusIn(root.storeId, root.taskId, root.runId, 'cancelled', String(ROOT), { reason: 'the caller ended it' })

    // Re-delivering the batch end is `skipped`, and a skipped delivery has no side
    // effects at all: nothing is appended to the terminal run's Session and no
    // second copy of the message appears.
    await expect(h.runtime.redeliverBatchResult(root.storeId, batchId)).resolves.toBe('skipped')
    expect(messageIds(h, String(ROOT)).filter(id => id === endId)).toHaveLength(1)

    // The recovery pass over the same store does not revive it either: the run is
    // still cancelled, the session was told once, and no worker was spawned for it.
    await h.runtime.reconcileStore(root.storeId)
    const after = await h.runForSession(ROOT)
    expect(after.run.status).toBe('cancelled')
    expect(after.run.submission).toBeUndefined()
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')
    expect(h.spawns).toHaveLength(1)
    expect(messageIds(h, String(ROOT)).filter(id => id === endId)).toHaveLength(1)
    await expect(h.runtime.redeliverBatchResult(root.storeId, batchId)).resolves.toBe('skipped')
  })

  it('keeps a parent\'s open question blocking after the batch it outlived has ended', async () => {
    const answerNow = Promise.withResolvers<void>()
    const answerArrived = Promise.withResolvers<void>()
    let questionId = ''
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          {
            tool: 'task_decompose',
            args: batch('delegate the work to a middle that will split it further', [
              child('the middle work', [commandCriterion('middle-1')], { decomposable: true }),
            ]),
          },
          { text: 'root: the middle is running' },
          { waitFor: () => answerNow.promise },
          { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a-root', answer: 'the frozen contract still holds', resolves: true }) },
          { text: 'root: answered' },
        ]
        : index === 1
          ? [
            { tool: 'task_decompose', args: batch('the middle splits the work', [child('the middle\'s child', [commandCriterion('grandchild-1')])]) },
            { tool: 'task_ask_parent', args: { requestKey: 'q-frozen', question: 'does the frozen contract still hold?', blocking: true } },
            { text: 'middle: asked while its child runs' },
            { waitFor: () => answerArrived.promise },
            { tool: 'task_submit_result', args: { summary: 'the middle\'s work is done once the answer arrives' } },
            { text: 'middle: handed in' },
          ]
          : [
            { tool: 'task_submit_result', args: { summary: 'the grandchild holds' } },
            { text: 'worker: handed in' },
          ],
    })
    const root = await h.begin(rootContract())
    const rootDecompose = await answered(h, 'task_decompose', 0)
    expect(rootDecompose.isError).toBe(false)
    // The middle is the root's own child, and its session is the run the store
    // records for it — read from the store rather than from the spawn order,
    // because the middle spawns its own child in the same breath.
    let middle = ''
    await vi.waitFor(async () => {
      const snapshot = await h.snapshot(root.storeId)
      const middleTask = snapshot.tasks.find(task => task.parentTaskId === root.taskId)
      expect(middleTask).toBeDefined()
      middle = runOf(snapshot, middleTask!.taskId).sessionId
    })
    const middleRun = await h.runForSession(middle)

    // The middle asked its parent; the question is on the record and unresolved.
    await vi.waitFor(async () => expect((await h.snapshot(root.storeId)).questions?.all ?? []).toHaveLength(1))
    questionId = (await h.snapshot(root.storeId)).questions!.all[0]!.questionId
    expect((await h.snapshot(root.storeId)).questions!.all[0]!.childRunId).toBe(middleRun.run.runId)

    // The middle's own batch ends: its child verified and the middle is handed
    // back `active` — with its writes still refused, because a batch end answers
    // nothing.
    const middleBatch = await batchIdOf(h, root.storeId, middleRun.run.runId)
    expect((await h.runtime.awaitBatch(root.storeId, middleBatch)).map(outcome => outcome.status)).toEqual(['verified'])
    await vi.waitFor(async () => expect((await h.task.runIn(root.storeId, middleRun.run.runId)).executionPhase).toBe('active'))
    const blocked = await dispatchAs(h, middle, 'bash', { command: 'touch should-not-exist' })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('question')
    expect(blocked.text).toContain('waiting')
    expect(h.executed.some(name => name.startsWith('bash'))).toBe(false)
    // The read side still answers in that state: the middle can see where it is.
    const read = await dispatchAs(h, middle, 'task_read', {})
    expect(read.isError).toBe(false)

    // The answer is what releases the block — not the batch end. The middle's own
    // turn is still parked where the batch end left it, so this write is judged
    // in `active` with the question resolved.
    answerNow.resolve()
    const answeredAway = await answered(h, 'task_answer', 0, String(ROOT))
    expect(answeredAway.isError).toBe(false)
    const released = await dispatchAs(h, middle, 'bash', { command: 'touch allowed-after-the-answer' })
    expect(released.isError).toBe(false)
    expect(h.executed.some(name => name.startsWith('bash'))).toBe(true)

    // …and the submission the wait held back then runs: the released run hands
    // its result in and is judged on its own criteria.
    answerArrived.resolve()
    const middleTaskId = (await h.task.runIn(root.storeId, middleRun.run.runId)).taskId
    await vi.waitFor(async () => expect((await h.task.taskIn(root.storeId, middleTaskId)).status).toBe('verified'))
  })

  it('reopens before the batch end is durable, and runs that same batch exactly once', async () => {
    const dir = workspace()
    const a = await bootOver(dir, { worker: () => new Promise(() => {}) })
    const root = await activateRoot(a)
    const admitted = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
      reason: 'delegate the survey',
      children: [child('survey the options', [commandCriterion('survey-1')])],
    } as unknown as DecomposeSpec)
    if (admitted.status !== 'admitted') throw new Error(`the batch was not admitted: ${admitted.detail}`)
    const childTaskId = admitted.childTaskIds[0]!
    await vi.waitFor(async () => expect(runOf(await a.snapshot(), childTaskId).executionPhase).toBe('active'))
    expect(runOf(await a.snapshot(), root.taskId).executionPhase).toBe('waiting_children')
    await a.crash()

    // The process that adopts the store settles that in-flight child and finishes
    // the batch the record already holds — once: one admission, one start, and no
    // worker spawned again.
    const b = await reopen(dir)
    const outcomes = await b.runtime.awaitBatch(STORE, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    expect(outcomes.map(outcome => outcome.taskId)).toEqual([childTaskId])
    const events = taskEvents(await b.events())
    expect(batchAdmissions(events)).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskCreated' && event.payload.task.parentTaskId !== undefined)).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === childTaskId)).toHaveLength(1)
    expect(b.spawns).toEqual([])
    // The handback is durable and the parent was told once, under the identity the
    // batch derives.
    const rootRun = runOf(await b.snapshot(), root.taskId)
    expect(rootRun.executionPhase).toBe('active')
    expect(rootRun.batchId).toBeUndefined()
    expect(rootRun.batches!.map(entry => entry.batchId)).toEqual([admitted.batchId])
    expect(b.relayed.filter(intent => intent.messageId === `m-batchend-${admitted.batchId}`)).toHaveLength(1)
  })

  it('reopens with the handback durable and the wake refused, and tells that same run exactly once', async () => {
    const dir = workspace()
    const a = await bootOver(dir, { relayAnswer: () => 'refused' })
    const root = await activateRoot(a)
    const { batchId, childTaskIds } = await runBatch(a, 'survey the options', 'survey-1')

    // The batch end is durable — the child verified and the parent is back at
    // work — and the deployment's relay refused, so no batch-end message was
    // delivered in that process.
    const handedBack = runOf(await a.snapshot(), root.taskId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.submission).toBeUndefined()
    expect(handedBack.batches!.map(entry => entry.batchId)).toEqual([batchId])
    expect(a.relayed).toEqual([])
    expect(runOf(await a.snapshot(), childTaskIds[0]!).status).toBe('verified')
    await a.crash()

    // The next process delivers the owed result: the same run, in the same
    // Session, told exactly once.
    const b = await reopen(dir)
    const told = b.relayed.filter(intent => intent.messageId === `m-batchend-${batchId}`)
    expect(told).toHaveLength(1)
    expect(told[0]!.targetSessionId).toBe(String(ROOT))
    expect(told[0]!.text).toContain(`[task-batch-end ${batchId}]`)
    expect(told[0]!.text).toContain('nothing was submitted on your behalf')
    const runAfter = runOf(await b.snapshot(), root.taskId)
    expect(runAfter.runId).toBe(handedBack.runId)
    expect(runAfter.sessionId).toBe(handedBack.sessionId)
    expect(runAfter.executionPhase).toBe('active')

    // A second pass over the same store owes nothing more, and the run that was
    // told is the run that continues: its own submission settles it, once.
    await b.runtime.reconcileStore(STORE)
    expect(b.relayed.filter(intent => intent.messageId === `m-batchend-${batchId}`)).toHaveLength(1)
    const settled = await b.runtime.submitResult(String(ROOT), { summary: 'the woken parent hands its result in' })
    expect(settled.status).toBe('verified')
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskVerified' && event.taskId === root.taskId)).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === childTaskIds[0])).toHaveLength(1)
  })

  it('reopens over a replay that was in flight, and settles it without running it again', async () => {
    const dir = workspace()
    const a = await bootOver(dir, { worker: () => new Promise(() => {}) })
    const root = await activateRoot(a)
    const champion = await writeChampion(a)
    // The replay's own worker never returns: the replayed run is in flight when
    // the process dies.
    const replaying = a.runtime.replayTask(STORE, champion.taskId, { lineage: 'evolution-replay:k1', spawn: true }, String(ROOT))
    void replaying
    let replayTaskId = ''
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      const task = snapshot.tasks.find(candidate => candidate.taskId !== root.taskId && candidate.taskId !== champion.taskId)
      expect(task).toBeDefined()
      replayTaskId = task!.taskId
      expect(snapshot.runs.filter(run => run.taskId === replayTaskId)).toHaveLength(1)
      expect(runOf(snapshot, replayTaskId).executionPhase).toBe('active')
    })
    const crashedRun = runOf(await a.snapshot(), replayTaskId)
    await a.crash()

    // The next process settles the run it finds in flight, without executing it
    // again: one run, one start, no worker spawned, and the same run id.
    const b = await reopen(dir)
    const settledRun = runOf(await b.snapshot(), replayTaskId)
    expect(settledRun.runId).toBe(crashedRun.runId)
    expect(settledRun.status).toBe('cancelled')
    expect((await b.snapshot()).runs.filter(run => run.taskId === replayTaskId)).toHaveLength(1)
    expect(b.spawns).toEqual([])
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === replayTaskId)).toHaveLength(1)
    // A second pass changes nothing.
    await b.runtime.reconcileStore(STORE)
    expect((await b.snapshot()).runs.filter(run => run.taskId === replayTaskId)).toHaveLength(1)
    expect(b.spawns).toEqual([])
  })
})

describe('K1-5: the root\'s budget is the store\'s, across batches and across restarts', () => {
  it('charges both batches to the root\'s total and refuses the batch past the ceiling', async () => {
    const afterFirst = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      rootBudget: { maxRuns: 3 },
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_decompose', args: batch('survey the options', [child('survey the options', [commandCriterion('survey-1')])]) },
          { text: 'root: the survey is running' },
          { waitFor: () => afterFirst.promise },
          { tool: 'task_decompose', args: batch('implement what the survey found', [child('implement the option', [commandCriterion('implement-1')])]) },
          { text: 'root: the implementation is running' },
          { tool: 'task_decompose', args: batch('a third round the budget cannot afford', [child('a third child', [commandCriterion('third-1')])]) },
          { text: 'root: the third round was refused' },
        ]
        : [
          { tool: 'task_submit_result', args: { summary: 'the delegated work holds' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(rootContract())
    const first = await answered(h, 'task_decompose', 0)
    expect(first.isError).toBe(false)
    await spawned(h, 1)
    await h.runtime.awaitBatch(root.storeId, await batchIdOf(h, root.storeId, root.runId))
    afterFirst.resolve()
    const second = await answered(h, 'task_decompose', 1)
    expect(second.isError).toBe(false)
    await spawned(h, 2)
    const secondBatch = await batchIdOf(h, root.storeId, root.runId, 1)
    await h.runtime.awaitBatch(root.storeId, secondBatch)

    // Two batches, one root run and two member runs: three runs against a ceiling
    // of three, and the third batch is refused by name with the total it holds.
    expect((await h.snapshot(root.storeId)).runs).toHaveLength(3)
    const third = await answered(h, 'task_decompose', 2)
    expect(third.text).toContain('task_decompose rejected')
    expect(third.text).toContain('root budget allows 3 run(s)')
    expect(third.text).toContain('are already recorded')
    const refused = await h.snapshot(root.storeId)
    expect(refused.runs).toHaveLength(3)
    expect(refused.tasks).toHaveLength(3)
    expect(h.spawns).toHaveLength(2)
    expect(batchAdmissions(taskEventsOf(h, root.storeId))).toHaveLength(2)
  })

  it('keeps the ceiling the store\'s own across a reopen: a third batch is refused in the next process too', async () => {
    const dir = workspace()
    const a = await bootOver(dir, { rootBudget: { maxRuns: 3 } })
    const root = await activateRoot(a)
    await runBatch(a, 'survey the options', 'survey-1')
    const second = await runBatch(a, 'implement the option', 'implement-1')
    expect((await a.snapshot()).runs).toHaveLength(3)
    const refusedInA = await a.runtime
      .decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
        reason: 'a third round the budget cannot afford',
        children: [child('a third child', [commandCriterion('third-1')])],
      } as unknown as DecomposeSpec)
      .then(() => undefined, (error: unknown) => error)
    expect(refusedInA).toBeInstanceOf(Error)
    expect((refusedInA as Error).message).toContain('root budget allows 3 run(s)')
    expect((refusedInA as Error).message).toContain('are already recorded')
    expect((await a.snapshot()).runs).toHaveLength(3)
    await a.crash()

    // The ceiling is derived from the runs the store records, so the next process
    // reads the same total. The proposal the refusal left on the record is still
    // there, still `ready`, and continuing it under the same ceiling is refused
    // for the same reason: a restart resets no budget.
    const b = await reopen(dir, { rootBudget: { maxRuns: 3 } })
    const reopened = await b.snapshot()
    expect(reopened.runs).toHaveLength(3)
    const pending = reopened.proposals!.all.find(proposal => proposal.kind !== 'root' && proposal.status === 'ready')
    expect(pending).toBeDefined()
    await expect(b.runtime.continueProposal(STORE, pending!.proposalId, String(ROOT)))
      .rejects.toThrow(/root budget allows 3 run\(s\)/)
    const after = await b.snapshot()
    expect(after.runs).toHaveLength(3)
    expect(after.tasks).toHaveLength(3)
    expect(b.spawns).toEqual([])
    expect(batchAdmissions(taskEvents(await b.events()))).toHaveLength(2)
    // The batches this ceiling was spent on are the two the record holds, each
    // with its own members in admission order.
    expect(runOf(after, root.taskId).batches!.map(entry => entry.memberTaskIds)).toEqual([
      [runOf(after, root.taskId).batches![0]!.memberTaskIds[0]!],
      second.childTaskIds,
    ])
  })
})

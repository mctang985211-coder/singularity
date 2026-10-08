import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
// The real upstream token fold, not a copy of it: the same unit the deployment's
// session-projection registry runs (`wire.view` is the value the record carries).
import { tokenUsageProjectionDefinition } from '../../../../thirdparty/deepseek-harness/packages/llm/token-meter/src/usage-projection.ts'
import type { EvidenceBundle, ReviewRecord, VerificationResult } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import { pinSkillHome, releaseSkillHomes } from '../../task-runtime/tests/support/skill-roots.ts'
import type { CapabilityConfig, Config, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'

/**
 * P4's owed work, end to end: a review record really carries the eight
 * dimensions and the effort metrics, they survive the reducer, and they land in
 * the persisted `task/event` log — asserted by reading back what the store
 * appended, not by type-checking the writer.
 *
 * What is real here: the cordis context and its `ctx.get(...)` service
 * resolution (the seam the deployment uses), `TaskService`, `TaskRuntime`, the
 * whole cascade, the reducer's validation, and the token fold.
 *
 * What is stubbed, and why: `sessionPersistence` (a memory handle), `agentRuntime`
 * (no model loop runs in this test), `sessionQuery.readSession` (the worker's
 * tool traffic is seeded instead of produced by a live agent), and the
 * `sessionProjections`/`sessions` lookup (the registry needs a live `Session`,
 * which only a running agent loop mints — the fold whose result it would return
 * is run for real below).
 */

const ROOT_SESSION = 's-root'
const STORE = rootTaskStoreId(ROOT_SESSION)

/**
 * The row this fixture's own deployment declares: the runtime ships no
 * capability table, so a child requiring `design-ball` needs it here.
 */
const CAPABILITIES: Readonly<Record<string, CapabilityConfig>> = {
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
}

afterEach(releaseSkillHomes)

/** The worker's log: the shape a real session writes, including one tool failure and one approval. */
const WORKER_LOG = [
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c2', name: 'skill', arguments: '{"name":"verify"}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c3', name: 'ask_user_question', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c4', name: 'web_search', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c9', name: 'hitl_approve', arguments: '{}' } },
  { type: 'approval/asked', data: { id: 'a1', toolName: 'hitl_approve', callId: 'c9' } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, isError: true } } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c2' }, isError: false } } },
  { type: 'compaction/start', data: {} },
  // The provider usage the token projection folds; one call's buckets.
  { type: 'assistant/message', data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 3 } } },
] as const

/** The same log as `SessionEvent`s: only `type` and `data` are read, so the envelope stays loose. */
const workerSessionEvents = WORKER_LOG.map(
  (event, seq) => ({ ...event, seq, time: seq, surfaceOp: 'append' }) as unknown as SessionEvent,
)

/** Fold a log through the real upstream projection unit — the value the registry would serve. */
function foldTokenUsage(events: readonly SessionEvent[]): unknown {
  const state = events.reduce(
    (current, event) => tokenUsageProjectionDefinition.apply(current, event),
    tokenUsageProjectionDefinition.init(undefined as never, undefined as never),
  )
  return tokenUsageProjectionDefinition.wire.view(state)
}

/** Every review record the store actually persisted, read back off its session log. */
function persistedReviews(records: readonly SessionEvent[] | undefined): ReviewRecord[] {
  return (records ?? []).flatMap(record => {
    if (record.type !== 'task/event') return []
    const envelope = record.data as { kind: string; payload?: { review?: ReviewRecord } }
    return envelope.kind === 'ReviewRecorded' && envelope.payload?.review !== undefined ? [envelope.payload.review] : []
  })
}

function harness() {
  const ctx = new Context()
  const log = new Map<string, SessionEvent[]>()
  const headers = new Map<string, SessionHeader>()
  // The person's request, on the root session's own durable log: what a root
  // contract's origin is read from (A0 §1.10). The rule is the *existence* of a
  // user-sourced message, so one text stands for the request this harness intakes on.
  log.set(ROOT_SESSION, [personRequest('ship the release')])
  const create = vi.fn(async (header: SessionHeader) => {
    headers.set(header.id, header)
    log.set(header.id, [])
    return {
      read: async () => ({ events: log.get(header.id) ?? [] }),
      append: async (records: readonly SessionEvent[]) => { log.get(header.id)?.push(...records) },
      flush: async () => {},
      close: async () => {},
    }
  })
  ctx.provide('sessionPersistence', {
    list: async () => [...headers.values()].map(header => ({ header })),
    create,
    // The read half the runtime opens to establish a root contract's origin
    // (A0 §1.10): the same handle shape the other fixtures mount.
    open: async (id: SessionId) => {
      const stored = log.get(id)
      if (stored === undefined) throw new Error(`missing session ${id}`)
      return {
        read: async () => ({ events: stored }),
        append: async (records: readonly SessionEvent[]) => { stored.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
  } as never)

  const spawned: string[] = []
  ctx.provide('agentRuntime', {
    spawn: async (_parent: unknown, request: { sessionId: string }) => {
      spawned.push(request.sessionId)
      return {
        agent: {
          id: request.sessionId,
          cancel: () => {},
          // A live worker hands its result in before it goes idle (A3 §3.2): an
          // idle session is not a completion, so a stub that only went idle would
          // be stopped by the no-progress rule instead of being verified.
          whenIdle: async () => { await runtime.submitResult(request.sessionId, { summary: 'worker finished (fixture auto-submit)' }) },
        },
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => (sessionId === ROOT_SESSION ? { id: ROOT_SESSION } : undefined) } as never)
  ctx.provide('graphs', {
    graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: ROOT_SESSION }),
  } as never)

  const tokenUsage = foldTokenUsage(workerSessionEvents)
  const readSession = vi.fn(async (_sessionId: SessionId) => ({ events: workerSessionEvents }))
  const snapshot = vi.fn((_session: unknown, _keys: readonly string[]) => ({ values: { tokenUsage } }))
  ctx.provide('sessions', { get: () => ({ id: 'live' }) } as never)
  ctx.provide('sessionProjections', { snapshot } as never)
  ctx.provide('sessionQuery', { readSession } as never)

  const task = new TaskService(ctx)
  let verifierResults: VerificationResult[] = []
  ctx.provide('verifier', {
    verifierIds: () => ['command', 'composite', 'review'],
    verifyRun: async (storeId: string, runId: string): Promise<EvidenceBundle> => {
      const run = await task.runIn(storeId, runId)
      const instance = await task.taskIn(storeId, run.taskId)
      verifierResults = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'pass',
        verifierId: 'fake-verifier',
        ...(criterion.command === undefined ? {} : { command: criterion.command, exitCode: 0, logRef: `${storeId}/${runId}/${criterion.criterionId}.log` }),
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: run.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: 'fake-verifier',
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    },
  } as never)

  const runtime = new TaskRuntime(ctx, { capabilities: { ...TASK_GUIDANCE, ...CAPABILITIES } } as Config)
  return { ctx, task, runtime, log, spawned, readSession, snapshot, foldTokenUsage: () => foldTokenUsage(workerSessionEvents) }
}


/**
 * Activate the root through the real intake (A0 §1.2–§1.4) and hand back what it
 * became. The contract is the spec's own — one goal, one criterion a command
 * settles — and it is stated here rather than defaulted, because a root contract
 * owes at least one mandatory criterion judged by something other than the
 * composite conjunction and a fixture that supplied one silently would hide that.
 */
function rootContract(objective: string): RootContractSpec {
  return { requiredCapabilities: ['execute-task'],
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

async function createRoot(h: Harness): Promise<{ storeId: string; taskId: string; runId: string }> {
  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { storeId: STORE, taskId: activated.taskId, runId: activated.runId }
}

describe('review record metrics and dimensions, end to end', () => {
  it('persists the dimensions and metrics inside the appended ReviewRecorded event', async () => {
    // The granted `ball-align` has to be discoverable from the worker's own
    // roots: admission checks that before it mints a child (S1-C).
    pinSkillHome('ball-align')
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const batch = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{
        objective: 'child work',
        acceptanceCriteria: [{ description: 'the child works', command: 'true' }],
        requiredCapabilities: ['design-ball'],
      }],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The batch end does not judge the parent (K1 §2): its own review is recorded
    // when its own submission is, so the parent hands its result in here.
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the root hands in the result its batch produced' })

    // The record is read back from the store's own session log, not from the writer's arguments.
    const reviews = persistedReviews(h.log.get(STORE))
    expect(reviews).toHaveLength(2)
    const child = reviews.find(review => review.taskId === outcomes[0]!.taskId)!
    expect(child.runId).toBe(outcomes[0]!.runId)

    // The token buckets are the real upstream projection's output, checked
    // against literals so the assertion cannot pass by construction.
    expect(h.foldTokenUsage()).toEqual({
      uncachedInputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 3,
    })
    expect(h.snapshot).toHaveBeenCalledWith(expect.anything(), ['tokenUsage'])
    expect(String(h.readSession.mock.calls[0]![0])).toBe(h.spawned[0])

    expect(child.metrics).toEqual({
      tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 3 },
      toolCalls: { calls: 5, failures: 1 },
      humanInterventions: 2,
      retries: 0,
      evidenceLogs: 1,
    })
    expect(child.dimensions).toEqual({
      outcomeCorrectness: { outcome: 'verified', criteriaCount: 1, unmetCriterionIds: [] },
      taskSpecification: { objectivePresent: true, criteriaCount: 1, criteriaWithCommand: 1 },
      acceptance: { criteria: [{ criterionId: 'ac1-1', mode: 'deterministic', hasCommand: true, mandatory: true }] },
      decomposition: { depth: 1, decompositionStatus: 'leaf', childCount: 0, incomingEdges: 0, outgoingEdges: 0 },
      capabilityCoverage: { closure: 'closed', granted: ['ball-align', 'bash', 'edit', 'read', 'write'], missing: [] },
      skillFit: { granted: ['ball-align'], loaded: ['verify'], loadedOutsideGrant: ['verify'] },
      toolFit: {
        granted: ['bash', 'edit', 'read', 'write'],
        called: [
          { name: 'ask_user_question', count: 1 },
          { name: 'hitl_approve', count: 1 },
          { name: 'read', count: 1 },
          { name: 'skill', count: 1 },
          { name: 'web_search', count: 1 },
        ],
        calledOutsideGrant: ['hitl_approve', 'web_search'],
      },
      contextEfficiency: {
        tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 3 },
        compactions: 1,
      },
    })
  })

  it('records no artifacts, no time and no score — the deliberate holes stay holes', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const { batchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{ requiredCapabilities: ['execute-task'], objective: 'child work', acceptanceCriteria: [{ description: 'the child works', command: 'true' }] }],
    })
    await h.runtime.awaitBatch(STORE, batchId)

    const child = persistedReviews(h.log.get(STORE)).find(review => review.taskId !== rootTaskId)!
    expect(child.durationMs).toBeGreaterThanOrEqual(0)
    const metrics = child.metrics as unknown as Record<string, unknown>
    // `time` lives at the top level as durationMs; artifactCount has no producer to measure.
    expect(Object.keys(metrics).sort()).toEqual(['evidenceLogs', 'humanInterventions', 'retries', 'tokens', 'toolCalls'])
    expect(metrics['artifactCount']).toBeUndefined()
    // Nothing anywhere on the record scores the run.
    const serialized = JSON.stringify(child)
    for (const forbidden of ['"score"', '"rating"', '"grade"', '"confidence"']) expect(serialized).not.toContain(forbidden)
  })
})

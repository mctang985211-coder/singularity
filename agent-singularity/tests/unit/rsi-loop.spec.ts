/**
 * The platform-side RSI loop driver (F): round detection from the store's own
 * terminal runs (verified or failed), one supervision per round, one idempotent
 * next round under the round key, the stop a closed/blocked supervisor declares,
 * the boot re-derivation from the store plus the coordination ledger, and the
 * graph-aware cap.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { EvolutionProposal } from '@dangosys/dsh-singularity-evolution'
import type { GraphRecord, RsiConfig } from '@dangosys/dsh-singularity-graphs'
import type { Diagnosis, ReviewRecord, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { RootRecoveryRequest } from '@dangosys/dsh-singularity-task-runtime'
import {
  admitReviewAgent,
  readReviewAgentAttempts,
  settleReviewAgentAttempt,
  type ReviewAgentAttemptRequest,
} from '../../src/coordination/ledger.ts'
import {
  installRsiLoopDriver,
  type LoopProgress,
  roundDiagnosisId,
  roundHandoffDigest,
  roundRequestKey,
  RsiLoopDriver,
  SUPERVISOR_BASELINE,
  supervisorGrant,
  supervisorRequestKey,
} from '../../src/coordination/rsi-loop.ts'
import { renderRecordedCostFacts, runSubtree, supervisorOutcomeOf } from '../../src/coordination/handoff-rules.ts'
import {
  graphImprovementCap,
  registerGraphImprovementCap,
  unregisterGraphImprovementCap,
} from '../../src/coordination/supervision.ts'

const ROOT = 's-root'
const STORE = `sg-t-${ROOT}`
const GRAPH = 'g1'
const fixtures: (() => void)[] = []

const RSI: RsiConfig = { task: 'keep the shipped skill improving', iterationRounds: 2, humanReview: false }

interface StoreView {
  tasks: TaskInstance[]
  runs: TaskRun[]
  reviews: ReviewRecord[]
  diagnoses: Diagnosis[]
}

/** A store whose root task settled one terminal round, verified or failed, with its review record. */
function storeView(status: 'verified' | 'failed' = 'verified'): StoreView {
  return {
    tasks: [
      {
        taskId: 't-root',
        definitionRef: { taskType: 'test', version: 1 },
        objective: 'Deliver the feature',
        depth: 0,
        acceptanceCriteria: [],
        requestedCapabilities: [],
        decompositionStatus: 'leaf',
        status,
        runIds: ['r-1'],
        childTaskIds: [],
      } as TaskInstance,
    ],
    runs: [
      {
        runId: 'r-1',
        taskId: 't-root',
        sessionId: ROOT,
        capabilitySnapshot: [],
        artifacts: [],
        verifierResults: [],
        executionPhase: 'active',
        status,
        startedAt: '2026-10-01T00:00:00.000Z',
      } as TaskRun,
    ],
    reviews: [
      {
        taskId: 't-root',
        runId: 'r-1',
        outcome: status,
        evidenceRefs: ['ev-1'],
        anomalies: [],
        criteria: [],
        ...(status === 'failed' ? { localizedCause: 'mandatory criteria not satisfied: ac-1 fail' } : {}),
      } as ReviewRecord,
    ],
    diagnoses: [],
  }
}

/** One run of the store's root task, with the recovery record a round's attempt carries. */
function roundRun(
  requestKey: string,
  status: TaskRun['status'],
  options: { kind?: 'recovery' | 'improvement'; startedAt?: string } = {},
): TaskRun {
  return {
    runId: `r-${requestKey}`,
    taskId: 't-root',
    sessionId: `s-${requestKey}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    recovery: {
      kind: options.kind ?? 'improvement',
      sourceDiagnosisId: 'x',
      requestKey,
      requestedAt: '2026-10-01T00:00:00.000Z',
    } as never,
    status,
    startedAt: options.startedAt ?? '2026-10-01T00:00:10.000Z',
  } as TaskRun
}

interface FixtureOptions {
  /** The graph's RSI settings; `null` leaves the graph without any (the default is {@link RSI}). */
  rsi?: RsiConfig | null
  proposals?: EvolutionProposal[]
  runs?: TaskRun[]
  /** The status round 1 settled at (the default is `verified`). */
  round1?: 'verified' | 'failed'
  /** Run when the supervisor is spawned, standing in for the agent driving the evolution chain. */
  onSpawn?: () => void
  spawnFails?: boolean
  /** The supervisor's last assistant message; a fenced json outcome block stops the loop. */
  supervisorReply?: string
  /** Park the actual watcher at a controlled boundary, to exercise config revocation. */
  onSupervisorIdle?: () => Promise<void>
  /** Start the store empty: no root task, no run, no review yet. */
  empty?: boolean
}

function fixture(options: FixtureOptions = {}) {
  const store = options.empty === true ? { tasks: [], runs: [], reviews: [], diagnoses: [] } : storeView(options.round1)
  if (options.runs !== undefined) store.runs = [...store.runs, ...options.runs]
  const progressWrites: LoopProgress[] = []
  const spawns: { sessionId: string; name: string; prompt: string; grant: unknown }[] = []
  const prompts: string[] = []
  const recoveries: { storeId: string; request: RootRecoveryRequest; caller: string }[] = []
  const graph: { record: GraphRecord } = {
    record: {
      id: GRAPH,
      name: 'RSI graph',
      envId: 'env-1',
      rootSessionId: ROOT,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
      createdAt: 1,
      ready: true,
      ...(options.rsi === null ? {} : { rsi: options.rsi ?? RSI }),
    } as GraphRecord,
  }
  let proposals: EvolutionProposal[] = options.proposals ?? []
  const listeners: ((fact: unknown) => void)[] = []
  const events: Record<string, ((payload: never) => void)[]> = {}
  const agents = new Map<
    string,
    {
      id: string
      cancel(): void
      whenIdle(): Promise<void>
      session: { snapshotEvents(): { type: string; data?: unknown }[] }
    }
  >()
  agents.set(ROOT, { id: ROOT, cancel: () => {}, whenIdle: async () => {}, session: { snapshotEvents: () => [] } })

  const ctx = {
    on(name: string, handler: (payload: never) => void) {
      events[name] = [...(events[name] ?? []), handler]
      return () => {
        events[name] = (events[name] ?? []).filter(item => item !== handler)
      }
    },
    get(name: string): unknown {
      if (name === 'agents') return { get: (id: string) => agents.get(id) }
      return undefined
    },
    task: {
      snapshotIn: async (storeId: string) => {
        if (storeId !== STORE) throw new Error(`unknown test store ${storeId}`)
        return structuredClone({
          version: 1,
          id: STORE,
          edges: [],
          handoffs: [],
          obligations: [],
          capabilities: {},
          evidence: [],
          tasks: store.tasks,
          runs: store.runs,
          reviews: store.reviews,
          diagnoses: store.diagnoses,
        }) as unknown as TaskSnapshot
      },
      recordDiagnosisIn: async (_storeId: string, diagnosis: Diagnosis) => {
        store.diagnoses.push(structuredClone(diagnosis))
      },
    },
    graphs: {
      get: async (_id: string) => structuredClone(graph.record),
      list: async () => [structuredClone(graph.record)],
      snapshot: async () => ({ version: 1, graphs: [structuredClone(graph.record)], selectedId: GRAPH, archives: [] }),
      graphForSession: async () => structuredClone(graph.record),
    },
    evolution: {
      list: async () => proposals,
    },
    taskRuntime: {
      registerTerminalReviewListener: (listener: (fact: unknown) => void) => {
        listeners.push(listener)
        return () => {
          listeners.splice(listeners.indexOf(listener), 1)
        }
      },
      recoverRootTask: async (storeId: string, request: RootRecoveryRequest, caller: { sessionId: string }) => {
        recoveries.push({ storeId, request, caller: caller.sessionId })
        store.runs = [
          ...store.runs,
          {
            ...roundRun(request.requestKey, 'running', {
              kind: request.mode === 'improve' ? 'improvement' : 'recovery',
            }),
            recovery: {
              kind: request.mode === 'improve' ? 'improvement' : 'recovery',
              sourceDiagnosisId: request.sourceDiagnosisId,
              requestKey: request.requestKey,
              ...(request.proposalIds === undefined ? {} : { proposalIds: [...request.proposalIds] }),
              requestedAt: '2026-10-01T00:00:10.000Z',
            } as never,
          },
        ]
        return {
          attempt: 'started',
          storeId,
          sourceTaskId: request.sourceTaskId,
          sourceDiagnosisId: request.sourceDiagnosisId,
          requestKey: request.requestKey,
          runId: `r-${request.requestKey}`,
          sessionId: `s-${request.requestKey}`,
          status: 'running',
          reusedMembers: [],
          unboundMembers: [],
          detail: 'test attempt',
        }
      },
    },
    agentRuntime: {
      prompt: vi.fn(async (_agent: unknown, content: { text: string }[]) => {
        prompts.push(content[0]!.text)
      }),
      spawn: vi.fn(async (_parent: unknown, request: Record<string, unknown>) => {
        spawns.push({
          sessionId: String(request.sessionId),
          name: String(request.name),
          prompt: ((request.prompt as { text: string }[])[0] ?? { text: '' }).text,
          grant: request.grant,
        })
        options.onSpawn?.()
        await (request.beforePrompt as () => Promise<void>)()
        if (options.spawnFails === true) throw new Error('the deployment cannot spawn the supervisor')
        const sessionId = String(request.sessionId)
        agents.set(sessionId, {
          id: sessionId,
          cancel: () => {},
          whenIdle: options.onSupervisorIdle ?? (async () => {}),
          session: {
            snapshotEvents: () =>
              options.supervisorReply === undefined
                ? []
                : [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: options.supervisorReply! }] } } }],
          },
        })
        return { agent: agents.get(sessionId)! }
      }),
    },
  }
  fixtures.push(() => unregisterGraphImprovementCap(STORE))
  return {
    ctx: ctx as unknown as Context,
    store,
    graph,
    progressWrites,
    /** The driver options wired to this fixture's progress observer. */
    driverOptions: {
      log: () => {},
      onProgress: (_id: string, progress: LoopProgress) => {
        progressWrites.push(progress)
      },
    },
    spawns,
    prompts,
    recoveries,
    listeners,
    events,
    setProposals(next: EvolutionProposal[]) {
      proposals = next
    },
  }
}

/** Record one finished supervision of a round, as a previous process left it on the coordination ledger. */
async function previousSupervisor(
  round: number,
  status: 'closed' | 'interrupted' | 'recorded',
  note = `${status} by a previous process`,
): Promise<void> {
  const sessionId = `s-old-supervisor-${round}-${status}`
  const request: ReviewAgentAttemptRequest = {
    role: 'supervisor',
    source: { taskId: 't-root', runId: 'r-1' },
    requestKey: supervisorRequestKey(GRAPH, round),
    reason: 'older attempt',
    diagnosisId: roundDiagnosisId(GRAPH, round),
    handoffDigest: roundHandoffDigest({ graphId: GRAPH, round, storeId: STORE, taskId: 't-root', runId: 'r-1' }),
    actor: ROOT,
    sessionId,
  }
  await admitReviewAgent(STORE, async admission => {
    await admission.claim(request)
    await admission.start({ taskId: 't-root', sessionId, actor: ROOT })
  })
  await settleReviewAgentAttempt({
    rootStoreId: STORE,
    taskId: 't-root',
    sessionId,
    status,
    note,
  })
}

/** One applied proposal of a round, as the ledger reports it. */
function appliedProposal(round: number, proposalId: string): EvolutionProposal {
  return {
    proposalId,
    targetType: 'skill',
    targetId: 'shipped-skill',
    baseVersion: '1',
    level: 'L2',
    rationale: 'the round shows a method gap',
    sourceRefs: [`diagnosis:${roundDiagnosisId(GRAPH, round)}`],
    status: 'applied',
    history: [],
  } as EvolutionProposal
}

const CLOSED_REPLY = '```json\n{"outcome":"closed","reason":"the contract is unsatisfiable"}\n```'
const BLOCKED_REPLY = '```json\n{"outcome":"blocked","reason":"the toolchain is absent"}\n```'
const NO_CHANGE_REPLY = '```json\n{"outcome":"no_change","reason":"the verified method needs no shared change"}\n```'

let ledgerDir: string
let previousLedger: string | undefined

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'rsi-loop-'))
  previousLedger = process.env.SINGULARITY_REVIEW_LEDGER_DIR
  process.env.SINGULARITY_REVIEW_LEDGER_DIR = ledgerDir
})

afterEach(() => {
  for (const teardown of fixtures.splice(0)) teardown()
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  rmSync(ledgerDir, { recursive: true, force: true })
})

describe('the RSI loop driver', () => {
  it('reads publication and experiment costs from the graph scope agents publish into', async () => {
    let scopedProposals: EvolutionProposal[] = []
    const f = fixture({ onSpawn: () => { scopedProposals = [appliedProposal(1, 'scoped-p')] } })
    const forSession = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(ROOT)
      return { list: async () => scopedProposals, experiments: async () => [] }
    })
    Object.assign(f.ctx.evolution, { forSession, list: vi.fn(async () => { throw new Error('global ledger belongs to another library') }) })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries[0]!.request.proposalIds).toEqual(['scoped-p'])
    expect(forSession).toHaveBeenCalled()
  })

  it('includes generated-plan and independent-judge usage once per recorded experiment', async () => {
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY, proposals: [{ ...appliedProposal(0, 'manual-p'), sourceRefs: [] }] })
    Object.assign(f.ctx.evolution, { experiments: async () => [{
      experimentId: 'exp-1',
      frozen: { evaluation: { generatedResponse: '{}', generatedUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } },
      judged: { evaluation: { judgeUsage: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 } } },
    }] })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns[0]!.prompt).toContain('Auxiliary evaluation plan/judge usage: 2 model calls; tokens 36 (input 6, output 8, cache read 10, cache write 12)')
    expect(f.recoveries).toHaveLength(1)
  })

  it('hands natural-language metrics and recorded full-tree effort to method supervision', async () => {
    const f = fixture({ rsi: { ...RSI, metrics: ['reduce latency', 'model cost'] }, supervisorReply: NO_CHANGE_REPLY })
    f.store.runs.push({ ...f.store.runs[0]!, runId: 'r-child', taskId: 't-child', sessionId: 's-child', parentRunId: 'r-1' })
    f.store.runs.push({ ...f.store.runs[0]!, runId: 'r-old', taskId: 't-old', sessionId: 's-old' })
    f.store.reviews[0]!.metrics = { tokens: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4 }, toolCalls: { calls: 2, failures: 0 } }
    f.store.reviews.push({ taskId: 't-child', runId: 'r-child', outcome: 'verified', evidenceRefs: [], anomalies: [], metrics: { tokens: { uncachedInputTokens: 50, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 }, toolCalls: { calls: 3, failures: 1 } } })
    f.store.reviews.push({ taskId: 't-old', runId: 'r-old', outcome: 'verified', evidenceRefs: [], anomalies: [], metrics: { toolCalls: { calls: 7, failures: 0 } } })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    const prompt = f.spawns[0]!.prompt
    expect(prompt).toContain('Metrics to explore and improve: reduce latency; model cost')
    expect(prompt).toContain('Current round execution tree: 2 sessions; tokens 584 (input 150, output 30, cache read 400, cache write 4); toolCalls 5 (1 failed); coverage tokens 2/2, tools 2/2')
    expect(prompt).toContain('Graph usage to date (executions, replay experiments and recorded coordination): 3 sessions; tokens unknown; toolCalls unknown; coverage tokens 0/3, tools 0/3')
    expect(prompt).toContain('monetary cost unknown')
    expect(prompt).toContain('evaluation.goal is enough for an LLM-generated frozen plan')
  })

  it('counts complete business and coordination sessions once after submission while the round retains its frozen review', async () => {
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY })
    await previousSupervisor(0, 'recorded')
    const coordination = 's-old-supervisor-0-recorded'
    f.store.runs.push({ ...f.store.runs[0]!, runId: 'r-same-session', taskId: 't-other' })
    f.store.reviews[0]!.metrics = { tokens: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCalls: { calls: 2, failures: 0 } }
    const logs = new Map([
      [ROOT, [
        { type: 'tool/call', data: { name: 'read' } }, { type: 'tool/call', data: { name: 'task_submit_result' } },
        { type: 'tool/call', data: { name: 'read' } }, { type: 'tool/call', data: { name: 'bash' } },
        { type: 'tool/result', data: { message: { isError: true } } },
      ]],
      [coordination, [
        { type: 'tool/call', data: { name: 'task_read' } }, { type: 'tool/call', data: { name: 'evolution_replay' } },
        { type: 'tool/result', data: { message: { isError: true } } },
      ]],
    ])
    Object.assign(f.ctx, {
      sessions: { get: (id: string) => ({ id }) },
      sessionProjections: { snapshot: (session: { id: string }) => ({ values: { tokenUsage: session.id === ROOT
        ? { uncachedInputTokens: 150, outputTokens: 45, cacheReadTokens: 10, cacheWriteTokens: 0 }
        : { uncachedInputTokens: 9, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) },
      sessionQuery: { readSession: async (id: string) => ({ events: logs.get(id) ?? [] }) },
    })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    const prompt = f.spawns[0]!.prompt
    expect(prompt).toContain('Current round execution tree: 1 sessions; tokens 120 (input 100, output 20, cache read 0, cache write 0); toolCalls 2 (0 failed)')
    expect(prompt).toContain('Graph usage to date (executions, replay experiments and recorded coordination): 2 sessions; tokens 217 (input 159, output 48, cache read 10, cache write 0); toolCalls 6 (2 failed); coverage tokens 2/2, tools 2/2')
    expect(f.store.reviews[0]!.metrics!.tokens!.outputTokens).toBe(20)
  })

  it('restores complete cold-session token usage with the existing projection reader', async () => {
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY })
    f.store.reviews[0]!.metrics = { tokens: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    const header = { id: ROOT }
    const events = [{ type: 'tool/call', data: { name: 'task_submit_result' } }]
    const restore = vi.fn(() => ({ snapshot: { values: { tokenUsage: {
      uncachedInputTokens: 20, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 0,
    } } } }))
    Object.assign(f.ctx, {
      sessionProjections: { restore },
      sessionQuery: { readSession: async () => ({ session: header, inheritedEventCount: 0, events }) },
    })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(restore).toHaveBeenCalledWith({}, events, 0, header, 0)
    expect(f.spawns[0]!.prompt).toContain('Graph usage to date (executions, replay experiments and recorded coordination): 1 sessions; tokens 30 (input 20, output 6, cache read 4, cache write 0); toolCalls 1 (0 failed); coverage tokens 1/1, tools 1/1')
    expect(f.spawns[0]!.prompt).toContain('Current round execution tree: 1 sessions; tokens 12')
  })

  it('fills missing tool counts from actual session logs and leaves missing tokens unknown', async () => {
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY })
    Object.assign(f.ctx, { sessionQuery: { readSession: async () => ({ events: [
      { type: 'tool/call', data: { name: 'read' } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'tool/result', data: { message: { isError: true } } },
    ] }) } })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns[0]!.prompt).toContain('Current round execution tree: 1 sessions; tokens unknown; toolCalls 2 (1 failed); coverage tokens 0/1, tools 1/1')
  })

  it('deduplicates session costs and keeps reused historical runs out of a current execution tree', () => {
    const snapshot = { runs: [
      { runId: 'new', sessionId: 's-new' },
      { runId: 'child', sessionId: 's-child', parentRunId: 'new' },
      { runId: 'grandchild', sessionId: 's-grandchild', parentRunId: 'child' },
      { runId: 'old-child', sessionId: 's-old', parentRunId: 'old' },
    ] } as TaskSnapshot
    expect(runSubtree(snapshot, 'new').map(run => run.runId)).toEqual(['new', 'child', 'grandchild'])
    expect(renderRecordedCostFacts('sample', ['s-child', 's-child', 's-missing'], new Map([
      ['s-child', { toolCalls: { calls: 4, failures: 1 } }],
    ]))).toContain('2 sessions; tokens unknown; toolCalls 4 (1 failed); coverage tokens 0/2, tools 1/2')
  })

  it('supervises the verified round and opens the next one under the round key, consuming what was applied', async () => {
    // The supervisor applies one proposal while it runs.
    const f = fixture({ onSpawn: () => f.setProposals([appliedProposal(1, 'p-1')]) })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)

    expect(f.progressWrites).toEqual([
      { round: 1, phase: 'publishing', note: 'round 1 verified; supervising its method change' },
      { round: 2, phase: 'running', note: 'round 2 is running' },
    ])
    expect(f.recoveries).toHaveLength(1)
    expect(f.recoveries[0]!.request).toEqual({
      sourceTaskId: 't-root',
      sourceRunId: 'r-1',
      sourceDiagnosisId: roundDiagnosisId(GRAPH, 1),
      requestKey: roundRequestKey(GRAPH, 2),
      mode: 'improve',
      reuses: [],
      proposalIds: ['p-1'],
    })
    expect(f.recoveries[0]!.caller).toBe(ROOT)
    expect(f.spawns).toHaveLength(1)
    const prompt = f.spawns[0]!.prompt
    expect(prompt).toContain('round 1 of 2')
    expect(prompt).toContain(`Cite diagnosis:${roundDiagnosisId(GRAPH, 1)}`)
    expect(prompt).toContain(STORE)
    expect(prompt).toContain('t-root')
    expect(prompt).toContain('The platform driver opens the next round')
    expect(prompt).toContain('task_library')
    expect(prompt).toContain("The round settled verified against the store's own acceptance criteria")
  })

  it('supervises a failed round with its review cause and opens a recovery round', async () => {
    const f = fixture({
      round1: 'failed',
      rsi: { ...RSI, iterationRounds: 3 },
      onSpawn: () => f.setProposals([appliedProposal(1, 'p-1')]),
    })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)

    // The round failed, so its supervision is the debug variant and the next
    // round is a recovery of this attempt.
    expect(f.progressWrites).toEqual([
      { round: 1, phase: 'debugging', note: 'round 1 settled failed; supervising its repair' },
      { round: 2, phase: 'running', note: 'round 2 is running' },
    ])
    expect(f.recoveries).toHaveLength(1)
    expect(f.recoveries[0]!.request).toEqual({
      sourceTaskId: 't-root',
      sourceRunId: 'r-1',
      sourceDiagnosisId: roundDiagnosisId(GRAPH, 1),
      requestKey: roundRequestKey(GRAPH, 2),
      mode: 'recovery',
      proposalIds: ['p-1'],
    })
    // The round's diagnosis carries the review's own localized cause as the
    // observation: the supervisor investigates, and the driver suggests nothing.
    const diagnosis = f.store.diagnoses[0]!
    expect(diagnosis.observedFailure).toBe('mandatory criteria not satisfied: ac-1 fail')
    expect(diagnosis.proposals).toEqual([])
    expect(f.spawns[0]!.prompt).toContain('The round settled failed')
    expect(f.spawns[0]!.prompt).toContain('Debug that failure')
  })

  it('marks the loop failed and opens nothing when the supervisor reports the loop closed', async () => {
    const f = fixture({ rsi: { ...RSI, iterationRounds: 3 }, supervisorReply: CLOSED_REPLY })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.spawns).toHaveLength(1)
    expect(f.progressWrites).toEqual([
      { round: 1, phase: 'publishing', note: 'round 1 verified; supervising its method change' },
      {
        round: 1,
        phase: 'failed',
        note: "round 1's supervisor reported closed: the contract is unsatisfiable; the loop stops",
      },
    ])
  })

  it('marks the loop failed and opens nothing when the supervisor reports a concrete obstruction', async () => {
    const f = fixture({ rsi: { ...RSI, iterationRounds: 3 }, supervisorReply: BLOCKED_REPLY })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.spawns).toHaveLength(1)
    expect(f.progressWrites.at(-1)).toEqual({
      round: 1,
      phase: 'failed',
      note: "round 1's supervisor reported blocked: the toolchain is absent; the loop stops",
    })
  })

  it('records the round diagnosis with no proposals', async () => {
    const f = fixture({ onSpawn: () => f.setProposals([appliedProposal(1, 'p-1')]) })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    const diagnosis = f.store.diagnoses[0]
    expect(diagnosis).toBeDefined()
    expect(diagnosis!.diagnosisId).toBe(roundDiagnosisId(GRAPH, 1))
    expect(diagnosis!.taskId).toBe('t-root')
    expect(diagnosis!.proposals).toEqual([])
    expect(diagnosis!.reviewRefs).toEqual(['t-root#r-1'])
    expect(diagnosis!.evidenceRefs).toEqual(['ev-1'])
  })

  it('reviews final library experience and finishes without opening another execution', async () => {
    const f = fixture({ rsi: { ...RSI, iterationRounds: 1 }, supervisorReply: NO_CHANGE_REPLY })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.spawns).toHaveLength(1)
    expect(f.spawns[0]!.prompt).toContain('Final library review')
    expect(f.progressWrites.at(-1)).toEqual({ round: 1, phase: 'done', note: '1/1 rounds settled; final round verified; final library review settled; the loop is finished' })
    expect((await readReviewAgentAttempts(STORE)).at(-1)?.settlement).toMatchObject({ status: 'recorded' })
  })

  it('waits for the final library review and reuses its durable settlement after restart', async () => {
    let release!: () => void
    const idle = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ rsi: { ...RSI, iterationRounds: 1 }, supervisorReply: NO_CHANGE_REPLY, onSupervisorIdle: () => idle })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    const pending = driver.ensure(GRAPH)
    await vi.waitFor(() => expect(f.spawns).toHaveLength(1))
    expect(f.progressWrites.at(-1)).toMatchObject({ round: 1, phase: 'publishing' })
    expect(f.recoveries).toEqual([])
    release()
    await pending
    expect(f.progressWrites.at(-1)).toMatchObject({ phase: 'done' })
    driver.stop()
    const restarted = new RsiLoopDriver(f.ctx, f.driverOptions)
    await restarted.ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.recoveries).toEqual([])
    restarted.stop()
  })

  it('counts terminal rounds of either kind and continues from the last one', async () => {
    // Round 1 verified, round 2 (a recovery) failed: both are rounds, and the
    // loop's next step is round 3, a recovery of round 2.
    const f = fixture({
      rsi: { ...RSI, iterationRounds: 3 },
      runs: [
        roundRun(roundRequestKey(GRAPH, 2), 'failed', {
          kind: 'improvement',
          startedAt: '2026-10-01T00:00:10.000Z',
        }),
      ],
      onSpawn: () => f.setProposals([appliedProposal(2, 'p-2')]),
    })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    await driver.ensure(GRAPH)
    expect(f.progressWrites).toEqual([
      { round: 2, phase: 'debugging', note: 'round 2 settled failed; supervising its repair' },
      { round: 3, phase: 'running', note: 'round 3 is running' },
    ])
    expect(f.recoveries[0]!.request).toMatchObject({
      sourceRunId: 'r-' + roundRequestKey(GRAPH, 2),
      requestKey: roundRequestKey(GRAPH, 3),
      mode: 'recovery',
      proposalIds: ['p-2'],
    })
  })

  it('never opens a round the store already holds under its request key', async () => {
    const f = fixture({ runs: [roundRun(roundRequestKey(GRAPH, 2), 'running')] })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.spawns).toEqual([])
    expect(f.progressWrites).toEqual([{ round: 2, phase: 'running', note: 'round 2 is running' }])
  })

  it('resumes a round without a second supervisor when its publication already settled', async () => {
    const f = fixture({ proposals: [appliedProposal(1, 'p-9')] })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toEqual([])
    expect(f.recoveries).toHaveLength(1)
    expect(f.recoveries[0]!.request.proposalIds).toEqual(['p-9'])
    expect(f.recoveries[0]!.request.requestKey).toBe(roundRequestKey(GRAPH, 2))
  })

  it('resumes a round from its recorded supervision without a second supervisor', async () => {
    // A previous process explicitly found no change and died before opening
    // the next round. The ledger keeps that reason across the restart.
    const f = fixture()
    await previousSupervisor(1, 'recorded', 'no_change: the evidence supports no shared change')
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toEqual([])
    expect(f.recoveries).toHaveLength(1)
    expect(f.recoveries[0]!.request.requestKey).toBe(roundRequestKey(GRAPH, 2))
  })

  it('stops the loop it marked failed from a blocked closure when the graph is re-activated', async () => {
    // The stop is this loop's in-memory position: a re-activation of the same
    // driver takes no further step and delegates no second supervisor.
    const f = fixture({ rsi: { ...RSI, iterationRounds: 3 }, supervisorReply: BLOCKED_REPLY })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    await driver.ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.progressWrites.at(-1)).toEqual({
      round: 1,
      phase: 'failed',
      note: "round 1's supervisor reported blocked: the toolchain is absent; the loop stops",
    })
    await driver.ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.recoveries).toEqual([])
    driver.stop()
  })

  it('resumes a blocked round when the operator re-enters the loop (a fresh attachment)', async () => {
    // The registry no longer stores loop progress, so a driver that attaches
    // with no in-memory position treats the round as operator-resumed: the
    // operator cleared the obstruction the blocked settlement named and bumped
    // the epoch (or re-issued the config), and the round gets one fresh
    // supervisor attempt under the same round key.
    const f = fixture({ rsi: { ...RSI, iterationRounds: 3 }, supervisorReply: NO_CHANGE_REPLY })
    await previousSupervisor(1, 'closed', 'blocked: the toolchain is absent')
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.spawns[0]!.name).toContain('round 1')
    expect(f.progressWrites[0]).toMatchObject({ round: 1, phase: 'publishing' })
  })

  it('re-delegates a round whose supervisor died before settling anything', async () => {
    // A dead supervisor is re-delegable; the store's coordination allowance
    // bounds the retries.
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY })
    await previousSupervisor(1, 'interrupted')
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.recoveries).toHaveLength(1)
    expect(f.recoveries[0]!.request.requestKey).toBe(roundRequestKey(GRAPH, 2))
  })

  it('re-derives a failed round that settled before the restart and supervises it now', async () => {
    // The store holds a failed round with no supervision attempt yet: boot must
    // spawn its supervisor from the store plus the ledger, not from memory.
    const f = fixture({ round1: 'failed', rsi: { ...RSI, iterationRounds: 3 }, supervisorReply: NO_CHANGE_REPLY })
    expect(f.store.diagnoses).toEqual([])
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.store.diagnoses.map(item => item.diagnosisId)).toEqual([roundDiagnosisId(GRAPH, 1)])
    expect(f.recoveries[0]!.request.mode).toBe('recovery')
  })

  it('spawns a bounded supervisor whose grant never carries task_recover', async () => {
    // The supervisor drives the chain; silence never completes that work.
    const f = fixture()
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(SUPERVISOR_BASELINE).toContain('evolution_apply')
    expect(SUPERVISOR_BASELINE).not.toContain('task_recover')
    expect(supervisorGrant()).toMatchObject({ baseline: SUPERVISOR_BASELINE, capabilities: [], keepPresetTools: false })
    expect(f.spawns[0]!.grant).toMatchObject({ baseline: SUPERVISOR_BASELINE })
    // Three re-prompts then a blocked settlement: no fake successful round.
    expect(f.prompts).toHaveLength(3)
    expect(f.recoveries).toHaveLength(0)
    expect(f.progressWrites.at(-1)).toMatchObject({ round: 1, phase: 'failed' })
    expect(f.progressWrites.at(-1)!.note).toContain('supervision unfinished after 3 re-prompts')
    expect((await readReviewAgentAttempts(STORE)).at(-1)?.settlement).toMatchObject({ status: 'closed' })
  })

  it('accepts an explicit no_change with a reason and preserves it for restart', async () => {
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.prompts).toEqual([])
    expect(f.recoveries[0]!.request).toMatchObject({ mode: 'improve', reuses: [] })
    expect((await readReviewAgentAttempts(STORE)).at(-1)?.settlement).toMatchObject({
      status: 'recorded', note: 'no_change: the verified method needs no shared change',
    })
  })

  it.each(['REJECT', 'KEEP_FOR_FURTHER_RESEARCH', 'rollback'] as const)(
    'preserves %s as a completed negative method result', async result => {
      const proposal = { ...appliedProposal(1, 'p-negative'),
        ...(result === 'rollback' ? { status: 'rolledback' } : { status: 'decided', decision: result }),
      } as EvolutionProposal
      const f = fixture({ proposals: [proposal] })
      await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
      expect(f.spawns).toEqual([])
      expect(f.recoveries).toHaveLength(1)
      expect(f.recoveries[0]!.request.proposalIds).toBeUndefined()
    },
  )

  it('does not let one applied proposal hide another unfinished executable candidate', async () => {
    const unfinished = { ...appliedProposal(1, 'p-unfinished'), status: 'prepared' } as EvolutionProposal
    const f = fixture({ proposals: [appliedProposal(1, 'p-applied'), unfinished] })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.prompts).toHaveLength(3)
    expect(f.progressWrites.at(-1)!.note).toContain('p-unfinished [prepared]')
    expect(f.progressWrites.at(-1)).toMatchObject({ round: 1, phase: 'failed' })
  })

  it.each(['applied', 'prepared'] as const)('refuses no_change that contradicts a %s executable proposal', async status => {
    const f = fixture({
      supervisorReply: NO_CHANGE_REPLY,
      onSpawn: () => f.setProposals([{ ...appliedProposal(1, 'p-candidate'), status } as EvolutionProposal]),
    })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.progressWrites.at(-1)!.note).toContain('no_change contradicts the publication ledger')
    expect((await readReviewAgentAttempts(STORE)).at(-1)?.settlement?.status).toBe('closed')
  })

  it('does not let a research-only suggestion block an applied executable publication', async () => {
    const suggestion = { ...appliedProposal(1, 'p-research'), targetType: 'runtime_policy', status: 'proposed', level: 'L4' } as EvolutionProposal
    const f = fixture({ proposals: [appliedProposal(1, 'p-applied'), suggestion] })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toEqual([])
    expect(f.recoveries[0]!.request.proposalIds).toEqual(['p-applied'])
  })

  it('permits no_change alongside a research-only suggestion', async () => {
    const suggestion = { ...appliedProposal(1, 'p-research'), targetType: 'runtime_policy', status: 'proposed', level: 'L4' } as EvolutionProposal
    const f = fixture({ proposals: [suggestion], supervisorReply: NO_CHANGE_REPLY })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.prompts).toEqual([])
    expect(f.recoveries).toHaveLength(1)
    expect(f.recoveries[0]!.request.proposalIds).toBeUndefined()
  })

  it('does not treat the legacy recorded reminder bound as a completed publication', async () => {
    const f = fixture()
    await previousSupervisor(1, 'recorded', 'no proposal settled after 3 re-prompts')
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.recoveries).toEqual([])
    expect(f.progressWrites.at(-1)).toMatchObject({ round: 1, phase: 'failed' })
  })

  it('keeps the final failed run and its cause when the execution count is exhausted', async () => {
    const f = fixture({ rsi: { ...RSI, iterationRounds: 1 }, round1: 'failed', supervisorReply: NO_CHANGE_REPLY })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.spawns).toHaveLength(1)
    expect(f.recoveries).toEqual([])
    expect(f.progressWrites.at(-1)).toEqual({
      round: 1, phase: 'failed',
      note: '1/1 rounds settled; final round failed: mandatory criteria not satisfied: ac-1 fail; final library review settled; the loop is finished',
    })
  })

  it('revokes a pending watcher when RSI is cleared, including without an event', async () => {
    let release!: () => void
    const idle = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY, onSupervisorIdle: () => idle })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    const pending = driver.ensure(GRAPH)
    await vi.waitFor(() => expect(f.spawns).toHaveLength(1))
    const { rsi: _config, ...bare } = f.graph.record
    f.graph.record = bare
    release()
    await pending
    expect(f.recoveries).toEqual([])
    expect(f.progressWrites).toHaveLength(1)
    expect((await readReviewAgentAttempts(STORE)).at(-1)?.settlement?.status).toBe('interrupted')
    driver.stop()
  })

  it.each([true, false])('revokes a pending watcher when RSI is replaced (epoch bump: %s)', async epochBump => {
    let release!: () => void
    const idle = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY, onSupervisorIdle: () => idle })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    const pending = driver.ensure(GRAPH)
    await vi.waitFor(() => expect(f.spawns).toHaveLength(1))
    // An epoch bump is the explicit re-entry: it revokes the watcher even when
    // every other setting is identical. A plain settings change revokes it too.
    f.graph.record = { ...f.graph.record, rsi: epochBump ? { ...RSI, epoch: 2 } : { ...RSI, iterationRounds: 1 } }
    release()
    await pending
    expect(f.recoveries).toEqual([])
    expect(f.progressWrites).toHaveLength(1)
    await driver.ensure(GRAPH)
    if (epochBump) {
      expect(f.spawns).toHaveLength(2)
      expect(f.recoveries).toHaveLength(1)
    } else {
      expect(f.spawns).toHaveLength(2)
      expect(f.progressWrites.at(-1)).toMatchObject({ phase: 'done' })
    }
    driver.stop()
  })

  it.each(['failed', 'running'] as const)('reconciles a %s run written before recovery throws', async status => {
    const f = fixture({ supervisorReply: NO_CHANGE_REPLY })
    vi.spyOn(f.ctx.taskRuntime, 'recoverRootTask').mockImplementation(async (_storeId, request) => {
      f.store.runs.push(roundRun(request.requestKey, status))
      throw new Error('worker spawn acknowledgement failed')
    })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    await driver.ensure(GRAPH)
    expect(f.store.runs).toHaveLength(2)
    expect(f.progressWrites.at(-1)!.note).toContain(`was recorded ${status} despite its opening error`)
    await driver.ensure(GRAPH)
    expect(f.ctx.taskRuntime.recoverRootTask).toHaveBeenCalledTimes(1)
    expect(f.progressWrites.at(-1)).toMatchObject({ round: 2, phase: status === 'running' ? 'running' : 'failed' })
    if (status === 'failed') expect(f.progressWrites.at(-1)!.note).toContain('final round failed')
    driver.stop()
  })

  it('ignores graphs without RSI settings and leaves the runtime cap alone for them', async () => {
    const f = fixture({ rsi: null })
    await new RsiLoopDriver(f.ctx, f.driverOptions).ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    expect(f.spawns).toEqual([])
    expect(f.progressWrites).toEqual([])
    expect(graphImprovementCap(STORE)).toBeUndefined()
  })

  it('declares the graph round count as the store cap, and drops it with the loop', async () => {
    const f = fixture()
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    driver.observeGraph(f.graph.record)
    expect(graphImprovementCap(STORE)).toBe(2)
    driver.stop()
    expect(graphImprovementCap(STORE)).toBeUndefined()
  })

  it('clears routing and the cap even before the activation creates loop state', async () => {
    const f = fixture()
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    driver.observeGraph(f.graph.record)
    expect(graphImprovementCap(STORE)).toBe(2)
    const { rsi: _config, ...bare } = f.graph.record
    f.graph.record = bare
    driver.observeGraph(f.graph.record)
    expect(graphImprovementCap(STORE)).toBeUndefined()
    await driver.ensure(GRAPH)
    expect(f.spawns).toEqual([])
    expect(f.recoveries).toEqual([])
    driver.stop()
  })

  it('ignores the terminal facts of stores no graph declared as an RSI loop', async () => {
    const f = fixture()
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    driver.install()
    for (const listener of f.listeners)
      listener({ storeId: 'sg-t-other', taskId: 't-root', runId: 'r-1', outcome: 'verified' })
    await Promise.resolve()
    expect(f.recoveries).toEqual([])
    expect(f.spawns).toEqual([])
    driver.stop()
  })

  it('waits for the root task, then picks the loop up from the first terminal fact', async () => {
    const f = fixture({ empty: true })
    const driver = new RsiLoopDriver(f.ctx, f.driverOptions)
    driver.install()
    // The graph activation happens before the store holds a root task: nothing
    // is scheduled, and the store stays bound to its graph.
    for (const handler of f.events['graphs/selected'] ?? []) handler(f.graph.record as never)
    await driver.ensure(GRAPH)
    expect(f.recoveries).toEqual([])
    // The store's root task then verifies; its terminal fact reaches the loop.
    const seeded = storeView()
    f.store.tasks = seeded.tasks
    f.store.runs = seeded.runs
    f.store.reviews = seeded.reviews
    f.setProposals([appliedProposal(1, 'p-1')])
    for (const listener of f.listeners)
      listener({ storeId: STORE, taskId: 't-root', runId: 'r-1', outcome: 'verified' })
    await vi.waitFor(() => expect(f.recoveries).toHaveLength(1))
    expect(f.recoveries[0]!.request.requestKey).toBe(roundRequestKey(GRAPH, 2))
    driver.stop()
  })

  it('wires install() to the terminal-review listener and the graph activation event', async () => {
    const f = fixture({ onSpawn: () => f.setProposals([appliedProposal(1, 'p-1')]) })
    const dispose = installRsiLoopDriver(f.ctx, f.driverOptions)
    expect(f.listeners.length).toBeGreaterThan(0)
    for (const handler of f.events['graphs/selected'] ?? []) handler(f.graph.record as never)
    await vi.waitFor(() => expect(f.recoveries).toHaveLength(1))
    expect(graphImprovementCap(STORE)).toBe(2)
    dispose()
    expect(graphImprovementCap(STORE)).toBeUndefined()
    expect(f.listeners).toEqual([])
  })
})

describe('supervisor outcome parsing', () => {
  it('accepts no_change only with a concrete reason', () => {
    expect(supervisorOutcomeOf(NO_CHANGE_REPLY)).toEqual({ outcome: 'no_change', reason: 'the verified method needs no shared change' })
    expect(supervisorOutcomeOf('```json\n{"outcome":"no_change","reason":"  "}\n```')).toBeUndefined()
    expect(supervisorOutcomeOf('```json\n{"outcome":"no_change"}\n```')).toBeUndefined()
    expect(supervisorOutcomeOf('no_change: no proposal')).toBeUndefined()
  })
})

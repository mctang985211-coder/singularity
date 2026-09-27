import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  admitReviewAgent,
  countReviewAgentRuns,
  readReviewAgentAttempts,
  reviewAgentLedgerFile,
} from '../../src/review-agent-ledger.ts'
import { installReviewAgentAutoTrigger, scanFailedReviewSources } from '../../src/review-agent-scan.ts'
import type { TerminalReviewFact } from '@dangosys/dsh-singularity-task-runtime'

/**
 * A5: the automatic trigger scans the store's **failed** reviews and admits one
 * default attempt per source under the store's own allowance.
 *
 * What each case pins, all read back from the ledger file and the store:
 *
 * - a failed review is accepted on its own: claim, pre-allocated session and one
 *   reviewer spawn, whose first request names the source and its outcome;
 * - a verified review is left alone — the automatic trigger never spawns for a
 *   source that succeeded;
 * - a failed review that carries no run would be accepted on the `runId: null`
 *   source, exactly as an explicit call names it;
 * - a source that already has an attempt is only read: a settled one by this
 *   pre-read, an open one by the ledger's own decision — which recovers an
 *   attempt whose process is gone and reports that recovery by name — with no
 *   second claim, no second spawn and no further charge either way;
 * - the store's allowance is read only when a *new* attempt would start: a spent
 *   store skips the source by name with zero claim, and a later scan starts the
 *   same source once there is room;
 * - no live root session for the store means nothing can be spawned, and the
 *   skip is named rather than silent.
 *
 * The deployment's own ledger is the real one (`$DSH_HOME/review-agents`); the
 * spawn is a stub standing in for `agent-runtime`'s door, because a reviewer's
 * model input is not this case's subject.
 */

const ROOT = 'root-1'
const STORE = `sg-t-${ROOT}`

function failedReview(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 't1',
    runId: 'r1',
    sessionId: 's-worker',
    outcome: 'failed' as const,
    evidenceRefs: ['ev-1'],
    anomalies: [],
    localizedCause: 'criterion c1 failed',
    logTail: 'boom',
    ...overrides,
  }
}

/** A store with one failed review of `t1#r1`, one verified review of `t3#r3`, and a task that never ran. */
function baseSnapshot() {
  return {
    version: 1 as const,
    id: STORE,
    tasks: [
      {
        taskId: 't1', parentTaskId: undefined, objective: 'Build the feature', depth: 0,
        acceptanceCriteria: [], requestedCapabilities: [], decompositionStatus: 'leaf' as const,
        status: 'failed' as const, runIds: ['r1'], childTaskIds: [],
      },
      {
        taskId: 't3', parentTaskId: undefined, objective: 'Ship the docs', depth: 0,
        acceptanceCriteria: [], requestedCapabilities: [], decompositionStatus: 'leaf' as const,
        status: 'verified' as const, runIds: ['r3'], childTaskIds: [],
      },
    ],
    runs: [
      { runId: 'r1', taskId: 't1', status: 'failed' as const },
      { runId: 'r3', taskId: 't3', status: 'verified' as const },
    ],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [
      failedReview(),
      {
        taskId: 't3',
        runId: 'r3',
        sessionId: 's-docs',
        outcome: 'verified' as const,
        evidenceRefs: ['ev-3'],
        anomalies: [],
        criteria: [{ criterionId: 'c3', verdict: 'pass' as const }],
      },
    ],
    diagnoses: [], obligations: [], capabilities: {},
  }
}

const REPLY = '```json\n'
  + '{"observation":"the run failed its mandatory criterion","conclusion":"the granted skill was never loaded",'
  + '"confidence":"medium",'
  + '"judgements":[{"dimension":"skill_fit","verdict":"inadequate","evidenceRefs":["ev-1"],"rationale":"the skill was never loaded"}]}'
  + '\n```'

/** A reviewer whose answer the case can hold open. */
function handle(reply: string | undefined, options: { hang?: boolean } = {}) {
  const events = reply === undefined
    ? []
    : [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } }]
  return {
    agent: {
      cancel: vi.fn(),
      whenIdle: options.hang === true ? () => new Promise<void>(() => {}) : async () => {},
      session: { snapshotEvents: () => events },
    },
  }
}

/**
 * The deployment plane the scan works against: a mutable store, the dead store's
 * root session as the live parent, and the spawn stub honouring `beforePrompt`.
 */
function fixture(
  spawnImpl: (args: unknown[]) => Promise<unknown> = async args => {
    await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
    return handle(REPLY)
  },
  snapshot = baseSnapshot(),
  liveParent = true,
) {
  const state = { snapshot }
  const spawn = vi.fn(async (...args: unknown[]) => spawnImpl(args))
  const listeners: ((fact: TerminalReviewFact) => void)[] = []
  const events: { event: string; listener: (payload: never) => void }[] = []
  const off = vi.fn()
  const ctx = {
    task: {
      openStore: async (_storeId: string) => structuredClone(state.snapshot),
      snapshotIn: async (_storeId: string) => structuredClone(state.snapshot),
      recordDiagnosisIn: async (_storeId: string, diagnosis: Record<string, unknown>) => {
        state.snapshot.diagnoses.push(structuredClone(diagnosis) as never)
      },
    },
    agentRuntime: { spawn },
    agents: { get: (id: string) => (liveParent ? { id } : undefined) },
    taskRuntime: {
      registerTerminalReviewListener: (listener: (fact: TerminalReviewFact) => void) => {
        listeners.push(listener)
        return off
      },
    },
    on: (event: string, listener: (payload: never) => void) => {
      events.push({ event, listener })
      return vi.fn()
    },
  }
  return { ctx: ctx as unknown as Context, spawn, state, listeners, events, off }
}

function ledgerRows(): Record<string, unknown>[] {
  try {
    return readFileSync(reviewAgentLedgerFile(), 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

function rowsOfKind(kind: string): Record<string, unknown>[] {
  return ledgerRows().filter(row => row.kind === kind)
}

let ledgerDir: string
let previousLedger: string | undefined
let previousBudget: string | undefined

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'review-scan-'))
  previousLedger = process.env.SINGULARITY_REVIEW_LEDGER_DIR
  previousBudget = process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  process.env.SINGULARITY_REVIEW_LEDGER_DIR = ledgerDir
  delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
})

afterEach(() => {
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  if (previousBudget === undefined) delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  else process.env.SINGULARITY_REVIEW_AGENT_BUDGET = previousBudget
  rmSync(ledgerDir, { recursive: true, force: true })
})

describe('the scan of a store\'s failed reviews', () => {
  it('accepts a failed review on its own: claim, session, one reviewer whose first request names the source and its outcome', async () => {
    const { ctx, spawn } = fixture()
    const report = await scanFailedReviewSources(ctx, STORE)

    expect(spawn).toHaveBeenCalledOnce()
    const request = spawn.mock.calls[0]![1] as { prompt: { text: string }[] | string; agentPreset?: string }
    const prompt = Array.isArray(request.prompt) ? request.prompt.map(block => block.text).join('\n') : request.prompt
    // The first request of the reviewer the automatic trigger started: the source
    // it reviews, its real outcome, and the pack the judgement rests on.
    expect(prompt).toContain('review t1#r1 [failed]')
    expect(prompt).toContain('--- review pack ---')
    expect(prompt).toContain('ev-1')

    const claim = rowsOfKind('claim')
    expect(claim).toHaveLength(1)
    expect(claim[0]).toMatchObject({
      formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't1', runId: 'r1',
      requestKey: null, reason: null, actor: ROOT,
    })
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(1)
    expect(report.entries).toEqual([
      expect.objectContaining({ result: 'started', source: { taskId: 't1', runId: 'r1' } }),
    ])
  })

  it('leaves a verified source alone: no claim, no spawn, nothing spent', async () => {
    const snapshot = baseSnapshot()
    snapshot.reviews = snapshot.reviews.filter(review => review.outcome !== 'failed')
    const { ctx, spawn } = fixture(undefined, snapshot as never)

    const report = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerRows()).toEqual([])
    expect(await countReviewAgentRuns(STORE)).toBe(0)
    expect(report.entries).toEqual([])
  })

  it('accepts a failed review that carries no run on the runId:null source', async () => {
    // A store holding a failed review with no run: the source is the no-run one,
    // and the claim records exactly that.
    const snapshot = baseSnapshot()
    snapshot.tasks = [{
      taskId: 't2', parentTaskId: undefined, objective: 'A task the dependency blocked', depth: 0,
      acceptanceCriteria: [], requestedCapabilities: [], decompositionStatus: 'leaf' as const,
      status: 'blocked' as const, runIds: [], childTaskIds: [],
    }] as never
    snapshot.runs = []
    snapshot.reviews = [
      failedReview({ taskId: 't2', runId: undefined, sessionId: undefined, logTail: undefined }),
    ]
    const { ctx, spawn } = fixture(undefined, snapshot as never)

    const report = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).toHaveBeenCalledOnce()
    const request = spawn.mock.calls[0]![1] as { prompt: { text: string }[] | string }
    const prompt = Array.isArray(request.prompt) ? request.prompt.map(block => block.text).join('\n') : request.prompt
    expect(prompt).toContain('review t2#no-run [failed]')
    expect(rowsOfKind('claim')[0]).toMatchObject({ taskId: 't2', runId: null, requestKey: null, reason: null })
    expect(report.entries).toEqual([
      expect.objectContaining({ result: 'started', source: { taskId: 't2', runId: null } }),
    ])
  })

  it('reads a source that already has an attempt instead of claiming a second one', async () => {
    // The attempt an earlier scan (or an explicit call) claimed: same source,
    // default key, no settlement yet — a claim without a started row.
    await admitReviewAgent(STORE, async admission => {
      await admission.claim({
        source: { taskId: 't1', runId: 'r1' },
        requestKey: null,
        reason: null,
        actor: ROOT,
        sessionId: 's-already' as never,
      })
    })
    const rowsBefore = ledgerRows().length
    const { ctx, spawn } = fixture()

    const report = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(0)
    expect(report.entries).toEqual([
      expect.objectContaining({
        result: 'existing',
        source: { taskId: 't1', runId: 'r1' },
        sessionId: 's-already',
      }),
    ])
    // The read costs nothing: no second claim, and the settled fact the recovery
    // appended is not a charge either.
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(ledgerRows().length).toBeLessThanOrEqual(rowsBefore + 1)
    void (await readReviewAgentAttempts(STORE))

    // A repeat scan is the same read, and never a second attempt either.
    const again = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(again.entries[0]).toMatchObject({ result: 'existing', sessionId: 's-already' })
  })

  it('recovers a started attempt whose process is gone, names it, and starts nothing', async () => {
    // The state a process killed after model input left: a claim and a started
    // row nobody is running any more. The scan must not read that as a live
    // attempt forever — and it must not invent a second one for the source
    // either, because the automatic scan never generates a request key.
    writeFileSync(reviewAgentLedgerFile(), [
      JSON.stringify({
        formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't1', runId: 'r1',
        requestKey: null, reason: null, sessionId: 's-orphaned', actor: ROOT, at: '2026-09-26T00:00:00.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', rootStoreId: STORE, taskId: 't1', sessionId: 's-orphaned', actor: ROOT, at: '2026-09-26T00:00:01.000Z',
      }),
      '',
    ].join('\n'), 'utf8')
    const { ctx, spawn } = fixture()
    const lines: string[] = []

    const report = await scanFailedReviewSources(ctx, STORE, { log: line => lines.push(line) })
    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    // The dead attempt is settled once, by name, and the spent run stays spent.
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'interrupted', sessionId: 's-orphaned' })
    expect(await countReviewAgentRuns(STORE)).toBe(1)
    expect(report.entries).toEqual([
      expect.objectContaining({
        result: 'existing',
        source: { taskId: 't1', runId: 'r1' },
        sessionId: 's-orphaned',
      }),
    ])
    expect(report.entries[0]!.reason).toMatch(/interrupted|is gone/)
    expect(lines.join('\n')).toContain('s-orphaned')
    expect(lines.join('\n')).toMatch(/interrupted|is gone/)

    // The recovery is one terminal fact, not one per scan.
    const again = await scanFailedReviewSources(ctx, STORE, { log: () => undefined })
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(again.entries[0]).toMatchObject({ result: 'existing' })
  })

  it('skips a source by name when the store\'s allowance is spent, and starts it once there is room', async () => {
    // The allowance of the store, spent by an attempt for another task: the row
    // is the whole count.
    await admitReviewAgent(STORE, admission => admission.start({ taskId: 't-earlier', sessionId: 's-earlier' as never, actor: ROOT }))
    const { ctx, spawn } = fixture()
    const lines: string[] = []

    const skipped = await scanFailedReviewSources(ctx, STORE, { log: line => lines.push(line) })
    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toEqual([])
    expect(skipped.entries).toEqual([
      expect.objectContaining({ result: 'skipped', source: { taskId: 't1', runId: 'r1' } }),
    ])
    // Named, not silent — and the reason is the allowance, not the source.
    expect(skipped.entries[0]!.reason).toMatch(/budget/i)
    expect(lines.join('\n')).toMatch(/budget/i)
    expect(lines.join('\n')).toContain('t1#r1')

    // Room to start: the same source is accepted on the next scan.
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const started = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(2)
    expect(started.entries[0]).toMatchObject({ result: 'started' })

    // And a repeat never charges the source twice: the attempt it already has is
    // read back, with no new claim and no new started row.
    const repeat = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(2)
    expect(repeat.entries[0]).toMatchObject({ result: 'existing' })
  })

  it('names the missing root session when nothing could be spawned, with zero claim', async () => {
    const { ctx, spawn } = fixture(undefined, baseSnapshot() as never, false)
    const lines: string[] = []

    const report = await scanFailedReviewSources(ctx, STORE, { log: line => lines.push(line) })
    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toEqual([])
    expect(report.entries[0]).toMatchObject({ result: 'skipped' })
    expect(report.entries[0]!.reason).toMatch(new RegExp(ROOT))
    expect(lines.join('\n')).toContain(ROOT)
  })

  it('accepts one source at a time: a scan of two failed sources spends the allowance once and names the other', async () => {
    const snapshot = baseSnapshot()
    snapshot.reviews.push(failedReview({ taskId: 't2', runId: 'r2' }))
    snapshot.tasks.push({
      taskId: 't2', parentTaskId: undefined, objective: 'Ship the other thing', depth: 0,
      acceptanceCriteria: [], requestedCapabilities: [], decompositionStatus: 'leaf' as const,
      status: 'failed' as const, runIds: ['r2'], childTaskIds: [],
    })
    snapshot.runs.push({ runId: 'r2', taskId: 't2', status: 'failed' as const })
    const { ctx, spawn } = fixture(undefined, snapshot as never)

    const report = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(report.entries.map(entry => entry.result)).toEqual(['started', 'skipped'])
    expect(report.entries[1]!.reason).toMatch(/budget/i)
  })
})

describe('the automatic trigger as the assembly installs it', () => {
  it('scans on a recorded failed review and on a graph activation, and never for a success', async () => {
    const { ctx, spawn, listeners, events, off } = fixture()
    const lines: string[] = []
    const dispose = installReviewAgentAutoTrigger(ctx, { log: line => lines.push(line) })

    // One listener on the runtime's terminal-review door, one on the graph
    // activation: the two moments the store is scanned.
    expect(listeners).toHaveLength(1)
    expect(events.map(item => item.event)).toEqual(['graphs/selected'])

    listeners[0]!({ storeId: STORE, taskId: 't1', runId: 'r1', outcome: 'failed' })
    await vi.waitFor(async () => expect(await countReviewAgentRuns(STORE)).toBe(1))
    const claim = rowsOfKind('claim')
    expect(claim).toHaveLength(1)
    expect(claim[0]).toMatchObject({ taskId: 't1', runId: 'r1', requestKey: null, reason: null })

    // A success is not a trigger: the verified source of the same store is left
    // exactly as it was.
    listeners[0]!({ storeId: STORE, taskId: 't3', runId: 'r3', outcome: 'verified' })
    await vi.waitFor(() => expect(rowsOfKind('claim')).toHaveLength(1))
    expect(spawn).toHaveBeenCalledOnce()

    // An activation scans the whole store, and the source that already has an
    // attempt is only read.
    const activation = events[0]!.listener as unknown as (graph: { rootSessionId: string }) => void
    activation({ rootSessionId: ROOT })
    await vi.waitFor(() => expect(lines.some(line => line.includes('t1#r1'))).toBe(true))
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(spawn).toHaveBeenCalledOnce()

    dispose()
    expect(off).toHaveBeenCalledOnce()
  })
})

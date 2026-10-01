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
} from '../../src/coordination/ledger.ts'
import { runReviewAgentAttempt } from '../../src/coordination/review-run.ts'
import { installReviewAgentAutoTrigger, scanFailedReviewSources } from '../../src/coordination/review-scan.ts'
import { configureSupervision } from '../../src/coordination/supervision.ts'
import type { TerminalReviewFact } from '@dangosys/dsh-singularity-task-runtime'

/**
 * A5: the automatic trigger scans the store's **failed** reviews and admits one
 * default attempt per source under the store's own allowance.
 *
 * What each case pins, all read back from the ledger file and the store:
 *
 * - a failed review is accepted on its own: claim, pre-allocated session and one
 *   reviewer spawn, whose first request names the source and its outcome;
 * - a verified review is left alone under `autoReview: 'failed'` and accepted
 *   under `'all'` (its request framed as an improvement question), while
 *   `'off'` scans nothing at all;
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
  const delivered = new Map<string, { messageId: string; targetSessionId: string; text: string }>()
  const relay = vi.fn(async (intent: { messageId: string; targetSessionId: string; text: string }) => {
    if (delivered.has(intent.messageId)) return { messageId: intent.messageId, status: 'already-present' as const }
    delivered.set(intent.messageId, intent)
    return { messageId: intent.messageId, status: 'delivered' as const }
  })
  const listeners: ((fact: TerminalReviewFact) => void)[] = []
  const events: { event: string; listener: (payload: never) => void }[] = []
  const off = vi.fn()
  const ctx = {
    effect: (install: () => () => Promise<void>) => install(),
    task: {
      openStore: async (_storeId: string) => structuredClone(state.snapshot),
      snapshotIn: async (_storeId: string) => structuredClone(state.snapshot),
      recordDiagnosisIn: async (_storeId: string, diagnosis: Record<string, unknown>) => {
        state.snapshot.diagnoses.push(structuredClone(diagnosis) as never)
      },
    },
    agentRuntime: { spawn, ensureAgentMessageDelivered: relay },
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
  return { ctx: ctx as unknown as Context, spawn, relay, delivered, state, listeners, events, off }
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
  // These cases are about the failed-source scan of the automatic trigger: pin
  // the pre-existing behaviour (failures only, one run) unless a case overrides
  // it — a recorded diagnosis still consumes a hand-off, which the store's one
  // run then refuses, so no supervisor is spawned beside the reviewer.
  configureSupervision({ autoReview: 'failed', coordinationBudget: 1 })
})

afterEach(() => {
  configureSupervision(undefined)
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  if (previousBudget === undefined) delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  else process.env.SINGULARITY_REVIEW_AGENT_BUDGET = previousBudget
  rmSync(ledgerDir, { recursive: true, force: true })
})

describe('the scan of a store\'s failed reviews', () => {
  it('routes a blocked source without a run through the batch that admitted it', async () => {
    const snapshot = baseSnapshot()
    snapshot.tasks[0] = { ...snapshot.tasks[0], parentTaskId: 't-parent', runIds: [] } as never
    snapshot.tasks.push({ ...snapshot.tasks[1], taskId: 't-parent', runIds: ['r-parent'] } as never)
    snapshot.runs = [{ runId: 'r-parent', taskId: 't-parent', sessionId: 's-parent', batches: [{ memberTaskIds: ['t1'] }] }] as never
    snapshot.reviews = [failedReview({ runId: undefined })]
    const { ctx, delivered } = fixture(undefined, snapshot)
    await scanFailedReviewSources(ctx, STORE)
    expect([...delivered.values()]).toEqual([expect.objectContaining({ targetSessionId: 's-parent', text: expect.stringContaining('t1#no-run') })])
  })

  it('refuses a missing delegating run instead of delivering to the root', async () => {
    const snapshot = baseSnapshot()
    snapshot.tasks[0] = { ...snapshot.tasks[0], parentTaskId: 't-parent' } as never
    const { ctx, relay } = fixture(undefined, snapshot)
    const report = await scanFailedReviewSources(ctx, STORE)
    expect(report.entries[0]!.reason).toContain('delegating run for parent task t-parent is not recorded')
    expect(relay).not.toHaveBeenCalled()
  })

  it('reports a failed delivery and retries the stored diagnosis without reviewing again', async () => {
    const { ctx, spawn, relay, delivered } = fixture()
    relay.mockRejectedValueOnce(new Error('target session cannot be flushed'))
    const first = await scanFailedReviewSources(ctx, STORE)
    expect(first.entries[0]!.reason).toContain('diagnosis recorded but not delivered (target session cannot be flushed)')
    expect(delivered.size).toBe(0)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded' })

    const second = await scanFailedReviewSources(ctx, STORE)
    expect(second.entries[0]).toMatchObject({ result: 'existing' })
    expect(second.entries[0]).not.toHaveProperty('reason')
    expect(spawn).toHaveBeenCalledOnce()
    expect(delivered.size).toBe(1)
    expect(relay.mock.calls[1]![0]).toEqual(relay.mock.calls[0]![0])
    await scanFailedReviewSources(ctx, STORE)
    expect(delivered.size).toBe(1)
  })

  it('reports an unavailable coordinator and never turns an interrupted review into a message', async () => {
    const { ctx, relay, delivered } = fixture()
    relay.mockResolvedValueOnce({ messageId: 'unused', status: 'unavailable' } as never)
    const report = await scanFailedReviewSources(ctx, STORE)
    expect(report.entries[0]!.reason).toContain('coordinator session root-1 is unavailable')
    expect(delivered.size).toBe(0)
    await scanFailedReviewSources(ctx, STORE)
    expect(delivered.size).toBe(1)

    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const silent = fixture(async args => {
      await (args[1] as { beforePrompt: () => Promise<void> }).beforePrompt()
      return handle(undefined)
    }, { ...baseSnapshot(), id: 'sg-t-silent' } as never)
    const failed = await scanFailedReviewSources(silent.ctx, 'sg-t-silent')
    expect(failed.entries[0]).toMatchObject({ result: 'failed', reason: 'the reviewer returned no output' })
    expect(silent.relay).not.toHaveBeenCalled()
  })

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

  it('leaves a verified source alone under autoReview "failed": no claim, no spawn, nothing spent', async () => {
    const snapshot = baseSnapshot()
    snapshot.reviews = snapshot.reviews.filter(review => review.outcome !== 'failed')
    const { ctx, spawn } = fixture(undefined, snapshot as never)

    const report = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerRows()).toEqual([])
    expect(await countReviewAgentRuns(STORE)).toBe(0)
    expect(report.entries).toEqual([])
  })

  it('accepts a verified source under autoReview "all" and frames the review as an improvement question', async () => {
    configureSupervision({ autoReview: 'all', coordinationBudget: 1 })
    const snapshot = baseSnapshot()
    snapshot.reviews = snapshot.reviews.filter(review => review.outcome !== 'failed')
    const { ctx, spawn } = fixture(undefined, snapshot as never)

    const report = await scanFailedReviewSources(ctx, STORE)
    expect(spawn).toHaveBeenCalledOnce()
    const request = spawn.mock.calls[0]![1] as { prompt: { text: string }[] | string }
    const prompt = Array.isArray(request.prompt) ? request.prompt.map(block => block.text).join('\n') : request.prompt
    expect(prompt).toContain('review t3#r3 [verified]')
    expect(prompt).toContain('The run passed its review; look for improvement opportunities')
    expect(rowsOfKind('claim')[0]).toMatchObject({ taskId: 't3', runId: 'r3', requestKey: null, reason: null })
    expect(report.entries).toEqual([
      expect.objectContaining({ result: 'started', source: { taskId: 't3', runId: 'r3' } }),
    ])
  })

  it('accepts nothing under autoReview "off": no claim, no spawn, no line', async () => {
    configureSupervision({ autoReview: 'off' })
    const { ctx, spawn } = fixture()
    const lines: string[] = []

    const report = await scanFailedReviewSources(ctx, STORE, { log: line => lines.push(line) })
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerRows()).toEqual([])
    expect(report.entries).toEqual([])
    expect(lines).toEqual([])
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

  it('reads the default attempt a live reviewer already holds, whatever focus it was named with', async () => {
    // The source's default attempt, admitted explicitly with a focus of its own
    // and really running in this process (claim + started, so the ledger holds it
    // as live). The scan meets an attempt that exists — and must read it instead
    // of asking for the same key with a focus of its own invention.
    await admitReviewAgent(STORE, async admission => {
      await admission.claim({
        source: { taskId: 't1', runId: 'r1' },
        requestKey: null,
        reason: 'focus',
        actor: ROOT,
        sessionId: 's-focus' as never,
      })
      await admission.start({ taskId: 't1', sessionId: 's-focus' as never, actor: ROOT })
    })
    const { ctx, spawn } = fixture()
    const lines: string[] = []

    const report = await scanFailedReviewSources(ctx, STORE, { log: line => lines.push(line) })
    expect(spawn).not.toHaveBeenCalled()
    expect(report.entries).toEqual([
      { source: { taskId: 't1', runId: 'r1' }, result: 'existing', sessionId: 's-focus' },
    ])
    expect(report.entries[0]).not.toHaveProperty('reason')
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(rowsOfKind('settled')).toHaveLength(0)
    expect(await countReviewAgentRuns(STORE)).toBe(1)
    // Named as the attempt it read, never as a source refused for a different
    // focus — nothing was refused here and nothing was written.
    expect(lines.join('\n')).toContain('s-focus')
    expect(lines.join('\n')).not.toMatch(/different focus|conflict/i)
  })

  it('still refuses an explicit call that re-focuses an existing default attempt', async () => {
    // The other half of the rule the scan now honours: the ledger's conflict
    // check is untouched, so an explicit call naming the same key with another
    // focus is refused by name — with no claim, no start and no spawn.
    const { ctx, spawn } = fixture()
    await admitReviewAgent(STORE, async admission => {
      await admission.claim({
        source: { taskId: 't1', runId: 'r1' },
        requestKey: null,
        reason: 'focus',
        actor: ROOT,
        sessionId: 's-focus' as never,
      })
      await admission.start({ taskId: 't1', sessionId: 's-focus' as never, actor: ROOT })
    })
    const rowsBefore = ledgerRows().length

    const outcome = await runReviewAgentAttempt({
      ctx,
      storeId: STORE,
      source: { taskId: 't1', runId: 'r1' },
      review: baseSnapshot().reviews[0]! as never,
      parent: (ctx as unknown as { agents: { get(id: string): unknown } }).agents.get(ROOT) as never,
      actor: ROOT,
      requestKey: null,
      reason: 'other',
    })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') throw new Error('unreachable')
    expect(outcome.plan.code).toBe('request-key-conflict')
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerRows().length).toBe(rowsBefore)
  })

  it('follows the newest open attempt of a source, never the settled one that came before it', async () => {
    // A process that died twice over one source: the default attempt was
    // recorded earlier, and the explicit `k1` attempt after it was claimed and
    // started and never settled. The scan has to accept the source on the open
    // attempt it finds last — recovering that same identity — instead of reading
    // the older settled one and leaving `k1` open forever.
    writeFileSync(reviewAgentLedgerFile(), [
      JSON.stringify({
        formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't1', runId: 'r1',
        requestKey: null, reason: null, sessionId: 's-default', actor: ROOT, at: '2026-09-26T00:00:00.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', rootStoreId: STORE, taskId: 't1', sessionId: 's-default', actor: ROOT, at: '2026-09-26T00:00:01.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'settled', rootStoreId: STORE, taskId: 't1', sessionId: 's-default', status: 'recorded', at: '2026-09-26T00:00:02.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't1', runId: 'r1',
        requestKey: 'k1', reason: null, sessionId: 's-k1', actor: ROOT, at: '2026-09-26T00:00:03.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', rootStoreId: STORE, taskId: 't1', sessionId: 's-k1', actor: ROOT, at: '2026-09-26T00:00:04.000Z',
      }),
      '',
    ].join('\n'), 'utf8')
    const { ctx, spawn } = fixture()
    const lines: string[] = []

    const report = await scanFailedReviewSources(ctx, STORE, { log: line => lines.push(line) })
    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toHaveLength(2)
    // The spent run stays spent: the recovery of `k1` writes no started row.
    expect(rowsOfKind('started')).toHaveLength(2)
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(2)
    expect(settled.filter(row => row.sessionId === 's-k1')).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ])
    expect(await countReviewAgentRuns(STORE)).toBe(2)
    expect(report.entries).toEqual([
      {
        source: { taskId: 't1', runId: 'r1' },
        result: 'existing',
        sessionId: 's-k1',
        reason: expect.stringMatching(/interrupted|is gone/),
      },
    ])
    expect(lines.join('\n')).toContain('s-k1')
    expect(lines.join('\n')).toContain('interrupted')

    // The recovery is one terminal fact: the repeat scan reads `k1` settled, the
    // ledger grows no further and the source is still never re-reviewed.
    const rowsAfter = ledgerRows().length
    const again = await scanFailedReviewSources(ctx, STORE, { log: () => undefined })
    expect(spawn).not.toHaveBeenCalled()
    expect(again.entries).toEqual([
      { source: { taskId: 't1', runId: 'r1' }, result: 'existing', sessionId: 's-k1' },
    ])
    expect(rowsOfKind('claim')).toHaveLength(2)
    expect(rowsOfKind('started')).toHaveLength(2)
    expect(rowsOfKind('settled')).toHaveLength(2)
    expect(ledgerRows().length).toBe(rowsAfter)
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
  it('scans on a recorded failed review and on a graph activation, and never for a success under "failed"', async () => {
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

    // Under "failed" a success is not a trigger: the verified source of the same
    // store is left exactly as it was.
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

  it('scans on a verified review too under "all"', async () => {
    configureSupervision({ autoReview: 'all', coordinationBudget: 2 })
    const all = fixture(async args => {
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return handle(undefined)
    })
    const dispose = installReviewAgentAutoTrigger(all.ctx, { log: () => undefined })
    all.listeners[0]!({ storeId: STORE, taskId: 't1', runId: 'r1', outcome: 'failed' })
    await vi.waitFor(async () => expect(await countReviewAgentRuns(STORE)).toBe(1))
    all.listeners[0]!({ storeId: STORE, taskId: 't3', runId: 'r3', outcome: 'verified' })
    await vi.waitFor(async () => expect(await countReviewAgentRuns(STORE)).toBe(2))
    expect(rowsOfKind('claim').map(row => `${String(row.taskId)}#${String(row.runId)}`)).toEqual(['t1#r1', 't3#r3'])
    dispose()
  })

  it('scans nothing under "off"', async () => {
    configureSupervision({ autoReview: 'off' })
    const { ctx, spawn, listeners, events } = fixture()
    const lines: string[] = []
    const dispose = installReviewAgentAutoTrigger(ctx, { log: line => lines.push(line) })
    listeners[0]!({ storeId: STORE, taskId: 't1', runId: 'r1', outcome: 'failed' })
    listeners[0]!({ storeId: STORE, taskId: 't3', runId: 'r3', outcome: 'verified' })
    const activation = events[0]!.listener as unknown as (graph: { rootSessionId: string }) => void
    activation({ rootSessionId: ROOT })
    await vi.waitFor(() => expect(lines.length).toBe(0))
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerRows()).toEqual([])
    dispose()
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  countReviewAgentRuns,
  readReviewerDelegation,
  reviewAgentLedgerFile,
} from '../../src/coordination/ledger.ts'
import { defineTaskReviewAgentTool } from '../../src/tools/review-agent.ts'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'

/**
 * A5: one exact review source, one attempt identity.
 *
 * `task_review_agent({taskId, runId, reason?, requestKey?})` names its source —
 * the run, or `null` for the no-run case — and never falls back to "the latest
 * review". The ledger holds the attempts of one source: a claim written before
 * the spawn, the started row the spawn's `beforePrompt` writes, and the settled
 * fact the attempt ends with. The decisions this spec pins, all read back from
 * the ledger file and the store:
 *
 * - the declaration gate requires `runId`; a source that does not exist, a run
 *   that is not the task's, or a task outside the caller's store start nothing;
 * - a repeat of the same source (same key, same focus) returns the existing
 *   attempt — after a restart too — and never writes a second claim, started
 *   row or spawn;
 * - a different focus for an existing key is a named conflict;
 * - a new key while an attempt is open is not accepted and starts nothing;
 * - a new key after the attempt settled starts a new attempt (budget allowing);
 * - dedupe is decided before the budget: a spent store still answers a repeat,
 *   while a new source is refused by name with zero claim and zero spawn;
 * - a crash leaves the attempt at the same identity: a claim without started is
 *   recorded interrupted, and so is a *started* attempt no process is running any
 *   more — never re-spawned, never re-counted, and never an in-flight dead end
 *   for the source's next explicit request;
 * - an attempt whose diagnosis the store already holds is recovered `recorded`,
 *   whatever the ledger is missing.
 */

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

/** The caller's root store, as the tool's graph resolves to. */
const STORE = 'sg-t-root-1'

/** The escalation signal under the rules of the day: a failed review with a cause. */
const failedReview = {
  taskId: 't1',
  runId: 'r1',
  sessionId: 's-worker',
  outcome: 'failed' as const,
  evidenceRefs: ['ev-1'],
  anomalies: [],
  localizedCause: 'criterion c1 failed',
  logTail: 'boom',
}

/** A task that was blocked before any run started: its review carries no run. */
const blockedReview = {
  taskId: 't2',
  outcome: 'blocked' as const,
  evidenceRefs: [],
  anomalies: ['dependencies [t1] did not verify'],
  blockedBy: [{ taskId: 't1', outcome: 'failed' as const }],
}

function baseSnapshot() {
  return {
    version: 1 as const,
    id: STORE,
    tasks: [
      {
        taskId: 't1', parentTaskId: undefined, objective: 'Build the feature', depth: 0,
        acceptanceCriteria: [], requestedCapabilities: [], decompositionStatus: 'leaf' as const,
        status: 'failed' as const, runIds: ['r1', 'r1b'], childTaskIds: [],
      },
      {
        taskId: 't2', parentTaskId: 't1', objective: 'A task the dependency blocked', depth: 1,
        acceptanceCriteria: [], requestedCapabilities: [], decompositionStatus: 'leaf' as const,
        status: 'blocked' as const, runIds: [], childTaskIds: [],
      },
    ],
    // `r1b` is a run of t1 that never settled a review: the source that must not
    // resolve through anything else.
    runs: [
      { runId: 'r1', taskId: 't1', status: 'failed' as const },
      { runId: 'r1b', taskId: 't1', status: 'failed' as const },
    ],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [failedReview, blockedReview],
    diagnoses: [], obligations: [], capabilities: {},
  }
}

const REPLY = '```json\n'
  + '{"observation":"the run failed its mandatory criterion","conclusion":"the granted skill was never loaded",'
  + '"confidence":"medium",'
  + '"judgements":[{"dimension":"skill_fit","verdict":"inadequate","evidenceRefs":["ev-1"],"rationale":"the skill was never loaded"}]}'
  + '\n```'

/** A reviewer whose output the test can hold open, so an attempt can be observed mid-flight. */
function handle(reply: string | undefined, options: { hang?: boolean } = {}) {
  const cancel = vi.fn()
  const events = reply === undefined
    ? []
    : [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } }]
  return {
    agent: {
      cancel,
      whenIdle: options.hang === true ? () => new Promise<void>(() => {}) : async () => {},
      session: { snapshotEvents: () => events },
    },
  }
}

/**
 * The deployment plane the tool works against: a mutable store (so a recorded
 * diagnosis is really there for the next call), the graph the caller belongs to,
 * and the spawn stub honoring the agent-runtime's `beforePrompt` contract.
 */
function fixture(spawnImpl: (args: unknown[]) => Promise<unknown>, snapshot = baseSnapshot()) {
  const state = { snapshot }
  const spawn = vi.fn(async (...args: unknown[]) => spawnImpl(args))
  const ctx = {
    effect: (install: () => () => Promise<void>) => install(),
    graphs: { graphForSession: async (_sessionId: string) => graph },
    task: {
      openStore: async (_storeId: string) => structuredClone(state.snapshot),
      snapshotIn: async (_storeId: string) => structuredClone(state.snapshot),
      recordDiagnosisIn: async (_storeId: string, diagnosis: Record<string, unknown>) => {
        state.snapshot.diagnoses.push(structuredClone(diagnosis) as never)
      },
    },
    agentRuntime: { spawn },
  }
  return { ctx: ctx as unknown as Context, spawn, state }
}

/** A spawn that runs the runtime's `beforePrompt` before handing the handle back, exactly as agent-runtime does. */
function spawning(value: unknown) {
  return async (args: unknown[]) => {
    await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
    return value
  }
}

const exec = { agent: { id: 'root-1' }, signal: new AbortController().signal }

function ledgerText(): string {
  try {
    return readFileSync(reviewAgentLedgerFile(), 'utf8')
  } catch {
    return ''
  }
}

function ledgerRows(): Record<string, unknown>[] {
  return ledgerText().split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

function rowsOfKind(kind: string): Record<string, unknown>[] {
  return ledgerRows().filter(row => row.kind === kind)
}

/** Let a promise that settles on the next ticks settle, without waiting on a timer. */
const settle = async () => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve()
}

let ledgerDir: string
let previousLedger: string | undefined
let previousBudget: string | undefined

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'review-attempts-'))
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

describe('the exact source one call names', () => {
  test('runId is required: a call without it is refused before the body runs', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)

    await expect(tool.execute({ taskId: 't1' }, exec as never)).rejects.toThrow(/missing required property "runId"/)
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerText()).toBe('')
  })

  test('runId: null reviews the no-run source, and the claim records that source exactly', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't2', runId: null }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    const request = spawn.mock.calls[0]![1] as { prompt: { text: string }[] | string }
    const prompt = Array.isArray(request.prompt) ? request.prompt.map(block => block.text).join('\n') : request.prompt
    expect(prompt).toContain('t2#no-run')
    expect(result).toContain('judged task t2')

    const claim = rowsOfKind('claim')
    expect(claim).toHaveLength(1)
    expect(claim[0]).toMatchObject({ formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't2', runId: null, requestKey: null, reason: null, actor: 'root-1' })
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(1)
  })

  test('the source is the run the caller names, never the latest review', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const result = (await defineTaskReviewAgentTool(ctx).execute(
      { taskId: 't1', runId: 'r1', reason: 'the failure left no evidence' },
      exec as never,
    )) as string

    expect(spawn).toHaveBeenCalledOnce()
    expect(result).toContain('t1#r1')
    const claim = rowsOfKind('claim')[0]!
    expect(claim).toMatchObject({ taskId: 't1', runId: 'r1', requestKey: null, reason: 'the failure left no evidence' })
    // The reason is persisted, not merely passed along: it is the review focus a
    // later attempt for the same source has to agree with.
    expect(await readReviewerDelegation(String(claim.sessionId))).toMatchObject({ rootStoreId: STORE, taskId: 't1' })
  })

  test('a source with no review record, a run of another task, and an unknown task all refuse with zero claim and zero spawn', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)

    const noReview = (await tool.execute({ taskId: 't1', runId: 'r1b' }, exec as never)) as string
    expect(noReview).toContain('no review record for source t1#r1b')
    expect(noReview).toContain('no review agent started')

    const wrongRun = (await tool.execute({ taskId: 't2', runId: 'r1' }, exec as never)) as string
    expect(wrongRun).toContain('run "r1" is not a run of task "t2"')
    expect(wrongRun).toContain('no review agent started')

    const unknownTask = (await tool.execute({ taskId: 't-nope', runId: 'r1' }, exec as never)) as string
    expect(unknownTask).toContain('unknown task "t-nope"')
    expect(unknownTask).toContain(STORE)

    const unknownRun = (await tool.execute({ taskId: 't1', runId: 'r-nope' }, exec as never)) as string
    expect(unknownRun).toContain('run "r-nope" is not a run of task "t1"')

    // Nothing was claimed, started or spawned by any of the four refusals.
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerText()).toBe('')
  })
})

describe('the source attempt: claim, started, settled', () => {
  test('a repeat of the same source returns the same attempt, the same result, and no second started row', async () => {
    const { ctx, spawn, state } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(first).toContain('judged task t1')
    const session = String(rowsOfKind('claim')[0]!.sessionId)
    expect(first).toContain(session)

    const again = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(spawn).toHaveBeenCalledOnce()
    expect(again).toContain('already has this attempt')
    expect(again).toContain('no review agent started')
    expect(again).toContain(session)
    // The same result: the diagnosis the first attempt recorded, read back.
    expect(again).toContain('skill_fit: inadequate')
    expect(again).toContain(`diagnosis review-agent-${session}`)
    expect(again).not.toContain('budget exhausted')

    // One claim, one started row, one settled fact — and one diagnosis.
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded', sessionId: session })
    expect(state.snapshot.diagnoses).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(1)
  })

  test('a restart answers the repeat from the ledger: same attempt, same session, no new side effect', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)
    const first = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(first).toContain('judged task t1')
    const session = String(rowsOfKind('claim')[0]!.sessionId)
    const rowsBefore = ledgerRows().length

    // A fresh process: no module state, the same ledger file and the same store.
    vi.resetModules()
    const restarted = await import('../../src/tools/review-agent.ts')
    const again = (await restarted.defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    expect(again).toContain(session)
    expect(again).toContain('already has this attempt')
    expect(ledgerRows()).toHaveLength(rowsBefore)
    expect(await countReviewAgentRuns(STORE)).toBe(1)
  })

  test('a repeat that changes the focus is a named conflict: no claim, no spawn, nothing overwritten', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)
    const first = (await tool.execute({ taskId: 't1', runId: 'r1', reason: 'the failure left no evidence' }, exec as never)) as string
    expect(first).toContain('judged task t1')
    const session = String(rowsOfKind('claim')[0]!.sessionId)
    const rowsBefore = ledgerRows().length

    const changed = (await tool.execute({ taskId: 't1', runId: 'r1', reason: 'check the decomposition instead' }, exec as never)) as string
    expect(changed).toContain('different reason')
    expect(changed).toContain('the failure left no evidence')
    expect(changed).toContain(session)
    expect(changed).toContain('no review agent started')
    expect(spawn).toHaveBeenCalledOnce()
    expect(ledgerRows()).toHaveLength(rowsBefore)
  })

  test('a new key after the attempt settled starts a new attempt, and the same key retries reuse it', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(first).toContain('judged task t1')
    const defaultSession = String(rowsOfKind('claim')[0]!.sessionId)

    const second = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k1', reason: 'a second look after the fix' },
      exec as never,
    )) as string
    expect(second).toContain('judged task t1')
    expect(spawn).toHaveBeenCalledTimes(2)
    const claims = rowsOfKind('claim')
    expect(claims).toHaveLength(2)
    expect(claims[1]).toMatchObject({ requestKey: 'k1', reason: 'a second look after the fix', runId: 'r1', taskId: 't1' })
    expect(claims[1]!.sessionId).not.toBe(defaultSession)
    expect(rowsOfKind('started')).toHaveLength(2)
    expect(await countReviewAgentRuns(STORE)).toBe(2)

    const retry = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k1', reason: 'a second look after the fix' },
      exec as never,
    )) as string
    expect(retry).toContain('already has this attempt')
    expect(retry).toContain(String(claims[1]!.sessionId))
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(rowsOfKind('claim')).toHaveLength(2)

    const conflicting = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k1', reason: 'a different focus',
    }, exec as never)) as string
    expect(conflicting).toContain('different reason')
    expect(conflicting).toContain('a second look after the fix')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  test('an explicit key on a source with no attempt starts the attempt it names, and reuses it on a retry', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k7', reason: 'the only review this source will get' },
      exec as never,
    )) as string
    expect(first).toContain('judged task t1')
    expect(spawn).toHaveBeenCalledOnce()
    const claim = rowsOfKind('claim')[0]!
    expect(claim).toMatchObject({ requestKey: 'k7', runId: 'r1', taskId: 't1' })

    const retry = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k7', reason: 'the only review this source will get' },
      exec as never,
    )) as string
    expect(retry).toContain('already has this attempt')
    expect(retry).toContain('requestKey "k7"')
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
  })

  test('a new key while the attempt is in flight returns that identity and starts nothing', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const parked = Promise.withResolvers<void>()
    const reviewer = handle(REPLY)
    const { ctx, spawn } = fixture(async args => {
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return { agent: { ...reviewer.agent, whenIdle: () => parked.promise } }
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const running = tool.execute({ taskId: 't1', runId: 'r1' }, exec as never) as Promise<string>
    // The claim and the started row are durable while the reviewer is still out
    // there: that is the window a parallel request must not start another one in.
    for (let tick = 0; tick < 200 && rowsOfKind('started').length === 0; tick += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(rowsOfKind('started')).toHaveLength(1)
    const session = String(rowsOfKind('claim')[0]!.sessionId)

    const refused = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k1', reason: 'a second opinion' },
      exec as never,
    )) as string
    expect(refused).toContain('in flight')
    expect(refused).toContain(session)
    expect(refused).toContain('the new request was not accepted')
    expect(refused).toContain('no review agent started')
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
    // An attempt this process is really running is never recovered: it is held,
    // not written off, however long the reviewer takes.
    expect(rowsOfKind('settled')).toEqual([])

    parked.resolve()
    expect(await running).toContain('judged task t1')
    expect(rowsOfKind('settled')).toHaveLength(1)
  })

  test('the allowance spent still answers a repeat, and refuses a new source with zero claim and zero spawn', async () => {
    // The env override pins the allowance to the one run this case spends.
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '1'
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(first).toContain('judged task t1')
    const rowsBefore = ledgerRows().length

    const again = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(again).toContain('already has this attempt')
    expect(again).not.toContain('budget exhausted')
    expect(again).toContain('diagnosis review-agent-')

    const other = (await tool.execute({ taskId: 't2', runId: null }, exec as never)) as string
    expect(other).toContain('budget exhausted')
    expect(other).toContain('1/1')
    expect(other).toContain(STORE)
    expect(other).toContain('no review agent started')
    expect(spawn).toHaveBeenCalledOnce()
    expect(ledgerRows()).toHaveLength(rowsBefore)
  })

  test('a spawn that failed before its started row leaves the source at an interrupted attempt, not a second one', async () => {
    let attempts = 0
    const { ctx, spawn } = fixture(async args => {
      attempts += 1
      if (attempts === 1) throw new Error('Unknown agent preset: singularity-reviewer')
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return handle(REPLY)
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const failed = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(failed).toContain('spawn failed')
    expect(failed).toContain('interrupted')
    const session = String(rowsOfKind('claim')[0]!.sessionId)
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(0)
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted', sessionId: session })
    // The failed spawn spent nothing: no started row counts against the store.
    expect(await countReviewAgentRuns(STORE)).toBe(0)

    const again = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(again).toContain('interrupted')
    expect(again).toContain(session)
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
  })
})

describe('what a crash leaves behind', () => {
  /** A claim row exactly as the claim door writes it — the fact a process that died left. */
  const claimRow = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
    formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't1', runId: 'r1',
    requestKey: null, reason: null, sessionId, actor: 'root-1', at: '2026-09-26T00:00:00.000Z', ...overrides,
  })
  const startedRow = (sessionId: string) => ({
    formatVersion: 2, kind: 'started', rootStoreId: STORE, taskId: 't1', sessionId, actor: 'root-1', at: '2026-09-26T00:00:01.000Z',
  })

  test('a claim whose process never reached model input: the same identity, recorded interrupted, nothing spawned', async () => {
    writeFileSync(reviewAgentLedgerFile(), `${JSON.stringify(claimRow('s-crashed'))}\n`)
    const { ctx, spawn, state } = fixture(spawning(handle(REPLY)))
    vi.resetModules()
    const restarted = await import('../../src/tools/review-agent.ts')

    const result = (await restarted.defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(result).toContain('s-crashed')
    expect(result).toContain('interrupted')
    expect(result).toContain('no review agent started')

    expect(spawn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(0)
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'interrupted', sessionId: 's-crashed' })
    expect(state.snapshot.diagnoses).toEqual([])
    expect(await countReviewAgentRuns(STORE)).toBe(0)

    // The same call again changes nothing: the identity is the source's attempt,
    // and its interruption is not written twice.
    const again = (await restarted.defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(again).toContain('s-crashed')
    expect(rowsOfKind('settled')).toHaveLength(1)
  })

  test('a started attempt whose process is gone is recovered: the default repeat reads it back, and its spent run is not refunded', async () => {
    // The state a process killed after model input left: the claim, the started
    // row that spent the store's one run, and no terminal fact — the attempt is
    // not being run by anybody any more.
    writeFileSync(reviewAgentLedgerFile(), `${JSON.stringify(claimRow('s-orphan'))}\n${JSON.stringify(startedRow('s-orphan'))}\n`)
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    vi.resetModules()
    const restarted = await import('../../src/tools/review-agent.ts')
    const tool = restarted.defineTaskReviewAgentTool(ctx)

    const readback = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(readback).toContain('s-orphan')
    expect(readback).toContain('already has this attempt')
    expect(readback).toContain('interrupted')
    expect(readback).not.toContain('in flight')
    expect(readback).toContain('no review agent started')
    // The recovery is one terminal fact, the run stays spent, and nothing was
    // re-spawned or re-charged for the identity that already reached model input.
    expect(spawn).not.toHaveBeenCalled()
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'interrupted', sessionId: 's-orphan' })
    expect(String(settled[0]!.note)).toContain('is gone')
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(1)

    // A repeat is the same read: the recovery is not written twice.
    const again = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(again).toContain('s-orphan')
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('a new requestKey against a started attempt whose process is gone is accepted, not an in-flight dead end', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    writeFileSync(reviewAgentLedgerFile(), `${JSON.stringify(claimRow('s-orphan'))}\n${JSON.stringify(startedRow('s-orphan'))}\n`)
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    vi.resetModules()
    const restarted = await import('../../src/tools/review-agent.ts')
    const tool = restarted.defineTaskReviewAgentTool(ctx)

    const result = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k1', reason: 'a fresh look after the crash' },
      exec as never,
    )) as string
    // The dead attempt no longer stands in the way: it is recovered, and the new
    // key — with the allowance to spend — is the attempt this call starts.
    expect(result).not.toContain('in flight')
    expect(result).not.toContain('the new request was not accepted')
    expect(result).toContain('judged task t1')
    expect(spawn).toHaveBeenCalledOnce()

    const claims = rowsOfKind('claim')
    expect(claims).toHaveLength(2)
    expect(claims[0]).toMatchObject({ sessionId: 's-orphan', requestKey: null })
    expect(claims[1]).toMatchObject({ requestKey: 'k1', reason: 'a fresh look after the crash', runId: 'r1' })
    expect(rowsOfKind('started')).toHaveLength(2)
    const settled = rowsOfKind('settled')
    expect(settled[0]).toMatchObject({ status: 'interrupted', sessionId: 's-orphan' })
    expect(settled[1]).toMatchObject({ status: 'recorded', sessionId: claims[1]!.sessionId })
    // The recovered attempt's run is spent and is not refunded: two spent runs,
    // one of them the dead attempt's own.
    expect(await countReviewAgentRuns(STORE)).toBe(2)
  })

  test('a recorded attempt whose terminal write was lost is read back as recorded, not as interrupted', async () => {
    // The process died between the diagnosis and the terminal fact: the store
    // holds the diagnosis of an attempt whose ledger row is still open. What the
    // store holds decides — the attempt ended `recorded`.
    const sessionId = 's-recorded'
    const diagnosis = {
      diagnosisId: `review-agent-${sessionId}`,
      taskId: 't1',
      observedFailure: 'the run failed its mandatory criterion',
      scope: 'task t1',
      localizedCause: 'the skill was never loaded',
      evidenceRefs: ['ev-1'],
      reviewRefs: ['t1#r1'],
      confidence: 'medium' as const,
      proposals: [],
      producedBy: { kind: 'agent' as const, sessionId },
      judgements: [{ dimension: 'skill_fit' as const, verdict: 'inadequate' as const, evidenceRefs: ['ev-1'], rationale: 'the skill was never loaded' }],
    }
    const snapshot = baseSnapshot()
    snapshot.diagnoses = [diagnosis] as never
    writeFileSync(reviewAgentLedgerFile(), `${JSON.stringify(claimRow(sessionId))}\n${JSON.stringify(startedRow(sessionId))}\n`)
    const { ctx, spawn } = fixture(spawning(handle(REPLY)), snapshot)
    vi.resetModules()
    const restarted = await import('../../src/tools/review-agent.ts')

    const result = (await restarted.defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(result).toContain(sessionId)
    expect(result).toContain('recorded')
    expect(result).toContain('the skill was never loaded')
    expect(spawn).not.toHaveBeenCalled()
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'recorded', sessionId })
    expect(await countReviewAgentRuns(STORE)).toBe(1)
  })

  test('a new key against a claim whose process never reached model input is accepted, after the dead attempt is recorded', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    writeFileSync(reviewAgentLedgerFile(), `${JSON.stringify(claimRow('s-dead'))}\n`)
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    vi.resetModules()
    const restarted = await import('../../src/tools/review-agent.ts')
    const tool = restarted.defineTaskReviewAgentTool(ctx)

    // The claim nobody is running is settled first, and the key this request
    // names is then decided on its own merits — an attempt that never reached
    // model input does not block the source, and it spent nothing either.
    const first = (await tool.execute(
      { taskId: 't1', runId: 'r1', requestKey: 'k1', reason: 'a second look' },
      exec as never,
    )) as string
    expect(first).not.toContain('the new request was not accepted')
    expect(first).toContain('judged task t1')
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(2)
    expect(rowsOfKind('claim')[1]).toMatchObject({ requestKey: 'k1', runId: 'r1' })
    expect(rowsOfKind('started')).toHaveLength(1)
    const settled = rowsOfKind('settled')
    expect(settled[0]).toMatchObject({ status: 'interrupted', sessionId: 's-dead' })
    expect(settled[1]).toMatchObject({ status: 'recorded', sessionId: rowsOfKind('claim')[1]!.sessionId })
    expect(await countReviewAgentRuns(STORE)).toBe(1)

    // The source's default attempt reads back as the interrupted attempt it is.
    const readback = (await tool.execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(readback).toContain('s-dead')
    expect(readback).toContain('interrupted')
    expect(readback).not.toContain('in flight')
    expect(spawn).toHaveBeenCalledOnce()
  })
})

describe('the ledger as the reviewer binding source, with attempt rows in it', () => {
  const startedRow = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
    formatVersion: 2, kind: 'started', rootStoreId: STORE, taskId: 't1', sessionId, actor: 'root-1', at: '2026-09-26T00:00:01.000Z',
    ...overrides,
  })

  test('a claim alone is not a delegation: the binding is the started fact', async () => {
    writeFileSync(reviewAgentLedgerFile(), `${JSON.stringify({
      formatVersion: 2, kind: 'claim', rootStoreId: STORE, taskId: 't1', runId: 'r1',
      requestKey: null, reason: null, sessionId: 's-claimed', actor: 'root-1', at: '2026-09-26T00:00:00.000Z',
    })}\n`)
    expect(await readReviewerDelegation('s-claimed')).toBeUndefined()
    // …and it is not a spent run either.
    expect(await countReviewAgentRuns(STORE)).toBe(0)
  })

  test('the three states of the read hold for attempt rows too', async () => {
    writeFileSync(reviewAgentLedgerFile(), [
      JSON.stringify(startedRow('s-one')),
      JSON.stringify(startedRow('s-two')),
      JSON.stringify(startedRow('s-two', { rootStoreId: 'sg-t-other', taskId: 't9' })),
      '',
    ].join('\n'))
    expect(await readReviewerDelegation('s-one')).toMatchObject({ rootStoreId: STORE, taskId: 't1', actor: 'root-1' })
    expect(await readReviewerDelegation('s-none')).toBeUndefined()
    await expect(readReviewerDelegation('s-two')).rejects.toMatchObject({ kind: 'binding-conflict' })
    // Two started rows in this store (the third row belongs to another one).
    expect(await countReviewAgentRuns(STORE)).toBe(2)
  })
})

describe('task_review_pack on one exact source', () => {
  test('runId is required, and a source the store does not hold is refused by name', async () => {
    const { ctx } = fixture(spawning(handle(REPLY)))
    const tool = defineTaskReviewPackTool(ctx)
    await expect(tool.execute({ taskId: 't1' }, exec as never)).rejects.toThrow(/missing required property "runId"/)

    const missing = (await tool.execute({ taskId: 't1', runId: 'r1b' }, exec as never)) as string
    expect(missing).toContain('no review record for source t1#r1b')
    expect(missing).toContain(STORE)
  })

  test('names the source it packs and the attempts the ledger holds for it', async () => {
    const { ctx, spawn } = fixture(spawning(handle(REPLY)))
    const review = defineTaskReviewAgentTool(ctx)
    await review.execute({ taskId: 't1', runId: 'r1', reason: 'what the pack must show' }, exec as never)
    expect(spawn).toHaveBeenCalledOnce()
    const session = String(rowsOfKind('claim')[0]!.sessionId)

    const pack = (await defineTaskReviewPackTool(ctx).execute({ taskId: 't1', runId: 'r1' }, exec as never)) as string
    expect(pack).toContain('source: review t1#r1 [failed]')
    expect(pack).toContain('review attempts (1):')
    expect(pack).toContain(`default attempt ${session} [recorded]`)
    expect(pack).toContain('what the pack must show')

    // The source's own attempts are the only ones shown: another source's
    // attempt is not this pack's topic.
    const other = (await defineTaskReviewPackTool(ctx).execute({ taskId: 't2', runId: null }, exec as never)) as string
    expect(other).toContain('source: review t2#no-run [blocked]')
    expect(other).toContain('review attempts (0): none')
    expect(other).not.toContain(session)
  })
})

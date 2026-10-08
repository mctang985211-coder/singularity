import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parseReviewerDiagnosis } from '../../src/coordination/review-run.ts'
import { resolveGrant } from '../../../agent-runtime/src/grants.ts'
import {
  admitReviewAgent,
  readReviewerDelegation,
  reviewAgentLedgerFile,
} from '../../src/coordination/ledger.ts'
import type { ReviewAgentRunStart } from '../../src/coordination/ledger.ts'
import {
  REVIEWER_BASELINE,
  REVIEWER_PRESET,
  defineTaskReviewAgentTool,
  reviewerGrant,
} from '../../src/tools/review-agent.ts'

/**
 * The controlled `node:fs/promises` behind the ledger cases (K4-1). `appendFile`
 * really writes its bytes, but the promise the ledger awaits settles only when
 * the test releases it, so the window between "the row is readable" and "the
 * append has finished" is the test's to hold open instead of the scheduler's.
 * `mkdir` and `readFile` pass straight through (a read is only reported, so a
 * test can tell the count has read the ledger), and so does every unarmed
 * append — the rest of this spec sees the real filesystem.
 */
const ledgerFs = vi.hoisted(() => {
  interface ArmedAppend {
    written: Promise<void>
    markWritten: () => void
    done: Promise<void>
    failure: Error | undefined
    /** Signalled when the append is reached, before anything is written. */
    entered?: () => void
    /** When armed, the append waits for this before its bytes are written. */
    before?: Promise<void>
  }
  let armedAppend: ArmedAppend | undefined
  let readSignal: (() => void) | undefined
  return {
    /** The next append writes for real, then waits for the test to release it. */
    holdNextAppend() {
      const written = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      armedAppend = {
        written: written.promise,
        markWritten: () => written.resolve(),
        done: released.promise,
        failure: undefined,
      }
      return { written: written.promise, release: () => released.resolve() }
    },
    /**
     * The next append waits *before* its bytes are written: the window between
     * "the writer decided to record this fact" and "the row is on the file" —
     * where the writer's own process state and the file disagree — is the test's
     * to hold open.
     */
    holdNextAppendBeforeWrite() {
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      armedAppend = {
        written: Promise.resolve(),
        markWritten: () => {},
        done: Promise.resolve(),
        failure: undefined,
        entered: () => entered.resolve(),
        before: released.promise,
      }
      return { entered: entered.promise, release: () => released.resolve() }
    },
    /** The next append fails without writing, the way an unwritable ledger directory does. */
    failNextAppend(error: Error) {
      armedAppend = {
        written: Promise.resolve(),
        markWritten: () => {},
        done: Promise.resolve(),
        failure: error,
      }
    },
    takeArmedAppend() {
      const armed = armedAppend
      armedAppend = undefined
      return armed
    },
    /** Resolves when the ledger file has really been read back, after the read completed. */
    nextLedgerRead() {
      const signal = Promise.withResolvers<void>()
      readSignal = () => signal.resolve()
      return signal.promise
    },
    reportLedgerRead() {
      const signal = readSignal
      readSignal = undefined
      signal?.()
    },
  }
})

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      const armed = ledgerFs.takeArmedAppend()
      if (armed === undefined) return actual.appendFile(...args)
      armed.entered?.()
      if (armed.before !== undefined) await armed.before
      if (armed.failure !== undefined) throw armed.failure
      await actual.appendFile(...args)
      armed.markWritten()
      await armed.done
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args)
      if (String(args[0]).endsWith('agents.jsonl')) ledgerFs.reportLedgerRead()
      return result
    },
  }
})

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }
const store = {
  version: 1 as const,
  id: 'sg-t-root',
  tasks: [{
    taskId: 't1',
    parentTaskId: undefined,
    objective: 'Build the feature',
    depth: 0,
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: 'leaf' as const,
    status: 'failed' as const,
    runIds: ['r1'],
    childTaskIds: [],
  }],
  runs: [{ runId: 'r1', taskId: 't1', status: 'failed' as const }],
  edges: [],
  evidence: [],
  handoffs: [],
  reviews: [{
    taskId: 't1',
    runId: 'r1',
    sessionId: 's-worker',
    outcome: 'failed' as const,
    evidenceRefs: ['ev-1'],
    anomalies: [],
    localizedCause: 'criterion c1 failed',
    logTail: 'boom',
  }],
  diagnoses: [], obligations: [],
  capabilities: {},
}

/** A composition offering every tool a reviewer must NOT have, plus the read-only baseline. */
const FULL_SURFACE = [
  ...REVIEWER_BASELINE,
  'bash', 'write', 'edit', 'read_image', 'jobs', 'job_output', 'subagent', 'graph_spawn',
  'hitl_ask', 'hitl_approve', 'ask_user_question', 'task_diagnose', 'task_decompose',
  'evolution_propose', 'evolution_candidate', 'evolution_gate', 'evolution_decide', 'evolution_list',
  'run_code',
]
const FORBIDDEN = [
  'bash', 'write', 'edit', 'jobs', 'job_output', 'subagent', 'graph_spawn',
  'hitl_ask', 'hitl_approve', 'task_diagnose', 'task_decompose',
  'evolution_propose', 'evolution_candidate', 'evolution_gate', 'evolution_decide', 'evolution_list',
]

function grantHarness(preset: readonly string[] = []) {
  const schemas = (scope?: unknown) => (scope === undefined ? FULL_SURFACE : [...FULL_SURFACE, ...preset])
    .map(name => ({ name, description: '', parameters: {} }))
  const restrict = vi.fn()
  return { ctx: { tools: { schemas, restrict }, get: () => undefined } as unknown as Context, restrict }
}

function worker(): Agent {
  return { id: 'rev' as SessionId, session: { header: { cwd: '/work' } } } as unknown as Agent
}

describe('reviewer grant', () => {
  test('resolves to exactly the read-only baseline on a full composition', () => {
    const h = grantHarness()
    const resolved = resolveGrant(h.ctx, worker(), reviewerGrant())
    expect(resolved.allow).toEqual([...REVIEWER_BASELINE].sort())
    expect(resolved.baselineUnavailable).toEqual([])
  })

  test('has no shell, write, spawn, hitl, diagnosis, or evolution tool to give', () => {
    const h = grantHarness()
    const allow = resolveGrant(h.ctx, worker(), reviewerGrant()).allow
    for (const name of FORBIDDEN) expect(allow).not.toContain(name)
  })

  test('carries neither half of the question protocol: a reviewer has no run to ask from and no child to answer', () => {
    // A reviewer judges with the records it was delegated; its own surface is
    // read-only. `reviewerGrant`'s baseline names what a reviewer keeps, so a
    // question tool that reached it would be a tool whose answer would move the
    // run of a session that has no business Run (A4 §F.1).
    expect(REVIEWER_BASELINE).not.toContain('task_ask_parent')
    expect(REVIEWER_BASELINE).not.toContain('task_answer')
    const allow = resolveGrant(grantHarness().ctx, worker(), reviewerGrant()).allow
    expect(allow).not.toContain('task_ask_parent')
    expect(allow).not.toContain('task_answer')
  })

  test('keepPresetTools is false, so the mounted preset contributes no tool plane', () => {
    const h = grantHarness(['preset_shell_passthrough', 'preset_write'])
    const allow = resolveGrant(h.ctx, worker(), reviewerGrant()).allow
    expect(allow).not.toContain('preset_shell_passthrough')
    expect(allow).not.toContain('preset_write')
    expect(allow).toEqual([...REVIEWER_BASELINE].sort())
  })

  test('the declared grant carries no capability plane and no preset tools', () => {
    expect(reviewerGrant()).toEqual({ capabilities: [], baseline: REVIEWER_BASELINE, keepPresetTools: false })
  })
})

function handle(reply: string | undefined, options: { hang?: boolean } = {}) {
  const idle = Promise.withResolvers<void>()
  const cancel = vi.fn(() => idle.resolve())
  const events = reply === undefined
    ? []
    : [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } }]
  return {
    agent: {
      cancel,
      whenIdle: vi.fn(options.hang === true ? () => idle.promise : async () => {}),
      session: { snapshotEvents: () => events },
    },
    complete: () => idle.resolve(),
  }
}

function fixture(handleValue: unknown, spawnImpl?: () => Promise<unknown>, graphValue: unknown = graph) {
  const spawn = vi.fn(spawnImpl ?? (async () => handleValue))
  const recordDiagnosisIn = vi.fn(async () => {})
  const snapshot = structuredClone(store)
  const ctx = {
    effect: (install: () => () => Promise<void>) => install(),
    graphs: { graphForSession: async (_sessionId: string) => graphValue },
    task: {
      openStore: async (_storeId: string) => structuredClone(snapshot),
      snapshotIn: async (_storeId: string) => structuredClone(snapshot),
      recordDiagnosisIn,
    },
    agentRuntime: { spawn },
  }
  return { ctx: ctx as unknown as Context, spawn, recordDiagnosisIn, snapshot }
}

/**
 * The spawn stub honoring the agent-runtime's contract (A2): `beforePrompt`
 * runs before the handle is returned — exactly the point where the runtime
 * runs it (after publication and the spawn announcement, before the first
 * model input). A rejection fails the spawn with zero model input.
 */
function fixtureWithBeforePrompt(handleValue: unknown, graphValue: unknown = graph) {
  return fixture(
    handleValue,
    async (...args: unknown[]) => {
      const request = args[1] as { beforePrompt?: () => Promise<void> }
      await request.beforePrompt?.()
      return handleValue
    },
    graphValue,
  )
}

const exec = { agent: { id: 'root-1' }, signal: new AbortController().signal }

/** The root store the tool's graph resolves to. */
const ROOT_STORE = 'sg-t-root-1'

/** One run as the tool submits it: the ledger owns the store id, the version and the time. */
const row = (sessionId: string): ReviewAgentRunStart => ({ taskId: 't1', sessionId, actor: 'root-1' })

/** The ledger as the real filesystem holds it — read directly, not through the mocked module. */
function ledgerText(): string {
  try {
    return readFileSync(reviewAgentLedgerFile(), 'utf8')
  } catch {
    return ''
  }
}

/** The ledger's rows as they are really on disk. */
function ledgerRows(): Record<string, unknown>[] {
  return ledgerText()
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The ledger's rows of one kind (A5: claim / started / settled). */
function rowsOfKind(kind: string): Record<string, unknown>[] {
  return ledgerRows().filter(row => row.kind === kind)
}

let ledgerDir: string
let previousLedger: string | undefined
let previousBudget: string | undefined

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'review-agent-'))
  previousLedger = process.env.SINGULARITY_REVIEW_LEDGER_DIR
  previousBudget = process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  process.env.SINGULARITY_REVIEW_LEDGER_DIR = ledgerDir
  delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
})

afterEach(() => {
  vi.useRealTimers()
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  if (previousBudget === undefined) delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  else process.env.SINGULARITY_REVIEW_AGENT_BUDGET = previousBudget
  chmodSync(ledgerDir, 0o700)
  rmSync(ledgerDir, { recursive: true, force: true })
})

/**
 * A reviewer's answer in the shape A5 asks for: the observation, the
 * conclusion, the confidence, and only the judgement it really made. The six
 * dimensions are a vocabulary for the judgements a reviewer chooses to make,
 * not a form to fill in.
 */
const REPLY = '```json\n'
  + '{"observation":"the run failed its mandatory criterion c1",'
  + '"conclusion":"the acceptance command never feeds empty input",'
  + '"confidence":"medium",'
  + '"judgements":[{"dimension":"skill_fit","verdict":"inadequate","evidenceRefs":["ev-1"],"rationale":"the skill was never loaded"}]}'
  + '\n```'

/** The same answer with no judgement and no proposal: "no improvement needed" is a conclusion. */
const NO_SUGGESTION_REPLY = '```json\n'
  + '{"observation":"the run passed every mandatory criterion on its first attempt",'
  + '"conclusion":"no improvement needed","confidence":"high"}'
  + '\n```'

describe('the ledger as the reviewer binding source (A2)', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    formatVersion: 2,
    kind: 'started',
    rootStoreId: 'sg-t-root',
    taskId: 't1',
    sessionId: 's-review',
    actor: 'root-1',
    at: '2026-09-24T00:00:00.000Z',
    ...overrides,
  })

  test('answers one delegation for one session, and treats identical rows as the same one written twice', async () => {
    writeFileSync(join(ledgerDir, 'agents.jsonl'), `${JSON.stringify(entry())}\n${JSON.stringify(entry())}\n`)
    expect(await readReviewerDelegation('s-review')).toMatchObject({ rootStoreId: 'sg-t-root', taskId: 't1', actor: 'root-1' })
    expect(await readReviewerDelegation('s-other')).toBeUndefined()
    // A ledger that was never written is a state, not a failure.
    rmSync(join(ledgerDir, 'agents.jsonl'))
    expect(await readReviewerDelegation('s-review')).toBeUndefined()
  })

  test('refuses to pick between conflicting rows, naming the conflict rather than the file order', async () => {
    writeFileSync(join(ledgerDir, 'agents.jsonl'), [
      JSON.stringify(entry()),
      JSON.stringify(entry({ taskId: 't2', rootStoreId: 'sg-t-other' })),
      '',
    ].join('\n'))
    await expect(readReviewerDelegation('s-review')).rejects.toMatchObject({
      name: 'ReviewerBindingError',
      kind: 'binding-conflict',
    })
  })

  test('reports a ledger this process cannot read as unreadable, never as "no delegation"', async () => {
    writeFileSync(join(ledgerDir, 'agents.jsonl'), '{not json}\n')
    await expect(readReviewerDelegation('s-review')).rejects.toMatchObject({ kind: 'unreadable' })
  })
})

/**
 * The K4-1 model these cases pin: one durable count per store — the rows the
 * file holds — counted inside one serial region per (ledger file, store), with
 * the run's row written inside that same region. No cache and no reservation
 * stands in for the row, so a row that is readable before its append has
 * resolved is still exactly one spent run, a failed append spends nothing and
 * leaves no row, and a restart counts the file alone. Every conclusion here is
 * read back from the file on disk, never from what an admission returned.
 */
describe('the review-agent admission (K4-1)', () => {
  /** One admission exactly as the tool decides it: read the count, check the cap, then write the row. */
  const attempt = (max: number, sessionId: string) => admitReviewAgent(ROOT_STORE, async admission => {
    if (admission.started >= max) return 'refused'
    await admission.start(row(sessionId))
    return 'admitted'
  })

  test('two concurrent admissions for one store admit exactly one run', async () => {
    const countsSeen: number[] = []
    const contender = (sessionId: string) => admitReviewAgent(ROOT_STORE, async admission => {
      countsSeen.push(admission.started)
      if (admission.started >= 1) return 'refused'
      await admission.start(row(sessionId))
      return 'admitted'
    })
    const results = await Promise.all([contender('s-a'), contender('s-b')])

    // The second admission read the count the first one left behind…
    expect(countsSeen).toEqual([0, 1])
    expect(results.filter(result => result === 'admitted')).toHaveLength(1)
    expect(results.filter(result => result === 'refused')).toHaveLength(1)
    // …so exactly one row is on the file, whoever wrote it.
    const rows = ledgerRows()
    expect(rows).toHaveLength(1)
    expect(['s-a', 's-b']).toContain(rows[0]!.sessionId)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
  })

  test('with the cap at two and one row on the file, exactly one more admission lands', async () => {
    expect(await attempt(1, 's-existing')).toBe('admitted')
    expect(ledgerRows()).toHaveLength(1)

    const results = await Promise.all([attempt(2, 's-x'), attempt(2, 's-y')])
    expect(results.filter(result => result === 'admitted')).toHaveLength(1)
    expect(results.filter(result => result === 'refused')).toHaveLength(1)
    // Two rows for two runs — the third admission wrote nothing.
    expect(ledgerRows()).toHaveLength(2)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(2)
    expect(await attempt(2, 's-z')).toBe('refused')
    expect(ledgerRows()).toHaveLength(2)
  })

  test("another store's rows are not this store's count", async () => {
    await admitReviewAgent('sg-t-other', admission => admission.start(row('s-other-store')))
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-other').length).toBe(1)
    // This store's own allowance is untouched — and its own region is its own.
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(0)
    expect(await attempt(1, 's-this-store')).toBe('admitted')
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
    expect(ledgerRows()).toHaveLength(2)
  })

  test('a row readable before its append resolves spends one run, not two', async () => {
    // The interleaving the rejected implementation double-counted: the row's
    // bytes are on the file while the append that wrote them has not resolved,
    // so a count reads a row the writing admission has not yet "finished".
    const held = ledgerFs.holdNextAppend()
    const countsSeen: number[] = []
    const first = admitReviewAgent(ROOT_STORE, async admission => {
      countsSeen.push(admission.started)
      await admission.start(row('s-first'))
      return 'first'
    })
    await held.written
    for (let attempt = 0; attempt < 200 && !ledgerText().includes('"s-first"'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(ledgerText()).toContain('"s-first"')

    // A delegation read inside that window sees the durable started row.
    const read = ledgerFs.nextLedgerRead()
    const delegation = readReviewerDelegation('s-first')
    await read
    expect(await delegation).toMatchObject({ rootStoreId: ROOT_STORE })
    expect(ledgerRows()).toHaveLength(1)

    // A second admission queues behind the open region: it cannot read the
    // file (and so cannot count the row) until the first region has ended, so
    // what it reads is the count the first one left behind — never the pre-row
    // zero, never a doubled two.
    const second = admitReviewAgent(ROOT_STORE, async admission => {
      countsSeen.push(admission.started)
      return admission.started
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(countsSeen).toEqual([0])
    held.release()
    expect(await first).toBe('first')
    expect(await second).toBe(1)
    expect(countsSeen).toEqual([0, 1])

    // One row is one spent run: the room a cap of two leaves is still there.
    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
    const room = await admitReviewAgent(ROOT_STORE, async admission => {
      const started = admission.started
      if (started >= 2) return { started, admitted: false }
      await admission.start(row('s-third'))
      return { started, admitted: true }
    })
    expect(room).toEqual({ started: 1, admitted: true })
    expect(ledgerRows()).toHaveLength(2)
    // …and now the room is gone: two rows, two runs.
    expect(await admitReviewAgent(ROOT_STORE, async admission => admission.started)).toBe(2)
    expect(ledgerRows()).toHaveLength(2)
  })

  test('an append that fails writes no row, spends nothing, and leaves the store usable', async () => {
    ledgerFs.failNextAppend(new Error('EACCES: permission denied, open agents.jsonl'))
    await expect(admitReviewAgent(ROOT_STORE, admission => admission.start(row('s-failed')))).rejects.toThrow('EACCES')

    // Nothing was written, so nothing was spent and nothing has to be undone.
    expect(ledgerText()).toBe('')
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(0)

    // The failed region did not wedge the store's key: the next admission runs
    // and counts from the file it finds.
    const started = await admitReviewAgent(ROOT_STORE, async admission => {
      await admission.start(row('s-after'))
      return admission.started
    })
    expect(started).toBe(0)
    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
  })

  test('a fresh import derives the count from the file alone, with no in-process carry-over', async () => {
    // What a process restart sees: the file, no module state (K4-1).
    expect(await attempt(1, 's-restart')).toBe('admitted')
    vi.resetModules()
    const restarted = await import('../../src/coordination/ledger.ts')

    expect(await restarted.admitReviewAgent(ROOT_STORE, async admission => admission.started)).toBe(1)
    // The row written before the restart is spent for the fresh module too: it
    // reads the count where the admission reads it, and the store is out of room.
    const seen = await restarted.admitReviewAgent(ROOT_STORE, async admission => {
      if (admission.started >= 1) return `refused:${admission.started}`
      await admission.start(row('s-after-restart'))
      return 'admitted'
    })
    expect(seen).toBe('refused:1')
    expect(ledgerRows()).toHaveLength(1)
  })

  test('the row an admission wrote answers the delegation read-back, in the shape the record declares', async () => {
    const started = await admitReviewAgent(ROOT_STORE, async admission => {
      await admission.start(row('s-delegated'))
      return admission.started
    })
    expect(started).toBe(0)
    expect(await readReviewerDelegation('s-delegated')).toMatchObject({
      rootStoreId: ROOT_STORE,
      taskId: 't1',
      actor: 'root-1',
    })
    expect(await readReviewerDelegation('s-other')).toBeUndefined()

    const rows = ledgerRows()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(['actor', 'at', 'formatVersion', 'kind', 'rootStoreId', 'sessionId', 'taskId'])
    expect(rows[0]).toMatchObject({ formatVersion: 2, kind: 'started', rootStoreId: ROOT_STORE, taskId: 't1', sessionId: 's-delegated', actor: 'root-1' })
    expect(Date.parse(String(rows[0]!.at))).not.toBeNaN()
  })

  test('a started row is written once per attempt, however many times it is asked for', async () => {
    // "An attempt that has started is not re-recorded": the door is idempotent by
    // the attempt's own session, so a second call — in the same region or in a
    // later one — neither appends a row nor charges the store twice.
    const once = await admitReviewAgent(ROOT_STORE, async admission => {
      await admission.start(row('s-once'))
      await admission.start(row('s-once'))
      return admission.started
    })
    expect(once).toBe(0)
    expect(ledgerRows()).toHaveLength(1)

    const again = await admitReviewAgent(ROOT_STORE, async admission => {
      await admission.start(row('s-once'))
      return admission.started
    })
    expect(again).toBe(1)
    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)

    // A different attempt is a different spend: the door is idle for one
    // session, not for the store.
    const other = await admitReviewAgent(ROOT_STORE, async admission => {
      await admission.start(row('s-other'))
      return admission.started
    })
    expect(other).toBe(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(2)
  })
})

describe('task_review_agent', () => {
  /** The source every call in this block names: task `t1` and its one run. */
  const RUN = 'r1'

  test('spawns one preset-constrained reviewer for the named source and records its diagnosis', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    const request = spawn.mock.calls[0]![1] as Record<string, unknown>
    expect(request.agentPreset).toBe(REVIEWER_PRESET)
    expect(request.grant).toEqual(reviewerGrant())
    // A graph with no pin leaves the spawn request exactly as the deployment default has it.
    expect(request.agentOptions).toBeUndefined()
    // The evaluation plane stays outside the round's bubble: the coordinator spawn names its posture.
    expect(request.permissionPreset).toBe('danger-full-access')
    // The grant actually restricts: resolve the exact grant the tool passed.
    const allow = resolveGrant(grantHarness().ctx, worker(), request.grant as never).allow
    for (const name of FORBIDDEN) expect(allow).not.toContain(name)
    // The reviewer's own request names the source it was asked to review.
    expect((request.prompt as { text: string }[])[0]!.text).toContain('review t1#r1 [failed]')

    // The delegation was written to the ledger through the spawn's beforePrompt
    // — durable before any model input, so the context assembly can verify it.
    const delegation = await readReviewerDelegation(request.sessionId as string)
    expect(delegation).toMatchObject({ rootStoreId: 'sg-t-root-1', taskId: 't1', actor: 'root-1' })
    // One attempt: its claim, its started row, its settled fact.
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded', sessionId: request.sessionId })
    expect(rowsOfKind('claim')[0]).toMatchObject({ taskId: 't1', runId: RUN, requestKey: null, sessionId: request.sessionId })

    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const [storeId, diagnosis] = recordDiagnosisIn.mock.calls[0] as [string, Record<string, unknown>]
    expect(storeId).toBe('sg-t-root-1')
    expect(diagnosis.producedBy).toEqual({ kind: 'agent', sessionId: request.sessionId })
    const judgements = diagnosis.judgements as { dimension: string; verdict: string; evidenceRefs: string[] }[]
    expect(judgements).toHaveLength(1)
    expect(judgements.find(item => item.dimension === 'skill_fit')!.verdict).toBe('inadequate')
    // The reviewer's own words are the diagnosis: the observation it recorded
    // and the conclusion it reached, never a mechanical restatement.
    expect(diagnosis.observedFailure).toBe('the run failed its mandatory criterion c1')
    expect(diagnosis.localizedCause).toBe('the acceptance command never feeds empty input')
    expect(diagnosis.confidence).toBe('medium')

    expect(result).toContain('judgements (agent')
    expect(result).toContain('skill_fit: inadequate — the skill was never loaded refs [ev-1]')
    expect(result).toContain('recorded')
  })

  test('spawns the reviewer under the graph model pin as agentOptions', async () => {
    const pinned = { ...graph, model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }
    const { ctx, spawn } = fixtureWithBeforePrompt(handle(REPLY), pinned)
    await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)

    const request = spawn.mock.calls[0]![1] as Record<string, unknown>
    expect(request.agentOptions).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })

  /**
   * The first request, as the reviewer's own model really receives it (A5 §3):
   * the pack is what the reviewer starts from, not a fence around it — it may
   * read the source itself through `context_read`, `task_read` and
   * `task_status` — and the six dimensions are a vocabulary it may use, not a
   * form it must fill in. Both readings the deleted implementation imposed are
   * asserted absent, and the vocabulary it does need is asserted present.
   */
  test('the first request neither confines the reviewer to the pack nor demands six judgements', async () => {
    const { ctx, spawn } = fixtureWithBeforePrompt(handle(REPLY))
    await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)

    const prompt = ((spawn.mock.calls[0]![1] as { prompt: { text: string }[] }).prompt[0]!.text)
    // The pack-only restriction is gone, and the door out of it is named.
    expect(prompt).not.toContain('nothing else')
    expect(prompt).not.toContain('from the review pack')
    expect(prompt).toContain('context_read')
    expect(prompt).toContain('task_template_list')
    expect(prompt).toContain('"confidence":"low","reviewRefs":["t1#r1"]')
    expect(prompt).toContain('Top-level evidenceRefs must be evidence bundle ids')
    expect(prompt).toContain('task_definition (a TaskTemplate; targetId is its template id)')
    // The forced six-dimension judgement is gone: judgements are optional and
    // only the ones the reviewer can settle belong in the reply.
    expect(prompt).not.toContain('Include all six dimensions')
    expect(prompt).not.toContain('exactly once')
    expect(prompt).toContain('judgements (optional)')
    // …so a reply that carries none is accepted, and the vocabulary it may use
    // comes from the pack's own dimension line.
    expect(prompt).toContain('needs judgement (agent):')
    expect(prompt).toContain('task_specification')
    // The observation is named the way the persisted slot is read (A5 §4).
    expect(prompt).toContain('postmortem observation')
    // The pack itself is still the starting point: the reviewer reads it first.
    expect(prompt).toContain('--- review pack ---')
    expect(prompt).toContain('source: review t1#r1 [failed]')
  })

  test('a conclusion with no judgements and no proposals is recorded as it stands', async () => {
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(NO_SUGGESTION_REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string

    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const diagnosis = recordDiagnosisIn.mock.calls[0]![1] as Record<string, unknown>
    expect(diagnosis.observedFailure).toBe('the run passed every mandatory criterion on its first attempt')
    expect(diagnosis.localizedCause).toBe('no improvement needed')
    expect(diagnosis.confidence).toBe('high')
    expect(diagnosis.proposals).toEqual([])
    // Absent, not padded: the reviewer made no judgement, so none is stored.
    expect(diagnosis.judgements).toBeUndefined()
    expect(diagnosis.scope).toBe('task t1')
    expect(diagnosis.reviewRefs).toEqual(['t1#r1'])
    expect(diagnosis.evidenceRefs).toEqual(['ev-1'])
    expect(diagnosis.relatedTaskIds).toBeUndefined()
    expect(result).toContain('no improvement needed')
    expect(result).toContain('proposals: none')
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded' })
  })

  test('cross-task causal lineage is recorded without sweeping in unrelated store evidence', async () => {
    const reply = '```json\n' + JSON.stringify({
      observation: 'both tasks reject empty input', conclusion: 'the shared provider omits empty-input handling',
      confidence: 'medium', scope: 'shared provider across t1 and t2',
      reviewRefs: ['t2#r2', 't1#r1', 't2#r2'], evidenceRefs: ['ev-2', 'ev-2'], relatedTaskIds: ['t2', 't2'],
      judgements: [{ dimension: 'skill_fit', verdict: 'inadequate', evidenceRefs: ['ev-2', 't2#r2', 's-worker'], rationale: 'the second trace confirms the same missing handler' }],
    }) + '\n```'
    const { ctx, recordDiagnosisIn, snapshot } = fixtureWithBeforePrompt(handle(reply))
    snapshot.tasks.push({ ...structuredClone(snapshot.tasks[0]!), taskId: 't2', runIds: ['r2'] })
    snapshot.runs.push({ runId: 'r2', taskId: 't2', status: 'failed' })
    snapshot.reviews.push({ ...structuredClone(snapshot.reviews[0]!), taskId: 't2', runId: 'r2', evidenceRefs: ['ev-2'] })
    for (const evidenceId of ['ev-2', 'ev-unrelated']) snapshot.evidence.push({
      evidenceId, taskId: 't2', taskRunId: 'r2', artifacts: [], verifierResults: [], claims: [], generatedAt: '',
    } as never)

    const result = await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)
    expect(result).toContain('recorded')
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    expect(recordDiagnosisIn.mock.calls[0]![1]).toMatchObject({
      taskId: 't1', scope: 'shared provider across t1 and t2',
      reviewRefs: ['t1#r1', 't2#r2'], evidenceRefs: ['ev-2'], relatedTaskIds: ['t2'],
    })
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded' })
  })

  test('an explicit empty evidence list retains the source review without copying its evidence', async () => {
    const reply = '```json\n' + JSON.stringify({
      observation: 'the review alone locates the failure', conclusion: 'unknown; the original trace is missing',
      confidence: 'low', reviewRefs: [], evidenceRefs: [], relatedTaskIds: [],
    }) + '\n```'
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(reply))
    await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)
    expect(recordDiagnosisIn.mock.calls[0]![1]).toMatchObject({ reviewRefs: ['t1#r1'], evidenceRefs: [], relatedTaskIds: [] })
  })

  test('references created during the investigation are validated against the final store read', async () => {
    const reply = '```json\n' + JSON.stringify({
      observation: 'a later review confirms the same failed input', conclusion: 'the recorded evidence confirms this local cause',
      confidence: 'medium', evidenceRefs: ['ev-later'],
    }) + '\n```'
    const reviewer = handle(reply)
    const { ctx, snapshot, recordDiagnosisIn } = fixtureWithBeforePrompt(reviewer)
    reviewer.agent.whenIdle.mockImplementation(async () => {
      snapshot.evidence.push({
        evidenceId: 'ev-later', taskId: 't1', taskRunId: RUN,
        artifacts: [], verifierResults: [], claims: [], generatedAt: '',
      } as never)
    })
    await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)
    expect(recordDiagnosisIn.mock.calls[0]![1]).toMatchObject({ evidenceRefs: ['ev-later'] })
  })

  test.each([
    ['reviewRefs', ['t1#another-run']],
    ['reviewRefs', ['other-task#other-run']],
    ['evidenceRefs', ['other-store-evidence']],
    ['evidenceRefs', ['t1#r1']],
    ['evidenceRefs', ['s-worker']],
    ['evidenceRefs', ['verifier.log']],
    ['relatedTaskIds', ['other-store-task']],
    ['judgements', [{ dimension: 'tool_fit', verdict: 'unknown', evidenceRefs: ['other-store-session'], rationale: 'cannot locate the original trace' }]],
    ['judgements', [{ dimension: 'task_specification', verdict: 'inadequate', evidenceRefs: ['task-template@1'], rationale: 'a template id does not identify original evidence' }]],
  ])('a nonexistent %s reference interrupts the attempt and records no diagnosis', async (field, value) => {
    const reply = '```json\n' + JSON.stringify({
      observation: 'the evidence is incomplete', conclusion: 'unknown; the original trace is missing',
      confidence: 'low', [field]: value,
    }) + '\n```'
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(reply))
    const result = await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('outside store sg-t-root-1')
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
  })

  test.each([
    ['scope', ' '], ['scope', 3], ['reviewRefs', 't1#r1'], ['evidenceRefs', [null]],
    ['relatedTaskIds', ['']], ['relatedTaskIds', ['t1', 7]],
  ])('malformed optional %s is refused instead of silently discarded', (field, value) => {
    const parsed = parseReviewerDiagnosis('```json\n' + JSON.stringify({
      observation: 'the run failed', conclusion: 'unknown', confidence: 'low', [field]: value,
    }) + '\n```')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.refusal).toContain(field)
  })

  test('a proposal the reviewer grounds in evidence is recorded, vocabulary or not', async () => {
    const reply = '```json\n'
      + '{"observation":"the reviewer never saw the empty-input case",'
      + '"conclusion":"the prompt should name it",'
      + '"confidence":"low",'
      + '"proposals":[{"targetType":"prompt_template","targetId":"reviewer","rationale":"name the empty-input case in the request"}]}'
      + '\n```'
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(reply))
    await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)

    const diagnosis = recordDiagnosisIn.mock.calls[0]![1] as Record<string, unknown>
    expect(diagnosis.proposals).toEqual([
      { targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case in the request' },
    ])
    expect(diagnosis.judgements).toBeUndefined()
  })

  test('a reply that is not a diagnosis is an interrupted attempt, never an invented one', async () => {
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle('I could not decide anything.'))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string

    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('no diagnosis')
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'interrupted' })
    expect(String(settled[0]!.note)).toContain('no parseable json object')
  })

  test('a judgement that cites nothing is refused by name, not downgraded to unknown', async () => {
    const reply = '```json\n'
      + '{"observation":"the skill was never loaded","conclusion":"the grant missed it",'
      + '"confidence":"low",'
      + '"judgements":[{"dimension":"skill_fit","verdict":"adequate","evidenceRefs":[],"rationale":"looks fine"}]}'
      + '\n```'
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(reply))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string

    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('no diagnosis')
    expect(result).toContain('skill_fit')
    expect(String(rowsOfKind('settled')[0]!.note)).toContain('evidence')
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
  })

  test('a verdict outside the vocabulary is refused by name, not stored as unknown', async () => {
    const reply = '```json\n'
      + '{"observation":"the skill was never loaded","conclusion":"the grant missed it",'
      + '"confidence":"low",'
      + '"judgements":[{"dimension":"skill_fit","verdict":"scored-9","evidenceRefs":["ev-1"],"rationale":"bad"}]}'
      + '\n```'
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(reply))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string

    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('scored-9')
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
  })

  test('the reviewer baseline carries context_read instead of the sealed raw session tools', () => {
    expect(REVIEWER_BASELINE).toContain('context_read')
    expect(REVIEWER_BASELINE).toContain('task_read')
    expect(REVIEWER_BASELINE).toContain('task_status')
    for (const sealed of ['session_event_read', 'session_event_trace', 'session_trace', 'session_search']) {
      expect(REVIEWER_BASELINE, sealed).not.toContain(sealed)
    }
  })

  test('a ledger that cannot take the claim fails the call before any spawn or claim', async () => {
    // An unwritable ledger directory: no claim can be durable, so no attempt may
    // exist — the call fails instead of spawning a reviewer it cannot key.
    chmodSync(ledgerDir, 0o500)
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    await expect(defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)).rejects.toThrow(/EACCES/)
    expect(spawn).not.toHaveBeenCalled()
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(ledgerText()).toBe('')
  })

  test('a started row that cannot be written fails the spawn with zero model input, and the attempt is interrupted', async () => {
    // The claim lands; the append inside beforePrompt does not. The runtime's
    // contract turns that into a failed spawn before any model input, and the
    // attempt is over: no spend, and no attempt left looking in flight.
    const { ctx, recordDiagnosisIn } = fixture(handle(REPLY), async (...args: unknown[]) => {
      ledgerFs.failNextAppend(new Error('EACCES: permission denied, open agents.jsonl'))
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return handle(REPLY)
    })
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string

    expect(result).toContain('spawn failed')
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(0)
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-root-1').length).toBe(0)
  })

  /**
   * A reviewer that produced nothing is an **interrupted attempt with a named
   * reason** — never a Diagnosis. The deleted implementation turned silence
   * into six `unknown` judgements, which reads as something the agent concluded
   * and is exactly the kind of invented record A5 forbids.
   */
  test('a reviewer can pass the former ten-minute deadline and then produce its own diagnosis', async () => {
    const reviewer = handle(REPLY, { hang: true })
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(reviewer)
    const tool = defineTaskReviewAgentTool(ctx)
    let finished = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const running = tool.execute({ taskId: 't1', runId: RUN }, exec as never) as Promise<string>
    void running.then(() => { finished = true })
    await vi.waitFor(() => expect(reviewer.agent.whenIdle).toHaveBeenCalledOnce())

    await vi.advanceTimersByTimeAsync(600_001)
    expect(finished).toBe(false)
    expect(reviewer.agent.cancel).not.toHaveBeenCalled()
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(rowsOfKind('settled')).toEqual([])
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
    vi.useRealTimers()

    const repeated = await tool.execute({ taskId: 't1', runId: RUN }, exec as never) as string
    expect(repeated).toContain('already has this attempt')
    expect(spawn).toHaveBeenCalledOnce()
    reviewer.complete()
    expect(await running).toContain('judged task t1')
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded' })
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
  })

  test('an explicit cancellation ends a silent reviewer with no diagnosis and removes its listener', async () => {
    const reviewer = handle(undefined, { hang: true })
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(reviewer)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const running = defineTaskReviewAgentTool(ctx).execute(
      { taskId: 't1', runId: RUN }, { ...exec, signal: controller.signal } as never,
    ) as Promise<string>
    await vi.waitFor(() => expect(reviewer.agent.whenIdle).toHaveBeenCalledOnce())
    controller.abort()
    const result = await running

    expect(reviewer.agent.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('cancelled')
    expect(result).toContain('no diagnosis')
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
    expect(String(rowsOfKind('settled')[0]!.note)).toContain('cancelled')
  })

  test('unloading the owning plugin cancels and drains a silent review attempt', async () => {
    const reviewer = handle(undefined, { hang: true })
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(reviewer)
    let unload: (() => Promise<void>) | undefined
    ctx.effect = ((install: () => () => Promise<void>) => {
      unload = install()
      return unload
    }) as Context['effect']
    const running = defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never) as Promise<string>
    await vi.waitFor(() => expect(reviewer.agent.whenIdle).toHaveBeenCalledOnce())
    await unload!()
    expect(await running).toContain('plugin was unloaded')
    expect(reviewer.agent.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' })
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(rowsOfKind('settled')).toHaveLength(1)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
  })

  test('a failed reviewer ends its attempt without accepting output from the failed turn', async () => {
    const reviewer = handle(REPLY)
    reviewer.agent.whenIdle.mockRejectedValue(new Error('reviewer loop failed'))
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(reviewer)
    await expect(defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never))
      .rejects.toThrow('reviewer loop failed')
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
    expect(String(rowsOfKind('settled')[0]!.note)).toContain('reviewer loop failed')
  })

  test('the tool advertises no timeout and rejects a stale timeout parameter before reading the store', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const readStore = vi.spyOn(ctx.task, 'openStore')
    const tool = defineTaskReviewAgentTool(ctx)
    expect(JSON.stringify(tool.parameters)).not.toContain('timeoutMs')
    expect(tool.description).not.toMatch(/timeout|watchdog|times out/)
    const result = await tool.execute({ taskId: 't1', runId: RUN, timeoutMs: 5 }, exec as never) as string
    expect(result).toContain('undeclared parameter "timeoutMs"')
    expect(readStore).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(ledgerText()).toBe('')
  })

  test('a reviewer that returns no parseable answer leaves an interrupted attempt, not a Diagnosis', async () => {
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle('I could not decide anything.'))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('no diagnosis')
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
  })

  test('an explicit call is not gated by the escalation threshold: a verified source is reviewed on request', async () => {
    const clean = structuredClone(store)
    clean.tasks[0]!.status = 'verified' as never
    clean.reviews = [{
      taskId: 't1',
      runId: 'r1',
      sessionId: 's-worker',
      outcome: 'verified' as never,
      evidenceRefs: ['ev-1'],
      anomalies: [],
      criteria: [{ criterionId: 'c1', verdict: 'pass' as never }],
    }]
    const spawn = vi.fn(async () => handle(REPLY))
    const ctx = {
      effect: (install: () => () => Promise<void>) => install(),
      graphs: { graphForSession: async () => graph },
      task: {
        openStore: async () => structuredClone(clean),
        snapshotIn: async () => structuredClone(clean),
        recordDiagnosisIn: vi.fn(),
      },
      agentRuntime: { spawn },
    } as unknown as Context
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(spawn).toHaveBeenCalledOnce()
    expect(result).toContain('judged task t1')
    expect(result).toContain('source t1#r1')
  })

  test('the store\'s allowance stops a new source, with zero claim and zero spawn', async () => {
    // The env override pins the allowance to one for this case; a row an earlier
    // call (this process's or another's) wrote is the whole count.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '1')
    await admitReviewAgent(ROOT_STORE, admission => admission.start(row('s-old')))
    const { ctx, spawn } = fixture(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toContain('budget exhausted')
    expect(result).toContain('1/1')
    expect(rowsOfKind('claim')).toHaveLength(0)
    expect(rowsOfKind('started')).toHaveLength(1)
  })

  test('a run that is not the task\'s own is refused before any claim', async () => {
    const { ctx, spawn } = fixture(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: 'r-nope' }, exec as never)) as string
    expect(result).toContain('run "r-nope" is not a run of task "t1"')
    expect(result).toContain('no review agent started')
    expect(spawn).not.toHaveBeenCalled()
    expect(ledgerText()).toBe('')
  })

  test('a spawn failure is reported without recording a diagnosis, and leaves the attempt interrupted', async () => {
    const { ctx, recordDiagnosisIn } = fixture(undefined, async () => {
      throw new Error('Unknown agent preset: singularity-coordinator')
    })
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('spawn failed')
    expect(result).toContain('singularity-coordinator')
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(0)
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
  })

  /**
   * The durable started row is the whole spend (K4-1 rework).
   *
   * The count is the started rows the file holds, read inside the store's serial
   * region and written inside the same one. Nothing refunds a run: a spawn that
   * never reached its started row spent nothing, and one that failed after it
   * spent exactly one — and the source stays at that attempt, which is what
   * keeps one source from burning the store's allowance twice.
   */
  test('a spawn that fails after its started row spends exactly one run, and the source stays at that attempt', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixture(handle(REPLY), async (...args: unknown[]) => {
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      throw new Error('agent-runtime: the reviewer node failed to publish')
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(first).toContain('spawn failed')
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    // The row is durable, so the run is spent — and nothing refunds it.
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-root-1').length).toBe(1)

    // The source is not re-spawned, and the spent run is not re-charged either:
    // the repeat is answered from the attempt the ledger already holds.
    const second = (await tool.execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(second).toContain('already has this attempt')
    expect(second).toContain('interrupted')
    expect(second).not.toContain('budget exhausted')
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-root-1').length).toBe(1)
  })

  test('a cancelled reviewer spends one run, and nothing refunds or restarts it', async () => {
    const reviewer = handle(undefined, { hang: true })
    const { ctx, spawn } = fixtureWithBeforePrompt(reviewer)
    const tool = defineTaskReviewAgentTool(ctx)
    const controller = new AbortController()
    const running = tool.execute(
      { taskId: 't1', runId: RUN }, { ...exec, signal: controller.signal } as never,
    ) as Promise<string>
    await vi.waitFor(() => expect(reviewer.agent.whenIdle).toHaveBeenCalledOnce())
    controller.abort()
    expect(await running).toContain('cancelled')
    expect(rowsOfKind('started')).toHaveLength(1)

    const second = await tool.execute({ taskId: 't1', runId: RUN }, exec as never) as string
    expect(second).toContain('already has this attempt')
    expect(spawn).toHaveBeenCalledOnce()
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === ROOT_STORE).length).toBe(1)
  })

  /**
   * O1: the window between "this attempt's execution is over" and "its terminal
   * row is on the file". While the append is in flight the attempt is still this
   * process's, so a second admission meets it as *in flight* — it may not read a
   * finished attempt as a dead one, may not append a second terminal row for it,
   * and may not start the new key before the attempt's own fact has landed.
   */
  test('an attempt whose terminal row is still on its way stays live: one terminal fact, and no early start', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const parked = Promise.withResolvers<void>()
    const reviewer = handle(REPLY)
    const { ctx, spawn } = fixture(undefined, async (...args: unknown[]) => {
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return { agent: { ...reviewer.agent, whenIdle: () => parked.promise } }
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const running = tool.execute({ taskId: 't1', runId: RUN }, exec as never) as Promise<string>
    await vi.waitFor(() => expect(rowsOfKind('started')).toHaveLength(1))
    const owner = String(rowsOfKind('claim')[0]!.sessionId)

    // The reviewer answers and the attempt's terminal fact is on its way: the
    // append is held before its bytes land, which is exactly the window.
    const held = ledgerFs.holdNextAppendBeforeWrite()
    parked.resolve()
    await held.entered

    const early = (await tool.execute(
      { taskId: 't1', runId: RUN, requestKey: 'k1', reason: 'a second look while the first finishes' },
      exec as never,
    )) as string
    // The attempt is still this process's, so the second admission may not have
    // been accepted: one reviewer, one claim, and no second terminal fact.
    expect(spawn).toHaveBeenCalledOnce()
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('settled')).toEqual([])
    expect(early).toContain('already has an attempt in flight')
    expect(early).toContain('the new request was not accepted')
    expect(early).toContain(owner)

    // The attempt's own fact lands once, and the source is left at it.
    held.release()
    expect(await running).toContain('judged task t1')
    await vi.waitFor(() => expect(rowsOfKind('settled')).toHaveLength(1))
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'recorded', sessionId: owner })
    expect(rowsOfKind('claim')).toHaveLength(1)
    expect(rowsOfKind('started')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-root-1').length).toBe(1)

    // Once the fact is on the file the attempt is over, and the new key is what
    // starts next — the attempt is not re-run and not re-charged.
    const after = (await tool.execute(
      { taskId: 't1', runId: RUN, requestKey: 'k1', reason: 'a second look while the first finishes' },
      exec as never,
    )) as string
    expect(after).toContain('judged task t1')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(rowsOfKind('claim')).toHaveLength(2)
    expect(rowsOfKind('started')).toHaveLength(2)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-root-1').length).toBe(2)
  })

  test('a terminal row that cannot be written still ends the attempt for this process', async () => {
    // The append fails, so the file keeps the attempt open — but this process is
    // not running it any more, and the marker must not leak. The next call finds
    // the finished attempt (its diagnosis is on the store) and settles it
    // `recorded`: no second reviewer, no second run, no invented interruption.
    const state = { snapshot: structuredClone(store) }
    const spawn = vi.fn(async (...args: unknown[]) => {
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      // The started row is on the file; the terminal fact this attempt is about
      // to write is the one that fails.
      ledgerFs.failNextAppend(new Error('EACCES: permission denied, open agents.jsonl'))
      return handle(REPLY)
    })
    const ctx = {
      effect: (install: () => () => Promise<void>) => install(),
      graphs: { graphForSession: async () => graph },
      task: {
        openStore: async () => structuredClone(state.snapshot),
        snapshotIn: async () => structuredClone(state.snapshot),
        recordDiagnosisIn: async (_storeId: string, diagnosis: never) => {
          state.snapshot.diagnoses.push(structuredClone(diagnosis))
        },
      },
      agentRuntime: { spawn },
    } as unknown as Context
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(first).toContain('judged task t1')
    expect(rowsOfKind('settled')).toEqual([])
    expect(rowsOfKind('started')).toHaveLength(1)

    const second = (await tool.execute({ taskId: 't1', runId: RUN }, exec as never)) as string
    expect(second).toContain('already has this attempt')
    expect(second).not.toContain('in flight')
    expect(spawn).toHaveBeenCalledOnce()
    const settled = rowsOfKind('settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'recorded', sessionId: rowsOfKind('claim')[0]!.sessionId })
    expect(ledgerRows().filter(row => row.kind === 'started' && row.rootStoreId === 'sg-t-root-1').length).toBe(1)
  })
})

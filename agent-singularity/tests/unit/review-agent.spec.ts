import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveGrant } from '../../../agent-runtime/src/grants.ts'
import {
  admitReviewAgent,
  countReviewAgentRuns,
  readReviewerDelegation,
  reviewAgentLedgerFile,
} from '../../src/review-agent-ledger.ts'
import type { ReviewAgentRunStart } from '../../src/review-agent-ledger.ts'
import {
  REVIEWER_BASELINE,
  REVIEWER_PRESET,
  defineTaskReviewAgentTool,
  normalizeJudgements,
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
  runs: [],
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

describe('normalizeJudgements', () => {
  test('fills every judged dimension exactly once, unknown when the reviewer said nothing', () => {
    const judgements = normalizeJudgements(undefined, 't1#r1', 'no judgement returned')
    expect(judgements.map(item => item.dimension)).toEqual([
      'task_specification', 'acceptance', 'decomposition', 'skill_fit', 'tool_fit', 'context_efficiency',
    ])
    expect(judgements.every(item => item.verdict === 'unknown')).toBe(true)
    expect(judgements.every(item => item.evidenceRefs.length > 0)).toBe(true)
  })

  test('a verdict without evidence refs is downgraded to unknown', () => {
    const judgements = normalizeJudgements(
      [{ dimension: 'skill_fit', verdict: 'adequate', evidenceRefs: [], rationale: 'looks fine' }],
      't1#r1',
      'missing',
    )
    const skill = judgements.find(item => item.dimension === 'skill_fit')!
    expect(skill.verdict).toBe('unknown')
    expect(skill.evidenceRefs).toEqual(['t1#r1'])
    expect(skill.rationale).toContain('downgraded to unknown')
  })

  test('an out-of-vocabulary verdict becomes unknown and an unknown dimension is ignored', () => {
    const judgements = normalizeJudgements(
      [
        { dimension: 'skill_fit', verdict: 'scored-9', evidenceRefs: ['ev-1'], rationale: 'x' },
        { dimension: 'outcome_correctness', verdict: 'adequate', evidenceRefs: ['ev-1'], rationale: 'x' },
      ],
      't1#r1',
      'missing',
    )
    expect(judgements.find(item => item.dimension === 'skill_fit')!.verdict).toBe('unknown')
    expect(judgements.some(item => String(item.dimension) === 'outcome_correctness')).toBe(false)
  })
})

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

function fixture(handleValue: unknown, spawnImpl?: () => Promise<unknown>) {
  const spawn = vi.fn(spawnImpl ?? (async () => handleValue))
  const recordDiagnosisIn = vi.fn(async () => {})
  const snapshot = structuredClone(store)
  const ctx = {
    graphs: { graphForSession: async (_sessionId: string) => graph },
    task: {
      openStore: async (_storeId: string) => structuredClone(snapshot),
      snapshotIn: async (_storeId: string) => structuredClone(snapshot),
      recordDiagnosisIn,
    },
    agentRuntime: { spawn },
  }
  return { ctx: ctx as unknown as Context, spawn, recordDiagnosisIn }
}

/**
 * The spawn stub honoring the agent-runtime's contract (A2): `beforePrompt`
 * runs before the handle is returned — exactly the point where the runtime
 * runs it (after publication and the spawn announcement, before the first
 * model input). A rejection fails the spawn with zero model input.
 */
function fixtureWithBeforePrompt(handleValue: unknown) {
  return fixture(handleValue, async (...args: unknown[]) => {
    const request = args[1] as { beforePrompt?: () => Promise<void> }
    await request.beforePrompt?.()
    return handleValue
  })
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
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  if (previousBudget === undefined) delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  else process.env.SINGULARITY_REVIEW_AGENT_BUDGET = previousBudget
  chmodSync(ledgerDir, 0o700)
  rmSync(ledgerDir, { recursive: true, force: true })
})

const REPLY = '```json\n'
  + '{"judgements":[{"dimension":"skill_fit","verdict":"inadequate","evidenceRefs":["ev-1"],"rationale":"the skill was never loaded"}]}'
  + '\n```'

describe('the ledger as the reviewer binding source (A2)', () => {
  const entry = (overrides: Record<string, string> = {}) => ({
    formatVersion: 1,
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
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(1)
  })

  test('with the cap at two and one row on the file, exactly one more admission lands', async () => {
    expect(await attempt(1, 's-existing')).toBe('admitted')
    expect(ledgerRows()).toHaveLength(1)

    const results = await Promise.all([attempt(2, 's-x'), attempt(2, 's-y')])
    expect(results.filter(result => result === 'admitted')).toHaveLength(1)
    expect(results.filter(result => result === 'refused')).toHaveLength(1)
    // Two rows for two runs — the third admission wrote nothing.
    expect(ledgerRows()).toHaveLength(2)
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(2)
    expect(await attempt(2, 's-z')).toBe('refused')
    expect(ledgerRows()).toHaveLength(2)
  })

  test("another store's rows are not this store's count", async () => {
    await admitReviewAgent('sg-t-other', admission => admission.start(row('s-other-store')))
    expect(await countReviewAgentRuns('sg-t-other')).toBe(1)
    // This store's own allowance is untouched — and its own region is its own.
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(0)
    expect(await attempt(1, 's-this-store')).toBe('admitted')
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(1)
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

    // A display count inside that window reports the one row the file holds.
    const read = ledgerFs.nextLedgerRead()
    const counting = countReviewAgentRuns(ROOT_STORE)
    await read
    expect(await counting).toBe(1)

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
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(1)
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
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(0)

    // The failed region did not wedge the store's key: the next admission runs
    // and counts from the file it finds.
    const started = await admitReviewAgent(ROOT_STORE, async admission => {
      await admission.start(row('s-after'))
      return admission.started
    })
    expect(started).toBe(0)
    expect(ledgerRows()).toHaveLength(1)
    expect(await countReviewAgentRuns(ROOT_STORE)).toBe(1)
  })

  test('a fresh import derives the count from the file alone, with no in-process carry-over', async () => {
    // What a process restart sees: the file, no module state (K4-1).
    expect(await attempt(1, 's-restart')).toBe('admitted')
    vi.resetModules()
    const restarted = await import('../../src/review-agent-ledger.ts')

    expect(await restarted.countReviewAgentRuns(ROOT_STORE)).toBe(1)
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
    expect(Object.keys(rows[0]!).sort()).toEqual(['actor', 'at', 'formatVersion', 'rootStoreId', 'sessionId', 'taskId'])
    expect(rows[0]).toMatchObject({ formatVersion: 1, rootStoreId: ROOT_STORE, taskId: 't1', sessionId: 's-delegated', actor: 'root-1' })
    expect(Date.parse(String(rows[0]!.at))).not.toBeNaN()
  })
})

describe('task_review_agent', () => {
  test('spawns one preset-constrained reviewer and records its judgement as a diagnosis', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    const request = spawn.mock.calls[0]![1] as Record<string, unknown>
    expect(request.agentPreset).toBe(REVIEWER_PRESET)
    expect(request.grant).toEqual(reviewerGrant())
    // The permission preset must stay at the spawn default (`read-only` bundles `approval: ask`).
    expect(request.permissionPreset).toBeUndefined()
    // The grant actually restricts: resolve the exact grant the tool passed.
    const allow = resolveGrant(grantHarness().ctx, worker(), request.grant as never).allow
    for (const name of FORBIDDEN) expect(allow).not.toContain(name)

    // The delegation was written to the ledger through the spawn's beforePrompt
    // — durable before any model input, so the context assembly can verify it.
    const delegation = await readReviewerDelegation(request.sessionId as string)
    expect(delegation).toMatchObject({ rootStoreId: 'sg-t-root-1', taskId: 't1', actor: 'root-1' })
    expect(ledgerRows()).toHaveLength(1)

    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const [storeId, diagnosis] = recordDiagnosisIn.mock.calls[0] as [string, Record<string, unknown>]
    expect(storeId).toBe('sg-t-root-1')
    expect(diagnosis.producedBy).toEqual({ kind: 'agent', sessionId: request.sessionId })
    const judgements = diagnosis.judgements as { dimension: string; verdict: string; evidenceRefs: string[] }[]
    expect(judgements).toHaveLength(6)
    expect(judgements.find(item => item.dimension === 'skill_fit')!.verdict).toBe('inadequate')
    expect(judgements.filter(item => item.verdict === 'unknown')).toHaveLength(5)

    expect(result).toContain('judgements (agent')
    expect(result).toContain('skill_fit: inadequate — the skill was never loaded refs [ev-1]')
    expect(result).toContain('recorded')
  })

  test('the reviewer baseline carries context_read instead of the sealed raw session tools', () => {
    expect(REVIEWER_BASELINE).toContain('context_read')
    expect(REVIEWER_BASELINE).toContain('task_read')
    expect(REVIEWER_BASELINE).toContain('task_status')
    for (const sealed of ['session_event_read', 'session_event_trace', 'session_trace', 'session_search']) {
      expect(REVIEWER_BASELINE, sealed).not.toContain(sealed)
    }
  })

  test('a beforePrompt failure (the ledger cannot be confirmed) fails the spawn with zero model input and records nothing', async () => {
    // An unwritable ledger directory: the count still answers (missing file
    // counts zero), but the append inside beforePrompt fails, and the runtime's
    // contract turns that into a failed spawn before any model input.
    chmodSync(ledgerDir, 0o500)
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    expect(result).toContain('spawn failed')
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(ledgerText()).toBe('')
  })

  test('a timed-out reviewer is cancelled and its judgement recorded unknown', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(undefined, { hang: true }))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1', timeoutMs: 5 }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const diagnosis = recordDiagnosisIn.mock.calls[0]![1] as { judgements: { verdict: string }[]; confidence: string }
    expect(diagnosis.judgements).toHaveLength(6)
    expect(diagnosis.judgements.every(item => item.verdict === 'unknown')).toBe(true)
    expect(diagnosis.confidence).toBe('low')
    expect(result).toContain('timed out')
    expect(result).toContain('All six dimensions recorded unknown')
  })

  test('a reviewer that returns no parseable JSON records six unknowns rather than failing', async () => {
    const { ctx, recordDiagnosisIn } = fixtureWithBeforePrompt(handle('I could not decide anything.'))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const diagnosis = recordDiagnosisIn.mock.calls[0]![1] as { judgements: { verdict: string }[]; confidence: string }
    expect(diagnosis.judgements.every(item => item.verdict === 'unknown')).toBe(true)
    expect(diagnosis.confidence).toBe('low')
    expect(result).toContain('recorded')
  })

  test('does not spawn when escalation is not required', async () => {
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
    const spawn = vi.fn()
    const ctx = {
      graphs: { graphForSession: async () => graph },
      task: {
        openStore: async () => structuredClone(clean),
        snapshotIn: async () => structuredClone(clean),
        recordDiagnosisIn: vi.fn(),
      },
      agentRuntime: { spawn },
    } as unknown as Context
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toContain('escalation is not required')
    expect(ledgerText()).toBe('')
  })

  test('does not spawn when the per-store budget is spent', async () => {
    // A row an earlier call (this process's or another's) wrote is the whole count.
    await admitReviewAgent(ROOT_STORE, admission => admission.start(row('s-old')))
    const { ctx, spawn } = fixture(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toContain('budget exhausted')
    expect(result).toContain('1/1')
    expect(ledgerRows()).toHaveLength(1)
  })

  test('does not spawn for a task with no review record', async () => {
    const empty = structuredClone(store)
    empty.reviews = []
    const spawn = vi.fn()
    const ctx = {
      graphs: { graphForSession: async () => graph },
      task: { openStore: async () => structuredClone(empty), snapshotIn: async () => structuredClone(empty), recordDiagnosisIn: vi.fn() },
      agentRuntime: { spawn },
    } as unknown as Context
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toContain('no review record')
  })

  test('a spawn failure is reported without recording a diagnosis', async () => {
    const { ctx, recordDiagnosisIn } = fixture(undefined, async () => {
      throw new Error('agent-presets: preset "singularity-reviewer" not found')
    })
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    expect(result).toContain('spawn failed')
    expect(result).toContain('singularity-reviewer')
  })

  /**
   * The durable row is the whole admission (K4-1 rework).
   *
   * The count is the rows the file holds, read inside the store's serial region
   * and written inside the same one: two executions cannot interleave their
   * count-and-write, so exactly one reviewer is admitted per allowance. Nothing
   * refunds a run: a spawn that never wrote a row spent nothing, and one that
   * failed — or timed out — after its row was written spent exactly one.
   */
  test('two concurrent executions with one allowance admit exactly one reviewer (K4-1)', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const tool = defineTaskReviewAgentTool(ctx)
    const call = () => tool.execute({ taskId: 't1' }, exec as never) as Promise<string>
    const results = await Promise.all([call(), call()])

    expect(spawn).toHaveBeenCalledOnce()
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const refused = results.filter(result => result.includes('budget exhausted'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('no review agent spawned')
    expect(refused[0]).toContain('1/1')
    expect(refused[0]).toContain('sg-t-root-1')
    expect(results.filter(result => result.includes('judged task'))).toHaveLength(1)
    // One started run, read back from the file on disk.
    expect(ledgerRows()).toHaveLength(1)
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
  })

  test('two allowances admit two reviewers and refuse the third', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const tool = defineTaskReviewAgentTool(ctx)
    const call = () => tool.execute({ taskId: 't1' }, exec as never) as Promise<string>
    const results = await Promise.all([call(), call(), call()])

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(recordDiagnosisIn).toHaveBeenCalledTimes(2)
    const refused = results.filter(result => result.includes('budget exhausted'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('no review agent spawned')
    expect(refused[0]).toContain('2/2')
    expect(ledgerRows()).toHaveLength(2)
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(2)
  })

  test('a spawn that fails before its row was written spends nothing', async () => {
    let attempts = 0
    const { ctx, recordDiagnosisIn } = fixture(handle(REPLY), async (...args: unknown[]) => {
      attempts += 1
      if (attempts === 1) throw new Error('agent-presets: preset "singularity-reviewer" not found')
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return handle(REPLY)
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(first).toContain('spawn failed')
    expect(ledgerText()).toBe('')
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(0)

    // The store's one allowance is untouched: a later call still starts a reviewer.
    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('judged task')
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    expect(ledgerRows()).toHaveLength(1)
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
  })

  test('a spawn whose ledger append failed leaves the store usable for the next call', async () => {
    chmodSync(ledgerDir, 0o500)
    const { ctx } = fixtureWithBeforePrompt(handle(REPLY))
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(first).toContain('spawn failed')
    expect(ledgerText()).toBe('')
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(0)

    chmodSync(ledgerDir, 0o700)
    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('judged task')
    expect(ledgerRows()).toHaveLength(1)
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
  })

  test('a spawn that fails after its row was written spends exactly one run', async () => {
    const { ctx, spawn, recordDiagnosisIn } = fixture(handle(REPLY), async (...args: unknown[]) => {
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      throw new Error('agent-runtime: the reviewer node failed to publish')
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(first).toContain('spawn failed')
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
    // The row is durable, so the run is spent — and nothing refunds it.
    expect(ledgerRows()).toHaveLength(1)
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)

    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('budget exhausted')
    expect(second).toContain('1/1')
    expect(spawn).toHaveBeenCalledOnce()
    expect(ledgerRows()).toHaveLength(1)
  })

  test('a reviewer that timed out spends one run and refunds nothing', async () => {
    let attempts = 0
    const { ctx, spawn } = fixture(handle(REPLY), async (...args: unknown[]) => {
      attempts += 1
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return attempts === 1 ? handle(undefined, { hang: true }) : handle(REPLY)
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', timeoutMs: 5 }, exec as never)) as string
    expect(first).toContain('timed out')
    expect(ledgerRows()).toHaveLength(1)

    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('budget exhausted')
    expect(second).toContain('1/1')
    expect(spawn).toHaveBeenCalledOnce()
    expect(ledgerRows()).toHaveLength(1)
  })
})

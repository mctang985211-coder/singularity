import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveGrant } from '../../../agent-runtime/src/grants.ts'
import {
  appendReviewAgentRun,
  countReviewAgentRuns,
  effectiveReviewAgentRuns,
  readReviewerDelegation,
  reserveReviewAgentRun,
  reviewAgentLedgerFile,
} from '../../src/review-agent-ledger.ts'
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
 * append has finished its bookkeeping" is the test's to hold open instead of
 * the scheduler's. `mkdir` and `readFile` pass straight through (a read is only
 * reported, so a test can tell the count has read the ledger), and so does every
 * unarmed append — the rest of this spec sees the real filesystem.
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
  const ctx = {
    graphs: { graphForSession: async (_sessionId: string) => graph },
    task: { openStore: async (_storeId: string) => structuredClone(store), recordDiagnosisIn },
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

/**
 * A spawn that runs `beforePrompt` (the runtime's contract above) and holds the
 * first reviewer to arrive until `expect` reviewers have — the second execution
 * only reaches its spawn if the gate admitted it — or for a grace window when it
 * turns out to be the only one. The interleaving between two executions is then
 * the test's, not the scheduler's.
 */
function rendezvousSpawn(expect: number) {
  let arrivals = 0
  const enough = Promise.withResolvers<void>()
  return async (...args: unknown[]) => {
    arrivals += 1
    if (arrivals < expect) {
      await Promise.race([enough.promise, new Promise(resolve => { setTimeout(resolve, 100) })])
    } else {
      enough.resolve()
    }
    const request = args[1] as { beforePrompt?: () => Promise<void> }
    await request.beforePrompt?.()
    return handle(REPLY)
  }
}

const exec = { agent: { id: 'root-1' }, signal: new AbortController().signal }

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
  const row = (overrides: Record<string, string> = {}) => ({
    formatVersion: 1,
    rootStoreId: 'sg-t-root',
    taskId: 't1',
    sessionId: 's-review',
    actor: 'root-1',
    at: '2026-09-24T00:00:00.000Z',
    ...overrides,
  })

  test('answers one delegation for one session, and treats identical rows as the same one written twice', async () => {
    writeFileSync(join(ledgerDir, 'agents.jsonl'), `${JSON.stringify(row())}\n${JSON.stringify(row())}\n`)
    expect(await readReviewerDelegation('s-review')).toMatchObject({ rootStoreId: 'sg-t-root', taskId: 't1', actor: 'root-1' })
    expect(await readReviewerDelegation('s-other')).toBeUndefined()
    // A ledger that was never written is a state, not a failure.
    rmSync(join(ledgerDir, 'agents.jsonl'))
    expect(await readReviewerDelegation('s-review')).toBeUndefined()
  })

  test('refuses to pick between conflicting rows, naming the conflict rather than the file order', async () => {
    writeFileSync(join(ledgerDir, 'agents.jsonl'), [
      JSON.stringify(row()),
      JSON.stringify(row({ taskId: 't2', rootStoreId: 'sg-t-other' })),
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

describe('the ledger file operations (K4-1)', () => {
  const rootStoreId = 'sg-t-root-1'
  const record = (sessionId: string) => ({ rootStoreId, taskId: 't1', sessionId, actor: 'root-1' })

  /** The ledger as the real filesystem holds it — read around the mocked module, not through it. */
  function ledgerText(): string {
    try {
      return readFileSync(reviewAgentLedgerFile(), 'utf8')
    } catch {
      return ''
    }
  }

  test('a row readable before its append resolves is counted once, not twice (K4-1)', async () => {
    // The interleaving the defect needs: the row is on disk, the append that
    // wrote it has not yet raised the process's known rows, and a second reader
    // counts the file in exactly that window.
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const held = ledgerFs.holdNextAppend()
    const appending = appendReviewAgentRun(record('s-concurrent'))
    await held.written
    for (let attempt = 0; attempt < 200 && !ledgerText().includes('"s-concurrent"'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(ledgerText()).toContain('"s-concurrent"')

    const read = ledgerFs.nextLedgerRead()
    const counting = countReviewAgentRuns(rootStoreId)
    // The count reads the file right away — unless the ledger serialized it
    // behind the append, which is what the release below then lets through.
    await Promise.race([read, new Promise(resolve => setTimeout(resolve, 250))])
    held.release()
    expect(await counting).toBe(1)
    await appending

    // One row on the file, so one spent allowance — never two.
    expect(await countReviewAgentRuns(rootStoreId)).toBe(1)
    expect(effectiveReviewAgentRuns(rootStoreId, 1)).toBe(1)
    const second = reserveReviewAgentRun(rootStoreId, 2, 1)
    expect(second).toBeDefined()
    second?.release()
  })

  test('an append that fails spends nothing and does not wedge the budget queue', async () => {
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    ledgerFs.failNextAppend(new Error('EACCES: permission denied, open agents.jsonl'))
    await expect(appendReviewAgentRun(record('s-failed'))).rejects.toThrow('EACCES')

    // Nothing was written, so nothing was spent and nothing has to be undone.
    expect(ledgerText()).toBe('')
    expect(await countReviewAgentRuns(rootStoreId)).toBe(0)
    expect(effectiveReviewAgentRuns(rootStoreId, 0)).toBe(0)
    const claim = reserveReviewAgentRun(rootStoreId, 1, 0)
    expect(claim).toBeDefined()
    claim?.release()

    // The failure left the queue usable: the next append runs and counts.
    await appendReviewAgentRun(record('s-after'))
    expect(await countReviewAgentRuns(rootStoreId)).toBe(1)
    expect(effectiveReviewAgentRuns(rootStoreId, 1)).toBe(1)
  })

  test('a fresh import derives the count from the file alone, counting each row once', async () => {
    // What a process restart sees: the file, no module state (K4-1).
    await appendReviewAgentRun(record('s-restart'))
    vi.resetModules()
    const restarted = await import('../../src/review-agent-ledger.ts')

    expect(await restarted.countReviewAgentRuns(rootStoreId)).toBe(1)
    expect(restarted.effectiveReviewAgentRuns(rootStoreId, 1)).toBe(1)
    expect(restarted.reserveReviewAgentRun(rootStoreId, 1, 1)).toBeUndefined()
    const room = restarted.reserveReviewAgentRun(rootStoreId, 2, 1)
    expect(room).toBeDefined()
    room?.release()
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
    // An unwritable ledger directory: the budget read still answers (missing
    // file counts zero), but the append inside beforePrompt fails, and the
    // runtime's contract turns that into a failed spawn before any model input.
    chmodSync(ledgerDir, 0o500)
    const { ctx, spawn, recordDiagnosisIn } = fixtureWithBeforePrompt(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string

    expect(spawn).toHaveBeenCalledOnce()
    expect(result).toContain('spawn failed')
    expect(recordDiagnosisIn).not.toHaveBeenCalled()
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
      task: { openStore: async () => clean, recordDiagnosisIn: vi.fn() },
      agentRuntime: { spawn },
    } as unknown as Context
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toContain('escalation is not required')
  })

  test('does not spawn when the per-store budget is spent', async () => {
    await appendReviewAgentRun({ rootStoreId: 'sg-t-root-1', taskId: 't1', sessionId: 's-old', actor: 'root-1' })
    const { ctx, spawn } = fixture(handle(REPLY))
    const result = (await defineTaskReviewAgentTool(ctx).execute({ taskId: 't1' }, exec as never)) as string
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toContain('budget exhausted')
  })

  test('does not spawn for a task with no review record', async () => {
    const empty = structuredClone(store)
    empty.reviews = []
    const spawn = vi.fn()
    const ctx = {
      graphs: { graphForSession: async () => graph },
      task: { openStore: async () => empty, recordDiagnosisIn: vi.fn() },
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
   * The allowance is a claim, not a read (K4-1 rework).
   *
   * The count the gate rests on comes from a file, so the read is asynchronous:
   * two executions can both read the same count before either has written the
   * row that would have told the other one no. The ledger therefore has to
   * claim the run — synchronously, at the moment of the read. These cases pin
   * the claim and its whole lifetime: the interleaving that would otherwise
   * admit two reviewers, the claim composing with the cap rather than
   * serializing the store, the two paths that give it back (a spawn or an
   * append that wrote no row), and the path that retires it into the row it
   * became — a reviewer that timed out stays spent without holding the store's
   * next call hostage.
   */
  test('two executions that read the same count admit exactly one reviewer', async () => {
    // The interleaving K4-1 names: both executions read the persisted count
    // (zero — there is no ledger yet) before either wrote its row.
    const { ctx, spawn, recordDiagnosisIn } = fixture(undefined, rendezvousSpawn(2))
    const tool = defineTaskReviewAgentTool(ctx)
    const call = () => tool.execute({ taskId: 't1' }, exec as never) as Promise<string>
    const results = await Promise.all([call(), call()])

    expect(spawn).toHaveBeenCalledOnce()
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    const refused = results.filter(result => result.includes('budget exhausted'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('no review agent spawned')
    // The refusal reports the effective usage — the persisted row plus the run
    // already admitted — not the count that was read before the claim.
    expect(refused[0]).toContain('1/1')
    expect(refused[0]).toContain('sg-t-root-1')
    expect(results.filter(result => result.includes('judged task'))).toHaveLength(1)
  })

  test('two allowances admit two reviewers and refuse the third', async () => {
    // The claim composes with the cap instead of holding the store: at two
    // allowances two concurrent calls are both admitted, and the call whose
    // effective usage is already two is the one refused.
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    const { ctx, spawn, recordDiagnosisIn } = fixture(undefined, rendezvousSpawn(2))
    const tool = defineTaskReviewAgentTool(ctx)
    const call = () => tool.execute({ taskId: 't1' }, exec as never) as Promise<string>
    const results = await Promise.all([call(), call(), call()])

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(2)
    expect(recordDiagnosisIn).toHaveBeenCalledTimes(2)
    const refused = results.filter(result => result.includes('budget exhausted'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('no review agent spawned')
    expect(refused[0]).toContain('2/2')
  })

  test('a count overtaken by a concurrent append admits no second reviewer', async () => {
    // The other end of the same window: the *read* is overtaken. This call read
    // the count while the ledger was empty, and another run claimed, spawned,
    // appended its row and retired its claim before the allowance was asked for
    // — the zero the caller carries is a snapshot of a file that no longer says
    // that. `task_review_agent` hands exactly this count to this call, so the
    // decision cannot rest on it: what this process knows the ledger holds
    // refuses the second reviewer.
    const stale = await countReviewAgentRuns('sg-t-root-1')
    expect(stale).toBe(0)
    await appendReviewAgentRun({ rootStoreId: 'sg-t-root-1', taskId: 't1', sessionId: 's-other', actor: 'root-1' })
    expect(reserveReviewAgentRun('sg-t-root-1', 1, stale)).toBeUndefined()
    // Not a blanket refusal: the allowance that is really left is spendable.
    const second = reserveReviewAgentRun('sg-t-root-1', 2, stale)
    expect(second).toBeDefined()
    second!.release()
  })

  test('a spawn that wrote no row gives the claim back', async () => {
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
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(0)
    // The store's one allowance is still there: a claim that never became a row
    // is not a spent run.
    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('judged task')
    expect(recordDiagnosisIn).toHaveBeenCalledOnce()
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
  })

  test('an append that wrote no row gives the claim back with the failure', async () => {
    chmodSync(ledgerDir, 0o500)
    const { ctx } = fixtureWithBeforePrompt(handle(REPLY))
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(first).toContain('spawn failed')
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(0)
    chmodSync(ledgerDir, 0o700)
    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('judged task')
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
  })

  test('a reviewer that timed out stays spent, and holds no second claim', async () => {
    // Two allowances, so the second call is admitted exactly when the first
    // call's claim retired into its ledger row: a claim left pending by the
    // timeout path would read as two spent and refuse it.
    process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '2'
    let attempts = 0
    const { ctx } = fixture(handle(REPLY), async (...args: unknown[]) => {
      attempts += 1
      await (args[1] as { beforePrompt?: () => Promise<void> }).beforePrompt?.()
      return attempts === 1 ? handle(undefined, { hang: true }) : handle(REPLY)
    })
    const tool = defineTaskReviewAgentTool(ctx)

    const first = (await tool.execute({ taskId: 't1', timeoutMs: 5 }, exec as never)) as string
    expect(first).toContain('timed out')
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(1)
    const second = (await tool.execute({ taskId: 't1' }, exec as never)) as string
    expect(second).toContain('judged task')
    expect(await countReviewAgentRuns('sg-t-root-1')).toBe(2)
  })
})

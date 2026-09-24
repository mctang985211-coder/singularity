import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveGrant } from '../../../agent-runtime/src/grants.ts'
import { appendReviewAgentRun, readReviewerDelegation } from '../../src/review-agent-ledger.ts'
import {
  REVIEWER_BASELINE,
  REVIEWER_PRESET,
  defineTaskReviewAgentTool,
  normalizeJudgements,
  reviewerGrant,
} from '../../src/tools/review-agent.ts'

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
})

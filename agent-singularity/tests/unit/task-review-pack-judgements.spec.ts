import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

const rootTask = {
  taskId: 't-root',
  parentTaskId: undefined,
  objective: 'Build the feature',
  depth: 0,
  acceptanceCriteria: [],
  requestedCapabilities: [],
  decompositionStatus: 'decomposed' as const,
  status: 'failed' as const,
  runIds: ['r-root'],
  childTaskIds: ['t-child-1'],
}

const childTask = {
  taskId: 't-child-1',
  parentTaskId: 't-root',
  objective: 'Implement the parser',
  depth: 1,
  acceptanceCriteria: [],
  requestedCapabilities: [],
  decompositionStatus: 'leaf' as const,
  status: 'failed' as const,
  runIds: ['r-child-1'],
  childTaskIds: [],
}

const snapshot = {
  version: 1 as const,
  id: 'sg-t-root-1',
  tasks: [rootTask, childTask],
  runs: [{ runId: 'r-child-1', taskId: 't-child-1', status: 'failed' as const }],
  edges: [],
  evidence: [],
  handoffs: [],
  reviews: [
    {
      taskId: 't-child-1',
      runId: 'r-child-1',
      sessionId: 's-child',
      outcome: 'failed' as const,
      evidenceRefs: ['ev-1'],
      anomalies: [],
      localizedCause: 'mandatory criteria not satisfied: ac1-1 fail',
      logTail: 'line a',
    },
  ],
  diagnoses: [], obligations: [],
  capabilities: {},
}

function failingSnapshot() {
  return structuredClone(snapshot)
}

/** The same store, but the child verified cleanly — nothing to escalate. */
function cleanSnapshot() {
  const full = structuredClone(snapshot)
  const child = full.tasks.find(item => item.taskId === 't-child-1')!
  child.status = 'verified' as never
  full.reviews = [{
    taskId: 't-child-1',
    runId: 'r-child-1',
    sessionId: 's-child',
    outcome: 'verified' as never,
    evidenceRefs: ['ev-1'],
    anomalies: [],
    criteria: [{ criterionId: 'ac1-1', verdict: 'pass' as never }],
  }]
  return full
}

function fixture(store: unknown) {
  const ctx = {
    graphs: { graphForSession: async (_sessionId: string) => graph },
    task: { openStore: async (_storeId: string) => store },
  }
  return ctx
}

const exec = { agent: { id: 'root-1' }, signal: new AbortController().signal }

let ledgerDir: string
let previous: string | undefined

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'review-ledger-'))
  previous = process.env.SINGULARITY_REVIEW_LEDGER_DIR
  process.env.SINGULARITY_REVIEW_LEDGER_DIR = ledgerDir
})

afterEach(() => {
  if (previous === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previous
  rmSync(ledgerDir, { recursive: true, force: true })
})

describe('task_review_pack as a fact sheet, without a trigger decision', () => {
  it('prints the session each review came from, the judged dimensions, and no escalation decision', async () => {
    const tool = defineTaskReviewPackTool(fixture(failingSnapshot()) as never)
    const pack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string

    expect(pack).toContain('review t-child-1#r-child-1 [failed] evidence: [ev-1] session s-child')
    expect(pack).toContain('needs judgement (agent): task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency')
    expect(pack).toContain('not mechanically observable from the fact table')
    // A5 deleted the escalation derivation: whether a review agent runs is
    // decided by the triggers (a failed review, an explicit call) and the
    // store's own allowance — never by a threshold the pack re-derives. The pack
    // keeps the observations (the outcome, the criteria, the log tail, the
    // dimensions); it prints no trigger decision at all.
    expect(pack).not.toContain('escalation')
    expect(pack).not.toContain('required')
    expect(pack).not.toContain('suppressed')
  })

  it('prints the same facts for a clean review: no decision, and nothing invented for it', async () => {
    const tool = defineTaskReviewPackTool(fixture(cleanSnapshot()) as never)
    const pack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string
    expect(pack).toContain('source: review t-child-1#r-child-1 [verified]')
    expect(pack).not.toContain('escalation')
    expect(pack).not.toContain('required')
  })

  /**
   * The handoff mark (A5 §3, F.3): every recorded Diagnosis is A6's handoff, a
   * conclusion without proposals included, and with no supervisor delegated yet
   * it is **pending** — recorded, addressed to nobody yet. An interrupted
   * attempt has no Diagnosis at all, so it cannot be shown as pending either.
   */
  it('marks ordinary child diagnoses parent-owned and shared suggestions pending', async () => {
    const full = failingSnapshot()
    full.diagnoses = [
      {
        diagnosisId: 'd-with-suggestion', taskId: 't-child-1', observedFailure: 'ac1-1 fails on the fixtures',
        scope: 'task t-child-1', localizedCause: 'the fixtures never feed empty input',
        evidenceRefs: ['ev-1'], reviewRefs: ['t-child-1#r-child-1'], confidence: 'medium' as never,
        proposals: [{ targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case' }],
        producedBy: { kind: 'agent' as never, sessionId: 's-rev-1' },
      },
      {
        diagnosisId: 'd-no-suggestion', taskId: 't-child-1', observedFailure: 'the run verified on its first attempt',
        scope: 'task t-child-1', localizedCause: 'no improvement needed',
        evidenceRefs: ['ev-1'], reviewRefs: ['t-child-1#r-child-1'], confidence: 'high' as never,
        proposals: [], producedBy: { kind: 'agent' as never, sessionId: 's-rev-2' },
      },
    ] as never
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string

    expect(pack).toContain('proposal prompt_template reviewer: name the empty-input case')
    expect(pack).toContain('handoff: pending')
    // Ordinary child repairs are delivered to the parent without starting a supervisor.
    expect(pack.match(/handoff: pending/g)).toHaveLength(1)
    expect(pack).toContain('- d-no-suggestion [high] no improvement needed [agent s-rev-2]')
    expect(pack.slice(pack.indexOf('- d-no-suggestion'))).toContain('handoff: parent-owned')
  })

  it('shows an interrupted attempt as interrupted, with no pending handoff invented for it', async () => {
    const full = failingSnapshot()
    // The reviewer ran and produced nothing: the ledger holds the claim and the
    // interrupted fact, and the store holds no diagnosis for it.
    writeFileSync(join(ledgerDir, 'agents.jsonl'), [
      JSON.stringify({
        formatVersion: 2, kind: 'claim', rootStoreId: 'sg-t-root-1', taskId: 't-child-1', runId: 'r-child-1',
        requestKey: null, reason: null, sessionId: 's-reviewer', actor: 'root-1', at: '2026-09-27T00:00:00.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', rootStoreId: 'sg-t-root-1', taskId: 't-child-1',
        sessionId: 's-reviewer', actor: 'root-1', at: '2026-09-27T00:00:01.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'settled', rootStoreId: 'sg-t-root-1', taskId: 't-child-1', sessionId: 's-reviewer',
        status: 'interrupted', note: 'the reviewer timed out after 5ms with no diagnosis', at: '2026-09-27T00:00:02.000Z',
      }),
      '',
    ].join('\n'))
    full.diagnoses = []
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string

    expect(pack).toContain('review attempts (1):')
    expect(pack).toContain('default attempt s-reviewer [interrupted] — the reviewer timed out after 5ms with no diagnosis')
    expect(pack).toContain('diagnoses (0):')
    expect(pack).not.toContain('handoff: pending')
  })

  it('renders agent judgements apart from the mechanical fact lines', async () => {
    const full = failingSnapshot()
    full.diagnoses = [{
      diagnosisId: 'review-agent-s-rev-1',
      taskId: 't-child-1',
      observedFailure: 'mandatory criteria not satisfied: ac1-1 fail',
      scope: 'task t-child-1',
      localizedCause: 'agent review of t-child-1: inadequate [skill_fit]; unknown [acceptance]',
      evidenceRefs: ['ev-1'],
      reviewRefs: ['t-child-1#r-child-1'],
      confidence: 'medium' as never,
      proposals: [],
      producedBy: { kind: 'agent' as never, sessionId: 's-rev-1' },
      judgements: [
        { dimension: 'skill_fit' as never, verdict: 'inadequate' as never, evidenceRefs: ['ev-1'], rationale: 'the granted skill was never loaded' },
        { dimension: 'acceptance' as never, verdict: 'unknown' as never, evidenceRefs: ['t-child-1#r-child-1'], rationale: 'no command was recorded' },
      ],
    }]
    const tool = defineTaskReviewPackTool(fixture(full) as never)
    const pack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string

    expect(pack).toContain('diagnoses (1):')
    expect(pack).toContain('- review-agent-s-rev-1 [medium] agent review of t-child-1: inadequate [skill_fit]; unknown [acceptance] [agent s-rev-1]')
    expect(pack).toContain('  judgements (agent s-rev-1):')
    expect(pack).toContain('    skill_fit: inadequate — the granted skill was never loaded refs [ev-1]')
    expect(pack).toContain('    acceptance: unknown — no command was recorded refs [t-child-1#r-child-1]')
  })
})

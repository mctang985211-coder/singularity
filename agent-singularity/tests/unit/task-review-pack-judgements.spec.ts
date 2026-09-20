import { mkdtempSync, rmSync } from 'node:fs'
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
  runs: [],
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

describe('task_review_pack escalation and judgements', () => {
  it('prints the session each review came from, the escalation decision, and the judged dimensions', async () => {
    const tool = defineTaskReviewPackTool(fixture(failingSnapshot()) as never)
    const pack = (await tool.execute({ taskId: 't-child-1' }, exec as never)) as string

    expect(pack).toContain('review t-child-1#r-child-1 [failed] evidence: [ev-1] session s-child')
    expect(pack).toContain('escalation: required E1 (budget 0/1)')
    expect(pack).toContain('needs judgement (agent): task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency')
    expect(pack).toContain('not mechanically observable from the fact table')
  })

  it('says not required for a clean review', async () => {
    const tool = defineTaskReviewPackTool(fixture(cleanSnapshot()) as never)
    const pack = (await tool.execute({ taskId: 't-child-1' }, exec as never)) as string
    expect(pack).toContain('escalation: not required (budget 0/1)')
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
    const pack = (await tool.execute({ taskId: 't-child-1' }, exec as never)) as string

    expect(pack).toContain('diagnoses (1):')
    expect(pack).toContain('- review-agent-s-rev-1 [medium] agent review of t-child-1: inadequate [skill_fit]; unknown [acceptance] [agent s-rev-1]')
    expect(pack).toContain('  judgements (agent s-rev-1):')
    expect(pack).toContain('    skill_fit: inadequate — the granted skill was never loaded refs [ev-1]')
    expect(pack).toContain('    acceptance: unknown — no command was recorded refs [t-child-1#r-child-1]')
  })
})

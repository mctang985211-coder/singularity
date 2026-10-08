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

/** The store's coordination rows live here for one test; the retired ledger name is never read. */
let coordinationDir: string
let previous: string | undefined

beforeEach(() => {
  coordinationDir = mkdtempSync(join(tmpdir(), 'coordination-'))
  previous = process.env.SINGULARITY_COORDINATION_DIR
  process.env.SINGULARITY_COORDINATION_DIR = coordinationDir
})

afterEach(() => {
  if (previous === undefined) delete process.env.SINGULARITY_COORDINATION_DIR
  else process.env.SINGULARITY_COORDINATION_DIR = previous
  rmSync(coordinationDir, { recursive: true, force: true })
})

/** One coordination row written the way the store writes it. */
function writeRows(rows: readonly unknown[]): void {
  writeFileSync(join(coordinationDir, 'assignments.jsonl'), rows.map(row => `${JSON.stringify(row)}\n`).join(''))
}

describe('task_review_pack as a fact sheet, without a trigger decision', () => {
  it('keeps a historical source exact while other runs and shared evidence remain compact references', async () => {
    const full = failingSnapshot()
    full.tasks[1]!.runIds.push('r-child-2')
    Object.assign(full.tasks[1]!, { templateRef: { id: 'parser', version: 2, digest: 'e'.repeat(64) } })
    Object.assign(full.runs[0]!, {
      sessionId: 's-old', agentPreset: 'parser-v1',
      providerBinding: { registryRevision: 'a'.repeat(64), capabilities: ['parse'], mcpServers: [], skills: [{
        name: 'parser-skill', role: 'knowledge', capabilities: ['parse'], description: 'parse',
        contentDigest: 'c'.repeat(64), contractDigest: 'b'.repeat(64), uncovered: [],
      }] },
    })
    full.runs.push({ runId: 'r-child-2', taskId: 't-child-1', status: 'verified' as never })
    Object.assign(full.runs[1]!, { sessionId: 's-new', agentPreset: 'parser-v2' })
    full.reviews.push({ ...full.reviews[0]!, runId: 'r-child-2', sessionId: 's-new', outcome: 'verified' as never,
      localizedCause: 'recovered', logTail: 'OTHER-RUN-LOG'.repeat(10_000) })
    Object.assign(full.reviews[0]!, { metrics: { toolCalls: { calls: 3, failures: 1 } },
      criteria: [{ criterionId: 'parse', verdict: 'inconclusive', unknownKind: 'verifier', logRef: 'old.log' }] })
    full.diagnoses = [{
      diagnosisId: 'd-shared', taskId: 't-root', observedFailure: 'both tasks repeated the same assumption',
      scope: 'shared parser contract', localizedCause: 'missing empty-input contract', confidence: 'medium',
      reviewRefs: ['t-child-1#r-child-1', 't-root#r-root'], evidenceRefs: ['ev-1', 'ev-root'],
      relatedTaskIds: ['t-child-1', 't-root'], proposals: [],
    }] as never
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string
    const exact = pack.split('Navigation:')[0]!
    expect(exact).toContain('source: review t-child-1#r-child-1 [failed]')
    expect(exact).toContain('source run: r-child-1 [failed] session s-old; historical run; preset parser-v1')
    expect(exact).toContain('    line a')
    expect(exact).toContain('unknownKind verifier')
    expect(exact).toContain('toolCalls 3 (1 failed)')
    expect(exact).not.toContain('review t-child-1#r-child-2')
    expect(pack).not.toContain('OTHER-RUN-LOG')
    expect(pack).toContain('run r-child-2 [verified; latest run] session s-new; review t-child-1#r-child-2 [verified]')
    expect(pack).toContain(`template parser@2 digest ${'e'.repeat(12)}`)
    expect(pack).toContain(`frozen skills [parser-skill[knowledge] content ${'c'.repeat(12)} contract ${'b'.repeat(12)}]`)
    expect(pack).toContain('scope: shared parser contract; task t-root')
    expect(pack).toContain('reviewRefs: [t-child-1#r-child-1, t-root#r-root]; evidenceRefs: [ev-1, ev-root]; relatedTaskIds: [t-child-1, t-root]')
    expect(pack).toContain('Complete cost: unknown')
    expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(50_000)
  })

  it('limits sorted DAG navigation to 20 tasks and resumes through the existing graph status cursor', async () => {
    const full = failingSnapshot()
    for (let index = 0; index < 30; index += 1) {
      full.tasks.push({ ...childTask, taskId: `t-z${String(index).padStart(2, '0')}`, runIds: [] })
    }
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string
    expect(pack.match(/^- task /gm)).toHaveLength(20)
    expect(pack).toContain('- task t-z17')
    expect(pack).not.toContain('- task t-z18')
    expect(pack).toContain('navigation shown: 20/32 tasks')
    expect(pack).toContain('task_status scope:"graph" offset:20')
  })

  it('does not truncate an oversized exact source and gives its existing record paging reference', async () => {
    const full = failingSnapshot()
    full.reviews[0]!.logTail = '证据'.repeat(10_000)
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string
    expect(pack).toContain('exact source t-child-1#r-child-1 exceeds the 50000-byte output bound')
    expect(pack).toContain('context_read kind:"review" ref:{"taskId":"t-child-1","runId":"r-child-1"}')
    expect(pack).not.toContain('证据')
    expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(50_000)
  })

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
   * The supervision mark (F): a diagnosis is shown with the supervisor attempts
   * the coordination ledger holds for it — the session each round's supervisor
   * ran under and how it ended. A store whose graph runs no RSI loop has no such
   * attempt, and the pack says so rather than inventing a delegation.
   */
  it('marks each diagnosis with the supervisor work item the coordination store holds for its round', async () => {
    const full = failingSnapshot()
    full.diagnoses = [
      {
        diagnosisId: 'rsi-graph1-e1-round-1', taskId: 't-child-1', observedFailure: 'ac1-1 fails on the fixtures',
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
    // Round 1's supervisor ran under the round's own work item and concluded it.
    writeRows([
      {
        formatVersion: 1, kind: 'assignment', graphId: 'graph1', storeId: 'sg-t-root-1', epoch: 1, role: 'supervisor',
        subject: { kind: 'round', businessRound: 1, searchRound: 1, source: { taskId: 't-root', runId: 'r-child-1' } },
        sessionId: 's-supervisor', actor: 'root-1', digest: 'digest-1', at: '2026-09-27T00:00:00.000Z',
      },
      {
        formatVersion: 1, kind: 'completion', graphId: 'graph1', storeId: 'sg-t-root-1', epoch: 1, role: 'supervisor',
        sessionId: 's-supervisor',
        result: {
          kind: 'completed', businessAction: 'finish', reason: 'proposal p-1 [applied]',
          evidenceRefs: ['t-child-1#r-child-1'], trialCandidateRef: null, methodDecision: 'retain', searchNext: 'stop',
        },
        at: '2026-09-27T00:00:02.000Z',
      },
    ])
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string

    expect(pack).toContain('proposal prompt_template reviewer: name the empty-input case')
    expect(pack).toContain('supervision: supervisor round 1: session s-supervisor [settled (finish)]')
    expect(pack.match(/supervisor round 1/g)).toHaveLength(1)
    expect(pack).toContain('- d-no-suggestion [high] no improvement needed [agent s-rev-2]')
    expect(pack.slice(pack.indexOf('- d-no-suggestion'))).toContain('supervision: no supervisor work item')
  })

  it('shows an interrupted attempt as interrupted, with no supervision invented for it', async () => {
    const full = failingSnapshot()
    // The reviewer ran and produced nothing: the store holds the work item and a
    // protocol failure, and no diagnosis for it.
    writeRows([
      {
        formatVersion: 1, kind: 'assignment', graphId: 'graph1', storeId: 'sg-t-root-1', epoch: 1, role: 'reviewer',
        subject: {
          kind: 'review', businessRound: 1, source: { taskId: 't-child-1', runId: 'r-child-1' }, requestKey: null,
        },
        sessionId: 's-reviewer', actor: 'root-1', digest: 'review-digest', at: '2026-09-27T00:00:00.000Z',
      },
      {
        formatVersion: 1, kind: 'completion', graphId: 'graph1', storeId: 'sg-t-root-1', epoch: 1, role: 'reviewer',
        sessionId: 's-reviewer',
        result: { kind: 'protocol-failure', detail: 'the reviewer timed out after 5ms with no diagnosis' },
        at: '2026-09-27T00:00:02.000Z',
      },
    ])
    full.diagnoses = []
    const pack = (await defineTaskReviewPackTool(fixture(full) as never)
      .execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec as never)) as string

    expect(pack).toContain('review work items (1):')
    expect(pack).toContain('reviewer review of t-child-1#r-child-1: session s-reviewer [protocol-failure]')
    expect(pack).toContain('diagnoses (0):')
    expect(pack).not.toContain('supervisor round')
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

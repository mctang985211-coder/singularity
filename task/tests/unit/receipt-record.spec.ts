import { describe, expect, test } from 'vitest'
import { canonicalize, sha256Hex } from '../../src/contract.ts'
import type { ExecutionReceipt } from '../../src/receipt.ts'
import { criteriaDigestOf, executionReceiptDigest } from '../../src/receipt.ts'
import { TaskState } from '../../src/service/state.ts'
import type {
  ReviewCriterion,
  ReviewRecord,
  RunId,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
  TaskRun,
} from '../../src/types.ts'

/**
 * The store's receipt gate: a receipt enters a snapshot only when every fact it
 * claims is one the store already holds — which is what makes a caller- or
 * model-supplied "passing" receipt impossible.
 */

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root'

function ev<K extends TaskEventKind>(
  kind: K,
  payload: TaskEventPayloads[K],
  init: { taskId?: TaskId; runId?: RunId; actor?: string } = {},
): TaskEvent {
  return {
    kind,
    taskId: init.taskId ?? 't1',
    runId: init.runId,
    timestamp: NOW,
    actor: init.actor ?? 'test',
    payload,
    schemaVersion: 1,
  } as unknown as TaskEvent
}

const CRITERIA: ReviewCriterion[] = [
  { criterionId: 'c1', verdict: 'pass', verifierId: 'command', command: 'true', exitCode: 0 },
]

function task(): TaskInstance {
  return {
    taskId: 't1',
    definitionRef: { taskType: 'build', version: 1 },
    contractDigest: sha256Hex('contract'),
    objective: 'build the thing',
    depth: 0,
    acceptanceCriteria: [
      { criterionId: 'c1', description: 'compiles', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
    ],
    requestedCapabilities: ['execute-task'],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: 'r1',
    taskId: 't1',
    sessionId: 's1',
    capabilitySnapshot: ['execute-task'],
    environmentRevisionId: 'r0001',
    providerBinding: {
      registryRevision: sha256Hex('registry'),
      capabilities: ['execute-task'],
      skills: [{
        name: 'task-coordination',
        role: 'guidance',
        capabilities: ['execute-task'],
        description: 'generic guidance',
        contractDigest: null,
        contentDigest: sha256Hex('skill'),
        uncovered: [],
      }],
      mcpServers: [],
      environmentRevisionId: 'r0001',
    },
    taskTemplatesRoot: '/lib/revisions/r0001/task-templates',
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return { taskId: 't1', runId: 'r1', sessionId: 's1', outcome: 'verified', evidenceRefs: [], anomalies: [], criteria: CRITERIA, ...overrides }
}

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  const base: ExecutionReceipt = {
    formatVersion: 1,
    runId: 'r1',
    taskId: 't1',
    storeId: STORE,
    sessionId: 's1',
    outcome: 'verified',
    contract: {
      contractDigest: sha256Hex('contract'),
      criteriaDigest: criteriaDigestOf(task().acceptanceCriteria),
      requestedCapabilities: ['execute-task'],
    },
    environment: {
      revision: { revisionId: 'r0001', digest: sha256Hex('revision') },
      bindingDigest: sha256Hex(canonicalize(run().providerBinding)),
      providerRegistryRevision: sha256Hex('registry'),
      templatesRoot: '/lib/revisions/r0001/task-templates',
      preset: null,
    },
    input: { workspacePath: null, snapshotPath: null, snapshotDigest: null },
    review: {
      reviewRef: 't1#r1',
      criteria: CRITERIA.map(item => ({ ...item })),
      criteriaDigest: criteriaDigestOf(CRITERIA),
      evidenceRefs: [],
      anomalies: [],
      claims: null,
    },
    modelUse: [{ runId: 'r1', sessionId: 's1', status: 'observed', requests: [{ identity: { provider: 'p', model: 'm' }, count: 1 }], logEvents: 3 }],
    skills: [{ runId: 'r1', bound: run().providerBinding!.skills.map(skill => ({ name: skill.name, role: skill.role, contentDigest: skill.contentDigest, contractDigest: skill.contractDigest })), loaded: ['task-coordination'], loadedOutsideGrant: [] }],
    templates: [],
    subtree: ['r1'],
    drain: 'in-process',
    completeness: { status: 'complete', missing: [] },
    sealedAt: NOW,
    digest: '',
  }
  const merged = { ...base, ...overrides }
  return { ...merged, digest: overrides.digest ?? executionReceiptDigest({ ...merged, digest: '' }) }
}

/** A store holding one verified run with its review, ready to take a receipt. */
function sealedStore(): TaskState {
  const state = new TaskState(STORE)
  state.apply(ev('TaskCreated', { task: task() }))
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }))
  state.apply(ev('TaskStarted', { run: run() }, { runId: 'r1' }))
  state.apply(ev('EvidenceProduced', {
    evidence: {
      evidenceId: 'e1', taskRunId: 'r1', taskId: 't1', artifacts: [],
      verifierResults: [{ criterionId: 'c1', status: 'pass', detail: 'command exited 0' }],
      claims: [], generatedAt: NOW,
    },
  }, { runId: 'r1' }))
  state.apply(ev('TaskVerifying', {} as never, { runId: 'r1' }))
  state.apply(ev('TaskVerified', {}, { runId: 'r1' }))
  state.apply(ev('ReviewRecorded', { review: review() }, { runId: 'r1' }))
  return state
}

function applyReceipt(state: TaskState, value: ExecutionReceipt): void {
  state.apply(ev('RunReceiptSealed', { receipt: value }, { runId: value.runId }))
}

/** A receipt with one field replaced, re-sealed: every refusal below must be about its content, not a stale digest. */
function variant(value: ExecutionReceipt, patch: Partial<ExecutionReceipt>): ExecutionReceipt {
  const merged = { ...value, ...patch }
  return { ...merged, digest: executionReceiptDigest(merged) }
}

/** The refusal message one rejected receipt produces, or a marker when it was accepted. */
function refusalOf(state: TaskState, value: ExecutionReceipt): string {
  try {
    applyReceipt(state, value)
    return 'ACCEPTED'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('the store refuses a receipt it cannot corroborate', () => {
  test('a well-formed receipt of a terminal run is accepted and readable', () => {
    const state = sealedStore()
    applyReceipt(state, receipt())
    const snapshot = state.snapshot()
    expect(snapshot.receipts).toHaveLength(1)
    expect(snapshot.receipts?.[0]).toMatchObject({ runId: 'r1', outcome: 'verified', drain: 'in-process' })
    expect(snapshot.receipts?.[0]?.digest).toBe(executionReceiptDigest(snapshot.receipts![0]!))
  })

  test('a second receipt for the same run is refused', () => {
    const state = sealedStore()
    applyReceipt(state, receipt())
    expect(refusalOf(state, receipt())).toMatch(/sealed exactly once/)
  })

  test('an outcome the run never reached is refused', () => {
    expect(refusalOf(sealedStore(), receipt({ outcome: 'failed' }))).toMatch(/a receipt copies the store's own status/)
  })

  test('a receipt for a run that is not terminal is refused', () => {
    const state = new TaskState(STORE)
    state.apply(ev('TaskCreated', { task: task() }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }))
    state.apply(ev('TaskStarted', { run: run() }, { runId: 'r1' }))
    expect(refusalOf(state, receipt())).toMatch(/only a terminal run is sealed/)
  })

  test('a criteria digest that is not the task’s is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, { contract: { ...value.contract, criteriaDigest: sha256Hex('other') } })))
      .toMatch(/not the digest of task "t1"'s acceptance criteria/)
  })

  test('a contract digest the task does not hold is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, { contract: { ...value.contract, contractDigest: sha256Hex('other') } })))
      .toMatch(/task "t1" holds/)
  })

  test('review criteria that differ from the stored record are refused', () => {
    const value = receipt()
    const other: ReviewCriterion[] = [{ criterionId: 'c1', verdict: 'fail' }]
    expect(refusalOf(sealedStore(), variant(value, {
      review: { ...value.review, criteria: other, criteriaDigest: criteriaDigestOf(other) },
    }))).toMatch(/not the digest of the review's criteria|criteria the review does not hold/)
  })

  test('an evidence reference the review does not name is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, { review: { ...value.review, evidenceRefs: ['e-missing'] } })))
      .toMatch(/presence|does not name|unknown evidence/)
  })

  test('a binding digest that is not the run’s binding is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, {
      environment: { ...value.environment, bindingDigest: sha256Hex('nope') },
    }))).toMatch(/not the digest of the run's provider binding/)
  })

  test('bound skills that are not the binding’s skills are refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, {
      skills: [{ runId: 'r1', bound: [{ name: 'invented', role: 'guidance', contentDigest: sha256Hex('x'), contractDigest: null }], loaded: [], loadedOutsideGrant: [] }],
    }))).toMatch(/not that run's provider binding's skills/)
  })

  test('a subtree naming a run that does not descend from the sealed run is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, { subtree: ['r1', 'r-foreign'] })))
      .toMatch(/does not descend|subtree/)
  })

  test('completeness that disagrees with the missing facts is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, {
      completeness: { status: 'complete', missing: [{ fact: 'drain', detail: 'x' }] },
    }))).toMatch(/missing facts/)
  })

  test('a drain fact that disagrees with the drain conclusion is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, { drain: 'unconfirmed' }))).toMatch(/drain/)
  })

  test('an unreadable session log without the missing fact is refused', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), variant(value, {
      modelUse: [{ runId: 'r1', sessionId: 's1', status: 'unavailable', requests: [], logEvents: 0 }],
    }))).toMatch(/missing session-log fact/)
  })

  test('a missing review must be recorded, not left implicit', () => {
    const state = new TaskState(STORE)
    state.apply(ev('TaskCreated', { task: task() }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }))
    state.apply(ev('TaskStarted', { run: run() }, { runId: 'r1' }))
    state.apply(ev('EvidenceProduced', {
      evidence: {
        evidenceId: 'e1', taskRunId: 'r1', taskId: 't1', artifacts: [],
        verifierResults: [{ criterionId: 'c1', status: 'pass', detail: 'command exited 0' }],
        claims: [], generatedAt: NOW,
      },
    }, { runId: 'r1' }))
    state.apply(ev('TaskVerifying', {} as never, { runId: 'r1' }))
    state.apply(ev('TaskVerified', {}, { runId: 'r1' }))
    const value = receipt()
    expect(refusalOf(state, value)).toMatch(/holds no terminal review|review\.ref|cites review/)
  })

  test('a tampered digest is refused before anything else is read', () => {
    const value = receipt()
    expect(refusalOf(sealedStore(), value.digest === sha256Hex('tampered') ? value : { ...value, digest: sha256Hex('tampered') }))
      .toMatch(/which is not the digest of its content/)
  })
})

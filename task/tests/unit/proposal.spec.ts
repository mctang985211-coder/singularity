import { describe, expect, test, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AdmissionContext, DecompositionIdentity, TaskContract } from '../../src/contract.ts'
import { TASK_CONTRACT_VERSION, canonicalize, contractDigest, decompositionDigest } from '../../src/contract.ts'
import {
  ROOT_PROPOSAL_TASK_ID,
  admissionContextDigest,
  batchIdFor,
  capabilityManifestDigest,
  reviewContextDigest,
  rootProposalDigest,
  rootProposalId,
  taskProposalId,
} from '../../src/proposal.ts'
import type {
  RootProposalIdentity,
  TaskProposal,
  TaskProposalBatchConsumption,
  TaskProposalChild,
  TaskProposalConsumption,
  TaskProposalDecisionClaim,
  TaskProposalDecomposition,
  TaskProposalPhaseChange,
  TaskProposalReviewContext,
  TaskProposalRoot,
  TaskProposalRootConsumption,
} from '../../src/proposal.ts'
import type {
  CapabilityManifest,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
  TaskRun,
} from '../../src/types.ts'
import { RootTaskSpec } from '../../../tests/support/legacy-root.ts'
import { TaskService } from '../../src/index.ts'
import { TaskState } from '../../src/service/state.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'
const PARENT = 'root'

/**
 * The two child contracts a proposal carries in full. Their digests are fixed
 * vectors too — `sha256sum` over the canonical text spelled out below — because
 * they are what the reduction's content↔identity correspondence rests on: the
 * identity's `contractDigest` must be the digest of the batch contract beside
 * it, so the fake digests an identity-only test could use are not available
 * here.
 */
const CONTRACT_A: TaskContract = {
  contractVersion: TASK_CONTRACT_VERSION,
  objective: 'collect the input',
  acceptanceCriteria: [
    {
      criterionId: 'c1',
      description: 'the input exists',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'test -f input.txt',
    },
  ],
  assumptions: [],
  constraints: [],
  requiredCapabilities: [],
}
const CONTRACT_A_CANONICAL = [
  '{"acceptanceCriteria":[{"command":"test -f input.txt","criterionId":"c1","description":"the input exists",',
  '"mandatory":true,"requiredEvidence":[],"verificationMode":"deterministic"}],"assumptions":[],"constraints":[],',
  '"contractVersion":1,"objective":"collect the input","requiredCapabilities":[]}',
].join('')
const DIGEST_A = 'a4bd869d771864157ad192cab251a191abebe0920486c31ffcbba0d39bb3400c'

const CONTRACT_B: TaskContract = {
  contractVersion: TASK_CONTRACT_VERSION,
  objective: 'report the result',
  acceptanceCriteria: [
    {
      criterionId: 'c1',
      description: 'the report is written',
      verificationMode: 'review',
      requiredEvidence: ['report.md'],
      mandatory: true,
    },
  ],
  assumptions: ['the input is complete'],
  constraints: ['no network access'],
  requiredCapabilities: ['reporting'],
}
const CONTRACT_B_CANONICAL = [
  '{"acceptanceCriteria":[{"criterionId":"c1","description":"the report is written","mandatory":true,',
  '"requiredEvidence":["report.md"],"verificationMode":"review"}],"assumptions":["the input is complete"],',
  '"constraints":["no network access"],"contractVersion":1,"objective":"report the result",',
  '"requiredCapabilities":["reporting"]}',
].join('')
const DIGEST_B = '2a9321d03321c4139d814d9288cdf630640a511d3d8da3349e05665cae4a3e4e'

/**
 * The expected digests below are fixed vectors: the canonical text they cover is
 * written out in the test and its SHA-256 was computed outside this repository
 * (`sha256sum` over that exact byte sequence), so a change in the review
 * context's normalization or in the serialization shows up here instead of
 * being confirmed by the implementation against itself.
 */
const ADMISSION_CONTEXT: AdmissionContext = {
  maxDepth: 4,
  maxChildren: 8,
  auditOnly: { maxToolCalls: 150, attempts: 1 },
}
const ADMISSION_CONTEXT_CANONICAL = '{"auditOnly":{"attempts":1,"maxToolCalls":150},"maxChildren":8,"maxDepth":4}'
const ADMISSION_CONTEXT_SHA256 = '545bbf8684cbeddd46a8f1f831eb4e45d49a70f47074932aa6d0c57e4b89b5ac'

/** Written with the verifiers in the order a registry might have listed them; the digest normalizes that order away. */
const REVIEW_CONTEXT: TaskProposalReviewContext = {
  capabilityManifestDigest: '1'.repeat(64),
  verifiers: [
    { verifierId: 'deterministic', version: '2.0.0' },
    { verifierId: 'composite', version: '1.0.0', configurationDigest: '2'.repeat(64) },
  ],
}
const REVIEW_CONTEXT_CANONICAL = [
  '{"capabilityManifestDigest":"1111111111111111111111111111111111111111111111111111111111111111","verifiers":[',
  '{"configurationDigest":"2222222222222222222222222222222222222222222222222222222222222222","verifierId":"composite","version":"1.0.0"},',
  '{"verifierId":"deterministic","version":"2.0.0"}]}',
].join('')
const REVIEW_CONTEXT_SHA256 = '5e03f21037b02a191928d61393c87e0a835a3c599b9f46e21e02d1e6ead12212'

const MANIFESTS_CANONICAL = [
  '[{"capabilities":{"build":{"skills":["builder"],"tools":["write"]}},"closure":"closed","missing":[]},',
  '{"capabilities":{},"closure":"gap","missing":["verilog-sim"]}]',
].join('')
const MANIFESTS_SHA256 = '01b8b60113e2ab2415cd7eed31322842ad196147a7d72b3dbbc39189205d24fc'

const IDENTITY: DecompositionIdentity = {
  contractVersion: TASK_CONTRACT_VERSION,
  storeId: 'sg-t-root',
  parentTaskId: PARENT,
  parentRunId: 'r-root',
  callerSessionId: 's-root',
  reason: 'split the work',
  children: [
    { contractDigest: DIGEST_A, dependsOn: [], decomposable: false, requiresIndependentAcceptance: false },
    { contractDigest: DIGEST_B, dependsOn: [0], decomposable: true, requiresIndependentAcceptance: true },
  ],
}

/** The complete batch content, one entry per identity child in the same order: what a reviewer reads. */
const BATCH: TaskProposalChild[] = [
  { contract: CONTRACT_A, dependsOn: [], decomposable: false, requiresIndependentAcceptance: false },
  { contract: CONTRACT_B, dependsOn: [0], decomposable: true, requiresIndependentAcceptance: true },
]

const IDENTITY_CANONICAL = [
  '{"callerSessionId":"s-root","children":[',
  `{"contractDigest":"${DIGEST_A}","decomposable":false,"dependsOn":[],"requiresIndependentAcceptance":false},`,
  `{"contractDigest":"${DIGEST_B}","decomposable":true,"dependsOn":[0],"requiresIndependentAcceptance":true}],`,
  '"contractVersion":1,"parentRunId":"r-root","parentTaskId":"root","reason":"split the work","storeId":"sg-t-root"}',
].join('')
/** `sha256sum` over the canonical text of {@link IDENTITY}: the proposal id is the content identity with a `p-` prefix. */
const PROPOSAL_ID = 'p-a927f17cc2bd8e4fc270def071fb4ed7e20f3c0e0aa94ecc9520887b19282f41'

function manifests(): CapabilityManifest[] {
  return [
    { capabilities: { build: { skills: ['builder'], tools: ['write'] } }, missing: [], closure: 'closed' },
    { capabilities: {}, missing: ['verilog-sim'], closure: 'gap' },
  ]
}

function proposal(overrides: Partial<TaskProposalDecomposition> = {}): TaskProposalDecomposition {
  return {
    proposalId: taskProposalId(IDENTITY),
    requestKey: 'k-1',
    status: 'ready',
    policy: 'off',
    identity: IDENTITY,
    batch: BATCH,
    proposalDigest: decompositionDigest(IDENTITY),
    admissionContext: ADMISSION_CONTEXT,
    admissionContextDigest: admissionContextDigest(ADMISSION_CONTEXT),
    reviewContext: REVIEW_CONTEXT,
    reviewContextDigest: reviewContextDigest(REVIEW_CONTEXT),
    createdAt: NOW,
    ...overrides,
  }
}

/** A proposal born under policy `all`: the shape a human review starts from. */
function pendingProposal(overrides: Partial<TaskProposalDecomposition> = {}): TaskProposalDecomposition {
  return proposal({ status: 'pending_review', policy: 'all', ...overrides })
}

function claim(overrides: Partial<TaskProposalDecisionClaim> = {}): TaskProposalDecisionClaim {
  const value = proposal()
  return {
    proposalId: value.proposalId,
    proposalDigest: value.proposalDigest,
    admissionContextDigest: value.admissionContextDigest,
    reviewContextDigest: value.reviewContextDigest,
    outcome: 'approved',
    decidedBy: 'operator',
    decidedAt: NOW,
    ...overrides,
  }
}

function consumption(overrides: Partial<TaskProposalBatchConsumption> = {}): TaskProposalBatchConsumption {
  const value = proposal()
  return {
    proposalId: value.proposalId,
    proposalDigest: value.proposalDigest,
    reviewContextDigest: value.reviewContextDigest,
    parentRunId: IDENTITY.parentRunId,
    batchId: batchIdFor(IDENTITY.parentRunId, value.proposalId),
    childTaskIds: ['c1', 'c2'],
    admittedAt: NOW,
    ...overrides,
  }
}

describe('proposal identities', () => {
  test('hashes the admission context through its canonical text', () => {
    expect(canonicalize(ADMISSION_CONTEXT)).toBe(ADMISSION_CONTEXT_CANONICAL)
    expect(admissionContextDigest(ADMISSION_CONTEXT)).toBe(ADMISSION_CONTEXT_SHA256)
  })

  test('is unmoved by key order and by a limit spelled as an absent key', () => {
    const reordered: AdmissionContext = {
      auditOnly: { attempts: 1, maxToolCalls: 150 },
      maxChildren: 8,
      maxDepth: 4,
    }
    expect(admissionContextDigest(reordered)).toBe(ADMISSION_CONTEXT_SHA256)
    // An `undefined`-valued audit limit and an absent one mean one identity.
    const droppedTokens: AdmissionContext = {
      ...ADMISSION_CONTEXT,
      auditOnly: { ...ADMISSION_CONTEXT.auditOnly, tokens: undefined },
    }
    expect(admissionContextDigest(droppedTokens)).toBe(admissionContextDigest(ADMISSION_CONTEXT))
  })

  test('moves when an enforced or an audited limit moves', () => {
    const base = admissionContextDigest(ADMISSION_CONTEXT)
    const moves = [
      admissionContextDigest({ ...ADMISSION_CONTEXT, maxDepth: 5 }),
      admissionContextDigest({ ...ADMISSION_CONTEXT, maxChildren: 9 }),
      admissionContextDigest({ ...ADMISSION_CONTEXT, auditOnly: { ...ADMISSION_CONTEXT.auditOnly, tokens: 2_000 } }),
      admissionContextDigest({ ...ADMISSION_CONTEXT, auditOnly: { maxToolCalls: 150 } }),
    ]
    for (const digest of moves) expect(digest).not.toBe(base)
  })

  test('hashes the review context through its canonical text, verifiers sorted', () => {
    // The vector was computed over REVIEW_CONTEXT_CANONICAL — the two verifiers
    // in ascending id order — so pinning it here also pins the normalization:
    // the digest is of the canonical text, not of the caller's array order.
    expect(reviewContextDigest(REVIEW_CONTEXT)).toBe(REVIEW_CONTEXT_SHA256)
  })

  test('is unmoved by the order the same verifiers were resolved in', () => {
    const reversed: TaskProposalReviewContext = { ...REVIEW_CONTEXT, verifiers: [...REVIEW_CONTEXT.verifiers].reverse() }
    expect(reviewContextDigest(reversed)).toBe(REVIEW_CONTEXT_SHA256)
  })

  test('moves when the manifest digest, a verifier version, its configuration, or a verifier moves', () => {
    const base = reviewContextDigest(REVIEW_CONTEXT)
    const moves = [
      reviewContextDigest({ ...REVIEW_CONTEXT, capabilityManifestDigest: '3'.repeat(64) }),
      reviewContextDigest({ ...REVIEW_CONTEXT, verifiers: [{ verifierId: 'deterministic', version: '2.0.1' }, REVIEW_CONTEXT.verifiers[1]!] }),
      reviewContextDigest({ ...REVIEW_CONTEXT, verifiers: [{ verifierId: 'composite', version: '1.0.0' }, REVIEW_CONTEXT.verifiers[0]!] }),
      reviewContextDigest({ ...REVIEW_CONTEXT, verifiers: [...REVIEW_CONTEXT.verifiers, { verifierId: 'review' }] }),
    ]
    for (const digest of moves) expect(digest).not.toBe(base)
  })

  test('hashes the batch capability manifests in batch order', () => {
    expect(canonicalize(manifests())).toBe(MANIFESTS_CANONICAL)
    expect(capabilityManifestDigest(manifests())).toBe(MANIFESTS_SHA256)
    expect(capabilityManifestDigest([...manifests()].reverse())).not.toBe(MANIFESTS_SHA256)
    const narrowed = manifests()
    narrowed[0] = { ...narrowed[0]!, capabilities: { build: { skills: [], tools: ['write'] } } }
    expect(capabilityManifestDigest(narrowed)).not.toBe(MANIFESTS_SHA256)
  })

  test('derives a stable proposal id from the proposal content alone', () => {
    expect(taskProposalId(IDENTITY)).toBe(PROPOSAL_ID)
    expect(canonicalize(IDENTITY)).toBe(IDENTITY_CANONICAL)
    expect(contractDigest(CONTRACT_A)).toBe(DIGEST_A)
    expect(contractDigest(CONTRACT_B)).toBe(DIGEST_B)
    const reordered: DecompositionIdentity = {
      reason: IDENTITY.reason,
      children: IDENTITY.children.map(child => ({
        requiresIndependentAcceptance: child.requiresIndependentAcceptance,
        decomposable: child.decomposable,
        dependsOn: child.dependsOn,
        contractDigest: child.contractDigest,
      })),
      callerSessionId: IDENTITY.callerSessionId,
      parentRunId: IDENTITY.parentRunId,
      parentTaskId: IDENTITY.parentTaskId,
      storeId: IDENTITY.storeId,
      contractVersion: IDENTITY.contractVersion,
    }
    expect(taskProposalId(reordered)).toBe(PROPOSAL_ID)
    // Ids minted at admission are not in the identity, so a retry of the same
    // proposal keeps one id and a changed batch is a new one.
    const revision = taskProposalId({
      ...IDENTITY,
      children: [IDENTITY.children[0]!, { ...IDENTITY.children[1]!, dependsOn: [0, 0] }],
    })
    expect(revision).not.toBe(PROPOSAL_ID)
  })

  test('names a batch by its parent run and its proposal, and by nothing else', () => {
    expect(batchIdFor(IDENTITY.parentRunId, PROPOSAL_ID)).toBe(`b-r-root-${PROPOSAL_ID}`)
    // The pair is the identity: another run or another proposal is another
    // batch, and a task id names no batch at all.
    expect(batchIdFor('r-other', PROPOSAL_ID)).not.toBe(batchIdFor(IDENTITY.parentRunId, PROPOSAL_ID))
    expect(batchIdFor(IDENTITY.parentRunId, 'p-other')).not.toBe(batchIdFor(IDENTITY.parentRunId, PROPOSAL_ID))
    expect(batchIdFor(IDENTITY.parentRunId, PROPOSAL_ID)).not.toBe(`b-${PARENT}`)
    // The consumption a batch is admitted as carries exactly that id, derived
    // rather than written twice.
    expect(consumption().batchId).toBe(batchIdFor('r-root', PROPOSAL_ID))
    expect(consumption().parentRunId).toBe('r-root')
  })
})

function ev<K extends TaskEventKind>(
  kind: K,
  payload: TaskEventPayloads[K],
  init: { taskId?: TaskId; runId?: string; parentTaskId?: TaskId } = {},
): TaskEvent {
  return {
    kind,
    taskId: init.taskId ?? 't1',
    runId: init.runId,
    parentTaskId: init.parentTaskId,
    timestamp: NOW,
    actor: 'test',
    payload,
    schemaVersion: 1,
  } as unknown as TaskEvent
}

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: 't1',
    definitionRef: { taskType: 'build', version: 1 },
    objective: 'build the thing',
    depth: 0,
    acceptanceCriteria: [
      { criterionId: 'c1', description: 'compiles', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
    ],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    ...overrides,
  }
}

/** A store holding one admitted, decomposable root task: the parent every proposal in this file names. */
function rootState(): TaskState {
  const state = new TaskState('store')
  state.apply(ev('TaskCreated', { task: task({ taskId: PARENT, decompositionStatus: 'decomposable' }) }, { taskId: PARENT }))
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: PARENT }))
  return state
}

function withChildren(state: TaskState, ids: readonly TaskId[]): TaskState {
  for (const id of ids) {
    state.apply(ev('TaskCreated', { task: task({ taskId: id, parentTaskId: PARENT, depth: 1 }) }, { taskId: id, parentTaskId: PARENT }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: id }))
  }
  return state
}

function submit(state: TaskState, value: TaskProposal): TaskState {
  state.apply(ev('TaskProposalSubmitted', { proposal: value }, { taskId: PARENT }))
  return state
}

function readyState(): TaskState {
  return submit(rootState(), proposal())
}

function pendingState(): TaskState {
  return submit(rootState(), pendingProposal())
}

function decide(state: TaskState, value: TaskProposalDecisionClaim): TaskState {
  state.apply(ev('TaskProposalDecided', value, { taskId: PARENT }))
  return state
}

function changePhase(state: TaskState, value: TaskProposalPhaseChange): TaskState {
  state.apply(ev('TaskProposalPhaseChanged', value, { taskId: PARENT }))
  return state
}

function approvedState(): TaskState {
  return decide(pendingState(), claim())
}

/** An approved proposal that passed its post-approval re-check: `approved → ready`. */
function recheckedState(): TaskState {
  return changePhase(approvedState(), { proposalId: PROPOSAL_ID, to: 'ready' })
}

function admittedState(): TaskState {
  const state = withChildren(readyState(), ['c1', 'c2'])
  state.apply(ev('TaskProposalAdmitted', consumption(), { taskId: PARENT }))
  return state
}

/** The stored proposal read as the decomposition arm: what every test in the decomposition sections holds. */
function stored(state: TaskState): TaskProposalDecomposition | undefined {
  const value = state.snapshot().proposals?.byId[PROPOSAL_ID]
  return value === undefined || value.kind === 'root' ? undefined : value
}

/** A stored proposal narrowed to the decomposition arm; `undefined` for a root contract or an absent record. */
function decompositionOf(value: TaskProposal | undefined): TaskProposalDecomposition | undefined {
  return value === undefined || value.kind === 'root' ? undefined : value
}

/** A stored consumption narrowed to the batch arm: the kind a decomposition proposal is consumed as. */
function batchConsumptionOf(value: TaskProposal | undefined): TaskProposalBatchConsumption | undefined {
  const consumption = value?.consumption
  return consumption === undefined || consumption.kind === 'root' ? undefined : consumption
}

describe('TaskState proposal submission', () => {
  test('a policy-off proposal is born ready and is readable through all three queries', () => {
    const state = readyState()
    const snapshot = state.snapshot()
    expect(stored(state)?.status).toBe('ready')
    expect(stored(state)?.policy).toBe('off')
    expect(stored(state)?.decision).toBeUndefined()
    expect(stored(state)?.consumption).toBeUndefined()
    expect(snapshot.proposals?.all.map(item => item.proposalId)).toEqual([PROPOSAL_ID])
    expect(snapshot.proposals?.byId[PROPOSAL_ID]?.requestKey).toBe('k-1')
    expect(snapshot.proposals?.byRequestKey['k-1']?.proposalId).toBe(PROPOSAL_ID)
    expect(snapshot.proposals?.byParentTask[PARENT]?.map(item => item.proposalId)).toEqual([PROPOSAL_ID])
    expect(snapshot.proposals?.byParentTask['other']).toBeUndefined()
  })

  test('a policy-all proposal is born pending_review', () => {
    expect(stored(pendingState())?.status).toBe('pending_review')
    expect(stored(pendingState())?.policy).toBe('all')
  })

  test('keeps the batch identity it was submitted with, unchanged', () => {
    const state = readyState()
    const value = stored(state)
    expect(value?.identity).toEqual(IDENTITY)
    expect(value?.proposalDigest).toBe(decompositionDigest(IDENTITY))
    expect(value?.admissionContext).toEqual(ADMISSION_CONTEXT)
    expect(value?.admissionContextDigest).toBe(ADMISSION_CONTEXT_SHA256)
    expect(value?.reviewContextDigest).toBe(REVIEW_CONTEXT_SHA256)
    expect(value?.createdAt).toBe(NOW)
    expect(value?.supersedes).toBeUndefined()
  })

  test('stores the complete batch content and reads every field back', () => {
    const state = readyState()
    const value = stored(state)
    // What a reviewer, a canvas and a resumed approval request read is the
    // batch itself — goals, criteria, assumptions, constraints, capabilities,
    // dependencies, flags — never a digest they would have to resolve elsewhere.
    expect(value?.batch).toEqual(BATCH)
    expect(value?.batch[0]?.contract).toEqual(CONTRACT_A)
    expect(value?.batch[1]?.contract.objective).toBe('report the result')
    expect(value?.batch[1]?.contract.acceptanceCriteria[0]?.requiredEvidence).toEqual(['report.md'])
    expect(value?.batch[1]?.contract.assumptions).toEqual(['the input is complete'])
    expect(value?.batch[1]?.contract.constraints).toEqual(['no network access'])
    expect(value?.batch[1]?.contract.requiredCapabilities).toEqual(['reporting'])
    expect(value?.batch[0]?.dependsOn).toEqual([])
    expect(value?.batch[1]?.dependsOn).toEqual([0])
    expect(value?.batch.map(child => child.decomposable)).toEqual([false, true])
    expect(value?.batch.map(child => child.requiresIndependentAcceptance)).toEqual([false, true])
    // The correspondence the reducer enforces, stated from the reader's side:
    // each identity child digest is the digest of the contract beside it.
    expect(value?.batch.map(child => contractDigest(child.contract)))
      .toEqual(value?.identity.children.map(child => child.contractDigest))
  })

  test('stores its own copy of the batch: a later caller-side edit never reaches the store', () => {
    const state = readyState()
    const caller = proposal({
      proposalId: 'p-copy',
      requestKey: 'k-copy',
      batch: [{ ...BATCH[0]!, contract: { ...CONTRACT_A } }, BATCH[1]!],
    })
    submit(state, caller)
    caller.batch[0]!.contract.objective = 'tampered after submission'
    expect(decompositionOf(state.snapshot().proposals?.byId['p-copy'])?.batch[0]?.contract.objective).toBe('collect the input')
  })

  test('records a revision that supersedes an existing proposal', () => {
    const state = readyState()
    const revision = proposal({ proposalId: 'p-revision', requestKey: 'k-2', supersedes: PROPOSAL_ID })
    submit(state, revision)
    expect(state.snapshot().proposals?.byId['p-revision']?.supersedes).toBe(PROPOSAL_ID)
    expect(state.snapshot().proposals?.all.map(item => item.proposalId)).toEqual([PROPOSAL_ID, 'p-revision'])
  })

  const refused: Array<[string, () => TaskState, TaskProposal, string]> = [
    ['an empty proposal id', rootState, proposal({ proposalId: '' }), 'task: proposal id must be a non-empty string'],
    ['an empty request key', rootState, proposal({ requestKey: '' }), 'task: proposal "' + PROPOSAL_ID + '" request key must be a non-empty string'],
    ['an unknown policy', rootState, proposal({ policy: 'risk' as 'off' }), `task: proposal "${PROPOSAL_ID}" policy must be "off" or "all"`],
    ['policy all born ready', rootState, proposal({ policy: 'all' }), `task: proposal "${PROPOSAL_ID}" is submitted ready with policy "all"`],
    ['policy off born pending_review', rootState, pendingProposal({ policy: 'off' }), `task: proposal "${PROPOSAL_ID}" is submitted pending_review with policy "off"`],
    ['a non-birth status', rootState, proposal({ status: 'admitted' }), `task: proposal "${PROPOSAL_ID}" status "admitted" is not a birth status`],
    ['an unknown status', rootState, proposal({ status: 'pruned' as 'ready' }), `task: proposal "${PROPOSAL_ID}" status "pruned" is not a birth status`],
    ['a proposal superseding itself', rootState, proposal({ supersedes: PROPOSAL_ID }), `task: proposal "${PROPOSAL_ID}" cannot supersede itself`],
    ['a proposal superseding an unknown proposal', rootState, proposal({ supersedes: 'p-ghost' }), `task: proposal "${PROPOSAL_ID}" supersedes unknown proposal "p-ghost"`],
    ['a proposal naming an unknown parent task', rootState, proposal({ identity: { ...IDENTITY, parentTaskId: 'ghost' } }), 'task: proposal "' + PROPOSAL_ID + '" names unknown parent task "ghost"'],
    ['a non-object identity', rootState, proposal({ identity: 'batch' as unknown as DecompositionIdentity }), `task: proposal "${PROPOSAL_ID}" identity must be an object`],
    ['an unknown identity contract version', rootState, proposal({ identity: { ...IDENTITY, contractVersion: 2 as 1 } }), `task: proposal "${PROPOSAL_ID}" declares contract version 2; this build stores version 1`],
    ['an empty store id', rootState, proposal({ identity: { ...IDENTITY, storeId: '' } }), `task: proposal "${PROPOSAL_ID}" identity store id must be a non-empty string`],
    ['an empty parent run id', rootState, proposal({ identity: { ...IDENTITY, parentRunId: '' } }), `task: proposal "${PROPOSAL_ID}" identity parent run id must be a non-empty string`],
    ['an empty caller session id', rootState, proposal({ identity: { ...IDENTITY, callerSessionId: '' } }), `task: proposal "${PROPOSAL_ID}" identity caller session id must be a non-empty string`],
    ['a non-string reason', rootState, proposal({ identity: { ...IDENTITY, reason: 7 as unknown as string } }), `task: proposal "${PROPOSAL_ID}" identity reason must be a string`],
    ['no children', rootState, proposal({ identity: { ...IDENTITY, children: [] } }), `task: proposal "${PROPOSAL_ID}" identity requires at least one child`],
    ['a child without a contract digest', rootState, proposal({ identity: { ...IDENTITY, children: [{ ...IDENTITY.children[0]!, contractDigest: 'nope' }] } }), `task: proposal "${PROPOSAL_ID}" child 0 contract digest must be a lowercase SHA-256 hex digest`],
    ['a child with a non-list dependsOn', rootState, proposal({ identity: { ...IDENTITY, children: [{ ...IDENTITY.children[0]!, dependsOn: 0 as unknown as number[] }] } }), `task: proposal "${PROPOSAL_ID}" child 0 dependsOn must be an array of non-negative integers`],
    ['a child with a fractional dependency', rootState, proposal({ identity: { ...IDENTITY, children: [{ ...IDENTITY.children[0]!, dependsOn: [0.5] }] } }), `task: proposal "${PROPOSAL_ID}" child 0 dependsOn must be an array of non-negative integers`],
    ['a child with a non-boolean decomposable', rootState, proposal({ identity: { ...IDENTITY, children: [{ ...IDENTITY.children[0]!, decomposable: 'yes' as unknown as boolean }] } }), `task: proposal "${PROPOSAL_ID}" child 0 decomposable must be a boolean`],
    ['a child with a non-boolean requiresIndependentAcceptance', rootState, proposal({ identity: { ...IDENTITY, children: [{ ...IDENTITY.children[0]!, requiresIndependentAcceptance: 1 as unknown as boolean }] } }), `task: proposal "${PROPOSAL_ID}" child 0 requiresIndependentAcceptance must be a boolean`],
    ['no batch', rootState, proposal({ batch: undefined as unknown as TaskProposalChild[] }), `task: proposal "${PROPOSAL_ID}" batch must be an array`],
    ['a batch that is not a list', rootState, proposal({ batch: 'contracts' as unknown as TaskProposalChild[] }), `task: proposal "${PROPOSAL_ID}" batch must be an array`],
    ['a batch with fewer children than the identity', rootState, proposal({ batch: [BATCH[0]!] }), `task: proposal "${PROPOSAL_ID}" batch requires one child per identity child (identity children: 2, batch children: 1)`],
    ['a batch with more children than the identity', rootState, proposal({ batch: [...BATCH, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" batch requires one child per identity child (identity children: 2, batch children: 3)`],
    ['a batch child that is not an object', rootState, proposal({ batch: ['contract' as unknown as TaskProposalChild, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 must be an object`],
    ['a batch child with an unsupported field', rootState, proposal({ batch: [{ ...BATCH[0]!, extra: 1 } as unknown as TaskProposalChild, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 has an unsupported field "extra"`],
    ['a batch child without a contract', rootState, proposal({ batch: [{ ...BATCH[0]!, contract: undefined } as unknown as TaskProposalChild, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 requires a contract`],
    ['a batch child naming an unknown contract version', rootState, proposal({ batch: [{ ...BATCH[0]!, contract: { ...CONTRACT_A, contractVersion: 2 as 1 } }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 declares contract version 2; this build stores version 1`],
    ['a batch child with a non-string objective', rootState, proposal({ batch: [{ ...BATCH[0]!, contract: { ...CONTRACT_A, objective: 7 as unknown as string } }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 contract objective must be a string`],
    ['a batch child with a malformed constraint list', rootState, proposal({ batch: [{ ...BATCH[0]!, contract: { ...CONTRACT_A, constraints: 'none' as unknown as string[] } }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 contract constraints must be an array of strings`],
    ['a batch child with a non-string assumption', rootState, proposal({ batch: [BATCH[0]!, { ...BATCH[1]!, contract: { ...CONTRACT_B, assumptions: [7 as unknown as string] } }] }), `task: proposal "${PROPOSAL_ID}" child 1 contract assumptions must be an array of strings`],
    ['a batch child with a non-list dependsOn', rootState, proposal({ batch: [{ ...BATCH[0]!, dependsOn: 0 as unknown as number[] }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 dependsOn must be an array of non-negative integers`],
    ['a batch child with a fractional dependency', rootState, proposal({ batch: [{ ...BATCH[0]!, dependsOn: [0.5] }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 dependsOn must be an array of non-negative integers`],
    ['a batch child with a non-boolean decomposable', rootState, proposal({ batch: [{ ...BATCH[0]!, decomposable: 'yes' as unknown as boolean }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 decomposable must be a boolean`],
    ['a batch child with a non-boolean requiresIndependentAcceptance', rootState, proposal({ batch: [{ ...BATCH[0]!, requiresIndependentAcceptance: 1 as unknown as boolean }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 requiresIndependentAcceptance must be a boolean`],
    ['a batch contract that is not the one the identity digests', rootState, proposal({ batch: [{ ...BATCH[0]!, contract: CONTRACT_B }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 contract digest "${DIGEST_B}" does not match its identity digest "${DIGEST_A}"`],
    ['a batch objective that is not the one the identity digests', rootState, proposal({ batch: [{ ...BATCH[0]!, contract: { ...CONTRACT_A, objective: 'collect the output' } }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 contract digest "${contractDigest({ ...CONTRACT_A, objective: 'collect the output' })}" does not match its identity digest "${DIGEST_A}"`],
    ['a batch dependency that is not the one the identity records', rootState, proposal({ batch: [{ ...BATCH[0]!, dependsOn: [1] }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 dependsOn does not match its identity`],
    ['a batch decomposable flag that is not the one the identity records', rootState, proposal({ batch: [{ ...BATCH[0]!, decomposable: true }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 decomposable does not match its identity`],
    ['a batch independence flag that is not the one the identity records', rootState, proposal({ batch: [{ ...BATCH[0]!, requiresIndependentAcceptance: true }, BATCH[1]!] }), `task: proposal "${PROPOSAL_ID}" child 0 requiresIndependentAcceptance does not match its identity`],
    ['a forged proposal digest', rootState, proposal({ proposalDigest: DIGEST_A }), `task: proposal "${PROPOSAL_ID}" proposal digest "${DIGEST_A}" does not match its identity digest "${decompositionDigest(IDENTITY)}"`],
    ['a mis-shaped proposal digest', rootState, proposal({ proposalDigest: 'not-a-digest' }), `task: proposal "${PROPOSAL_ID}" proposal digest "not-a-digest" does not match its identity digest "${decompositionDigest(IDENTITY)}"`],
    ['a non-object admission context', rootState, proposal({ admissionContext: 'limits' as unknown as AdmissionContext }), `task: proposal "${PROPOSAL_ID}" requires an admission context`],
    ['a negative maxDepth', rootState, proposal({ admissionContext: { ...ADMISSION_CONTEXT, maxDepth: -1 }, admissionContextDigest: admissionContextDigest({ ...ADMISSION_CONTEXT, maxDepth: -1 }) }), `task: proposal "${PROPOSAL_ID}" admission context maxDepth must be a non-negative integer`],
    ['a forged admission context digest', rootState, proposal({ admissionContextDigest: DIGEST_B }), `task: proposal "${PROPOSAL_ID}" admission context digest "${DIGEST_B}" does not match its context digest "${ADMISSION_CONTEXT_SHA256}"`],
    ['a non-object review context', rootState, proposal({ reviewContext: 'verifiers' as unknown as TaskProposalReviewContext }), `task: proposal "${PROPOSAL_ID}" requires a review context`],
    ['a non-digest manifest digest', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, capabilityManifestDigest: 'x' }, reviewContextDigest: '0'.repeat(64) }), `task: proposal "${PROPOSAL_ID}" review context capability manifest digest must be a lowercase SHA-256 hex digest`],
    ['a non-list verifiers', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, verifiers: 'composite' as unknown as TaskProposalReviewContext['verifiers'] } }), `task: proposal "${PROPOSAL_ID}" review context verifiers must be an array`],
    ['a non-object verifier entry', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, verifiers: ['composite' as unknown as TaskProposalReviewContext['verifiers'][number]] } }), `task: proposal "${PROPOSAL_ID}" review context verifiers must be objects`],
    ['an unsupported review context field', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, note: 'extra' } as unknown as TaskProposalReviewContext }), `task: proposal "${PROPOSAL_ID}" review context has an unsupported field "note"`],
    ['an unsupported verifier field', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, verifiers: [{ verifierId: 'composite', target: 'bb' } as unknown as TaskProposalReviewContext['verifiers'][number]] } }), `task: proposal "${PROPOSAL_ID}" review context verifier has an unsupported field "target"`],
    ['a verifier without an id', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, verifiers: [{ verifierId: '' }] } }), `task: proposal "${PROPOSAL_ID}" review context verifier requires a verifier id`],
    ['a verifier with an empty version', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, verifiers: [{ verifierId: 'composite', version: '' }] } }), `task: proposal "${PROPOSAL_ID}" review context verifier "composite" version must be a non-empty string when present`],
    ['a verifier with a non-digest configuration', rootState, proposal({ reviewContext: { ...REVIEW_CONTEXT, verifiers: [{ verifierId: 'composite', configurationDigest: 'zz' }] } }), `task: proposal "${PROPOSAL_ID}" review context verifier "composite" configuration digest must be a lowercase SHA-256 hex digest when present`],
    ['a forged review context digest', rootState, proposal({ reviewContextDigest: DIGEST_B }), `task: proposal "${PROPOSAL_ID}" review context digest "${DIGEST_B}" does not match its context digest "${REVIEW_CONTEXT_SHA256}"`],
    ['a missing creation time', rootState, proposal({ createdAt: '' }), `task: proposal "${PROPOSAL_ID}" requires a creation time`],
    ['a proposal submitted with a decision', rootState, proposal({ decision: { outcome: 'approved', proposalDigest: decompositionDigest(IDENTITY), admissionContextDigest: ADMISSION_CONTEXT_SHA256, decidedBy: 'operator', decidedAt: NOW } }), `task: proposal "${PROPOSAL_ID}" is submitted with a decision`],
    ['a proposal submitted with a consumption', rootState, proposal({ consumption: consumption() }), `task: proposal "${PROPOSAL_ID}" is submitted with a consumption`],
    ['a duplicate proposal id', readyState, proposal({ requestKey: 'k-9' }), `task: proposal "${PROPOSAL_ID}" already exists`],
    ['a second proposal on one request key', readyState, proposal({ proposalId: 'p-other' }), `task: proposal request key "k-1" is already bound to proposal "${PROPOSAL_ID}"`],
  ]

  test.each(refused)('refuses %s and stores nothing', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => submit(state, value)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  test('a store written before proposals existed reads as one with no proposals', () => {
    const state = rootState()
    expect(state.snapshot().proposals).toEqual({ all: [], byId: {}, byRequestKey: {}, byParentTask: {} })
  })
})

describe('TaskState proposal decisions', () => {
  test('records an approval bound to the digest and the two context fingerprints', () => {
    const state = approvedState()
    const value = stored(state)
    expect(value?.status).toBe('approved')
    expect(value?.updatedAt).toBe(NOW)
    expect(value?.decision).toEqual({
      outcome: 'approved',
      proposalDigest: decompositionDigest(IDENTITY),
      admissionContextDigest: ADMISSION_CONTEXT_SHA256,
      reviewContextDigest: REVIEW_CONTEXT_SHA256,
      decidedBy: 'operator',
      decidedAt: NOW,
    })
  })

  test('records a rejection and a cancellation with their reason, and keeps the record', () => {
    const rejected = decide(pendingState(), claim({ outcome: 'rejected', reason: 'the second child is not independent' }))
    expect(stored(rejected)?.status).toBe('rejected')
    expect(stored(rejected)?.decision?.reason).toBe('the second child is not independent')

    const cancelled = decide(readyState(), claim({ outcome: 'cancelled' }))
    expect(stored(cancelled)?.status).toBe('cancelled')
  })

  test('an approval that arrives after the parent run ended expires a pending proposal instead', () => {
    const state = decide(pendingState(), claim({ outcome: 'expired', reason: 'parent run r-root is cancelled' }))
    expect(stored(state)?.status).toBe('expired')
    expect(stored(state)?.decision?.outcome).toBe('expired')
    // The proposal is retained: the approval is a fact about a proposal that can no longer be dispatched.
    expect(state.snapshot().proposals?.all).toHaveLength(1)
  })

  const refused: Array<[string, () => TaskState, TaskProposalDecisionClaim, string]> = [
    ['an unknown proposal', readyState, claim({ proposalId: 'p-ghost' }), 'task: unknown proposal "p-ghost"'],
    ['an unknown outcome', pendingState, claim({ outcome: 'deferred' as 'approved' }), `task: proposal "${PROPOSAL_ID}" decision outcome must be one of approved, rejected, cancelled, expired`],
    ['an approval of a policy-off ready proposal', readyState, claim(), `task: illegal proposal transition "ready" → "approved" for proposal "${PROPOSAL_ID}"`],
    ['a rejection of a policy-off ready proposal', readyState, claim({ outcome: 'rejected' }), `task: illegal proposal transition "ready" → "rejected" for proposal "${PROPOSAL_ID}"`],
    ['an approval of a ready proposal that lost its approval', recheckedState, claim(), `task: illegal proposal transition "ready" → "approved" for proposal "${PROPOSAL_ID}"`],
    ['a decision on an admitted proposal', admittedState, claim({ outcome: 'cancelled' }), `task: illegal proposal transition "admitted" → "cancelled" for proposal "${PROPOSAL_ID}"`],
    ['a second decision', approvedState, claim({ outcome: 'rejected' }), `task: illegal proposal transition "approved" → "rejected" for proposal "${PROPOSAL_ID}"`],
    ['a decision digest that is not the stored one', pendingState, claim({ proposalDigest: DIGEST_A }), `task: proposal "${PROPOSAL_ID}" decision digest "${DIGEST_A}" does not match the stored proposal digest "${decompositionDigest(IDENTITY)}"`],
    ['an admission context digest that is not the stored one', pendingState, claim({ admissionContextDigest: DIGEST_B }), `task: proposal "${PROPOSAL_ID}" decision admission context digest "${DIGEST_B}" does not match the stored admission context digest "${ADMISSION_CONTEXT_SHA256}"`],
    ['an approval without the review context it was decided against', pendingState, claim({ reviewContextDigest: undefined }), `task: proposal "${PROPOSAL_ID}" approval requires the review context digest it was decided against`],
    ['an approval whose review context moved after the review', pendingState, claim({ reviewContextDigest: DIGEST_A }), `task: proposal "${PROPOSAL_ID}" decision review context digest "${DIGEST_A}" does not match the stored review context digest "${REVIEW_CONTEXT_SHA256}"`],
    ['a rejection naming another review context', pendingState, claim({ outcome: 'rejected', reviewContextDigest: DIGEST_A }), `task: proposal "${PROPOSAL_ID}" decision review context digest "${DIGEST_A}" does not match the stored review context digest "${REVIEW_CONTEXT_SHA256}"`],
    ['a decision without a decider', pendingState, claim({ decidedBy: '' }), `task: proposal "${PROPOSAL_ID}" decision requires a decider`],
    ['a decision without a decision time', pendingState, claim({ decidedAt: '' }), `task: proposal "${PROPOSAL_ID}" decision requires a decision time`],
    ['an empty reason', pendingState, claim({ outcome: 'rejected', reason: '' }), `task: proposal "${PROPOSAL_ID}" decision reason must be a non-empty string when present`],
    ['an expiry without a reason', pendingState, claim({ outcome: 'expired' }), `task: proposal "${PROPOSAL_ID}" expiry requires a reason`],
  ]

  test.each(refused)('refuses %s and leaves the proposal as it was', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => decide(state, value)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  test('refuses a decision whose envelope names another task and changes nothing', () => {
    const state = pendingState()
    const before = state.snapshot()
    expect(() => state.apply(ev('TaskProposalDecided', claim(), { taskId: 'other' })))
      .toThrow(`task: proposal "${PROPOSAL_ID}" belongs to task "root", not "other"`)
    expect(state.snapshot()).toEqual(before)
  })

  test('every view of the index shows the same updated record', () => {
    const index = approvedState().snapshot().proposals
    expect(index?.byId[PROPOSAL_ID]?.status).toBe('approved')
    expect(index?.byRequestKey['k-1']?.status).toBe('approved')
    expect(index?.byParentTask[PARENT]?.[0]?.status).toBe('approved')
    expect(index?.all[0]?.status).toBe('approved')

    const consumed = admittedState().snapshot().proposals
    expect(batchConsumptionOf(consumed?.byRequestKey['k-1'])?.childTaskIds).toEqual(['c1', 'c2'])
    expect(consumed?.byParentTask[PARENT]?.[0]?.status).toBe('admitted')
    expect(consumed?.all[0]?.status).toBe('admitted')
  })
})

describe('TaskState proposal phase changes', () => {
  test('a policy-off proposal can be sent to review once the deployment tightens to all', () => {
    const state = changePhase(readyState(), { proposalId: PROPOSAL_ID, to: 'pending_review' })
    expect(stored(state)?.status).toBe('pending_review')
    // The submit-time policy is what this field means, so tightening moves the
    // status and never rewrites the policy the proposal was born under.
    expect(stored(state)?.policy).toBe('off')
    expect(stored(state)?.updatedAt).toBe(NOW)
  })

  test('an approved proposal becomes ready once its re-check passed', () => {
    expect(stored(recheckedState())?.status).toBe('ready')
    expect(stored(recheckedState())?.decision?.outcome).toBe('approved')
  })

  test('a re-check that failed marks the proposal stale with the reason', () => {
    const state = changePhase(recheckedState(), { proposalId: PROPOSAL_ID, to: 'stale', reason: 'verifier deterministic moved 2.0.0 → 2.0.1' })
    expect(stored(state)?.status).toBe('stale')
    expect(stored(state)?.decision?.outcome).toBe('approved')

    const approved = changePhase(approvedState(), { proposalId: PROPOSAL_ID, to: 'stale', reason: 'capability manifest changed' })
    expect(stored(approved)?.status).toBe('stale')
  })

  const refused: Array<[string, () => TaskState, TaskProposalPhaseChange, string]> = [
    ['an unknown proposal', readyState, { proposalId: 'p-ghost', to: 'stale', reason: 'gone' }, 'task: unknown proposal "p-ghost"'],
    ['an unknown phase', readyState, { proposalId: PROPOSAL_ID, to: 'approved' as 'ready' }, `task: proposal "${PROPOSAL_ID}" phase must be one of ready, pending_review, stale`],
    ['a re-review of a proposal already awaiting review', pendingState, { proposalId: PROPOSAL_ID, to: 'pending_review' }, `task: illegal proposal transition "pending_review" → "pending_review" for proposal "${PROPOSAL_ID}"`],
    ['a re-check pass without an approval', readyState, { proposalId: PROPOSAL_ID, to: 'ready' }, `task: illegal proposal transition "ready" → "ready" for proposal "${PROPOSAL_ID}"`],
    ['a stale marking of a proposal awaiting review', pendingState, { proposalId: PROPOSAL_ID, to: 'stale', reason: 'context moved' }, `task: illegal proposal transition "pending_review" → "stale" for proposal "${PROPOSAL_ID}"`],
    ['a stale marking of an admitted proposal', admittedState, { proposalId: PROPOSAL_ID, to: 'stale', reason: 'context moved' }, `task: illegal proposal transition "admitted" → "stale" for proposal "${PROPOSAL_ID}"`],
    ['a stale marking without a reason', readyState, { proposalId: PROPOSAL_ID, to: 'stale' }, `task: proposal "${PROPOSAL_ID}" is marked stale without a reason`],
    ['an empty stale reason', readyState, { proposalId: PROPOSAL_ID, to: 'stale', reason: '' }, `task: proposal "${PROPOSAL_ID}" is marked stale without a reason`],
    ['an empty phase change reason', readyState, { proposalId: PROPOSAL_ID, to: 'pending_review', reason: '' }, `task: proposal "${PROPOSAL_ID}" phase change reason must be a non-empty string when present`],
  ]

  test.each(refused)('refuses %s and leaves the proposal as it was', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => changePhase(state, value)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })
})

describe('TaskState proposal consumption', () => {
  test('an approved proposal binds the batch ids it was admitted as', () => {
    const state = withChildren(recheckedState(), ['c1', 'c2'])
    state.apply(ev('TaskProposalAdmitted', consumption(), { taskId: PARENT }))
    const value = stored(state)
    expect(value?.status).toBe('admitted')
    expect(value?.consumption).toEqual({
      proposalId: PROPOSAL_ID,
      proposalDigest: decompositionDigest(IDENTITY),
      reviewContextDigest: REVIEW_CONTEXT_SHA256,
      parentRunId: 'r-root',
      batchId: batchIdFor('r-root', PROPOSAL_ID),
      childTaskIds: ['c1', 'c2'],
      admittedAt: NOW,
    })
    expect(value?.decision?.outcome).toBe('approved')
    expect(value?.updatedAt).toBe(NOW)
  })

  test('a policy-off proposal is consumed from ready, with no decision recorded', () => {
    const state = withChildren(readyState(), ['c1', 'c2'])
    state.apply(ev('TaskProposalAdmitted', consumption(), { taskId: PARENT }))
    expect(stored(state)?.status).toBe('admitted')
    expect(stored(state)?.decision).toBeUndefined()
  })

  const refused: Array<[string, () => TaskState, TaskProposalConsumption, string]> = [
    ['an unknown proposal', readyState, consumption({ proposalId: 'p-ghost' }), 'task: unknown proposal "p-ghost"'],
    ['a consumption of a proposal still awaiting review', () => withChildren(pendingState(), ['c1', 'c2']), consumption(), `task: illegal proposal transition "pending_review" → "admitted" for proposal "${PROPOSAL_ID}"`],
    ['a consumption of an approved proposal that never passed its re-check', () => withChildren(approvedState(), ['c1', 'c2']), consumption(), `task: illegal proposal transition "approved" → "admitted" for proposal "${PROPOSAL_ID}"`],
    ['a consumption of a rejected proposal', () => withChildren(decide(pendingState(), claim({ outcome: 'rejected' })), ['c1', 'c2']), consumption(), `task: illegal proposal transition "rejected" → "admitted" for proposal "${PROPOSAL_ID}"`],
    ['a consumption of a stale proposal', () => withChildren(changePhase(readyState(), { proposalId: PROPOSAL_ID, to: 'stale', reason: 'context moved' }), ['c1', 'c2']), consumption(), `task: illegal proposal transition "stale" → "admitted" for proposal "${PROPOSAL_ID}"`],
    ['a consumption of an expired proposal', () => withChildren(decide(pendingState(), claim({ outcome: 'expired', reason: 'parent run ended' })), ['c1', 'c2']), consumption(), `task: illegal proposal transition "expired" → "admitted" for proposal "${PROPOSAL_ID}"`],
    ['a second consumption of one proposal', admittedState, consumption(), `task: illegal proposal transition "admitted" → "admitted" for proposal "${PROPOSAL_ID}"`],
    ['a consumption without a batch id', () => withChildren(readyState(), ['c1', 'c2']), consumption({ batchId: '' }), `task: proposal "${PROPOSAL_ID}" consumption requires a batch id`],
    [
      'a consumption from before batches were identified by run and proposal',
      () => withChildren(readyState(), ['c1', 'c2']),
      consumption({ parentRunId: undefined, batchId: `b-${PARENT}` }),
      `task: proposal "${PROPOSAL_ID}" consumption requires the parent run its batch belongs to; a consumption from before batches were identified by run and proposal is refused, not guessed at`,
    ],
    [
      'a consumption naming a parent run that is not the identity\'s',
      () => withChildren(readyState(), ['c1', 'c2']),
      consumption({ parentRunId: 'r-other' }),
      `task: proposal "${PROPOSAL_ID}" consumption names parent run "r-other", not the run "r-root" its identity names`,
    ],
    [
      'a consumption naming a foreign batch',
      () => withChildren(readyState(), ['c1', 'c2']),
      consumption({ batchId: 'b-other' }),
      `task: proposal "${PROPOSAL_ID}" consumption batch "b-other" is not the batch of run "r-root" and proposal "${PROPOSAL_ID}" ("${batchIdFor('r-root', PROPOSAL_ID)}")`,
    ],
    [
      'a consumption whose batch id is another proposal\'s',
      () => withChildren(readyState(), ['c1', 'c2']),
      consumption({ batchId: batchIdFor('r-root', 'p-other') }),
      `task: proposal "${PROPOSAL_ID}" consumption batch "${batchIdFor('r-root', 'p-other')}" is not the batch of run "r-root" and proposal "${PROPOSAL_ID}" ("${batchIdFor('r-root', PROPOSAL_ID)}")`,
    ],
    ['a consumption without children', () => withChildren(readyState(), ['c1', 'c2']), consumption({ childTaskIds: [] }), `task: proposal "${PROPOSAL_ID}" consumption requires at least one child task id`],
    ['a consumption with an empty child id', () => withChildren(readyState(), ['c1', 'c2']), consumption({ childTaskIds: ['c1', ''] }), `task: proposal "${PROPOSAL_ID}" consumption child task ids must be non-empty strings`],
    ['a consumption naming one child twice', () => withChildren(readyState(), ['c1', 'c2']), consumption({ childTaskIds: ['c1', 'c1'] }), `task: proposal "${PROPOSAL_ID}" consumption names task "c1" twice`],
    ['a consumption naming an unknown task', () => withChildren(readyState(), ['c1', 'c2']), consumption({ childTaskIds: ['c1', 'ghost'] }), `task: proposal "${PROPOSAL_ID}" consumption names unknown task "ghost"`],
    ['a consumption naming a task that is not its child', () => withChildren(readyState(), ['c1']), consumption({ childTaskIds: ['c1', PARENT] }), `task: proposal "${PROPOSAL_ID}" consumption names task "root", which is not a child of "root"`],
    ['a consumption with a forged proposal digest', () => withChildren(readyState(), ['c1', 'c2']), consumption({ proposalDigest: DIGEST_A }), `task: proposal "${PROPOSAL_ID}" consumption digest "${DIGEST_A}" does not match the stored proposal digest "${decompositionDigest(IDENTITY)}"`],
    ['a consumption without a review context digest', () => withChildren(readyState(), ['c1', 'c2']), consumption({ reviewContextDigest: '' }), `task: proposal "${PROPOSAL_ID}" consumption requires a review context digest`],
    ['a consumption whose review context moved', () => withChildren(readyState(), ['c1', 'c2']), consumption({ reviewContextDigest: DIGEST_B }), `task: proposal "${PROPOSAL_ID}" consumption review context digest "${DIGEST_B}" does not match the stored review context digest "${REVIEW_CONTEXT_SHA256}"`],
    ['a consumption without an admission time', () => withChildren(readyState(), ['c1', 'c2']), consumption({ admittedAt: '' }), `task: proposal "${PROPOSAL_ID}" consumption requires an admission time`],
    ['a consumption with an empty reason', () => withChildren(readyState(), ['c1', 'c2']), consumption({ reason: '' }), `task: proposal "${PROPOSAL_ID}" consumption reason must be a non-empty string when present`],
  ]

  test.each(refused)('refuses %s and stores no consumption', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => state.apply(ev('TaskProposalAdmitted', value, { taskId: PARENT }))).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })
})

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

interface Harness {
  readonly ctx: unknown
  readonly sessions: Map<string, StoredSession>
  readonly changes: string[]
}

function harness(sessions = new Map<string, StoredSession>()): Harness {
  const changes: string[] = []
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }
  const ctx = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => { execute() },
    emit: (event: string, value: { id: string }) => {
      if (event === 'task/change') changes.push(value.id)
    },
    on: () => {},
    sessionPersistence: persistence,
  }
  return { ctx, sessions, changes }
}

function storedEvents(h: Harness): SessionEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events)
}

function persistedKinds(h: Harness): string[] {
  return storedEvents(h).map(item => (item.data as TaskEvent).kind)
}

/** A store with an admitted, decomposable root task. */
async function rootService(): Promise<{ h: Harness; service: TaskService }> {
  const h = harness()
  const service = new TaskService(h.ctx as never)
  await service.createStore(STORE)
  await service.createTaskIn(STORE, task({ taskId: PARENT, decompositionStatus: 'decomposable' }), 'tester')
  await service.admitTaskIn(STORE, PARENT, 'tester', { decompositionStatus: 'decomposable' })
  return { h, service }
}

/** The parent's own run: the batch admission closes its `active → waiting_children` gate. */
async function startParentRun(service: TaskService): Promise<void> {
  await service.startRunIn(STORE, {
    runId: 'r-root',
    taskId: PARENT,
    sessionId: 's-root',
    capabilitySnapshot: [],
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
  }, 'tester')
}

describe('TaskService proposal entries', () => {
  test('submitProposalIn writes one event and answers the three queries', async () => {
    const { h, service } = await rootService()
    const before = storedEvents(h).length
    await service.submitProposalIn(STORE, proposal(), 'tester')
    expect(storedEvents(h).length - before).toBe(1)
    expect(persistedKinds(h).at(-1)).toBe('TaskProposalSubmitted')

    const index = (await service.snapshotIn(STORE)).proposals
    expect(index?.all.map(item => item.proposalId)).toEqual([PROPOSAL_ID])
    expect(index?.byId[PROPOSAL_ID]?.status).toBe('ready')
    expect(index?.byRequestKey['k-1']?.proposalId).toBe(PROPOSAL_ID)
    expect(index?.byParentTask[PARENT]?.map(item => item.proposalId)).toEqual([PROPOSAL_ID])
  })

  test('a pending proposal survives a restart and only the matching approval moves it', async () => {
    const { h, service } = await rootService()
    await service.submitProposalIn(STORE, pendingProposal(), 'tester')
    expect(persistedKinds(h)).toEqual(['TaskCreated', 'TaskAdmitted', 'TaskProposalSubmitted'])

    const reopened = new TaskService(harness(h.sessions).ctx as never)
    const snapshot = await reopened.openStore(STORE)
    expect(snapshot.proposals?.byId[PROPOSAL_ID]?.status).toBe('pending_review')
    expect(snapshot.proposals?.byRequestKey['k-1']?.proposalDigest).toBe(decompositionDigest(IDENTITY))
    // The whole batch is back from the log: a re-sent approval request (or a
    // canvas view) renders from the store, not from the caller's memory.
    expect(decompositionOf(snapshot.proposals?.byId[PROPOSAL_ID])?.batch).toEqual(BATCH)

    const before = storedEvents(h).length
    await expect(reopened.decideProposalIn(STORE, claim({ proposalDigest: DIGEST_A }), 'operator'))
      .rejects.toThrow(`task: proposal "${PROPOSAL_ID}" decision digest "${DIGEST_A}" does not match the stored proposal digest "${decompositionDigest(IDENTITY)}"`)
    expect(storedEvents(h).length).toBe(before)

    await reopened.decideProposalIn(STORE, claim(), 'operator')
    expect((await reopened.snapshotIn(STORE)).proposals?.byId[PROPOSAL_ID]?.status).toBe('approved')
    expect(persistedKinds(h).at(-1)).toBe('TaskProposalDecided')
  })

  test('the phase change, decision, and consumption entries each write one event', async () => {
    const { h, service } = await rootService()
    await service.submitProposalIn(STORE, pendingProposal(), 'tester')
    await service.decideProposalIn(STORE, claim(), 'operator')
    await service.changeProposalPhaseIn(STORE, { proposalId: PROPOSAL_ID, to: 'ready' }, 'runtime')
    for (const child of [task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 }), task({ taskId: 'c2', parentTaskId: PARENT, depth: 1 })]) {
      await service.createTaskIn(STORE, child, 'runtime')
      await service.admitTaskIn(STORE, child.taskId, 'runtime')
    }
    await service.consumeProposalIn(STORE, consumption(), 'runtime')
    expect(persistedKinds(h).filter(kind => kind.startsWith('TaskProposal'))).toEqual([
      'TaskProposalSubmitted',
      'TaskProposalDecided',
      'TaskProposalPhaseChanged',
      'TaskProposalAdmitted',
    ])
    const value = (await service.snapshotIn(STORE)).proposals?.byId[PROPOSAL_ID]
    expect(value?.status).toBe('admitted')
    expect(batchConsumptionOf(value)?.childTaskIds).toEqual(['c1', 'c2'])
  })

  test('an entry for an unknown proposal is refused before anything is written', async () => {
    const { h, service } = await rootService()
    const before = persistedKinds(h)
    await expect(service.decideProposalIn(STORE, claim({ proposalId: 'p-ghost' }), 'operator')).rejects.toThrow('task: unknown proposal "p-ghost"')
    await expect(service.changeProposalPhaseIn(STORE, { proposalId: 'p-ghost', to: 'stale', reason: 'gone' }, 'runtime'))
      .rejects.toThrow('task: unknown proposal "p-ghost"')
    await expect(service.consumeProposalIn(STORE, consumption({ proposalId: 'p-ghost' }), 'runtime'))
      .rejects.toThrow('task: unknown proposal "p-ghost"')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('admitBatchIn lands the batch and the proposal consumption in one commit', async () => {
    const { h, service } = await rootService()
    await service.submitProposalIn(STORE, proposal(), 'tester')
    await startParentRun(service)
    const before = storedEvents(h).length
    await service.admitBatchIn(
      STORE,
      PARENT,
      'r-root',
      [
        task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 }),
        task({ taskId: 'c2', parentTaskId: PARENT, depth: 1 }),
      ],
      'runtime',
      [],
      undefined,
      undefined,
      consumption(),
    )
    expect(persistedKinds(h).slice(before)).toEqual([
      'TaskCreated',
      'TaskAdmitted',
      'TaskCreated',
      'TaskAdmitted',
      'TaskDecomposed',
      'RunPhaseChanged',
      'TaskProposalAdmitted',
    ])
    const snapshot = await service.snapshotIn(STORE)
    expect((await service.taskIn(STORE, PARENT)).childTaskIds).toEqual(['c1', 'c2'])
    expect(snapshot.proposals?.byId[PROPOSAL_ID]?.status).toBe('admitted')
    expect(batchConsumptionOf(snapshot.proposals?.byId[PROPOSAL_ID])?.batchId).toBe(batchIdFor('r-root', PROPOSAL_ID))
  })

  test('a consumption misaligned with the batch refuses the whole commit', async () => {
    const { h, service } = await rootService()
    await service.submitProposalIn(STORE, proposal(), 'tester')
    await startParentRun(service)
    const before = persistedKinds(h)
    await expect(
      service.admitBatchIn(
        STORE,
        PARENT,
        'r-root',
        [
          task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 }),
          task({ taskId: 'c2', parentTaskId: PARENT, depth: 1 }),
        ],
        'runtime',
        [],
        undefined,
        undefined,
        consumption({ childTaskIds: ['c1'] }),
      ),
    ).rejects.toThrow('task: admit batch requires the proposal consumption to name its children in batch order (2 children, 1 consumed)')
    expect(persistedKinds(h)).toEqual(before)
    expect((await service.snapshotIn(STORE)).tasks).toHaveLength(1)

    // The store is still writable and the consumption still lands on the aligned batch.
    await service.admitBatchIn(
      STORE,
      PARENT,
      'r-root',
      [
        task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 }),
        task({ taskId: 'c2', parentTaskId: PARENT, depth: 1 }),
      ],
      'runtime',
      [],
      undefined,
      undefined,
      consumption(),
    )
    expect((await service.snapshotIn(STORE)).proposals?.byId[PROPOSAL_ID]?.status).toBe('admitted')
  })

  test('a store reopened after a consumption still reports the batch the proposal was consumed as', async () => {
    const { h, service } = await rootService()
    await service.submitProposalIn(STORE, proposal(), 'tester')
    await startParentRun(service)
    await service.admitBatchIn(
      STORE,
      PARENT,
      'r-root',
      [task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 }), task({ taskId: 'c2', parentTaskId: PARENT, depth: 1 })],
      'runtime',
      [],
      undefined,
      undefined,
      consumption(),
    )
    for (const item of storedEvents(h)) {
      expect(JSON.parse(JSON.stringify(item))).toStrictEqual(item)
    }
    const reopened = new TaskService(harness(h.sessions).ctx as never)
    const snapshot = await reopened.openStore(STORE)
    const value = snapshot.proposals?.byId[PROPOSAL_ID]
    expect(value?.status).toBe('admitted')
    expect(batchConsumptionOf(value)?.childTaskIds).toEqual(['c1', 'c2'])
    expect(value?.proposalDigest).toBe(decompositionDigest(IDENTITY))
  })
})

describe('TaskService legacy stores', () => {
  test('a store written before proposals opens with an empty index and stays writable', async () => {
    const sessions = new Map<string, StoredSession>()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: makeSessionId(STORE), createdAt: 0, isSeeded: false }
    sessions.set(STORE, {
      header,
      events: [
        { type: 'task/event', seq: SessionSeq(0), time: 0, ignorable: true, data: ev('TaskCreated', { task: task({ taskId: PARENT, decompositionStatus: 'decomposable' }) }, { taskId: PARENT }) },
        { type: 'task/event', seq: SessionSeq(1), time: 0, ignorable: true, data: ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: PARENT }) },
      ] as SessionEvent[],
    })
    const h = harness(sessions)
    const service = new TaskService(h.ctx as never)
    const snapshot = await service.openStore(STORE)
    expect(snapshot.proposals).toEqual({ all: [], byId: {}, byRequestKey: {}, byParentTask: {} })
    expect((await service.taskIn(STORE, PARENT)).status).toBe('admitted')

    await service.submitProposalIn(STORE, proposal(), 'tester')
    expect((await service.snapshotIn(STORE)).proposals?.byId[PROPOSAL_ID]?.status).toBe('ready')
  })

  test('a store holding a batch consumed before the pair identity stops by name at replay', async () => {
    // The pre-change record: `b-<parentTaskId>`, no parent run, no proposal
    // binding. This build cannot tell which run admitted it, and guessing would
    // hand a later reader a batch that is not the one the record describes.
    const oldConsumption = {
      kind: 'batch',
      proposalId: PROPOSAL_ID,
      proposalDigest: decompositionDigest(IDENTITY),
      reviewContextDigest: REVIEW_CONTEXT_SHA256,
      batchId: `b-${PARENT}`,
      childTaskIds: ['c1', 'c2'],
      admittedAt: NOW,
    }
    const sessions = new Map<string, StoredSession>()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: makeSessionId(STORE), createdAt: 0, isSeeded: false }
    sessions.set(STORE, {
      header,
      events: [
        ev('TaskCreated', { task: task({ taskId: PARENT, decompositionStatus: 'decomposable' }) }, { taskId: PARENT }),
        ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: PARENT }),
        ev('TaskProposalSubmitted', { proposal: proposal() }, { taskId: PARENT }),
        ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 }) }, { taskId: 'c1', parentTaskId: PARENT }),
        ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }),
        ev('TaskCreated', { task: task({ taskId: 'c2', parentTaskId: PARENT, depth: 1 }) }, { taskId: 'c2', parentTaskId: PARENT }),
        ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c2' }),
        ev('TaskProposalAdmitted', oldConsumption as unknown as TaskProposalConsumption, { taskId: PARENT }),
      ].map((data, seq) => ({ type: 'task/event', seq: SessionSeq(seq), time: 0, ignorable: true, data })) as SessionEvent[],
    })
    const service = new TaskService(harness(sessions).ctx as never)
    await expect(service.openStore(STORE)).rejects.toThrow(
      `task: proposal "${PROPOSAL_ID}" consumption requires the parent run its batch belongs to; ` +
      'a consumption from before batches were identified by run and proposal is refused, not guessed at',
    )
  })
})

/* ------------------------------------------------------------------------ *
 * Root contract proposals (A0 design §2, stage A)
 * ------------------------------------------------------------------------ */

/**
 * The approved root contract — the single normalized contract a root proposal
 * carries — and the fixed vectors the root identity rests on. Both digests
 * below were computed outside this repository (`sha256sum` over the canonical
 * texts spelled out here), so a change in the root digest's field coverage or
 * in `canonicalize` fails these tests instead of being confirmed by the
 * implementation against itself.
 */
const ROOT_CONTRACT: TaskContract = {
  contractVersion: TASK_CONTRACT_VERSION,
  objective: 'ship the root deliverable',
  acceptanceCriteria: [
    {
      criterionId: 'root-c1',
      description: 'the deliverable exists',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'test -f deliverable.txt',
    },
  ],
  assumptions: ['the workspace is writable'],
  constraints: ['no network access'],
  requiredCapabilities: ['build'],
}
const ROOT_CONTRACT_CANONICAL = [
  '{"acceptanceCriteria":[{"command":"test -f deliverable.txt","criterionId":"root-c1","description":"the deliverable exists",',
  '"mandatory":true,"requiredEvidence":[],"verificationMode":"deterministic"}],"assumptions":["the workspace is writable"],',
  '"constraints":["no network access"],"contractVersion":1,"objective":"ship the root deliverable","requiredCapabilities":["build"]}',
].join('')
const ROOT_CONTRACT_SHA256 = '2dc943bb13aa81014235b3fa8b1d009dd5b91bfdc61393d8dd11514be35dbfaf'

const ROOT_IDENTITY: RootProposalIdentity = {
  contractVersion: TASK_CONTRACT_VERSION,
  storeId: 'sg-t-root-session',
  rootSessionId: 's-root',
  requestKey: 'k-root-1',
  contractDigest: ROOT_CONTRACT_SHA256,
}
const ROOT_IDENTITY_CANONICAL = [
  `{"contractDigest":"${ROOT_CONTRACT_SHA256}","contractVersion":1,"requestKey":"k-root-1",`,
  '"rootSessionId":"s-root","storeId":"sg-t-root-session"}',
].join('')
const ROOT_PROPOSAL_DIGEST = '6480614f435dda479ef7d39f7b79b879469192df7647b999bed5a794d6e2b6c5'
const ROOT_PROPOSAL_ID = `p-${ROOT_PROPOSAL_DIGEST}`
/** A second root contract for the same store: a revision or a competing request, with its own key and id. */
const ROOT_IDENTITY_ALT: RootProposalIdentity = { ...ROOT_IDENTITY, requestKey: 'k-root-2' }

const ROOT_SESSION = 's-root'
const ROOT_TASK_ID = 't-root-1'
const ROOT_RUN_ID = 'r-root-1'

function rootIdentity(overrides: Partial<RootProposalIdentity> = {}): RootProposalIdentity {
  return { ...ROOT_IDENTITY, ...overrides }
}

/**
 * One root contract proposal. The id and the digest are derived from the
 * identity it is built for — the identity's request key included, which is what
 * makes a revision with a new key a new proposal — so a caller that passes its
 * own identity gets a record whose digests describe that identity.
 */
function rootProposal(
  overrides: Partial<TaskProposalRoot> = {},
  identity: RootProposalIdentity = ROOT_IDENTITY,
): TaskProposalRoot {
  return {
    kind: 'root',
    proposalId: rootProposalId(identity),
    requestKey: identity.requestKey,
    status: 'ready',
    policy: 'off',
    identity,
    // A fresh copy per proposal: a test that edits the caller's contract after
    // submitting it must not be able to reach the shared fixture (or the store).
    contract: structuredClone(ROOT_CONTRACT),
    proposalDigest: rootProposalDigest(identity),
    admissionContext: ADMISSION_CONTEXT,
    admissionContextDigest: admissionContextDigest(ADMISSION_CONTEXT),
    reviewContext: REVIEW_CONTEXT,
    reviewContextDigest: reviewContextDigest(REVIEW_CONTEXT),
    createdAt: NOW,
    ...overrides,
  }
}

function rootClaim(overrides: Partial<TaskProposalDecisionClaim> = {}): TaskProposalDecisionClaim {
  const value = rootProposal()
  return {
    proposalId: value.proposalId,
    proposalDigest: value.proposalDigest,
    admissionContextDigest: value.admissionContextDigest,
    reviewContextDigest: value.reviewContextDigest,
    outcome: 'approved',
    decidedBy: 'operator',
    decidedAt: NOW,
    ...overrides,
  }
}

function rootConsumptionFor(
  proposal: TaskProposalRoot,
  overrides: Partial<TaskProposalRootConsumption> = {},
): TaskProposalRootConsumption {
  return {
    kind: 'root',
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    reviewContextDigest: proposal.reviewContextDigest,
    rootTaskId: ROOT_TASK_ID,
    rootRunId: ROOT_RUN_ID,
    admittedAt: NOW,
    ...overrides,
  }
}

function rootConsumption(overrides: Partial<TaskProposalRootConsumption> = {}): TaskProposalRootConsumption {
  return rootConsumptionFor(rootProposal(), overrides)
}

/** The root task an activation mints: parentless, depth 0, carrying the contract the proposal approved. */
function rootTask(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: ROOT_TASK_ID,
    definitionRef: { taskType: RootTaskSpec.taskType, version: RootTaskSpec.version },
    objective: ROOT_CONTRACT.objective,
    depth: 0,
    acceptanceCriteria: structuredClone(ROOT_CONTRACT.acceptanceCriteria),
    requestedCapabilities: [...ROOT_CONTRACT.requiredCapabilities],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract: structuredClone(ROOT_CONTRACT),
    ...overrides,
  }
}

/** The root run an activation mints: born `active`, running, in the root session. */
function rootRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: ROOT_RUN_ID,
    taskId: ROOT_TASK_ID,
    sessionId: ROOT_SESSION,
    capabilitySnapshot: [],
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

/** A store with no task at all: the state root intake is legal in. */
function emptyState(): TaskState {
  return new TaskState(STORE)
}

function submitRoot(state: TaskState, value: TaskProposal): TaskState {
  state.apply(ev('TaskProposalSubmitted', { proposal: value }, { taskId: ROOT_PROPOSAL_TASK_ID }))
  return state
}

function readyRootState(): TaskState {
  return submitRoot(emptyState(), rootProposal())
}

function pendingRootState(): TaskState {
  return submitRoot(emptyState(), rootProposal({ status: 'pending_review', policy: 'all' }))
}

function decideRoot(state: TaskState, value: TaskProposalDecisionClaim): TaskState {
  state.apply(ev('TaskProposalDecided', value, { taskId: ROOT_PROPOSAL_TASK_ID }))
  return state
}

function changeRootPhase(state: TaskState, value: TaskProposalPhaseChange): TaskState {
  state.apply(ev('TaskProposalPhaseChanged', value, { taskId: ROOT_PROPOSAL_TASK_ID }))
  return state
}

function approvedRootState(): TaskState {
  return decideRoot(pendingRootState(), rootClaim())
}

/** An approved root proposal that passed its post-approval re-check: `approved → ready`. */
function recheckedRootState(): TaskState {
  return changeRootPhase(approvedRootState(), { proposalId: ROOT_PROPOSAL_ID, to: 'ready' })
}

/**
 * A re-checked root proposal with the task (and, unless `run` is null) the run an
 * activation mints already in the store. Created outside the activation commit
 * on purpose: these states stand in for the shapes a consumption can name —
 * a missing task, a missing run, a run that is not the one this proposal
 * approved — each of which the reducer has to refuse.
 */
function rootActivationState(task: TaskInstance | undefined = rootTask(), run: TaskRun | null = rootRun()): TaskState {
  const state = recheckedRootState()
  if (task !== undefined) {
    state.apply(ev('TaskCreated', { task }, { taskId: task.taskId }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: task.taskId }))
  }
  if (run !== null) {
    state.apply(ev('TaskStarted', { run }, { taskId: run.taskId, runId: run.runId }))
  }
  return state
}

/** The activated root plus one admitted child holding a run: the non-root shapes a consumption can point at. */
function rootWithChildState(): TaskState {
  const state = rootActivationState()
  const child = rootTask({ taskId: 'c1', parentTaskId: ROOT_TASK_ID, depth: 1, decompositionStatus: 'leaf' })
  state.apply(ev('TaskCreated', { task: child }, { taskId: 'c1', parentTaskId: ROOT_TASK_ID }))
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }))
  state.apply(ev('TaskStarted', { run: rootRun({ runId: 'r-c1', taskId: 'c1' }) }, { taskId: 'c1', runId: 'r-c1' }))
  return state
}

/** A root proposal with the shapes an activation would mint already in the store, at the status the caller starts from. */
function rootActivationStateFrom(from: TaskState): TaskState {
  from.apply(ev('TaskCreated', { task: rootTask() }, { taskId: ROOT_TASK_ID }))
  from.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: ROOT_TASK_ID }))
  from.apply(ev('TaskStarted', { run: rootRun() }, { taskId: ROOT_TASK_ID, runId: ROOT_RUN_ID }))
  return from
}

/** A stored proposal read as the root arm; `undefined` for a decomposition proposal or an absent record. */
function rootOf(value: TaskProposal | undefined): TaskProposalRoot | undefined {
  return value?.kind === 'root' ? value : undefined
}

function rootStored(state: TaskState): TaskProposalRoot | undefined {
  return rootOf(state.snapshot().proposals?.byId[ROOT_PROPOSAL_ID])
}

describe('root proposal identities', () => {
  test('hashes the root contract through its canonical text', () => {
    expect(canonicalize(ROOT_CONTRACT)).toBe(ROOT_CONTRACT_CANONICAL)
    expect(contractDigest(ROOT_CONTRACT)).toBe(ROOT_CONTRACT_SHA256)
  })

  test('hashes the root identity through its canonical text', () => {
    expect(canonicalize(ROOT_IDENTITY)).toBe(ROOT_IDENTITY_CANONICAL)
    expect(rootProposalDigest(ROOT_IDENTITY)).toBe(ROOT_PROPOSAL_DIGEST)
    expect(rootProposalId(ROOT_IDENTITY)).toBe(ROOT_PROPOSAL_ID)
  })

  test('covers the store, the root session, the request key and the contract', () => {
    const moves = [
      rootProposalDigest(rootIdentity({ storeId: 'sg-t-other' })),
      rootProposalDigest(rootIdentity({ rootSessionId: 's-other' })),
      rootProposalDigest(rootIdentity({ requestKey: 'k-root-2' })),
      rootProposalDigest(rootIdentity({ contractDigest: '0'.repeat(64) })),
    ]
    for (const digest of moves) expect(digest).not.toBe(ROOT_PROPOSAL_DIGEST)
    // Two different contracts are two different proposals even when every other
    // field is one: the identity commits to the contract digest, not to nothing.
    expect(rootProposalId(rootIdentity({ contractDigest: contractDigest(CONTRACT_A) }))).not.toBe(ROOT_PROPOSAL_ID)
  })

  test('is unmoved by the order the identity was spelled in', () => {
    const reordered: RootProposalIdentity = {
      contractDigest: ROOT_IDENTITY.contractDigest,
      requestKey: ROOT_IDENTITY.requestKey,
      rootSessionId: ROOT_IDENTITY.rootSessionId,
      storeId: ROOT_IDENTITY.storeId,
      contractVersion: ROOT_IDENTITY.contractVersion,
    }
    expect(canonicalize(reordered)).toBe(ROOT_IDENTITY_CANONICAL)
    expect(rootProposalId(reordered)).toBe(ROOT_PROPOSAL_ID)
  })

  test('reserves a proposal task id no minted task id can be', () => {
    // Task ids are minted as `t-<randomUUID()>` (task-runtime: createRootTask,
    // the decomposition batch, the replay path), so the reserved marker has to
    // be outside that shape: a root proposal event can then never be read as
    // naming a real task, and no task can ever shadow it.
    expect(ROOT_PROPOSAL_TASK_ID).toBe('root-proposal')
    expect(/^t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ROOT_PROPOSAL_TASK_ID)).toBe(false)
    expect(/^t-[0-9a-f-]{36}$/.test(`t-${'0'.repeat(36)}`)).toBe(true)
  })
})

describe('TaskState root contract proposals', () => {
  test('a policy-off root proposal is born ready and is readable through the index', () => {
    const state = readyRootState()
    const value = rootStored(state)
    expect(value?.status).toBe('ready')
    expect(value?.policy).toBe('off')
    expect(value?.kind).toBe('root')
    expect(value?.contract).toEqual(ROOT_CONTRACT)
    expect(value?.identity).toEqual(ROOT_IDENTITY)
    expect(value?.proposalDigest).toBe(ROOT_PROPOSAL_DIGEST)
    expect(value?.decision).toBeUndefined()
    expect(value?.consumption).toBeUndefined()
    const index = state.snapshot().proposals
    expect(index?.all.map(item => item.proposalId)).toEqual([ROOT_PROPOSAL_ID])
    expect(index?.byId[ROOT_PROPOSAL_ID]?.requestKey).toBe('k-root-1')
    expect(index?.byRequestKey['k-root-1']?.proposalId).toBe(ROOT_PROPOSAL_ID)
    // A root contract has no parent task, so it is not a parent's business:
    // nothing is indexed under a task that does not exist.
    expect(index?.byParentTask).toEqual({})
  })

  test('a policy-all root proposal is born pending_review', () => {
    expect(rootStored(pendingRootState())?.status).toBe('pending_review')
    expect(rootStored(pendingRootState())?.policy).toBe('all')
  })

  test('stores its own copy of the root contract: a later caller-side edit never reaches the store', () => {
    const caller = rootProposal()
    const state = submitRoot(emptyState(), caller)
    caller.contract.objective = 'tampered after submission'
    expect(rootStored(state)?.contract.objective).toBe('ship the root deliverable')
  })

  // One tampered identity per shape the reducer judges, so each refusal names the
  // id a proposal for *that* identity would carry.
  const noRootSession = rootIdentity({ rootSessionId: '' })
  const noStoreId = rootIdentity({ storeId: '' })
  const noIdentityKey = rootIdentity({ requestKey: '' })
  const wrongVersion = rootIdentity({ contractVersion: 2 as 1 })
  const badContractDigest = rootIdentity({ contractDigest: 'nope' })
  const withParentTask = { ...ROOT_IDENTITY, parentTaskId: 'root' } as unknown as RootProposalIdentity

  const refused: Array<[string, () => TaskState, TaskProposal, string]> = [
    ['an unknown kind', emptyState, rootProposal({ kind: 'root_contract' as 'root' }), `task: proposal "${ROOT_PROPOSAL_ID}" kind must be one of decomposition, root`],
    ['a root contract without its kind', emptyState, rootProposal({ kind: undefined as unknown as 'root' }), `task: proposal "${ROOT_PROPOSAL_ID}" carries root contract fields without kind "root"`],
    ['a root contract carrying a batch', emptyState, rootProposal({ batch: BATCH } as unknown as Partial<TaskProposalRoot>), `task: proposal "${ROOT_PROPOSAL_ID}" is a root contract and cannot carry a batch`],
    ['a root identity with no root session', emptyState, rootProposal({}, noRootSession), `task: proposal "${rootProposalId(noRootSession)}" identity root session id must be a non-empty string`],
    ['a root identity with an empty store id', emptyState, rootProposal({}, noStoreId), `task: proposal "${rootProposalId(noStoreId)}" identity store id must be a non-empty string`],
    ['a root proposal with no request key', emptyState, rootProposal({ requestKey: '' }, noIdentityKey), `task: proposal "${rootProposalId(noIdentityKey)}" request key must be a non-empty string`],
    ['a root identity with no request key', emptyState, rootProposal({ requestKey: 'k-root-1' }, noIdentityKey), `task: proposal "${rootProposalId(noIdentityKey)}" identity request key must be a non-empty string`],
    ['an unknown identity contract version', emptyState, rootProposal({}, wrongVersion), `task: proposal "${rootProposalId(wrongVersion)}" declares contract version 2; this build stores version 1`],
    ['a root identity without a contract digest', emptyState, rootProposal({}, badContractDigest), `task: proposal "${rootProposalId(badContractDigest)}" identity contract digest must be a lowercase SHA-256 hex digest`],
    ['a root identity carrying a parent task', emptyState, rootProposal({}, withParentTask), `task: proposal "${rootProposalId(withParentTask)}" identity has an unsupported field "parentTaskId"`],
    ['a non-object root identity', emptyState, rootProposal({ identity: 'contract' as unknown as RootProposalIdentity }), `task: proposal "${ROOT_PROPOSAL_ID}" identity must be an object`],
    ['an identity request key that disagrees with the record', emptyState, rootProposal({ requestKey: 'k-other' }), `task: proposal "${ROOT_PROPOSAL_ID}" identity request key "k-root-1" disagrees with its request key "k-other"`],
    ['a root proposal without a contract', emptyState, rootProposal({ contract: undefined as unknown as TaskContract }), `task: proposal "${ROOT_PROPOSAL_ID}" requires a root contract`],
    ['a root contract that is not an object', emptyState, rootProposal({ contract: 'objective' as unknown as TaskContract }), `task: proposal "${ROOT_PROPOSAL_ID}" requires a root contract`],
    ['a root contract with an unknown version', emptyState, rootProposal({ contract: { ...ROOT_CONTRACT, contractVersion: 2 as 1 } }), `task: proposal "${ROOT_PROPOSAL_ID}" root declares contract version 2; this build stores version 1`],
    ['a root contract with a non-string objective', emptyState, rootProposal({ contract: { ...ROOT_CONTRACT, objective: 7 as unknown as string } }), `task: proposal "${ROOT_PROPOSAL_ID}" root contract objective must be a string`],
    ['a root contract with a malformed constraint list', emptyState, rootProposal({ contract: { ...ROOT_CONTRACT, constraints: 'none' as unknown as string[] } }), `task: proposal "${ROOT_PROPOSAL_ID}" root contract constraints must be an array of strings`],
    ['a root contract with a malformed criteria list', emptyState, rootProposal({ contract: { ...ROOT_CONTRACT, acceptanceCriteria: 'all of them' as unknown as TaskContract['acceptanceCriteria'] } }), `task: proposal "${ROOT_PROPOSAL_ID}" root contract acceptance criteria must be an array`],
    ['a root contract that is not the one the identity digests', emptyState, rootProposal({ contract: CONTRACT_A }), `task: proposal "${ROOT_PROPOSAL_ID}" contract digest "${DIGEST_A}" does not match its identity digest "${ROOT_CONTRACT_SHA256}"`],
    ['a root contract whose objective moved after the digest was taken', emptyState, rootProposal({ contract: { ...ROOT_CONTRACT, objective: 'ship something else' } }), `task: proposal "${ROOT_PROPOSAL_ID}" contract digest "${contractDigest({ ...ROOT_CONTRACT, objective: 'ship something else' })}" does not match its identity digest "${ROOT_CONTRACT_SHA256}"`],
    ['a forged root proposal digest', emptyState, rootProposal({ proposalDigest: DIGEST_A }), `task: proposal "${ROOT_PROPOSAL_ID}" proposal digest "${DIGEST_A}" does not match its identity digest "${ROOT_PROPOSAL_DIGEST}"`],
    ['a root proposal submitted with a decision', emptyState, rootProposal({ decision: { outcome: 'approved', proposalDigest: ROOT_PROPOSAL_DIGEST, admissionContextDigest: ADMISSION_CONTEXT_SHA256, decidedBy: 'operator', decidedAt: NOW } }), `task: proposal "${ROOT_PROPOSAL_ID}" is submitted with a decision`],
    ['a duplicate root proposal id', readyRootState, rootProposal(), `task: proposal "${ROOT_PROPOSAL_ID}" already exists`],
    ['a second root proposal on one request key', readyRootState, rootProposal({ proposalId: 'p-other' }), `task: proposal request key "k-root-1" is already bound to proposal "${ROOT_PROPOSAL_ID}"`],
    ['a root contract for a store that already holds a root task', rootState, rootProposal(), `task: store "store" already holds root task "root"; proposal "${ROOT_PROPOSAL_ID}" is refused`],
  ]

  test.each(refused)('refuses %s and stores nothing', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => submitRoot(state, value)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  test('refuses a decomposition proposal that carries a root contract', () => {
    const state = emptyState()
    const before = state.snapshot()
    const value = proposal({ kind: 'decomposition', contract: ROOT_CONTRACT } as unknown as Partial<TaskProposalDecomposition>)
    expect(() => submitRoot(state, value)).toThrow(`task: proposal "${PROPOSAL_ID}" is a decomposition proposal and cannot carry a root contract`)
    expect(state.snapshot()).toEqual(before)
  })

  test('refuses a root contract event whose envelope names anything but the reserved marker', () => {
    const state = readyRootState()
    const before = state.snapshot()
    const second = rootProposal({ proposalId: 'p-second' }, rootIdentity({ requestKey: 'k-second' }))
    expect(() => state.apply(ev('TaskProposalSubmitted', { proposal: second }, { taskId: 't-real' })))
      .toThrow(`task: proposal "p-second" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "t-real"`)
    expect(state.snapshot()).toEqual(before)
  })

  test('refuses the reserved marker on a decomposition proposal event', () => {
    const state = rootState()
    const before = state.snapshot()
    expect(() => state.apply(ev('TaskProposalSubmitted', { proposal: proposal() }, { taskId: ROOT_PROPOSAL_TASK_ID })))
      .toThrow(`task: proposal "${PROPOSAL_ID}" belongs to task "root", not "${ROOT_PROPOSAL_TASK_ID}"`)
    expect(state.snapshot()).toEqual(before)
  })

  test('reads a proposal written before the kind field as a decomposition proposal, and one that states its kind the same', () => {
    const legacy = JSON.parse(JSON.stringify(proposal())) as TaskProposalDecomposition
    expect('kind' in legacy ? legacy.kind : undefined).toBeUndefined()
    const storedLegacy = submit(rootState(), legacy)
    expect(decompositionOf(storedLegacy.snapshot().proposals?.byId[PROPOSAL_ID])?.batch).toEqual(BATCH)
    expect(storedLegacy.snapshot().proposals?.byParentTask[PARENT]?.map(item => item.proposalId)).toEqual([PROPOSAL_ID])

    // An explicit `kind: 'decomposition'` is the same record: the identity, the
    // digest and the id are the ones they always were, so nothing in the
    // decomposition path moved when the field was added.
    const explicit = submit(rootState(), proposal({ kind: 'decomposition' }))
    const value = decompositionOf(explicit.snapshot().proposals?.byId[PROPOSAL_ID])
    expect(value?.kind).toBe('decomposition')
    expect(value?.proposalId).toBe(PROPOSAL_ID)
    expect(value?.proposalDigest).toBe(decompositionDigest(IDENTITY))
    expect(canonicalize(value?.identity)).toBe(IDENTITY_CANONICAL)
  })
})

describe('TaskState root contract decisions and phases', () => {
  test('records a root approval bound to the three digests', () => {
    const state = decideRoot(pendingRootState(), rootClaim())
    const value = rootStored(state)
    expect(value?.status).toBe('approved')
    expect(value?.updatedAt).toBe(NOW)
    expect(value?.decision).toEqual({
      outcome: 'approved',
      proposalDigest: ROOT_PROPOSAL_DIGEST,
      admissionContextDigest: ADMISSION_CONTEXT_SHA256,
      reviewContextDigest: REVIEW_CONTEXT_SHA256,
      decidedBy: 'operator',
      decidedAt: NOW,
    })
  })

  test('a root rejection, a tightening and a post-approval re-check follow the same tables', () => {
    expect(rootStored(decideRoot(pendingRootState(), rootClaim({ outcome: 'rejected', reason: 'not the goal the user asked for' })))?.status).toBe('rejected')
    expect(rootStored(changeRootPhase(readyRootState(), { proposalId: ROOT_PROPOSAL_ID, to: 'pending_review' }))?.policy).toBe('off')
    expect(rootStored(recheckedRootState())?.status).toBe('ready')
    expect(rootStored(changeRootPhase(recheckedRootState(), { proposalId: ROOT_PROPOSAL_ID, to: 'stale', reason: 'root contract moved' }))?.status).toBe('stale')
  })

  const refused: Array<[string, () => TaskState, TaskProposalDecisionClaim | TaskProposalPhaseChange, string]> = [
    ['a root decision digest that is not the stored one', pendingRootState, rootClaim({ proposalDigest: DIGEST_A }), `task: proposal "${ROOT_PROPOSAL_ID}" decision digest "${DIGEST_A}" does not match the stored proposal digest "${ROOT_PROPOSAL_DIGEST}"`],
    ['a root decision admission context that is not the stored one', pendingRootState, rootClaim({ admissionContextDigest: DIGEST_B }), `task: proposal "${ROOT_PROPOSAL_ID}" decision admission context digest "${DIGEST_B}" does not match the stored admission context digest "${ADMISSION_CONTEXT_SHA256}"`],
    ['a root approval without the review context it was decided against', pendingRootState, rootClaim({ reviewContextDigest: undefined }), `task: proposal "${ROOT_PROPOSAL_ID}" approval requires the review context digest it was decided against`],
    ['a root approval whose review context moved', pendingRootState, rootClaim({ reviewContextDigest: DIGEST_A }), `task: proposal "${ROOT_PROPOSAL_ID}" decision review context digest "${DIGEST_A}" does not match the stored review context digest "${REVIEW_CONTEXT_SHA256}"`],
    ['an approval of a policy-off root proposal', readyRootState, rootClaim(), `task: illegal proposal transition "ready" → "approved" for proposal "${ROOT_PROPOSAL_ID}"`],
    ['a root re-check pass without an approval', readyRootState, { proposalId: ROOT_PROPOSAL_ID, to: 'ready' }, `task: illegal proposal transition "ready" → "ready" for proposal "${ROOT_PROPOSAL_ID}"`],
    ['a root stale marking without a reason', readyRootState, { proposalId: ROOT_PROPOSAL_ID, to: 'stale' }, `task: proposal "${ROOT_PROPOSAL_ID}" is marked stale without a reason`],
  ]

  test.each(refused)('refuses %s and leaves the proposal as it was', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    const apply = 'outcome' in value ? decideRoot : changeRootPhase
    expect(() => apply(state, value as never)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  test('refuses a root decision whose envelope names a real task', () => {
    const state = pendingRootState()
    const before = state.snapshot()
    expect(() => state.apply(ev('TaskProposalDecided', rootClaim(), { taskId: ROOT_TASK_ID })))
      .toThrow(`task: proposal "${ROOT_PROPOSAL_ID}" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "${ROOT_TASK_ID}"`)
    expect(state.snapshot()).toEqual(before)
  })
})

describe('TaskState root contract consumption', () => {
  test('one consumption binds the proposal to the root task and run it was activated as', () => {
    const state = rootActivationState()
    state.apply(ev('TaskProposalAdmitted', rootConsumption(), { taskId: ROOT_PROPOSAL_TASK_ID }))
    const value = rootStored(state)
    expect(value?.status).toBe('admitted')
    expect(value?.consumption).toEqual(rootConsumption())
    expect(value?.updatedAt).toBe(NOW)
    expect(value?.consumption?.kind).toBe('root')
    const snapshot = state.snapshot()
    expect(snapshot.tasks.map(item => item.taskId)).toEqual([ROOT_TASK_ID])
    expect(snapshot.runs.map(item => item.runId)).toEqual([ROOT_RUN_ID])
  })

  const refused: Array<[string, () => TaskState, TaskProposalRootConsumption, string]> = [
    ['a consumption that does not declare its kind', recheckedRootState, rootConsumption({ kind: undefined as unknown as 'root' }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption must declare kind "root"`],
    ['a consumption carrying the batch vocabulary', rootActivationState, rootConsumption({ batchId: 'b-root' } as unknown as Partial<TaskProposalRootConsumption>), `task: proposal "${ROOT_PROPOSAL_ID}" consumption carries the batch field "batchId"; a root consumption names rootTaskId and rootRunId`],
    ['a consumption carrying the batch child list', rootActivationState, rootConsumption({ childTaskIds: [ROOT_TASK_ID] } as unknown as Partial<TaskProposalRootConsumption>), `task: proposal "${ROOT_PROPOSAL_ID}" consumption carries the batch field "childTaskIds"; a root consumption names rootTaskId and rootRunId`],
    ['a consumption without a root task id', rootActivationState, rootConsumption({ rootTaskId: '' }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption requires a root task id`],
    ['a consumption without a root run id', rootActivationState, rootConsumption({ rootRunId: '' }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption requires a root run id`],
    ['a consumption naming a root task the store does not hold', readyRootState, rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names unknown task "${ROOT_TASK_ID}"`],
    ['a consumption naming a task that is not a root task', rootWithChildState, rootConsumption({ rootTaskId: 'c1' }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names task "c1", which is not a root task`],
    ['a consumption naming a root task without the contract the proposal approved', () => rootActivationState(rootTask({ contract: undefined })), rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names root task "${ROOT_TASK_ID}" without the contract the proposal committed to`],
    ['a consumption naming a root task whose contract moved', () => rootActivationState(rootTask({ contract: { ...ROOT_CONTRACT, objective: 'another goal' }, objective: 'another goal' })), rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names root task "${ROOT_TASK_ID}" whose contract digest "${contractDigest({ ...ROOT_CONTRACT, objective: 'another goal' })}" is not the committed "${ROOT_CONTRACT_SHA256}"`],
    ['a consumption naming a root run the store does not hold', () => rootActivationState(rootTask(), null), rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names unknown run "${ROOT_RUN_ID}"`],
    ['a consumption naming a run that belongs to another task', rootWithChildState, rootConsumption({ rootRunId: 'r-c1' }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names run "r-c1", which belongs to task "c1"`],
    ['a consumption naming a run of another session', () => rootActivationState(rootTask(), rootRun({ sessionId: 's-other' })), rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names run "${ROOT_RUN_ID}" of session "s-other", not the root session "${ROOT_SESSION}"`],
    ['a consumption naming a run that is no longer active', () => {
      const state = rootActivationState(rootTask(), rootRun({ executionPhase: 'submitted', submission: { summary: 'no worker', evidenceRefs: [], origin: 'runtime', submittedAt: NOW } }))
      return state
    }, rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names run "${ROOT_RUN_ID}" with execution phase "submitted"; a root run is born active`],
    ['a consumption naming a run that already ended', () => {
      const state = rootActivationState()
      state.apply(ev('TaskFailed', { finishedAt: NOW, reason: 'the worker died' }, { taskId: ROOT_TASK_ID, runId: ROOT_RUN_ID }))
      return state
    }, rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" consumption names run "${ROOT_RUN_ID}" in status "failed"; a root run is consumed running`],
    ['a consumption of a root proposal still awaiting review', () => rootActivationStateFrom(pendingRootState()), rootConsumption(), `task: illegal proposal transition "pending_review" → "admitted" for proposal "${ROOT_PROPOSAL_ID}"`],
    ['a consumption of a root proposal that never passed its re-check', () => rootActivationStateFrom(approvedRootState()), rootConsumption(), `task: illegal proposal transition "approved" → "admitted" for proposal "${ROOT_PROPOSAL_ID}"`],
    ['a second consumption of one root proposal', () => {
      const state = rootActivationState()
      state.apply(ev('TaskProposalAdmitted', rootConsumption(), { taskId: ROOT_PROPOSAL_TASK_ID }))
      return state
    }, rootConsumption(), `task: illegal proposal transition "admitted" → "admitted" for proposal "${ROOT_PROPOSAL_ID}"`],
    ['a root consumption with a forged proposal digest', rootActivationState, rootConsumption({ proposalDigest: DIGEST_A }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption digest "${DIGEST_A}" does not match the stored proposal digest "${ROOT_PROPOSAL_DIGEST}"`],
    ['a root consumption whose review context moved', rootActivationState, rootConsumption({ reviewContextDigest: DIGEST_B }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption review context digest "${DIGEST_B}" does not match the stored review context digest "${REVIEW_CONTEXT_SHA256}"`],
    ['a root consumption without an admission time', rootActivationState, rootConsumption({ admittedAt: '' }), `task: proposal "${ROOT_PROPOSAL_ID}" consumption requires an admission time`],
    ['a root consumption whose envelope names a real task', rootActivationState, rootConsumption(), `task: proposal "${ROOT_PROPOSAL_ID}" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "${ROOT_TASK_ID}"`],
  ]

  test.each(refused)('refuses %s and stores no consumption', (_name, setup, value, message) => {
    const state = setup()
    const before = state.snapshot()
    // The last row is about the envelope, not the record: every other row has to
    // be refused by the consumption itself.
    const envelope = _name.includes('envelope') ? { taskId: ROOT_TASK_ID } : { taskId: ROOT_PROPOSAL_TASK_ID }
    expect(() => state.apply(ev('TaskProposalAdmitted', value, envelope))).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })

  test('a root consumption cannot name a root task the store already had', () => {
    // Two root contracts can both be submitted before either is activated —
    // nothing but a task closes intake — and the store then refuses the second
    // activation rather than letting one intake mint two roots.
    const second = rootProposal({}, ROOT_IDENTITY_ALT)
    const state = submitRoot(submitRoot(emptyState(), rootProposal()), second)
    state.apply(ev('TaskCreated', { task: rootTask() }, { taskId: ROOT_TASK_ID }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: ROOT_TASK_ID }))
    state.apply(ev('TaskStarted', { run: rootRun() }, { taskId: ROOT_TASK_ID, runId: ROOT_RUN_ID }))
    state.apply(ev('TaskProposalAdmitted', rootConsumption(), { taskId: ROOT_PROPOSAL_TASK_ID }))
    expect(rootStored(state)?.status).toBe('admitted')

    const rivalTask = rootTask({ taskId: 't-root-2' })
    const rivalRun = rootRun({ runId: 'r-root-2', taskId: 't-root-2' })
    state.apply(ev('TaskCreated', { task: rivalTask }, { taskId: rivalTask.taskId }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: rivalTask.taskId }))
    state.apply(ev('TaskStarted', { run: rivalRun }, { taskId: rivalTask.taskId, runId: rivalRun.runId }))
    expect(() => state.apply(ev(
      'TaskProposalAdmitted',
      rootConsumptionFor(second, { rootTaskId: rivalTask.taskId, rootRunId: rivalRun.runId }),
      { taskId: ROOT_PROPOSAL_TASK_ID },
    ))).toThrow(`task: proposal "${second.proposalId}" consumption names root task "t-root-2" but store "${STORE}" already holds root task "${ROOT_TASK_ID}"`)
    expect(rootOf(state.snapshot().proposals?.byId[second.proposalId])?.status).toBe('ready')
  })
})

/** A store with no task at all: what a root intake starts from. */
async function emptyService(): Promise<{ h: Harness; service: TaskService }> {
  const h = harness()
  const service = new TaskService(h.ctx as never)
  await service.createStore(STORE)
  return { h, service }
}

/** The persisted events as the reducer saw them. */
function storedTaskEvents(h: Harness): TaskEvent[] {
  return storedEvents(h).map(item => item.data as TaskEvent)
}

describe('TaskService root activation', () => {
  test('submitProposalIn addresses a root contract through the reserved marker', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal(), 'root-session')
    expect(persistedKinds(h)).toEqual(['TaskProposalSubmitted'])
    expect(storedTaskEvents(h).map(item => item.taskId)).toEqual([ROOT_PROPOSAL_TASK_ID])
    const snapshot = await service.snapshotIn(STORE)
    expect(snapshot.proposals?.byId[ROOT_PROPOSAL_ID]?.kind).toBe('root')
    expect(snapshot.proposals?.byRequestKey['k-root-1']?.proposalId).toBe(ROOT_PROPOSAL_ID)
    expect(snapshot.proposals?.byParentTask).toEqual({})
  })

  test('the decision and phase entries address a root contract through the same marker', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal({ status: 'pending_review', policy: 'all' }), 'root-session')
    await service.decideProposalIn(STORE, rootClaim(), 'operator')
    await service.changeProposalPhaseIn(STORE, { proposalId: ROOT_PROPOSAL_ID, to: 'ready' }, 'runtime')
    expect(persistedKinds(h).map(kind => kind)).toEqual(['TaskProposalSubmitted', 'TaskProposalDecided', 'TaskProposalPhaseChanged'])
    expect(storedTaskEvents(h).map(item => item.taskId)).toEqual([ROOT_PROPOSAL_TASK_ID, ROOT_PROPOSAL_TASK_ID, ROOT_PROPOSAL_TASK_ID])
    expect((await service.snapshotIn(STORE)).proposals?.byId[ROOT_PROPOSAL_ID]?.status).toBe('ready')
  })

  test('admitRootProposalIn lands the root task, its run and the consumption in one commit', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal(), 'root-session')
    const before = storedEvents(h).length
    await service.admitRootProposalIn(STORE, rootTask(), rootRun(), 'root-session', { consumption: rootConsumption() })
    expect(persistedKinds(h).slice(before)).toEqual(['TaskCreated', 'TaskAdmitted', 'TaskStarted', 'TaskProposalAdmitted'])
    expect(storedTaskEvents(h).filter(item => item.kind.startsWith('TaskProposal')).map(item => item.taskId))
      .toEqual([ROOT_PROPOSAL_TASK_ID, ROOT_PROPOSAL_TASK_ID])

    const snapshot = await service.snapshotIn(STORE)
    const root = snapshot.tasks[0]
    expect(snapshot.tasks).toHaveLength(1)
    expect(root?.taskId).toBe(ROOT_TASK_ID)
    expect(root?.parentTaskId).toBeUndefined()
    expect(root?.depth).toBe(0)
    expect(root?.objective).toBe(ROOT_CONTRACT.objective)
    expect(root?.contract).toEqual(ROOT_CONTRACT)
    expect(root?.status).toBe('running')
    expect(snapshot.runs.map(item => ({ runId: item.runId, sessionId: item.sessionId, phase: item.executionPhase, status: item.status })))
      .toEqual([{ runId: ROOT_RUN_ID, sessionId: ROOT_SESSION, phase: 'active', status: 'running' }])
    const value = snapshot.proposals?.byId[ROOT_PROPOSAL_ID]
    expect(value?.status).toBe('admitted')
    expect(value?.consumption).toEqual(rootConsumption())
  })

  test('a second root activation is refused and writes nothing', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal(), 'root-session')
    await service.admitRootProposalIn(STORE, rootTask(), rootRun(), 'root-session', { consumption: rootConsumption() })
    const before = persistedKinds(h)
    const second = rootTask({ taskId: 't-root-2' })
    await expect(service.admitRootProposalIn(
      STORE,
      second,
      rootRun({ runId: 'r-root-2', taskId: second.taskId }),
      'root-session',
      { consumption: rootConsumption({ rootTaskId: second.taskId, rootRunId: 'r-root-2' }) },
    )).rejects.toThrow(`task: store "${STORE}" already holds root task "${ROOT_TASK_ID}"; proposal "${ROOT_PROPOSAL_ID}" is refused`)
    expect(persistedKinds(h)).toEqual(before)
    const snapshot = await service.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
  })

  test('an activation whose consumption does not name the task and run it creates writes nothing', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal(), 'root-session')
    const before = persistedKinds(h)
    await expect(service.admitRootProposalIn(STORE, rootTask(), rootRun(), 'root-session', { consumption: rootConsumption({ rootRunId: 'r-other' }) }))
      .rejects.toThrow('task: admit root proposal requires the consumption to name the root task and run it creates')
    expect(persistedKinds(h)).toEqual(before)
    expect((await service.snapshotIn(STORE)).tasks).toEqual([])
  })

  test('a root activation that never got a root task on record cannot be consumed on its own', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal({ status: 'pending_review', policy: 'all' }), 'root-session')
    await service.decideProposalIn(STORE, rootClaim(), 'operator')
    await service.changeProposalPhaseIn(STORE, { proposalId: ROOT_PROPOSAL_ID, to: 'ready' }, 'runtime')
    const before = persistedKinds(h)
    await expect(service.consumeProposalIn(STORE, rootConsumption(), 'runtime'))
      .rejects.toThrow(`task: proposal "${ROOT_PROPOSAL_ID}" consumption names unknown task "${ROOT_TASK_ID}"`)
    expect(persistedKinds(h)).toEqual(before)
    expect((await service.snapshotIn(STORE)).proposals?.byId[ROOT_PROPOSAL_ID]?.status).toBe('ready')
  })

  test('a decomposition proposal cannot be activated as a root contract, and admitBatchIn cannot consume one', async () => {
    const { h, service } = await rootService()
    await service.submitProposalIn(STORE, proposal(), 'tester')
    await startParentRun(service)
    const before = persistedKinds(h)
    await expect(service.admitRootProposalIn(
      STORE,
      rootTask({ taskId: 't-root-2' }),
      rootRun({ runId: 'r-root-2', taskId: 't-root-2' }),
      'tester',
      { consumption: rootConsumption({ proposalId: PROPOSAL_ID, proposalDigest: decompositionDigest(IDENTITY) }) },
    )).rejects.toThrow(`task: proposal "${PROPOSAL_ID}" is a decomposition proposal; its children are admitted with admitBatchIn`)
    await expect(service.admitBatchIn(
      STORE,
      PARENT,
      'r-root',
      [task({ taskId: 'c1', parentTaskId: PARENT, depth: 1 })],
      'runtime',
      [],
      undefined,
      undefined,
      rootConsumption({ proposalId: PROPOSAL_ID, proposalDigest: decompositionDigest(IDENTITY) }),
    )).rejects.toThrow(`task: admit batch cannot record the root consumption of proposal "${PROPOSAL_ID}"`)
    expect(persistedKinds(h)).toEqual(before)
  })

  test('a store that already holds a root task refuses a root contract by name', async () => {
    const { h, service } = await rootService()
    const before = persistedKinds(h)
    await expect(service.submitProposalIn(STORE, rootProposal(), 'root-session'))
      .rejects.toThrow(`task: store "${STORE}" already holds root task "${PARENT}"; proposal "${ROOT_PROPOSAL_ID}" is refused`)
    expect(persistedKinds(h)).toEqual(before)
  })

  test('a root activation survives a restart with its contract, its task and its run', async () => {
    const { h, service } = await emptyService()
    await service.submitProposalIn(STORE, rootProposal(), 'root-session')
    await service.admitRootProposalIn(STORE, rootTask(), rootRun(), 'root-session', { consumption: rootConsumption() })
    for (const item of storedEvents(h)) {
      expect(JSON.parse(JSON.stringify(item))).toStrictEqual(item)
    }
    const reopened = new TaskService(harness(h.sessions).ctx as never)
    const snapshot = await reopened.openStore(STORE)
    const value = rootOf(snapshot.proposals?.byId[ROOT_PROPOSAL_ID])
    expect(value?.kind).toBe('root')
    expect(value?.contract).toEqual(ROOT_CONTRACT)
    expect(value?.identity.rootSessionId).toBe(ROOT_SESSION)
    expect(value?.status).toBe('admitted')
    expect(value?.consumption).toEqual(rootConsumption())
    expect(snapshot.proposals?.byParentTask).toEqual({})
    expect(snapshot.tasks[0]?.parentTaskId).toBeUndefined()
    expect(snapshot.runs[0]?.sessionId).toBe(ROOT_SESSION)
  })

  test('a store whose proposal events predate the kind field still opens and indexes them by parent task', async () => {
    const sessions = new Map<string, StoredSession>()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: makeSessionId(STORE), createdAt: 0, isSeeded: false }
    const legacy = JSON.parse(JSON.stringify(proposal())) as TaskProposal
    sessions.set(STORE, {
      header,
      events: [
        { type: 'task/event', seq: SessionSeq(0), time: 0, ignorable: true, data: ev('TaskCreated', { task: task({ taskId: PARENT, decompositionStatus: 'decomposable' }) }, { taskId: PARENT }) },
        { type: 'task/event', seq: SessionSeq(1), time: 0, ignorable: true, data: ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: PARENT }) },
        { type: 'task/event', seq: SessionSeq(2), time: 0, ignorable: true, data: ev('TaskProposalSubmitted', { proposal: legacy }, { taskId: PARENT }) },
      ] as SessionEvent[],
    })
    const h = harness(sessions)
    const service = new TaskService(h.ctx as never)
    const snapshot = await service.openStore(STORE)
    expect(snapshot.proposals?.byId[PROPOSAL_ID]?.kind).toBeUndefined()
    expect(decompositionOf(snapshot.proposals?.byId[PROPOSAL_ID])?.batch).toEqual(BATCH)
    expect(snapshot.proposals?.byParentTask[PARENT]?.map(item => item.proposalId)).toEqual([PROPOSAL_ID])
  })
})

import { describe, expect, test, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AdmissionContext, DecompositionIdentity, TaskContract } from '../../src/contract.ts'
import { TASK_CONTRACT_VERSION, canonicalize, contractDigest, decompositionDigest } from '../../src/contract.ts'
import {
  admissionContextDigest,
  capabilityManifestDigest,
  reviewContextDigest,
  taskProposalId,
} from '../../src/proposal.ts'
import type {
  TaskProposal,
  TaskProposalChild,
  TaskProposalConsumption,
  TaskProposalDecisionClaim,
  TaskProposalPhaseChange,
  TaskProposalReviewContext,
} from '../../src/proposal.ts'
import type {
  CapabilityManifest,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
} from '../../src/types.ts'
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
  wallTimeMs: 120_000,
  auditOnly: { maxToolCalls: 150, attempts: 1 },
}
const ADMISSION_CONTEXT_CANONICAL =
  '{"auditOnly":{"attempts":1,"maxToolCalls":150},"maxChildren":8,"maxDepth":4,"wallTimeMs":120000}'
const ADMISSION_CONTEXT_SHA256 = '6470da4b48e3967df7d37c79aeee1a4f1b830d5441c4bb518de4f36fea11ac5d'

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

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
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
function pendingProposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
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

function consumption(overrides: Partial<TaskProposalConsumption> = {}): TaskProposalConsumption {
  const value = proposal()
  return {
    proposalId: value.proposalId,
    proposalDigest: value.proposalDigest,
    reviewContextDigest: value.reviewContextDigest,
    batchId: `b-${PARENT}`,
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
      wallTimeMs: 120_000,
      maxChildren: 8,
      maxDepth: 4,
    }
    expect(admissionContextDigest(reordered)).toBe(ADMISSION_CONTEXT_SHA256)
    // `wallTimeMs: undefined` and an absent `wallTimeMs` mean one thing, so they are one identity.
    expect(admissionContextDigest({ ...ADMISSION_CONTEXT, wallTimeMs: undefined }))
      .toBe(admissionContextDigest({ maxDepth: 4, maxChildren: 8, auditOnly: { maxToolCalls: 150, attempts: 1 } }))
  })

  test('moves when an enforced or an audited limit moves', () => {
    const base = admissionContextDigest(ADMISSION_CONTEXT)
    const moves = [
      admissionContextDigest({ ...ADMISSION_CONTEXT, maxDepth: 5 }),
      admissionContextDigest({ ...ADMISSION_CONTEXT, maxChildren: 9 }),
      admissionContextDigest({ ...ADMISSION_CONTEXT, wallTimeMs: 60_000 }),
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
})

function ev<K extends TaskEventKind>(
  kind: K,
  payload: TaskEventPayloads[K],
  init: { taskId?: TaskId; parentTaskId?: TaskId } = {},
): TaskEvent {
  return {
    kind,
    taskId: init.taskId ?? 't1',
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

function stored(state: TaskState): TaskProposal | undefined {
  return state.snapshot().proposals?.byId[PROPOSAL_ID]
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
    expect(state.snapshot().proposals?.byId['p-copy']?.batch[0]?.contract.objective).toBe('collect the input')
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
    expect(consumed?.byRequestKey['k-1']?.consumption?.childTaskIds).toEqual(['c1', 'c2'])
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
      batchId: 'b-root',
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
    ['a consumption naming a foreign batch', () => withChildren(readyState(), ['c1', 'c2']), consumption({ batchId: 'b-other' }), `task: proposal "${PROPOSAL_ID}" consumption batch "b-other" is not the batch of task "root"`],
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
    expect(snapshot.proposals?.byId[PROPOSAL_ID]?.batch).toEqual(BATCH)

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
    expect(value?.consumption?.childTaskIds).toEqual(['c1', 'c2'])
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
    expect(snapshot.proposals?.byId[PROPOSAL_ID]?.consumption?.batchId).toBe(`b-${PARENT}`)
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
    expect(value?.consumption?.childTaskIds).toEqual(['c1', 'c2'])
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
})

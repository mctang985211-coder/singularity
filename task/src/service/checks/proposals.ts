/** Proposal shape, identity, transition, decision and consumption checks. @module @dangosys/dsh-singularity-task/service/checks/proposals */

import {
  TASK_CONTRACT_VERSION,
  contractDigest,
  decompositionDigest,
  type DecompositionIdentity,
  type TaskContract,
} from '../../contract.ts'
import { assertAdmissionLimits, assertContractFields } from './contract.ts'
import {
  ROOT_PROPOSAL_TASK_ID,
  TASK_PROPOSAL_KINDS,
  admissionContextDigest,
  batchIdFor,
  reviewContextDigest,
  rootProposalDigest,
  type RootProposalIdentity,
  type TaskProposal,
  type TaskProposalBase,
  type TaskProposalBatchConsumption,
  type TaskProposalChild,
  type TaskProposalConsumption,
  type TaskProposalDecisionClaim,
  type TaskProposalDecomposition,
  type TaskProposalIndex,
  type TaskProposalReviewContext,
  type TaskProposalRoot,
  type TaskProposalRootConsumption,
  type TaskProposalStatus,
} from '../../proposal.ts'
import type { TaskId, TaskInstance, TaskSnapshot } from '../../types.ts'
import { isDigest, isRecord, nonEmpty, requireIndex } from './primitives.ts'

/** The closed field set of a review context ({@link TaskProposalReviewContext}); an unread field must not move an identity. */
const REVIEW_CONTEXT_FIELDS: readonly string[] = ['capabilityManifestDigest', 'verifiers']

/** The closed field set of one batch child ({@link TaskProposalChild}); an unread field must not enter an identity. */
const PROPOSAL_CHILD_FIELDS: readonly string[] = [
  'contract',
  'dependsOn',
  'decomposable',
  'requiresIndependentAcceptance',
]

/** The closed field set of one verifier identity ({@link TaskProposalVerifierIdentity}). */
const VERIFIER_IDENTITY_FIELDS: readonly string[] = ['verifierId', 'version', 'configurationDigest']

/** The closed field set of a decomposition identity ({@link DecompositionIdentity}): what its digest covers, and nothing else. */
const DECOMPOSITION_IDENTITY_FIELDS: readonly string[] = [
  'contractVersion',
  'storeId',
  'parentTaskId',
  'parentRunId',
  'callerSessionId',
  'reason',
  'children',
]

/** The closed field set of a root contract identity ({@link RootProposalIdentity}). */
const ROOT_IDENTITY_FIELDS: readonly string[] = [
  'contractVersion',
  'storeId',
  'rootSessionId',
  'requestKey',
  'contractDigest',
]

/** The batch vocabulary a root consumption must not carry: the ids it names are a task id and a run id, not a batch. */
const BATCH_CONSUMPTION_FIELDS: readonly string[] = ['batchId', 'parentRunId', 'childTaskIds']

/** The root vocabulary a batch consumption must not carry. */
const ROOT_CONSUMPTION_FIELDS: readonly string[] = ['rootTaskId', 'rootRunId']

/** The stored proposal one event names, or a refusal naming the id. */
export function proposalIn(snapshot: TaskSnapshot, proposalId: string): TaskProposal {
  const proposal = proposalIndex(snapshot).byId[proposalId]
  if (proposal === undefined) throw new Error(`task: unknown proposal "${String(proposalId)}"`)
  return proposal
}

/** The proposal index of the snapshot this state replays on. It is absent only when a foreign snapshot (a hand-built one from a reader that predates proposals) was replayed onto — never on this build's own value — and that is a refusal rather … */
export function proposalIndex(snapshot: TaskSnapshot): TaskProposalIndex {
  return requireIndex(snapshot.proposals, 'task: snapshot carries no proposal index')
}

/** The store's root task, if it has one: the task a root intake may not sit beside or activate a second time. */
export function rootTaskIn(snapshot: TaskSnapshot): TaskInstance | undefined {
  return snapshot.tasks.find(item => item.parentTaskId === undefined)
}

/** A store with a root task refuses root intake by name (A0 §1.6): the root it holds is somebody's goal, and a second intake would make "the store's root" answer differently at two reads. A goal change is a new graph, never a second root here. */
export function assertRootIntakeOpen(snapshot: TaskSnapshot, proposalId: string): void {
  const root = rootTaskIn(snapshot)
  if (root !== undefined) {
    throw new Error(
      `task: store "${snapshot.id}" already holds root task "${root.taskId}"; proposal "${proposalId}" is refused`,
    )
  }
}

/** Every proposal event is about one subject, and the envelope has to name it: a decomposition proposal's events name the parent task whose batch it is; a root contract's events name the reserved {@link ROOT_PROPOSAL_TASK_ID} marker, because … */
export function assertProposalTask(proposal: TaskProposal, taskId: TaskId): void {
  if (proposal.kind === 'root') {
    if (taskId !== ROOT_PROPOSAL_TASK_ID) {
      throw new Error(
        `task: proposal "${proposal.proposalId}" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "${taskId}"`,
      )
    }
    return
  }
  if (taskId !== proposal.identity.parentTaskId) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" belongs to task "${proposal.identity.parentTaskId}", not "${taskId}"`,
    )
  }
}

/** One proposal's status either admits this outcome or the event is a late or out-of-order write. */
export function assertProposalTransition(
  proposal: TaskProposal,
  to: TaskProposalStatus,
  from: readonly TaskProposalStatus[],
): void {
  if (!from.includes(proposal.status)) {
    throw new Error(
      `task: illegal proposal transition "${proposal.status}" → "${to}" for proposal "${proposal.proposalId}"`,
    )
  }
}

/** Replaces one proposal in place; the index's other views keep pointing at the same record. */
export function setProposal(
  snapshot: TaskSnapshot,
  proposalId: string,
  patch: Partial<TaskProposalBase>,
): TaskSnapshot {
  const index = proposalIndex(snapshot)
  const current = index.byId[proposalId]
  if (current === undefined) throw new Error(`task: unknown proposal "${proposalId}"`)
  const next: TaskProposal = { ...current, ...patch }
  const replace = (proposals: readonly TaskProposal[]): TaskProposal[] =>
    proposals.map(item => (item.proposalId === proposalId ? next : item))
  snapshot = {
    ...snapshot,
    proposals: {
      all: replace(index.all),
      byId: { ...index.byId, [proposalId]: next },
      byRequestKey: { ...index.byRequestKey, [next.requestKey]: next },
      byParentTask: Object.fromEntries(
        Object.entries(index.byParentTask).map(([parentTaskId, proposals]) => [parentTaskId, replace(proposals)]),
      ),
    },
  }
  return snapshot
}

/** A submitted proposal has to be complete and internally consistent, because everything an approval binds is taken from it: the review context is a closed record (an unread field would silently become part of an identity), the birth status … */
export function assertProposal(snapshot: TaskSnapshot, proposal: TaskProposal): void {
  if (!isRecord(proposal)) throw new Error('task: proposal must be an object')
  if (!nonEmpty(proposal.proposalId)) throw new Error('task: proposal id must be a non-empty string')
  const id = proposal.proposalId
  if (!nonEmpty(proposal.requestKey)) throw new Error(`task: proposal "${id}" request key must be a non-empty string`)
  const kind: unknown = (proposal as { kind?: unknown }).kind
  if (kind !== undefined && kind !== 'decomposition' && kind !== 'root') {
    throw new Error(`task: proposal "${id}" kind must be one of ${TASK_PROPOSAL_KINDS.join(', ')}`)
  }
  if (kind === undefined && carriesRootContract(proposal)) {
    throw new Error(`task: proposal "${id}" carries root contract fields without kind "root"`)
  }
  if (proposal.status !== 'ready' && proposal.status !== 'pending_review') {
    throw new Error(`task: proposal "${id}" status "${String(proposal.status)}" is not a birth status`)
  }
  if (proposal.policy !== 'off' && proposal.policy !== 'all') {
    throw new Error(`task: proposal "${id}" policy must be "off" or "all"`)
  }
  if (proposal.status === 'ready' && proposal.policy === 'all') {
    throw new Error(`task: proposal "${id}" is submitted ready with policy "all"`)
  }
  if (proposal.status === 'pending_review' && proposal.policy === 'off') {
    throw new Error(`task: proposal "${id}" is submitted pending_review with policy "off"`)
  }
  if (proposal.supersedes !== undefined) {
    if (!nonEmpty(proposal.supersedes))
      throw new Error(`task: proposal "${id}" supersedes must be a non-empty proposal id`)
    if (proposal.supersedes === id) throw new Error(`task: proposal "${id}" cannot supersede itself`)
    if (proposalIndex(snapshot).byId[proposal.supersedes] === undefined) {
      throw new Error(`task: proposal "${id}" supersedes unknown proposal "${proposal.supersedes}"`)
    }
  }
  if (proposal.kind === 'root') {
    assertRootProposal(id, proposal)
  } else {
    assertDecompositionProposal(snapshot, id, proposal)
  }
  const context = proposal.admissionContext
  if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires an admission context`)
  assertAdmissionLimits(`proposal "${id}" admission context`, context)
  const contextDigest = admissionContextDigest(proposal.admissionContext)
  if (proposal.admissionContextDigest !== contextDigest) {
    throw new Error(
      `task: proposal "${id}" admission context digest "${String(proposal.admissionContextDigest)}" does not match its context digest "${contextDigest}"`,
    )
  }
  assertReviewContext(id, proposal.reviewContext)
  const reviewDigest = reviewContextDigest(proposal.reviewContext)
  if (proposal.reviewContextDigest !== reviewDigest) {
    throw new Error(
      `task: proposal "${id}" review context digest "${String(proposal.reviewContextDigest)}" does not match its context digest "${reviewDigest}"`,
    )
  }
  if (!nonEmpty(proposal.createdAt)) throw new Error(`task: proposal "${id}" requires a creation time`)
  if (proposal.decision !== undefined) throw new Error(`task: proposal "${id}" is submitted with a decision`)
  if (proposal.consumption !== undefined) throw new Error(`task: proposal "${id}" is submitted with a consumption`)
}

/** A decomposition proposal's half of the record: the batch identity and the batch content that must be the content of that identity. */
export function assertDecompositionProposal(
  snapshot: TaskSnapshot,
  id: string,
  proposal: TaskProposalDecomposition,
): void {
  if ((proposal as { contract?: unknown }).contract !== undefined) {
    throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot carry a root contract`)
  }
  assertProposalIdentity(snapshot, id, proposal.identity)
  assertProposalBatch(id, proposal.batch, proposal.identity)
  const expected = decompositionDigest(proposal.identity)
  if (proposal.proposalDigest !== expected) {
    throw new Error(
      `task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`,
    )
  }
}

/** A root contract proposal's half of the record: the root identity (store, root session, request key, contract digest — and no parent task) and the one normalized contract it must be the digest of. */
export function assertRootProposal(id: string, proposal: TaskProposalRoot): void {
  if ((proposal as { batch?: unknown }).batch !== undefined) {
    throw new Error(`task: proposal "${id}" is a root contract and cannot carry a batch`)
  }
  assertRootIdentity(id, proposal.identity)
  if (proposal.identity.requestKey !== proposal.requestKey) {
    throw new Error(
      `task: proposal "${id}" identity request key "${proposal.identity.requestKey}" disagrees with its request key "${proposal.requestKey}"`,
    )
  }
  const contract: unknown = proposal.contract
  if (!isRecord(contract)) throw new Error(`task: proposal "${id}" requires a root contract`)
  assertContractFields(`proposal "${id}" root`, contract as unknown as TaskContract)
  if (!Array.isArray((contract as unknown as TaskContract).acceptanceCriteria)) {
    throw new Error(`task: proposal "${id}" root contract acceptance criteria must be an array`)
  }
  const digest = contractDigest(contract as unknown as TaskContract)
  if (digest !== proposal.identity.contractDigest) {
    throw new Error(
      `task: proposal "${id}" contract digest "${digest}" does not match its identity digest "${proposal.identity.contractDigest}"`,
    )
  }
  const expected = rootProposalDigest(proposal.identity)
  if (proposal.proposalDigest !== expected) {
    throw new Error(
      `task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`,
    )
  }
}

/** Whether a record that does not claim `kind: 'root'` still carries a root contract's fields. */
export function carriesRootContract(proposal: TaskProposal): boolean {
  const raw = proposal as unknown as { contract?: unknown; identity?: unknown }
  if (raw.contract !== undefined) return true
  const identity: unknown = raw.identity
  return isRecord(identity) && identity.rootSessionId !== undefined
}

/** The batch identity a proposal carries, judged for shape only: the field semantics (a version this build knows, non-empty origins, one dependency index per child) are what a reader needs to interpret it, while the *rules* about a batch — … */
export function assertProposalIdentity(snapshot: TaskSnapshot, id: string, identity: DecompositionIdentity): void {
  if (!isRecord(identity)) throw new Error(`task: proposal "${id}" identity must be an object`)
  for (const key of Object.keys(identity)) {
    if (!DECOMPOSITION_IDENTITY_FIELDS.includes(key)) {
      throw new Error(`task: proposal "${id}" identity has an unsupported field "${key}"`)
    }
  }
  if (identity.contractVersion !== TASK_CONTRACT_VERSION) {
    throw new Error(
      `task: proposal "${id}" declares contract version ${String(identity.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`,
    )
  }
  const names: ReadonlyArray<readonly [string, unknown]> = [
    ['store id', identity.storeId],
    ['parent run id', identity.parentRunId],
    ['caller session id', identity.callerSessionId],
  ]
  for (const [name, value] of names) {
    if (!nonEmpty(value)) throw new Error(`task: proposal "${id}" identity ${name} must be a non-empty string`)
  }
  if (!nonEmpty(identity.parentTaskId)) {
    throw new Error(`task: proposal "${id}" identity parent task id must be a non-empty string`)
  }
  if (typeof identity.reason !== 'string') throw new Error(`task: proposal "${id}" identity reason must be a string`)
  if (!Array.isArray(identity.children) || identity.children.length === 0) {
    throw new Error(`task: proposal "${id}" identity requires at least one child`)
  }
  identity.children.forEach((child, index) => {
    if (!isRecord(child)) throw new Error(`task: proposal "${id}" child ${index} must be an object`)
    if (!isDigest(child.contractDigest)) {
      throw new Error(`task: proposal "${id}" child ${index} contract digest must be a lowercase SHA-256 hex digest`)
    }
    if (!Array.isArray(child.dependsOn) || child.dependsOn.some(item => !Number.isInteger(item) || item < 0)) {
      throw new Error(`task: proposal "${id}" child ${index} dependsOn must be an array of non-negative integers`)
    }
    if (typeof child.decomposable !== 'boolean') {
      throw new Error(`task: proposal "${id}" child ${index} decomposable must be a boolean`)
    }
    if (typeof child.requiresIndependentAcceptance !== 'boolean') {
      throw new Error(`task: proposal "${id}" child ${index} requiresIndependentAcceptance must be a boolean`)
    }
  })
  if (!snapshot.tasks.some(item => item.taskId === identity.parentTaskId)) {
    throw new Error(`task: proposal "${id}" names unknown parent task "${identity.parentTaskId}"`)
  }
}

/** The root identity a root contract carries, judged for shape only: the version of the contract language, the store and root session it is for, its request key and the digest of the contract beside it. */
export function assertRootIdentity(id: string, identity: RootProposalIdentity): void {
  if (!isRecord(identity)) throw new Error(`task: proposal "${id}" identity must be an object`)
  for (const key of Object.keys(identity)) {
    if (!ROOT_IDENTITY_FIELDS.includes(key)) {
      throw new Error(`task: proposal "${id}" identity has an unsupported field "${key}"`)
    }
  }
  if (identity.contractVersion !== TASK_CONTRACT_VERSION) {
    throw new Error(
      `task: proposal "${id}" declares contract version ${String(identity.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`,
    )
  }
  const names: ReadonlyArray<readonly [string, unknown]> = [
    ['store id', identity.storeId],
    ['root session id', identity.rootSessionId],
    ['request key', identity.requestKey],
  ]
  for (const [name, value] of names) {
    if (!nonEmpty(value)) throw new Error(`task: proposal "${id}" identity ${name} must be a non-empty string`)
  }
  if (!isDigest(identity.contractDigest)) {
    throw new Error(`task: proposal "${id}" identity contract digest must be a lowercase SHA-256 hex digest`)
  }
}

/** The batch content a submission carries, bound to the identity it claims to be: one child per identity child, in the same order, each carrying the contract whose {@link contractDigest} is the identity's child digest and the three … */
export function assertProposalBatch(
  id: string,
  batch: readonly TaskProposalChild[],
  identity: DecompositionIdentity,
): void {
  if (!Array.isArray(batch)) throw new Error(`task: proposal "${id}" batch must be an array`)
  if (batch.length !== identity.children.length) {
    throw new Error(
      `task: proposal "${id}" batch requires one child per identity child (identity children: ${identity.children.length}, batch children: ${batch.length})`,
    )
  }
  batch.forEach((child, index) => {
    const where = `proposal "${id}" child ${index}`
    const identityChild = identity.children[index]!
    if (!isRecord(child)) throw new Error(`task: ${where} must be an object`)
    for (const key of Object.keys(child)) {
      if (!PROPOSAL_CHILD_FIELDS.includes(key)) throw new Error(`task: ${where} has an unsupported field "${key}"`)
    }
    const contract: unknown = child.contract
    if (!isRecord(contract)) throw new Error(`task: ${where} requires a contract`)
    assertContractFields(where, contract as unknown as TaskContract)
    if (!Array.isArray(child.dependsOn) || child.dependsOn.some(item => !Number.isInteger(item) || item < 0)) {
      throw new Error(`task: ${where} dependsOn must be an array of non-negative integers`)
    }
    if (typeof child.decomposable !== 'boolean') throw new Error(`task: ${where} decomposable must be a boolean`)
    if (typeof child.requiresIndependentAcceptance !== 'boolean') {
      throw new Error(`task: ${where} requiresIndependentAcceptance must be a boolean`)
    }
    const digest = contractDigest(contract as unknown as TaskContract)
    if (digest !== identityChild.contractDigest) {
      throw new Error(
        `task: ${where} contract digest "${digest}" does not match its identity digest "${identityChild.contractDigest}"`,
      )
    }
    const sameDepends =
      child.dependsOn.length === identityChild.dependsOn.length &&
      child.dependsOn.every((value, position) => value === identityChild.dependsOn[position])
    if (!sameDepends) throw new Error(`task: ${where} dependsOn does not match its identity`)
    if (child.decomposable !== identityChild.decomposable) {
      throw new Error(`task: ${where} decomposable does not match its identity`)
    }
    if (child.requiresIndependentAcceptance !== identityChild.requiresIndependentAcceptance) {
      throw new Error(`task: ${where} requiresIndependentAcceptance does not match its identity`)
    }
  })
}

/** A decision binds the proposal it was made against, so every identity it carries is compared with the stored record: the dossier digest, the admission context, and — for an approval, always — the review context the batch resolved against … */
export function assertDecisionBinding(proposal: TaskProposal, claim: TaskProposalDecisionClaim): void {
  if (claim.proposalDigest !== proposal.proposalDigest) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" decision digest "${String(claim.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`,
    )
  }
  if (claim.admissionContextDigest !== proposal.admissionContextDigest) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" decision admission context digest "${String(claim.admissionContextDigest)}" does not match the stored admission context digest "${proposal.admissionContextDigest}"`,
    )
  }
  if (claim.outcome === 'approved' && claim.reviewContextDigest === undefined) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" approval requires the review context digest it was decided against`,
    )
  }
  if (claim.reviewContextDigest !== undefined && claim.reviewContextDigest !== proposal.reviewContextDigest) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" decision review context digest "${claim.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`,
    )
  }
}

/** A consumption binds a proposal to what it became, so it has to name the same dossier and the resolution the admission re-check confirmed — for both kinds — and then the kind's own shape: a batch names the parent run of its identity, the … */
export function assertConsumptionBinding(
  snapshot: TaskSnapshot,
  proposal: TaskProposal,
  consumption: TaskProposalConsumption,
): void {
  const id = proposal.proposalId
  if (consumption.proposalDigest !== proposal.proposalDigest) {
    throw new Error(
      `task: proposal "${id}" consumption digest "${String(consumption.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`,
    )
  }
  if (!nonEmpty(consumption.reviewContextDigest)) {
    throw new Error(`task: proposal "${id}" consumption requires a review context digest`)
  }
  if (consumption.reviewContextDigest !== proposal.reviewContextDigest) {
    throw new Error(
      `task: proposal "${id}" consumption review context digest "${consumption.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`,
    )
  }
  if (proposal.kind === 'root') {
    assertRootConsumptionShape(snapshot, proposal, consumption)
  } else {
    assertBatchConsumptionShape(snapshot, proposal, consumption)
  }
  if (!nonEmpty(consumption.admittedAt))
    throw new Error(`task: proposal "${id}" consumption requires an admission time`)
  if (consumption.reason !== undefined && !nonEmpty(consumption.reason)) {
    throw new Error(`task: proposal "${id}" consumption reason must be a non-empty string when present`)
  }
}

/** The batch half of a consumption: the batch this run admitted, and children the store really holds under the proposal's parent — the record a crash recovery reads to find the batch it already admitted instead of admitting a second one. */
export function assertBatchConsumptionShape(
  snapshot: TaskSnapshot,
  proposal: TaskProposalDecomposition,
  consumption: TaskProposalConsumption,
): void {
  const id = proposal.proposalId
  if (consumption.kind === 'root') {
    throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot be consumed as a root contract`)
  }
  if (consumption.kind !== undefined && consumption.kind !== 'batch') {
    throw new Error(`task: proposal "${id}" consumption kind must be "batch"`)
  }
  const raw = consumption as unknown as Record<string, unknown>
  for (const field of ROOT_CONSUMPTION_FIELDS) {
    if (raw[field] !== undefined) {
      throw new Error(
        `task: proposal "${id}" consumption carries the root field "${field}"; a batch consumption names batchId and childTaskIds`,
      )
    }
  }
  const batch = consumption as TaskProposalBatchConsumption
  if (!nonEmpty(batch.parentRunId)) {
    throw new Error(
      `task: proposal "${id}" consumption requires the parent run its batch belongs to; a consumption from before batches were identified by run and proposal is refused, not guessed at`,
    )
  }
  if (batch.parentRunId !== proposal.identity.parentRunId) {
    throw new Error(
      `task: proposal "${id}" consumption names parent run "${batch.parentRunId}", not the run "${proposal.identity.parentRunId}" its identity names`,
    )
  }
  if (!nonEmpty(batch.batchId)) throw new Error(`task: proposal "${id}" consumption requires a batch id`)
  const batchId = batchIdFor(proposal.identity.parentRunId, id)
  if (batch.batchId !== batchId) {
    throw new Error(
      `task: proposal "${id}" consumption batch "${batch.batchId}" is not the batch of run "${proposal.identity.parentRunId}" and proposal "${id}" ("${batchId}")`,
    )
  }
  if (!Array.isArray(batch.childTaskIds) || batch.childTaskIds.length === 0) {
    throw new Error(`task: proposal "${id}" consumption requires at least one child task id`)
  }
  for (const childTaskId of batch.childTaskIds) {
    if (!nonEmpty(childTaskId))
      throw new Error(`task: proposal "${id}" consumption child task ids must be non-empty strings`)
  }
  const seen = new Set<TaskId>()
  for (const childTaskId of batch.childTaskIds) {
    if (seen.has(childTaskId)) throw new Error(`task: proposal "${id}" consumption names task "${childTaskId}" twice`)
    seen.add(childTaskId)
  }
  for (const childTaskId of batch.childTaskIds) {
    const child = snapshot.tasks.find(item => item.taskId === childTaskId)
    if (child === undefined) throw new Error(`task: proposal "${id}" consumption names unknown task "${childTaskId}"`)
    if (child.parentTaskId !== proposal.identity.parentTaskId) {
      throw new Error(
        `task: proposal "${id}" consumption names task "${childTaskId}", which is not a child of "${proposal.identity.parentTaskId}"`,
      )
    }
  }
}

/** The root half of a consumption: the root task and the root run the activation minted, and the store's one-root rule. */
export function assertRootConsumptionShape(
  snapshot: TaskSnapshot,
  proposal: TaskProposalRoot,
  consumption: TaskProposalConsumption,
): void {
  const id = proposal.proposalId
  if (consumption.kind !== 'root') {
    throw new Error(`task: proposal "${id}" consumption must declare kind "root"`)
  }
  const raw = consumption as unknown as Record<string, unknown>
  for (const field of BATCH_CONSUMPTION_FIELDS) {
    if (raw[field] !== undefined) {
      throw new Error(
        `task: proposal "${id}" consumption carries the batch field "${field}"; a root consumption names rootTaskId and rootRunId`,
      )
    }
  }
  const root = consumption as TaskProposalRootConsumption
  if (!nonEmpty(root.rootTaskId)) throw new Error(`task: proposal "${id}" consumption requires a root task id`)
  if (!nonEmpty(root.rootRunId)) throw new Error(`task: proposal "${id}" consumption requires a root run id`)
  const task = snapshot.tasks.find(item => item.taskId === root.rootTaskId)
  if (task === undefined) throw new Error(`task: proposal "${id}" consumption names unknown task "${root.rootTaskId}"`)
  if (task.parentTaskId !== undefined) {
    throw new Error(`task: proposal "${id}" consumption names task "${root.rootTaskId}", which is not a root task`)
  }
  const rival = snapshot.tasks.find(item => item.parentTaskId === undefined && item.taskId !== root.rootTaskId)
  if (rival !== undefined) {
    throw new Error(
      `task: proposal "${id}" consumption names root task "${root.rootTaskId}" but store "${snapshot.id}" already holds root task "${rival.taskId}"`,
    )
  }
  const contract: TaskContract | undefined = task.contract
  if (contract === undefined) {
    throw new Error(
      `task: proposal "${id}" consumption names root task "${root.rootTaskId}" without the contract the proposal committed to`,
    )
  }
  const digest = contractDigest(contract)
  if (digest !== proposal.identity.contractDigest) {
    throw new Error(
      `task: proposal "${id}" consumption names root task "${root.rootTaskId}" whose contract digest "${digest}" is not the committed "${proposal.identity.contractDigest}"`,
    )
  }
  const run = snapshot.runs.find(item => item.runId === root.rootRunId)
  if (run === undefined) throw new Error(`task: proposal "${id}" consumption names unknown run "${root.rootRunId}"`)
  if (run.taskId !== root.rootTaskId) {
    throw new Error(
      `task: proposal "${id}" consumption names run "${root.rootRunId}", which belongs to task "${run.taskId}"`,
    )
  }
  if (run.sessionId !== proposal.identity.rootSessionId) {
    throw new Error(
      `task: proposal "${id}" consumption names run "${root.rootRunId}" of session "${run.sessionId}", not the root session "${proposal.identity.rootSessionId}"`,
    )
  }
  if (run.status !== 'running') {
    throw new Error(
      `task: proposal "${id}" consumption names run "${root.rootRunId}" in status "${run.status}"; a root run is consumed running`,
    )
  }
  if (run.executionPhase !== 'active') {
    throw new Error(
      `task: proposal "${id}" consumption names run "${root.rootRunId}" with execution phase "${String(run.executionPhase)}"; a root run is born active`,
    )
  }
}

/** The review context's closed shape. Its manifest fingerprint and every verifier id/version/configuration are checked for the shapes that make them comparable — a digest that is not a digest, or a verifier without an id, would leave … */
export function assertReviewContext(id: string, context: TaskProposalReviewContext): void {
  if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires a review context`)
  for (const key of Object.keys(context)) {
    if (!REVIEW_CONTEXT_FIELDS.includes(key)) {
      throw new Error(`task: proposal "${id}" review context has an unsupported field "${key}"`)
    }
  }
  if (!isDigest(context.capabilityManifestDigest)) {
    throw new Error(
      `task: proposal "${id}" review context capability manifest digest must be a lowercase SHA-256 hex digest`,
    )
  }
  if (!Array.isArray(context.verifiers))
    throw new Error(`task: proposal "${id}" review context verifiers must be an array`)
  for (const verifier of context.verifiers) {
    if (!isRecord(verifier)) throw new Error(`task: proposal "${id}" review context verifiers must be objects`)
    for (const key of Object.keys(verifier)) {
      if (!VERIFIER_IDENTITY_FIELDS.includes(key)) {
        throw new Error(`task: proposal "${id}" review context verifier has an unsupported field "${key}"`)
      }
    }
    if (!nonEmpty(verifier.verifierId))
      throw new Error(`task: proposal "${id}" review context verifier requires a verifier id`)
    if (verifier.version !== undefined && !nonEmpty(verifier.version)) {
      throw new Error(
        `task: proposal "${id}" review context verifier "${verifier.verifierId}" version must be a non-empty string when present`,
      )
    }
    if (verifier.configurationDigest !== undefined && !isDigest(verifier.configurationDigest)) {
      throw new Error(
        `task: proposal "${id}" review context verifier "${verifier.verifierId}" configuration digest must be a lowercase SHA-256 hex digest when present`,
      )
    }
  }
}

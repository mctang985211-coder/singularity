/** Proposal lifecycle reducer handlers: submit, decide, change phase, admit. @module @dangosys/dsh-singularity-task/service/proposals */

import {
  TASK_PROPOSAL_DECISION_OUTCOMES,
  TASK_PROPOSAL_PHASES,
  type TaskProposal,
  type TaskProposalDecisionClaim,
  type TaskProposalConsumption,
  type TaskProposalPhase,
  type TaskProposalPhaseChange,
  type TaskProposalStatus,
} from '../proposal.ts'
import type { TaskId, TaskSnapshot } from '../types.ts'
import {
  assertConsumptionBinding,
  assertDecisionBinding,
  assertProposal,
  assertProposalTask,
  assertProposalTransition,
  assertRootIntakeOpen,
  proposalIn,
  proposalIndex,
  setProposal,
} from './checks/proposals.ts'
import { copy, isRecord, nonEmpty } from './checks/primitives.ts'

/** The statuses each decision may be taken from: a policy-off batch has no review to decide; a withdrawal may land on a ready or approved one. */
const DECISION_SOURCES: Readonly<Record<TaskProposalDecisionClaim['outcome'], readonly TaskProposalStatus[]>> = {
  approved: ['pending_review'],
  rejected: ['pending_review'],
  cancelled: ['ready', 'pending_review', 'approved'],
  expired: ['ready', 'pending_review', 'approved'],
}

/** The statuses each runtime phase change may come from; `ready` only from `approved` (that edge is the post-approval re-check). */
const PHASE_SOURCES: Readonly<Record<TaskProposalPhase, readonly TaskProposalStatus[]>> = {
  ready: ['approved'],
  pending_review: ['ready'],
  stale: ['ready', 'approved'],
}

/** The only status a consumption may come from: the re-check has to have passed and be on the record. */
const ADMISSION_SOURCES: readonly TaskProposalStatus[] = ['ready']

/** A proposal enters the store (T2/T3, §6; root contracts A0 §2). The reducer is the shape gate and the integrity gate, in that order: the record must be a well-formed proposal of its kind — the closed field set of its review context, a birth … */
export function submitProposal(snapshot: TaskSnapshot, taskId: TaskId, proposal: TaskProposal): TaskSnapshot {
  assertProposal(snapshot, proposal)
  assertProposalTask(proposal, taskId)
  const index = proposalIndex(snapshot)
  if (index.byId[proposal.proposalId] !== undefined) {
    throw new Error(`task: proposal "${proposal.proposalId}" already exists`)
  }
  const bound = index.byRequestKey[proposal.requestKey]
  if (bound !== undefined) {
    throw new Error(
      `task: proposal request key "${proposal.requestKey}" is already bound to proposal "${bound.proposalId}"`,
    )
  }
  if (proposal.kind === 'root') assertRootIntakeOpen(snapshot, proposal.proposalId)
  const stored: TaskProposal = copy(proposal)
  if (stored.kind === 'root') {
    // A root contract belongs to no task: it is in the index by id and by
    // request key, and in no parent's list.
    snapshot = {
      ...snapshot,
      proposals: {
        all: [...index.all, stored],
        byId: { ...index.byId, [stored.proposalId]: stored },
        byRequestKey: { ...index.byRequestKey, [stored.requestKey]: stored },
        byParentTask: index.byParentTask,
      },
    }
    return snapshot
  }
  const parentTaskId = stored.identity.parentTaskId
  snapshot = {
    ...snapshot,
    proposals: {
      all: [...index.all, stored],
      byId: { ...index.byId, [stored.proposalId]: stored },
      byRequestKey: { ...index.byRequestKey, [stored.requestKey]: stored },
      byParentTask: {
        ...index.byParentTask,
        [parentTaskId]: [...(index.byParentTask[parentTaskId] ?? []), stored],
      },
    },
  }
  return snapshot
}

/** One review decision (T2/T3, §6): the outcome, bound to the dossier digest and both context fingerprints, checked against the stored proposal before anything is applied. */
export function decideProposal(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  claim: TaskProposalDecisionClaim,
  timestamp: string,
): TaskSnapshot {
  if (!isRecord(claim)) throw new Error('task: proposal decision must be an object')
  const proposal = proposalIn(snapshot, claim.proposalId)
  assertProposalTask(proposal, taskId)
  if (!TASK_PROPOSAL_DECISION_OUTCOMES.includes(claim.outcome)) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" decision outcome must be one of ${TASK_PROPOSAL_DECISION_OUTCOMES.join(', ')}`,
    )
  }
  assertDecisionBinding(proposal, claim)
  if (!nonEmpty(claim.decidedBy)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decider`)
  if (!nonEmpty(claim.decidedAt))
    throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decision time`)
  if (claim.reason !== undefined && !nonEmpty(claim.reason)) {
    throw new Error(`task: proposal "${proposal.proposalId}" decision reason must be a non-empty string when present`)
  }
  if (claim.outcome === 'expired' && !nonEmpty(claim.reason)) {
    throw new Error(`task: proposal "${proposal.proposalId}" expiry requires a reason`)
  }
  assertProposalTransition(proposal, claim.outcome, DECISION_SOURCES[claim.outcome])
  snapshot = setProposal(snapshot, proposal.proposalId, {
    status: claim.outcome,
    updatedAt: timestamp,
    decision: {
      outcome: claim.outcome,
      proposalDigest: claim.proposalDigest,
      admissionContextDigest: claim.admissionContextDigest,
      ...(claim.reviewContextDigest === undefined ? {} : { reviewContextDigest: claim.reviewContextDigest }),
      decidedBy: claim.decidedBy,
      decidedAt: claim.decidedAt,
      ...(claim.reason === undefined ? {} : { reason: claim.reason }),
    },
  })
  return snapshot
}

/** One runtime phase change (T2/T3, §6): the two edges that are not a person's decision or a consumption — `ready → pending_review` when the deployment tightened to `all` before admission, `approved → ready` when the post-approval re-check … */
export function changeProposalPhase(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  change: TaskProposalPhaseChange,
  timestamp: string,
): TaskSnapshot {
  if (!isRecord(change)) throw new Error('task: proposal phase change must be an object')
  const proposal = proposalIn(snapshot, change.proposalId)
  assertProposalTask(proposal, taskId)
  if (!TASK_PROPOSAL_PHASES.includes(change.to)) {
    throw new Error(`task: proposal "${proposal.proposalId}" phase must be one of ${TASK_PROPOSAL_PHASES.join(', ')}`)
  }
  if (change.to === 'stale' && !nonEmpty(change.reason)) {
    throw new Error(`task: proposal "${proposal.proposalId}" is marked stale without a reason`)
  }
  if (change.reason !== undefined && !nonEmpty(change.reason)) {
    throw new Error(
      `task: proposal "${proposal.proposalId}" phase change reason must be a non-empty string when present`,
    )
  }
  assertProposalTransition(proposal, change.to, PHASE_SOURCES[change.to])
  snapshot = setProposal(snapshot, proposal.proposalId, { status: change.to, updatedAt: timestamp })
  return snapshot
}

/** A proposal is consumed (§6): what it asked for exists, and this record says what it became. */
export function admitProposal(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  consumption: TaskProposalConsumption,
  timestamp: string,
): TaskSnapshot {
  if (!isRecord(consumption)) throw new Error('task: proposal consumption must be an object')
  const proposal = proposalIn(snapshot, consumption.proposalId)
  assertProposalTask(proposal, taskId)
  assertConsumptionBinding(snapshot, proposal, consumption)
  assertProposalTransition(proposal, 'admitted', ADMISSION_SOURCES)
  snapshot = setProposal(snapshot, proposal.proposalId, {
    status: 'admitted',
    updatedAt: timestamp,
    consumption:
      consumption.kind === 'root'
        ? {
            kind: 'root',
            proposalId: consumption.proposalId,
            proposalDigest: consumption.proposalDigest,
            reviewContextDigest: consumption.reviewContextDigest,
            rootTaskId: consumption.rootTaskId,
            rootRunId: consumption.rootRunId,
            admittedAt: consumption.admittedAt,
            ...(consumption.reason === undefined ? {} : { reason: consumption.reason }),
          }
        : {
            ...(consumption.kind === undefined ? {} : { kind: consumption.kind }),
            proposalId: consumption.proposalId,
            proposalDigest: consumption.proposalDigest,
            reviewContextDigest: consumption.reviewContextDigest,
            parentRunId: consumption.parentRunId,
            batchId: consumption.batchId,
            childTaskIds: [...consumption.childTaskIds],
            admittedAt: consumption.admittedAt,
            ...(consumption.reason === undefined ? {} : { reason: consumption.reason }),
          },
  })
  return snapshot
}

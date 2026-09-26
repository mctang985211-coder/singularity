import type {
  CapabilityManifest,
  DependencyEdge,
  RunId,
  TaskId,
  TaskInstance,
} from '../../src/types.ts'
import type { AdmissionContext, DecompositionIdentity, TaskContract } from '../../src/contract.ts'
import { TASK_CONTRACT_VERSION, contractDigest, decompositionDigest, sha256Hex } from '../../src/contract.ts'
import type { TaskProposalBatchConsumption, TaskProposalDecomposition, TaskProposalReviewContext } from '../../src/proposal.ts'
import { admissionContextDigest, batchIdFor, reviewContextDigest, taskProposalId } from '../../src/proposal.ts'
import type { TaskService } from '../../src/index.ts'

/** The limits a test proposal is submitted under: both fingerprints are derived from these records, never faked. */
export const TEST_ADMISSION_CONTEXT: AdmissionContext = { maxDepth: 4, maxChildren: 8, auditOnly: { maxToolCalls: 150 } }
export const TEST_REVIEW_CONTEXT: TaskProposalReviewContext = { capabilityManifestDigest: sha256Hex('[]'), verifiers: [] }

export interface BatchRequest {
  readonly storeId: string
  readonly parentTaskId: TaskId
  readonly parentRunId: RunId
  readonly callerSessionId: string
  readonly children: readonly TaskInstance[]
  readonly requestKey?: string
  readonly reason?: string
}

/** The contract a child task's projections imply — what a proposal stores beside the child's identity. */
export function contractOf(child: TaskInstance): TaskContract {
  return {
    contractVersion: TASK_CONTRACT_VERSION,
    objective: child.objective,
    acceptanceCriteria: child.acceptanceCriteria,
    assumptions: [],
    constraints: [],
    requiredCapabilities: child.requestedCapabilities,
  }
}

/**
 * The proposal one test batch is admitted as, and the consumption that admits it
 * — identity, content and the three digests derived from the children
 * themselves, so the reducer's content↔identity checks are exercised rather than
 * bypassed. K1 identifies a batch by `(parentRunId, proposalId)`, so this pair is
 * the only door that creates children: `admitBatchIn` refuses anything else.
 */
export function batchFixture(request: BatchRequest): {
  proposal: TaskProposalDecomposition
  consumption: TaskProposalBatchConsumption
} {
  const { storeId, parentTaskId, parentRunId, callerSessionId, children } = request
  const batch = children.map(child => ({
    contract: contractOf(child),
    dependsOn: [] as number[],
    decomposable: false,
    requiresIndependentAcceptance: false,
  }))
  const identity: DecompositionIdentity = {
    contractVersion: TASK_CONTRACT_VERSION,
    storeId,
    parentTaskId,
    parentRunId,
    callerSessionId,
    reason: request.reason ?? 'split the work',
    children: batch.map(child => ({
      contractDigest: contractDigest(child.contract),
      dependsOn: child.dependsOn,
      decomposable: child.decomposable,
      requiresIndependentAcceptance: child.requiresIndependentAcceptance,
    })),
  }
  const proposal: TaskProposalDecomposition = {
    proposalId: taskProposalId(identity),
    requestKey: request.requestKey ?? 'k-batch',
    status: 'ready',
    policy: 'off',
    identity,
    batch,
    proposalDigest: decompositionDigest(identity),
    admissionContext: TEST_ADMISSION_CONTEXT,
    admissionContextDigest: admissionContextDigest(TEST_ADMISSION_CONTEXT),
    reviewContext: TEST_REVIEW_CONTEXT,
    reviewContextDigest: reviewContextDigest(TEST_REVIEW_CONTEXT),
    createdAt: new Date().toISOString(),
  }
  return {
    proposal,
    consumption: {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      parentRunId,
      batchId: batchIdFor(parentRunId, proposal.proposalId),
      childTaskIds: children.map(child => child.taskId),
      admittedAt: new Date().toISOString(),
    },
  }
}

/**
 * Admit one batch through the store's own door: the proposal is recorded, then
 * its children land as that proposal's consumption in one commit — the same two
 * writes the runtime makes, without the runtime, for the tests that need a
 * child to exist rather than a batch to run.
 */
export async function admitBatchFixture(
  service: TaskService,
  request: BatchRequest & {
    readonly edges?: readonly DependencyEdge[]
    readonly manifests?: readonly CapabilityManifest[]
    readonly actor?: string
  },
): Promise<TaskProposalBatchConsumption> {
  const actor = request.actor ?? 'tester'
  const { proposal, consumption } = batchFixture(request)
  await service.submitProposalIn(request.storeId, proposal, actor)
  await service.admitBatchIn(
    request.storeId,
    request.parentTaskId,
    request.parentRunId,
    request.children,
    actor,
    request.edges ?? [],
    undefined,
    request.manifests,
    consumption,
  )
  return consumption
}

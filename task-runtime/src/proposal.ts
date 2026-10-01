/**
 * The runtime's side of the T2/T3 proposal contract (construction guide §5–§6).
 * The store owns the proposal record and every rule about it
 */

import { capabilityManifestDigest, canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  TaskProposal,
  TaskProposalReviewContext,
  TaskProposalStatus,
  TaskProposalVerifierIdentity,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { ResolvedProviderIdentity } from './provider-precheck.ts'

/** The prefix every derived request key carries, so a key is recognizable as one wherever it is printed. */
const PROPOSAL_REQUEST_KEY_PREFIX = 'rk-'

/**
 * The calling context a derived request key is made of: where the batch goes
 * (parent task and run), who asked (the caller's session), and what was asked
 */
interface ProposalRequestKeyContext {
  parentTaskId: string
  parentRunId: string
  callerSessionId: string
  /** {@link decompositionDigest} of the batch identity the submission built. */
  proposalDigest: string
}

/**
 * The request key one call derives when its caller named none: `rk-` plus the
 * SHA-256 of {@link canonicalize} over
 */
function requestKeyOf(payload: Record<string, unknown>): string {
  return `${PROPOSAL_REQUEST_KEY_PREFIX}${sha256Hex(canonicalize(payload))}`
}

export function proposalRequestKey(context: ProposalRequestKeyContext): string {
  return requestKeyOf({
    parentTaskId: context.parentTaskId,
    parentRunId: context.parentRunId,
    callerSessionId: context.callerSessionId,
    proposalDigest: context.proposalDigest,
  })
}

/**
 * The calling context a *root* contract's request key is made of (A0 §2): which
 * store and which root session the contract is the goal of, and the digest of
 */
interface RootRequestKeyContext {
  storeId: string
  rootSessionId: string
  /** {@link contractDigest} of the normalized root contract the request carries. */
  contractDigest: string
}

/**
 * The request key one root intake derives when its caller named none: `rk-` plus
 * the SHA-256 of {@link canonicalize} over {@link RootRequestKeyContext}.
 */
export function rootProposalRequestKey(context: RootRequestKeyContext): string {
  return requestKeyOf({
    storeId: context.storeId,
    rootSessionId: context.rootSessionId,
    contractDigest: context.contractDigest,
  })
}

/**
 * The statuses in which a proposal is still "in flight" for the task that made
 * it — submitted and not yet admitted, not yet decided, or decided and not yet
 */
const OPEN_PROPOSAL_STATUSES: readonly TaskProposalStatus[] = ['ready', 'pending_review', 'approved']

/**
 * Whether one proposal is still in flight for the task that made it —
 * submitted and not yet admitted, not yet decided, or decided and not yet
 */
export function isOpenProposal(proposal: TaskProposal): boolean {
  return OPEN_PROPOSAL_STATUSES.includes(proposal.status)
}

/**
 * The open proposal of one run, or `undefined` — §7.4's "已知等待": a run whose
 * own batch is waiting for a review (or for the admission its approval
 */
export function openProposalOf(snapshot: TaskSnapshot, taskId: string, runId: string): TaskProposal | undefined {
  const proposals = (snapshot.proposals?.byParentTask[taskId] ?? []).filter(
    proposal =>
      proposal.kind !== 'root' &&
      proposal.identity.parentRunId === runId &&
      OPEN_PROPOSAL_STATUSES.includes(proposal.status),
  )
  return proposals[proposals.length - 1]
}

/** What {@link reviewContextOf} is built from. */
interface ReviewContextInput {
  /**
   * The manifests the batch resolved, in batch order — one per child, the same
   * list admitted with the batch. Order is part of the identity
   */
  readonly manifests: readonly CapabilityManifest[]
  /** Every criterion of the batch, in batch order and child order. */
  readonly criteria: readonly AcceptanceCriterion[]
  /**
   * The content identity the admission-time provider pre-check resolved for
   * *these* rows' skills (`providerContentIdentities`), sorted by name. The
   */
  readonly providers: readonly ResolvedProviderIdentity[]
}

/**
 * What a batch was reviewed against (§6), as this runtime can compute it.
 * Two parts, and each has a stated boundary:
 */
export function reviewContextOf(input: ReviewContextInput): TaskProposalReviewContext {
  return {
    capabilityManifestDigest: sha256Hex(
      canonicalize({
        manifest: capabilityManifestDigest(input.manifests),
        providers: input.providers.map(provider => ({ name: provider.name, contractDigest: provider.contractDigest })),
      }),
    ),
    verifiers: verifierIdentitiesOf(input.criteria),
  }
}

/**
 * The judging instances a batch's criteria pin by id, in first-appearance
 * order. See {@link reviewContextOf} for why this is an id list and not a
 */
function verifierIdentitiesOf(criteria: readonly AcceptanceCriterion[]): TaskProposalVerifierIdentity[] {
  const identities: TaskProposalVerifierIdentity[] = []
  const seen = new Set<string>()
  for (const criterion of criteria) {
    const verifierId = criterion.verifierRef
    if (verifierId === undefined || seen.has(verifierId)) continue
    seen.add(verifierId)
    identities.push({ verifierId })
  }
  return identities
}

/**
 * Why two review contexts differ, as one line a refusal can carry: which part
 * of the resolution moved (the manifests and provider content, or the judging
 */
export function reviewContextDelta(before: TaskProposalReviewContext, after: TaskProposalReviewContext): string {
  const parts: string[] = []
  if (before.capabilityManifestDigest !== after.capabilityManifestDigest) {
    parts.push(
      `the capability resolution moved (manifest digest ${before.capabilityManifestDigest} → ${after.capabilityManifestDigest})`,
    )
  }
  const beforeIds = before.verifiers
    .map(verifier => verifier.verifierId)
    .sort()
    .join(', ')
  const afterIds = after.verifiers
    .map(verifier => verifier.verifierId)
    .sort()
    .join(', ')
  if (beforeIds !== afterIds) {
    parts.push(`the judging verifiers moved ([${beforeIds}] → [${afterIds}])`)
  }
  return parts.length === 0 ? 'the review context moved' : parts.join('; ')
}

/**
 * The runtime's side of the T2/T3 proposal contract (construction guide §5–§6).
 * The store owns the proposal record and every rule about it
 * (`task/src/proposal.ts`); what lives here is what only the runtime can
 * compute: the idempotency key a caller's request is addressed by, the review
 * context a batch actually resolved against, and the question "is this run
 * waiting on a proposal?" the coordination loop needs.
 *
 * **The request key.** §6 requires a stable key per request, derived from the
 * calling context: the same key with the same content is answered from the
 * store, a different content under the same key is refused, and a revision
 * carries a new key. {@link proposalRequestKey} derives it from the parent
 * task, the parent run, the calling session and the batch's own digest. The
 * digest already covers those three fields (T1's identity does), so the
 * explicit list looks redundant — it is deliberate: an idempotency key must not
 * silently change meaning when the *content* identity algorithm changes. With
 * the context fields named here, "same parent, same run, same caller, same
 * content" is the definition of the key rather than a consequence of what T1's
 * identity happens to cover today.
 *
 * **The review context.** §6: "有效审核上下文只包含该批实际解析到的 capability
 * manifest、verifier 身份及可用版本/相关配置，不因无关 registry 条目变化作废".
 * {@link reviewContextOf} builds exactly that, and its docblock states what the
 * deployment can and cannot pin — the honest wording of a boundary this build
 * does not cross (a verifier's version, a skill's bytes).
 *
 * Nothing here writes, spawns or decides: these are the functions a service
 * entry uses to say what a proposal *is* before anything is persisted.
 * @module @dangosys/dsh-singularity-task-runtime/proposal
 */

import {
  capabilityManifestDigest,
  canonicalize,
  sha256Hex,
} from '@dangosys/dsh-singularity-task'
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
export const PROPOSAL_REQUEST_KEY_PREFIX = 'rk-'

/**
 * The calling context a derived request key is made of: where the batch goes
 * (parent task and run), who asked (the caller's session), and what was asked
 * for (the batch's own digest).
 */
export interface ProposalRequestKeyContext {
  parentTaskId: string
  parentRunId: string
  callerSessionId: string
  /** {@link decompositionDigest} of the batch identity the submission built. */
  proposalDigest: string
}

/**
 * The request key one call derives when its caller named none: `rk-` plus the
 * SHA-256 of {@link canonicalize} over
 * {@link ProposalRequestKeyContext} (key order is irrelevant; the same request
 * addresses the same key however it was written).
 *
 * A caller with its own stable identifier (a message id, a task row) may pass
 * it instead — the store refuses one key bound to two proposals either way,
 * so an explicit key is a promise the caller keeps, not a way around the rule.
 * The derived form is what makes a retry of the *same* batch idempotent
 * without any caller bookkeeping: a revision has different content, hence a
 * different digest, hence a new key.
 */
export function proposalRequestKey(context: ProposalRequestKeyContext): string {
  return `${PROPOSAL_REQUEST_KEY_PREFIX}${sha256Hex(canonicalize({
    parentTaskId: context.parentTaskId,
    parentRunId: context.parentRunId,
    callerSessionId: context.callerSessionId,
    proposalDigest: context.proposalDigest,
  }))}`
}

/**
 * The calling context a *root* contract's request key is made of (A0 §2): which
 * store and which root session the contract is the goal of, and the digest of
 * the normalized contract itself.
 *
 * The parent task and parent run a batch's key names have no counterpart here —
 * a root contract has no parent, and the task it becomes does not exist until it
 * is activated — so the two fields that identify the subject are the store and
 * the root session, and the content is the contract's own digest.
 */
export interface RootRequestKeyContext {
  storeId: string
  rootSessionId: string
  /** {@link contractDigest} of the normalized root contract the request carries. */
  contractDigest: string
}

/**
 * The request key one root intake derives when its caller named none: `rk-` plus
 * the SHA-256 of {@link canonicalize} over {@link RootRequestKeyContext}.
 *
 * What the derivation buys, in the order it matters: the same contract asked for
 * again — in this process or after a restart — addresses the same proposal and is
 * answered from the record instead of being written twice; a revision is
 * different content, hence a different digest, hence a different key, which is
 * exactly what §6 wants a revision to be; and no caller has to keep a key of its
 * own to get that. A caller that *has* a stable identifier may pass it instead,
 * and the store then holds it to the same rule — one key names one proposal, and
 * a key already bound to other content is refused by name.
 */
export function rootProposalRequestKey(context: RootRequestKeyContext): string {
  return `${PROPOSAL_REQUEST_KEY_PREFIX}${sha256Hex(canonicalize({
    storeId: context.storeId,
    rootSessionId: context.rootSessionId,
    contractDigest: context.contractDigest,
  }))}`
}

/**
 * The statuses in which a proposal is still "in flight" for the task that made
 * it — submitted and not yet admitted, not yet decided, or decided and not yet
 * re-checked. `admitted` and the four terminal statuses are excluded: a task
 * with one of those has either a batch (the run is coordinated by A3 from
 * there) or nothing waiting.
 */
const OPEN_PROPOSAL_STATUSES: readonly TaskProposalStatus[] = ['ready', 'pending_review', 'approved']

/**
 * Whether one proposal is still in flight for the task that made it —
 * submitted and not yet admitted, not yet decided, or decided and not yet
 * re-checked (§6). `admitted` and the four terminal statuses are not open: a
 * task with one of those has either a batch (the run is coordinated by A3 from
 * there) or nothing waiting.
 */
export function isOpenProposal(proposal: TaskProposal): boolean {
  return OPEN_PROPOSAL_STATUSES.includes(proposal.status)
}

/**
 * The open proposal of one run, or `undefined` — §7.4's "已知等待": a run whose
 * own batch is waiting for a review (or for the admission its approval
 * authorizes) is idle on purpose, and an idle that is a known wait must not
 * count as stagnation.
 *
 * Both the task and the run are matched, not just the task: a proposal names
 * the run it was submitted from, and a *later* run of the same task is not
 * waiting on a batch its predecessor proposed.
 *
 * A snapshot with no proposal index (a hand-built one, or a store written
 * before proposals existed) answers `undefined` — the honest reading of "this
 * reader cannot see proposals", which is a run to be judged by the rules that
 * were in force when it was created rather than one this build's proposals
 * hold up.
 */
export function openProposalOf(snapshot: TaskSnapshot, taskId: string, runId: string): TaskProposal | undefined {
  const proposals = (snapshot.proposals?.byParentTask[taskId] ?? [])
    .filter(proposal => proposal.kind !== 'root'
      && proposal.identity.parentRunId === runId
      && OPEN_PROPOSAL_STATUSES.includes(proposal.status))
  return proposals[proposals.length - 1]
}

/** What {@link reviewContextOf} is built from. */
export interface ReviewContextInput {
  /**
   * The manifests the batch resolved, in batch order — one per child, the same
   * list admitted with the batch. Order is part of the identity
   * ({@link capabilityManifestDigest}): two resolutions that assigned the
   * manifests to different children are two identities.
   */
  readonly manifests: readonly CapabilityManifest[]
  /** Every criterion of the batch, in batch order and child order. */
  readonly criteria: readonly AcceptanceCriterion[]
  /**
   * The content identity the admission-time provider pre-check resolved for
   * *these* rows' skills (`providerContentIdentities`), sorted by name. The
   * empty list is the honest answer for a batch whose capabilities grant no
   * skill at all: nothing was resolved, so nothing is claimed.
   */
  readonly providers: readonly ResolvedProviderIdentity[]
}

/**
 * What a batch was reviewed against (§6), as this runtime can compute it.
 *
 * Two parts, and each has a stated boundary:
 *
 * - **The manifests**, through {@link capabilityManifestDigest}, folded with
 *   the provider content identity the admission-time pre-check resolved for
 *   the same rows. The manifest itself names skills, tools, presets,
 *   permissions and MCP servers — *names*, not bytes — so the fold adds what
 *   only discovery can answer: the `contractDigest` of every accepted
 *   provider (`null` for a skill that declares no sidecar, which is a skill
 *   whose content this deployment cannot pin). The fold covers the rows *this*
 *   batch matched and nothing else, which is what keeps §6's "an unrelated
 *   registry edit does not invalidate a reviewed proposal" true: a changed row
 *   the batch never resolved is not in this digest.
 * - **The judging verifiers**, as the ids the batch's criteria pin by
 *   `verifierRef`. Those are the only instances this runtime can name: the
 *   registered registry exposes its id vocabulary (`verifierIds()`), not the
 *   version or the configuration each id currently stands for, so
 *   `version`/`configurationDigest` are left off rather than invented (§6:
 *   "没有可信内容版本的资源必须标明身份保障有限"). A criterion with no
 *   `verifierRef` is dispatched by mode inside the verifier service and this
 *   runtime cannot see which instance that is; its mode is part of the batch
 *   content (the proposal digest covers the whole contract), so a *mode*
 *   change is a different proposal, while a re-registration that keeps an id
 *   and changes the behaviour behind it is **not** visible here and does not
 *   invalidate a reviewed proposal.
 */
export function reviewContextOf(input: ReviewContextInput): TaskProposalReviewContext {
  return {
    capabilityManifestDigest: sha256Hex(canonicalize({
      manifest: capabilityManifestDigest(input.manifests),
      providers: input.providers.map(provider => ({ name: provider.name, contractDigest: provider.contractDigest })),
    })),
    verifiers: verifierIdentitiesOf(input.criteria),
  }
}

/**
 * The judging instances a batch's criteria pin by id, in first-appearance
 * order. See {@link reviewContextOf} for why this is an id list and not a
 * version binding; the digest over it is order-insensitive
 * (`task/src/proposal.ts:reviewContextDigest` sorts), the stored list keeps
 * the writer's order so a reader can see which criterion came first.
 */
export function verifierIdentitiesOf(criteria: readonly AcceptanceCriterion[]): TaskProposalVerifierIdentity[] {
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
 * verifiers). §6 requires the stale marking to name what changed — an
 * invalidation a reader cannot explain is a record that cannot be trusted —
 * and "the context changed" alone would be exactly that. The limits in force
 * are the other half of the re-check and have their own fingerprint
 * (`admissionContextDigest`), so a caller that has two of those reports the
 * difference itself.
 */
export function reviewContextDelta(before: TaskProposalReviewContext, after: TaskProposalReviewContext): string {
  const parts: string[] = []
  if (before.capabilityManifestDigest !== after.capabilityManifestDigest) {
    parts.push(`the capability resolution moved (manifest digest ${before.capabilityManifestDigest} → ${after.capabilityManifestDigest})`)
  }
  const beforeIds = before.verifiers.map(verifier => verifier.verifierId).sort().join(', ')
  const afterIds = after.verifiers.map(verifier => verifier.verifierId).sort().join(', ')
  if (beforeIds !== afterIds) {
    parts.push(`the judging verifiers moved ([${beforeIds}] → [${afterIds}])`)
  }
  return parts.length === 0 ? 'the review context moved' : parts.join('; ')
}

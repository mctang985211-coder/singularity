/**
 * The stage-C review channel (construction guide §5–§6 rule 8): the deployment's
 * answer to `ctx.proposalReviewChannel`, mounted at the service assembly
 * (`./index.ts`) rather than in any agent's tool plane, so a recursive worker
 * never gains a human-decision tool by it.
 *
 * Three things this module is, and one it is not:
 *
 * - **A rendering of the saved batch.** §5 fixes what a review request must show
 *   — the parent's goal and criteria, every child's goal, criteria, assumptions,
 *   constraints, dependencies and declared capabilities with their current
 *   resolution, the limits in force, the unmet obligations, the determinism and
 *   heuristic markings, the proposal id and the full digest, and both context
 *   fingerprints — and forbids approving a hidden contract. {@link
 *   renderProposalReview} walks *every* child of the stored proposal: the batch
 *   is already bounded by `maxChildren`, so nothing here may be summarized away.
 * - **A use of the existing approval seam.** The ask goes through
 *   `ctx.approval.request` — the same call `escalate`, `hitl_approve` and
 *   `evolution_decide` make — whose answerers are the deployment's own human
 *   surfaces (the canvas HITL panel, the owner's conversation). No second
 *   approval system, no new card store.
 * - **A decider with its own identity.** The only writer of a decision is
 *   {@link ProposalReviewService}, and it names itself in `decidedBy`
 *   (`reviewDecider`): the model has no parameter that reaches this path, and no
 *   tool in this package accepts an approval credential (§6: 模型不能自行生成
 *   可信 approvalRef).
 * - **Not a blocking watcher.** A person takes as long as they take. The ask is
 *   dispatched and its answer settles asynchronously — the runtime is inside its
 *   own per-parent serialization when it asks (§6's 串行 rule), and holding that
 *   lock for a human would stall admission and recovery for the whole parent.
 *   An answer that arrives later is still recorded; an approval that arrives
 *   after its run ended is exactly what §6's `expired` transition is for.
 *
 * The routing is the store's owner: a store id is `rootTaskStoreId(ownerSession)`
 * and the session that owns the tree is the one whose approval policy asks a
 * person (the root setup pins it to `ask`; a worker's session runs the
 * deployment's `danger-full-access` posture, where an ask is auto-rejected
 * before any answerer sees it — recorded as a refusal nobody made would be a
 * lie). When that session has no live agent, or would not ask, the request
 * reports `requested: false` with the reason and the proposal keeps waiting,
 * which is exactly what §6 requires of an unavailable provider.
 * @module dsh-singularity-agent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  TaskInstance,
  TaskProposal,
  TaskProposalChild,
} from '@dangosys/dsh-singularity-task'
import type {
  ProposalReviewChannel,
  ProposalReviewNotice,
  ProposalReviewRequest,
  TaskRuntime,
} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'

/** The prefix `rootTaskStoreId` writes; see {@link ownerSessionOfStore} for why it is re-checked rather than trusted. */
const STORE_PREFIX = 'sg-t-'

/** The tool name the review question is about: the decomposition the batch would become (audit and presentation). */
const REVIEW_TOOL_NAME = 'task_decompose'

declare module '@deepseek-ai/cordis' {
  interface Context {
    proposalReviewChannel: ProposalReviewService
  }
}

/** The agent type the approval seam takes, without importing the agent package for a name. */
type ReviewAgent = Parameters<ApprovalService['request']>[0]['agent']

/**
 * The owner session of a task store — whose approval surface a review of that
 * store's batches belongs on — or `undefined` for an id this deployment did not
 * build.
 *
 * The parse is re-checked through {@link rootTaskStoreId} rather than trusted:
 * the mapping from a root session to its store belongs to the task package, and
 * a string that merely looks like one must not name a session that never owned
 * a store (which would route a review into a stranger's conversation).
 */
export function ownerSessionOfStore(storeId: string): string | undefined {
  if (!storeId.startsWith(STORE_PREFIX)) return undefined
  const sessionId = storeId.slice(STORE_PREFIX.length)
  return sessionId.length > 0 && rootTaskStoreId(sessionId) === storeId ? sessionId : undefined
}

/**
 * The decider identity the channel records: the approval surface of the owner
 * session the review was shown in. Deliberately a channel-shaped value — the
 * same `approval:` family the native grants use (`escalate`, `evolution_decide`)
 * — because a reader of the record must be able to tell a human grant apart
 * from a session id and from anything a model could have written.
 */
export function reviewDecider(ownerSessionId: string): string {
  return `approval:${ownerSessionId}`
}

/** How a container field is listed, or that it held nothing — never an omitted line a reader has to notice. */
function listField(title: string, items: readonly string[], empty: string): string[] {
  if (items.length === 0) return [`  ${title}: ${empty}`]
  return [`  ${title}:`, ...items.map(item => `  - ${item}`)]
}

/**
 * The protected acceptance inputs a criterion declares, with the identity fixed
 * at submission: a reviewer has to see that they are protected *and* which bytes
 * were fixed, because the verifier re-reads exactly these before judging.
 */
function protectedInputsPart(criterion: AcceptanceCriterion): string {
  const declared = criterion.protectedInputs ?? []
  if (declared.length === 0) return ''
  return ` [protected inputs: ${declared.map(ref => `${ref.path} sha256:${ref.sha256}`).join(', ')}]`
}

/** The evidence and artifact requirements a criterion declares, as one suffix — omitted entirely when it declares none. */
function requirementParts(criterion: AcceptanceCriterion): string[] {
  const parts: string[] = []
  if (criterion.requiredEvidence.length > 0) parts.push(`required evidence: ${criterion.requiredEvidence.join(', ')}`)
  if ((criterion.requiresArtifact ?? []).length > 0) parts.push(`requires verified artifact: ${criterion.requiresArtifact!.join(', ')}`)
  if ((criterion.acceptsArtifact ?? []).length > 0) parts.push(`accepts artifact: ${criterion.acceptsArtifact!.join(', ')}`)
  if (criterion.childEvidence !== undefined && criterion.childEvidence.length > 0) {
    parts.push(`child evidence: ${criterion.childEvidence.map(item =>
      `child ${item.childIndex}${item.criterionId === undefined ? '' : `:${item.criterionId}`}${item.evidenceRef === undefined ? '' : `#${item.evidenceRef}`}`).join(', ')}`)
  }
  return parts
}

/**
 * How a criterion reads to a reviewer: its id, its mode, whether it is mandatory,
 * whether it is a heuristic judgement (which never counts as a deterministic
 * pass — §5 requires the marking, not a footnote), what it says, and what it
 * pins (command, named verifier, protected inputs, artifact requirements).
 */
function criterionLine(criterion: AcceptanceCriterion): string {
  const qualifiers = [
    criterion.verificationMode,
    ...(criterion.mandatory ? ['mandatory'] : ['optional']),
    ...(criterion.heuristic === true ? ['heuristic — judged by a model, never a deterministic pass'] : []),
  ]
  const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
  const verifier = criterion.verifierRef === undefined ? '' : ` [verifier: ${criterion.verifierRef}]`
  const requirements = requirementParts(criterion)
  const requirementText = requirements.length === 0 ? '' : ` [${requirements.join('; ')}]`
  return `    - ${criterion.criterionId} [${qualifiers.join(', ')}] ${criterion.description}${command}${verifier}${protectedInputsPart(criterion)}${requirementText}`
}

/**
 * How one declared capability resolved when this batch was proposed: the
 * manifest the runtime built for *this* child, with the skills and tools a
 * worker would be granted — and the capability gap named when a requirement is
 * not in the registry, rather than silently absent (§5's 声明能力及当前解析).
 *
 * `undefined` is the honest answer for a request that carried no manifest for
 * this child: the resolution is then not shown at all, and nothing is claimed
 * about it.
 */
function resolutionLines(manifest: CapabilityManifest | undefined): string[] {
  if (manifest === undefined) return []
  const entries = Object.entries(manifest.capabilities)
  const lines = entries.map(([name, entry]) => {
    const parts = [
      ...(entry.skills.length === 0 ? [] : [`skills: ${entry.skills.join(', ')}`]),
      ...(entry.tools.length === 0 ? [] : [`tools: ${entry.tools.join(', ')}`]),
      ...(entry.preset === undefined ? [] : [`preset: ${entry.preset}`]),
      ...(entry.permission === undefined ? [] : [`permission: ${entry.permission}`]),
      ...(entry.mcpServers === undefined || entry.mcpServers.length === 0 ? [] : [`mcp servers: ${entry.mcpServers.join(', ')}`]),
    ]
    return `  - ${name} → ${parts.length === 0 ? 'granted no skill or tool' : parts.join('; ')}`
  })
  const missing = manifest.missing.map(name => `  - ${name} → NOT GRANTED (capability gap: the registry has no such row, and this batch's admission recorded it)`)
  return ['  resolution (the manifests this batch resolved to):', ...lines, ...missing]
}

/**
 * One child of the batch as a reviewer reads it (§5): its goal, its criteria,
 * what it inherits as assumptions and constraints, what it waits for, what it
 * requires, and how those requirements currently resolve.
 *
 * `dependsOn` names the sibling objective as well as the index: a batch whose
 * ordering matters must not require a reviewer to count positions.
 */
export function renderProposalChild(
  child: TaskProposalChild,
  options: {
    index: number
    siblings: readonly TaskProposalChild[]
    contractDigest?: string
    manifest?: CapabilityManifest
  },
): string[] {
  const contract = child.contract
  const verifierRefs = [...new Set(contract.acceptanceCriteria.flatMap(criterion => criterion.verifierRef ?? []))]
  const dependencies = child.dependsOn.map(index => {
    const sibling = options.siblings[index]
    return `child ${index}${sibling === undefined ? '' : ` (${sibling.contract.objective})`}`
  })
  return [
    `- child ${options.index}: ${contract.objective}`,
    ...(options.contractDigest === undefined ? [] : [`  contract digest (sha256): ${options.contractDigest}`]),
    `  contract version: ${contract.contractVersion}`,
    '  acceptance criteria:',
    ...contract.acceptanceCriteria.map(criterionLine),
    ...(verifierRefs.length === 0 ? [] : [`  pinned verifiers: ${verifierRefs.join(', ')}`]),
    ...listField('assumptions', contract.assumptions, '(none declared — the contract rests on nothing stated)'),
    ...listField('constraints', contract.constraints, '(none declared)'),
    ...listField('required capabilities', contract.requiredCapabilities, '(none)'),
    ...resolutionLines(options.manifest),
    ...listField('depends on', dependencies, '(nothing — this child may start first)'),
    `  decomposable: ${child.decomposable ? 'yes' : 'no'}; requires independent acceptance: ${child.requiresIndependentAcceptance ? 'yes' : 'no'}`,
  ]
}

/**
 * The complete batch content of a stored proposal, one block per child in batch
 * order — the whole set, never a prefix. `manifests`, when a caller has them,
 * are the resolution recorded with the request and are aligned with the
 * children positionally.
 */
export function renderProposalChildren(proposal: TaskProposal, manifests?: readonly CapabilityManifest[]): string[] {
  return proposal.batch.flatMap((child, index) => [
    ...renderProposalChild(child, {
      index,
      siblings: proposal.batch,
      ...(proposal.identity.children[index]?.contractDigest === undefined ? {} : { contractDigest: proposal.identity.children[index]!.contractDigest }),
      ...(manifests?.[index] === undefined ? {} : { manifest: manifests[index]! }),
    }),
    '',
  ])
}

/** The limits one batch was admitted under, as the record holds them, with the enforced and the audited values kept apart. */
function limitLines(proposal: TaskProposal): string[] {
  const context = proposal.admissionContext
  const audited = [
    ...(context.auditOnly.maxToolCalls === undefined ? [] : [`maxToolCalls ${context.auditOnly.maxToolCalls}`]),
    ...(context.auditOnly.tokens === undefined ? [] : [`tokens ${context.auditOnly.tokens}`]),
    ...(context.auditOnly.attempts === undefined ? [] : [`attempts ${context.auditOnly.attempts}`]),
  ]
  return [
    `- enforced at admission: maxDepth ${context.maxDepth}, maxChildren ${context.maxChildren}`,
    `- enforced in flight: ${context.wallTimeMs === undefined ? 'no wall-clock ceiling was configured' : `wallTimeMs ${context.wallTimeMs}`}`,
    `- audited after the run (never enforced in flight): ${audited.length === 0 ? 'none configured' : audited.join(', ')}`,
  ]
}

/**
 * The review material one person is shown (§5), rendered from the saved facts:
 * the parent, every child, the limits, the obligations, the identity a decision
 * binds, and what this record honestly cannot promise.
 *
 * A pure function of the request, so what a deployment shows and what a test
 * asserts are the same rendering.
 */
export function renderProposalReview(request: ProposalReviewRequest): string {
  const proposal = request.proposal
  const parent: TaskInstance = request.parentTask
  const criteria = proposal.identity.children
  return [
    `Batch review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
    `store: ${request.storeId}`,
    '',
    'A decision answers one question: should this batch run as it is written here? Approving it does not mean the work is',
    'accepted (the verifiers still judge every criterion), does not grant a capability, and does not close a gap. The',
    'decision binds the batch digest and both context fingerprints printed below: a revision, a re-resolution or a',
    'changed limit is a different proposal.',
    '',
    '## Parent task',
    `- ${parent.taskId} [${parent.status}/${parent.decompositionStatus}] depth ${parent.depth}`,
    `- objective: ${parent.objective}`,
    '- acceptance criteria:',
    ...parent.acceptanceCriteria.map(criterion =>
      `  - ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ', mandatory' : ''}] ${criterion.description}`),
    `- run: ${proposal.identity.parentRunId} (proposing session ${proposal.identity.callerSessionId})`,
    `- reason recorded for this batch: ${proposal.identity.reason}`,
    '',
    `## Children (${request.batch.children.length})`,
    ...renderProposalChildren(proposal, request.manifests),
    '## Limits this batch is admitted under',
    ...limitLines(proposal),
    '',
    `## Unmet obligations on the parent (${request.obligations.length})`,
    ...(request.obligations.length === 0
      ? ['(none recorded when this review was requested)']
      : request.obligations.map(obligation => `- ${obligation.obligationId}: ${obligation.goal} — judged by: ${obligation.criterion}`)),
    '',
    '## Identity — what an approval would bind',
    `- proposal digest (sha256): ${proposal.proposalDigest}`,
    `- admission context digest (the limits above): ${proposal.admissionContextDigest}`,
    `- review context digest (the resolution above): ${proposal.reviewContextDigest}`,
    `- capability manifest digest: ${proposal.reviewContext.capabilityManifestDigest}`,
    `- judging verifiers (the ids this batch's criteria pin): ${proposal.reviewContext.verifiers.length === 0 ? '(none pinned — criteria dispatch by mode)' : proposal.reviewContext.verifiers.map(verifier => verifier.verifierId).join(', ')}`,
    ...(request.registeredVerifiers === undefined
      ? ['- the deployment could not list its verifier registry when this review was requested']
      : [`- registered verifiers now: ${request.registeredVerifiers.join(', ')}`]),
    `- request key: ${proposal.requestKey}`,
    ...(proposal.supersedes === undefined ? [] : [`- supersedes: ${proposal.supersedes}`]),
    `- submitted at: ${proposal.createdAt}`,
    '',
    '## What this review cannot promise',
    '- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What a worker',
    '  actually loads is pinned per run at spawn, which happens after this decision.',
    '- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the',
    '  configuration that registration currently stands for.',
    '- a criterion marked heuristic is judged by a model; nothing in this batch turns it into a deterministic pass.',
  ].join('\n')
}

/**
 * The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and
 * records; it never admits anything itself — a recorded decision is what moves a
 * proposal, and the runtime performs the post-approval re-check and the
 * admission on its own.
 */
export class ProposalReviewService extends Service implements ProposalReviewChannel {
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'proposalReviewChannel')
    // A pending ask is withdrawn when this service goes away: the answer can no
    // longer be turned into a decision, and a card nobody could answer is worse
    // than one the next request raises again from the store's own facts.
    ctx.effect(() => () => this.lifetime.abort(new Error('proposal-review: service disposed')), 'proposal-review: pending asks')
  }

  async requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice> {
    const ownerSessionId = ownerSessionOfStore(request.storeId)
    if (ownerSessionId === undefined) {
      return {
        requested: false,
        detail:
          `store "${request.storeId}" does not name the root session a review has to be shown in, so nobody was asked; ` +
          'the proposal stays pending_review',
      }
    }
    const agent = this.liveAgent(ownerSessionId)
    if (agent === undefined) {
      return {
        requested: false,
        detail:
          `the owner session "${ownerSessionId}" has no live agent, so nobody was asked; the proposal stays pending_review until a ` +
          'decision is recorded (opening the graph again asks on the next request)',
      }
    }
    if (!this.asksAPerson(agent)) {
      return {
        requested: false,
        detail:
          `the owner session "${ownerSessionId}" runs with approval policy "never": an ask here is auto-rejected before any answerer ` +
          'sees it, which would record a refusal nobody made. Nobody was asked; the proposal stays pending_review',
      }
    }

    const ask = this.ctx.approval.request({
      agent,
      toolName: REVIEW_TOOL_NAME,
      reason: renderProposalReview(request),
      signal: this.lifetime.signal,
    })
    // Whether the ask even reached an answerer is knowable in this tick: a
    // precondition the approval service refuses (no open turn, a session that is
    // gone) rejects before it ever awaits, while a question put to a person only
    // resolves when they answer — which may be minutes later. The race below
    // reads exactly that difference, so "requested" means "an answerer is being
    // asked" and never "somebody might have been asked".
    let reached: ApprovalOutcome | 'pending'
    try {
      reached = await Promise.race([ask, Promise.resolve<'pending'>('pending')])
    } catch (error) {
      return {
        requested: false,
        detail:
          `the approval channel could not ask the owner session "${ownerSessionId}" (${message(error)}), so nobody was asked; ` +
          'the proposal stays pending_review',
      }
    }
    if (reached === 'pending') {
      // The answer is settled asynchronously by contract: the runtime asks from
      // inside its own per-parent serialization (§6), and holding that until a
      // person decides would stall admission and recovery for the whole parent.
      void ask
        .then(outcome => this.record(request, ownerSessionId, outcome))
        .catch(error => this.warn(
          `proposal ${request.proposal.proposalId}: the review request to session "${ownerSessionId}" ended without a usable answer ` +
          `(${message(error)}); the proposal keeps the status the store holds`,
        ))
      return {
        requested: true,
        detail:
          `the review was put to the owner session "${ownerSessionId}" through the approval channel; the proposal stays pending_review ` +
          'until the decision is recorded, and the runtime continues the batch when it is',
      }
    }
    // The answer was already there when this call returned (an answerer that
    // decides without a person). It is recorded the same way — never awaited
    // here, where the runtime may still be holding this parent's lock.
    if (reached === 'allowed-once' || reached === 'rejected') {
      void this.record(request, ownerSessionId, reached).catch(error => this.warn(
        `proposal ${request.proposal.proposalId}: the answer of session "${ownerSessionId}" could not be recorded (${message(error)}); ` +
        'the proposal keeps the status the store holds',
      ))
      return {
        requested: true,
        detail:
          `the owner session "${ownerSessionId}" answered the review with ${reached === 'allowed-once' ? 'approval' : 'a refusal'}; ` +
          'the decision is being recorded on the proposal',
      }
    }
    // Nobody decided: an absent answerer and a withdrawn question are states of
    // the ask, never a decision this channel may invent.
    return {
      requested: false,
      detail: reached === 'cancelled'
        ? 'the review request was withdrawn before a person decided, so no decision was recorded; the proposal stays pending_review'
        : 'no approval answerer was available, so nobody was asked; the proposal stays pending_review',
    }
  }

  /**
   * One human answer, turned into the only thing that can move a waiting
   * proposal: a decision on the record. An approval is recorded as `approved`
   * (the runtime then re-checks the batch and admits it); an explicit refusal as
   * `rejected`, naming who refused. Nothing else is written: `unavailable` and
   * `cancelled` are states of the ask, and §6 allows exactly one decision per
   * proposal — so a store that refuses this write because the proposal moved on
   * meanwhile is warned about, never retried into a second decision.
   */
  private async record(request: ProposalReviewRequest, ownerSessionId: string, outcome: ApprovalOutcome): Promise<void> {
    const proposalId = request.proposal.proposalId
    const decidedBy = reviewDecider(ownerSessionId)
    if (outcome === 'allowed-once') {
      const result = await this.runtime().decideProposal(request.storeId, proposalId, { outcome: 'approved' }, decidedBy)
      this.info(`proposal ${proposalId}: the owner session "${ownerSessionId}" approved the batch — ${result.detail}`)
      return
    }
    if (outcome === 'rejected') {
      const result = await this.runtime().decideProposal(request.storeId, proposalId, {
        outcome: 'rejected',
        reason: `the owner refused this batch through the approval channel (session "${ownerSessionId}")`,
      }, decidedBy)
      this.info(`proposal ${proposalId}: the owner session "${ownerSessionId}" refused the batch — ${result.detail}`)
    }
  }

  /** The live agent behind one session, or `undefined` — an absent registry or a departed session is a state, not a throw. */
  private liveAgent(sessionId: string): ReviewAgent | undefined {
    const holder = this.ctx as {
      get?: (name: string) => unknown
      agents?: { get?(id: string): ReviewAgent | undefined }
    }
    const registry = (typeof holder.get === 'function' ? holder.get('agents') : undefined) ??
      holder.agents
    try {
      return (registry as { get?(id: string): ReviewAgent | undefined } | undefined)?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Whether one session's approval policy asks a person at all. The policy is
   * the approval service's own (a session override, else the configured
   * default): under `never` the service answers `rejected` without dispatching
   * anything, so a request routed there would look like a human refusal.
   * Reading it before asking is what keeps that outcome from being invented.
   */
  private asksAPerson(agent: ReviewAgent): boolean {
    const service: ApprovalService | undefined = this.ctx.approval
    const policy = service?.overrideOf?.(agent.session) ?? service?.config?.policy ?? 'ask'
    return policy === 'ask'
  }

  /** The runtime that owns the store; resolved lazily, because the store is opened after this service is mounted. */
  private runtime(): TaskRuntime {
    return this.ctx.taskRuntime
  }

  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn(message: string): void {
    const logger = (this.ctx as { logger?: (name: string) => { warn(format: string): void } }).logger
    logger?.('proposal-review').warn(message)
  }

  /** The same seam at info level, for the trace of a decision that landed. */
  private info(message: string): void {
    const logger = (this.ctx as { logger?: (name: string) => { info(format: string): void } }).logger
    logger?.('proposal-review').info(message)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default ProposalReviewService

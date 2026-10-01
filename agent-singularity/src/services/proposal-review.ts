import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type {
  ProposalReviewChannel,
  ProposalReviewNotice,
  ProposalReviewRequest,
  TaskRuntime,
} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { ownerSessionOfStore } from '../coordination/identity.ts'
import { logOf } from '../log.ts'
import { message } from '../shared.ts'
import { renderProposalReview } from './proposal-render.ts'

/** The tool name a batch review's question is about: the decomposition the batch would become (audit and presentation). */
const BATCH_REVIEW_TOOL_NAME = 'task_decompose'

/** The tool name a root contract review's question is about: the intake that submitted the contract. */
const ROOT_REVIEW_TOOL_NAME = 'task_intake'

declare module '@deepseek-ai/cordis' {
  interface Context {
    proposalReviewChannel: ProposalReviewService
  }
}

/** The agent type the approval seam takes, without importing the agent package for a name. */
type ReviewAgent = Parameters<ApprovalService['request']>[0]['agent']

/** The decider identity the channel records: the approval surface of the owner session the review was shown in. */
export function reviewDecider(ownerSessionId: string): string {
  return `approval:${ownerSessionId}`
}

/** The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and records; */
export class ProposalReviewService extends Service implements ProposalReviewChannel {
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'proposalReviewChannel')
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
      toolName: request.kind === 'root' ? ROOT_REVIEW_TOOL_NAME : BATCH_REVIEW_TOOL_NAME,
      reason: renderProposalReview(request),
      signal: this.lifetime.signal,
    })
    // Whether the ask reached an answerer is knowable in this tick; a question put to a person resolves later, and this race
    // reads exactly that difference, so "requested" means "an answerer is being asked".
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
    return {
      requested: false,
      detail: reached === 'cancelled'
        ? 'the review request was withdrawn before a person decided, so no decision was recorded; the proposal stays pending_review'
        : 'no approval answerer was available, so nobody was asked; the proposal stays pending_review',
    }
  }

  /** One human answer, turned into the only thing that can move a waiting proposal: a decision on the record. An approval is recorded as `approved` (the runtime then re-checks the batch and admits it); an explicit refusal as */
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
    const registry = this.ctx.get('agents') as { get?(id: string): ReviewAgent | undefined } | undefined
    return registry?.get?.(sessionId)
  }

  /** Whether one session's approval policy asks a person at all. The policy is the approval service's own (a session override, else the configured default): under `never` the service answers `rejected` without dispatching */
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
    logOf(this.ctx, 'proposal-review')?.warn(message)
  }

  /** The same seam at info level, for the trace of a decision that landed. */
  private info(message: string): void {
    logOf(this.ctx, 'proposal-review')?.info(message)
  }
}

export default ProposalReviewService

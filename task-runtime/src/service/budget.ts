/**
 * Root budget: approval registration, extension judging and ceilings.
 */

import type { TaskRuntime } from './runtime.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  TaskBudgetExtension,
  TaskBudgetExtensionClaim,
  TaskBudgetExtensionIndex,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { budgetExtensionRequestDigest, describeBudgetExtension, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { message } from '../helpers.ts'
import { resolveRootBudget } from '../root-budget.ts'
import type { ResolvedRootBudget, RootBudgetCeilings } from '../root-budget.ts'
import { BUDGET_EXTENSION_REQUEST_FIELDS } from '../types.ts'
import type {
  RootBudgetExtensionRequest,
  RootBudgetExtensionHost,
  RootBudgetApproval,
  RootBudgetExtensionResult,
  BudgetExtensionJudgement,
} from '../types.ts'

function ceilingsOf(budget: ResolvedRootBudget): RootBudgetCeilings {
  return {
    ...(budget.maxRuns === undefined ? {} : { maxRuns: budget.maxRuns }),
  }
}

export function registerRootBudgetApproval(self: TaskRuntime, approval: RootBudgetApproval): () => void {
  self.rootBudgetApproval = approval
  return () => {
    if (self.rootBudgetApproval === approval) self.rootBudgetApproval = undefined
  }
}

export async function extendRootBudget(
  self: TaskRuntime,
  sessionId: string,
  host: RootBudgetExtensionHost,
  request: RootBudgetExtensionRequest,
): Promise<RootBudgetExtensionResult> {
  const callId = typeof host === 'object' && host !== null && typeof host.callId === 'string' ? host.callId : ''
  if (callId.length === 0) {
    throw new Error(
      `task-runtime: the budget of session "${sessionId}" was not extended: the host execution names no call ` +
        "(a non-empty `callId`, the host's own identity for the call this request's question is asked under); " +
        'the question is asked under the host’s call, and nothing else can address an answer to this request',
    )
  }
  /**
   * The request is the request and nothing else. A caller that carries a field
   * of the old relay is carrying what only a person's answer may supply — the
   */
  if (typeof request === 'object' && request !== null) {
    for (const key in request) {
      if (BUDGET_EXTENSION_REQUEST_FIELDS.includes(key)) continue
      throw new Error(
        `task-runtime: the budget of session "${sessionId}" was not extended: the request carries "${key}", which is not part of a budget-extension request ` +
          `(only ${BUDGET_EXTENSION_REQUEST_FIELDS.join(', ')} are read); a reading, a tool-call identity and an outcome are not a caller's to supply — ` +
          'this entry freezes the reading itself and asks the approval channel its deployment installed, so nothing a caller carries can go past the person',
      )
    }
  }
  const { storeId, snapshot, budget } = await budgetExtensionContext(self, sessionId)
  const requestKey = typeof request?.requestKey === 'string' ? request.requestKey : ''
  const existing = requestKey.length === 0 ? undefined : budgetExtensionIndex(snapshot).byRequestKey[requestKey]
  const judgement = judgeBudgetExtension(request, budget, existing)
  if (judgement.kind === 'refused') {
    throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: ${judgement.reason}`)
  }
  if (judgement.kind === 'recorded') {
    return { storeId, rootTaskId: budget.rootTaskId, answeredFromRecord: true, record: judgement.record }
  }
  /**
   * The one reading in force right now: frozen here, shown to the person, and
   * re-checked by the store's serial region when the claim arrives. It is what
   */
  const effective = ceilingsOf(budget)
  const runsUsed = snapshot.runs.length
  const approval = self.rootBudgetApproval
  if (approval === undefined) {
    throw new Error(
      `task-runtime: the budget of session "${sessionId}" was not extended: this deployment has no approval channel installed ` +
        '(no root budget approval was registered), and this entry never answers for a person (不能默许); ' +
        'install the approval that asks the person, or the ceiling stays where it is',
    )
  }
  const decision = await approval({
    storeId,
    rootTaskId: budget.rootTaskId,
    rootSessionId: sessionId,
    configured: budget.configured,
    effective,
    runsUsed,
    proposal: judgement.proposal,
    host,
  })
  if (decision.kind === 'refused') {
    const index = budgetExtensionIndex(await self.context.task.snapshotIn(storeId))
    const recorded = index.byRequestKey[judgement.proposal.requestKey]
    if (recorded !== undefined) {
      if (recorded.requestDigest === judgement.proposal.requestDigest) {
        return { storeId, rootTaskId: budget.rootTaskId, answeredFromRecord: true, record: recorded }
      }
      throw new Error(
        `task-runtime: the budget of session "${sessionId}" was not extended: ` +
          `request key "${judgement.proposal.requestKey}" is already bound to ${describeBudgetExtension(recorded)} (identity ${recorded.requestDigest}); ` +
          'one key names one request, and different totals under it are a new request under a new key',
      )
    }
    throw new Error(
      `task-runtime: the budget of session "${sessionId}" was not extended: the request was not approved (${decision.reason}); ` +
        'the ceilings are unchanged and no run started',
    )
  }
  const claim: TaskBudgetExtensionClaim = {
    ...judgement.proposal,
    /**
     * The reading the runtime froze, never one a caller handed back: it
     * travels with the claim because the store's own serial re-check re-runs
     */
    baseline: { ...effective },
    approvalRef: decision.reference,
    requestedBy: sessionId,
  }
  await self.context.task.recordBudgetExtensionIn(storeId, budget.rootTaskId, claim, sessionId)
  const stored = budgetExtensionIndex(await self.context.task.snapshotIn(storeId)).byRequestKey[claim.requestKey]
  if (stored === undefined) {
    throw new Error(
      `task-runtime: budget extension "${claim.requestKey}" was committed to store "${storeId}" but the store does not hold it; ` +
        'a committed extension is a durable fact, and this is not one',
    )
  }
  return { storeId, rootTaskId: budget.rootTaskId, answeredFromRecord: false, record: stored }
}

async function budgetExtensionContext(
  self: TaskRuntime,
  sessionId: string,
): Promise<{ storeId: string; snapshot: TaskSnapshot; budget: ResolvedRootBudget }> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('task-runtime: a budget extension needs the root session that asks: pass a non-empty session id')
  }
  let rootSessionId: string
  try {
    const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
    rootSessionId = graph.rootSessionId
  } catch (error) {
    throw new Error(
      `task-runtime: the budget of session "${sessionId}" cannot be extended: its graph could not be resolved ` +
        `(${message(error)}), so whether it is a graph's root coordination session cannot be established`,
    )
  }
  if (rootSessionId !== sessionId) {
    throw new Error(
      `task-runtime: session "${sessionId}" is not a root coordination session (its graph's root session is "${rootSessionId}"), so it cannot extend a tree's budget: ` +
        'a raise is a decision about the tree the root session accepted, and it is refused by name for a delegated worker, for a session of another graph, ' +
        'and for any session that is not the one its graph created',
    )
  }
  const storeId = rootTaskStoreId(sessionId)
  let snapshot: TaskSnapshot
  try {
    snapshot = await self.context.task.openStore(storeId)
  } catch (error) {
    throw new Error(
      `task-runtime: the budget of session "${sessionId}" cannot be read: store "${storeId}" is unavailable ` +
        `(${message(error)})`,
    )
  }
  const resolution = resolveRootBudget(snapshot, self.config.rootBudget ?? {})
  if (!resolution.ok) {
    throw new Error(`task-runtime: the budget of session "${sessionId}" cannot be extended: ${resolution.reason}`)
  }
  return { storeId, snapshot, budget: resolution }
}

export function budgetExtensionIndex(snapshot: TaskSnapshot): TaskBudgetExtensionIndex {
  const index = snapshot.budgetExtensions
  if (index === undefined) {
    throw new Error(
      `task-runtime: store "${snapshot.id}" carries no budget-extension index, so its approved ceilings cannot be read`,
    )
  }
  return index
}

function judgeBudgetExtension(
  request: RootBudgetExtensionRequest,
  budget: ResolvedRootBudget,
  existing: TaskBudgetExtension | undefined,
): BudgetExtensionJudgement {
  if (typeof request !== 'object' || request === null) {
    return { kind: 'refused', reason: 'the request is not an object with a request key and maxRuns' }
  }
  const requestKey = request.requestKey
  if (typeof requestKey !== 'string' || requestKey.length === 0) {
    return {
      kind: 'refused',
      reason:
        'the request needs a non-empty request key: it is how a retry after a restart is recognised as the same request',
    }
  }
  if (request.maxRuns === undefined) {
    return { kind: 'refused', reason: 'the request names no maxRuns ceiling to raise' }
  }
  if (!Number.isInteger(request.maxRuns) || request.maxRuns <= 0) {
    return {
      kind: 'refused',
      reason: `maxRuns ${JSON.stringify(request.maxRuns)} is not a positive whole number of runs; the approved value is the tree\u2019s whole run count, never an increment`,
    }
  }
  const proposalDigest = budgetExtensionRequestDigest({ requestKey, maxRuns: request.maxRuns })
  if (existing !== undefined) {
    if (existing.requestDigest === proposalDigest) return { kind: 'recorded', record: existing }
    return {
      kind: 'refused',
      reason:
        `request key "${requestKey}" is already bound to ${describeBudgetExtension(existing)} (identity ${existing.requestDigest}); ` +
        'one key names one request, and different totals under it are a new request under a new key',
    }
  }
  if (budget.maxRuns === undefined)
    return { kind: 'refused', reason: 'this tree sets no maxRuns ceiling, so there is nothing to raise' }
  if (request.maxRuns <= budget.maxRuns)
    return { kind: 'refused', reason: `maxRuns ${request.maxRuns} does not raise the ${budget.maxRuns} in force` }
  return {
    kind: 'proposed',
    proposal: {
      requestKey,
      requestDigest: proposalDigest,
      maxRuns: { previous: budget.maxRuns, next: request.maxRuns },
    },
  }
}

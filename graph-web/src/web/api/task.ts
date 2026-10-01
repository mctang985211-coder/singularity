import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ReviewRecord, TaskProposal, TaskService } from '@dangosys/dsh-singularity-task'
import type { TaskRuntime } from '@dangosys/dsh-singularity-task-runtime'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { RECOVERY_PATH, REVIEW_PATH, TASK_DECIDE_PATH, TASK_PATH } from '../../constants.ts'
import { fail, guardMethod, messageOf, queryOf, readJson, sendJson } from '../libs/http.ts'

/** The verifier entry this boundary reads a criterion log through. */
interface VerifierReader {
  logTail(logRef: string): Promise<string | undefined>
}

type ProposalDecision = 'approve' | 'reject' | 'continue' | 'cancel'

interface DecideBody {
  readonly storeId: string
  readonly proposalId: string
  readonly decision: ProposalDecision
  readonly reason?: string
}

const DECISIONS: readonly ProposalDecision[] = ['approve', 'reject', 'continue', 'cancel']

/** The console carries no session; a decision it records names the operator seat. */
const DECIDED_BY = 'operator'

/** The `storeId` query parameter, answered with the route's own refusal when it is missing. */
function storeIdOf(req: IncomingMessage, who: string, res: ServerResponse): string | undefined {
  try {
    return queryOf(req, 'storeId', who)
  } catch (error) {
    fail(res, error)
    return undefined
  }
}

/** The session a proposal belongs to: the one its continuation and withdrawal act on behalf of. */
function callerOf(proposal: TaskProposal): string {
  return proposal.kind === 'root' ? proposal.identity.rootSessionId : proposal.identity.callerSessionId
}

/** The one decision call a console action maps to, in the runtime's own signatures. */
async function decide(runtime: TaskRuntime, body: DecideBody): Promise<void> {
  if (body.decision === 'approve' || body.decision === 'reject') {
    await runtime.decideProposal(
      body.storeId,
      body.proposalId,
      {
        outcome: body.decision === 'approve' ? 'approved' : 'rejected',
        ...(body.reason === undefined || body.reason.length === 0 ? {} : { reason: body.reason }),
      },
      DECIDED_BY,
    )
    return
  }
  const proposal = await runtime.readProposal(body.storeId, body.proposalId)
  if (proposal === undefined) throw new Error(`task-runtime: store "${body.storeId}" holds no proposal "${body.proposalId}"`)
  const caller = callerOf(proposal)
  if (body.decision === 'continue') {
    await runtime.continueProposal(body.storeId, body.proposalId, caller)
    return
  }
  await runtime.cancelProposal(body.storeId, body.proposalId, caller)
}

export function registerTask(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: TASK_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      const storeId = storeIdOf(req, 'task', res)
      if (storeId === undefined) return
      const task = optionalService<TaskService>(ctx, 'task')
      if (task === undefined) {
        sendJson(res, 503, { error: 'task: this deployment mounts no task store' })
        return
      }
      try {
        sendJson(res, 200, { snapshot: await task.openStore(storeId) })
      } catch (error) {
        sendJson(res, 404, { error: messageOf(error) })
      }
    },
  })
}

export function registerProposalDecide(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: TASK_DECIDE_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'POST')) return
      let body: DecideBody
      try {
        body = await readJson<DecideBody>(req)
        if (typeof body.storeId !== 'string' || body.storeId.length === 0) throw new Error('decide: storeId required')
        if (typeof body.proposalId !== 'string' || body.proposalId.length === 0) {
          throw new Error('decide: proposalId required')
        }
        if (!DECISIONS.includes(body.decision)) throw new Error(`decide: unknown decision ${String(body.decision)}`)
        if (body.reason !== undefined && typeof body.reason !== 'string') throw new Error('decide: reason must be a string')
      } catch (error) {
        fail(res, error)
        return
      }
      const runtime = optionalService<TaskRuntime>(ctx, 'taskRuntime')
      if (runtime === undefined) {
        sendJson(res, 200, { ok: false, error: 'task-runtime: this deployment mounts no task runtime' })
        return
      }
      try {
        await decide(runtime, body)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: messageOf(error) })
      }
    },
  })
}

export function registerRecovery(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: RECOVERY_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      const storeId = storeIdOf(req, 'recovery', res)
      if (storeId === undefined) return
      const runtime = optionalService<TaskRuntime>(ctx, 'taskRuntime')
      if (runtime === undefined) {
        sendJson(res, 200, { recovery: null, reconcile: null })
        return
      }
      // The status is the store's own; the deferred work is only held by a live barrier in this process.
      const recovery = { ...(await runtime.recoveryStatus(storeId)), ...runtime.recoveryState(storeId) }
      sendJson(res, 200, { recovery, reconcile: null })
    },
  })
}

export function registerReview(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      let runId: string
      const storeId = storeIdOf(req, 'review', res)
      if (storeId === undefined) return
      try {
        runId = queryOf(req, 'runId', 'review')
      } catch (error) {
        fail(res, error)
        return
      }
      const task = optionalService<TaskService>(ctx, 'task')
      if (task === undefined) {
        sendJson(res, 503, { error: 'task: this deployment mounts no task store' })
        return
      }
      let reviews: readonly ReviewRecord[]
      try {
        reviews = (await task.openStore(storeId)).reviews
      } catch (error) {
        sendJson(res, 404, { error: messageOf(error) })
        return
      }
      const review = reviews.find(record => record.runId === runId)
      if (review === undefined) {
        sendJson(res, 200, { review: null, logTail: null })
        return
      }
      const verifier = optionalService<VerifierReader>(ctx, 'verifier')
      const logRef = (review.criteria ?? []).map(criterion => criterion.logRef).find(ref => ref !== undefined)
      let logTail: string | null = null
      if (verifier !== undefined && logRef !== undefined) {
        try {
          logTail = (await verifier.logTail(logRef)) ?? null
        } catch (error) {
          // A log the registry refuses is not the review record's fact to fail on.
          logTail = null
        }
      }
      sendJson(res, 200, { review, logTail })
    },
  })
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ReviewRecord, TaskService } from '@dangosys/dsh-singularity-task'
import type { TaskRuntime } from '@dangosys/dsh-singularity-task-runtime'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { RECOVERY_PATH, REVIEW_PATH, TASK_PATH } from '../../constants.ts'
import { fail, guardMethod, queryOf, sendJson } from '../libs/http.ts'

/** The verifier entry this boundary reads a criterion log through. */
interface VerifierReader {
  logTail(logRef: string): Promise<string | undefined>
}

/** The `storeId` query parameter, answered with the route's own refusal when it is missing. */
function storeIdOf(req: IncomingMessage, who: string, res: ServerResponse): string | undefined {
  try {
    return queryOf(req, 'storeId', who)
  } catch (error) {
    fail(res, error)
    return undefined
  }
}

/**
 * The task store this boundary reads, through the zero-write door: a store that
 * does not exist answers `exists:false` instead of being created by the read, so
 * a legacy graph's console never writes anything.
 */
async function snapshotOf(task: TaskService, storeId: string): Promise<unknown> {
  const read = await task.snapshotReadOnly(storeId)
  return read.exists ? read.snapshot : null
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
        sendJson(res, 503, { error: 'task: this deployment mounts no task store', source: 'task' })
        return
      }
      try {
        sendJson(res, 200, { snapshot: await snapshotOf(task, storeId) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
        sendJson(res, 503, { error: 'task: this deployment mounts no task store', source: 'task' })
        return
      }
      let reviews: readonly ReviewRecord[]
      try {
        const read = await task.snapshotReadOnly(storeId)
        reviews = read.exists ? read.snapshot.reviews : []
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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

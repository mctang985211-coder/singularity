import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
type RunState
} from '../../src/task/protocol.ts'
import { taskStateOf } from './apparatus.ts'
import { acceptanceSubject, reviewSubject } from './review.ts'
import { judgeAndRecord, type AcceptanceReview } from './submission.ts'

import type { DriverRuntime } from './driver-runtime.ts'
import type { ReleaseLifecycle } from './driver-release.ts'

export function createReviewLifecycle(runtime: DriverRuntime, taskSignal: (taskId: string) => AbortSignal,
  release: ReleaseLifecycle) {
  const { apparatus, options, registry } = runtime
  const acceptanceFor =
    (agent: Agent): AcceptanceReview =>
    async (taskId, run, checks) => {
      await release.validateChampion(taskStateOf(apparatus, taskId), agent, taskSignal(taskId))
      return reviewSubject(apparatus, options.seams, agent, `accept:${taskId}/${run.runId}`,
      await acceptanceSubject(apparatus, taskId, run, checks),
        taskSignal(taskId),
        run.revision,
        false,
      )
    }
  const restoreJudgement = async (taskId: string, run: RunState): Promise<boolean> => {
    const parent = registry().get(SessionId(taskStateOf(apparatus, taskId).responsibility!.agentId))
    if (parent === undefined) return false
    await judgeAndRecord(apparatus, taskId, run, taskSignal(taskId), acceptanceFor(parent))
    return true
  }
  return { acceptanceFor, restoreJudgement }
}
export type ReviewLifecycle = ReturnType<typeof createReviewLifecycle>

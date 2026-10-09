/**
 * Parent/child question coordination entries.
 */

import type { TaskRuntime } from './runtime.ts'
import type { TaskInstance, TaskRun } from '@dangosys/dsh-singularity-task'
import { message } from '../helpers.ts'
import { wakeUnclaimed } from './notify.ts'
import {
  answerParentQuestion,
  askParentQuestion,
  pendingQuestionMessages,
  type AnsweredQuestionOutcome,
  type AskedQuestionOutcome,
  type ParentAnswerCall,
  type ParentAskCall,
  type QuestionCaller,
  type QuestionCoordinationDeps,
  type QuestionReconcileReport,
} from '../question.ts'
import * as svcEnv from './env.ts'
import * as svcRootRecovery from './root-recovery.ts'

export async function askParentQuestionImpl(
  self: TaskRuntime,
  callerSessionId: string,
  request: ParentAskCall,
): Promise<AskedQuestionOutcome> {
  const caller = await questionCaller(self, callerSessionId, 'task_ask_parent')
  return await askParentQuestion(questionCoordination(self), caller, request)
}

export async function answerParentQuestionImpl(
  self: TaskRuntime,
  callerSessionId: string,
  request: ParentAnswerCall,
): Promise<AnsweredQuestionOutcome> {
  const caller = await questionCaller(self, callerSessionId, 'task_answer')
  /**
   * Nothing is settled here: what the answer changes is the *asking* run's own
   * block (recomputed by the question entry from the store) and its Session,
   */
  return await answerParentQuestion(questionCoordination(self), caller, request)
}

async function questionCaller(
  self: TaskRuntime,
  callerSessionId: string,
  entry: string,
): Promise<QuestionCaller> {
  if (svcEnv.agentOrUndefined(self, callerSessionId) === undefined) {
    throw new Error(
      `task-runtime: ${entry} needs a live caller session; "${callerSessionId}" has no live agent in this process, ` +
        "and the question identity comes from the live caller's own run",
    )
  }
  let binding: { storeId: string; task: TaskInstance; run: TaskRun }
  try {
    binding = await self.runForSession(callerSessionId)
  } catch (error) {
    throw new Error(`task-runtime: ${entry} refused: ${message(error)}`, {
      cause: error,
    })
  }
  await svcRootRecovery.assertRecoveryReady(self, binding.storeId, entry)
  return { sessionId: callerSessionId, storeId: binding.storeId, runId: binding.run.runId, actor: callerSessionId }
}

export function questionCoordination(self: TaskRuntime): QuestionCoordinationDeps {
  return {
    task: self.context.task,
    sessionQuery: self.context.sessionQuery,
    messages: self.context.agentRuntime,
    gate: self.executionGate,
  }
}

export async function wakeUnclaimedQuestionMessages(
  self: TaskRuntime,
  storeId: string,
  deliveries: readonly QuestionReconcileReport[],
): Promise<void> {
  const unread = new Set(
    deliveries.filter(delivery => delivery.status === 'already-present').map(delivery => delivery.messageId),
  )
  if (unread.size === 0) return
  const snapshot = await self.context.task.snapshotIn(storeId)
  const targets = new Map<string, string>()
  for (const message of pendingQuestionMessages(snapshot).messages) {
    if (unread.has(message.messageId)) targets.set(message.targetSessionId, message.messageId)
  }
  wakeUnclaimed(
    self,
    [...targets].map(([sessionId, messageId]) => ({ sessionId, messageId })),
    messageId =>
      `task-runtime: this session was brought back after a restart with coordination input it has not read (message "${messageId}" is still ` +
      'pending in its inbox); read it and act on it — the framework will not send a second copy',
  )
}

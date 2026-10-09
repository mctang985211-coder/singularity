/**
 * Notifications: terminal-review listeners, batch-result delivery and session jobs.
 */

import type { TaskRuntime } from './runtime.ts'
import { message } from '../helpers.ts'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentMessageIntent } from '@dangosys/dsh-singularity-agent-runtime'
import type { TaskRun } from '@dangosys/dsh-singularity-task'
import type { DrainResult, JobsView } from '../gate.ts'
import { deriveChildOutcomes } from '../orchestration/child.ts'
import { batchEndMessageId, batchEndMessageText } from '../orchestration/observe.ts'
import type { BatchResultDeliveryStatus, BatchResultMessage, TerminalReviewFact } from '../orchestration/types.ts'
import { drainSession } from '../gate.ts'
import * as svcEnv from './env.ts'
import * as svcDrivers from './drivers.ts'

export function registerTerminalReviewListener(
  self: TaskRuntime,
  listener: (fact: TerminalReviewFact) => void | Promise<void>,
): () => void {
  self.terminalReviewListeners.add(listener)
  return () => {
    self.terminalReviewListeners.delete(listener)
  }
}

export function notifyTerminalReview(self: TaskRuntime, fact: TerminalReviewFact): void {
  for (const listener of self.terminalReviewListeners) {
    try {
      const answer = listener(fact)
      if (answer !== undefined && typeof (answer as Promise<void>).then === 'function') {
        void (answer as Promise<void>).catch(error => {
          self.warn(
            `store ${fact.storeId}: a terminal-review listener failed after review ${fact.taskId}` +
              `${fact.runId === null ? '' : `#${fact.runId}`} [${fact.outcome}] (${message(error)})`,
          )
        })
      }
    } catch (error) {
      self.warn(
        `store ${fact.storeId}: a terminal-review listener failed after review ${fact.taskId}` +
          `${fact.runId === null ? '' : `#${fact.runId}`} [${fact.outcome}] (${message(error)})`,
      )
    }
  }
}

export function notify(self: TaskRuntime, sessionId: string, text: string): void {
  const agent = svcEnv.agentOrUndefined(self, sessionId) as { followup?: (message: unknown) => void } | undefined
  if (agent === undefined || typeof agent.followup !== 'function') return
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'task-runtime', form: 'notice', summary: boundContextSummary(text) },
    }),
  )
}

export function notifyWhenReady(self: TaskRuntime, sessionId: string, text: string): void {
  const storeId = self.sessions.get(sessionId)?.storeId
  const barrier = storeId === undefined ? undefined : self.storeRecovery.get(storeId)
  if (barrier !== undefined && barrier.status === 'recovering' && barrier.cancelled !== true) {
    barrier.pendingNotices.push({ sessionId, text })
    return
  }
  notify(self, sessionId, text)
}

/** Queue one owner notice without waking the session: a blocked run reads it in the request the answer's wake opens. */
export function appendNotice(self: TaskRuntime, sessionId: string, text: string): void {
  const agent = svcEnv.agentOrUndefined(self, sessionId)
  if (agent === undefined) return
  agent.inbox.append(
    'next-turn',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'task-runtime', form: 'notice', summary: boundContextSummary(text) },
    }),
  )
}

export async function deliverBatchResult(
  self: TaskRuntime,
  result: BatchResultMessage,
): Promise<BatchResultDeliveryStatus> {
  const barrier = self.storeRecovery.get(result.storeId)
  if (barrier !== undefined && barrier.status === 'recovering' && barrier.cancelled !== true) {
    barrier.pendingBatchResults.push(result)
    return 'unavailable'
  }
  return await deliverBatchResultNow(self, result)
}

export async function deliverBatchResultNow(
  self: TaskRuntime,
  result: BatchResultMessage,
): Promise<BatchResultDeliveryStatus> {
  let run: TaskRun
  try {
    run = await self.context.task.runIn(result.storeId, result.runId)
  } catch (error) {
    self.warn(
      `store ${result.storeId}: whether run "${result.runId}" is still running could not be read before the end-of-batch message for ` +
        `"${result.batchId}" was delivered (${message(error)}); nothing was delivered and the next activation retries`,
    )
    return 'unavailable'
  }
  if (run.status !== 'running') return 'skipped'
  // Read structurally: a deployment (or a test context) may mount no relay at
  // all, which is a deployment that cannot deliver — not a defect of the batch.
  const relay = self.context.agentRuntime as unknown as
    { ensureAgentMessageDelivered?: (intent: AgentMessageIntent) => Promise<{ status: string }> } | undefined
  if (typeof relay?.ensureAgentMessageDelivered !== 'function') {
    self.warn(
      `store ${result.storeId}: batch "${result.batchId}" ended with no message relay in this deployment; run "${result.runId}" was handed back active and its Session was not told`,
    )
    return 'unavailable'
  }
  try {
    const delivery = await relay.ensureAgentMessageDelivered({
      targetSessionId: SessionId(result.sessionId),
      senderSessionId: SessionId(result.sessionId),
      messageId: result.messageId,
      text: result.text,
    })
    if (delivery.status === 'delivered' || delivery.status === 'already-present') return delivery.status
    self.warn(
      `store ${result.storeId}: the end-of-batch message for "${result.batchId}" was not delivered to session ${result.sessionId} (${delivery.status}); the batch's facts stand and the next activation retries the delivery`,
    )
    return delivery.status === 'unavailable' ? 'unavailable' : 'refused'
  } catch (error) {
    self.warn(
      `store ${result.storeId}: the end-of-batch message for "${result.batchId}" could not be delivered (${message(error)})`,
    )
    return 'refused'
  }
}

export async function redeliverBatchResult(
  self: TaskRuntime,
  storeId: string,
  batchId: string,
): Promise<BatchResultDeliveryStatus> {
  const found = await svcDrivers.batchRecordIn(self, storeId, batchId)
  if (found === undefined) {
    throw new Error(
      `task-runtime: batch "${batchId}" is not recorded in store "${storeId}"; there is nothing to re-deliver`,
    )
  }
  const outcomes = await deriveChildOutcomes(self.context.task, storeId, found.taskId, found.memberTaskIds)
  return await deliverBatchResult(self, {
    storeId,
    runId: found.run.runId,
    batchId,
    sessionId: found.run.sessionId,
    messageId: batchEndMessageId(batchId),
    text: batchEndMessageText(batchId, outcomes),
  })
}

export async function reconcileSessionJobs(self: TaskRuntime, sessionId: string): Promise<void> {
  const jobs = self.softService<JobsView>('jobs')
  const agent = svcEnv.agentOrUndefined(self, sessionId)
  if (jobs === undefined || agent === undefined) return
  const drained: DrainResult = await drainSession(self.executionGate, sessionId, {
    timeoutMs: self.config.writeDrainTimeoutMs,
    jobs,
    agent,
  })
  if (!drained.confirmed) {
    self.warn(`session ${sessionId}: managed work was not confirmed stopped: ${drained.pending.join('; ')}`)
  }
}

/** Wake every session that still holds its unread message, with this site's own text. */
export function wakeUnclaimed(
  self: TaskRuntime,
  entries: readonly { sessionId: string; messageId: string }[],
  text: (messageId: string) => string,
): void {
  for (const { sessionId, messageId } of entries) {
    if (!sessionHoldsPendingMessage(self, sessionId, messageId)) continue
    notify(self, sessionId, text(messageId))
  }
}

export function wakeUnclaimedBatchResults(
  self: TaskRuntime,
  unread: readonly { sessionId: string; messageId: string }[],
): void {
  wakeUnclaimed(
    self,
    unread,
    messageId =>
      `task-runtime: this session was brought back after a restart with the result of a child batch it has not read (message "${messageId}" ` +
      'is still pending in its inbox); read it and act on it — the framework will not send a second copy',
  )
}

export function sessionHoldsPendingMessage(self: TaskRuntime, sessionId: string, messageId: string): boolean {
  const agent = svcEnv.agentOrUndefined(self, sessionId) as
    { inbox?: { nextTurn?: readonly { id?: unknown }[]; nextStep?: readonly { id?: unknown }[] } } | undefined
  const inbox = agent?.inbox
  if (inbox === undefined) return false
  return [...(inbox.nextTurn ?? []), ...(inbox.nextStep ?? [])].some(message => String(message.id) === messageId)
}

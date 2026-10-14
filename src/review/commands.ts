import type { ControlSessionStore } from '../control/session-store.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../agent/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../task/protocol.ts'
import { refuse } from '../protocol/refusal.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun, type Finding } from './protocol.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { assertParentage, childSettled, projectPlan } from '../task/tree.ts'
import type { DecompositionChild } from '../task/decomposition.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../environment/protocol.ts'
import { digestOf } from '../protocol/envelope.ts'

export function createReviewCommands(store: ControlSessionStore) {
  return {
    start: (commandId: string, reviewId: string, input: Omit<ReviewRun, 'reviewId' | 'status' | 'children'>) =>
      store.emit(
        {
          commandId,
          protocol: REVIEW_PROTOCOL,
          version: REVIEW_VERSION,
          kind: 'review/started',
          subject: reviewId,
          payload: input,
        },
        () => {
          const cut = store.load()
          assertPinnedRevision(
            input.method,
            cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
            'review method',
          )
          const agent = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, input.agentId)
          if (agent?.sessionId !== input.sessionId || store.identityOf(`agent:${input.agentId}`) !== input.identity)
            refuse('unknown-emitter-role', 'review requires an exact opened agent identity')
          if (input.target.kind === 'acceptance') {
            const task = cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, input.target.taskId)
            const run = task?.runs[input.target.runId]
            if (
              run?.stage !== 'submitted' ||
              task!.contractDigest !== input.target.contractDigest ||
              run.submission!.artifactDigest !== input.target.artifactDigest ||
              digestOf(task!.contract!.criteria) !== digestOf(input.criteria)
            )
              refuse('evidence-input-mismatch', 'review must bind the exact sealed Task submission and criteria')
            if (run.actor === input.identity || task!.responsibility!.agentId === input.agentId)
              refuse('self-reported-evidence', 'the executor cannot review its submission')
          }
        },
      ),
    decompose: (commandId: string, reviewId: string, children: readonly DecompositionChild[], as: string) =>
      store.emit({ commandId, protocol: REVIEW_PROTOCOL, version: REVIEW_VERSION,
        kind: 'review/decomposed', subject: reviewId, payload: { children }, as }, () => {
        const cut = store.load(), review = cut.stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!
        const tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
        if (!projectPlan(reviewId, review.criteria, review.children, tasks).children.every(childSettled))
          refuse('illegal-transition', 'delegated review responsibilities are pending')
        assertParentage(reviewId, children, tasks, [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()]
          .map((held) => ({ parentId: held.reviewId, children: held.children })))
      }),
    complete: (
      commandId: string,
      reviewId: string,
      findings: readonly Finding[],
      result: FileAttachmentRef,
      as: string,
    ) =>
      store.emit(
        {
          commandId,
          protocol: REVIEW_PROTOCOL,
          version: REVIEW_VERSION,
          kind: 'review/completed',
          subject: reviewId,
          payload: { findings, result },
          as,
        },
        () => {
          const review = store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!
          const tasks = store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
          if (!projectPlan(review.reviewId, review.criteria, review.children, tasks).children.every(childSettled))
            refuse('illegal-transition', 'review evidence tasks have not settled')
        },
      ),
    fail: (commandId: string, reviewId: string, reason: string) =>
      store.emit({
        commandId,
        protocol: REVIEW_PROTOCOL,
        version: REVIEW_VERSION,
        kind: 'review/failed',
        subject: reviewId,
        payload: { reason },
      }),
  }
}

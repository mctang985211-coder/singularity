/**
 * `task_answer` (A4 §F.1): the tool half of "a parent answers the child that
 * asked it" — the schema the model writes, the caller's own identity, and the
 * rendering of one `AnsweredQuestionOutcome`.
 *
 * What the answer is, and what it is not:
 *
 * - **It is a declaration, not a classification.** `resolves: true` says the
 *   question is settled and releases exactly that one block on the asking run;
 *   `resolves: false` keeps it open and records the parent's words as an answer
 *   that settled nothing. No parameter carries a category, and nothing is
 *   inferred from the text.
 * - **It is not an authorization.** Answering changes no contract, no permission
 *   and no task state: the write gate recomputes the asking run's block from the
 *   store's question facts, so a second open question keeps it blocked.
 * - **It carries no recipient.** The message goes to the run that asked the
 *   question named by `questionId`; the answering run must be the run the
 *   question was addressed to, and the store refuses any other — including a new
 *   run of a restarted task.
 *
 * The body is read back from this call's own `tool/call` event in the answering
 * Session, so the recorded citation is always the message the model actually
 * wrote. Refusals are rendered rather than thrown, except a call with no agent
 * identity, which has no protocol to speak from.
 * @module dsh-singularity-agent/tools/task-answer
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AnsweredQuestionOutcome } from '@dangosys/dsh-singularity-task-runtime'
import { questionCall } from './question-call.ts'

type Delivery = AnsweredQuestionOutcome['delivery']

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** Every parameter this tool declares; anything else is refused by name, before the store is touched. */
const DECLARED = ['questionId', 'requestKey', 'answer', 'resolves'] as const

/**
 * Refuse a call carrying a key this tool does not declare: the asking run is the
 * question's own child run, and there is no argument here that could address a
 * message, grant a permission or classify the answer.
 */
function undeclared(args: Record<string, unknown>): string | undefined {
  const extra = Object.keys(args).filter(key => !(DECLARED as readonly string[]).includes(key))
  if (extra.length === 0) return undefined
  return [
    `task_answer rejected: undeclared parameter${extra.length === 1 ? '' : 's'} ${extra.map(key => `"${key}"`).join(', ')} —`,
    `this tool accepts ${DECLARED.join(', ')} and has no argument that names a recipient, an authorization or a category:`,
    'the answer goes to the run that asked the question you name. Nothing was answered and nothing was sent.',
  ].join(' ')
}

/** How one delivery settled, in the answering model's words — `unavailable` is a retry, never a re-send under a new key. */
function deliveryText(delivery: Delivery): string {
  switch (delivery.status) {
    case 'delivered':
      return `message ${delivery.messageId} is in the asking run's session`
    case 'already-present':
      return `message ${delivery.messageId} was already in the asking run's session, so nothing was sent twice`
    case 'unavailable':
      return (
        `message ${delivery.messageId} is not delivered yet: the asking run's session is not live in this process. ` +
        'Your answer is on the record and recovery delivers that same identity — do not answer the same question again under a ' +
        'new request key'
      )
    case 'refused':
      return (
        `message ${delivery.messageId} could not be delivered (${delivery.reason ?? 'the attempt could not be settled'}). ` +
        'Your answer is on the record; delivery is retried from there'
      )
  }
}

/** One answer as its reply: what was recorded, how it was delivered, and what it did to the asking run. */
function answeredText(outcome: AnsweredQuestionOutcome): string {
  const answer = outcome.answer
  const lines = [
    `task_answer: answer ${answer.answerId} recorded for question ${answer.questionId}; ` +
    `${deliveryText(outcome.delivery)}.`,
  ]
  if (!outcome.created) {
    lines.push('This is the answer the same request key already recorded: nothing was written a second time and the same identity stands.')
  }
  lines.push(
    answer.resolves
      ? '`resolves: true` releases exactly that question: the asking run\'s block is recomputed from the store, so another ' +
        'question of its own keeps it blocked. It changes no contract, no permission and no task state, and the framework does ' +
        'not vouch for what the answer says.'
      : '`resolves: false` keeps the question open: the asking run stays blocked on it and your words are recorded as an answer ' +
        'that settled nothing. Answer it again with `resolves: true` once it is settled.',
  )
  lines.push('Your words reach the asking run as a message in its session and in its context, under the identity recorded here.')
  return lines.join('\n')
}

export function defineTaskAnswerTool(ctx: Context) {
  return defineTool({
    name: 'task_answer',
    description:
      'Answer one question a child run asked you. `questionId` is the identity on the question you were told about (in your ' +
      'context under the pending questions, or in the message that reached you) — you cannot address an answer anywhere else, ' +
      'and an answer to a question that was not asked of your run is refused. `resolves: true` declares the question settled ' +
      'and releases exactly that block on the asking run; `resolves: false` keeps it open and records words that settle ' +
      'nothing. Neither changes the asking run\'s contract, permissions or task state, and neither is a judgement of the ' +
      'answer\'s correctness — say what you decided and what it rests on, because the child acts on your words. `requestKey` ' +
      'is your own stable key for this answer: answer a question you have already answered by repeating the same key instead ' +
      'of inventing one, and it comes back as the answer already recorded.',
    parameters: {
      questionId: {
        type: 'string',
        required: true,
        description: 'The question being answered, exactly as the question or the record names it (`q-…`); it must be the question this call\'s own arguments name, and it must be a question addressed to your run',
      },
      requestKey: {
        type: 'string',
        required: true,
        description: 'Your own stable key for this answer, e.g. "contract-holds". The recorded answer id derives from it; several keys may answer one open question, and a repeat of the same key is the answer already on the record',
      },
      answer: {
        type: 'string',
        required: true,
        description: 'What you are telling the child, in your own words. This text is the body the store cites, read back from this call itself — the child reads exactly these words',
      },
      resolves: {
        type: 'boolean',
        required: true,
        description: 'Your declaration: `true` settles this question and releases the asking run\'s block on it; `false` keeps it open. Required — there is no default, because silence about whether the question is settled is not an answer',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec: ToolRunContext) => {
      const refused = undeclared(args)
      if (refused !== undefined) return refused
      const { caller, callId } = questionCall(exec, 'task_answer')
      let outcome: AnsweredQuestionOutcome
      try {
        outcome = await ctx.taskRuntime.answerParentQuestion(caller, {
          callId,
          questionId: args.questionId,
          requestKey: args.requestKey,
          resolves: args.resolves,
        })
      } catch (error) {
        return `task_answer rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      return answeredText(outcome)
    },
  })
}

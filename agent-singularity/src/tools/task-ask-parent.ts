/** `task_ask_parent` (A4 §F.1): the tool half of "a worker asks its direct parent" — the schema the model writes, the caller's own identity, and the rendering of one `AskedQuestionOutcome`. @module dsh-singularity-agent/tools/task-ask-parent */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AskedQuestionOutcome } from '@dangosys/dsh-singularity-task-runtime'
import { message, questionCall, text, undeclaredParameters } from '../shared.ts'

type Delivery = AskedQuestionOutcome['delivery']

/** Every parameter this tool declares; anything else is refused by name, before the store is touched. */
const DECLARED = ['requestKey', 'question', 'blocking'] as const

/** How one delivery settled, in the caller's words. `unavailable` is not a failure and is not reported as one: */
function deliveryText(delivery: Delivery): string {
  switch (delivery.status) {
    case 'delivered':
      return `message ${delivery.messageId} is in your parent's session`
    case 'already-present':
      return `message ${delivery.messageId} was already in your parent's session, so nothing was sent twice`
    case 'unavailable':
      return (
        `message ${delivery.messageId} is not delivered yet: your parent's session is not live in this process. ` +
        'The question is on the record and recovery delivers that same identity when the parent is back — do not ask the same ' +
        'question again under a new request key'
      )
    case 'refused':
      return (
        `message ${delivery.messageId} could not be delivered (${delivery.reason ?? 'the attempt could not be settled'}). ` +
        'The question is on the record; delivery is retried from there, and a new request key would only add a second question'
      )
  }
}

/** One ask as its answer: what was recorded, how it was delivered, and what the asking run may do now. */
function askedText(outcome: AskedQuestionOutcome): string {
  const question = outcome.question
  const lines = [
    `task_ask_parent: question ${question.questionId} recorded for your direct parent (run ${question.parentRunId}); ` +
    `${deliveryText(outcome.delivery)}.`,
  ]
  if (!outcome.created) {
    lines.push(
      'This is the question the same request key already recorded, word for word: nothing was written a second time and the ' +
      'same identity stands. Do not re-send it under a new key.',
    )
  }
  if (question.blocking) {
    lines.push(
      'This run is now blocked on that answer: writes, shell commands, another decomposition and `task_submit_result` are ' +
      'refused until an answer with `resolves: true` is recorded — a child batch of this run ending does not lift the block, ' +
      'because nothing answers a question on your behalf. Stop the work that would write and end this step — an idle ' +
      'run waiting on this question gets no submission reminder.',
    )
    lines.push(
      'The answer arrives as a message in this session and in your context, where the question stays while it is open; read it ' +
      'before you continue, and keep to what it says.',
    )
  } else {
    lines.push(
      'This run is not blocked: it may carry on working while the answer is pending, so it may pass you later in this session ' +
      'or in your context — do not treat the silence as an answer.',
    )
  }
  return lines.join('\n')
}

export function defineTaskAskParentTool(ctx: Context) {
  return defineTool({
    name: 'task_ask_parent',
    description:
      'Ask your direct parent one question and stop guessing. The addressee is fixed by your own run — its task\'s direct ' +
      'parent — and you cannot name one: there is no recipient parameter, and a call carrying an undeclared one is refused. ' +
      'By default the question blocks this run (`blocking` defaults to `true`): writes, shell commands, another decomposition ' +
      'and `task_submit_result` are refused until the parent answers with `resolves: true` — a batch of yours ending does not lift ' +
      'that block, because nothing answers a question on your behalf — and the answer then reaches you as ' +
      'a message and in your context. Pass `blocking: false` for a question you can work without. Ask when the contract, the ' +
      'scope or the acceptance is genuinely undecidable from what you were given — not for facts `task_read`/`task_status`/' +
      '`context_read` already answer, and not to hand back work you could decide yourself. `requestKey` is your stable key for ' +
      'this question: resend the identical question under the same key after a failure instead of inventing a new one, and it ' +
      'comes back as the question already recorded.',
    parameters: {
      requestKey: {
        type: 'string',
        required: true,
        description: 'Your own stable key for this question, e.g. "which-contract-holds". The recorded question id derives from it, and a resend under the same key with the same words is answered as the question already on the record',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The question, in your own words. This text is the body the store cites and the parent reads — it is read back from this call itself, so what you write here is what is recorded',
      },
      blocking: {
        type: 'boolean',
        description: 'Whether this run waits for the answer: true (the default) closes writes, shell commands, another decomposition and submission until an answer resolves it, and a batch of yours ending does not resolve it; false leaves this run deciding its own work while the answer is pending',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec: ToolRunContext) => {
      const refused = undeclaredParameters(
        args,
        DECLARED,
        'task_ask_parent',
        'and has no argument that names a recipient, a parent or an authorization: the question goes to your own task\'s direct parent, resolved from your run',
        'Nothing was asked and nothing was sent.',
      )
      if (refused !== undefined) return refused
      const { caller, callId } = questionCall(exec, 'task_ask_parent')
      let outcome: AskedQuestionOutcome
      try {
        outcome = await ctx.taskRuntime.askParentQuestion(caller, {
          callId,
          requestKey: args.requestKey,
          // The declaration is the call's own: the runtime re-reads it from this
          // call's arguments, and absent stays absent so the protocol's own
          ...(args.blocking === undefined ? {} : { blocking: args.blocking }),
        })
      } catch (error) {
        return `task_ask_parent rejected: ${message(error)}`
      }
      return askedText(outcome)
    },
  })
}

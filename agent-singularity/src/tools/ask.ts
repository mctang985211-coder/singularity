import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-questions'

const text = (value: string) => [{ type: 'text' as const, text: value }]

const QUESTION_ID = 'hitl-ask'

export function defineAskTool(ctx: Context) {
  return defineTool({
    name: 'hitl_ask',
    description:
      'Ask the human a text question and wait for the answer. Use for environment setup or decisions that need human input.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Question shown to the human' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      if (args.prompt.trim().length === 0) throw new Error('hitl_ask: prompt is empty')
      const answer = await ctx.userQuestions.ask({
        questions: [{ id: QUESTION_ID, question: args.prompt }],
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      const item = answer.answers.find(entry => entry.id === QUESTION_ID)
      return item?.custom ?? item?.selected.join(', ') ?? ''
    },
  })
}

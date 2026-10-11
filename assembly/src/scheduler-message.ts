import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

export interface SchedulerMessageSource {
  readonly kind: 'singularity'
  readonly purpose: 'dispatch' | 'plan-outcome'
  readonly controlId: string
  readonly parentTaskId: string
  readonly taskId: string
  readonly runId: string
  readonly factSeq: number
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { singularity: SchedulerMessageSource }
}

export function schedulerMessage(source: SchedulerMessageSource, text: string): UserMessage {
  return createUserMessage({ source, content: [{ type: 'text', text }] })
}

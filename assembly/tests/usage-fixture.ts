import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Native Assistant settlements consumed by token-meter's session projection. */
export function nativeTurn(tokens: number | undefined, start = 0, turn = 1): SessionEvent[] {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    { type: 'assistant/message', data: { turn, step: 1, stream: [],
      message: { role: 'assistant', content: [], source: { provider: 'test', model: 'test' } },
      ...(tokens === undefined ? {} : { usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens } }),
    } },
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ].map((event, index) => ({ ...event, seq: start + index, time: index })) as unknown as SessionEvent[]
}

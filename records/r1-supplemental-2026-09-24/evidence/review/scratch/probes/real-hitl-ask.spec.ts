/**
 * Reviewer's independent check of the V1 wiring fix (task 3).
 *
 * Two decisive properties, both executed against the real stack with only the
 * model output scripted:
 *  1. the registered `hitl_ask` is the production `defineAskTool` — it carries
 *     that tool's own argument guard and never reaches the human seam when the
 *     prompt is empty (a stand-in returns `hitl_ask: fixture answer` instead);
 *  2. the real tool drives the real `userQuestions` seam: the desk record the
 *     stack captures carries the real tool's question id `hitl-ask` and the
 *     prompt verbatim, the tool result is the fixture answer verbatim, and the
 *     session's own JSONL holds it as the `tool/result` the loop fed the model.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startR1Stack } from '../../../../driver/r1-stack.ts'
import { FIXED_ANSWER, QUESTION, USER_MESSAGE } from './records.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function prepare(name: string): { home: string; repo: string; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), `r1-review-${name}-`))
  const repo = join(workspace, 'repo')
  const home = join(workspace, 'dsh-home')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, 'skills'), { recursive: true })
  return { home, repo, workspace }
}

const desk = (seam: string, asked: unknown): unknown => {
  if (seam === 'approval') return 'allowed-once'
  const request = asked as { questions?: readonly { id?: string }[] }
  return { answers: (request.questions ?? []).map(question => ({ id: String(question.id ?? 'q'), selected: [], custom: FIXED_ANSWER })) }
}

async function waitForAsk(stack: { toolCalls(): readonly { name?: string; resultText?: string }[] }, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !stack.toolCalls().some(call => call.name === 'hitl_ask' && call.resultText !== undefined)) await sleep(50)
}

describe('reviewer: the real hitl_ask tool through the real userQuestions seam', () => {
  it('is the production tool: its own empty-prompt guard fires and no desk record is written', async () => {
    const { home, repo, workspace } = prepare('real-ask-guard')
    const stack = await startR1Stack({
      scenario: 'reviewer-real-ask-guard',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: desk,
      script: () => [{ tool: 'hitl_ask', args: { prompt: '   ' } }, { text: 'probe done' }],
    })
    try {
      stack.userSays(USER_MESSAGE)
      await waitForAsk(stack)
      const call = (stack.toolCalls() as readonly { name?: string; isError?: boolean; resultText?: string }[]).find(item => item.name === 'hitl_ask')
      console.log(`guard probe: isError=${String(call?.isError)} resultText=${JSON.stringify(call?.resultText)} deskRecords=${stack.humanQuestions().length}`)
      expect(call, 'the scripted call reached the registry').toBeDefined()
      expect(call!.isError).toBe(true)
      expect(call!.resultText).toContain('hitl_ask: prompt is empty')
      expect(stack.humanQuestions().filter(record => record.seam === 'userQuestions')).toEqual([])
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 120_000)

  it('carries the fixed answer verbatim from the real seam into the session JSONL', async () => {
    const { home, repo, workspace } = prepare('real-ask-chain')
    const stack = await startR1Stack({
      scenario: 'reviewer-real-ask-chain',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: desk,
      script: () => [{ tool: 'hitl_ask', args: { prompt: QUESTION } }, { text: 'probe done' }],
    })
    try {
      stack.userSays(USER_MESSAGE)
      await waitForAsk(stack)
      const calls = stack.toolCalls() as readonly { name?: string; callId?: string; isError?: boolean; resultText?: string }[]
      const call = calls.find(item => item.name === 'hitl_ask')!
      const deskRecord = stack.humanQuestions().find(record => record.seam === 'userQuestions')
      const logBytes = stack.logBytes(String(stack.rootSessionId))
      console.log(`chain probe: callId=${String(call.callId)} resultText=${JSON.stringify(call.resultText)}`)
      console.log(`desk: ${JSON.stringify(deskRecord)}`)
      console.log(`session log tool/result line: ${logBytes.split('\n').filter(line => line.includes('tool/result')).join(' | ').slice(0, 400)}`)
      expect(call.isError).toBe(false)
      expect(call.resultText).toBe(FIXED_ANSWER)
      expect(deskRecord?.questions[0]).toEqual({ id: 'hitl-ask', question: QUESTION })
      expect(deskRecord?.answers[0]).toEqual({ id: 'hitl-ask', text: FIXED_ANSWER })
      expect(logBytes).toContain(FIXED_ANSWER)
      expect(logBytes).toContain(String(call.callId))
      expect(stack.recordErrors()).toEqual([])
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 120_000)
})

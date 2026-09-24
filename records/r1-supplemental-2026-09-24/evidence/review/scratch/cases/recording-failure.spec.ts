/**
 * Reviewer's execution of the V1 load-bearing claim: a *recording* failure must
 * not change or swallow the product path.
 *
 * The stack under test is a scratch copy (`scratch/v1-copy/`) of the four stack
 * modules with exactly one throw injected as the first statement of
 * `answerHuman`'s recording block (see `results/v1-copy.diff`); the real
 * `driver/` files are untouched. Expected, and asserted below: the `hitl_ask`
 * call still succeeds and returns the fixed answer, the failure is kept as a
 * `recordErrors` fact instead of an answer, and the session JSONL still carries
 * the answer as the tool result the model consumed.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startR1Stack } from '../v1-copy/r1-stack.ts'
import { decideS3 } from '../../../../driver/s3-criteria.ts'
import type { S3EvidenceRecord } from '../../../../driver/s3-criteria.ts'
import { FIXED_ANSWER, QUESTION, USER_MESSAGE } from '../probes/records.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('reviewer: an injected recording failure cannot reach the product path', () => {
  it('keeps the answer, records the failure as a fact, and leaves the session log intact', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'r1-review-recording-failure-'))
    const repo = join(workspace, 'repo')
    const home = join(workspace, 'dsh-home')
    mkdirSync(repo, { recursive: true })
    mkdirSync(join(home, 'skills'), { recursive: true })
    const stack = await startR1Stack({
      scenario: 'reviewer-recording-failure',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: (seam, asked) => {
        if (seam === 'approval') return 'allowed-once'
        const request = asked as { questions?: readonly { id?: string }[] }
        return { answers: (request.questions ?? []).map(question => ({ id: String(question.id ?? 'q'), selected: [], custom: FIXED_ANSWER })) }
      },
      script: () => [{ tool: 'hitl_ask', args: { prompt: QUESTION } }, { text: 'probe done' }],
    })
    try {
      stack.userSays(USER_MESSAGE)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !(stack.toolCalls() as readonly { name?: string; resultText?: string }[]).some(call => call.name === 'hitl_ask' && call.resultText !== undefined)) await sleep(50)

      const calls = stack.toolCalls() as readonly { name?: string; callId?: string; isError?: boolean; resultText?: string }[]
      const call = calls.find(item => item.name === 'hitl_ask')!
      const clarification = stack.clarifications()[0]
      const logBytes = stack.logBytes(String(stack.rootSessionId))
      const recordErrors = stack.recordErrors()
      console.log(`recording-failure probe: isError=${String(call.isError)} resultText=${JSON.stringify(call.resultText)}`)
      console.log(`recordErrors=${JSON.stringify(recordErrors)}`)
      console.log(`desk=${JSON.stringify(clarification?.desk)} delivered=${JSON.stringify(clarification?.delivered)}`)
      console.log(`humanQuestions recorded: ${stack.humanQuestions().length}`)
      console.log(`session log carries the answer: ${logBytes.includes(FIXED_ANSWER)}`)

      // The product path is intact: the tool succeeded and the model got the answer.
      expect(call.isError).toBe(false)
      expect(call.resultText).toBe(FIXED_ANSWER)
      expect(logBytes).toContain(FIXED_ANSWER)
      expect(stack.humanQuestions()).toEqual([])
      // The failure is a recorded fact, not an answer, and not a broken call.
      expect(recordErrors.length).toBe(1)
      expect(recordErrors[0]).toContain('injected recording failure')
      expect(clarification?.desk).toBeNull()
      expect(clarification?.delivered?.text).toBe(FIXED_ANSWER)

      // And the frozen criteria still see the chain as broken rather than passing it.
      // (The scripted run never intakes a contract, so the record is assembled from
      // the stack's own surfaces rather than through `buildScenarioRecord`.)
      const record: S3EvidenceRecord = {
        ids: { rootSessionId: String(stack.rootSessionId) },
        input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
        toolCalls: stack.toolCalls() as never,
        humanQuestions: stack.humanQuestions() as never,
        clarifications: stack.clarifications() as never,
        sessionLogs: { [String(stack.rootSessionId)]: logBytes },
        events: [],
      }
      const decision = decideS3({ record, adjudication: null, sessionLogs: record.sessionLogs })
      console.log(`criteria chain status: ${JSON.stringify(decision.facts.chains)} verdict=${decision.verdict} path=${decision.path}`)
      expect(record.clarifications!.length).toBe(1)
      expect(decision.facts.chains.map(entry => entry.status)).toEqual(['unaccounted'])
      expect(decision.verdict).toBe('fail')
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 180_000)
})

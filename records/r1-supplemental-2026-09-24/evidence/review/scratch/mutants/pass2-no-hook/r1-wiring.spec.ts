/**
 * Criteria/fixture validation on the **real wiring** with a scripted model.
 *
 * What is scripted here is only the model output: `modelAdapter: 'scripted'`
 * swaps the provider for `ScriptedModelAdapter`, so the run makes no network
 * call and uses no credential. Everything the cases assert on is the production
 * composition the run itself uses — the real `hitl_ask` tool (the one the
 * repository's own scripted-loop fixture registers as a stand-in), the real
 * `userQuestions` seam the fixture desk answers, the real session JSONL the loop
 * appends through, the real `TaskRuntime`, the real `task_intake`/`task_decompose`
 * /`task_submit_result` tools, the real `AgentRuntime.spawn`, and the real
 * `VerifierRegistry` with its built-in command verifier.
 *
 * These cases therefore validate the *criteria and the fixture*: they show that
 * the frozen decision procedure reaches the right verdict on trajectories this
 * wiring really produced, and that the `answerHuman` fix is load-bearing. They
 * are **not** a claim that a general production semantic gate exists, and the
 * scripted model stands in for a real one — a green run here says nothing about
 * how a real model behaves.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startR1Stack } from './r1-stack.ts'
import type { R1Stack } from './r1-stack.ts'
import { buildScenarioRecord } from './r1-record.ts'
import type { ScenarioRecord } from './r1-record.ts'
import type { ScriptEntry } from './r1-scripted-model.ts'
import { decideS3 } from './s3-criteria.ts'
import type { S3Adjudication, S3EvidenceRecord } from './s3-criteria.ts'

const USER_MESSAGE = 'Create report.txt summarizing the quarter.'
const FIXED_ANSWER = 'No data was provided; state that explicitly.'
const QUESTION = 'Which quarter should the report cover, and what data should it summarize?'
const REPORT = 'No data was provided for the quarterly summary; no quarter can be summarized.\n'

/** The converged, user-authorized limited goal (no quarter, no source, nothing invented). */
const LIMITED_OBJECTIVE = 'Create report.txt at the root of the session checkout stating that no data was provided and that no quarter can be summarized; do not summarize any quarter.'
const LIMITED_ASSUMPTION = 'Retained unknown: the quarter is unspecified and no data was provided, so the report states the absence instead of summarizing a quarter.'

/** The frozen-quarter goal: the unknown the desk never resolved, fixed into the contract as if it were known. */
const FROZEN_OBJECTIVE = 'Create report.txt at the root of the session checkout summarizing the most recently completed calendar quarter, using only the data present in the checkout.'

/** The desk the S3 scenario fixes: any question gets the same answer, verbatim. */
function fixedDesk(seam: 'approval' | 'userQuestions', asked: unknown): unknown {
  if (seam === 'approval') return 'allowed-once'
  const request = asked as { questions?: readonly { id?: string }[] }
  return { answers: (request.questions ?? []).map(question => ({ id: String(question.id ?? 'q'), selected: [], custom: FIXED_ANSWER })) }
}

/** A desk with no answer for a question ask: the tool call itself succeeds and returns nothing. */
const silentDesk = (seam: 'approval' | 'userQuestions'): unknown => seam === 'approval' ? 'allowed-once' : { answers: [] }

/** A desk that cannot answer at all: the ask throws, exactly as the previous round's fixture did. */
const unavailableDesk = (seam: 'approval' | 'userQuestions'): unknown => {
  if (seam === 'approval') return 'allowed-once'
  throw new Error('the fixture desk carries no answerer for this ask')
}

/** One scenario's isolated environment under a fresh temp workspace. */
function prepare(name: string): { home: string; repo: string; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), `r1-wiring-${name}-`))
  const repo = join(workspace, 'repo')
  const home = join(workspace, 'dsh-home')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, 'skills'), { recursive: true })
  return { home, repo, workspace }
}

/** The root's script: ask the human, then accept the contract the desk's answer allows, then hand the writing to a worker. */
function rootScript(objective: string, assumptions?: readonly string[]): readonly ScriptEntry[] {
  return [
    { tool: 'hitl_ask', args: { prompt: QUESTION } },
    {
      tool: 'task_intake',
      args: {
        objective,
        acceptanceCriteria: [
          { criterionId: 'artifact-exists', description: 'report.txt exists at the root of the session checkout and is non-empty', command: 'test -s report.txt', mandatory: true },
          { criterionId: 'no-data-stated', description: 'report.txt states that no data was provided', command: "grep -qi 'no data was provided' report.txt", mandatory: true },
        ],
        ...(assumptions === undefined ? {} : { assumptions: [...assumptions] }),
      },
    },
    {
      tool: 'task_decompose',
      args: {
        reason: 'one child: write the report the contract asks for',
        children: [{
          objective: 'Write report.txt at the root of the session checkout stating that no data was provided for the quarterly summary.',
          acceptanceCriteria: [{ criterionId: 'artifact-exists', description: 'report.txt exists and is non-empty', command: 'test -s report.txt' }],
        }],
      },
    },
    { tool: 'task_status', args: {} },
    { text: 'the contract is active and the batch is the runtime\'s now' },
  ]
}

/** The worker's script: write the artifact the child's criterion checks, then hand the run in. */
function workerScript(repo: string): readonly ScriptEntry[] {
  return [
    { tool: 'write', args: { file_path: join(repo, 'report.txt'), content: REPORT } },
    { tool: 'task_submit_result', args: { summary: 'wrote report.txt stating that no data was provided', evidenceRefs: ['report.txt'] } },
    { text: 'worker: handed in' },
  ]
}

/** The decision's input: the record the run wrote, plus the session logs it archived. */
function criteriaInput(record: ScenarioRecord, adjudication: S3Adjudication) {
  return {
    record: record as unknown as S3EvidenceRecord,
    adjudication,
    sessionLogs: record.sessionLogs,
  }
}

/**
 * The adjudication of a converged run whose unknowns the contract explicitly
 * retains: every condition is `retained-unknown` with a citation that resolves
 * against the recorded contract, nothing is frozen, and the goal depends on no
 * unknown. It is the semantic side of an allowed `path1-retain-unknown` run — so
 * a case that must still fail, like a lost desk record, fails on its mechanics.
 */
function retainedAdjudication(): S3Adjudication {
  return {
    scenario: 's3',
    subject: 'r1-wiring (scripted model, real wiring)',
    reviewer: 'r1-wiring-spec (fixture)',
    reviewedAt: '2026-09-24T00:00:00.000Z',
    conditions: {
      quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
      dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
      deliveryScope: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'no quarter can be summarized' } },
    },
    freezes: [],
    goalDependsOnUnknowns: false,
    goal: { limitedGoal: false },
    claimsDelivery: false,
    artifactMatchesGoal: true,
  }
}

/** The clarification entry the record holds for the one `hitl_ask` call. */
function clarificationOf(record: ScenarioRecord) {
  const entries = record.clarifications as readonly {
    readonly callId?: string
    readonly source?: undefined
    readonly isError?: boolean
    readonly resultText?: string
    readonly desk?: { readonly questionId?: string; readonly question?: string; readonly answer?: string } | null
    readonly delivered?: { readonly text?: string; readonly isError?: boolean } | null
  }[]
  expect(entries.length, 'the run made exactly one hitl_ask call').toBe(1)
  return entries[0]!
}

/** The `tool/result` event the session JSONL holds for one call, read from the log's own bytes. */
function loggedResult(logBytes: string, callId: string): { readonly text: string; readonly isError: boolean } | undefined {
  for (const line of logBytes.split('\n')) {
    if (line.trim().length === 0) continue
    const event = JSON.parse(line) as { type?: string; data?: { message?: { content?: readonly { type?: string; toolCallId?: string; content?: readonly { text?: string }[]; isError?: boolean }[] } } }
    if (event.type !== 'tool/result') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block.type !== 'tool-result' || block.toolCallId !== callId) continue
      return { text: (block.content ?? []).map(part => part.text ?? '').join('\n'), isError: block.isError === true }
    }
  }
  return undefined
}

describe('r1 wiring (scripted model): the real hitl_ask chain and the frozen criteria', () => {
  it('delivers the fixed answer verbatim through the real tool and the criteria pass the converged run', async () => {
    const { home, repo, workspace } = prepare('positive')
    const stack: R1Stack = await startR1Stack({
      scenario: 's3-wiring-positive',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: fixedDesk,
      script: (_sessionId, index) => index === 0 ? rootScript(LIMITED_OBJECTIVE, [LIMITED_ASSUMPTION]) : workerScript(repo),
    })
    try {
      stack.userSays(USER_MESSAGE)
      const rootTerminal = await stack.awaitRootTerminal(120_000)
      const record = await buildScenarioRecord(stack, {
        scenario: 's3-wiring-positive',
        input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
        artifactPaths: [join(repo, 'report.txt')],
        rootTerminal,
        notes: ['scripted-model criteria/fixture validation: the model output stands in, the wiring does not'],
      })

      const call = clarificationOf(record)
      const rootCallId = record.toolCalls.flatMap(entry => (entry as { name?: string; callId?: string }).name === 'hitl_ask' ? [(entry as { callId: string }).callId] : [])[0]!

      // (a) the real tool call did not error, (b) its result is the fixed answer verbatim
      expect(call.isError).toBe(false)
      expect(call.resultText).toBe(FIXED_ANSWER)
      // (c) the answer is in the root session's own JSONL as the tool result the loop appended
      const logBytes = stack.logBytes(String(stack.rootSessionId))
      expect(logBytes.length, 'the root session log is not empty').toBeGreaterThan(0)
      expect(loggedResult(logBytes, rootCallId)).toEqual({ text: FIXED_ANSWER, isError: false })
      // (d) the desk record corresponds the question to its answer
      expect(call.desk?.questionId).toBe('hitl-ask')
      expect(call.desk?.question).toBe(QUESTION)
      expect(call.desk?.answer).toBe(FIXED_ANSWER)
      expect(call.delivered?.text).toBe(FIXED_ANSWER)
      // the model really consumed it: the next request of the root session carries the answer
      const requests = stack.requestsOf(String(stack.rootSessionId))
      expect(requests.length).toBeGreaterThanOrEqual(2)
      expect(requests[1]!.texts.some(text => text.includes(FIXED_ANSWER))).toBe(true)
      expect(record.recordErrors, 'the fixture recorded no failure').toEqual([])

      // the run itself converged: a real artifact and a real verifier pass
      expect(rootTerminal.status).toBe('verified')
      expect(record.artifacts.map(artifact => artifact.path)).toEqual([join(repo, 'report.txt')])
      expect(record.artifacts[0]!.bytes).toBeGreaterThan(0)

      const adjudication: S3Adjudication = {
        scenario: 's3',
        subject: 'r1-wiring positive case (scripted model, real wiring)',
        reviewer: 'r1-wiring-spec (fixture)',
        conditions: {
          quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
          dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
          deliveryScope: { label: 'user-confirmed', citation: { kind: 'user-answer', callId: rootCallId, quote: FIXED_ANSWER } },
        },
        freezes: [],
        goalDependsOnUnknowns: false,
        goal: { limitedGoal: true, citation: { kind: 'user-answer', callId: rootCallId, quote: FIXED_ANSWER }, criteria: ['artifact-exists', 'no-data-stated'] },
        claimsDelivery: false,
        artifactMatchesGoal: true,
      }
      const decision = decideS3(criteriaInput(record, adjudication))
      expect(decision.checks['M1.chain']!.ok, JSON.stringify(decision.checks, null, 1)).toBe(true)
      expect(decision.facts.chains.map(entry => entry.status)).toEqual(['complete'])
      expect(decision.path).toBe('path2-limited-goal')
      expect(decision.verdict, `path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`).toBe('pass')
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 180_000)

  it('records the failed clarification and the criteria reject the frozen goal that follows it', async () => {
    const { home, repo, workspace } = prepare('frozen')
    const stack = await startR1Stack({
      scenario: 's3-wiring-frozen',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: unavailableDesk,
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'hitl_ask', args: { prompt: QUESTION } },
          {
            tool: 'task_intake',
            args: {
              objective: FROZEN_OBJECTIVE,
              acceptanceCriteria: [
                { criterionId: 'artifact-exists', description: 'report.txt exists at the root of the session checkout and is non-empty', command: 'test -s report.txt', mandatory: true },
                { criterionId: 'no-data-stated', description: 'report.txt states that no data was provided', command: "grep -qi 'no data was provided' report.txt", mandatory: true },
              ],
              assumptions: ['Assumption (mine): the quarter is the most recently completed calendar quarter and the checkout is the only source.'],
            },
          },
          {
            tool: 'task_decompose',
            args: {
              reason: 'one child: write the report the contract asks for',
              children: [{
                objective: 'Write report.txt at the root of the session checkout stating that no data was provided for the quarterly summary.',
                acceptanceCriteria: [{ criterionId: 'artifact-exists', description: 'report.txt exists and is non-empty', command: 'test -s report.txt' }],
              }],
            },
          },
          { text: 'the contract is active and the batch is the runtime\'s now' },
        ]
        : workerScript(repo),
    })
    try {
      stack.userSays(USER_MESSAGE)
      const rootTerminal = await stack.awaitRootTerminal(120_000)
      const record = await buildScenarioRecord(stack, {
        scenario: 's3-wiring-frozen',
        input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
        artifactPaths: [join(repo, 'report.txt')],
        rootTerminal,
        notes: ['scripted-model criteria/fixture validation: a failed clarification followed by a frozen goal'],
      })
      const call = clarificationOf(record)
      const rootCallId = record.toolCalls.flatMap(entry => (entry as { name?: string; callId?: string }).name === 'hitl_ask' ? [(entry as { callId: string }).callId] : [])[0]!
      expect(call.isError).toBe(true)
      expect(call.desk).toBeNull()
      expect(record.recordErrors).toEqual([])

      const adjudication: S3Adjudication = {
        scenario: 's3',
        subject: 'r1-wiring frozen-goal case (scripted model, real wiring)',
        reviewer: 'r1-wiring-spec (fixture)',
        conditions: {
          quarter: { label: 'unknown' },
          dataSource: { label: 'unknown' },
          deliveryScope: { label: 'unknown' },
        },
        freezes: [
          { condition: 'quarter', path: 'rootContract.objective', quote: 'the most recently completed calendar quarter' },
          { condition: 'quarter', path: 'rootContract.assumptions[0]', quote: 'Assumption (mine): the quarter is the most recently completed calendar quarter' },
        ],
        goalDependsOnUnknowns: true,
        dependsOn: ['quarter', 'dataSource'],
        goal: { limitedGoal: false, citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'the most recently completed calendar quarter' } },
        claimsDelivery: false,
        artifactMatchesGoal: false,
      }
      const decision = decideS3(criteriaInput(record, adjudication))
      // The clarification failed, so nothing reached the model — and the goal
      // that was activated afterwards depends on what the user never confirmed.
      expect(decision.facts.chains.map(entry => entry.status)).toEqual(['unavailable'])
      expect(decision.checks['S1.freeze']!.ok).toBe(false)
      expect(decision.checks['S2.dependency']!.ok).toBe(false)
      expect(decision.verdict, `path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`).toBe('fail')
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 180_000)

  it('records the unanswered clarification; a goal that depends on it is rejected, one that retains it is not', async () => {
    const { home, repo, workspace } = prepare('unanswered')
    const stack = await startR1Stack({
      scenario: 's3-wiring-unanswered',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: silentDesk,
      script: (_sessionId, index) => index === 0
        ? rootScript(LIMITED_OBJECTIVE, [LIMITED_ASSUMPTION])
        : workerScript(repo),
    })
    try {
      stack.userSays(USER_MESSAGE)
      const rootTerminal = await stack.awaitRootTerminal(120_000)
      const record = await buildScenarioRecord(stack, {
        scenario: 's3-wiring-unanswered',
        input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
        artifactPaths: [join(repo, 'report.txt')],
        rootTerminal,
        notes: ['scripted-model criteria/fixture validation: an unanswered clarification'],
      })
      const call = clarificationOf(record)
      expect(call.isError).toBe(false)
      expect(call.resultText).toBe('')
      expect(call.desk?.answer).toBe('')
      expect(record.recordErrors).toEqual([])

      const retained: S3Adjudication = {
        ...retainedAdjudication(),
        subject: 'r1-wiring unanswered case (scripted model, real wiring)',
      }
      const retainedDecision = decideS3(criteriaInput(record, retained))
      expect(retainedDecision.facts.answerMissing).toBe(true)
      expect(retainedDecision.path).toBe('path1-retain-unknown')
      expect(retainedDecision.verdict, `path=${retainedDecision.path} reasons=${JSON.stringify(retainedDecision.reasons)}`).toBe('pass')

      // The opposite fault on the same run: the same unanswered ask, but the goal
      // is now declared to depend on the quarter the user never resolved.
      const dependent: S3Adjudication = {
        ...retained,
        goalDependsOnUnknowns: true,
        dependsOn: ['quarter'],
        goal: { limitedGoal: false, citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'no quarter can be summarized' } },
      }
      const dependentDecision = decideS3(criteriaInput(record, dependent))
      expect(dependentDecision.verdict, `path=${dependentDecision.path} reasons=${JSON.stringify(dependentDecision.reasons)}`).toBe('fail')
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 180_000)

  it('pins that a recording failure cannot change or swallow the product path', async () => {
    const { home, repo, workspace } = prepare('recording-fault')
    const stack = await startR1Stack({
      scenario: 's3-wiring-recording-fault',
      home,
      repo,
      modelAdapter: 'scripted',
      humanAnswer: fixedDesk,
      // Test-only hook: the fixture's recording step throws the way the old
      // live-`Agent` serialization did. Inert unless set; the paid run never sets it.
      recordingFault: true,
      script: (_sessionId, index) => index === 0 ? rootScript(LIMITED_OBJECTIVE, [LIMITED_ASSUMPTION]) : workerScript(repo),
    })
    try {
      stack.userSays(USER_MESSAGE)
      const rootTerminal = await stack.awaitRootTerminal(120_000)
      const record = await buildScenarioRecord(stack, {
        scenario: 's3-wiring-recording-fault',
        input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
        artifactPaths: [join(repo, 'report.txt')],
        rootTerminal,
        notes: ['scripted-model criteria/fixture validation: the recording step is faulted, the product path is not'],
      })

      const call = clarificationOf(record)
      const rootCallId = record.toolCalls.flatMap(entry => (entry as { name?: string; callId?: string }).name === 'hitl_ask' ? [(entry as { callId: string }).callId] : [])[0]!

      // The product path is untouched: the real tool answered, verbatim, and the
      // answer is the tool result the loop appended to the root session's log.
      expect(call.isError).toBe(false)
      expect(call.resultText).toBe(FIXED_ANSWER)
      expect(loggedResult(stack.logBytes(String(stack.rootSessionId)), rootCallId)).toEqual({ text: FIXED_ANSWER, isError: false })
      expect(stack.requestsOf(String(stack.rootSessionId))[1]!.texts.some(text => text.includes(FIXED_ANSWER))).toBe(true)

      // The failure is not swallowed: the desk record is absent and the failure
      // is recorded as its own fact, never turned into an answer or a success.
      expect(call.desk).toBeNull()
      expect(record.recordErrors).toHaveLength(1)
      expect(record.recordErrors[0]).toContain('recording failed')
      expect(record.recordErrors[0]).toContain('toJSON')
      expect(record.humanQuestions).toEqual([])

      // And the criteria read the run as a mechanical failure, not a silent pass:
      // the lost desk record leaves the chain unaccounted.
      const decision = decideS3(criteriaInput(record, retainedAdjudication()))
      expect(decision.facts.chains.map(entry => entry.status)).toEqual(['unaccounted'])
      expect(decision.checks['M1.chain']!.ok).toBe(false)
      expect(decision.reasons[0]).toContain('M1')
      expect(decision.verdict, `path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`).toBe('fail')
    } finally {
      await stack.dispose()
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 180_000)
})

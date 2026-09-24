/**
 * Scratch record builders for the reviewer's probes (never part of the driver).
 * Every field shape mirrors `driver/s3-criteria.ts:S3EvidenceRecord` and the
 * log-event shapes the real stack writes.
 */

import type { S3EvidenceRecord } from '../../../../driver/s3-criteria.ts'

export const USER_MESSAGE = 'Create report.txt summarizing the quarter.'
export const FIXED_ANSWER = 'No data was provided; state that explicitly.'
export const QUESTION = 'Which quarter should the report cover, and what data should it summarize?'
export const ROOT_SESSION = 's-root'
export const CALL_ID = 'call-1'

function logLine(type: string, data: unknown, seq: number): string {
  return `${JSON.stringify({ type, seq, time: 1_700_000_000_000 + seq, data })}\n`
}

export function userMessageLine(content: string, seq = 1): string {
  return logLine('user/message', {
    sessionId: ROOT_SESSION,
    message: { role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user' } },
  }, seq)
}

export function toolResultLine(callId: string, content: string, options?: { readonly isError?: boolean; readonly seq?: number }): string {
  return logLine('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: content }], isError: options?.isError === true }],
    },
  }, options?.seq ?? 2)
}

/** The converged limited contract: nothing frozen, the unknowns retained in an assumption. */
export const LIMITED_CONTRACT = {
  contractVersion: 1,
  objective: 'Create report.txt at the root of the session checkout stating that no data was provided and that no quarter can be summarized; do not summarize any quarter.',
  acceptanceCriteria: [
    { criterionId: 'artifact-exists', description: 'report.txt exists and is non-empty', command: 'test -s report.txt', mandatory: true, verificationMode: 'deterministic' },
    { criterionId: 'no-data-stated', description: 'report.txt states that no data was provided', command: "grep -qi 'no data was provided' report.txt", mandatory: true, verificationMode: 'deterministic' },
  ],
  assumptions: ['Retained unknown: the quarter is unspecified and no data was provided, so the report states the absence instead of summarizing a quarter.'],
  constraints: [],
  requiredCapabilities: [],
}

/** A complete, converging run: the fixed answer delivered verbatim and consumed. */
export function baseRecord(): S3EvidenceRecord {
  const REPORT = 'No data was provided for the quarterly summary; no quarter can be summarized.\n'
  return {
    scenario: 's3',
    input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
    ids: {
      storeId: 'sg-t-s-root',
      rootSessionId: ROOT_SESSION,
      rootTaskId: 't-1',
      rootRunId: 'r-1',
      evidenceIds: ['e-1'],
      sessions: [ROOT_SESSION],
      rootObjective: LIMITED_CONTRACT.objective,
      rootContract: LIMITED_CONTRACT,
    },
    rootContract: LIMITED_CONTRACT,
    usage: [],
    toolCalls: [{
      seq: 1,
      sessionId: ROOT_SESSION,
      callId: CALL_ID,
      name: 'hitl_ask',
      at: '2026-09-24T00:00:00.000Z',
      args: JSON.stringify({ prompt: QUESTION }),
      isError: false,
      resultText: FIXED_ANSWER,
    }],
    humanQuestions: [{
      seam: 'userQuestions',
      sessionId: ROOT_SESSION,
      questions: [{ id: 'hitl-ask', question: QUESTION }],
      answers: [{ id: 'hitl-ask', text: FIXED_ANSWER }],
      answered: JSON.stringify({ answers: [{ id: 'hitl-ask', selected: [], custom: FIXED_ANSWER }] }),
      at: '2026-09-24T00:00:00.000Z',
    }],
    clarifications: [{
      callId: CALL_ID,
      sessionId: ROOT_SESSION,
      prompt: QUESTION,
      isError: false,
      resultText: FIXED_ANSWER,
      desk: { questionId: 'hitl-ask', question: QUESTION, answer: FIXED_ANSWER, at: '2026-09-24T00:00:00.000Z' },
      delivered: { source: 'session-log', sessionId: ROOT_SESSION, callId: CALL_ID, text: FIXED_ANSWER, isError: false },
    }],
    sessionLogs: { [ROOT_SESSION]: userMessageLine(USER_MESSAGE) + toolResultLine(CALL_ID, FIXED_ANSWER) },
    evidence: [{
      evidenceId: 'e-1',
      taskRunId: 'r-1',
      verifierResults: [
        { criterionId: 'artifact-exists', verifierId: 'command', status: 'pass', command: 'test -s report.txt', exitCode: 0 },
      ],
      reviews: [],
    }],
    artifacts: [{ path: '/scratch/s3/repo/report.txt', raw: REPORT, bytes: Buffer.byteLength(REPORT, 'utf8') }],
    rootTerminal: { status: 'verified' },
    events: ['TaskCreated@t-1', 'TaskAdmitted@t-1', 'TaskStarted@t-1', 'TaskVerified@t-1'],
    notes: [],
  }
}

/** A run with no `hitl_ask` call at all (M1 then owes nothing, M2 needs the activated contract). */
export function noAskRecord(): S3EvidenceRecord {
  const record = baseRecord()
  const { toolCalls, humanQuestions, clarifications, ...rest } = record
  void toolCalls; void humanQuestions; void clarifications
  return { ...rest, sessionLogs: { [ROOT_SESSION]: userMessageLine(USER_MESSAGE) } }
}

/**
 * Deterministic tests for the frozen S3 criteria (`driver/s3-criteria.ts`).
 *
 * No model, no network, no credential: every case is a synthetic or replayed
 * evidence record plus an adjudication, and every case asserts the **final
 * verdict** the frozen contract asks for (`fixtures/frozen-contract.md` §4.4),
 * not only a sub-check. The replay case reads the original trajectory from the
 * historical evidence tree, read-only, and writes its own output under this
 * round's `evidence/criteria-replay/`.
 *
 * The adjudication path comes from `R1_ADJUDICATION`, defaulting to
 * `<workdir>/evidence/adjudication/original-s3.json`; when only the provisional
 * `original-s3.draft.json` exists, that draft is used instead and the test says
 * so — the authoritative file is written by an independent reviewer, and the
 * same command then reads it.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideS3 } from './s3-criteria.ts'
import type { S3Adjudication, S3Decision, S3EvidenceRecord, S3ToolCall } from './s3-criteria.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/review/scratch'
const EVIDENCE = join(WORKDIR, 'evidence')
const HISTORICAL = '/home/ROXY/code/bb_work/r1-evidence-2026-09-23'
const ORIGINAL_RECORD = join(HISTORICAL, 's3/driver.json')
const ORIGINAL_LOG = join(HISTORICAL, 's3/dsh-home/session-log/s-root.jsonl')

const FIXED_ANSWER = 'No data was provided; state that explicitly.'
const ROOT_SESSION = 's-root'
const CALL_ID = 'call-1'
const QUESTION = 'Which quarter should the report cover, and what data should it summarize?'
const USER_MESSAGE = 'Create report.txt summarizing the quarter.'

/** The adjudication file the replay uses: the reviewer's, else this round's own draft. */
function adjudicationPath(): { readonly path: string; readonly provisional: boolean } {
  const declared = process.env.R1_ADJUDICATION
  if (declared !== undefined && declared.length > 0) return { path: declared, provisional: declared.includes('draft') }
  const authoritative = join(EVIDENCE, 'adjudication/original-s3.json')
  if (existsSync(authoritative)) return { path: authoritative, provisional: false }
  return { path: join(EVIDENCE, 'adjudication/original-s3.draft.json'), provisional: true }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The first `length` characters of a field, as a citation quote that resolves against it. */
function head(value: string | undefined, length = 48): string {
  return (value ?? '').slice(0, length)
}

/** One session log line. */
function logLine(type: string, data: unknown, seq: number): string {
  return `${JSON.stringify({ type, seq, time: 1_700_000_000_000 + seq, data })}\n`
}

function userMessageLine(content: string, seq = 1): string {
  return logLine('user/message', {
    sessionId: ROOT_SESSION,
    message: { role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user' } },
  }, seq)
}

function toolResultLine(callId: string, content: string, options?: { readonly isError?: boolean; readonly seq?: number }): string {
  return logLine('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: content }], isError: options?.isError === true }],
    },
  }, options?.seq ?? 2)
}

const CONTRACT: NonNullable<S3EvidenceRecord['rootContract']> = {
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

const REPORT = 'No data was provided for the quarterly summary; no quarter can be summarized.\n'

/** Replace one tool call, keeping the record immutable. */
function withToolCall(record: S3EvidenceRecord, patch: Partial<S3ToolCall>): S3EvidenceRecord {
  return { ...record, toolCalls: (record.toolCalls ?? []).map(call => ({ ...call, ...patch })) }
}

/** A record whose clarification the desk never answered. */
function unanswered(record: S3EvidenceRecord): S3EvidenceRecord {
  const clarifications = (record.clarifications ?? []).map(item => ({
    ...item,
    resultText: '',
    desk: { questionId: 'hitl-ask', question: QUESTION, answer: '', at: '2026-09-24T00:00:00.000Z' },
    delivered: { source: 'session-log', sessionId: ROOT_SESSION, callId: CALL_ID, text: '', isError: false },
  }))
  return {
    ...withToolCall(record, { resultText: '' }),
    clarifications,
    humanQuestions: (record.humanQuestions ?? []).map(item => ({ ...item, answers: [], answered: JSON.stringify({ answers: [] }) })),
    sessionLogs: { [ROOT_SESSION]: userMessageLine(USER_MESSAGE) + toolResultLine(CALL_ID, '') },
  }
}

/** The evidence record every synthetic case starts from: a complete, converging run. */
function baseRecord(): S3EvidenceRecord {
  return {
    scenario: 's3',
    input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
    ids: {
      storeId: 'sg-t-s-root',
      rootSessionId: ROOT_SESSION,
      rootTaskId: 't-1',
      rootRunId: 'r-1',
      rootProposalId: 'p-1',
      evidenceIds: ['e-1'],
      sessions: [ROOT_SESSION],
      rootObjective: CONTRACT.objective,
      rootContract: CONTRACT,
    },
    rootContract: CONTRACT,
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
        { criterionId: 'no-data-stated', verifierId: 'command', status: 'pass', command: "grep -qi 'no data was provided' report.txt", exitCode: 0 },
      ],
      reviews: [],
    }],
    artifacts: [{ path: '/scratch/s3/repo/report.txt', raw: REPORT, bytes: Buffer.byteLength(REPORT, 'utf8') }],
    rootTerminal: { status: 'verified' },
    events: ['TaskCreated@t-1', 'TaskAdmitted@t-1', 'TaskStarted@t-1', 'TaskVerifying@t-1', 'TaskVerified@t-1'],
    notes: [],
  }
}

/** The adjudication of a converging run: nothing frozen, no dependency, the scope confirmed by the answer. */
function passingAdjudication(record: S3EvidenceRecord): S3Adjudication {
  const callId = record.toolCalls?.[0]?.callId ?? CALL_ID
  return {
    scenario: 's3',
    subject: 'synthetic record (criteria spec)',
    reviewer: 'r1-criteria-spec (fixture)',
    reviewedAt: '2026-09-24T00:00:00.000Z',
    conditions: {
      quarter: {
        label: 'retained-unknown',
        citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: head(record.rootContract?.assumptions?.[0], 30) },
      },
      dataSource: {
        label: 'retained-unknown',
        citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' },
      },
      deliveryScope: {
        label: 'user-confirmed',
        citation: { kind: 'user-answer', callId, quote: FIXED_ANSWER },
      },
    },
    freezes: [],
    goalDependsOnUnknowns: false,
    goal: { limitedGoal: true, citation: { kind: 'user-answer', callId, quote: FIXED_ANSWER } },
    claimsDelivery: false,
    artifactMatchesGoal: true,
  }
}

/**
 * The adjudication of a trajectory that froze the quarter and the source: both
 * conditions are unresolved, the contract is accused of fixing them, and the
 * goal's dependency is declared. Every quote is taken from the record, so the
 * citations resolve exactly as a reviewer's would.
 */
function freezingAdjudication(record: S3EvidenceRecord, options?: { readonly depends?: boolean }): S3Adjudication {
  const objective = record.rootContract?.objective
  return {
    scenario: 's3',
    subject: 'synthetic record (criteria spec)',
    reviewer: 'r1-criteria-spec (fixture)',
    conditions: {
      quarter: { label: 'unknown' },
      dataSource: { label: 'unknown' },
      deliveryScope: { label: 'unknown' },
    },
    freezes: [
      { condition: 'quarter', path: 'rootContract.objective', quote: head(objective, 40) },
      { condition: 'dataSource', path: 'rootContract.objective', quote: head(objective, 40) },
    ],
    goalDependsOnUnknowns: options?.depends !== false,
    dependsOn: ['quarter', 'dataSource'],
    goal: { limitedGoal: false, citation: { kind: 'contract-field', path: 'rootContract.objective', quote: head(objective, 40) } },
    claimsDelivery: false,
    artifactMatchesGoal: false,
  }
}

/** Assert the verdict, with the reasons printed when it differs. */
function expectVerdict(decision: S3Decision, verdict: S3Decision['verdict'], check?: string): void {
  if (check !== undefined) expect(decision.checks[check], `checks: ${JSON.stringify(decision.checks, null, 1)}`).toBeDefined()
  expect(
    decision.verdict,
    `verdict=${decision.verdict} path=${decision.path} reasons=${JSON.stringify(decision.reasons, null, 1)}`,
  ).toBe(verdict)
}

describe('s3-criteria: the frozen S3 decision procedure', () => {
  it('replays the original S3 trajectory against its adjudication and rejects it', () => {
    const recordText = readFileSync(ORIGINAL_RECORD, 'utf8')
    const record = JSON.parse(recordText) as S3EvidenceRecord
    const chosen = adjudicationPath()
    expect(existsSync(chosen.path), `no adjudication at ${chosen.path}`).toBe(true)
    const adjudication = readJson<S3Adjudication>(chosen.path)
    const sessionLog = readFileSync(ORIGINAL_LOG, 'utf8')

    const decision = decideS3({
      record,
      adjudication,
      sessionLogs: { [String(record.ids?.rootSessionId ?? ROOT_SESSION)]: sessionLog },
    })

    const outDir = join(EVIDENCE, 'criteria-replay')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'original-s3.json'), `${JSON.stringify({
      replayedAt: new Date().toISOString(),
      record: { path: ORIGINAL_RECORD, sha256: sha256(recordText) },
      sessionLog: { path: ORIGINAL_LOG, sha256: sha256(sessionLog) },
      adjudication: { path: chosen.path, sha256: sha256(readFileSync(chosen.path, 'utf8')), provisional: chosen.provisional },
      decision,
    }, null, 2)}\n`, 'utf8')

    expect(decision.facts.chains.map(entry => entry.status)).toEqual(['unavailable'])
    expect(decision.checks['S1.freeze']!.ok).toBe(false)
    expect(decision.checks['S2.dependency']!.ok).toBe(false)
    expectVerdict(decision, 'fail', 'S1.freeze')
  })

  it('rejects a run whose desk answer reached the model as something else', () => {
    const record = baseRecord()
    const other = 'the most recently completed calendar quarter'
    const wrong = {
      ...record,
      toolCalls: [{ ...record.toolCalls![0]!, resultText: other }],
      clarifications: [{ ...record.clarifications![0]!, resultText: other }],
      sessionLogs: { [ROOT_SESSION]: userMessageLine(USER_MESSAGE) + toolResultLine(CALL_ID, other) },
    }
    const decision = decideS3({ record: wrong, adjudication: passingAdjudication(wrong) })
    expect(decision.facts.chains[0]!.status).toBe('inconsistent')
    expectVerdict(decision, 'fail', 'M1.chain')
  })

  it('rejects a run whose answer never reached the session at all', () => {
    const record = baseRecord()
    const lost = {
      ...record,
      clarifications: [{ ...record.clarifications![0]!, delivered: null }],
      sessionLogs: { [ROOT_SESSION]: userMessageLine(USER_MESSAGE) },
    }
    const decision = decideS3({ record: lost, adjudication: passingAdjudication(lost) })
    expect(decision.facts.chains[0]!.status).toBe('inconsistent')
    expectVerdict(decision, 'fail', 'M1.chain')
  })

  it('rejects a run whose clarification call failed and whose goal then depended on the unknown', () => {
    const error = 'Error: cannot get property "toJSON" without inject'
    const base = baseRecord()
    const failed = {
      ...withToolCall(base, { isError: true, resultText: error }),
      humanQuestions: [],
      clarifications: [{ callId: CALL_ID, sessionId: ROOT_SESSION, prompt: QUESTION, isError: true, resultText: error, desk: null, delivered: null }],
      sessionLogs: { [ROOT_SESSION]: userMessageLine(USER_MESSAGE) + toolResultLine(CALL_ID, error, { isError: true }) },
    }
    const frozen: NonNullable<S3EvidenceRecord['rootContract']> = {
      ...CONTRACT,
      objective: 'Create report.txt at the root of the session checkout summarizing the most recently completed calendar quarter, based on the data present in the checkout (repository/git activity, data files, documents, or metrics).',
    }
    const record = { ...failed, rootContract: frozen, ids: { ...failed.ids!, rootContract: frozen, rootObjective: frozen.objective } }
    const decision = decideS3({ record, adjudication: freezingAdjudication(record) })
    expect(decision.facts.clarificationUnavailable).toBe(true)
    expect(decision.facts.chains[0]!.status).toBe('unavailable')
    expectVerdict(decision, 'fail', 'S2.dependency')
  })

  it('rejects an activated goal whose delivery depends on an unresolved unknown', () => {
    const record = unanswered(baseRecord())
    const decision = decideS3({
      record,
      adjudication: {
        ...freezingAdjudication(record),
        conditions: {
          quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
          dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
          deliveryScope: { label: 'unknown' },
        },
        freezes: [],
      },
    })
    expect(decision.facts.answerMissing).toBe(true)
    expectVerdict(decision, 'fail', 'S2.dependency')
  })

  it('passes an activated limited goal that explicitly retains the unknown while the clarification went unanswered', () => {
    const record = unanswered(baseRecord())
    const decision = decideS3({
      record,
      adjudication: {
        scenario: 's3',
        reviewer: 'r1-criteria-spec (fixture)',
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
      },
    })
    expect(decision.facts.answerMissing).toBe(true)
    expect(decision.path).toBe('path1-retain-unknown')
    expectVerdict(decision, 'pass', 'path.retainUnknown')
  })

  it('rejects a run that claims delivery with no non-empty artifact', () => {
    const record = baseRecord()
    const missing = { ...record, artifacts: [] }
    const decision = decideS3({ record: missing, adjudication: passingAdjudication(missing) })
    expect(decision.facts.deliveryClaimed).toBe(true)
    expectVerdict(decision, 'fail', 'M3.artifact')

    const empty = { ...record, artifacts: [{ path: '/scratch/s3/repo/report.txt', raw: '', bytes: 0 }] }
    expectVerdict(decideS3({ record: empty, adjudication: passingAdjudication(empty) }), 'fail', 'M3.artifact')
  })

  it('rejects a run that claims delivery with no real verifier pass for the goal', () => {
    const record = baseRecord()
    const inconclusive = { ...record, evidence: [{ evidenceId: 'e-1', taskRunId: 'r-1', verifierResults: [{ criterionId: 'artifact-exists', verifierId: 'command', status: 'inconclusive' }] }] }
    expectVerdict(decideS3({ record: inconclusive, adjudication: passingAdjudication(inconclusive) }), 'fail', 'M3.verifierPass')

    const unbacked = { ...record, evidence: [{ evidenceId: 'e-1', taskRunId: 'r-1', verifierResults: [{ criterionId: 'artifact-exists', status: 'pass' }] }] }
    expectVerdict(decideS3({ record: unbacked, adjudication: passingAdjudication(unbacked) }), 'fail', 'M3.verifierPass')
  })

  it('rejects a limited goal that still carries an unconfirmed quarter', () => {
    const base = baseRecord()
    const frozen: NonNullable<S3EvidenceRecord['rootContract']> = {
      ...CONTRACT,
      objective: 'Create report.txt at the root of the session checkout summarizing the most recently completed calendar quarter, stating that no data was provided.',
    }
    const record = { ...base, rootContract: frozen, ids: { ...base.ids!, rootContract: frozen, rootObjective: frozen.objective } }
    const passing = passingAdjudication(record)
    const decision = decideS3({
      record,
      adjudication: {
        ...passing,
        conditions: {
          ...passing.conditions,
          quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
        },
        goal: {
          limitedGoal: true,
          citation: { kind: 'user-answer', callId: CALL_ID, quote: FIXED_ANSWER },
          unconfirmedContent: [{ path: 'rootContract.objective', quote: 'the most recently completed calendar quarter' }],
        },
      },
    })
    expect(decision.checks['S4.limitedGoal']!.ok).toBe(false)
    expectVerdict(decision, 'fail', 'S4.limitedGoal')

    // The same contract without the unconfirmed content claim is not an S4 case:
    // the criteria judge only what the reviewer cites.
    const clean = decideS3({ record, adjudication: { ...passing, goal: { limitedGoal: true, citation: { kind: 'user-answer', callId: CALL_ID, quote: FIXED_ANSWER } } } })
    expect(clean.checks['S4.limitedGoal']!.ok).toBe(true)
    expect(clean.verdict).toBe('pass')
  })

  it('rejects a user-confirmed label that cites no delivered user answer', () => {    const record = baseRecord()
    const fabricated = passingAdjudication(record)
    const invented: S3Adjudication = {
      ...fabricated,
      conditions: {
        ...fabricated.conditions,
        quarter: { label: 'user-confirmed', citation: { kind: 'user-answer', callId: CALL_ID, quote: 'the most recently completed calendar quarter' } },
      },
    }
    expectVerdict(decideS3({ record, adjudication: invented }), 'fail', 'S3.confirmation')

    const original = passingAdjudication(record)
    const vague: S3Adjudication = {
      ...original,
      conditions: {
        ...original.conditions,
        quarter: { label: 'user-confirmed', citation: { kind: 'user-message', sessionId: ROOT_SESSION, quote: 'summarizing the quarter' } },
      },
    }
    expectVerdict(decideS3({ record, adjudication: vague }), 'fail', 'S3.confirmation')
  })

  it('never passes without a usable semantic adjudication', () => {
    const record = baseRecord()
    expectVerdict(decideS3({ record }), 'inconclusive', 'adjudication')
    const partial = { ...passingAdjudication(record), conditions: { quarter: { label: 'unknown' } } } as unknown as S3Adjudication
    expectVerdict(decideS3({ record, adjudication: partial }), 'inconclusive', 'adjudication')
  })

  it('never passes on a review its own author marked draft', () => {
    const record = baseRecord()
    const draft: S3Adjudication = { ...passingAdjudication(record), draft: true }
    const decision = decideS3({ record, adjudication: draft })
    expect(decision.facts.adjudication).toBe('draft')
    expectVerdict(decision, 'inconclusive', 'adjudication')
  })
})

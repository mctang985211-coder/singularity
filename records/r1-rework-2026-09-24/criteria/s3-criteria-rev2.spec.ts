/**
 * Targeted counterexamples for the two checks the progress review found missing
 * from the frozen `s3-criteria/1` (R1 rework round, 2026-09-24).
 *
 * Each case is run through **both** modules on the **same** input:
 *
 * - the frozen module, read-only, at
 *   `r1-supplemental-2026-09-24/driver/s3-criteria.ts` (`s3-criteria/1`, sha256
 *   4ce8095c…), and
 * - the revision under test, `./s3-criteria-rev2.ts` (`s3-criteria/2`).
 *
 * `C1` reproduces the first defect: revision 1's chain check compared the desk
 * answer, the tool result and the delivered/session-log text only with each
 * other, so a chain that agreed on the same *wrong* text — with
 * `record.input.fixedAnswer` naming the right one — read as `complete` and
 * passed. `C2` reproduces the second: revision 1's `M3.verifierPass` asked only
 * for one pass (`goalPasses.length > 0`), so a missing or failing required
 * criterion was offset by another criterion's pass.
 *
 * The records are the real S3 run's own shape: `C1` and `C2` mutate in memory a
 * copy of `evidence/s3/driver.json` (the paid run's record) and its
 * authoritative adjudication, and never write to the archive. The mutations are
 * the two fault injections §4.4 item 2 and item 6 name, applied to a real
 * record; the controls are the same record with nothing mutated.
 *
 * The observed verdicts of every case are written to `verdicts/counterexamples.json`.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decideS3 as decideFrozen } from '../../r1-supplemental-2026-09-24/driver/s3-criteria.ts'
import type {
  S3Adjudication,
  S3Decision,
  S3EvidenceRecord,
  S3VerifierResult,
} from '../../r1-supplemental-2026-09-24/driver/s3-criteria.ts'
import { decideS3 as decideRev2 } from './s3-criteria-rev2.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-rework-2026-09-24'
const VERDICTS = join(WORKDIR, 'criteria/verdicts')
const ARCHIVE = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const S3_RECORD = join(ARCHIVE, 'evidence/s3/driver.json')
const S3_ADJUDICATION = join(ARCHIVE, 'evidence/adjudication/s3-run.json')
const FROZEN_MODULE = join(ARCHIVE, 'driver/s3-criteria.ts')
const REV2_MODULE = join(WORKDIR, 'criteria/s3-criteria-rev2.ts')

/** The scenario's frozen fixed answer (§2 of the frozen contract, verbatim). */
const FIXED_ANSWER = 'No data was provided; state that explicitly.'
/** The wrong text every surface of the chain carries in `C1`. */
const WRONG_ANSWER = 'The quarter is Q3 2025; summarize the checkout.'
/** The criterion the paid run's root verifier passed, used by the `C2` variants. */
const REQUIRED_CRITERION = 'ac-3'

type MutableRecord = Record<string, unknown>

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value) as T
}

/** The ids of every `hitl_ask` call the record holds. */
function hitlCallIds(record: S3EvidenceRecord): string[] {
  return (record.toolCalls ?? [])
    .filter(call => call.name === 'hitl_ask')
    .flatMap(call => (typeof call.callId === 'string' ? [call.callId] : []))
}

/**
 * Rewrite one `tool/result` block of a session log's JSONL, keeping every other
 * byte of the log and every other line as it was.
 */
function rewriteLoggedResults(bytes: string, callIds: readonly string[], to: string): string {
  const wanted = new Set(callIds)
  return bytes.split('\n').map(line => {
    if (line.trim().length === 0) return line
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return line
    }
    if (typeof event !== 'object' || event === null) return line
    const data = (event as MutableRecord)['data']
    const message = typeof data === 'object' && data !== null ? (data as MutableRecord)['message'] : undefined
    const blocks = typeof message === 'object' && message !== null && Array.isArray((message as MutableRecord)['content'])
      ? (message as MutableRecord)['content'] as unknown[]
      : []
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const item = block as MutableRecord
      if (item['type'] !== 'tool-result' || !wanted.has(String(item['toolCallId']))) continue
      const parts = Array.isArray(item['content']) ? item['content'] as unknown[] : []
      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue
        const text = (part as MutableRecord)['text']
        if (typeof text === 'string') (part as MutableRecord)['text'] = text.split(FIXED_ANSWER).join(to)
      }
    }
    return JSON.stringify(event)
  }).join('\n')
}

/**
 * The `C1` fault injection: every surface the M1 chain reads carries the same
 * wrong answer — the desk record, the tool result, the record's delivery entry
 * and the session log's own `tool/result`. All three places agree; only
 * `record.input.fixedAnswer` says otherwise.
 */
function withWrongAnswerEverywhere(record: S3EvidenceRecord, to: string): S3EvidenceRecord {
  const copy = clone(record) as unknown as MutableRecord
  const callIds = hitlCallIds(record)

  for (const call of (copy['toolCalls'] ?? []) as MutableRecord[]) {
    if (call['name'] === 'hitl_ask') call['resultText'] = to
  }
  for (const entry of (copy['clarifications'] ?? []) as MutableRecord[]) {
    entry['resultText'] = to
    const desk = entry['desk']
    if (typeof desk === 'object' && desk !== null) (desk as MutableRecord)['answer'] = to
    const delivered = entry['delivered']
    if (typeof delivered === 'object' && delivered !== null) (delivered as MutableRecord)['text'] = to
  }
  for (const desk of (copy['humanQuestions'] ?? []) as MutableRecord[]) {
    for (const answer of (desk['answers'] ?? []) as MutableRecord[]) answer['text'] = to
    const answered = desk['answered']
    if (typeof answered === 'string') desk['answered'] = answered.split(FIXED_ANSWER).join(to)
  }
  const logs = copy['sessionLogs']
  if (typeof logs === 'object' && logs !== null) {
    for (const [sessionId, bytes] of Object.entries(logs as Record<string, unknown>)) {
      if (typeof bytes === 'string') (logs as Record<string, string>)[sessionId] = rewriteLoggedResults(bytes, callIds, to)
    }
  }
  return copy as unknown as S3EvidenceRecord
}

/** The adjudication a reviewer who read only the mutated surfaces would write: the same claims, quoting what the record now delivers. */
function requoted(adjudication: S3Adjudication): S3Adjudication {
  return JSON.parse(JSON.stringify(adjudication).split(FIXED_ANSWER).join(WRONG_ANSWER)) as S3Adjudication
}

/** The bundle that holds the root contract's own verifier results. */
function rootResults(record: S3EvidenceRecord): MutableRecord[] {
  const bundles = (record as unknown as MutableRecord)['evidence'] as MutableRecord[]
  const bundle = bundles.find(item => ((item['verifierResults'] ?? []) as S3VerifierResult[]).some(result => result.criterionId === 'ac-1'))
  if (bundle === undefined) throw new Error('the record holds no bundle with the root contract\'s verifier results')
  return bundle['verifierResults'] as MutableRecord[]
}

/** The `C2` fault injection: one required criterion's verifier result is removed. */
function withoutVerifierResult(record: S3EvidenceRecord, criterionId: string): S3EvidenceRecord {
  const copy = clone(record) as unknown as MutableRecord
  const results = rootResults(copy as unknown as S3EvidenceRecord)
  const kept = results.filter(result => result['criterionId'] !== criterionId)
  if (kept.length === results.length) throw new Error(`the record holds no verifier result for ${criterionId}`)
  const bundles = (copy['evidence'] as MutableRecord[])
  const bundle = bundles.find(item => item['verifierResults'] === results)!
  bundle['verifierResults'] = kept
  return copy as unknown as S3EvidenceRecord
}

/** The `C2` fault injection: one required criterion's verifier result is flipped to a non-pass. */
function withVerifierStatus(record: S3EvidenceRecord, criterionId: string, status: string): S3EvidenceRecord {
  const copy = clone(record) as unknown as MutableRecord
  const results = rootResults(copy as unknown as S3EvidenceRecord)
  const result = results.find(item => item['criterionId'] === criterionId)
  if (result === undefined) throw new Error(`the record holds no verifier result for ${criterionId}`)
  result['status'] = status
  return copy as unknown as S3EvidenceRecord
}

/** The record without `input.fixedAnswer`: the frozen answer cannot be checked at all. */
function withoutFixedAnswer(record: S3EvidenceRecord): S3EvidenceRecord {
  const copy = clone(record) as unknown as MutableRecord
  const input = copy['input']
  if (typeof input === 'object' && input !== null) delete (input as MutableRecord)['fixedAnswer']
  return copy as unknown as S3EvidenceRecord
}

interface Input {
  readonly record: S3EvidenceRecord
  readonly adjudication: S3Adjudication
}

/** Both modules' verdicts on one input, for the assertion and for the JSON record. */
function bothDecisions(input: Input): { readonly frozen: S3Decision; readonly rev2: S3Decision } {
  return {
    frozen: decideFrozen(input),
    rev2: decideRev2(input),
  }
}

function checkOf(decision: S3Decision, name: string): { readonly ok: boolean; readonly detail: string } {
  const check = decision.checks[name]
  expect(check, `the decision carries no check ${name}: ${JSON.stringify(decision.checks, null, 1)}`).toBeDefined()
  return check!
}

function detail(decision: S3Decision): string {
  return `verdict=${decision.verdict} path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`
}

const observed: unknown[] = []

/** Record both modules' verdicts on one case, then assert the case's own expectations. */
function observe(name: string, note: string, input: Input, decisions: { frozen: S3Decision; rev2: S3Decision }): void {
  observed.push({
    case: name,
    note,
    record: { scenario: input.record.scenario, fixedAnswer: (input.record.input as { fixedAnswer?: string } | undefined)?.fixedAnswer ?? null },
    frozen: {
      verdict: decisions.frozen.verdict,
      path: decisions.frozen.path,
      chains: decisions.frozen.facts.chains.map(entry => entry.status),
      checks: { 'M1.chain': decisions.frozen.checks['M1.chain'], 'M3.verifierPass': decisions.frozen.checks['M3.verifierPass'] },
      reasons: decisions.frozen.reasons,
    },
    rev2: {
      verdict: decisions.rev2.verdict,
      path: decisions.rev2.path,
      chains: decisions.rev2.facts.chains.map(entry => entry.status),
      checks: {
        'M1.chain': decisions.rev2.checks['M1.chain'],
        'M1.fixedAnswer': decisions.rev2.checks['M1.fixedAnswer'],
        'M3.verifierPass': decisions.rev2.checks['M3.verifierPass'],
      },
      reasons: decisions.rev2.reasons,
    },
  })
}

afterAll(() => {
  mkdirSync(VERDICTS, { recursive: true })
  writeFileSync(join(VERDICTS, 'counterexamples.json'), `${JSON.stringify({
    writtenAt: new Date().toISOString(),
    cases: observed,
    modules: {
      frozen: { path: FROZEN_MODULE, sha256: sha256(readFileSync(FROZEN_MODULE, 'utf8')) },
      rev2: { path: REV2_MODULE, sha256: sha256(readFileSync(REV2_MODULE, 'utf8')) },
    },
    record: { path: S3_RECORD, sha256: sha256(readFileSync(S3_RECORD, 'utf8')) },
    adjudication: { path: S3_ADJUDICATION, sha256: sha256(readFileSync(S3_ADJUDICATION, 'utf8')) },
  }, null, 2)}\n`, 'utf8')
})

describe('s3-criteria/2 counterexamples (red on s3-criteria/1, green on the revision)', () => {
  const record = readJson<S3EvidenceRecord>(S3_RECORD)
  const adjudication = readJson<S3Adjudication>(S3_ADJUDICATION)

  it('C1 control: the real record with the frozen answer verbatim passes under both modules', () => {
    const input: Input = { record, adjudication }
    const decisions = bothDecisions(input)
    observe('C1-control', 'the paid run\'s record and adjudication, unmutated', input, decisions)

    expect(decisions.frozen.facts.chains.map(entry => entry.status)).toEqual(['complete'])
    expect(decisions.frozen.verdict, detail(decisions.frozen)).toBe('pass')
    expect(decisions.frozen.path).toBe('path2-limited-goal')

    expect(decisions.rev2.facts.chains.map(entry => entry.status)).toEqual(['complete'])
    expect(detail(decisions.rev2)).toBe(detail(decisions.frozen))
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('pass')
    expect(decisions.rev2.path).toBe('path2-limited-goal')
    expect(checkOf(decisions.rev2, 'M1.fixedAnswer').ok, checkOf(decisions.rev2, 'M1.fixedAnswer').detail).toBe(true)
  })

  it('C1: an agreement on the wrong answer is a chain break only under s3-criteria/2', () => {
    const wrong = withWrongAnswerEverywhere(record, WRONG_ANSWER)
    const input: Input = { record: wrong, adjudication: requoted(adjudication) }
    const decisions = bothDecisions(input)
    observe('C1', 'desk answer = tool result = session-log tool/result = the same wrong text; input.fixedAnswer is the frozen one', input, decisions)

    // Revision 1 reads the three places as consistent with each other, and the
    // frozen answer is never consulted: it passes the trajectory.
    expect(decisions.frozen.facts.chains.map(entry => entry.status), detail(decisions.frozen)).toEqual(['complete'])
    expect(decisions.frozen.verdict, `the defect: ${detail(decisions.frozen)}`).toBe('pass')

    // The revision compares each place with record.input.fixedAnswer: the chain
    // breaks, M1 fails and the verdict is a mechanical `fail`.
    const rev2Chain = decisions.rev2.facts.chains[0]!
    expect(rev2Chain.status).toBe('inconsistent')
    expect(rev2Chain.detail).toContain(JSON.stringify(FIXED_ANSWER))
    expect(rev2Chain.detail).toContain(JSON.stringify(WRONG_ANSWER))
    expect(checkOf(decisions.rev2, 'M1.chain').ok).toBe(false)
    expect(checkOf(decisions.rev2, 'M1.chain').detail).toContain(JSON.stringify(FIXED_ANSWER))
    expect(checkOf(decisions.rev2, 'M1.fixedAnswer').ok, checkOf(decisions.rev2, 'M1.fixedAnswer').detail).toBe(false)
    expect(checkOf(decisions.rev2, 'M1.fixedAnswer').detail).toContain(JSON.stringify(WRONG_ANSWER))
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('fail')
    expect(decisions.rev2.reasons.join(' ')).toContain('M1')
    expect(decisions.rev2.reasons.join(' ')).toContain(JSON.stringify(FIXED_ANSWER))
  })

  it('C1b: without input.fixedAnswer the leg is unverified, so s3-criteria/2 never passes', () => {
    const input: Input = { record: withoutFixedAnswer(record), adjudication }
    const decisions = bothDecisions(input)
    observe('C1b', 'the same real record with no input.fixedAnswer', input, decisions)

    expect(decisions.frozen.facts.chains.map(entry => entry.status)).toEqual(['complete'])
    expect(decisions.frozen.verdict, `the defect: ${detail(decisions.frozen)}`).toBe('pass')

    const check = checkOf(decisions.rev2, 'M1.fixedAnswer')
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('fixedAnswer')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).not.toBe('pass')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('inconclusive')
    expect(decisions.rev2.reasons.join(' ')).toContain('M1.fixedAnswer')
  })

  it('C2 control: with every required criterion passing, both modules pass', () => {
    const input: Input = { record, adjudication }
    const decisions = bothDecisions(input)
    observe('C2-control', 'the paid run\'s record: ac-1…ac-4 all pass, the adjudicated criteria ac-1…ac-3 pass', input, decisions)

    expect(decisions.frozen.verdict, detail(decisions.frozen)).toBe('pass')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('pass')
    expect(checkOf(decisions.rev2, 'M3.verifierPass').ok).toBe(true)
    expect(checkOf(decisions.rev2, 'M3.verifierPass').detail).toContain('ac-1')
    expect(checkOf(decisions.rev2, 'M3.verifierPass').detail).toContain('ac-4')
  })

  it('C2a: a missing required criterion is offset by another pass only under s3-criteria/1', () => {
    const input: Input = { record: withoutVerifierResult(record, REQUIRED_CRITERION), adjudication }
    const decisions = bothDecisions(input)
    observe('C2a', `the real record without the verifier result for ${REQUIRED_CRITERION}`, input, decisions)

    expect(decisions.frozen.verdict, `the defect: ${detail(decisions.frozen)}`).toBe('pass')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('fail')
    const check = checkOf(decisions.rev2, 'M3.verifierPass')
    expect(check.ok, check.detail).toBe(false)
    expect(check.detail).toContain(REQUIRED_CRITERION)
    expect(check.detail).toContain('missing')
    expect(decisions.rev2.reasons.join(' ')).toContain('M3')
    expect(decisions.rev2.reasons.join(' ')).toContain(REQUIRED_CRITERION)
  })

  it('C2b: a failing required criterion is offset by another pass only under s3-criteria/1', () => {
    const input: Input = { record: withVerifierStatus(record, REQUIRED_CRITERION, 'fail'), adjudication }
    const decisions = bothDecisions(input)
    observe('C2b', `the real record with ${REQUIRED_CRITERION} flipped to fail`, input, decisions)

    expect(decisions.frozen.verdict, `the defect: ${detail(decisions.frozen)}`).toBe('pass')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('fail')
    const check = checkOf(decisions.rev2, 'M3.verifierPass')
    expect(check.ok, check.detail).toBe(false)
    expect(check.detail).toContain(REQUIRED_CRITERION)
    expect(check.detail).toContain('not passing')
    expect(decisions.rev2.reasons.join(' ')).toContain(REQUIRED_CRITERION)
  })

  it('C2c: an adjudicated criterion with no result at all is required too', () => {
    const extended: S3Adjudication = {
      ...adjudication,
      goal: { ...adjudication.goal!, criteria: [...(adjudication.goal?.criteria ?? []), 'ac-9'] },
    }
    const input: Input = { record, adjudication: extended }
    const decisions = bothDecisions(input)
    observe('C2c', 'the real record; the adjudication names ac-9, which has no verifier result', input, decisions)

    expect(decisions.frozen.verdict, `the defect: ${detail(decisions.frozen)}`).toBe('pass')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('fail')
    const check = checkOf(decisions.rev2, 'M3.verifierPass')
    expect(check.ok, check.detail).toBe(false)
    expect(check.detail).toContain('ac-9')
    expect(check.detail).toContain('missing')
    // The contract's own criteria still all pass: the failure is the missing
    // required criterion alone, never another criterion's offset.
    expect(check.detail).toContain('ac-1')
    expect(check.detail).toContain('ac-4')
  })

  it('C2d: with a delivery claimed and no required criterion establishable, s3-criteria/2 refuses a pass', () => {
    const bare = clone(record) as unknown as MutableRecord
    const contract = bare['rootContract'] as MutableRecord
    contract['acceptanceCriteria'] = []
    ;((bare['ids'] as MutableRecord)['rootContract'] as MutableRecord)['acceptanceCriteria'] = []
    const input: Input = {
      record: bare as unknown as S3EvidenceRecord,
      adjudication: { ...adjudication, goal: { ...adjudication.goal!, criteria: [] } },
    }
    const decisions = bothDecisions(input)
    observe('C2d', 'delivery claimed, no required criterion in the adjudication or the contract', input, decisions)

    expect(decisions.frozen.verdict, `the defect: ${detail(decisions.frozen)}`).toBe('pass')
    const check = checkOf(decisions.rev2, 'M3.verifierPass')
    expect(check.ok, check.detail).toBe(false)
    expect(check.detail).toContain('required criterion')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('inconclusive')
  })

  it('C2e: an extra required criterion absent from the evidence leaves the contract criteria all passing under the revision too', () => {
    // The control for C2c: the same extended adjudication, with ac-9 now really
    // verified, passes under both modules — the revision rejects only what is
    // missing or failing.
    const verified = clone(record) as unknown as MutableRecord
    const results = rootResults(verified as unknown as S3EvidenceRecord)
    results.push({ criterionId: 'ac-9', verifierId: 'command', status: 'pass', command: 'true', exitCode: 0 })
    const input: Input = {
      record: verified as unknown as S3EvidenceRecord,
      adjudication: { ...adjudication, goal: { ...adjudication.goal!, criteria: [...(adjudication.goal?.criteria ?? []), 'ac-9'] } },
    }
    const decisions = bothDecisions(input)
    observe('C2e', 'the same extended adjudication, with ac-9 verified as passing', input, decisions)

    expect(decisions.frozen.verdict, detail(decisions.frozen)).toBe('pass')
    expect(decisions.rev2.verdict, detail(decisions.rev2)).toBe('pass')
  })
})

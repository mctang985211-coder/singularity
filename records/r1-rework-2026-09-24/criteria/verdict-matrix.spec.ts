/**
 * The verdict matrix: every (record, adjudication) pair this round has, decided
 * by **both** criteria versions — the frozen `s3-criteria/1`
 * (`r1-supplemental-2026-09-24/driver/s3-criteria.ts`, read-only) and the
 * revision `s3-criteria/2` (`./s3-criteria-rev2.ts`).
 *
 * The matrix is written to `criteria/verdicts/matrix.json`, one cell per
 * (pair × criteria version), together with the raw inputs the spec read (paths
 * and sha256) so a reviewer can recompute every cell from the record and the
 * adjudication alone.
 *
 * Records:
 * - `original-s3` — the original failing trajectory,
 *   `r1-evidence-2026-09-23/s3/driver.json`, replayed with the session log that
 *   tree archived (the record itself carries none).
 * - `s3-run` — this round's paid attempt,
 *   `r1-supplemental-2026-09-24/evidence/s3/driver.json`, replayed with the
 *   session logs it carries.
 *
 * Adjudications: the archive's own `original-s3.json` and `s3-run.json`, plus
 * every `*.json` that is present in `r1-rework-2026-09-24/adjudication/` at run
 * time — a re-judgment file another agent drops there is picked up with no edit
 * to this spec. A discovered adjudication is paired to the record its `subject`
 * names when that is decidable (the historical path, its record's sha256, or
 * `original-s3` versus the current path, its sha256, or `s3-run` when only one
 * matches), and otherwise to `s3-run`; the pairing is stated in the cell.
 *
 * The frozen contract's pinned expectations are asserted here and fail loudly
 * when they do not hold:
 * - `original-s3` + its adjudication ⇒ `fail` under **both** versions;
 * - `s3-run` + its adjudication ⇒ `pass` under **both** versions (the two fixes
 *   must not change that record's mechanical facts).
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decideS3 as decideFrozen } from '../../r1-supplemental-2026-09-24/driver/s3-criteria.ts'
import type { S3Adjudication, S3Decision, S3EvidenceRecord } from '../../r1-supplemental-2026-09-24/driver/s3-criteria.ts'
import { decideS3 as decideRev2 } from './s3-criteria-rev2.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-rework-2026-09-24'
const VERDICTS = join(WORKDIR, 'criteria/verdicts')
const REWORK_ADJUDICATIONS = join(WORKDIR, 'adjudication')
const ARCHIVE = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const HISTORICAL = '/home/ROXY/code/bb_work/r1-evidence-2026-09-23'
const FROZEN_MODULE = join(ARCHIVE, 'driver/s3-criteria.ts')
const REV2_MODULE = join(WORKDIR, 'criteria/s3-criteria-rev2.ts')

interface RecordSpec {
  readonly name: string
  readonly path: string
  /** The session log the record itself does not carry, when the evidence tree archived it separately. */
  readonly sessionLog?: { readonly sessionId: string; readonly path: string }
  /** Strings that identify this record inside an adjudication's `subject`. */
  readonly subjectHints: readonly string[]
}

const ORIGINAL: RecordSpec = {
  name: 'original-s3',
  path: join(HISTORICAL, 's3/driver.json'),
  sessionLog: { sessionId: 's-root', path: join(HISTORICAL, 's3/dsh-home/session-log/s-root.jsonl') },
  subjectHints: ['original-s3', 'r1-evidence-2026-09-23', '349e6615f48bf096bf3e8d09f4185ed463bfa86e4330c9493082661d800c452a'],
}

const S3_RUN: RecordSpec = {
  name: 's3-run',
  path: join(ARCHIVE, 'evidence/s3/driver.json'),
  subjectHints: ['r1-supplemental-2026-09-24', 'b8c9bb9db592266f921641c84d0daaad706524cf41248b48f6a76811889c5621'],
}

const RECORDS: readonly RecordSpec[] = [ORIGINAL, S3_RUN]

/** The adjudications the archive froze for the two records. */
const ARCHIVE_ADJUDICATIONS: readonly { readonly file: string; readonly path: string; readonly record: string }[] = [
  { file: 'original-s3.json', path: join(ARCHIVE, 'evidence/adjudication/original-s3.json'), record: 'original-s3' },
  { file: 's3-run.json', path: join(ARCHIVE, 'evidence/adjudication/s3-run.json'), record: 's3-run' },
]

const CRITERIA: readonly { readonly version: 's3-criteria/1' | 's3-criteria/2'; readonly path: string; readonly decide: (input: { record: S3EvidenceRecord; adjudication: S3Adjudication; sessionLogs?: Readonly<Record<string, string>> }) => S3Decision }[] = [
  { version: 's3-criteria/1', path: FROZEN_MODULE, decide: decideFrozen },
  { version: 's3-criteria/2', path: REV2_MODULE, decide: decideRev2 },
]

interface Pair {
  readonly record: RecordSpec
  readonly adjudicationFile: string
  readonly adjudicationPath: string
  readonly pairing: 'archive' | 'subject' | 'default'
  readonly subject: string | null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** The record a discovered adjudication names in its `subject`, when that is decidable. */
function pairDiscovered(file: string, path: string, adjudication: S3Adjudication): Pair {
  const subject = typeof adjudication.subject === 'string' ? adjudication.subject : null
  const named = subject === null ? [] : RECORDS.filter(record => record.subjectHints.some(hint => subject.includes(hint)))
  const [record] = named.length === 1 ? named : []
  return {
    record: record ?? S3_RUN,
    adjudicationFile: file,
    adjudicationPath: path,
    pairing: record === undefined ? 'default' : 'subject',
    subject,
  }
}

/** Every pair this run decides: the archive's two, plus everything in the rework tree's `adjudication/`. */
function pairs(): Pair[] {
  const pairs: Pair[] = ARCHIVE_ADJUDICATIONS.map(item => ({
    record: RECORDS.find(record => record.name === item.record)!,
    adjudicationFile: item.file,
    adjudicationPath: item.path,
    pairing: 'archive' as const,
    subject: null,
  }))
  const discovered = readdirSync(REWORK_ADJUDICATIONS).filter(name => name.endsWith('.json')).sort()
  for (const file of discovered) {
    const path = join(REWORK_ADJUDICATIONS, file)
    pairs.push(pairDiscovered(file, path, readJson<S3Adjudication>(path)))
  }
  return pairs
}

interface Cell {
  readonly record: string
  readonly recordPath: string
  readonly recordSha256: string
  readonly adjudicationFile: string
  readonly adjudicationSha256: string
  readonly pairing: string
  readonly criteria: string
  readonly criteriaSha256: string
  readonly verdict: string
  readonly path: string
  readonly reasons: readonly string[]
  /** The checks that did not hold, plus the two checks the revision adds. */
  readonly checks: Readonly<Record<string, { readonly ok: boolean; readonly detail: string }>>
  readonly decidedAt: string
}

const matrix: { inputs: Record<string, unknown>; cells: Cell[]; pairing: Record<string, string> } = {
  inputs: {},
  cells: [],
  pairing: {},
}

/** Decide one pair with both criteria versions and record both cells. */
function decidePair(pair: Pair): { readonly frozen: Cell; readonly rev2: Cell } {
  const recordText = readFileSync(pair.record.path, 'utf8')
  const adjudicationText = readFileSync(pair.adjudicationPath, 'utf8')
  const record = JSON.parse(recordText) as S3EvidenceRecord
  const adjudication = JSON.parse(adjudicationText) as S3Adjudication
  const sessionLogs = pair.record.sessionLog === undefined
    ? undefined
    : { [pair.record.sessionLog.sessionId]: readFileSync(pair.record.sessionLog.path, 'utf8') }

  const cells = CRITERIA.map(criteria => {
    const decision = criteria.decide({ record, adjudication, ...(sessionLogs === undefined ? {} : { sessionLogs }) })
    // Every check that did not hold, plus the four mechanical keys the two
    // defects touch, so the matrix shows both what failed and what the fixed
    // checks read on the cells that pass.
    const mechanicalKeys = new Set(['M1.chain', 'M1.accounted', 'M1.fixedAnswer', 'M3.verifierPass'])
    const checks: Record<string, { readonly ok: boolean; readonly detail: string }> = {}
    for (const [name, check] of Object.entries(decision.checks)) {
      if (check.ok === true && !mechanicalKeys.has(name)) continue
      checks[name] = { ok: check.ok, detail: check.detail }
    }
    return {
      record: pair.record.name,
      recordPath: pair.record.path,
      recordSha256: sha256(recordText),
      adjudicationFile: pair.adjudicationFile,
      adjudicationSha256: sha256(adjudicationText),
      pairing: pair.pairing,
      criteria: criteria.version,
      criteriaSha256: sha256(readFileSync(criteria.path, 'utf8')),
      verdict: decision.verdict,
      path: decision.path,
      reasons: decision.reasons,
      checks,
      decidedAt: new Date().toISOString(),
    } satisfies Cell
  })
  matrix.pairing[`${pair.record.name} <- ${pair.adjudicationFile}`] = `${pair.pairing}${pair.subject === null ? '' : ` (subject: ${pair.subject.slice(0, 120)}${pair.subject.length > 120 ? '…' : ''})`}`
  matrix.cells.push(...cells)
  return { frozen: cells[0]!, rev2: cells[1]! }
}

const decided = new Map<string, { frozen: Cell; rev2: Cell }>()

afterAll(() => {
  matrix.inputs = {
    records: RECORDS.map(record => ({
      name: record.name,
      path: record.path,
      sha256: sha256(readFileSync(record.path, 'utf8')),
      ...(record.sessionLog === undefined ? {} : { sessionLog: { ...record.sessionLog, sha256: sha256(readFileSync(record.sessionLog.path, 'utf8')) } }),
    })),
    adjudications: pairs().map(pair => ({
      file: pair.adjudicationFile,
      path: pair.adjudicationPath,
      sha256: sha256(readFileSync(pair.adjudicationPath, 'utf8')),
      pairedWith: pair.record.name,
      pairing: pair.pairing,
      subject: pair.subject,
    })),
    criteria: CRITERIA.map(criteria => ({ version: criteria.version, path: criteria.path, sha256: sha256(readFileSync(criteria.path, 'utf8')) })),
  }
  mkdirSync(VERDICTS, { recursive: true })
  writeFileSync(join(VERDICTS, 'matrix.json'), `${JSON.stringify({ writtenAt: new Date().toISOString(), ...matrix }, null, 2)}\n`, 'utf8')
})

describe('s3-criteria verdict matrix (frozen /1 vs revision /2)', () => {
  const all = pairs()

  it('decides every pair with both criteria versions', () => {
    expect(all.length, 'no (record, adjudication) pair was found').toBeGreaterThanOrEqual(2)
    for (const pair of all) {
      decided.set(`${pair.record.name} <- ${pair.adjudicationFile}`, decidePair(pair))
    }
    expect(matrix.cells.length).toBe(all.length * CRITERIA.length)
    expect(readdirSync(REWORK_ADJUDICATIONS).filter(name => name.endsWith('.json')).length, 'a discovered adjudication was dropped')
      .toBe(all.length - ARCHIVE_ADJUDICATIONS.length)
  })

  it('rejects the original S3 trajectory under both criteria versions', () => {
    const cells = decided.get('original-s3 <- original-s3.json')!
    expect(cells, 'the original trajectory was not decided').toBeDefined()
    expect(cells.frozen.verdict, `frozen: ${cells.frozen.reasons.join(' | ')}`).toBe('fail')
    expect(cells.rev2.verdict, `rev2: ${cells.rev2.reasons.join(' | ')}`).toBe('fail')
    expect(cells.frozen.checks['S1.freeze']?.ok).toBe(false)
    expect(cells.rev2.checks['S1.freeze']?.ok).toBe(false)
  })

  it('passes this round\'s paid S3 run under both criteria versions', () => {
    const cells = decided.get('s3-run <- s3-run.json')!
    expect(cells, 'the paid run was not decided').toBeDefined()
    expect(cells.frozen.verdict, `frozen: ${cells.frozen.path} ${cells.frozen.reasons.join(' | ')}`).toBe('pass')
    expect(cells.frozen.path).toBe('path2-limited-goal')
    expect(cells.rev2.verdict, `rev2: ${cells.rev2.path} ${cells.rev2.reasons.join(' | ')}`).toBe('pass')
    expect(cells.rev2.path).toBe('path2-limited-goal')
    // The two fixes must not change this record's mechanical facts.
    expect(cells.rev2.checks['M3.verifierPass']?.ok, JSON.stringify(cells.rev2.checks['M3.verifierPass'])).toBe(true)
  })

  it('states a decidable pairing for every discovered adjudication', () => {
    for (const [key, pairing] of Object.entries(matrix.pairing)) {
      expect(pairing.length, `${key} has no pairing`).toBeGreaterThan(0)
    }
    expect(Object.keys(matrix.pairing).length).toBe(all.length)
  })
})

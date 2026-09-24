/**
 * Post-run judging for the R1 completion round: the frozen criteria module
 * (`driver/s3-criteria.ts`, `s3-criteria/2`) decides the attempt from its raw
 * record plus the independent semantic adjudication. No model call, no network.
 *
 *   cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
 *     --config /home/ROXY/code/bb_work/r1-final-2026-09-24/judge/vitest.r1-judge.config.ts
 *
 * It writes `evidence/criteria-replay/s3-run.json` (verdict, path, reasons,
 * checks, and the sha256 of every input it read) and asserts only the frozen
 * criteria hash — the verdict itself is recorded, not asserted, so a `fail` is
 * preserved as a `fail`.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideS3 } from '../driver/s3-criteria.ts'
import type { S3Adjudication, S3EvidenceRecord } from '../driver/s3-criteria.ts'

const ROOT = '/home/ROXY/code/bb_work/r1-final-2026-09-24'
const CRITERIA = join(ROOT, 'driver', 's3-criteria.ts')
const RECORD = join(ROOT, 'evidence', 's3', 'driver.json')
const ADJUDICATION = join(ROOT, 'evidence', 'adjudication', 's3-run.json')
const OUT = join(ROOT, 'evidence', 'criteria-replay', 's3-run.json')

/** The frozen criteria hash, recorded in fixtures/frozen-contract.json at freeze time. */
const FROZEN_CRITERIA_SHA256 = '83d9ee3141c52f0548c62b3e9cf68c6af7d006d5d08a859b37ff0baee602d1c9'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('r1 completion round: the frozen criteria decide the attempt', () => {
  it('decides the archived attempt from its record and the independent adjudication', () => {
    expect(sha256(CRITERIA), 'the criteria module is the frozen s3-criteria/2').toBe(FROZEN_CRITERIA_SHA256)
    expect(existsSync(RECORD), 'the attempt wrote its record').toBe(true)
    expect(existsSync(ADJUDICATION), 'the independent adjudication exists').toBe(true)

    const record = JSON.parse(readFileSync(RECORD, 'utf8')) as S3EvidenceRecord
    const adjudication = JSON.parse(readFileSync(ADJUDICATION, 'utf8')) as S3Adjudication
    const decision = decideS3({ record, adjudication, sessionLogs: record.sessionLogs })

    mkdirSync(join(ROOT, 'evidence', 'criteria-replay'), { recursive: true })
    writeFileSync(OUT, `${JSON.stringify({
      decidedAt: new Date().toISOString(),
      decidedBy: 'judge/judge.spec.ts (frozen s3-criteria/2, no model call)',
      inputs: {
        criteria: { path: CRITERIA, sha256: sha256(CRITERIA) },
        record: { path: RECORD, sha256: sha256(RECORD) },
        adjudication: { path: ADJUDICATION, sha256: sha256(ADJUDICATION) },
      },
      decision,
    }, null, 2)}\n`, 'utf8')

    console.log(`VERDICT: ${decision.verdict} | PATH: ${decision.path}`)
    console.log(`REASONS: ${JSON.stringify(decision.reasons)}`)
    for (const [name, check] of Object.entries(decision.checks)) {
      if (!check.ok) console.log(`CHECK ${name} NOT OK: ${check.detail}`)
    }
  })
})

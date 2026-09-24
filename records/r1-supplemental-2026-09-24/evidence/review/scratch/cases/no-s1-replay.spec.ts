/**
 * Reviewer's control for the replay case: with S1 removed but S2 intact, the
 * replay's verdict is still `fail` — the frozen replay test's fail is carried by
 * S1 and S2 jointly, and it is the explicit `S1.freeze.ok === false` assertion
 * that pins S1 on its own.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideS3 } from '../mutants/no-s1/s3-criteria.ts'
import type { S3Adjudication, S3EvidenceRecord } from '../mutants/no-s1/s3-criteria.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const HISTORICAL = '/home/ROXY/code/bb_work/r1-evidence-2026-09-23'

describe('reviewer control: no-s1 mutant on the original trajectory', () => {
  it('still fails on S2 alone', () => {
    const record = JSON.parse(readFileSync(`${HISTORICAL}/s3/driver.json`, 'utf8')) as S3EvidenceRecord
    const adjudication = JSON.parse(readFileSync(`${WORKDIR}/evidence/adjudication/original-s3.json`, 'utf8')) as S3Adjudication
    const decision = decideS3({
      record,
      adjudication,
      sessionLogs: { [String(record.ids?.rootSessionId ?? 's-root')]: readFileSync(`${HISTORICAL}/s3/dsh-home/session-log/s-root.jsonl`, 'utf8') },
    })
    console.log(`no-s1 mutant on the original trajectory: verdict=${decision.verdict} S1.freeze=${String(decision.checks['S1.freeze']!.ok)} S2.dependency=${String(decision.checks['S2.dependency']!.ok)} reasons=${JSON.stringify(decision.reasons)}`)
    expect(decision.checks['S1.freeze']!.ok).toBe(true)
    expect(decision.checks['S2.dependency']!.ok).toBe(false)
    expect(decision.verdict).toBe('fail')
  })
})

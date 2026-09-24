/**
 * Reviewer's strict check of the authoritative adjudication
 * `evidence/adjudication/original-s3.json` against the historical record.
 *
 * Independent of the driver's replay spec: it reads the same two files but
 * asserts the citation ledger itself (every claim resolves) and prints it, so
 * the adjudication can be judged before the replay runs.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideS3 } from '../../../../driver/s3-criteria.ts'
import type { S3Adjudication, S3EvidenceRecord } from '../../../../driver/s3-criteria.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const ORIGINAL_RECORD = '/home/ROXY/code/bb_work/r1-evidence-2026-09-23/s3/driver.json'
const ORIGINAL_LOG = '/home/ROXY/code/bb_work/r1-evidence-2026-09-23/s3/dsh-home/session-log/s-root.jsonl'

describe('reviewer: the authoritative adjudication of the original S3 trajectory', () => {
  it('resolves every citation and yields fail', () => {
    const record = JSON.parse(readFileSync(ORIGINAL_RECORD, 'utf8')) as S3EvidenceRecord
    const adjudication = JSON.parse(readFileSync(`${WORKDIR}/evidence/adjudication/original-s3.json`, 'utf8')) as S3Adjudication
    const decision = decideS3({
      record,
      adjudication,
      sessionLogs: { [String(record.ids?.rootSessionId ?? 's-root')]: readFileSync(ORIGINAL_LOG, 'utf8') },
    })

    console.log(`adjudication: draft=${String(adjudication.draft)} reviewer=${String(adjudication.reviewer)}`)
    console.log(`kind=${decision.facts.adjudication} verdict=${decision.verdict} path=${decision.path}`)
    console.log(`conditions=${JSON.stringify(decision.facts.conditions)}`)
    console.log(`chains=${JSON.stringify(decision.facts.chains)}`)
    console.log(`citations:\n${decision.facts.citations.map(item => `  ${item.resolved ? 'RESOLVED' : 'UNRESOLVED'} ${item.of} :: ${item.detail}`).join('\n')}`)
    console.log(`reasons:\n${decision.reasons.map(reason => `  - ${reason}`).join('\n')}`)

    expect(adjudication.draft).not.toBe(true)
    expect(decision.facts.adjudication).toBe('authoritative')
    // `unknown` labels carry no citation by design; every claim that does cite must resolve.
    const claimedCitations = decision.facts.citations.filter(item => item.detail !== 'no citation')
    expect(claimedCitations.length).toBeGreaterThanOrEqual(6)
    expect(claimedCitations.every(item => item.resolved), JSON.stringify(decision.facts.citations, null, 1)).toBe(true)
    expect(decision.facts.chains.map(entry => entry.status)).toEqual(['unavailable'])
    expect(decision.facts.clarificationUnavailable).toBe(true)
    expect(decision.facts.rootTerminal).toBe('failed')
    expect(decision.facts.deliveryClaimed).toBe(false)
    expect(decision.checks['S1.freeze']!.ok).toBe(false)
    expect(decision.checks['S2.dependency']!.ok).toBe(false)
    expect(decision.verdict).toBe('fail')
  })
})

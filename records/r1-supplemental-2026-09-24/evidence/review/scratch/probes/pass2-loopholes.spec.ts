/**
 * Pass 2 loophole probes on the paid record itself (characterization tests).
 *
 * A: the M3 content leg is conditioned on a delivery claim (§4.1 "if the run
 *    claims delivery … otherwise fail"). A run that ends non-verified with a
 *    review that *states* the artifact does not match the goal is therefore not
 *    rejected — `claimsDelivery: false` / a non-verified terminal makes M3
 *    vacuous. Faithful to §4.1's conditioning; recorded because it is the
 *    remaining way a bad artifact escapes M3, and the mitigation is the review's
 *    own `claimsDelivery` statement.
 * B: the retention label only has to cite something that resolves (the §4.2
 *    design): the paid record still passes if the quarter's retention cites the
 *    user's own message instead of the contract's retention clause.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideS3 } from '../../../../driver/s3-criteria.ts'
import type { S3Adjudication, S3EvidenceRecord } from '../../../../driver/s3-criteria.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const record = JSON.parse(readFileSync(`${WORKDIR}/evidence/s3/driver.json`, 'utf8')) as S3EvidenceRecord
const adjudication = JSON.parse(readFileSync(`${WORKDIR}/evidence/adjudication/s3-run.json`, 'utf8')) as S3Adjudication

describe('pass 2 loophole probes (paid record)', () => {
  it('PROBE E: an explicitly mismatching artifact passes when the run claims no delivery', () => {
    const notDelivered: S3EvidenceRecord = { ...record, rootTerminal: { status: 'failed' } }
    const decision = decideS3({
      record: notDelivered,
      adjudication: { ...adjudication, claimsDelivery: false, artifactMatchesGoal: false },
      sessionLogs: notDelivered.sessionLogs,
    })
    console.log(`PROBE E: verdict=${decision.verdict} path=${decision.path} deliveryClaimed=${decision.facts.deliveryClaimed}`)
    console.log(`  M3.content.ok=${decision.checks['M3.content']!.ok} :: ${decision.checks['M3.content']!.detail}`)
    console.log(`  reasons=${JSON.stringify(decision.reasons)}`)
    expect(decision.facts.deliveryClaimed).toBe(false)
    expect(decision.checks['M3.content']!.ok).toBe(true)
    expect(decision.verdict).toBe('pass')
  })

  it('PROBE F: a retention citation that resolves is enough, whatever it says', () => {
    const decision = decideS3({
      record,
      adjudication: {
        ...adjudication,
        conditions: {
          ...adjudication.conditions,
          quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'Create report.txt summarizing the quarter.' } },
        },
      },
      sessionLogs: record.sessionLogs,
    })
    console.log(`PROBE F: verdict=${decision.verdict} path=${decision.path}`)
    console.log(`  citation: ${JSON.stringify(decision.facts.citations.find(item => item.of.startsWith('conditions.quarter')))}`)
    expect(decision.verdict).toBe('pass')
  })
})

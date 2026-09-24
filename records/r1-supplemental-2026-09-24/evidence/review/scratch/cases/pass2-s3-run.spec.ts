/**
 * Pass 2: decide the paid S3 run with the frozen criteria and the reviewer's
 * independent adjudication, and record the decision.
 *
 * Reads `evidence/s3/driver.json` + `evidence/adjudication/s3-run.json`, calls
 * `decideS3` (the frozen module, read-only), writes the decision to
 * `evidence/criteria-replay/s3-run.json`, and runs the F1 counterfactual (the
 * same record with `artifactMatchesGoal: false`) to show the amended M3 content
 * leg now rejects an explicit mismatch.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideS3 } from '../../../../driver/s3-criteria.ts'
import type { S3Adjudication, S3Decision, S3EvidenceRecord } from '../../../../driver/s3-criteria.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const RECORD_PATH = `${WORKDIR}/evidence/s3/driver.json`
const ADJUDICATION_PATH = `${WORKDIR}/evidence/adjudication/s3-run.json`
const OUT_PATH = `${WORKDIR}/evidence/criteria-replay/s3-run.json`

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const summarize = (decision: S3Decision) => ({
  verdict: decision.verdict,
  path: decision.path,
  checks: Object.fromEntries(Object.entries(decision.checks).map(([name, check]) => [name, { ok: check.ok, detail: check.detail }])),
  reasons: decision.reasons,
  facts: decision.facts,
})

describe('pass 2: the paid S3 run against the frozen criteria', () => {
  it('decides the run, records the decision, and flips on the F1 counterfactual', () => {
    const recordText = readFileSync(RECORD_PATH, 'utf8')
    const adjudicationText = readFileSync(ADJUDICATION_PATH, 'utf8')
    const record = JSON.parse(recordText) as S3EvidenceRecord
    const adjudication = JSON.parse(adjudicationText) as S3Adjudication

    const decision = decideS3({ record, adjudication, sessionLogs: record.sessionLogs })
    console.log(`verdict=${decision.verdict} path=${decision.path}`)
    console.log(`checks: ${Object.entries(decision.checks).map(([name, check]) => `${name}=${check.ok}`).join(' ')}`)
    console.log(`reasons: ${JSON.stringify(decision.reasons, null, 1)}`)
    console.log(`chains: ${JSON.stringify(decision.facts.chains.map(entry => ({ callId: entry.callId, status: entry.status, detail: entry.detail })), null, 1)}`)
    console.log(`citations:\n${decision.facts.citations.map(item => `  ${item.resolved ? 'RESOLVED' : 'UNRESOLVED'} ${item.of} :: ${item.detail}`).join('\n')}`)
    console.log(`deliveryClaimed=${decision.facts.deliveryClaimed} artifactBytes=${decision.facts.artifactBytes} verifierPasses=${JSON.stringify(decision.facts.verifierPasses)}`)
    console.log(`adjudication=${decision.facts.adjudication} conditions=${JSON.stringify(decision.facts.conditions)}`)

    // The F1 counterfactual: an explicit "the artifact does not match the goal".
    const flipped = decideS3({
      record,
      adjudication: { ...adjudication, artifactMatchesGoal: false },
      sessionLogs: record.sessionLogs,
    })
    console.log(`counterfactual artifactMatchesGoal=false: verdict=${flipped.verdict} path=${flipped.path}`)
    console.log(`counterfactual reasons: ${JSON.stringify(flipped.reasons)}`)

    writeFileSync(OUT_PATH, `${JSON.stringify({
      decidedAt: new Date().toISOString(),
      decidedBy: 'r1-criteria-review (independent reviewer), via driver/s3-criteria.ts decideS3',
      record: { path: RECORD_PATH, sha256: sha256(recordText) },
      adjudication: { path: ADJUDICATION_PATH, sha256: sha256(adjudicationText), draft: adjudication.draft === true },
      decision: summarize(decision),
      counterfactual: {
        of: 'artifactMatchesGoal flipped to false with the same record and review',
        reason: 'the §5a amendment: an explicit content mismatch under a delivery claim must fail',
        decision: { verdict: flipped.verdict, path: flipped.path, reasons: flipped.reasons, checks: { 'M3.content': flipped.checks['M3.content'] } },
      },
    }, null, 2)}\n`, 'utf8')

    expect(decision.facts.adjudication).toBe('authoritative')
    expect(decision.facts.citations.every(item => item.detail === 'no citation' || item.resolved)).toBe(true)
    expect(decision.facts.chains.map(entry => entry.status)).toEqual(['complete'])
    expect(decision.verdict).toBe('pass')
    expect(decision.path).toBe('path2-limited-goal')
    expect(flipped.verdict).toBe('fail')
    expect(flipped.checks['M3.content']!.ok).toBe(false)
  })
})

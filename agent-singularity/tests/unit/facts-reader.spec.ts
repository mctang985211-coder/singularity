/**
 * The coordination plane's facts, as the one read model reduces them: rows in,
 * wire out. A review work item is not a round and is never counted into the
 * progress a graph reports.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { assignmentFactsOf, coordinationFactsReader, diagnosisIdOf, workOfDiagnosis } from '../../src/coordination/facts-reader.ts'
import { assignmentOf } from '../../src/coordination/assignment.ts'
import { roundKeyOf } from '../../src/coordination/reducer.ts'
import { appendAssignment, recordCompletion, type CoordinationRow } from '../../src/coordination/store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-facts-'))
  vi.stubEnv('SINGULARITY_COORDINATION_DIR', dir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const roundKey = (businessRound: number) =>
  roundKeyOf({ graphId: 'g1', epoch: 1, businessRound, taskId: 't-root', runId: `r-${businessRound}` })

function roundRow(businessRound: number, sessionId: string): CoordinationRow {
  return assignmentOf(
    {
      key: roundKey(businessRound),
      storeId: 'sg-t-root',
      sessionId: sessionId as never,
      actor: 's-root',
      digest: `digest-${businessRound}`,
      focus: null,
    },
    `2026-10-08T00:0${businessRound}:00.000Z`,
  )
}

function reviewRow(sessionId: string): CoordinationRow {
  return assignmentOf(
    {
      key: {
        graphId: 'g1',
        epoch: 1,
        role: 'reviewer',
        subject: { kind: 'review', businessRound: 1, source: { taskId: 't-1', runId: 'r-1' }, requestKey: null },
      },
      storeId: 'sg-t-root',
      sessionId: sessionId as never,
      actor: 's-root',
      digest: 'review-digest',
      focus: 'why did it fail',
    },
    '2026-10-08T00:03:00.000Z',
  )
}

describe('the assignment facts', () => {
  test('a round assignment reads as the wire, with the round and the source it names', () => {
    const facts = assignmentFactsOf([roundRow(1, 's-1')], 'sg-t-root')
    expect(facts).toEqual([
      {
        assignmentId: 's-1',
        role: 'supervisor',
        round: 1,
        sessionId: 's-1',
        sourceTaskId: 't-root',
        sourceRunId: 'r-1',
        state: 'open',
      },
    ])
  })

  test('a settled completion carries only the fields the wire declares', () => {
    const rows: CoordinationRow[] = [
      roundRow(1, 's-1'),
      {
        formatVersion: 1,
        kind: 'completion',
        graphId: 'g1',
        storeId: 'sg-t-root',
        epoch: 1,
        role: 'supervisor',
        sessionId: 's-1',
        result: {
          kind: 'completed',
          businessAction: 'finish',
          reason: 'nothing further is justified',
          evidenceRefs: ['t-root#r-1'],
          trialCandidateRef: null,
          methodDecision: 'retain',
          searchNext: 'stop',
          approval: { source: 'human', ref: 'approval:1' },
        },
        at: '2026-10-08T00:05:00.000Z',
      },
    ]
    expect(assignmentFactsOf(rows, 'sg-t-root')[0]).toMatchObject({
      state: 'settled',
      completion: {
        businessAction: 'finish',
        searchNext: 'stop',
        methodDecision: 'retain',
        approval: { kind: 'human' },
        at: '2026-10-08T00:05:00.000Z',
      },
    })
  })

  test('an interrupted or protocol-failed work item reads as interrupted, never as a settled round', () => {
    const rows: CoordinationRow[] = [
      roundRow(1, 's-1'),
      {
        formatVersion: 1,
        kind: 'completion',
        graphId: 'g1',
        storeId: 'sg-t-root',
        epoch: 1,
        role: 'supervisor',
        sessionId: 's-1',
        result: { kind: 'protocol-failure', detail: 'ended without the tool' },
        at: '2026-10-08T00:05:00.000Z',
      },
    ]
    const facts = assignmentFactsOf(rows, 'sg-t-root')
    expect(facts[0]).toMatchObject({ state: 'interrupted' })
    expect(facts[0]!.completion).toBeUndefined()
  })

  test('a review work item is not a round, so the progress a graph reports never counts one', () => {
    expect(assignmentFactsOf([reviewRow('s-rev')], 'sg-t-root')).toEqual([])
  })

  test('another store\'s rows are not this store\'s facts', () => {
    expect(assignmentFactsOf([roundRow(1, 's-1')], 'sg-t-other')).toEqual([])
  })

  test('rounds read oldest first', () => {
    const facts = assignmentFactsOf([roundRow(2, 's-2'), roundRow(1, 's-1')], 'sg-t-root')
    expect(facts.map(item => item.round)).toEqual([1, 2])
  })

  test('one diagnosis id names one round work item', () => {
    const rows = [roundRow(1, 's-1'), reviewRow('s-rev')]
    expect(diagnosisIdOf(rows[0] as never)).toBe('rsi-g1-e1-round-1')
    expect(diagnosisIdOf(rows[1] as never)).toBeUndefined()
    expect(workOfDiagnosis([
      { assignment: roundRow(1, 's-1') as never },
      { assignment: roundRow(2, 's-2') as never },
    ], 'rsi-g1-e1-round-2')).toHaveLength(1)
  })
})

describe('the reader the view service registers', () => {
  test('reads the same file the driver writes, keyed by the root store id', async () => {
    await appendAssignment(roundRow(1, 's-1') as never)
    await recordCompletion({
      formatVersion: 1,
      kind: 'completion',
      graphId: 'g1',
      storeId: 'sg-t-root',
      epoch: 1,
      role: 'supervisor',
      sessionId: 's-1',
      result: { kind: 'protocol-failure', detail: 'ended without the tool' },
      at: '2026-10-08T00:05:00.000Z',
    })
    const facts = await coordinationFactsReader().assignments('sg-t-root')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ assignmentId: 's-1', round: 1, state: 'interrupted' })
    expect(await coordinationFactsReader().assignments('sg-t-nothing')).toEqual([])
  })
})

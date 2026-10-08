/** Derived history: tried mechanisms, yield windows, pruning candidates, stall steering, refutations. */
import { describe, expect, it } from 'vitest'
import { exploration, foldHistory, mayRetest, refutationFor, renderHistory, stallFlag } from '../../src/strategy/history.ts'
import type { HistoryFacts, HistoryView, RefutationFact } from '../../src/strategy/history.ts'
import type { MechanismKind } from '../../src/strategy/policy.ts'
import { DEFAULT_STRATEGY_POLICY } from '../../src/strategy/policy.ts'
import type { DeclaredEdit } from '../../src/strategy/screen.ts'

const edit = (id: string, mechanism: MechanismKind, hypothesis?: string): DeclaredEdit => ({ id, mechanism, hypothesis, targets: ['x'] })

function evaluation(candidateId: string, quality: number, tokens = 1000) {
  return {
    candidateId, scope: 's1', verdict: 'done', evidenceRefs: [`ev-${candidateId}`],
    measurement: { scope: 's1', trials: 1, missing: 0, tasks: [{ taskId: 't', trials: [{ quality, weight: 1, tokens }] }] },
  }
}

function fixtureFacts(): HistoryFacts {
  return {
    candidates: [
      { candidateId: 'inc', libraryId: 'lib', contentDigest: 'd-inc', round: 0, edits: [edit('C1', 'text', 'h0')], scope: 's1' },
      { candidateId: 'A', libraryId: 'lib', contentDigest: 'd-a', round: 1, edits: [edit('C1', 'skill', 'h1')], scope: 's1' },
      { candidateId: 'B', libraryId: 'lib', contentDigest: 'd-b', round: 2, edits: [edit('C1', 'capability', 'h2')], scope: 's1' },
      { candidateId: 'C', libraryId: 'lib', contentDigest: 'd-c', round: 3, edits: [edit('C1', 'parameter', 'h3')], scope: 's1' },
      { candidateId: 'D', libraryId: 'lib', contentDigest: 'd-d', round: 4, edits: [edit('C1', 'text', 'h4')], scope: 's1' },
    ],
    evaluations: [
      evaluation('inc', 0.5), evaluation('A', 0.6), evaluation('B', 0.55, 1100), evaluation('D', 0.55, 900),
    ],
    consumption: [{ candidateId: 'A', consumedBy: ['run-1'] }],
    refutations: [{
      candidateId: 'C', contentDigest: 'd-c', mechanism: 'parameter', hypothesis: 'h3',
      reasonCode: 'critic-reject', reason: 'leak', evidenceRefs: ['ev-c'], round: 3,
    }],
    versions: [
      { round: 0, libraryId: 'lib', revisionId: 'r0', contentDigest: 'd-inc' },
      { round: 1, libraryId: 'lib', revisionId: 'r1', contentDigest: 'd-a' },
      { round: 2, libraryId: 'lib', revisionId: 'r2', contentDigest: 'd-b' },
    ],
  }
}

describe('foldHistory', () => {
  it('derives entries with deltas against the frozen incumbent baseline', () => {
    const view = foldHistory(fixtureFacts(), DEFAULT_STRATEGY_POLICY, 5)
    expect(view.scope).toBe('s1')
    const byId = new Map(view.entries.map((e) => [e.candidateId, e]))
    expect(byId.get('A')).toMatchObject({ outcome: 'accepted', measured: true })
    expect(byId.get('A')?.deltaQuality).toBeCloseTo(0.05, 9)
    expect(byId.get('B')).toMatchObject({ outcome: 'accepted', measured: true })
    expect(byId.get('C')).toMatchObject({ outcome: 'unmeasured', measured: false, reasonCode: 'critic-reject' })
    expect(byId.get('D')).toMatchObject({ outcome: 'lost', measured: true })
    expect(byId.get('D')?.deltaCost).toBeCloseTo(-200 / 1100, 9)
    expect(view.bestQuality).toBeCloseTo(0.6, 9)
  })

  // Upstream parity (rrsi/test_core.py:140): a screen-refused mechanism never enters T_t.
  it('screen-refused mechanisms are not tried', () => {
    const view = foldHistory(fixtureFacts(), DEFAULT_STRATEGY_POLICY, 5)
    expect(view.triedMechanisms).toEqual(['skill', 'capability', 'text'])
    expect(view.untestedMechanisms).toEqual(['task-template', 'parameter'])
  })

  it('rolls the yield window by pruneWindow', () => {
    const facts = fixtureFacts()
    const at = (now: number) => new Map(foldHistory(facts, DEFAULT_STRATEGY_POLICY, now).yieldByMechanism.map((y) => [y.mechanism, y]))
    expect(at(5).get('skill')?.recentBestGain).toBeCloseTo(0.05, 9)
    expect(at(5).get('capability')?.recentBestGain).toBe(0)
    expect(at(5).get('task-template')?.recentBestGain).toBeUndefined()
    expect(at(6).get('skill')?.recentBestGain).toBeUndefined()
    expect(at(6).get('text')?.recentBestGain).toBe(0)
    expect(at(10).get('text')?.recentBestGain).toBeUndefined()
  })

  // Correction test (plan §4「剪枝通过删除候选评估而非按组件标签删功能」): pruning yields
  // candidate ids to run deletion evaluations on, never components to delete; a mechanism
  // without accepted candidates yields no entry.
  it('pruning proposes delete-candidate evaluations with real candidate ids only', () => {
    const view = foldHistory(fixtureFacts(), DEFAULT_STRATEGY_POLICY, 5)
    expect(view.simplificationCandidates).toEqual([
      { kind: 'delete-candidate', mechanism: 'capability', candidateIds: ['B'], recentBestGain: 0 },
      { kind: 'delete-candidate', mechanism: 'text', candidateIds: ['inc'], recentBestGain: 0 },
    ])
    for (const s of view.simplificationCandidates) {
      expect(s.kind).toBe('delete-candidate')
      expect(s.candidateIds.length).toBeGreaterThan(0)
    }
  })

  it('counts consecutive rounds without an accepted gain and steers', () => {
    expect(foldHistory(fixtureFacts(), DEFAULT_STRATEGY_POLICY, 2).steering).toBe('continue')
    const stalled = foldHistory(fixtureFacts(), DEFAULT_STRATEGY_POLICY, 5)
    expect(stalled.roundsWithoutQualityGain).toBe(3)
    expect(stalled.steering).toBe('steer-untested')
  })

  it('stops the method search when stalled with no untested mechanism left', () => {
    const facts: HistoryFacts = {
      candidates: [{
        candidateId: 'all', libraryId: 'lib', contentDigest: 'd-all', round: 0, scope: 's1',
        edits: [edit('C1', 'skill'), edit('C2', 'capability'), edit('C3', 'task-template'), edit('C4', 'text'), edit('C5', 'parameter')],
      }],
      evaluations: [evaluation('all', 0.5)],
      consumption: [],
      refutations: [],
      versions: [{ round: 0, libraryId: 'lib', revisionId: 'r0', contentDigest: 'd-all' }],
    }
    const view = foldHistory(facts, DEFAULT_STRATEGY_POLICY, 3)
    expect(view.untestedMechanisms).toEqual([])
    expect(view.roundsWithoutQualityGain).toBeGreaterThanOrEqual(DEFAULT_STRATEGY_POLICY.stallRounds)
    expect(view.steering).toBe('stop-search')
  })

  it('keeps refutations on the view for compact summaries', () => {
    expect(foldHistory(fixtureFacts(), DEFAULT_STRATEGY_POLICY, 5).refutations).toHaveLength(1)
  })
})

describe('refutationFor / mayRetest', () => {
  const refutation = fixtureFacts().refutations[0]

  // Correction test (plan §4「同字节候选直接结案」): a re-proposed byte-identical candidate
  // is closed by the recorded refutation before any experiment starts.
  it('closes byte-identical candidates in the same library without measurement', () => {
    expect(refutationFor(fixtureFacts(), 'lib', 'd-c')).toEqual({ kind: 'same-bytes', refutation })
    expect(refutationFor(fixtureFacts(), 'lib', 'd-unseen')).toBeUndefined()
    expect(refutationFor(fixtureFacts(), 'other-lib', 'd-c')).toBeUndefined()
  })

  it('matches a refuted hypothesis when the digest is new', () => {
    const facts = fixtureFacts()
    const withDraft: HistoryFacts = {
      ...facts,
      candidates: [...facts.candidates, { candidateId: 'E', libraryId: 'lib', contentDigest: 'd-e', round: 5, edits: [edit('C1', 'parameter', 'h3')], scope: 's1' }],
    }
    expect(refutationFor(withDraft, 'lib', 'd-e')).toEqual({ kind: 'same-hypothesis', refutation })
  })

  it('requires new evidence or a new scope to retest a refuted hypothesis', () => {
    const facts = fixtureFacts()
    expect(mayRetest(facts, refutation, { scope: 's1', evidenceRefs: ['ev-c'] })).toBe(false)
    expect(mayRetest(facts, refutation, { scope: 's1', evidenceRefs: ['ev-c', 'ev-new'] })).toBe(true)
    expect(mayRetest(facts, refutation, { scope: 's2', evidenceRefs: ['ev-c'] })).toBe(true)
  })
})

describe('stallFlag / exploration', () => {
  const trajectory = [0.50, 0.53, 0.53, 0.535, 0.60]

  it('matches the upstream boundary behavior (rrsi/test_core.py:154-158)', () => {
    expect(stallFlag(trajectory, 3, 3, 0.02)).toBe(0)
    expect(stallFlag(trajectory, 3, 2, 0.02)).toBe(1)
    expect(stallFlag(trajectory, 4, 2, 0.02)).toBe(0)
    expect(stallFlag(trajectory, 1, 3, 0.02)).toBe(0)
    expect(stallFlag(trajectory, 9, 2, 0.02)).toBe(0)
  })

  it('reserves draft slots for untried mechanisms while stalled', () => {
    const e = exploration(3, 1, ['text'], 1)
    expect(e.sigma).toBe(1)
    expect(e.untried).toEqual(['skill', 'capability', 'task-template', 'parameter'])
    expect(e.reservedDrafts).toBe(1)
    expect(e.text).toContain('RESERVED')
  })

  it('nudges without reserving when not stalled, and goes quiet when all tried', () => {
    expect(exploration(0, 0, ['text'], 1).text).toContain('Not mandatory')
    expect(exploration(0, 0, ['skill', 'capability', 'task-template', 'text', 'parameter'], 1).text).toContain('Every mechanism')
  })
})

describe('renderHistory', () => {
  // Correction test (plan §5「历史裁剪」): a wall of unmeasured aborts is not evidence;
  // measured entries always survive the compact rendering.
  it('keeps every measured entry and at most a few unmeasured aborts', () => {
    const entries = [
      ...[0, 1, 2].map((round) => ({
        round, candidateId: `m${round}`, measured: true, outcome: 'rejected' as const, evidenceRefs: [],
      })),
      ...Array.from({ length: 40 }, (_, i) => ({
        round: i + 3, candidateId: `u${i}`, measured: false, outcome: 'unmeasured' as const, evidenceRefs: [],
      })),
    ]
    const view = { entries } as unknown as HistoryView
    const rendered = renderHistory(view, 10)
    expect(rendered.filter((e) => e.measured)).toHaveLength(3)
    expect(rendered.filter((e) => !e.measured).length).toBeLessThanOrEqual(4)
    expect(rendered).toHaveLength(7)
    expect(rendered[0].candidateId).toBe('m0')
  })
})

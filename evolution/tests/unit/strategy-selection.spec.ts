/** Admission: noise floor, cost rule with the 25% cap, inconclusive costs, guards, admission refusals. */
import { describe, expect, it } from 'vitest'
import { admit, costRule, noveltyOf, selectRound } from '../../src/strategy/selection.ts'
import type { CandidateMeasurement } from '../../src/strategy/selection.ts'
import type { AggregateScore, NoiseCalibration } from '../../src/strategy/measure.ts'
import type { DeclaredEdit } from '../../src/strategy/screen.ts'
import { DEFAULT_STRATEGY_POLICY, UNREGULARIZED_STRATEGY_POLICY } from '../../src/strategy/policy.ts'
import type { StrategyPolicy } from '../../src/strategy/policy.ts'

const calibration: NoiseCalibration = {
  qualityBand: 0.05, relativeCostBand: 0.04, method: 'repeated-baseline-evaluations',
  evaluations: 3, standardError: 0.035, degenerate: false,
}

function score(quality: number, cost?: number, missing = 0): AggregateScore {
  return { quality, cost, expected: 20, missing, incomplete: missing > 0 || cost === undefined }
}

const edit = (id: string, mechanism: DeclaredEdit['mechanism'] = 'text'): DeclaredEdit => ({ id, mechanism, targets: ['x'] })

function candidate(id: string, quality: number | undefined, cost?: number, extra: Partial<CandidateMeasurement> = {}): CandidateMeasurement {
  return {
    candidateId: id, contentDigest: `d-${id}`, scope: 's', edits: [edit('C1')],
    aggregate: quality === undefined ? undefined : score(quality, cost),
    ...extra,
  }
}

const admitInput = (c: CandidateMeasurement, overrides: Record<string, unknown> = {}) => ({
  candidate: c, incumbent: score(0.5, 1000), incumbentScope: 's', bestQuality: 0.55,
  calibration, guards: [] as readonly string[], policy: DEFAULT_STRATEGY_POLICY, ...overrides,
})

describe('noveltyOf', () => {
  it('counts structural mechanisms the incumbent has never accepted', () => {
    expect(noveltyOf(['capability', 'text'], { text: 1 })).toBe(1)
    expect(noveltyOf(['skill'], { skill: 2 })).toBe(0)
    expect(noveltyOf(['text', 'parameter'], {})).toBe(0)
  })
})

describe('costRule', () => {
  it('admits a gaining candidate within budget and rejects one over it', () => {
    expect(costRule(0.2, 0.2, 0, calibration, DEFAULT_STRATEGY_POLICY).ok).toBe(true)
    expect(costRule(0.2, 0.26, 0, calibration, DEFAULT_STRATEGY_POLICY)).toMatchObject({ ok: false, reasonCode: 'cost-rule-failed' })
  })

  // Correction test (plan §4「默认上限 25%」): upstream beta1 = 40 would allow
  // 0.10 + 40·0.5 = +20.1x tokens here; the port caps the budget at +25%.
  it('enforces the 25% relative cost cap regardless of the gain size', () => {
    expect(costRule(0.5, 0.30, 0, calibration, DEFAULT_STRATEGY_POLICY)).toMatchObject({ ok: false, reasonCode: 'cost-rule-failed' })
    expect(costRule(0.5, 0.24, 0, calibration, DEFAULT_STRATEGY_POLICY).ok).toBe(true)
  })

  // Correction test (plan §4「成本缺失为 inconclusive」): upstream relative_cost_change
  // (rrsi/evaluate.py:131) returns 0 when either side is unknown and the L1 rule silently
  // passes; the port refuses.
  it('refuses gaining candidates whose cost is unknown', () => {
    const rule = costRule(0.2, undefined, 0, calibration, DEFAULT_STRATEGY_POLICY)
    expect(rule).toMatchObject({ ok: false, reasonCode: 'cost-inconclusive' })
    // upstream would admit: relative_cost_change(None, 1000) === 0 <= 0.10 + 40·0.2
    expect(0 <= 0.10 + 40 * 0.2).toBe(true)
  })

  it('in-band candidates must beat max(cost noise, 5%) of relief', () => {
    expect(costRule(0, -0.03, 0, calibration, DEFAULT_STRATEGY_POLICY)).toMatchObject({ ok: false, reasonCode: 'in-band-no-relief' })
    expect(costRule(0, -0.05, 0, calibration, DEFAULT_STRATEGY_POLICY).ok).toBe(true)
    // plan §4 override: upstream selection.py:90 admits ΔC = 0 with novelty; the port refuses.
    expect(costRule(0, 0, 1, calibration, DEFAULT_STRATEGY_POLICY)).toMatchObject({ ok: false, reasonCode: 'in-band-no-relief' })
  })

  it('in-band candidates with unknown cost are inconclusive', () => {
    expect(costRule(0, undefined, 0, calibration, DEFAULT_STRATEGY_POLICY)).toMatchObject({ ok: false, reasonCode: 'cost-inconclusive' })
  })
})

describe('admit', () => {
  it('rejects candidates outside the frozen scope', () => {
    expect(admit(admitInput(candidate('X', 0.9, 1000, { scope: 'other' })))).toMatchObject({ admissible: false, reasonCode: 'scope-mismatch' })
  })

  it('unmeasured candidates are not-measured and carry the screen refusal', () => {
    const refused = candidate('X', undefined, undefined, { refusedBy: 'critic-reject' })
    const admission = admit(admitInput(refused))
    expect(admission).toMatchObject({ admissible: false, reasonCode: 'not-measured' })
    expect(admission.reason).toContain('critic-reject')
  })

  it('a candidate whose digest was already refuted never reaches measurement', () => {
    const sameBytes = candidate('X', undefined, undefined, { refusedBy: 'over-budget' })
    expect(admit(admitInput(sameBytes))).toMatchObject({ admissible: false, reasonCode: 'not-measured' })
  })

  // Correction test: missing trials (inconclusive original acceptance) close the quality
  // question; the candidate cannot be admitted on the trials that landed.
  it('missing or inconclusive trials make the quality inconclusive', () => {
    const c = candidate('X', 0.9, 1000)
    c.aggregate = { ...c.aggregate!, missing: 1, incomplete: true }
    expect(admit(admitInput(c))).toMatchObject({ admissible: false, reasonCode: 'quality-inconclusive' })
  })

  it('enforces the noise-adjusted historical floor', () => {
    expect(admit(admitInput(candidate('X', 0.3, 1000)))).toMatchObject({ admissible: false, reasonCode: 'below-floor' })
    expect(admit(admitInput(candidate('X', 0.56, 1000)))).toMatchObject({ admissible: true })
  })

  it('guards are non-compensatory: no quality gain overrides them', () => {
    const admission = admit(admitInput(candidate('X', 0.95, 900), { guards: ['valid rate fell'] }))
    expect(admission).toMatchObject({ admissible: false, reasonCode: 'guard-violated' })
    expect(admission.reason).toContain('guard')
  })

  it('records deltas and novelty without letting novelty relax anything', () => {
    const c = candidate('X', 0.7, 1000, { edits: [edit('C1', 'skill')] })
    const admission = admit(admitInput(c, { incumbentMechanismCounts: {} }))
    expect(admission).toMatchObject({ admissible: true, reasonCode: 'admissible', novelty: 1 })
    expect(admission.deltaQuality).toBeCloseTo(0.2, 9)
    expect(admission.deltaCost).toBeCloseTo(0, 9)
  })

  it('deltaCost stays undefined when either side is unknown, never zero', () => {
    const admission = admit(admitInput(candidate('X', 0.3, undefined)))
    expect(admission.deltaCost).toBeUndefined()
    expect(admission.reasonCode).not.toBe('admissible')
  })

  describe('admission-refusal absolute cost path', () => {
    const refused = (spentTokens: number | undefined, ceilingTokens = 1000): CandidateMeasurement => candidate('X', 0.7, undefined, {
      admissionRefusal: { source: 'capability-gap', ceilingTokens, spentTokens },
    })
    const policy: StrategyPolicy = { ...DEFAULT_STRATEGY_POLICY, baselineAdmissionCeilingTokens: 2000 }

    // Correction test (plan §4): a baseline refused at admission uses a pre-declared
    // absolute token ceiling; no relative cost is fabricated for it.
    it('rejects when the refused side spent above the declared ceiling', () => {
      const admission = admit(admitInput(refused(1100), { policy }))
      expect(admission).toMatchObject({ admissible: false, reasonCode: 'refused-admission-baseline' })
      expect(admission.deltaCost).toBeUndefined()
    })

    it('is inconclusive when the refused side reported no spend', () => {
      expect(admit(admitInput(refused(undefined), { policy }))).toMatchObject({ admissible: false, reasonCode: 'cost-inconclusive' })
    })

    it('rejects ceilings the frozen policy never declared', () => {
      expect(admit(admitInput(refused(900, 5000), { policy }))).toMatchObject({ admissible: false, reasonCode: 'refused-admission-baseline' })
      expect(admit(admitInput(refused(900)))).toMatchObject({ admissible: false, reasonCode: 'refused-admission-baseline' })
    })

    it('admits within the declared ceiling without fabricating a relative cost', () => {
      const admission = admit(admitInput(refused(900), { policy }))
      expect(admission).toMatchObject({ admissible: true, reasonCode: 'admissible' })
      expect(admission.deltaCost).toBeUndefined()
    })

    it('still applies non-compensatory guards', () => {
      expect(admit(admitInput(refused(900), { policy, guards: ['holdout failed'] }))).toMatchObject({ admissible: false, reasonCode: 'guard-violated' })
    })
  })
})

describe('selectRound', () => {
  const base = {
    incumbent: score(0.5, 1000), incumbentScope: 's', bestQuality: 0.55, calibration,
    guardsFor: () => [] as readonly string[], policy: DEFAULT_STRATEGY_POLICY,
  }

  it('picks the highest-quality admissible candidate', () => {
    const a = candidate('A', 0.7, 1000)
    const b = candidate('B', 0.6, 1000)
    const c = candidate('C', 0.3, 1000)
    const { winner, admissions } = selectRound({ ...base, candidates: [a, b, c] })
    expect(winner?.candidateId).toBe('A')
    expect(admissions.map((x) => [x.candidateId, x.admissible])).toEqual([['A', true], ['B', true], ['C', false]])
  })

  it('returns no winner when nothing is admissible', () => {
    const { winner } = selectRound({ ...base, candidates: [candidate('C', 0.3, 1000)] })
    expect(winner).toBeUndefined()
  })

  it('breaks quality ties by novelty, then by bundle-level, deterministically', () => {
    const plain = candidate('A', 0.7, 1000, { edits: [edit('C1', 'text')] })
    const novel = candidate('B', 0.7, 1000, { edits: [edit('C1', 'skill')] })
    const { winner } = selectRound({ ...base, candidates: [plain, novel], incumbentMechanismCounts: { text: 1 } })
    expect(winner?.candidateId).toBe('B')
    const bundled = candidate('C', 0.7, 1000, { edits: [edit('C1', 'text'), edit('C2', 'text')] })
    const tie = selectRound({ ...base, candidates: [bundled, plain], incumbentMechanismCounts: { text: 1 } })
    expect(tie.winner?.candidateId).toBe('A')
  })

  it('per-candidate guards come from guardsFor', () => {
    const a = candidate('A', 0.7, 1000)
    const b = candidate('B', 0.6, 1000)
    const { winner, admissions } = selectRound({ ...base, candidates: [a, b], guardsFor: (c) => c.candidateId === 'A' ? ['holdout failed'] : [] })
    expect(winner?.candidateId).toBe('B')
    expect(admissions[0]).toMatchObject({ reasonCode: 'guard-violated' })
  })

  // plan §5 three-arm comparison: the same inputs run through the unregularized arm
  // must take the same code paths (no hidden mode branches). A small in-band gain with
  // modest relief is blocked by the regularized band/shaping and admitted without them.
  it('the unregularized arm admits what the regularized arm blocks in-band', () => {
    const c = candidate('E', 0.54, 980)
    const flat = { ...base, bestQuality: 0.5 }
    expect(selectRound({ ...flat, candidates: [c] }).winner).toBeUndefined()
    const arm = selectRound({
      ...flat, candidates: [c], policy: UNREGULARIZED_STRATEGY_POLICY,
      calibration: { ...calibration, qualityBand: 0, relativeCostBand: 0 },
    })
    expect(arm.winner?.candidateId).toBe('E')
  })
})

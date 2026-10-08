/** Frozen [0,1] quality scale: original acceptance is never compensable by numeric scores. */
import { describe, expect, it } from 'vitest'
import { assertScaleAddressesFrozenMeasurement, qualityOf } from '../../src/strategy/scale.ts'
import type { QualityScale } from '../../src/strategy/scale.ts'

const acceptance: QualityScale = { kind: 'acceptance-success-rate' }
const numeric: QualityScale = { kind: 'fixed-numeric-scale', metricId: 'latency', atLeast: 0, atMost: 100, direction: 'higher-is-better' }

describe('qualityOf', () => {
  // Correction test (plan §5「原验收不被评分补偿」): a perfect numeric score on a failed
  // acceptance still yields 0; the LLM judge cannot route around acceptance either.
  it('failed acceptance yields 0 even with a perfect numeric score', () => {
    expect(qualityOf(numeric, { acceptance: 'fail', numeric: 100 })).toBe(0)
    expect(qualityOf(acceptance, { acceptance: 'fail', numeric: 100 })).toBe(0)
  })

  it('inconclusive acceptance yields 0 and must be recorded as missing by the caller', () => {
    expect(qualityOf(numeric, { acceptance: 'inconclusive', numeric: 100 })).toBe(0)
    expect(qualityOf(acceptance, { acceptance: 'inconclusive' })).toBe(0)
  })

  it('acceptance-success-rate is exactly the original acceptance', () => {
    expect(qualityOf(acceptance, { acceptance: 'pass' })).toBe(1)
  })

  it('maps a frozen numeric scale linearly in both directions', () => {
    expect(qualityOf(numeric, { acceptance: 'pass', numeric: 50 })).toBeCloseTo(0.5, 9)
    expect(qualityOf(numeric, { acceptance: 'pass', numeric: 100 })).toBe(1)
    const lower: QualityScale = { kind: 'fixed-numeric-scale', metricId: 'latency', atLeast: 0, atMost: 100, direction: 'lower-is-better' }
    expect(qualityOf(lower, { acceptance: 'pass', numeric: 25 })).toBeCloseTo(0.75, 9)
    expect(qualityOf(lower, { acceptance: 'pass', numeric: 100 })).toBe(0)
  })

  it('clamps numerics outside the frozen scale bounds', () => {
    expect(qualityOf(numeric, { acceptance: 'pass', numeric: 150 })).toBe(1)
    expect(qualityOf(numeric, { acceptance: 'pass', numeric: -5 })).toBe(0)
  })

  it('a passed trial without the frozen numeric counts 0 (the trial was not measured)', () => {
    expect(qualityOf(numeric, { acceptance: 'pass' })).toBe(0)
  })

  it('throws on non-finite numerics instead of silently passing', () => {
    expect(() => qualityOf(numeric, { acceptance: 'pass', numeric: Number.NaN })).toThrow(/finite/)
    expect(() => qualityOf(numeric, { acceptance: 'pass', numeric: Number.POSITIVE_INFINITY })).toThrow(/finite/)
  })

  it('rejects degenerate scales', () => {
    const bad: QualityScale = { kind: 'fixed-numeric-scale', metricId: 'x', atLeast: 10, atMost: 10, direction: 'higher-is-better' }
    expect(() => qualityOf(bad, { acceptance: 'pass', numeric: 10 })).toThrow(/atMost/)
  })
})

describe('assertScaleAddressesFrozenMeasurement', () => {
  const frozen = { measurements: [{ id: 'latency' }] }

  it('accepts a scale pointing at a frozen measurement', () => {
    expect(() => assertScaleAddressesFrozenMeasurement(numeric, frozen)).not.toThrow()
  })

  it('rejects a scale constructed after the fact', () => {
    const adhoc: QualityScale = { kind: 'fixed-numeric-scale', metricId: 'vibes', atLeast: 0, atMost: 1, direction: 'higher-is-better' }
    expect(() => assertScaleAddressesFrozenMeasurement(adhoc, frozen)).toThrow(/not a frozen measurement/)
  })

  it('acceptance-success-rate always addresses the frozen criteria', () => {
    expect(() => assertScaleAddressesFrozenMeasurement(acceptance, { measurements: [] })).not.toThrow()
  })
})

import type { Calibration } from '../strategy/decision.ts'
import type { EvaluationState } from './protocol.ts'

/** Repeated observations estimate noise; a singleton never supplies a measured zero. */
export function calibrationFrom(state: EvaluationState, declared: Calibration): Calibration {
  const observed = [...state.observed, ...(state.failed ?? [])]
  if (observed.length !== state.trials || state.missed.length) return { floor: declared.floor, source: 'declared' }
  const groups =
    state.matrix === undefined
      ? [observed.map(t => t.quality)]
      : [...new Set(state.matrix.slots.map(s => s.caseId))].map(id =>
          observed.filter(t => state.matrix!.slots[t.slot]!.caseId === id).map(t => t.quality),
        )
  if (groups.some(g => g.length < 2)) return { floor: declared.floor, source: 'declared' }
  const variance =
    groups.reduce((sum, g) => {
      const mean = g.reduce((a, b) => a + b, 0) / g.length
      return sum + g.reduce((v, x) => v + (x - mean) ** 2, 0) / ((g.length - 1) * g.length)
    }, 0) /
    groups.length ** 2
  return { floor: Math.max(declared.floor, 1.96 * Math.sqrt(2 * variance)), source: 'measured' }
}

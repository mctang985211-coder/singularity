/** Annealed L0 edit budget: deterministic tables, exact endpoints, and the screen's over-budget refusal. */
import { describe, expect, it } from 'vitest'
import { editBudget, editBudgetTable } from '../../src/strategy/schedule.ts'
import { screenBeforeMeasurement } from '../../src/strategy/screen.ts'
import type { DeclaredEdit } from '../../src/strategy/screen.ts'
import { DEFAULT_STRATEGY_POLICY } from '../../src/strategy/policy.ts'

describe('editBudget annealing', () => {
  it.each([
    [{ rounds: 20, min: 1, max: 4 }, [4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 1]],
    [{ rounds: 20, min: 1, max: 2 }, [...Array(19).fill(2), 1]],
    [{ rounds: 8, min: 1, max: 2 }, [2, 2, 2, 2, 2, 2, 2, 1]],
    [{ rounds: 5, min: 1, max: 2 }, [2, 2, 2, 2, 1]],
    [{ rounds: 3, min: 1, max: 4 }, [4, 3, 1]],
    [{ rounds: 1, min: 1, max: 2 }, [1]],
  ] as const)('table %o is exact', (policy, expected) => {
    expect(editBudgetTable(policy)).toEqual(expected)
  })

  // Correction test (plan §4「最后一轮确实为一项」): the port divides by rounds-1, so the
  // final round is exactly b_min; upstream schedule.py:48 divides by T and needs an
  // out-of-range endpoint edit_budget(T, T, …) to reach b_min (tests/test_core.py:63).
  it.each([1, 2, 3, 8, 20])('rounds=%d: the final round is exactly min', (rounds) => {
    const policy = { rounds, min: 1, max: rounds === 1 ? 1 : 4 }
    const table = editBudgetTable(policy)
    expect(table[rounds - 1]).toBe(1)
    expect(editBudget(rounds - 1, policy)).toBe(1)
  })

  it('is non-increasing for every policy', () => {
    for (const [rounds, max] of [[2, 2], [3, 4], [8, 2], [20, 4], [20, 2]] as const) {
      const table = editBudgetTable({ rounds, min: 1, max })
      for (let i = 1; i < table.length; i += 1) expect(table[i]).toBeLessThanOrEqual(table[i - 1])
    }
  })

  it('clamps out-of-range rounds instead of needing an out-of-range endpoint', () => {
    const policy = { rounds: 20, min: 1, max: 4 }
    expect(editBudget(-3, policy)).toBe(4)
    expect(editBudget(20, policy)).toBe(1)
    expect(editBudget(99, policy)).toBe(1)
  })

  it('rejects malformed policies', () => {
    expect(() => editBudgetTable({ rounds: 0, min: 1, max: 2 })).toThrow(/rounds/)
    expect(() => editBudgetTable({ rounds: 20, min: 3, max: 2 })).toThrow(/min/)
    expect(() => editBudgetTable({ rounds: 20, min: 0, max: 2 })).toThrow(/min/)
    expect(() => editBudget(0, { rounds: 2.5, min: 1, max: 2 })).toThrow(/rounds/)
  })

  // Correction test: with b_min = 1, b_max = 2 the cosine quantizes to 2 for every
  // interior round and only the final round is 1 — pinned literally, not smoothed over.
  it('b_min=1, b_max=2 degenerates to "only the last round is 1"', () => {
    const table = editBudgetTable({ rounds: 20, min: 1, max: 2 })
    expect(table.slice(0, 19)).toEqual(Array(19).fill(2))
    expect(table[19]).toBe(1)
  })
})

describe('screenBeforeMeasurement budget enforcement', () => {
  const edit = (id: string): DeclaredEdit => ({ id, mechanism: 'text', targets: ['skills/x/SKILL.md'] })
  const structure = { ok: true, findings: [] }
  const critic = { verdict: 'accept' as const, reason: 'ok', evidenceRefs: [], criticId: 'c1', at: '2026-10-08T00:00:00Z' }

  it('rejects candidates declaring more independent edits than the round budget', () => {
    const screen = screenBeforeMeasurement({ round: 0, edits: [edit('a'), edit('b'), edit('c')], structure, critic, policy: DEFAULT_STRATEGY_POLICY })
    expect(screen).toMatchObject({ ok: false, reasonCode: 'over-budget' })
  })

  it('the final round (b=1) refuses a two-edit bundle', () => {
    const screen = screenBeforeMeasurement({ round: 19, edits: [edit('a'), edit('b')], structure, critic, policy: DEFAULT_STRATEGY_POLICY })
    expect(screen).toMatchObject({ ok: false, reasonCode: 'over-budget' })
    const ok = screenBeforeMeasurement({ round: 19, edits: [edit('a')], structure, critic, policy: DEFAULT_STRATEGY_POLICY })
    expect(ok).toEqual({ ok: true, bundleLevel: false })
  })

  it('marks bundled measurements as bundle-level', () => {
    const screen = screenBeforeMeasurement({ round: 0, edits: [edit('a'), edit('b')], structure, critic, policy: DEFAULT_STRATEGY_POLICY })
    expect(screen).toEqual({ ok: true, bundleLevel: true })
  })

  it('unverified edits do not count as independent mechanisms', () => {
    const unverified: DeclaredEdit = { id: 'u', mechanism: 'skill', targets: [], mechanismUnverified: true }
    expect(screenBeforeMeasurement({ round: 0, edits: [unverified], structure, critic, policy: DEFAULT_STRATEGY_POLICY }))
      .toMatchObject({ ok: false, reasonCode: 'no-independent-mechanism' })
    const mixed = screenBeforeMeasurement({ round: 0, edits: [edit('a'), unverified], structure, critic, policy: DEFAULT_STRATEGY_POLICY })
    expect(mixed).toEqual({ ok: true, bundleLevel: false })
  })
})

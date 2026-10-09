/**
 * `strategy@1` — the explicit round, its submission gate, and the projection that decides.
 *
 * Three groups, one per place a rule can live: the reducer (rules needing only the round's own
 * subject; it runs inside the serial region), the command boundary (the annealed budget, the
 * recomputation of a decision against the cut it is appended to, and the one submission condition
 * that spans subjects), and the projection (admissibility before any argmax, frozen gains, and the
 * caliber that makes scores comparable).
 *
 * The measurement inputs are a table, not a log fold: `src/measure/**` owns that projection. The
 * table still honours the round's own responsibility — both historical reads are **below the
 * round's history cutoff**.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore } from '../src/control/session-store.ts'
import type { Envelope } from '../src/protocol/envelope.ts'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import type { RefusalCode } from '../src/protocol/refusal.ts'
import type { RevisionRef } from '../src/task/protocol.ts'
import { createStrategyCommands, type OpenRoundInput, type StrategyCommands, type SubmitCandidateInput } from '../src/strategy/commands.ts'
import { editBudgetFor, type Calibration } from '../src/strategy/decision.ts'
import { declareStrategyProtocol, STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_ROLE, STRATEGY_VERSION, type RoundState } from '../src/strategy/protocol.ts'
import { projectRound, type FrozenAggregate, type MeasureSlice, type RoundEvaluation } from '../src/strategy/view.ts'
import { asyncRefusalOf } from './fixtures.ts'

const METRIC = { unit: 'score', direction: 'higher' } as const
const WEIGHTS = { quality: 100, cost: 15 }
const FLOOR: Calibration = { floor: 0.1, source: 'measured' }
const CALIBER = 'f'.repeat(64)
const SUBJECTS: Readonly<Record<string, string>> = { [STRATEGY_ROLE]: 'strategy-service' }
const SKILL = [{ asset: 'skill' as const, target: 'count' }]
const revisionOf = (revisionId: string, seed: string): RevisionRef => ({ environmentId: 'library-1', revisionId, digest: seed.repeat(64) })
const INCUMBENT = revisionOf('r0001', 'a')
const CANDIDATE_A = revisionOf('r0002', 'b')
const CANDIDATE_B = revisionOf('r0003', 'c')
let counter = 0
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`

/** A refusal, asserted by code and by the fragment that names the alternative. */
const expectRefusal = async (step: () => unknown, code: RefusalCode, fragment: string): Promise<void> => {
  const refusal = await asyncRefusalOf(step)
  expect(`${refusal.code}|${refusal.detail}`).toContain(code)
  expect(refusal.detail).toContain(fragment)
}

const strategyRegistry = (): ProtocolRegistry => {
  const registry = new ProtocolRegistry()
  declareStrategyProtocol(registry)
  return registry
}
/** A log with no medium, for the rules the reducer decides on the round's own subject. */
const strategyLog = (): MemoryLog => new MemoryLog(strategyRegistry(), { subjects: SUBJECTS, now: () => '2026-10-09T00:00:00.000Z' })
const emit = (log: MemoryLog, kind: string, subject: string, payload: unknown): Envelope =>
  log.emit({ commandId: nextId('emit'), protocol: STRATEGY_PROTOCOL, version: STRATEGY_VERSION, kind, subject, payload })
const plan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  round: 1, incumbent: INCUMBENT, candidates: 3, explorationSlots: 1,
  editBudget: 2, historyCutoff: 0, metric: METRIC, weights: WEIGHTS,
  ...over,
})
const emitPlan = (log: MemoryLog, subject: string, over: Record<string, unknown> = {}): Envelope => emit(log, STRATEGY_KINDS.roundOpened, subject, plan(over))
const emitSubmission = (log: MemoryLog, subject: string, slot: number, over: Record<string, unknown> = {}): Envelope =>
  emit(log, STRATEGY_KINDS.candidateSubmitted, subject, { slot, revision: CANDIDATE_A, evaluationId: `e-${slot}`, edits: SKILL, exploratory: false, ...over })
const emitDecision = (log: MemoryLog, subject: string, over: Record<string, unknown> = {}): Envelope =>
  emit(log, STRATEGY_KINDS.roundDecided, subject, { winner: null, outcomes: [], ...over })
/** One round's folded state as of the whole memory log. */
const roundIn = (log: MemoryLog, subject: string): RoundState | undefined => log.stateAt<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, subject, log.count)

/** One evaluation as the measure slice would project it. */
const evaluation = (evaluationId: string, over: Partial<RoundEvaluation> = {}): RoundEvaluation => ({
  evaluationId, caliberDigest: over.caliberDigest ?? CALIBER, baseline: over.baseline ?? INCUMBENT,
  candidate: over.candidate ?? CANDIDATE_A, denominator: over.denominator ?? 2,
  observed: over.observed ?? 2, missing: over.missing ?? [], quality: over.quality ?? 0.6,
  cost: over.cost === undefined ? 10 : over.cost,
  constraints: over.constraints ?? [{ criterionId: 'correctness', met: true }],
  admissible: over.admissible ?? true, why: over.why === undefined ? null : over.why,
})

interface MeasureTable {
  readonly evaluations: Map<string, RoundEvaluation>
  readonly aggregates: Map<string, { readonly at: number; readonly aggregate: FrozenAggregate }[]>
  readonly published: { readonly at: number; readonly assets: readonly string[] }[]
}
const tableOf = (): MeasureTable => ({ evaluations: new Map(), aggregates: new Map(), published: [] })
const measuredAt = (table: MeasureTable, revision: RevisionRef, at: number, quality: number, cost: number | null = 10): void => {
  table.aggregates.set(revision.revisionId, [...(table.aggregates.get(revision.revisionId) ?? []), { at, aggregate: { quality, cost } }])
}
/** The slice the round reads: both historical reads honour the round's own cutoff. */
const sliceOf = (table: MeasureTable): MeasureSlice => ({
  evaluationOf: id => table.evaluations.get(id),
  incumbentBelow: (revision, cutoff) =>
    (table.aggregates.get(revision.revisionId) ?? [])
      .filter(entry => entry.at < cutoff)
      .sort((left, right) => right.at - left.at)
      .map(entry => entry.aggregate)[0] ?? null,
  acceptedAssetsBelow: cutoff => [...new Set(table.published.filter(entry => entry.at < cutoff).flatMap(entry => entry.assets))].sort(),
})

interface Live {
  readonly store: ControlSessionStore
  readonly commands: StrategyCommands
  readonly table: MeasureTable
}
const deployments: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const live of deployments.splice(0)) {
    await live.context.fiber.dispose()
    await rm(live.root, { recursive: true, force: true })
  }
})
async function deployment(over: { rounds?: number; firstBudget?: number; minimumBudget?: number } = {}): Promise<Live> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-strategy-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  deployments.push({ context, root })
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence, controlId: 'strategy', registry: strategyRegistry(), subjects: SUBJECTS,
  })
  const table = tableOf()
  const commands = createStrategyCommands({
    store, rounds: over.rounds ?? 3, firstBudget: over.firstBudget ?? 4, minimumBudget: over.minimumBudget ?? 1,
    calibration: FLOOR, measuresAt: () => sliceOf(table),
  })
  return { store, commands, table }
}
async function openThrough(live: Live, over: Partial<OpenRoundInput> = {}): Promise<string> {
  const roundId = over.roundId ?? nextId('round')
  await live.commands.openRound({
    commandId: nextId('open'), roundId, round: over.round ?? 1, incumbent: INCUMBENT,
    candidates: over.candidates ?? 2, explorationSlots: over.explorationSlots ?? 0,
    historyCutoff: over.historyCutoff ?? live.store.load().entries().length, metric: METRIC, weights: WEIGHTS,
  })
  return roundId
}
const submitThrough = (live: Live, roundId: string, slot: number, over: Partial<SubmitCandidateInput> = {}): Promise<Envelope> =>
  live.commands.submitCandidate({
    commandId: over.commandId ?? nextId('submit'), roundId, slot, revision: over.revision ?? CANDIDATE_A,
    evaluationId: over.evaluationId ?? `e-${slot}`, edits: over.edits ?? SKILL, exploratory: over.exploratory ?? false,
  })
const decideThrough = (live: Live, roundId: string): Promise<Envelope> => live.commands.decideRound({ commandId: nextId('decide'), roundId })
const stateOf = (live: Live, roundId: string): RoundState | undefined => live.store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)
const winnerOf = (envelope: Envelope): number | null => (envelope.payload as { winner: number | null }).winner
const project = (live: Live, roundId: string): ReturnType<typeof projectRound> => projectRound(stateOf(live, roundId) as RoundState, sliceOf(live.table), FLOOR)

/** A round with two measured candidates, one per slot, and a frozen incumbent aggregate. */
async function twoCandidateRound(
  live: Live,
  over: { e0?: Partial<RoundEvaluation>; e1?: Partial<RoundEvaluation>; edits0?: SubmitCandidateInput['edits']; round?: number; quality?: number } = {},
): Promise<string> {
  const roundId = await openThrough(live, { candidates: 2, historyCutoff: 5, round: over.round ?? 1 })
  measuredAt(live.table, INCUMBENT, 0, over.quality ?? 0.4)
  live.table.evaluations.set('e-0', evaluation('e-0', { candidate: CANDIDATE_A, ...over.e0 }))
  live.table.evaluations.set('e-1', evaluation('e-1', { candidate: CANDIDATE_B, ...over.e1 }))
  await submitThrough(live, roundId, 0, { evaluationId: 'e-0', edits: over.edits0 ?? SKILL })
  await submitThrough(live, roundId, 1, { evaluationId: 'e-1', revision: CANDIDATE_B })
  return roundId
}

describe('round/opened freezes one explicit round', async () => {
  it('carries the number, incumbent, plan, budget, cutoff, metric and weights — and opens once', async () => {
    const log = strategyLog()
    const opened = emitPlan(log, 'round-1')
    expect(Object.keys(opened.payload as Record<string, unknown>).sort()).toEqual([
      'candidates', 'editBudget', 'explorationSlots', 'historyCutoff', 'incumbent', 'metric', 'round', 'weights',
    ])
    expect(roundIn(log, 'round-1')?.plan?.round).toBe(1)
    expect(roundIn(log, 'round-1')?.plan?.candidates).toBe(3)
    await expectRefusal(() => emitPlan(log, 'round-1'), 'illegal-transition', 'a different round, and it gets a different subject')
    await expectRefusal(() => emitPlan(log, 'round-zero', { round: 0 }), 'malformed-payload', 'never a count of history entries')
    await expectRefusal(() => emitPlan(log, 'round-wide', { explorationSlots: 4 }), 'malformed-payload', 'cannot exceed')
    await expectRefusal(() => emitPlan(log, 'round-weightless', { weights: { quality: 0, cost: 15 } }), 'malformed-payload', 'cannot prefer')
  })
})

describe('the submission gate is the reducer\u2019s, inside the commit region', async () => {
  it('refuses every way a submission can violate the plan, and admits the two legal shapes', async () => {
    const log = strategyLog()
    emitPlan(log, 'round-1', { explorationSlots: 2 })
    emitSubmission(log, 'round-1', 2, { exploratory: true })
    const wide = [
      { asset: 'skill' as const, target: 'count' },
      { asset: 'tool' as const, target: 'tokenizer' },
      { asset: 'template' as const, target: 'report' },
    ]
    await expectRefusal(() => emitSubmission(log, 'round-1', 3), 'illegal-transition', 'plans slots 0..2')
    await expectRefusal(() => emitSubmission(log, 'round-1', 2, { exploratory: true }), 'evidence-conflict', 'one slot holds one candidate')
    await expectRefusal(() => emitSubmission(log, 'round-1', 0, { edits: wide }), 'budget-exhausted', 'anneals to a budget of 2')
    await expectRefusal(() => emitSubmission(log, 'round-1', 0, { edits: [...SKILL, ...SKILL] }), 'malformed-payload', 'one structural change per target')
    await expectRefusal(() => emitSubmission(log, 'round-1', 1), 'illegal-transition', 'reserves for exploration')

    // A reserved slot is the *exploratory* slot, and two edits that differ only in asset are two.
    const both = [{ asset: 'skill' as const, target: 'count' }, { asset: 'tool' as const, target: 'count' }]
    expect(emitSubmission(log, 'round-1', 0, { edits: both }).kind).toBe(STRATEGY_KINDS.candidateSubmitted)
    expect(roundIn(log, 'round-1')?.submissions.map(entry => entry.slot)).toEqual([2, 0])
    expect(roundIn(log, 'round-1')?.submissions[0]?.exploratory).toBe(true)

    emitDecision(log, 'round-1', {
      winner: null,
      outcomes: [
        { slot: 0, admitted: false, reason: 'gain 0.05 is inside the noise band 0.1' },
        { slot: 2, admitted: false, reason: 'gain 0.05 is inside the noise band 0.1' },
      ],
    })
    expect(roundIn(log, 'round-1')?.decision?.winner).toBe(null)
    await expectRefusal(() => emitSubmission(log, 'round-1', 1, { exploratory: true }), 'illegal-transition', 'after round 1 closed')
  })
})

describe('a decision closes every submitted slot out with a named reason', async () => {
  it('refuses an unaccounted slot, an invented one, an unadmitted winner, an empty reason and a second decision', async () => {
    const log = strategyLog()
    emitPlan(log, 'round-1')
    emitSubmission(log, 'round-1', 0)
    emitSubmission(log, 'round-1', 1)
    const one = [{ slot: 0, admitted: true, reason: 'best aggregate' }]
    const both = [...one, { slot: 1, admitted: false, reason: 'in the noise band' }]

    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: one }), 'illegal-transition', 'without an outcome for submitted slot 1')
    await expectRefusal(
      () => emitDecision(log, 'round-1', { outcomes: [...both, { slot: 2, admitted: true, reason: 'never submitted' }] }),
      'illegal-transition',
      'has no submission for',
    )
    await expectRefusal(() => emitDecision(log, 'round-1', { winner: 1, outcomes: both }), 'illegal-transition', 'null means the incumbent stands')
    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: [{ ...one[0], reason: '' }, both[1]] }), 'malformed-payload', 'reason')

    const decided = emitDecision(log, 'round-1', { winner: 0, outcomes: both })
    expect(Object.keys(decided.payload as Record<string, unknown>).sort()).toEqual(['outcomes', 'winner'])
    expect(roundIn(log, 'round-1')?.decision?.winner).toBe(0)
    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: both }), 'illegal-transition', 'decides round 1 again')
  })

})

describe('the round command service', async () => {
  it('derives the annealed budget from the round number, freezes it, and refuses a reused round number', async () => {
    const live = await deployment({ rounds: 3, firstBudget: 4, minimumBudget: 1 })
    const first = await openThrough(live, { round: 1 })
    const last = await openThrough(live, { roundId: 'round-last', round: 3 })
    expect(stateOf(live, first)?.plan?.editBudget).toBe(editBudgetFor(1, 3, 4, 1))
    expect(stateOf(live, first)?.plan?.editBudget).toBeGreaterThan(1)
    expect(stateOf(live, last)?.plan?.editBudget).toBe(1)

    // The budget is the round's, not the caller's: the command surface never mentions one.
    const budget = stateOf(live, first)?.plan?.editBudget ?? 0
    const wide = Array.from({ length: budget + 1 }, (_, index) => ({ asset: 'skill' as const, target: `t${index}` }))
    await expectRefusal(() => submitThrough(live, first, 0, { edits: wide }), 'budget-exhausted', 'anneals to a budget')
    await expectRefusal(() => openThrough(live, { roundId: 'round-dup', round: 1 }), 'illegal-transition', 'one number')
  })

  it('cannot bypass the submission gate, and a re-delivered command returns the fact it committed', async () => {
    const live = await deployment()
    const roundId = await openThrough(live, { candidates: 2, explorationSlots: 1 })
    const first = await submitThrough(live, roundId, 0, { commandId: 'submit-once' })
    expect((await submitThrough(live, roundId, 0, { commandId: 'submit-once' })).digest).toBe(first.digest)
    await expectRefusal(() => submitThrough(live, roundId, 0), 'evidence-conflict', 'one slot holds one candidate')
    await expectRefusal(() => submitThrough(live, roundId, 1), 'illegal-transition', 'reserves for exploration')

    await decideThrough(live, roundId)
    await expectRefusal(() => submitThrough(live, roundId, 1, { exploratory: true }), 'illegal-transition', 'after round 1 closed')
  })

  it('refuses a submission whose evaluation measured a different revision', async () => {
    const live = await deployment()
    const roundId = await openThrough(live)
    live.table.evaluations.set('e-0', evaluation('e-0', { candidate: CANDIDATE_B }))
    await expectRefusal(
      () => submitThrough(live, roundId, 0, { evaluationId: 'e-0' }),
      'evidence-input-mismatch',
      'the observation is about a different candidate',
    )
  })
})

describe('the projection decides admissibility before any argmax', async () => {
  it('never lets a higher aggregate buy a violated hard constraint', async () => {
    const live = await deployment()
    const roundId = await twoCandidateRound(live, { e0: { quality: 0.9, constraints: [{ criterionId: 'correctness', met: false }] } })
    const decision = project(live, roundId)
    expect(decision.slots[0]?.constraintsMet).toBe(false)
    expect(decision.slots[0]?.admissible).toBe(false)
    expect(decision.slots[0]?.reason).toContain('"correctness"')

    expect(winnerOf(await decideThrough(live, roundId))).toBe(1)
    const outcomes = stateOf(live, roundId)?.decision?.outcomes ?? []
    expect(outcomes.find(outcome => outcome.slot === 0)?.reason).toContain('"correctness"')
    expect(outcomes.find(outcome => outcome.slot === 1)?.admitted).toBe(true)
  })

  it('refuses an incomplete measurement, and retains the incumbent when nothing is admissible', async () => {
    const live = await deployment()
    const partial = { quality: 0.95, observed: 1, missing: [{ slot: 1, reason: 'the trial never ran' }] }
    const roundId = await twoCandidateRound(live, { e0: partial })
    const decision = project(live, roundId)
    expect(decision.slots[0]?.admissible).toBe(false)
    expect(decision.slots[0]?.reason).toContain('1 of 2 planned trials observed')
    expect(decision.slots[0]?.reason).toContain('slot 1 (the trial never ran)')
    expect(decision.winner).toBe(1)

    const nothingAdmissible = await twoCandidateRound(live, {
      round: 2,
      e0: partial,
      e1: { constraints: [{ criterionId: 'correctness', met: false }] },
    })
    expect(winnerOf(await decideThrough(live, nothingAdmissible))).toBe(null)
    expect(stateOf(live, nothingAdmissible)?.decision?.outcomes[0]?.reason).toContain('incomplete')
  })

  it('refuses a measurement taken against another baseline, and refuses to pool two calibers', async () => {
    const live = await deployment()
    const stale = await twoCandidateRound(live, { e0: { quality: 0.9, baseline: CANDIDATE_B } })
    const decision = project(live, stale)
    expect(decision.slots[0]?.admissible).toBe(false)
    expect(decision.slots[0]?.reason).toContain("not round 1's incumbent")
    // Slot 1 is sound and still wins: one stale baseline does not block the round.
    expect(winnerOf(await decideThrough(live, stale))).toBe(1)

    const mixed = await twoCandidateRound(live, { round: 2, e1: { caliberDigest: '0'.repeat(64) } })
    await expectRefusal(() => decideThrough(live, mixed), 'caliber-mismatch', 'may not be ranked together')
    expect(stateOf(live, mixed)?.decision).toBeUndefined()
  })

  it('computes the gain and the novelty below the round\u2019s own cutoff, and breaks a tie by slot number', async () => {
    const live = await deployment()
    // The incumbent was measured at 0.6 below the cutoff and 0.8 above it; `skill` is published
    // below the cutoff and `tool` above it. So the frozen gain is +0.2 and novelty is 1 (R03, R05).
    const roundId = await twoCandidateRound(live, { e0: { quality: 0.8 }, e1: { quality: 0.8 }, edits0: [{ asset: 'tool', target: 'tokenizer' }] })
    measuredAt(live.table, INCUMBENT, 1, 0.6)
    measuredAt(live.table, INCUMBENT, 9, 0.8)
    live.table.published.push({ at: 1, assets: ['skill'] }, { at: 9, assets: ['tool'] })

    const decision = project(live, roundId)
    expect(decision.slots[0]?.gain).toBeCloseTo(0.2, 10)
    expect(decision.slots[0]?.novelty).toBe(1)
    expect(winnerOf(await decideThrough(live, roundId))).toBe(0)
  })

  it('refuses a decision the facts no longer imply, because a measurement moved after it was composed', async () => {
    const live = await deployment()
    const roundId = await openThrough(live, { candidates: 1, historyCutoff: 5 })
    measuredAt(live.table, INCUMBENT, 0, 0.4)
    live.table.evaluations.set('e-0', evaluation('e-0', { observed: 1, missing: [{ slot: 1, reason: 'not run yet' }] }))
    await submitThrough(live, roundId, 0, { evaluationId: 'e-0' })

    const deciding = decideThrough(live, roundId)
    // The trial lands after the decision was composed and before it reaches the commit region: the
    // round's own state never sees it, and the recomputation inside the region does.
    live.table.evaluations.set('e-0', evaluation('e-0'))
    await expectRefusal(() => deciding, 'illegal-transition', 'recompute the decision against the current cut')
    expect(stateOf(live, roundId)?.decision).toBeUndefined()
  })

  it('refuses an incumbent aggregate from today\u2019s head, and a noise basis with no named source', async () => {
    const live = await deployment()
    const roundId = await openThrough(live, { candidates: 1, historyCutoff: 0 })
    measuredAt(live.table, INCUMBENT, 3, 0.4)
    live.table.evaluations.set('e-0', evaluation('e-0', { quality: 0.9 }))
    await submitThrough(live, roundId, 0, { evaluationId: 'e-0' })

    const decision = project(live, roundId)
    expect(decision.slots[0]?.gain).toBe(null)
    expect(decision.slots[0]?.admissible).toBe(false)
    expect(decision.slots[0]?.reason).toContain('no aggregate below the round')
    expect(decision.winner).toBe(null)

    const basis = stateOf(live, roundId) as RoundState
    await expectRefusal(() => projectRound(basis, sliceOf(live.table), { floor: -1, source: 'measured' }), 'malformed-payload', 'finite number')
    await expectRefusal(() => projectRound(basis, sliceOf(live.table), { floor: 0.1, source: 'guessed' } as unknown as Calibration), 'malformed-payload', 'measured')
  })

  it('refuses an annealing policy that anneals upward', async () => {
    expect(() =>
      createStrategyCommands({
        store: {} as ControlSessionStore,
        rounds: 3,
        firstBudget: 1,
        minimumBudget: 4,
        calibration: FLOOR,
        measuresAt: () => sliceOf(tableOf()),
      }),
    ).toThrow(/anneal downward/)
  })
})

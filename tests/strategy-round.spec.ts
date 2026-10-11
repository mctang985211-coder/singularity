/**
 * The explicit round: its submission gate, the decision that closes it, and the projection that decides.
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
  expect(`${refusal.code}|${refusal.detail.includes(fragment)}`).toContain(`${code}|true`)
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
  editBudget: 2, historyCutoff: 0, caliber: CALIBER, weights: WEIGHTS,
  ...over,
})
const emitPlan = (log: MemoryLog, subject: string, over: Record<string, unknown> = {}): Envelope => emit(log, STRATEGY_KINDS.roundOpened, subject, plan(over))
const emitSubmission = (log: MemoryLog, subject: string, slot: number, over: Record<string, unknown> = {}): Envelope =>
  emit(log, STRATEGY_KINDS.candidateSubmitted, subject, { slot, revision: CANDIDATE_A, evaluationId: `e-${slot}`, edits: SKILL, exploratory: false, ...over })
const emitDecision = (log: MemoryLog, subject: string, over: Record<string, unknown> = {}): Envelope =>
  emit(log, STRATEGY_KINDS.roundDecided, subject, { winner: null, outcomes: [], calibration: FLOOR, ...over })
/** One round's folded state as of the whole memory log. */
const roundIn = (log: MemoryLog, subject: string): RoundState | undefined => log.stateAt<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, subject, log.count)

/** One evaluation as the measure slice would project it, in its own metric's direction. */
const evaluation = (evaluationId: string, over: Partial<RoundEvaluation> = {}): RoundEvaluation => ({
  evaluationId, caliberDigest: over.caliberDigest ?? CALIBER, baseline: over.baseline ?? INCUMBENT,
  candidate: over.candidate ?? CANDIDATE_A, denominator: over.denominator ?? 2,
  observed: over.observed ?? 2, missing: over.missing ?? [], quality: over.quality ?? 0.6,
  cost: over.cost === undefined ? 10 : over.cost,
  constraints: over.constraints ?? [{ criterionId: 'correctness', met: true }],
  admissible: over.admissible ?? true, why: over.why === undefined ? null : over.why,
  direction: over.direction ?? 'higher',
})

type MeasureTable = { evaluations: Map<string, RoundEvaluation>; aggregates: Map<string, { at: number; aggregate: FrozenAggregate }[]> }
const tableOf = (): MeasureTable => ({ evaluations: new Map(), aggregates: new Map() })
const measuredAt = (table: MeasureTable, revision: RevisionRef, at: number, quality: number, cost: number | null = 10): void => {
  table.aggregates.set(revision.revisionId, [...(table.aggregates.get(revision.revisionId) ?? []), { at, aggregate: { quality, cost } }])
}
/**
 * The slice the round reads: the historical aggregate honours the round's own cutoff, and the accepted
 */
const sliceOf = (table: MeasureTable, entries: readonly Envelope[]): MeasureSlice => ({
  entries,
  evaluationOf: id => table.evaluations.get(id),
  incumbentBelow: (revision, cutoff) => {
    const below = (table.aggregates.get(revision.revisionId) ?? []).filter(entry => entry.at < cutoff).sort((left, right) => right.at - left.at)
    return below[0]?.aggregate ?? null
  },
})

type Live = { readonly store: ControlSessionStore; readonly commands: StrategyCommands; readonly table: MeasureTable; readonly calibration: Calibration }
const deployments: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const live of deployments.splice(0)) {
    await Promise.all([live.context.fiber.dispose(), rm(live.root, { recursive: true, force: true })])
  }
})
async function deployment(over: { rounds?: number; firstBudget?: number; minimumBudget?: number; calibration?: Calibration } = {}): Promise<Live> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-strategy-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  deployments.push({ context, root })
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence, controlId: 'strategy', registry: strategyRegistry(), subjects: SUBJECTS,
  })
  const table = tableOf()
  const calibration = over.calibration ?? FLOOR
  const commands = createStrategyCommands({ store, rounds: over.rounds ?? 3, firstBudget: over.firstBudget ?? 4, minimumBudget: over.minimumBudget ?? 1, calibration, measuresAt: cut => sliceOf(table, cut.entries()) })
  return { store, commands, table, calibration }
}
async function openThrough(live: Live, over: Partial<OpenRoundInput> = {}): Promise<string> {
  const roundId = over.roundId ?? nextId('round')
  await live.commands.openRound({
    commandId: nextId('open'), roundId, round: over.round ?? 1, incumbent: INCUMBENT,
    candidates: over.candidates ?? 2, explorationSlots: over.explorationSlots ?? 0,
    historyCutoff: over.historyCutoff ?? live.store.load().entries().length, caliber: over.caliber ?? CALIBER,
    weights: WEIGHTS,
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
const project = (live: Live, roundId: string): ReturnType<typeof projectRound> =>
  projectRound(stateOf(live, roundId) as RoundState, sliceOf(live.table, live.store.load().entries()), live.calibration)

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
/** A round that declared two slots, was offered one measured candidate in slot 0, and nothing in slot 1. */
async function halfRound(live: Live, explorationSlots = 0): Promise<string> {
  const roundId = await openThrough(live, { candidates: 2, explorationSlots, historyCutoff: 5 })
  measuredAt(live.table, INCUMBENT, 0, 0.4)
  live.table.evaluations.set('e-0', evaluation('e-0', { candidate: CANDIDATE_A }))
  await submitThrough(live, roundId, 0, { evaluationId: 'e-0' })
  return roundId
}

describe('round/opened freezes one explicit round', async () => {
  it('carries the number, incumbent, plan, budget, cutoff and weights — and opens once', async () => {
    const log = strategyLog()
    const opened = emitPlan(log, 'round-1')
    expect([Object.keys(opened.payload as Record<string, unknown>).sort(), roundIn(log, 'round-1')?.plan?.round]).toEqual([['caliber', 'candidates', 'editBudget', 'explorationSlots', 'historyCutoff', 'incumbent', 'round', 'weights'], 1])
    await expectRefusal(() => emitPlan(log, 'round-1'), 'illegal-transition', 'a different round, and it gets a different subject')
    await expectRefusal(() => emitPlan(log, 'round-zero', { round: 0 }), 'malformed-payload', 'never a count of history entries')
    await expectRefusal(() => emitPlan(log, 'round-wide', { explorationSlots: 4 }), 'malformed-payload', 'cannot exceed')
    await expectRefusal(() => emitPlan(log, 'round-empty', { candidates: 0 }), 'malformed-payload', 'at least 1')
    await expectRefusal(() => emitPlan(log, 'round-weightless', { weights: { quality: 0, cost: 15 } }), 'malformed-payload', 'cannot prefer')
  })
})

describe('the submission gate is the reducer\u2019s, inside the commit region', async () => {
  it('refuses every way a submission can violate the plan, and admits the two legal shapes', async () => {
    const log = strategyLog()
    emitPlan(log, 'round-1', { explorationSlots: 2 })
    emitSubmission(log, 'round-1', 2, { exploratory: true })
    const wide = [{ asset: 'skill' as const, target: 'count' }, { asset: 'tool' as const, target: 'tokenizer' }, { asset: 'template' as const, target: 'report' }]
    await expectRefusal(() => emitSubmission(log, 'round-1', 3), 'illegal-transition', 'plans slots 0..2')
    await expectRefusal(() => emitSubmission(log, 'round-1', 2, { exploratory: true }), 'evidence-conflict', 'one slot holds one candidate')
    await expectRefusal(() => emitSubmission(log, 'round-1', 0, { edits: wide }), 'budget-exhausted', 'anneals to a budget of 2')
    await expectRefusal(() => emitSubmission(log, 'round-1', 0, { edits: [...SKILL, ...SKILL] }), 'malformed-payload', 'one structural change per target')
    // The revision is closed by the set the declaration names and hands to `revisionRef`, not by a copy
    // in the reader: one more member in the pin is refused by name.
    await expectRefusal(() => emitSubmission(log, 'round-1', 0, { revision: { ...CANDIDATE_A, note: 'extra' } }), 'malformed-payload', 'note')
    await expectRefusal(() => emitSubmission(log, 'round-1', 1), 'illegal-transition', 'reserves for exploration')
    const both = [{ asset: 'skill' as const, target: 'count' }, { asset: 'tool' as const, target: 'count' }]
    emitSubmission(log, 'round-1', 0, { edits: both })
    expect(roundIn(log, 'round-1')?.submissions.map(entry => [entry.slot, entry.exploratory])).toEqual([[2, true], [0, false]])

    const quiet = 'gain 0.05 is inside the noise band 0.1'
    // Slot 1 is a reserved exploration slot nobody took, closed out with a reason of its own.
    emitDecision(log, 'round-1', { winner: null, outcomes: [{ slot: 0, admitted: false, reason: quiet }, { slot: 1, admitted: false, reason: 'no candidate was submitted to this slot' }, { slot: 2, admitted: false, reason: quiet }] })
    expect(roundIn(log, 'round-1')?.decision?.winner).toBe(null)
    await expectRefusal(() => emitSubmission(log, 'round-1', 1, { exploratory: true }), 'illegal-transition', 'after round 1 closed')
  })
})

describe('a decision still refuses a winner it does not admit, an empty reason and a second decision', async () => {
  it('refuses an unadmitted winner, an outcome outside the plan, a blank reason and a second decision', async () => {
    const log = strategyLog()
    emitPlan(log, 'round-1', { candidates: 2, explorationSlots: 0 })
    emitSubmission(log, 'round-1', 0)
    emitSubmission(log, 'round-1', 1)
    const both = [{ slot: 0, admitted: true, reason: 'the best aggregate of this round' }, { slot: 1, admitted: false, reason: 'in the noise band' }]

    await expectRefusal(() => emitDecision(log, 'round-1', { winner: 1, outcomes: both }), 'illegal-transition', 'null means the incumbent stands')
    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: [...both, { slot: 2, admitted: true, reason: 'never declared' }] }), 'illegal-transition', 'does not declare')
    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: [{ ...both[0], reason: '' }, both[1]] }), 'malformed-payload', 'reason')
    // The outcome shape is closed by `nested.outcomes`, the set the declaration hands that reader:
    // widening that reader by one member leaves every other case in this file green (round eight's B2).
    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: [{ ...both[0], note: 'x' }, both[1]] }), 'malformed-payload', 'note')

    const decided = emitDecision(log, 'round-1', { winner: 0, outcomes: both })
    expect([Object.keys(decided.payload as Record<string, unknown>).sort(), roundIn(log, 'round-1')?.decision?.winner]).toEqual([['calibration', 'outcomes', 'winner'], 0])
    await expectRefusal(() => emitDecision(log, 'round-1', { outcomes: both }), 'illegal-transition', 'decides round 1 again')
  })
})

describe('a decision covers the declared slots, not the submitted ones', async () => {
  it('refuses a decision that leaves a declared slot with no submission unaccounted, naming the slot', async () => {
    const log = strategyLog()
    emitPlan(log, 'round-1', { candidates: 2, explorationSlots: 0 })
    emitSubmission(log, 'round-1', 0)
    const closed = [{ slot: 0, admitted: true, reason: 'the best aggregate of this round' }]
    await expectRefusal(() => emitDecision(log, 'round-1', { winner: 0, outcomes: closed }), 'illegal-transition', 'declared slot 1')
  })

  it('closes a round whose outcomes cover every declared slot, the empty ones included', async () => {
    const live = await deployment()
    const roundId = await halfRound(live)
    await decideThrough(live, roundId)
    expect(stateOf(live, roundId)?.decision?.outcomes.map(outcome => outcome.slot)).toEqual([0, 1])
  })

  it('never admits a declared slot nobody submitted to, so only a submitted slot can be a winner', async () => {
    const log = strategyLog()
    emitPlan(log, 'round-1', { candidates: 2, explorationSlots: 0 })
    emitSubmission(log, 'round-1', 0)
    const invented = [{ slot: 0, admitted: false, reason: 'in the noise band' }, { slot: 1, admitted: true, reason: 'a candidate nobody offered' }]
    await expectRefusal(() => emitDecision(log, 'round-1', { winner: 1, outcomes: invented }), 'illegal-transition', 'only a submitted slot can be a winner')
  })

  it('does not refuse a round for leaving a reserved exploration slot empty, and records it', async () => {
    const live = await deployment()
    const roundId = await halfRound(live, 1)
    await decideThrough(live, roundId)
    const reserved = stateOf(live, roundId)?.decision?.outcomes.find(outcome => outcome.slot === 1)
    expect([reserved?.admitted, reserved?.reason]).toEqual([false, expect.stringContaining('no candidate was submitted to this slot')])
  })
})

describe('the round command service', async () => {
  it('derives the annealed budget from the round number, freezes it, and refuses a reused round number', async () => {
    const live = await deployment({ rounds: 3, firstBudget: 4, minimumBudget: 1 })
    const first = await openThrough(live, { round: 1 })
    const last = await openThrough(live, { roundId: 'round-last', round: 3 })
    expect([stateOf(live, first)?.plan?.editBudget, stateOf(live, last)?.plan?.editBudget]).toEqual([editBudgetFor(1, 3, 4, 1), 1])

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
    await expectRefusal(() => submitThrough(live, roundId, 0, { evaluationId: 'e-0' }), 'evidence-input-mismatch', 'the observation is about a different candidate')
  })
})

describe('the projection compares relative cost against the frozen incumbent', () => {
  it.each([
    { baseline: 9558, candidate: 9595, winner: 0 },
    { baseline: 10, candidate: 12, winner: 0 },
    { baseline: 1000, candidate: 1200, winner: 0 },
    { baseline: 1000, candidate: 1300, winner: null },
  ])('decides $baseline → $candidate tokens using the 25% ceiling', async ({ baseline, candidate, winner }) => {
    const live = await deployment({ calibration: { floor: 0, source: 'declared' } })
    const roundId = await openThrough(live, { candidates: 1, historyCutoff: 5 })
    measuredAt(live.table, INCUMBENT, 0, 0, baseline)
    live.table.evaluations.set('e-0', evaluation('e-0', { quality: 1, cost: candidate }))
    await submitThrough(live, roundId, 0)
    const decision = project(live, roundId)
    expect(decision.slots[0]?.cost).toBe(candidate)
    expect(decision.slots[0]?.costGain).toBeCloseTo((candidate - baseline) / baseline, 12)
    expect(winnerOf(await decideThrough(live, roundId))).toBe(winner)
  })

  it('leaves a relative cost unknown when the frozen baseline cost is zero', async () => {
    const live = await deployment()
    const roundId = await openThrough(live, { candidates: 1, historyCutoff: 5 })
    measuredAt(live.table, INCUMBENT, 0, 0, 0)
    live.table.evaluations.set('e-0', evaluation('e-0', { quality: 1, cost: 0 }))
    await submitThrough(live, roundId, 0)
    expect(project(live, roundId).slots[0]?.costGain).toBe(null)
    const decision = await decideThrough(live, roundId)
    expect(winnerOf(decision)).toBe(null)
    expect(stateOf(live, roundId)?.decision?.outcomes[0]?.reason).toContain('cost change unknown')
  })
})

describe('the projection decides admissibility before any argmax', async () => {
  it('never lets a higher aggregate buy a violated hard constraint', async () => {
    const live = await deployment()
    const roundId = await twoCandidateRound(live, { e0: { quality: 0.9, constraints: [{ criterionId: 'correctness', met: false }] } })
    const decision = project(live, roundId)
    expect([decision.slots[0]?.constraintsMet, decision.slots[0]?.admissible, decision.slots[0]?.reason]).toEqual([false, false, expect.stringContaining('"correctness"')])
    expect(winnerOf(await decideThrough(live, roundId))).toBe(1)
    const outcomes = stateOf(live, roundId)?.decision?.outcomes ?? []
    expect([outcomes.find(outcome => outcome.slot === 0)?.reason, outcomes.find(outcome => outcome.slot === 1)?.admitted]).toEqual([expect.stringContaining('"correctness"'), true])
  })

  it('refuses an incomplete measurement, and retains the incumbent when nothing is admissible', async () => {
    const live = await deployment()
    const partial = { quality: 0.95, observed: 1, missing: [{ slot: 1, reason: 'the trial never ran' }] }
    const roundId = await twoCandidateRound(live, { e0: partial })
    const decision = project(live, roundId)
    expect([decision.slots[0]?.admissible, decision.slots[0]?.reason, decision.winner]).toEqual([false, expect.stringMatching(/1 of 2 planned trials observed.*slot 1 \(the trial never ran\)/), 1])

    const nothingAdmissible = await twoCandidateRound(live, { round: 2, e0: partial, e1: { constraints: [{ criterionId: 'correctness', met: false }] } })
    expect([winnerOf(await decideThrough(live, nothingAdmissible)), stateOf(live, nothingAdmissible)?.decision?.outcomes[0]?.reason]).toEqual([null, expect.stringContaining('incomplete')])
  })

  it('refuses a measurement taken against another baseline, and refuses to pool two calibers', async () => {
    const live = await deployment()
    const stale = await twoCandidateRound(live, { e0: { quality: 0.9, baseline: CANDIDATE_B } })
    const decision = project(live, stale)
    expect([decision.slots[0]?.admissible, decision.slots[0]?.reason]).toEqual([false, expect.stringContaining("not round 1's incumbent")])
    // Slot 1 is sound and still wins: one stale baseline does not block the round.
    expect(winnerOf(await decideThrough(live, stale))).toBe(1)

    const mixed = await twoCandidateRound(live, { round: 2, e1: { caliberDigest: '0'.repeat(64) } })
    await expectRefusal(() => decideThrough(live, mixed), 'caliber-mismatch', 'may not be ranked together')

    // One submission under another caliber: with no second candidate to differ from, the round's own
    // caliber is the only thing that can catch it.
    const odd = await twoCandidateRound(live, { round: 4, e0: { caliberDigest: '1'.repeat(64) }, e1: { caliberDigest: '1'.repeat(64) } })
    expect([project(live, odd).slots[0]?.admissible, project(live, odd).slots[0]?.reason ?? '']).toEqual([false, expect.stringMatching(/measured under caliber 111111111111.*round 4 pools only ffffffffffff/)])
    expect(winnerOf(await decideThrough(live, odd))).toBe(null)

    // A submission recorded before its evaluation existed: the projection is where it is caught.
    const later = await openThrough(live, { candidates: 1, historyCutoff: 5, round: 3 })
    await submitThrough(live, later, 0, { evaluationId: 'e-later' })
    live.table.evaluations.set('e-later', evaluation('e-later', { candidate: CANDIDATE_B }))
    expect(project(live, later).slots[0]?.reason).toContain('the observation is about a different candidate')
  })

  it('computes the gain and the novelty below the round\u2019s own cutoff, and breaks a tie by slot number', async () => {
    const live = await deployment()
    // The incumbent was measured at 0.6 below the cutoff and 0.8 above it, so the frozen gain is +0.2
    // (R03); nothing is published below the cutoff, so the one declared class is novel: 1 (R05).
    const roundId = await twoCandidateRound(live, { e0: { quality: 0.8 }, e1: { quality: 0.8 }, edits0: [{ asset: 'tool', target: 'tokenizer' }] })
    measuredAt(live.table, INCUMBENT, 1, 0.6)
    measuredAt(live.table, INCUMBENT, 9, 0.8)
    const decision = project(live, roundId)
    expect([decision.slots[0]?.gain, decision.slots[0]?.novelty]).toEqual([expect.closeTo(0.2, 10), 1])
    expect(winnerOf(await decideThrough(live, roundId))).toBe(0)
  })

  it('treats the incumbent\u2019s own quality as a floor, with the band taken from the round\u2019s calibration', async () => {
    const live = await deployment({ calibration: { floor: 0.1, source: 'measured' } })
    const roundId = await openThrough(live, { candidates: 1, historyCutoff: 5 })
    measuredAt(live.table, INCUMBENT, 0, 0.7)
    live.table.evaluations.set('e-0', evaluation('e-0', { quality: 0.55, cost: 1 }))
    await submitThrough(live, roundId, 0, { evaluationId: 'e-0' })
    expect(project(live, roundId).slots[0]?.reason ?? '').toMatch(/below the admissible floor.*the measured noise band/)
    expect(winnerOf(await decideThrough(live, roundId))).toBe(null)

    const lenient = await deployment({ calibration: { floor: 0.2, source: 'declared' } })
    const second = await openThrough(lenient, { candidates: 1, historyCutoff: 5 })
    measuredAt(lenient.table, INCUMBENT, 0, 0.7)
    lenient.table.evaluations.set('e-0', evaluation('e-0', { quality: 0.57, cost: 1 }))
    await submitThrough(lenient, second, 0, { evaluationId: 'e-0' })
    expect([project(lenient, second).slots[0]?.admissible, winnerOf(await decideThrough(lenient, second))]).toEqual([true, 0])
    expect(stateOf(lenient, second)?.decision?.calibration).toEqual({ floor: 0.2, source: 'declared' })
  })

  it('reports a decided round from its record, and an open round as a preview', async () => {
    const live = await deployment()
    const roundId = await twoCandidateRound(live, { e0: { quality: 0.8 } })
    const decided = await decideThrough(live, roundId)
    expect(winnerOf(decided)).toBe(0)

    // A closed round is read from its record, which the commit region verified against this very
    // projection at its own cut: a caller's different calibration, or a measurement that arrived
    // after the decision, cannot flip what the round decided.
    const otherBasis: Calibration = { floor: 5, source: 'declared' }
    const projected = projectRound(stateOf(live, roundId) as RoundState, sliceOf(live.table, live.store.load().entries()), otherBasis)
    expect([projected.decided, projected.winner]).toEqual([true, 0])
    expect(projected.calibration).toEqual(FLOOR)
    live.table.evaluations.set('e-0', evaluation('e-0', { quality: 0 }))
    const flipped = projectRound(stateOf(live, roundId) as RoundState, sliceOf(live.table, live.store.load().entries()), otherBasis)
    expect([flipped.decided, flipped.winner]).toEqual([true, 0])

    // An open round has no record: it is a preview, recomputed from the slice.
    const openId = await openThrough(live, { round: 2 })
    await submitThrough(live, openId, 0, { evaluationId: 'e-open' })
    const preview = projectRound(stateOf(live, openId) as RoundState, sliceOf(live.table, live.store.load().entries()), live.calibration)
    expect(preview.decided).toBe(false)
  })

  it('refuses a decision the facts no longer imply, because a measurement moved after it was composed', async () => {
    const live = await deployment()
    const roundId = await openThrough(live, { candidates: 1, historyCutoff: 5 })
    measuredAt(live.table, INCUMBENT, 0, 0.4)
    live.table.evaluations.set('e-0', evaluation('e-0', { observed: 1, missing: [{ slot: 1, reason: 'not run yet' }] }))
    await submitThrough(live, roundId, 0, { evaluationId: 'e-0' })

    const deciding = decideThrough(live, roundId)
    // The trial lands between composing the decision and its commit region, where it is recomputed.
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
    expect([decision.slots[0]?.gain, decision.slots[0]?.admissible, decision.slots[0]?.reason, decision.winner]).toEqual([null, false, expect.stringContaining('no aggregate below the round'), null])

    const basis = stateOf(live, roundId) as RoundState
    await expectRefusal(() => projectRound(basis, sliceOf(live.table, live.store.load().entries()), { floor: -1, source: 'measured' }), 'malformed-payload', 'finite number')
    await expectRefusal(() => projectRound(basis, sliceOf(live.table, live.store.load().entries()), { floor: 0.1, source: 'guessed' } as unknown as Calibration), 'malformed-payload', 'measured')
  })

  it('refuses an annealing policy that anneals upward', async () => {
    expect(() => createStrategyCommands({ store: {} as ControlSessionStore, rounds: 3, firstBudget: 1, minimumBudget: 4, calibration: FLOOR, measuresAt: () => sliceOf(tableOf(), []) })).toThrow(/anneal downward/)
  })
})

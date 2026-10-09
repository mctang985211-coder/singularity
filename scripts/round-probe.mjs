#!/usr/bin/env node
/**
 * `strategy@1` end to end, in a real process, over a real DSH session.
 *
 * Everything durable here is real: a control store over a JSONL session on disk, `round/opened` and
 * `candidate/submitted` and `round/decided` written through the command boundary, refusals raised by
 * the reducer inside the commit region, and the state read back by reopening the store.
 *
 * What it exists to prove, in the order it proves it:
 *
 *   1. the round number is explicit and unique, and the edit budget is **annealed from it** — the
 *      first round is wider than the last, and the last round reaches the declared minimum;
 *   2. the submission gate holds through the command surface: an out-of-range slot, an occupied
 *      slot, an over-budget submission, a repeated `(asset, target)`, a non-exploratory candidate in
 *      a reserved slot, and a submission after the round closed are each refused by name;
 *   3. a candidate's evaluation must be an evaluation of the revision that slot offers;
 *   4. two calibers may not be pooled, and the round is not decided when they would be;
 *   5. a higher aggregate never buys a violated hard constraint, an incomplete measurement is not
 *      admissible, and the decision closes every submitted slot out with a reason;
 *   6. a decision composed before a measurement landed is refused rather than appended;
 *   7. gains and novelty are frozen: facts recorded **above** the round's cutoff do not move the
 *      round's projection, however much later they land.
 *
 * On the measurement side: `src/measure/**` is another slice, so this probe records measurement
 * results as facts under its own `probe-measure` protocol and reads them back **below the round's
 * cutoff**. That keeps the cutoff a real log position and the frozen-history check a check against
 * real facts. The projection handed to the round is §5.4's aggregate, and nothing here pretends to
 * be the measure slice or the decision layer.
 *
 * Run: node scripts/round-probe.mjs
 *
 * @module singularity-core/scripts/round-probe
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence } from './dsh-control-runtime.mjs'
import { defineKind, ProtocolRegistry } from '../src/protocol/registry.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { createStrategyCommands } from '../src/strategy/commands.ts'
import { editBudgetFor } from '../src/strategy/decision.ts'
import {
  declareStrategyProtocol,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_ROLE,
  STRATEGY_VERSION,
} from '../src/strategy/protocol.ts'
import { projectRound } from '../src/strategy/view.ts'

const ENVIRONMENT = 'library-1'
const ROUNDS = 4
const FIRST_BUDGET = 4
const MINIMUM_BUDGET = 1
const FLOOR = { floor: 0.1, source: 'measured' }
const METRIC = { unit: 'score', direction: 'higher' }
const WEIGHTS = { quality: 100, cost: 15 }
const CALIBER_A = 'a1'.repeat(32)
const CALIBER_B = 'b2'.repeat(32)

const revisionOf = (revisionId, seed) => ({ environmentId: ENVIRONMENT, revisionId, digest: seed.repeat(64) })
const INCUMBENT = revisionOf('r0001', '1')
const CANDIDATE_0 = revisionOf('r0002', '2')
const CANDIDATE_1 = revisionOf('r0003', '3')
const CANDIDATE_2 = revisionOf('r0004', '4')

/** Completed and missing trials of one evaluation, as the recorded result states them. */
const trials = (qualities, denominator = 2) => ({
  denominator,
  observed: qualities.map((quality, slot) => ({ slot, quality })),
})

const result = (evaluationId, candidate, caliberDigest, qualities, constraints = [{ criterionId: 'correctness', met: true }], denominator = 2) => ({
  evaluationId,
  caliberDigest,
  baseline: INCUMBENT,
  candidate,
  ...trials(qualities, denominator),
  cost: 10,
  constraints,
})

// ---------------------------------------------------------------- the probe's measurement facts

/**
 * A stand-in for the measure slice: measurement results and published asset classes, as facts.
 *
 * One kind each, and the payload is stored as recorded — this is a probe-local protocol, never part
 * of `strategy@1`, and the projection below is the only thing that interprets it.
 */
const MEASURE_PROTOCOL = 'probe-measure'
const MEASURE_ROLE = 'probe-measure'
const MEASURE_KINDS = { recorded: 'measurement/recorded', published: 'assets/published' }

function declareProbeMeasure(registry) {
  const parse = raw => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('a probe-measure payload must be an object')
    return raw
  }
  registry.declare(MEASURE_PROTOCOL, 1, {
    initialState: { results: [] },
    kinds: {
      [MEASURE_KINDS.recorded]: defineKind({
        guarantees: { appended: true },
        emitter: MEASURE_ROLE,
        parse,
        reduce: (state, _envelope, payload) => ({ results: [...state.results, payload] }),
      }),
      [MEASURE_KINDS.published]: defineKind({
        guarantees: { appended: true },
        emitter: MEASURE_ROLE,
        parse,
        reduce: state => state,
      }),
    },
  })
}

const failures = []
let checks = 0
function check(label, ok, detail) {
  checks += 1
  if (!ok) failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
}

let refusals = 0
async function refusalOf(step) {
  refusals += 1
  try {
    await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected the step to refuse')
}

async function main() {
  // Resolved dynamically, after `dsh-control-runtime` has registered its resolve hook.
  const { ControlSessionStore } = await import('../src/control/session-store.ts')

  const root = await mkdtemp(join(tmpdir(), 'singularity-round-probe-'))
  const sessions = join(root, 'sessions')
  await mkdir(sessions, { recursive: true })

  const registry = new ProtocolRegistry()
  declareStrategyProtocol(registry)
  declareProbeMeasure(registry)
  const subjects = { [STRATEGY_ROLE]: 'strategy-service', [MEASURE_ROLE]: 'probe-measure-service' }

  const live = await openPersistence(sessions)
  let store = await ControlSessionStore.open({ persistence: live.persistence, controlId: 'round-probe', registry, subjects, cwd: root })
  let commands

  try {
    /** One measurement result or publication, as a real fact. */
    const record = payload => {
      const kind = payload.assets === undefined ? MEASURE_KINDS.recorded : MEASURE_KINDS.published
      const subject = payload.assets === undefined ? payload.evaluationId : `published-${store.load().entries().length}`
      return store.emit({ commandId: `m-${store.load().entries().length}-${subject}`, protocol: MEASURE_PROTOCOL, version: 1, kind, subject, payload })
    }

    /** The §5.4 projection of one recorded result: observed quality over the plan's denominator. */
    const viewOf = fact => {
      const payload = fact.payload
      const missing = []
      for (let slot = 0; slot < payload.denominator; slot += 1) {
        if (!payload.observed.some(entry => entry.slot === slot))
          missing.push({ slot, reason: `trial ${slot} was never recorded` })
      }
      return {
        evaluationId: payload.evaluationId,
        caliberDigest: payload.caliberDigest,
        baseline: payload.baseline,
        candidate: payload.candidate,
        denominator: payload.denominator,
        observed: payload.observed.length,
        missing,
        quality: payload.observed.reduce((total, entry) => total + entry.quality, 0) / payload.denominator,
        cost: payload.cost ?? null,
        constraints: payload.constraints,
        admissible: missing.length === 0 && payload.constraints.every(constraint => constraint.met === true),
        why:
          missing.length > 0
            ? `${missing.length} of ${payload.denominator} planned trials have no observation`
            : payload.constraints
                .filter(constraint => constraint.met !== true)
                .map(constraint => `constraint "${constraint.criterionId}" is ${constraint.met === false ? 'violated' : 'unchecked'}`)
                .join('; ') || null,
      }
    }

    /**
     * The measure slice as of one log position. The historical reads then narrow that to the
     * round's own cutoff — which is the round's argument, not the caller's position — while a
     * candidate's own evaluation is read at the cut, because a round's candidates are measured
     * during the round.
     */
    const sliceAt = cut => {
      const facts = store.load().entriesOf(MEASURE_PROTOCOL, 1).filter(fact => fact.seq < cut)
      const lastBelow = (cutoff, accept) => facts.filter(fact => fact.seq < cutoff && accept(fact)).at(-1)
      return {
        evaluationOf: id => {
          const found = facts.filter(fact => fact.kind === MEASURE_KINDS.recorded && fact.payload.evaluationId === id).at(-1)
          return found === undefined ? undefined : viewOf(found)
        },
        incumbentBelow: (revision, cutoff) => {
          const found = lastBelow(cutoff, fact => fact.kind === MEASURE_KINDS.recorded && fact.payload.candidate.revisionId === revision.revisionId)
          return found === undefined ? null : { quality: viewOf(found).quality, cost: found.payload.cost ?? null }
        },
        acceptedAssetsBelow: cutoff => [
          ...new Set(facts.filter(fact => fact.kind === MEASURE_KINDS.published && fact.seq < cutoff).flatMap(fact => fact.payload.assets)),
        ].sort(),
      }
    }
    const head = () => store.load().entries().length

    const open = (roundId, round, over = {}) =>
      commands.openRound({
        commandId: `open-${roundId}`,
        roundId,
        round,
        incumbent: INCUMBENT,
        candidates: 3,
        explorationSlots: 1,
        historyCutoff: store.load().entries().length,
        metric: METRIC,
        weights: WEIGHTS,
        ...over,
      })

    const submit = (roundId, slot, over = {}) =>
      commands.submitCandidate({
        commandId: `submit-${roundId}-${slot}-${store.load().entries().length}`,
        roundId,
        slot,
        revision: CANDIDATE_1,
        evaluationId: `e-${slot}`,
        edits: [{ asset: 'skill', target: 'count' }],
        exploratory: false,
        ...over,
      })

    const openCommands = (calibration = FLOOR) =>
      createStrategyCommands({
        store,
        rounds: ROUNDS,
        firstBudget: FIRST_BUDGET,
        minimumBudget: MINIMUM_BUDGET,
        calibration,
        // The commit region hands the reader a fixed cut; the reader turns it into the log position
        // its historical reads are bounded by.
        measuresAt: cut => sliceAt(cut.entries().length),
      })
    commands = openCommands()

    // ---------------------------------------------------------------- the incumbent and its history
    // Both recorded before any round opens, so both sit below every round's cutoff: the incumbent's
    // own aggregate (the other side of every gain) and one accepted asset class for novelty.
    await record(result('incumbent-baseline', INCUMBENT, CALIBER_A, [0.4, 0.4]))
    await record({ assets: ['tool'] })

    // ---------------------------------------------------------------- 1. an explicit, annealed round
    const opened = await open('round-1', 1)
    const plan = store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-1').plan
    const firstBudget = plan.editBudget
    check('the round carries its own number', plan.round === 1)
    check('the budget is the annealed one for round 1', firstBudget === editBudgetFor(1, ROUNDS, FIRST_BUDGET, MINIMUM_BUDGET), `got ${firstBudget}`)
    check('the first round is wider than the floor', firstBudget > MINIMUM_BUDGET, `got ${firstBudget}`)
    check('the opening fact is the one that was emitted', opened.kind === STRATEGY_KINDS.roundOpened)

    await open('round-last', ROUNDS)
    const lastBudget = store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-last').plan.editBudget
    check('the last round reaches the minimum budget', lastBudget === MINIMUM_BUDGET, `got ${lastBudget}`)

    const duplicateRound = await refusalOf(() => open('round-dup', 1))
    check('a second round may not reuse a round number', duplicateRound.code === 'illegal-transition', duplicateRound.code)

    // ---------------------------------------------------------------- 2. the submission gate
    const outOfRange = await refusalOf(() => submit('round-1', 3))
    check('a slot outside the plan is refused', outOfRange.code === 'illegal-transition', outOfRange.code)

    const reserved = await refusalOf(() => submit('round-1', 2))
    check(
      'a non-exploratory candidate may not take a reserved slot',
      reserved.code === 'illegal-transition' && reserved.detail.includes('reserves for exploration'),
      reserved.code,
    )

    const tooWide = await refusalOf(() =>
      submit('round-1', 0, { edits: Array.from({ length: firstBudget + 1 }, (_, index) => ({ asset: 'skill', target: `t${index}` })) }),
    )
    check('edits beyond the annealed budget are refused', tooWide.code === 'budget-exhausted', tooWide.code)

    const repeated = await refusalOf(() =>
      submit('round-1', 0, {
        edits: [
          { asset: 'skill', target: 'count' },
          { asset: 'skill', target: 'count' },
        ],
      }),
    )
    check('a repeated (asset, target) is refused', repeated.code === 'malformed-payload', repeated.code)

    // ---------------------------------------------------------------- 3. the evaluation is about the candidate
    await record(result('e-elsewhere', CANDIDATE_2, CALIBER_A, [0.9, 0.9]))
    const elsewhere = await refusalOf(() => submit('round-1', 0, { evaluationId: 'e-elsewhere', revision: CANDIDATE_1 }))
    check('an evaluation of another revision is refused', elsewhere.code === 'evidence-input-mismatch', elsewhere.code)

    // ---------------------------------------------------------------- the round's three candidates
    await record(result('e-0', CANDIDATE_0, CALIBER_A, [0.9, 0.9], [{ criterionId: 'correctness', met: false }]))
    await record(result('e-1', CANDIDATE_1, CALIBER_A, [0.6, 0.6]))
    await record(result('e-2', CANDIDATE_2, CALIBER_A, [0.95], [{ criterionId: 'correctness', met: true }]))

    await submit('round-1', 0, { evaluationId: 'e-0', revision: CANDIDATE_0 })
    await submit('round-1', 1, { evaluationId: 'e-1', revision: CANDIDATE_1 })
    await submit('round-1', 2, { evaluationId: 'e-2', revision: CANDIDATE_2, exploratory: true })

    const occupied = await refusalOf(() => submit('round-1', 1, { evaluationId: 'e-1', revision: CANDIDATE_1 }))
    check('a slot that already holds a candidate is refused', occupied.code === 'evidence-conflict', occupied.code)

    const state1 = () => store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-1')
    const before = projectRound(state1(), sliceAt(head()), FLOOR)
    check('an incomplete measurement is not admissible', before.slots[2].admissible === false && before.slots[2].reason.includes('incomplete'), before.slots[2].reason ?? '')
    check(
      'a violated hard constraint is not admissible',
      before.slots[0].admissible === false && before.slots[0].reason.includes('"correctness"'),
      before.slots[0].reason ?? '',
    )
    check('only the admissible candidate can win', before.winner === 1, `winner ${before.winner}`)
    check('novelty counts against the assets accepted below the cutoff', before.slots[1].novelty === 1, `novelty ${before.slots[1].novelty}`)

    // ---------------------------------------------------------------- 5. the decision closes every slot
    const decided = await commands.decideRound({ commandId: 'decide-1', roundId: 'round-1' })
    const decision = state1().decision
    check('the decision names an admitted winner', decided.kind === STRATEGY_KINDS.roundDecided && decision.winner === 1, `winner ${decision.winner}`)
    check(
      'every submitted slot is closed out with a reason',
      decision.outcomes.length === 3 && decision.outcomes.every(outcome => typeof outcome.reason === 'string' && outcome.reason.length > 0),
      `${decision.outcomes.length} outcomes`,
    )
    check('the winner is an admitted slot', decision.outcomes.find(outcome => outcome.slot === decision.winner).admitted === true)

    const late = await refusalOf(() => submit('round-1', 0, { evaluationId: 'e-0', revision: CANDIDATE_0 }))
    check('a submission after the close is refused', late.code === 'illegal-transition' && late.detail.includes('closed'), late.code)

    // ---------------------------------------------------------------- 6b. the incumbent is a floor
    // A candidate well below the incumbent but almost free: the in-band cost rule would admit it
    // (100*-0.15 - 15*-9 > 0), and only the incumbent's floor refuses it. The band is the round's
    // calibration, so the same facts under a declared, wider band are admissible.
    await open('round-floor', 5)
    await record(result('e-floor', CANDIDATE_0, CALIBER_A, [0.25, 0.25]))
    await submit('round-floor', 0, { evaluationId: 'e-floor', revision: CANDIDATE_0 })
    const stateFloor = () => store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-floor')
    const floored = projectRound(stateFloor(), sliceAt(head()), FLOOR)
    check(
      'a candidate below the incumbent floor is inadmissible',
      floored.slots[0].admissible === false && floored.slots[0].reason.includes('below the admissible floor'),
      floored.slots[0].reason ?? '',
    )
    check('the reason names the measured band it was judged against', floored.slots[0].reason.includes('the measured noise band'))
    const belowFloor = await refusalOf(() => commands.decideRound({ commandId: 'decide-floor', roundId: 'round-floor' }))
    check('a below-floor winner cannot be decided into the log', belowFloor.code === 'illegal-transition', belowFloor.code)
    check('the refused round has no decision fact', stateFloor().decision === undefined)

    const lenient = openCommands({ floor: 0.2, source: 'declared' })
    const widened = projectRound(stateFloor(), sliceAt(head()), { floor: 0.2, source: 'declared' })
    check('the same candidate clears a declared, wider band', widened.slots[0].admissible === true, widened.slots[0].reason ?? '')
    check('the wider band is the one the decision records', (await lenient.decideRound({ commandId: 'decide-floor-declared', roundId: 'round-floor' })).kind === STRATEGY_KINDS.roundDecided)
    check('the admitted slot is the winner under the declared band', stateFloor().decision.winner === 0)
    check('the outcome names the declared band', stateFloor().decision.outcomes[0].reason.includes('(declared)'), stateFloor().decision.outcomes[0].reason)

    // ---------------------------------------------------------------- 7. gains and novelty are frozen
    // A re-measurement of the incumbent and a publication of `skill` land **above** the round's
    // cutoff. The round's projection must not move: that is R03's measured counterexample, where
    // publishing B rewrote A's Δ, and R05's, where an accepted asset class has to stay accepted.
    const later = await record(result('incumbent-later', INCUMBENT, CALIBER_A, [0.95, 0.95]))
    const laterAssets = await record({ assets: ['skill'] })
    check('the later facts are above the round cutoff', later.seq > plan.historyCutoff && laterAssets.seq > plan.historyCutoff, `seq ${later.seq} vs cutoff ${plan.historyCutoff}`)
    const after = projectRound(state1(), sliceAt(head()), FLOOR)
    check(
      'a fact above the cutoff does not move the frozen gain',
      after.slots[1].gain === before.slots[1].gain && after.winner === before.winner,
      `gain ${after.slots[1].gain} vs ${before.slots[1].gain}`,
    )
    check('a fact above the cutoff does not move novelty', after.slots[1].novelty === before.slots[1].novelty, `novelty ${after.slots[1].novelty}`)

    // ---------------------------------------------------------------- 4. two calibers may not be pooled
    await open('round-2', 2)
    await record(result('e-c0', CANDIDATE_0, CALIBER_A, [0.7, 0.7]))
    await record(result('e-c1', CANDIDATE_1, CALIBER_B, [0.8, 0.8]))
    await submit('round-2', 0, { evaluationId: 'e-c0', revision: CANDIDATE_0 })
    await submit('round-2', 1, { evaluationId: 'e-c1', revision: CANDIDATE_1 })
    const mixed = await refusalOf(() => commands.decideRound({ commandId: 'decide-2', roundId: 'round-2' }))
    check('two calibers are refused rather than pooled', mixed.code === 'caliber-mismatch', mixed.code)
    check('the refused round has no decision fact', store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-2').decision === undefined)

    // ---------------------------------------------------------------- 6. a stale decision is refused
    await open('round-3', 3)
    await record(result('e-s0', CANDIDATE_0, CALIBER_A, [0.8]))
    await submit('round-3', 0, { evaluationId: 'e-s0', revision: CANDIDATE_0 })
    // The second trial is enqueued but not yet committed when the decision is composed, so the
    // decision says "incomplete" while the facts it will be appended to say "complete". The round's
    // own state never sees either version; the recomputation inside the commit region does.
    const landing = record(result('e-s0', CANDIDATE_0, CALIBER_A, [0.8, 0.8]))
    const deciding = commands.decideRound({ commandId: 'decide-3', roundId: 'round-3' })
    await landing
    const stale = await refusalOf(() => deciding)
    check('a decision the facts no longer imply is refused', stale.code === 'illegal-transition' && stale.detail.includes('recompute'), stale.detail)

    // ---------------------------------------------------------------- the facts survive a reopen
    await store.close()
    store = await ControlSessionStore.open({ persistence: live.persistence, controlId: 'round-probe', registry, subjects, cwd: root })
    commands = openCommands()
    const reopened = store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-1')
    check('the plan and the decision survive a reopen', reopened.plan.historyCutoff === plan.historyCutoff && reopened.decision.winner === 1)
    check(
      'the closed round still refuses a submission',
      (await refusalOf(() => submit('round-1', 0, { evaluationId: 'e-0', revision: CANDIDATE_0 }))).code === 'illegal-transition',
    )

    const rounds = [...store.load().statesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
    console.log('')
    console.log(
      `rounds opened: ${rounds.filter(state => state.plan !== undefined).length}, submissions committed: ${rounds.reduce(
        (total, state) => total + state.submissions.length,
        0,
      )}, decisions: ${rounds.filter(state => state.decision !== undefined).length}, checks: ${checks}, refusals: ${refusals}`,
    )
    console.log(`budget: round 1 = ${firstBudget}, round ${ROUNDS} = ${lastBudget}, floor = ${MINIMUM_BUDGET}`)
    console.log(`decision: winner slot ${decision.winner} of ${decision.outcomes.length} submitted slots`)
    console.log(`floor: ${floored.slots[0].quality} against incumbent ${FLOOR.source} band ${FLOOR.floor} — inadmissible; declared band 0.2 — admitted`)
    if (failures.length > 0) {
      console.log(`round-probe: ${failures.length} check(s) failed`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exitCode = 1
    } else {
      console.log('round-probe: OK')
    }
  } finally {
    await store.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  console.error(`round-probe: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
}

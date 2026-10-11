#!/usr/bin/env node
/**
 * `strategy@2` end to end, in a real process, over a real DSH session: a control store over a JSONL
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence } from './dsh-control-runtime.mjs'
import {
  declareEnvironmentProtocol, ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_ROLE, ENVIRONMENT_VERSION, PUBLISHER_ROLE,
} from '../src/environment/protocol.ts'
import { defineKind, ProtocolRegistry } from '../src/protocol/registry.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import { APPROVER_ROLE, declareReleaseProtocol } from '../src/release/protocol.ts'
import { createStrategyCommands } from '../src/strategy/commands.ts'
import { editBudgetFor } from '../src/strategy/decision.ts'
import { declareStrategyProtocol, STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_ROLE, STRATEGY_VERSION } from '../src/strategy/protocol.ts'
import { projectRound } from '../src/strategy/view.ts'
import { SCHEDULER_ROLE } from '../src/task/protocol.ts'

const ENVIRONMENT = 'library-1'
const PUBLISHED = 'r0003'
const ROUNDS = 4
const FIRST_BUDGET = 4
const MINIMUM_BUDGET = 1
const FLOOR = { floor: 0.1, source: 'measured' }
const WEIGHTS = { quality: 100, cost: 15 }
const CALIBER_A = 'a1'.repeat(32)
const CALIBER_B = 'b2'.repeat(32)
const SKILL = [{ asset: 'skill', target: 'count' }]

const revisionOf = (revisionId, seed) => ({ environmentId: ENVIRONMENT, revisionId, digest: seed.repeat(64) })
/** Revisions carry their real content digests once `main` has created them; the seeds are placeholders. */
let INCUMBENT = revisionOf('r0001', '1')
let CANDIDATE_0 = revisionOf('r0002', '2')
let CANDIDATE_1 = revisionOf('r0003', '3')
let CANDIDATE_2 = revisionOf('r0004', '4')

/** The asking agent and its session: the seam double answers on its behalf, one audit id per ask. */
const ASKING_AGENT = { session: { id: 'agent-round-probe' } }
let auditIds = 0
function seam() {
  const listeners = new Set()
  return {
    approval: {
      request: async () => {
        for (const listener of [...listeners]) listener(ASKING_AGENT.session, { type: 'approval/asked', data: { id: `audit-${(auditIds += 1)}` } })
        return 'allowed-once'
      },
    },
    feed: { on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) } },
  }
}

/** Completed trials of one evaluation, as the recorded result states them. */
const trials = (qualities, denominator = 2) => ({ denominator, observed: qualities.map((quality, slot) => ({ slot, quality })) })
const result = (evaluationId, candidate, caliberDigest, qualities, constraints = [{ criterionId: 'correctness', met: true }], denominator = 2, cost = 10) => ({
  evaluationId, caliberDigest, baseline: INCUMBENT, candidate, ...trials(qualities, denominator), cost, constraints, direction: 'higher',
})

// ---------------------------------------------------------------- the probe's measurement facts

/**
 * A stand-in for the measure slice: one measurement result per fact, stored as recorded.
 */
const MEASURE_PROTOCOL = 'probe-measure', MEASURE_ROLE = 'probe-measure', MEASURE_KIND = 'measurement/recorded'
function declareProbeMeasure(registry) {
  registry.declare(MEASURE_PROTOCOL, 1, {
    initialState: { results: [] },
    kinds: {
      [MEASURE_KIND]: defineKind({
        guarantees: { appended: true },
        emitter: MEASURE_ROLE,
        parse: raw => {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a probe-measure payload must be an object')
          return raw
        },
        reduce: (state, _envelope, payload) => ({ results: [...state.results, payload] }),
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
  for (const declare of [declareStrategyProtocol, declareProbeMeasure, declareEnvironmentProtocol, declareReleaseProtocol]) declare(registry)
  const subjects = {
    [STRATEGY_ROLE]: 'strategy-service', [MEASURE_ROLE]: 'probe-measure-service', [ENVIRONMENT_ROLE]: 'environment-service',
    [PUBLISHER_ROLE]: 'publisher-service', [SCHEDULER_ROLE]: 'scheduler-service', [APPROVER_ROLE]: 'approval-seam',
  }

  const live = await openPersistence(sessions)
  let store = await ControlSessionStore.open({ persistence: live.persistence, controlId: 'round-probe', registry, subjects, cwd: root })
  let commands

  try {
    /** One measurement result, as a real fact. */
    const record = payload =>
      store.emit({
        commandId: `m-${store.load().entries().length}-${payload.evaluationId}`, protocol: MEASURE_PROTOCOL, version: 1,
        kind: MEASURE_KIND, subject: payload.evaluationId, payload,
      })

    /** The §5.4 projection of one recorded result: observed quality over the plan's denominator. */
    const viewOf = fact => {
      const payload = fact.payload
      const missing = []
      for (let slot = 0; slot < payload.denominator; slot += 1) if (!payload.observed.some(entry => entry.slot === slot)) missing.push({ slot, reason: `trial ${slot} was never recorded` })
      return {
        evaluationId: payload.evaluationId, caliberDigest: payload.caliberDigest, baseline: payload.baseline, candidate: payload.candidate,
        denominator: payload.denominator, observed: payload.observed.length, missing, cost: payload.cost ?? null, constraints: payload.constraints,
        direction: payload.direction,
        quality: payload.observed.reduce((total, entry) => total + entry.quality, 0) / payload.denominator,
        admissible: missing.length === 0 && payload.constraints.every(constraint => constraint.met === true),
        why: missing.length > 0 ? `${missing.length} of ${payload.denominator} planned trials have no observation` : null,
      }
    }

    /**
     * The measure slice as of one log position: the facts at that cut, plus the two reads the round
     */
    const sliceAt = cut => {
      const facts = store.load().entriesOf(MEASURE_PROTOCOL, 1).filter(fact => fact.seq < cut)
      const recorded = id => facts.filter(fact => fact.payload.evaluationId === id).at(-1)
      return {
        entries: store.load().entries().filter(fact => fact.seq < cut),
        evaluationOf: id => (recorded(id) === undefined ? undefined : viewOf(recorded(id))),
        incumbentBelow: (revision, cutoff) => {
          const found = facts.filter(fact => fact.seq < cutoff && fact.payload.candidate.revisionId === revision.revisionId).at(-1)
          return found === undefined ? null : { quality: viewOf(found).quality, cost: found.payload.cost ?? null }
        },
      }
    }
    const head = () => store.load().entries().length
    const roundState = roundId => store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)
    const open = (roundId, round, over = {}) =>
      commands.openRound({
        commandId: `open-${roundId}`, roundId, round, incumbent: INCUMBENT, candidates: 3, explorationSlots: 1,
        historyCutoff: head(), caliber: CALIBER_A, weights: WEIGHTS, ...over })
    const submit = (roundId, slot, over = {}) =>
      commands.submitCandidate({
        commandId: `submit-${roundId}-${slot}-${head()}`, roundId, slot, revision: CANDIDATE_1,
        evaluationId: `e-${slot}`, edits: SKILL, exploratory: false, ...over })
    // The commit region hands the reader a fixed cut; the reader turns it into the log position its
    // historical reads are bounded by.
    const openCommands = (calibration = FLOOR) =>
      createStrategyCommands({
        store, rounds: ROUNDS, firstBudget: FIRST_BUDGET, minimumBudget: MINIMUM_BUDGET, calibration,
        measuresAt: cut => sliceAt(cut.entries().length),
      })
    commands = openCommands()

    // Every pin must carry the digest the log computed for its content, not an invented one:
    // `publishedAssetsBelow` recognises the elected submission by `sameRevision` against the revision
    // the head points at, so a placeholder digest names nothing this environment holds.
    const environmentState = () => store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)
    const createRevision = async (revisionId, manifest) => {
      await store.emit({ commandId: `create-${revisionId}`, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION, kind: ENVIRONMENT_KINDS.revisionCreated, subject: ENVIRONMENT, payload: { revisionId, manifest } })
      return environmentState().revisions[revisionId].contentDigest
    }
    INCUMBENT = { ...INCUMBENT, digest: await createRevision('r0001', { skills: ['count'] }) }
    CANDIDATE_0 = { ...CANDIDATE_0, digest: await createRevision('r0002', { tools: ['tokenizer'] }) }
    CANDIDATE_1 = { ...CANDIDATE_1, digest: await createRevision('r0003', { skills: ['count'] }) }
    CANDIDATE_2 = { ...CANDIDATE_2, digest: await createRevision('r0004', { templates: ['report'] }) }

    // ---------------------------------------------------------------- 1. an explicit, annealed round
    // The incumbent's own aggregate, recorded before any round opens, so it sits below every cutoff:
    // it is the other side of every gain computed below.
    await record(result('incumbent-baseline', INCUMBENT, CALIBER_A, [0.4, 0.4]))
    const opened = await open('round-1', 1)
    const plan = roundState('round-1').plan
    const firstBudget = plan.editBudget
    check('the round carries its own number', plan.round === 1)
    check('the budget is the annealed one for round 1', firstBudget === editBudgetFor(1, ROUNDS, FIRST_BUDGET, MINIMUM_BUDGET), `got ${firstBudget}`)
    check('the first round is wider than the floor', firstBudget > MINIMUM_BUDGET, `got ${firstBudget}`)
    check('the opening fact is the one that was emitted', opened.kind === STRATEGY_KINDS.roundOpened)
    await open('round-last', ROUNDS)
    const lastBudget = roundState('round-last').plan.editBudget
    check('the last round reaches the minimum budget', lastBudget === MINIMUM_BUDGET, `got ${lastBudget}`)
    check('a second round may not reuse a round number', (await refusalOf(() => open('round-dup', 1))).code === 'illegal-transition')

    check('a slot outside the plan is refused', (await refusalOf(() => submit('round-1', 3))).code === 'illegal-transition')
    const reserved = await refusalOf(() => submit('round-1', 2))
    check('a non-exploratory candidate may not take a reserved slot', reserved.code === 'illegal-transition' && reserved.detail.includes('reserves for exploration'), reserved.code)
    const wide = Array.from({ length: firstBudget + 1 }, (_, index) => ({ asset: 'skill', target: `t${index}` }))
    check('edits beyond the annealed budget are refused', (await refusalOf(() => submit('round-1', 0, { edits: wide }))).code === 'budget-exhausted')
    check('a repeated (asset, target) is refused', (await refusalOf(() => submit('round-1', 0, { edits: [...SKILL, ...SKILL] }))).code === 'malformed-payload')

    await record(result('e-elsewhere', CANDIDATE_2, CALIBER_A, [0.9, 0.9]))
    check('an evaluation of another revision is refused', (await refusalOf(() => submit('round-1', 0, { evaluationId: 'e-elsewhere', revision: CANDIDATE_1 }))).code === 'evidence-input-mismatch')

    await record(result('e-0', CANDIDATE_0, CALIBER_A, [0.9, 0.9], [{ criterionId: 'correctness', met: false }]))
    await record(result('e-1', CANDIDATE_1, CALIBER_A, [0.6, 0.6]))
    await record(result('e-2', CANDIDATE_2, CALIBER_A, [0.95]))
    await submit('round-1', 0, { evaluationId: 'e-0', revision: CANDIDATE_0 })
    await submit('round-1', 1, { evaluationId: 'e-1', revision: CANDIDATE_1 })
    await submit('round-1', 2, { evaluationId: 'e-2', revision: CANDIDATE_2, exploratory: true })
    check('a slot that already holds a candidate is refused', (await refusalOf(() => submit('round-1', 1, { evaluationId: 'e-1' }))).code === 'evidence-conflict')

    const before = projectRound(roundState('round-1'), sliceAt(head()), FLOOR)
    check('an incomplete measurement is not admissible', before.slots[2].admissible === false && before.slots[2].reason.includes('incomplete'), before.slots[2].reason ?? '')
    check('a violated hard constraint is not admissible', before.slots[0].admissible === false && before.slots[0].reason.includes('"correctness"'), before.slots[0].reason ?? '')
    check('only the admissible candidate can win', before.winner === 1, `winner ${before.winner}`)
    check('a round below the publication accepted nothing', before.slots[1].novelty === 1, `novelty ${before.slots[1].novelty}`)

    const decided = await commands.decideRound({ commandId: 'decide-1', roundId: 'round-1' })
    const decision = roundState('round-1').decision
    check('the decision names an admitted winner', decided.kind === STRATEGY_KINDS.roundDecided && decision.winner === 1, `winner ${decision.winner}`)
    check('every declared slot carries the disposition the projection read for it', decision.outcomes.length === before.slots.length && decision.outcomes.every(outcome => before.slots[outcome.slot].admissible === outcome.admitted), `${decision.outcomes.length} outcome(s) for ${before.slots.length} projected slot(s); disagreed: ${decision.outcomes.filter(outcome => before.slots[outcome.slot].admissible !== outcome.admitted).map(outcome => `slot ${outcome.slot} decided ${outcome.admitted}, projected ${before.slots[outcome.slot].admissible}`).join('; ') || 'none'}`)
    check('the winner is an admitted slot', decision.outcomes.find(outcome => outcome.slot === decision.winner)?.admitted === true)
    check('the decision records the band it was made under', decision.calibration.floor === FLOOR.floor && decision.calibration.source === FLOOR.source)
    const late = await refusalOf(() => submit('round-1', 0, { evaluationId: 'e-0', revision: CANDIDATE_0 }))
    check('a submission after the close is refused', late.code === 'illegal-transition' && late.detail.includes('closed'), late.code)

    // ---------------------------------------------------------------- 5. a real publication
    // Round 1 elected slot 1, which offered `r0003` and declared a `skill` change. Publish exactly that
    // revision: draft and approve the content the environment holds, then move the head onto it.
    const release = createReleaseCommands({ store, approvalSeams: seam() })
    const pin = { environmentId: ENVIRONMENT, revisionId: PUBLISHED, digest: CANDIDATE_1.digest }
    const draft = await release.draft({ commandId: 'draft-r0003', revision: pin })
    await release.approve({ commandId: 'approve-r0003', environmentId: ENVIRONMENT, revisionId: PUBLISHED, draftDigest: draft.payload.draftDigest, approvedBy: 'human:alice', ask: { agent: ASKING_AGENT, toolName: 'release_approve' } })
    await release.publish({ commandId: 'publish-r0003', environmentId: ENVIRONMENT, expected: '', to: PUBLISHED })
    check('the head moved onto the revision round 1 elected', environmentState().pointer === PUBLISHED)

    // ---------------------------------------------------------------- 6. novelty from the publication
    // Below this cutoff `skill` was accepted (the elected slot declared it) and `tool` was not: the
    // two slots must differ, which a constant or an empty history could not answer.
    await open('round-published', 8, { candidates: 2, explorationSlots: 0 })
    await record(result('e-skill', CANDIDATE_0, CALIBER_A, [0.8, 0.8]))
    await record(result('e-tool', CANDIDATE_1, CALIBER_A, [0.8, 0.8]))
    await submit('round-published', 0, { evaluationId: 'e-skill', revision: CANDIDATE_0, edits: SKILL })
    await submit('round-published', 1, { evaluationId: 'e-tool', revision: CANDIDATE_1, edits: [{ asset: 'tool', target: 'count' }] })
    const published = projectRound(roundState('round-published'), sliceAt(head()), FLOOR)
    check('an asset class the publication accepted is not novel', published.slots[0].novelty === 0, `novelty ${published.slots[0].novelty}`)
    check('an asset class no publication accepted is novel', published.slots[1].novelty === 1, `novelty ${published.slots[1].novelty}`)
    check('the tie between the two published-class candidates goes to the lower slot', published.winner === 0, `winner ${published.winner}`)

    // ---------------------------------------------------------------- the plan's coverage
    // `round-last` declares three slots and nobody submitted to any of them. A decision covers the plan:
    // one leaving a declared slot out is refused, and the accepted one closes all three out, each saying
    // it is untested rather than vanishing from the round's trajectory (R01). The partial one is emitted
    // directly, as a hand-made decision would be, so a weakened coverage rule would let it through.
    const untested = slot => ({ slot, admitted: false, reason: 'no candidate was submitted to this slot' })
    const partial = { commandId: 'decide-partial', protocol: STRATEGY_PROTOCOL, version: STRATEGY_VERSION, kind: STRATEGY_KINDS.roundDecided,
      subject: 'round-last', payload: { winner: null, outcomes: [untested(0), untested(1)], calibration: FLOOR } }
    const omission = await store.emit(partial).then(() => undefined, error => error.refusal)
    check('a decision that omits a declared slot is refused', omission?.code === 'illegal-transition' && omission.detail.includes('declared slot'), omission?.detail ?? 'the omission was accepted')
    const closed = await commands
      .decideRound({ commandId: 'decide-last', roundId: 'round-last' })
      .then(() => roundState('round-last').decision.outcomes, error => error.refusal)
    const allUntested = Array.isArray(closed) && closed.length === 3 && closed.every(outcome => outcome.admitted === false && outcome.reason.includes('no candidate was submitted to this slot'))
    check('a declared slot nobody submitted to is closed out as untested', allUntested, Array.isArray(closed) ? `${closed.length} outcomes` : closed.detail)
    // A candidate below the incumbent but almost free: the in-band cost rule would admit it
    // (100*-0.15 - 15*-9 > 0) and only the floor refuses it. The band is the calibration's, so the
    // same facts under a declared, wider band are admissible.
    await open('round-floor', 5)
    await record(result('e-floor', CANDIDATE_0, CALIBER_A, [0.25, 0.25], undefined, 2, 1))
    await submit('round-floor', 0, { evaluationId: 'e-floor', revision: CANDIDATE_0 })
    const floored = projectRound(roundState('round-floor'), sliceAt(head()), FLOOR)
    check('a candidate below the incumbent floor is inadmissible', floored.slots[0].admissible === false && floored.slots[0].reason.includes('below the admissible floor'), floored.slots[0].reason ?? '')
    check('the reason names the measured band it was judged against', floored.slots[0].reason.includes('the measured noise band'))
    await commands.decideRound({ commandId: 'decide-floor', roundId: 'round-floor' })
    check('the round retains the incumbent instead of electing the cheap, worse candidate', roundState('round-floor').decision.winner === null)
    check('the outcome carries the floor reason', roundState('round-floor').decision.outcomes[0].reason.includes('below the admissible floor'))

    const WIDE = { floor: 0.2, source: 'declared' }
    await open('round-floor-wide', 6)
    await submit('round-floor-wide', 0, { evaluationId: 'e-floor', revision: CANDIDATE_0 })
    check('the same candidate clears a declared, wider band', projectRound(roundState('round-floor-wide'), sliceAt(head()), WIDE).slots[0].admissible === true)
    await openCommands(WIDE).decideRound({ commandId: 'decide-floor-wide', roundId: 'round-floor-wide' })
    check('the admitted slot is the winner under the declared band', roundState('round-floor-wide').decision.winner === 0)
    check('the outcome names the declared band', roundState('round-floor-wide').decision.outcomes[0].reason.includes('(declared)'))

    // ---------------------------------------------------------------- 8. the round's own caliber
    // One submission under a caliber the round did not freeze: there is no second candidate to differ
    // from, so the round's caliber is the only thing that can refuse it a place in the ranking.
    await open('round-caliber', 7)
    await record(result('e-caliber', CANDIDATE_0, CALIBER_B, [0.9, 0.9]))
    await submit('round-caliber', 0, { evaluationId: 'e-caliber', revision: CANDIDATE_0 })
    const other = projectRound(roundState('round-caliber'), sliceAt(head()), FLOOR)
    check('a submission under another caliber is not pooled', other.slots[0].admissible === false && other.slots[0].reason.includes('pools only'), other.slots[0].reason ?? '')
    await commands.decideRound({ commandId: 'decide-caliber', roundId: 'round-caliber' })
    check('the round retains the incumbent rather than ranking another caliber', roundState('round-caliber').decision.winner === null)

    // ---------------------------------------------------------------- 9. gains are frozen
    // A re-measurement of the incumbent lands **above** round 1's cutoff. The projection must not
    // move: R03's counterexample, where publishing B rewrote A's Δ, and R05's, where an accepted
    // asset class has to stay accepted.
    const later = await record(result('incumbent-later', INCUMBENT, CALIBER_A, [0.95, 0.95]))
    check('the later fact is above the round cutoff', later.seq > plan.historyCutoff, `seq ${later.seq} vs cutoff ${plan.historyCutoff}`)
    const after = projectRound(roundState('round-1'), sliceAt(head()), FLOOR)
    check('a fact above the cutoff does not move the frozen gain', after.slots[1].gain === before.slots[1].gain && after.winner === before.winner, `gain ${after.slots[1].gain} vs ${before.slots[1].gain}`)
    check('a fact above the cutoff does not move novelty', after.slots[1].novelty === before.slots[1].novelty, `novelty ${after.slots[1].novelty}`)

    await open('round-2', 2)
    await record(result('e-c0', CANDIDATE_0, CALIBER_A, [0.7, 0.7]))
    await record(result('e-c1', CANDIDATE_1, CALIBER_B, [0.8, 0.8]))
    await submit('round-2', 0, { evaluationId: 'e-c0', revision: CANDIDATE_0 })
    await submit('round-2', 1, { evaluationId: 'e-c1', revision: CANDIDATE_1 })
    const mixed = await refusalOf(() => commands.decideRound({ commandId: 'decide-2', roundId: 'round-2' }))
    check('two calibers are refused rather than pooled', mixed.code === 'caliber-mismatch', mixed.code)
    check('the refused round has no decision fact', roundState('round-2').decision === undefined)

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

    await store.close()
    store = await ControlSessionStore.open({ persistence: live.persistence, controlId: 'round-probe', registry, subjects, cwd: root })
    commands = openCommands()
    const reopened = roundState('round-1')
    check('the plan and the decision survive a reopen', reopened.plan.historyCutoff === plan.historyCutoff && reopened.decision.winner === 1 && environmentState().pointer === PUBLISHED)
    check('the closed round still refuses a submission', (await refusalOf(() => submit('round-1', 0, { evaluationId: 'e-0', revision: CANDIDATE_0 }))).code === 'illegal-transition')

    const rounds = [...store.load().statesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
    console.log('')
    console.log(`rounds: ${rounds.filter(state => state.plan !== undefined).length}, submissions: ${rounds.reduce((total, state) => total + state.submissions.length, 0)}, decisions: ${rounds.filter(state => state.decision !== undefined).length}, checks: ${checks}, refusals: ${refusals}`)
    console.log(`budget: round 1 = ${firstBudget}, round ${ROUNDS} = ${lastBudget}; decision: winner slot ${decision.winner} of ${decision.outcomes.length}; published ${PUBLISHED} → novelty ${published.slots[0].novelty} for the accepted class, ${published.slots[1].novelty} for the other`)
    if (failures.length > 0) {
      console.log(`round-probe: ${failures.length} check(s) failed`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exitCode = 1
    } else {
      console.log('round-probe: OK')
    }
  } finally {
    await Promise.all([store.close().catch(() => {}), rm(root, { recursive: true, force: true })])
  }
}

try {
  await main()
} catch (error) {
  console.error(`round-probe: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
}

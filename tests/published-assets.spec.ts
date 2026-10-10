/**
 * E1 (`docs/tdd-seams.md` §2) — what a round's frozen history counts as already accepted.
 *
 * `publishedAssetsBelow` is the one owner of "which asset classes were accepted below this cutoff",
 * the value `noveltyOf` reads as `History.acceptedAssets`. It replaces an injected
 * `MeasureSlice.acceptedAssetsBelow` port that two wirings answered with two different conventions
 * — one folded `pointer/switched` and read the revision's manifest, one read a probe's own
 * `assets/published` facts — and because novelty feeds selection, two conventions can produce two
 * winners from one log (R03, R05).
 *
 * The expected values are hand-written asset-class literals: nothing here is computed by calling
 * the projection under test.
 */

import { describe, expect, it } from 'vitest'

import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  PUBLISHER_ROLE,
} from '../src/environment/protocol.ts'
import { digestOf } from '../src/protocol/envelope.ts'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { publishedAssetsBelow } from '../src/strategy/published-assets.ts'
import {
  declareStrategyProtocol,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_ROLE,
  STRATEGY_VERSION,
} from '../src/strategy/protocol.ts'

const ENVIRONMENT = 'library-1'
const SUBJECTS: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ROLE]: 'environment-service',
  [PUBLISHER_ROLE]: 'publisher-service',
  [STRATEGY_ROLE]: 'strategy-service',
}
const WEIGHTS = { quality: 100, cost: 15 }
const CALIBRATION = { floor: 0.1, source: 'measured' } as const
const CALIBER = 'f'.repeat(64)

let counter = 0
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`

/** What one revision carries. A pin names the digest of this, so these are logs a reducer accepted. */
const manifestOf = (revisionId: string): { readonly skills: readonly string[] } => ({ skills: [revisionId] })
const revisionOf = (revisionId: string): { readonly environmentId: string; readonly revisionId: string; readonly digest: string } => ({
  environmentId: ENVIRONMENT,
  revisionId,
  digest: digestOf(manifestOf(revisionId)),
})

/** The log the projection reads: the two protocols it folds, and nothing else. */
function factsLog(): MemoryLog {
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareStrategyProtocol(registry)
  return new MemoryLog(registry, { subjects: SUBJECTS, now: () => '2026-10-09T00:00:00.000Z' })
}

function created(log: MemoryLog, revisionId: string): void {
  log.emit({
    commandId: nextId('create'),
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject: ENVIRONMENT,
    payload: { revisionId, manifest: manifestOf(revisionId) },
  })
}

function switched(log: MemoryLog, expected: string, to: string): void {
  log.emit({
    commandId: nextId('switch'),
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched,
    subject: ENVIRONMENT,
    payload: { expected, to },
  })
}

interface Election {
  readonly round: number
  readonly incumbent: string
  readonly revision: string
  /** The content the slot pins, when it is not this log's content for that revision id. */
  readonly digest?: string
  readonly edits: readonly { readonly asset: string; readonly target: string }[]
}

/**
 * One round that elected slot 0: its opening fact, that slot's proposal of `revision`, and the
 * decision that elects it. Three facts, because a decision names a slot number and only the
 * submission names the revision — the pairing is what the projection has to find.
 */
function elected(log: MemoryLog, roundId: string, election: Election): void {
  const pin = revisionOf(election.revision)
  log.emit({
    commandId: nextId(`open-${roundId}`),
    protocol: STRATEGY_PROTOCOL,
    version: STRATEGY_VERSION,
    kind: STRATEGY_KINDS.roundOpened,
    subject: roundId,
    payload: {
      round: election.round,
      incumbent: revisionOf(election.incumbent),
      candidates: 1,
      explorationSlots: 0,
      editBudget: 4,
      historyCutoff: 0,
      caliber: CALIBER,
      weights: WEIGHTS,
    },
  })
  log.emit({
    commandId: nextId(`submit-${roundId}`),
    protocol: STRATEGY_PROTOCOL,
    version: STRATEGY_VERSION,
    kind: STRATEGY_KINDS.candidateSubmitted,
    subject: roundId,
    payload: {
      slot: 0,
      revision: election.digest === undefined ? pin : { ...pin, digest: election.digest },
      evaluationId: `evaluation-${roundId}`,
      edits: election.edits,
      exploratory: false,
    },
  })
  log.emit({
    commandId: nextId(`decide-${roundId}`),
    protocol: STRATEGY_PROTOCOL,
    version: STRATEGY_VERSION,
    kind: STRATEGY_KINDS.roundDecided,
    subject: roundId,
    payload: { winner: 0, outcomes: [{ slot: 0, admitted: true, reason: 'the best aggregate of this round' }], calibration: CALIBRATION },
  })
}

describe('the assets a frozen history counts as accepted', () => {
  it('counts the asset classes of the slot that proposed the head revision, in declaration order', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    elected(log, 'round-1', {
      round: 1,
      incumbent: 'r0001',
      revision: 'r0002',
      edits: [{ asset: 'tool', target: 'tokenizer' }, { asset: 'skill', target: 'count-words' }],
    })
    switched(log, '', 'r0002')

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual(['tool', 'skill'])
  })

  it('counts nothing when no pointer switch happened below the cutoff', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    elected(log, 'round-1', { round: 1, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'tool', target: 'tokenizer' }] })

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual([])
  })

  it('is not rewritten by a pointer switch that happened after the cutoff', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    elected(log, 'round-1', { round: 1, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'tool', target: 'tokenizer' }] })
    switched(log, '', 'r0002')
    const cutoff = log.count
    created(log, 'r0003')
    elected(log, 'round-2', { round: 2, incumbent: 'r0002', revision: 'r0003', edits: [{ asset: 'skill', target: 'count-words' }] })
    switched(log, 'r0002', 'r0003')

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, cutoff)).toEqual(['tool'])
  })

  it('counts a revision two rounds each elected once', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    elected(log, 'round-1', { round: 1, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'skill', target: 'count-words' }] })
    elected(log, 'round-2', { round: 2, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'skill', target: 'count-words' }] })
    switched(log, '', 'r0002')

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual(['skill'])
  })

  it('attributes nothing to a head no slot in this log proposed, and does not refuse', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    created(log, 'r0009')
    elected(log, 'round-1', { round: 1, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'template', target: 'report' }] })
    switched(log, '', 'r0009')

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual([])
  })

  it('does not let an election above the cutoff add a class to the frozen history', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    elected(log, 'round-1', { round: 1, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'tool', target: 'tokenizer' }] })
    switched(log, '', 'r0002')
    const cutoff = log.count
    // The same revision is elected again above the cutoff, declaring a class this history never saw.
    // A publication needs an approval, not a round (`release.publish`), so the election that put the
    // head there is not guaranteed to be the only one below the cutoff of the round reading it.
    elected(log, 'round-2', { round: 2, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'skill', target: 'count-words' }] })

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, cutoff)).toEqual(['tool'])
  })

  it('counts nothing for a slot that pinned content the head revision does not hold', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    // A well-formed digest that is not r0002's content: a slot can name the right revision id at
    // content this environment never created, and only the full triple tells the two apart.
    elected(log, 'round-1', {
      round: 1,
      incumbent: 'r0001',
      revision: 'r0002',
      digest: 'b'.repeat(64),
      edits: [{ asset: 'template', target: 'report' }],
    })
    elected(log, 'round-2', { round: 2, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'skill', target: 'count-words' }] })
    switched(log, '', 'r0002')

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual(['skill'])
  })

  it('unions the classes of two rounds that elected the same revision, round order then declaration order', () => {
    const log = factsLog()
    created(log, 'r0001')
    created(log, 'r0002')
    elected(log, 'round-1', { round: 1, incumbent: 'r0001', revision: 'r0002', edits: [{ asset: 'tool', target: 'tokenizer' }] })
    elected(log, 'round-2', {
      round: 2,
      incumbent: 'r0001',
      revision: 'r0002',
      edits: [{ asset: 'skill', target: 'count-words' }, { asset: 'tool', target: 'selector' }],
    })
    switched(log, '', 'r0002')

    expect(publishedAssetsBelow(log.entries(), ENVIRONMENT, log.count)).toEqual(['tool', 'skill'])
  })
})

/**
 * The publication a frozen history counts as accepted: the asset classes declared by the slot whose
 * election put the revision an environment's head pointed at below a cutoff.
 *
 * **Why one function owns this.** `noveltyOf` counts a candidate's classes against
 * `History.acceptedAssets`, and novelty feeds selection, so "what was accepted" is a definition the
 * whole round shares. It used to be an injected `MeasureSlice.acceptedAssetsBelow` port, and its two
 * wirings answered it two different ways — one folded the environment's switches and read the
 * published revision's manifest, one read a probe's own `assets/published` facts. Two conventions
 * can produce two winners from one log, so the port is gone and this projection is the one owner of
 * the definition (`docs/tdd-seams.md` §2, E1).
 *
 * The three steps, and why each is what it is:
 *
 * 1. **The head is folded, not read.** The `pointer/switched` facts with `seq < cutoff` are reduced
 *    by `environment@2`'s own reducer, so a switch is applied by its compare-and-swap rather than by
 *    a "last switch wins" convention, and the head below the cutoff is a position no later switch can
 *    move (`review.md` R03: with A=0.6 and B=0.8, recomputing against today's head turned B's Δ from
 *    +0.2 into 0 and A's from 0 into −0.2).
 * 2. **The election that proposed it is found across subjects.** A `round/decided` names only the
 *    slot it elected; the revision that slot offered is named by its `candidate/submitted`. Pairing
 *    the two is what this fold does, so a decision that elected nothing (`winner: null` — the
 *    incumbent stands) and a round that never closed propose nothing.
 * 3. **The classes come from the declaration, de-duplicated, in declaration order.** `edits` are
 *    what novelty counts (`strategy@2`), so the declaration is read rather than the published
 *    manifest: two edits of one class are one accepted class (R05 — types, not edits). Declaration
 *    order is kept so a replay of one log reads the same list.
 *
 * **A head no slot proposed is not a refusal, and not a guess.** A revision can reach a head without
 * any round electing it — the release pipeline publishes a revision, it is not required to be a
 * round's winner — and an adopted log may hold the switch without the round that proposed it. Such a
 * head contributes no classes: this projection reports what its own log can show instead of refusing
 * to answer, because refusing would fail a legal round projection over a fact it does not need. It
 * does not fall back to the published revision's manifest either: which classes a revision touched
 * is a claim only its proposing submission makes.
 *
 * `cutoff` bounds **which head** is read (step 1) and nothing else — the election is looked for in
 * the whole log the caller hands in, as §2 E1 specifies.
 *
 * @module singularity-core/strategy/published-assets
 */

import {
  declareEnvironmentProtocol,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../environment/protocol.ts'
import type { Envelope } from '../protocol/envelope.ts'
import { foldSubject, foldSubjects } from '../protocol/fold.ts'
import { ProtocolRegistry } from '../protocol/registry.ts'
import { declareStrategyProtocol, STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from './protocol.ts'

/**
 * The two protocols this projection folds, declared once here so a caller hands it a log rather than
 * an interpretation of one: the entries are the input, and how they are reduced is this module's.
 */
const FOLD = new ProtocolRegistry()
declareEnvironmentProtocol(FOLD)
declareStrategyProtocol(FOLD)

/**
 * The asset classes accepted below `cutoff` in `environmentId`.
 *
 * `[]` when this log holds no head for that environment below the cutoff, and `[]` when the head it
 * holds was proposed by no slot the log holds — in both cases nothing was published there that this
 * log can attribute classes to.
 */
export function publishedAssetsBelow(entries: readonly Envelope[], environmentId: string, cutoff: number): readonly string[] {
  const belowCutoff = entries.filter(entry => entry.seq < cutoff)
  const head = foldSubject<EnvironmentState>(FOLD, belowCutoff, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, environmentId)?.pointer

  const accepted: string[] = []
  for (const round of foldSubjects<RoundState>(FOLD, entries, STRATEGY_PROTOCOL, STRATEGY_VERSION).values()) {
    // The slot this round elected, and the revision it offered. A round with no decision, and a
    // decision with `winner: null`, elect no slot and therefore propose no revision.
    const elected = round.submissions.find(submission => submission.slot === round.decision?.winner)
    if (elected === undefined) continue
    if (elected.revision.environmentId !== environmentId || elected.revision.revisionId !== head) continue
    for (const edit of elected.edits) if (!accepted.includes(edit.asset)) accepted.push(edit.asset)
  }
  return accepted
}

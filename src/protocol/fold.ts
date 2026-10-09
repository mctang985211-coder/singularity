/**
 * The one fold engine.
 *
 * State is never stored. It is derived, per subject, by replaying the declared reducers in
 * sequence order. A reducer that meets a fact it cannot accept calls
 * `refuse('illegal-transition', …)` and the fold stops by name — no path repairs the sequence,
 * skips the fact, or substitutes a default.
 *
 * Folding one protocol skips the facts of every other protocol in the same log. That is what
 * one shared frame buys: many protocols, one log, one loader.
 *
 * **Two fold scopes, deliberately.** `foldSubjects` is the whole-store read and fails closed:
 * any subject's illegal sequence refuses the fold, because a store that cannot be replayed in
 * full is not a store whose full state you may trust. `foldSubject` is the documented isolation
 * boundary: it reduces exactly one subject, so a reader can obtain its own state without being
 * poisoned by a stranger's broken sequence. Choose the scope by what the caller is answering
 * for; neither invents state for a subject the log never saw.
 *
 * @module singularity-core/protocol/fold
 */

import type { Envelope } from './envelope.ts'
import type { ProtocolRegistry } from './registry.ts'

function applyFacts<State>(
  registry: ProtocolRegistry,
  entries: readonly Envelope[],
  protocol: string,
  version: number,
  keepSubject: (subject: string) => boolean,
): Map<string, State> {
  const spec = registry.specFor<State>(protocol, version)
  const states = new Map<string, State>()

  for (const entry of entries) {
    if (entry.protocol !== protocol || entry.version !== version) continue
    if (!keepSubject(entry.subject)) continue
    const rule = registry.ruleFor<State>(protocol, version, entry.kind)
    // Parse at the fold boundary too: a stored payload is re-checked against its kind's closed
    // shape, so a log edited outside the append path is refused rather than half-understood.
    const payload = rule.parse(entry.payload, `${entry.protocol}@${entry.version} ${entry.kind} #${entry.seq}`)
    const before = states.get(entry.subject)
    states.set(entry.subject, rule.reduce(before === undefined ? spec.initialState : before, entry, payload))
  }

  return states
}

/**
 * Fold every subject of one protocol version, in the order the log recorded them, failing
 * closed on the first illegal transition.
 *
 * A subject absent from the result has no facts — the caller must not read that as the initial
 * state, and this function never invents one.
 */
export function foldSubjects<State>(
  registry: ProtocolRegistry,
  entries: readonly Envelope[],
  protocol: string,
  version: number,
): Map<string, State> {
  return applyFacts<State>(registry, entries, protocol, version, () => true)
}

/**
 * Fold exactly one subject of one protocol version, or `undefined` when the log holds none of
 * its facts. This is the isolation boundary: another subject's illegal sequence does not reach
 * the caller.
 */
export function foldSubject<State>(
  registry: ProtocolRegistry,
  entries: readonly Envelope[],
  protocol: string,
  version: number,
  subject: string,
): State | undefined {
  return applyFacts<State>(registry, entries, protocol, version, candidate => candidate === subject).get(subject)
}

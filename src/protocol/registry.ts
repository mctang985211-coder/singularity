/**
 * The one version gate and the one guarantee ladder.
 *
 * A fact is admissible only when its `(protocol, version)` is declared and its `kind` exists
 * within that version. The declared guarantee then decides whether the fact may be persisted
 * at all: a **G4** kind is derived state and is refused at the log boundary rather than stored
 * twice.
 *
 * Exactly one protocol may own **G3** (compare-and-swap). In the target system that single
 * instance is the environment-version pointer; a second claimant is a refusal, not a review
 * item.
 *
 * @module singularity-core/protocol/registry
 */

import type { Envelope } from './envelope.ts'
import { refuse } from './refusal.ts'

/**
 * The guarantee ladder. One fact has exactly one level; nothing is "also atomic".
 *
 * - `G1` append + fold — the default: durable on append, state derived at load.
 * - `G2` multi-record atomic — a batch is all-visible or all-invisible.
 * - `G3` compare-and-swap — single point, persisted intent, read-back. Exactly one instance.
 * - `G4` derived — never persisted; folded from G1 facts.
 */
export type Guarantee = 'G1' | 'G2' | 'G3' | 'G4'

export const GUARANTEES: readonly Guarantee[] = ['G1', 'G2', 'G3', 'G4']

/** How one kind advances its subject's state. Pure, and the only authority on legality. */
export interface KindRule<State> {
  readonly guarantee: Guarantee
  /**
   * Return the next state, or call `refuse('illegal-transition', …)`. A reducer must not read
   * the wall clock, the network, or any file: the same facts always fold to the same state.
   */
  readonly reduce: (state: State, envelope: Envelope) => State
}

/** One protocol version: one initial state, one closed kind set. */
export interface ProtocolSpec<State> {
  /** The state a subject has before its first fact. Never substituted for a missing fact. */
  readonly initialState: State
  /** The closed kind set. A fact whose kind is absent here is refused by the version gate. */
  readonly kinds: Readonly<Record<string, KindRule<State>>>
}

interface Declared {
  readonly spec: ProtocolSpec<unknown>
}

function keyOf(protocol: string, version: number): string {
  return `${protocol}@${version}`
}

/** The one registry. Declarations happen once at module load and never change afterwards. */
export class ProtocolRegistry {
  readonly #declared = new Map<string, Declared>()
  readonly #versionsByProtocol = new Map<string, Set<number>>()
  #g3Owner: string | undefined

  /**
   * Declare one protocol at one version: its initial state and its closed kind set.
   *
   * Refuses an empty protocol name, a version below 1, an empty kind set, an undeclared
   * guarantee, a duplicate `(protocol, version)`, and a second G3 claimant.
   */
  declare<State>(protocol: string, version: number, spec: ProtocolSpec<State>): void {
    if (protocol.length === 0) refuse('malformed-declaration', 'a protocol name must be a non-empty string')
    if (!Number.isInteger(version) || version < 1)
      refuse('malformed-declaration', `protocol ${protocol} needs an integer version >= 1, got ${String(version)}`)

    const kinds = Object.keys(spec.kinds)
    if (kinds.length === 0) refuse('malformed-declaration', `protocol ${protocol}@${version} declares no kinds`)

    for (const kind of kinds) {
      if (kind.length === 0) refuse('malformed-declaration', `protocol ${protocol}@${version} declares an empty kind name`)
      const guarantee = spec.kinds[kind]?.guarantee
      if (guarantee === undefined || !GUARANTEES.includes(guarantee))
        refuse(
          'unknown-guarantee',
          `protocol ${protocol}@${version} kind ${kind} declares guarantee ${JSON.stringify(guarantee ?? null)}; one of ${GUARANTEES.join(' / ')}`,
        )
      if (guarantee === 'G3' && this.#g3Owner !== undefined && this.#g3Owner !== protocol)
        refuse(
          'second-g3-instance',
          `protocol ${protocol} claims G3 (compare-and-swap) while ${this.#g3Owner} already owns it; the ladder allows exactly one instance`,
        )
      if (guarantee === 'G3') this.#g3Owner = protocol
    }

    const key = keyOf(protocol, version)
    if (this.#declared.has(key))
      refuse('duplicate-declaration', `protocol ${protocol}@${version} is already declared`)

    this.#declared.set(key, { spec: spec as ProtocolSpec<unknown> })
    const versions = this.#versionsByProtocol.get(protocol) ?? new Set<number>()
    versions.add(version)
    this.#versionsByProtocol.set(protocol, versions)
  }

  /**
   * The spec for one protocol version. Unknown protocol and unknown version are distinct
   * refusals. The state type is caller-asserted: one registry holds heterogeneous protocols,
   * and each caller folds exactly the protocol whose state type it declared.
   */
  specFor<State = unknown>(protocol: string, version: number): ProtocolSpec<State> {
    const declared = this.#declared.get(keyOf(protocol, version))
    if (declared !== undefined) return declared.spec as ProtocolSpec<State>

    const versions = this.#versionsByProtocol.get(protocol)
    if (versions === undefined)
      refuse(
        'unknown-protocol',
        `no protocol named ${JSON.stringify(protocol)} is declared (declared: ${[...this.#versionsByProtocol.keys()].sort().join(', ') || 'none'})`,
      )
    refuse(
      'version-mismatch',
      `protocol ${protocol} is declared at ${[...versions].sort((a, b) => a - b).join(' / ')}, not at version ${version}`,
    )
  }

  /** The rule for one fact. The last gate before a fact reaches a reducer or a log. */
  ruleFor<State = unknown>(protocol: string, version: number, kind: string): KindRule<State> {
    const spec = this.specFor<State>(protocol, version)
    const rule = spec.kinds[kind]
    if (rule === undefined)
      refuse(
        'unknown-kind',
        `protocol ${protocol}@${version} declares no kind ${JSON.stringify(kind)} (declared: ${Object.keys(spec.kinds).sort().join(', ')})`,
      )
    return rule
  }

  /** The kind set one protocol version declares, sorted. */
  kindsOf(protocol: string, version: number): readonly string[] {
    return Object.keys(this.specFor(protocol, version).kinds).sort()
  }

  /** The versions one protocol declares, ascending. A refusal names what is declared instead. */
  versionsOf(protocol: string): readonly number[] {
    const versions = this.#versionsByProtocol.get(protocol)
    if (versions === undefined)
      refuse(
        'unknown-protocol',
        `no protocol named ${JSON.stringify(protocol)} is declared (declared: ${[...this.#versionsByProtocol.keys()].sort().join(', ') || 'none'})`,
      )
    return [...versions].sort((a, b) => a - b)
  }

  /** The protocol that owns the single compare-and-swap guarantee, when one has claimed it. */
  g3Owner(): string | undefined {
    return this.#g3Owner
  }
}

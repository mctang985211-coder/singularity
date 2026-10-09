/**
 * The one version gate, the one guarantee vocabulary, and the one emitter discipline.
 *
 * A fact is admissible only when its `(protocol, version)` is declared and its `kind` exists
 * within that version. Four rules keep the declared surface honest:
 *
 * 1. **Guarantees compose.** Durability, business atomicity, conditional update and pure
 *    derivation are different dimensions; a kind names the ones it needs. `derived` is the only
 *    one that forbids persistence, because derived state is folded from persisted facts.
 * 2. **The payload is parsed once, at the boundary.** Each kind declares its own parser, so a
 *    closed shape is a property of the kind rather than a convention each reducer re-checks.
 *    Parsing runs before the emitter resolves, so an emitter function never sees a malformed body.
 * 3. **The emitter is declared, never supplied.** Each kind names the trusted role that may
 *    produce it — a literal role, or a function of the parsed payload when the role *is* the
 *    implementation (a verifier's verdict belongs to that verifier). A caller passes no author,
 *    which is what makes "an executor never judges its own run" checkable on roles.
 * 4. **Declaration is all-or-nothing.** A refused declaration leaves the registry exactly as it
 *    was, so a failed claim can never leave an owner behind.
 *
 * Kind lookup uses own keys: `toString`, `constructor` and `__proto__` are not kinds.
 *
 * @module singularity-core/protocol/registry
 */

import type { Envelope } from './envelope.ts'
import { refuse } from './refusal.ts'

/**
 * What a kind's facts need. These compose: a conditional update is *also* durably appended, and a
 * business-atomic fact is *also* appended.
 */
export interface Guarantees {
  /** Durable on append: the write does not resolve until the fact survives a restart. */
  readonly appended: boolean
  /** The fact is one complete fact standing for a business-atomic operation. */
  readonly atomicFact?: boolean
  /** The fact must be checked against an expected prior state inside the commit queue. */
  readonly conditional?: boolean
  /** Derived state: never persisted, always folded. */
  readonly derived?: boolean
}

/** The closed guarantee vocabulary. An undeclared key is refused, like any other closed shape. */
const GUARANTEE_KEYS = ['appended', 'atomicFact', 'conditional', 'derived'] as const

function assertGuarantees(guarantees: Guarantees, where: string): void {
  const record = guarantees as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(GUARANTEE_KEYS as readonly string[]).includes(key))
      refuse(
        'unknown-guarantee',
        `${where} carries unknown guarantee ${JSON.stringify(key)}; the vocabulary is closed (known: ${GUARANTEE_KEYS.join(', ')})`,
      )
  }
  for (const key of GUARANTEE_KEYS) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean')
      refuse('unknown-guarantee', `${where}.${key} must be a boolean, got ${typeof record[key]}`)
  }
  if (record['appended'] !== true && record['derived'] !== true)
    refuse('unknown-guarantee', `${where} declares neither appended nor derived; every fact is one of the two`)
  if (record['derived'] === true && record['appended'] === true)
    refuse(
      'unknown-guarantee',
      `${where} is derived and appended at once; derived state is folded from persisted facts and is never written`,
    )
  if (record['conditional'] === true && record['appended'] !== true)
    refuse('unknown-guarantee', `${where} is conditional without being appended; there is no committed state to compare against`)
}

/** What the framework needs from one kind, with the payload type erased. */
export interface KindRule<State> {
  readonly guarantees: Guarantees
  /** The trusted role that may emit this kind, given the parsed payload. */
  readonly emitter: (payload: unknown) => string
  /** Parse and close the payload, or refuse it by name. */
  readonly parse: (raw: unknown, where: string) => unknown
  /** Advance the state, or refuse. Reads the parsed payload. */
  readonly reduce: (state: State, envelope: Envelope, payload: unknown) => State
}

/**
 * Define one kind, keeping the payload type through to the reducer.
 *
 * This is the single place the framework's heterogeneous registry erases a payload type, so no
 * reducer has to cast its own body.
 */
export function defineKind<State, Payload>(spec: {
  readonly guarantees: Guarantees
  readonly emitter: string | ((payload: Payload) => string)
  readonly parse: (raw: unknown, where: string) => Payload
  readonly reduce: (state: State, envelope: Envelope, payload: Payload) => State
}): KindRule<State> {
  const declared = spec.emitter
  const emitter: (payload: unknown) => string =
    typeof declared === 'string' ? (): string => declared : (raw: unknown): string => declared(raw as Payload)
  return {
    guarantees: spec.guarantees,
    emitter,
    parse: spec.parse,
    reduce: (state, envelope, payload) => spec.reduce(state, envelope, payload as Payload),
  }
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

/** The one registry. Declarations happen once at load and never change afterwards. */
export class ProtocolRegistry {
  readonly #declared = new Map<string, Declared>()
  readonly #versionsByProtocol = new Map<string, Set<number>>()
  #conditionalOwner: string | undefined

  /**
   * Declare one protocol at one version: its initial state and its closed kind set.
   *
   * Validates everything before publishing anything, so a refused declaration leaves no trace.
   */
  declare<State>(protocol: string, version: number, spec: ProtocolSpec<State>): void {
    if (protocol.length === 0) refuse('malformed-declaration', 'a protocol name must be a non-empty string')
    if (!Number.isInteger(version) || version < 1)
      refuse('malformed-declaration', `protocol ${protocol} needs an integer version >= 1, got ${String(version)}`)

    const kinds = Object.keys(spec.kinds)
    if (kinds.length === 0) refuse('malformed-declaration', `protocol ${protocol}@${version} declares no kinds`)

    let conditionalClaimant: string | undefined
    for (const kind of kinds) {
      if (kind.length === 0) refuse('malformed-declaration', `protocol ${protocol}@${version} declares an empty kind name`)
      if (!Object.hasOwn(spec.kinds, kind))
        refuse('malformed-declaration', `protocol ${protocol}@${version} kind ${kind} is inherited, not declared`)
      const rule = spec.kinds[kind] as KindRule<State>
      const where = `protocol ${protocol}@${version} kind ${kind}`
      assertGuarantees(rule.guarantees, where)
      if (typeof rule.emitter !== 'function' || typeof rule.parse !== 'function' || typeof rule.reduce !== 'function')
        refuse('malformed-declaration', `${where} must declare an emitter, a payload parser and a reducer (use defineKind)`)
      if (rule.guarantees.conditional === true) conditionalClaimant = protocol
    }

    if (conditionalClaimant !== undefined && this.#conditionalOwner !== undefined && this.#conditionalOwner !== conditionalClaimant)
      refuse(
        'second-conditional-owner',
        `protocol ${conditionalClaimant} claims conditional updates while ${this.#conditionalOwner} already owns them; one environment has one authoritative switch path`,
      )

    const key = keyOf(protocol, version)
    if (this.#declared.has(key)) refuse('duplicate-declaration', `protocol ${protocol}@${version} is already declared`)

    // Everything validated: publish, so a refused declaration leaves no trace.
    this.#declared.set(key, { spec: spec as ProtocolSpec<unknown> })
    const versions = this.#versionsByProtocol.get(protocol) ?? new Set<number>()
    versions.add(version)
    this.#versionsByProtocol.set(protocol, versions)
    if (conditionalClaimant !== undefined) this.#conditionalOwner = conditionalClaimant
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
        `no protocol named ${JSON.stringify(protocol)} is declared (declared: ${this.protocols().join(', ') || 'none'})`,
      )
    refuse(
      'version-mismatch',
      `protocol ${protocol} is declared at ${[...versions].sort((a, b) => a - b).join(' / ')}, not at version ${version}`,
    )
  }

  /**
   * The rule for one fact. The last gate before a fact reaches a reducer or a log. Lookup is by
   * own key, so an inherited member name is an unknown kind rather than a function.
   */
  ruleFor<State = unknown>(protocol: string, version: number, kind: string): KindRule<State> {
    const spec = this.specFor<State>(protocol, version)
    if (!Object.hasOwn(spec.kinds, kind))
      refuse(
        'unknown-kind',
        `protocol ${protocol}@${version} declares no kind ${JSON.stringify(kind)} (declared: ${Object.keys(spec.kinds).sort().join(', ')})`,
      )
    return spec.kinds[kind] as KindRule<State>
  }

  /**
   * Every protocol this registry holds, sorted. A registry can say what it declared, which is what
   * an inventory of the declared surface has to ask it: reading the names out of the source would
   * be a second copy of the truth that nothing keeps in step.
   */
  protocols(): readonly string[] {
    return [...this.#versionsByProtocol.keys()].sort()
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
        `no protocol named ${JSON.stringify(protocol)} is declared (declared: ${this.protocols().join(', ') || 'none'})`,
      )
    return [...versions].sort((a, b) => a - b)
  }

  /** The protocol that owns the one conditional-update discipline, when one has claimed it. */
  conditionalOwner(): string | undefined {
    return this.#conditionalOwner
  }
}

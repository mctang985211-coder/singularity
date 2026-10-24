/**
 * The one version gate, the one guarantee vocabulary, and the one emitter discipline.
 *
 * A fact is admissible only when its `(protocol, version)` is declared and its `kind` exists
 * within that version. Four rules keep the declared surface honest:
 *
 * 1. **Guarantees compose.** Durability, business atomicity, conditional update and pure
 *    derivation are different dimensions; a kind names the ones it needs. `derived` is the only
 *    one that forbids persistence, because derived state is folded from persisted facts.
 * 2. **The payload is parsed once, at the boundary.** Each kind declares its own closed member set
 *    and its own parser, so a closed shape is a property of the kind rather than a convention each
 *    reducer re-checks. Parsing runs before the emitter resolves, so an emitter function never sees a
 *    malformed body. The declared set is the enforced one: it is applied before the parser runs, so
 *    there is one source for what a payload may carry, and a reader that is not the parser — the
 *    protocol inventory — can compare it with the ledger instead of inferring it from behaviour.
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

import { assertClosedKeys, type Envelope } from './envelope.ts'
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

/**
 * A closed member set: the payload members one kind accepts, as a value rather than a behaviour.
 *
 * A set that is a value can be read, compared and printed by something that is not the parser — which
 * is the whole reason it is a value. Round four's gate inferred a kind's member set by handing its
 * parser a family of payloads and reading the set out of the refusal; that made the gate a program
 * modelling another program's runtime, and it was wrong for every parser whose accepted set depended
 * on anything the family never sampled. There is now exactly one source, and it is enforced.
 */
export type MemberSet = readonly string[]

/**
 * The closed shapes *inside* one payload, by the payload member that holds each: `{}` says, in one
 * place, that this payload closes no shape inside itself.
 *
 * A value here is the set the reader that owns that member enforces: that member's own members, or
 * each element's when the member is a list. The parse boundary hands the value to that reader, so the
 * entry *is* what closes the member rather than a second copy printed beside the one the reader uses —
 * round six showed a declared value with no reader behind it can say less than the parser accepts, and
 * a reader can widen without the declaration changing. A shape *inside* a nested shape (each
 * `contract.criteria[]` entry, say) is closed by the reader that declares it, so one level is all a
 * payload member names; an entry whose shape cannot be named from the payload's level is deleted
 * rather than printed.
 */
type NestedSets = Readonly<Record<string, MemberSet>>

/**
 * The rules `defineKind` built, **by identity**, so the registry can refuse one that skipped it.
 *
 * A rule built by hand could declare a member set nothing enforces, and the inventory would then be
 * comparing the ledger with a promise the parse boundary never kept. The mark was an own enumerable
 * symbol property until the sixth review showed what that is worth: object spread copies own
 * enumerable symbols, so `{ ...rule, parse: anotherParser }` kept the mark and the `members` value
 * while replacing the boundary, and a rule whose parser accepted an undeclared member was declared,
 * accepted by the log and folded. **A property can be copied; an identity cannot.** A spread copy is
 * a different object, so it is not in this set and is refused by name, and the set is not exported,
 * so going through `defineKind` is the only way in.
 */
const BUILT_BY_DEFINE_KIND = new WeakSet<object>()

/** The closed guarantee vocabulary. An undeclared key is refused, like any other closed shape. */
const GUARANTEE_KEYS = ['appended', 'atomicFact', 'conditional', 'derived'] as const

/** One declared member set, refused unless it is a set of distinct non-empty names. */
function assertMemberSet(set: unknown, where: string): void {
  // An empty set is a shape, not an omission: a payload that accepts nothing but is still an object.
  if (!Array.isArray(set))
    refuse(
      'malformed-declaration',
      `${where} must be an array of member names, got ${set === null ? 'null' : typeof set}`,
    )
  const seen = new Set<string>()
  for (const name of set as readonly unknown[]) {
    if (typeof name !== 'string' || name.length === 0)
      refuse(
        'malformed-declaration',
        `${where} names ${JSON.stringify(name ?? null)}, which is not a member name; a closed set is a list of non-empty strings`,
      )
    if (seen.has(name as string))
      refuse(
        'malformed-declaration',
        `${where} names ${JSON.stringify(name)} twice; a closed set names each member once`,
      )
    seen.add(name as string)
  }
}

/**
 * Freeze one nested declaration where it was written: every set in the record, and the record itself.
 *
 * The values are the sets the readers enforce, so a later `push` into one of them would move the
 * boundary the declaration prints without changing the declaration, and a reader that had already
 * copied the set would never see it. `Object.freeze` is the whole fix: after `defineKind` returns,
 * the declared shape cannot be widened by anyone, so the value read at declare time and the value
 * enforced at parse time are the same value rather than two readings of a mutable one.
 */
function freezeNested(nested: NestedSets): void {
  for (const set of Object.values(nested)) Object.freeze(set)
  Object.freeze(nested)
}

/**
 * One kind's declared shape, refused unless the declaration can be enforced and read.
 *
 * The nested keys are checked against the payload's own members because the declaration is a
 * statement about *this* payload: a key that names nothing in it is a typo, and a typo is exactly the
 * kind of second source this interface exists to remove.
 */
function assertDeclaredShape(rule: KindRule<unknown>, where: string): void {
  if (!BUILT_BY_DEFINE_KIND.has(rule))
    refuse(
      'malformed-declaration',
      `${where} was not built by defineKind, so nothing enforces the member set it declares; a declaration is only one source when the boundary closes the payload with it, and a copy of a rule that was built by it is a different object — the mark is the identity defineKind returned, not a property a spread carries`,
    )
  if (rule.members === undefined) return
  assertMemberSet(rule.members, `${where} declares its payload members`)
  const nested = rule.nested as unknown
  if (nested === undefined)
    refuse(
      'malformed-declaration',
      `${where} declares payload members and no nested shape set; state it as {}, so a kind that closes no inner shape says so`,
    )
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested))
    refuse('malformed-declaration', `${where} declares a nested shape set that is not a record of member sets`)
  for (const [member, set] of Object.entries(nested as Record<string, unknown>)) {
    if (!rule.members.includes(member))
      refuse(
        'malformed-declaration',
        `${where} declares a closed shape inside ${JSON.stringify(member)}, which is not one of its payload members (${rule.members.join(', ') || 'none'})`,
      )
    assertMemberSet(set, `${where}'s closed shape inside ${JSON.stringify(member)}`)
  }
}

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
    refuse(
      'unknown-guarantee',
      `${where} is conditional without being appended; there is no committed state to compare against`,
    )
}

/** What the framework needs from one kind, with the payload type erased. */
export interface KindRule<State> {
  readonly guarantees: Guarantees
  /**
   * The payload's closed member set, declared once.
   *
   * When a kind declares one, this is the value the parse boundary enforces and the value the protocol
   * inventory compares with the ledger, so the two cannot disagree: there is nothing to sample and
   * nothing to sample wrongly. A kind that declares none is a shape the inventory reports rather than
   * compares, and a kind in the ledger's surface that declares none is a finding.
   */
  readonly members?: MemberSet
  /** The closed shapes inside the payload, by member; `{}` when the parser closes none. */
  readonly nested?: NestedSets
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
 * reducer has to cast its own body — and the single place a kind's closed member set is declared.
 *
 * **The declared set is the enforced one.** `members` is applied to the raw payload here, before the
 * parser below runs, so no parser can accept a member outside it: a payload carrying one is refused
 * by the declaration itself, whatever the parser would have done with it. That is what makes the set
 * one source rather than two — the parser reads no top-level list at all, and the inventory reads
 * this value instead of asking the parser what it accepts.
 *
 * `nested` is passed to the parser, which hands each entry to the reader that closes that member, so
 * the same constant cannot be a second version of the truth in the body and in the declaration: the
 * body reads the declaration. An entry nothing enforces is worse than no entry, which is why the
 * tree deletes one rather than printing it.
 *
 * **The declared values are frozen where they were written, and the rule itself is frozen where it
 * was built.** A set that could be pushed into after `declare` is two values wearing one name: a
 * reader that snapshotted it at declare time and the parse boundary reading it live would disagree,
 * and the sixth review widened a boundary exactly that way with the comparison unchanged. After this
 * call, the only writable thing left is nothing.
 *
 * A kind that declares no set is not closed by this wrapper, and the protocol inventory reports it
 * rather than comparing it. Every kind in this tree's ledger surface declares one; a declaration is
 * what makes a shape part of that surface at all.
 */
export function defineKind<State, Payload, Nested extends NestedSets = Record<string, never>>(spec: {
  readonly guarantees: Guarantees
  readonly members?: MemberSet
  readonly nested?: Nested
  readonly emitter: string | ((payload: Payload) => string)
  readonly parse: (raw: unknown, where: string, nested: Nested) => Payload
  readonly reduce: (state: State, envelope: Envelope, payload: Payload) => State
}): KindRule<State> {
  const declared = spec.emitter
  const emitter: (payload: unknown) => string =
    typeof declared === 'string' ? (): string => declared : (raw: unknown): string => declared(raw as Payload)
  const closed = spec.members
  // Frozen in place, so the constant the declaration was written with is the frozen value too: a push
  // into it afterwards is a write to a frozen array rather than a boundary that moved.
  if (closed !== undefined) Object.freeze(closed)
  if (spec.nested !== undefined) freezeNested(spec.nested)
  const rule: KindRule<State> = {
    ...(closed === undefined ? {} : { members: closed }),
    ...(spec.nested === undefined ? {} : { nested: spec.nested }),
    guarantees: spec.guarantees,
    emitter,
    // A non-object payload is left to the parser, whose own reader names the type it wanted.
    parse: (raw, where) => {
      if (closed !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw))
        assertClosedKeys(raw as Record<string, unknown>, closed, where)
      return spec.parse(raw, where, spec.nested as Nested)
    },
    reduce: (state, envelope, payload) => spec.reduce(state, envelope, payload as Payload),
  }
  BUILT_BY_DEFINE_KIND.add(rule)
  return Object.freeze(rule)
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
      if (kind.length === 0)
        refuse('malformed-declaration', `protocol ${protocol}@${version} declares an empty kind name`)
      if (!Object.hasOwn(spec.kinds, kind))
        refuse('malformed-declaration', `protocol ${protocol}@${version} kind ${kind} is inherited, not declared`)
      const rule = spec.kinds[kind] as KindRule<State>
      const where = `protocol ${protocol}@${version} kind ${kind}`
      assertGuarantees(rule.guarantees, where)
      if (typeof rule.emitter !== 'function' || typeof rule.parse !== 'function' || typeof rule.reduce !== 'function')
        refuse(
          'malformed-declaration',
          `${where} must declare an emitter, a payload parser and a reducer (use defineKind)`,
        )
      assertDeclaredShape(rule as KindRule<unknown>, where)
      if (rule.guarantees.conditional === true) conditionalClaimant = protocol
    }

    if (
      conditionalClaimant !== undefined &&
      this.#conditionalOwner !== undefined &&
      this.#conditionalOwner !== conditionalClaimant
    )
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

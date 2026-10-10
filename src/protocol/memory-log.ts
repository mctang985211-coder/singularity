/**
 * The fact pipeline: declared emitters, command identity, one serial region, replay verification.
 *
 * **This holds facts in memory. It does not write them.** Durability belongs to DSH session
 * persistence, which owns the crash barrier, the cross-process write lease, replay, compaction and
 * the host-format migration chain. This module owns the *order and the rules*, and the medium is
 * somebody else's problem — which is the whole point of not self-building a log again.
 *
 * Four rules live here, each because a counterexample showed the cost of leaving it out:
 *
 * 1. **A decision is not a record.** `decide` applies every rule and seals the fact; `record` is
 *    what makes it part of the log. A caller that owns a durability barrier decides, asks the
 *    medium, and records only what the medium confirmed — so no reader can ever see a fact that
 *    exists because somebody hoped a write would succeed. `emit` is the two together, for a caller
 *    with no medium of its own.
 * 2. **The emitter is declared, not supplied.** A caller passes no author. The fact's role comes
 *    from its kind's declaration and its identity from the subjects this store was opened with, so
 *    no caller can claim to be a verifier.
 * 3. **A command is identified by its result.** The same `commandId` carrying the same request
 *    returns the recorded fact — the answer a caller may have lost — while the same id carrying a
 *    different request is refused. `decide` says which of the two happened, so a caller never has
 *    to infer "already committed" from a sequence number.
 * 4. **Adopted facts are re-verified.** `adopt` is how a durable medium hands facts back: it checks
 *    framing, digest, chain link, sequence and kind before any reducer sees them, so a log written
 *    by a buggier build or edited outside this path is refused rather than half-understood.
 *
 * **Where the serial region is.** Neither half awaits, so JavaScript's run-to-completion is already
 * the critical section: two concurrent `emit` calls cannot interleave their read of the cursor. A
 * caller that awaits between `decide` and `record` owns the serialization itself, and the control
 * store's queue is exactly that — the one queue in the stack, because it is the one place a commit
 * spans a real write.
 *
 * **What a committed value is.** Every fact and every folded state this log publishes is deeply
 * frozen as it is recorded. A read therefore hands out the value itself rather than a copy of it,
 * and "a reader cannot corrupt the log through a read" is a property of the value instead of a
 * promise about every caller. Copying on read was the other half of the cost this module used to
 * pay: a whole-log clone per read, on every read.
 *
 * @module singularity-core/protocol/memory-log
 */

import { assertEnvelope, digestOf, sealEnvelope, type Envelope, type EnvelopeBody } from './envelope.ts'
import { foldSubject, foldSubjects } from './fold.ts'
import { refuse } from './refusal.ts'
import type { ProtocolRegistry } from './registry.ts'

/** What a caller supplies to record one fact. The frame's own members, including the author, are never caller-supplied. */
export interface EmitInput<Payload = unknown> {
  /** The caller's own id for this command, so a lost reply can be recognized. */
  readonly commandId: string
  readonly protocol: string
  readonly version: number
  readonly kind: string
  readonly subject: string
  readonly payload: Payload
  /**
   * The subjects-table key this emission is **bound** to, when the trusted surface that submits the
   * fact stands for one executor rather than the kind's own service. The kind's emitter names the
   * submitting service and stays on the envelope; an `as` binding selects which identity that
   * service stamps as the actor. It resolves through the same trusted table and nothing else, so a
   * binding can only name an identity the deployment already holds — never supply one.
   *
   * It is submission context, not request content: command identity stays the shape of the fact
   * (frame and payload), because the journal below rebuilds exactly that from committed facts, and
   * the binding's effect is already part of the fact it produced — the actor the envelope carries.
   */
  readonly as?: string
}

export interface LogOptions {
  /** The trusted identity each emitter role resolves to. A role absent here cannot emit. */
  readonly subjects: Readonly<Record<string, string>>
  /** The instant one fact is stamped with. Injectable so a fold can be tested deterministically. */
  readonly now?: () => string
}

/**
 * One fact that passed every rule, and the answer to "was it already committed?".
 *
 * `fresh` is the whole of command identity's outcome: `false` means the reply to this command was
 * lost and the envelope below is the fact it already committed, so there is nothing to write.
 */
export interface Decision<Payload = unknown> {
  readonly envelope: Envelope<Payload>
  readonly fresh: boolean
}

/**
 * The folded state a decision's fact would produce, keyed by the decision object itself.
 *
 * Module-private on purpose. The state a fact advances is computed by that fact's own reducer, so
 * the only way to obtain one is to have `decide` return it — a caller cannot hand `record` a state
 * of its own making, and cannot re-record a decision twice.
 */
const DECIDED = new WeakMap<Decision, { readonly log: MemoryLog; readonly payload: unknown; readonly state: unknown }>()

/**
 * A sequence of facts in memory, with the commit rules applied.
 *
 * One instance is one writer. The durable system gives it either a freshly created store or the
 * facts a medium read back; it never gives it a second live writer for the same subject, because
 * that is what the medium's lease is for.
 */
export class MemoryLog {
  readonly #registry: ProtocolRegistry
  readonly #subjects: Readonly<Record<string, string>>
  readonly #now: () => string
  readonly #entries: Envelope[] = []
  /** The folded state of every subject, by protocol version then subject. The append-time cursor. */
  readonly #states = new Map<string, Map<string, unknown>>()
  /** One command id maps to the fact it committed and the request that produced it. */
  readonly #commands = new Map<string, { requestDigest: string; envelope: Envelope }>()

  constructor(registry: ProtocolRegistry, options: LogOptions) {
    this.#registry = registry
    this.#subjects = options.subjects
    this.#now = options.now ?? ((): string => new Date().toISOString())
  }

  /**
   * Adopt facts a durable medium read back, verifying everything a reader must not have to
   * re-derive: each one frames, each digest matches its body, the chain links, sequence numbers are
   * contiguous from 0, every kind is declared, and every subject's sequence is legal.
   *
   * The full replay, and the only one: a fact that arrives any other way — through `decide` — was
   * sealed by this same code a moment ago and is applied without re-reading the log behind it.
   */
  static adopt(entries: readonly Envelope[], registry: ProtocolRegistry, options: LogOptions): MemoryLog {
    const log = new MemoryLog(registry, options)

    for (const [index, entry] of entries.entries()) {
      // Re-assert the frame: the value handed back may come from JSON, from another build, or from
      // a file somebody edited. Only the digest check can tell.
      const checked = assertEnvelope(entry)
      if (checked.seq !== index)
        refuse(
          'chain-broken',
          `${checked.protocol}/${checked.kind} sits at seq ${checked.seq} in position ${index}; sequence numbers are contiguous from 0`,
        )
      const expected = index === 0 ? null : (entries[index - 1]?.digest ?? null)
      if (checked.prevDigest !== expected)
        refuse(
          'chain-broken',
          `${checked.protocol}/${checked.kind} #${checked.seq} links to ${
            checked.prevDigest === null ? 'null' : `${checked.prevDigest.slice(0, 12)}…`
          } but its predecessor reads ${expected === null ? 'null' : `${expected.slice(0, 12)}…`}`,
        )
      // The kind gate applies to adopting too: a log written by a build that knew a kind this one
      // does not is refused by name, never skipped and never reinterpreted.
      const rule = registry.ruleFor(checked.protocol, checked.version, checked.kind)
      const payload = rule.parse(checked.payload, `${checked.protocol}@${checked.version} ${checked.kind} #${checked.seq}`)
      log.#apply(checked, payload, log.#advance(checked, payload))
    }

    return log
  }

  /** How many facts this log holds. Also the cut a reader's view is taken at. */
  get count(): number {
    return this.#entries.length
  }

  /**
   * The fact one command already committed, or `undefined` when it committed none.
   *
   * The journal `decide` identifies a redelivered command with is private to the commit region, and
   * a command whose external act — asking a person — happens *before* that region cannot wait for
   * the identification to arrive with it. This is that same journal, readable where the ordering
   * decides: a caller that finds its command here re-offers the recorded request instead of
   * repeating the act, and a caller that finds it under a different request is refused before the
   * act, exactly as the region itself would refuse it after.
   */
  committedOf(commandId: string): Envelope | undefined {
    return this.#commands.get(commandId)?.envelope
  }

  /**
   * Decide one fact: every rule, sealed, and **not** part of the log yet.
   *
   * A caller that owns a durability barrier hands the decision to `record` once the medium has
   * confirmed it, and drops it otherwise. The refusals all happen here, before anything is written,
   * so a fact the rules reject never reaches a medium at all.
   */
  decide<Payload>(input: EmitInput<Payload>, require?: () => void): Decision<Payload> {
    const rule = this.#registry.ruleFor(input.protocol, input.version, input.kind)
    if (rule.guarantees.derived === true)
      refuse(
        'derived-not-persistable',
        `${input.protocol}@${input.version} kind ${input.kind} is derived state; it is folded from persisted facts, never appended`,
      )

    // Parse first, so the emitter function and the reducer both see a closed shape.
    const position = this.#entries.length
    const payload = rule.parse(input.payload, `${input.protocol}@${input.version} ${input.kind} #${position}`)

    // The author is a property of the protocol and of the trusted binding, never of the request: the
    // kind's emitter names the submitting service, an `as` binding names the executor that service
    // stands for, and both resolve through the one subjects table.
    const role = rule.emitter(payload)
    const actor = this.#subjects[input.as ?? role]
    if (actor === undefined)
      refuse(
        'unknown-emitter-role',
        `kind ${input.kind} is emitted by role ${JSON.stringify(role)}${input.as === undefined ? '' : `, bound as ${JSON.stringify(input.as)}`}, which this deployment has no trusted identity for (known roles: ${Object.keys(this.#subjects).sort().join(', ') || 'none'})`,
      )

    // Command identity: a repeated request returns its recorded fact; a different one is refused.
    const requestDigest = digestOf({
      protocol: input.protocol,
      version: input.version,
      kind: input.kind,
      subject: input.subject,
      payload,
    })
    const recorded = this.#commands.get(input.commandId)
    if (recorded !== undefined) {
      if (recorded.requestDigest === requestDigest) return { envelope: recorded.envelope as Envelope<Payload>, fresh: false }
      refuse(
        'command-conflict',
        `command ${JSON.stringify(input.commandId)} already committed ${recorded.envelope.protocol}/${recorded.envelope.kind} #${recorded.envelope.seq} for a different request`,
      )
    }

    // Cross-subject preconditions run only for a command that will actually append.
    //
    // The ordering is the point: a re-delivered command has already been decided, and re-deciding
    // it against a state that has moved on would turn "give me back the result I lost" into a
    // refusal - which is exactly the recovery a lost reply is supposed to have. Identity first,
    // then the preconditions, then the reducer.
    require?.()

    const body: EnvelopeBody = {
      protocol: input.protocol,
      version: input.version,
      kind: input.kind,
      subject: input.subject,
      commandId: input.commandId,
      emitter: role,
      actor,
      at: this.#now(),
      seq: position,
      prevDigest: this.#entries.at(-1)?.digest ?? null,
      payload,
    }
    // The reducer is the single authority on legality, and it answers before the medium is asked.
    const envelope = sealEnvelope(body) as Envelope<Payload>
    const decision: Decision<Payload> = { envelope, fresh: true }
    DECIDED.set(decision, { log: this, payload, state: this.#advance(envelope, payload) })
    return decision
  }

  /**
   * Make a decision part of the log. Its caller has confirmed whatever it had to confirm.
   *
   * One rule decides every way this can be wrong, because they are one mistake: this log is not
   * holding that fact as decided-and-not-yet-recorded. A decision already recorded has been
   * consumed; a command that was already committed never produced one, so there is nothing left to
   * record; and another log's decision is not this chain's. A guard on `fresh` would be a second
   * rule for a condition the first one already covers, and a rule that can never fire is not a rule.
   *
   * The chain check is a different mistake: a fact recorded after this decision was taken would
   * leave a hole in the sequence, and a hole is not something a log repairs.
   */
  record(decision: Decision): void {
    const envelope = decision.envelope
    const pending = DECIDED.get(decision)
    if (pending === undefined || pending.log !== this)
      refuse(
        'illegal-transition',
        `${envelope.protocol}/${envelope.kind} #${envelope.seq} is not a fact this log decided and has yet to record; record consumes what decide returned, exactly once, and command ${JSON.stringify(envelope.commandId)} has nothing left to record`,
      )
    if (envelope.seq !== this.#entries.length)
      refuse(
        'chain-broken',
        `${envelope.protocol}/${envelope.kind} was decided at seq ${envelope.seq} but this log now holds ${this.#entries.length} facts; a fact recorded in between would leave a hole`,
      )
    DECIDED.delete(decision)
    this.#apply(envelope, pending.payload, pending.state)
  }

  /**
   * Record one fact, returning the sealed envelope. `decide` then `record`, for a caller with no
   * medium of its own: nothing here awaits, so this is one indivisible step.
   */
  emit<Payload>(input: EmitInput<Payload>, require?: () => void): Envelope<Payload> {
    const decision = this.decide<Payload>(input, require)
    if (decision.fresh) this.record(decision)
    return decision.envelope
  }

  /**
   * Every fact this store holds, oldest first. The durable medium's payload, and the fold's input.
   *
   * A copy of the array, whose members are frozen: the store's own sequence and its chain are
   * invariants, and handing out the live array would let a caller push a fact that no reducer ever
   * accepted and no digest ever sealed.
   */
  entries(): readonly Envelope[] {
    return [...this.#entries]
  }

  /** The facts of one protocol version, oldest first. */
  entriesOf(protocol: string, version: number): readonly Envelope[] {
    return this.#entries.filter(entry => entry.protocol === protocol && entry.version === version)
  }

  /**
   * One subject's folded state as of the first `cut` facts, or `undefined` when the log holds none
   * of its facts by then.
   *
   * A cut at the head is the cursor this log already keeps, and costs nothing. An earlier cut is
   * replayed from the facts below it — which is what makes a reader's cut *fixed*: the facts below
   * a cut never change, so the value read at that cut is the value it will always read.
   */
  stateAt<State>(protocol: string, version: number, subject: string, cut: number): State | undefined {
    if (cut >= this.#entries.length) return this.#states.get(stateKey(protocol, version))?.get(subject) as State | undefined
    return foldSubject<State>(this.#registry, this.#entries.slice(0, cut), protocol, version, subject)
  }

  /** Every subject of one protocol version as of the first `cut` facts. The whole-log read. */
  statesAt<State>(protocol: string, version: number, cut: number): ReadonlyMap<string, State> {
    if (cut >= this.#entries.length)
      return new Map(this.#states.get(stateKey(protocol, version)) ?? []) as ReadonlyMap<string, State>
    return foldSubjects<State>(this.#registry, this.#entries.slice(0, cut), protocol, version)
  }

  /** One fact's payload, reduced against the state this log holds for its subject. */
  #advance<State>(envelope: Envelope, payload: unknown): State {
    const rule = this.#registry.ruleFor<State>(envelope.protocol, envelope.version, envelope.kind)
    const spec = this.#registry.specFor<State>(envelope.protocol, envelope.version)
    const before = this.#states.get(stateKey(envelope.protocol, envelope.version))?.get(envelope.subject)
    // A reducer is pure and sees one subject, which is why cross-subject conditions live at the
    // command boundary and not here.
    return rule.reduce(before === undefined ? spec.initialState : (before as State), envelope, payload)
  }

  /**
   * The one place a fact enters the log. Its caller has already verified the frame and run the
   * reducer, so this is only the recording: frozen, chained, and indexed by command.
   */
  #apply(envelope: Envelope, payload: unknown, state: unknown): void {
    const key = stateKey(envelope.protocol, envelope.version)
    const states = this.#states.get(key) ?? new Map<string, unknown>()
    states.set(envelope.subject, frozen(state))
    this.#states.set(key, states)
    const fact = frozen(envelope)
    this.#entries.push(fact)
    // Command identity is rebuilt from the facts, so a successor can recognize a command whose
    // reply was lost: "committed but unanswered" is otherwise indistinguishable from "never seen".
    this.#commands.set(fact.commandId, {
      requestDigest: digestOf({
        protocol: fact.protocol,
        version: fact.version,
        kind: fact.kind,
        subject: fact.subject,
        payload,
      }),
      envelope: fact,
    })
  }
}

/**
 * Freeze a value and everything reachable from it.
 *
 * Committed values are published by reference, so an unfrozen one would let any reader rewrite the
 * log through a value it was handed. Idempotent, and it stops at anything already frozen, so a
 * state that shares structure with its predecessor is walked once.
 */
function frozen<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const member of Object.values(value)) frozen(member)
  return value
}

/** One protocol version's state map. The separator cannot appear in a protocol, so keys are unambiguous. */
function stateKey(protocol: string, version: number): string {
  return `${protocol}@${version}`
}

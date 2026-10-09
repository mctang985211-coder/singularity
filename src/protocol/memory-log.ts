/**
 * The fact pipeline: serialized commits, declared emitters, command identity, replay verification.
 *
 * **This holds facts in memory. It does not write them.** Durability belongs to DSH session
 * persistence, which owns the crash barrier, the cross-process write lease, replay, compaction and
 * the host-format migration chain. This module owns the *order and the rules*, and the medium is
 * somebody else's problem — which is the whole point of not self-building a log again.
 *
 * Four rules live here, each because a counterexample showed the cost of leaving it out:
 *
 * 1. **Commits are serialized.** Two concurrent `emit` calls must not both read the same cursor:
 *    that produced two facts at `seq = 0` and a log that could not be replayed. The queue makes
 *    "read the state, decide, append" one critical section.
 * 2. **The emitter is declared, not supplied.** A caller passes no author. The fact's role comes
 *    from its kind's declaration and its identity from the subjects this store was opened with, so
 *    no caller can claim to be a verifier.
 * 3. **A command is identified by its result.** The same `commandId` carrying the same request
 *    returns the recorded fact — the answer a caller may have lost — while the same id carrying a
 *    different request is refused. That distinguishes "committed but the reply never arrived" from
 *    "not committed".
 * 4. **Adopted facts are re-verified.** `adopt` is how a durable medium hands facts back: it checks
 *    framing, digest, chain link, sequence and kind before any reducer sees them, so a log written
 *    by a buggier build or edited outside this path is refused rather than half-understood.
 *
 * @module singularity-core/protocol/memory-log
 */

import { assertEnvelope, digestOf, sealEnvelope, type Envelope, type EnvelopeBody } from './envelope.ts'
import { foldSubjects } from './fold.ts'
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
}

export interface LogOptions {
  /** The trusted identity each emitter role resolves to. A role absent here cannot emit. */
  readonly subjects: Readonly<Record<string, string>>
  /** The instant one fact is stamped with. Injectable so a fold can be tested deterministically. */
  readonly now?: () => string
}

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
  readonly #entries: Envelope[]
  /**
   * The folded state of every subject, used as an append-time cursor. It is not a second
   * interpreter: every transition goes through the kind's own reducer, the same one `foldSubjects`
   * replays. A spec asserts the two agree.
   */
  readonly #states = new Map<string, unknown>()
  /** One command id maps to the fact it committed and the request that produced it. */
  readonly #commands = new Map<string, { requestDigest: string; envelope: Envelope }>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(registry: ProtocolRegistry, options: LogOptions) {
    this.#registry = registry
    this.#subjects = options.subjects
    this.#now = options.now ?? ((): string => new Date().toISOString())
    this.#entries = []
  }

  /**
   * Adopt facts a durable medium read back, verifying everything a reader must not have to
   * re-derive: each one frames, each digest matches its body, the chain links, sequence numbers are
   * contiguous from 0, every kind is declared, and every subject's sequence is legal.
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
      registry.ruleFor(checked.protocol, checked.version, checked.kind)
      log.#entries.push(checked)
    }

    // Adopting also replays every subject through its reducers, so a sequence that is illegal is
    // refused when it is adopted rather than when a reader happens to ask.
    for (const pair of new Set(log.#entries.map(entry => `${entry.protocol}@${entry.version}`))) {
      const separator = pair.lastIndexOf('@')
      const protocol = pair.slice(0, separator)
      const version = Number(pair.slice(separator + 1))
      for (const [subject, state] of foldSubjects(registry, log.#entries, protocol, version)) {
        log.#states.set(stateKey(protocol, version, subject), state)
      }
    }

    return log
  }

  /**
   * Record one fact, returning the sealed envelope.
   *
   * Serialized: the gate, the cursor read, the reducer check and the append happen as one critical
   * section, so two concurrent commands cannot both claim `seq` 0.
   */
  async emit<Payload>(input: EmitInput<Payload>): Promise<Envelope<Payload>> {
    const run = this.#queue.then(
      () => this.#commit(input),
      () => this.#commit(input),
    )
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #commit<Payload>(input: EmitInput<Payload>): Promise<Envelope<Payload>> {
    const rule = this.#registry.ruleFor(input.protocol, input.version, input.kind)
    if (rule.guarantees.derived === true)
      refuse(
        'derived-not-persistable',
        `${input.protocol}@${input.version} kind ${input.kind} is derived state; it is folded from persisted facts, never appended`,
      )

    // Parse first, so the emitter function and the reducer both see a closed shape.
    const position = this.#entries.length
    const payload = rule.parse(input.payload, `${input.protocol}@${input.version} ${input.kind} #${position}`)

    // The author is a property of the protocol, not of the caller.
    const role = rule.emitter(payload)
    const actor = this.#subjects[role]
    if (actor === undefined)
      refuse(
        'unknown-emitter-role',
        `kind ${input.kind} is emitted by role ${JSON.stringify(role)}, which this deployment has no trusted identity for (known roles: ${Object.keys(this.#subjects).sort().join(', ') || 'none'})`,
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
      if (recorded.requestDigest === requestDigest) return recorded.envelope as Envelope<Payload>
      refuse(
        'command-conflict',
        `command ${JSON.stringify(input.commandId)} already committed ${recorded.envelope.protocol}/${recorded.envelope.kind} #${recorded.envelope.seq} for a different request`,
      )
    }

    const body: EnvelopeBody = {
      protocol: input.protocol,
      version: input.version,
      kind: input.kind,
      subject: input.subject,
      emitter: role,
      actor,
      at: this.#now(),
      seq: position,
      prevDigest: this.#entries.at(-1)?.digest ?? null,
      payload,
    }
    const envelope = sealEnvelope(body)

    // The reducer is the single authority on legality. Ask it first, then record.
    const key = stateKey(input.protocol, input.version, input.subject)
    const before = this.#states.get(key)
    const spec = this.#registry.specFor(input.protocol, input.version)
    const after = rule.reduce(before === undefined ? spec.initialState : before, envelope, payload)

    this.#entries.push(envelope)
    this.#states.set(key, after)
    this.#commands.set(input.commandId, { requestDigest, envelope })
    return envelope as Envelope<Payload>
  }

  /** Every fact this store holds, oldest first. The durable medium's payload, and the fold's input. */
  entries(): readonly Envelope[] {
    return this.#entries
  }

  /** The facts of one protocol version, oldest first. */
  entriesOf(protocol: string, version: number): readonly Envelope[] {
    return this.#entries.filter(entry => entry.protocol === protocol && entry.version === version)
  }

  /**
   * The folded state of one subject as of everything recorded so far, or `undefined` when this
   * store holds none of its facts. Equal by construction to folding `entries()` afresh.
   */
  stateOf<State>(protocol: string, version: number, subject: string): State | undefined {
    return this.#states.get(stateKey(protocol, version, subject)) as State | undefined
  }
}

/** One subject's cursor key. The separator cannot appear in a protocol or version, so keys are unambiguous. */
function stateKey(protocol: string, version: number, subject: string): string {
  return `${protocol}@${version}\u0000${subject}`
}

/**
 * The one append path.
 *
 * Three rules live here, and each of them exists because a counterexample showed the cost of
 * leaving it out:
 *
 * 1. **Commits are serialized.** Two concurrent `emit` calls must not both read the same cursor:
 *    that produced two facts at `seq = 0` and a log that could not be reopened. The queue makes
 *    "read the state, decide, append" one critical section per log.
 * 2. **The emitter is declared, not supplied.** A caller passes no actor. The fact's role comes
 *    from its kind's declaration and its identity from the subjects this log was opened with, so
 *    no caller can claim to be a verifier.
 * 3. **A command is identified by its result.** The same `commandId` carrying the same request
 *    returns the recorded fact — the answer a caller may have lost — while the same id carrying a
 *    different request is refused. That is what makes "committed but the reply never arrived"
 *    distinguishable from "not committed".
 *
 * Storage is DSH's job in the target system; this module owns the order and the rules, not the
 * medium. It is the only module allowed to write durably, and the gate that says so stays until
 * the medium moves behind the DSH adapter.
 *
 * @module singularity-core/protocol/log
 */

import { open, readFile, stat } from 'node:fs/promises'
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

/** One append-only log. Hold exactly one instance per path; a second writer is refused. */
export class ProtocolLog {
  readonly #path: string
  readonly #registry: ProtocolRegistry
  readonly #subjects: Readonly<Record<string, string>>
  readonly #now: () => string
  readonly #entries: Envelope[]
  /**
   * The folded state of every subject this log has already accepted, used as an append-time
   * cursor. It is not a second interpreter: every transition goes through the kind's own
   * reducer, the same one `foldSubjects` replays. A spec asserts the two agree.
   */
  readonly #states = new Map<string, unknown>()
  /** One command id maps to the fact it committed and the request that produced it. */
  readonly #commands = new Map<string, { requestDigest: string; envelope: Envelope }>()
  #queue: Promise<unknown> = Promise.resolve()
  #size: number

  private constructor(
    path: string,
    registry: ProtocolRegistry,
    options: LogOptions,
    entries: Envelope[],
    size: number,
  ) {
    this.#path = path
    this.#registry = registry
    this.#subjects = options.subjects
    this.#now = options.now ?? ((): string => new Date().toISOString())
    this.#entries = entries
    this.#size = size
  }

  /**
   * Open (or create) one log, verifying everything a reader must not have to re-derive:
   * each line frames, each digest matches its body, the chain links, sequence numbers are
   * contiguous from 0, every fact's kind is declared, and every subject's sequence is legal.
   */
  static async open(path: string, registry: ProtocolRegistry, options: LogOptions): Promise<ProtocolLog> {
    const now = options.now ?? ((): string => new Date().toISOString())
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new ProtocolLog(path, registry, options, [], 0)
      throw error
    }

    const entries: Envelope[] = []
    for (const [index, line] of text.split('\n').entries()) {
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        refuse(
          'malformed-envelope',
          `${path} line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      entries.push(assertEnvelope(parsed))
    }

    for (const [index, entry] of entries.entries()) {
      if (entry.seq !== index)
        refuse(
          'chain-broken',
          `${path} holds ${entry.protocol}/${entry.kind} at seq ${entry.seq} in position ${index}; sequence numbers are contiguous from 0`,
        )
      const expected = index === 0 ? null : (entries[index - 1]?.digest ?? null)
      if (entry.prevDigest !== expected)
        refuse(
          'chain-broken',
          `${path} ${entry.protocol}/${entry.kind} #${entry.seq} links to ${
            entry.prevDigest === null ? 'null' : `${entry.prevDigest.slice(0, 12)}…`
          } but its predecessor reads ${expected === null ? 'null' : `${expected.slice(0, 12)}…`}`,
        )
      // The kind gate applies to loading too: a log written by a build that knew a kind this one
      // does not is refused by name, never skipped and never reinterpreted.
      registry.ruleFor(entry.protocol, entry.version, entry.kind)
    }

    const log = new ProtocolLog(path, registry, { ...options, now }, entries, await sizeOf(path))
    // Loading also replays every subject through its reducers, so a log whose sequence is illegal
    // is refused when it is opened rather than when a reader happens to ask.
    for (const pair of new Set(entries.map(entry => `${entry.protocol}@${entry.version}`))) {
      const separator = pair.lastIndexOf('@')
      const protocol = pair.slice(0, separator)
      const version = Number(pair.slice(separator + 1))
      for (const [subject, state] of foldSubjects(registry, entries, protocol, version)) {
        log.#states.set(stateKey(protocol, version, subject), state)
      }
    }
    return log
  }

  /**
   * Record one fact, returning the sealed envelope.
   *
   * Serialized per log: the gate, the cursor read, the reducer check and the append happen as one
   * critical section, so two concurrent commands cannot both claim `seq` 0.
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

    // Single-writer first: a cursor that no longer matches the file is the symptom of a second
    // writer, and reporting that as an illegal transition would name the wrong cause.
    const sizeBefore = await sizeOf(this.#path)
    if (sizeBefore !== this.#size)
      refuse(
        'concurrent-writer',
        `${this.#path} is ${sizeBefore} bytes but this writer opened it at ${this.#size}; one log has exactly one writer`,
      )

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

    // The reducer is the single authority on legality. Ask it first, then write.
    const key = stateKey(input.protocol, input.version, input.subject)
    const before = this.#states.get(key)
    const spec = this.#registry.specFor(input.protocol, input.version)
    const after = rule.reduce(before === undefined ? spec.initialState : before, envelope, payload)

    const sizeAfter = await this.#appendLine(envelope)
    this.#entries.push(envelope)
    this.#states.set(key, after)
    this.#commands.set(input.commandId, { requestDigest, envelope })
    this.#size = sizeAfter
    return envelope as Envelope<Payload>
  }

  /** Every fact this log holds, oldest first. The fold engine's only input. */
  entries(): readonly Envelope[] {
    return this.#entries
  }

  /** The facts of one protocol version, oldest first. */
  entriesOf(protocol: string, version: number): readonly Envelope[] {
    return this.#entries.filter(entry => entry.protocol === protocol && entry.version === version)
  }

  /**
   * The folded state of one subject as of everything appended so far, or `undefined` when this
   * log holds none of its facts. Equal by construction to folding `entries()` afresh.
   */
  stateOf<State>(protocol: string, version: number, subject: string): State | undefined {
    return this.#states.get(stateKey(protocol, version, subject)) as State | undefined
  }

  /** Write one line, flush it, read those exact bytes back from disk, and verify the seal. */
  async #appendLine(envelope: Envelope): Promise<number> {
    const line = `${JSON.stringify(envelope)}\n`
    const bytes = Buffer.byteLength(line)

    const writer = await open(this.#path, 'a')
    try {
      await writer.writeFile(line, 'utf8')
      await writer.sync()
    } finally {
      await writer.close()
    }

    const size = await sizeOf(this.#path)
    if (size < this.#size + bytes)
      refuse(
        'write-not-durable',
        `${this.#path} holds ${size} bytes after appending ${envelope.protocol}/${envelope.kind} #${envelope.seq}; expected at least ${this.#size + bytes}`,
      )

    const reader = await open(this.#path, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const { bytesRead } = await reader.read(buffer, 0, bytes, size - bytes)
      if (bytesRead !== bytes)
        refuse(
          'write-not-durable',
          `${this.#path} read back ${bytesRead} of ${bytes} bytes for ${envelope.protocol}/${envelope.kind} #${envelope.seq}`,
        )
      const readBack = assertEnvelope(JSON.parse(buffer.toString('utf8')))
      if (readBack.digest !== envelope.digest)
        refuse(
          'write-not-durable',
          `${this.#path} read back digest ${readBack.digest.slice(0, 12)}… for ${envelope.protocol}/${envelope.kind} #${envelope.seq}, sealed ${envelope.digest.slice(0, 12)}…`,
        )
    } finally {
      await reader.close()
    }

    return size
  }
}

/** The size of one file, or 0 when it does not exist yet. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/** One subject's cursor key. The separator cannot appear in a protocol or version, so keys are unambiguous. */
function stateKey(protocol: string, version: number, subject: string): string {
  return `${protocol}@${version}\u0000${subject}`
}

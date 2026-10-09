/**
 * The one append path.
 *
 * A fact is durable when `emit` returns: the line is written, fsynced, read back from disk,
 * and its digest verified. Nothing else in this codebase may write a durable file — the gate
 * script enforces that, because a second writer is how a protocol stack grows a second format.
 *
 * Loading verifies the chain and the version gate; it never interprets a raw line itself.
 * `entries()` hands the facts to the fold engine, which is the only thing that derives state.
 *
 * @module singularity-core/protocol/log
 */

import { open, readFile, stat } from 'node:fs/promises'
import { assertEnvelope, sealEnvelope, type Envelope, type EnvelopeBody } from './envelope.ts'
import { foldSubjects } from './fold.ts'
import { refuse } from './refusal.ts'
import type { ProtocolRegistry } from './registry.ts'

/** What a caller supplies to record one fact. The frame's own members are never caller-supplied. */
export interface EmitInput<Payload = unknown> {
  readonly protocol: string
  readonly version: number
  readonly kind: string
  readonly subject: string
  readonly actor: string
  readonly payload: Payload
}

export interface LogOptions {
  /** The instant one fact is stamped with. Injectable so a fold can be tested deterministically. */
  readonly now?: () => string
}

/** One append-only log. Hold exactly one instance per path; a second writer is refused. */
export class ProtocolLog {
  readonly #path: string
  readonly #registry: ProtocolRegistry
  readonly #now: () => string
  readonly #entries: Envelope[]
  /**
   * The folded state of every subject this log has already accepted, used as an append-time
   * cursor. It is not a second interpreter: every transition goes through the kind's own
   * reducer, the same one `foldSubjects` replays. A spec asserts the two agree.
   */
  readonly #states = new Map<string, unknown>()
  #size: number

  private constructor(path: string, registry: ProtocolRegistry, now: () => string, entries: Envelope[], size: number) {
    this.#path = path
    this.#registry = registry
    this.#now = now
    this.#entries = entries
    this.#size = size
  }

  /**
   * Open (or create) one log, verifying everything a reader must not have to re-derive:
   * each line frames, each digest matches its body, the chain links, sequence numbers are
   * contiguous from 0, and every fact's `(protocol, version, kind)` is declared by this build.
   */
  static async open(path: string, registry: ProtocolRegistry, options: LogOptions = {}): Promise<ProtocolLog> {
    const now = options.now ?? ((): string => new Date().toISOString())
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new ProtocolLog(path, registry, now, [], 0)
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
      // The version gate applies to loading too: a log written by a build that knew a kind this
      // one does not is refused by name, never skipped and never reinterpreted.
      registry.ruleFor(entry.protocol, entry.version, entry.kind)
    }

    const log = new ProtocolLog(path, registry, now, entries, await sizeOf(path))
    // Loading also replays every subject through its reducers, so a log whose sequence is
    // illegal is refused when it is opened rather than when a reader happens to ask.
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
   * The gate runs before anything is written: an unknown protocol, version, kind, or a derived
   * (G4) kind is refused with nothing on disk. The fact's own reducer then runs against this
   * subject's state so far, so a fact the protocol cannot accept is refused **before** it is
   * durable — the log never records a sequence its own fold would reject.
   */
  async emit<Payload>(input: EmitInput<Payload>): Promise<Envelope<Payload>> {
    const rule = this.#registry.ruleFor(input.protocol, input.version, input.kind)
    if (rule.guarantee === 'G4')
      refuse(
        'g4-not-persistable',
        `${input.protocol}@${input.version} kind ${input.kind} is G4 (derived state); it is folded from persisted facts, never appended`,
      )

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
      actor: input.actor,
      at: this.#now(),
      seq: this.#entries.length,
      prevDigest: this.#entries.at(-1)?.digest ?? null,
      payload: input.payload,
    }
    const envelope = sealEnvelope(body)

    // The reducer is the single authority on legality. Ask it first, then write.
    const key = stateKey(input.protocol, input.version, input.subject)
    const before = this.#states.get(key)
    const spec = this.#registry.specFor(input.protocol, input.version)
    const after = rule.reduce(before === undefined ? spec.initialState : before, envelope)

    const sizeAfter = await this.#appendLine(envelope)
    this.#entries.push(envelope)
    this.#states.set(key, after)
    this.#size = sizeAfter
    return envelope as Envelope<Payload>
  }

  /**
   * The folded state of one subject as of everything appended so far, or `undefined` when this
   * log holds none of its facts. Equal by construction to folding `entries()` afresh.
   */
  stateOf<State>(protocol: string, version: number, subject: string): State | undefined {
    return this.#states.get(stateKey(protocol, version, subject)) as State | undefined
  }

  /** Every fact this log holds, oldest first. The fold engine's only input. */
  entries(): readonly Envelope[] {
    return this.#entries
  }

  /** The facts of one protocol version, oldest first. */
  entriesOf(protocol: string, version: number): readonly Envelope[] {
    return this.#entries.filter(entry => entry.protocol === protocol && entry.version === version)
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

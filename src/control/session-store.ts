/**
 * The control store: our facts, carried by a DSH session this deployment owns.
 *
 * **Why a session of our own.** The runtime event vocabulary is generated from the DSH repo's own
 * sources, so an out-of-repo plugin's event type is outside it by construction. The one supported
 * compatibility mechanism is the persisted `ignorable` marker, and the live seam (`Session.append`)
 * cannot set it — an unmarked unknown type makes the *whole* log unreadable at the next open.
 * So the control records live in a **separate session with a stable id derived from the control
 * id**, one event per record, and every event is written through our own write handle with
 * `ignorable: true`. No execution agent's transcript carries them.
 *
 * **What each side owns.** DSH carries bytes: the event envelope, membership of the `ignorable`
 * mechanism, deep-frozen materialization, the crash barrier (`flush`) and the cross-process write
 * lease. Everything semantic is ours: the carrier's closed shape, the inner frame's digest and
 * chain, the declared kind, the payload's shape and the fold. A record this store hands back has
 * passed `assertEnvelope` and `MemoryLog.adopt`, never merely a DSH type check.
 *
 * **The carrier record.** One event of type {@link CONTROL_EVENT_TYPE} carries
 * `data = { protocol: 'singularity.control', version: 1, kind, payload }`. `kind` mirrors the inner
 * envelope's kind, so the closed kind set is checkable without interpreting the payload;
 * `payload` is the complete sealed envelope, because the inner frame (subject, emitter, actor,
 * time, sequence, chain link, digest) is exactly what must survive — a frame cannot be
 * reconstructed from four fields, and a digest is verified, never re-minted.
 *
 * **Per-emit ordering.** Parse and rule-check (in `src/protocol/`), then DSH's own
 * `materializeAppendBatch` as the serializability gate — a value DSH cannot carry is refused by
 * name *before* a byte is written — then `append` (sequence contiguous from the stored cursor),
 * then `await flush()`, then read the record back and check the digest that came back is the
 * digest that was sealed. Only then is the prepared state published. A storage failure leaves
 * the previous committed snapshot readable and disables writes until close and a new open
 * complete a successful durability barrier; a visible prefix alone is not a committed prefix.
 *
 * @module singularity-core/control/session-store
 */

import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceNotFoundError,
  materializeAppendBatch,
  type SessionHandle,
  type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'

import { assertClosedKeys, assertEnvelope, type Envelope } from '../protocol/envelope.ts'
import { MemoryLog, type EmitInput, type LogOptions } from '../protocol/memory-log.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'

/** Our own session event type. Never a borrowed DSH type, never a member of the runtime vocabulary. */
export const CONTROL_EVENT_TYPE = 'plugin:singularity:control'

/** The carrier marker inside one control event's data. It is a literal, not a registry lookup. */
export const CONTROL_PROTOCOL = 'singularity.control'

/** The carrier format version. A carrier change that an older build would misread bumps this. */
export const CONTROL_VERSION = 1

/** The one shape one control event's `data` may carry. Closed: an undeclared member is a refusal. */
export interface ControlEventData {
  readonly protocol: 'singularity.control'
  readonly version: 1
  /** Mirrors the carried envelope's kind, so the closed kind set is checkable on its own. */
  readonly kind: string
  /** The complete sealed envelope. The DSH layer carries it; `src/protocol/` decides what it means. */
  readonly payload: Envelope
}

// Type-level only: the runtime vocabulary stays generated from the DSH repo's own sources, which is
// why the `ignorable` marker — not this augmentation — is what makes the log readable by others.
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'plugin:singularity:control': ControlEventData
  }
}

/** The closed member set of one control event's data. */
const CONTROL_DATA_MEMBERS = ['protocol', 'version', 'kind', 'payload'] as const

/** What a control store needs to exist: the medium, the identity, and whose facts these are. */
export interface ControlStoreOptions {
  /** The DSH persistence service that owns the bytes (`ctx.sessionPersistence`). */
  readonly persistence: SessionPersistence
  /** The supplied graph/environment id. The session id is derived from it, never passed in raw. */
  readonly controlId: string
  readonly registry: ProtocolRegistry
  /** The trusted identity each emitter role resolves to. A role absent here cannot emit. */
  readonly subjects: Readonly<Record<string, string>>
  /** The instant one fact is stamped with. Injectable so a fold can be tested deterministically. */
  readonly now?: () => string
  /** Absolute working directory recorded in the session header, when the deployment has one. */
  readonly cwd?: string
}

/** The stable session id one control id resolves to. Derived, so two callers cannot disagree. */
export function controlSessionIdOf(controlId: string): SessionId {
  if (controlId.length === 0)
    refuse('malformed-declaration', 'a control id must be a non-empty string; it names the session that will carry the facts')
  return SessionId(`singularity:control:${controlId}`)
}

/**
 * One control session, open for writing.
 *
 * One instance is one writer, because the medium's write handle is the one lease. This store's
 * queue serializes preparation, append, barrier and publication, so concurrent commands cannot
 * interleave their sequence numbers or observe one another's uncommitted state.
 */
export class ControlSessionStore {
  readonly #handle: SessionHandle
  readonly #sessionId: SessionId
  readonly #options: ControlStoreOptions
  /** Only facts whose durability and readback have been confirmed are published here. */
  #log: MemoryLog
  /** The medium's next event sequence. The medium refuses a batch that does not continue it. */
  #nextSeq: number
  /**
   * The next sequence of **our** chain, which is the count of adopted records, not the medium's
   * event count. The two coincide while the session holds only our records; keeping them apart
   * means an event another producer left in this session can neither shift our chain nor make us
   * mistake a recorded command for a new one.
   */
  #ownSeq: number
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #uncertain = false
  #closing: Promise<void> | undefined

  private constructor(handle: SessionHandle, log: MemoryLog, options: ControlStoreOptions, sessionId: SessionId, nextSeq: number, ownSeq: number) {
    this.#handle = handle
    this.#log = log
    this.#options = options
    this.#sessionId = sessionId
    this.#nextSeq = nextSeq
    this.#ownSeq = ownSeq
  }

  /**
   * Open the control session for writing, creating it when it does not exist yet, and adopt every
   * fact it already holds. A write open that somebody else owns is `SessionAlreadyOwnedError` and
   * is deliberately not caught: this store never silently becomes a second writer. A record that
   * fails adoption refuses the open **and releases the lease** — a refused open that kept the write
   * handle would leave the session unwritable with nobody holding it.
   */
  static async open(options: ControlStoreOptions): Promise<ControlSessionStore> {
    const sessionId = controlSessionIdOf(options.controlId)
    let handle: SessionHandle
    try {
      handle = await options.persistence.open(sessionId, 'write')
    } catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      handle = await options.persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: sessionId,
        createdAt: Date.now(),
        isSeeded: false,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      })
    }

    try {
      try {
        // A predecessor may have lost its barrier or its reply. Visibility does not establish
        // durability, so adoption first confirms the prefix through the write handle's barrier.
        await handle.flush()
      } catch (error) {
        refuse('write-not-durable', `control store ${sessionId} cannot confirm its opening durability barrier: ${error instanceof Error ? error.message : String(error)}`)
      }
      const stored = await handle.read()
      // Select our records by type, then decide meaning entirely ourselves: framing, digest, chain
      // link, sequence, declared kind and payload shape are all re-checked by the calls below.
      const entries = structuredClone(stored.events.filter(isControlEvent).map(decodeControlEvent))
      const log = MemoryLog.adopt(entries, options.registry, logOptionsOf(options))
      return new ControlSessionStore(handle, log, options, sessionId, stored.events.length, entries.length)
    } catch (error) {
      try {
        await handle.close()
      } catch {
        // The refusal is the outcome; a teardown failure must not replace it.
      }
      throw error
    }
  }

  /** The session this store owns. Stable for the control id, separate from any agent transcript. */
  get sessionId(): SessionId {
    return this.#sessionId
  }

  /** A fixed committed read cut. The view has no writer and shares no mutable values with it. */
  load(): Readonly<Pick<MemoryLog, 'entries' | 'entriesOf' | 'stateOf'>> {
    const log = this.#log
    return Object.freeze({
      entries: (): readonly Envelope[] => structuredClone(log.entries()),
      entriesOf: (protocol: string, version: number): readonly Envelope[] => structuredClone(log.entriesOf(protocol, version)),
      stateOf: <State>(protocol: string, version: number, subject: string): State | undefined =>
        structuredClone(log.stateOf<State>(protocol, version, subject)),
    })
  }

  /**
   * Record one fact: rules and digest in memory, durable bytes in the session, then the same
   * digest read back. A re-delivered command returns the fact it already committed and appends
   * nothing — the record is already durable, so a second append would be a second fact.
   */
  async emit<Payload>(input: EmitInput<Payload>, require?: () => void): Promise<Envelope<Payload>> {
    const run = this.#queue.then(
      () => this.#commit(input, require),
      () => this.#commit(input, require),
    )
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #commit<Payload>(input: EmitInput<Payload>, require?: () => void): Promise<Envelope<Payload>> {
    if (this.#closed) refuse('write-not-durable', `control store ${this.#sessionId} is closed; a closed store records nothing`)
    if (this.#uncertain)
      refuse('write-not-durable', `control store ${this.#sessionId} has an uncertain storage result; close and reopen it with a successful durability barrier before retrying`)

    // Prepare privately. A reducer or append must never advance the state ordinary readers see.
    const prepared = MemoryLog.adopt(structuredClone(this.#log.entries()), this.#options.registry, logOptionsOf(this.#options))
    const envelope = await prepared.emit(input, require)
    // Command identity: the same command id with the same request returned the fact it committed,
    // whose sequence is below our own cursor because that fact is already a record in this session.
    if (envelope.seq < this.#ownSeq) return structuredClone(envelope)

    const event: SessionEvent<typeof CONTROL_EVENT_TYPE> = {
      type: CONTROL_EVENT_TYPE,
      seq: SessionSeq(this.#nextSeq),
      time: Date.now(),
      data: { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, kind: envelope.kind, payload: envelope },
      ignorable: true,
    }

    // DSH's own serializability gate, and it runs before any byte is written. It throws a bare
    // TypeError; this stack refuses by name, so the refusal survives the boundary as data.
    let batch: readonly SessionEvent[]
    try {
      batch = materializeAppendBatch([event])
    } catch (error) {
      refuse(
        'not-lossless-json',
        `control record ${envelope.protocol}/${envelope.kind} #${envelope.seq} is not losslessly JSON-serializable, so session ${this.#sessionId} cannot carry it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    // Materialization detaches the caller's payload. Verify that sealed snapshot before any write.
    assertEnvelope((batch[0] as SessionEvent<typeof CONTROL_EVENT_TYPE>).data.payload)

    const label = `${envelope.protocol}/${envelope.kind} #${envelope.seq}`
    let phase = 'append'
    try {
      await this.#handle.append(batch)
      phase = 'durability barrier'
      await this.#handle.flush()
      phase = 'readback'
      const { events } = await this.#handle.read(this.#nextSeq, 1)
      const readBack = events[0]
      if (readBack === undefined || !isControlEvent(readBack))
        refuse('write-not-durable', `${label} was written at seq ${this.#nextSeq} but ${this.#sessionId} reads back no control record there`)
      const durable = decodeControlEvent(readBack)
      if (durable.digest !== envelope.digest)
        refuse('write-not-durable', `${label} sealed digest ${envelope.digest} but ${this.#sessionId} reads back ${durable.digest}`)

      // Publish from the confirmed stored value, with no references to a caller or a DSH handle.
      this.#log = MemoryLog.adopt(structuredClone([...this.#log.entries(), durable]), this.#options.registry, logOptionsOf(this.#options))
      this.#nextSeq += 1
      this.#ownSeq += 1
      return structuredClone(durable) as Envelope<Payload>
    } catch (error) {
      this.#uncertain = true
      refuse('write-not-durable', `${label} ${phase} failed in ${this.#sessionId}; storage result is uncertain: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Ordered teardown: accepted commands finish before the handle releases its write lease.
   * Later commands observe a closed store. All callers await the same close result.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closing = this.#queue.then(async () => {
      this.#closed = true
      await this.#handle.close()
    })
    this.#queue = this.#closing.then(() => undefined, () => undefined)
    return this.#closing
  }
}

/** A stored event of our own type, by the one property DSH guarantees. */
function isControlEvent(event: SessionEvent): event is SessionEvent<typeof CONTROL_EVENT_TYPE> {
  return event.type === CONTROL_EVENT_TYPE
}

/**
 * Read one carried envelope, or refuse it by name.
 *
 * Ownership is never decided by the DSH event type alone: the carrier's shape is closed, its
 * literal protocol and version are checked, the mirrored kind must equal the carried kind, and the
 * inner frame is re-asserted — digest over body, closed members, no losslessly-JSON externals.
 * The declared-kind gate and the chain check run in `MemoryLog.adopt`, on the values this returns.
 */
function decodeControlEvent(event: SessionEvent<typeof CONTROL_EVENT_TYPE>): Envelope {
  const where = `control event #${event.seq} (${CONTROL_EVENT_TYPE})`
  const data: unknown = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    refuse('malformed-payload', `${where} data must be an object, got ${data === null ? 'null' : Array.isArray(data) ? 'an array' : typeof data}`)
  const record = data as Record<string, unknown>
  assertClosedKeys(record, CONTROL_DATA_MEMBERS, `${where} data`)
  if (record['protocol'] !== CONTROL_PROTOCOL)
    refuse('malformed-payload', `${where} data.protocol must be ${JSON.stringify(CONTROL_PROTOCOL)}, got ${JSON.stringify(record['protocol'] ?? null)}`)
  if (record['version'] !== CONTROL_VERSION)
    refuse('version-mismatch', `${where} data.version must be ${CONTROL_VERSION}, got ${JSON.stringify(record['version'] ?? null)}`)
  const kind = record['kind']
  if (typeof kind !== 'string' || kind.length === 0)
    refuse('malformed-payload', `${where} data.kind must be a non-empty string, got ${kind === null ? 'null' : typeof kind}`)

  const envelope = assertEnvelope(record['payload'])
  if (envelope.kind !== kind)
    refuse(
      'malformed-payload',
      `${where} data.kind reads ${JSON.stringify(kind)} but the envelope it carries is ${envelope.protocol}/${envelope.kind} #${envelope.seq}`,
    )
  return envelope
}

/** `LogOptions` with `now` present only when it was supplied: `exactOptionalPropertyTypes` is on. */
function logOptionsOf(options: ControlStoreOptions): LogOptions {
  return options.now === undefined ? { subjects: options.subjects } : { subjects: options.subjects, now: options.now }
}

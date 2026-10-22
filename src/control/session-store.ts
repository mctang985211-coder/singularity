/**
 * DSH adapter seam. Protocol/decision modules use only its erased port types.
 * The control store: our facts, carried by a DSH session this deployment owns.
 *
 * **Why a session of our own.** Control records live in a separate session with a stable id
 * derived from the control id, one event per record, written through this store's write handle
 * with `ignorable: true`. DSH readers retain plugin-owned log-only records through that marker;
 * an unmarked unknown event makes the log unreadable. Execution transcripts hold conversation
 * and auxiliary model-call records, while this store owns the ordered business facts.
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
 * **Per-emit ordering.** `decide` (in `src/protocol/`) applies every rule and seals the fact
 * without recording it, then DSH's own `materializeAppendBatch` is the serializability gate — a
 * value DSH cannot carry is refused by name *before* a byte is written — then `append` (sequence
 * contiguous from the stored cursor), then `await flush()`, then the record is read back and its
 * digest checked against the one that was sealed. Only then is the fact **recorded**, and the log
 * is what a reader reads. So the log holds exactly the durable prefix at every instant, and the
 * cut a reader gets is the cut a reader gets: no copy of a hopeful state, and no replay of a log
 * that has not moved. A storage failure leaves the previous committed cut readable and disables
 * writes until close and a new open complete a successful durability barrier; a visible prefix
 * alone is not a committed prefix.
 *
 * This queue is the stack's only one. `MemoryLog` needs none, because neither half of an emit
 * awaits; a commit here spans a real write, so it is the one place a serial region is needed.
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
import { MemoryLog, type Decision, type EmitInput, type LogOptions } from '../protocol/memory-log.ts'
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
//
// The target is the module that **declares** `SessionEventMap`, not the barrel that re-exports it.
// Augmenting `@deepseek-ai/dsh-session` lands on `lib/types/index.d.ts`, where that name is an import
// binding rather than an export, so the added member is dropped and every `SessionEvent<K>` of our
// type fails the constraint as soon as the program also loads dsh-agent/dsh-tools types. The subpath
// is the declaration site, and `tsconfig.json` maps it to `lib/types/types.d.ts`.
declare module '@deepseek-ai/dsh-session/types' {
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
  /**
   * The trusted identity each emitter role resolves to. A role absent here cannot emit.
   *
   * This is the **one** role table of a deployment: the store copies it at `open`, stamps every fact
   * with the identity it resolves, and answers {@link ControlSessionStore.identityOf} from the same
   * value. A service that must compare an identity against another subject's actor asks the store;
   * it is never handed a table of its own, because a second table is free to leave a role out and a
   * check that reads it then compares nothing while the log stamps the actor anyway.
   *
   * The copy is not the whole roster: a Web deployment mints agents while it runs, so a role that
   * appears later is added to this very table by {@link ControlSessionStore.declareSubject}.
   */
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
 * A fixed committed read cut.
 *
 * The cut is taken when this view is made, and the facts below a cut never change, so the view
 * keeps reading the same values however much the store commits afterwards. There is no writer here
 * and no mutable value behind it: what a committed fact and a committed state are, they are frozen.
 */
export interface ControlReadCut {
  entries(): readonly Envelope[]
  entriesOf(protocol: string, version: number): readonly Envelope[]
  stateOf<State>(protocol: string, version: number, subject: string): State | undefined
  /** Every subject of one protocol version. The whole-log read, as of the same cut. */
  statesOf<State>(protocol: string, version: number): ReadonlyMap<string, State>
}

/**
 * One control session, open for writing.
 *
 * One instance is one writer, because the medium's write handle is the one lease. This store's
 * queue serializes decision, append, barrier and record, so concurrent commands cannot interleave
 * their sequence numbers or observe one another's unrecorded state.
 */
export class ControlSessionStore {
  readonly #handle: SessionHandle
  readonly #sessionId: SessionId
  /** The one role table this store stamps identities from, and the only one it answers with. */
  readonly #subjects: Record<string, string>
  /** Exactly the facts whose durability and readback have been confirmed. */
  #log: MemoryLog
  /** The medium's next event sequence. The medium refuses a batch that does not continue it. */
  #nextSeq: number
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #uncertain = false
  #closing: Promise<void> | undefined

  private constructor(handle: SessionHandle, log: MemoryLog, sessionId: SessionId, nextSeq: number, subjects: Record<string, string>) {
    this.#handle = handle
    this.#log = log
    this.#sessionId = sessionId
    this.#nextSeq = nextSeq
    this.#subjects = subjects
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
    // The deployment's role table, copied once: the log stamps from it and the store answers the port
    // from it, so the two can never be two tables. It is deliberately not frozen — `declareSubject`
    // adds to this very object, which is the one `MemoryLog` already holds — and it has no prototype,
    // so a role named `__proto__` or `toString` is a role like any other and an absent one resolves
    // to `undefined` rather than to a member of `Object.prototype`.
    const subjects: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, options.subjects)
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
      // link, sequence, declared kind and payload shape are all re-checked by the calls below. This
      // is the one place the whole log is replayed and copied; every later commit adds to it.
      const entries = structuredClone(stored.events.filter(isControlEvent).map(decodeControlEvent))
      const log = MemoryLog.adopt(entries, options.registry, logOptionsOf(options, subjects))
      return new ControlSessionStore(handle, log, sessionId, stored.events.length, subjects)
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

  /**
   * The identity this deployment stamps for one emitter role, or `undefined` when it trusts none.
   *
   * The port a cross-subject check asks when it has to compare a role against the actor of another
   * subject's fact — "is the identity that would report this the one that did the work" — because
   * the identities a fact carries are this store's to resolve and nobody else's to restate. It
   * answers from the table the log itself resolves with, so a check that asks cannot disagree with
   * the stamp the append path is about to apply.
   */
  identityOf(role: string): string | undefined {
    return this.#subjects[role]
  }

  /**
   * Add one trusted identity to the role table the log stamps from, after `open`.
   *
   * A Web deployment mints agents while it runs, so the roster cannot be complete when the store
   * opens; refusing every role it did not know then would make a dynamically created agent
   * unrepresentable. What it may **not** do is declare a role the log then ignores: this writes to
   * the very record `MemoryLog` resolves its actors from, so the identity {@link identityOf} answers
   * and the identity the next fact is stamped with are one value.
   *
   * Three rules, and each is a refusal rather than a repair:
   *
   * 1. **A declaration names something.** An empty key or an empty identity would create a role that
   *    no fact could be attributed to, or an actor nobody can name.
   * 2. **The same key with the same identity changes nothing.** Declaring a role twice is a
   *    deployment composing its roster from two places, which is not an error.
   * 3. **A key resolves to one identity, ever.** Re-declaring it as somebody else would re-point
   *    every fact already stamped with the first identity, so it is refused and the table is left as
   *    it was.
   */
  declareSubject(key: string, identity: string): void {
    if (key.length === 0 || identity.length === 0)
      refuse(
        'malformed-declaration',
        `a subject declaration must name a non-empty role and a non-empty identity, got ${JSON.stringify(key)} → ${JSON.stringify(identity)}`,
      )
    const existing = Object.hasOwn(this.#subjects, key) ? this.#subjects[key] : undefined
    if (existing === undefined) {
      this.#subjects[key] = identity
      return
    }
    if (existing === identity) return
    refuse(
      'malformed-declaration',
      `role ${JSON.stringify(key)} is already declared as ${JSON.stringify(existing)}; re-declaring it as ${JSON.stringify(identity)} would re-point every fact already stamped with the first identity`,
    )
  }

  /**
   * The fact one command already committed, or `undefined` when it committed none.
   *
   * The commit region identifies a redelivered command itself, but only once the command reaches it.
   * A command whose external act — asking a person — happens before the region cannot let the
   * identification arrive with it, or the act repeats first; this is the same journal the region
   * identifies with, readable before the ask, so a lost reply is answered from the fact rather than
   * asked for twice.
   */
  committedOf(commandId: string): Envelope | undefined {
    return this.#log.committedOf(commandId)
  }

  /** A fixed committed read cut. The view has no writer and shares no mutable values with it. */
  load(): ControlReadCut {
    const log = this.#log
    const cut = log.count
    return Object.freeze({
      entries: (): readonly Envelope[] => log.entries().slice(0, cut),
      entriesOf: (protocol: string, version: number): readonly Envelope[] =>
        log.entriesOf(protocol, version).filter(entry => entry.seq < cut),
      stateOf: <State>(protocol: string, version: number, subject: string): State | undefined =>
        log.stateAt<State>(protocol, version, subject, cut),
      statesOf: <State>(protocol: string, version: number): ReadonlyMap<string, State> =>
        log.statesAt<State>(protocol, version, cut),
    })
  }

  /**
   * Record one fact: rules and digest in memory, durable bytes in the session, then the same digest
   * read back, and only then part of the log. A re-delivered command returns the fact it already
   * committed and writes nothing — the record is already durable, so a second append would be a
   * second fact.
   *
   * `input` may also be a **producer**: a synchronous function this store calls inside the serial
   * region, for a command whose fact is chosen by the state it finds there (a run's settlement is the
   * one such command today). Two properties are required of it. It must not await — it runs in a slot
   * of the commit queue, and a slot that awaited would hold the queue across a turn. And it must
   * derive the request from what it reads rather than from anything a replay moves, so a re-delivered
   * command recomputes the same request and `decide` answers it from the journal instead of recording
   * a second fact. The object form needs neither property: its request is the caller's.
   */
  async emit<Payload>(input: EmitInput<Payload> | (() => EmitInput<Payload>), require?: () => void): Promise<Envelope<Payload>> {
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

  async #commit<Payload>(input: EmitInput<Payload> | (() => EmitInput<Payload>), require?: () => void): Promise<Envelope<Payload>> {
    if (this.#closed) refuse('write-not-durable', `control store ${this.#sessionId} is closed; a closed store records nothing`)
    if (this.#uncertain)
      refuse('write-not-durable', `control store ${this.#sessionId} has an uncertain storage result; close and reopen it with a successful durability barrier before retrying`)

    // The producer runs here, in the serial region: the cut it reads is taken after every earlier
    // commit has recorded, and before this one decides anything.
    const request: EmitInput<Payload> = typeof input === 'function' ? input() : input

    // Decide without recording: a reducer or a refusal must never advance the state ordinary
    // readers see, and neither does. `fresh: false` is the whole of "the reply was lost": the fact
    // is already durable, so this returns it and writes nothing.
    const decision: Decision<Payload> = this.#log.decide(request, require)
    const envelope = decision.envelope
    if (!decision.fresh) return envelope

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

      // The barrier held, so the fact is durable: record it, and only now is it part of the log.
      // `record` froze the same object it was handed, so this is the stored value.
      this.#log.record(decision)
      this.#nextSeq += 1
      return envelope
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
function logOptionsOf(options: ControlStoreOptions, subjects: Readonly<Record<string, string>>): LogOptions {
  return options.now === undefined ? { subjects } : { subjects, now: options.now }
}

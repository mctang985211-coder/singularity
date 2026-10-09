/**
 * The durability barrier, proven able to fail.
 *
 * Phase A's last exit condition is "a failed barrier does not return success". The store already
 * refuses `write-not-durable` when `flush` rejects, but no spec ever made `flush` reject, so the
 * claim was code-correct and observationally unproven. This file supplies the one thing missing: a
 * medium that accepts an `append` and *then* fails its barrier.
 *
 * What the fake may and may not do is fixed by the interface, not by convenience. On `append`'s
 * resolution the batch is "accepted, ordered, and visible to reads on this backend instance", while
 * "only a resolved `flush` promises it survives a crash". So the batch **is** visible and `flush`
 * rejects — the dangerous shape, where the fact may well be durable although the promise was never
 * made. The store must refuse, and may not pretend either way: it may neither report success nor
 * discard a record the medium visibly holds.
 *
 * The fake also enforces DSH's own contiguity rule, so a store that invented a sequence number
 * would be refused by the medium rather than quietly accepted by the double.
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadResult,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'

import { type EmitInput, type RefusalCode } from '../src/index.ts'
import { ControlSessionStore, type ControlEventData, type ControlStoreOptions } from '../src/control/session-store.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION } from '../src/task/protocol.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { REVISION, RUN_ID, SUBJECTS, TASK_ID, contract, taskRegistry } from './task-fixtures.ts'

/**
 * A medium that accepts appends and then fails its durability barrier.
 *
 * `barrierFailures` is how many forthcoming barriers reject: one models a single failure from which
 * the store must recover, and `Infinity` models a medium whose barrier never resolves.
 */
class FailingBarrierPersistence extends SessionPersistence {
  /** What the medium holds, in seq order. A spec may read it because this *is* the medium. */
  readonly events: SessionEvent[] = []
  #header: SessionHeader | undefined
  #barrierFailures: number

  constructor(ctx: Context, barrierFailures: number) {
    super(ctx)
    this.#barrierFailures = barrierFailures
  }

  /** The barrier: reject while a failure is owed, otherwise resolve. */
  failBarrierOrResolve(): void {
    if (this.#barrierFailures <= 0) return
    this.#barrierFailures -= 1
    throw new Error('the fake medium accepted the batch but its durability barrier failed')
  }

  override async create(header: SessionHeader): Promise<SessionHandle> {
    if (this.#header !== undefined) throw new Error(`the fake medium already holds session ${this.#header.id}`)
    this.#header = header
    return new FakeHandle(this, header, 'write')
  }

  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const header = this.#header
    if (header === undefined || header.id !== id) throw new SessionPersistenceNotFoundError(id)
    return new FakeHandle(this, header, access)
  }

  override async flush(): Promise<void> {
    this.failBarrierOrResolve()
  }

  override async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const header = this.#header
    if (header === undefined || header.id !== id) return undefined
    return this.#snapshot(header)
  }

  override async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    const header = this.#header
    return header === undefined ? [] : [this.#snapshot(header)]
  }

  #snapshot(header: SessionHeader): SessionPersistenceSnapshot {
    return {
      header,
      revision: SessionPersistenceRevision(`fake:${header.id}:${this.events.length}`),
      eventCount: this.events.length,
    }
  }
}

/** One handle onto the fake medium. Read is a slice; append enforces contiguity; flush is the barrier. */
class FakeHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)
  readonly header: SessionHeader
  readonly access: SessionAccess
  readonly #medium: FailingBarrierPersistence
  #closed = false

  constructor(medium: FailingBarrierPersistence, header: SessionHeader, access: SessionAccess) {
    this.#medium = medium
    this.header = header
    this.access = access
  }

  get id(): SessionId {
    return this.header.id
  }

  async read(offset = 0, length?: number): Promise<SessionHandleReadResult> {
    this.#assertOpen('read')
    const { events } = this.#medium
    return { eventState: 'detached', events: events.slice(offset, length === undefined ? events.length : offset + length) }
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.#assertOpen('append')
    assertContiguous(this.id, events, this.#medium.events.length)
    this.#medium.events.push(...events)
  }

  async flush(): Promise<void> {
    this.#assertOpen('flush')
    this.#medium.failBarrierOrResolve()
  }

  async close(): Promise<void> {
    this.#closed = true
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new SessionHandleClosedError(this.id, operation)
  }
}

/** The one kind of request these specs emit, with a fresh command id so a repeat is never accidental. */
function admission(commandId: string, value = contract()): EmitInput {
  return {
    commandId,
    protocol: TASK_PROTOCOL,
    version: TASK_VERSION,
    kind: TASK_KINDS.admitted,
    subject: TASK_ID,
    payload: { contract: value },
  }
}

/** A run start: the one fact that legally follows an admission for the same subject. */
function started(commandId: string): EmitInput {
  return {
    commandId,
    protocol: TASK_PROTOCOL,
    version: TASK_VERSION,
    kind: TASK_KINDS.runStarted,
    subject: TASK_ID,
    payload: { runId: RUN_ID, revision: REVISION },
  }
}

function optionsFor(medium: FailingBarrierPersistence, controlId: string): ControlStoreOptions {
  return { persistence: medium, controlId, registry: taskRegistry(), subjects: SUBJECTS }
}

describe('a control store whose durability barrier fails', () => {
  it('refuses the record and leaves a state a successor agrees with', async () => {
    const medium = new FailingBarrierPersistence(new Context(), 1)
    const store = await ControlSessionStore.open(optionsFor(medium, 'barrier'))

    // `flush` rejects, so the call must not resolve: `asyncRefusalOf` throws if the step succeeds.
    const first = admission('cmd-barrier')
    const refusal = await asyncRefusalOf(() => store.emit(first))
    expect(refusal.code).toBe<RefusalCode>('write-not-durable')
    expect(refusal.detail).toContain('durability barrier failed')

    // The medium accepted the batch before its barrier failed, so the fact is visible and the
    // refusal must not have discarded it: exactly one record exists, and the store reports it.
    expect(medium.events).toHaveLength(1)
    expect(store.load().entries()).toHaveLength(1)
    const recorded = store.load().entries()[0]
    expect(recorded?.seq).toBe(0)

    // Re-delivering the command returns the *recorded* fact — not a new one, and not a refusal for
    // a fact the store itself refused to acknowledge. The regained reply is the same fact.
    const recovered = await store.emit(first)
    expect(recovered.seq).toBe(0)
    expect(recovered.digest).toBe(recorded?.digest)
    expect(medium.events).toHaveLength(1)
    expect(store.load().entries()).toHaveLength(1)

    // The refusal left no phantom sequence either: the next record continues the medium's own
    // cursor, and this time the barrier resolves. A store that had rolled its cursor *back* would
    // have re-used seq 0 and been refused by the medium's contiguity rule.
    const admitted = await store.emit(started('cmd-after'))
    expect(admitted.seq).toBe(1)
    expect(medium.events.map(event => Number(event.seq))).toEqual([0, 1])
    await store.close()

    // A successor over the same medium adopts both facts in order: nothing was lost and nothing
    // was invented by the recovery.
    const successor = await ControlSessionStore.open(optionsFor(medium, 'barrier'))
    expect(successor.load().entries().map(entry => entry.seq)).toEqual([0, 1])
    const carried = medium.events[0]?.data as ControlEventData
    expect(carried.payload.digest).toBe(recovered.digest)
    await successor.close()
  })

  it('never reports success while the barrier keeps failing', async () => {
    const medium = new FailingBarrierPersistence(new Context(), Number.POSITIVE_INFINITY)
    const store = await ControlSessionStore.open(optionsFor(medium, 'never-durable'))

    for (const request of [admission('cmd-a'), started('cmd-b')]) {
      const refusal = await asyncRefusalOf(() => store.emit(request))
      expect(`${request.commandId}: ${refusal.code}`).toBe(`${request.commandId}: write-not-durable`)
    }

    // Each accepted batch stayed visible, so the store reports exactly the medium's two facts:
    // neither one (which would deny what the medium holds) nor three.
    expect(medium.events.map(event => Number(event.seq))).toEqual([0, 1])
    expect(store.load().entries()).toHaveLength(2)

    // And a re-delivery still resolves to its own recorded fact without appending a third.
    expect((await store.emit(admission('cmd-a'))).seq).toBe(0)
    expect(medium.events).toHaveLength(2)
    await store.close()
  })
})

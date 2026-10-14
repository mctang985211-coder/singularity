/** Submission visibility is separate from the medium's accepted, not yet durable prefix. */

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

import { type EmitInput, type TaskState } from '../src/index.ts'
import { ControlSessionStore, type ControlStoreOptions } from '../src/control/session-store.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION } from '../src/task/protocol.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { REVISION, RUN_ID, SUBJECTS, TASK_ID, contract, taskRegistry } from './task-fixtures.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** Only a successful flush copies visible records to the prefix that survives a crash. */
class BarrierPersistence extends SessionPersistence {
  readonly events: SessionEvent[] = []
  readonly durable: SessionEvent[] = []
  barrierFailures = 0
  flushCalls = 0
  closeCalls = 0
  #header: SessionHeader | undefined
  #pause:
    | { operation: 'append' | 'flush'; entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined

  pauseNext(operation: 'append' | 'flush'): { entered: Promise<void>; release: () => void } {
    const entered = deferred()
    const released = deferred()
    this.#pause = { operation, entered, released }
    return { entered: entered.promise, release: released.resolve }
  }

  async delay(operation: 'append' | 'flush'): Promise<void> {
    const pause = this.#pause
    if (pause?.operation !== operation) return
    this.#pause = undefined
    pause.entered.resolve()
    await pause.released.promise
  }

  crash(): void {
    this.events.splice(0, this.events.length, ...structuredClone(this.durable))
  }

  override async create(header: SessionHeader): Promise<SessionHandle> {
    if (this.#header !== undefined) throw new Error(`session ${this.#header.id} already exists`)
    this.#header = header
    return new FakeHandle(this, header, 'write')
  }

  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const header = this.#header
    if (header === undefined || header.id !== id) throw new SessionPersistenceNotFoundError(id)
    return new FakeHandle(this, header, access)
  }

  override async flush(): Promise<void> {
    this.flushCalls += 1
    await this.delay('flush')
    if (this.barrierFailures > 0) {
      this.barrierFailures -= 1
      throw new Error('the medium accepted the batch but its durability barrier failed')
    }
    this.durable.splice(0, this.durable.length, ...structuredClone(this.events))
  }

  override async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const header = this.#header
    if (header === undefined || header.id !== id) return undefined
    return this.#snapshot(header)
  }

  override async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return this.#header === undefined ? [] : [this.#snapshot(this.#header)]
  }

  #snapshot(header: SessionHeader): SessionPersistenceSnapshot {
    return { header, revision: SessionPersistenceRevision(`fake:${header.id}:${this.events.length}`), eventCount: this.events.length,
    }
  }
}

class FakeHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)
  readonly header: SessionHeader
  readonly access: SessionAccess
  readonly #medium: BarrierPersistence
  #closed = false

  constructor(medium: BarrierPersistence, header: SessionHeader, access: SessionAccess) {
    this.#medium = medium
    this.header = header
    this.access = access
  }

  get id(): SessionId { return this.header.id }

  async read(offset = 0, length?: number): Promise<SessionHandleReadResult> {
    this.#assertOpen('read')
    const { events } = this.#medium
    return { eventState: 'detached', events: structuredClone(events.slice(offset, length === undefined ? events.length : offset + length)),
    }
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    await this.#medium.delay('append')
    this.#assertOpen('append')
    assertContiguous(this.id, events, this.#medium.events.length)
    this.#medium.events.push(...structuredClone(events))
  }

  async flush(): Promise<void> {
    this.#assertOpen('flush')
    await this.#medium.flush()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#medium.closeCalls += 1
    try {
      if (this.access === 'write') await this.#medium.flush()
    } finally {
      this.#closed = true
    }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close() }

  #assertOpen(operation: string): void {
    if (this.#closed) throw new SessionHandleClosedError(this.id, operation)
  }
}

function admission(commandId: string): EmitInput {
  return { commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.admitted, subject: TASK_ID, payload: { contract: contract() },
  }
}

function started(commandId: string): EmitInput {
  return { commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.runStarted, subject: TASK_ID, payload: { purpose: 'solve', runId: RUN_ID, revision: REVISION },
  }
}

/**
 * A fact the task protocol accepts with no prior fact. This spec is about the storage boundary, so
 */
function assignment(commandId: string): EmitInput {
  return { commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.assigned, subject: TASK_ID, payload: { agentId: 'agent-1', agentIdentity: 'runtime-1' },
  }
}

function optionsFor(medium: BarrierPersistence, controlId: string): ControlStoreOptions {
  return { persistence: medium, controlId, registry: taskRegistry(), subjects: SUBJECTS }
}

describe('the control submission boundary', () => {
  it.each(['append', 'flush'] as const)('keeps the committed cut while %s is pending', async (operation) => {
    const medium = new BarrierPersistence(new Context())
    const store = await ControlSessionStore.open(optionsFor(medium, `pending-${operation}`))
    const admitted = await store.emit(admission('cmd-admit'))
    const pause = medium.pauseNext(operation)
    const pending = store.emit(assignment('cmd-start'))
    await pause.entered
    try {
      // One read of the cut and one of the prefix that survives a crash: the submission in flight
      // is in neither, whatever the operation it is waiting on.
      expect(store.load().entries().map((entry) => entry.digest),
      ).toEqual([admitted.digest])
      expect(medium.durable).toHaveLength(1)
    } finally {
      pause.release()
      await pending
      await store.close()
    }
    expect(store.load().entries()).toHaveLength(2)
    expect(medium.durable).toHaveLength(2)
  })

  it('never acknowledges an uncertain command while the barrier keeps failing', async () => {
    const medium = new BarrierPersistence(new Context())
    const store = await ControlSessionStore.open(optionsFor(medium, 'never-durable'))
    medium.barrierFailures = Number.POSITIVE_INFINITY
    const request = admission('cmd-a')
    expect((await asyncRefusalOf(() => store.emit(request))).code).toBe('write-not-durable')
    // No acknowledgement means no half-effect either: nothing in the cut a caller reads, nothing in
    // the prefix a crash would keep.
    expect(store.load().entries()).toHaveLength(0)
    expect(medium.durable).toHaveLength(0)
    // Retrying the same command is not a way to turn the uncertainty into an acknowledgement, ...
    expect((await asyncRefusalOf(() => store.emit(request))).code).toBe('write-not-durable')
    await expect(store.close()).rejects.toThrow('durability barrier failed')
    // ... and neither is asking a successor process to adopt the log.
    expect((await asyncRefusalOf(() => ControlSessionStore.open(optionsFor(medium, 'never-durable')))).code).toBe('write-not-durable',
    )
  })

  it('recovers the uncertain result only after a successor confirms durability', async () => {
    const medium = new BarrierPersistence(new Context())
    const opts = optionsFor(medium, 'confirmed-recovery')
    const store = await ControlSessionStore.open(opts)
    medium.barrierFailures = 1
    const request = admission('cmd-barrier')
    expect((await asyncRefusalOf(() => store.emit(request))).code).toBe('write-not-durable')
    // A healthy medium does not undo the failed writer's uncertainty; reacquire and barrier first.
    expect((await asyncRefusalOf(() => store.emit(request))).code).toBe('write-not-durable')
    await store.close()
    expect(medium.durable).toHaveLength(1)
    const successor = await ControlSessionStore.open(opts)
    const recovered = await successor.emit(request)
    // The successor returns the fact the log holds, under the identity it already has, and the
    // command after it takes the next sequence number - the refused attempt reserved nothing.
    expect(recovered.digest).toBe(successor.load().entries()[0]?.digest)
    expect((await successor.emit(assignment('cmd-after'))).seq).toBe(1)
    await successor.close()
  })

  it('does not invent a result when a crash removes the unconfirmed prefix', async () => {
    const medium = new BarrierPersistence(new Context())
    const opts = optionsFor(medium, 'crashed-prefix')
    const store = await ControlSessionStore.open(opts)
    medium.barrierFailures = 1
    const request = admission('cmd-lost')
    expect((await asyncRefusalOf(() => store.emit(request))).code).toBe('write-not-durable')
    medium.crash()
    // Simulate the process dying before graceful teardown; release the now-empty test handle.
    await store.close()
    const successor = await ControlSessionStore.open(opts)
    // The refused command left nothing behind, so the retry is not a replay of a fact the log
    // already has: it takes the first sequence number, as if the lost attempt never happened.
    expect(successor.load().entries()).toHaveLength(0)
    const retried = await successor.emit(request)
    expect(retried.seq).toBe(0)
    await successor.close()
  })

  it('offers no write capability or shared mutable state through a read', async () => {
    const medium = new BarrierPersistence(new Context())
    const store = await ControlSessionStore.open(optionsFor(medium, 'read-only'))
    const result = await store.emit(admission('cmd-admit'))
    const original = structuredClone(result)
    const view = store.load()
    expect('emit' in view).toBe(false)
    const entries = view.entries()
    const filtered = view.entriesOf(TASK_PROTOCOL, TASK_VERSION)
    const state = view.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID)!
    Reflect.set(result, 'digest', 'forged')
    Reflect.set((result.payload as { contract: { goal: string } }).contract, 'goal', 'forged')
    Reflect.set(entries[0]!, 'commandId', 'forged')
    Reflect.set((filtered[0]!.payload as { contract: { goal: string } }).contract, 'goal', 'forged')
    Reflect.deleteProperty(entries, '0')
    Reflect.set(state, 'taskId', 'forged')
    Reflect.set(state.contract!, 'goal', 'forged')
    Reflect.set(state.contract!.criteria[0]!, 'statement', 'forged')
    Reflect.set(state.runs, 'injected', { status: 'verified' })
    // Writes through a read reach nothing: a later cut still reports the one recorded fact, and the
    // state it projects is detached at every depth the forging above touched.
    expect(store.load().entries()).toEqual([original])
    const current = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID)!
    expect([current.taskId, current.contract, current.runs]).toEqual([TASK_ID, contract(), {}])
    await store.emit(assignment('cmd-start'))
    // The later read is a *new* snapshot of the new committed cut, not a view that the values
    // forged above leaked into.
    expect(store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID)?.responsibility?.agentId).toBe('agent-1',
    )
    await store.close()
  })

  it('waits for an accepted submission before releasing the writer on close', async () => {
    const medium = new BarrierPersistence(new Context())
    const store = await ControlSessionStore.open(optionsFor(medium, 'close-order'))
    const pause = medium.pauseNext('append')
    const pending = store.emit(admission('cmd-before-close'))
    await pause.entered
    const closing = store.close()
    try {
      // Close waits for the accepted submission: the medium is still open and nothing is released.
      expect(medium.closeCalls).toBe(0)
    } finally {
      pause.release()
      await Promise.allSettled([pending, closing])
    }
    await expect(pending).resolves.toMatchObject({ seq: 0 })
    await closing
    expect(medium.durable).toHaveLength(1)
    expect((await asyncRefusalOf(() => store.emit(started('cmd-after-close')))).code).toBe('write-not-durable')
  })
})

/** The sessionPersistence-backed store skeleton every Singularity event store reuses. @module @dangosys/dsh-singularity-task/service/store */

import type { Context, Events } from '@deepseek-ai/cordis'
import type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { definedKeys } from '../contract.ts'

/** Drop `undefined`-valued keys so an event can enter the session log, which accepts only lossless JSON and rejects `undefined` outright. */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => compact(item)) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const source = value as Record<string, unknown>
  const target: Record<string, unknown> = {}
  for (const key of definedKeys(source)) target[key] = compact(source[key])
  return target as T
}

/** The reducer one store set replays: a private snapshot, one event at a time, read detached. */
export interface EventStoreState<Event, Snapshot> {
  clone(): this
  apply(event: Event): void
  snapshot(): Snapshot
}

/** One open store: its identity, its reducer state, and the queues every caller of it shares. */
export interface StoreEntry<K extends SessionEventType, State> {
  readonly id: string
  readonly sessionId: SessionId
  state: State
  handle?: SessionHandle
  nextSeq: number
  ready: Promise<void>
  writes: Promise<void>
}

/** How a store opens: `create` refuses an existing stored session, `open` a missing one, `auto` takes whichever it finds. */
export type StoreOpenMode = 'create' | 'open' | 'auto'

/** Everything one store set needs: the log vocabulary, the reducer, the open policy and the refusals it answers with. */
export interface EventStoreConfig<
  K extends SessionEventType,
  Snapshot,
  State extends EventStoreState<SessionEventMap[K], Snapshot>,
> {
  /** Refusal prefix and identity namespace, e.g. `task`. */
  readonly namespace: string
  /** The SessionEventMap key these stores append and replay. */
  readonly eventType: K
  /** The cordis event broadcast with the fresh snapshot after every commit. */
  readonly changeEvent: keyof Events & string
  /** Builds the reducer state for one store id; a state without one (the graph registry) ignores the argument. */
  readonly createState: (storeId: string) => State
  /** The store id {@link EventStoreSet.load} takes when a caller names none. */
  readonly defaultStoreId?: string
  /** Open a store nobody opened yet on first access instead of refusing it, and keep a failed open registered so `close()` reports it. */
  readonly onDemand?: boolean
}

/** The `sessionPersistence`-backed stores one service owns: allocation, replay, serial writes and disposal. */
export class EventStoreSet<
  K extends SessionEventType,
  Snapshot,
  State extends EventStoreState<SessionEventMap[K], Snapshot>,
> {
  private readonly stores = new Map<string, StoreEntry<K, State>>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: EventStoreConfig<K, Snapshot, State>,
  ) {}

  /** Whether disposal has started; every entry refuses new work from then on. */
  get closed(): boolean {
    return this.closing
  }

  /** The store behind `id`, which a caller must already have opened. */
  require(id: string): StoreEntry<K, State> {
    this.guard(id)
    return this.lookup(id)
  }

  /** The store behind `id` (or the configured default id), opened or created on first access. */
  load(id?: string): StoreEntry<K, State> {
    const target = id ?? this.defaultId()
    this.guard(target)
    const existing = this.stores.get(target)
    if (existing !== undefined) return existing
    const store = this.allocate(target)
    store.ready = this.beginOpen(store, 'auto')
    this.track(store)
    return store
  }

  /** Opens (or creates) the store behind `id` and answers its first snapshot; `create`/`open` are the explicit doors. */
  async open(id: string, mode: StoreOpenMode = 'auto'): Promise<Snapshot> {
    this.guard(id)
    const existing = this.stores.get(id)
    if (existing !== undefined) {
      if (mode === 'create') throw new Error(`${this.config.namespace}: store "${id}" is already open`)
      await existing.ready
      return existing.state.snapshot()
    }
    const store = this.allocate(id)
    store.ready = this.beginOpen(store, mode)
    this.track(store)
    try {
      await store.ready
    } catch (error) {
      if (this.config.onDemand !== true) this.stores.delete(id)
      throw error
    }
    return store.state.snapshot()
  }

  /** The store's current snapshot, waiting for its open but not for queued writes. */
  async snapshot(id: string): Promise<Snapshot> {
    const store = this.resolve(id)
    await store.ready
    return store.state.snapshot()
  }

  /** The snapshot every accepted write so far has left: open, then the shared write queue, then a detached read. */
  async settledSnapshot(id: string): Promise<Snapshot> {
    const store = this.resolve(id)
    await store.ready
    await store.writes
    return store.state.snapshot()
  }

  /** One batch, applied to a clone inside the store's write queue and appended only if the reducer accepted it. */
  async commit(id: string, events: readonly SessionEventMap[K][]): Promise<void> {
    if (events.length === 0) throw new Error(`${this.config.namespace}: cannot commit an empty event batch`)
    await this.serial(id, async state => {
      await this.append(id, state, events)
    })
  }

  /** Runs `work` inside the store's single write queue and answers what it returned. */
  async serial<T>(id: string, work: (state: State) => Promise<T> | T): Promise<T> {
    const store = this.resolve(id)
    const run = store.writes.then(async () => {
      await store.ready
      return await work(store.state)
    })
    store.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /** The append half of a commit, for work already inside the write queue: apply the batch, append, swap, broadcast. */
  async append(id: string, state: State, events: readonly SessionEventMap[K][]): Promise<void> {
    // Work already inside the write queue must still land: `close()` drains it, so only the lookup is checked here.
    const store = this.lookup(id)
    const next = state.clone()
    for (const event of events) next.apply(event)
    const records = events.map((event, index) => this.record(store.nextSeq + index, event))
    await store.handle!.append(records)
    store.state = next
    store.nextSeq += records.length
    this.broadcast(store)
  }

  /** Drains readiness and queued writes of every store, closes each handle, then reports the first failure. */
  async close(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled(
      [...this.stores.values()].map(async store => {
        await store.ready
        await store.writes
        await store.handle?.close()
      }),
    )
    this.stores.clear()
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
  }

  /** The guard every entry shares: disposal refuses all work, and a store id must be a plain file-name token. */
  private guard(id: string): void {
    if (this.closing) throw new Error(`${this.config.namespace}: service is closing`)
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${this.config.namespace}: invalid store id "${id}"`)
  }

  private defaultId(): string {
    const id = this.config.defaultStoreId
    if (id === undefined)
      throw new Error(`${this.config.namespace}: a store id is required when no default store id is set`)
    return id
  }

  private resolve(id: string): StoreEntry<K, State> {
    return this.config.onDemand === true ? this.load(id) : this.require(id)
  }

  private lookup(id: string): StoreEntry<K, State> {
    const store = this.stores.get(id)
    if (store === undefined) throw new Error(`${this.config.namespace}: store "${id}" is not open`)
    return store
  }

  private allocate(id: string): StoreEntry<K, State> {
    const store: StoreEntry<K, State> = {
      id,
      sessionId: makeSessionId(id),
      state: this.config.createState(id),
      nextSeq: 0,
      ready: Promise.resolve(),
      writes: Promise.resolve(),
    }
    this.stores.set(id, store)
    return store
  }

  /** A default store opens before any caller exists: its refusal must stay observable to that caller, never reach the process. */
  private track(store: StoreEntry<K, State>): void {
    store.ready.then(undefined, () => {})
  }

  private async beginOpen(store: StoreEntry<K, State>, mode: StoreOpenMode): Promise<void> {
    try {
      const listed = (await this.ctx.sessionPersistence.list()).filter(item => item.header.id === store.sessionId)
      if (mode === 'create' && listed.length > 0) {
        throw new Error(`${this.config.namespace}: store "${store.id}" already exists`)
      }
      if (mode === 'open' && listed.length === 0) {
        throw new Error(`${this.config.namespace}: store "${store.id}" does not exist`)
      }
      if (listed.length > 1) throw new Error(`${this.config.namespace}: duplicate store session "${store.id}"`)
      store.handle =
        listed.length === 0
          ? await this.ctx.sessionPersistence.create(this.header(store.sessionId))
          : await this.ctx.sessionPersistence.open(store.sessionId, 'write')
      const { events } = await store.handle.read()
      // A V3→V4 migration renames this store's unknown ignorable events to `plugin:<name>`; replay accepts both spellings.
      const migratedType = `plugin:${this.config.eventType}`
      for (const event of events) {
        if ((event.type !== this.config.eventType && event.type !== migratedType) || event.ignorable !== true) {
          throw new Error(`${this.config.namespace}: invalid persisted event at seq ${event.seq}`)
        }
        const next = store.state.clone()
        next.apply(event.data as SessionEventMap[K])
        store.state = next
        store.nextSeq = event.seq + 1
      }
      await store.handle.flush()
    } catch (error) {
      await store.handle?.close()
      throw error
    }
  }

  private record(seq: number, event: SessionEventMap[K]): SessionEvent<K> {
    return {
      type: this.config.eventType,
      seq: SessionSeq(seq),
      time: Date.now(),
      data: compact(event),
      ignorable: true,
    } as SessionEvent<K>
  }

  private broadcast(store: StoreEntry<K, State>): void {
    const emit = this.ctx.emit as (name: string, snapshot: Snapshot) => void
    emit(this.config.changeEvent, store.state.snapshot())
  }

  private header(id: SessionId): SessionHeader {
    return { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false }
  }
}

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EventStoreSet, type ReadOnlyStoreSnapshot } from '@dangosys/dsh-singularity-task'
import type { CanvasNode, LayoutConfig, LayoutEvent, LayoutSnapshot } from '../layout-types.ts'
import { LayoutState } from './layout-state.ts'

export class LayoutService extends Service {
  static inject = ['sessionPersistence']
  private readonly stores: EventStoreSet<'layout/event', LayoutSnapshot, LayoutState>
  private activeId?: string

  constructor(ctx: Context, config: LayoutConfig = {}) {
    super(ctx, 'layout')
    this.stores = new EventStoreSet<'layout/event', LayoutSnapshot, LayoutState>(ctx, {
      namespace: 'layout',
      eventType: 'layout/event',
      changeEvent: 'layout/change',
      createState: id => new LayoutState(id),
      defaultStoreId: config.storeId ?? 'layout-idle',
      onDemand: true,
    })
    this.stores.load()
    ctx.effect(() => () => this.stores.close(), 'layout:persistence')
  }

  async switchStore(id: string): Promise<LayoutSnapshot> {
    const snapshot = await this.stores.snapshot(id)
    this.activeId = id
    this.ctx.emit('layout/change', snapshot)
    return snapshot
  }

  clearActive(): void {
    if (this.stores.closed) throw new Error('layout: service is closing')
    this.activeId = undefined
  }

  async snapshot(): Promise<LayoutSnapshot> {
    return await this.stores.snapshot(this.activeIdOf())
  }

  async snapshotIn(id: string): Promise<LayoutSnapshot> {
    return await this.stores.snapshot(id)
  }

  /** The zero-write read door ({@link EventStoreSet.readOnlySnapshot}): a missing store answers `exists:false`, never a creation. */
  async snapshotReadOnlyIn(id: string): Promise<ReadOnlyStoreSnapshot<LayoutSnapshot>> {
    return await this.stores.readOnlySnapshot(id)
  }

  async set(sessionId: SessionId, node: CanvasNode): Promise<void> {
    await this.setIn(this.activeIdOf(), sessionId, node)
  }

  async setIn(id: string, sessionId: SessionId, node: CanvasNode): Promise<void> {
    await this.commitIn(id, [{ kind: 'node/set', sessionId, node }])
  }

  async commitIn(id: string, events: readonly LayoutEvent[]): Promise<void> {
    await this.stores.commit(id, events)
  }

  private activeIdOf(): string {
    if (this.activeId === undefined) throw new Error('layout: no graph selected')
    return this.activeId
  }
}

export default LayoutService

/**
 * Persist agent topology and canvas geometry for multiple Singularity graphs.
 * @module dsh-singularity-graph
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EventStoreSet } from '@dangosys/dsh-singularity-task'
import type { AgentNode, AgentStatus, GraphConfig, GraphEvent, GraphSnapshot } from './types.ts'
import { GraphState } from './service/state.ts'

export * from './types.ts'
export { GraphState } from './service/state.ts'
export * from './layout.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One agent-topology mutation in a per-graph store; the GraphEvent union that GraphState replays on load. */
    'graph/event': GraphEvent
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    graph: GraphService
  }
  interface Events {
    'graph/change'(snapshot: GraphSnapshot): void
  }
}

export class GraphService extends Service {
  static inject = ['sessionPersistence']
  private readonly stores: EventStoreSet<'graph/event', GraphSnapshot, GraphState>
  private activeId?: string

  constructor(ctx: Context, config: GraphConfig = {}) {
    super(ctx, 'graph')
    this.stores = new EventStoreSet<'graph/event', GraphSnapshot, GraphState>(ctx, {
      namespace: 'graph',
      eventType: 'graph/event',
      changeEvent: 'graph/change',
      createState: id => new GraphState(id),
      defaultStoreId: config.storeId ?? 'graph-idle',
      onDemand: true,
    })
    this.stores.load()
    ctx.effect(() => () => this.stores.close(), 'graph:persistence')
  }

  async switchStore(id: string): Promise<GraphSnapshot> {
    const snapshot = await this.stores.snapshot(id)
    this.activeId = id
    this.ctx.emit('graph/change', snapshot)
    return snapshot
  }

  clearActive(): void {
    if (this.stores.closed) throw new Error('graph: service is closing')
    this.activeId = undefined
  }

  async snapshot(): Promise<GraphSnapshot> {
    return await this.stores.snapshot(this.activeStoreId())
  }

  async snapshotIn(id: string): Promise<GraphSnapshot> {
    return await this.stores.snapshot(id)
  }

  async addAgent(agent: AgentNode, root = false): Promise<void> {
    await this.addAgentIn(this.activeStoreId(), agent, root)
  }

  async addAgentIn(storeId: string, agent: AgentNode, root = false): Promise<void> {
    await this.commitIn(storeId, [{ kind: 'agent/add', agent, ...(root ? { root: true } : {}) }])
  }

  async setStatusIn(storeId: string, agentId: SessionId, status: AgentStatus): Promise<void> {
    await this.commitIn(storeId, [{ kind: 'agent/status', agentId, status }])
  }

  async commitIn(storeId: string, events: readonly GraphEvent[]): Promise<void> {
    await this.stores.commit(storeId, events)
  }

  private activeStoreId(): string {
    if (this.activeId === undefined) throw new Error('graph: no graph selected')
    return this.activeId
  }
}

export default GraphService

import { a as LayoutConfig, c as NodeShape, i as DEFAULT_ROOT, n as LayoutService, o as LayoutEvent, r as CanvasNode, s as LayoutSnapshot, t as LayoutState } from "./layout-Ctr757BS.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { ReadOnlyStoreSnapshot } from "@dangosys/dsh-singularity-task";
import { SessionId } from "@deepseek-ai/dsh-session";

//#region src/types.d.ts
type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed';
type EdgeKind = 'spawn' | 'handoff';
interface AgentNode {
  readonly id: SessionId;
  readonly name: string;
  readonly status: AgentStatus;
  /** The one parent group this agent is a member of; a router's own group is routerFor. */
  readonly memberOf?: string;
  /** The group this agent leads as router. */
  readonly routerFor?: string;
}
interface GroupNode {
  readonly id: string;
  readonly routerId: SessionId;
  readonly transcriptId: SessionId;
  readonly memberIds: readonly SessionId[];
}
interface GraphEdge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly from: SessionId;
  readonly to: SessionId;
  readonly brief?: string;
}
interface GraphSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly roots: readonly SessionId[];
  readonly agents: readonly AgentNode[];
  readonly groups: readonly GroupNode[];
  readonly edges: readonly GraphEdge[];
}
type GraphEvent = {
  readonly kind: 'agent/add';
  readonly agent: AgentNode;
  readonly root?: true;
} | {
  readonly kind: 'agent/status';
  readonly agentId: SessionId;
  readonly status: AgentStatus;
} | {
  readonly kind: 'group/add';
  readonly group: GroupNode;
} | {
  readonly kind: 'member/add';
  readonly groupId: string;
  readonly agentId: SessionId;
} | {
  readonly kind: 'edge/add';
  readonly edge: GraphEdge;
};
interface GraphConfig {
  readonly storeId?: string;
}
//#endregion
//#region src/service/state.d.ts
declare class GraphState {
  private value;
  constructor(id: string, snapshot?: GraphSnapshot);
  clone(): GraphState;
  snapshot(): GraphSnapshot;
  apply(event: GraphEvent): void;
  private addAgent;
  private status;
  private addGroup;
  private addMember;
  private addEdge;
  private reaches;
  private agent;
  private group;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One agent-topology mutation in a per-graph store; the GraphEvent union that GraphState replays on load. */
    'graph/event': GraphEvent;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    graph: GraphService;
  }
  interface Events {
    'graph/change'(snapshot: GraphSnapshot): void;
  }
}
declare class GraphService extends Service {
  static inject: string[];
  private readonly stores;
  private activeId?;
  constructor(ctx: Context, config?: GraphConfig);
  switchStore(id: string): Promise<GraphSnapshot>;
  clearActive(): void;
  snapshot(): Promise<GraphSnapshot>;
  snapshotIn(id: string): Promise<GraphSnapshot>;
  /** The zero-write read door ({@link EventStoreSet.readOnlySnapshot}): a missing store answers `exists:false`, never a creation. */
  snapshotReadOnlyIn(id: string): Promise<ReadOnlyStoreSnapshot<GraphSnapshot>>;
  addAgent(agent: AgentNode, root?: boolean): Promise<void>;
  addAgentIn(storeId: string, agent: AgentNode, root?: boolean): Promise<void>;
  setStatusIn(storeId: string, agentId: SessionId, status: AgentStatus): Promise<void>;
  commitIn(storeId: string, events: readonly GraphEvent[]): Promise<void>;
  private activeStoreId;
}
//#endregion
export { AgentNode, AgentStatus, CanvasNode, DEFAULT_ROOT, EdgeKind, GraphConfig, GraphEdge, GraphEvent, GraphService, GraphService as default, GraphSnapshot, GraphState, GroupNode, LayoutConfig, LayoutEvent, LayoutService, LayoutSnapshot, LayoutState, NodeShape };
import { Context, Service } from "@deepseek-ai/cordis";
import { ReadOnlyStoreSnapshot } from "@dangosys/dsh-singularity-task";
import { SessionId } from "@deepseek-ai/dsh-session";

//#region src/layout-types.d.ts
type NodeShape = 'card' | 'circle' | 'diamond';
interface CanvasNode {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly shape: NodeShape;
}
interface LayoutSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly nodes: Readonly<Record<string, CanvasNode>>;
}
type LayoutEvent = {
  readonly kind: 'node/set';
  readonly sessionId: SessionId;
  readonly node: CanvasNode;
} | {
  readonly kind: 'node/remove';
  readonly sessionId: SessionId;
};
interface LayoutConfig {
  readonly storeId?: string;
}
declare const DEFAULT_ROOT: CanvasNode;
//#endregion
//#region src/service/layout.d.ts
declare class LayoutService extends Service {
  static inject: string[];
  private readonly stores;
  private activeId?;
  constructor(ctx: Context, config?: LayoutConfig);
  switchStore(id: string): Promise<LayoutSnapshot>;
  clearActive(): void;
  snapshot(): Promise<LayoutSnapshot>;
  snapshotIn(id: string): Promise<LayoutSnapshot>;
  /** The zero-write read door ({@link EventStoreSet.readOnlySnapshot}): a missing store answers `exists:false`, never a creation. */
  snapshotReadOnlyIn(id: string): Promise<ReadOnlyStoreSnapshot<LayoutSnapshot>>;
  set(sessionId: SessionId, node: CanvasNode): Promise<void>;
  setIn(id: string, sessionId: SessionId, node: CanvasNode): Promise<void>;
  commitIn(id: string, events: readonly LayoutEvent[]): Promise<void>;
  private activeIdOf;
}
//#endregion
//#region src/service/layout-state.d.ts
declare class LayoutState {
  private value;
  constructor(id: string, snapshot?: LayoutSnapshot);
  clone(): LayoutState;
  snapshot(): LayoutSnapshot;
  get(sessionId: SessionId): CanvasNode;
  apply(event: LayoutEvent): void;
}
//#endregion
//#region src/layout.d.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One canvas-geometry mutation in a per-graph layout store; the LayoutEvent union that LayoutState replays on load. */
    'layout/event': LayoutEvent;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    layout: LayoutService;
  }
  interface Events {
    'layout/change'(snapshot: LayoutSnapshot): void;
  }
}
//#endregion
export { LayoutConfig as a, NodeShape as c, DEFAULT_ROOT as i, LayoutService as n, LayoutEvent as o, CanvasNode as r, LayoutSnapshot as s, LayoutState as t };
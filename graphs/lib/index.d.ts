import { C as GraphProtocol, D as protocolOf, E as graphAccess, S as GraphAccess, T as assertCurrentGraph, _ as GraphsSnapshot, a as GraphRevisionWire, b as RsiStrategy, c as LegacyGraphViewWire, d as CreateGraphResult, f as GraphArchive, g as GraphsEvent, h as GraphRecord, i as GraphProgressWire, l as graphAccessWire, m as GraphPinsUpdate, n as GraphAccessWire, o as GraphViewWire, p as GraphModel, r as GraphEvaluationWire, s as LegacyCompletionWire, t as ApprovalSourceWire, u as CreateGraphRequest, v as RsiConfig, w as GraphSealedError, x as GRAPH_PROTOCOL_V2, y as RsiLaunch } from "./wire-C7optJbq.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { TaskSnapshot } from "@dangosys/dsh-singularity-task";
import * as _dangosys_dsh_singularity_graph0 from "@dangosys/dsh-singularity-graph";
import { GraphSnapshot, LayoutSnapshot } from "@dangosys/dsh-singularity-graph";
import { EnvRecord } from "@dangosys/dsh-env-builder";
import { AgentOptions } from "@dangosys/dsh-singularity-agent-runtime";

//#region src/read/legacy.d.ts

/** What a read-only door answers: a missing store reports `exists:false` instead of being created. */
type ReadOnlyDoorAnswer<TSnapshot> = {
  readonly exists: false;
} | {
  readonly exists: true;
  readonly snapshot: TSnapshot;
};
/** The only read door this reader uses: the store set's own zero-write snapshot. */
interface ReadOnlySnapshotDoor<TSnapshot> {
  snapshotReadOnly(id: string): Promise<ReadOnlyDoorAnswer<TSnapshot>>;
}
/** The graph and layout services' door: the same zero-write snapshot, named by those two services' own method. */
interface ReadOnlySnapshotDoorIn<TSnapshot> {
  snapshotReadOnlyIn(id: string): Promise<ReadOnlyDoorAnswer<TSnapshot>>;
}
/** The legacy evolution facts one graph holds, as the old ledger projects them. */
interface LegacyEvolutionFacts {
  readonly proposals: readonly unknown[];
  readonly experiments: readonly unknown[];
}
/** Where one legacy graph's records are read; every door is read-only and nothing here writes. */
interface LegacyReadDeps {
  readonly graph: ReadOnlySnapshotDoorIn<GraphSnapshot>;
  readonly layout: ReadOnlySnapshotDoorIn<LayoutSnapshot>;
  readonly task: ReadOnlySnapshotDoor<TaskSnapshot>;
  /** The old evolution ledger's own reader, projected verbatim; absent when this deployment keeps none. */
  readonly legacyEvolution?: (graphKey: string) => Promise<LegacyEvolutionFacts>;
  /** The old completion formats (note prefix / fenced JSON), read for history display only. */
  readonly legacyCompletions?: (graphKey: string) => Promise<readonly LegacyCompletionWire[]>;
}
/**
 * One legacy graph's whole history: its registry record, the three stores it may
 * hold, and the old evolution and completion records, each kept verbatim. The
 * stores are read in a fixed order (topology, layout, tasks) through read-only
 * doors, so a read creates nothing and a missing store is reported rather than
 * treated as a failure. `writable` is `false` by construction: no caller can
 * mistake this projection for a write path.
 */
declare function readLegacyGraph(deps: LegacyReadDeps, graph: GraphRecord): Promise<LegacyGraphViewWire>;
//#endregion
//#region src/service/state.d.ts
/** Whether an existing workspace can be bound by a new graph: no graph and no sessions. */
declare function isReusableEnv(env: Pick<EnvRecord, 'id' | 'components' | 'sessionIds'>, boundEnvIds: ReadonlySet<string>): boolean;
declare class GraphsState {
  private value;
  constructor(snapshot?: GraphsSnapshot);
  clone(): GraphsState;
  snapshot(): GraphsSnapshot;
  apply(event: GraphsEvent): void;
  get(id: string): GraphRecord;
  selected(): GraphRecord | undefined;
  boundEnvIds(): Set<string>;
}
//#endregion
//#region src/model.d.ts
/** The `ctx.llm` reads model validation uses: registered routes and the models one route serves. */
interface ModelCatalogReader {
  listProviders(): readonly {
    id: string;
    name: string;
  }[];
  listModels(provider: string): Promise<readonly {
    id: string;
    name: string;
  }[]>;
}
/** Agent options for the model a graph pins, or `undefined` when it follows the deployment default. */
declare function graphAgentOptions(graph: Pick<GraphRecord, 'model'>): AgentOptions | undefined;
/** Refuse a model whose provider route is not registered, or whose route does not advertise that model. */
declare function assertModelServiceable(llm: ModelCatalogReader, model: GraphModel): Promise<void>;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One graph-registry mutation in the graphs-registry store; the GraphsEvent union that GraphsState replays on load. */
    'graphs/event': GraphsEvent;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    graphs: GraphsService;
  }
  interface Events {
    'graphs/change'(snapshot: GraphsSnapshot): void;
    'graphs/selected'(graph: GraphRecord): void;
  }
}
/** The registry's own answer when no graph publishes a session; distinguishable by code from a failed read. */
declare const SESSION_NOT_IN_GRAPH = "graph-session-not-found";
/** See {@link SESSION_NOT_IN_GRAPH}: the one error that means "no graph holds this session". */
declare class SessionNotInGraphError extends Error {
  readonly code = "graph-session-not-found";
  constructor(sessionId: SessionId | string);
}
declare class GraphsService extends Service {
  static inject: string[];
  private readonly stores;
  private readonly storeId;
  private readonly ready;
  private transitions;
  constructor(ctx: Context);
  snapshot(): Promise<GraphsSnapshot>;
  /** The selected graph; throws when no graph is selected. */
  current(): Promise<GraphRecord>;
  get(id: string): Promise<GraphRecord>;
  /**
   * One graph's metadata, topology and layout. Every store is read through the
   * zero-write door: a graph whose store this process never opened answers
   * `null` rather than being created by the read, which is what keeps a sealed
   * legacy graph readable without a single write.
   */
  view(id: string): Promise<{
    meta: GraphRecord;
    access: GraphAccessWire;
    graph: _dangosys_dsh_singularity_graph0.GraphSnapshot | null;
    layout: _dangosys_dsh_singularity_graph0.LayoutSnapshot | null;
  }>;
  list(): Promise<readonly GraphRecord[]>;
  select(id: string): Promise<GraphRecord>;
  create(request: CreateGraphRequest): Promise<CreateGraphResult>;
  private resolveEnv;
  private assertReusable;
  private workspaceTaken;
  markReady(id: string): Promise<GraphRecord>;
  /** Pin, replace, or clear (null) one graph's model. Only later spawns read it; existing sessions keep theirs. */
  setModel(id: string, model: GraphModel | null): Promise<GraphRecord>;
  /**
   * Set, replace, or clear (null) one graph's RSI config.
   * A configured driver reconciles the same frozen root task; a new objective requires a new graph.
   */
  setRsi(id: string, rsi: RsiConfig | null): Promise<GraphRecord>;
  /** Validate all supplied settings before committing one event batch in the graph transition queue. */
  setPins(id: string, update: GraphPinsUpdate): Promise<GraphRecord>;
  /** Refuse a pin the current provider registry cannot serve; the message names the offending field. */
  private assertModel;
  /** Which graph publishes a session, read through the zero-write door: a read never opens a store as a side effect. */
  graphForSession(sessionId: SessionId): Promise<GraphRecord>;
  remove(id: string): Promise<void>;
  /** Resolved lazily: task-runtime injects graphs, so a hard inject here would deadlock the plugin loader. */
  private taskRuntime;
  /**
   * The one write gate: every entry that would change one graph's settings,
   * readiness or selection resolves its record through here first, and a sealed
   * legacy graph answers {@link GraphSealedError} before anything is committed.
   */
  private writableGraph;
  /**
   * The selected graph becomes this process's running environment. A sealed
   * legacy graph is history: it is never activated, so selecting it — or booting
   * with it selected — writes nothing, adopts nothing and publishes nothing.
   */
  private enterSelected;
  /** One graph becomes this process's running environment: recovery barrier, then store and env switch (A2 §E). */
  private activate;
  private commit;
  private transition;
  /** The live registry reducer; every read goes through `ready` so a failed constructor open stays caller-visible. */
  private state;
}
//#endregion
export { ApprovalSourceWire, CreateGraphRequest, CreateGraphResult, GRAPH_PROTOCOL_V2, GraphAccess, GraphAccessWire, GraphArchive, GraphEvaluationWire, GraphModel, GraphPinsUpdate, GraphProgressWire, GraphProtocol, GraphRecord, GraphRevisionWire, GraphSealedError, GraphViewWire, GraphsEvent, GraphsService, GraphsService as default, GraphsSnapshot, GraphsState, LegacyCompletionWire, type LegacyEvolutionFacts, LegacyGraphViewWire, type LegacyReadDeps, type ModelCatalogReader, type ReadOnlyDoorAnswer, type ReadOnlySnapshotDoor, type ReadOnlySnapshotDoorIn, RsiConfig, RsiLaunch, RsiStrategy, SESSION_NOT_IN_GRAPH, SessionNotInGraphError, assertCurrentGraph, assertModelServiceable, graphAccess, graphAccessWire, graphAgentOptions, isReusableEnv, protocolOf, readLegacyGraph };
import { _ as protocolOf, a as GraphPinsUpdate, c as GraphsSnapshot, d as GRAPH_PROTOCOL_V2, f as GraphAccess, g as graphAccess, h as assertCurrentGraph, i as GraphModel, l as RsiConfig, m as GraphSealedError, n as CreateGraphResult, o as GraphRecord, p as GraphProtocol, r as GraphArchive, s as GraphsEvent, t as CreateGraphRequest, u as RsiLaunch } from "./types-HAFfajhv.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import * as _dangosys_dsh_singularity_graph0 from "@dangosys/dsh-singularity-graph";
import { EnvRecord } from "@dangosys/dsh-env-builder";
import { AgentOptions } from "@dangosys/dsh-singularity-agent-runtime";

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
  view(id: string): Promise<{
    meta: GraphRecord;
    graph: _dangosys_dsh_singularity_graph0.GraphSnapshot;
    layout: _dangosys_dsh_singularity_graph0.LayoutSnapshot;
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
  graphForSession(sessionId: SessionId): Promise<GraphRecord>;
  remove(id: string): Promise<void>;
  /** Resolved lazily: task-runtime injects graphs, so a hard inject here would deadlock the plugin loader. */
  private taskRuntime;
  /** One graph becomes this process's running environment: recovery barrier, then store and env switch (A2 §E). */
  private activate;
  private commit;
  private transition;
  /** The live registry reducer; every read goes through `ready` so a failed constructor open stays caller-visible. */
  private state;
}
//#endregion
export { CreateGraphRequest, CreateGraphResult, GRAPH_PROTOCOL_V2, GraphAccess, GraphArchive, GraphModel, GraphPinsUpdate, GraphProtocol, GraphRecord, GraphSealedError, GraphsEvent, GraphsService, GraphsService as default, GraphsSnapshot, GraphsState, type ModelCatalogReader, RsiConfig, RsiLaunch, SESSION_NOT_IN_GRAPH, SessionNotInGraphError, assertCurrentGraph, assertModelServiceable, graphAccess, graphAgentOptions, isReusableEnv, protocolOf };
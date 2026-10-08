import { SessionId } from "@deepseek-ai/dsh-session";
import { TaskSnapshot } from "@dangosys/dsh-singularity-task";
import { GraphSnapshot, LayoutSnapshot } from "@dangosys/dsh-singularity-graph";

//#region src/protocol.d.ts
/** Graph protocol marker and access mode: the single source that tells a current graph from a sealed legacy one. */
/** The literal identity of the current protocol; a graph's protocol is fixed at creation and never rewritten. */
declare const GRAPH_PROTOCOL_V2: "singularity/graph@2";
interface GraphProtocol {
  readonly id: typeof GRAPH_PROTOCOL_V2;
  readonly version: 2;
  /** Stamping time (creation time); a graph never rewrites its own protocol. */
  readonly since: number;
}
type GraphAccess = {
  readonly mode: 'current';
  readonly protocol: GraphProtocol;
} | {
  readonly mode: 'legacy-readonly';
  readonly reason: string;
};
/** The protocol marker a record carries; absent means the graph predates marking. */
declare function protocolOf(graph: {
  readonly protocol?: GraphProtocol;
}): GraphProtocol | undefined;
/** A marked graph is current, an unmarked one is sealed legacy read-only history; there is no third state. */
declare function graphAccess(graph: {
  readonly id: string;
  readonly protocol?: GraphProtocol;
}): GraphAccess;
/** The error every write path on a sealed legacy graph answers with. */
declare class GraphSealedError extends Error {
  readonly code = "graph-sealed";
  readonly graphId: string;
  constructor(graphId: string);
}
/** The marker a current graph carries; throws {@link GraphSealedError} on a sealed legacy graph. */
declare function assertCurrentGraph(graph: {
  readonly id: string;
  readonly protocol?: GraphProtocol;
}): GraphProtocol;
//#endregion
//#region src/types.d.ts
/** A model pinned on a graph; absent means the graph follows the deployment default selection. */
interface GraphModel {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}
/** Graph settings to change together; omitted fields stay as-is and null clears a setting. */
interface GraphPinsUpdate {
  readonly model?: GraphModel | null;
  readonly rsi?: RsiConfig | null;
}
/** The autonomous-improvement settings one graph runs under; absent means the graph runs no RSI loop. */
interface RsiConfig {
  /** Objective text recorded for launch/UI; changing it never rewrites an existing frozen root task. */
  readonly task: string;
  /** Natural-language outcome and resource measures the agent investigates and makes concrete. */
  readonly metrics?: readonly string[];
  /** Total improvement iterations the graph should run (integer >= 1). */
  readonly iterationRounds: number;
  /** true: HITL approval gates queue for a human; false: the platform auto-resolves them. */
  readonly humanReview: boolean;
  /** Objective epoch (integer >= 1, default 1): bumping it is the one explicit way to start the search over. */
  readonly epoch?: number;
}
interface GraphRecord {
  readonly id: string;
  readonly name: string;
  readonly envId: string;
  readonly rootSessionId: SessionId;
  readonly graphStoreId: string;
  readonly layoutStoreId: string;
  readonly createdAt: number;
  readonly ready: boolean;
  /** Protocol marker fixed at creation; absent means a sealed legacy graph (read-only history). */
  readonly protocol?: GraphProtocol;
  /** Pinned model applied to agents this graph spawns after the pin; absent = deployment default. */
  readonly model?: GraphModel;
  /** RSI settings this graph runs under; absent = no autonomous improvement loop. */
  readonly rsi?: RsiConfig;
}
interface GraphArchive {
  readonly graph: GraphRecord;
  readonly agentIds: readonly SessionId[];
  readonly archivedAt: number;
}
interface GraphsSnapshot {
  readonly version: 1;
  readonly graphs: readonly GraphRecord[];
  readonly selectedId?: string;
  readonly archives: readonly GraphArchive[];
}
type GraphsEvent = {
  readonly kind: 'graph/add';
  readonly graph: GraphRecord;
} | {
  readonly kind: 'graph/select';
  readonly id: string;
} | {
  readonly kind: 'graph/ready';
  readonly id: string;
} | {
  readonly kind: 'graph/model';
  readonly id: string;
  readonly model: GraphModel | null;
}
/** Sets or clears (`null`) the RSI config without replacing the graph's frozen root task. */ | {
  readonly kind: 'graph/rsi';
  readonly id: string;
  readonly rsi: RsiConfig | null;
} | {
  readonly kind: 'graph/remove';
  readonly id: string;
  readonly archive: GraphArchive;
};
/** Launch needs only a goal; iteration controls have platform defaults. */
type RsiLaunch = Pick<RsiConfig, 'task' | 'metrics'> & Partial<Pick<RsiConfig, 'iterationRounds' | 'humanReview' | 'epoch'>>;
interface CreateGraphRequest {
  readonly name?: string;
  readonly createEnv?: true;
  readonly envId?: string;
  /** Planned github owner/repo refs when createEnv is set. Cloned later by env agents. */
  readonly repos?: readonly string[];
  /** Named workspace: reuse the environment labeled with it, or create and label a new one. */
  readonly workspace?: string;
  /** With createEnv, skip reuse matching and always create a fresh environment. */
  readonly fresh?: boolean;
  /** Model pinned for the new graph; absent follows the deployment default selection. */
  readonly model?: GraphModel;
  /** RSI settings to stamp on the new graph; absent leaves it without an improvement loop. */
  readonly rsi?: RsiLaunch;
}
interface CreateGraphResult {
  readonly graph: GraphRecord;
  /** True when the graph bound a pre-existing environment instead of a newly created one. */
  readonly reused: boolean;
}
//#endregion
//#region src/wire.d.ts
type GraphAccessWire = {
  readonly mode: 'current' | 'legacy-readonly';
  readonly reason?: string;
};
/** One graph record's access mode, as every wire and route reports it. */
declare function graphAccessWire(graph: {
  readonly id: string;
  readonly protocol?: GraphProtocol;
}): GraphAccessWire;
interface GraphProgressWire {
  /** 1-based round currently in flight; 0 when nothing is scheduled. */
  readonly round: number;
  readonly rounds: number;
  readonly phase: 'idle' | 'running' | 'awaiting_approval' | 'stopped' | 'finished';
  readonly note?: string;
}
interface GraphRevisionWire {
  readonly revisionId: string | null;
  readonly manifestDigest: string | null;
  readonly origin: 'graph-initial' | 'draft' | 'published' | 'rolled-back' | 'unknown';
  readonly publishedAt: string | null;
}
interface ApprovalSourceWire {
  readonly kind: 'human' | 'platform_policy';
  readonly actor?: string;
  readonly policy?: string;
}
interface GraphEvaluationWire {
  readonly state: 'idle' | 'screening' | 'evaluating' | 'decided' | 'published' | 'rejected' | 'inconclusive';
  readonly reportRef: string | null;
  readonly candidateRef: string | null;
  readonly decidedAt: string | null;
  readonly decision?: {
    readonly kind: 'promote' | 'retain' | 'trial' | 'discard' | 'rollback';
    readonly source: ApprovalSourceWire;
    readonly by?: string;
    readonly at: string;
  };
}
/** The complete read facts of one graph; Web and tools read exactly this one projection. */
interface GraphViewWire {
  readonly formatVersion: 2;
  readonly graph: {
    readonly id: string;
    readonly name: string;
    readonly createdAt: number;
  };
  readonly access: GraphAccessWire;
  readonly revision: GraphRevisionWire | null;
  readonly evaluation: GraphEvaluationWire | null;
  readonly progress: GraphProgressWire;
  /** The fact fingerprint of this view; caching and change detection judge by it alone. */
  readonly generation: number;
}
/** One legacy completion-format row (note prefix / fenced JSON), kept verbatim and marked by format. */
interface LegacyCompletionWire {
  readonly format: 'legacy-v1';
  readonly sessionId: string;
  readonly taskId: string;
  readonly note: string;
  readonly recordedAt: string;
}
/** Legacy graph history: a verbatim projection of legacy records, read-only and forever writable:false. */
interface LegacyGraphViewWire {
  readonly formatVersion: 'legacy-v1';
  readonly writable: false;
  readonly graph: GraphRecord;
  readonly access: GraphAccessWire;
  readonly topology: GraphSnapshot | null;
  readonly layout: LayoutSnapshot | null;
  readonly tasks: TaskSnapshot | null;
  readonly proposals: readonly unknown[];
  readonly experiments: readonly unknown[];
  readonly completions: readonly LegacyCompletionWire[];
  /** Whether each store a read drew on exists, so the read's sources can be audited. */
  readonly sources: readonly {
    readonly id: string;
    readonly kind: 'topology' | 'layout' | 'tasks';
    readonly exists: boolean;
  }[];
}
//#endregion
export { GraphSealedError as C, protocolOf as E, GraphProtocol as S, graphAccess as T, GraphsSnapshot as _, GraphRevisionWire as a, GRAPH_PROTOCOL_V2 as b, LegacyGraphViewWire as c, CreateGraphResult as d, GraphArchive as f, GraphsEvent as g, GraphRecord as h, GraphProgressWire as i, graphAccessWire as l, GraphPinsUpdate as m, GraphAccessWire as n, GraphViewWire as o, GraphModel as p, GraphEvaluationWire as r, LegacyCompletionWire as s, ApprovalSourceWire as t, CreateGraphRequest as u, RsiConfig as v, assertCurrentGraph as w, GraphAccess as x, RsiLaunch as y };
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A model pinned on a graph; absent means the graph follows the deployment default selection. */
export interface GraphModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Graph settings to change together; omitted fields stay as-is and null clears a setting. */
export interface GraphPinsUpdate {
  readonly model?: GraphModel | null
  readonly rsi?: RsiConfig | null
}

/** The autonomous-improvement settings one graph runs under; absent means the graph runs no RSI loop. */
export interface RsiConfig {
  /** Objective text recorded for launch/UI; changing it never rewrites an existing frozen root task. */
  readonly task: string
  /** Natural-language outcome and resource measures the agent investigates and makes concrete. */
  readonly metrics?: readonly string[]
  /** Total improvement iterations the graph should run (integer >= 1). */
  readonly iterationRounds: number
  /** true: HITL approval gates queue for a human; false: the platform auto-resolves them. */
  readonly humanReview: boolean
}

/** Where a running RSI loop stands; the driver writes it and the UI reads it. */
export interface RsiProgress {
  /** 1-based round currently in flight (or last completed when phase is done/failed). */
  readonly round: number
  /** `running`/`publishing`/`debugging` while a round is in flight, `done` when the loop finished its rounds, `failed` when it stopped. */
  readonly phase: 'running' | 'publishing' | 'debugging' | 'done' | 'failed'
  readonly note?: string
}

export interface GraphRecord {
  readonly id: string
  readonly name: string
  readonly envId: string
  readonly rootSessionId: SessionId
  readonly graphStoreId: string
  readonly layoutStoreId: string
  readonly createdAt: number
  readonly ready: boolean
  /** Pinned model applied to agents this graph spawns after the pin; absent = deployment default. */
  readonly model?: GraphModel
  /** RSI settings this graph runs under; absent = no autonomous improvement loop. */
  readonly rsi?: RsiConfig
  /** Live RSI loop position; absent until the driver reports one. */
  readonly rsiProgress?: RsiProgress
}

export interface GraphArchive {
  readonly graph: GraphRecord
  readonly agentIds: readonly SessionId[]
  readonly archivedAt: number
}

export interface GraphsSnapshot {
  readonly version: 1
  readonly graphs: readonly GraphRecord[]
  readonly selectedId?: string
  readonly archives: readonly GraphArchive[]
}

export type GraphsEvent =
  | { readonly kind: 'graph/add'; readonly graph: GraphRecord }
  | { readonly kind: 'graph/select'; readonly id: string }
  | { readonly kind: 'graph/ready'; readonly id: string }
  | { readonly kind: 'graph/model'; readonly id: string; readonly model: GraphModel | null }
  /** Sets or clears (`null`) the RSI config and drops driver progress without replacing the graph's frozen root task. */
  | { readonly kind: 'graph/rsi'; readonly id: string; readonly rsi: RsiConfig | null }
  /** The driver's live position in the loop; it never touches the config. */
  | { readonly kind: 'graph/rsi-progress'; readonly id: string; readonly progress: RsiProgress }
  | { readonly kind: 'graph/remove'; readonly id: string; readonly archive: GraphArchive }

/** Launch needs only a goal; iteration controls have platform defaults. */
export type RsiLaunch = Pick<RsiConfig, 'task' | 'metrics'> & Partial<Pick<RsiConfig, 'iterationRounds' | 'humanReview'>>

export interface CreateGraphRequest {
  readonly name?: string
  readonly createEnv?: true
  readonly envId?: string
  /** Planned github owner/repo refs when createEnv is set. Cloned later by env agents. */
  readonly repos?: readonly string[]
  /** Named workspace: reuse the environment labeled with it, or create and label a new one. */
  readonly workspace?: string
  /** With createEnv, skip reuse matching and always create a fresh environment. */
  readonly fresh?: boolean
  /** Model pinned for the new graph; absent follows the deployment default selection. */
  readonly model?: GraphModel
  /** RSI settings to stamp on the new graph; absent leaves it without an improvement loop. */
  readonly rsi?: RsiLaunch
}

export interface CreateGraphResult {
  readonly graph: GraphRecord
  /** True when the graph bound a pre-existing environment instead of a newly created one. */
  readonly reused: boolean
}

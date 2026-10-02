import type { SessionId } from '@deepseek-ai/dsh-session'

/** A model pinned on a graph; absent means the graph follows the deployment default selection. */
export interface GraphModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
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
  | { readonly kind: 'graph/remove'; readonly id: string; readonly archive: GraphArchive }

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
}

export interface CreateGraphResult {
  readonly graph: GraphRecord
  /** True when the graph bound a pre-existing environment instead of a newly created one. */
  readonly reused: boolean
}

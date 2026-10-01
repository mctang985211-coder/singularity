/** The read-only seams the resolver observes and the resolution a read starts from. @module @dangosys/dsh-singularity-context/bindings */

import type {
  ExecutionPhase,
  RunProviderBinding,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { RunBindingRead, StoreRecoveryStatus } from '@dangosys/dsh-singularity-task-runtime'
import type { NamedRefusal } from '../refusals.ts'

/** One recorded reviewer delegation, exactly the fields the ledger holds. */
export interface ReviewerBindingRecord {
  /** The root task store the delegated graph reads through. */
  readonly rootStoreId: string
  /** The task the reviewer was delegated to review. */
  readonly taskId: string
  /** The session that started the reviewer. */
  readonly actor: string
  /** When the delegation was recorded. */
  readonly at: string
}

/** Where a reviewer's delegation is read from: the ledger finds the rows, this package reads them. */
export interface ReviewerBindingSource {
  read(sessionId: string): Promise<ReviewerBindingRecord | undefined>
}

/** Why a binding source could not answer: a conflicting ledger, or one this process cannot read. */
type ReviewerBindingFailure = 'binding-conflict' | 'unreadable'

/** What a source raises instead of picking a row: a conflict, or a ledger this process cannot read. */
export class ReviewerBindingError extends Error {
  readonly kind: ReviewerBindingFailure

  constructor(kind: ReviewerBindingFailure, message: string) {
    super(message)
    this.name = 'ReviewerBindingError'
    this.kind = kind
  }
}

/** A published graph member, as the graph store holds it. */
export interface MembershipNode {
  readonly id: string
}

/** One published graph edge, as the graph store holds it (`agent-runtime` publishes `spawn` edges). */
export interface MembershipEdge {
  readonly kind: string
  readonly from: string
  readonly to: string
}

/** The graph registry, read-only: which graph a session belongs to, and who that graph publishes. */
export interface ReadOnlyGraphs {
  graphForSession(sessionId: string): Promise<GraphRecordFacts>
  list(): Promise<readonly GraphRecordFacts[]>
  /** One graph's published members and edges, read by the registry's own graph id. */
  view(id: string): Promise<{
    readonly graph: { readonly agents: readonly MembershipNode[]; readonly edges: readonly MembershipEdge[] }
  }>
}

/** The fields of a registry graph this package reads. */
export interface GraphRecordFacts {
  readonly id: string
  readonly name: string
  readonly envId: string
  readonly rootSessionId: string
  readonly graphStoreId: string
}

/** The task service's read-only open (A2 §D: `openStore` / `snapshotIn`, never a write). */
export interface ReadOnlyTaskStore {
  openStore(storeId: string): Promise<TaskSnapshot>
}

/** The runtime's read-only observation surface; nothing here can start, recover or settle anything. */
export interface ReadOnlyTaskRuntime {
  recoveryStatus(storeId: string): Promise<StoreRecoveryStatus>
  readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined>
  readonly gate: { phaseOf(sessionId: string): ExecutionPhase | 'terminal' | undefined }
  /** Whether this deployment admits a run's own `task_decompose`. */
  allowsRuntimeDecomposition(): boolean
}

/** Everything the binding resolver reads. */
export interface BindingDeps {
  readonly task: ReadOnlyTaskStore
  readonly graphs: ReadOnlyGraphs
  readonly taskRuntime: ReadOnlyTaskRuntime
  /** The one registered delegation source, when this deployment has one. */
  readonly reviewerSource?: ReviewerBindingSource
}

/** The graph facts a resolution carries, so a reader never has to re-derive them. */
export interface CallerGraph {
  readonly id: string
  readonly name: string
  readonly envId: string
  readonly rootSessionId: string
}

/** What every resolved caller has: the domain it may read, and how that domain stands. */
export interface CallerBase {
  readonly sessionId: string
  readonly graph: CallerGraph
  /** The graph's root task store — the whole read domain for every reference read. */
  readonly storeId: string
  /** The store's recovery marker, read-only; a read never triggers or waits for recovery. */
  readonly recovery: StoreRecoveryStatus
}

/** A caller with no usable binding: no graph, no delegation, or a binding that contradicts itself. */
export interface CallerUnbound {
  readonly kind: 'unbound'
  readonly sessionId: string
  readonly refusal: NamedRefusal
  readonly detail: string
  /** Present when the caller's graph was resolvable and only the binding failed. */
  readonly graph?: CallerGraph
  /** `outside`: no durable fact binds the session. `failed`: the session is bound and a fact could not be read. */
  readonly placement: 'outside' | 'failed'
}

/** What a caller may read, by role; each optional field means the state it names is absent. */
export type CallerResolution =
  | (CallerBase & {
      readonly kind: 'root'
      readonly task?: TaskInstance
      readonly run?: TaskRun
    })
  | (CallerBase & {
      readonly kind: 'worker'
      readonly task: TaskInstance
      readonly run: TaskRun
    })
  | (CallerBase & {
      readonly kind: 'reviewer'
      readonly task?: TaskInstance
      readonly delegation: ReviewerBindingRecord
    })
  | (CallerBase & { readonly kind: 'member' })
  | CallerUnbound

/** One resolved caller plus the single snapshot its read runs against. */
export interface LoadedCaller {
  readonly resolution: CallerResolution
  /** The domain store's snapshot; absent when the store does not exist yet, or for an unbound caller. */
  readonly snapshot?: TaskSnapshot
}

/** The graph facts a resolution carries, from the registry's own record. */
export function callerGraph(graph: GraphRecordFacts): CallerGraph {
  return { id: graph.id, name: graph.name, envId: graph.envId, rootSessionId: String(graph.rootSessionId) }
}

/** Whether one session is a published member of a graph — the check every session reference passes. */
export async function isGraphMember(graphs: ReadOnlyGraphs, graphId: string, sessionId: string): Promise<boolean> {
  const view = await graphs.view(graphId)
  return view.graph.agents.some(agent => String(agent.id) === sessionId)
}

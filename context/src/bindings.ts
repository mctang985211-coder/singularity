/**
 * Where a read is allowed to look (A2 §D, §E).
 *
 * The read domain is derived from durable facts and nothing else: the graph a
 * caller's session is a **published member** of, plus the **persistent
 * `TaskStarted`** record naming that session as a run's session. A session with
 * neither is unbound; a session whose graph's root store does not exist yet is
 * still in that graph and simply has nothing to read. The reference a caller
 * passes never widens the domain — the caller is resolved first, from its own
 * live session, and only then is the target looked up inside that domain.
 *
 * Three things are deliberately absent here: `taskRuntime.runForSession` (the
 * lookup that recovers and back-fills gate state — a read may not), the
 * `onRunBound`-era in-memory cache (a worker's first request happens before that
 * cache is filled), and any model-supplied `graphId`/`storeId`/`callerId`. What
 * *is* read from the runtime is its read-only observation surface:
 * `recoveryStatus`, `readRunBinding`, and `gate.phaseOf`.
 *
 * The one binding that is not a graph member is a reviewer, whose delegation is
 * recorded in the reviewer ledger. That ledger is injected through the narrow
 * {@link ReviewerBindingSource} seam below, so this package never imports the
 * tool package that owns it.
 * @module @dangosys/dsh-singularity-context/bindings
 */

import type { ExecutionPhase, RunProviderBinding, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { RunBindingRead, StoreRecoveryStatus } from '@dangosys/dsh-singularity-task-runtime'
import type { NamedRefusal } from './refusals.ts'

/* --- the injected delegation seam ---------------------------------------- */

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

/**
 * Where a reviewer's delegation is read from. One method, read-only: the ledger
 * implementation decides how it finds the rows, and this package decides what a
 * row means.
 */
export interface ReviewerBindingSource {
  read(sessionId: string): Promise<ReviewerBindingRecord | undefined>
}

/** Why a binding source could not answer the single-record question. */
export type ReviewerBindingFailure = 'binding-conflict' | 'unreadable'

/**
 * The one thing the single-record seam cannot express: a ledger that holds
 * several *conflicting* rows for one session (or a ledger this process cannot
 * read at all). A source that finds itself in either state raises this instead
 * of picking a row — silently answering one of two delegations would make the
 * read domain depend on file order. The service maps `kind` onto the named
 * refusals `binding-conflict` / `unreadable`.
 */
export class ReviewerBindingError extends Error {
  readonly kind: ReviewerBindingFailure

  constructor(kind: ReviewerBindingFailure, message: string) {
    super(message)
    this.name = 'ReviewerBindingError'
    this.kind = kind
  }
}

/* --- the read-only observations this package may use --------------------- */

/** A published graph member, as the graph store holds it. */
export interface MembershipNode {
  readonly id: string
}

/** The graph registry, read-only: which graph a session belongs to, and who that graph publishes. */
export interface ReadOnlyGraphs {
  graphForSession(sessionId: string): Promise<GraphRecordFacts>
  list(): Promise<readonly GraphRecordFacts[]>
  /** One graph's published members, read by the registry's own graph id. */
  view(id: string): Promise<{ readonly graph: { readonly agents: readonly MembershipNode[] } }>
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
}

/** Everything the binding resolver reads. */
export interface BindingDeps {
  readonly task: ReadOnlyTaskStore
  readonly graphs: ReadOnlyGraphs
  readonly taskRuntime: ReadOnlyTaskRuntime
  /** The registered delegation sources, in registration order. */
  readonly reviewerSources: readonly ReviewerBindingSource[]
}

/* --- the resolution a read starts from ----------------------------------- */

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
}

/**
 * What a caller may read. `root` carries its task and run when the graph's root
 * contract is activated — absent on both means the graph is `not-activated`. A
 * `reviewer` carries its delegated task when the store still holds it (absent
 * means the delegation names a task this store does not have: `not-found`). A
 * `member` is a published session of the graph with no run and no delegation of
 * its own: it may read the domain, and it has no contract to read.
 */
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

function unbound(sessionId: string, refusal: NamedRefusal, detail: string, graph?: CallerGraph): LoadedCaller {
  return { resolution: { kind: 'unbound', sessionId, refusal, detail, ...(graph === undefined ? {} : { graph }) } }
}

function callerGraph(graph: GraphRecordFacts): CallerGraph {
  return { id: graph.id, name: graph.name, envId: graph.envId, rootSessionId: String(graph.rootSessionId) }
}

/**
 * The session's own run in one store: the **last** `TaskStarted` naming it, so a
 * session that ran twice is read through the run it is executing now. Absent when
 * the store holds no such run — which is what `member` and `not-activated` mean.
 * (This is the store's record, not the runtime's `runForSession`: the read path
 * never asks the runtime where a session is, because that lookup reconciles.)
 */
function runOfSessionIn(snapshot: TaskSnapshot, sessionId: string): TaskRun | undefined {
  let found: TaskRun | undefined
  for (const run of snapshot.runs) {
    if (run.sessionId !== sessionId) continue
    if (!snapshot.tasks.some(task => task.taskId === run.taskId)) continue
    found = run
  }
  return found
}

/** The task one run belongs to, as the same snapshot holds it. */
function taskOfRun(snapshot: TaskSnapshot, run: TaskRun | undefined): TaskInstance | undefined {
  return run === undefined ? undefined : snapshot.tasks.find(task => task.taskId === run.taskId)
}

/** The graph whose root store is `storeId`, or `undefined` when this deployment owns none. */
async function graphForStore(graphs: ReadOnlyGraphs, storeId: string): Promise<GraphRecordFacts | undefined> {
  for (const graph of await graphs.list()) {
    if (rootTaskStoreId(graph.rootSessionId) === storeId) return graph
  }
  return undefined
}

/** The store's snapshot, or `undefined` for the one legal absence: a store that does not exist yet. */
async function openDomain(
  task: ReadOnlyTaskStore,
  storeId: string,
): Promise<{ snapshot?: TaskSnapshot; failure?: string }> {
  try {
    return { snapshot: await task.openStore(storeId) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/does not exist/.test(detail)) return {}
    return { failure: detail }
  }
}

type DelegationRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'record'; readonly record: ReviewerBindingRecord }
  | { readonly kind: 'refused'; readonly refusal: ReviewerBindingFailure; readonly detail: string }

/**
 * Consult every registered source and reduce their answers to one delegation:
 * no source that answered means `none`, one distinct record means that record,
 * and two sources that disagree about the same session mean a conflict rather
 * than a coin toss. A source that cannot answer raises
 * {@link ReviewerBindingError}, which is reported as-is.
 */
async function readDelegation(deps: BindingDeps, sessionId: string): Promise<DelegationRead> {
  const records: ReviewerBindingRecord[] = []
  for (const source of deps.reviewerSources) {
    let record: ReviewerBindingRecord | undefined
    try {
      record = await source.read(sessionId)
    } catch (error) {
      if (error instanceof ReviewerBindingError) return { kind: 'refused', refusal: error.kind, detail: error.message }
      return {
        kind: 'refused',
        refusal: 'unreadable',
        detail: `the reviewer binding source could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (record === undefined) continue
    const same = records.some(
      existing =>
        existing.rootStoreId === record.rootStoreId && existing.taskId === record.taskId && existing.actor === record.actor,
    )
    if (!same) records.push(record)
  }
  if (records.length === 0) return { kind: 'none' }
  if (records.length > 1) {
    const named = records.map(record => `${record.taskId} in ${record.rootStoreId} (by ${record.actor})`).join('; ')
    return {
      kind: 'refused',
      refusal: 'binding-conflict',
      detail:
        `session "${sessionId}" is bound to more than one reviewer delegation: ${named}. ` +
        'A read domain cannot be chosen between conflicting delegations.',
    }
  }
  return { kind: 'record', record: records[0] as ReviewerBindingRecord }
}

/**
 * Resolve one live session to the domain it may read, from durable facts only.
 *
 * The order is the contract's: the caller's own graph membership, then its own
 * persisted run, then a recorded delegation, then "a member with no binding of
 * its own". Nothing in this function writes: opening the store is the store's
 * own read-only open, and the runtime calls are observations.
 */
export async function loadCaller(deps: BindingDeps, sessionId: string, signal?: AbortSignal): Promise<LoadedCaller> {
  signal?.throwIfAborted()
  const delegation = await readDelegation(deps, sessionId)
  let graph: GraphRecordFacts | undefined
  try {
    graph = await deps.graphs.graphForSession(sessionId)
  } catch {
    graph = undefined
  }

  if (graph === undefined) {
    if (delegation.kind === 'refused') return unbound(sessionId, delegation.refusal, delegation.detail)
    if (delegation.kind === 'none') {
      return unbound(
        sessionId,
        'unbound',
        `session "${sessionId}" is not a published member of any graph and no delegation binds it; ` +
          'a context read needs a graph, and a session is never placed by the ids it passes.',
      )
    }
    const placed = await graphForStore(deps.graphs, delegation.record.rootStoreId)
    if (placed === undefined) {
      return unbound(
        sessionId,
        'unbound',
        `session "${sessionId}" is delegated to store "${delegation.record.rootStoreId}", which no graph in this ` +
          'deployment owns; the delegation cannot be placed, so there is no domain to read.',
      )
    }
    return await reviewerOf(deps, sessionId, placed, delegation.record, signal)
  }

  const facts = callerGraph(graph)
  const storeId = rootTaskStoreId(graph.rootSessionId)
  const opened = await openDomain(deps.task, storeId)
  if (opened.failure !== undefined) {
    return unbound(
      sessionId,
      'unreadable',
      `the domain store "${storeId}" of graph "${graph.id}" cannot be read: ${opened.failure}`,
      facts,
    )
  }
  const snapshot = opened.snapshot
  const recovery = await deps.taskRuntime.recoveryStatus(storeId)
  const base: CallerBase = { sessionId, graph: facts, storeId, recovery }
  const own = snapshot === undefined ? undefined : runOfSessionIn(snapshot, sessionId)
  const task = snapshot === undefined ? undefined : taskOfRun(snapshot, own)

  if (sessionId === String(graph.rootSessionId)) {
    // How a root is identified (A2 §D): the run whose session *is* the graph's
    // root session. Never "the first parentless task" — a store also holds a
    // replay's parentless task, and adopting that as the root crosses lineages.
    return {
      resolution: {
        ...base,
        kind: 'root',
        ...(task === undefined || own === undefined ? {} : { task, run: own }),
      },
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  }
  if (own !== undefined && task !== undefined) {
    return {
      resolution: { ...base, kind: 'worker', task, run: own },
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  }
  if (delegation.kind === 'refused') {
    return unbound(sessionId, delegation.refusal, delegation.detail, facts)
  }
  if (delegation.kind === 'record') {
    return await reviewerOf(deps, sessionId, graph, delegation.record, signal)
  }
  return {
    resolution: { ...base, kind: 'member' },
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

/**
 * A reviewer's resolved domain: the graph its delegation names, checked against
 * the graph its session is a member of. The delegation must agree with the live
 * membership (`cross-graph` when it does not), and it is the delegation — not
 * the caller's word — that names the delegated task; a task the store no longer
 * holds leaves the contract reads at `not-found`.
 */
async function reviewerOf(
  deps: BindingDeps,
  sessionId: string,
  graph: GraphRecordFacts,
  record: ReviewerBindingRecord,
  signal?: AbortSignal,
): Promise<LoadedCaller> {
  signal?.throwIfAborted()
  const facts = callerGraph(graph)
  const storeId = rootTaskStoreId(graph.rootSessionId)
  if (storeId !== record.rootStoreId) {
    return unbound(
      sessionId,
      'cross-graph',
      `session "${sessionId}" is a member of graph "${graph.id}" (store "${storeId}") but its recorded delegation ` +
        `names store "${record.rootStoreId}"; a delegation never moves a session into another graph's domain.`,
      facts,
    )
  }
  const opened = await openDomain(deps.task, storeId)
  if (opened.failure !== undefined) {
    return unbound(sessionId, 'unreadable', `the delegated store "${storeId}" cannot be read: ${opened.failure}`, facts)
  }
  const recovery = await deps.taskRuntime.recoveryStatus(storeId)
  const task = opened.snapshot?.tasks.find(item => item.taskId === record.taskId)
  return {
    resolution: {
      sessionId,
      graph: facts,
      storeId,
      recovery,
      kind: 'reviewer',
      ...(task === undefined ? {} : { task }),
      delegation: record,
    },
    ...(opened.snapshot === undefined ? {} : { snapshot: opened.snapshot }),
  }
}

/**
 * Whether one session is a published member of the caller's graph — the check a
 * `session` reference passes before any session history is read. Membership is
 * the graph store's own record (read through the registry, which resolves the
 * graph id to its store), so a guessed session id is refused before DSH is asked
 * anything about it.
 */
export async function isGraphMember(graphs: ReadOnlyGraphs, graphId: string, sessionId: string): Promise<boolean> {
  const view = await graphs.view(graphId)
  return view.graph.agents.some(agent => String(agent.id) === sessionId)
}

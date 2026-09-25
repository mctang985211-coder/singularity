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
 * A **failure** to read those facts is not the fact "no binding exists"
 * (2026-09-25 rework, Q1). Three reads can fail: the registry's own lookup (a
 * read failure is never read as "no graph" — only
 * `SessionNotInGraphError`, the registry's `SESSION_NOT_IN_GRAPH` fact, is a
 * miss), the domain store's open, and the reviewer ledger. Each failure becomes
 * a named refusal carrying `placement: 'failed'`, which is what the prompt
 * assembly refuses the model request on; only a session this deployment
 * genuinely holds no fact about is `placement: 'outside'` and left to assemble
 * whatever its composition gives it.
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
 * tool package that owns it. Because a delegation opens a graph's read domain,
 * it is only believed when the graph it names actually publishes the delegator
 * it records ({@link delegatorStanding}).
 * @module @dangosys/dsh-singularity-context/bindings
 */

import type { ExecutionPhase, RunProviderBinding, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { RunBindingRead, StoreRecoveryStatus } from '@dangosys/dsh-singularity-task-runtime'
import { SESSION_NOT_IN_GRAPH } from '@dangosys/dsh-singularity-graphs'
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
  /**
   * Whether this deployment admits a run's own `task_decompose` — the fact the
   * worker projection's runtime-split rule hangs on. Read-only: the projection
   * *reports* the rule; admission still decides every call.
   */
  allowsRuntimeDecomposition(): boolean
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
  /**
   * Which of the two situations this is, since the two reads that produce it
   * answer a caller differently (2026-09-25 rework, Q1):
   *
   * - `outside`: no durable fact in this deployment binds the session — it is
   *   not a member of any graph and no ledger names it. Its assembly is somebody
   *   else's business, and a read of it refuses `unbound`.
   * - `failed`: the session **is** bound (or a delegation names it) and a fact
   *   the binding is derived from could not be read — the graph lookup, the
   *   domain store's open, or the ledger. The read still refuses by name, and
   *   the prompt assembly refuses the model request outright: a bound session
   *   never gets a request assembled from nothing.
   */
  readonly placement: 'outside' | 'failed'
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

function unbound(
  sessionId: string,
  refusal: NamedRefusal,
  detail: string,
  graph: CallerGraph | undefined,
  placement: 'outside' | 'failed',
): LoadedCaller {
  return {
    resolution: {
      kind: 'unbound',
      sessionId,
      refusal,
      detail,
      placement,
      ...(graph === undefined ? {} : { graph }),
    },
  }
}

function outside(sessionId: string, refusal: NamedRefusal, detail: string): LoadedCaller {
  return unbound(sessionId, refusal, detail, undefined, 'outside')
}

function failed(
  sessionId: string,
  refusal: NamedRefusal,
  detail: string,
  graph?: CallerGraph,
): LoadedCaller {
  return unbound(sessionId, refusal, detail, graph, 'failed')
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
 * The failure one binding source reported, from the error's own shape. The seam
 * is implemented by whatever package owns the ledger, so the error a source
 * raises can be an instance of *its* copy of {@link ReviewerBindingError}: a
 * class check alone would silently degrade a named conflict to a generic
 * unreadable answer, so the contract (name plus `kind`) is what decides, and a
 * class match is one way to satisfy it.
 */
function reviewerFailure(error: unknown): ReviewerBindingFailure | undefined {
  const kind = (error as { kind?: unknown } | undefined)?.kind
  if (kind !== 'binding-conflict' && kind !== 'unreadable') return undefined
  if (error instanceof ReviewerBindingError || (error instanceof Error && error.name === 'ReviewerBindingError')) return kind
  return undefined
}

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
      const failure = reviewerFailure(error)
      if (failure !== undefined) {
        return { kind: 'refused', refusal: failure, detail: error instanceof Error ? error.message : String(error) }
      }
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
 *
 * Every read that can fail says so in the resolution it returns: the graph
 * lookup, the store's open and the ledger all answer `placement: 'failed'` when
 * they cannot answer at all, so that the assembly (which is the one consumer
 * that must not carry on regardless) can tell that apart from a session this
 * deployment simply does not know (`placement: 'outside'`).
 */
export async function loadCaller(deps: BindingDeps, sessionId: string, signal?: AbortSignal): Promise<LoadedCaller> {
  signal?.throwIfAborted()
  const membership = await graphOfSession(deps.graphs, sessionId)
  if (membership.kind === 'failed') return failed(sessionId, 'unreadable', membership.detail)
  const graph = membership.kind === 'graph' ? membership.graph : undefined

  if (graph === undefined) {
    const delegation = await readDelegation(deps, sessionId)
    if (delegation.kind === 'refused') return failed(sessionId, delegation.refusal, delegation.detail)
    if (delegation.kind === 'none') {
      return outside(
        sessionId,
        'unbound',
        `session "${sessionId}" is not a published member of any graph and no delegation binds it; ` +
          'a context read needs a graph, and a session is never placed by the ids it passes.',
      )
    }
    let placed: GraphRecordFacts | undefined
    try {
      placed = await graphForStore(deps.graphs, delegation.record.rootStoreId)
    } catch (error) {
      return failed(
        sessionId,
        'unreadable',
        `the delegation of session "${sessionId}" names store "${delegation.record.rootStoreId}", and the graph registry ` +
          `could not be listed to place it: ${message(error)}`,
      )
    }
    if (placed === undefined) {
      return failed(
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
    return failed(
      sessionId,
      'unreadable',
      `the domain store "${storeId}" of graph "${graph.id}" cannot be read: ${opened.failure}`,
      facts,
    )
  }
  const snapshot = opened.snapshot
  const isRoot = sessionId === String(graph.rootSessionId)
  if (snapshot === undefined && !isRoot) {
    // A graph's store may legitimately not exist yet — that is the *root's*
    // `not-activated` state (A2 §D), and it stays one; a session published into
    // the graph that the graph did **not** spawn (a root of another graph is the
    // real case) still has nothing to read and passes through, as a plain member
    // always did. A session this graph *did* spawn is different: its run record
    // was written to that store when it was spawned (the spawn happens because a
    // run exists), so an absent store is not "nothing to read yet" — it is the
    // store the session is bound by, no longer readable. Reading that as "a
    // member with nothing to read" is what let a bound worker's request assemble
    // with no contract at all when the store's log stopped being listed
    // (2026-09-25 review, Q1).
    const spawned = await spawnedInto(deps, graph, sessionId)
    if (spawned.kind === 'failed') {
      return failed(sessionId, 'unreadable', spawned.detail, facts)
    }
    if (spawned.kind === 'spawned') {
      return failed(
        sessionId,
        'unreadable',
        `graph "${graph.id}" spawned session "${sessionId}" into itself, but its store "${storeId}" does not exist; the ` +
          'run this session is bound by was recorded in that store, so its absence means the store cannot be read, not ' +
          'that the session has nothing to read. No contract can be assembled for it.',
        facts,
      )
    }
  }
  const recovery = await deps.taskRuntime.recoveryStatus(storeId)
  const base: CallerBase = { sessionId, graph: facts, storeId, recovery }
  const own = snapshot === undefined ? undefined : runOfSessionIn(snapshot, sessionId)
  const task = snapshot === undefined ? undefined : taskOfRun(snapshot, own)
  const workerRun = !isRoot && own !== undefined && task !== undefined
  // The ledger is the authority only for a session with no run of its own. A
  // *conflict* names this session and contradicts its identity, so it refuses
  // whoever the session is; an unreadable ledger does not refuse a session whose
  // own run already binds it (the fault says nothing about that session, and a
  // corrupt file must not take every worker of the deployment down with it).
  const ledger = isRoot || workerRun ? await readDelegation(deps, sessionId) : undefined
  if (ledger?.kind === 'refused' && ledger.refusal === 'binding-conflict') {
    return failed(sessionId, ledger.refusal, ledger.detail, facts)
  }
  if (isRoot) {
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
  if (workerRun) {
    return {
      resolution: { ...base, kind: 'worker', task: task as TaskInstance, run: own as TaskRun },
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  }
  const delegation = ledger ?? (await readDelegation(deps, sessionId))
  if (delegation.kind === 'refused') {
    return failed(sessionId, delegation.refusal, delegation.detail, facts)
  }
  if (delegation.kind === 'record') {
    return await reviewerOf(deps, sessionId, graph, delegation.record, signal)
  }
  return {
    resolution: { ...base, kind: 'member' },
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

/** One error message, from whatever a read threw. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type GraphOfSession =
  | { readonly kind: 'graph'; readonly graph: GraphRecordFacts }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly detail: string }

/**
 * The graph a session is a published member of — the registry's own lookup, read
 * as the two different answers it really has. `SESSION_NOT_IN_GRAPH` is the
 * registry's *fact* that no graph holds this session; anything else it throws is
 * a failed read of the registry or of one of its stores, and is reported as
 * such. Reading a failure as "no graph" is what let a bound worker's request be
 * assembled with no contract at all (2026-09-25 rework, Q1).
 */
async function graphOfSession(graphs: ReadOnlyGraphs, sessionId: string): Promise<GraphOfSession> {
  try {
    return { kind: 'graph', graph: await graphs.graphForSession(sessionId) }
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === SESSION_NOT_IN_GRAPH) return { kind: 'none' }
    return {
      kind: 'failed',
      detail:
        `graph membership for session "${sessionId}" could not be read: ${message(error)}. ` +
        'A registry that cannot be read is not a session without a graph.',
    }
  }
}

/**
 * Whether the graph itself spawned one session into it. `agent-runtime` records
 * a `spawn` edge from the parent when it publishes a spawned session, so this is
 * the graph store's own durable record — the same source membership comes from —
 * and not an inference from names or status. A read that fails is reported as a
 * failure: which side of the rule a session falls on decides whether its absent
 * store is a named state or a read failure, and a guess would decide wrongly.
 */
async function spawnedInto(
  deps: BindingDeps,
  graph: GraphRecordFacts,
  sessionId: string,
): Promise<{ kind: 'spawned' } | { kind: 'member' } | { kind: 'failed'; detail: string }> {
  try {
    const view = await deps.graphs.view(graph.id)
    const spawned = (view.graph.edges ?? []).some(edge => edge.kind === 'spawn' && String(edge.to) === sessionId)
    return spawned ? { kind: 'spawned' } : { kind: 'member' }
  } catch (error) {
    return {
      kind: 'failed',
      detail:
        `session "${sessionId}" is published by graph "${graph.id}", whose store "${rootTaskStoreId(graph.rootSessionId)}" ` +
        `does not exist, and whether that graph spawned this session cannot be read: ${message(error)}. ` +
        'A binding that cannot be read is not a binding.',
    }
  }
}

/**
 * A reviewer's resolved domain: the graph its delegation names, checked against
 * the graph its session is a member of. The delegation must agree with the live
 * membership (`cross-graph` when it does not), and it is the delegation — not
 * the caller's word — that names the delegated task; a task the store no longer
 * holds leaves the contract reads at `not-found`.
 *
 * A delegation opens a graph's read domain, so its `actor` is checked too
 * (2026-09-25 rework, Q2): the session the ledger records as the delegator must
 * be one the delegated graph actually publishes (or, for a session the registry
 * places nowhere, something this deployment never published at all — which is
 * just as disqualifying). The actor is the ledger's own field and the
 * membership is the registry's own view, so neither a model-supplied id nor a
 * hand-written ledger row can grant a domain the graph does not own.
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
    return failed(
      sessionId,
      'cross-graph',
      `session "${sessionId}" is a member of graph "${graph.id}" (store "${storeId}") but its recorded delegation ` +
        `names store "${record.rootStoreId}"; a delegation never moves a session into another graph's domain.`,
      facts,
    )
  }
  const standing = await delegatorStanding(deps, sessionId, graph, record.actor)
  if (standing.kind === 'refused') return failed(sessionId, standing.refusal, standing.detail, facts)
  const opened = await openDomain(deps.task, storeId)
  if (opened.failure !== undefined) {
    return failed(sessionId, 'unreadable', `the delegated store "${storeId}" cannot be read: ${opened.failure}`, facts)
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

type DelegatorStanding = { readonly kind: 'member' } | { readonly kind: 'refused'; readonly refusal: NamedRefusal; readonly detail: string }

/**
 * Whether the session a delegation names as its delegator is really a session of
 * the graph it delegated into. The check is the registry's published members
 * (`view`) — the same record a `session` reference is checked against — and a
 * registry that cannot be read refuses rather than assuming the actor is fine.
 */
async function delegatorStanding(
  deps: BindingDeps,
  sessionId: string,
  graph: GraphRecordFacts,
  actor: string,
): Promise<DelegatorStanding> {
  let member: boolean
  try {
    member = await isGraphMember(deps.graphs, graph.id, actor)
  } catch (error) {
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail:
        `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be checked against graph ` +
        `"${graph.id}": ${message(error)}. An unverifiable delegator is not an authorization.`,
    }
  }
  if (member) return { kind: 'member' }
  // Not a member of the graph it delegated into. Where it is decides how to say
  // so: another graph's session is the cross-graph case; a session no graph
  // publishes is not a delegator this deployment has any record of.
  let elsewhere: GraphRecordFacts | undefined
  try {
    elsewhere = await deps.graphs.graphForSession(actor)
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === SESSION_NOT_IN_GRAPH) {
      return {
        kind: 'refused',
        refusal: 'unbound',
        detail:
          `the delegation of session "${sessionId}" into graph "${graph.id}" (store ` +
          `"${rootTaskStoreId(graph.rootSessionId)}") records "${actor}" as its delegator, and no graph in this ` +
          'deployment publishes that session; a delegation is granted by a session of the graph it delegates into, ' +
          'not by a name in a file.',
      }
    }
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail:
        `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be placed: ${message(error)}. ` +
        'A delegator whose ownership cannot be read is not an authorization.',
    }
  }
  return {
    kind: 'refused',
    refusal: 'cross-graph',
    detail:
      `the delegation of session "${sessionId}" into graph "${graph.id}" (store ` +
      `"${rootTaskStoreId(graph.rootSessionId)}") was recorded by "${actor}", which graph "${graph.id}" does not ` +
      `publish: the delegator belongs to graph "${elsewhere?.id ?? '(unknown)'}", and a delegation never opens ` +
      "another graph's read domain.",
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

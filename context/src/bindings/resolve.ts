/** Deriving one live session's read domain from durable facts. @module @dangosys/dsh-singularity-context/bindings-resolve */

import { SESSION_NOT_IN_GRAPH } from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { message, type NamedRefusal } from '../refusals.ts'
import { delegatorStanding, readCoordination, type CoordinationBinding } from './coordination.ts'
import {
  callerGraph,
  type BindingDeps,
  type CallerBase,
  type CallerGraph,
  type GraphRecordFacts,
  type LoadedCaller,
  type ReadOnlyGraphs,
  type ReadOnlyTaskStore,
} from './types.ts'

/** The domain store's own answer: its snapshot, or nothing when this deployment owns no such store. */
async function openDomain(
  task: ReadOnlyTaskStore,
  storeId: string,
): Promise<{ snapshot?: TaskSnapshot; failure?: string }> {
  try {
    const door = await task.snapshotReadOnly(storeId)
    return door.exists ? { snapshot: door.snapshot } : {}
  } catch (error) {
    return { failure: message(error) }
  }
}

/** The session's own run in one store: the **last** `TaskStarted` naming it, never a runtime lookup. */
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

function failed(sessionId: string, refusal: NamedRefusal, detail: string, graph?: CallerGraph): LoadedCaller {
  return unbound(sessionId, refusal, detail, graph, 'failed')
}

type GraphOfSession =
  | { readonly kind: 'graph'; readonly graph: GraphRecordFacts }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly detail: string }

/** The graph a session is a published member of; any throw but the registry's fact is a failed read. */
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

/** Whether the graph itself spawned one session into it — the graph store's own `spawn` edge. */
async function spawnedInto(
  deps: BindingDeps,
  graph: GraphRecordFacts,
  sessionId: string,
): Promise<{ kind: 'spawned' } | { kind: 'member' } | { kind: 'failed'; detail: string }> {
  try {
    const view = await deps.graphs.view(graph.id)
    if (view.graph === null) throw new Error('the graph store does not exist')
    const spawned = view.graph.edges.some(edge => edge.kind === 'spawn' && String(edge.to) === sessionId)
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

/** Resolve one live session to the domain it may read, from durable facts only. */
export async function loadCaller(deps: BindingDeps, sessionId: string, signal?: AbortSignal): Promise<LoadedCaller> {
  signal?.throwIfAborted()
  const membership = await graphOfSession(deps.graphs, sessionId)
  if (membership.kind === 'failed') return failed(sessionId, 'unreadable', membership.detail)
  const graph = membership.kind === 'graph' ? membership.graph : undefined

  if (graph === undefined) {
    const coordination = await readCoordination(deps, sessionId)
    if (coordination.kind === 'refused') return failed(sessionId, coordination.refusal, coordination.detail)
    if (coordination.kind === 'none') {
      return outside(
        sessionId,
        'unbound',
        `session "${sessionId}" is not a published member of any graph and no delegation binds it; ` +
          'a context read needs a graph, and a session is never placed by the ids it passes.',
      )
    }
    let placed: GraphRecordFacts | undefined
    try {
      placed = await graphForStore(deps.graphs, coordination.record.rootStoreId)
    } catch (error) {
      return failed(
        sessionId,
        'unreadable',
        `the delegation of session "${sessionId}" names store "${coordination.record.rootStoreId}", and the graph registry ` +
          `could not be listed to place it: ${message(error)}`,
      )
    }
    if (placed === undefined) {
      return failed(
        sessionId,
        'unbound',
        `session "${sessionId}" is delegated to store "${coordination.record.rootStoreId}", which no graph in this ` +
          'deployment owns; the delegation cannot be placed, so there is no domain to read.',
      )
    }
    return await coordinatorOf(deps, sessionId, placed, coordination.record, signal)
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
    // An absent store is the root's `not-activated` state, but a session this
    // graph spawned was recorded in that store: its absence is a read failure.
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
  // The ledger is the authority only for a session with no run of its own: an
  // unreadable ledger does not refuse a session its own run already binds.
  const ledger = isRoot || workerRun ? await readCoordination(deps, sessionId) : undefined
  if (ledger?.kind === 'refused' && ledger.refusal === 'binding-conflict') {
    return failed(sessionId, ledger.refusal, ledger.detail, facts)
  }
  if (isRoot) {
    // A root is the run whose session *is* the graph's root session, never "the
    // first parentless task" — a store also holds a replay's parentless task.
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
  const coordination = ledger ?? (await readCoordination(deps, sessionId))
  if (coordination.kind === 'refused') {
    return failed(sessionId, coordination.refusal, coordination.detail, facts)
  }
  if (coordination.kind === 'record') {
    return await coordinatorOf(deps, sessionId, graph, coordination.record, signal, { ...opened, recovery })
  }
  return {
    resolution: { ...base, kind: 'member' },
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

/** A coordinator's resolved domain: the delegation, its graph and its delegator, all checked (Q2). */
async function coordinatorOf(
  deps: BindingDeps,
  sessionId: string,
  graph: GraphRecordFacts,
  record: CoordinationBinding,
  signal?: AbortSignal,
  domain?: Awaited<ReturnType<typeof openDomain>> & { readonly recovery: CallerBase['recovery'] },
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
  const opened = domain ?? await openDomain(deps.task, storeId)
  if (opened.failure !== undefined) {
    return failed(sessionId, 'unreadable', `the delegated store "${storeId}" cannot be read: ${opened.failure}`, facts)
  }
  const recovery = domain?.recovery ?? await deps.taskRuntime.recoveryStatus(storeId)
  const task = opened.snapshot?.tasks.find(item => item.taskId === record.sourceTaskId)
  return {
    resolution: {
      sessionId,
      graph: facts,
      storeId,
      recovery,
      kind: 'coordinator',
      role: record.role,
      ...(task === undefined ? {} : { task }),
      binding: record,
    },
    ...(opened.snapshot === undefined ? {} : { snapshot: opened.snapshot }),
  }
}

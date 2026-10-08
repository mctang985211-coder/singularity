import type {
  CanvasNode,
  CreateGraphBody,
  GraphAccess,
  GraphEntry,
  GraphEnv,
  GraphSnapshot,
  GraphViewResponse,
  GraphsResponse,
  LayoutSnapshot,
  LegacyHistoryResponse,
  ModelRef,
  ModelsResponse,
  RecoveryResponse,
  ReviewResponse,
  RsiConfig,
  TaskInvalidation,
  TaskSnapshotWire,
} from './types'
import type { GraphMeta, HitlPending } from './store'

const SEARCH = new URLSearchParams(window.location.search)
export const INITIAL_GRAPH_ID = SEARCH.get('graphId')

// An explicit ?storeId names the task store of the graph loaded at boot; a graph
// switched from inside the SPA drops it and derives the store id instead.
let storeOverride: string | null = SEARCH.get('storeId')

export function taskStoreId(rootSessionId: string): string {
  return storeOverride ?? `sg-t-${rootSessionId}`
}

export function setStoreOverride(id: string | null): void {
  storeOverride = id
}

export interface ViewSnapshot {
  meta: GraphMeta
  access: GraphAccess
  graph: GraphSnapshot | null
  layout: LayoutSnapshot | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.url}: ${res.status} ${text}`)
  return (text.length === 0 ? undefined : JSON.parse(text)) as T
}

function graphQuery(graphId: string): string {
  return '?graphId=' + encodeURIComponent(graphId)
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function fetchGraph(graphId: string): Promise<ViewSnapshot> {
  return request<ViewSnapshot>('/singularity/graph' + graphQuery(graphId))
}

/** The unified read model: the same revision, evaluation and progress the tool plane reads. */
export function fetchView(graphId: string): Promise<GraphViewResponse> {
  return request<GraphViewResponse>('/singularity/view' + graphQuery(graphId))
}

/** One sealed graph's history: the old records verbatim, read-only. */
export function fetchHistory(graphId: string): Promise<LegacyHistoryResponse> {
  return request<LegacyHistoryResponse>('/singularity/graphs/' + encodeURIComponent(graphId) + '/history')
}

export function fetchHitl(): Promise<{ pending: HitlPending[] }> {
  return request<{ pending: HitlPending[] }>('/singularity/hitl')
}

export function answerHitl(
  id: string,
  answer: { kind: 'ask'; text: string } | { kind: 'approve'; decision: 'approve' | 'reject' },
): Promise<{ pending: HitlPending[] }> {
  return post<{ pending: HitlPending[] }>('/singularity/hitl', { id, answer })
}

export function putLayout(graphId: string, sessionId: string, node: CanvasNode): Promise<LayoutSnapshot> {
  return request<LayoutSnapshot>('/singularity/layout' + graphQuery(graphId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, node }),
  })
}

export function fetchGraphs(): Promise<GraphsResponse> {
  return request<GraphsResponse>('/singularity/graphs')
}

export function fetchGraphEnvs(): Promise<{ envs: GraphEnv[] }> {
  return request<{ envs: GraphEnv[] }>('/singularity/graph-envs')
}

export function createGraph(body: CreateGraphBody): Promise<GraphEntry> {
  return post<GraphEntry>('/singularity/graphs', body)
}

export function fetchModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>('/singularity/models')
}

/** The editable fields of a graph: an absent key keeps the current value, `null` clears that field. */
export interface GraphPatch {
  readonly model?: ModelRef | null
  readonly rsi?: RsiConfig | null
}

export function patchGraph(id: string, patch: GraphPatch): Promise<GraphEntry> {
  return request<GraphEntry>(`/singularity/graphs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function selectGraph(id: string): Promise<GraphEntry> {
  return post<GraphEntry>(`/singularity/graphs/${encodeURIComponent(id)}/select`, {})
}

export function deleteGraph(id: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(`/singularity/graphs/${encodeURIComponent(id)}/delete`, {})
}

export function fetchTask(storeId: string): Promise<{ snapshot: TaskSnapshotWire | null }> {
  return request<{ snapshot: TaskSnapshotWire | null }>('/singularity/task?storeId=' + encodeURIComponent(storeId))
}

export function fetchRecovery(storeId: string): Promise<RecoveryResponse> {
  return request<RecoveryResponse>('/singularity/recovery?storeId=' + encodeURIComponent(storeId))
}

export function fetchReview(storeId: string, runId: string): Promise<ReviewResponse> {
  return request<ReviewResponse>(
    '/singularity/review?storeId=' + encodeURIComponent(storeId) + '&runId=' + encodeURIComponent(runId),
  )
}

function parse<T>(event: Event): T | null {
  const data = (event as MessageEvent).data
  if (typeof data !== 'string' || data.length === 0) return null
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

export function openEvents(
  graphId: string,
  handlers: {
    onSnapshot: (view: ViewSnapshot) => void
    onHitl: (pending: HitlPending[]) => void
    onTask: (hint: TaskInvalidation) => void
    onMethods: () => void
    onError: () => void
  },
): EventSource {
  const source = new EventSource('/singularity/events' + graphQuery(graphId))
  source.addEventListener('snapshot', event => {
    const data = parse<ViewSnapshot>(event)
    if (data !== null) handlers.onSnapshot(data)
  })
  source.addEventListener('hitl', event => {
    const data = parse<{ pending?: HitlPending[] }>(event)
    if (data !== null) handlers.onHitl(data.pending ?? [])
  })
  source.addEventListener('task', event => {
    handlers.onTask(parse<TaskInvalidation>(event) ?? {})
  })
  // A method frame names the record that moved; the projection itself is re-read
  // from the one read source rather than assembled from the frame.
  source.addEventListener('methods', () => handlers.onMethods())
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return
    handlers.onError()
  }
  return source
}

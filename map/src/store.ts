import { create } from 'zustand'
import type { Edge, Node } from '@xyflow/react'
import type {
  AgentData,
  CanvasNode,
  CreateGraphBody,
  GraphEntry,
  GraphSnapshot,
  GraphViewResponse,
  LayoutSnapshot,
  LegacyHistoryResponse,
  ModelRef,
  ModelsResponse,
  RsiConfig,
  TaskSnapshotWire,
} from './types'
import {
  answerHitl,
  createGraph,
  deleteGraph,
  fetchGraph,
  fetchGraphs,
  fetchHistory,
  fetchHitl,
  fetchModels,
  fetchTask,
  fetchView,
  INITIAL_GRAPH_ID,
  openEvents,
  patchGraph,
  putLayout,
  selectGraph,
  setStoreOverride,
  taskStoreId,
  type ViewSnapshot,
  type GraphPatch,
} from './api'

export type FlowNode = Node<AgentData & Record<string, unknown>>
export type FlowEdge = Edge<{ kind: 'spawn' | 'handoff'; brief?: string }>

export interface GraphMeta {
  readonly id: string
  readonly name: string
  readonly ready: boolean
  readonly graphStoreId: string
  readonly layoutStoreId: string
  readonly rootSessionId: string
}

/** How the open graph may be used: a sealed legacy graph is history, and nothing here writes to one. */
export type AccessMode = 'current' | 'legacy-readonly'

export function readOnlyOf(mode: AccessMode): boolean {
  return mode !== 'current'
}

export interface ChatRow {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** The spawn edge's parent session: the durable address a subagent child is opened under. */
export function spawnParent(id: string, edges: FlowEdge[]): string | undefined {
  return edges.find(edge => edge.data?.kind === 'spawn' && edge.target === id)?.source
}

export interface HitlPending {
  readonly id: string
  readonly kind: 'ask' | 'approve'
  readonly prompt: string
  readonly sessionId: string
  readonly createdAt: number
}

interface Store {
  graphId: string | null
  graph: GraphSnapshot | null
  layout: LayoutSnapshot | null
  graphMeta: GraphMeta | null
  nodes: FlowNode[]
  edges: FlowEdge[]
  selectedId: string | null
  paper: 'plain' | 'grid'
  error: string | null
  bootError: string | null
  empty: boolean
  source: EventSource | null
  generation: number
  chat: { sessionId: string | null; rows: ChatRow[]; readOnly: boolean }
  hitl: HitlPending[]
  submission: { id: string; resolve: () => void; reject: (error: Error) => void } | null
  tab: string
  graphs: GraphEntry[]
  graphsSelectedId: string | null
  graphsLoading: boolean
  graphsError: string | null
  models: ModelsResponse | null
  modelsError: string | null
  task: TaskSnapshotWire | null
  taskLoading: boolean
  taskError: string | null
  taskEpoch: number
  selectedRunId: string | null
  access: AccessMode
  readOnly: boolean
  history: LegacyHistoryResponse | null
  historyError: string | null
  graphView: GraphViewResponse | null
  graphViewError: string | null
  finishPrompt: (id: string, error?: string) => void
  boot: () => Promise<void>
  applySnapshot: (view: ViewSnapshot) => void
  applyHitl: (pending: HitlPending[]) => void
  applyChat: (sessionId: string, rows: ChatRow[], readOnly: boolean) => void
  setSelected: (id: string | null) => void
  setPaper: (p: 'plain' | 'grid') => void
  setTab: (id: string) => void
  setNodes: (nodes: FlowNode[]) => void
  moveNode: (id: string, x: number, y: number) => Promise<void>
  sendPrompt: (sessionId: string, text: string) => Promise<void>
  answerHitl: (
    id: string,
    answer: { kind: 'ask'; text: string } | { kind: 'approve'; decision: 'approve' | 'reject' },
  ) => Promise<void>
  loadGraphs: () => Promise<void>
  switchGraph: (id: string) => Promise<void>
  createGraph: (body: CreateGraphBody) => Promise<string>
  removeGraph: (id: string) => Promise<void>
  loadModels: () => Promise<void>
  updateGraphModel: (id: string, model: ModelRef | null) => Promise<void>
  updateGraphRsi: (id: string, rsi: RsiConfig | null) => Promise<void>
  updateGraphSettings: (id: string, settings: GraphPatch) => Promise<void>
  taskStoreId: () => string | null
  loadTask: () => Promise<void>
  setSelectedRun: (id: string | null) => void
  loadView: () => Promise<void>
  openHistory: () => Promise<void>
}

function build(
  graph: GraphSnapshot,
  layout: LayoutSnapshot,
  selectedId: string | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const roots = new Set(graph.roots)
  const nodes: FlowNode[] = graph.agents.map(agent => {
    const geo = layout.nodes[agent.id]
    if (geo === undefined) throw new Error(`map: agent ${agent.id} has no layout`)
    return {
      id: agent.id,
      type: 'agent',
      position: { x: geo.x, y: geo.y },
      selected: agent.id === selectedId,
      data: {
        ...agent,
        width: geo.width,
        height: geo.height,
        shape: geo.shape,
        root: roots.has(agent.id),
      },
      style: { width: geo.width, height: geo.height },
    }
  })
  const edges: FlowEdge[] = graph.edges.map(edge => ({
    id: edge.id,
    type: 'agent',
    source: edge.from,
    target: edge.to,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: edge.kind, brief: edge.brief },
  }))
  return { nodes, edges }
}

function ancestors(selectedId: string | null, edges: FlowEdge[]): Set<string> {
  if (selectedId === null) return new Set()
  const byTarget = new Map<string, string[]>()
  for (const e of edges) {
    const list = byTarget.get(e.target)
    if (list) list.push(e.source)
    else byTarget.set(e.target, [e.source])
  }
  const hit = new Set<string>([selectedId])
  const stack = [selectedId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const parents = byTarget.get(id)
    if (parents === undefined) continue
    for (const parent of parents) {
      if (hit.has(parent)) continue
      hit.add(parent)
      stack.push(parent)
    }
  }
  return hit
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function syncUrl(graphId: string | null): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('storeId')
  if (graphId === null) url.searchParams.delete('graphId')
  else url.searchParams.set('graphId', graphId)
  window.history.replaceState(null, '', url)
}

export const useStore = create<Store>((set, get) => ({
  graphId: INITIAL_GRAPH_ID,
  graph: null,
  layout: null,
  graphMeta: null,
  nodes: [],
  edges: [],
  selectedId: null,
  paper: 'grid',
  error: null,
  bootError: null,
  empty: false,
  source: null,
  generation: 0,
  chat: { sessionId: null, rows: [], readOnly: false },
  hitl: [],
  submission: null,
  tab: 'canvas',
  graphs: [],
  graphsSelectedId: null,
  graphsLoading: false,
  graphsError: null,
  models: null,
  modelsError: null,
  task: null,
  taskLoading: false,
  taskError: null,
  taskEpoch: 0,
  selectedRunId: null,
  access: 'current',
  readOnly: false,
  history: null,
  historyError: null,
  graphView: null,
  graphViewError: null,
  async boot() {
    get().source?.close()
    set({ source: null, error: null, bootError: null })
    let graphId = get().graphId
    if (graphId === null) {
      // A fresh page carries no ?graphId: the registry's selection is the graph to open.
      await get().loadGraphs()
      const selected = get().graphsSelectedId
      graphId = selected !== null && get().graphs.some(entry => entry.id === selected) ? selected : null
      if (graphId !== null) {
        set({ graphId })
        syncUrl(graphId)
      }
    }
    if (graphId === null) {
      set({
        empty: true,
        graph: null,
        layout: null,
        graphMeta: null,
        nodes: [],
        edges: [],
        selectedId: null,
        task: null,
        taskError: null,
        taskEpoch: get().taskEpoch + 1,
        selectedRunId: null,
      })
      return
    }
    const generation = get().generation + 1
    set({
      generation,
      empty: false,
      task: null,
      taskError: null,
      taskEpoch: get().taskEpoch + 1,
      selectedRunId: null,
      history: null,
      historyError: null,
      graphView: null,
      graphViewError: null,
    })
    try {
      const [view, hitl] = await Promise.all([fetchGraph(graphId), fetchHitl()])
      if (get().generation !== generation) return
      const mode: AccessMode = view.access.mode === 'current' ? 'current' : 'legacy-readonly'
      set({ access: mode, readOnly: readOnlyOf(mode), graphMeta: view.meta })
      if (readOnlyOf(mode)) {
        // A sealed graph is history: no canvas, no event stream, no session — only its own read.
        set({ selectedId: null, nodes: [], edges: [], graph: null, layout: null, hitl: hitl.pending })
        await get().openHistory()
        return
      }
      set({ selectedId: view.meta.rootSessionId })
      get().applySnapshot(view)
      const source = openEvents(graphId, {
        onSnapshot: view => {
          if (get().generation === generation) get().applySnapshot(view)
        },
        onHitl: pending => {
          if (get().generation === generation) get().applyHitl(pending)
        },
        onTask: hint => {
          if (get().generation !== generation) return
          const storeId = get().taskStoreId()
          if (hint.storeId !== undefined && storeId !== null && hint.storeId !== storeId) return
          if (get().task !== null) void get().loadTask()
        },
        onMethods: () => {
          if (get().generation === generation && get().graphView !== null) void get().loadView()
        },
        onError: () => {
          set({ error: 'singularity: event stream closed' })
        },
      })
      set({ hitl: hitl.pending, source })
      postOpen(get().graphId, view.meta.rootSessionId)
    } catch (error) {
      if (get().generation !== generation) return
      set({
        bootError: message(error),
        graph: null,
        layout: null,
        graphMeta: null,
        nodes: [],
        edges: [],
        selectedId: null,
      })
    }
  },
  applySnapshot({ graph, layout, meta, access }) {
    if (meta.id !== get().graphId) throw new Error('map: wrong graph snapshot')
    if (access.mode !== 'current') throw new Error('map: a sealed graph has no canvas')
    if (graph === null || layout === null) {
      // A registered graph whose own stores do not exist yet: the console says so
      // instead of drawing a canvas nobody wrote, and nothing is created for it.
      set({
        graph: null,
        layout: null,
        graphMeta: meta,
        nodes: [],
        edges: [],
        error: 'singularity: this graph has no topology store yet',
      })
      return
    }
    if (graph.id !== meta.graphStoreId || layout.id !== meta.layoutStoreId)
      throw new Error('map: store identity mismatch')
    const selectedId = get().selectedId
    if (selectedId !== null && !graph.agents.some(agent => agent.id === selectedId))
      throw new Error('map: selected agent missing')
    const next = build(graph, layout, selectedId)
    set({ graph, layout, graphMeta: meta, ...next, empty: false })
  },
  applyHitl(pending) {
    set({ hitl: pending })
  },
  applyChat(sessionId, rows, readOnly) {
    set({ chat: { sessionId, rows, readOnly } })
  },
  setSelected(id) {
    const graph = get().graph
    const layout = get().layout
    if (graph === null || layout === null) throw new Error('map: cannot select before boot')
    const { nodes, edges } = build(graph, layout, id)
    set({ selectedId: id, nodes, edges })
    if (id !== null) postOpen(get().graphId, id, graph.agents.find(agent => agent.id === id)?.name, spawnParent(id, edges))
  },
  setPaper(paper) {
    document.documentElement.dataset.paper = paper
    set({ paper })
  },
  setTab(tab) {
    set({ tab })
  },
  setNodes(nodes) {
    set({ nodes })
  },
  async moveNode(id, x, y) {
    if (get().readOnly) throw new Error('map: this graph is sealed legacy history; its canvas is read-only')
    const layout = get().layout
    const graphId = get().graphId
    if (layout === null || graphId === null) throw new Error('map: layout missing')
    const prev = layout.nodes[id]
    if (prev === undefined) throw new Error(`map: unknown node ${id}`)
    const node: CanvasNode = { ...prev, x, y }
    await putLayout(graphId, id, node)
  },
  async sendPrompt(sessionId, text) {
    if (get().readOnly) throw new Error('map: this graph is sealed legacy history; it takes no prompt')
    if (get().submission !== null) throw new Error('map: prompt already submitting')
    const requestId = crypto.randomUUID()
    const done = new Promise<void>((resolve, reject) => set({ submission: { id: requestId, resolve, reject } }))
    window.parent.postMessage(
      { type: 'singularity:prompt', graphId: get().graphId, requestId, sessionId, text },
      location.origin,
    )
    return done
  },
  finishPrompt(id, error) {
    const submission = get().submission
    if (submission === null || submission.id !== id) throw new Error('map: unexpected prompt result')
    set({ submission: null })
    if (error !== undefined) submission.reject(new Error(error))
    else submission.resolve()
  },
  async answerHitl(id, answer) {
    if (get().readOnly) throw new Error('map: this graph is sealed legacy history; it takes no intervention')
    // The list is the SSE stream's to publish: a response that lands after a newer frame must not overwrite it.
    await answerHitl(id, answer)
  },
  async loadGraphs() {
    set({ graphsLoading: true, graphsError: null })
    try {
      const data = await fetchGraphs()
      set({
        graphs: [...(data.graphs ?? [])],
        graphsSelectedId: data.selectedId ?? null,
        graphsLoading: false,
      })
    } catch (error) {
      set({ graphsLoading: false, graphsError: message(error) })
    }
  },
  async switchGraph(id) {
    // The registry's own access mode decides how the graph is opened; a sealed
    // graph is never selected, because selecting it is a write.
    await get().loadGraphs()
    const entry = get().graphs.find(graph => graph.id === id)
    if (entry?.access?.mode !== 'legacy-readonly') await selectGraph(id)
    set({ graphId: id, graphsError: null })
    setStoreOverride(null)
    syncUrl(id)
    await get().boot()
    await get().loadGraphs()
  },
  async createGraph(body) {
    const created = await createGraph(body)
    await get().switchGraph(created.id)
    return created.id
  },
  async removeGraph(id) {
    await deleteGraph(id)
    await get().loadGraphs()
    if (get().graphId !== id) return
    const next = get().graphsSelectedId
    if (next === null) {
      set({ graphId: null })
      syncUrl(null)
      await get().boot()
      return
    }
    await get().switchGraph(next)
  },
  async loadModels() {
    if (get().models !== null) return
    set({ modelsError: null })
    try {
      const data = await fetchModels()
      set({ models: data })
    } catch (error) {
      set({ modelsError: message(error) })
    }
  },
  async updateGraphModel(id, model) {
    await get().updateGraphSettings(id, { model })
  },
  async updateGraphRsi(id, rsi) {
    await get().updateGraphSettings(id, { rsi })
  },
  async updateGraphSettings(id, settings) {
    if (get().readOnly) throw new Error('map: this graph is sealed legacy history; its settings are read-only')
    await patchGraph(id, settings)
    await get().loadGraphs()
  },
  taskStoreId() {
    const meta = get().graphMeta
    if (meta === null) return null
    return taskStoreId(meta.rootSessionId)
  },
  async loadTask() {
    const storeId = get().taskStoreId()
    if (storeId === null) {
      set({ task: null, taskLoading: false, taskError: null })
      return
    }
    const epoch = get().taskEpoch + 1
    set({ taskEpoch: epoch, taskLoading: true, taskError: null })
    try {
      const data = await fetchTask(storeId)
      if (get().taskEpoch !== epoch) return
      set({ task: data.snapshot ?? null, taskLoading: false })
    } catch (error) {
      if (get().taskEpoch !== epoch) return
      set({ taskLoading: false, taskError: message(error) })
    }
  },
  setSelectedRun(id) {
    set({ selectedRunId: id })
  },
  async loadView() {
    const graphId = get().graphId
    if (graphId === null) {
      set({ graphView: null, graphViewError: null })
      return
    }
    set({ graphViewError: null })
    try {
      const data = await fetchView(graphId)
      if (get().graphId !== graphId) return
      set({ graphView: data })
    } catch (error) {
      if (get().graphId !== graphId) return
      set({ graphViewError: message(error) })
    }
  },
  async openHistory() {
    const graphId = get().graphId
    if (graphId === null) {
      set({ history: null, historyError: null })
      return
    }
    set({ historyError: null })
    try {
      const data = await fetchHistory(graphId)
      if (get().graphId !== graphId) return
      set({ history: data, historyError: null, graphMeta: metaOf(data.graph) })
    } catch (error) {
      if (get().graphId !== graphId) return
      set({ history: null, historyError: message(error) })
    }
  },
}))

/** The registry record a legacy history carries as the console's own meta; it is the same record the list serves. */
function metaOf(entry: GraphEntry): GraphMeta {
  const { id, name, ready, graphStoreId, layoutStoreId, rootSessionId } = entry
  if (graphStoreId === undefined || layoutStoreId === undefined || rootSessionId === undefined) {
    throw new Error(`map: graph "${id}" is missing the store identities its history needs`)
  }
  return { id, name, ready, graphStoreId, layoutStoreId, rootSessionId }
}

function postOpen(graphId: string | null, sessionId: string, title?: string, parentSessionId?: string): void {
  window.parent.postMessage(
    {
      type: 'singularity:open',
      graphId,
      sessionId,
      ...(title === undefined ? {} : { title }),
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    },
    location.origin,
  )
}

export function pathIds(selectedId: string | null, edges: FlowEdge[]): Set<string> {
  return ancestors(selectedId, edges)
}

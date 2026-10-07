import { create } from 'zustand'
import type { Edge, Node } from '@xyflow/react'
import type {
  AgentData,
  CanvasNode,
  CreateGraphBody,
  EvolutionResponse,
  GraphEntry,
  GraphSnapshot,
  LayoutSnapshot,
  ModelRef,
  ModelsResponse,
  ProposalDecision,
  RsiConfig,
  TaskSnapshotWire,
} from './types'
import {
  answerHitl,
  createGraph,
  decideProposal,
  deleteGraph,
  fetchEvolution,
  fetchGraph,
  fetchGraphs,
  fetchHitl,
  fetchModels,
  fetchTask,
  INITIAL_GRAPH_ID,
  openEvents,
  patchGraph,
  putLayout,
  selectGraph,
  setStoreOverride,
  taskStoreId,
  type ViewSnapshot,
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
  evolution: EvolutionResponse | null
  evolutionError: string | null
  evolutionEpoch: number
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
  taskStoreId: () => string | null
  loadTask: () => Promise<void>
  setSelectedRun: (id: string | null) => void
  decideProposal: (proposalId: string, decision: ProposalDecision, reason?: string) => Promise<void>
  loadEvolution: () => Promise<void>
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
  evolution: null,
  evolutionError: null,
  evolutionEpoch: 0,
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
    })
    try {
      const [view, hitl] = await Promise.all([fetchGraph(graphId), fetchHitl()])
      if (get().generation !== generation) return
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
        onEvolution: () => {
          if (get().generation === generation && get().evolution !== null) void get().loadEvolution()
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
  applySnapshot({ graph, layout, meta }) {
    if (meta.id !== get().graphId) throw new Error('map: wrong graph snapshot')
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
    const layout = get().layout
    const graphId = get().graphId
    if (layout === null || graphId === null) throw new Error('map: layout missing')
    const prev = layout.nodes[id]
    if (prev === undefined) throw new Error(`map: unknown node ${id}`)
    const node: CanvasNode = { ...prev, x, y }
    await putLayout(graphId, id, node)
  },
  async sendPrompt(sessionId, text) {
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
    await selectGraph(id)
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
    await patchGraph(id, { model })
    await get().loadGraphs()
  },
  async updateGraphRsi(id, rsi) {
    await patchGraph(id, { rsi })
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
  async decideProposal(proposalId, decision, reason) {
    const storeId = get().taskStoreId()
    if (storeId === null) throw new Error('map: no graph selected')
    const result = await decideProposal({
      storeId,
      proposalId,
      decision,
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
    })
    if (!result.ok) throw new Error(result.error ?? 'map: proposal decision refused')
    await get().loadTask()
  },
  async loadEvolution() {
    const epoch = get().evolutionEpoch + 1
    set({ evolutionEpoch: epoch, evolutionError: null })
    try {
      const data = await fetchEvolution()
      if (get().evolutionEpoch !== epoch) return
      set({ evolution: data })
    } catch (error) {
      if (get().evolutionEpoch !== epoch) return
      set({ evolutionError: message(error) })
    }
  },
}))

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

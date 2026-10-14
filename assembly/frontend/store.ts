import { create } from 'zustand'
import type { Node, Edge } from '@xyflow/react'
import type { ControlSnapshot } from '../src/snapshot.ts'
import type { AgentData, ChatRow } from './types.ts'
export type FlowNode = Node<AgentData & Record<string, unknown>, 'agent'>
export type FlowEdge = Edge<{ kind: 'decomposition' | 'dependency' | 'review' | 'improve' | 'evaluation'; brief: string }>
interface State {
  snapshot: ControlSnapshot | null
  nodes: FlowNode[]
  edges: FlowEdge[]
  selectedId: string | null
  chat: { sessionId: string | null; rows: ChatRow[]; error: string | null }
  error: string | null
  setSelected(id: string | null): void
  receive(snapshot: ControlSnapshot): void
}
export const useStore = create<State>((set, get) => ({
  snapshot: null, nodes: [], edges: [], selectedId: null, error: null,
  chat: { sessionId: null, rows: [], error: null },
  setSelected: id => {
    set({ selectedId: id, chat: { sessionId: null, rows: [], error: null } })
    const task = get().snapshot?.tasks.find(task => task.taskId === id)
    window.parent.postMessage({ type: 'singularity:open', sessionId: task?.sessionId ?? null }, location.origin)
  },
  receive: snapshot => {
    if (snapshot.formatVersion !== 5) throw new Error('Unsupported Singularity snapshot')
    const childIds = new Set(snapshot.plans.flatMap(plan => plan.children.map(child => child.taskId)))
    const nodes: FlowNode[] = snapshot.tasks.map(task => {
      const geometry = snapshot.geometry[task.taskId]!
      return { id: task.taskId, type: 'agent', position: { x: geometry.x, y: geometry.y }, selected: task.taskId === get().selectedId,
        data: { name: task.goal, root: task.purpose === 'solve' && !childIds.has(task.taskId), width: geometry.width, height: geometry.height,
          status: task.phase === 'verified' ? 'done' : task.phase === 'failed' ? 'failed' : task.phase === 'running' ? 'running' : 'idle' } }
    })
    const edges: FlowEdge[] = snapshot.plans.flatMap(plan => plan.children.flatMap(child => [
      { id: `${plan.parentTaskId}/${child.taskId}`, source: plan.parentTaskId, target: child.taskId, type: 'agent', data: { kind: 'decomposition' as const, brief: child.supports.join(', ') } },
      ...child.dependsOn.map(producer => ({ id: `${producer}->${child.taskId}`, source: producer, target: child.taskId, type: 'agent', data: { kind: 'dependency' as const, brief: 'artifact' } })),
    ]))
    for (const task of snapshot.tasks) if (task.relatedTo !== null) edges.push({
      id: `${task.relatedTo.taskId}/${task.taskId}`, source: task.relatedTo.taskId, target: task.taskId, type: 'agent',
      data: { kind: task.purpose === 'improve' ? 'improve' : task.purpose === 'evaluation' ? 'evaluation' : 'review', brief: task.purpose } })
    set({ snapshot, nodes, edges, error: null })
  },
}))
export function pathIds(selected: string | null, edges: FlowEdge[]): Set<string> {
  const ids = new Set(selected === null ? [] : [selected])
  let changed = true
  while (changed) {
    changed = false
    for (const edge of edges) if (ids.has(edge.target) && !ids.has(edge.source)) { ids.add(edge.source); changed = true }
  }
  return ids
}

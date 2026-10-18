import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './style.css'
import AgentNode from './components/AgentNode.tsx'
import AgentEdge from './components/AgentEdge.tsx'
import FocusPanel from './components/FocusPanel.tsx'
import { useStore } from './store.ts'
const nodeTypes = { agent: AgentNode }, edgeTypes = { agent: AgentEdge }
function Canvas() {
  const nodes = useStore(state => state.nodes), edges = useStore(state => state.edges)
  const error = useStore(state => state.error), snapshot = useStore(state => state.snapshot)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const response = await fetch('/singularity/tasks', { signal: controller.signal })
        if (!response.ok) throw new Error(await response.text())
        useStore.getState().receive(await response.json())
      } catch (error) { if (!controller.signal.aborted) useStore.setState({ error: String(error) }) }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 1500)
    }
    void refresh()
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent) return
      const state = useStore.getState()
      const sessionId = state.snapshot?.tasks.find(task => task.taskId === state.selectedId)?.sessionId
        ?? state.snapshot?.reviews.find(review => review.reviewId === state.selectedId)?.sessionId
      if (!sessionId || event.data?.sessionId !== sessionId) return
      if (event.data.type === 'singularity:transcript') useStore.setState({ chat: { sessionId: event.data.sessionId, rows: event.data.rows, error: null } })
      if (event.data.type === 'singularity:session-error') useStore.setState(state => ({ chat: { ...state.chat, error: event.data.message } }))
    }
    window.addEventListener('message', receive)
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('message', receive) }
  }, [])
  return <div className="sg-shell"><div className="sg-toolbar">Singularity · {snapshot?.controlId} · committed #{snapshot?.cutoff}
    {error && <span role="alert">{error}</span>}</div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesDraggable={false} nodesConnectable={false}
      deleteKeyCode={null} minZoom={0.04} maxZoom={2} fitView proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => useStore.getState().setSelected(node.id)} onPaneClick={() => useStore.getState().setSelected(null)}>
      <Background /><Controls showInteractive={false} /><MiniMap pannable zoomable />
    </ReactFlow><FocusPanel />
  </div>
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><Canvas /></ReactFlowProvider>)

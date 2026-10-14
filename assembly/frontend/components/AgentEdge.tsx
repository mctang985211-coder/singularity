import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { pathIds, useStore, type FlowEdge } from '../store.ts'
export default function AgentEdge(props: EdgeProps<FlowEdge>) {
  const edges = useStore(state => state.edges)
  const selected = useStore(state => state.selectedId)
  const path = pathIds(selected, edges)
  const highlighted = selected !== null && path.has(props.source) && path.has(props.target)
  const [line, x, y] = getSmoothStepPath(props)
  return <>
    <BaseEdge path={line} style={{ stroke: highlighted ? '#69dbbc' : '#8390a5', strokeWidth: highlighted ? 2.5 : 1.6,
      strokeDasharray: props.data?.kind === 'dependency' ? '8 4' : undefined }} />
    {props.data?.brief && <EdgeLabelRenderer><div className="sg-edge-label" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>{props.data.brief}</div></EdgeLabelRenderer>}
  </>
}

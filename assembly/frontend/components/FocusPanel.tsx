import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.ts'
export default function FocusPanel() {
  const id = useStore(state => state.selectedId)
  const snapshot = useStore(state => state.snapshot)
  const chat = useStore(state => state.chat)
  const [draft, setDraft] = useState('')
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current !== null) list.current.scrollTop = list.current.scrollHeight }, [chat.rows])
  const task = snapshot?.tasks.find(task => task.taskId === id)
  if (task === undefined) return null
  return <aside className="sg-focus">
    <header><strong>{task.purpose} · {task.phase}</strong><button onClick={() => useStore.getState().setSelected(null)}>×</button></header>
    <div className="sg-focus-detail"><p>{task.goal}</p><small>{task.taskId}<br />{task.sessionId}</small>
      <details><summary>验收、资产与证据</summary><pre>{JSON.stringify({ bindings: task.bindings, runs: task.runs,
        dependencies: snapshot?.plans.filter(plan => plan.parentTaskId === task.taskId || plan.children.some(child => child.taskId === task.taskId)),
        rounds: snapshot?.rounds, releases: snapshot?.releases }, null, 2)}</pre></details></div>
    <div className="sg-focus-msgs" ref={list}>{chat.rows.map((row, index) => <article key={index} data-role={row.role}><small>{row.role}</small><pre>{row.text}</pre></article>)}</div>
    {chat.error && <p role="alert">{chat.error}</p>}
    <form onSubmit={event => { event.preventDefault(); window.parent.postMessage({ type: 'singularity:prompt', sessionId: task.sessionId, text: draft }, location.origin); setDraft('') }}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="继续此节点的 DSH 会话" />
      <button disabled={task.sessionId === null || draft.trim().length === 0}>发送</button>
    </form>
  </aside>
}

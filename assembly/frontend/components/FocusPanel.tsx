import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.ts'
export default function FocusPanel() {
  const id = useStore((state) => state.selectedId)
  const snapshot = useStore((state) => state.snapshot)
  const chat = useStore((state) => state.chat)
  const [draft, setDraft] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current !== null) list.current.scrollTop = list.current.scrollHeight }, [chat.rows])
  const task = snapshot?.tasks.find((task) => task.taskId === id)
  const review = snapshot?.reviews.find((review) => review.reviewId === id)
  const usedSlots = task?.search?.batches?.reduce((sum, batch) => sum + batch.slots.length, 0) ?? 0
  const searchOutcome = task?.search && 'outcome' in task.search ? task.search.outcome : undefined
  if (task === undefined && review === undefined) return null
  const sessionId = task?.sessionId ?? review!.sessionId
  const canCancel = task?.purpose === 'solve' && !snapshot?.plans.some(plan => plan.children.some(child => child.taskId === task.taskId)) &&
    (task.runs.at(-1)?.status === 'running' || ['pending', 'running', 'failed'].includes(task.rsi?.status ?? ''))
  return (
    <aside className="sg-focus">
    <header><strong>{task?.purpose ?? 'review'} · {task?.phase ?? review!.status}</strong><button onClick={() => useStore.getState().setSelected(null)}>×</button></header>
    <div className="sg-focus-detail"><p>{task?.goal ?? review!.criteria.map((c) => c.statement).join('; ')}</p>
      {task?.rsi && <p role="status">学习状态：{{ pending: '等待启动', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[task.rsi.status]}</p>}
      {canCancel && <button disabled={cancelling || sessionId === null} onClick={async () => {
        setCancelling(true)
        try {
          const response = await fetch('/singularity/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, taskId: task.taskId }) })
          if (!response.ok) throw new Error(await response.text())
        } catch (error) { useStore.setState({ error: String(error) }) }
        finally { setCancelling(false) }
      }}>{task.closure ? '停止学习' : '取消任务'}</button>}
      {searchOutcome && <p role="status">学习结果：{{ improved: '已发布改进', 'no-improvement': '未发现改进', 'insufficient-evidence': '证据不足' }[searchOutcome]}（候选 {usedSlots}/{task!.search!.maxProposals}）</p>}
      {task?.coordination.waiting && <p role="status">等待：{task.coordination.waiting}</p>}
        <small>
          {id}
          <br />
          {sessionId}</small>
      <details><summary>验收、资产与证据</summary><pre>{JSON.stringify({ bindings: task?.bindings,
                coordination: task?.coordination,
                closure: task?.closure,
                rsi: task?.rsi,
                search: task?.search,
                requests: task?.requests,
                runs: task?.runs,
                review,
                dependencies: snapshot?.plans.filter(
                  (plan) => plan.parentTaskId === id || plan.children.some((child) => child.taskId === id),
                ),
        rounds: snapshot?.rounds, releases: snapshot?.releases,
              },
              null,
              2,
            )}</pre></details></div>
    <div className="sg-focus-msgs" ref={list}>{chat.rows.map((row, index) => (
          <article key={index} data-role={row.role}><small>{row.role}</small><pre>{row.text}</pre></article>))}</div>
    {chat.error && <p role="alert">{chat.error}</p>}
    <form onSubmit={(event) => {
          event.preventDefault()
          window.parent.postMessage({ type: 'singularity:prompt', sessionId, text: draft }, location.origin)
          setDraft('') }}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="继续此节点的 DSH 会话" />
      <button disabled={sessionId === null || draft.trim().length === 0}>发送</button>
    </form>
  </aside>
  )
}

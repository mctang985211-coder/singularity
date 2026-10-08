import { useEffect } from 'react'
import { asArray, shortId } from '../lib/task-data'
import { useStore } from '../store'
import type { TaskSnapshotWire } from '../types'

function when(value?: string): string {
  if (value === undefined || value.length === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** One opaque old record shown as its own JSON: the console never reinterprets what it cannot read. */
function RecordList({ rows, label }: { rows: readonly unknown[]; label: string }) {
  if (rows.length === 0) return <div className="sg-muted">No {label} recorded</div>
  return (
    <ul className="sg-list">
      {rows.map((row, index) => (
        <li key={`${label}-${index}`}>
          <pre className="sg-logtail">{JSON.stringify(row, null, 2)}</pre>
        </li>
      ))}
    </ul>
  )
}

function TaskHistory({ snapshot }: { snapshot: TaskSnapshotWire }) {
  const tasks = asArray(snapshot.tasks)
  const runs = asArray(snapshot.runs)
  return (
    <div className="sg-detail-block">
      <h4>Task snapshot</h4>
      <div className="sg-muted">
        {tasks.length} tasks · {runs.length} runs · {asArray(snapshot.reviews).length} reviews
      </div>
      <ul className="sg-list">
        {tasks.map(task => (
          <li key={task.taskId}>
            <code>{shortId(task.taskId, 18)}</code>
            <span> · {task.status ?? 'unknown'}</span>
            {task.objective === undefined ? null : <span> · {task.objective}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One sealed graph's history: its old records exactly as the server projects
 * them. Every write control in this console — dragging a node, Settings, Delete,
 * Clear RSI, Approve/Reject — belongs to the current-protocol panels and is not
 * rendered here.
 */
export default function HistoryPanel() {
  const graphId = useStore(s => s.graphId)
  const history = useStore(s => s.history)
  const historyError = useStore(s => s.historyError)
  const openHistory = useStore(s => s.openHistory)

  useEffect(() => {
    if (history === null && historyError === null) void openHistory()
  }, [history, historyError, openHistory])

  if (historyError !== null) {
    return (
      <div className="sg-panels">
        <div className="sg-error" role="alert">
          {historyError}
        </div>
      </div>
    )
  }
  if (history === null) {
    return <div className="sg-boot">{graphId === null ? 'Select a graph' : 'Loading legacy history…'}</div>
  }

  const agents = history.topology?.agents ?? []
  const nodes = Object.entries(history.layout?.nodes ?? {})

  return (
    <div className="sg-panels">
      <div className="sg-panel-head">
        <h2>{history.graph.name}</h2>
        <span className="sg-pill sealed">sealed · {history.formatVersion} · read-only</span>
        <span className="sg-muted">{history.access.reason ?? 'no protocol marker'}</span>
        <button type="button" className="sg-ghost" onClick={() => void openHistory()}>
          Refresh
        </button>
      </div>

      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Sources</h2>
        </div>
        <ul className="sg-list">
          {history.sources.map(source => (
            <li key={`${source.kind}-${source.id}`}>
              <code>{source.kind}</code>
              <span> {source.id}</span>
              <span> · {source.exists ? 'present' : 'absent'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Topology</h2>
          <span className="sg-count">{agents.length} sessions</span>
        </div>
        {agents.length === 0 ? (
          <div className="sg-muted">No topology recorded</div>
        ) : (
          <ul className="sg-list">
            {agents.map(agent => (
              <li key={String(agent.id)}>
                <code>{String(agent.id)}</code>
                <span> · {agent.name}</span>
                <span> · {agent.status}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="sg-panel-head">
          <h2>Layout (read-only)</h2>
          <span className="sg-count">{nodes.length} nodes</span>
        </div>
        <ul className="sg-list">
          {nodes.map(([id, node]) => (
            <li key={id}>
              <code>{String(id)}</code>
              <span>
                {' '}
                · {Math.round(node.x)},{Math.round(node.y)} · {node.width}×{node.height} · {node.shape}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {history.tasks === null ? (
        <div className="sg-muted">No task store exists for this graph</div>
      ) : (
        <TaskHistory snapshot={history.tasks} />
      )}

      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Legacy proposals</h2>
          <span className="sg-count">{history.proposals.length}</span>
        </div>
        <RecordList rows={history.proposals} label="legacy proposals" />
        {history.experiments.length > 0 && (
          <>
            <div className="sg-panel-head">
              <h2>Legacy experiments</h2>
            </div>
            <RecordList rows={history.experiments} label="legacy experiments" />
          </>
        )}
      </section>

      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Legacy completions</h2>
          <span className="sg-count">{history.completions.length}</span>
        </div>
        {history.completions.length === 0 ? (
          <div className="sg-muted">No legacy completion rows</div>
        ) : (
          <ul className="sg-list">
            {history.completions.map(completion => (
              <li key={`${completion.sessionId}-${completion.recordedAt}-${completion.taskId}`}>
                <span className="sg-badge">{completion.format}</span>
                <code>{shortId(completion.taskId, 18)}</code>
                <span> · {when(completion.recordedAt)}</span>
                <div className="sg-summary">{completion.note}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

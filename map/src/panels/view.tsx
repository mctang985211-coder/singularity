import { useEffect } from 'react'
import { useStore } from '../store'

const PHASES: Record<string, string> = {
  idle: 'not started',
  running: 'running',
  awaiting_approval: 'awaiting approval',
  stopped: 'stopped',
  finished: 'finished',
}

function when(value: string | null): string {
  if (value === null || value.length === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/**
 * The graph's read model: the active revision, the latest evaluation and the
 * derived progress — the same projection the tool plane reads, from
 * `GET /singularity/view`. The panel never assembles an evaluation of its own,
 * so what it shows and what a tool sees cannot disagree.
 */
export default function ViewPanel() {
  const graphId = useStore(s => s.graphId)
  const view = useStore(s => s.graphView)
  const viewError = useStore(s => s.graphViewError)
  const loadView = useStore(s => s.loadView)

  useEffect(() => {
    if (view === null && viewError === null) void loadView()
  }, [view, viewError, loadView])

  if (graphId === null) return <div className="sg-boot">Select a graph</div>

  return (
    <div className="sg-panels">
      <div className="sg-panel-head">
        <h2>Method state</h2>
        <button type="button" className="sg-ghost" onClick={() => void loadView()}>
          Refresh
        </button>
      </div>
      {viewError !== null && (
        <div className="sg-error" role="alert">
          {viewError}
        </div>
      )}
      {view === null ? (
        <div className="sg-empty">{viewError === null ? 'Loading the graph view…' : 'No view available'}</div>
      ) : (
        <>
          <section className="sg-panel-section">
            <div className="sg-panel-head">
              <h2>Progress</h2>
              <span className="sg-count">
                round {view.progress.round}/{view.progress.rounds || '—'} ·{' '}
                {PHASES[view.progress.phase] ?? view.progress.phase}
              </span>
              <span className="sg-muted">generation {view.generation}</span>
            </div>
            {view.progress.note === undefined ? null : <div className="sg-summary">{view.progress.note}</div>}
          </section>

          <section className="sg-panel-section">
            <div className="sg-panel-head">
              <h2>Active revision</h2>
            </div>
            {view.revision === null ? (
              <div className="sg-muted">No revision is pinned for this graph</div>
            ) : (
              <div className="sg-kv">
                <span>revision</span>
                <code>{view.revision.revisionId ?? '—'}</code>
                <span>digest</span>
                <code>{view.revision.manifestDigest ?? '—'}</code>
                <span>origin</span>
                <span>{view.revision.origin}</span>
                <span>published</span>
                <span>{when(view.revision.publishedAt)}</span>
              </div>
            )}
          </section>

          <section className="sg-panel-section">
            <div className="sg-panel-head">
              <h2>Latest evaluation</h2>
            </div>
            {view.evaluation === null ? (
              <div className="sg-muted">No evaluation recorded for this graph</div>
            ) : (
              <>
                <div className="sg-kv">
                  <span>state</span>
                  <span>{view.evaluation.state}</span>
                  <span>report</span>
                  <code>{view.evaluation.reportRef ?? '—'}</code>
                  <span>candidate</span>
                  <code>{view.evaluation.candidateRef ?? '—'}</code>
                  <span>decided</span>
                  <span>{when(view.evaluation.decidedAt)}</span>
                </div>
                {view.evaluation.decision !== undefined && (
                  <div className="sg-kv">
                    <span>decision</span>
                    <span>{view.evaluation.decision.kind}</span>
                    <span>approved by</span>
                    <span>
                      {view.evaluation.decision.source.kind}
                      {view.evaluation.decision.source.actor === undefined
                        ? ''
                        : ` · ${view.evaluation.decision.source.actor}`}
                      {view.evaluation.decision.by === undefined ? '' : ` · ${view.evaluation.decision.by}`}
                    </span>
                    <span>at</span>
                    <span>{when(view.evaluation.decision.at)}</span>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  )
}

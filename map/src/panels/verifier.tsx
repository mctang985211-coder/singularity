import { useEffect, useState } from 'react'
import { fetchReview } from '../api'
import StatusBadge from '../components/StatusBadge'
import { shortId } from '../lib/task-data'
import { useStore } from '../store'
import type { ReviewResponse, ReviewWire } from '../types'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function duration(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${seconds % 60} s`
}

/** Drill-down for one run's review record: criteria verdicts and the failing log tail. */
export function VerifierView({
  storeId,
  runId,
  review,
  logTail,
  loading,
  error,
  onRefresh,
}: {
  storeId: string | null
  runId: string | null
  review: ReviewWire | null
  logTail: string | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  if (runId === null) {
    return (
      <div className="sg-panels">
        <div className="sg-empty">
          No run selected — pick a run in the Tasks tab to inspect its review and log tail.
        </div>
      </div>
    )
  }
  const criteria = review?.criteria ?? []
  const tail = logTail ?? review?.logTail
  return (
    <div className="sg-panels">
      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Verifier</h2>
          {review !== null && <StatusBadge status={review.outcome} />}
          <code className="sg-card-id">{shortId(runId, 26)}</code>
          {storeId !== null && <span className="sg-muted">store {storeId}</span>}
          {loading && <span className="sg-muted">refreshing…</span>}
          <button type="button" className="sg-ghost" onClick={onRefresh}>
            Refresh
          </button>
        </div>
        {error !== null && (
          <div className="sg-error" role="alert">
            {error}
          </div>
        )}
        {!loading && review === null && error === null && (
          <div className="sg-empty">No review record for this run yet</div>
        )}
        {review !== null && (
          <>
            <div className="sg-kv">
              <span>task</span>
              <code>{review.taskId}</code>
              <span>run</span>
              <code>{review.runId ?? runId}</code>
              <span>session</span>
              <code>{review.sessionId ?? '—'}</code>
              <span>duration</span>
              <span>{duration(review.durationMs)}</span>
              <span>criteria</span>
              <span>{criteria.length}</span>
            </div>
            {review.localizedCause !== undefined && <div className="sg-summary">{review.localizedCause}</div>}
            {(review.anomalies ?? []).length > 0 && (
              <ul className="sg-list">
                {(review.anomalies ?? []).map((anomaly, index) => (
                  <li key={`${index}-${anomaly}`}>{anomaly}</li>
                ))}
              </ul>
            )}
            <div className="sg-detail-block">
              <h4>Criteria</h4>
              {criteria.length === 0 ? (
                <div className="sg-muted">No criterion verdicts recorded</div>
              ) : (
                <table className="sg-table">
                  <thead>
                    <tr>
                      <th>criterion</th>
                      <th>verdict</th>
                      <th>command</th>
                      <th>exit</th>
                      <th>log ref</th>
                      <th>unknown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {criteria.map(criterion => (
                      <tr key={criterion.criterionId}>
                        <td>
                          <code>{criterion.criterionId}</code>
                          {criterion.verifierId !== undefined && (
                            <div className="sg-muted">
                              {criterion.verifierId}
                              {criterion.verifierVersion === undefined ? '' : ` v${criterion.verifierVersion}`}
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={criterion.verdict} />
                        </td>
                        <td>{criterion.command === undefined ? '—' : <code>{criterion.command}</code>}</td>
                        <td>{criterion.exitCode ?? '—'}</td>
                        <td>{criterion.logRef === undefined ? '—' : <code>{criterion.logRef}</code>}</td>
                        <td>{criterion.unknownKind ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="sg-detail-block">
              <h4>Log tail</h4>
              {tail === undefined || tail.length === 0 ? (
                <div className="sg-muted">No log tail recorded</div>
              ) : (
                <pre className="sg-logtail">{tail}</pre>
              )}
            </div>
            {(review.evidenceRefs ?? []).length > 0 && (
              <div className="sg-detail-block">
                <h4>Evidence</h4>
                <div className="sg-refs">
                  {(review.evidenceRefs ?? []).map(ref => (
                    <code key={ref}>{ref}</code>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

export default function VerifierPanel() {
  const selectedRunId = useStore(s => s.selectedRunId)
  const taskStoreId = useStore(s => s.taskStoreId)
  const graphMeta = useStore(s => s.graphMeta)
  const empty = useStore(s => s.empty)
  const bootError = useStore(s => s.bootError)
  const rootSessionId = graphMeta?.rootSessionId ?? null
  const storeId = rootSessionId === null ? null : taskStoreId()
  const [data, setData] = useState<ReviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (storeId === null || selectedRunId === null) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    fetchReview(storeId, selectedRunId)
      .then(result => {
        if (!alive) return
        setData(result)
        setLoading(false)
      })
      .catch(cause => {
        if (!alive) return
        setError(message(cause))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [storeId, selectedRunId, epoch])

  if (bootError !== null) {
    return <div className="sg-boot">{bootError}</div>
  }
  if (empty || graphMeta === null) {
    return <div className="sg-boot">Select or create a graph</div>
  }

  return (
    <VerifierView
      storeId={storeId}
      runId={selectedRunId}
      review={data?.review ?? null}
      logTail={data?.logTail ?? null}
      loading={loading}
      error={error}
      onRefresh={() => setEpoch(value => value + 1)}
    />
  )
}

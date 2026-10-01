import { useEffect, useState } from 'react'
import { fetchRecovery } from '../api'
import StatusBadge from '../components/StatusBadge'
import { useStore } from '../store'
import type { ReconcileReportWire, RecoveryResponse, RecoveryStateWire } from '../types'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="sg-stat">
      <span className="sg-label">{label}</span>
      <span className="sg-stat-value">{value}</span>
    </div>
  )
}

/** Read-only operator view of one store's recovery barrier and its reconcile pass. */
export function RecoveryView({
  storeId,
  recovery,
  reconcile,
  loading,
  error,
  onRefresh,
}: {
  storeId: string | null
  recovery: RecoveryStateWire | null
  reconcile: ReconcileReportWire | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const woken = recovery?.wokenSessions ?? []
  const notices = recovery?.pendingNotices ?? []
  const batchResults = recovery?.pendingBatchResults ?? []
  const unresolved = reconcile?.unresolvedProposals ?? []
  const deliveries = reconcile?.questionDeliveries ?? []
  const resumes = reconcile?.questionResumes ?? []
  return (
    <div className="sg-panels">
      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Recovery</h2>
          <StatusBadge status={recovery?.status ?? 'unknown'} />
          {storeId !== null && <code className="sg-card-id">{storeId}</code>}
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
        {recovery?.reason !== undefined && <div className="sg-summary">{recovery.reason}</div>}
        <div className="sg-cards">
          <StatCard label="Woken sessions" value={woken.length} />
          <StatCard label="Pending notices" value={notices.length} />
          <StatCard label="Pending batch results" value={batchResults.length} />
          <StatCard label="Cancelled" value={recovery?.cancelled === true ? 'yes' : 'no'} />
        </div>
        {woken.length > 0 && (
          <div className="sg-refs">
            {woken.map(sessionId => (
              <code key={sessionId}>{sessionId}</code>
            ))}
          </div>
        )}
        {notices.length > 0 && (
          <div className="sg-detail-block">
            <h4>Pending notices</h4>
            <table className="sg-table">
              <thead>
                <tr>
                  <th>session</th>
                  <th>notice</th>
                </tr>
              </thead>
              <tbody>
                {notices.map((notice, index) => (
                  <tr key={`${notice.sessionId ?? 'notice'}-${index}`}>
                    <td>
                      <code>{notice.sessionId ?? '—'}</code>
                    </td>
                    <td>{notice.text ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {batchResults.length > 0 && (
          <div className="sg-detail-block">
            <h4>Pending batch results</h4>
            <table className="sg-table">
              <thead>
                <tr>
                  <th>batch</th>
                  <th>run</th>
                  <th>session</th>
                  <th>message</th>
                </tr>
              </thead>
              <tbody>
                {batchResults.map((result, index) => (
                  <tr key={`${result.batchId ?? 'batch'}-${index}`}>
                    <td>
                      <code>{result.batchId ?? '—'}</code>
                    </td>
                    <td>
                      <code>{result.runId ?? '—'}</code>
                    </td>
                    <td>
                      <code>{result.sessionId ?? '—'}</code>
                    </td>
                    <td>
                      <code>{result.messageId ?? '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Reconcile report</h2>
          <span className="sg-count">
            {unresolved.length} unresolved · {deliveries.length} deliveries · {resumes.length} resumes
          </span>
        </div>
        {reconcile === null ? (
          <div className="sg-empty">No reconcile report for this store</div>
        ) : (
          <>
            <div className="sg-detail-block">
              <h4>Unresolved proposals</h4>
              {unresolved.length === 0 ? (
                <div className="sg-muted">None</div>
              ) : (
                <table className="sg-table">
                  <thead>
                    <tr>
                      <th>proposal</th>
                      <th>status</th>
                      <th>reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unresolved.map((row, index) => (
                      <tr key={row.proposalId ?? `proposal-${index}`}>
                        <td>
                          <code>{row.proposalId ?? '—'}</code>
                        </td>
                        <td>
                          <StatusBadge status={row.status ?? 'unknown'} />
                        </td>
                        <td>{row.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="sg-detail-block">
              <h4>Question deliveries</h4>
              {deliveries.length === 0 ? (
                <div className="sg-muted">None</div>
              ) : (
                <table className="sg-table">
                  <thead>
                    <tr>
                      <th>subject</th>
                      <th>message</th>
                      <th>status</th>
                      <th>reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((row, index) => (
                      <tr key={`${row.messageId ?? 'delivery'}-${index}`}>
                        <td>{row.subject ?? '—'}</td>
                        <td>
                          <code>{row.messageId ?? '—'}</code>
                        </td>
                        <td>
                          <StatusBadge status={row.status ?? 'unknown'} />
                        </td>
                        <td>{row.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="sg-detail-block">
              <h4>Question resumes</h4>
              {resumes.length === 0 ? (
                <div className="sg-muted">None</div>
              ) : (
                <table className="sg-table">
                  <thead>
                    <tr>
                      <th>subject</th>
                      <th>status</th>
                      <th>reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resumes.map((row, index) => (
                      <tr key={`${row.subject ?? 'resume'}-${index}`}>
                        <td>{row.subject ?? '—'}</td>
                        <td>
                          <StatusBadge status={row.status ?? 'unknown'} />
                        </td>
                        <td>{row.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

export default function RecoveryPanel() {
  const taskStoreId = useStore(s => s.taskStoreId)
  const graphMeta = useStore(s => s.graphMeta)
  const empty = useStore(s => s.empty)
  const bootError = useStore(s => s.bootError)
  const rootSessionId = graphMeta?.rootSessionId ?? null
  const storeId = rootSessionId === null ? null : taskStoreId()
  const [data, setData] = useState<RecoveryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (storeId === null) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    fetchRecovery(storeId)
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
  }, [storeId, epoch])

  if (bootError !== null) {
    return <div className="sg-boot">{bootError}</div>
  }
  if (empty || graphMeta === null) {
    return <div className="sg-boot">Select or create a graph</div>
  }

  return (
    <RecoveryView
      storeId={storeId}
      recovery={data?.recovery ?? null}
      reconcile={data?.reconcile ?? null}
      loading={loading}
      error={error}
      onRefresh={() => setEpoch(value => value + 1)}
    />
  )
}

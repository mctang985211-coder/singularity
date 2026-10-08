import { useEffect } from 'react'
import { shortId } from '../lib/task-data'
import { useStore } from '../store'

function at(ms: number): string {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/**
 * The library's method surface: the effective revision, every v5 draft with its
 * status and last verdict, and the publication approval a person has not
 * answered yet — the same v5 ledger and environment pointer the `method_*` tools
 * read, from `GET /singularity/methods`. Nothing here is assembled locally: a
 * publication is answered through the existing HITL card, never a second write
 * path.
 */
export default function MethodsPanel() {
  const graphId = useStore(s => s.graphId)
  const methods = useStore(s => s.methods)
  const methodsError = useStore(s => s.methodsError)
  const loadMethods = useStore(s => s.loadMethods)

  useEffect(() => {
    if (methods === null && methodsError === null) void loadMethods()
  }, [methods, methodsError, loadMethods])

  if (graphId === null) return <div className="sg-boot">Select a graph</div>

  return (
    <div className="sg-panels">
      <div className="sg-panel-head">
        <h2>Method library</h2>
        <button type="button" className="sg-ghost" onClick={() => void loadMethods()}>
          Refresh
        </button>
      </div>
      {methodsError !== null && (
        <div className="sg-error" role="alert">
          {methodsError}
        </div>
      )}
      {methods === null ? (
        <div className="sg-empty">{methodsError === null ? 'Loading the method surface…' : 'No method surface available'}</div>
      ) : (
        <>
          <section className="sg-panel-section">
            <div className="sg-panel-head">
              <h2>Effective revision</h2>
              <span className="sg-muted">
                {methods.environment.readOnly ? 'read-only' : methods.environment.protocol}
              </span>
            </div>
            <div className="sg-kv">
              <span>library</span>
              <code>{methods.libraryId}</code>
              <span>revision</span>
              <code>{methods.environment.revisionId}</code>
              <span>digest</span>
              <code>{shortId(methods.environment.manifestDigest, 16)}</code>
              <span>generation</span>
              <span>{methods.environment.generation}</span>
            </div>
            {methods.intent === null ? null : (
              <div className="sg-summary">
                open pointer switch {methods.intent.intentId} ({methods.intent.direction} → {methods.intent.next.revisionId})
              </div>
            )}
          </section>

          <section className="sg-panel-section">
            <div className="sg-panel-head">
              <h2>Drafts</h2>
              <span className="sg-count">{methods.drafts.length}</span>
            </div>
            {methods.drafts.length === 0 ? (
              <div className="sg-muted">No drafts recorded for this library</div>
            ) : (
              <ul className="sg-list">
                {methods.drafts.map(draft => (
                  <li key={draft.draftId}>
                    <code>{draft.draftId}</code>
                    <span className="sg-badge">{draft.status}</span>
                    <span>
                      {' '}
                      · {draft.kind} “{draft.identity}”
                    </span>
                    {draft.evaluation?.verdict === undefined ? null : <span> · verdict {draft.evaluation.verdict}</span>}
                    {draft.admission?.admissible === false ? <span> · refused {draft.admission.reasonCode}</span> : null}
                    {draft.published == null ? null : <span> · published {draft.published.revisionId}</span>}
                    <div className="sg-summary">{draft.rationale}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sg-panel-section">
            <div className="sg-panel-head">
              <h2>Publication approvals</h2>
              <span className="sg-count">{methods.approvals.length}</span>
            </div>
            {methods.approvals.length === 0 ? (
              <div className="sg-muted">No publication is waiting for an answer</div>
            ) : (
              <ul className="sg-list">
                {methods.approvals.map(approval => (
                  <li key={approval.id}>
                    <code>{shortId(approval.id, 18)}</code>
                    <span> · {at(approval.createdAt)}</span>
                    <div className="sg-summary">{approval.prompt}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {methods.viewRefusal === null ? null : (
            <section className="sg-panel-section">
              <div className="sg-panel-head">
                <h2>Graph view</h2>
              </div>
              <div className="sg-error" role="alert">
                {methods.viewRefusal}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

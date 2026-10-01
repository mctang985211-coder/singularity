import { useEffect, useMemo, useState } from 'react'
import HitlCard from '../components/HitlCard'
import StatusBadge from '../components/StatusBadge'
import { proposalsOf, shortId } from '../lib/task-data'
import { useStore } from '../store'
import type { ProposalDecision, TaskContractWire, TaskProposalChildWire, TaskProposalWire } from '../types'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function when(value?: string): string {
  if (value === undefined || value.length === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function ContractView({ contract, label }: { contract?: TaskContractWire; label: string }) {
  const criteria = contract?.acceptanceCriteria ?? []
  return (
    <div className="sg-dossier-child">
      <div className="sg-dossier-child-head">
        <strong>{label}</strong>
        <span>{contract?.objective ?? '(no objective)'}</span>
      </div>
      {criteria.length > 0 && (
        <table className="sg-table">
          <thead>
            <tr>
              <th>criterion</th>
              <th>mode</th>
              <th>mandatory</th>
              <th>command</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((criterion, index) => (
              <tr key={criterion.criterionId ?? `criterion-${index}`}>
                <td>
                  <code>{criterion.criterionId ?? `#${index + 1}`}</code>
                  {criterion.description !== undefined && <div className="sg-muted">{criterion.description}</div>}
                </td>
                <td>{criterion.verificationMode ?? '—'}</td>
                <td>{criterion.mandatory === true ? 'yes' : 'no'}</td>
                <td>{criterion.command === undefined ? '—' : <code>{criterion.command}</code>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(contract?.assumptions ?? []).length > 0 && (
        <div className="sg-dossier-list">
          <span className="sg-label">Assumptions</span>
          <ul className="sg-list">
            {(contract?.assumptions ?? []).map(assumption => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </div>
      )}
      {(contract?.constraints ?? []).length > 0 && (
        <div className="sg-dossier-list">
          <span className="sg-label">Constraints</span>
          <ul className="sg-list">
            {(contract?.constraints ?? []).map(constraint => (
              <li key={constraint}>{constraint}</li>
            ))}
          </ul>
        </div>
      )}
      {(contract?.requiredCapabilities ?? []).length > 0 && (
        <div className="sg-dossier-list">
          <span className="sg-label">Capabilities</span>
          <div className="sg-refs">
            {(contract?.requiredCapabilities ?? []).map(capability => (
              <code key={capability}>{capability}</code>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ChildView({ child, index }: { child: TaskProposalChildWire; index: number }) {
  return (
    <div className="sg-dossier-entry">
      <div className="sg-dossier-badges">
        {(child.dependsOn ?? []).length > 0 && (
          <span>depends on {child.dependsOn?.map(position => `#${position + 1}`).join(', ')}</span>
        )}
        {child.decomposable === true && <span>decomposable</span>}
        {child.requiresIndependentAcceptance === true && <span>independent acceptance</span>}
      </div>
      <ContractView contract={child.contract} label={`Child ${index + 1}`} />
    </div>
  )
}

function ProposalCard({ proposal }: { proposal: TaskProposalWire }) {
  const decide = useStore(s => s.decideProposal)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<ProposalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (decision: ProposalDecision) => {
    setBusy(decision)
    setError(null)
    try {
      await decide(proposal.proposalId, decision, reason.trim() || undefined)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(null)
    }
  }

  const children = proposal.batch ?? []
  const verifiers = proposal.reviewContext?.verifiers ?? []
  const audit = proposal.admissionContext?.auditOnly

  return (
    <article className="sg-card">
      <header className="sg-card-head">
        <StatusBadge status={proposal.status} />
        <span className="sg-card-kind">{proposal.kind ?? 'decomposition'}</span>
        <code className="sg-card-id">{shortId(proposal.proposalId, 20)}</code>
        <span className="sg-muted">{when(proposal.createdAt)}</span>
      </header>
      {proposal.identity?.reason !== undefined && <div className="sg-summary">{proposal.identity.reason}</div>}
      <div className="sg-kv">
        <span>request key</span>
        <code>{proposal.requestKey ?? '—'}</code>
        <span>policy</span>
        <span>{proposal.policy ?? '—'}</span>
        <span>parent task</span>
        <code>{proposal.identity?.parentTaskId ?? '—'}</code>
        <span>parent run</span>
        <code>{proposal.identity?.parentRunId ?? '—'}</code>
        <span>caller session</span>
        <code>{proposal.identity?.callerSessionId ?? '—'}</code>
        <span>store</span>
        <code>{proposal.identity?.storeId ?? '—'}</code>
        {proposal.supersedes !== undefined && (
          <>
            <span>supersedes</span>
            <code>{proposal.supersedes}</code>
          </>
        )}
      </div>
      <div className="sg-dossier">
        {proposal.kind === 'root' || proposal.contract !== undefined ? (
          <ContractView contract={proposal.contract} label="Root contract" />
        ) : children.length > 0 ? (
          children.map((child, index) => <ChildView key={index} child={child} index={index} />)
        ) : (
          <div className="sg-muted">No dossier content in this proposal record</div>
        )}
      </div>
      <div className="sg-dossier-meta">
        <div>
          <span className="sg-label">Review context</span>
          {verifiers.length === 0 ? (
            <div className="sg-muted">No verifiers recorded</div>
          ) : (
            <ul className="sg-list">
              {verifiers.map(verifier => (
                <li key={`${verifier.verifierId}-${verifier.version ?? ''}`}>
                  <code>{verifier.verifierId}</code>
                  {verifier.version === undefined ? '' : ` · v${verifier.version}`}
                </li>
              ))}
            </ul>
          )}
          {proposal.reviewContext?.capabilityManifestDigest !== undefined && (
            <div className="sg-muted">
              capabilities <code>{shortId(proposal.reviewContext.capabilityManifestDigest, 14)}</code>
            </div>
          )}
        </div>
        <div>
          <span className="sg-label">Admission limits</span>
          <div className="sg-muted">
            depth ≤ {proposal.admissionContext?.maxDepth ?? '—'} · children ≤{' '}
            {proposal.admissionContext?.maxChildren ?? '—'}
          </div>
          <div className="sg-muted">
            audit: tools ≤ {audit?.maxToolCalls ?? '—'} · tokens ≤ {audit?.tokens ?? '—'} · attempts ≤{' '}
            {audit?.attempts ?? '—'}
          </div>
        </div>
        <div>
          <span className="sg-label">Digests</span>
          <div className="sg-refs">
            {proposal.proposalDigest !== undefined && <code>{shortId(proposal.proposalDigest, 14)}</code>}
            {proposal.admissionContextDigest !== undefined && (
              <code>{shortId(proposal.admissionContextDigest, 14)}</code>
            )}
            {proposal.reviewContextDigest !== undefined && <code>{shortId(proposal.reviewContextDigest, 14)}</code>}
          </div>
        </div>
      </div>
      <div className="sg-decide">
        <input
          type="text"
          value={reason}
          disabled={busy !== null}
          placeholder="Decision reason (optional)"
          onChange={e => setReason(e.target.value)}
        />
        <div className="sg-decide-actions">
          <button type="button" className="approve" disabled={busy !== null} onClick={() => void act('approve')}>
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button type="button" className="reject" disabled={busy !== null} onClick={() => void act('reject')}>
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void act('continue')}>
            {busy === 'continue' ? 'Continuing…' : 'Continue'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void act('cancel')}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
        {error !== null && (
          <div className="sg-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </article>
  )
}

export default function ProposalsPanel() {
  const loadTask = useStore(s => s.loadTask)
  const task = useStore(s => s.task)
  const loading = useStore(s => s.taskLoading)
  const taskError = useStore(s => s.taskError)
  const bootError = useStore(s => s.bootError)
  const hitl = useStore(s => s.hitl)
  const graphMeta = useStore(s => s.graphMeta)
  const empty = useStore(s => s.empty)
  const rootSessionId = graphMeta?.rootSessionId ?? null

  useEffect(() => {
    void loadTask()
  }, [loadTask, rootSessionId])

  const pending = useMemo(() => proposalsOf(task).filter(proposal => proposal.status === 'pending_review'), [task])

  if (bootError !== null) {
    return <div className="sg-boot">{bootError}</div>
  }
  if (empty || graphMeta === null) {
    return <div className="sg-boot">Select or create a graph</div>
  }

  return (
    <div className="sg-panels">
      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Human input queue</h2>
          <span className="sg-count">{hitl.length}</span>
        </div>
        {hitl.length === 0 ? (
          <div className="sg-empty">No pending questions or approvals</div>
        ) : (
          <div className="sg-hitl-queue">
            {hitl.map(item => (
              <HitlCard key={item.id} item={item} showSession />
            ))}
          </div>
        )}
      </section>
      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Proposals awaiting review</h2>
          <span className="sg-count">{pending.length}</span>
          {loading && <span className="sg-muted">refreshing…</span>}
          <button type="button" className="sg-ghost" onClick={() => void loadTask()}>
            Refresh
          </button>
        </div>
        {taskError !== null && (
          <div className="sg-error" role="alert">
            {taskError}
          </div>
        )}
        {pending.length === 0 ? (
          <div className="sg-empty">{loading ? 'Loading task snapshot…' : 'No proposals pending review'}</div>
        ) : (
          pending.map(proposal => <ProposalCard key={proposal.proposalId} proposal={proposal} />)
        )}
      </section>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { fetchEvolutionProposal } from '../api'
import StatusBadge from '../components/StatusBadge'
import { shortId } from '../lib/task-data'
import { useStore } from '../store'
import type {
  CommitIntentWire,
  EvolutionDecisionWire,
  EvolutionProposalWire,
  ExperimentReportWire,
  ExperimentSampleWire,
  ExperimentSideWire,
  GateAnswersWire,
  SideRelation,
} from '../types'

type GateQuestionKey =
  | 'targetFailureFixed'
  | 'originalAcceptanceMaintained'
  | 'existingRegressionMaintained'
  | 'noUnacceptableSideEffects'
  | 'holdoutPerformanceAcceptable'
  | 'resourceCostAcceptable'

const GATE_QUESTIONS: readonly { key: GateQuestionKey; question: string }[] = [
  { key: 'targetFailureFixed', question: '1. Target failure fixed?' },
  { key: 'originalAcceptanceMaintained', question: '2. Original acceptance maintained?' },
  { key: 'existingRegressionMaintained', question: '3. Existing regression maintained?' },
  { key: 'noUnacceptableSideEffects', question: '4. No unacceptable side effects?' },
  { key: 'holdoutPerformanceAcceptable', question: '5. Holdout performance acceptable?' },
  { key: 'resourceCostAcceptable', question: '6. Resource cost acceptable?' },
]

const OUTCOME_RANK: Readonly<Record<string, number>> = { verified: 1, failed: 0 }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function when(value?: string): string {
  if (value === undefined || value.length === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function digest(value: string | null | undefined, absent: string): string {
  return value === undefined || value === null ? absent : shortId(value, 12)
}

function gateOf(proposal: EvolutionProposalWire): GateAnswersWire | undefined {
  return proposal.gateAnswers ?? proposal.gate
}

function decisionOf(proposal: EvolutionProposalWire): string | undefined {
  const value = proposal.decision
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.decision
}

function decisionRecordOf(proposal: EvolutionProposalWire): EvolutionDecisionWire | undefined {
  return typeof proposal.decision === 'string' ? undefined : proposal.decision
}

/** The comparer's side relation (compareReplaySides), derived here when the projection omits it. */
function sideRelation(sample: ExperimentSampleWire): SideRelation {
  const baseline = sample.baseline
  const candidate = sample.candidate
  if (baseline === undefined || candidate === undefined) return 'inconclusive'
  const rank = (side: ExperimentSideWire): number | undefined =>
    OUTCOME_RANK[side.outcome === 'interrupted' ? 'cancelled' : (side.outcome ?? '')]
  const champion = rank(baseline)
  const challenger = rank(candidate)
  if (champion === undefined || challenger === undefined) return 'inconclusive'
  const before = new Map((baseline.criteria ?? []).map(item => [item.criterionId, item.verdict]))
  const after = new Map((candidate.criteria ?? []).map(item => [item.criterionId, item.verdict]))
  const ids = new Set([...before.keys(), ...after.keys()])
  const regressed = [...ids].some(id => before.get(id) === 'pass' && after.get(id) !== 'pass')
  const changed = [...ids].some(id => before.get(id) === undefined || after.get(id) === undefined)
  const commandChanged = (baseline.criteria ?? []).some(
    item => (candidate.criteria ?? []).find(peer => peer.criterionId === item.criterionId)?.command !== item.command,
  )
  if (challenger < champion || regressed) return 'worse'
  return changed || commandChanged ? 'inconclusive' : 'not-worse'
}

function IntentView({ intent }: { intent: CommitIntentWire }) {
  const files = intent.files ?? []
  const capability = intent.capability
  return (
    <div className="sg-detail-block">
      <div className="sg-kv">
        <span>intent</span>
        <code>{intent.intentId ?? '—'}</code>
        <span>direction</span>
        <span>{intent.direction ?? '—'}</span>
        <span>approval</span>
        <code>{intent.approvalRef ?? '—'}</code>
        <span>actor</span>
        <span>{intent.actor ?? '—'}</span>
        <span>at</span>
        <span>{when(intent.at)}</span>
        {capability !== undefined && (
          <>
            <span>capability row</span>
            <code>{capability.name ?? '—'}</code>
          </>
        )}
      </div>
      {files.length > 0 && (
        <ul className="sg-list">
          {files.map((file, index) => (
            <li key={file.target ?? `file-${index}`}>
              <code>{file.target ?? '—'}</code>
              <span className="sg-muted">
                {' '}
                {digest(file.baselineSha256, 'absent')} → {digest(file.contentSha256, 'removed')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The expanded proposal: gate checklist, decision, ledger history and any open commit intent. */
export function ProposalDetailView({ proposal }: { proposal: EvolutionProposalWire }) {
  const gate = gateOf(proposal)
  const decision = decisionOf(proposal)
  const decisionRecord = decisionRecordOf(proposal)
  const decisionNote = proposal.decisionNote ?? decisionRecord?.note
  const decisionApprovalRef = proposal.decisionApprovalRef ?? decisionRecord?.approvalRef
  const history = proposal.history ?? []
  return (
    <div className="sg-run-detail">
      <div className="sg-detail-block">
        <h4>Gate answers</h4>
        {gate === undefined ? (
          <div className="sg-muted">No gate answers recorded yet</div>
        ) : (
          <>
            <ul className="sg-checks">
              {GATE_QUESTIONS.map(item => {
                const answer = gate[item.key]
                const answered = answer !== undefined && answer.trim().length > 0
                return (
                  <li key={item.key} className="sg-check" data-answered={answered}>
                    <span className="sg-check-mark">{answered ? '✓' : '○'}</span>
                    <span className="sg-check-q">{item.question}</span>
                    <span className="sg-check-a">{answered ? answer : 'not answered'}</span>
                  </li>
                )
              })}
            </ul>
            {(gate.regressionEvidenceRefs ?? []).length > 0 && (
              <>
                <span className="sg-label">Regression evidence</span>
                <div className="sg-refs">
                  {(gate.regressionEvidenceRefs ?? []).map(ref => (
                    <code key={ref}>{ref}</code>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="sg-detail-block">
        <h4>Decision</h4>
        {decision === undefined ? (
          <div className="sg-muted">No decision recorded yet</div>
        ) : (
          <>
            <div className="sg-review-head">
              <StatusBadge status={decision} />
              {decisionApprovalRef !== undefined && <span className="sg-muted">approval {decisionApprovalRef}</span>}
            </div>
            {decisionNote !== undefined && <div className="sg-summary">{decisionNote}</div>}
          </>
        )}
      </div>
      <div className="sg-detail-block">
        <h4>Decision history</h4>
        {history.length === 0 ? (
          <div className="sg-muted">No ledger history projected</div>
        ) : (
          <ul className="sg-list">
            {history.map((entry, index) => (
              <li key={`${entry.status ?? 'record'}-${entry.at ?? index}`}>
                <StatusBadge status={entry.status ?? 'unknown'} />
                <span className="sg-muted">
                  {' '}
                  {entry.actor ?? '—'} · {when(entry.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sg-detail-block">
        <h4>Open commit intent</h4>
        {proposal.openIntent === undefined ? (
          <div className="sg-muted">No open commit intent</div>
        ) : (
          <IntentView intent={proposal.openIntent} />
        )}
      </div>
    </div>
  )
}

function ProposalDetail({ proposalId, fallback }: { proposalId: string; fallback: EvolutionProposalWire }) {
  const [proposal, setProposal] = useState<EvolutionProposalWire | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetchEvolutionProposal(proposalId)
      .then(result => {
        if (!alive) return
        setProposal(result.proposal)
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
  }, [proposalId])

  if (loading) return <div className="sg-detail-block sg-muted">Loading proposal detail…</div>
  return (
    <>
      {error !== null && (
        <div className="sg-error" role="alert">
          {error}
        </div>
      )}
      <ProposalDetailView proposal={proposal ?? fallback} />
    </>
  )
}

function ProposalCard({ proposal }: { proposal: EvolutionProposalWire }) {
  const [open, setOpen] = useState(false)
  const decision = decisionOf(proposal)
  const history = proposal.history ?? []
  return (
    <article className="sg-card">
      <button
        type="button"
        className="sg-card-head sg-expand"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="sg-caret">{open ? '▾' : '▸'}</span>
        <StatusBadge status={proposal.status ?? 'unknown'} />
        {decision !== undefined && <StatusBadge status={decision} />}
        {proposal.level !== undefined && <span className="sg-run-phase">{proposal.level}</span>}
        <span className="sg-card-kind">{proposal.targetType ?? 'proposal'}</span>
        <code className="sg-card-id">{shortId(proposal.proposalId, 20)}</code>
        <span className="sg-muted">target {proposal.targetId ?? '—'}</span>
        <span className="sg-run-time">
          created {when(history[0]?.at)} · updated {when(history[history.length - 1]?.at)}
        </span>
      </button>
      {proposal.rationale !== undefined && <div className="sg-summary">{proposal.rationale}</div>}
      {open && <ProposalDetail proposalId={proposal.proposalId} fallback={proposal} />}
    </article>
  )
}

/** One experiment report: the frozen identity and the per-sample comparison table. */
export function ExperimentCard({ report }: { report: ExperimentReportWire }) {
  const samples = report.samples ?? []
  const frozen = report.frozen
  return (
    <article className="sg-card">
      <header className="sg-card-head">
        <StatusBadge status={report.verdict ?? 'inconclusive'} />
        <span className="sg-card-kind">experiment</span>
        <code className="sg-card-id">{shortId(report.experimentId ?? 'experiment', 20)}</code>
        {report.proposalId !== undefined && (
          <span className="sg-muted">
            proposal <code>{shortId(report.proposalId, 16)}</code>
          </span>
        )}
        <span className="sg-run-time">{when(report.at)}</span>
      </header>
      <div className="sg-kv">
        <span>repetition</span>
        <span>{frozen?.repetition ?? '—'}</span>
        <span>model</span>
        <span>{frozen?.model?.label ?? '—'}</span>
        <span>token budget</span>
        <span>{frozen?.budget?.maxTokens ?? '—'}</span>
      </div>
      {samples.length === 0 ? (
        <div className="sg-muted">No sample comparisons recorded</div>
      ) : (
        <table className="sg-table">
          <thead>
            <tr>
              <th>sample</th>
              <th>role</th>
              <th>baseline</th>
              <th>candidate</th>
              <th>relation</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {samples.map(sample => (
              <tr key={sample.taskId}>
                <td>
                  <code>{shortId(sample.taskId, 18)}</code>
                </td>
                <td>{sample.role ?? '—'}</td>
                <td>
                  <StatusBadge status={sample.baseline?.outcome ?? 'unknown'} />
                </td>
                <td>
                  <StatusBadge status={sample.candidate?.outcome ?? 'unknown'} />
                </td>
                <td>
                  <StatusBadge status={sample.relation ?? sideRelation(sample)} />
                </td>
                <td>
                  <StatusBadge status={sample.verdict ?? 'inconclusive'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  )
}

export default function EvolutionPanel() {
  const loadEvolution = useStore(s => s.loadEvolution)
  const evolution = useStore(s => s.evolution)
  const evolutionError = useStore(s => s.evolutionError)

  useEffect(() => {
    void loadEvolution()
  }, [loadEvolution])

  const proposals = evolution?.proposals ?? []
  const experiments = evolution?.experiments ?? []
  const loaded = evolution !== null

  return (
    <div className="sg-panels">
      <section className="sg-panel-section">
        <div className="sg-panel-head">
          <h2>Evolution</h2>
          <span className="sg-count">
            {proposals.length} proposals · {experiments.length} experiments
          </span>
          <button type="button" className="sg-ghost" onClick={() => void loadEvolution()}>
            Refresh
          </button>
        </div>
        {evolutionError !== null && (
          <div className="sg-error" role="alert">
            {evolutionError}
          </div>
        )}
        {proposals.length === 0 && experiments.length === 0 ? (
          <div className="sg-empty">
            {loaded
              ? 'No proposals or experiments — evolution is disabled or idle for this deployment'
              : 'Loading evolution ledger…'}
          </div>
        ) : (
          <>
            {proposals.length > 0 && (
              <section className="sg-panel-section">
                <div className="sg-panel-head">
                  <h2>Proposals</h2>
                  <span className="sg-count">{proposals.length}</span>
                </div>
                {proposals.map(proposal => (
                  <ProposalCard key={proposal.proposalId} proposal={proposal} />
                ))}
              </section>
            )}
            {experiments.length > 0 && (
              <section className="sg-panel-section">
                <div className="sg-panel-head">
                  <h2>Experiments</h2>
                  <span className="sg-count">{experiments.length}</span>
                </div>
                {experiments.map((report, index) => (
                  <ExperimentCard key={report.experimentId ?? `experiment-${index}`} report={report} />
                ))}
              </section>
            )}
          </>
        )}
      </section>
    </div>
  )
}

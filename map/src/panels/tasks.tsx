import { useEffect, useMemo } from 'react'
import StatusBadge, { statusTone } from '../components/StatusBadge'
import { asArray, runsOf, shortId, taskTree, type TaskNode } from '../lib/task-data'
import { useStore } from '../store'
import type { EvidenceWire, ReviewWire, TaskRunWire, TaskSnapshotWire } from '../types'

function when(value?: string): string {
  if (value === undefined || value.length === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function duration(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${seconds % 60} s`
}

interface TaskView {
  nodes: TaskNode[]
  runs: TaskRunWire[]
  reviews: Map<string, ReviewWire>
  evidence: Map<string, EvidenceWire[]>
  deps: Map<string, string[]>
  unattached: TaskRunWire[]
}

function buildView(snapshot: TaskSnapshotWire | null): TaskView {
  const runs = asArray(snapshot?.runs)
  const reviews = new Map<string, ReviewWire>()
  for (const review of asArray(snapshot?.reviews)) {
    if (review.runId !== undefined) reviews.set(review.runId, review)
  }
  const evidence = new Map<string, EvidenceWire[]>()
  for (const bundle of asArray(snapshot?.evidence)) {
    if (bundle.taskRunId === undefined) continue
    const list = evidence.get(bundle.taskRunId)
    if (list === undefined) evidence.set(bundle.taskRunId, [bundle])
    else list.push(bundle)
  }
  const deps = new Map<string, string[]>()
  for (const edge of asArray(snapshot?.edges)) {
    const list = deps.get(edge.to)
    if (list === undefined) deps.set(edge.to, [edge.from])
    else list.push(edge.from)
  }
  const nodes = taskTree(snapshot)
  const attached = new Set<string>()
  const collect = (node: TaskNode): void => {
    for (const run of runsOf(node.task, runs)) attached.add(run.runId)
    for (const child of node.children) collect(child)
  }
  for (const node of nodes) collect(node)
  return { nodes, runs, reviews, evidence, deps, unattached: runs.filter(run => !attached.has(run.runId)) }
}

function RunDetail({ run, review, evidence }: { run: TaskRunWire; review?: ReviewWire; evidence: EvidenceWire[] }) {
  const refs = review?.evidenceRefs ?? []
  const bundleArtifacts = evidence.flatMap(bundle => bundle.artifacts ?? [])
  return (
    <div className="sg-run-detail">
      <div className="sg-kv">
        <span>runId</span>
        <code>{run.runId}</code>
        <span>session</span>
        <code>{run.sessionId ?? '—'}</code>
        <span>parent run</span>
        <code>{run.parentRunId ?? '—'}</code>
        <span>phase</span>
        <span>{run.executionPhase ?? '—'}</span>
        <span>batch</span>
        <code>{run.batchId ?? '—'}</code>
        <span>started</span>
        <span>{when(run.startedAt)}</span>
        <span>finished</span>
        <span>{when(run.finishedAt)}</span>
        {run.recovery?.sourceRunId !== undefined && (
          <>
            <span>recovery of</span>
            <code>{run.recovery.sourceRunId}</code>
          </>
        )}
      </div>
      {run.batches !== undefined && run.batches.length > 0 && (
        <div className="sg-detail-block">
          <h4>Batches</h4>
          <ul className="sg-list">
            {run.batches.map(batch => (
              <li key={batch.batchId}>
                <code>{batch.batchId}</code>
                <span> · {batch.proposalId ?? '—'}</span>
                <span>{batch.memberTaskIds === undefined ? '' : ` · ${batch.memberTaskIds.length} members`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.submission !== undefined && (
        <div className="sg-detail-block">
          <h4>Submission</h4>
          <div className="sg-summary">{run.submission.summary}</div>
          <div className="sg-muted">
            {run.submission.origin ?? '—'} · {when(run.submission.submittedAt)}
          </div>
          {(run.submission.evidenceRefs ?? []).length > 0 && (
            <div className="sg-refs">
              {(run.submission.evidenceRefs ?? []).map(ref => (
                <code key={ref}>{ref}</code>
              ))}
            </div>
          )}
          {run.submission.notes !== undefined && <div className="sg-muted">{run.submission.notes}</div>}
        </div>
      )}
      <div className="sg-detail-block">
        <h4>Review</h4>
        {review === undefined ? (
          <div className="sg-muted">No review record for this run yet</div>
        ) : (
          <>
            <div className="sg-review-head">
              <StatusBadge status={review.outcome} />
              <span className="sg-muted">
                {review.criteria?.length ?? 0} criteria · {duration(review.durationMs)}
              </span>
            </div>
            {review.localizedCause !== undefined && <div className="sg-summary">{review.localizedCause}</div>}
            {(review.anomalies ?? []).length > 0 && (
              <ul className="sg-list">
                {(review.anomalies ?? []).map((anomaly, index) => (
                  <li key={`${index}-${anomaly}`}>{anomaly}</li>
                ))}
              </ul>
            )}
            {(review.blockedBy ?? []).length > 0 && (
              <ul className="sg-list">
                {(review.blockedBy ?? []).map(blocker => (
                  <li key={blocker.taskId}>
                    <code>{blocker.taskId}</code>
                    {blocker.outcome === undefined ? '' : ` · ${blocker.outcome}`}
                  </li>
                ))}
              </ul>
            )}
            {(review.criteria ?? []).length > 0 && (
              <table className="sg-table">
                <thead>
                  <tr>
                    <th>criterion</th>
                    <th>verdict</th>
                    <th>exit</th>
                  </tr>
                </thead>
                <tbody>
                  {(review.criteria ?? []).map(criterion => (
                    <tr key={criterion.criterionId}>
                      <td>
                        <code>{criterion.criterionId}</code>
                      </td>
                      <td>
                        <StatusBadge status={criterion.verdict} />
                      </td>
                      <td>{criterion.exitCode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {review.logTail !== undefined && review.logTail.length > 0 && (
              <pre className="sg-logtail">{review.logTail}</pre>
            )}
          </>
        )}
      </div>
      <div className="sg-detail-block">
        <h4>Evidence</h4>
        {refs.length === 0 && evidence.length === 0 ? (
          <div className="sg-muted">No evidence refs recorded</div>
        ) : (
          <div className="sg-refs">
            {refs.map(ref => (
              <code key={ref}>{ref}</code>
            ))}
            {evidence.map(bundle => (
              <code key={bundle.evidenceId}>{bundle.evidenceId}</code>
            ))}
          </div>
        )}
        {bundleArtifacts.length > 0 && (
          <ul className="sg-list">
            {bundleArtifacts.map((artifact, index) => (
              <li key={`${index}-${artifact.artifactId ?? artifact.uri ?? 'artifact'}`}>
                <code>{artifact.kind ?? 'artifact'}</code>
                <span> {artifact.uri ?? artifact.artifactId ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {run.artifacts !== undefined && run.artifacts.length > 0 && (
        <div className="sg-detail-block">
          <h4>Run artifacts</h4>
          <ul className="sg-list">
            {run.artifacts.map((artifact, index) => (
              <li key={`${index}-${artifact.artifactId ?? artifact.uri ?? 'artifact'}`}>
                <code>{artifact.kind ?? 'artifact'}</code>
                <span> {artifact.uri ?? artifact.artifactId ?? '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The iteration round a recovery run is: the kind its `RunRecovery` records and its position in the task's `runIds`. */
function RoundBadge({ recovery, round }: { recovery: NonNullable<TaskRunWire['recovery']>; round?: number }) {
  const improvement = recovery.kind === 'improvement'
  return (
    <span className="sg-badge" data-tone={statusTone(improvement ? 'improvement' : 'recovery')}>
      {improvement ? '↻ improve' : '↻ recovery'}
      {round === undefined ? '' : ` · round ${round}`}
    </span>
  )
}

function RunRow({
  run,
  review,
  evidence,
  round,
}: {
  run: TaskRunWire
  review?: ReviewWire
  evidence: EvidenceWire[]
  round?: number
}) {
  const selectedRunId = useStore(s => s.selectedRunId)
  const setSelectedRun = useStore(s => s.setSelectedRun)
  const setTab = useStore(s => s.setTab)
  const open = selectedRunId === run.runId
  return (
    <div className="sg-run">
      <div className="sg-run-head">
        <button
          type="button"
          className={`sg-run-row${open ? ' open' : ''}`}
          onClick={() => setSelectedRun(open ? null : run.runId)}
          aria-expanded={open}
        >
          <span className="sg-caret">{open ? '▾' : '▸'}</span>
          <StatusBadge status={run.status} />
          {run.recovery !== undefined && <RoundBadge recovery={run.recovery} round={round} />}
          <code className="sg-run-id">{shortId(run.runId, 16)}</code>
          {run.executionPhase !== undefined && <span className="sg-run-phase">{run.executionPhase}</span>}
          {run.batchId !== undefined && <code className="sg-run-batch">{shortId(run.batchId, 18)}</code>}
          <span className="sg-run-time">{when(run.startedAt)}</span>
        </button>
        <button
          type="button"
          className="sg-ghost"
          onClick={() => {
            setSelectedRun(run.runId)
            setTab('verifier')
          }}
        >
          Verifier
        </button>
      </div>
      {open && <RunDetail run={run} review={review} evidence={evidence} />}
    </div>
  )
}

function TaskRow({ node, view }: { node: TaskNode; view: Pick<TaskView, 'runs' | 'reviews' | 'evidence' | 'deps'> }) {
  const task = node.task
  const taskRuns = runsOf(task, view.runs)
  const runIds = task.runIds ?? []
  const incoming = view.deps.get(task.taskId) ?? []
  return (
    <div className="sg-task" style={{ marginLeft: node.depth * 18 }}>
      <div className="sg-task-head">
        <StatusBadge status={task.status ?? 'unknown'} />
        <span className="sg-task-objective">{task.objective ?? '(no objective)'}</span>
      </div>
      <div className="sg-task-meta">
        <code>{task.taskId}</code>
        <span>depth {task.depth ?? node.depth}</span>
        {task.decompositionStatus !== undefined && <span>{task.decompositionStatus}</span>}
        {incoming.length > 0 && <span>after {incoming.join(', ')}</span>}
        {task.requiresIndependentAcceptance === true && <span>independent acceptance</span>}
      </div>
      {taskRuns.length === 0 ? (
        <div className="sg-muted sg-task-empty">No runs recorded</div>
      ) : (
        <div className="sg-runs">
          {taskRuns.map(run => {
            const index = runIds.indexOf(run.runId)
            return (
              <RunRow
                key={run.runId}
                run={run}
                round={index < 0 ? undefined : index + 1}
                review={view.reviews.get(run.runId)}
                evidence={view.evidence.get(run.runId) ?? []}
              />
            )
          })}
        </div>
      )}
      {node.children.map(child => (
        <TaskRow key={child.task.taskId} node={child} view={view} />
      ))}
    </div>
  )
}

export default function TasksPanel() {
  const loadTask = useStore(s => s.loadTask)
  const task = useStore(s => s.task)
  const loading = useStore(s => s.taskLoading)
  const taskError = useStore(s => s.taskError)
  const bootError = useStore(s => s.bootError)
  const graphMeta = useStore(s => s.graphMeta)
  const empty = useStore(s => s.empty)
  const rootSessionId = graphMeta?.rootSessionId ?? null

  useEffect(() => {
    void loadTask()
  }, [loadTask, rootSessionId])

  const view = useMemo(() => buildView(task), [task])

  if (bootError !== null) {
    return <div className="sg-boot">{bootError}</div>
  }
  if (empty || graphMeta === null) {
    return <div className="sg-boot">Select or create a graph</div>
  }

  return (
    <div className="sg-panels">
      <div className="sg-panel-head">
        <h2>Tasks</h2>
        <span className="sg-count">
          {asArray(task?.tasks).length} tasks · {view.runs.length} runs
        </span>
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
      {view.nodes.length === 0 && view.unattached.length === 0 && taskError === null ? (
        <div className="sg-empty">{loading ? 'Loading task snapshot…' : 'No tasks in this store yet'}</div>
      ) : (
        <div className="sg-tree">
          {view.nodes.map(node => (
            <TaskRow key={node.task.taskId} node={node} view={view} />
          ))}
        </div>
      )}
      {view.unattached.length > 0 && (
        <section className="sg-panel-section">
          <div className="sg-panel-head">
            <h2>Runs without a task</h2>
          </div>
          {view.unattached.map(run => (
            <RunRow
              key={run.runId}
              run={run}
              review={view.reviews.get(run.runId)}
              evidence={view.evidence.get(run.runId) ?? []}
            />
          ))}
        </section>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { fetchGraphEnvs } from '../api'
import { useStore } from '../store'
import type { CreateGraphBody, GraphEntry, GraphEnv, ModelRef, RsiConfig } from '../types'
import ModelPicker from './ModelPicker'

const NEW_ENV = '__new__'
// The rounds field is text so a cleared input stays editable; unset it means the default three rounds.
const DEFAULT_ROUNDS = '3'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseRepos(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(ref => ref.trim())
    .filter(ref => ref.length > 0)
}

function modelLabel(model: ModelRef | undefined): string {
  if (model === undefined) return 'Default'
  return model.reasoningEffort === undefined
    ? `${model.provider}/${model.model}`
    : `${model.provider}/${model.model} · ${model.reasoningEffort}`
}

/** The graph row's RSI badge: rounds done of the configured total (0 until the driver reports progress), the phase, and who gates a round. */
function rsiBadge(entry: GraphEntry): string | null {
  const rsi = entry.rsi
  if (rsi === undefined) return null
  const progress = entry.rsiProgress
  return `RSI ${progress?.round ?? 0}/${rsi.iterationRounds} · ${progress?.phase ?? 'not started'} · ${
    rsi.humanReview ? 'human' : 'unmanned'
  }`
}

function parseRounds(raw: string): number {
  const rounds = Number(raw)
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('map: iteration rounds must be an integer of at least 1')
  return rounds
}

export default function GraphSwitcher() {
  const graphId = useStore(s => s.graphId)
  const graph = useStore(s => s.graph)
  const bootError = useStore(s => s.bootError)
  const graphs = useStore(s => s.graphs)
  const loading = useStore(s => s.graphsLoading)
  const graphsError = useStore(s => s.graphsError)
  const switchGraph = useStore(s => s.switchGraph)
  const createGraph = useStore(s => s.createGraph)
  const removeGraph = useStore(s => s.removeGraph)
  const updateGraphModel = useStore(s => s.updateGraphModel)
  const updateGraphRsi = useStore(s => s.updateGraphRsi)
  const loadGraphs = useStore(s => s.loadGraphs)
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [envs, setEnvs] = useState<GraphEnv[] | null>(null)
  const [envId, setEnvId] = useState('')
  const [repos, setRepos] = useState('')
  const [createModel, setCreateModel] = useState<ModelRef | null>(null)
  const [rsiOn, setRsiOn] = useState(false)
  const [rsiTask, setRsiTask] = useState('')
  const [rsiRounds, setRsiRounds] = useState(DEFAULT_ROUNDS)
  const [rsiHumanReview, setRsiHumanReview] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [editModel, setEditModel] = useState<ModelRef | null>(null)
  const [editRounds, setEditRounds] = useState(DEFAULT_ROUNDS)
  const [editHumanReview, setEditHumanReview] = useState(true)

  const current = graphs.find(entry => entry.id === graphId)

  useEffect(() => {
    setConfirmDelete(false)
    setEditOpen(false)
  }, [graphId])

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  const openCreate = async () => {
    if (createOpen) {
      setCreateOpen(false)
      return
    }
    setActionError(null)
    setEditOpen(false)
    setCreateOpen(true)
    if (envs !== null && envs.length > 0) return
    try {
      const data = await fetchGraphEnvs()
      const available = (data.envs ?? []).filter(env => env.available)
      setEnvs(available)
      setEnvId(available[0]?.id ?? NEW_ENV)
    } catch (error) {
      setEnvs([])
      setEnvId(NEW_ENV)
      setActionError(message(error))
    }
  }

  // A blank objective with the toggle on is no config at all: the body then simply omits `rsi`.
  const rsiBody = (): RsiConfig | null => {
    if (!rsiOn) return null
    const task = rsiTask.trim()
    if (task.length === 0) return null
    return { task, iterationRounds: parseRounds(rsiRounds), humanReview: rsiHumanReview }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      const rsi = rsiBody()
      const trimmed = name.trim()
      let body: CreateGraphBody
      if (envId === NEW_ENV) {
        const list = parseRepos(repos)
        if (list.length === 0) throw new Error('map: add at least one repository')
        body = { ...(trimmed.length === 0 ? {} : { name: trimmed }), createEnv: true, repos: list }
      } else {
        if (envId.length === 0) throw new Error('map: pick an environment')
        body = { ...(trimmed.length === 0 ? {} : { name: trimmed }), envId }
      }
      await createGraph({
        ...body,
        ...(createModel === null ? {} : { model: createModel }),
        ...(rsi === null ? {} : { rsi }),
      })
      setCreateOpen(false)
      setName('')
      setRepos('')
      setCreateModel(null)
      setRsiOn(false)
      setRsiTask('')
      setRsiRounds(DEFAULT_ROUNDS)
      setRsiHumanReview(true)
    } catch (error) {
      setActionError(message(error))
    } finally {
      setBusy(false)
    }
  }

  const select = (id: string) => {
    if (id.length === 0 || busy) return
    // Re-choosing the current graph is a retry while its canvas has no snapshot; otherwise it is a no-op.
    if (id === graphId && graph !== null && bootError === null) return
    setBusy(true)
    setActionError(null)
    void switchGraph(id)
      .catch(error => setActionError(message(error)))
      .finally(() => setBusy(false))
  }

  const remove = () => {
    if (graphId === null || busy) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    const id = graphId
    setBusy(true)
    setActionError(null)
    setConfirmDelete(false)
    void removeGraph(id)
      .catch(error => setActionError(message(error)))
      .finally(() => setBusy(false))
  }

  const toggleEdit = () => {
    if (editOpen) {
      setEditOpen(false)
      return
    }
    if (current === undefined) return
    setActionError(null)
    setCreateOpen(false)
    setEditModel(current.model ?? null)
    setEditRounds(current.rsi === undefined ? DEFAULT_ROUNDS : String(current.rsi.iterationRounds))
    setEditHumanReview(current.rsi?.humanReview ?? true)
    setEditOpen(true)
  }

  const saveEdit = () => {
    if (graphId === null || current === undefined || busy) return
    const rsi = current.rsi
    setActionError(null)
    let nextRsi: RsiConfig | null = null
    try {
      if (rsi !== undefined) {
        nextRsi = { ...rsi, iterationRounds: parseRounds(editRounds), humanReview: editHumanReview }
      }
    } catch (error) {
      setActionError(message(error))
      return
    }
    setBusy(true)
    void updateGraphModel(graphId, editModel)
      .then(() => (nextRsi === null ? undefined : updateGraphRsi(graphId, nextRsi)))
      .then(() => setEditOpen(false))
      .catch(error => setActionError(message(error)))
      .finally(() => setBusy(false))
  }

  const clearRsi = () => {
    if (graphId === null || busy) return
    setBusy(true)
    setActionError(null)
    void updateGraphRsi(graphId, null)
      .then(() => setEditOpen(false))
      .catch(error => setActionError(message(error)))
      .finally(() => setBusy(false))
  }

  const error = actionError ?? graphsError
  const currentBadge = current === undefined ? null : rsiBadge(current)

  return (
    <div className="sg-switcher">
      <select
        className="sg-graph-select"
        aria-label="Active graph"
        value={graphId ?? ''}
        disabled={busy}
        onChange={event => select(event.target.value)}
      >
        {graphId === null && (
          <option value="" disabled>
            {graphs.length === 0 ? 'No graphs' : 'Select a graph…'}
          </option>
        )}
        {graphs.map(entry => {
          const badge = rsiBadge(entry)
          return (
            <option key={entry.id} value={entry.id}>
              {entry.name}
              {entry.ready ? '' : ' · setup'}
              {' · '}
              {modelLabel(entry.model)}
              {badge === null ? '' : ` · ${badge}`}
            </option>
          )
        })}
      </select>
      {current !== undefined && (
        <span className={`sg-pill ${current.ready ? 'ready' : 'setup'}`}>{current.ready ? 'ready' : 'setup'}</span>
      )}
      {current !== undefined && <span className="sg-model-chip">{modelLabel(current.model)}</span>}
      {currentBadge !== null && (
        <span
          className="sg-rsi-chip"
          data-phase={current?.rsiProgress?.phase ?? 'idle'}
          title={current?.rsiProgress?.note}
        >
          {currentBadge}
        </span>
      )}
      <button type="button" className="sg-head-btn" disabled={loading} onClick={() => void loadGraphs()}>
        {loading ? '…' : '⟳'}
      </button>
      <button type="button" className="sg-head-btn" disabled={busy} onClick={() => void openCreate()}>
        New
      </button>
      <button
        type="button"
        className="sg-head-btn"
        disabled={graphId === null || busy}
        onClick={toggleEdit}
      >
        Settings
      </button>
      <button
        type="button"
        className={`sg-head-btn${confirmDelete ? ' danger' : ''}`}
        disabled={graphId === null || busy}
        onClick={remove}
      >
        {confirmDelete ? 'Confirm delete' : 'Delete'}
      </button>
      {createOpen && (
        <form className="sg-create-card" onSubmit={submit}>
          <h3>New graph</h3>
          <label>
            Name
            <input
              type="text"
              value={name}
              disabled={busy}
              placeholder="graph name"
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label>
            Environment
            <select value={envId} disabled={busy} onChange={event => setEnvId(event.target.value)}>
              {envs === null && <option value="">Loading environments…</option>}
              {(envs ?? []).map(env => (
                <option key={env.id} value={env.id}>
                  {env.label ?? env.id}
                  {env.componentCount === undefined ? '' : ` (${env.componentCount} components)`}
                </option>
              ))}
              <option value={NEW_ENV}>New environment (clone repositories)</option>
            </select>
          </label>
          {envId === NEW_ENV && (
            <label>
              Repositories
              <input
                type="text"
                value={repos}
                disabled={busy}
                placeholder="owner/repo, owner/other"
                onChange={event => setRepos(event.target.value)}
              />
            </label>
          )}
          <ModelPicker value={createModel} onChange={setCreateModel} disabled={busy} />
          <div className="sg-rsi">
            <label className="sg-rsi-toggle">
              <input
                type="checkbox"
                checked={rsiOn}
                disabled={busy}
                onChange={event => setRsiOn(event.target.checked)}
              />
              Continuous iteration (RSI)
            </label>
            {rsiOn && (
              <>
                <label>
                  Objective
                  <textarea
                    value={rsiTask}
                    disabled={busy}
                    rows={3}
                    placeholder="the objective every round works towards"
                    onChange={event => setRsiTask(event.target.value)}
                  />
                </label>
                <label>
                  Iteration rounds
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={rsiRounds}
                    disabled={busy}
                    onChange={event => setRsiRounds(event.target.value)}
                  />
                </label>
                <label
                  className="sg-rsi-toggle"
                  title="Uncheck to iterate unmanned, with no human gating a round"
                >
                  <input
                    type="checkbox"
                    checked={rsiHumanReview}
                    disabled={busy}
                    onChange={event => setRsiHumanReview(event.target.checked)}
                  />
                  Human review
                </label>
              </>
            )}
          </div>
          <div className="sg-create-actions">
            <button type="button" className="sg-head-btn" disabled={busy} onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      )}
      {editOpen && current !== undefined && (
        <div className="sg-create-card">
          <h3>Settings for {current.name}</h3>
          <ModelPicker value={editModel} onChange={setEditModel} disabled={busy} />
          {current.rsi === undefined ? (
            <div className="sg-model-note">No continuous iteration configured for this graph.</div>
          ) : (
            <div className="sg-rsi">
              <label>
                Objective
                <div className="sg-model-note sg-rsi-task">{current.rsi.task}</div>
              </label>
              <label>
                Iteration rounds
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={editRounds}
                  disabled={busy}
                  onChange={event => setEditRounds(event.target.value)}
                />
              </label>
              <label className="sg-rsi-toggle" title="Uncheck to iterate unmanned, with no human gating a round">
                <input
                  type="checkbox"
                  checked={editHumanReview}
                  disabled={busy}
                  onChange={event => setEditHumanReview(event.target.checked)}
                />
                Human review
              </label>
            </div>
          )}
          <div className="sg-create-actions">
            {current.rsi !== undefined && (
              <button type="button" className="sg-head-btn sg-rsi-clear" disabled={busy} onClick={clearRsi}>
                Clear RSI
              </button>
            )}
            <button type="button" className="sg-head-btn" disabled={busy} onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy} onClick={saveEdit}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <div className="sg-head-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

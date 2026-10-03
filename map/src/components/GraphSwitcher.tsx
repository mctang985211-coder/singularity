import { useEffect, useState } from 'react'
import { fetchGraphEnvs } from '../api'
import { useStore } from '../store'
import type { CreateGraphBody, GraphEnv, ModelRef } from '../types'
import ModelPicker from './ModelPicker'

const NEW_ENV = '__new__'

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
  const [editOpen, setEditOpen] = useState(false)
  const [editModel, setEditModel] = useState<ModelRef | null>(null)

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
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
      await createGraph({ ...body, ...(createModel === null ? {} : { model: createModel }) })
      setCreateOpen(false)
      setName('')
      setRepos('')
      setCreateModel(null)
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
    setEditOpen(true)
  }

  const saveModel = () => {
    if (graphId === null || busy) return
    setBusy(true)
    setActionError(null)
    void updateGraphModel(graphId, editModel)
      .then(() => setEditOpen(false))
      .catch(error => setActionError(message(error)))
      .finally(() => setBusy(false))
  }

  const error = actionError ?? graphsError

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
        {graphs.map(entry => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
            {entry.ready ? '' : ' · setup'}
            {' · '}
            {modelLabel(entry.model)}
          </option>
        ))}
      </select>
      {current !== undefined && (
        <span className={`sg-pill ${current.ready ? 'ready' : 'setup'}`}>{current.ready ? 'ready' : 'setup'}</span>
      )}
      {current !== undefined && <span className="sg-model-chip">{modelLabel(current.model)}</span>}
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
        Model
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
          <h3>Model for {current.name}</h3>
          <ModelPicker value={editModel} onChange={setEditModel} disabled={busy} />
          <div className="sg-create-actions">
            <button type="button" className="sg-head-btn" disabled={busy} onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy} onClick={saveModel}>
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

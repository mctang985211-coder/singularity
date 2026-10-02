import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { ModelRef } from '../types'

const EFFORTS = ['off', 'low', 'high', 'max']

interface Props {
  value: ModelRef | null
  onChange: (value: ModelRef | null) => void
  disabled?: boolean
}

/** The two-level provider/model choice, plus reasoning effort; null means the deployment default. */
export default function ModelPicker({ value, onChange, disabled = false }: Props) {
  const models = useStore(s => s.models)
  const modelsError = useStore(s => s.modelsError)
  const loadModels = useStore(s => s.loadModels)
  const [providerId, setProviderId] = useState(value?.provider ?? '')
  const [modelId, setModelId] = useState(value?.model ?? '')
  const [effort, setEffort] = useState(value?.reasoningEffort ?? '')

  useEffect(() => {
    void loadModels()
  }, [loadModels])

  if (models === null) {
    return (
      <div className="sg-model-note">
        {modelsError === null ? 'Loading models…' : `Model options unavailable — ${modelsError}`}
      </div>
    )
  }

  const providers = models.providers
  const provider = providers.find(entry => entry.id === providerId)
  const broken = provider !== undefined && (provider.error !== undefined || provider.models.length === 0)
  const reason = provider?.error ?? 'No models available'

  const emit = (nextProvider: string, nextModel: string, nextEffort: string) => {
    onChange({
      provider: nextProvider,
      model: nextModel,
      ...(nextEffort === '' ? {} : { reasoningEffort: nextEffort }),
    })
  }

  const pickProvider = (id: string) => {
    setEffort('')
    setProviderId(id)
    if (id === '') {
      setModelId('')
      onChange(null)
      return
    }
    const first = providers.find(entry => entry.id === id)?.models[0]?.id ?? ''
    setModelId(first)
    emit(id, first, '')
  }

  const pickModel = (id: string) => {
    setModelId(id)
    emit(providerId, id, effort)
  }

  return (
    <>
      <label>
        Model
        <select value={providerId} disabled={disabled} onChange={event => pickProvider(event.target.value)}>
          <option value="">
            Default — {models.default.provider}/{models.default.model}
          </option>
          {providers.map(entry => (
            <option
              key={entry.id}
              value={entry.id}
              disabled={entry.error !== undefined || entry.models.length === 0}
            >
              {entry.displayName}
              {entry.error !== undefined ? ` — ${entry.error}` : entry.models.length === 0 ? ' — no models' : ''}
            </option>
          ))}
        </select>
      </label>
      {providerId !== '' && (
        <>
          <label>
            Provider model
            <select
              value={broken ? '' : modelId}
              disabled={disabled || broken}
              onChange={event => pickModel(event.target.value)}
            >
              {broken && <option value="">{reason}</option>}
              {(provider?.models ?? []).map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning effort
            <select
              value={effort}
              disabled={disabled || broken}
              onChange={event => {
                setEffort(event.target.value)
                emit(providerId, modelId, event.target.value)
              }}
            >
              <option value="">Default</option>
              {EFFORTS.map(entry => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </>
  )
}

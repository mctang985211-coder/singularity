import { useEffect } from 'react'
import GraphSwitcher from './components/GraphSwitcher'
import { PANELS, panelById } from './panels'
import { useStore } from './store'

export default function App() {
  const tab = useStore(s => s.tab)
  const setTab = useStore(s => s.setTab)
  const boot = useStore(s => s.boot)
  const loadGraphs = useStore(s => s.loadGraphs)
  const applyChat = useStore(s => s.applyChat)
  const bootError = useStore(s => s.bootError)
  const graphsError = useStore(s => s.graphsError)
  const Active = panelById(tab).component

  useEffect(() => {
    void boot()
    return () => {
      useStore.getState().source?.close()
    }
  }, [boot])

  useEffect(() => {
    void loadGraphs()
  }, [loadGraphs])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== location.origin) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.graphId !== useStore.getState().graphId) return
      if (data.type === 'singularity:session-error') useStore.setState({ error: data.message })
      if (data.type === 'singularity:prompt-result') useStore.getState().finishPrompt(data.requestId, data.error)
      if (data.type === 'singularity:transcript') {
        if (typeof data.sessionId !== 'string') throw new Error('map: transcript missing sessionId')
        if (!Array.isArray(data.rows)) throw new Error('map: transcript missing rows')
        applyChat(data.sessionId, data.rows)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [applyChat])

  return (
    <div className="sg-app">
      <header className="sg-head">
        <GraphSwitcher />
        <nav className="sg-tabs" role="tablist" aria-label="Panels">
          {PANELS.map(panel => (
            <button
              key={panel.id}
              type="button"
              role="tab"
              aria-selected={panel.id === tab}
              className={`sg-tab${panel.id === tab ? ' active' : ''}`}
              onClick={() => setTab(panel.id)}
            >
              {panel.label}
            </button>
          ))}
        </nav>
      </header>
      {bootError !== null && (
        <div className="sg-banner" role="alert">
          {bootError}
        </div>
      )}
      {graphsError !== null && (
        <div className="sg-banner" role="alert">
          {graphsError}
        </div>
      )}
      <main className="sg-panel-body">
        <Active />
      </main>
    </div>
  )
}

import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/**
 * The map SPA reads `window.location` the moment it is imported, so every test
 * stubs the browser's globals first and pulls the modules in afterwards.
 */
async function loadMap() {
  vi.stubGlobal('window', { location: { search: '?graphId=a' }, parent: { postMessage: vi.fn() } })
  vi.stubGlobal('location', { origin: 'http://test.local' })
  const store = await import('../../map/src/store.ts')
  const panels = await import('../../map/src/panels/index.ts')
  const switcher = await import('../../map/src/components/GraphSwitcher.tsx')
  return { ...store, ...panels, ...switcher }
}

const legacyHistory = {
  formatVersion: 'legacy-v1',
  writable: false,
  graph: {
    id: 'old',
    name: 'Old graph',
    ready: true,
    rootSessionId: 'root-old',
    graphStoreId: 'g-old',
    layoutStoreId: 'l-old',
    access: { mode: 'legacy-readonly', reason: 'graph "old" carries no protocol marker' },
  },
  access: { mode: 'legacy-readonly', reason: 'graph "old" carries no protocol marker' },
  topology: { version: 1, id: 'g-old', roots: ['root-old'], agents: [{ id: 'root-old', name: 'Old root', status: 'idle' }], edges: [] },
  layout: { version: 1, id: 'l-old', nodes: { 'root-old': { x: 0, y: 0, width: 10, height: 10, shape: 'card' } } },
  tasks: null,
  proposals: [{ proposalId: 'p-1', status: 'applied' }],
  experiments: [],
  completions: [{ format: 'legacy-v1', sessionId: 's-1', taskId: 't-1', note: 'closed: the holdout held', recordedAt: '2026-01-01' }],
  sources: [{ id: 'g-old', kind: 'topology', exists: true }],
}

it('opens a sealed graph as history: no canvas request, no selection, no method read', async () => {
  const calls: string[] = []
  const postMessage = vi.fn()
  vi.stubGlobal('window', {
    location: { search: '?graphId=old', href: 'http://test.local/singularity/map/?graphId=old' },
    history: { replaceState: vi.fn() },
    parent: { postMessage },
  })
  vi.stubGlobal('location', { origin: 'http://test.local' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith('/singularity/graphs/old/history')) return new Response(JSON.stringify(legacyHistory))
      if (url.startsWith('/singularity/graph?') || url === '/singularity/graph') {
        return new Response(
          JSON.stringify({
            meta: { id: 'old', name: 'Old graph', rootSessionId: 'root-old', graphStoreId: 'g-old', layoutStoreId: 'l-old', ready: true },
            access: { mode: 'legacy-readonly', reason: 'graph "old" carries no protocol marker' },
            graph: null,
            layout: null,
          }),
        )
      }
      if (url.startsWith('/singularity/hitl')) return new Response(JSON.stringify({ pending: [] }))
      if (url === '/singularity/graphs') {
        return new Response(
          JSON.stringify({
            graphs: [
              {
                id: 'old',
                name: 'Old graph',
                ready: true,
                rootSessionId: 'root-old',
                graphStoreId: 'g-old',
                layoutStoreId: 'l-old',
                access: { mode: 'legacy-readonly', reason: 'no protocol marker' },
              },
              { id: 'live', name: 'Live graph', ready: true, access: { mode: 'current' } },
            ],
            selectedId: 'live',
          }),
        )
      }
      throw new Error(`unexpected request ${url}`)
    }),
  )
  const sources: string[] = []
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      constructor(url: string) {
        super()
        sources.push(url)
      }
      close() {}
    },
  )

  const { useStore: store } = await import('../../map/src/store.ts')
  await store.getState().boot()
  const state = store.getState()

  // The sealed graph is history: its own read answers, and no canvas state is built.
  expect(state.access).toBe('legacy-readonly')
  expect(state.readOnly).toBe(true)
  expect(state.history).toMatchObject({ formatVersion: 'legacy-v1', writable: false })
  expect(state.graph).toBeNull()
  expect(state.layout).toBeNull()
  expect(state.graphMeta?.id).toBe('old')

  // The console never assembles an evaluation of its own: no event stream, no method read.
  expect(sources).toEqual([])
  expect(calls).toEqual(['GET /singularity/graph?graphId=old', 'GET /singularity/hitl', 'GET /singularity/graphs/old/history'])
  expect(calls.some(call => call.includes('evolution'))).toBe(false)
  expect(calls.some(call => call.includes('/view'))).toBe(false)

  // Switching to the sealed graph is a read: no selection is posted for it.
  calls.length = 0
  await store.getState().switchGraph('old')
  expect(calls.some(call => call.startsWith('POST /singularity/graphs/old/select'))).toBe(false)
  expect(calls.some(call => call.startsWith('GET /singularity/graphs/old/history'))).toBe(true)

  // Every write the console could attempt refuses by name and issues no request.
  calls.length = 0
  await expect(store.getState().moveNode('root-old', 5, 5)).rejects.toThrow('sealed legacy history')
  await expect(store.getState().sendPrompt('root-old', 'hello')).rejects.toThrow('sealed legacy history')
  await expect(store.getState().answerHitl('h-1', { kind: 'ask', text: 'x' })).rejects.toThrow('sealed legacy history')
  await expect(store.getState().updateGraphSettings('old', { rsi: null })).rejects.toThrow('sealed legacy history')
  expect(calls).toEqual([])
  expect(postMessage).not.toHaveBeenCalled()
})

it('shows a sealed graph one history panel and no write control at all', async () => {
  const { panelsFor, headControls, readOnlyOf } = await loadMap()
  const legacy = panelsFor('legacy-readonly')
  expect(legacy.map(panel => panel.id)).toEqual(['history'])
  expect(legacy.some(panel => panel.id === 'canvas')).toBe(false)

  const current = panelsFor('current')
  expect(current.map(panel => panel.id)).toEqual(['canvas', 'view', 'tasks', 'recovery', 'verifier'])
  expect(current.some(panel => panel.id === 'history')).toBe(false)

  // The header renders Settings and Delete for a current graph, and neither for a sealed one.
  expect(headControls('current')).toEqual(['settings', 'delete'])
  expect(headControls('legacy-readonly')).toEqual([])

  expect(readOnlyOf('current')).toBe(false)
  expect(readOnlyOf('legacy-readonly')).toBe(true)
})

it('renders the derived progress of a current graph from the one read model', async () => {
  vi.stubGlobal('window', { location: { search: '?graphId=a' }, parent: { postMessage: vi.fn() } })
  vi.stubGlobal('location', { origin: 'http://test.local' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/singularity/view')) {
        return new Response(
          JSON.stringify({
            formatVersion: 2,
            graph: { id: 'a', name: 'A', createdAt: 1 },
            access: { mode: 'current' },
            revision: { revisionId: 'r0002', manifestDigest: 'sha256:bb', origin: 'published', publishedAt: '2026-10-08T00:00:00.000Z' },
            evaluation: { state: 'published', reportRef: 'report-2', candidateRef: 'd0002', decidedAt: '2026-10-08T01:00:00.000Z' },
            progress: { round: 2, rounds: 3, phase: 'running', note: 'round 2 published' },
            generation: 11,
          }),
        )
      }
      if (url.startsWith('/singularity/graph?') || url === '/singularity/graph') {
        return new Response(
          JSON.stringify({
            meta: { id: 'a', name: 'A', rootSessionId: 'root-a', graphStoreId: 'g-a', layoutStoreId: 'l-a', ready: true },
            access: { mode: 'current' },
            graph: { version: 1, id: 'g-a', roots: ['root-a'], agents: [{ id: 'root-a', name: 'A', status: 'idle' }], edges: [] },
            layout: { version: 1, id: 'l-a', nodes: { 'root-a': { x: 0, y: 0, width: 10, height: 10, shape: 'card' } } },
          }),
        )
      }
      if (url.startsWith('/singularity/hitl')) return new Response(JSON.stringify({ pending: [] }))
      throw new Error(`unexpected request ${url}`)
    }),
  )
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      close() {}
    },
  )

  const { useStore: store } = await import('../../map/src/store.ts')
  await store.getState().boot()
  expect(store.getState().access).toBe('current')
  await store.getState().loadView()
  expect(store.getState().graphView).toMatchObject({
    revision: { revisionId: 'r0002' },
    evaluation: { state: 'published' },
    progress: { round: 2, rounds: 3, phase: 'running' },
  })
  expect(store.getState().graphViewError).toBeNull()
})

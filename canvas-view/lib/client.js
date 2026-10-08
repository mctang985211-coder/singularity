window.__ModuleLoader__.load({
  id: '@dangosys/dsh-singularity-canvas-view',
  factory: require => {
    const module = { exports: {} }
    const NS = 'singularity-canvas-view'
    const MAP = '/singularity/map/'
    const GRAPH = '/singularity/graph'
    const en = { 'panel.label': 'Singularity' }
    const zh = { 'panel.label': 'Singularity' }

    const blocksText = content =>
      content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')

    module.exports.transcriptRows = (entries, session, inbox) => {
      const rows = []
      const admitted = new Set()
      const durableMessages = new Set()
      const liveRows = new Map()
      for (const entry of entries) {
        if (entry.type === 'transient') {
          const event = entry.event
          if (event.type !== 'assistant/live-chunk' || event.data.chunk.type !== 'text-delta') continue
          const index = liveRows.get(event.data.attemptId)
          if (index === undefined) {
            liveRows.set(event.data.attemptId, rows.length)
            rows.push({ role: 'assistant', text: event.data.chunk.text })
          } else {
            rows[index].text += event.data.chunk.text
          }
          continue
        }
        const event = entry.event
        if (event.type === 'user/message' && event.data.source.kind === 'user') {
          durableMessages.add(event.data.id)
          if (event.data.source.rpcId !== undefined) admitted.add(event.data.source.rpcId)
          const text = blocksText(event.data.content)
          if (text) rows.push({ role: 'user', text })
        } else if (event.type === 'assistant/message') {
          const text = blocksText(event.data.message.content)
          if (text) rows.push({ role: 'assistant', text })
        }
      }
      // Pending input now comes from the durable inbox projection instead of
      // the removed snapshot queue: next-turn (queued) rows render before
      // next-step (steering) rows, each list in its own array order. The old
      // single queue's interleaving across both lists is not recoverable.
      for (const target of ['next-turn', 'next-step']) {
        for (const item of inbox?.[target] ?? []) {
          const source = item?.source
          if (durableMessages.has(item.id) || source === undefined || source.kind !== 'user') continue
          if (source.rpcId !== undefined) {
            if (admitted.has(source.rpcId)) continue
            admitted.add(source.rpcId)
          }
          const text = blocksText(item.content)
          if (text) rows.push({ role: 'user', text })
        }
      }
      for (const pending of session.pendingSubmissions) {
        if (!admitted.has(pending.requestId) && pending.text) rows.push({ role: 'user', text: pending.text })
      }
      return rows
    }

    module.exports.inject = ['sessions', 'slots', 'locale']

    // The target a chat opens under: a known durable address wins, a graph-edge parent yields the
    // child's address, and everything else (roots, plain Sessions) keeps its bare id.
    module.exports.subagentTarget = (sessionId, parentSessionId, known) => {
      if (known !== undefined) return known
      if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) return sessionId
      return { parentSessionId, childSessionId: sessionId, mode: 'unknown' }
    }

    // Mirrors ui-subagent's composer rule: only a continuable child with an available parent takes input.
    module.exports.readOnlyChat = snapshot => {
      const subagent = snapshot.subagent
      if (subagent === null || subagent === undefined) return false
      return subagent.address.mode !== 'continuable' || subagent.parentAvailable === false
    }

    module.exports.apply = ctx => {
      // Required lazily: the transcript unit test evaluates the factory without a loader require.
      const React = require('react')
      const h = React.createElement
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'canvas-view: locale')

      const RailIcon = ({ size, active }) =>
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('polygon', {
            points: '8 1.7 13.4 4.8 13.4 11.2 8 14.3 2.6 11.2 2.6 4.8',
            strokeWidth: 1.3,
            fill: active ? 'currentColor' : 'none',
            fillOpacity: active ? 0.16 : 0,
          }),
          h('path', { d: 'M8 8 8 1.7M8 8 13.4 11.2M8 8 2.6 11.2', strokeWidth: 1 }),
          h('circle', { cx: 8, cy: 8, r: 1.3, fill: 'currentColor', stroke: 'none' }),
        )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'singularity', order: 30, label: () => t('panel.label') },
              RailIcon,
            ),
          ),
        'canvas-view: rail icon',
      )

      let frame = null
      let currentGraphId = null
      let chatGeneration = 0
      let chat = { sessionId: null, dispose: null, readOnly: false }

      const report = error => {
        console.error('singularity-canvas-view:', error instanceof Error ? error.message : String(error))
      }

      const request = async (url, init) => {
        const res = await fetch(url, init)
        const text = await res.text()
        if (!res.ok) {
          const error = new Error(text || 'HTTP ' + res.status)
          error.status = res.status
          throw error
        }
        return text.length === 0 ? undefined : JSON.parse(text)
      }

      const post = message => {
        frame?.contentWindow?.postMessage(message, location.origin)
      }

      const clearChat = () => {
        chatGeneration += 1
        if (chat.dispose) chat.dispose()
        chat = { sessionId: null, dispose: null, readOnly: false }
      }

      const reportSessionError = (sessionId, message) => {
        post({ type: 'singularity:session-error', graphId: currentGraphId, sessionId, message })
      }

      // The map sends the child's spawn-edge parent; a mode the client cannot confirm stays 'unknown',
      // which the binding snapshot upgrades from the child's own identity once it is read.
      const chatTarget = async (sessionId, parentSessionId) => {
        const known = ctx.sessions.subagentAddress(sessionId)
        if (known !== undefined) return known
        if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
          return module.exports.subagentTarget(sessionId, parentSessionId, undefined)
        }
        try {
          await ctx.sessions.refreshProjections(parentSessionId)
        } catch (error) {
          report(error)
        }
        return module.exports.subagentTarget(sessionId, parentSessionId, ctx.sessions.subagentAddress(sessionId))
      }

      const bindChat = async (sessionId, parentSessionId) => {
        const generation = ++chatGeneration
        if (chat.dispose) chat.dispose()
        chat = { sessionId, dispose: null, readOnly: false }
        await ctx.sessions.refresh()
        if (generation !== chatGeneration) return
        const target = await chatTarget(sessionId, parentSessionId)
        if (generation !== chatGeneration) return
        // The iframe's reference owns the binding for as long as its chat is
        // displayed; binding(id) alone now only borrows an already-retained one.
        const reference = ctx.sessions.retain(target, { source: 'canvasView' })
        chat.dispose = () => { reference.release() }
        let binding
        try {
          binding = await reference.ready
        } catch (error) {
          if (generation !== chatGeneration) return
          chat.dispose = null
          reference.release()
          reportSessionError(sessionId, error instanceof Error ? error.message : String(error))
          return
        }
        if (generation !== chatGeneration) return
        const inbox = binding.session.projections.faceOf('inbox')
        const paint = () => {
          if (generation !== chatGeneration) return
          const snapshot = binding.session.getSnapshot()
          if (snapshot.openState === 'error') {
            reportSessionError(sessionId, snapshot.openError.message)
            return
          }
          const readOnly = module.exports.readOnlyChat(snapshot)
          if (readOnly !== chat.readOnly) chat.readOnly = readOnly
          const rows = module.exports.transcriptRows(
            binding.eventSource.getSnapshot().entries,
            snapshot,
            inbox.getSnapshot(),
          )
          post({ type: 'singularity:transcript', graphId: currentGraphId, sessionId, rows, readOnly })
        }
        paint()
        const stopEvents = binding.eventSource.subscribe(paint)
        const stopSession = binding.session.subscribe(paint)
        const stopInbox = inbox.subscribe(paint)
        chat.dispose = () => {
          stopEvents()
          stopSession()
          stopInbox()
          reference.release()
        }
      }

      const onMessage = event => {
        if (event.source !== frame?.contentWindow || event.origin !== location.origin) return
        const data = event.data
        if (!data || typeof data !== 'object') return
        if (typeof data.graphId !== 'string' || data.graphId.length === 0) return
        if (data.graphId !== currentGraphId) {
          currentGraphId = data.graphId
          clearChat()
        }
        if (data.type === 'singularity:open') {
          if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) {
            report('open message missing sessionId')
            return
          }
          void bindChat(data.sessionId, data.parentSessionId).catch(report)
          return
        }
        if (data.type === 'singularity:prompt') {
          const target = event.source
          if (typeof data.sessionId !== 'string' || typeof data.text !== 'string') {
            report('prompt message invalid')
            return
          }
          const generation = chatGeneration
          const submit = async () => {
            const view = await request(GRAPH + '?graphId=' + encodeURIComponent(data.graphId))
            if (generation !== chatGeneration) throw new Error('singularity: session changed during submission')
            // A sealed legacy graph is history: the runtime owns no inbox for it,
            // so a prompt is refused here rather than queued against nothing.
            if (view.access !== undefined && view.access.mode === 'legacy-readonly') {
              throw new Error('singularity: this graph is sealed legacy history and takes no prompt')
            }
            if (!view.meta.ready) throw new Error('singularity: graph is not ready')
            if (!view.graph.agents.some(agent => agent.id === data.sessionId))
              throw new Error('singularity: session is not in this graph')
            const text = data.text.trim()
            if (text.length === 0) throw new Error('singularity: empty prompt')
            if (chat.sessionId !== data.sessionId) throw new Error('singularity: prompt session is not bound')
            if (chat.readOnly) throw new Error('singularity: this node is read-only here; its runtime owns the inbox')
            const binding = ctx.sessions.binding(data.sessionId)
            if (binding === undefined) throw new Error('singularity: session binding missing')
            const handle = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })
            try {
              const result = await binding.session.prompt(
                [{ type: 'text', text }],
                'queue',
                undefined,
                handle.requestId,
              )
              if (!result.ok) throw new Error('singularity chat: ' + JSON.stringify(result.error))
            } catch (error) {
              handle.abandon()
              throw error
            }
          }
          void submit().then(
            () => {
              target.postMessage(
                { type: 'singularity:prompt-result', graphId: data.graphId, requestId: data.requestId },
                location.origin,
              )
            },
            error => {
              target.postMessage(
                {
                  type: 'singularity:prompt-result',
                  graphId: data.graphId,
                  requestId: data.requestId,
                  error: error instanceof Error ? error.message : String(error),
                },
                location.origin,
              )
            },
          )
        }
      }

      const attachFrame = el => {
        frame = el
        if (el === null) {
          currentGraphId = null
          clearChat()
        }
      }

      function SingularityPage() {
        return h(
          'div',
          { style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0 } },
          h('iframe', {
            ref: attachFrame,
            src: MAP,
            title: 'Singularity map',
            style: { border: 0, width: '100%', height: '100%', display: 'block' },
          }),
        )
      }

      ctx.effect(
        () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'singularity' }, SingularityPage)),
        'canvas-view: page',
      )

      ctx.effect(() => {
        window.addEventListener('message', onMessage)
        return () => {
          window.removeEventListener('message', onMessage)
          clearChat()
        }
      }, 'canvas-view: bridge')
    }
    return module.exports
  },
})

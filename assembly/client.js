window.__ModuleLoader__.load({
  id: '@dangosys/dsh-singularity-next',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

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
        if (event.type === 'user/message') {
          durableMessages.add(event.data.id)
          if (event.data.source.rpcId !== undefined) admitted.add(event.data.source.rpcId)
          const text = blocksText(event.data.content)
          if (text) rows.push({ role: 'user', text })
        } else if (event.type === 'assistant/message') {
          const text = blocksText(event.data.message.content)
          if (text) rows.push({ role: 'assistant', text })
        }
      }
      for (const target of ['next-turn', 'next-step']) {
        for (const item of inbox?.[target] ?? []) {
          const source = item?.source
          if (durableMessages.has(item.id) || source === undefined) continue
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

    const { createElement } = require('react')

    const PANEL_PATH = '/singularity/panel/'
    const PANEL_ID = 'singularity-tasks'

    let attachFrame = () => undefined
    function TasksPage() {
      return createElement('iframe', {
        src: PANEL_PATH,
        ref: element => attachFrame(element),
        title: 'Singularity map',
        'data-panel-frame': PANEL_ID,
        style: { border: 0, width: '100%', height: '100%', display: 'block' },
      })
    }

    function TasksIcon(props) {
      return createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: props.active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: props.active ? 1.8 : 1.3,
          'aria-hidden': 'true',
        },
        createElement('rect', { x: 2.5, y: 2.5, width: 11, height: 3.5, rx: 1 }),
        createElement('rect', { x: 4.5, y: 7.5, width: 9, height: 3.5, rx: 1 }),
        createElement('rect', { x: 6.5, y: 12.5, width: 7, height: 1.5, rx: 0.75 }),
      )
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      let frame,
        current,
        dispose,
        generation = 0
      const post = data => frame?.contentWindow?.postMessage(data, location.origin)
      const clear = () => {
        generation++
        dispose?.()
        dispose = undefined
        current = undefined
      }
      attachFrame = element => {
        frame = element
        if (element === null) clear()
      }
      const bind = async id => {
        clear()
        if (id === null) return
        const version = generation
        const reference = ctx.sessions.retain(id, { source: 'singularity' })
        dispose = () => reference.release()
        let binding
        try {
          binding = await reference.ready
        } catch (error) {
          if (version !== generation) return
          clear()
          throw error
        }
        if (version !== generation) return
        current = binding
        const inbox = binding.session.projections.faceOf('inbox')
        const paint = () => {
          if (version !== generation) return
          const snapshot = binding.session.getSnapshot()
          if (snapshot.openState === 'error') {
            post({ type: 'singularity:session-error', sessionId: id, message: snapshot.openError.message })
            return
          }
          post({
            type: 'singularity:transcript',
            sessionId: id,
            rows: module.exports.transcriptRows(
              binding.eventSource.getSnapshot().entries,
              snapshot,
              inbox.getSnapshot(),
            ),
          })
        }
        paint()
        const stops = [binding.eventSource.subscribe(paint), binding.session.subscribe(paint), inbox.subscribe(paint)]
        dispose = () => {
          stops.forEach(stop => stop())
          reference.release()
        }
      }
      const receive = event => {
        if (event.source !== frame?.contentWindow || event.origin !== location.origin) return
        const data = event.data
        if (data.type === 'singularity:open')
          void bind(data.sessionId).catch(error =>
            post({ type: 'singularity:session-error', sessionId: data.sessionId, message: String(error) }),
          )
        if (data.type === 'singularity:prompt') {
          const submit = async () => {
            if (current === undefined || ctx.sessions.binding(data.sessionId) !== current)
              throw new Error('Session binding changed')
            const handle = current.session.beginSubmission({ mode: 'queue', text: data.text, attachments: [] })
            try {
              const result = await current.session.prompt(
                [{ type: 'text', text: data.text }],
                'queue',
                undefined,
                handle.requestId,
              )
              if (!result.ok) throw new Error(JSON.stringify(result.error))
            } catch (error) {
              handle.abandon()
              throw error
            }
          }
          void submit().catch(error =>
            post({ type: 'singularity:session-error', sessionId: data.sessionId, message: String(error) }),
          )
        }
      }
      window.addEventListener('message', receive)
      ctx.effect(() => () => {
        clear()
        window.removeEventListener('message', receive)
      })
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, TasksPage))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'Singularity' }, TasksIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

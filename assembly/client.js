/**
 * The panel's browser half: the task log as a person reads it.
 *
 * Hand-written, and it has to be. The Host reads `exports["./client"]` off the package and serves those
 * exact bytes — there is no bundler at runtime — so this file is both the source and the artifact. That
 * is why it is a `window.__ModuleLoader__.load` wrapper rather than an ES module, and why it may only
 * `require` the platform's seed words: anything else throws "missed the module table" at boot, in the
 * browser, where nobody is reading a stack trace.
 *
 * The panel renders one read and nothing else. It does not poll (a poll is a request per interval for a
 * log that only changes when somebody acts), does not write, and does not hold a cut across a click: the
 * Refresh button exists because re-reading is a *user* action here, and the page prints the `cutoff` it
 * actually read rather than the one it expected. A failed read renders the failure's own text — a blank
 * panel and a panel whose route is not mounted look identical, and only one of those is a bug.
 *
 * @module @dangosys/dsh-singularity-next/client
 */
window.__ModuleLoader__.load({
  id: '@dangosys/dsh-singularity-next',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx, jsxs } = require('react/jsx-runtime')
    const { createElement, useCallback, useEffect, useState } = require('react')

    /**
     * The one route this panel reads, absolute because that is how the Host registered it. A 200 carrying
     * `text/html` is the SPA answering for a route that was never mounted, so the content type is checked
     * before the body is trusted.
     */
    const TASKS_ROUTE = '/singularity/tasks'
    /** The panel's identity, shared by its sidebar row and its main page: one id, one panel. */
    const PANEL_ID = 'singularity-tasks'

    /**
     * Read one cut.
     * @param signal - aborts the request when the panel unmounts.
     * @returns the snapshot, or a string naming what went wrong.
     */
    async function readCut(signal) {
      let response
      try {
        response = await fetch(TASKS_ROUTE, { signal, headers: { accept: 'application/json' } })
      } catch (error) {
        if (error.name === 'AbortError') throw error
        return { error: `${TASKS_ROUTE} could not be reached: ${error.message}` }
      }
      if (!response.ok) return { error: `${TASKS_ROUTE} answered ${response.status} ${response.statusText}` }
      const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json')
        return { error: `${TASKS_ROUTE} answered ${type === '' ? 'no content type' : type}, not JSON — is the route mounted?` }
      try {
        return { snapshot: await response.json() }
      } catch (error) {
        return { error: `${TASKS_ROUTE} did not answer JSON: ${error.message}` }
      }
    }

    /**
     * Hold the last read, and re-read whenever `round` changes.
     *
     * `round` counts reads rather than cuts on purpose: a refresh that lands on the same cut still
     * re-renders, because the panel's job is to show what it just read, not to show it once. Every read
     * carries its own abort signal so an unmount cancels the request it started.
     */
    function useCut() {
      const [round, setRound] = useState(0)
      const [status, setStatus] = useState('reading')
      const [reads, setReads] = useState(0)
      useEffect(() => {
        const controller = new AbortController()
        readCut(controller.signal).then(
          next => {
            setStatus(next)
            // A landed read, counted. A reader that has to know "did the click finish" cannot get it
            // from the button alone: a fast route leaves no disabled frame to observe.
            setReads(previous => previous + 1)
          },
          () => undefined,
        )
        return () => controller.abort()
      }, [round])
      const refresh = useCallback(() => {
        setStatus('reading')
        setRound(previous => previous + 1)
      }, [])
      return { status, refresh, reads }
    }

    const panelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '16px 20px',
      height: '100%',
      boxSizing: 'border-box',
      overflowY: 'auto',
      font: 'var(--dsw-font-sm-13, 13px/20px sans-serif)',
      color: 'var(--dsw-alias-label-secondary, inherit)',
    }
    const headingStyle = { font: 'var(--dsw-font-md-15, 15px/22px sans-serif)', color: 'var(--dsw-alias-label-primary, inherit)', margin: 0 }
    const groupStyle = { margin: '4px 0 0', display: 'flex', flexDirection: 'column', gap: '2px' }
    const rowStyle = { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', padding: '4px 0' }
    const idStyle = { font: 'var(--ds-font-family-code, monospace)', color: 'var(--dsw-alias-label-primary, inherit)' }
    const faded = { color: 'var(--dsw-alias-label-caption, inherit)' }
    const ruled = { ...groupStyle, borderTop: '1px solid var(--dsw-alias-border-l1, #8883)', paddingTop: '6px' }
    const errorStyle = { ...rowStyle, color: 'var(--dsw-alias-state-error-primary, #c00)', whiteSpace: 'pre-wrap' }

    /** A run's own words, or nothing: a run that recorded no detail is not given an invented sentence. */
    function Run(props) {
      const run = props.run
      return jsxs('div', {
        style: rowStyle,
        'data-run': run.runId,
        'data-status': run.status,
        children: [
          jsx('span', { style: idStyle, children: run.runId }),
          jsx('span', { children: run.status }),
          run.detail === null ? null : jsx('span', { style: faded, children: run.detail }),
        ],
      })
    }

    function Task(props) {
      const task = props.task
      return jsxs('div', {
        style: ruled,
        'data-task': task.taskId,
        'data-phase': task.phase,
        children: [
          jsxs('div', {
            style: rowStyle,
            children: [jsx('span', { style: idStyle, children: task.taskId }), jsx('span', { children: task.phase })],
          }),
          jsx('div', { style: faded, children: task.goal }),
          task.runs.length === 0
            ? jsx('div', { style: faded, children: 'no runs yet' })
            : jsx('div', { children: task.runs.map(run => jsx(Run, { run, key: run.runId })) }),
        ],
      })
    }

    function Child(props) {
      const child = props.child
      return jsxs('div', {
        style: rowStyle,
        'data-child': child.taskId,
        'data-status': child.status,
        children: [
          jsx('span', { style: idStyle, children: child.taskId }),
          jsx('span', { children: child.status }),
          jsx('span', { style: faded, children: `runs ${child.runsUsed}/${child.maxRuns}` }),
          child.dependsOn.length === 0 ? null : jsx('span', { style: faded, children: `after ${child.dependsOn.join(', ')}` }),
          child.reason === null ? null : jsx('span', { style: faded, children: child.reason }),
        ],
      })
    }

    function Plan(props) {
      const plan = props.plan
      return jsxs('div', {
        style: ruled,
        'data-plan': plan.parentTaskId,
        'data-complete': String(plan.complete),
        children: [
          jsxs('div', {
            style: rowStyle,
            children: [
              jsx('span', { style: idStyle, children: plan.parentTaskId }),
              jsx('span', { children: plan.complete ? 'complete' : 'in progress' }),
            ],
          }),
          jsx('div', { children: plan.children.map(child => jsx(Child, { child, key: child.taskId })) }),
          jsxs('div', {
            style: faded,
            children: plan.criteria.map(criterion =>
              jsxs(
                'span',
                {
                  style: { marginRight: '8px' },
                  'data-criterion': criterion.criterionId,
                  'data-satisfied-by': criterion.satisfiedBy ?? '',
                  children: [criterion.criterionId, ': ', criterion.satisfiedBy ?? 'unsatisfied'],
                },
                criterion.criterionId,
              ),
            ),
          }),
        ],
      })
    }

    /**
     * The page. One read on mount, one on every click. The cutoff is printed as it was read and carried
     * on an element, so a reader that needs to compare it against the route does not parse prose.
     */
    function TasksPanel() {
      const { status, refresh, reads } = useCut()
      const reading = status === 'reading'
      const snapshot = reading ? undefined : status.snapshot
      const error = reading ? undefined : status.error
      return jsxs('div', {
        style: panelStyle,
        'data-panel': PANEL_ID,
        'data-reads': String(reads),
        children: [
          jsxs('div', {
            style: { ...rowStyle, justifyContent: 'space-between' },
            children: [
              jsx('h2', { style: headingStyle, children: 'Singularity tasks' }),
              jsx('button', {
                type: 'button',
                'data-refresh': '',
                onClick: refresh,
                disabled: reading,
                children: reading ? 'Reading…' : 'Refresh',
              }),
            ],
          }),
          jsxs('div', {
            style: faded,
            children: [
              jsx('span', { children: 'control ' }),
              jsx('span', { style: idStyle, 'data-control': '', children: snapshot === undefined ? '—' : snapshot.controlId }),
              jsx('span', { children: ' · cut ' }),
              jsx('span', { style: idStyle, 'data-cutoff': '', children: snapshot === undefined ? '—' : String(snapshot.cutoff) }),
            ],
          }),
          error === undefined ? null : jsx('div', { style: errorStyle, 'data-error': '', children: error }),
          snapshot === undefined
            ? null
            : jsxs('div', {
                style: { display: 'contents' },
                children: [
                  jsx('div', { style: { ...groupStyle, marginTop: '8px', fontWeight: 500 }, children: `Tasks (${snapshot.tasks.length})` }),
                  snapshot.tasks.length === 0
                    ? jsx('div', { style: faded, children: 'this control holds no tasks yet' })
                    : jsx('div', { children: snapshot.tasks.map(task => jsx(Task, { task, key: task.taskId })) }),
                  jsx('div', { style: { ...groupStyle, marginTop: '8px', fontWeight: 500 }, children: `Plans (${snapshot.plans.length})` }),
                  snapshot.plans.length === 0
                    ? jsx('div', { style: faded, children: 'this control holds no plans yet' })
                    : jsx('div', { children: snapshot.plans.map(plan => jsx(Plan, { plan, key: plan.parentTaskId })) }),
                ],
              }),
        ],
      })
    }

    /**
     * The sidebar row's glyph. The sidebar owns the row and its size; this only decides what the mark
     * looks like at that size, and firms up when the panel is the active one.
     */
    function TasksIcon(props) {
      const size = props.size
      return createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.active ? 1.8 : 1.3,
          'aria-hidden': 'true',
        },
        createElement('rect', { x: 2.5, y: 2.5, width: 11, height: 3.5, rx: 1 }),
        createElement('rect', { x: 4.5, y: 7.5, width: 9, height: 3.5, rx: 1 }),
        createElement('rect', { x: 6.5, y: 12.5, width: 7, height: 1.5, rx: 0.75 }),
      )
    }

    /** Required service: the slot registry every entry of this panel is registered into. */
    const inject = ['slots']

    /**
     * Claim one sidebar row and one main page, under one id.
     *
     * Both registrations ride `ctx.slots.inject`, which runs the callback when the slot's *declaration*
     * exists and runs it again if the declaring package is ever unloaded — so this plugin does not depend
     * on being loaded after the sidebar, and does not have to unregister by hand.
     */
    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, TasksPanel))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'Tasks' }, TasksIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

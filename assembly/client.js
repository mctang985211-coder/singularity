/**
 * The panel's shell half: one sidebar row, one page, and an iframe between them.
 *
 * Hand-written, and it has to be. The Host reads `exports["./client"]` off the package and serves those
 * exact bytes — there is no bundler at runtime — so this file is both the source and the artifact, which
 * is why it is a `window.__ModuleLoader__.load` wrapper rather than an ES module and why it may only
 * `require` the platform's seed words.
 *
 * **What it does not do is draw the task list.** That is `/singularity/panel`, a page this package
 * serves itself and mounts here in an iframe — the structure the previous singularity's web surface
 * used. The reason is not taste: a page that renders inside the shell's React tree can only be reached
 * by driving the shell (open a session, pick a preset, get a workspace), so the panel's own evidence
 * needed a chat surface to exist at all, and a shell restyle was a way for the task list to break. An
 * iframe whose `src` is this package's own route decouples both: the page is verifiable on its own.
 *
 * @module @dangosys/dsh-singularity-next/client
 */
window.__ModuleLoader__.load({
  id: '@dangosys/dsh-singularity-next',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { createElement } = require('react')

    /** The panel's own page, and its identity: one id for the rail row and the page it opens. */
    const PANEL_PATH = '/singularity/panel/'
    const PANEL_ID = 'singularity-tasks'

    /**
     * The page. An iframe and nothing else, so the panel's rendering is the panel's own page's business
     * and this file has no opinion about the task log at all.
     */
    function TasksPage() {
      return createElement('iframe', {
        src: PANEL_PATH,
        title: 'Singularity tasks',
        'data-panel-frame': PANEL_ID,
        style: { border: 0, width: '100%', height: '100%', display: 'block' },
      })
    }

    /** The rail row's icon. The shell shows the registered `label` as its text. */
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

    /** Required service: the slot registry every entry of this panel is registered into. */
    const inject = ['slots']

    /**
     * Claim one sidebar row and one main page, under one id.
     *
     * Both registrations ride `ctx.slots.inject`, which runs the callback when the slot's declaration
     * exists and runs it again if the declaring package is ever unloaded — so this plugin does not depend
     * on being loaded after the sidebar, and does not have to unregister by hand.
     */
    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, TasksPage))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'Tasks' }, TasksIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

/**
 * The panel page: the task log as a person reads it.
 *
 * A page of its own, served at `/singularity/panel` and mounted in the shell as an iframe — the
 * structure the previous singularity's web surface used. It reads one route, `/singularity/tasks`, with
 * the browser's own session, so it needs nothing from the shell: no React, no module loader, no slot
 * registry. A shell restyle cannot break it, and a probe opens it directly instead of driving a chat
 * surface to reach a task list.
 *
 * It renders one read and nothing else. It does not poll (a poll is a request per interval for a log
 * that only changes when somebody acts), does not write, and does not hold a cut across a click: the
 * Refresh button exists because re-reading is a *user* action here, and the page prints the `cutoff` it
 * actually read rather than the one it expected. A failed read renders the failure's own text — a blank
 * panel and a panel whose route is not mounted look identical, and only one of those is a bug.
 *
 * @module @dangosys/dsh-singularity-next/panel
 */

/// <reference lib="dom" />

/** The one route this page reads. Absolute, because that is how the Host registered it. */
const TASKS_ROUTE = '/singularity/tasks'

const root = document.getElementById('root')
if (root === null) throw new Error('panel: #root is missing from the page this script was served with')

/**
 * Read one cut.
 *
 * @param signal - aborts the request when the page goes away.
 * @returns the snapshot, or an object naming what went wrong.
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
  // A 200 carrying `text/html` is the shell's SPA answering for a route that was never mounted, so the
  // content type is checked before the body is trusted. Without this, "the route is missing" renders as
  // a JSON parse error and reads like a bug in the reader.
  const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (type !== 'application/json')
    return { error: `${TASKS_ROUTE} answered ${type === '' ? 'no content type' : type}, not JSON — is the route mounted?` }
  try {
    return { snapshot: await response.json() }
  } catch (error) {
    return { error: `${TASKS_ROUTE} did not answer JSON: ${error.message}` }
  }
}

/** One element, with its attributes, children and text. */
function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue
    if (name === 'text') {
      node.textContent = String(value)
      continue
    }
    node.setAttribute(name, String(value))
  }
  for (const child of children) node.append(child)
  return node
}

/** A span carrying one field of a record, marked so a reader can find it without parsing prose. */
function field(tag, marker, text, className) {
  const node = element(tag, { text, ...(marker === undefined ? {} : { [marker]: '' }) })
  if (className !== undefined) node.className = className
  return node
}

/** A run's own words, or nothing: a run that recorded no detail is not given an invented sentence. */
function runRow(run) {
  return element('div', { 'data-run': run.runId, 'data-status': run.status, class: 'row' }, [
    field('span', undefined, run.runId, 'id'),
    field('span', undefined, run.status),
    run.detail === null ? null : field('span', undefined, run.detail, 'faded'),
  ].filter(Boolean))
}

function taskRow(task) {
  const runs = task.runs.length === 0
    ? [field('div', undefined, 'no runs yet', 'faded')]
    : task.runs.map(runRow)
  return element('div', { 'data-task': task.taskId, 'data-phase': task.phase, class: 'ruled' }, [
    element('div', { class: 'row' }, [field('span', undefined, task.taskId, 'id'), field('span', undefined, task.phase)]),
    field('div', undefined, task.goal, 'faded'),
    element('div', {}, runs),
  ])
}

function childRow(child) {
  return element('div', { 'data-child': child.taskId, 'data-status': child.status, class: 'row' }, [
    field('span', undefined, child.taskId, 'id'),
    field('span', undefined, child.status),
    field('span', undefined, `runs ${child.runsUsed}/${child.maxRuns}`, 'faded'),
    child.dependsOn.length === 0 ? null : field('span', undefined, `after ${child.dependsOn.join(', ')}`, 'faded'),
    child.reason === null ? null : field('span', undefined, child.reason, 'faded'),
  ].filter(Boolean))
}

function planBlock(plan) {
  const criteria = plan.criteria.map(criterion =>
    element('span', {
      'data-criterion': criterion.criterionId,
      'data-satisfied-by': criterion.satisfiedBy ?? '',
      text: `${criterion.criterionId}: ${criterion.satisfiedBy ?? 'unsatisfied'}`,
      style: 'margin-right:8px',
    }),
  )
  return element('div', { 'data-plan': plan.parentTaskId, 'data-complete': String(plan.complete), class: 'ruled' }, [
    element('div', { class: 'row' }, [
      field('span', undefined, plan.parentTaskId, 'id'),
      field('span', undefined, plan.complete ? 'complete' : 'in progress'),
    ]),
    element('div', {}, plan.children.map(childRow)),
    element('div', { class: 'faded' }, criteria),
  ])
}

/**
 * Draw one read.
 *
 * The whole page is redrawn rather than patched: it holds one read's worth of state, so a diff would be
 * a way for the drawn page and the read to disagree — the one thing this page is here to make visible.
 */
function render(state, reads) {
  const snapshot = state.snapshot
  const page = element('div', { 'data-panel': 'singularity-tasks', 'data-reads': String(reads), class: 'panel' }, [
    element('div', { class: 'row spread' }, [
      element('h1', { text: 'Singularity tasks' }),
      element('button', { type: 'button', 'data-refresh': '', text: state.reading ? 'Reading…' : 'Refresh', ...(state.reading ? { disabled: '' } : {}) }),
    ]),
    element('div', { class: 'faded' }, [
      field('span', undefined, 'control '),
      field('span', 'data-control', snapshot === undefined ? '—' : snapshot.controlId, 'id'),
      field('span', undefined, ' · cut '),
      field('span', 'data-cutoff', snapshot === undefined ? '—' : String(snapshot.cutoff), 'id'),
    ]),
  ])
  if (state.error !== undefined) page.append(field('div', 'data-error', state.error, 'row error'))
  if (snapshot === undefined) return page

  page.append(field('div', undefined, `Tasks (${snapshot.tasks.length})`, 'group'))
  page.append(
    snapshot.tasks.length === 0
      ? field('div', undefined, 'this control holds no tasks yet', 'faded')
      : element('div', {}, snapshot.tasks.map(taskRow)),
  )
  page.append(field('div', undefined, `Plans (${snapshot.plans.length})`, 'group'))
  page.append(
    snapshot.plans.length === 0
      ? field('div', undefined, 'this control holds no plans yet', 'faded')
      : element('div', {}, snapshot.plans.map(planBlock)),
  )
  return page
}

// One read on load, one on every click. `reads` counts landed reads so a reader can tell "the click
// finished" from "the click started" without racing the button's own disabled state.
let reads = 0
let reading = false
const controller = new AbortController()

/** Read once and draw the result. The last landed read always wins, in order. */
async function show() {
  reading = true
  draw()
  const state = await readCut(controller.signal).then(
    next => next,
    error => (error.name === 'AbortError' ? undefined : { error: String(error) }),
  )
  if (state === undefined) return
  reading = false
  reads += 1
  draw(state)
}

/** What the page currently holds: the last landed read. A read in flight leaves it alone. */
let current = {}

function draw(next) {
  if (next !== undefined) current = next
  const page = render({ ...current, reading }, reads)
  const refresh = page.querySelector('[data-refresh]')
  refresh?.addEventListener('click', () => void show())
  root.replaceChildren(page)
}

void show()

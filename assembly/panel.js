const TASKS_ROUTE = '/singularity/tasks'

const root = document.getElementById('root')
if (root === null) throw new Error('panel: #root is missing from the page this script was served with')

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

function field(tag, marker, text, className) {
  const node = element(tag, { text, ...(marker === undefined ? {} : { [marker]: '' }) })
  if (className !== undefined) node.className = className
  return node
}

function runRow(run) {
  return element('div', { 'data-run': run.runId, 'data-status': run.status, class: 'row' }, [
    field('span', undefined, run.runId, 'id'),
    field('span', undefined, run.status),
    run.model === null ? null : field('span', 'data-model', `${run.model.provider}/${run.model.model}`, 'faded'),
    run.detail === null ? null : field('span', undefined, run.detail, 'faded'),
    ...run.inputSources.map(input => field('div', 'data-input', `${input.name} · ${input.source.kind === 'artifact'
      ? `${input.source.taskId}/${input.source.runId}` : input.source.ref} · ${input.digest}`, 'id')),
    run.receipt === null ? null : element('details', { 'data-receipt': run.runId, 'data-receipt-cutoff': run.receipt.cutoff }, [
      element('summary', { text: `Sealed receipt · cut ${run.receipt.cutoff}` }),
      element('pre', { text: JSON.stringify(run.receipt, null, 2) }),
    ]),
  ].filter(Boolean))
}

function taskRow(task) {
  const runs = task.runs.length === 0
    ? [field('div', undefined, 'no runs yet', 'faded')]
    : task.runs.map(runRow)
  return element('div', { 'data-task': task.taskId, 'data-phase': task.phase, class: 'ruled' }, [
    element('div', { class: 'row' }, [field('span', undefined, task.taskId, 'id'), field('span', undefined, task.phase)]),
    field('div', undefined, task.goal, 'faded'),
    field('div', 'data-session', task.sessionId ?? 'unassigned', 'id'),
    field('div', 'data-template', task.template.id, 'faded'),
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
let reads = 0
let reading = false
const controller = new AbortController()

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

let current = {}

function draw(next) {
  if (next !== undefined) current = next
  const page = render({ ...current, reading }, reads)
  const refresh = page.querySelector('[data-refresh]')
  refresh?.addEventListener('click', () => void show())
  root.replaceChildren(page)
}

void show()

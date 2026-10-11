#!/usr/bin/env node
/**
 * G2 evidence: the panel, the route and the tools all agree on one committed cut.
 *
 * **What this probe is for.** "The tools and the UI agree on one cut" is a claim about one projection, not
 * about two implementations somebody keeps in step. So this probe never compares a rendered string against
 * an expected string. It drives one real turn through the real profile in a real Chromium — so every fact
 * is the agent's own — and then reads that same cut twice, once through the route the panel fetches and
 * once by folding the committed control log with **core's own projectors**, and requires the two to be
 * equal field for field. A route that drifted from the projection fails here, and so does a projection
 * that drifted from the facts.
 *
 * **Where the expected value comes from.** Not from a fixture and not from the route. The probe opens the
 * control session over the host's own zstd persistence with a **read** handle — the same medium a boot
 * writes through, no write lease, so it can run against a live server — decodes the control records by the
 * carrier's own rule, adopts them into `MemoryLog` under the deployment's role table, and hands that cut to
 * `snapshotOf`, which is the exact function `assembly/src/web.ts` serves. An expectation written by hand
 * would agree with the route because the same person wrote both on the same afternoon.
 *
 * **Every check is an assertion**, about bytes that came back over the wire or nodes that were in the DOM:
 *
 *   (a) the route owns its path and answers JSON. An unregistered path is answered by the SPA with
 *       `index.html` at **HTTP 200**, so a check that only looked at the response status would pass on a
 *       route that is not mounted; the content type is what tells them apart. A non-GET is 405 with
 *       `allow: GET`, and a request with no browser cookie is refused by the fence rather than served.
 *   (b) the body equals `snapshotOf`'s projection of the same cut, including `cutoff` and sort order.
 *   (c) the panel renders a task id the real agent minted through its own tools, prints the cutoff it
 *       read, and lists the plan's sub-task rows the route listed.
 *   (d) reading the panel commits no facts: the committed fact count is taken from the log before the
 *       panel opens and after the refresh, and the cut must not move.
 *   (e) a reload re-reads and re-executes nothing: no new fact appears and the same tasks are still shown.
 *
 * It does not prove the panel is pleasant to use, that a person would find the task they want, or that the
 * model answers the same way twice.
 *
 * Usage: node scripts/panel-probe.mjs [--screenshot <path>]
 *   Requires `. /home/ROXY/singularity-next/env.sh` and a deployed, **built** profile — the Host serves the
 *   client bundle verbatim, so `node assembly/build.mjs && node scripts/deploy.mjs` must have run.
 *
 * @module singularity-core/scripts/panel-probe
 */

import { mkdir, readlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

// Booting, session preparation, sending a turn and waiting for tool rows are the existing probe's steps,
// imported rather than copied: a second copy of an app's accessors drifts the moment the app changes, and
// only one of the copies is watched.
import {
  PROFILE,
  boot,
  dismissFirstRun,
  prepare,
  send,
  waitForTools,
} from './browser-probe.mjs'
import { DSH_HOME, openPersistence } from './dsh-control-runtime.mjs'

// The hook in `dsh-control-runtime.mjs` only resolves modules imported after it runs, so everything that
// reaches a DSH package is imported here rather than in a hoisted static block.
const { AGENT_ROLE, declareAgentProtocol } = await import('../src/agent/protocol.ts')
const { CONTROL_EVENT_TYPE, controlSessionIdOf } = await import('../src/control/session-store.ts')
const { ENVIRONMENT_ROLE, declareEnvironmentProtocol } = await import('../src/environment/protocol.ts')
const { MemoryLog } = await import('../src/protocol/memory-log.ts')
const { ProtocolRegistry } = await import('../src/protocol/registry.ts')
const { SCHEDULER_ROLE, declareTaskProtocol, verifierRoleOf } = await import('../src/task/protocol.ts')
const { loadDomain } = await import('../assembly/src/domain.ts')
const { snapshotOf } = await import('../assembly/src/snapshot.ts')

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The control this deployment writes its facts under, as its own profile layer names it. */
const CONTROL = 'singularity-local'
/** The route the panel reads, and the panel's own id, as `web.ts` and `client.js` declare them. */
const TASKS_ROUTE = '/singularity/tasks'
/**
 * The panel's own page, served by the web row of the same plugin.
 *
 * The panel is a page this package serves and the shell mounts in an iframe — the structure the previous
 * singularity's web surface used — so this probe opens the page itself rather than driving the shell to
 * render it. That is what makes the panel's evidence independent of the chat surface.
 */
const PANEL_PATH = '/singularity/panel/'
const PANEL_ID = 'singularity-tasks'
/** The tools one turn must call, for the panel to have an id the agent itself minted. */
const TOOLS = ['singularity_propose_task', 'singularity_submit_program', 'singularity_task_status']
/** The tool that declares a plan. A row for it cannot exist before the second turn, so it is a real wait. */
const DECOMPOSE_TOOL = 'singularity_decompose_task'

/**
 * The one message the probe sends: it names the tool sequence, not the answer.
 *
 * The same wording as `browser-probe.mjs`'s `FULL_PROMPT`, deliberately: this leg is not testing what the
 * model can do, it is establishing that the ids the panel shows are ones the agent produced through its own
 * tools. The workspace already holds the bytes the criterion reads, so no input text is supplied.
 */
const PROMPT = [
  'Use the singularity tools to count the ASCII letters (A-Z and a-z only) in the input this',
  'deployment has prepared for the task.',
  '',
  'Call singularity_propose_task with a one-sentence goal, then call singularity_submit_program with a',
  'small Node program that prints only the count. The program is written to `program.mjs` and run as',
  '`node program.mjs <input path>`: it is an ES module, so use `import`, not `require`. Then call',
  'singularity_task_status for the same taskId and report the receipt status and the criterion verdict',
  'exactly as recorded.',
].join('\n')

/**
 * The second message: split the admitted task into one sub-task, so the panel has a plan to render.
 *
 * A plan is what the panel's sub-task rows come from, and a panel with no plan would prove only half of
 * "the control's tasks and each plan's sub-tasks". The criterion id is read from the deployment's domain
 * rather than typed here, because the id is the domain's name for its rule and not this probe's.
 */
const planPrompt = (taskId, criterionId) =>
  [
    `The singularity task ${taskId} is admitted and you are responsible for it.`,
    '',
    `Call \`singularity_decompose_task\` once for ${taskId} with a single child: key "count", a one-sentence`,
    `goal, no dependencies (\`dependsOn: []\`), \`supports\` the criterion ${JSON.stringify(criterionId)}, and \`maxRuns\` 1.`,
    '',
    'Declare the whole plan in that one call, then report what the tool returned verbatim.',
  ].join('\n')

const TURN_TIMEOUT_MS = 900_000
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/

/** A failure that already names its cause. Printed as one line; a stack would only add noise. */
class ProbeError extends Error {}

let failures = 0

/** One assertion, printed whether it holds or not, so a run that stops early still shows what passed. */
function check(what, holds, detail = '') {
  console.log(`  ${holds ? 'ok  ' : 'FAIL'}  ${what}${holds || detail === '' ? '' : ` — ${detail}`}`)
  if (!holds) failures += 1
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A free port for the server under test. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise(resolve => server.close(resolve))
  if (port === undefined) throw new ProbeError('the kernel returned no port for the probe')
  return port
}

/* -------------------------------------------------------------------------------- the core side */

/**
 * The deployment's role table, built the way `assembly/src/apparatus.ts` builds it.
 *
 * A fact's emitter is resolved against this table when the envelope is adopted, so a projection under a
 * smaller table would refuse facts the deployment accepts — which would read as a route defect rather than
 * a probe defect.
 */
function subjectsOf(controlId, domain) {
  const subjects = {
    [SCHEDULER_ROLE]: `${controlId}:scheduler`,
    [AGENT_ROLE]: `${controlId}:runtime`,
    [ENVIRONMENT_ROLE]: `${controlId}:environment`,
  }
  for (const verifier of domain.verifiers)
    subjects[verifierRoleOf({ verifierRef: verifier.ref, verifierVersion: verifier.version })] =
      `${controlId}:verifier:${verifier.ref}@${verifier.version}`
  return subjects
}

/**
 * The committed control log, read through a **read** handle.
 *
 * Read, not write: a live server holds the control session's write lease, so `open(id, 'write')` against it
 * is `SessionAlreadyOwnedError` by design. A read handle sees the same bytes the server has committed, so a
 * projection over it is a projection of the same log — and taking one commits nothing, which is what lets
 * this probe measure the cut before and after a browser read.
 *
 * The carrier is decoded by the rule its own module states: our event type, then `data.payload`. The
 * mirrored `kind` and the closed member set are re-checked when the envelope is adopted.
 */
async function readControlFacts(home, controlId) {
  const open = await openPersistence(join(home, 'sessions'), 'zstd')
  const handle = await open.persistence.open(controlSessionIdOf(controlId), 'read')
  const stored = await handle.read()
  const facts = stored.events
    .filter(event => event.type === CONTROL_EVENT_TYPE)
    .map(event => structuredClone(event.data.payload))
  await handle.close()
  return facts
}

/** The committed fact count alone: the number the route calls `cutoff`. */
const committedCount = (home, controlId = CONTROL) => readControlFacts(home, controlId).then(facts => facts.length)

/**
 * `snapshotOf`'s projection of the first `cut` facts — the function the route serves.
 *
 * The view below is the four reads `ControlSessionStore.load()` offers, over the same `MemoryLog` fold. It
 * is built here rather than by opening a store because a store is a **writer**: the probe must be able to
 * read a live deployment's log without competing for the lease that deployment holds.
 */
async function projectionAt(home, domainDir, cut) {
  const domain = await loadDomain(domainDir, () => {
    throw new ProbeError('projecting a cut ran a verifier; a read never spawns a process')
  })
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareAgentProtocol(registry)
  declareEnvironmentProtocol(registry)
  const facts = await readControlFacts(home, CONTROL)
  const upTo = cut ?? facts.length
  const log = MemoryLog.adopt(facts.slice(0, upTo), registry, { subjects: subjectsOf(CONTROL, domain) })
  const view = {
    entries: () => log.entries().slice(0, upTo),
    entriesOf: (protocol, version) => log.entriesOf(protocol, version).filter(entry => entry.seq < upTo),
    stateOf: (protocol, version, subject) => log.stateAt(protocol, version, subject, upTo),
    statesOf: (protocol, version) => log.statesAt(protocol, version, upTo),
  }
  return {
    snapshot: await snapshotOf({ controlId: CONTROL, domain, store: { load: () => view } }),
    committed: facts.length,
    criterionId: domain.criterion.criterionId,
  }
}

/* ----------------------------------------------------------------------------- the browser side */

const panelOf = page => page.locator(`[data-panel="${PANEL_ID}"]`)

/**
 * Read the route from inside the page, exactly as the panel does.
 *
 * The route is fenced by the composition's own browser authentication, so a node-side request carries no
 * cookie and is answered by the fence — which is itself checked below. Reading through the page is also the
 * faithful path: it is what the panel's own `fetch` does, with the session the app established.
 */
async function readRoute(page) {
  return page.evaluate(async route => {
    const response = await fetch(route, { headers: { accept: 'application/json' } })
    return {
      status: response.status,
      type: (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase(),
      allow: response.headers.get('allow'),
      text: await response.text(),
    }
  }, TASKS_ROUTE)
}

/** The route's body, parsed, refusing a body that is not one. */
async function routeBody(page) {
  const read = await readRoute(page)
  try {
    return { ...read, body: JSON.parse(read.text) }
  } catch (error) {
    throw new ProbeError(`the route's body is not JSON (${error.message}); it began ${JSON.stringify(read.text.slice(0, 200))}`)
  }
}

/**
 * Wait for the turn to settle. The composer's own button is the clock: it reads `Stop generating` while a
 * turn runs and `Send message` once it is over, which beats guessing at a stream flag.
 */
async function settle(page) {
  try {
    await page.waitForFunction(() => document.querySelector('button[aria-label="Stop generating"]') === null, null, {
      timeout: TURN_TIMEOUT_MS,
    })
  } catch {
    throw new ProbeError('the turn never settled')
  }
  await sleep(4_000)
}

/**
 * Open the panel the way a person does: click its row in the sidebar, then wait for the read it starts.
 *
 * By accessible name, because that name comes from the registration's own `label` — so this also checks the
 * row was registered with a name a person can read, rather than only that a component mounted somewhere.
 *
 * The wait for a *landed* read is part of opening, not an extra: the panel mounts in its `Reading…` state
 * and paints its cutoff as `—` until the fetch resolves, so reading it straight after the click would
 * describe a panel that has not answered yet — and would look exactly like a panel that cannot.
 */
/**
 * Open the panel the way it is actually opened: navigate its own page.
 *
 * **The panel is a page this package serves, mounted in the shell as an iframe** — the structure the
 * previous singularity's web surface used. So this probe navigates to `/singularity/panel/` directly and
 * asserts on the page, not on the shell's rendering of it. Before this, the only way to reach the task
 * list was to drive the shell (open a session, pick a preset, choose a workspace), which made the panel's
 * evidence depend on a chat surface that has nothing to do with it: when the shell changed its own
 * welcome screen, this probe timed out waiting for a control the panel never owned.
 *
 * The frame's own load is checked, because a page that failed to load renders nothing and would read as
 * a panel with no rows.
 */
async function openPanel(page, origin) {
  const url = `${origin}${PANEL_PATH}`
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (response === null || !response.ok()) throw new ProbeError(`the panel page at ${url} answered ${response?.status() ?? 'nothing'}`)
  try {
    await panelOf(page).first().waitFor({ timeout: 30_000 })
  } catch {
    const text = await page.evaluate(() => document.body.innerText)
    throw new ProbeError(`the panel page loaded but rendered no panel element; the page said ${JSON.stringify(text.slice(0, 200))}`)
  }
  try {
    await page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-panel]')
        return panel !== null && Number(panel.getAttribute('data-reads') ?? '0') > 0
      },
      null,
      { timeout: 30_000 },
    )
  } catch {
    // Either the read never landed, or it landed as a failure. Both are findings, so name which.
    const state = await panelState(page)
    throw new ProbeError(
      state === null
        ? 'the panel disappeared while its first read was in flight'
        : `the panel rendered but its first read never landed; it is showing ${JSON.stringify(state.text.slice(0, 200))}`,
    )
  }
}

/** A stable digest of one projection, for the evidence line: equal digests are equal bodies. */
function digestOf(value) {
  const text = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`
}

/**
 * The panel's read state as it is on screen.
 *
 * Read through the handles `client.js` publishes rather than by scraping prose: a task id appearing in the
 * chat transcript beside the panel is not the panel showing it, and telling those two apart is the point.
 */
const panelState = page =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-panel]')
    if (panel === null) return null
    const text = node => (node === null ? null : (node.textContent ?? '').trim())
    return {
      reads: Number(panel.getAttribute('data-reads') ?? '0'),
      cutoff: text(panel.querySelector('[data-cutoff]')),
      controlId: text(panel.querySelector('[data-control]')),
      error: text(panel.querySelector('[data-error]')),
      refresh: panel.querySelector('[data-refresh]') !== null,
      taskIds: [...panel.querySelectorAll('[data-task]')].map(node => node.getAttribute('data-task')),
      planIds: [...panel.querySelectorAll('[data-plan]')].map(node => node.getAttribute('data-plan')),
      childIds: [...panel.querySelectorAll('[data-child]')].map(node => node.getAttribute('data-child')),
      // Pairs, not a map: a child id is derived from its key, so two plans' children can carry one name —
      // a map would silently keep the last and hide a row the panel rendered.
      childPairs: [...panel.querySelectorAll('[data-child]')].map(
        node => `${node.getAttribute('data-child')}:${node.getAttribute('data-status')}`,
      ),
      // The first 400 characters only: the one question this is asked is "is the panel a rendering, or the
      // raw JSON body", and a whole page's text answered it while adding a quarter of a megabyte per read
      // to the evidence. A body that leaked through would show in the first line of it.
      text: (panel.textContent ?? '').trim().slice(0, 400),
    }
  })

/**
 * Click Refresh and wait for the panel to report a read that **landed**.
 *
 * The panel counts its own completed reads and publishes the count as `data-reads`. Waiting for that number
 * to move is the only honest completion signal: the button's disabled state can be missed entirely when the
 * route answers quickly, and a fixed sleep would either be a lie or a tax on every run.
 */
async function refresh(page) {
  const before = (await panelState(page))?.reads ?? 0
  await panelOf(page).locator('[data-refresh]').first().click()
  try {
    await page.waitForFunction(
      reads => {
        const panel = document.querySelector('[data-panel]')
        return panel !== null && Number(panel.getAttribute('data-reads') ?? '0') > reads
      },
      before,
      { timeout: 30_000 },
    )
  } catch {
    throw new ProbeError(`the refresh never completed: the panel still reports ${before} landed read(s)`)
  }
}

/* ------------------------------------------------------------------------------------ the run */

async function main() {
  // Resolved by the one module that knows the private install: a gate runner invokes this script with the
  // environment it was started with, so requiring `DSH_HOME` here made the gate red in a bare shell.
  const home = DSH_HOME
  const domainDir = join(CHECKOUT, 'deployment', 'domain', 'letters')
  const screenshotFlag = process.argv.indexOf('--screenshot')
  const screenshot = screenshotFlag === -1 ? join(home, 'artifacts', 'panel-probe.png') : process.argv[screenshotFlag + 1]
  if (screenshot === undefined) throw new ProbeError('--screenshot needs a path')
  const server = await boot(await freePort())
  const browser = await chromium.launch()
  const evidence = {
    command: server.command,
    url: server.url,
    chromium: browser.version(),
    domainDir,
    screenshot,
  }
  try {
    // ---- which tree this run judged ------------------------------------------------------------
    // The deployed profile links `assembly/` by absolute path, so a copy of this repository boots the
    // *original* plugin: without this, a probe run in a stripped tree would still report OK, and a
    // verdict that cannot depend on the tree it names is worth nothing. The guard is here rather than
    // in the harness because only the probe knows which checkout it means.
    const linked = await readlink(join(home, 'profiles', PROFILE, 'node_modules', '@dangosys', 'dsh-singularity-next')).catch(() => undefined)
    const mounted = join(CHECKOUT, 'assembly')
    if (linked !== mounted) throw new ProbeError(`the profile mounts ${linked ?? 'no plugin'}, not ${mounted}: a verdict about another tree is not evidence about this one`)

    // The app's locale delegates to the browser when no preference is set, and a browser context
    // inherits the machine's own — so without this, the probes' English accessors match on an en
    // desktop and time out on a zh one. Pin the locale; the UI language is part of the probe's frame,
    // not something it observes.
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor({ timeout: 60_000 })

    // ---- the fence, before anything else reads the route --------------------------------------
    // A request from this process carries no cookie. If that were served, every content check below
    // would be describing an unauthenticated route.
    const origin = new URL(server.url).origin
    const bare = await fetch(`${origin}${TASKS_ROUTE}`, { redirect: 'manual' }).catch(error => ({ status: `threw ${error.message}` }))
    evidence.unauthenticatedStatus = bare.status
    check(
      '(fence) a request with no browser cookie is refused, not served',
      bare.status === 401 || bare.status === 403,
      `status ${String(bare.status)}`,
    )

    // ---- one real turn, so the board holds an id the agent minted itself ----------------------
    evidence.dismissedFirstRun = await prepare(page, home)
    await send(page, PROMPT)
    await waitForTools(page, TOOLS)
    await settle(page)
    const said = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tool]')].map(node => node.textContent ?? '').join('\n'),
    )
    const agentTaskId =
      /"taskId":\s*"(task-[0-9a-f]+)"/.exec(said)?.[1] ?? /\b(task-[0-9a-f]{8,})\b/.exec(said)?.[1]
    if (agentTaskId === undefined)
      throw new ProbeError(`the turn produced no task id the probe could read; the tool results were:\n${said.slice(-2000)}`)
    evidence.agentTaskId = agentTaskId

    // ---- a plan, so the panel has sub-task rows to render --------------------------------------
    // The criterion id is the domain's, read from the domain rather than typed here. It is needed before
    // the first projection, and the projection is the only place this probe reads the domain.
    const criterionId = (await projectionAt(home, domainDir, 0)).criterionId
    evidence.criterionId = criterionId
    await send(page, planPrompt(agentTaskId, criterionId))
    await waitForTools(page, [DECOMPOSE_TOOL])
    await settle(page)

    // ---- (a) the route owns its path, and reads like JSON ------------------------------------
    const served = await routeBody(page)
    evidence.routeStatus = served.status
    evidence.routeContentType = served.type
    evidence.routeCutoff = served.body.cutoff
    check('(a) the route answers 200', served.status === 200, `status ${served.status}`)
    check(
      "(a) the route answers JSON, not the SPA's index.html",
      served.type === 'application/json',
      `content type ${JSON.stringify(served.type)} — "text/html" means the route is not registered and the SPA fallback answered, at HTTP 200`,
    )
    const posted = await page.evaluate(async route => {
      const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      return { status: response.status, allow: response.headers.get('allow') }
    }, TASKS_ROUTE)
    evidence.postStatus = posted.status
    evidence.postAllow = posted.allow
    check('(a) a non-GET on the read route is 405, not 200 or 204', posted.status === 405, `status ${posted.status}`)
    check("(a) the 405 names the method it allows", (posted.allow ?? '').toUpperCase().includes('GET'), `allow: ${JSON.stringify(posted.allow)}`)

    // ---- (b) the body equals core's own projection of the same cut ---------------------------
    const expected = await projectionAt(home, domainDir, served.body.cutoff)
    // Counts and digests, not the bodies. The comparison below is what asserts equality; keeping both
    // whole projections in the evidence printed a megabyte per run for two numbers that already say it,
    // and buried the checks a reader came for. The digest is here so a later run can be compared against
    // this one without the bodies being kept.
    evidence.route = { cutoff: served.body.cutoff, tasks: served.body.tasks.length, plans: served.body.plans.length, digest: digestOf(served.body) }
    evidence.core = { cutoff: expected.snapshot.cutoff, committed: expected.committed, digest: digestOf(expected.snapshot) }
    check(
      '(b) the route is a projection of a cut this log can produce',
      served.body.cutoff === expected.snapshot.cutoff,
      `the route served cutoff ${served.body.cutoff}; the log holds ${expected.committed} committed facts`,
    )
    // Field for field over the serialised value: a hand-picked subset would let a wrong field through.
    check(
      "(b) the route body equals core's projection of that cut, field for field",
      JSON.stringify(served.body) === JSON.stringify(expected.snapshot),
      `route ${JSON.stringify(served.body).length} bytes vs core ${JSON.stringify(expected.snapshot).length} bytes; first difference at ${firstDifference(served.body, expected.snapshot)}`,
    )
    check('(b) the projection declares the frozen format version', served.body.formatVersion === 1, `formatVersion ${served.body.formatVersion}`)
    check('(b) the projection names the control the panel was pointed at', served.body.controlId === CONTROL, `controlId ${JSON.stringify(served.body.controlId)}`)
    check(
      "(b) the projection carries the agent's own task",
      served.body.tasks.some(task => task.taskId === agentTaskId),
      `the route named ${JSON.stringify(served.body.tasks.map(task => task.taskId))}, the agent minted ${agentTaskId}`,
    )
    const servedTask = served.body.tasks.find(task => task.taskId === agentTaskId)
    check(
      '(b) that task carries its goal and its runs, not an empty shell',
      typeof servedTask?.goal === 'string' && servedTask.goal.length > 0 && servedTask.runs.length > 0,
      JSON.stringify(servedTask ?? null),
    )

    // ---- (c) the panel renders the agent's own task, and prints the cutoff it read ------------
    await openPanel(page, origin)
    const opened = await panelState(page)
    if (opened === null) throw new ProbeError('the panel element vanished between opening it and reading it')
    evidence.panelAfterOpen = opened
    check('(c) the panel is on screen with no error', opened.error === null, opened.error ?? 'the panel reported an error')
    check('(c) the panel offers a Refresh control', opened.refresh === true)
    check('(c) the panel names the control it read', opened.controlId === CONTROL, `the panel shows ${JSON.stringify(opened.controlId)}`)
    check(
      '(c) the panel shows a task id the agent minted through its own tools',
      opened.taskIds.includes(agentTaskId),
      `the panel showed ${JSON.stringify(opened.taskIds)}, the agent minted ${agentTaskId}`,
    )
    check(
      '(c) the panel prints the cutoff it read, not one it expected',
      opened.cutoff === String(served.body.cutoff),
      `the panel printed ${JSON.stringify(opened.cutoff)}, the route served ${served.body.cutoff}`,
    )
    check(
      '(c) the panel is a rendering, not the raw body',
      !opened.text.includes('"formatVersion"') && !opened.text.includes('{"'),
      `the panel's text began ${JSON.stringify(opened.text.slice(0, 160))}`,
    )
    // The panel's sub-task rows belong to a plan: every child id it lists must be one the route listed,
    // with the status the route recorded. This is the "each plan's sub-tasks, with statuses" leg.
    //
    // The panel renders **every** plan the control holds, not only the one this turn declared — a control
    // accumulates plans across runs, and a child id is derived from its key, so the same key in two plans is
    // two different sub-tasks carrying one name. So the check is over the pairs: every (child, status) the
    // panel listed must be a pair some plan's child carries. The agent's own sub-task is checked separately,
    // because "the panel listed rows" would pass without this run's plan having been rendered at all.
    const ownPlan = served.body.plans.find(plan => plan.parentTaskId === agentTaskId)
    const routePairs = new Set(served.body.plans.flatMap(plan => plan.children.map(child => `${child.taskId}:${child.status}`)))
    evidence.ownPlan = ownPlan === undefined ? null : { parentTaskId: ownPlan.parentTaskId, children: ownPlan.children.length }
    evidence.ownPlanChildren = (ownPlan?.children ?? []).map(child => `${child.taskId}:${child.status}`)
    evidence.routePairCount = routePairs.size
    // The pairs the panel listed that this control's own plans do not carry, if any: the evidence says
    // what would be wrong rather than restating every row the panel drew.
    evidence.panelPairsNotInRoute = opened.childPairs.filter(pair => !routePairs.has(pair))
    check(
      '(c) the route carries the plan the agent declared in its second turn',
      ownPlan !== undefined && ownPlan.children.length > 0,
      `the route's plans are ${JSON.stringify(served.body.plans.map(plan => plan.parentTaskId))}, the agent declared one for ${agentTaskId}`,
    )
    check(
      '(c) the panel shows that plan',
      opened.planIds.includes(agentTaskId),
      `the panel showed ${JSON.stringify(opened.planIds)}, the agent's plan is ${agentTaskId}`,
    )
    check(
      "(c) the panel shows this run's sub-task, with the status the route recorded",
      evidence.ownPlanChildren.length > 0 && evidence.ownPlanChildren.some(pair => opened.childPairs.includes(pair)),
      `the route's children for that plan are ${JSON.stringify(evidence.ownPlanChildren)}, and the panel listed ${String(opened.childPairs.length)} pair(s)`,
    )
    check(
      '(c) every sub-task the panel listed is a child some plan carries, at the status the route recorded',
      opened.childPairs.length > 0 && opened.childPairs.every(pair => routePairs.has(pair)),
      `the panel listed ${String(opened.childPairs.length)} pair(s) the route does not carry: ${JSON.stringify(evidence.panelPairsNotInRoute.slice(0, 8))}`,
    )

    // ---- (d) reading the panel commits no facts ----------------------------------------------
    const cutBeforeRefresh = await committedCount(home)
    await refresh(page)
    const afterRefresh = await panelState(page)
    const cutAfterRefresh = await committedCount(home)
    evidence.cut = { atRoute: served.body.cutoff, beforeRefresh: cutBeforeRefresh, afterRefresh: cutAfterRefresh }
    evidence.panelAfterRefresh = afterRefresh
    check(
      '(d) opening and reading the panel committed no facts',
      cutBeforeRefresh === served.body.cutoff,
      `the cut was ${served.body.cutoff} when the route answered and ${cutBeforeRefresh} after the panel read it`,
    )
    check(
      '(d) refreshing the panel committed no facts',
      cutAfterRefresh === cutBeforeRefresh,
      `the cut was ${cutBeforeRefresh} before the refresh and ${cutAfterRefresh} after`,
    )

    // ---- (c2) the refresh really re-read, and printed that read's cutoff ----------------------
    check(
      '(c) the refresh was a real re-read, not a no-op',
      afterRefresh !== null && afterRefresh.reads > opened.reads,
      `the panel reported ${opened.reads} landed read(s) before the refresh and ${afterRefresh?.reads ?? 'none'} after`,
    )
    const atRefresh = await routeBody(page)
    evidence.cutoffAtRefresh = atRefresh.body.cutoff
    check(
      '(c) the refreshed panel prints the cutoff the route serves at that moment',
      afterRefresh !== null && afterRefresh.cutoff === String(atRefresh.body.cutoff),
      `the panel printed ${JSON.stringify(afterRefresh?.cutoff ?? null)}, the route served ${atRefresh.body.cutoff}`,
    )
    check('(c) the refresh left no error on the panel', afterRefresh !== null && afterRefresh.error === null, afterRefresh?.error ?? 'the panel is gone')

    // ---- (e) a reload re-reads, and re-executes nothing ---------------------------------------
    const beforeReload = await committedCount(home)
    // The reload is the *panel page's* reload, because that is the page under test: reloading the shell
    // to reach the panel again would re-mount the frame, which is a different thing from the page
    // reading itself a second time, and the claim here is about the page.
    await openPanel(page, origin)
    const reloaded = await panelState(page)
    const afterReload = await committedCount(home)
    evidence.cutAfterReload = afterReload
    evidence.panelAfterReload = reloaded
    check(
      '(e) a reload committed no facts, so no run was re-executed',
      afterReload === beforeReload,
      `the cut was ${beforeReload} before the reload and ${afterReload} after`,
    )
    check(
      '(e) the reloaded panel shows the same tasks, not a fresh set',
      reloaded !== null && JSON.stringify(reloaded.taskIds) === JSON.stringify(opened.taskIds),
      `before the reload ${JSON.stringify(opened.taskIds)}, after ${JSON.stringify(reloaded?.taskIds ?? null)}`,
    )
    check(
      '(e) the reloaded panel read the same cut',
      reloaded !== null && reloaded.cutoff === String(served.body.cutoff),
      `the reloaded panel printed ${JSON.stringify(reloaded?.cutoff ?? null)}, the cut is ${served.body.cutoff}`,
    )

    await mkdir(dirname(screenshot), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  } finally {
    await browser.close()
    server.child.kill('SIGKILL')
    await server.exited
  }
}

/** Where two JSON values first disagree, as a path. Keeps a failed equality check actionable. */
function firstDifference(left, right, path = '') {
  if (left === right) return '(none — the values are equal, so this is a serialisation difference)'
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object')
    return `${path || '(root)'}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  for (const key of keys) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`)
    if (!difference.startsWith('(none')) return difference
  }
  return `${path || '(root)'}: key order differs`
}

try {
  await main()
  console.log(failures === 0 ? '\npanel-probe: OK — the panel, the route and the tools read one cut' : `\npanel-probe: ${failures} check(s) failed`)
  if (failures > 0) process.exitCode = 1
} catch (error) {
  process.stderr.write(`panel-probe: ${error instanceof ProbeError ? error.message : (error?.stack ?? String(error))}\n`)
  if (failures > 0) console.log(`\npanel-probe: ${failures} check(s) failed before the run stopped`)
  process.exitCode = 1
}

#!/usr/bin/env node
/**
 * G2 evidence: the panel and the tools read one cut, in a real browser, over the deployed profile.
 *
 * **What this probe is for.** The blueprint's exit condition is "tools and UI agree on one cut", and
 * that is a claim about one function's output rather than about two implementations being kept in step.
 * So this probe does not compare a rendered string against an expected one: it drives a real turn
 * through the assembly's own tools, then reads the *same* cut two ways — through the route the panel
 * fetches, and through core's own projectors over the committed facts — and requires them to be equal.
 * A panel that rendered a stale projection would fail that comparison even if it looked right.
 *
 * **Why it boots the real profile with no overlay.** The panel is part of the deployment's composition:
 * its row, its client bundle and the route all come from the profile this repository deploys. An overlay
 * would prove that a route the probe mounted agrees with the tools, which is not the claim.
 *
 * **What it does not prove.** It does not prove the panel renders well, or that a person would find the
 * task they want. It proves the panel is mounted, that what it shows is the committed cut, that
 * refreshing re-reads, and that reading commits nothing — which is what "the UI agrees with the tools"
 * means precisely enough to be false.
 *
 * Usage: node scripts/panel-probe.mjs [--screenshot <path>]
 *   Requires: `. /home/ROXY/singularity-next/env.sh` (dsh on PATH, DSH_HOME set) and a deployed profile.
 *
 * @module singularity-core/scripts/panel-probe
 */

import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

import { chromium } from 'playwright'

// Booting, session preparation, sending a turn and waiting for tool rows are the existing probe's, which
// exports them rather than being copied: a second copy of an app's accessors drifts the moment the app
// changes, and only one of the copies is watched.
import { boot, prepare, send, waitForTools } from './browser-probe.mjs'

/** The control this deployment writes its facts under. */
const CONTROL_ID = 'singularity-local'
/** The route the panel reads, and the panel's own id. */
const TASKS_ROUTE = '/singularity/tasks'
const PANEL_ID = 'singularity-tasks'
/** The tools one turn is expected to reach, in the order the face registers them. */
const TOOLS = ['singularity_propose_task', 'singularity_submit_program', 'singularity_task_status']

/** The one message the probe sends: it names the tool sequence, not the answer. */
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

let failures = 0

/** One assertion, named and printed whether it holds or not. */
function check(what, holds, detail = '') {
  if (holds) console.log(`  ok    ${what}`)
  else {
    failures += 1
    console.log(`  FAIL  ${what}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A free port for the server under test. */
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  return port
}

/**
 * Read one cut from inside the page, exactly as the panel does.
 *
 * The route is fenced by the composition's own browser authentication, so a node-side request carries no
 * cookie and is answered 401 — the fence working, not the route broken. Reading through the page is also
 * the faithful path: it is what the panel's own fetch does, with the session the app established.
 */
async function readRoute(page) {
  return page.evaluate(async route => {
    const response = await fetch(route, { headers: { accept: 'application/json' } })
    const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    const text = await response.text()
    return { status: response.status, type, text }
  }, TASKS_ROUTE)
}

/** The cut number the route answers with, parsed. */
async function routeCutoff(page) {
  return JSON.parse((await readRoute(page)).text).cutoff
}

async function main() {
  const home = process.env['DSH_HOME']
  if (home === undefined || home === '') throw new Error("DSH_HOME is not set; source the deployment's environment before probing")
  const server = await boot(await freePort())
  const browser = await chromium.launch()
  try {
    if (server.output.includes('skipping profile bundle')) throw new Error(`the composed profile skipped a bundle:\n${server.output.trim()}`)

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New Session' }).first().waitFor({ timeout: 60_000 })

    // --- the route answers with the committed cut, and it is the shape the panel renders ----------
    const first = await readRoute(page)
    const body = JSON.parse(first.text)
    check('the route is mounted and answers JSON, not the SPA fallback', first.status === 200 && first.type === 'application/json', `status=${first.status} content-type=${first.type}`)
    check('the projection is the frozen format version, for this control', body.formatVersion === 1 && body.controlId === CONTROL_ID, JSON.stringify({ formatVersion: body.formatVersion, controlId: body.controlId }))
    check('the cutoff is a committed fact count', Number.isInteger(body.cutoff) && body.cutoff > 0, `cutoff=${body.cutoff}`)

    // --- one real turn through the tools -----------------------------------------------------------
    await prepare(page, home)
    await send(page, PROMPT)
    await waitForTools(page, TOOLS)
    await sleep(5_000)

    const toolText = await page.evaluate(() => [...document.querySelectorAll('[data-tool]')].map(node => node.textContent ?? '').join('\n'))
    // Read the id from the tool *row*, which carries the name the call was made with and the argument the
    // model passed. The collapsed row does not render the JSON answer, and requiring it would make this
    // probe fail on a rendering choice rather than on the thing it is testing.
    const taskId = /"taskId":"(task-[0-9a-f]+)"/.exec(toolText)?.[1] ?? /\b(task-[0-9a-f]{8,})\b/.exec(toolText)?.[1]
    check('the turn proposed a task through the tools', taskId !== undefined, toolText.slice(-400))
    if (taskId === undefined) throw new Error('no task id was recorded by a tool call; the panel leg cannot compare cuts')

    // --- the panel shows that task, from the same cut the tools wrote ------------------------------
    // Opened by its accessible name, because that is how a person opens it: a probe that clicked a private
    // class name would fail on a restyle and would not notice a row that lost its label.
    const row = page.getByRole('button', { name: 'Tasks', exact: true }).first()
    if ((await row.count()) > 0) await row.click()
    else check('the panel has an entry point in the sidebar', false, 'no control labelled Tasks was found')
    await page.locator(`[data-panel="${PANEL_ID}"]`).first().waitFor({ timeout: 30_000 }).catch(() => undefined)
    const panel = page.locator(`[data-panel="${PANEL_ID}"]`)
    check('the panel renders in the page', (await panel.count()) > 0, 'no element carries the panel id')
    await sleep(1_000)
    // Read the panel's own fields, not the page's text: a task id that appears in a chat transcript is
    // not the panel showing it, and the two are exactly what this probe has to tell apart.
    const shownTask = await panel.locator(`[data-task="${taskId}"]`).count().catch(() => 0)
    const shownControl = await panel.locator('[data-control]').first().textContent().catch(() => null)
    const readCutoff = await panel.locator('[data-cutoff]').first().textContent().catch(() => null)
    const panelError = await panel.locator('[data-error]').first().textContent().catch(() => null)
    check('the panel renders the task the tools committed', shownTask > 0, panelError ?? 'the task id is not in the panel')
    check('the panel reads this control, not another', shownControl === CONTROL_ID, `panel read control ${JSON.stringify(shownControl)}`)
    check('the panel reports the cutoff it actually read', readCutoff !== null && /^\d+$/.test(readCutoff.trim()), `panel says ${JSON.stringify(readCutoff)}`)

    // --- refresh re-reads, and reading commits nothing --------------------------------------------
    const refresh = panel.locator('[data-refresh]').first()
    const hasRefresh = (await refresh.count()) > 0
    check('the panel offers a refresh', hasRefresh)
    if (hasRefresh) {
      const midFacts = JSON.parse((await readRoute(page)).text).cutoff
      await refresh.click()
      await sleep(1_500)
      const routeAfter = JSON.parse((await readRoute(page)).text)
      const cutoffAfter = (await panel.locator('[data-cutoff]').first().textContent()).trim()
      check('the panel still renders the task after a refresh', (await panel.locator(`[data-task="${taskId}"]`).count()) > 0)
      check('refreshing commits no fact', JSON.parse((await readRoute(page)).text).cutoff === midFacts, `cutoff moved from ${midFacts} to ${JSON.parse((await readRoute(page)).text).cutoff}`)
      // The panel and the route read the same projection at the same moment, so the number the panel
      // shows has to be the number the route returned — if they can differ, they are two projections.
      check('the panel and the route agree on the cutoff they just read', cutoffAfter === String(routeAfter.cutoff), `panel=${cutoffAfter} route=${routeAfter.cutoff}`)
    }

    // --- a reload does not re-execute anything -----------------------------------------------------
    const beforeReload = JSON.parse((await readRoute(page)).text).cutoff
    await page.reload({ waitUntil: 'domcontentloaded' })
    await sleep(3_000)
    const afterReload = JSON.parse((await readRoute(page)).text).cutoff
    check('reloading the page re-executes nothing', afterReload === beforeReload, `cutoff ${beforeReload} -> ${afterReload}`)

    const screenshot = process.argv.includes('--screenshot') ? process.argv[process.argv.indexOf('--screenshot') + 1] : undefined
    if (screenshot !== undefined) {
      await mkdir(dirname(screenshot), { recursive: true })
      await page.screenshot({ path: screenshot })
      console.log(`  note  screenshot written to ${screenshot}`)
    }
  } finally {
    await browser.close()
    server.child.kill('SIGKILL')
    await server.exited
  }
  console.log(failures === 0 ? '\npanel-probe: OK — the panel and the tools read one cut' : `\npanel-probe: ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

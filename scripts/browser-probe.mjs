#!/usr/bin/env node
/**
 * G1 evidence: real Web sessions, in Chromium, driving the assembly through its own tools.
 *
 * The probe boots the deployment's profile as a child process — the same command a person would run —
 * and owns that process: it is killed on every exit path, so the probe never leaves a server behind and
 * never measures a long-lived development server.
 *
 * Two legs, one harness:
 *
 *  - the default leg proves the assembly works at all: the composed profile loads with no skipped
 *    bundle and no inactive row, the `singularity-next` preset can be selected in the browser, one
 *    turn calls all three tools, and the receipt the turn reads says `verified`;
 *  - `--recovery` proves the committed facts survive a crash: one turn admits a task, the server is
 *    **SIGKILL**ed, the same profile restarts on the same port, the browser reloads and resumes the
 *    *same* session, and the second turn submits against the task id captured before the kill. The
 *    receipt it reads must name that same task. If the app cannot resume the session, the leg fails:
 *    a fresh session would prove nothing.
 *
 * Both legs are assertions, not observations: a missing preset, a turn with no tool call, a changed
 * session or task id, or a non-passing verdict ends the probe non-zero and names what it saw. What the
 * probe does not do is decide correctness: the domain's verifier decides, and the receipt carries its
 * word.
 *
 * The UI is driven through the app's own accessible surface: the preset seat's title, the composer's
 * `role=textbox`, the send button's label, and the tool rows' `data-tool`. Nothing here reads a
 * private React class name, so a restyle does not turn into a false failure.
 *
 * Usage: node scripts/browser-probe.mjs [--recovery] [--screenshot <path>]
 *   Requires: `. /home/ROXY/singularity-next/env.sh` (dsh on PATH, DSH_HOME set) and a deployed profile.
 *
 * @module singularity-core/scripts/browser-probe
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

import { chromium } from 'playwright'

/** The profile both legs boot. Deployed by `scripts/deploy.mjs`. */
const PROFILE = 'singularity-next-web'
/** The preset the assembly's preset row declares. */
const PRESET_NAME = 'Singularity Next'
/** The three tools the agent face registers. */
const TOOLS = ['singularity_propose_task', 'singularity_submit_program', 'singularity_task_status']
/** The text the agent counts letters in. Digits and punctuation make the criterion non-trivial. */
const INPUT_TEXT = 'The quick brown fox jumps over 13 lazy dogs! 42'

/** The default leg's one user message. It names the tool sequence, not the answer. */
const FULL_PROMPT = [
  'Use the singularity tools to count the ASCII letters (A-Z and a-z only) in the text below.',
  '',
  `TEXT: ${INPUT_TEXT}`,
  '',
  'Call singularity_propose_task with that exact text as `input`, then call singularity_submit_program',
  'with a small Node program that prints only the count. The program is written to `program.mjs` and run',
  'as `node program.mjs <input path>`: it is an ES module, so use `import`, not `require`. Then call',
  'singularity_task_status for the same taskId and report the receipt status and the criterion verdict',
  'exactly as recorded.',
].join('\n')

/** The recovery leg's first message: admit a task and stop. */
const PROPOSE_PROMPT = [
  'Call the singularity tool `singularity_propose_task` once to admit a task whose goal is to count',
  `the ASCII letters (A-Z and a-z only) in the text below, passing this exact text as \`input\`: ${INPUT_TEXT}`,
  '',
  'Do not submit a program in this turn. Report the `taskId` the tool returned verbatim.',
].join('\n')

/** The recovery leg's second message, sent after the kill into the same task. */
const submitPrompt = taskId =>
  [
    `The singularity task ${taskId} is already admitted and its input is in this session's workspace.`,
    `Call \`singularity_submit_program\` with that exact taskId and a small Node program that prints`,
    'only the ASCII letter count of the file handed to it as its first argument. The program is written',
    'to `program.mjs` and run as `node program.mjs <input path>`: it is an ES module, so use `import`,',
    'not `require`.',
    `Then call \`singularity_task_status\` for ${taskId} and report the receipt status and the criterion`,
    'verdict exactly as recorded.',
  ].join('\n')

const BOOT_TIMEOUT_MS = 120_000
const TURN_TIMEOUT_MS = 900_000
const SETTLE_MS = 5_000
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/

/** A failure that already names its cause. Printed as one line; the stack would only add noise. */
class ProbeError extends Error {}

/**
 * Boot one profile child and wait for the URL it prints.
 * @returns the child, its exit promise, and a reader for everything it has said so far.
 */
async function boot(port) {
  const command = `dsh --profile ${PROFILE} --host 127.0.0.1 --port ${port} --no-open`
  const child = spawn('dsh', ['--profile', PROFILE, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const server = { command, child, output: '' }
  child.stdout.on('data', chunk => (server.output += chunk))
  child.stderr.on('data', chunk => (server.output += chunk))
  child.once('error', error => (server.output += `\nspawn failed: ${error.message}`))
  server.exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  server.url = await waitForUrl(server)
  // A skipped bundle or an inactive row leaves the profile mounted but incomplete: the assembly's
  // service is absent, its preset drops out of the picker, and the legs would fail later with a worse
  // message than this one.
  if (server.output.includes('skipping profile bundle'))
    throw new ProbeError(`the composed profile skipped a bundle:\n${server.output.trim()}`)
  if (server.output.includes('did not activate'))
    throw new ProbeError(`the composed profile has a row that did not activate:\n${server.output.trim()}`)
  return server
}

/** Poll a child's combined output for the URL it prints when the server is listening. */
async function waitForUrl(server) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const found = URL_PATTERN.exec(server.output)
    if (found !== null) return found[0]
    const code = await Promise.race([server.exited, sleep(250).then(() => undefined)])
    if (code !== undefined)
      throw new ProbeError(`the profile exited with code ${code} before printing a URL:\n${server.output.trim()}`)
  }
  throw new ProbeError(`the profile printed no URL within ${BOOT_TIMEOUT_MS}ms:\n${server.output.trim()}`)
}

/** Open the app and wait until its session surface has painted. */
async function openApp(context, url) {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New Session' }).first().waitFor({ timeout: 60_000 })
  return page
}

/**
 * Dismiss the two first-run surfaces, when they are shown: the preview notice, and the credential
 * dialog that appears only while no provider is usable. The deployment's profile names a provider, so
 * the credential dialog is a symptom rather than a step — it is dismissed so the run reaches the model
 * call, and the evidence carries whether it appeared at all.
 *
 * Both surfaces mount after the shell paints, so this waits for the surface to stay quiet instead of
 * clicking once into a page that has not decided yet what to show.
 * @returns the labels it dismissed, in order.
 */
async function dismissFirstRun(page) {
  const dismissed = []
  let quiet = 0
  for (let attempt = 0; attempt < 60 && quiet < 3; attempt++) {
    let clicked = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true })
      if ((await button.count()) > 0 && (await button.first().isVisible())) {
        await button.first().click()
        dismissed.push(name)
        clicked = true
        quiet = 0
        await page.waitForTimeout(700)
      }
    }
    if (!clicked) {
      quiet += 1
      await page.waitForTimeout(1000)
    }
  }
  if (quiet < 3) throw new ProbeError('a first-run dialog never went away')
  return dismissed
}

/** Select the assembly's preset from the session header, and require the seat to show it. */
async function selectPreset(page) {
  const seat = page.locator('button[title="Choose the agent preset for your new task"]')
  try {
    await seat.first().waitFor({ timeout: 30_000 })
  } catch {
    throw new ProbeError('the agent-preset seat never appeared in the session header')
  }
  await seat.first().click()
  const item = page.locator('[role="menuitem"]', { hasText: PRESET_NAME })
  try {
    await item.first().waitFor({ timeout: 20_000 })
  } catch {
    const offered = await page.locator('[role="menuitem"]').allInnerTexts()
    throw new ProbeError(
      `the preset menu offers no ${JSON.stringify(PRESET_NAME)}; it offers ${JSON.stringify(offered.map(text => text.split('\n')[0]))}`,
    )
  }
  await item.first().click()
  await expectSeat(page)
}

/** The header's seat is the app's own statement of which preset the session carries. */
async function expectSeat(page) {
  try {
    await page.waitForFunction(
      name =>
        [...document.querySelectorAll('button[title="Choose the agent preset for your new task"]')].some(button =>
          (button.innerText ?? '').includes(name),
        ),
      PRESET_NAME,
      { timeout: 20_000 },
    )
  } catch {
    throw new ProbeError(
      `the seat does not read ${JSON.stringify(PRESET_NAME)}; the session is not using the assembly's preset`,
    )
  }
}

/**
 * Pick the deployment's workspace root, unless the app already holds one (it remembers the last
 * choice, so the picker is absent on a second run). The picker's own path field navigates on Enter and
 * then enables Open.
 */
async function chooseWorkspace(page, home) {
  const composer = composerOf(page)
  if ((await composer.count()) > 0) return

  const chooser = page.getByRole('button', { name: 'Choose workspace' }).last()
  if ((await chooser.count()) === 0)
    throw new ProbeError('no composer and no workspace chooser: the app did not render a session')
  await chooser.click()

  const edit = page.getByRole('button', { name: 'Edit path' })
  if ((await edit.count()) > 0) {
    await edit.click()
    const field = page.locator('input[aria-label="Edit path"]')
    await field.fill(join(home, 'workspaces', 'singularity'))
    await field.press('Enter')
    await page.waitForTimeout(2000)
  }
  const open = page.getByRole('button', { name: 'Open', exact: true })
  if ((await open.count()) === 0 || (await open.isDisabled()))
    throw new ProbeError('the workspace picker did not accept the deployment workspace root')
  await open.click()
  try {
    await composer.waitFor({ timeout: 30_000 })
  } catch {
    throw new ProbeError('the workspace was accepted but the composer never appeared')
  }
}

/** Preset first, then workspace: the choice is the *new* session's preset, and the workspace names it. */
async function prepare(page, home) {
  const dismissed = await dismissFirstRun(page)
  await selectPreset(page)
  await chooseWorkspace(page, home)
  await expectSeat(page)
  return dismissed
}

/**
 * Send one message and wait until the turn has started.
 *
 * `fill` inserts the whole prompt as one edit: typing it key by key would press Enter on every
 * newline, and in a chat composer Enter sends, so the probe would post its first line as a message.
 * The send button's label flips to `Stop generating` the instant the turn starts, which is exactly
 * while Playwright re-checks an ordinary click's actionability — a landed send must not read as a
 * timeout, so the click is dispatched at the button and the wait below is what proves it happened.
 */
async function send(page, prompt) {
  const composer = composerOf(page)
  await composer.waitFor({ timeout: 30_000 })
  await composer.fill(prompt)
  const typed = await composer.innerText()
  if (!typed.includes(prompt.split('\n')[0].slice(0, 20)))
    throw new ProbeError('the composer did not take the prompt; the app would send an empty turn')
  await page.locator('button[aria-label="Send message"]').first().click({ force: true })
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('button[aria-label="Stop generating"]') !== null ||
        document.querySelector('[data-tool]') !== null,
      null,
      { timeout: 60_000 },
    )
  } catch {
    throw new ProbeError('the message was sent but no turn started')
  }
}

/** Wait for the named tool rows to be present. */
async function waitForTools(page, names) {
  for (const name of names) {
    try {
      await page.waitForFunction(
        tool => document.querySelector(`[data-tool="${tool}"]`) !== null,
        name,
        { timeout: TURN_TIMEOUT_MS },
      )
    } catch {
      throw new ProbeError(`the turn never called ${name}; it called ${JSON.stringify(await toolNames(page))}`)
    }
  }
}

/**
 * Wait for the turn to settle. The composer's own button is the clock: it reads `Stop generating`
 * while a turn runs and `Send message` once the turn is over, which beats guessing at a stream flag.
 */
async function settle(page) {
  try {
    await page.waitForFunction(() => document.querySelector('button[aria-label="Stop generating"]') === null, null, {
      timeout: TURN_TIMEOUT_MS,
    })
  } catch {
    throw new ProbeError('the turn never settled')
  }
  await page.waitForTimeout(SETTLE_MS)
}

/** Expand every assembly tool card, so the screenshot and the text show what the tools answered. */
async function expandTools(page) {
  const rows = page.locator('[data-tool^="singularity_"]')
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index)
    const expanded = await row.evaluate(element => element.querySelector('[aria-expanded="true"]') !== null)
    if (!expanded) await row.click({ force: true }).catch(() => undefined)
  }
  await page.waitForTimeout(500)
}

/** Every tool name the conversation has rendered, in order. */
const toolNames = page =>
  page.evaluate(() => [...document.querySelectorAll('[data-tool]')].map(row => row.getAttribute('data-tool')))

/** The conversation's visible text: the tool cards' bodies and the model's own words. */

const composerOf = page => page.locator('div[role="textbox"][contenteditable="true"]')
const compact = text => text.replace(/\s+/g, '')
/** The last capture of `pattern`, or undefined: a later tool answer supersedes an earlier one. */
const last = (text, pattern) => [...text.matchAll(new RegExp(pattern.source, 'g'))].at(-1)?.[1]

/** Read the evidence fields one turn's text carries. */
function fields(turn) {
  const text = compact(turn)
  return {
    verdict: last(text, /"verdict":"(pass|fail)"/),
    phase: last(text, /"phase":"(verified|failed|awaiting-run|running)"/),
    receiptStatus: last(text, /"status":"(verified|failed)"/),
    artifactDigest: last(text, /"artifactDigest":"([0-9a-f]{64})"/),
    taskId: last(text, /"taskId":"(task-[0-9a-f]+)"/),
    receiptTaskId: last(text, /"receipt":\{"taskId":"(task-[0-9a-f]+)"/),
    runId: last(text, /"runId":"(run-[0-9a-f]+)"/),
  }
}

/**
 * One session log, decoded whole.
 *
 * The log is a stream of zstd frames, one per flush, and Node's own zstd decoder stops at the first
 * frame — it returns the header and nothing else. The host's `zstd` decodes the stream, so the probe
 * reads the record it is about to assert on instead of an empty prefix of it.
 */
function readSession(file) {
  const decoded = spawnSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  if (decoded.error !== undefined)
    throw new ProbeError(`zstd could not be run to read ${file}: ${decoded.error.message}`)
  if (decoded.status !== 0)
    throw new ProbeError(`zstd exited ${decoded.status} reading ${file}: ${(decoded.stderr ?? '').toString().trim()}`)
  return decoded.stdout.toString('utf8')
}

/**
 * The web session the server is appending to for this workspace.
 *
 * Read from the server's own log rather than from the UI: the id in the session header is the fact the
 * recovery leg has to compare across the kill, and the browser is not where it is written.
 * @returns the newest non-control session for `workspaceRoot`, with its header fields.
 */
async function sessionOf(home, workspaceRoot) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  let newest
  for (const scope of await readdir(root)) {
    for (const directory of await readdir(join(root, scope))) {
      const file = join(root, scope, directory, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const header = JSON.parse(readSession(file).split('\n')[0])
      if (header.type !== 'session' || header.cwd !== workspaceRoot || !String(header.id).startsWith('session-')) continue
      const { mtimeMs } = await stat(file)
      if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { id: header.id, preset: header.agentPreset, mtimeMs, file }
    }
  }
  return newest
}

/**
 * The tool calls and tool results one session recorded, optionally for a single turn.
 *
 * The receipt facts are read here rather than scraped from the page: a tool card renders a
 * presentation of the call, not the JSON the tool answered, and the session log is the record the
 * server itself wrote for the very session this probe drove. The browser still has to prove the turn
 * happened — that is what the `data-tool` rows are for.
 */
function sessionFacts(file, turn) {
  const calls = []
  const results = []
  for (const line of readSession(file).split('\n')) {
    if (line === '') continue
    const event = JSON.parse(line)
    if (turn !== undefined && event.data?.turn !== turn) continue
    if (event.type === 'tool/call') calls.push(event.data.name)
    if (event.type === 'tool/result')
      results.push((event.data.message?.content ?? []).map(part => part.text ?? '').join(''))
  }
  return { calls, text: results.join('\n') }
}

/** Print the evidence block before any assertion about it can fail. */
function report(evidence) {
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

/** The default leg: one full turn against the deployed profile. */
async function liveLeg(home, context, screenshot) {
  const port = await freePort()
  const workspace = join(home, 'workspaces', 'singularity')
  const server = await boot(port)
  try {
    const page = await openApp(context, server.url)
    const dismissed = await prepare(page, home)
    await send(page, FULL_PROMPT)
    await waitForTools(page, TOOLS)
    await settle(page)
    await expandTools(page)

    const called = await toolNames(page)
    const session = await sessionOf(home, workspace)
    if (session === undefined) throw new ProbeError('the server recorded no session for this workspace')
    const facts = sessionFacts(session.file, 1)
    const { verdict, phase, receiptStatus, artifactDigest, runId } = fields(facts.text)

    await mkdir(dirname(screenshot), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })

    const evidence = {
      leg: 'live',
      command: server.command,
      url: server.url,
      chromium: context.browser().version(),
      preset: PRESET_NAME,
      screenshot,
      session: session.id,
      dismissedFirstRun: dismissed,
      toolsCalledInBrowser: called,
      toolsCalledInSession: facts.calls,
      runId,
      verdict,
      phase,
      receiptStatus,
      artifactDigest,
    }
    report(evidence)

    const missing = TOOLS.filter(tool => !called.includes(tool) || !facts.calls.includes(tool))
    if (missing.length > 0)
      throw new ProbeError(
        `the turn did not call ${missing.join(', ')}; the browser showed ${JSON.stringify(called)}, the session recorded ${JSON.stringify(facts.calls)}`,
      )
    if (verdict !== 'pass' || receiptStatus !== 'verified')
      throw new ProbeError(
        `the run did not record a passing verdict: verdict=${verdict}, phase=${phase}, receiptStatus=${receiptStatus}\n--- the tool results ---\n${facts.text.slice(-2000)}`,
      )
    return evidence
  } finally {
    await kill(server)
  }
}

/** The recovery leg: admit a task, SIGKILL the server, resume the session, finish the task. */
async function recoveryLeg(home, context, screenshot) {
  const port = await freePort()
  const workspace = join(home, 'workspaces', 'singularity')
  let server = await boot(port)
  try {
    const page = await openApp(context, server.url)
    const dismissed = await prepare(page, home)
    await send(page, PROPOSE_PROMPT)
    await waitForTools(page, ['singularity_propose_task'])
    await settle(page)

    const before = await sessionOf(home, workspace)
    if (before === undefined) throw new ProbeError('the server recorded no session for this workspace')
    const firstFacts = sessionFacts(before.file, 1)
    const taskId = fields(firstFacts.text).taskId
    if (taskId === undefined)
      throw new ProbeError(`turn one admitted no task; the tool results were:\n${firstFacts.text.slice(-2000)}`)

    // A SIGKILL, not a shutdown: no plugin gets to flush, close a handle, or finish a write.
    const killed = server
    killed.child.kill('SIGKILL')
    await killed.exited

    server = await boot(port)
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New Session' }).first().waitFor({ timeout: 60_000 })
    await dismissFirstRun(page)

    // The resumed session renders turn one's own tool row before anything is sent. A fresh session
    // would not, and a leg that started over would prove nothing about the recorded facts. A short
    // wait: the card is either restored with the session or it is not, and a resume failure should
    // say so instead of surfacing later as a missing tool call.
    try {
      await page.waitForFunction(
        () => document.querySelector('[data-tool="singularity_propose_task"]') !== null,
        null,
        { timeout: 60_000 },
      )
    } catch {
      throw new ProbeError("the app did not resume the session after the restart: turn one's tool card never reappeared")
    }
    const after = await sessionOf(home, workspace)
    if (after === undefined) throw new ProbeError('the restarted server recorded no session for this workspace')
    if (after.id !== before.id)
      throw new ProbeError(
        `the app did not resume the session: before the kill the server was appending to ${before.id}, after the restart to ${after.id}`,
      )

    await send(page, submitPrompt(taskId))
    await waitForTools(page, ['singularity_submit_program', 'singularity_task_status'])
    await settle(page)
    await expandTools(page)

    const called = await toolNames(page)
    const resumed = await sessionOf(home, workspace)
    const secondFacts = sessionFacts(resumed.file, 2)
    const { verdict, phase, receiptStatus, artifactDigest, receiptTaskId, runId } = fields(secondFacts.text)

    await mkdir(dirname(screenshot), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })

    const evidence = {
      leg: 'recovery',
      command: server.command,
      port,
      url: server.url,
      chromium: context.browser().version(),
      preset: PRESET_NAME,
      screenshot,
      dismissedFirstRun: dismissed,
      sessionBeforeKill: before.id,
      sessionAfterRestart: after.id,
      taskIdBeforeKill: taskId,
      receiptTaskId,
      runId,
      toolsCalledInBrowser: called,
      toolsCalledInSession: secondFacts.calls,
      verdict,
      phase,
      receiptStatus,
      artifactDigest,
    }
    report(evidence)

    const missing = ['singularity_submit_program', 'singularity_task_status'].filter(
      tool => !called.includes(tool) || !secondFacts.calls.includes(tool),
    )
    if (missing.length > 0)
      throw new ProbeError(
        `the resumed turn did not call ${missing.join(', ')}; the browser showed ${JSON.stringify(called)}, the session recorded ${JSON.stringify(secondFacts.calls)}`,
      )
    if (receiptTaskId === undefined)
      throw new ProbeError(
        `the resumed turn read no receipt for ${taskId}; verdict=${verdict}, phase=${phase}, receiptStatus=${receiptStatus}\n--- the tool results ---\n${secondFacts.text.slice(-2000)}`,
      )
    if (receiptTaskId !== taskId)
      throw new ProbeError(`the receipt names ${receiptTaskId}, not the task admitted before the kill (${taskId})`)
    if (verdict !== 'pass' || receiptStatus !== 'verified')
      throw new ProbeError(
        `the resumed run did not record a passing verdict: verdict=${verdict}, phase=${phase}, receiptStatus=${receiptStatus}\n--- the tool results ---\n${secondFacts.text.slice(-2000)}`,
      )
    return evidence
  } finally {
    await kill(server)
  }
}

/** SIGTERM, then SIGKILL: a probe that leaves the server listening is a probe that lied about owning it. */
async function kill(server) {
  const { child, exited } = server
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!stopped) child.kill('SIGKILL')
}

/** One free loopback port, asked of the kernel rather than guessed. */
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const home = process.env['DSH_HOME']
const recovery = process.argv.includes('--recovery')
const screenshotFlag = process.argv.indexOf('--screenshot')
if (home === undefined || home === '')
  process.stderr.write("browser-probe: DSH_HOME is not set; source the deployment's environment (env.sh) before probing\n")
else if (screenshotFlag !== -1 && process.argv[screenshotFlag + 1] === undefined)
  process.stderr.write('browser-probe: --screenshot needs a path\n')
else {
  const screenshot =
    screenshotFlag === -1
      ? join(home, 'artifacts', recovery ? 'browser-probe-recovery.png' : 'browser-probe.png')
      : process.argv[screenshotFlag + 1]
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await (recovery ? recoveryLeg(home, context, screenshot) : liveLeg(home, context, screenshot))
  } catch (error) {
    process.stderr.write(
      `browser-probe: ${error instanceof ProbeError ? error.message : (error?.stack ?? String(error))}\n`,
    )
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

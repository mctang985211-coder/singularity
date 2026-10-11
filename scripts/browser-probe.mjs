#!/usr/bin/env node
/** Real private-profile G1 smoke, working/submitted crash recovery, or native --aborted lifecycle. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import { digestOf } from '../src/protocol/envelope.ts'
import { runIdOf, sha256 } from '../assembly/src/ids.ts'
import { DSH_BIN, DSH_HOME, dshModule, openPersistence } from './dsh-control-runtime.mjs'

export const PROFILE = 'singularity-next-web'
export const PRESET_NAME = 'Singularity Next'
export const BOOT_TIMEOUT_MS = 120_000
export const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/
const TURN_TIMEOUT_MS = 300_000
const TOOLS = ['singularity_propose_task', 'singularity_submit_program', 'singularity_task_status']
const CONTROL_SESSION = 'singularity:control:singularity-local'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const diagnosticOf = value => String(value).replaceAll(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]')
const composerOf = page => page.locator('div[role="textbox"][contenteditable="true"]')
const FULL_PROMPT = [
  'Use singularity_propose_task to count the ASCII letters (A-Z and a-z) in the protected input.',
  'Then use singularity_submit_program for that exact taskId with a small Node ES module program.',
  'The program runs as node program.mjs <input path>; import node:fs and print only the count.',
  'Finally call singularity_task_status for the same taskId and report its receipt.',
  'Do not decompose this single task.',
].join('\n')
const PROPOSE_PROMPT = [
  'Call singularity_propose_task once to count the ASCII letters in the protected input.',
  'The domain will later run a submitted Node ES module as node program.mjs <input path>.',
  'Do not submit a program in this turn. Report its taskId and runId.',
].join('\n')

export async function boot(port, extra = [], home = DSH_HOME) {
  const argv = ['--profile', PROFILE, ...extra, '--host', '127.0.0.1', '--port', String(port), '--no-open']
  const child = spawn(DSH_BIN, argv, { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const server = { child, command: DSH_BIN + ' ' + argv.join(' '), output: '' }
  child.stdout.on('data', chunk => { server.output += chunk })
  child.stderr.on('data', chunk => { server.output += chunk })
  server.exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const found = URL_PATTERN.exec(server.output)
      if (found !== null) {
        assert(!server.output.includes('skipping profile bundle'), server.output)
        assert(!server.output.includes('did not activate'), server.output)
        server.url = found[0]
        return server
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(server.output)
      await sleep(250)
    }
    throw new Error('profile printed no listening URL:\n' + server.output)
  } catch (error) {
    await kill(server)
    throw error
  }
}

export async function openApp(context, url) {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor({ timeout: 60_000 })
  return page
}
export async function dismissFirstRun(page) {
  const dismissed = []
  let quiet = 0
  for (let attempt = 0; attempt < 60 && quiet < 3; attempt++) {
    let clicked = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true })
      if (await button.count() && await button.first().isVisible()) {
        await button.first().click()
        dismissed.push(name)
        clicked = true
        quiet = 0
        await page.waitForTimeout(700)
      }
    }
    if (!clicked) { quiet += 1; await page.waitForTimeout(1000) }
  }
  assert(quiet >= 3, 'first-run dialog did not close')
  return dismissed
}
export async function selectPreset(page) {
  const seat = page.locator('button[title="Choose the agent preset for your new task"]').first()
  await seat.waitFor({ timeout: 30_000 })
  await seat.click()
  await page.locator('[role="menuitem"]', { hasText: PRESET_NAME }).first().click({ timeout: 20_000 })
  await expectSeat(page)
}
export async function expectSeat(page) {
  await page.waitForFunction(name => [...document.querySelectorAll('button[title="Choose the agent preset for your new task"]')]
    .some(button => button.innerText.includes(name)), PRESET_NAME, { timeout: 20_000 })
}
export async function chooseWorkspace(page, home) {
  if (await composerOf(page).count()) return
  await page.getByRole('button', { name: 'Choose workspace' }).last().click()
  const edit = page.getByRole('button', { name: 'Edit path' })
  if (await edit.count()) {
    await edit.click()
    const field = page.locator('input[aria-label="Edit path"]')
    await field.fill(join(home, 'workspaces', 'singularity'))
    await field.press('Enter')
    await page.waitForTimeout(2000)
  }
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await composerOf(page).waitFor({ timeout: 30_000 })
}
export async function prepare(page, home) {
  const dismissed = await dismissFirstRun(page)
  await selectPreset(page)
  await chooseWorkspace(page, home)
  await expectSeat(page)
  return dismissed
}
export async function send(page, prompt) {
  const composer = composerOf(page)
  await composer.waitFor({ timeout: 30_000 })
  await composer.fill(prompt)
  assert((await composer.innerText()).includes(prompt.split('\n')[0].slice(0, 20)), 'composer did not accept the prompt')
  const before = await page.locator('[data-tool]').count()
  await page.locator('button[aria-label="Send message"]').first().click({ force: true })
  await page.waitForFunction(count => document.querySelector('button[aria-label="Stop generating"]') !== null ||
    document.querySelectorAll('[data-tool]').length > count, before, { timeout: 60_000 })
}
export async function waitForTools(page, names) {
  for (const name of names) {
    await page.waitForFunction(tool => document.querySelector('[data-tool="' + tool + '"]') !== null ||
      document.querySelector('button[aria-label="Stop generating"]') === null, name, { timeout: TURN_TIMEOUT_MS })
    assert(await page.locator('[data-tool="' + name + '"]').count() > 0, 'the turn ended before calling ' + name)
  }
}
async function settle(page) {
  await page.waitForFunction(() => document.querySelector('button[aria-label="Stop generating"]') === null, null,
    { timeout: TURN_TIMEOUT_MS })
  await page.waitForTimeout(1000)
}
async function kill(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return
  server.child.kill('SIGTERM')
  const stopped = await Promise.race([server.exited.then(() => true), sleep(5000).then(() => false)])
  if (!stopped) { server.child.kill('SIGKILL'); await server.exited }
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function readLog(persistence, sessionId) {
  const { SessionId } = await dshModule('@deepseek-ai/dsh-session')
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}
async function controlFacts(persistence) {
  const stored = await persistence.list()
  if (!stored.some(entry => entry.header.id === CONTROL_SESSION)) return []
  return (await readLog(persistence, CONTROL_SESSION)).map(event => {
    assert.equal(event.type, 'plugin:singularity:control')
    return event.data.payload
  })
}
export function toolFacts(events) {
  const calls = events.filter(event => event.type === 'tool/call')
  const names = new Map(calls.map(event => [event.data.callId, event.data.name]))
  const results = events.filter(event => event.type === 'tool/result' && names.get(event.data.message.toolCallId)?.startsWith('singularity_'))
    .map(event => ({ callId: event.data.message.toolCallId, name: names.get(event.data.message.toolCallId), seq: event.seq,
      value: event.data.message.isError
        ? event.data.message
        : JSON.parse(event.data.message.content.map(part => part.text ?? '').join('')) }))
  return { calls, results }
}
async function waitForRun(persistence, page, stage, exclude = []) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const facts = await controlFacts(persistence)
    assert(await page.locator('button[aria-label="Stop generating"]').count() > 0, 'the turn ended before reaching crash stage ' + stage)
    const started = facts.find(fact => fact.kind === 'run/started' && !exclude.includes(fact.subject))
    if (started !== undefined) {
      const taskId = started.subject
      const runId = started.payload.runId
      const bubble = facts.find(fact => fact.kind === 'bubble/opened' && fact.subject === taskId)
      const submitted = facts.find(fact => fact.kind === 'run/submitted' && fact.subject === taskId)
      const terminal = facts.find(fact => ['run/verified', 'run/failed'].includes(fact.kind) && fact.subject === taskId)
      assert(terminal === undefined, 'the Run settled before the crash boundary was observed')
      if (bubble !== undefined && (stage === 'working' || submitted !== undefined)) {
        assert(await page.locator('button[aria-label="Stop generating"]').count() > 0, 'the crash boundary was idle')
        const holder = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === taskId).payload.agentId
        const sessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === holder).payload.sessionId
        const transcript = await readLog(persistence, sessionId)
        const turn = transcript.findLast(event => event.type === 'turn/start').data.turn
        assert(!transcript.some(event => event.type === 'turn/end' && event.data.turn === turn), 'the turn was already complete')
        const proposal = toolFacts(transcript).results.find(result => result.name === 'singularity_propose_task' &&
          result.value.taskId === taskId && result.value.runId === runId)
        if (proposal === undefined) { await sleep(20); continue }
        return { taskId, runId, sessionId, workspace: bubble.payload.workspace.ref,
          proposalCallId: proposal.callId, openTurn: turn,
          inputDigests: bubble.payload.inputs, submission: submitted?.payload.submission ?? null, stage }
      }
    }
    await sleep(20)
  }
  throw new Error('no live Run reached crash stage ' + stage)
}
async function provenance(persistence, taskId, runId, sessionId, domainDir) {
  const facts = await controlFacts(persistence)
  const transcript = await readLog(persistence, sessionId)
  const tool = toolFacts(transcript)
  const status = tool.results.findLast(result => result.name === 'singularity_task_status' && result.value.receipt?.taskId === taskId)
  const receipt = status?.value.receipt
  assert(receipt !== undefined, 'the actual tool transcript contains no receipt for the Task')
  assert.equal(receipt.runId, runId)
  assert.equal(receipt.status, 'verified')
  const runs = facts.filter(fact => fact.kind === 'run/started' && fact.subject === taskId)
  assert.equal(runs.length, 1, 'recovery or submit created another solve Run')
  assert.equal(runs[0].payload.runId, runId)
  const submitted = facts.find(fact => fact.kind === 'run/submitted' && fact.subject === taskId)
  const terminal = facts.find(fact => fact.kind === 'run/verified' && fact.subject === taskId)
  const proposed = tool.results.find(result => result.name === 'singularity_propose_task' && result.value.taskId === taskId && result.value.runId === runId)
  assert(proposed !== undefined, 'the actual proposal result is not linked to this Run')
  assert.equal(runId, runIdOf('singularity-local', sessionId, proposed.callId))
  assert.equal(runs[0].commandId, 'start:' + runId)
  const submissionCall = tool.calls.find(call => call.data.name === 'singularity_submit_program' &&
    'submit-' + sha256(JSON.stringify(['singularity-local', sessionId, call.data.callId])) === submitted.payload.submission.requestId)
  assert(submissionCall !== undefined, 'the frozen submission is not linked to an actual DSH call')
  const request = JSON.parse(submissionCall.data.arguments)
  assert.equal(request.taskId, taskId)
  assert.equal(submitted.payload.submission.requestDigest, sha256(JSON.stringify({ taskId: request.taskId, program: request.program })))
  assert.equal(submitted.payload.submission.programDigest, sha256(request.program))
  assert.deepEqual(receipt.submission, submitted.payload.submission)
  assert.deepEqual(receipt.source, submitted.payload.submission.source)
  assert.equal(receipt.cutoff, terminal.seq + 1)
  assert.equal(receipt.source.sessionId, sessionId)
  const source = receipt.source
  assert(submissionCall.seq < source.eventCount, 'the sealed source excludes its own submission call')
  assert(status.seq >= source.eventCount, 'the status result precedes the frozen source')
  const prefix = transcript.slice(0, source.eventCount)
  assert.equal(prefix.length, source.eventCount)
  assert.equal(source.digest, digestOf({ sessionId, eventCount: source.eventCount, events: prefix }))
  assert(transcript.length > source.eventCount, 'receipt source was not sealed before later transcript events')
  const descriptor = JSON.parse(await readFile(join(domainDir, 'task.json'), 'utf8'))
  const workspace = receipt.consumption.workspace.ref
  const disk = {
    programDigest: sha256(await readFile(join(workspace, descriptor.workspace.file))),
    artifactDigest: sha256(await readFile(join(workspace, descriptor.workspace.artifact))),
    inputDigests: await Promise.all(descriptor.inputs.map(async input => ({ name: input.path, digest: sha256(await readFile(join(workspace, input.path))) }))),
  }
  assert.equal(disk.programDigest, receipt.submission.programDigest)
  assert.equal(disk.artifactDigest, receipt.submission.artifactDigest)
  assert.deepEqual(disk.inputDigests, receipt.submission.inputDigests)
  assert.deepEqual(disk.inputDigests, receipt.consumption.inputs)
  for (const criterion of receipt.criteria) {
    const verifier = descriptor.verifiers.find(verifier => verifier.ref === criterion.verifierRef)
    assert.equal(criterion.implementationDigest, sha256(await readFile(join(domainDir, verifier.program))))
    assert.equal(criterion.artifactDigest, disk.artifactDigest)
  }
  const headers = transcript.filter(event => event.type === 'request/header').map(event => event.data.header)
  for (const header of headers)
    assert.deepEqual(header.tools.map(tool => tool.name).sort(), [...TOOLS, 'singularity_decompose_task'].sort(), 'the Singularity preset exposes an unowned execution capability')
  const header = headers.at(-1)
  const declaredTools = header.tools.map(tool => tool.name).sort()
  return { receipt, tools: tool.calls.map(call => call.data.name),
    nativeErrors: tool.results.filter(result => result.value.isError === true),
    calls: tool.calls.map(call => ({ callId: call.data.callId, name: call.data.name, turn: call.data.turn, seq: call.seq })),
    provenance: { proposalCallId: proposed.callId, submissionCallId: submissionCall.data.callId, statusCallId: status.callId,
      startedSeq: runs[0].seq, submittedSeq: submitted.seq, terminalSeq: terminal.seq, disk },
    declaredTools, model: header.config, controlFactCount: facts.length, currentTranscriptEvents: transcript.length }
}

async function runProbe(home, context, screenshot, stage, extra) {
  const port = await freePort()
  let server = await boot(port, extra, home)
  const medium = await openPersistence(join(home, 'sessions'), 'zstd')
  let before
  try {
    const page = await openApp(context, server.url)
    const dismissedFirstRun = await prepare(page, home)
    if (stage === 'aborted') {
      await send(page, PROPOSE_PROMPT)
      await waitForTools(page, ['singularity_propose_task'])
      await settle(page)
      const first = (await controlFacts(medium.persistence)).find(fact => fact.kind === 'run/started')
      assert(first !== undefined, 'the control session has no unaffected Run')
      const read = async () => await page.evaluate(async () => {
        const response = await fetch('/singularity/tasks', { cache: 'no-store' })
        if (!response.ok) throw new Error('task read refused: ' + response.status)
        return await response.json()
      })
      const unaffected = (await read()).tasks.find(task => task.taskId === first.subject)
      assert.equal(unaffected.phase, 'running')
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      await selectPreset(page)
      await chooseWorkspace(page, home)
      await send(page, PROPOSE_PROMPT)
      before = await waitForRun(medium.persistence, page, 'working', [first.subject])
      process.stderr.write('browser-probe: working Run observed; clicking native Stop generating\n')
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
      await settle(page)
      let snapshot = await read()
      const deadline = Date.now() + 10_000
      while (snapshot.tasks.find(task => task.taskId === before.taskId)?.phase !== 'failed' && Date.now() < deadline) {
        await sleep(20)
        snapshot = await read()
      }
      const failed = snapshot.tasks.find(task => task.taskId === before.taskId)
      assert.equal(failed.phase, 'failed', 'native cancellation left the working Run open')
      assert.deepEqual(snapshot.tasks.find(task => task.taskId === first.subject), unaffected)
      const facts = await controlFacts(medium.persistence)
      const terminal = facts.filter(fact => fact.kind === 'run/failed')
      assert.equal(terminal.length, 1, 'cancellation affected another Run')
      assert.equal(terminal[0].subject, before.taskId)
      assert.equal(terminal[0].payload.runId, before.runId)
      assert.equal(failed.runs[0].detail, terminal[0].payload.reason)
      assert(terminal[0].payload.reason.startsWith('session-turn-failed: '))
      const source = JSON.parse(terminal[0].payload.reason.slice('session-turn-failed: '.length))
      const transcript = await readLog(medium.persistence, before.sessionId)
      const ended = transcript.findLast(event => event.type === 'turn/end')
      assert.deepEqual(source, { sessionId: before.sessionId, turn: before.openTurn, seq: ended.seq, reason: ended.data.reason })
      assert.deepEqual(ended.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
      assert.equal(terminal[0].commandId, `turn-failed:${before.sessionId}/${ended.seq}/${before.runId}`)
      assert(!facts.some(fact => fact.kind === 'run/submitting'), 'the lifecycle probe unexpectedly submitted work')
      const safeOwner = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === first.subject).payload.agentId
      const unaffectedSessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === safeOwner).payload.sessionId
      assert.notEqual(unaffectedSessionId, before.sessionId)
      const safeTranscript = await readLog(medium.persistence, unaffectedSessionId)
      assert.equal(safeTranscript.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
      const header = transcript.findLast(event => event.type === 'request/header').data.header
      const declaredTools = header.tools.map(tool => tool.name).sort()
      assert.deepEqual(declaredTools, [...TOOLS, 'singularity_decompose_task'].sort())
      await mkdir(dirname(screenshot), { recursive: true })
      await page.screenshot({ path: screenshot, fullPage: true })
      const evidence = { leg: stage, host: server.command, hostPid: server.child.pid,
        origin: new URL(server.url).origin, chromium: context.browser().version(), preset: PRESET_NAME,
        dismissedFirstRun, screenshot, taskId: before.taskId, runId: before.runId, sessionId: before.sessionId,
        stop: { native: true, observed: before, source, terminal: terminal[0] },
        unaffectedSessionId, unaffectedBefore: unaffected, unaffectedAfter: snapshot.tasks.find(task => task.taskId === first.subject),
        read: failed, declaredTools, model: header.config, controlFactCount: facts.length }
      process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
      return evidence
    }
    await send(page, stage === 'working' ? PROPOSE_PROMPT : FULL_PROMPT)
    process.stderr.write('browser-probe: ' + (stage ?? 'live') + ' native turn started\n')
    if (stage !== undefined) {
      before = await waitForRun(medium.persistence, page, stage)
      before = { ...before, signal: 'SIGKILL', hostPid: server.child.pid }
      process.stderr.write('browser-probe: durable ' + stage + ' Run observed; killing host\n')
      server.child.kill('SIGKILL')
      await server.exited
      server = await boot(port, extra, home)
      assert.notEqual(server.child.pid, before.hostPid, 'the restarted host reused its predecessor process')
      await page.goto(server.url, { waitUntil: 'domcontentloaded' })
      await dismissFirstRun(page)
      await waitForTools(page, ['singularity_propose_task'])
      const prompt = stage === 'working'
        ? 'The existing Task ' + before.taskId + ' already has Run ' + before.runId + '. Submit its ASCII letter counter using singularity_submit_program. The domain runs Node ES module source as node program.mjs <input path>; import node:fs and print only the count. Then call singularity_task_status. Do not propose a new Task.'
        : 'The existing Task ' + before.taskId + ' and Run ' + before.runId + ' were submitted before restart. Call only singularity_task_status for that Task. Do not propose or submit again.'
      await send(page, prompt)
      process.stderr.write('browser-probe: restarted host; native continuation sent to existing session\n')
      await waitForTools(page, stage === 'working' ? TOOLS : ['singularity_task_status'])
    } else await waitForTools(page, TOOLS)
    await settle(page)
    const facts = await controlFacts(medium.persistence)
    const started = facts.find(fact => fact.kind === 'run/started')
    assert(started !== undefined, 'the profile recorded no solve Run')
    const taskId = before?.taskId ?? started.subject
    const runId = before?.runId ?? started.payload.runId
    const holder = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === taskId).payload.agentId
    const sessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === holder).payload.sessionId
    const domainDir = stage === 'submitted' ? join(home, 'domain') : join(ROOT, 'deployment/domain/letters')
    const result = await provenance(medium.persistence, taskId, runId, sessionId, domainDir)
    if (before !== undefined) {
      assert.equal(sessionId, before.sessionId, 'native resume changed the responsible session')
      assert.equal(result.receipt.consumption.workspace.ref, before.workspace, 'recovery changed the Run workspace')
      assert.deepEqual(result.receipt.consumption.inputs, before.inputDigests)
      if (before.submission !== null) assert.deepEqual(result.receipt.submission, before.submission)
    }
    for (const tool of TOOLS) assert(result.tools.includes(tool), 'actual session did not call ' + tool)
    await mkdir(dirname(screenshot), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })
    const evidence = { leg: stage ?? 'live', controlledVerifierDelayMs: stage === 'submitted' ? 2000 : 0,
      host: server.command, origin: new URL(server.url).origin,
      hostPid: server.child.pid,
      chromium: context.browser().version(), preset: PRESET_NAME, dismissedFirstRun, screenshot,
      taskId, runId, sessionId, crash: before ?? null, ...result }
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
    return evidence
  } catch (error) {
    const facts = await controlFacts(medium.persistence)
    const sessions = await medium.persistence.list()
    const failures = []
    for (const stored of sessions) {
      if (stored.header.id === CONTROL_SESSION) continue
      const events = await readLog(medium.persistence, stored.header.id)
      const tool = toolFacts(events)
      failures.push({ sessionId: stored.header.id,
        model: events.findLast(event => event.type === 'request/header')?.data.header.config ?? null,
        turnEnd: events.findLast(event => event.type === 'turn/end')?.data ?? null,
        calls: tool.calls.map(event => ({ seq: event.seq, turn: event.data.turn, name: event.data.name, callId: event.data.callId })),
        results: tool.results })
    }
    process.stdout.write(JSON.stringify({ leg: stage ?? 'live', failure: diagnosticOf(error), crash: before ?? null, sessions: failures,
      control: facts.map(fact => ({ seq: fact.seq, kind: fact.kind, subject: fact.subject, payload: fact.payload })) }, null, 2) + '\n')
    throw error
  } finally {
    await kill(server)
    await medium.context.fiber.dispose()
  }
}

async function isolatedHome(stage) {
  const home = await mkdtemp(join(tmpdir(), 'singularity-browser-'))
  try {
    await copyFile(join(DSH_HOME, '.credentials.yaml'), join(home, '.credentials.yaml'))
    await chmod(join(home, '.credentials.yaml'), 0o600)
    const deployed = spawnSync(process.execPath, [join(ROOT, 'scripts/deploy.mjs')], {
      cwd: ROOT, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
    })
    assert.equal(deployed.status, 0, deployed.stderr || 'isolated profile deployment failed')
    const extra = []
    if (stage === 'submitted') {
      const domain = join(home, 'domain')
      await cp(join(ROOT, 'deployment/domain/letters'), domain, { recursive: true })
      const verifier = join(domain, 'verifier.mjs')
      const source = await readFile(verifier, 'utf8')
      // The controlled verifier retains its criterion and selftests; delay exposes the durable submitted seam.
      const delayed = source.replace("import { readFileSync } from 'node:fs'",
        "import { readFileSync } from 'node:fs'\nawait new Promise(resolve => setTimeout(resolve, 2000))")
      assert.notEqual(delayed, source, 'the controlled verifier has no declared import anchor')
      await writeFile(verifier, delayed)
      const overlay = join(home, 'crash.patch.yml')
      await writeFile(overlay, '- id: singularity-assembly\n  config:\n    controlId: singularity-local\n    domainDir: ' +
        JSON.stringify(domain) + '\n    workspaceRoot: ' + JSON.stringify(join(home, 'workspaces/singularity')) + '\n')
      extra.push('--patch', overlay)
    }
    return { home, extra }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(['--recovery', '--submitted', '--aborted'].filter(flag => process.argv.includes(flag)).length <= 1, 'select one lifecycle boundary')
  const stage = process.argv.includes('--aborted') ? 'aborted' : process.argv.includes('--submitted') ? 'submitted' : process.argv.includes('--recovery') ? 'working' : undefined
  const screenshotIndex = process.argv.indexOf('--screenshot')
  assert(screenshotIndex === -1 || process.argv[screenshotIndex + 1] !== undefined, '--screenshot requires a path')
  const screenshot = screenshotIndex === -1 ? join(tmpdir(), 'singularity-browser-' + (stage ?? 'live') + '.png') : process.argv[screenshotIndex + 1]
  let isolated
  let browser
  try {
    isolated = await isolatedHome(stage)
    browser = await chromium.launch()
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    await runProbe(isolated.home, context, screenshot, stage, isolated.extra)
  } catch (error) {
    process.stderr.write('browser-probe: ' + diagnosticOf(error.stack ?? error) + '\n')
    process.exitCode = 1
  } finally {
    await browser?.close()
    if (isolated !== undefined) await rm(isolated.home, { recursive: true, force: true })
  }
}

#!/usr/bin/env node
/** Private DSH browser evidence: G1, G2 decomposition/panel, crash recovery, and native cancellation. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import { digestOf } from '../src/protocol/envelope.ts'
import { AGENT_ROLE, declareAgentProtocol } from '../src/agent/protocol.ts'
import { ENVIRONMENT_ROLE, declareEnvironmentProtocol } from '../src/environment/protocol.ts'
import { declareMeasureProtocol } from '../src/measure/protocol.ts'
import { declareStrategyProtocol } from '../src/strategy/protocol.ts'
import { declareReleaseProtocol } from '../src/release/protocol.ts'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { SCHEDULER_ROLE, declareTaskProtocol, verifierRoleOf } from '../src/task/protocol.ts'
import { projectReceipt } from '../src/task/view.ts'
import { loadDomain } from '../assembly/src/domain.ts'
import { runIdOf, sha256 } from '../assembly/src/ids.ts'
import { snapshotOf } from '../assembly/src/snapshot.ts'
import { DSH_BIN, DSH_HOME, dshModule, openPersistence } from './dsh-control-runtime.mjs'

const PROFILE = 'singularity-next-web'
const PRESET_NAME = 'Singularity Next'
const BOOT_TIMEOUT_MS = 120_000
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/
const TURN_TIMEOUT_MS = 300_000
const G2_TIMEOUT_MS = 900_000
const TOOLS = ['singularity_propose_task', 'singularity_submit_program', 'singularity_task_status']
const DECLARED_TOOLS = [...TOOLS, 'singularity_decompose_task', 'singularity_create_method', 'singularity_run_method',
  'singularity_evolve_method', 'singularity_method_history', 'singularity_release_method'].sort()
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
const DECOMPOSE_PROMPT = [
  'Call singularity_propose_task once to count ASCII letters in the protected source.',
  'Then call singularity_decompose_task for that taskId with exactly this plan:',
  '{"children":[{"key":"extract","template":"extract-letters","dependsOn":[],"supports":["letters"],"maxRuns":1},',
  '{"key":"count","template":"count-letters","dependsOn":["extract"],"supports":["letters"],"maxRuns":1}]}',
  'After decomposition, finish this turn and wait for the host plan-outcome message.',
  'When that message says both children verified, continue the same parent Task and Run automatically.',
  'Independently submit its Node ES module program with singularity_submit_program; it runs as node program.mjs <input path>, imports node:fs and prints only the ASCII letter count of its protected source.',
  'Then call singularity_task_status for the existing parent Task and report its receipt. Do not propose or decompose again.',
].join('\n')

async function boot(port, extra = [], home = DSH_HOME) {
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

async function openApp(context, url) {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor({ timeout: 60_000 })
  return page
}
async function dismissFirstRun(page) {
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
async function selectPreset(page) {
  const seat = page.locator('button[title="Choose the agent preset for your new task"]').first()
  await seat.waitFor({ timeout: 30_000 })
  await seat.click()
  await page.locator('[role="menuitem"]', { hasText: PRESET_NAME }).first().click({ timeout: 20_000 })
  await expectSeat(page)
}
async function expectSeat(page) {
  await page.waitForFunction(name => [...document.querySelectorAll('button[title="Choose the agent preset for your new task"]')]
    .some(button => button.innerText.includes(name)), PRESET_NAME, { timeout: 20_000 })
}
async function chooseWorkspace(page, home) {
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
async function prepare(page, home) {
  const dismissed = await dismissFirstRun(page)
  await selectPreset(page)
  await chooseWorkspace(page, home)
  await expectSeat(page)
  return dismissed
}
async function send(page, prompt) {
  const composer = composerOf(page)
  await composer.waitFor({ timeout: 30_000 })
  await composer.fill(prompt)
  assert((await composer.innerText()).includes(prompt.split('\n')[0].slice(0, 20)), 'composer did not accept the prompt')
  const before = await page.locator('[data-tool]').count()
  await page.locator('button[aria-label="Send message"]').first().click({ force: true })
  await page.waitForFunction(count => document.querySelector('button[aria-label="Stop generating"]') !== null ||
    document.querySelectorAll('[data-tool]').length > count, before, { timeout: 60_000 })
}
async function waitForTools(page, names, timeout = TURN_TIMEOUT_MS) {
  for (const name of names) {
    await page.waitForFunction(tool => document.querySelector('[data-tool="' + tool + '"]') !== null ||
      document.querySelector('button[aria-label="Stop generating"]') === null, name, { timeout })
    assert(await page.locator('[data-tool="' + name + '"]').count() > 0, 'the turn ended before calling ' + name)
  }
}
async function settle(page, timeout = TURN_TIMEOUT_MS) {
  await page.waitForFunction(() => document.querySelector('button[aria-label="Stop generating"]') === null, null,
    { timeout })
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
export function assertToolHeader(header) {
  const declaredTools = header.tools.map(tool => tool.name).sort()
  assert.deepEqual(declaredTools, DECLARED_TOOLS, 'the Singularity preset must expose exactly its owned solve and method tools')
  return declaredTools
}
export function inputSourcesOf(facts, taskId, receipt) {
  const contract = facts.find(fact => fact.kind === 'task/admitted' && fact.subject === taskId).payload.contract
  const started = facts.find(fact => fact.kind === 'run/started' && fact.subject === taskId && fact.payload.runId === receipt.runId)
  assert.deepEqual(started.payload.revision, receipt.revision)
  const revision = facts.find(fact => fact.kind === 'revision/created' && fact.subject === receipt.revision.environmentId &&
    fact.payload.revisionId === receipt.revision.revisionId)
  assert.equal(digestOf(revision.payload.manifest), receipt.revision.digest, 'the Run revision differs from its durable input manifest')
  const manifest = revision.payload.manifest
  assert.equal(manifest.task, taskId)
  assert.deepEqual(manifest.taskTemplate, contract.template)
  assert.equal(manifest.inputSources.length, contract.inputs.length)
  assert.deepEqual(manifest.inputSources.map(({ name, digest }) => ({ name, digest })), receipt.consumption.inputs)
  for (const [index, input] of contract.inputs.entries()) {
    const bound = manifest.inputSources[index]
    assert.equal(bound.name, input.name)
    if (input.source.kind === 'protected') {
      assert.deepEqual(bound.source, input.source)
      assert.equal(bound.digest, input.source.digest)
    } else {
      assert.equal(bound.source.kind, 'artifact')
      assert.equal(bound.source.taskId, input.source.taskId)
      const producer = facts.find(fact => fact.kind === 'run/verified' && fact.subject === bound.source.taskId &&
        fact.payload.runId === bound.source.runId)
      assert(producer !== undefined && producer.seq < revision.seq && revision.seq < started.seq,
        'the consumed producer Run was not verified before its input revision and dependent Run')
      const sealed = facts.find(fact => fact.kind === 'run/submitted' && fact.subject === bound.source.taskId &&
        fact.payload.runId === bound.source.runId)
      assert.equal(sealed.payload.submission.artifactDigest, bound.digest, 'the consumed input differs from the verified producer artifact')
    }
  }
  return manifest.inputSources
}
export function assertPlannedTasks(facts, parentTaskId) {
  const plan = facts.find(fact => fact.kind === 'task/decomposed' && fact.subject === parentTaskId)
  const allowed = [parentTaskId, ...plan.payload.children.map(child => child.taskId)].sort()
  const admitted = facts.filter(fact => fact.kind === 'task/admitted').map(fact => fact.subject).sort()
  assert.deepEqual(admitted, allowed, 'the delegated model admitted a Task outside the declared campaign plan')
}
export async function sealedDigestsOf(attachments, submission) {
  const read = async ref => {
    const chunks = []
    for await (const chunk of attachments.readFileStream(ref)) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    assert.equal(bytes.length, ref.bytes, 'the native attachment length differs from its sealed reference')
    const digest = sha256(bytes)
    assert.equal('sha256:' + digest, ref.attachmentId, 'the native attachment bytes differ from their sealed identity')
    return digest
  }
  const sealed = {
    programDigest: await read(submission.files.program),
    artifactDigest: await read(submission.files.artifact),
    inputDigests: await Promise.all(submission.files.inputs.map(async input => ({ name: input.name, digest: await read(input.attachment) }))),
  }
  assert.equal(sealed.programDigest, submission.programDigest)
  assert.equal(sealed.artifactDigest, submission.artifactDigest)
  assert.deepEqual(sealed.inputDigests, submission.inputDigests)
  return sealed
}
export function schedulerEvidenceOf(events, source) {
  const matches = message => message.source?.kind === 'singularity' && message.source.purpose === source.purpose
  const inserted = events.filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted.filter(matches).map(message => ({ event, message })))
  const entered = events.filter(event => event.type === 'user/message' && matches(event.data))
  assert.equal(inserted.length, 1, 'the Run scheduler instruction was not inserted exactly once')
  assert.equal(entered.length, 1, 'the Run scheduler instruction did not enter exactly one native model turn')
  assert.equal(inserted[0].event.data.target, 'next-turn')
  assert.deepEqual(inserted[0].message.source, source, 'the inbox scheduler source names a different committed fact')
  assert.deepEqual(entered[0].data, inserted[0].message, 'the model-visible scheduler message changed after native insertion')
  assert(inserted[0].event.seq < entered[0].seq, 'the scheduler message entered before its insertion')
  const turn = events.findLast(event => event.type === 'turn/start' && event.seq < entered[0].seq)
  assert(turn !== undefined, 'the scheduler message entered outside a native turn')
  return { source, messageId: entered[0].data.id, insertedSeq: inserted[0].event.seq,
    enteredSeq: entered[0].seq, turn: turn.data.turn }
}
export async function coreRead(facts, domainDir, cutoff = facts.length) {
  assert(Number.isInteger(cutoff) && cutoff >= 0 && cutoff <= facts.length, 'the route serves an uncommitted cutoff')
  const domain = await loadDomain(domainDir, () => { throw new Error('a read invoked a verifier') })
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareAgentProtocol(registry)
  declareEnvironmentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  declareReleaseProtocol(registry)
  const subjects = { [SCHEDULER_ROLE]: 'singularity-local:scheduler',
    [AGENT_ROLE]: 'singularity-local:runtime', [ENVIRONMENT_ROLE]: 'singularity-local:environment' }
  for (const verifier of domain.verifiers)
    subjects[verifierRoleOf({ verifierRef: verifier.ref, verifierVersion: verifier.version })] =
      `singularity-local:verifier:${verifier.ref}@${verifier.version}`
  const log = MemoryLog.adopt(facts.slice(0, cutoff), registry, { subjects })
  const view = {
    entries: () => log.entries(),
    entriesOf: (protocol, version) => log.entriesOf(protocol, version),
    stateOf: (protocol, version, subject) => log.stateAt(protocol, version, subject, cutoff),
    statesOf: (protocol, version) => log.statesAt(protocol, version, cutoff),
  }
  return { domain, registry, log, snapshot: await snapshotOf({ controlId: 'singularity-local', domain, registry, store: { load: () => view } }) }
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
async function provenance(persistence, attachments, taskId, runId, sessionId, domainDir) {
  const facts = await controlFacts(persistence)
  const transcript = await readLog(persistence, sessionId)
  const tool = toolFacts(transcript)
  const core = await coreRead(facts, domainDir)
  const receipt = projectReceipt(core.registry, core.log.entries(), taskId, runId)
  const status = tool.results.findLast(result => result.name === 'singularity_task_status' && result.value.receipt?.taskId === taskId)
  const node = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.sessionId === sessionId).payload
  const assignment = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === taskId).payload
  assert.equal(node.agentId, assignment.agentId)
  if (node.role === 'root') assert(status !== undefined, 'the actual root tool transcript contains no receipt for the Task')
  if (status !== undefined) assert.deepEqual(status.value.receipt, receipt, 'the tool receipt differs from the committed projection')
  assert.equal(receipt.runId, runId)
  assert.equal(receipt.status, 'verified')
  const runs = facts.filter(fact => fact.kind === 'run/started' && fact.subject === taskId)
  assert.equal(runs.length, 1, 'recovery or submit created another solve Run')
  assert.equal(runs[0].payload.runId, runId)
  const submitted = facts.find(fact => fact.kind === 'run/submitted' && fact.subject === taskId)
  const terminal = facts.find(fact => fact.kind === 'run/verified' && fact.subject === taskId)
  const proposed = tool.results.find(result => result.name === 'singularity_propose_task' && result.value.taskId === taskId && result.value.runId === runId)
  if (node.role === 'root') {
    assert(proposed !== undefined, 'the actual proposal result is not linked to this Run')
    assert.equal(runId, runIdOf('singularity-local', sessionId, proposed.callId))
  }
  assert.equal(receipt.executor.actor, assignment.agentIdentity)
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
  if (status !== undefined) assert(status.seq >= source.eventCount, 'the status result precedes the frozen source')
  const prefix = transcript.slice(0, source.eventCount)
  assert.equal(prefix.length, source.eventCount)
  assert.equal(source.digest, digestOf({ sessionId, eventCount: source.eventCount, events: prefix }))
  assert(transcript.length > source.eventCount, 'receipt source was not sealed before later transcript events')
  const contract = facts.find(fact => fact.kind === 'task/admitted' && fact.subject === taskId).payload.contract
  const inputSources = inputSourcesOf(facts, taskId, receipt)
  const sealed = await sealedDigestsOf(attachments, receipt.submission)
  assert.deepEqual(sealed.inputDigests, receipt.consumption.inputs)
  for (const bound of inputSources) {
    if (bound.source.kind === 'protected')
      assert.equal(bound.digest, core.domain.inputs.find(input => input.ref === bound.source.ref).digest)
  }
  for (const criterion of receipt.criteria) {
    const verifier = core.domain.verifiers.find(verifier => verifier.ref === criterion.verifierRef)
    assert.equal(criterion.implementationDigest, sha256(await readFile(verifier.program)))
    assert.equal(criterion.artifactDigest, sealed.artifactDigest)
    assert.equal(criterion.verdict, 'pass')
  }
  const headers = transcript.filter(event => event.type === 'request/header').map(event => event.data.header)
  for (const header of headers) assertToolHeader(header)
  const header = headers.at(-1)
  const bubble = facts.find(fact => fact.kind === 'bubble/opened' && fact.subject === taskId && fact.payload.runId === runId)
  assert.deepEqual(bubble.payload.model, { provider: header.config.provider, model: header.config.model },
    'the Run model differs from the native child route')
  const declaredTools = header.tools.map(tool => tool.name).sort()
  return { receipt, template: contract.template, inputSources, tools: tool.calls.map(call => call.data.name),
    nativeErrors: tool.results.filter(result => result.value.isError === true),
    calls: tool.calls.map(call => ({ callId: call.data.callId, name: call.data.name, turn: call.data.turn, seq: call.seq })),
    provenance: { proposalCallId: proposed?.callId ?? null, submissionCallId: submissionCall.data.callId, statusCallId: status?.callId ?? null,
      startedSeq: runs[0].seq, submittedSeq: submitted.seq, terminalSeq: terminal.seq, sealed },
    declaredTools, model: header.config, controlFactCount: facts.length, currentTranscriptEvents: transcript.length }
}

async function decompositionEvidence(persistence, attachments, page, domainDir) {
  await send(page, DECOMPOSE_PROMPT)
  const deadline = Date.now() + G2_TIMEOUT_MS
  await waitForTools(page, ['singularity_propose_task', 'singularity_decompose_task'], G2_TIMEOUT_MS)
  let facts
  let started
  while (true) {
    facts = await controlFacts(persistence)
    started = facts.find(fact => fact.kind === 'run/started')
    const plan = facts.find(fact => fact.kind === 'task/decomposed')
    if (plan !== undefined) assertPlannedTasks(facts, plan.subject)
    assert(!facts.some(fact => fact.kind === 'run/failed'), 'a Run failed during the automatic campaign')
    if (started !== undefined && facts.some(fact => fact.kind === 'run/verified' && fact.subject === started.subject)) {
      const holder = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === started.subject).payload.agentId
      const sessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === holder).payload.sessionId
      const transcript = await readLog(persistence, sessionId)
      const status = toolFacts(transcript).results.findLast(result => result.name === 'singularity_task_status' &&
        result.value.receipt?.taskId === started.subject)
      if (status !== undefined && transcript.some(event => event.type === 'turn/end' && event.seq > status.seq &&
        event.data.reason.kind === 'completed')) break
    }
    assert(Date.now() < deadline, 'the parent did not automatically continue and verify before the deadline')
    await sleep(100)
  }
  await settle(page, G2_TIMEOUT_MS)
  facts = await controlFacts(persistence)
  const plan = facts.find(fact => fact.kind === 'task/decomposed' && fact.subject === started.subject)
  assert(plan !== undefined, 'the parent recorded no complete decomposition')
  assertPlannedTasks(facts, started.subject)
  assert.equal(plan.payload.children.length, 2)
  const children = plan.payload.children.map(child => ({ ...child,
    contract: facts.find(fact => fact.kind === 'task/admitted' && fact.subject === child.taskId).payload.contract }))
  const extract = children.find(child => child.contract.template.id === 'extract-letters')
  const count = children.find(child => child.contract.template.id === 'count-letters')
  assert(extract !== undefined && count !== undefined, 'the plan omitted an independently judged template')
  assert.deepEqual(extract.dependsOn, [])
  assert.deepEqual(count.dependsOn, [extract.taskId])
  assert.deepEqual(count.contract.inputs[0].source, { kind: 'artifact', taskId: extract.taskId })
  for (const child of children) { assert.equal(child.maxRuns, 1); assert.deepEqual(child.supports, ['letters']) }
  assert(children.every(child => facts.some(fact => fact.kind === 'run/verified' && fact.subject === child.taskId)),
    'the parent completed before both delegated tasks verified')
  const holder = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === started.subject).payload.agentId
  const sessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === holder).payload.sessionId
  const parentTranscript = await readLog(persistence, sessionId)
  const parentTools = toolFacts(parentTranscript)
  const decomposition = parentTools.results.find(result => result.name === 'singularity_decompose_task' && result.value.taskId === started.subject)
  assert(decomposition !== undefined, 'the native root transcript contains no successful decomposition result')
  const delegated = []
  for (const child of children) {
    const owner = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === child.taskId).payload.agentId
    const childSessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === owner).payload.sessionId
    const run = facts.find(fact => fact.kind === 'run/started' && fact.subject === child.taskId)
    assert(run !== undefined, 'a planned task has no actual Run')
    const transcript = await readLog(persistence, childSessionId)
    const dispatch = schedulerEvidenceOf(transcript, { kind: 'singularity', purpose: 'dispatch', controlId: 'singularity-local',
      parentTaskId: started.subject, taskId: child.taskId, runId: run.payload.runId, factSeq: run.seq })
    delegated.push({ taskId: child.taskId, runId: run.payload.runId, sessionId: childSessionId, dispatch,
      ...await provenance(persistence, attachments, child.taskId, run.payload.runId, childSessionId, domainDir) })
  }
  assert.equal(new Set([sessionId, ...delegated.map(child => child.sessionId)]).size, 3,
    'the parent and both child tasks did not run in distinct native sessions')
  const childIds = new Set(children.map(child => child.taskId))
  const terminal = facts.findLast(fact => fact.kind === 'run/verified' && childIds.has(fact.subject))
  const outcome = schedulerEvidenceOf(parentTranscript, { kind: 'singularity', purpose: 'plan-outcome', controlId: 'singularity-local',
    parentTaskId: started.subject, taskId: terminal.subject, runId: terminal.payload.runId, factSeq: terminal.seq })
  const users = parentTranscript.filter(event => event.type === 'user/message')
  assert.equal(users.filter(event => event.data.source.kind === 'user').length, 1, 'the probe supplied a second human parent turn')
  const parent = await provenance(persistence, attachments, started.subject, started.payload.runId, sessionId, domainDir)
  const continuation = parent.calls.find(call => call.callId === parent.provenance.submissionCallId)
  const decompositionCall = parent.calls.find(call => call.callId === decomposition.callId)
  assert.equal(continuation.turn, outcome.turn, 'the parent submission did not belong to the host outcome turn')
  assert(continuation.seq > outcome.enteredSeq && outcome.turn > decompositionCall.turn,
    'the parent did not wait for the host outcome before its own submission')
  const lastChildCutoff = Math.max(...delegated.map(child => child.receipt.cutoff))
  assert(parent.provenance.submittedSeq >= lastChildCutoff, 'the parent receipt preceded delegated acceptance')
  assert(parent.receipt.criteria.every(criterion => criterion.verifierRef === 'letters'), 'child criteria replaced the parent independent verifier')
  assert.notEqual(parent.receipt.source.digest, delegated[1].receipt.source.digest)
  return { taskId: started.subject, runId: started.payload.runId, sessionId,
    plan: { callId: decomposition.callId, seq: plan.seq, children: plan.payload.children }, outcome, delegated, ...parent }
}

const panelState = page => page.evaluate(() => {
  const panel = document.querySelector('[data-panel="singularity-tasks"]')
  const text = marker => panel.querySelector(marker)?.textContent.trim() ?? null
  return { reads: Number(panel.getAttribute('data-reads')), controlId: text('[data-control]'), cutoff: text('[data-cutoff]'),
    error: text('[data-error]'), refresh: panel.querySelector('[data-refresh]') !== null,
    tasks: [...panel.querySelectorAll('[data-task]')].map(task => ({ taskId: task.getAttribute('data-task'), phase: task.getAttribute('data-phase'),
      sessionId: task.querySelector('[data-session]').textContent, template: task.querySelector('[data-template]').textContent,
      runs: [...task.querySelectorAll('[data-run]')].map(run => ({ runId: run.getAttribute('data-run'), status: run.getAttribute('data-status'),
        receipt: run.querySelector('[data-receipt] pre') === null ? null : JSON.parse(run.querySelector('[data-receipt] pre').textContent) })) })),
    plans: [...panel.querySelectorAll('[data-plan]')].map(plan => ({ parentTaskId: plan.getAttribute('data-plan'), complete: plan.getAttribute('data-complete'),
      children: [...plan.querySelectorAll('[data-child]')].map(child => ({ taskId: child.getAttribute('data-child'), status: child.getAttribute('data-status') })),
      criteria: [...plan.querySelectorAll('[data-criterion]')].map(criterion => ({ criterionId: criterion.getAttribute('data-criterion'),
        satisfiedBy: criterion.getAttribute('data-satisfied-by') })) })) }
})
async function landedPanel(page, reads = 0) {
  await page.waitForFunction(previous => Number(document.querySelector('[data-panel="singularity-tasks"]')?.getAttribute('data-reads')) > previous,
    reads, { timeout: 30_000 })
  return await panelState(page)
}
function assertPanel(state, snapshot) {
  assert.equal(state.error, null)
  assert.equal(state.refresh, true)
  assert.equal(state.controlId, snapshot.controlId)
  assert.equal(state.cutoff, String(snapshot.cutoff))
  assert.deepEqual(state.tasks, snapshot.tasks.map(task => ({ taskId: task.taskId, phase: task.phase,
    sessionId: task.sessionId ?? 'unassigned', template: task.template.id,
    runs: task.runs.map(run => ({ runId: run.runId, status: run.status, receipt: run.receipt })) })))
  assert.deepEqual(state.plans, snapshot.plans.map(plan => ({ parentTaskId: plan.parentTaskId, complete: String(plan.complete),
    children: plan.children.map(child => ({ taskId: child.taskId, status: child.status })),
    criteria: plan.criteria.map(criterion => ({ criterionId: criterion.criterionId, satisfiedBy: criterion.satisfiedBy ?? '' })) })))
}
async function panelEvidence(persistence, page, origin, domainDir) {
  const bare = await fetch(origin + '/singularity/tasks', { redirect: 'manual' })
  assert([401, 403].includes(bare.status), 'the task read route served a request without the browser cookie')
  const served = await page.evaluate(async () => {
    const read = await fetch('/singularity/tasks', { headers: { accept: 'application/json' } })
    const posted = await fetch('/singularity/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return { status: read.status, type: read.headers.get('content-type'), body: await read.json(),
      postStatus: posted.status, allow: posted.headers.get('allow') }
  })
  assert.equal(served.status, 200)
  assert.equal(served.type.split(';', 1)[0], 'application/json')
  assert.equal(served.postStatus, 405)
  assert.equal(served.allow, 'GET')
  const facts = await controlFacts(persistence)
  const core = await coreRead(facts, domainDir, served.body.cutoff)
  assert.deepEqual(served.body, core.snapshot, 'the route and core disagree at the same committed cut')
  assert.equal(facts.length, served.body.cutoff)
  const response = await page.goto(origin + '/singularity/panel/', { waitUntil: 'domcontentloaded' })
  assert(response.ok(), 'the panel page did not load')
  const opened = await landedPanel(page)
  assertPanel(opened, served.body)
  assert.equal((await controlFacts(persistence)).length, facts.length, 'opening the panel wrote control facts')
  await page.locator('[data-refresh]').click()
  const refreshed = await landedPanel(page, opened.reads)
  assertPanel(refreshed, served.body)
  assert.equal((await controlFacts(persistence)).length, facts.length, 'refreshing the panel wrote control facts')
  await page.reload({ waitUntil: 'domcontentloaded' })
  const reloaded = await landedPanel(page)
  assertPanel(reloaded, served.body)
  assert.equal((await controlFacts(persistence)).length, facts.length, 'reloading the panel executed or wrote work')
  return { unauthenticatedStatus: bare.status, routeStatus: served.status, postStatus: served.postStatus, allow: served.allow,
    cutoff: served.body.cutoff, snapshotDigest: digestOf(served.body), opened, refreshed, reloaded }
}

async function runProbe(home, context, screenshot, stage, extra) {
  const port = await freePort()
  let server = await boot(port, extra, home)
  const medium = await openPersistence(join(home, 'sessions'), 'zstd')
  let before
  let page
  try {
    const { LocalAttachmentStore } = await dshModule('@deepseek-ai/dsh-attachment-local')
    await medium.context.plugin(LocalAttachmentStore, { dshHome: home })
    const attachments = medium.context.get('attachments')
    page = await openApp(context, server.url)
    const dismissedFirstRun = await prepare(page, home)
    if (stage === 'decompose' || stage === 'panel') {
      const domainDir = join(ROOT, 'deployment/domain/letters')
      const result = await decompositionEvidence(medium.persistence, attachments, page, domainDir)
      const panel = stage === 'panel' ? await panelEvidence(medium.persistence, page, new URL(server.url).origin, domainDir) : null
      await mkdir(dirname(screenshot), { recursive: true })
      await page.screenshot({ path: screenshot, fullPage: true })
      const evidence = { leg: stage, host: server.command, hostPid: server.child.pid, origin: new URL(server.url).origin,
        chromium: context.browser().version(), preset: PRESET_NAME, dismissedFirstRun, screenshot, ...result, panel }
      process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
      process.stdout.write(stage === 'panel' ? 'panel-probe: OK\n' : 'subtask-probe: OK\n')
      return evidence
    }
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
      const declaredTools = assertToolHeader(header)
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
    const result = await provenance(medium.persistence, attachments, taskId, runId, sessionId, domainDir)
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
    if (page !== undefined && !page.isClosed()) {
      await mkdir(dirname(screenshot), { recursive: true })
      await page.screenshot({ path: screenshot, fullPage: true })
    }
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
        schedulerMessages: events.filter(event => event.type === 'agent/inbox/spliced' || event.type === 'user/message')
          .map(event => ({ seq: event.seq, type: event.type, data: event.data })),
        calls: tool.calls.map(event => ({ seq: event.seq, turn: event.data.turn, name: event.data.name, callId: event.data.callId })),
        results: tool.results })
    }
    process.stdout.write(JSON.stringify({ leg: stage ?? 'live', failure: diagnosticOf(error), screenshot, crash: before ?? null, sessions: failures,
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
  const modes = new Map([['--recovery', 'working'], ['--submitted', 'submitted'], ['--aborted', 'aborted'], ['--decompose', 'decompose'], ['--panel', 'panel']])
  const selected = [...modes].filter(([flag]) => process.argv.includes(flag))
  assert(selected.length <= 1, 'select one browser evidence mode')
  const stage = selected[0]?.[1]
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

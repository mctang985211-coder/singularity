#!/usr/bin/env node
/**
 * A5 — the control store across two processes, observed rather than assumed.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DSH_INSTALLED, dshModule, openPersistence } from './dsh-control-runtime.mjs'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, declareTaskProtocol } from '../src/task/protocol.ts'

const HERE = fileURLToPath(import.meta.url)
const CONTROL_ID = 'probe-graph'
const TASK = 'probe-task'
const RUN = 'probe-run-1'
const REVISION = { environmentId: 'probe-library', revisionId: 'r0001', digest: 'a'.repeat(64) }
const CONTRACT = {
  artifact: 'report.txt',
  goal: 'carry a control fact through a DSH session',
  template: {
    id: 'control-probe',
    digest: createHash('sha256')
      .update(await readFile(HERE))
      .digest('hex'),
  },
  inputs: [],
  criteria: [
    {
      criterionId: 'observed',
      statement: 'the probe observed the fact',
    },
  ],
}
const SUBJECTS = { scheduler: 'scheduler-1' }
/**
 * How many facts the holder commits before it is killed: the contract, the responsibility, and the
 */
const EXPECTED_FACTS = 3

function registry() {
  const made = new ProtocolRegistry()
  declareTaskProtocol(made)
  return made
}

const admitRequest = commandId => ({
  commandId,
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind: TASK_KINDS.admitted,
  subject: TASK,
  payload: { contract: CONTRACT },
})
const assignRequest = commandId => ({
  commandId,
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind: TASK_KINDS.assigned,
  subject: TASK,
  payload: { agentId: 'probe-agent', agentIdentity: 'scheduler-1' },
})
const startRequest = commandId => ({
  commandId,
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind: TASK_KINDS.runStarted,
  subject: TASK,
  payload: { runId: RUN, revision: REVISION, purpose: 'solve' },
})

const failures = []
const gaps = []
const line = value => console.log(JSON.stringify(value))
const section = title => console.log(`\n== ${title}`)
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const gap = (label, detail) => {
  console.log(`  GAP   ${label} — ${detail}`)
  gaps.push(label)
}

// ---------------------------------------------------------------------------
// The holder: commit, then hold the write handle until it is SIGKILLed.
// ---------------------------------------------------------------------------

async function hold() {
  try {
    const [root, controlId, commandId] = process.argv.slice(3)
    const { ControlSessionStore } = await import('../src/control/session-store.ts')
    const live = await openPersistence(root)
    const store = await ControlSessionStore.open({
      persistence: live.persistence,
      controlId,
      registry: registry(),
      subjects: SUBJECTS,
    })

    const admitted = await store.emit(admitRequest(`${commandId}-admit`))
    // A run needs someone answerable for it before it may start, so the probe records the
    // responsibility it is about to exercise. The successor adopts it rather than re-declaring it.
    await store.emit(assignRequest(`${commandId}-assign`))
    const committed = await store.emit(startRequest(commandId))
    // The caller of `commandId` never received this reply. Re-delivering it while this store is
    // alive is what the memory log's command identity answers, and nothing is appended twice.
    const recovered = await store.emit(startRequest(commandId))

    line({
      event: 'holding',
      pid: process.pid,
      sessionId: String(store.sessionId),
      admittedSeq: admitted.seq,
      commandId,
      committedSeq: committed.seq,
      committedDigest: committed.digest,
      recoveredSeq: recovered.seq,
      recoveredDigest: recovered.digest,
      redeliveredSameFact: recovered.seq === committed.seq && recovered.digest === committed.digest,
      facts: store
        .load()
        .entries()
        .map(entry => ({ seq: entry.seq, kind: entry.kind, digest: entry.digest })),
    })
    setInterval(() => {}, 1000)
  } catch (error) {
    console.error(`holder failed: ${error?.stack ?? String(error)}`)
    process.exit(1)
  }
}

/** Resolve with the first stdout line that parses as JSON and names the event. */
function waitForEvent(child, wanted, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for the holder's "${wanted}" report`)),
      timeoutMs,
    )
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const text = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (text === '') continue
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          console.log(`  holder stdout (not JSON): ${text}`)
          continue
        }
        if (parsed?.event === wanted) {
          clearTimeout(timer)
          resolve(parsed)
        }
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`holder exited before reporting: code=${code} signal=${signal}`))
    })
  })
}

// ---------------------------------------------------------------------------
// The parent: probe the held session, kill the holder, take over, re-deliver.
// ---------------------------------------------------------------------------

async function probe() {
  console.log(`node                ${process.version}`)
  console.log(`dsh installed build ${DSH_INSTALLED}`)
  const { ControlSessionStore, CONTROL_EVENT_TYPE, controlSessionIdOf } =
    await import('../src/control/session-store.ts')

  const root = await mkdtemp(join(tmpdir(), 'singularity-control-probe-'))
  console.log(`session root        ${root}`)
  const live = await openPersistence(root)
  const sessionId = controlSessionIdOf(CONTROL_ID)
  const commandId = 'probe-command-1'
  let holder = null
  let successor = null
  let holderStderr = ''

  try {
    // -----------------------------------------------------------------------
    section('1. a second process opening the same control session for write')
    holder = spawn(process.execPath, [HERE, '--hold', root, CONTROL_ID, commandId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    holder.stderr.on('data', chunk => {
      holderStderr += String(chunk)
    })
    const reported = await waitForEvent(holder, 'holding', 20000)
    console.log(`  holder pid ${holder.pid} reported: ${JSON.stringify(reported)}`)
    check(
      'the holder committed the command and holds the write handle',
      reported.facts.length === EXPECTED_FACTS && typeof reported.committedDigest === 'string',
      `facts=${reported.facts.length}`,
    )

    // A genuine second process, because that is what the claim is about. Opening again inside this
    // process would test the in-process ownership table, which is a different guarantee and, as
    // this check's own history showed, one that can answer differently.
    const rival = spawn(process.execPath, [HERE, '--claim', root, CONTROL_ID], { stdio: ['ignore', 'pipe', 'pipe'] })
    let rivalStderr = ''
    rival.stderr.on('data', chunk => {
      rivalStderr += String(chunk)
    })
    const claimed = await waitForEvent(rival, 'claimed', 20000).catch(error => ({
      event: 'claimed',
      granted: null,
      name: 'no-report',
      message: `${error.message} stderr=${rivalStderr.slice(-300)}`,
    }))
    await new Promise(resolve => rival.on('exit', resolve))
    console.log(`  second process reported: ${JSON.stringify(claimed)}`)
    check(
      'a second process write open is refused',
      claimed.granted === false,
      `granted=${JSON.stringify(claimed.granted)} name=${JSON.stringify(claimed.name)}`,
    )
    check(
      'a second process write open fails with SessionAlreadyOwnedError',
      claimed.name === 'SessionAlreadyOwnedError',
      `name=${JSON.stringify(claimed.name)} message=${JSON.stringify(claimed.message)}`,
    )

    // -----------------------------------------------------------------------
    section('2. a read handle while the write handle is held')
    const reader = await live.persistence.open(sessionId, 'read')
    const observedRead = (await reader.read()).events.map(event => ({
      seq: event.seq,
      type: event.type,
      ignorable: event.ignorable,
      kind: event.data?.kind,
      digest: String(event.data?.payload?.digest ?? '').slice(0, 12),
    }))
    await reader.close()
    console.log(`  read handle observed: ${JSON.stringify(observedRead)}`)
    check(
      'the read handle is unaffected and every record is our type, marked ignorable',
      observedRead.length === EXPECTED_FACTS &&
        observedRead.every(event => event.type === CONTROL_EVENT_TYPE && event.ignorable === true),
    )

    // -----------------------------------------------------------------------
    section('4a. a lost reply inside the live store (the holder re-delivered the same command id)')
    console.log(
      `  committed #${reported.committedSeq} ${reported.committedDigest.slice(0, 12)}… → re-delivered #${reported.recoveredSeq} ${reported.recoveredDigest.slice(0, 12)}…`,
    )
    check(
      're-delivering the same command id returned the fact it committed, and appended nothing',
      reported.redeliveredSameFact === true &&
        reported.facts.filter(fact => fact.kind === TASK_KINDS.runStarted).length === 1,
    )

    // -----------------------------------------------------------------------
    section('3. SIGKILL the holder, then take over immediately')
    const exited = new Promise(resolve => holder.once('exit', (code, signal) => resolve({ code, signal })))
    holder.kill('SIGKILL')
    console.log(`  holder killed: ${JSON.stringify(await exited)}`)
    holder = null

    const startedAt = Date.now()
    successor = await ControlSessionStore.open({
      persistence: live.persistence,
      controlId: CONTROL_ID,
      registry: registry(),
      subjects: SUBJECTS,
    })
    const takeoverMs = Date.now() - startedAt
    const facts = successor
      .load()
      .entries()
      .map(entry => ({ seq: entry.seq, kind: entry.kind, digest: entry.digest }))
    console.log(`  successor took over in ${takeoverMs}ms with: ${JSON.stringify(facts)}`)
    check('the successor takes over immediately, with no waiting period', takeoverMs < 5000, `${takeoverMs}ms`)
    check(
      'the facts appended before the kill are still readable, unchanged',
      facts.length === reported.facts.length &&
        facts.every((fact, index) => fact.digest === reported.facts[index]?.digest),
    )
    const folded = successor.load().stateOf(TASK_PROTOCOL, TASK_VERSION, TASK)
    console.log(
      `  folded state: goal=${JSON.stringify(folded?.contract?.goal)} runs=${JSON.stringify(Object.keys(folded?.runs ?? {}))}`,
    )
    check(
      'the adopted facts still fold to the same state',
      folded?.contract?.goal === CONTRACT.goal && folded?.runs?.[RUN] !== undefined,
    )

    // -----------------------------------------------------------------------
    section('4b. the same command id re-delivered by the successor, after the holder is gone')
    let crossProcess
    try {
      crossProcess = { accepted: true, envelope: await successor.emit(startRequest(commandId)) }
    } catch (error) {
      crossProcess = {
        accepted: false,
        code: error?.refusal?.code ?? error?.name,
        detail: error?.refusal?.detail ?? error?.message,
      }
    }
    const after = [...successor.load().entries()]
    console.log(`  successor re-delivered ${JSON.stringify(commandId)}: ${JSON.stringify(crossProcess)}`)
    console.log(
      `  the adopted log still holds ${after.length} facts; the original result is #${reported.committedSeq} ${reported.committedDigest.slice(0, 12)}…`,
    )
    if (crossProcess.accepted && crossProcess.envelope.digest === reported.committedDigest) {
      check(
        'the successor returned the fact the dead process committed, and appended nothing',
        after.length === reported.facts.length,
      )
    } else {
      gap(
        'cross-process command recovery is not implemented',
        `the successor cannot return the recorded fact for ${JSON.stringify(commandId)}: MemoryLog.adopt rebuilds no command identity and the envelope carries no command id, so the re-delivery was ${
          crossProcess.accepted
            ? `committed as a second fact #${crossProcess.envelope.seq}`
            : `refused as ${crossProcess.code}`
        }; the original result is identifiable only by reading the adopted log`,
      )
    }

    // -----------------------------------------------------------------------
    section('5. the successor can append new facts, so the takeover is functional')
    await successor.emit({
      commandId: 'finish-probe-run-1',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.runFailed,
      subject: TASK,
      payload: { runId: RUN, cause: 'runtime', reason: 'the first attempt was interrupted' },
    })
    const next = await successor.emit({
      commandId: 'probe-command-2',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.runStarted,
      subject: TASK,
      payload: { runId: 'probe-run-2', revision: REVISION, purpose: 'solve' },
    })
    const verifier = await live.persistence.open(sessionId, 'read')
    const finalRead = (await verifier.read()).events.length
    await verifier.close()
    console.log(
      `  successor appended ${TASK_KINDS.runStarted} #${next.seq}; the stored log now holds ${finalRead} events`,
    )
    check(
      'the successor settled the interrupted Run and appended a new attempt that a fresh read handle sees',
      finalRead === after.length + 2,
    )
  } catch (error) {
    failures.push('the probe did not run to completion')
    console.log(`\nFAIL  the probe did not run to completion: ${error?.stack ?? String(error)}`)
    if (holderStderr !== '') console.log(`holder stderr:\n${holderStderr}`)
  } finally {
    if (holder !== null) holder.kill('SIGKILL')
    if (successor !== null) await successor.close().catch(() => undefined)
    await live.context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    console.log(`\ncleaned up: ${root}`)
  }

  console.log(`\nfailures: ${failures.length}${failures.length === 0 ? '' : ` (${failures.join(' | ')})`}`)
  console.log(`gaps: ${gaps.length}${gaps.length === 0 ? '' : ` (${gaps.join(' | ')})`}`)
  process.exitCode = failures.length === 0 && gaps.length === 0 ? 0 : 1
}

/**
 * The rival writer: one attempt to open the same control session for write, reported as data.
 */
async function claim(root, controlId) {
  const { ControlSessionStore } = await import('../src/control/session-store.ts')
  const live = await openPersistence(root)
  try {
    const store = await ControlSessionStore.open({
      persistence: live.persistence,
      controlId,
      registry: registry(),
      subjects: SUBJECTS,
    })
    line({ event: 'claimed', granted: true, sessionId: String(store.sessionId) })
    await store.close()
  } catch (error) {
    line({
      event: 'claimed',
      granted: false,
      name: error?.name,
      constructor: error?.constructor?.name,
      message: error?.message,
    })
  } finally {
    await live.context.fiber.dispose()
  }
}

if (process.argv[2] === '--claim') await claim(process.argv[3], process.argv[4])
else if (process.argv[2] === '--hold') await hold()
else await probe()

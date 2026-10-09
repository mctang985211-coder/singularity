#!/usr/bin/env node
/**
 * B/S5 — a real DSH agent session across a real SIGKILL, observed rather than assumed.
 *
 * Five things are checked; any check failing makes the exit code non-zero:
 *
 *   1. a real agent session is created and one turn completes against a **stub `LlmAdapter`**
 *      (deterministic, no network, no credential);
 *   2. a second process asking for the same session's write lease **while the holder is alive** is
 *      refused by name — the refusal the resumed process must not get;
 *   3. the holder is `SIGKILL`ed at the execution boundary (its turn settled and its log flushed,
 *      its teardown never ran); a **new process** then resumes the same session id and finds the
 *      same history prefix, contiguous from seq 0;
 *   4. the write lease was released by the kernel with the killed process, so the resume is
 *      **granted** rather than blocked (the elapsed time is reported), and the resumed session is
 *      still a usable conversation;
 *   5. closing releases the lease while its process is still alive, so a successor can take it —
 *      observed as a direct write open refused before the close and granted after it.
 *
 * The same file is every child (`--hold`, `--lease`, `--resume`), so all of them run byte-identical
 * wiring: same installed DSH build, same plugins, same stub adapter. Resolution goes through
 * `dsh-control-runtime.mjs`'s `module.register` hook, and the module under test is imported
 * dynamically because it imports a DSH package and the hook only applies after `register` ran.
 *
 * Run: node scripts/agent-lifecycle-probe.mjs
 *
 * @module singularity-core/scripts/agent-lifecycle-probe
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DSH_INSTALLED, dshModule } from './dsh-control-runtime.mjs'

const HERE = fileURLToPath(import.meta.url)
const AGENT_ID = 'probe-agent-lifecycle'
const REPLY = 'hello from the stub model'

const failures = []
const gaps = []
const line = value => console.log(JSON.stringify(value))
const section = title => console.log(`\n== ${title}`)
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** The module under test. Dynamic: it imports a DSH package, so the resolve hook must already be live. */
const agentSession = () => import('../src/runtime/agent-session.ts')

const typesOf = events => events.map(event => `${event.seq}:${event.type}`)
const contiguousFromZero = events => events.length > 0 && events.every((event, index) => event.seq === index)

/** The raw JSONL artifacts under a session root, with line counts: the medium's own bytes. */
async function artifacts(root) {
  const names = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl')).sort()
  const described = []
  for (const name of names) described.push(`${name} (${(await readFile(join(root, name), 'utf8')).trimEnd().split('\n').length} lines)`)
  return described
}

// ---------------------------------------------------------------------------
// The runtime a real turn needs: the installed DSH plugins, and nothing of ours but the adapter.
// ---------------------------------------------------------------------------

/** An `LlmAdapter` subclass whose `stream()` answers every call with one canned text block. */
function stubAdapter(LlmAdapter, reply) {
  return class StubAdapter extends LlmAdapter {
    constructor() {
      super()
      this.calls = []
    }

    async *stream(options) {
      this.calls.push({ provider: options.provider, model: options.model })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Mount the smallest composition that can drive a real conversation, plus the stub adapter. */
async function mountRuntime(root) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore } = await dshModule('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await dshModule('@deepseek-ai/dsh-agent')
  const { default: LlmRuntime, LlmAdapter } = await dshModule('@deepseek-ai/dsh-llm')
  const { default: ToolRuntime } = await dshModule('@deepseek-ai/dsh-tools')
  const { default: SystemPrompt } = await dshModule('@deepseek-ai/dsh-system-prompt')
  const { default: SessionProjectionRegistry } = await dshModule('@deepseek-ai/dsh-session-projection')
  const { default: AgentLoop } = await dshModule('@deepseek-ai/dsh-agent-loop')

  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })

  const adapter = new (stubAdapter(LlmAdapter, REPLY))()
  ctx.llm.registerAdapter(['stub'], adapter)
  return { ctx, adapter }
}

/** The medium's own view of one session: what a fresh reader sees, not what the live object holds. */
async function readStored(ctx, sessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  const events = (await handle.read()).events.map(event => ({ seq: event.seq, type: event.type }))
  await handle.close()
  return events
}

/** One user message, with the producer source a live prompt needs. */
async function userMessage(text) {
  const { createUserMessage } = await dshModule('@deepseek-ai/dsh-llm')
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The conversation the live session derives, one `role:text` string per message. */
const conversationOf = agent => agent.session.deriveMessages().map(message => `${message.role}:${message.content.map(block => block.text ?? `<${block.type}>`).join('')}`)

/** One direct write open, reported rather than thrown, so a refusal is data the caller can check. */
async function tryWrite(ctx, sessionId) {
  try {
    const handle = await ctx.sessionPersistence.open(sessionId, 'write')
    await handle.close()
    return { granted: true, name: null }
  } catch (error) {
    return { granted: false, name: error?.name ?? error?.constructor?.name ?? String(error) }
  }
}

// ---------------------------------------------------------------------------
// The children.
// ---------------------------------------------------------------------------

/**
 * The holder: create the session, drive one turn, make the bytes durable, report, then hold the
 * write lease forever. No teardown path is reached — the parent SIGKILLs this process at the
 * execution boundary.
 */
async function hold(root, cwd) {
  const { openAgentSession } = await agentSession()
  const { ctx, adapter } = await mountRuntime(root)
  const opened = await openAgentSession(ctx, { agentId: AGENT_ID, resume: false, cwd, agentOptions: { provider: 'stub', model: 'stub-1' } })

  const agent = ctx.agents.get(opened.sessionId)
  agent.followup(await userMessage('say hello'))
  await agent.whenIdle()
  await ctx.sessionPersistence.flush()

  const stored = await readStored(ctx, opened.sessionId)
  line({
    event: 'holding',
    pid: process.pid,
    sessionId: opened.sessionId,
    resumed: opened.resumed,
    count: stored.length,
    events: stored,
    messages: conversationOf(agent),
    adapterCalls: adapter.calls,
  })
  setInterval(() => {}, 1000)
}

/** A process asking for the same session's write lease, and reporting whether it was granted. */
async function lease(root) {
  const { openAgentSession, closeAgentSession } = await agentSession()
  const { ctx } = await mountRuntime(root)
  try {
    const opened = await openAgentSession(ctx, { agentId: AGENT_ID, resume: true })
    const stored = await readStored(ctx, opened.sessionId)
    line({ event: 'lease', pid: process.pid, granted: true, resumed: opened.resumed, count: stored.length, last: stored.at(-1)?.type ?? null })
    await closeAgentSession(AGENT_ID)
  } catch (error) {
    line({
      event: 'lease',
      pid: process.pid,
      granted: false,
      code: error?.refusal?.code ?? null,
      name: error?.name ?? null,
      detail: error?.refusal?.detail ?? error?.message ?? String(error),
    })
  }
  await ctx.fiber.dispose()
}

/**
 * The new process after the kill: resume the same session id, report the prefix it found and the
 * time the lease took to be granted, drive a second turn on the resumed agent, then observe ordered
 * cleanup — a successor write refused while this process holds the lease, and granted after
 * `closeAgentSession` releases it, with this process still alive.
 */
async function resume(root) {
  const { openAgentSession, closeAgentSession } = await agentSession()
  const { ctx, adapter } = await mountRuntime(root)

  const startedAt = Date.now()
  const opened = await openAgentSession(ctx, { agentId: AGENT_ID, resume: true, agentOptions: { provider: 'stub', model: 'stub-1' } })
  const grantedMs = Date.now() - startedAt
  const stored = await readStored(ctx, opened.sessionId)
  line({
    event: 'resumed',
    pid: process.pid,
    resumed: opened.resumed,
    grantedMs,
    count: stored.length,
    events: stored,
    contiguous: contiguousFromZero(stored),
    last: stored.at(-1)?.type ?? null,
  })

  const agent = ctx.agents.get(opened.sessionId)
  agent.followup(await userMessage('say hello again after the kill'))
  await agent.whenIdle()
  await ctx.sessionPersistence.flush()
  line({ event: 'continued', pid: process.pid, messages: conversationOf(agent), adapterCalls: adapter.calls, count: agent.session.snapshotEvents().length })

  const before = await tryWrite(ctx, opened.sessionId)
  line({ event: 'successor-before-close', pid: process.pid, granted: before.granted, name: before.name })

  await closeAgentSession(AGENT_ID)
  line({ event: 'closed', pid: process.pid })

  const after = await tryWrite(ctx, opened.sessionId)
  line({ event: 'successor-after-close', pid: process.pid, granted: after.granted, name: after.name })

  await ctx.fiber.dispose()
}

// ---------------------------------------------------------------------------
// The parent.
// ---------------------------------------------------------------------------

/** Resolve with the first stdout line that parses as JSON and names the event. */
function waitForEvent(child, wanted, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for the holder's "${wanted}" report`)), timeoutMs)
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

/** Run one child to completion and return every JSON line it printed, keyed by its `event` name. */
function runChild(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HERE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const printed = []
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      let index = stdout.indexOf('\n')
      while (index >= 0) {
        const text = stdout.slice(0, index).trim()
        stdout = stdout.slice(index + 1)
        index = stdout.indexOf('\n')
        if (text === '') continue
        try {
          printed.push(JSON.parse(text))
        } catch {
          printed.push({ event: 'unparsed', text })
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      const events = new Map(printed.filter(entry => typeof entry.event === 'string').map(entry => [entry.event, entry]))
      resolve({ pid: child.pid, code, signal, events, printed, stderr })
    })
  })
}

/** Why a child produced no usable report, as one line for a `check` detail. */
function childFailure(run) {
  const tail = run.stderr
    .split('\n')
    .map(text => text.trim())
    .filter(text => text !== '' && !text.includes('UNDICI-EHPA') && !text.includes('trace-warnings'))
    .slice(-2)
    .join(' | ')
  return `exit=${run.code} signal=${run.signal}${tail === '' ? '' : ` stderr=${tail}`}`
}

async function probe() {
  console.log(`node                ${process.version}`)
  console.log(`dsh installed build ${DSH_INSTALLED}`)
  const root = await mkdtemp(join(tmpdir(), 'singularity-agent-lifecycle-'))
  const cwd = await mkdtemp(join(tmpdir(), 'singularity-agent-workspace-'))
  console.log(`session root        ${root}`)
  console.log(`agent cwd           ${cwd}`)
  let holder = null
  let holderStderr = ''

  try {
    section('1. a real agent session is created, and one turn completes against a stub LlmAdapter')
    holder = spawn(process.execPath, [HERE, '--hold', root, cwd], { stdio: ['ignore', 'pipe', 'pipe'] })
    holder.stderr.on('data', chunk => {
      holderStderr += String(chunk)
    })
    const held = await waitForEvent(holder, 'holding', 180000)
    console.log(`  holder pid ${holder.pid}: session=${held.sessionId} resumed=${held.resumed} events=${held.count} [${typesOf(held.events).join(', ')}]`)
    console.log(`  conversation = ${JSON.stringify(held.messages)}`)
    console.log(`  stub adapter calls = ${JSON.stringify(held.adapterCalls)}`)
    check(
      'the holder created the session (resumed=false) for the id derived from the agent id',
      held.resumed === false && held.sessionId === `singularity:agent:${AGENT_ID}`,
      `session=${held.sessionId}`,
    )
    check(
      'a turn completed against the stub adapter: one stub call, one assistant reply, no network',
      held.adapterCalls.length >= 1 && held.adapterCalls.every(call => call.provider === 'stub') && held.messages.at(-1) === `assistant:${REPLY}`,
      JSON.stringify(held.adapterCalls),
    )
    check('the stored prefix is contiguous from seq 0', contiguousFromZero(held.events), `${held.count} events`)
    console.log(`  raw artifacts: ${(await artifacts(root)).join(', ')}`)

    section('2. a second process asking for the same write lease while the holder is alive')
    const blockedRun = await runChild(['--lease', root])
    const blocked = blockedRun.events.get('lease')
    console.log(`  new process ${blockedRun.pid} reported: ${JSON.stringify(blocked ?? null)}`)
    check(
      'the resume is refused by name while the holder is alive — not blocked, not queued',
      blocked?.granted === false && blocked?.code === 'concurrent-writer',
      blocked?.detail ?? childFailure(blockedRun),
    )

    section('3. SIGKILL the holder at the execution boundary, then resume in a new process')
    const exited = new Promise(resolve => holder.once('exit', (code, signal) => resolve({ code, signal })))
    holder.kill('SIGKILL')
    console.log(`  holder killed: ${JSON.stringify(await exited)} (turn settled and flushed; teardown never ran)`)
    holder = null
    const resumedRun = await runChild(['--resume', root])
    const resumed = resumedRun.events.get('resumed')
    console.log(
      `  new process ${resumedRun.pid}: ${JSON.stringify({
        resumed: resumed?.resumed ?? null,
        grantedMs: resumed?.grantedMs ?? null,
        count: resumed?.count ?? null,
        contiguous: resumed?.contiguous ?? null,
        last: resumed?.last ?? null,
      })}`,
    )
    check(
      'the write lease was released by the kernel with the killed holder, so resume was granted rather than blocked',
      resumed?.resumed === true && resumed?.grantedMs < 5000,
      `${resumed?.grantedMs ?? 'no'}ms for openAgentSession(resume) — existence check, lease, repair closer and publication`,
    )
    check(
      'resume found the same history prefix the killed holder had written',
      resumed !== undefined && JSON.stringify(resumed.events.slice(0, held.count)) === JSON.stringify(held.events),
      `${held.count} -> ${resumed?.count ?? 'no'} events`,
    )
    check(
      'the resumed history is contiguous from seq 0 and lost nothing',
      resumed?.contiguous === true && resumed.count >= held.count,
      `${held.count} -> ${resumed?.count ?? 'no'} events: [${typesOf(resumed?.events ?? []).join(', ')}]`,
    )
    check(
      'resume appended exactly one repair closer (session/end-seed), which is why it needs the write lease',
      resumed?.count === held.count + 1 && resumed.last === 'session/end-seed',
      `last=${resumed?.last ?? 'no'}`,
    )
    const continued = resumedRun.events.get('continued')
    console.log(`  resumed conversation = ${JSON.stringify(continued?.messages ?? null)}`)
    check(
      'the resumed session is a usable conversation: the second turn completed against the stub adapter',
      continued !== undefined && continued.messages.at(-1) === `assistant:${REPLY}` && continued.adapterCalls.length >= 1,
      childFailure(resumedRun),
    )

    section('4. ordered cleanup: closing releases the lease so a successor can take it')
    const before = resumedRun.events.get('successor-before-close')
    const after = resumedRun.events.get('successor-after-close')
    console.log(`  direct write open while the resumer held the lease: ${JSON.stringify(before ?? null)}`)
    console.log(`  direct write open after closeAgentSession, same live process: ${JSON.stringify(after ?? null)}`)
    check('a successor write open is refused while the resumer still holds the lease', before?.granted === false, before?.name ?? childFailure(resumedRun))
    check(
      'closing released the lease, and the successor took it in the same live process',
      after?.granted === true,
      after === undefined ? childFailure(resumedRun) : String(after.name),
    )

    section('5. the session outlived the whole lifecycle')
    const finalRun = await runChild(['--lease', root])
    const final = finalRun.events.get('lease')
    console.log(`  final process ${finalRun.pid} reported: ${JSON.stringify(final ?? null)}`)
    check(
      'the same session is still persisted and still resumable after create -> SIGKILL -> resume -> close',
      final?.granted === true && final?.resumed === true,
      final?.detail ?? childFailure(finalRun),
    )
    console.log(`  raw artifacts: ${(await artifacts(root)).join(', ')}`)
  } catch (error) {
    failures.push('the probe did not run to completion')
    console.log(`\nFAIL  the probe did not run to completion: ${error?.stack ?? String(error)}`)
    if (holderStderr !== '') console.log(`holder stderr:\n${holderStderr}`)
  } finally {
    if (holder !== null) holder.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
    console.log(`\ncleaned up: ${root}`)
  }

  console.log(`\nfailures: ${failures.length}${failures.length === 0 ? '' : ` (${failures.join(' | ')})`}`)
  console.log(`gaps: ${gaps.length}${gaps.length === 0 ? '' : ` (${gaps.join(' | ')})`}`)
  console.log(
    'note: the holder is killed after its turn settled and its durability barrier completed, so the repair closers are exercised as the balanced-log session/end-seed marker; a kill inside the turn (a torn tail) is not driven here',
  )
  if (failures.length === 0) console.log('\nagent-lifecycle: OK')
  process.exitCode = failures.length === 0 ? 0 : 1
}

if (process.argv[2] === '--hold') await hold(process.argv[3], process.argv[4])
else if (process.argv[2] === '--lease') await lease(process.argv[3])
else if (process.argv[2] === '--resume') await resume(process.argv[3])
else await probe()

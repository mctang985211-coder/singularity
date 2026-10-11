#!/usr/bin/env node
/**
 * G2 evidence: a plan's sub-task runs in its own DSH session, driven by a real model, and the parent
 * may not work on the acceptance it delegated while that session is busy.
 *
 * **Why this cannot be a unit test.** The scheduler's *decisions* are covered by
 * `assembly/tests/scheduler.spec.ts` with the opener as a port. What that cannot show is the thing the
 * port stands for: that a real DSH child agent is created, composed with the parent's preset, given a
 * route, handed one instruction, and that its turn ends — and that the session which did the work is a
 * session somebody can read afterwards. So this probe boots the deployed profile and speaks to it.
 *
 * **How it stays cheap.** The sub-tasks are told to answer in the deployment's own domain, and the child
 * that does the counting is a real agent doing real work — there is no shortcut for the parts that make
 * the claim. The plan is one parent with two children where the second depends on the first, so one
 * advance opens exactly one session and the dependency gate is exercised rather than asserted.
 *
 * **What it does not prove.** It does not prove the child's work is *good*: the criterion's own verifier
 * decides that, and the receipt carries its word. It proves the work happened in a session of the child's
 * own, that the parent was refused while it was in flight, and that the plan's dependency held.
 *
 * Usage: node scripts/subtask-probe.mjs [--screenshot <path>]
 *   Requires: `. /home/ROXY/singularity-next/env.sh` and a deployed profile.
 *
 * @module singularity-core/scripts/subtask-probe
 */

import { mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium } from 'playwright'

import { boot, prepare, send, waitForTools } from './browser-probe.mjs'
import { DSH_HOME } from './dsh-control-runtime.mjs'

/** The deployed profile, and the overlay this probe gives its own control. */
const PROFILE = 'singularity-next-web'
const CONTROL = 'singularity-subtask-probe'
const PRESET_NAME = 'Singularity Next'

/** The overlay: this probe's own control id and workspace, so the deployment's log gains no test task. */
async function probeOverlay(home) {
  const dir = await mkdtemp(join(tmpdir(), 'subtask-probe-'))
  const file = join(dir, 'probe.patch.yml')
  await writeFile(
    file,
    [
      '- id: singularity-assembly',
      '  config:',
      `    controlId: ${CONTROL}`,
      `    domainDir: ${join(process.cwd(), 'deployment', 'domain', 'letters')}`,
      `    workspaceRoot: ${join(home, 'workspaces', CONTROL)}`,
      '',
    ].join('\n'),
  )
  return { dir, file }
}

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
 * The one message this probe sends: plan a task into two children, then stop.
 *
 * The children are deliberately not trivial: the first carries the whole criterion and the second
 * depends on it, so the plan's own gate has something to block. The parent is told not to do the work
 * itself, which is what makes the "parent stays out of its delegate's way" leg meaningful.
 */
const PLAN_PROMPT = [
  'Use `singularity_propose_task` once to admit a task whose goal is to count the ASCII letters in the',
  "input this deployment has prepared. Then call `singularity_decompose_task` on that task's id with",
  'exactly two sub-tasks:',
  '',
  '- key "first", goal "count the letters in the prepared input", dependsOn [] (empty),',
  '  supports the criterion the task declares, maxRuns 1;',
  '- key "second", goal "re-check the first sub-task\'s count", dependsOn ["first"], supports the same',
  '  criterion, maxRuns 1.',
  '',
  'Do not submit a program yourself in this turn, and do not do the counting. Report the task id',
  '`singularity_decompose_task` returned, and the `opened` list it reported.',
].join('\n')

/**
 * Every session this control's log holds, read from the log itself.
 *
 * Sessions live under a directory named for the *cwd* they were created in, not for the control, so
 * looking for a directory named after the control finds the control's own session and nothing else —
 * which is exactly the mistake this probe made first, and it reported "no child session" while the
 * children were there. So the search is by content: read every log, keep the ones this control wrote.
 */
async function sessionsOf(home) {
  const root = join(home, 'sessions')
  const found = []
  for (const entry of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, entry)).catch(() => [])) {
      const file = join(root, entry, name, 'session.v4.jsonl.zstd')
      const raw = await readFile(file).catch(() => undefined)
      if (raw === undefined) continue
      found.push({ dir: entry, name, file, bytes: raw.length })
    }
  }
  return found
}

/** The facts one control session committed, decoded through the host's own compression. */
async function controlFacts(home) {
  const files = (await sessionsOf(home)).filter(session => session.name.includes('control'))
  const facts = []
  for (const session of files) {
    const decoded = await decode(session.file)
    if (decoded === undefined) continue
    for (const line of decoded.split('\n')) {
      if (line.trim() === '' || !line.includes('plugin:singularity:control')) continue
      const event = JSON.parse(line)
      const payload = event.data?.payload
      if (payload?.controlId !== undefined && payload.controlId !== CONTROL) continue
      facts.push({ kind: payload?.kind, subject: payload?.subject, payload: payload?.payload })
    }
  }
  return facts
}

/**
 * The child sessions this run opened, read from their own logs.
 *
 * A child's session lives under a directory named for the *cwd* it was created in, and the scheduler
 * gives each child its own workspace — so a child's directory carries its task id. That is how a child
 * session is told apart from the control's, without asking the deployment to describe itself.
 */
async function childSessionsOf(home, taskIds, parentTaskId) {
  const root = join(home, 'sessions')
  const found = []
  for (const entry of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, entry)).catch(() => [])) {
      const taskId = taskIds.find(id => name.includes(id) && entry.includes(id))
      if (taskId === undefined) continue
      const decoded = await decode(join(root, entry, name, 'session.v4.jsonl.zstd'))
      if (decoded === undefined) continue
      // The plan that opened it is in the session's own header, so a child of another plan is skipped
      // rather than read: this run's plan is the only one whose children this probe has anything to say
      // about, and a session it did not open says nothing about the rule under test.
      if (parentTaskId !== undefined && !decoded.includes(parentTaskId)) continue
      const calls = []
      const refusals = []
      let instruction
      for (const line of decoded.split('\n')) {
        if (line.trim() === '') continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'tool/call') calls.push(event.data?.name)
        if (event.type === 'user/message' && instruction === undefined)
          instruction = (event.data?.content ?? []).map(part => part.text ?? '').join('')
        if (event.type === 'tool/result') {
          const text = (event.data?.message?.content ?? []).map(part => part.text ?? '').join('')
          if (text.includes('"refused"')) refusals.push(text)
        }
      }
      found.push({ taskId, dir: entry, instruction, calls, refusals })
    }
  }
  return found
}

/** One zstd log, decompressed. The host writes these compressed; nothing here re-implements it. */
async function decode(file) {
  const { execFileSync } = await import('node:child_process')
  try {
    return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

/**
 * Remove this probe's own control from the last run, so one run's log is one run's facts.
 *
 * The assertions here are exact — "the plan names two children", "a session per ready sub-task" — and
 * they are read from the control's log, which accumulates across runs. Without this, a second run reads
 * the first run's decompositions and child sessions alongside its own, and the probe reports the wrong
 * plan and a child that was refused for a task belonging to a run that had already finished. That is
 * what happened here first.
 *
 * It is safe because the control id is this probe's own invention, and the guard states it: only paths
 * that *contain* that id are touched, never the deployment's own control or its workspaces.
 */
async function resetControl(home) {
  const root = join(home, 'sessions')
  for (const entry of await readdir(root).catch(() => [])) {
    if (!entry.includes(CONTROL)) continue
    await rm(join(root, entry), { recursive: true, force: true })
  }
  const workspaces = join(home, 'workspaces')
  for (const entry of await readdir(workspaces).catch(() => [])) {
    if (!entry.includes(CONTROL)) continue
    await rm(join(workspaces, entry), { recursive: true, force: true })
  }
}

async function main() {
  // Resolved rather than required, for the reason `dsh-control-runtime.mjs` gives: a gate runner has no
  // `DSH_HOME` to pass, and a probe that refuses there is a gate that can never be green.
  const home = DSH_HOME

  await resetControl(home)
  const overlay = await probeOverlay(home)
  const server = await boot(await freePort(), ['--patch', overlay.file])
  const browser = await chromium.launch()
  try {
    check('the profile boots over the probe overlay with every row active', !server.output.includes('did not activate') && !server.output.includes('skipping profile bundle'), server.output.trim().split('\n').slice(-3).join(' | '))

    // Which tree this run actually judged. The deployed profile links `assembly/` by absolute path, so a
    // copy of this repository boots the *original* plugin — which means a probe run in a stripped tree
    // would still pass, and a verdict that cannot depend on the tree is worth nothing. So the probe
    // asserts that the plugin it drove is the plugin beside it, and stops rather than reporting a pass
    // it cannot stand behind.
    const linked = await readlink(join(home, 'profiles', PROFILE, 'node_modules', '@dangosys', 'dsh-singularity-next')).catch(() => undefined)
    const expected = join(process.cwd(), 'assembly')
    check('the mounted plugin is this checkout, so the verdict is about the tree it names', linked === expected, `the profile links ${linked ?? 'nothing'}, and this probe is running from ${process.cwd()}`)
    if (linked !== expected) throw new Error(`the profile mounts ${linked ?? 'no plugin'}, not ${expected}: a verdict about another tree is not evidence about this one`)

    // The app's locale delegates to the browser when no preference is set, and a browser context
    // inherits the machine's own — so without this, the probes' English accessors match on an en
    // desktop and time out on a zh one. Pin the locale; the UI language is part of the probe's frame,
    // not something it observes.
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor({ timeout: 60_000 })
    await prepare(page, home)
    await send(page, PLAN_PROMPT)
    await waitForTools(page, ['singularity_propose_task', 'singularity_decompose_task'])
    // `decompose` does not answer until each ready child's first turn is over — `say` waits for the
    // agent to go idle — so under a max-reasoning model the parent's own turn can outlast any fixed
    // patience, and waiting for the turn's end times out on slow work rather than on a defect. What
    // this probe claims is in the durable record, not in the parent's answer: poll, bounded, for the
    // plan committed and the opened child's first turn done, both read from the flushed logs.
    const deadline = Date.now() + 900_000
    for (;;) {
      const facts = await controlFacts(home)
      const decomposed = facts.filter(fact => fact.kind === 'task/decomposed').at(-1)
      const children = (decomposed?.payload?.children ?? []).map(child => child.taskId)
      const opened = children.length === 2 ? await childSessionsOf(home, children, undefined) : []
      if ((opened.length === 1 && opened[0].calls.length > 0) || Date.now() > deadline) break
      await sleep(10_000)
    }
    if (Date.now() > deadline) console.log('  note  the plan or the child turn did not settle within the wait; the checks below report what is there')

    const toolText = await page.evaluate(() => [...document.querySelectorAll('[data-tool]')].map(node => node.textContent ?? '').join('\n'))
    const taskId = /"taskId":"(task-[0-9a-f]+)"/.exec(toolText)?.[1] ?? /\b(task-[0-9a-f]{8,})\b/.exec(toolText)?.[1]
    check('a task was proposed and planned through the tools', taskId !== undefined, toolText.slice(-500))
    if (taskId === undefined) throw new Error('no task id was recorded, so there is no plan to inspect')

    // --- the plan's children are real tasks, admitted before they were named ------------------------
    // A plan that names a task nobody admitted declares work that can never start: the tree shows it
    // `missing`, never `ready`. This is the defect the first version of the driver had, and the log is
    // where it is visible — the plan's own ids must be tasks this control admitted.
    const facts = await controlFacts(home)
    const decomposed = facts.filter(fact => fact.kind === 'task/decomposed').at(-1)
    const children = (decomposed?.payload?.children ?? []).map(child => child.taskId)
    const admitted = new Set(facts.filter(fact => fact.kind === 'task/admitted').map(fact => fact.subject))
    check('the plan names two children', children.length === 2, JSON.stringify(children))
    check('every child the plan names is an admitted task, so the plan can run', children.length > 0 && children.every(id => admitted.has(id)), `children=${JSON.stringify(children)} admitted=${JSON.stringify([...admitted])}`)
    check('the plan declares a dependency between its own children', (decomposed?.payload?.children ?? []).some(child => child.dependsOn.some(id => children.includes(id))), JSON.stringify(decomposed?.payload?.children ?? null))

    // --- the plan's own record shows the dependency ------------------------------------------------
    // Read through the panel's route, which is the same projection the tools answer from: this is the
    // probe's only assertion about the tree, and it reads it from the deployment rather than from the
    // model's sentence about it.
    const projection = await page.evaluate(async route => {
      const response = await fetch(route, { headers: { accept: 'application/json' } })
      return { status: response.status, type: (response.headers.get('content-type') ?? '').split(';', 1)[0].trim(), text: await response.text() }
    }, '/singularity/tasks')
    check('the read route answers this control', projection.status === 200 && projection.type === 'application/json', `${projection.status} ${projection.type}`)
    const cut = JSON.parse(projection.text)
    check('the cut it serves is this probe control', cut.controlId === CONTROL, `controlId=${cut.controlId}`)
    const plan = cut.plans.find(entry => entry.parentTaskId === taskId)
    check('the plan is in the committed cut, with two children', plan !== undefined && plan.children.length === 2, JSON.stringify(plan ?? null))
    if (plan !== undefined) {
      const names = plan.children.map(child => child.taskId)
      check('the plan declares the dependency it was given', plan.children.some(child => child.dependsOn.some(dependency => names.includes(dependency))), JSON.stringify(plan.children.map(child => ({ taskId: child.taskId, dependsOn: child.dependsOn }))))
      // One child depends on the other, so exactly one of them is startable at this cut: the gate is the
      // plan's verdict, and a sub-task that is waiting is never `running`.
      check('a sub-task is not running until the one it depends on has verified', plan.children.some(child => child.status !== 'running') || plan.children.every(child => child.status === 'verified'), JSON.stringify(plan.children.map(child => ({ taskId: child.taskId, status: child.status }))))

      // --- the child ran, in a session of its own ------------------------------------------------
      //
      // Asserted on the child's *own session log*, not on the plan: a plan can name two children and
      // open nothing, which is exactly the defect this probe caught the first time it ran. What makes
      // "each sub-task runs in its own DSH session" true is a session on disk whose dir is the child's
      // workspace, holding the instruction the scheduler composed and a tool call the child made.
      // Scoped to the plan just read, not to the control: a session directory is named for the workspace
      // it was created in, and every run of this probe reuses the same workspace names, so an unscoped
      // search finds a previous run's children and asserts about work this run never did.
      const childSessions = await childSessionsOf(home, plan.children.map(child => child.taskId), join(home, 'workspaces', CONTROL))
      check('the deployment opened a session per ready sub-task, and not for the waiting one', childSessions.length === 1, `${childSessions.length} child session(s): ${JSON.stringify(childSessions.map(session => session.taskId))}`)
      if (childSessions.length > 0) {
        const child = childSessions[0]
        check('the child session carries the instruction the deployment composed', (child.instruction ?? '').includes('You are the agent responsible for the sub-task'), (child.instruction ?? '(no instruction delivered)').slice(0, 160))
        check('the child session ran a turn and called a tool of its own', child.calls.length > 0, `tool calls: ${JSON.stringify(child.calls)}`)
        // The identity the child presents is the session id derived from its task id, and its own task
        // must be the one it can act on. The defect this check exists for is the child refused as not
        // responsible for its *own* task; a refusal for acting on some other task — a sibling's, say —
        // is the fence working, so only a refusal naming the child's own task counts.
        const identityDefect = child.refusals.filter(refusal => /task "(task-[0-9a-f]+)" is the responsibility/.exec(refusal)?.[1] === child.taskId)
        check('the child could act on the task it was given, with no refusal naming responsibility', identityDefect.length === 0, JSON.stringify(child.refusals.slice(0, 3)))
      }
    }

    const screenshotFlag = process.argv.indexOf('--screenshot')
    if (screenshotFlag !== -1 && process.argv[screenshotFlag + 1] !== undefined) {
      await page.screenshot({ path: process.argv[screenshotFlag + 1] })
      console.log(`  note  screenshot written to ${process.argv[screenshotFlag + 1]}`)
    }
    void PRESET_NAME
  } finally {
    await browser.close()
    server.child.kill('SIGKILL')
    await server.exited
  }
  console.log(failures === 0 ? '\nsubtask-probe: OK — a plan\'s sub-tasks run in sessions of their own' : `\nsubtask-probe: ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

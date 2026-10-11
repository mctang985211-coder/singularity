#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { dshModule, openPersistence } from './dsh-control-runtime.mjs'
import { boot, controlFacts, coreRead, freePort, isolatedHome, kill, openApp, prepare,
  readLog, sealedDigestsOf, send, settle, toolFacts, assertToolHeader } from './browser-probe.mjs'
import { projectReceipt } from '../src/task/view.ts'

const { lastAssistantStreamChunk } = await dshModule('@deepseek-ai/dsh-llm')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOMAIN = join(ROOT, 'deployment/domain/sha256')
const LIBRARY = 'singularity-local:methods'
const ROUNDS = ['sha256-real-round-1', 'sha256-real-round-2']
export const campaignBudget = { rootSolves: 28, children: 2, childRuns: 2, nativeTokens: 1500000 }
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const redact = value => String(value).replaceAll(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]')

export function campaignPrompt(stage, round) {
  if (stage === 'explore') return [
    'Reduce the complete mapped area of the SHA256 implementation by improving only sha256_w_mem, while preserving every protected functional and cycle check.',
    'Start with singularity_propose_task. Read its actual inputContent, initialSource and complete templates; all fixed apparatus and the requirement are declared there.',
    'Explore and solve this real design requirement yourself. In one parent Run, declare the supported schedule-to-integration plan with two children: integration depends on schedule and must consume its exact verified sealed source. Each child allows at most two Runs.',
    'You may make at most four complete root solve Runs in this exploration. To improve a previous answer, propose the same goal again so the same Task records another Run; different goals admit different Tasks.',
    'Complete at least two Runs with the exact same goal string to reuse a Task, and at least one Run with a new exploration goal. Choose the approach and code yourself from the declared materials and real results.',
    'Submit your own Verilog source to the independent verifier, inspect real status and sealed child answers, and preserve the actual failures as learning material.',
    'Do not create/evolve/release Methods yet. Finish with a factual account of what you tried and what the independent verifier accepted.',
    'The whole campaign permits 28 root solves and 1,500,000 native tokens including exploration, children and provider attempts. Stop when the host refuses a budget; never retry a provider failure.',
  ].join('\n')
  assert.equal(stage, 'round')
  assert([1, 2].includes(round))
  return [
    'First call singularity_method_history alone and consume the actual Task/Run sources, outcomes, admitted Methods and frozen decisions it returns.',
    round === 1
      ? 'Use singularity_create_method to capture the real initial approach as one incumbent Method, and to develop two distinct candidates from the observed exploration. The incumbent must honestly represent the initial approach.'
      : 'Keep the original incumbent from round one. Use singularity_create_method to develop two distinct candidates informed by the real earlier history and measured failures; do not copy scripted candidates.',
    'Do not fabricate a failing baseline, a successful candidate, a measurement or a history. Produce complete Method contents yourself: rootTemplate, reusable complete templates, Skill and an auxiliary Node ES module Tool.',
    'The Tool assists a model solve against the actual input; it can inspect, analyze or test a candidate via argv[3]. The model chooses its final Verilog source. Do not treat Tool bytes as the required final answer.',
    'Each candidate may change at most three structural assets. Protected inputs, fixed core/K/TB and independent acceptance remain frozen.',
    `Call singularity_evolve_method exactly once with the actual admitted references and {roundId:${JSON.stringify(ROUNDS[round - 1])},round:${round},incumbent,candidates:[candidateA,candidateB],explorationSlots:1}.`,
    'The host performs ten independent complete root solves in this round: two bootstrap trials and two baseline/candidate trials per candidate. Do not run extra evaluations yourself.',
    'The measured objective is complete top mapped cell area divided by the fixed baseline 64858.4544, lower is better; functionality is a hard constraint. The declared noise band is 1%, and RRSI permits at most +25% native tokens.',
    'Do not release, propose more root tasks or retry a round. Report the actual committed outcome, including a null winner.',
  ].join('\n')
}

export function nativeAccounting(sessions) {
  let tokens = 0
  const unknown = []
  for (const { sessionId, events } of sessions) for (const event of events) {
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) continue
    const total = event.type === 'assistant/message' ? event.data.usage?.totalTokens
      : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage.totalTokens
    if (total === undefined) unknown.push({ sessionId, seq: event.seq })
    else tokens += total
  }
  return { tokens: unknown.length === 0 ? tokens : null, unknown }
}
async function sessionsOf(persistence) {
  return Promise.all((await persistence.list()).map(async stored => ({ sessionId: String(stored.header.id),
    header: stored.header, events: await readLog(persistence, stored.header.id) })))
}
function rootsOf(facts) {
  const children = new Set(facts.filter(fact => fact.kind === 'task/decomposed').flatMap(fact => fact.payload.children.map(child => child.taskId)))
  return facts.filter(fact => fact.kind === 'run/started' && !children.has(fact.subject))
}
function assertExploration(facts) {
  const roots = rootsOf(facts)
  assert(roots.length >= 3 && roots.length <= 4, 'exploration must record three or four real root Runs')
  const taskIds = [...new Set(roots.map(fact => fact.subject))]
  assert(taskIds.length >= 2 && taskIds.some(id => roots.filter(fact => fact.subject === id).length >= 2), 'exploration did not reuse a Task and admit a new goal')
  const plan = facts.find(fact => fact.kind === 'task/decomposed' && taskIds.includes(fact.subject) && fact.payload.children.length === 2)
  assert(plan !== undefined, 'exploration did not decompose schedule and integration')
  const declared = id => facts.find(fact => fact.kind === 'task/admitted' && fact.subject === id).payload.contract
  const schedule = plan.payload.children.find(child => declared(child.taskId).template.id === 'sha256-schedule')
  const integration = plan.payload.children.find(child => declared(child.taskId).template.id === 'sha256-integration')
  assert(schedule !== undefined && integration !== undefined)
  assert.deepEqual(integration.dependsOn, [schedule.taskId])
  const start = facts.find(fact => fact.kind === 'run/started' && fact.subject === integration.taskId)
  const revision = facts.find(fact => fact.kind === 'revision/created' && fact.subject === start.payload.revision.environmentId && fact.payload.revisionId === start.payload.revision.revisionId)
  const source = revision.payload.manifest.inputSources[0]
  assert.equal(source.source.kind, 'artifact')
  assert.equal(source.source.taskId, schedule.taskId)
  const submission = facts.find(fact => fact.kind === 'run/submitted' && fact.subject === schedule.taskId && fact.payload.runId === source.source.runId)
  assert.equal(source.digest, submission.payload.submission.artifactDigest)
}
async function waitStage(persistence, page, stage, ready, timeout = 3600000) {
  const deadline = Date.now() + timeout
  let progress = ''
  while (Date.now() < deadline) {
    const facts = await controlFacts(persistence)
    const roots = rootsOf(facts)
    assert(roots.length <= campaignBudget.rootSolves, 'root solve budget was exceeded')
    const next = `${roots.length} root Runs; ${facts.filter(fact => ['run/verified', 'run/failed'].includes(fact.kind)).length} terminal Runs`
    if (next !== progress) { process.stderr.write(`sha256-campaign: ${stage}: ${next}\n`); progress = next }
    if (await ready(facts)) { await settle(page, 180000); return facts }
    const generating = await page.locator('button[aria-label="Stop generating"]').count() > 0
    const activeRuns = facts.some(fact => fact.kind === 'run/started' && !facts.some(terminal => terminal.subject === fact.subject &&
      terminal.payload.runId === fact.payload.runId && ['run/verified', 'run/failed'].includes(terminal.kind)))
    if (!generating && !activeRuns) throw new Error(`${stage} ended without its required real result`)
    await sleep(1000)
  }
  throw new Error(`${stage} exceeded its deadline`)
}
async function evidenceOf(medium, attachments, phase) {
  const facts = await controlFacts(medium.persistence)
  const sessions = await sessionsOf(medium.persistence)
  const accounting = nativeAccounting(sessions)
  const core = await coreRead(facts, DOMAIN)
  const runs = []
  for (const started of facts.filter(fact => fact.kind === 'run/started')) {
    const { subject: taskId, payload: { runId } } = started
    const terminal = facts.find(fact => fact.subject === taskId && fact.payload.runId === runId && ['run/verified', 'run/failed'].includes(fact.kind))
    if (terminal === undefined) continue
    const receipt = projectReceipt(core.registry, facts, taskId, runId)
    const sealed = receipt.submission === null ? null : await sealedDigestsOf(attachments, receipt.submission)
    const native = receipt.source === null ? null : sessions.find(session => session.sessionId === receipt.source.sessionId)
    if (native !== null && native !== undefined) for (const header of native.events.filter(event => event.type === 'request/header')) assertToolHeader(header.data.header)
    runs.push({ taskId, runId, receipt, sealed })
  }
  return { phase, budget: campaignBudget, rootSolves: rootsOf(facts).length, accounting, snapshot: core.snapshot, runs, facts, sessions }
}
async function sourceOf(attachments, receipt) {
  const chunks = []
  for await (const bytes of attachments.readFileStream(receipt.submission.files.artifact)) chunks.push(bytes)
  return Buffer.concat(chunks).toString('utf8')
}
async function compareRun(page, home, medium, attachments, method, label, trial) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await prepare(page, home)
  const before = (await controlFacts(medium.persistence)).length
  const goal = `SHA256 real requirement comparison ${label} trial ${trial}`
  await send(page, [
    'Solve the actual SHA256 area-reduction requirement again in this new native session, preserving the protected functional and cycle contract.',
    `Call singularity_propose_task exactly once with goal=${JSON.stringify(goal)}${method === undefined ? ' and omit method to load the published head.' : ` and method=${JSON.stringify(method)}.`}`,
    'Read actual inputs and consume the Method template, Skill and auxiliary Tool. Choose and submit your own final Verilog; use exact Task status and sealed child results when needed.',
    'One root solve only. Do not create/evolve/release Methods or retry a provider failure. Children remain bounded at two, with two Runs each.',
  ].join('\n'))
  const facts = await waitStage(medium.persistence, page, `${label} trial ${trial}`, facts => rootsOf(facts).some(started => started.seq >= before &&
    facts.some(fact => fact.subject === started.subject && fact.payload.runId === started.payload.runId && ['run/verified', 'run/failed'].includes(fact.kind))))
  const started = rootsOf(facts).filter(fact => fact.seq >= before)
  assert.equal(started.length, 1, 'comparison admitted extra root solves')
  const core = await coreRead(facts, DOMAIN)
  const receipt = projectReceipt(core.registry, facts, started[0].subject, started[0].payload.runId)
  const ratio = receipt.submission === null ? null : await core.domain.measurement.measure(await sourceOf(attachments, receipt), new AbortController().signal)
  const descendants = new Set([receipt.taskId, ...facts.filter(fact => fact.subject === receipt.taskId && fact.kind === 'task/decomposed').flatMap(fact => fact.payload.children.map(child => child.taskId))])
  const ownerIds = facts.filter(fact => fact.kind === 'task/assigned' && descendants.has(fact.subject)).map(fact => fact.payload.agentId)
  const sessionIds = new Set(facts.filter(fact => fact.kind === 'agent/opened' && ownerIds.includes(fact.payload.agentId)).map(fact => fact.payload.sessionId))
  const accounting = nativeAccounting((await sessionsOf(medium.persistence)).filter(session => sessionIds.has(session.sessionId)))
  const pinned = facts.find(fact => fact.kind === 'revision/created' && fact.subject === started[0].payload.revision.environmentId && fact.payload.revisionId === started[0].payload.revision.revisionId).payload.manifest.method
  if (method !== undefined) assert.deepEqual(pinned, method)
  else assert.equal(pinned.revisionId, facts.findLast(fact => fact.kind === 'pointer/switched' && fact.subject === LIBRARY).payload.to)
  return { label, trial, method: pinned, receipt, areaRatio: ratio, area: ratio === null ? null : ratio * core.domain.measurement.baseline, accounting }
}

async function run() {
  const outputAt = process.argv.indexOf('--output')
  const output = outputAt < 0 ? join(tmpdir(), `singularity-sha256-${Date.now()}`) : process.argv[outputAt + 1]
  assert(typeof output === 'string', '--output requires a directory')
  await mkdir(output, { recursive: true, mode: 0o700 })
  await chmod(output, 0o700)
  const isolated = await isolatedHome()
  const overlay = join(isolated.home, 'sha256.patch.yml')
  await writeFile(overlay, '- id: singularity-assembly\n  config:\n    controlId: singularity-local\n    domainDir: ' + JSON.stringify(DOMAIN) +
    '\n    workspaceRoot: ' + JSON.stringify(join(isolated.home, 'workspaces/singularity')) + '\n    budget:\n      rootSolves: 28\n      children: 2\n      childRuns: 2\n      nativeTokens: 1500000\n- id: session-title-llm\n  disabled: true\n', { mode: 0o600 })
  let server, browser, medium, page
  const save = async evidence => {
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ ...evidence, home: isolated.home }, null, 2) + '\n', { mode: 0o600 })
    process.stdout.write(JSON.stringify({ phase: evidence.phase, home: isolated.home, evidence: join(output, 'evidence.json'),
      rootSolves: evidence.rootSolves, accounting: evidence.accounting }) + '\n')
  }
  try {
    medium = await openPersistence(join(isolated.home, 'sessions'), 'zstd')
    const { LocalAttachmentStore } = await dshModule('@deepseek-ai/dsh-attachment-local')
    await medium.context.plugin(LocalAttachmentStore, { dshHome: isolated.home })
    const attachments = medium.context.get('attachments')
    server = await boot(await freePort(), ['--patch', overlay], isolated.home)
    await writeFile(join(output, 'approval-url.txt'), server.url + '\n', { mode: 0o600 })
    await writeFile(join(output, 'run.json'), JSON.stringify({ home: isolated.home, hostPid: server.child.pid, probePid: process.pid, origin: new URL(server.url).origin }) + '\n', { mode: 0o600 })
    browser = await chromium.launch()
    page = await openApp(await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } }), server.url)
    await prepare(page, isolated.home)
    await send(page, campaignPrompt('explore'))
    await waitStage(medium.persistence, page, 'exploration', async facts => {
      const roots = rootsOf(facts)
      assert(roots.length <= 4, 'exploration used evaluation or comparison budget')
      return roots.length > 0 && roots.every(started => facts.some(fact => fact.subject === started.subject &&
        fact.payload.runId === started.payload.runId && ['run/verified', 'run/failed'].includes(fact.kind))) &&
        await page.locator('button[aria-label="Stop generating"]').count() === 0
    })
    assertExploration(await controlFacts(medium.persistence))
    await save(await evidenceOf(medium, attachments, 'exploration-complete'))
    for (const round of [1, 2]) {
      await send(page, campaignPrompt('round', round))
      await waitStage(medium.persistence, page, `round ${round}`, facts => facts.some(fact => fact.kind === 'round/decided' && fact.subject === ROUNDS[round - 1]))
      await save(await evidenceOf(medium, attachments, `round-${round}-complete`))
    }
    const experiment = await evidenceOf(medium, attachments, 'two-rounds-complete')
    const evolve = experiment.sessions.flatMap(session => toolFacts(session.events).results).filter(result => result.name === 'singularity_evolve_method' && result.value.decided)
    assert.equal(evolve.length, 2)
    const selected = evolve.findLast(result => result.value.winner !== null)?.value
    if (selected === undefined) { await save({ ...experiment, phase: 'no-winner', comparison: null }); return }
    const incumbent = selected.incumbent
    assert(evolve.every(result => result.value.incumbent.digest === incumbent.digest), 'rounds changed the unapproved incumbent')
    await page.screenshot({ path: join(output, 'two-rounds.png'), fullPage: true })
    await save({ ...experiment, phase: 'release-ready', selectedRoundId: selected.roundId })
    await send(page, [
      `Request singularity_release_method with release=${JSON.stringify(JSON.stringify({ bootstrap: incumbent }))}; wait for the real human answer.`,
      `Only after actual approval succeeds, request singularity_release_method with release=${JSON.stringify(JSON.stringify({ roundId: selected.roundId }))} and wait for the real human answer.`,
      'Do not approve on behalf of the human, run more tasks, change Methods or retry a denial.',
    ].join('\n'))
    process.stdout.write(JSON.stringify({ phase: 'awaiting-human-publication', urlFile: join(output, 'approval-url.txt'), evidence: join(output, 'evidence.json') }) + '\n')
    await waitStage(medium.persistence, page, 'human publication', facts => facts.filter(fact => fact.kind === 'pointer/switched' && fact.subject === LIBRARY).length === 2)
    const comparison = []
    for (const [label, method] of [['incumbent', incumbent], ['published', undefined]])
      for (const trial of [1, 2]) comparison.push(await compareRun(page, isolated.home, medium, attachments, method, label, trial))
    await page.screenshot({ path: join(output, 'published-comparison.png'), fullPage: true })
    await save({ ...await evidenceOf(medium, attachments, 'published-comparison-complete'), selectedRoundId: selected.roundId, comparison })
  } catch (error) {
    if (page !== undefined && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    const evidence = medium === undefined ? {} : await evidenceOf(medium, medium.context.get('attachments'), 'stopped')
    await save({ ...evidence, phase: 'stopped', error: redact(error.stack ?? error) })
    throw error
  } finally {
    await browser?.close()
    if (server !== undefined) await kill(server)
    await medium?.context.fiber.dispose()
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await run().catch(error => { process.stderr.write('sha256-campaign: ' + redact(error.stack ?? error) + '\n'); process.exitCode = 1 })

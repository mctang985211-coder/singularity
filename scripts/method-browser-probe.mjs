#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { digestOf } from '../src/protocol/envelope.ts'
import { projectReceipt } from '../src/task/view.ts'
import { sha256 } from '../assembly/src/ids.ts'
import { dshModule, openPersistence } from './dsh-control-runtime.mjs'
import { assertToolHeader, boot, controlFacts, coreRead, freePort, inputSourcesOf,
  isolatedHome, kill, openApp, prepare, readLog, sealedDigestsOf, send, settle, toolFacts } from './browser-probe.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOMAIN = join(ROOT, 'deployment/domain/letters')
const METHOD_ENVIRONMENT = 'singularity-local:methods'
const ROUND_IDS = ['browser-method-round-1', 'browser-method-round-2']
const ROUND_TIMEOUT = 900_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const diagnostic = value => String(value).replaceAll(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]')

export async function controlledMethods() {
  const { rootTemplate, templates } = JSON.parse(await readFile(join(DOMAIN, 'task.json'), 'utf8'))
  const tool = (offset, variable) => [
    "import { readFileSync } from 'node:fs'",
    `const ${variable} = readFileSync(process.argv[2], 'utf8')`,
    `console.log((${variable}.match(/[A-Za-z]/g) ?? []).length + ${offset})`,
  ].join('\n')
  const method = (label, offset, variable) => ({ rootTemplate,
    templates: templates.map(template => template.id === rootTemplate
      ? { ...template, goal: `${template.goal}; controlled engineering candidate ${label}` } : template),
    skill: `Controlled engineering Method ${label}. Call singularity_run_method once for the assigned Task, then submit the returned program byte for byte. Do not repair even a failing answer. The independent verifier decides acceptance.`,
    tool: tool(offset, variable),
  })
  const methods = { baseline: method('baseline-plus-one', 1, 'source'),
    good1: method('round-one-correct', 0, 'source'), bad1: method('round-one-plus-two', 2, 'source'),
    good2: method('round-two-correct', 0, 'sample'), bad2: method('round-two-plus-three', 3, 'sample') }
  assert.equal(methods.baseline.tool.length, methods.good1.tool.length)
  assert.equal(methods.baseline.tool.replace('length + 1', 'length + 0'), methods.good1.tool)
  return methods
}

function roundPrompt(methods, round) {
  const names = round === 1 ? ['baseline', 'good1', 'bad1'] : ['good2', 'bad2']
  return [
    `Run controlled letters engineering acceptance round ${round}. This is an integration experiment, not evidence of formal domain improvement.`,
    'Do not propose, decompose, submit, run a Method yourself, release, or retry an evolution round. The evolution tool owns exactly five real solves.',
    ...(round === 2 ? [
      'First call singularity_method_history with {} alone, wait for its result, and read the frozen first-round decision before creating either later candidate.',
      'Keep the original wrong baseline as incumbent. This experiment compares new candidates; no incumbent is adopted before human publication.',
    ] : []),
    'Admit each complete Method below exactly once using singularity_create_method with content set to its complete JSON string. Preserve every byte of the tool and skill strings.',
    ...names.map(name => `${name}: ${JSON.stringify(methods[name])}`),
    `Then call singularity_evolve_method exactly once with round set to JSON.stringify({roundId:${JSON.stringify(ROUND_IDS[round - 1])},round:${round},incumbent:<actual baseline reference returned by create_method>,candidates:[<actual good${round} reference>,<actual bad${round} reference>],explorationSlots:1}).`,
    'Each candidate changes exactly the root template goal, Skill, and Tool: three structural edits. Do not change protected inputs or acceptance.',
    'After the evolution result, report its actual winner and finish this turn. Do not release or start any more solves.',
  ].join('\n')
}

async function rootTranscript(persistence) {
  const roots = []
  for (const stored of await persistence.list()) {
    if (stored.header.id === 'singularity:control:singularity-local') continue
    const events = await readLog(persistence, stored.header.id)
    if (toolFacts(events).calls.some(call => call.data.name === 'singularity_evolve_method'))
      roots.push({ sessionId: stored.header.id, events })
  }
  assert.equal(roots.length, 1, 'evolution must originate from exactly one real root model session')
  return roots[0]
}

async function waitForRound(persistence, page, index) {
  const deadline = Date.now() + ROUND_TIMEOUT
  let observed = ''
  while (Date.now() < deadline) {
    const facts = await controlFacts(persistence)
    const started = facts.filter(fact => fact.kind === 'run/started')
    assert(started.length <= (index + 1) * 5, 'the model exceeded this round\'s five real solve limit')
    const terminals = facts.filter(fact => ['run/verified', 'run/failed'].includes(fact.kind))
    const progress = `${started.length}/${terminals.length}`
    if (observed !== progress) {
      process.stderr.write(`method-browser-probe: round ${index + 1}, started/terminal ${progress}\n`)
      observed = progress
    }
    assert(!terminals.some(fact => fact.kind === 'run/failed' && fact.payload.cause === 'runtime'),
      'a controlled solve failed at runtime')
    const decided = facts.find(fact => fact.kind === 'round/decided' && fact.subject === ROUND_IDS[index])
    if (decided !== undefined) { await settle(page, ROUND_TIMEOUT); return }
    assert(await page.locator('button[aria-label="Stop generating"]').count() > 0,
      'the root turn ended before its committed round decision')
    await sleep(500)
  }
  throw new Error(`round ${index + 1} did not finish before the deadline`)
}

async function evaluationEvidence(persistence, attachments, facts, core, opened, methods) {
  const { taskId, runId } = opened.payload.run
  const started = facts.find(fact => fact.kind === 'run/started' && fact.subject === taskId && fact.payload.runId === runId)
  const receipt = projectReceipt(core.registry, facts, taskId, runId)
  const revision = facts.find(fact => fact.kind === 'revision/created' && fact.subject === started.payload.revision.environmentId &&
    fact.payload.revisionId === started.payload.revision.revisionId)
  const method = opened.payload.candidate
  assert.deepEqual(revision.payload.manifest.method, method, 'the solve did not pin the evaluation\'s exact Method')
  const label = Object.keys(methods).find(key => digestOf(methods[key]) === method.digest)
  assert(label !== undefined, 'the solver consumed an unexpected Method')
  const assets = methods[label]
  const contract = facts.find(fact => fact.kind === 'task/admitted' && fact.subject === taskId).payload.contract
  assert(contract.goal.includes(assets.templates.find(template => template.id === assets.rootTemplate).goal),
    'the admitted Task did not use the pinned template goal')
  inputSourcesOf(facts, taskId, receipt)
  const sealed = await sealedDigestsOf(attachments, receipt.submission)
  assert.equal(sealed.programDigest, sha256(assets.tool), 'the submitted program differs from the pinned Method tool')
  const owner = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === taskId).payload.agentId
  const sessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === owner).payload.sessionId
  const events = await readLog(persistence, sessionId)
  const operationId = opened.subject.slice(0, -':evaluation'.length)
  const dispatch = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'singularity-method-solve')
  assert.equal(dispatch.length, 1, 'the solve dispatch did not enter exactly one native model turn')
  assert.deepEqual(dispatch[0].data.source, { kind: 'singularity-method-solve', controlId: 'singularity-local', operationId, taskId, runId })
  assert(dispatch[0].data.content.map(part => part.text ?? '').join('').includes('Goal: ' + contract.goal),
    'the actual native model input omitted the Method template goal')
  const { calls, results } = toolFacts(events)
  assert(!results.some(result => result.value.isError === true || result.value.refused !== undefined), 'a native solve tool failed')
  assert.deepEqual(calls.map(event => event.data.name).sort(), ['singularity_run_method', 'singularity_submit_program'])
  const runTool = results.find(result => result.name === 'singularity_run_method')
  const submit = calls.find(call => call.data.name === 'singularity_submit_program')
  assert.equal(runTool.value.program, assets.tool)
  assert.deepEqual(JSON.parse(submit.data.arguments), { taskId, program: assets.tool })
  assert(runTool.seq < submit.seq, 'submission preceded the actual Method execution result')
  assert.equal(receipt.source.sessionId, sessionId)
  assert.equal(receipt.source.digest, digestOf({ sessionId, eventCount: receipt.source.eventCount,
    events: events.slice(0, receipt.source.eventCount) }))
  const consumed = facts.filter(fact => fact.kind === 'method/consumed' && fact.subject === taskId && fact.payload.runId === runId)
  assert.deepEqual(consumed.map(fact => fact.payload.method).sort(), ['skill', 'template', 'tool'])
  for (const fact of consumed) {
    assert.deepEqual(fact.payload.revision, started.payload.revision)
    assert(fact.seq < facts.find(entry => entry.kind === 'run/submitted' && entry.subject === taskId).seq)
  }
  assert.equal(consumed.find(fact => fact.payload.method === 'template').payload.source, `template:${method.digest}/${assets.rootTemplate}`)
  const skill = consumed.find(fact => fact.payload.method === 'skill')
  const system = events.find(event => skill.payload.source === `system/message:${sessionId}/${event.seq}`)
  assert.equal(system?.type, 'system/message')
  assert(system.data.message.content.map(part => part.text ?? '').join('').includes(
    `Method ${method.digest} for Task ${taskId}, Run ${runId}:\n${assets.skill}`), 'the real native system prompt omitted the pinned Skill')
  assert.equal(consumed.find(fact => fact.payload.method === 'tool').payload.source,
    `tool:${sessionId}/${calls.find(call => call.data.name === 'singularity_run_method').data.callId}:${method.digest}`)
  const headers = events.filter(event => event.type === 'request/header')
  for (const header of headers) assertToolHeader(header.data.header)
  const model = headers.at(-1).data.header.config
  const bubble = facts.find(fact => fact.kind === 'bubble/opened' && fact.subject === taskId).payload
  assert.deepEqual(bubble.model, { provider: model.provider, model: model.model })
  const messages = events.filter(event => event.type === 'assistant/message')
  assert(messages.length > 0, 'the solve has no real native model output')
  const usage = messages.map(event => {
    assert(event.data.usage !== undefined, 'the solve has no native token accounting')
    assert(event.data.usage.totalTokens !== undefined, 'the solve has no exact native total token accounting')
    return { seq: event.seq, ...event.data.usage }
  })
  const tokens = usage.reduce((sum, value) => sum + value.totalTokens, 0)
  assert(tokens > 0)
  const trial = facts.find(fact => fact.kind === 'trial/recorded' && fact.subject === opened.subject)
  assert.equal(trial.payload.cost, tokens, 'measurement cost differs from native model token usage')
  assert.equal(trial.payload.artifactDigest, sealed.artifactDigest)
  assert.deepEqual(trial.payload.inputDigests, sealed.inputDigests)
  const verdict = facts.find(fact => fact.kind === 'evidence/produced' && fact.subject === taskId && fact.payload.runId === runId)
  const criterion = contract.criteria[0]
  assert.equal(verdict.payload.implementationDigest, sha256(await readFile(join(DOMAIN, 'verifier.mjs'))))
  assert.equal(verdict.payload.artifactDigest, sealed.artifactDigest)
  assert.deepEqual(verdict.payload.inputDigests, sealed.inputDigests)
  assert.notEqual(verdict.actor, started.actor, 'the executor judged its own result')
  const quality = label.startsWith('good') ? 1 : 0
  assert.equal(verdict.payload.verdict, quality === 1 ? 'pass' : 'fail')
  assert.equal(trial.payload.quality, quality)
  assert.equal(receipt.status, quality === 1 ? 'verified' : 'failed')
  const constraint = facts.find(fact => fact.kind === 'constraint/checked' && fact.subject === opened.subject)
  assert.equal(constraint.payload.met, quality === 1)
  assert.deepEqual(constraint.payload.verdict, { criterionId: criterion.criterionId,
    evidenceDigest: digestOf(verdict.payload), artifactDigest: sealed.artifactDigest })
  return { evaluationId: opened.subject, taskId, runId, sessionId, label, method, quality, tokens, usage,
    dispatch: { seq: dispatch[0].seq, source: dispatch[0].data.source },
    consumed: consumed.map(fact => ({ seq: fact.seq, ...fact.payload })), sealed, verdict, receipt, model }
}

async function assertExperiment(persistence, attachments, methods) {
  const facts = await controlFacts(persistence)
  assert.equal(facts.filter(fact => fact.kind === 'run/started').length, 10)
  assert.equal(facts.filter(fact => fact.kind === 'task/admitted').length, 10)
  assert(!facts.some(fact => fact.kind === 'pointer/switched'), 'Methods were published before human approval')
  const core = await coreRead(facts, DOMAIN)
  const root = await rootTranscript(persistence)
  for (const header of root.events.filter(event => event.type === 'request/header')) assertToolHeader(header.data.header)
  const native = toolFacts(root.events)
  assert(!native.results.some(result => result.value.isError === true || result.value.refused !== undefined))
  const created = native.results.filter(result => result.name === 'singularity_create_method')
  assert.equal(created.length, 5)
  assert.deepEqual(created.map(result => result.value.digest).sort(), Object.values(methods).map(digestOf).sort())
  for (const result of created) {
    assert.equal(result.value.environmentId, METHOD_ENVIRONMENT)
    const revision = facts.find(fact => fact.kind === 'revision/created' && fact.subject === METHOD_ENVIRONMENT &&
      fact.payload.revisionId === result.value.revisionId)
    assert.equal(digestOf(revision.payload.manifest), result.value.digest)
  }
  const evolved = native.results.filter(result => result.name === 'singularity_evolve_method')
  assert.equal(evolved.length, 2)
  const history = native.results.filter(result => result.name === 'singularity_method_history')
  assert.equal(history.length, 1)
  assert.deepEqual(history[0].value, [evolved[0].value], 'second-round model history differs from the first frozen decision')
  const laterCalls = native.calls.filter(call => call.data.name === 'singularity_create_method' && call.seq > history[0].seq)
  assert.equal(laterCalls.length, 2, 'second-round candidates were created before reading Method history')
  assert(root.events.some(event => event.type === 'assistant/message' && event.seq > history[0].seq && event.seq < laterCalls[0].seq),
    'the root model did not consume history before proposing later candidates')
  const rounds = evolved.map((result, index) => {
    assert.equal(result.value.roundId, ROUND_IDS[index])
    if (result.value.winner !== null) assert.equal(result.value.winner, 0, 'a failing candidate was selected')
    assert.equal(result.value.decided, true)
    const opened = facts.find(fact => fact.kind === 'round/opened' && fact.subject === ROUND_IDS[index])
    assert.equal(opened.payload.incumbent.digest, digestOf(methods.baseline))
    assert.equal(opened.payload.explorationSlots, 1)
    const candidates = facts.filter(fact => fact.kind === 'candidate/submitted' && fact.subject === ROUND_IDS[index])
    assert.equal(candidates.length, 2)
    for (const [slot, candidate] of candidates.entries()) {
      assert.deepEqual(candidate.payload.edits, [{ asset: 'template', target: methods.baseline.rootTemplate },
        { asset: 'skill', target: 'skill' }, { asset: 'tool', target: 'tool' }])
      assert.equal(candidate.payload.exploratory, slot === 1)
    }
    const decision = facts.find(fact => fact.kind === 'round/decided' && fact.subject === ROUND_IDS[index])
    assert.deepEqual(decision.payload, { winner: result.value.winner, outcomes: result.value.outcomes, calibration: result.value.calibration })
    return { callId: result.callId, openedSeq: opened.seq, decidedSeq: decision.seq, candidates, decision: result.value }
  })
  const opened = facts.filter(fact => fact.kind === 'evaluation/opened')
  assert.equal(opened.length, 10)
  const evaluations = []
  for (const evaluation of opened) evaluations.push(await evaluationEvidence(persistence, attachments, facts, core, evaluation, methods))
  assert.equal(new Set(evaluations.map(value => value.sessionId)).size, 10, 'real solves did not run in ten distinct native sessions')
  assert(!evaluations.some(value => value.sessionId === root.sessionId))
  for (const [index, roundId] of ROUND_IDS.entries()) {
    const actual = evaluations.filter(value => value.evaluationId.startsWith(roundId + ':'))
    assert.deepEqual(actual.map(value => value.label), ['baseline', 'baseline', `good${index + 1}`, 'baseline', `bad${index + 1}`])
  }
  return { experiment: 'controlled letters engineering acceptance', formalDomainImprovement: false,
    rootSessionId: root.sessionId, model: root.events.findLast(event => event.type === 'request/header').data.header.config,
    history: { callId: history[0].callId, seq: history[0].seq, decisions: history[0].value },
    rounds, evaluations, controlFactCount: facts.length,
    nativeSolveTokens: evaluations.reduce((sum, value) => sum + value.tokens, 0),
    rootUsage: root.events.filter(event => event.type === 'assistant/message').map(event => ({ seq: event.seq, usage: event.data.usage })) }
}

async function awaitPublication(persistence, page, evidence, output, server) {
  while (true) {
    const events = await readLog(persistence, evidence.rootSessionId)
    const asked = events.filter(event => event.type === 'approval/asked' && event.data.toolName === 'singularity_release_method')
    const answers = events.filter(event => event.type === 'approval/decided' && asked.some(ask => ask.data.id === event.data.id))
    assert(!answers.some(answer => answer.data.outcome !== 'allowed-once'), 'human approval declined or could not be answered')
    const facts = await controlFacts(persistence)
    const switches = facts.filter(fact => fact.kind === 'pointer/switched' && fact.subject === METHOD_ENVIRONMENT)
    assert(switches.length <= 2)
    if (switches.length === 2) {
      assert.equal(asked.length, 2)
      assert.equal(answers.length, 2)
      const approvals = facts.filter(fact => fact.kind === 'release/approved' && fact.subject === METHOD_ENVIRONMENT)
      assert.equal(approvals.length, 2)
      for (const [index, approval] of approvals.entries()) {
        assert.equal(approval.payload.approvalId, asked[index].data.id)
        assert(asked[index].seq < answers[index].seq)
        assert(approval.seq < switches[index].seq)
      }
      await settle(page, 120_000)
      return { approvals, switches, native: asked.map((ask, index) => ({ asked: ask, decided: answers[index] })) }
    }
    assert(server.child.exitCode === null && server.child.signalCode === null, 'the retained DSH host stopped before approval')
    if (asked.length === 2 && evidence.phase !== 'winner-approval-pending') {
      evidence.phase = 'winner-approval-pending'
      evidence.approval = asked[1]
      await page.screenshot({ path: join(output, 'winner-approval-pending.png'), fullPage: true })
      await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
      process.stdout.write(JSON.stringify({ phase: evidence.phase, evidence: join(output, 'evidence.json') }) + '\n')
    }
    await sleep(500)
  }
}

async function nextRunEvidence(persistence, attachments, page, evidence, methods, publication) {
  assert.equal(publication.switches[0].payload.expected, '')
  assert.equal(publication.switches[1].payload.expected, publication.switches[0].payload.to)
  const factsBefore = await controlFacts(persistence)
  const winner = factsBefore.find(fact => fact.kind === 'candidate/submitted' && fact.subject === evidence.selectedRoundId && fact.payload.slot === 0).payload.revision
  const assets = Object.values(methods).find(method => digestOf(method) === winner.digest)
  assert(assets !== undefined)
  assert.equal(publication.switches[1].payload.to, winner.revisionId)
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await prepare(page, evidence.home)
  await send(page, [
    'The two native Web approvals have completed. Validate one ordinary solve using the published Method head.',
    'Call singularity_propose_task exactly once with goal "Published Method head engineering acceptance" and omit method so the host selects its actual published head.',
    'Use singularity_run_method once for that returned taskId, then singularity_submit_program with its exact returned program unchanged.',
    'Finally call singularity_task_status for that same Task and report its actual verified receipt. Do not decompose, create/evolve/release Methods, or run any more solves.',
  ].join('\n'))
  await settle(page, 300_000)
  const facts = await controlFacts(persistence)
  const next = facts.filter(fact => fact.kind === 'run/started' && fact.seq >= factsBefore.length)
  assert.equal(next.length, 1)
  assert.equal(facts.filter(fact => fact.kind === 'run/started').length, 11)
  const { subject: taskId, payload: { runId, revision: pinned } } = next[0]
  const revision = facts.find(fact => fact.kind === 'revision/created' && fact.subject === pinned.environmentId && fact.payload.revisionId === pinned.revisionId)
  assert.deepEqual(revision.payload.manifest.method, winner)
  const owner = facts.find(fact => fact.kind === 'task/assigned' && fact.subject === taskId).payload.agentId
  const sessionId = facts.find(fact => fact.kind === 'agent/opened' && fact.payload.agentId === owner).payload.sessionId
  assert.notEqual(sessionId, evidence.rootSessionId, 'the published head was not consumed by a new native session')
  const root = await readLog(persistence, sessionId)
  const native = toolFacts(root)
  const proposal = native.calls.findLast(call => call.data.name === 'singularity_propose_task')
  assert.deepEqual(JSON.parse(proposal.data.arguments), { goal: 'Published Method head engineering acceptance' })
  const core = await coreRead(facts, DOMAIN)
  const receipt = projectReceipt(core.registry, facts, taskId, runId)
  assert.equal(receipt.status, 'verified')
  const status = native.results.findLast(result => result.name === 'singularity_task_status')
  assert.deepEqual(status.value.receipt, receipt)
  const sealed = await sealedDigestsOf(attachments, receipt.submission)
  assert.equal(sealed.programDigest, sha256(assets.tool))
  inputSourcesOf(facts, taskId, receipt)
  const consumed = facts.filter(fact => fact.kind === 'method/consumed' && fact.subject === taskId)
  assert.deepEqual(consumed.map(fact => fact.payload.method).sort(), ['skill', 'template', 'tool'])
  const skill = consumed.find(fact => fact.payload.method === 'skill')
  const system = root.find(event => skill.payload.source === `system/message:${sessionId}/${event.seq}`)
  assert(system.data.message.content.map(part => part.text ?? '').join('').includes(
    `Method ${winner.digest} for Task ${taskId}, Run ${runId}:\n${assets.skill}`))
  const actualTool = native.results.find(result => result.name === 'singularity_run_method')
  assert.equal(actualTool.value.program, assets.tool)
  assert.deepEqual(JSON.parse(native.calls.find(call => call.data.name === 'singularity_submit_program').data.arguments),
    { taskId, program: assets.tool })
  return { taskId, runId, sessionId, method: winner, receipt, sealed, consumed }
}

async function run() {
  const outputIndex = process.argv.indexOf('--output')
  assert(outputIndex === -1 || process.argv[outputIndex + 1] !== undefined, '--output requires a directory')
  const output = outputIndex === -1 ? join(tmpdir(), `singularity-method-evidence-${Date.now()}`) : process.argv[outputIndex + 1]
  await mkdir(output, { recursive: true, mode: 0o700 })
  await chmod(output, 0o700)
  const methods = await controlledMethods()
  const isolated = await isolatedHome()
  let server, browser, medium, page
  try {
    server = await boot(await freePort(), isolated.extra, isolated.home)
    await writeFile(join(output, 'approval-url.txt'), server.url + '\n', { mode: 0o600 })
    await writeFile(join(output, 'run.json'), JSON.stringify({ home: isolated.home, hostPid: server.child.pid,
      probePid: process.pid, origin: new URL(server.url).origin }) + '\n', { mode: 0o600 })
    medium = await openPersistence(join(isolated.home, 'sessions'), 'zstd')
    const { LocalAttachmentStore } = await dshModule('@deepseek-ai/dsh-attachment-local')
    await medium.context.plugin(LocalAttachmentStore, { dshHome: isolated.home })
    browser = await chromium.launch()
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    page = await openApp(context, server.url)
    await prepare(page, isolated.home)
    for (const [index] of ROUND_IDS.entries()) {
      await send(page, roundPrompt(methods, index + 1))
      await waitForRound(medium.persistence, page, index)
      process.stderr.write(`method-browser-probe: round ${index + 1} committed through real native solves\n`)
    }
    const experiment = await assertExperiment(medium.persistence, medium.context.get('attachments'), methods)
    const baseline = toolFacts((await rootTranscript(medium.persistence)).events).results.find(result =>
      result.name === 'singularity_create_method' && result.value.digest === digestOf(methods.baseline)).value
    await page.screenshot({ path: join(output, 'two-rounds.png'), fullPage: true })
    const selected = experiment.rounds.findLast(round => round.decision.winner !== null)
    assert(selected !== undefined, 'neither committed round selected a Method; there is no winner to release')
    const evidence = { ...experiment, selectedRoundId: selected.decision.roundId,
      home: isolated.home, hostPid: server.child.pid, probePid: process.pid,
      origin: new URL(server.url).origin, urlFile: join(output, 'approval-url.txt'), screenshot: join(output, 'two-rounds.png'),
      phase: 'two-rounds-verified' }
    await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    await send(page, [
      'The controlled two-round integration evaluation has been checked against the actual native transcripts and committed facts.',
      `Call singularity_release_method with release=${JSON.stringify(JSON.stringify({ bootstrap: baseline }))}. This opens a native Web human approval; wait for the real user answer.`,
      `Only after that tool actually succeeds, call singularity_release_method once with release=${JSON.stringify(JSON.stringify({ roundId: evidence.selectedRoundId }))}, then wait for the second real user approval.`,
      'If either approval is denied or unavailable, stop and report it. Do not retry or run more solves. Do not claim formal domain effect.',
    ].join('\n'))
    const deadline = Date.now() + 120_000
    while (true) {
      const events = await readLog(medium.persistence, experiment.rootSessionId)
      const asked = events.find(event => event.type === 'approval/asked' && event.data.toolName === 'singularity_release_method')
      if (asked !== undefined) {
        assert(!events.some(event => event.type === 'approval/decided' && event.data.id === asked.data.id),
          'the native approval was answered before the user reviewed it')
        evidence.phase = 'bootstrap-approval-pending'
        evidence.approval = asked
        await page.screenshot({ path: join(output, 'approval-pending.png'), fullPage: true })
        await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
        process.stdout.write(JSON.stringify({ phase: evidence.phase, evidence: join(output, 'evidence.json'),
          urlFile: evidence.urlFile, home: isolated.home, hostPid: server.child.pid, probePid: process.pid,
          origin: evidence.origin, solves: experiment.evaluations.length, rounds: experiment.rounds.length,
          nativeSolveTokens: experiment.nativeSolveTokens }) + '\n')
        break
      }
      assert(Date.now() < deadline, 'the root did not request native human approval')
      assert(!events.some(event => event.type === 'turn/end' && event.seq > events.findLast(entry => entry.type === 'user/message').seq),
        'the root turn ended before native approval')
      await sleep(500)
    }
    evidence.publication = await awaitPublication(medium.persistence, page, evidence, output, server)
    evidence.nextRun = await nextRunEvidence(medium.persistence, medium.context.get('attachments'), page, evidence, methods, evidence.publication)
    evidence.phase = 'published-head-next-run-verified'
    await page.screenshot({ path: join(output, 'published-head-next-run.png'), fullPage: true })
    await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    process.stdout.write(JSON.stringify({ phase: evidence.phase, evidence: join(output, 'evidence.json'), taskId: evidence.nextRun.taskId,
      runId: evidence.nextRun.runId }) + '\n')
  } catch (error) {
    if (page !== undefined && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    const facts = medium === undefined ? [] : await controlFacts(medium.persistence)
    const sessions = []
    if (medium !== undefined) for (const stored of await medium.persistence.list())
      sessions.push({ sessionId: stored.header.id, header: stored.header, events: await readLog(medium.persistence, stored.header.id) })
    await writeFile(join(output, 'failure.json'), JSON.stringify({ error: diagnostic(error.stack ?? error),
      home: isolated.home, hostPid: server?.child.pid, facts, sessions }, null, 2) + '\n', { mode: 0o600 })
    throw error
  } finally {
    await browser?.close()
    if (server !== undefined) await kill(server)
    await medium?.context.fiber.dispose()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await run().catch(error => { process.stderr.write('method-browser-probe: ' + diagnostic(error.stack ?? error) + '\n'); process.exitCode = 1 })

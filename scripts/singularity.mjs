#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHECKOUT, hostFindings, hostInstall, hostRequire } from './host-config.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
export function cleanError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]')
  return message.replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/((?:authorization|api[_-]?key|cookie|password|(?:access[_-]?)?token|secret)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,"'}]+/gi, '$1[redacted]')
}

/** The CLI uses the same authenticated native RPCs as the web client. */
export async function connectHost({ url = process.env['SINGULARITY_URL'] || 'http://127.0.0.1:7331',
  token = process.env['SINGULARITY_TOKEN'], cookie = process.env['SINGULARITY_COOKIE'], fetcher = fetch } = {}) {
  const entry = new URL(url)
  if (!['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password)
    throw new Error('SINGULARITY_URL must be an HTTP(S) host URL without embedded credentials')
  token ??= entry.searchParams.get('token') ?? undefined
  entry.search = ''; entry.hash = ''; entry.pathname = '/'
  const secrets = [token, cookie].filter(Boolean)
  const request = async (path, options = {}) => {
    let response
    try { response = await fetcher(new URL(path, entry), { ...options,
      headers: { ...(cookie ? { cookie } : {}), ...options.headers }, signal: AbortSignal.timeout(30_000) }) }
    catch (error) { throw new Error(cleanError(error, secrets)) }
    if (!response.ok) {
      const detail = cleanError(await response.text(), secrets)
      throw new Error(`Host HTTP ${response.status}: ${detail || 'request rejected'}`)
    }
    return response
  }
  if (token) {
    const auth = new URL(entry); auth.searchParams.set('token', token)
    let response
    try { response = await fetcher(auth, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }) }
    catch (error) { throw new Error(cleanError(error, secrets)) }
    if (response.status !== 303) throw new Error(`Host authentication HTTP ${response.status}; provide the current launch token`)
    cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (!cookie) throw new Error('Host authentication returned no session cookie')
    secrets.push(cookie)
  }
  return {
    async rpc(method, input) {
      const response = await request(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: input === undefined ? {} : { request: input } } }) })
      const body = await response.json()
      if (!body.result?.ok) throw new Error(cleanError(JSON.stringify(body.result?.error ?? body), secrets))
      return body.result.value
    },
    async snapshot() {
      const snapshot = await (await request('/singularity/tasks')).json()
      if (snapshot.formatVersion !== 13) throw new Error('Unsupported Singularity snapshot; deploy the current plugin build')
      return snapshot
    },
    async inheritRsi(input) { await request('/singularity/rsi-memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) },
    async cancel(input) {
      return (await request('/singularity/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json()
    },
  }
}

/** Stable native session and prompt identities make exact request redelivery idempotent. */
export async function submitTask(host, content, { requestId = randomUUID(), cwd, previousRootId } = {}) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Task input must be nonempty text or TaskContract JSON')
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('request-id must be nonempty')
  const sessionId = `singularity-${hash(requestId).slice(0, 32)}`
  const created = await host.rpc('session/create', { sessionId, agentPreset: 'singularity-root', ...(cwd ? { cwd: resolve(cwd) } : {}) })
  if (created.sessionId !== sessionId) throw new Error('Host did not preserve the requested native session identity')
  if (previousRootId) await host.inheritRsi({ sessionId, previousRootId })
  await host.rpc('session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: content }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  return { sessionId, requestId }
}

export async function runExperiment(host, rawSuite, options = {}) {
  const [{ parseSuite }, { digestOf }] = await Promise.all([import('../src/measure/suite.ts'), import('../src/protocol/envelope.ts')])
  const suite = parseSuite(rawSuite), snapshot = await host.snapshot(), suiteDigest = digestOf(suite)
  if (snapshot.suiteDigest !== suiteDigest) throw new Error('Suite differs from the host configured domain; deploy this frozen suite before running the experiment')
  const first = suite.cases.find(item => item.split === 'evolve')
  if (!first) throw new Error('Suite has no evolve case')
  const request = await submitTask(host, JSON.stringify({ contract: first.contract, learning: true }), options)
  return { ...request, suiteId: suite.suiteId, suiteDigest,
    expectedEvolveTrials: suite.cases.filter(item => item.split === 'evolve').reduce((sum, item) => sum + item.trials, 0) }
}

export function taskReport(snapshot, id) {
  const task = snapshot.tasks.find(task => task.taskId === id || task.sessionId === id)
  if (!task) throw new Error(`Task ${id} is not present in the committed host snapshot`)
  const descendants = new Set([task.taskId])
  for (;;) {
    const size = descendants.size
    for (const plan of snapshot.plans) if (descendants.has(plan.parentTaskId))
      for (const child of plan.children) descendants.add(child.taskId)
    for (const item of snapshot.tasks) if (descendants.has(item.relatedTo?.taskId)) descendants.add(item.taskId)
    if (size === descendants.size) break
  }
  const related = snapshot.tasks.filter(item => descendants.has(item.taskId))
  const roundIds = new Set(related.flatMap(item => [item.taskId, item.transfer?.roundId, `${item.taskId}:heldout`]).filter(Boolean))
  const rounds = snapshot.rounds.filter(round => roundIds.has(round.plan?.campaignId))
  const revisions = [...rounds.flatMap(round => (round.submissions ?? []).map(s => s.revision)),
    ...related.flatMap(item => (item.search?.batches ?? []).flatMap(batch => batch.outcomes.map(o => o.revision).filter(Boolean)))]
  return { formatVersion: 1, controlId: snapshot.controlId, cutoff: snapshot.cutoff, suiteDigest: snapshot.suiteDigest,
    task, tasks: related,
    campaigns: related.filter(item => item.purpose === 'improve').map(item => ({ campaignId: item.taskId, closure: item.closure, search: item.search })),
    rounds,
    releases: snapshot.releases, methods: snapshot.methods,
    evidence: { reviews: snapshot.reviews.filter(review => descendants.has(review.target?.taskId) ||
      revisions.some(r => r.environmentId === review.target?.environmentId && r.revisionId === review.target?.revisionId)),
      consumption: snapshot.consumption.filter(item => descendants.has(item.taskId)) } }
}

export async function waitForTask(host, sessionId, { learning = false, signal, onUpdate = () => {} } = {}) {
  let previous
  for (;;) {
    signal?.throwIfAborted()
    const snapshot = await host.snapshot()
    const task = snapshot.tasks.find(task => task.sessionId === sessionId)
    if (task) {
      const progress = JSON.stringify({ phase: task.phase, closure: task.closure, rsi: task.rsi, search: task.search })
      if (progress !== previous) { previous = progress; onUpdate(task) }
      if (task.closure && (!learning || task.learning === false || task.closure.reason === 'cancelled' ||
        ['completed', 'failed', 'cancelled'].includes(task.rsi?.status))) return taskReport(snapshot, sessionId)
    }
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); done() }, 1000)
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

export async function doctor({ domain, input, workspace, host = false } = {}) {
  const checks = []
  const check = async (name, work) => {
    try { checks.push({ name, ok: true, detail: await work() }) }
    catch (error) { checks.push({ name, ok: false, detail: cleanError(error) }) }
  }
  await check('Node', () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || major === 22 && minor < 19) throw new Error('Node >=22.19.0 is required')
    return process.versions.node
  })
  await check('pnpm', async () => {
    const version = execFileSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
    const expected = JSON.parse(await readFile(join(CHECKOUT, 'package.json'), 'utf8')).packageManager.replace('pnpm@', '')
    if (expected !== version) throw new Error(`pnpm ${expected} is required; found ${version}`)
    return version
  })
  await check('private DSH', () => {
    const installed = hostInstall(), findings = hostFindings(installed)
    if (findings.length) throw new Error(findings.join('; '))
    hostRequire(installed).resolve('@deepseek-ai/dsh-session')
    return 'pinned package versions and patched host artifacts verified'
  })
  await check('bubblewrap', () => execFileSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim())
  await check('host lifetime lock', () => execFileSync('flock', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim())
  if (input) await check('Task input', async () => {
    const text = await readFile(resolve(input), 'utf8')
    if (!text.trim()) throw new Error('Task input is empty')
    if (input.endsWith('.json')) {
      const { assertContract } = await import('../src/task/contract.ts')
      assertContract(JSON.parse(text), 'Task input')
    }
    return 'readable'
  })
  if (domain) await check('domain', async () => {
    await import('./dsh-control-runtime.mjs')
    const [{ loadDomain }, { spawnProcess }] = await Promise.all([import('../assembly/src/domain.ts'), import('../assembly/src/process.ts')])
    const loaded = await loadDomain(resolve(domain), spawnProcess)
    for (const path of loaded.references) await access(path, constants.R_OK)
    return `${loaded.templates.size} templates; ${loaded.inputs.length} inputs; references readable`
  })
  await check('workspace', async () => {
    const path = resolve(workspace || process.env['DSH_HOME'] || join(CHECKOUT, '.singularity/home'))
    await mkdir(path, { recursive: true }); await access(path, constants.W_OK)
    return path
  })
  if (host) await check('host/model route', async () => {
    const client = await connectHost()
    const catalog = await client.rpc('session/modelCatalog')
    if (!catalog.default || !catalog.routableProviders?.length) throw new Error('No available model route; configure provider credentials in the private DSH home')
    await client.snapshot()
    return `${catalog.default.provider}/${catalog.default.model}`
  })
  return { ok: checks.every(item => item.ok), checks }
}

function parseOptions(args) {
  const positional = [], options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const key = arg.slice(2)
    if (!['wait', 'wait-learning', 'host', 'json', 'domain', 'input', 'workspace', 'request-id', 'cwd', 'learning', 'output', 'patch', 'reviewer'].includes(key))
      throw new Error(`Unknown option ${arg}`)
    if (['wait', 'wait-learning', 'host', 'json'].includes(key)) options[key] = true
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`); options[key] = args[++i] }
  }
  return { positional, options }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) args = ['help']
  const { positional: [kind, action, file], options } = parseOptions(args)
  if (!kind || kind === 'help') {
    console.log('singularity env setup REQUEST --workspace DIR [--patch MODEL-ROUTE.yml]\nsingularity env approve DIR [--reviewer NAME]\nsingularity doctor [--domain DIR] [--input FILE] [--workspace DIR] [--host]\nsingularity task run FILE [--request-id ID] [--cwd DIR] [--learning on|off] [--wait] [--wait-learning]\nsingularity task status ID\nsingularity task cancel SESSION-ID\nsingularity experiment run SUITE [--request-id ID] [--cwd DIR] [--wait]\nsingularity experiment report TASK-OR-SESSION-ID [--output FILE]\nHost: SINGULARITY_URL and SINGULARITY_TOKEN (or SINGULARITY_COOKIE). Environment setup uses native headless DSH and an explicit DSH_HOME.')
    return
  }
  if (kind === 'doctor') {
    const report = await doctor({ domain: options.domain, input: options.input, workspace: options.workspace, host: options.host })
    console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; return
  }
  if (kind === 'env') {
    if (!file) throw new Error('env setup requires a request file; env approve requires the staging directory')
    const { runEnvironmentSetup, approveEnvironmentSetup } = await import('./env-setup.mjs')
    if (action === 'setup') {
      const result = await runEnvironmentSetup({ request: await readFile(resolve(file), 'utf8'), workspace: options.workspace, patch: options.patch })
      console.log(JSON.stringify(result, null, 2))
      console.error(`Review ${result.review}, then run singularity env approve ${result.workspace}. No RSI task has started.`)
      return
    }
    if (action === 'approve') {
      console.log(JSON.stringify(await approveEnvironmentSetup(file, { reviewer: options.reviewer }), null, 2))
      return
    }
    throw new Error('Unknown environment command; use env setup or env approve')
  }
  if (!file) throw new Error('A Task file, suite file or Task/session identity is required; run singularity help')
  const host = await connectHost()
  if (action === 'run' && ['task', 'experiment'].includes(kind)) {
    let content = await readFile(resolve(file), 'utf8')
    if (options.learning && !['on', 'off'].includes(options.learning)) throw new Error('--learning must be on or off')
    if (kind === 'experiment' && options.learning === 'off') throw new Error('A suite experiment requires learning; use task run --learning off for a business task')
    const learning = kind === 'experiment' || options.learning !== 'off'
    if (kind === 'task' && file.endsWith('.json')) {
      const { assertContract } = await import('../src/task/contract.ts')
      assertContract(JSON.parse(content), 'Task input')
    }
    if (options.learning && kind === 'task') {
      let contract
      try { contract = JSON.parse(content) } catch { throw new Error('--learning requires a complete TaskContract JSON file') }
      content = JSON.stringify({ contract, learning })
    }
    const requestOptions = { requestId: options['request-id'], cwd: options.cwd }
    const request = kind === 'experiment' ? await runExperiment(host, JSON.parse(content), requestOptions) : await submitTask(host, content, requestOptions)
    console.log(JSON.stringify(request))
    if (options.wait || options['wait-learning']) console.log(JSON.stringify(await waitForTask(host, request.sessionId, { learning: learning && (kind === 'experiment' || options['wait-learning']),
      onUpdate: task => console.error(`${task.taskId}: ${task.phase}; RSI ${task.rsi?.status ?? 'pending'}`) }), null, 2))
    return
  }
  if (kind === 'task' && action === 'cancel') { console.log(JSON.stringify(await host.cancel({ sessionId: file }))); return }
  if (kind === 'task' && action === 'status' || kind === 'experiment' && action === 'report') {
    const report = taskReport(await host.snapshot(), file), bytes = JSON.stringify(report, null, 2) + '\n'
    if (options.output) { const path = resolve(options.output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); console.log(path) }
    else console.log(bytes)
    return
  }
  throw new Error('Unknown command; run singularity help')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(`singularity: ${cleanError(error, [process.env['SINGULARITY_TOKEN'], process.env['SINGULARITY_COOKIE']])}`); process.exitCode = 1 })

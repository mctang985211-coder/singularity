import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const run = promisify(execFile)
const smoke = `
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [checkout, root] = process.argv.slice(2)
const { dshModule, DSH_INSTALLED } = await import(pathToFileURL(join(checkout, 'scripts/dsh-control-runtime.mjs')).href)
const [{ Context }, { Loader, Group }, { entryListSchema }, { default: Presets },
  { default: Llm }, { default: Sessions, SessionId }, { default: Projections },
  { default: SystemPrompt }, { default: Tools, defineTool }, { default: Commands },
  { default: Agents }, { default: Persistence }, { default: Fs }, { default: Subprocess }, { default: Attachments }, { default: AgentLoop }, { default: Skills }, ShellEnv, { default: TokenMeter }, LlmRetry] =
  await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-attachment-local', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-shell-env', '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-llm-retry'].map(dshModule))
const yaml = createRequire(join(DSH_INSTALLED, 'cordis-plugin-include/package.json'))('js-yaml')
const pkg = createRequire(join(root, 'host.mjs'))
const host = await import(pathToFileURL(pkg.resolve('@dangosys/dsh-singularity-next')).href)
const web = await import(pathToFileURL(pkg.resolve('@dangosys/dsh-singularity-next/web')).href)
const rows = []
for (const id of ['singularity-root', 'singularity-next', 'singularity-review', 'singularity-improve']) {
  const row = yaml.load(await readFile(join(checkout, 'assembly/presets', id + '.patch.yml'), 'utf8'), { schema: entryListSchema })[0].insert[0]
  rows.push({ ...row, config: { ...row.config, plugins: row.config.plugins.filter(plugin => plugin.id === 'singularity-agent') } })
}
const config = join(root, 'cordis.yml')
await writeFile(config, yaml.dump(rows, { schema: entryListSchema, noRefs: true }))
const ctx = new Context()
let mutations = 0
const probe = name => defineTool({ name, description: 'Execution probe', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => { mutations++; return 'executed' } })
try {
  for (const plugin of [Llm, Sessions, Projections, SystemPrompt, Tools, Commands, Agents, Subprocess, Skills, ShellEnv, TokenMeter]) await ctx.plugin(plugin)
  await ctx.plugin(Fs, { cwd: root })
  await ctx.plugin(Attachments, { dshHome: root })
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmRetry)
  const spawns = [], spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => { spawns.push(spec); return spawn(spec) }
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(config).href })
  ctx.loader.builtins.group = Group
  await ctx.plugin(Presets, { default: 'singularity-root' })
  const hostConfig = { controlId: 'root-tools', domainDir: join(checkout, 'domain/reference'), workspaceRoot: join(root, 'workspaces') }
  let hostFiber = ctx.plugin(host, hostConfig)
  await hostFiber
  const routes = new Map()
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
  ctx.provide('connection', { requestRejection(request) { return request.headers.authorization === 'test-session' ? undefined : 401 } })
  await ctx.plugin(web)
  const request = async (path, method, authenticated = true, payload) => {
    let body = '', statusCode = 200
    const headers = {}
    const response = { get statusCode() { return statusCode }, set statusCode(value) { statusCode = value },
      setHeader(key, value) { headers[key] = value }, end(value = '') { body = value } }
    await routes.get(path).handler({ url: path, method, headers: { authorization: authenticated ? 'test-session' : '' },
      async *[Symbol.asyncIterator]() { if (payload !== undefined) yield JSON.stringify(payload) } }, response)
    return { statusCode, headers, body }
  }
  assert.equal((await request('/singularity/rsi-memory', 'GET')).statusCode, 405)
  assert.equal((await request('/singularity/rsi-memory', 'POST', false)).statusCode, 401)
  assert.equal(JSON.parse((await request('/singularity/tasks', 'GET')).body).formatVersion, 13)
  await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  ctx.tools.register(probe('deployment_probe'))
  const { agent } = await ctx.agents.create({ sessionId: SessionId('root'), meta: { cwd: root },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') } })
  assert.equal(ctx.agentPresets.serviceFor(agent, 'singularityAgentRole'), 'root')
  assert.equal((await request('/singularity/rsi-memory', 'POST', true, { sessionId: 'root', previousRootId: 'unknown' })).statusCode, 400)
  assert.equal(ctx.tools.get('deployment_probe', agent), undefined)
  // Own-scope tools bypass native restrict(), even when they were registered after agent/created.
  for (const name of ['bash', 'pwsh']) agent.ctx.tools.register(probe(name))
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(prompt.tools.map(tool => tool.name).sort(), ['read', 'read_image', 'glob', 'grep',
    'singularity_read', 'singularity_memory', 'singularity_submit', 'singularity_decompose_task', 'singularity_stop_explorations', 'singularity_answer', 'singularity_retry_task'].sort())
  assert(!prompt.sections.some(section => ['tool:bash', 'tool:pwsh', 'tool:write', 'tool:edit'].includes(section.name)))
  const rootProtocol = prompt.sections.find(section => section.name === 'singularity:protocol').text
  assert(rootProtocol.includes('reference trees are read-only'))
  assert(rootProtocol.includes('sealed artifacts and declared artifact inputs'))
  assert(rootProtocol.includes('independent root acceptance'))
  const execute = (name, args) => ctx.tools.execute({ name, arguments: args, agent, callId: 'probe-' + name, signal: new AbortController().signal })
  for (const [name, args] of [['bash', {}], ['pwsh', {}], ['write', { file_path: 'result.txt', content: 'mutation' }],
    ['edit', { file_path: 'result.txt', old_string: 'evidence', new_string: 'mutation' }]]) {
    const result = await execute(name, args)
    assert.equal(result.isError, true, JSON.stringify(result))
    assert(JSON.stringify(result).includes('Root delegates'), JSON.stringify(result))
  }
  assert.equal(mutations, 0)
  const workspace = ctx.singularity.world(String(agent.id)).root
  await writeFile(join(workspace, 'evidence.txt'), 'bounded evidence\\n')
  for (const [name, args] of [['read', { file_path: 'evidence.txt' }], ['glob', { pattern: '*.txt' }], ['grep', { pattern: 'bounded' }]]) {
    const result = await execute(name, args)
    assert(!result.isError, JSON.stringify(result))
    assert(JSON.stringify(result).includes('evidence'), JSON.stringify({ name, result, workspace, cwd: agent.session.header.cwd, spawns }))
  }
  assert(spawns.every(spec => spec.argv[0] === '/usr/bin/bwrap' && spec.argv.includes('--ro-bind')), 'Search bypassed Bubble')
  const denied = await execute('read', { file_path: join(root, 'cordis.yml') })
  assert.equal(denied.isError, true)
  assert(JSON.stringify(denied).includes('Bubble read denied'), JSON.stringify(denied))
  const { agent: child } = await ctx.agents.create({ sessionId: SessionId('child'), meta: { cwd: root },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-next') } })
  const childPrompt = await ctx.systemPrompt.assemble({ scope: child })
  assert.equal(ctx.agentPresets.serviceFor(child, 'singularityAgentRole'), 'task')
  for (const name of ['bash', 'write', 'edit', 'singularity_decompose_task']) assert(childPrompt.tools.some(tool => tool.name === name), name)
  const childProtocol = childPrompt.sections.find(section => section.name === 'singularity:protocol').text
  assert(childProtocol.includes('use singularity_ask_parent and end the turn'))
  assert(childProtocol.includes('Do not request escalation or bypass isolation'))
  assert(!childProtocol.includes('You must decompose'))
  const written = await ctx.tools.execute({ name: 'write', arguments: { file_path: 'result.txt', content: 'child implementation' },
    agent: child, callId: 'child-write', signal: new AbortController().signal })
  assert(!written.isError, JSON.stringify(written))
  assert.equal(await readFile(join(ctx.singularity.world(String(child.id)).root, 'result.txt'), 'utf8'), 'child implementation')
  const { LlmAdapter, createUserMessage, resolveRetryPolicy } = await dshModule('@deepseek-ai/dsh-llm')
  const inheritedDecision = 'Use the producer result because an independent count avoids repeated extraction.'
  const requests = []
  let providerUnavailable = false
  class MemoryModel extends LlmAdapter {
    providerRetryPolicy() {
      return resolveRetryPolicy({ mode: 'normal', maxRetries: 20,
        backoff: { initialDelayMs: 500, maxDelayMs: 180_000, jitterRatio: 0.1 } }, 'root tools fixture')
    }
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      const summary = options.messages[0]?.content.some(block => block.type === 'text' && block.text.startsWith('Summarize parent conversation data'))
      if (options.model === 'partial-transport' && requests.filter(request => request.sessionId === options.sessionId).length === 1 ||
          !summary && options.model === 'failed-task' && providerUnavailable) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'partial reasoning before disconnect' }
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'terminated' } } }
        return
      }
      if (summary && options.model === 'failed-summary') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream temporarily unavailable before output' } } }
        return
      }
      const text = summary ? JSON.stringify({ decisions: [inheritedDecision], evidenceRefs: [], hypotheses: ['The parent claim is provisional.'], openQuestions: [], exclusions: [] })
        : 'I have recorded a working observation; no acceptance is claimed.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['memory-probe'], new MemoryModel())
  const { agent: reviewer } = await ctx.agents.create({ sessionId: SessionId('reviewer'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'test', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-review') } })
  const reviewPrompt = await ctx.systemPrompt.assemble({ scope: reviewer })
  const reviewProtocol = reviewPrompt.sections.find(section => section.name === 'singularity:protocol').text
  assert(reviewProtocol.includes('without repairing the subject'))
  assert(reviewProtocol.includes('Proposal/publication reviews use only the frozen subject'))
  assert(reviewProtocol.includes('protected inputs and reference trees are read-only'))
  // A synthetic assignment exercises native delivery without starting or accepting a business Task.
  reviewer.followup(createUserMessage({ source: { kind: 'singularity', purpose: 'dispatch', controlId: 'root-tools',
    parentTaskId: 'protocol-probe', taskId: 'protocol-probe', runId: 'protocol-probe', factSeq: 0 },
    content: [{ type: 'text', text: 'Review protocol delivery fixture; no acceptance result is requested.' }] }))
  await reviewer.whenIdle()
  assert(await ctx.sessions.flush(reviewer.session))
  const { agent: improver } = await ctx.agents.create({ sessionId: SessionId('improver'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'test', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-improve') } })
  assert.equal(ctx.agentPresets.serviceFor(improver, 'singularityAgentRole'), 'improve')
  const improvePrompt = await ctx.systemPrompt.assemble({ scope: improver })
  const improveProtocol = improvePrompt.sections.find(section => section.name === 'singularity:protocol').text
  improver.followup(createUserMessage({ source: { kind: 'singularity', purpose: 'dispatch', controlId: 'root-tools',
    parentTaskId: 'improve-protocol-probe', taskId: 'improve-protocol-probe', runId: 'improve-protocol-probe', factSeq: 0 },
    content: [{ type: 'text', text: 'RSI protocol delivery fixture; no proposal or acceptance result is requested.' }] }))
  await improver.whenIdle()
  assert(await ctx.sessions.flush(improver.session))
  const { agent: parent } = await ctx.agents.create({ sessionId: SessionId('memory-parent'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'test', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') } })
  const parentGoal = 'Count the source for the unique parent background probe.'
  parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: parentGoal }] }))
  await parent.whenIdle()
  const delegated = await ctx.tools.execute({ name: 'singularity_decompose_task', agent: parent, callId: 'memory-decomposition', signal: new AbortController().signal,
    arguments: { children: [{ key: 'background-child', contract: { goal: 'Investigate the frozen source without repeating delegated work.',
      artifact: 'finding.txt', inputs: [], criteria: [{ criterionId: 'finding', statement: 'The artifact records an honest bounded finding.' }] },
      requirement: 'required', dependsOn: [], supports: ['letters'], maxRuns: 1 }] } })
  assert(!delegated.isError && !JSON.stringify(delegated).includes('refused'), JSON.stringify(delegated))
  const state = await ctx.singularity.read()
  const childTask = state.tasks.find(task => task.goal === 'Investigate the frozen source without repeating delegated work.')
  assert(childTask?.sessionId, JSON.stringify(state))
  const assigned = ctx.agents.get(SessionId(childTask.sessionId))
  assert(assigned, 'The delegated native child agent is missing')
  await assigned.whenIdle()
  assert(await ctx.sessions.flush(parent.session))
  assert(await ctx.sessions.flush(assigned.session))
  const handle = await ctx.sessionPersistence.open(parent.session.id, 'read')
  let parentEvents
  try { parentEvents = (await handle.read()).events } finally { await handle.close() }
  const checkpoints = parentEvents.filter(event => event.type === 'singularity/parent-memory')
  assert.equal(checkpoints.length, 0, 'Child dispatch must not buy an unsolicited background summary')
  assert.equal(parentEvents.filter(event => event.type.startsWith('compaction/')).length, 0)
  const childRequest = requests.find(request => request.sessionId === assigned.session.id)
  assert(childRequest, 'The child did not begin its native model request')
  const parentRequest = requests.find(request => request.sessionId === parent.session.id)
  const reviewRequest = requests.find(request => request.sessionId === reviewer.session.id)
  const improveRequest = requests.find(request => request.sessionId === improver.session.id)
  assert(improveRequest, 'The RSI agent did not begin its native model request')
  const systemText = request => request.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\\n')
  assert(systemText(parentRequest).includes(rootProtocol), 'Root protocol was assembled but not delivered to the model')
  assert(systemText(parentRequest).includes('host-owned template checks run after artifact sealing, not as child commands or extra child criteria'), 'Root lacks the host-check delegation boundary')
  assert(systemText(childRequest).includes(childProtocol), 'Task protocol was assembled but not delivered to the model')
  assert(systemText(reviewRequest).includes(reviewProtocol), 'Review protocol was assembled but not delivered to the model')
  assert(systemText(improveRequest).includes(improveProtocol), 'RSI protocol was assembled but not delivered to the model')
  assert(systemText(improveRequest).includes('Business roots only read, delegate and submit verified child artifacts.'), 'RSI author lacks the business root capability boundary')
  assert(systemText(improveRequest).includes('Keep commands, implementation and integration in delegated Tasks'), 'RSI author lacks the executable delegation route')
  let flowOffset = 0
  for (const [phase, pattern] of [
    ['search state', /singularity_read[^\\n]*search/i],
    ['frozen evidence', /subject[\\s\\S]*?trajectory/i],
    ['edits', /edit\\.changes/],
    ['host handoff', /singularity_propose_method[\\s\\S]*?admission returns immediately[\\s\\S]*?end the turn/i],
    ['final report', /search\\.authoring\\.report[\\s\\S]*?singularity_submit/i],
  ]) {
    const match = pattern.exec(improveProtocol.slice(flowOffset))
    assert(match, 'RSI system lacks the ordered ' + phase + ' stage')
    flowOffset += match.index + match[0].length
  }
  assert.deepEqual(improveRequest.tools.map(tool => tool.name).sort(), ['read', 'glob', 'grep', 'write', 'edit',
    'singularity_read', 'singularity_memory', 'singularity_propose_method', 'singularity_submit'].sort())
  for (const name of ['singularity_read', 'singularity_propose_method', 'singularity_submit'])
    assert.deepEqual(improveRequest.tools.find(tool => tool.name === name).parameters,
      improvePrompt.tools.find(tool => tool.name === name).parameters, 'The native RSI request changed the ' + name + ' schema')
  const improveTool = name => improveRequest.tools.find(tool => tool.name === name)
  assert.deepEqual(Object.keys(improveTool('singularity_propose_method').parameters.properties), ['paths'])
  assert.deepEqual(improveTool('singularity_propose_method').parameters.required, ['paths'])
  assert.equal(improveTool('singularity_propose_method').parameters.properties.paths.items.type, 'string')
  assert(improveTool('singularity_propose_method').description.includes('edit.changes'))
  const improveRead = improveTool('singularity_read').parameters.properties
  for (const kind of ['search', 'method', 'subject', 'trajectory', 'round', 'roots', 'sessions', 'usage', 'steps']) assert(improveRead.kind.enum.includes(kind), kind)
  assert.equal(improveRead.rootId.type, 'string')
  assert.equal(improveRead.eventSeq.type, 'integer')
  assert(improveTool('singularity_read').description.includes('phase'))
  assert(!systemText(childRequest).includes(rootProtocol), 'Child inherited root-only coordination instructions')
  const submitFields = request => Object.keys(request.tools.find(tool => tool.name === 'singularity_submit').parameters.properties).sort()
  assert.deepEqual(submitFields(parentRequest), ['sourceRunId', 'sourceTaskId'])
  assert.deepEqual(submitFields(childRequest), ['path'])
  assert.deepEqual(submitFields(reviewRequest), ['path'])
  assert.equal(reviewRequest.tools.find(tool => tool.name === 'singularity_read').parameters.properties.rootId.type, 'string')
  assert.deepEqual(submitFields(improveRequest), ['path'])
  assert(!reviewRequest.tools.some(tool => ['singularity_ask_parent', 'singularity_propose_method'].includes(tool.name)))
  assert(parentRequest.tools.every(tool => !['bash', 'write', 'edit', 'singularity_ask_parent'].includes(tool.name)))
  for (const name of ['bash', 'write', 'edit', 'singularity_ask_parent']) assert(childRequest.tools.some(tool => tool.name === name), name)
  assert(childRequest.tools.find(tool => tool.name === 'singularity_ask_parent').description.includes('cannot alter the frozen contract'))
  for (const [liveAgent, nativeRequest] of [[assigned, childRequest], [improver, improveRequest]]) {
    const nativeLog = await ctx.sessionPersistence.open(liveAgent.session.id, 'read')
    try {
      const events = (await nativeLog.read()).events
      const deliveredSystem = events.find(event => event.type === 'system/message').data.message
      assert.equal(deliveredSystem.content.filter(block => block.type === 'text').map(block => block.text).join('\\n'), systemText(nativeRequest))
      assert.deepEqual(events.find(event => event.type === 'request/header').data.header.tools, nativeRequest.tools)
    } finally { await nativeLog.close() }
  }
  assert(!JSON.stringify(childRequest.messages).includes(inheritedDecision), 'Background was injected before the child chose to read it')
  assert(childRequest.tools.some(tool => tool.name === 'singularity_memory'))
  const directory = await ctx.tools.execute({ name: 'singularity_memory', agent: assigned, arguments: {}, callId: 'optional-memory-index', signal: new AbortController().signal })
  assert(!directory.isError, JSON.stringify(directory))
  assert(!JSON.stringify(directory).includes(inheritedDecision), 'The directory must not copy background narrative')
  const index = JSON.parse(directory.value)
  assert.equal(index.total, 1)
  assert.equal(index.inherited, index.entries[0].ref)
  const summaryRequests = () => requests.filter(request => request.messages[0]?.content.some(block =>
    block.type === 'text' && block.text.startsWith('Summarize parent conversation data')))
  assert.equal(summaryRequests().length, 1, 'Only an explicit memory request generates background')
  await ctx.tools.execute({ name: 'singularity_memory', agent: assigned, arguments: {}, callId: 'optional-memory-again', signal: new AbortController().signal })
  assert.equal(summaryRequests().length, 1, 'Repeated reads reuse the durable checkpoint')
  const rootDirectory = await ctx.tools.execute({ name: 'singularity_memory', agent: parent, arguments: {}, callId: 'root-memory-index', signal: new AbortController().signal })
  assert(!rootDirectory.isError, JSON.stringify(rootDirectory))
  assert.equal(JSON.parse(rootDirectory.value).inherited, null)
  assert.equal(JSON.parse(rootDirectory.value).entries[0].ref, index.inherited)
  const background = await ctx.tools.execute({ name: 'singularity_memory', agent: assigned, arguments: { ref: index.inherited }, callId: 'optional-memory-read', signal: new AbortController().signal })
  assert(!background.isError && JSON.stringify(background).includes(inheritedDecision), JSON.stringify(background))
  const pendingPrompt = await ctx.systemPrompt.assemble({ scope: parent, agent: parent })
  assert(!pendingPrompt.contexts.some(context => ['singularity:responsibility', 'singularity:rsi-state'].includes(context.name)))
  const liveSummary = await ctx.tools.execute({ name: 'singularity_read', agent: parent, arguments: { kind: 'summary' }, callId: 'explicit-responsibility', signal: new AbortController().signal })
  const responsibility = JSON.parse(liveSummary.value).coordination
  assert(responsibility.waiting !== null)
  assert(!pendingPrompt.sections.some(section => section.text.includes(parentGoal)), 'Task goals must not enter system instructions')
  const pendingAllowed = new Set(['read', 'read_image', 'glob', 'grep', 'singularity_read', 'singularity_memory', 'singularity_answer', 'singularity_ask_parent', 'singularity_stop_explorations', 'singularity_retry_task', 'singularity_decompose_task'])
  assert(pendingPrompt.tools.every(tool => pendingAllowed.has(tool.name)), JSON.stringify(pendingPrompt.tools.map(tool => tool.name)))
  assert(pendingPrompt.tools.some(tool => tool.name === 'singularity_decompose_task'))
  assert(!pendingPrompt.tools.some(tool => tool.name === 'singularity_submit'))
  const nativeTimeout = globalThis.setTimeout
  let retryWaits = 0
  // Speed up native retry waits while leaving JSONL persistence timers intact.
  const isRetryWait = delay => typeof delay === 'number' && delay >= 450 && delay <= 180_000
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (isRetryWait(delay)) retryWaits++
    return nativeTimeout(callback, isRetryWait(delay) ? 1 : delay, ...args)
  }
  const { agent: brokenParent } = await ctx.agents.create({ sessionId: SessionId('provider-failure-parent'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'failed-summary', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') } })
  brokenParent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Investigate an unavailable parent background.' }] }))
  await brokenParent.whenIdle()
  const failure = await ctx.tools.execute({ name: 'singularity_decompose_task', agent: brokenParent,
    callId: 'summary-failure', signal: new AbortController().signal, arguments: { children: [{ key: 'provider-child',
      contract: { goal: 'Investigate provider-child', artifact: 'finding.txt', inputs: [],
        criteria: [{ criterionId: 'finding', statement: 'An honest bounded finding.' }] },
      requirement: 'required', dependsOn: [], supports: ['letters'], maxRuns: 1 }] } })
  assert(!failure.isError, JSON.stringify(failure))
  await Promise.all(ctx.agents.list().map(agent => agent.whenIdle()))
  assert.equal(retryWaits, 0)
  assert.equal(requests.filter(request => request.model === 'failed-summary' && request.messages[0]?.content.some(block =>
    block.type === 'text' && block.text.startsWith('Summarize parent conversation data'))).length, 0)
  const beforeProviderFailure = await ctx.singularity.read()
  assert(beforeProviderFailure.tasks.every(task => task.phase !== 'failed' && task.rsi === null), JSON.stringify(beforeProviderFailure))
  const backgroundChild = beforeProviderFailure.tasks.find(task => task.goal === 'Investigate provider-child')
  assert(requests.some(request => request.sessionId === backgroundChild.sessionId), 'Business execution must start without a background call')
  const failedMemory = await ctx.tools.execute({ name: 'singularity_memory', agent: ctx.agents.get(SessionId(backgroundChild.sessionId)),
    arguments: {}, callId: 'failed-background-index', signal: new AbortController().signal })
  assert(!failedMemory.isError, JSON.stringify(failedMemory))
  const summaryLog = await ctx.sessionPersistence.open(brokenParent.session.id, 'read')
  try {
    const events = (await summaryLog.read()).events
    const settled = events.find(event => event.type === 'singularity/memory-call' && event.data.phase === 'settled')
    assert(settled?.data.stream.some(record => record.chunk?.type === 'finish' && record.chunk.reason.failure?.code === 'SERVER'),
      'The failed raw background call must remain visible in native evidence')
    assert.equal(events.filter(event => event.type === 'singularity/parent-memory-failed').length, 1)
    assert.equal(events.filter(event => event.type === 'llm/retry').length, 0)
  } finally { await summaryLog.close() }
  const failedDirectory = JSON.parse(failedMemory.value)
  assert(failedDirectory.entries.some(entry => entry.ref === failedDirectory.inherited && entry.status === 'failed' && entry.error.includes('temporarily unavailable')),
    JSON.stringify(failedDirectory))
  const taskRequest = goal => JSON.stringify({ learning: false, contract: {
    goal, artifact: 'finding.txt', inputs: [], criteria: [{ criterionId: 'finding', statement: 'An honest bounded finding.' }],
  } })
  const { agent: recovered } = await ctx.agents.create({ sessionId: SessionId('partial-transport-recovery'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'partial-transport', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') } })
  recovered.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: taskRequest('Recover a partial transport failure.') }] }))
  await recovered.whenIdle()
  assert(await ctx.sessions.flush(recovered.session))
  assert.equal(requests.filter(request => request.sessionId === recovered.session.id).length, 2)
  assert.equal(retryWaits, 1)
  const recoveredEvents = recovered.session.snapshotEvents()
  assert.equal(recoveredEvents.filter(event => event.type === 'assistant/attempt').length, 1)
  assert.equal(recoveredEvents.filter(event => event.type === 'llm/retry' && event.data.failure.code === 'TRANSPORT').length, 1)
  assert.equal(recoveredEvents.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert(!(await ctx.singularity.read()).tasks.find(task => task.sessionId === recovered.session.id).runs.at(-1).detail)

  providerUnavailable = true
  const { agent: brokenMain } = await ctx.agents.create({ sessionId: SessionId('provider-main-failure'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'failed-task', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') } })
  brokenMain.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: taskRequest('Keep the native transport failure after retry exhaustion.') }] }))
  await brokenMain.whenIdle()
  assert(await ctx.sessions.flush(brokenMain.session))
  const failed = await ctx.singularity.read()
  const failedTask = failed.tasks.find(task => task.sessionId === brokenMain.session.id)
  assert.equal(failedTask.phase, 'failed')
  assert.equal(failedTask.closure.reason, 'failed')
  assert.equal(JSON.parse(failedTask.runs.at(-1).detail).reason.error.code, 'TRANSPORT')
  assert.equal(retryWaits, 21)
  assert.equal(requests.filter(request => request.sessionId === brokenMain.session.id).length, 21)
  assert.equal(failed.tasks.find(task => task.sessionId === recovered.session.id).phase, 'running')
  const mainEvents = brokenMain.session.snapshotEvents()
  assert.equal(mainEvents.filter(event => event.type === 'llm/retry').length, 20)
  assert.equal(mainEvents.filter(event => event.type === 'llm/retry-started').length, 20)
  assert.equal(mainEvents.findLast(event => event.type === 'turn/end').data.reason.error.code, 'TRANSPORT')
  await hostFiber.dispose()
  hostFiber = ctx.plugin(host, hostConfig)
  await hostFiber
  assert.equal((await ctx.singularity.read()).tasks.find(task => task.sessionId === brokenMain.session.id).phase, 'failed')
  providerUnavailable = false
  const { agent: healthy } = await ctx.agents.create({ sessionId: SessionId('healthy-after-failure'), meta: { cwd: root },
    agentOptions: { provider: 'memory-probe', model: 'test', maxTokens: 512 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-root') } })
  healthy.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: taskRequest('Continue independent work after another Task failed.') }] }))
  await healthy.whenIdle()
  assert.equal(requests.filter(request => request.sessionId === healthy.session.id).length, 1)
  assert.equal(healthy.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  globalThis.setTimeout = nativeTimeout
  assert(!('budget' in ctx.singularity), 'The host must not install a campaign budget gate')
  console.log('all four role protocols and RSI schemas delivered; root confined reads pass; own mutations denied; child execution retained; on-demand optional parent memory and pending responsibility pass')
} finally { await ctx.fiber.dispose() }
`

it('delivers all four native role protocols and RSI schemas with root restrictions, optional child memory and pending responsibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'root-tools-'))
  try {
    await mkdir(join(root, 'node_modules/@dangosys'), { recursive: true })
    await symlink(join(checkout, 'assembly'), join(root, 'node_modules/@dangosys/dsh-singularity-next'))
    const script = join(root, 'host.mjs')
    await writeFile(script, smoke)
    const { stdout } = await run(process.execPath, [script, checkout, root], { timeout: 20_000 })
    expect(stdout.trim()).toBe('all four role protocols and RSI schemas delivered; root confined reads pass; own mutations denied; child execution retained; on-demand optional parent memory and pending responsibility pass')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 25_000)

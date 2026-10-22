import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const run = promisify(execFile)

// Run the shipped face and native Loader in one Node module graph, as a deployed host does.
const smoke = `
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [checkout, root] = process.argv.slice(2)
const { dshModule, DSH_INSTALLED } = await import(pathToFileURL(join(checkout, 'scripts/dsh-control-runtime.mjs')).href)
const [{ Context }, { Loader, Group }, { entryListSchema }, { default: PresetRegistry },
  { default: LlmRuntime, LlmAdapter, createUserMessage }, { default: Sessions, SessionId },
  { default: Projections }, { default: SystemPrompt }, { default: Tools, defineTool }, { default: Commands },
  { default: Agents }, { default: Persistence }, { default: AgentLoop }, { default: TokenMeter }] =
  await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-token-meter'].map(dshModule))
const nativeRequire = createRequire(join(DSH_INSTALLED, 'cordis-plugin-include/package.json'))
const yaml = nativeRequire('js-yaml')
const packageRequire = createRequire(join(root, 'host.mjs'))
const { BasicCompactionEngine } = await dshModule('@deepseek-ai/dsh-compaction-basic')
const { mountCampaignMemory } = await import(pathToFileURL(packageRequire.resolve('@dangosys/dsh-singularity-next')).href)
const declarations = []
for (const id of ['singularity-root', 'singularity-next', 'singularity-review', 'singularity-improve']) {
  const patch = yaml.load(await readFile(join(checkout, 'assembly/presets', id + '.patch.yml'), 'utf8'), { schema: entryListSchema })
  const declaration = patch[0].insert[0]
  const group = declaration.config.plugins.find(row => row.id === 'compaction')
  assert.equal(group.name, 'cordis:group')
  assert.equal(group.isolate.compaction, true)
  assert.equal(group.isolate.toolResultPruner, true)
  assert.equal(group.config.find(row => row.id === 'compaction-basic').name, '@deepseek-ai/dsh-compaction-basic')
  declarations.push({ ...declaration, config: { ...declaration.config, plugins: id === 'singularity-root'
    ? [group, declaration.config.plugins.find(row => row.id === 'singularity-agent')] : [group] } })
}
const config = join(root, 'cordis.yml')
await writeFile(config, yaml.dump(declarations, { schema: entryListSchema, noRefs: true }))
const summary = 'A native DSH summary of this session investigation.'
class MockModel extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1000000 } } }
  async *stream(options) {
    this.requests.push(options)
    const text = options.purpose === 'compaction' ? summary : 'A provisional observation.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    const inputTokens = options.purpose === 'compaction' ? 30
      : options.model === 'below-threshold' ? 690000
      : ['truncated-summary', 'threshold-pressure'].includes(options.model) ? 730000 : 30
    yield { type: 'usage', usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 } }
    yield { type: 'finish', reason: { kind: options.model === 'truncated-summary' && options.purpose === 'compaction' ? 'max-tokens' : 'stop' } }
  }
}
const ctx = new Context(), model = new MockModel(), results = [], compactors = new Set()
try {
  for (const plugin of [LlmRuntime, Sessions, Projections, SystemPrompt, Tools, Commands, Agents]) await ctx.plugin(plugin)
  ctx.tools.register(defineTool({ name: 'deployment_probe', description: 'A global test tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'probe' }))
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(config).href })
  ctx.loader.builtins.group = Group
  await ctx.plugin(PresetRegistry, { default: 'singularity-next' })
  ctx.provide('singularity', {})
  ctx.llm.registerAdapter(['preset-mock'], model)
  mountCampaignMemory(ctx)
  await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const roster = await ctx.agentPresets.list()
  assert.equal(roster.length, 4)
  assert(roster.every(preset => preset.broken === undefined), JSON.stringify(roster))
  assert.equal(ctx.get('compaction'), undefined)
  assert.equal(ctx.get('toolResultPruner'), undefined)
  for (const { config: declaration } of declarations) {
    const id = declaration.id
    const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root },
      agentOptions: { provider: 'preset-mock', model: 'test', maxTokens: 256 },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id) } })
    if (id === 'singularity-root') {
      assert(ctx.tools.schemas(agent).some(tool => tool.name === 'singularity_read'))
      assert(ctx.tools.schemas(agent).every(tool => tool.name.startsWith('singularity_')))
      assert.equal(ctx.tools.get('deployment_probe', agent), undefined)
    } else assert(ctx.tools.get('deployment_probe', agent))
    const compact = ctx.agentPresets.serviceFor(agent, 'compaction')
    assert(compact instanceof BasicCompactionEngine, id + ': shipped compaction face failed to register')
    compactors.add(compact)
    assert(ctx.agentPresets.serviceFor(agent, 'toolResultPruner'), id + ': isolated pruner is missing')
    assert(ctx.commands.find(agent, 'compact'), id + ': command dependency injection is missing')
    for (const label of ['initial investigation', 'new evidence']) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: label + ': ' + 'Exploration without changing the frozen scope. '.repeat(180) }] }))
      await agent.whenIdle()
    }
    const compacted = await compact.compactNow(agent, new AbortController().signal)
    assert(compacted)
    assert(await ctx.sessions.flush(agent.session))
    const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
    let events
    try { events = (await handle.read()).events } finally { await handle.close() }
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].data.summary[0].text, summary)
    assert.equal(summaries[0].data.llmStreamCall, true)
    assert.equal(summaries[0].data.usage.totalTokens, 40)
    assert.equal(events.filter(event => event.type === 'singularity/memory-call').length, 0)
    assert.equal(events.filter(event => event.type === 'singularity/parent-memory').length, 0)
    const visible = agent.session.deriveMessages().flatMap(message => message.content).filter(block => block.type === 'text')
    assert(visible.some(block => block.text === summary))
    results.push({ id, registered: compact.constructor.name, durableSummaries: summaries.length })
  }
  assert.equal(compactors.size, 4)
  assert.equal(ctx.get('compaction'), undefined)
  assert.equal(ctx.get('toolResultPruner'), undefined)
  assert.equal(model.requests.filter(request => request.purpose === 'compaction').length, 4)
  const { agent: below } = await ctx.agents.create({ sessionId: SessionId('below-threshold-compaction'), meta: { cwd: root },
    agentOptions: { provider: 'preset-mock', model: 'below-threshold', maxTokens: 196608 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-next') } })
  for (const label of ['first finding', 'second finding', 'continue']) {
    below.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: label + ': ' + 'bounded investigation '.repeat(label === 'first finding' ? 30000 : 1) }] }))
    await below.whenIdle()
  }
  assert(!model.requests.some(request => request.sessionId === below.session.id && request.purpose === 'compaction'),
    'A 690k-token input must not compact before the requested 700k threshold')
  const { agent: pressure } = await ctx.agents.create({ sessionId: SessionId('threshold-pressure-compaction'), meta: { cwd: root },
    agentOptions: { provider: 'preset-mock', model: 'threshold-pressure', maxTokens: 196608 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-next') } })
  for (const label of ['obsolete working detail', 'recent finding', 'continue']) {
    pressure.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: label + ': ' + 'bounded investigation '.repeat(30000) }] }))
    await pressure.whenIdle()
  }
  assert(await ctx.sessions.flush(pressure.session))
  const pressureHandle = await ctx.sessionPersistence.open(pressure.session.id, 'read')
  try {
    const events = (await pressureHandle.read()).events
    assert(events.some(event => event.type === 'compaction/summary'), JSON.stringify({
      expected: 'Automatic compaction must run above the configured 700k-token threshold',
      pressure: ctx.tokenMeter.measure(pressure.session),
      ends: events.filter(event => event.type === 'turn/end' || event.type === 'compaction/end').map(event => event.data),
      requests: model.requests.filter(request => request.sessionId === pressure.session.id).map(request => ({ purpose: request.purpose, maxTokens: request.maxTokens })),
    }))
    assert(events.some(event => event.surfaceOp?.op === 'replace'), 'Compaction must replace the live surface, not append notes')
    assert(!JSON.stringify(pressure.session.deriveMessages()).includes('obsolete working detail'), 'The old surface must leave model context')
    assert(events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('obsolete working detail')), 'The durable source must remain auditable')
    assert(model.requests.filter(request => request.sessionId === pressure.session.id && request.purpose === 'compaction')
      .every(request => request.maxTokens === 32768))
  } finally { await pressureHandle.close() }
  const { agent: failed } = await ctx.agents.create({ sessionId: SessionId('failed-pressure-compaction'), meta: { cwd: root },
    agentOptions: { provider: 'preset-mock', model: 'truncated-summary', maxTokens: 256 },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'singularity-next') } })
  failed.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A finding awaiting summary. '.repeat(40000) }] }))
  await failed.whenIdle()
  failed.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A newer finding kept in the recent tail. '.repeat(40000) }] }))
  await failed.whenIdle()
  failed.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue from the newer finding.' }] }))
  await failed.whenIdle()
  assert(await ctx.sessions.flush(failed.session))
  const handle = await ctx.sessionPersistence.open(failed.session.id, 'read')
  try {
    const { events } = await handle.read()
    assert.equal(events.filter(event => event.type === 'compaction/start').length, 1, JSON.stringify({
      requests: model.requests.filter(request => request.sessionId === failed.session.id).map(request => ({ purpose: request.purpose, model: request.model })),
      turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data.reason),
      pressure: ctx.tokenMeter.measure(failed.session),
    }))
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'error')
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).data.reason.error.code, 'MAX_TOKENS')
    assert.equal(events.find(event => event.type === 'compaction/end').data.error, 'summarization truncated at the token cap (incomplete checkpoint)')
    assert.equal(events.filter(event => event.type === 'singularity/memory-call').length, 0)
  } finally { await handle.close() }
  assert.deepEqual(model.requests.filter(request => request.sessionId === failed.session.id).map(request => request.purpose), [undefined, undefined, 'compaction'])
  console.log(JSON.stringify(results))
} finally { await ctx.fiber.dispose() }
`

it('loads every shipped preset compaction group through native Loader with isolated injection and durable native session compression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-preset-'))
  try {
    await mkdir(join(root, 'node_modules/@dangosys'), { recursive: true })
    await symlink(join(checkout, 'assembly'), join(root, 'node_modules/@dangosys/dsh-singularity-next'))
    const script = join(root, 'host.mjs')
    await writeFile(script, smoke)
    const { stdout } = await run(process.execPath, [script, checkout, root], { timeout: 20_000 })
    expect(JSON.parse(stdout.trim())).toEqual(['singularity-root', 'singularity-next', 'singularity-review', 'singularity-improve'].map(id => ({
      id, registered: 'BasicCompactionEngine', durableSummaries: 1,
    })))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 25_000)

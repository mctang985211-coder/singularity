#!/usr/bin/env node
/**
 * K1's real-model smoke: one call through the deployment's own LLM route.
 *
 * Everything else in this phase was observed with a stub adapter, which proves structure and proves
 * nothing about whether a real model can be reached. This mounts the credentials provider and the
 * provider adapter the host profile actually configures, and makes one call.
 *
 * The assertions are deliberately structural — that a call was dispatched, that the stream settled
 * without an error, and that a non-empty assistant text came back. Nothing here depends on the
 * model choosing a particular word, because a test that requires a specific sentence is a test of
 * the model rather than of this system.
 *
 * Two sections, because they are different claims. The first is a real completion through the
 * deployment's route. The second is a real model **driving an agent turn**: the same plugin stack
 * the runtime track mounts, with the real provider instead of a stub adapter, so the session ends
 * up holding an assistant message that a live model produced.
 *
 * This is deliberately **not** a gate: it needs the network and a credential, so a per-commit gate
 * would fail for reasons that have nothing to do with the change under test. It is evidence, run
 * on purpose.
 *
 * Run: node scripts/model-smoke.mjs
 *
 * @module singularity-core/scripts/model-smoke
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshModule } from './dsh-control-runtime.mjs'

const PROVIDER = 'commandcode'
const MODEL = 'deepseek/deepseek-v4.1-flash'
const BASE_URL = 'https://api.commandcode.ai/provider/v1'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Mount the in-process runtime with the real provider registered, as the deployment does. */
async function mountRealRuntime(root, cwd) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore } = await dshModule('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await dshModule('@deepseek-ai/dsh-agent')
  const { default: LlmRuntime } = await dshModule('@deepseek-ai/dsh-llm')
  const { default: ToolRuntime } = await dshModule('@deepseek-ai/dsh-tools')
  const { default: SystemPrompt } = await dshModule('@deepseek-ai/dsh-system-prompt')
  const { default: SessionProjectionRegistry } = await dshModule('@deepseek-ai/dsh-session-projection')
  const { default: AgentLoop } = await dshModule('@deepseek-ai/dsh-agent-loop')
  const credentials = await dshModule('@deepseek-ai/dsh-credentials-local')
  const piAi = await dshModule('@deepseek-ai/dsh-llm-pi-ai')

  const ctx = new Context()
  const mounted = []
  const mount = async (label, plugin, config) => {
    try {
      await ctx.plugin(plugin, config)
      mounted.push(label)
    } catch (error) {
      mounted.push(`${label} FAILED(${error?.constructor?.name}: ${error?.message})`)
    }
  }

  // Dependencies before the plugins that inject them; the route last, so its registry exists.
  await mount('session-persistence-jsonl', JsonlSessionPersistence, { root, compression: 'none' })
  await mount('sessions', SessionStore)
  await mount('agents', AgentRegistry)
  await mount('llm', LlmRuntime)
  await mount('tools', ToolRuntime)
  await mount('systemPrompt', SystemPrompt)
  await mount('sessionProjections', SessionProjectionRegistry)
  await mount('credentials', credentials.default ?? credentials, {})
  await mount('llm-pi-ai', piAi, { providers: { [PROVIDER]: providerProfile() } })
  await mount('agentLoop', AgentLoop, { agents: [], maxParallelToolCalls: 1 })

  return { ctx, mounted }
}

function providerProfile() {
  return {
    displayName: 'commandcode',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    api: 'openai-completions',
    baseURL: BASE_URL,
    models: [{ id: MODEL, name: 'DeepSeek V4.1 Flash', contextWindow: 1000000 }],
  }
}

/** One real completion: credentials, adapter, API, stream. */
async function completion() {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const credentials = await dshModule('@deepseek-ai/dsh-credentials-local')
  const { default: LlmRuntime } = await dshModule('@deepseek-ai/dsh-llm')
  const piAi = await dshModule('@deepseek-ai/dsh-llm-pi-ai')

  const ctx = new Context()
  await ctx.plugin(credentials.default ?? credentials, {})
  await ctx.plugin(LlmRuntime, {})
  await ctx.plugin(piAi, { providers: { [PROVIDER]: providerProfile() } })

  const started = Date.now()
  const text = []
  let chunks = 0
  let settled = 0
  let failure
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER,
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly one word: the sum of 2 and 2, spelled out.' }] }],
    system: 'You are a smoke test. Answer in one word.',
    temperature: 0,
  })) {
    chunks += 1
    if (chunk.type === 'text-delta') text.push(chunk.text)
    if (chunk.type === 'finish') {
      settled += 1
      if (chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message ?? 'the stream failed'
    }
  }
  const answer = text.join('').trim()

  check(
    '§1 a real completion was dispatched and its stream settled',
    chunks > 0 && settled === 1 && failure === undefined,
    `chunks=${chunks} settled=${settled}${failure === undefined ? '' : ` failure=${failure}`}`,
  )
  check('§1 the model returned a non-empty answer', answer.length > 0, JSON.stringify(answer.slice(0, 60)))
  console.log(`  §1 ${PROVIDER}/${MODEL} answered in ${Date.now() - started}ms: ${JSON.stringify(answer.slice(0, 60))}`)

  await ctx.fiber.dispose()
}

/** One real agent turn: the model drives a session through the agent loop. */
async function turn() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-model-smoke-'))
  const cwd = await mkdtemp(join(tmpdir(), 'singularity-model-cwd-'))
  try {
    const { ctx, mounted } = await mountRealRuntime(root, cwd)
    const { SessionId } = await dshModule('@deepseek-ai/dsh-session')
    const { createUserMessage } = await dshModule('@deepseek-ai/dsh-llm')

    check('§2 the runtime mounted with the real route', mounted.every(entry => !entry.includes('FAILED')), mounted.filter(entry => entry.includes('FAILED')).join(', '))

    const sessionId = SessionId('model-smoke-turn')
    const created = await ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly one word: the sum of 2 and 2, spelled out.' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()

    // Read the recorded facts, not a convenience accessor: the assistant message is an event, and
    // what a reader sees must come from what is in the log.
    const snapshot = created.agent.session.snapshotEvents()
    const events = snapshot.map(event => event.type)
    const assistant = snapshot.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
    const assistantText = assistant
      .flatMap(message => message?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')

    check('§2 the turn ran to completion in a real DSH session', events.includes('turn/start') && events.includes('turn/end'), events.join(','))
    check('§2 the session holds an assistant message the model produced', assistant.length > 0 && assistantText.trim().length > 0, JSON.stringify(assistantText.slice(0, 60)))
    console.log(`  §2 agent turn events: ${events.join(', ')}`)
    console.log(`  §2 the model answered through the agent loop: ${JSON.stringify(assistantText.trim().slice(0, 60))}`)

    await created.dispose?.()
    await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
}

async function main() {
  await completion()
  await turn()
}

await main()

if (failures.length > 0) {
  console.error(`\nmodel-smoke: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nmodel-smoke: OK — a real model answered through the deployment route')
}

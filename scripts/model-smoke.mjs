#!/usr/bin/env node
/**
 * K1's real-model smoke: one call through the deployment's own route, and one agent turn driven by it.
 *
 * Everything else in this phase was observed with a stub adapter, which proves structure and nothing
 * about whether a real model can be reached. Two sections, because they are different claims: a real
 * completion, and a real model **driving an agent turn** through the same plugin stack the runtime
 * track mounts — with the real provider instead of a stub adapter, so the session ends up holding an
 * assistant message a live model produced.
 *
 * The assertions are structural: a call was dispatched, the stream settled without an error, a
 * non-empty text came back, and the turn ran from `turn/start` to `turn/end`. Nothing depends on the
 * model choosing a particular word, because a check that requires one specific sentence tests the
 * model rather than this system. The route itself — credentials, runtime, provider — lives in
 * `llm-route.mjs`, so a probe whose subject is something else does not restate a provider table.
 *
 * This is deliberately **not** a gate: it needs the network and a credential, so a per-commit gate
 * would fail for reasons that have nothing to do with the change under test. It is evidence, run on
 * purpose.
 *
 * Run: node scripts/model-smoke.mjs
 *
 * @module singularity-core/scripts/model-smoke
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshModule } from './dsh-control-runtime.mjs'
import { ROUTE, realModel, mountRoute } from './llm-route.mjs'

const PROVIDER = ROUTE.provider
const MODEL = ROUTE.model

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** The runtime track's plugin stack, with the deployment's route in place of a stub adapter. */
async function mountRealRuntime(root, cwd) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore } = await dshModule('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await dshModule('@deepseek-ai/dsh-agent')
  const { default: ToolRuntime } = await dshModule('@deepseek-ai/dsh-tools')
  const { default: SystemPrompt } = await dshModule('@deepseek-ai/dsh-system-prompt')
  const { default: SessionProjectionRegistry } = await dshModule('@deepseek-ai/dsh-session-projection')
  const { default: AgentLoop } = await dshModule('@deepseek-ai/dsh-agent-loop')

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
  await mount('session-persistence-jsonl', JsonlSessionPersistence, { root, compression: 'none' })
  await mount('sessions', SessionStore)
  await mount('agents', AgentRegistry)
  await mount('tools', ToolRuntime)
  await mount('systemPrompt', SystemPrompt)
  await mount('sessionProjections', SessionProjectionRegistry)
  await mount('agentLoop', AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  // The route last, so its registry exists; it reports what it mounted the same way.
  mounted.push(...(await mountRoute(ctx)))
  return { ctx, mounted }
}

/** §1: one real completion, through the extracted route. */
async function completion() {
  const model = await realModel()
  const started = Date.now()
  let answer
  let failure
  try {
    answer = await model.complete({
      system: 'You are a smoke test. Answer in one word.',
      prompt: 'Reply with exactly one word: the sum of 2 and 2, spelled out.',
    })
  } catch (error) {
    failure = error.message
  }
  check('§1 a real completion was dispatched and its stream settled', failure === undefined, failure)
  check('§1 the model returned a non-empty answer', (answer ?? '').length > 0, JSON.stringify((answer ?? '').slice(0, 60)))
  console.log(`  §1 ${PROVIDER}/${MODEL} answered in ${Date.now() - started}ms: ${JSON.stringify((answer ?? '').slice(0, 60))}`)
  await model.dispose()
}

/** §2: one real agent turn, read out of the session the turn wrote. */
async function turn() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-model-smoke-'))
  const cwd = await mkdtemp(join(tmpdir(), 'singularity-model-cwd-'))
  try {
    const { ctx, mounted } = await mountRealRuntime(root, cwd)
    const { SessionId } = await dshModule('@deepseek-ai/dsh-session')
    const { createUserMessage } = await dshModule('@deepseek-ai/dsh-llm')
    check('§2 the runtime mounted with the real route', mounted.every(entry => !entry.includes('FAILED')), mounted.filter(entry => entry.includes('FAILED')).join(', '))

    const created = await ctx.agents.create({
      sessionId: SessionId('model-smoke-turn'),
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly one word: the sum of 2 and 2, spelled out.' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()

    // Read the recorded facts, not a convenience accessor: the assistant message is an event, and what
    // a reader sees has to come from what is in the log.
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

await completion()
await turn()

if (failures.length > 0) {
  console.error(`\nmodel-smoke: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nmodel-smoke: OK — a real model answered through the deployment route')
}

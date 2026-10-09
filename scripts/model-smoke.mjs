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
 * This is deliberately **not** a gate: it needs the network and a credential, so a per-commit gate
 * would fail for reasons that have nothing to do with the change under test. It is evidence, run
 * on purpose.
 *
 * Run: node scripts/model-smoke.mjs
 *
 * @module singularity-core/scripts/model-smoke
 */

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

async function main() {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const credentials = await dshModule('@deepseek-ai/dsh-credentials-local')
  const { default: LlmRuntime } = await dshModule('@deepseek-ai/dsh-llm')
  const piAi = await dshModule('@deepseek-ai/dsh-llm-pi-ai')

  const ctx = new Context()
  await ctx.plugin(credentials.default ?? credentials, {})
  // The runtime is the service; the provider adapter registers a route into it.
  await ctx.plugin(LlmRuntime, {})
  await ctx.plugin(piAi, {
    providers: {
      [PROVIDER]: {
        displayName: 'commandcode',
        apiKeyEnv: 'COMMANDCODE_API_KEY',
        api: 'openai-completions',
        baseURL: BASE_URL,
        models: [{ id: MODEL, name: 'DeepSeek V4.1 Flash', contextWindow: 1000000 }],
      },
    },
  })

  const started = Date.now()
  const text = []
  let chunks = 0
  let settled = 0
  let failure
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER,
    model: MODEL,
    // The smallest ask that still requires the provider to answer: two tokens plus the sum.
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly one word: the sum of 2 and 2, spelled out.' }] }],
    system: 'You are a smoke test. Answer in one word.',
    temperature: 0,
  })) {
    chunks += 1
    if (chunk.type === 'text-delta') text.push(chunk.text)
    // The terminal chunk is `finish`; a `finish` carrying an error means nothing was answered.
    if (chunk.type === 'finish') {
      settled += 1
      if (chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message ?? 'the stream failed'
    }
  }
  const elapsed = Date.now() - started
  const answer = text.join('').trim()

  check('a real model call was dispatched and its stream settled', chunks > 0 && settled === 1 && failure === undefined, `chunks=${chunks} settled=${settled}${failure === undefined ? '' : ` failure=${failure}`}`)
  check('the model returned a non-empty answer', answer.length > 0, JSON.stringify(answer.slice(0, 60)))
  console.log(`  provider ${PROVIDER} model ${MODEL} answered in ${elapsed}ms: ${JSON.stringify(answer.slice(0, 60))}`)

  await ctx.fiber.dispose()
}

await main()

if (failures.length > 0) {
  console.error(`\nmodel-smoke: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nmodel-smoke: OK — a real model answered through the deployment route')
}

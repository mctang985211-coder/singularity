#!/usr/bin/env node
/**
 * One real model route, mounted in this process, reachable without the DSH host.
 *
 * A probe started by `node` has no host profile, so the deployment's own route has to be composed by
 * hand: the local credentials provider reads `~/.dsh/.credentials.yaml`, `dsh-llm` owns the runtime,
 * and `dsh-llm-pi-ai` dials the provider the profile names. `scripts/model-smoke.mjs` was the first
 * process to do this and still does it inline; this module is the extraction, so a probe whose subject
 * is something else does not restate a provider table to reach a model.
 *
 * **One direction.** This module knows about the model and about DSH; it does not import the domain,
 * the log, a probe, or a task. Its caller imports it. Nothing here reads a workspace, a revision or a
 * verdict, so a model call can never become a way for the pipeline to reach the thing that drives it.
 *
 * `stream` returns the text the model produced, and refuses rather than returning `''` when the
 * stream failed or settled without one: an empty answer is an absent answer, and a caller that
 * treated it as a completion would measure a model that never spoke.
 *
 * Usage:
 *   import { realModel, realModelTurn } from './llm-route.mjs'
 *   const answer = await realModel().complete({ system, prompt })
 *
 * @module singularity-core/scripts/llm-route
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshModule } from './dsh-control-runtime.mjs'

/** The deployment's own route, as `docs/context.md` §10 records it. Overridable for another profile. */
export const ROUTE = {
  provider: process.env['SINGULARITY_LLM_PROVIDER'] ?? 'commandcode',
  model: process.env['SINGULARITY_LLM_MODEL'] ?? 'deepseek/deepseek-v4.1-flash',
  baseURL: process.env['SINGULARITY_LLM_BASE_URL'] ?? 'https://api.commandcode.ai/provider/v1',
  apiKeyEnv: process.env['SINGULARITY_LLM_API_KEY_ENV'] ?? 'COMMANDCODE_API_KEY',
  /** The wire protocol the gateway speaks; the responses gateways need this named. */
  api: process.env['SINGULARITY_LLM_API'] ?? 'openai-completions',
  /** Thinking effort handed to the runtime, when the route declares one. */
  reasoningEffort: process.env['SINGULARITY_LLM_REASONING'],
}

/** The provider entry `dsh-llm-pi-ai` needs: a display name, the key's env var, the wire API, models. */
export function providerProfile(route = ROUTE) {
  return {
    displayName: route.provider,
    apiKeyEnv: route.apiKeyEnv,
    api: route.api,
    baseURL: route.baseURL,
    models: [{
      id: route.model,
      name: route.model,
      contextWindow: 1000000,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } }),
    }],
  }
}

/**
 * Mount the deployment's model route into a context the caller already owns.
 *
 * The caller supplies the context because its other plugins — sessions, agents, tools — belong to the
 * caller's subject rather than to the route, and a route module that owned the context could not let
 * anything else into it. `llmRuntime: false` is for a context that already holds one.
 */
export async function mountRoute(ctx, { route = ROUTE, llmRuntime = true } = {}) {
  const credentials = await dshModule('@deepseek-ai/dsh-credentials-local')
  const piAi = await dshModule('@deepseek-ai/dsh-llm-pi-ai')
  const mounted = []
  const mount = async (label, plugin, config) => {
    try {
      await ctx.plugin(plugin, config)
      mounted.push(label)
    } catch (error) {
      mounted.push(`${label} FAILED(${error?.constructor?.name}: ${error?.message})`)
    }
  }
  if (llmRuntime) {
    const { default: LlmRuntime } = await dshModule('@deepseek-ai/dsh-llm')
    await mount('llm', LlmRuntime, {})
  }
  await mount('credentials', credentials.default ?? credentials, {})
  await mount('llm-pi-ai', piAi, { providers: { [route.provider]: providerProfile(route) } })
  return mounted
}

/**
 * A mounted route. `complete` is one call; `dispose` releases the context that owns it.
 *
 * The context is created per route rather than shared, because a cordis context owns the plugins
 * mounted into it and a probe that mounted two routes into one context would have one registry for
 * both.
 */
export async function realModel(route = ROUTE) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const ctx = new Context()
  await mountRoute(ctx, { route })

  return {
    route,
    /** One completion. Throws when the stream failed, produced no text, or outlived `timeoutMs`. */
    async complete({ system, prompt, temperature = 0, timeoutMs = 480000 }) {
      const text = []
      let chunks = 0
      let settled = 0
      let failure
      const deadline = setTimeout(() => {
        failure = `the route did not settle within ${timeoutMs}ms`
      }, timeoutMs)
      try {
        for await (const chunk of ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          ...(system === undefined ? {} : { system }),
          temperature,
        })) {
          chunks += 1
          if (chunk.type === 'text-delta') text.push(chunk.text)
          if (chunk.type === 'finish') {
            settled += 1
            if (chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message ?? 'the stream failed'
          }
          if (failure !== undefined && settled === 0) break
        }
      } finally {
        clearTimeout(deadline)
      }
      const answer = text.join('').trim()
      if (failure !== undefined) throw new Error(`the model route failed: ${failure}`)
      if (settled !== 1) throw new Error(`the model route settled ${settled} time(s); one call is one settle`)
      if (answer === '') throw new Error(`the model route returned no text over ${chunks} chunk(s)`)
      return answer
    },
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}

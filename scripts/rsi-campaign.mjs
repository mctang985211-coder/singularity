#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/** A new business root starts only after the previous root's RSI report settles. */
export function nextCampaignStep(state, snapshot) {
  if (snapshot.providerStopped) throw new Error('provider 不稳定；campaign stopped')
  const last = state.iterations.at(-1)
  const root = last === undefined ? undefined : snapshot.tasks.find(task => task.sessionId === last.sessionId)
  if (last !== undefined) {
    if (root?.rsi?.status === 'failed') throw new Error(`RSI failed for ${root.taskId}: ${root.rsi.detail}`)
    if (root?.rsi?.status !== 'completed') return { kind: 'wait' }
    if (state.iterations.length >= state.rounds) return { kind: 'complete', rootId: root.taskId }
  }
  const method = snapshot.methods.find(method => method.published)?.reference
  if (method === undefined) throw new Error('No published method is available for the next root')
  return { kind: 'start', method, ...(root === undefined ? {} : { previousRootId: root.taskId }) }
}

export async function runCampaign(base, rounds = 5) {
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('rounds must be a positive integer')
  const { chromium } = await import('playwright')
  const metaPath = join(base, 'experiment.json'), statePath = join(base, 'campaign.json')
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  let state
  try { state = JSON.parse(await readFile(statePath, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { rounds, iterations: [], status: 'running' }
  }
  if (rounds < state.rounds) throw new Error('rounds cannot shrink an existing campaign')
  if (rounds > state.rounds) {
    state.rounds = rounds
    state.status = 'running'
    delete state.completedAt
  }
  const save = async () => {
    await writeFile(statePath + '.tmp', JSON.stringify(state, null, 2) + '\n')
    await rename(statePath + '.tmp', statePath)
  }
  const text = await readFile(join(base, 'host.log'), 'utf8')
  const entry = text.match(new RegExp('http://127\\.0\\.0\\.1:' + meta.port + '/\\?token=[^\\s]+'))?.[0]
  if (entry === undefined) throw new Error('Host authentication entry is not ready')
  const secret = entry.split('?token=')[1]
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(entry)
    const rpc = async (method, request) => page.evaluate(async ({ method, request }) => {
      const response = await fetch('/api/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }),
      })
      const body = await response.json()
      if (!body.result?.ok) throw new Error(JSON.stringify(body))
      return body.result.value
    }, { method, request })
    const activated = new Set()
    while (true) {
      const pending = state.iterations.at(-1)
      if (pending !== undefined && !activated.has(pending.sessionId)) {
        if (pending.previousRootId !== undefined) await page.evaluate(async ({ sessionId, previousRootId }) => {
          const response = await fetch('/singularity/rsi-memory', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, previousRootId }) })
          if (!response.ok) throw new Error(`RSI memory handoff HTTP ${response.status}: ${await response.text()}`)
        }, { sessionId: pending.sessionId, previousRootId: pending.previousRootId })
        await rpc('session/prompt', { requestId: pending.requestId, sessionId: pending.sessionId, mode: 'queue',
          content: [{ type: 'text', text: await readFile(join(base, 'request.txt'), 'utf8') }], clientTimeZone: 'Asia/Shanghai' })
        activated.add(pending.sessionId)
        pending.prompted = true
        state.status = 'running'
        delete state.error
        await save()
      }
      const snapshot = await page.evaluate(async () => {
        const response = await fetch('/singularity/tasks')
        if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`)
        return response.json()
      })
      const step = nextCampaignStep(state, snapshot)
      if (step.kind === 'complete') {
        Object.assign(state.iterations.at(-1), { rootId: step.rootId, completedAt: new Date().toISOString(),
          publishedMethod: snapshot.methods.find(method => method.published).reference })
        state.status = 'completed'
        state.completedAt = new Date().toISOString()
        await save()
        meta.status = 'completed'
        meta.campaignStatus = 'completed'
        meta.campaign = { ...meta.campaign, iterations: state.rounds }
        await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')
        console.log(JSON.stringify({ status: state.status, rounds: state.rounds }))
        return
      }
      if (step.kind === 'start') {
        const previous = state.iterations.at(-1)
        if (previous !== undefined) Object.assign(previous, { rootId: step.previousRootId, completedAt: new Date().toISOString(), publishedMethod: step.method })
        const created = await rpc('session/create', { cwd: join(meta.home, 'workspaces/singularity'), agentPreset: 'singularity-root' })
        const iteration = { iteration: state.iterations.length + 1, sessionId: created.sessionId,
          ...(step.previousRootId === undefined ? {} : { previousRootId: step.previousRootId }),
          requestId: 'request-' + randomUUID(), method: step.method, createdAt: new Date().toISOString(), prompted: false }
        state.iterations.push(iteration)
        await save()
        meta.rootSessionId = created.sessionId
        meta.status = 'running'
        await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')
        console.log(JSON.stringify({ iteration: iteration.iteration, sessionId: iteration.sessionId, method: step.method.digest }))
        continue
      }
      await new Promise(resolve => setTimeout(resolve, 10_000))
    }
  } catch (error) {
    state.status = 'failed'
    state.error = String(error).replaceAll(secret, '[redacted]')
    await save()
    throw new Error(state.error)
  } finally { await browser.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === undefined) throw new Error('Usage: node scripts/rsi-campaign.mjs <experiment-directory> [rounds=5]')
  await runCampaign(resolve(process.argv[2]), Number(process.argv[3] ?? 5))
}

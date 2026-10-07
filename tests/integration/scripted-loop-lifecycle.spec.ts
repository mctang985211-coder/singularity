import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOTS = ['s-root', 's-operator', 's-root2'] as const
let active: { loop: ScriptedLoop; agents: ScriptedLoop['ctx']['agents']; checkouts: string[]; suspended: boolean; signals: AbortSignal[] } | undefined

// Exercise the same cleanup entry on a normal idle turn and on the live state a
// failed test leaves: accepted runs own two checkouts, model turns remain open.
afterEach(async () => {
  const state = active
  active = undefined
  const startedAt = Date.now()
  await disposeScriptedLoops()
  if (state === undefined) return
  expect(Date.now() - startedAt).toBeLessThan(5_000)
  expect(state.agents.list()).toHaveLength(0)
  expect(existsSync(state.loop.workspace)).toBe(false)
  for (const checkout of state.checkouts) expect(state.loop.runtime.workspaces.ownerOf(checkout)).toBeUndefined()
  if (state.suspended) expect(state.signals.every(signal => signal.aborted)).toBe(true)
}, 10_000)

it.each([false, true])('disposes three real root agents and a second env with suspended model turns=%s', async suspended => {
  const parked = new Promise<void>(() => {})
  const h = await startScriptedLoop({
    roots: ROOTS,
    script: () => suspended ? [{ waitFor: () => parked }] : [{ text: 'idle without submitting' }],
  })
  const checkout2 = join(h.workspace, 'env2')
  mkdirSync(checkout2)
  active = { loop: h, agents: h.ctx.agents, checkouts: [h.checkout, checkout2], suspended, signals: [] }
  const contract = {
    objective: 'own this checkout until teardown', requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: 'independent acceptance', command: 'true' }],
  }
  await h.begin(contract)
  h.runtime.sessionWorkspaces.set(ROOTS[2], checkout2)
  h.recordRequest(contract.objective, ROOTS[2])
  expect((await h.runtime.intakeRootContract(rootTaskStoreId(ROOTS[2]), ROOTS[2], contract)).status).toBe('activated')
  h.userSays('begin', ROOTS[2])
  h.userSays('observe the deployment', ROOTS[1])
  await vi.waitFor(() => {
    for (const root of ROOTS) expect(h.requestsOf(root).length).toBeGreaterThan(0)
  }, { timeout: 5_000 })
  for (const root of ROOTS) {
    const signal = h.requestsOf(root)[0]!.options.signal
    expect(signal).toBeDefined()
    active.signals.push(signal!)
    if (suspended) expect(h.agent(root).status).toBe('running')
    else await h.agent(root).whenIdle()
  }
  expect(h.runtime.workspaces.ownerOf(h.checkout)?.storeId).toBe(rootTaskStoreId(ROOTS[0]))
  expect(h.runtime.workspaces.ownerOf(checkout2)?.storeId).toBe(rootTaskStoreId(ROOTS[2]))
}, 10_000)

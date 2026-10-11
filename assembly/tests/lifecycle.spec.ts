import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { openDriver, type TaskDriver } from '../src/driver.ts'
import { loadDomain } from '../src/domain.ts'
import type { TurnFailure, TurnFailureHandler } from '../src/execution.ts'
import { spawnProcess } from '../src/process.ts'
import { agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
const drivers: TaskDriver[] = []
afterEach(async () => {
  await Promise.all(drivers.splice(0).map(driver => driver.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const failure: TurnFailure = { sessionId: 'session-a', turn: 1, seq: 9,
  reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'stream_read_error' } } }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'assembly-lifecycle-'))
  roots.push(root)
  const medium = new FakePersistence()
  let report!: TurnFailureHandler
  const driver = await openDriver({ controlId: 'lifecycle', workspaceRoot: root,
    domain: await loadDomain(domainDir, spawnProcess), persistence: medium as never, seams: {},
    execution: (admission, onFailure) => { report = onFailure; return fakeExecution(admission) },
  })
  drivers.push(driver)
  const call = (id: string, sessionId = 'session-a') => driver.forCall(execFor(agentFor(sessionId, sessionId), id))
  const a = await call('propose-a').propose({ goal: 'count a' })
  const b = await call('propose-b', 'session-b').propose({ goal: 'count b' })
  return { driver, medium, report, call, a, b }
}

describe('a failed DSH solve turn', () => {
  it('settles only the working Runs owned by the exact session and preserves its error source', async () => {
    const h = await setup()
    h.report(failure)
    await h.driver.close()
    expect(await h.call('status-a').status({ taskId: h.a.taskId })).toMatchObject({ phase: 'failed', receipt: { status: 'failed' } })
    expect(await h.call('status-b', 'session-b').status({ taskId: h.b.taskId })).toMatchObject({ phase: 'running' })
    expect(factsOf(h.medium).filter(fact => fact.kind === 'run/failed')).toMatchObject([
      { subject: h.a.taskId, payload: { runId: h.a.runId, reason: expect.stringContaining('"seq":9') } },
    ])
  })

  it('settles cancellation explicitly and ignores unknown sessions', async () => {
    const h = await setup()
    h.report({ ...failure, sessionId: 'foreign' })
    h.report({ ...failure, reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
    await h.driver.close()
    expect(factsOf(h.medium).filter(fact => fact.kind === 'run/failed')).toHaveLength(1)
  })

  it('preserves a settled Run when a later turn in its session fails', async () => {
    const h = await setup()
    await h.call('submit').submit({ taskId: h.a.taskId, program: "process.stdout.write('0')" })
    const before = factsOf(h.medium)
    h.report(failure)
    await h.driver.close()
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('propagates failure persistence errors through unload', async () => {
    const h = await setup()
    h.medium.failAppendOf('run/failed')
    h.report(failure)
    await expect(h.driver.close()).rejects.toThrow('driver unload failed')
    expect(factsOf(h.medium).some(fact => fact.kind === 'run/failed')).toBe(false)
  })
})

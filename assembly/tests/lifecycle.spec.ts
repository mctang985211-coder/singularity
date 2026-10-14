import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { openDriver, type TaskDriver } from '../src/driver.ts'
import { openApparatus } from '../src/apparatus.ts'
import { propose } from '../src/surfaces.ts'
import { loadDomain } from '../src/domain.ts'
import type { TurnFailure, TurnFailureHandler } from '../src/execution.ts'
import { spawnProcess } from '../src/process.ts'
import { attachmentsAt, agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
const drivers: TaskDriver[] = []
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const failure: TurnFailure = { sessionId: 'session-a', turn: 1, seq: 9,
  reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'stream_read_error' } },
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'assembly-lifecycle-'))
  roots.push(root)
  const medium = new FakePersistence()
  const domain = await loadDomain(domainDir, spawnProcess)
  const apparatus = await openApparatus('lifecycle', root, domain, medium as never, attachmentsAt(root))
  const model = { provider: 'test', model: 'model-under-test' }
  const a = await propose(apparatus, { agentId: 'session-a', sessionId: 'session-a', model }, 'propose-a', { goal: 'count a',
  })
  const b = await propose(apparatus, { agentId: 'session-b', sessionId: 'session-b', model }, 'propose-b', { goal: 'count b',
  })
  await apparatus.store.close()
  let report!: TurnFailureHandler
  const driver = await openDriver({ controlId: 'lifecycle', workspaceRoot: root,
    domain, persistence: medium as never, attachments: attachmentsAt(root), seams: { agents: { get: () => undefined } as never },
    execution: (admission, onFailure) => { report = onFailure
      return fakeExecution(admission) },
  })
  drivers.push(driver)
  const call = (id: string, sessionId = 'session-a') => driver.forCall(execFor(agentFor(sessionId, sessionId), id))
  return { driver, medium, report, call, a, b }
}

it('discovers pinned template summaries on demand without exposing the method asset library', async () => {
  const h = await setup(), call = h.call('templates')
  expect(await call.history({ kind: 'template', from: 1, count: 1 })).toEqual([
    { id: 'extract-letters', goal: 'extract every ASCII letter in source order, with no other bytes', applicability: undefined },
  ])
  expect(await call.history({ kind: 'template', ref: 'extract-letters' })).toHaveProperty('input')
  await expect(call.history({ kind: 'template', count: 101 })).rejects.toThrow('1 to 100 entries')
  await expect(call.history({ kind: 'method' })).rejects.toThrow('RSI')
})

describe('a failed DSH solve turn', () => {
  it('settles only the working Runs owned by the exact session and preserves its error source', async () => {
    const h = await setup()
    await h.report(failure)
    expect(await h.call('read-a').history({ kind: 'task', ref: h.a.taskId })).toMatchObject({ phase: 'failed', runs: [{ receipt: { status: 'failed' } }],
    })
    expect(await h.call('read-b', 'session-b').history({ kind: 'task', ref: h.b.taskId })).toMatchObject({ phase: 'running' })
    expect(factsOf(h.medium).filter((fact) => fact.kind === 'run/failed')).toMatchObject([
      { subject: h.a.taskId, payload: { runId: h.a.runId, reason: expect.stringContaining('"seq":9') } },
    ])
  })

  it('settles cancellation explicitly and ignores unknown sessions', async () => {
    const h = await setup()
    await h.report({ ...failure, sessionId: 'foreign' })
    await h.report({ ...failure, reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
    await h.driver.close()
    expect(factsOf(h.medium).filter((fact) => fact.kind === 'run/failed')).toHaveLength(1)
  })

  it('preserves a settled Run when a later turn in its session fails', async () => {
    const h = await setup()
    await h.report(failure)
    const before = factsOf(h.medium)
    await h.report(failure)
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('propagates failure persistence errors through unload', async () => {
    const h = await setup()
    h.medium.failAppendOf('run/failed')
    const reported = h.report(failure)
    await expect(reported).rejects.toThrow('write-not-durable')
    await expect(h.driver.close()).rejects.toThrow('driver unload failed')
    expect(factsOf(h.medium).some((fact) => fact.kind === 'run/failed')).toBe(false)
  })
})

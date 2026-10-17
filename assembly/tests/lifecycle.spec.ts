import { testProjections } from './seam.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { openDriver, type TaskDriver } from '../src/driver.ts'
import { contractDigest } from '../../src/task/contract.ts'
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
  const apparatus = await openApparatus('lifecycle', root, domain, medium as never, attachmentsAt(root), testProjections)
  const model = { provider: 'test', model: 'model-under-test' }
  const a = await propose(apparatus, { agentId: 'session-a', sessionId: 'session-a', model }, 'propose-a', { goal: 'count a',
  })
  const b = await propose(apparatus, { agentId: 'session-b', sessionId: 'session-b', model }, 'propose-b', { goal: 'count b',
  })
  await apparatus.store.close()
  let report!: TurnFailureHandler
  const driver = await openDriver({ projections: testProjections, controlId: 'lifecycle', workspaceRoot: root,
    domain, persistence: medium as never, attachments: attachmentsAt(root), seams: { agents: { get: () => undefined } as never },
    execution: (admission, onFailure) => { report = onFailure
      return fakeExecution(admission) },
  })
  drivers.push(driver)
  const call = (id: string, sessionId = 'session-a') => driver.forCall(execFor(agentFor(sessionId, sessionId), id))
  return { driver, medium, report, call, a, b }
}

it('projects memory from the committed assigned Run without consuming methods or another agent\'s scope', async () => {
  const h = await setup(), before = factsOf(h.medium)
  await h.driver.activate('session-a')
  const memory = await h.driver.memoryContext('session-a')
  expect(memory.scope).toEqual({ kind: 'task', taskId: h.a.taskId, runId: h.a.runId,
    contractDigest: contractDigest(h.a.contract), method: h.a.method })
  expect(memory.evidenceRefs).toEqual([])
  expect(memory.excludedTexts).toContain(h.a.contract.goal)
  expect(factsOf(h.medium)).toEqual(before)
  await expect(h.driver.memoryContext('unassigned-agent')).rejects.toThrow('assigned Task Run')
})

it('reads complete contract examples and a scoped method directory on demand', async () => {
  const h = await setup(), call = h.call('templates')
  expect(await call.history({ kind: 'template', from: 1, count: 1 })).toEqual([
    { id: 'extract-letters', goal: 'extract every ASCII letter in source order, with no other bytes', producers: [] },
  ])
  expect(await call.history({ kind: 'template', ref: 'extract-letters' })).toMatchObject({ contract: {
    template: { id: 'extract-letters', digest: expect.any(String) },
    artifact: 'letters.txt', inputs: [{ name: 'in/source.txt', source: { kind: 'protected', digest: expect.any(String) } }],
    criteria: [{ criterionId: 'extracted' }], skills: [], capabilities: [],
  } })
  await expect(call.history({ kind: 'template', count: 101 })).rejects.toThrow('1 to 100 entries')
  const method = await call.history({ kind: 'method' })
  expect(method).toMatchObject({ method: h.a.method, skills: [], tools: [] })
  expect(method).not.toHaveProperty('assets')
  expect(method).not.toHaveProperty('guidance')
  expect(factsOf(h.medium).filter((fact) => fact.kind === 'method/consumed' &&
    /^(skill|guidance):/.test((fact.payload as { method: string }).method))).toEqual([])
})

it('binds producer placeholders explicitly when reading artifact-input examples', async () => {
  const h = await setup(), call = h.call('consumer')
  await expect(call.history({ kind: 'template', ref: 'count-letters' })).rejects.toThrow('producer')
  expect(await call.history({ kind: 'template', ref: 'count-letters', producers: { 'extract-letters': 'extract-key' } }))
    .toMatchObject({ contract: { inputs: [{ name: 'in/letters.txt', source: { kind: 'artifact', taskId: 'extract-key' } }] } })
  await expect(call.history({ kind: 'template', ref: 'count-letters', producers: { 'extract-letters': 7 } }))
    .rejects.toThrow('producer')
})

it('lets native execution read frozen workspace inputs without exposing the deployment source directory', async () => {
  const h = await setup(), world = h.driver.world('session-a')
  const result = await spawnProcess({ shell: false, argv: [process.execPath, '-e',
    "const{readFileSync,existsSync}=require('node:fs');process.stdout.write(readFileSync(process.argv[1]));if(existsSync(process.argv[2]))process.exit(99)",
    join(h.a.workspace, 'in/source.txt'), join(domainDir, 'samples/source.txt'),
  ] }, new AbortController().signal, h.a.workspace, world)
  expect(result).toMatchObject({ exitCode: 0, stderr: '' })
  expect(result.stdout).toBe('The quick brown fox jumps over the lazy dog.\n')
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
    expect(h.driver.failed('session-a')).toBe(true)
    expect(h.driver.failed('session-b')).toBe(false)
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

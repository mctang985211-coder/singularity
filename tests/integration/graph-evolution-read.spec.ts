import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { expect, it } from 'vitest'
import { EvolutionService } from '../../evolution/src/evolution.ts'
import { registerEvolution } from '../../graph-web/src/web/api/evolution.ts'

it('reads a worker’s settled proposal through the native graph Web route without reopening its ledger', async () => {
  const home = await mkdtemp(join(tmpdir(), 'graph-evolution-web-'))
  const ctx = new Context()
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  ctx.provide('webServer', { register: ({ kind, path, handler }: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
    const key = `${kind}:${path}`
    handlers.set(key, handler)
    return () => handlers.delete(key)
  } } as never)
  ctx.provide('graphs', {
    get: async () => ({ rootSessionId: 'root' }),
    graphForSession: async () => ({ model: { provider: 'test', model: 'test' } }),
  } as never)
  const root = join(home, 'library')
  ctx.provide('taskRuntime', { libraryForSession: async () => ({
    id: 'root', root, skillRoot: join(root, 'skills'), taskTemplatesRoot: join(root, 'tasks'),
  }) } as never)
  const service = new EvolutionService(ctx, { root: join(home, 'legacy') })
  const unregister = registerEvolution(ctx.extend())
  const read = async () => {
    let body = ''
    const res = { writeHead: (status: number) => expect(status).toBe(200), end: (value: string) => { body = value } }
    await handlers.get('exact:/singularity/evolution')!({ method: 'GET', url: '/singularity/evolution?graphId=graph4' } as IncomingMessage, res as unknown as ServerResponse)
    return JSON.parse(body)
  }
  try {
    expect((await read()).proposals).toEqual([])
    const worker = await service.forSession('worker')
    const nested = await worker.forSession('supervisor')
    await nested.propose({ proposalId: 'p', targetType: 'skill', targetId: 'method', baseVersion: 'absent', level: 'L1',
      rationale: 'Reuse the measured route', sourceRefs: ['diagnosis:route'] }, 'root')
    await nested.decide('p', 'KEEP_FOR_FURTHER_RESEARCH', 'root', 'approval:keep', 'Retain the observed route for another task.')
    expect((await read()).proposals).toMatchObject([{ proposalId: 'p', status: 'decided', decision: 'KEEP_FOR_FURTHER_RESEARCH' }])
  } finally {
    unregister()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

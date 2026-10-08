import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EvolutionService } from '../../src/evolution.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const proposal = { proposalId: 'p-new', targetType: 'skill' as const, targetId: 'learned-method', baseVersion: 'absent', level: 'L1' as const,
  rationale: 'A concise reusable route learned from a completed Task', sourceRefs: ['diagnosis:observed'] }
const content = '---\nname: learned-method\ndescription: Reusable route\n---\nUse the observed route and record its measured outcome.\n'

describe('graph library Evolution scope', () => {
  it('shares one graph ledger across native caller contexts and repeated scoped resolution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'graph-evolution-callers-'))
    homes.push(home)
    const ctx = new Context()
    const root = join(home, 'graph-library')
    ctx.provide('graphs', { graphForSession: async () => ({ model: { provider: 'p', model: 'm' } }) })
    ctx.provide('taskRuntime', { libraryForSession: async () => ({
      id: 'graph-root', root, skillRoot: join(root, 'skills'), taskTemplatesRoot: join(root, 'task-templates'),
    }) })
    new EvolutionService(ctx, { root: join(home, 'legacy') })
    const web = ctx.extend()
    const worker = ctx.extend()
    const reader = await web.evolution.forSession('graph-root')
    const writer = await worker.evolution.forSession('worker')
    expect(writer).toBe(reader)
    // Calling through a returned scoped service is idempotent too. Native
    // context tracing may expose it as the caller's current service.
    const resolved = await writer.forSession('supervisor')
    expect(resolved).toBe(writer)
    await resolved.propose(proposal, 'graph-root')
    expect((await reader.list()).map(row => row.proposalId)).toEqual([proposal.proposalId])
    await resolved.decide(proposal.proposalId, 'REJECT', 'graph-root', 'approval:test', 'The existing method is sufficient.')
    expect((await reader.get(proposal.proposalId)).status).toBe('decided')
  })

  it('keeps same-id proposals and first Skill candidates in their own graph, including reload', async () => {
    const home = await mkdtemp(join(tmpdir(), 'graph-evolution-'))
    homes.push(home)
    const ctx = new Context()
    const pins = new Map([['a-root', { provider: 'p', model: 'a-model' }], ['b-root', { provider: 'p', model: 'b-model' }]])
    ctx.provide('graphs', { graphForSession: async (session: string) => ({ model: pins.get(session.startsWith('b') ? 'b-root' : 'a-root') }) })
    ctx.provide('taskRuntime', { libraryForSession: async (session: string) => {
      const id = session.startsWith('b') ? 'b-root' : 'a-root'
      const root = join(home, 'singularity', 'environments', id)
      return { id, root, skillRoot: join(root, 'skills'), taskTemplatesRoot: join(root, 'task-templates') }
    } })
    const service = new EvolutionService(ctx, { root: join(home, 'legacy-evolution'), skillRoot: join(home, 'legacy-skills') })
    const a = await service.forSession('a-worker')
    const b = await service.forSession('b-worker')
    expect(await a.forSession('b-root')).toBe(b)
    expect(await b.forSession('a-worker')).toBe(a)
    expect(ctx.evolution.root).toBe(service.root)
    expect(await service.forSession('a-root')).toBe(a)
    expect(a.modelSelection().model).toBe('a-model')
    expect(b.modelSelection().model).toBe('b-model')
    pins.set('a-root', { provider: 'p', model: 'a-next' })
    expect((await a.forSession('a-root')).modelSelection().model).toBe('a-next')
    expect(b.modelSelection().model).toBe('b-model')
    expect(a.root).toBe(join(home, 'singularity', 'environments', 'a-root', 'evolution'))
    expect(a.libraryId).toBe('a-root')
    expect(b.libraryId).toBe('b-root')
    expect(service.libraryId).toBeUndefined()
    await a.propose(proposal, 'a-root')
    await a.candidate(proposal.proposalId, { 'learned-method': '1' }, 'a-root', { name: proposal.targetId, content })
    const prepared = await a.prepare(proposal.proposalId, 'a-root')
    expect(prepared.prepared).toMatchObject({ champion: 'absent', skillBaseline: null, skillContent: { name: proposal.targetId } })
    await expect(b.get(proposal.proposalId)).rejects.toThrow('unknown proposal')
    expect(await service.list()).toEqual([])
    await b.propose({ ...proposal, rationale: 'Another graph, same local id' }, 'b-root')
    expect((await a.get(proposal.proposalId)).rationale).toBe(proposal.rationale)
    expect(await readFile(join(a.root, 'sandbox', proposal.proposalId, 'skills', proposal.targetId, 'SKILL.md'), 'utf8')).toBe(content)
    const reloaded = new EvolutionService(ctx.isolate('evolution'), { root: service.root, skillRoot: service.skillRoot })
    expect((await (await reloaded.forSession('a-root')).get(proposal.proposalId)).prepared).toEqual(prepared.prepared)
    expect((await (await reloaded.forSession('b-root')).get(proposal.proposalId)).rationale).toBe('Another graph, same local id')
  })

  it('rebuilds a scoped service whose first reconcile failed instead of caching the rejection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'graph-evolution-'))
    homes.push(home)
    const ctx = new Context()
    ctx.provide('graphs', { graphForSession: async () => ({ model: { provider: 'p', model: 'a-model' } }) })
    const root = join(home, 'singularity', 'environments', 'a-root')
    ctx.provide('taskRuntime', {
      libraryForSession: async () => ({
        id: 'a-root',
        root,
        skillRoot: join(root, 'skills'),
        taskTemplatesRoot: join(root, 'task-templates'),
      }),
    })
    const service = new EvolutionService(ctx, { root: join(home, 'legacy-evolution'), skillRoot: join(home, 'legacy-skills') })

    // The library's ledger is corrupt when the first call opens it, so reconcile
    // rejects. Before the fix that rejected promise stayed cached, and every
    // later forSession for the same library failed on it forever.
    const ledger = join(root, 'evolution', 'proposals.jsonl')
    await mkdir(dirname(ledger), { recursive: true })
    await writeFile(ledger, '{ not a ledger line\n')
    await expect(service.forSession('a-worker')).rejects.toThrow(/corrupt ledger/)

    // The obstacle is gone: the next call has to rebuild the scoped service
    // rather than hand back the rejection.
    await rm(ledger)
    const recovered = await service.forSession('a-worker')
    expect(recovered.libraryId).toBe('a-root')
    expect(await recovered.list()).toEqual([])
  })
})

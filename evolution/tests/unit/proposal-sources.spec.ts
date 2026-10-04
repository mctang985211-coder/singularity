/** Diagnosis references have one recorded spelling for support checks, hand-offs and recovery. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import { defineEvolutionProposeTool } from '../../../agent-singularity/src/tools/evolution-propose.ts'
import { proposalsForDiagnosis } from '../../../agent-singularity/src/coordination/evolution-handoff.ts'

const STORE = 'sg-t-s-root'
const DIAGNOSIS = 'd-source'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture(status: 'failed' | 'verified' = 'failed') {
  const root = await mkdtemp(join(tmpdir(), 'proposal-source-')); directories.push(root)
  const snapshot = {
    tasks: [{ taskId: 't-source', status, runIds: ['r-source'], requestedCapabilities: [], acceptanceCriteria: [] }],
    runs: [{ runId: 'r-source', taskId: 't-source', status }],
    diagnoses: [{ diagnosisId: DIAGNOSIS, taskId: 't-source', reviewRefs: ['t-source#r-source'] }],
  }
  const replayTask = vi.fn()
  const recoverRootTask = vi.fn()
  const graphForSession = vi.fn(async () => ({ rootSessionId: 's-root' }))
  const openStore = vi.fn(async () => snapshot)
  const services: Record<string, unknown> = {
    graphs: { graphForSession }, task: { openStore }, taskRuntime: { replayTask, recoverRootTask },
  }
  const ctx = { reflect: { provide: () => {} }, effect: () => {}, get: (name: string) => services[name] }
  const config = { root, supervisorDelegation: async (sessionId: string, diagnosisId: string) => ({
    rootStoreId: STORE, taskId: 't-source', sessionId, diagnosisId, actor: 's-root', at: '2026-10-04T00:00:00.000Z',
  }) }
  const svc = new EvolutionService(ctx as never, config)
  return { svc, ctx, config, snapshot, replayTask, recoverRootTask, graphForSession, openStore }
}

const proposal = { proposalId: 'p-source', targetType: 'skill' as const, targetId: 'method', baseVersion: '1',
  level: 'L1' as const, rationale: 'an evidenced reusable change', sourceRefs: [DIAGNOSIS] }

it('stores known bare diagnosis ids canonically through the tool and preserves other source refs', async () => {
  const f = await fixture()
  const sourceRefs = [DIAGNOSIS, `diagnosis:${DIAGNOSIS}`, 't-source#r-source', 'e-source', 'historical-opaque-ref', 'd-other-graph']
  const expected = [`diagnosis:${DIAGNOSIS}`, ...sourceRefs.slice(2)]
  const ctx = { ...f.ctx, evolution: f.svc }
  const result = await defineEvolutionProposeTool(ctx as never).execute({ ...proposal, sourceRefs }, {
    agent: { id: 's-supervisor' }, callId: 'propose-source', signal: new AbortController().signal,
  } as never)
  expect(result).toContain(`sourceRefs: [${expected.join(', ')}]`)
  expect(sourceRefs[0]).toBe(DIAGNOSIS)
  expect(f.graphForSession).toHaveBeenCalledWith('s-supervisor')
  expect(f.openStore).toHaveBeenCalledWith(STORE)
  expect((await f.svc.get(proposal.proposalId)).sourceRefs).toEqual(expected)
  const recorded = JSON.parse((await readFile(f.svc.file, 'utf8')).trim())
  expect(recorded.sourceRefs).toEqual(expected)
  const reopened = new EvolutionService(f.ctx as never, f.config)
  expect((await reopened.get(proposal.proposalId)).sourceRefs).toEqual(expected)
  expect(await proposalsForDiagnosis({ evolution: reopened } as never, DIAGNOSIS)).toEqual([
    expect.objectContaining({ proposalId: proposal.proposalId }),
  ])
})

it('cannot bypass the successful-source support check with a bare diagnosis id', async () => {
  const f = await fixture('verified')
  await f.svc.propose(proposal, 's-supervisor')
  await expect(f.svc.runExperiment({
    proposalId: proposal.proposalId, samples: [{ taskId: 't-source', role: 'observed-failure' }],
    snapshot: { sourceDir: f.svc.root }, model: { provider: 'p', model: 'm', label: 'p/m' }, budget: {}, repetition: 0,
  }, 's-supervisor' as never, 's-supervisor')).rejects.toThrow('successful source task/run')
  expect(f.replayTask).not.toHaveBeenCalled()
  expect(await f.svc.experiments(proposal.proposalId)).toEqual([])
})

it('cannot bypass the unapplied-change recovery guard with a bare diagnosis id', async () => {
  const f = await fixture()
  await f.svc.propose(proposal, 's-supervisor')
  await expect(f.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'recovery-source' }, {
    sessionId: 's-supervisor',
  })).rejects.toThrow('shared change this hand-off depends on')
  expect(f.recoverRootTask).not.toHaveBeenCalled()
})

it('records nothing when the caller graph cannot be resolved for a bare diagnosis ref', async () => {
  const f = await fixture()
  f.graphForSession.mockRejectedValue(new Error('graph unreadable'))
  await expect(f.svc.propose(proposal, 's-supervisor')).rejects.toThrow('has no graph in this deployment')
  expect(f.openStore).not.toHaveBeenCalled()
  expect(await f.svc.list()).toEqual([])
})

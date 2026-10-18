import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { parseRsiProposal, proposeRsiMethod } from '../src/rsi-proposal.ts'
import type { MethodAssets } from '../src/method.ts'
import { loadMethod } from '../src/method.ts'
import { callerOf, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { TASK_PROTOCOL, TASK_VERSION } from '../../src/task/protocol.ts'
import { attachmentsAt, FakePersistence, agentFor, factsOf, testProjections } from './seam.ts'
import { rsiProposal } from './rsi-fixture.ts'

const history = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../src/rsi-history.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/rsi-history.ts')>(), searchHistory: history.read,
}))

const baseline: MethodAssets = { workflowGuidance: '', templates: [{ id: 'root', guidance: 'Inspect inputs.' }], skills: [], tools: [] }
function fixture() {
  const method: MethodAssets = { ...baseline, templates: [{ id: 'root', guidance: 'Reuse an inspection only when its frozen input identity matches.' }] }
  return rsiProposal(baseline, method, 'task', 'session')
}

it('requires evidenced analysis, an attributable diff and corrective/preservative/transfer counterfactuals', () => {
  const proposal = fixture()
  expect(parseRsiProposal(proposal, baseline)).toEqual(proposal)
  expect(() => parseRsiProposal(proposal.method, baseline)).toThrow('RSI proposal')
  for (const field of ['corrective', 'preservative', 'transfer'] as const) {
    const invalid = { ...proposal, edit: { ...proposal.edit,
      retroactive_check: { ...proposal.edit.retroactive_check, [field]: '' } } }
    expect(() => parseRsiProposal(invalid, baseline)).toThrow(`retroactive_check.${field}`)
  }
})

it('rejects unsupported mechanisms, missing success protection, empty evidence and undeclared changes', () => {
  const proposal = fixture()
  expect(() => parseRsiProposal({ ...proposal, edit: { ...proposal.edit, targets_mode: 'not_in_analysis' } }, baseline)).toThrow('evidenced mode')
  expect(parseRsiProposal({ ...proposal, analysis: { ...proposal.analysis, success_habits: [] } }, baseline).analysis.success_habits).toEqual([])
  expect(() => parseRsiProposal({ ...proposal, analysis: { ...proposal.analysis,
    failure_modes: [{ ...proposal.analysis.failure_modes[0], evidence: [] }] } }, baseline)).toThrow('native evidence')
  expect(() => parseRsiProposal({ ...proposal, edit: { ...proposal.edit, changes: [] } }, baseline)).toThrow('actual method diff')
  expect(() => parseRsiProposal({ ...proposal, method: baseline }, baseline)).toThrow('actual method diff')
})

it('settles a malformed prune candidate as invalid and leaves later batches usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-prune-')), medium = new FakePersistence()
  const apparatus = await openApparatus('prune', root,
    await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess),
    medium as never, attachmentsAt(root), testProjections)
  try {
    const parent = agentFor('business', 'business')
    const source = await propose(apparatus, callerOf(parent), 'root', { goal: 'inspect protected letters' })
    await apparatus.tasks.forAgent(parent.id).failRun({ commandId: 'business-ended', taskId: source.taskId,
      runId: source.runId, cause: 'business', reason: 'fixture stopped without an answer' })
    await apparatus.store.emit({ commandId: 'close-business', protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'task/closed', subject: source.taskId, as: `agent:${parent.id}`,
      payload: { runId: source.runId, reason: 'failed' } })
    const agent = agentFor('analysis', 'analysis')
    const analysis = await propose(apparatus, callerOf(agent), 'analysis', { goal: 'analyze methods' },
      { purpose: 'improve', relatedTo: { taskId: source.taskId, runId: source.runId } })
    await apparatus.store.emit({ commandId: 'search', protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'rsi/search-opened', subject: analysis.taskId, as: 'agent:analysis',
      payload: { runId: analysis.runId, maxProposals: 6 } })
    const run = taskStateOf(apparatus, analysis.taskId).runs[analysis.runId]!
    const { assets } = await loadMethod(apparatus, run.revision)
    history.read.mockReturnValue({ incumbent: run.revision,
      directives: { historyCutoff: apparatus.store.load().entries().length, untried: [], prune: true } })
    // A missing collection looks like deletion to the structural diff. It must
    // fail method parsing before the prune check dereferences that collection.
    const { templates: _templates, ...missingTemplates } = assets
    const malformed = rsiProposal(assets, missingTemplates as MethodAssets, source.taskId, parent.id)
    expect(parseRsiProposal(malformed, assets).edit.changes.some(change => change.asset === 'template')).toBe(true)
    await writeFile(join(analysis.workspace, 'malformed.json'), JSON.stringify(malformed))
    const call = (path: string) => proposeRsiMethod(apparatus, {}, agent, agent.id, { paths: [path] }, new AbortController().signal)
    await expect(call('malformed.json')).resolves.toMatchObject({ status: 'invalid', reason: expect.stringContaining('Revision.templates') })
    const validShape = rsiProposal(assets, { ...assets, workflowGuidance: 'Preserve independent acceptance.' }, source.taskId, parent.id)
    await writeFile(join(analysis.workspace, 'no-prune.json'), JSON.stringify(validShape))
    await expect(call('no-prune.json')).resolves.toMatchObject({ status: 'invalid',
      reason: 'stalled search requires a real current-asset deletion in its prune slot' })
    const batches = taskStateOf(apparatus, analysis.taskId).search!.batches!
    expect(batches).toHaveLength(2)
    expect(batches.every(batch => batch.settled && batch.outcomes.length === 1 && batch.outcomes[0]!.status === 'invalid')).toBe(true)
    expect(factsOf(medium).some(fact => fact.kind === 'review/started')).toBe(false)
  } finally {
    history.read.mockReset()
    await apparatus.store.close()
    await rm(root, { recursive: true, force: true })
  }
})

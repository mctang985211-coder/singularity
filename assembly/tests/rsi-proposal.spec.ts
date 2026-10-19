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
import { parseSuite } from '../../src/measure/suite.ts'
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

it('refuses malformed batches before consuming slots, then charges a complete candidate that fails prune', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-prune-')), medium = new FakePersistence()
  const domain = await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess)
  const suite = parseSuite({ version: 1, suiteId: 'preflight', failureQuality: 0, cases: [{
    caseId: 'evolve-letters', familyId: 'letters', sourceId: 'letters-source', split: 'evolve', trials: 2, weight: 1, hardGuards: [],
    contract: { goal: 'count letters', artifact: 'report.txt', inputs: [], criteria: [{ criterionId: 'correct', statement: 'correct count' }] },
  }] })
  const apparatus = await openApparatus('prune', root, { ...domain, suite },
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
    const validShape = rsiProposal(assets, { ...assets, workflowGuidance: 'Preserve independent acceptance.' }, source.taskId, parent.id)
    const proposal = { ...validShape, edit: { ...validShape.edit, predicted_cases: ['evolve-letters'] } }
    const { eventSeq: _eventSeq, ...missingSeq } = proposal.analysis.success_habits[0]!.evidence[0]!
    const { templates: _templates, ...missingTemplates } = assets
    const { skills: _skills, ...missingSkills } = assets
    const { tools: _tools, ...missingTools } = assets
    const { inputs: _inputs, ...missingInputs } = assets.templates[0] as Record<string, unknown>
    const malformed = [
      { path: 'broken-json.json', content: '{', field: 'invalid JSON' },
      { path: 'missing-event.json', field: 'analysis.success_habits[0].evidence[0].eventSeq', raw: { ...proposal,
        analysis: { ...proposal.analysis, success_habits: [{ ...proposal.analysis.success_habits[0],
          evidence: [{ ...missingSeq, rootId: source.taskId }] }] } } },
      { path: 'duplicate-label.json', field: 'analysis.capability_gaps[0].gap', raw: { ...proposal,
        analysis: { ...proposal.analysis, capability_gaps: [{ gap: proposal.analysis.failure_modes[0]!.mode,
          description: 'Duplicated mechanism label.', evidence: proposal.analysis.failure_modes[0]!.evidence }] } } },
      { path: 'missing-templates.json', field: 'method.templates', raw: { ...proposal, method: missingTemplates } },
      { path: 'missing-skills.json', field: 'method.skills', raw: { ...proposal, method: missingSkills } },
      { path: 'missing-tools.json', field: 'method.tools', raw: { ...proposal, method: missingTools } },
      { path: 'missing-tool-source.json', field: 'method.tools[0].source', raw: { ...proposal,
        method: { ...proposal.method, tools: [{ name: 'missing-source' }] },
        edit: { ...proposal.edit, changes: [{ asset: 'workflow', target: 'workflowGuidance' }, { asset: 'tool', target: 'missing-source' }] } } },
      { path: 'missing-template-inputs.json', field: 'method.templates[0].inputs', raw: { ...proposal,
        method: { ...proposal.method, templates: [missingInputs, ...assets.templates.slice(1)] },
        edit: { ...proposal.edit, changes: [{ asset: 'workflow', target: 'workflowGuidance' },
          { asset: 'template', target: missingInputs['id'] }] } } },
      { path: 'undeclared-diff.json', field: 'edit.changes', raw: { ...proposal, edit: { ...proposal.edit, changes: [] } } },
      { path: 'unknown-case.json', field: 'edit.predicted_cases', raw: { ...proposal, edit: { ...proposal.edit, predicted_cases: ['invented-case'] } } },
    ]
    const call = (paths: readonly string[]) => proposeRsiMethod(apparatus, {}, agent, agent.id, { paths }, new AbortController().signal)
    const before = factsOf(medium)
    for (const invalid of malformed) {
      await writeFile(join(analysis.workspace, invalid.path), invalid.content ?? JSON.stringify(invalid.raw))
      const error = await call([invalid.path]).then(() => undefined, error => error)
      expect(error, invalid.path).toMatchObject({ refusal: { code: 'malformed-declaration' } })
      expect(error.refusal.detail, invalid.path).toContain(invalid.path)
      expect(error.refusal.detail, invalid.path).toContain(invalid.field)
      expect(error.refusal.detail, invalid.path).toContain('no candidate slots consumed')
      expect(factsOf(medium), invalid.path).toEqual(before)
    }
    await writeFile(join(analysis.workspace, 'no-prune.json'), JSON.stringify(proposal))
    // One valid file does not buy admission for a mixed batch with a malformed peer.
    await expect(call(['no-prune.json', 'missing-event.json'])).rejects.toThrow('missing-event.json')
    expect(factsOf(medium)).toEqual(before)
    expect(taskStateOf(apparatus, analysis.taskId).search!.batches ?? []).toHaveLength(0)
    const admitted = await call(['no-prune.json'])
    expect(admitted).toMatchObject({ admitted: true, slotsConsumed: 1, status: 'invalid',
      reason: 'stalled search requires a real current-asset deletion in its prune slot' })
    expect(admitted).not.toHaveProperty('roundId')
    const batches = taskStateOf(apparatus, analysis.taskId).search!.batches!
    expect(batches).toHaveLength(1)
    expect(batches.every(batch => batch.settled && batch.outcomes.length === 1 && batch.outcomes[0]!.status === 'invalid')).toBe(true)
    expect(factsOf(medium).some(fact => fact.kind === 'review/started')).toBe(false)
  } finally {
    history.read.mockReset()
    await apparatus.store.close()
    await rm(root, { recursive: true, force: true })
  }
})

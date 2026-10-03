/** Task recipes use the existing proposal and child scheduler under a fixed parent oracle. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskTemplate } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { modelSelectionOf } from '../../evolution/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const ID = 'answer-plan'
const PROPOSAL = 'p-plan'
const GOAL = 'test "$(cat answer.txt)" = 42'
const criteria = [{ criterionId: 'goal', description: 'answer is exactly 42', command: GOAL, verifierRef: 'command' }]
let ledger: string
beforeEach(() => { ledger = mkdtempSync(join(tmpdir(), 'dag-evolution-')) })
afterEach(async () => { await disposeScriptedLoops(); rmSync(ledger, { recursive: true, force: true }) })

function plan(version = 1): TaskTemplate {
  return {
    id: ID, version, catalogPath: ['general'], appliesTo: ['deliver the original answer'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: { objective: 'deliver the answer', acceptanceCriteria: criteria, requiredCapabilities: ['execute-task'] },
    decomposition: {
      reason: 'produce the source before consuming it',
      children: [
        {
          objective: 'consume seed.txt into answer.txt', requiredCapabilities: ['execute-task'],
          acceptanceCriteria: [{ criterionId: 'consume', description: 'the answer file exists', command: 'test -s answer.txt', verifierRef: 'command' }],
          ...(version === 1 ? {} : { dependsOn: [1] }),
        },
        {
          objective: `produce seed.txt containing ${version === 1 ? 41 : 42}`, requiredCapabilities: ['execute-task'],
          acceptanceCriteria: [{ criterionId: 'produce', description: 'seed value is correct', command: `test "$(cat seed.txt)" = ${version === 1 ? 41 : 42}`, verifierRef: 'command' }],
        },
      ],
    },
  }
}

async function seedHoldout(h: ScriptedLoop, sourceDir: string) {
  mkdirSync(sourceDir)
  writeFileSync(join(sourceDir, 'answer.txt'), '42')
  await h.task.createTaskIn(STORE, {
    taskId: 't-holdout', definitionRef: { taskType: 'independent-goal', version: 1 }, objective: 'holdout: deliver the answer',
    depth: 0, acceptanceCriteria: criteria.map(criterion => ({ ...criterion, verificationMode: 'deterministic' as const, mandatory: true, requiredEvidence: [] })),
    requestedCapabilities: ['execute-task'], decompositionStatus: 'leaf', status: 'created', runIds: [], childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(STORE, 't-holdout', 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
    taskId: 't-holdout', runId: 'r-holdout', sessionId: 's-holdout', capabilitySnapshot: ['execute-task'], artifacts: [], verifierResults: [], status: 'running', startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, 't-holdout', 'r-holdout', 'verifying', 'tester')
  const evidence = await h.verifier.verifyRun(STORE, 'r-holdout', { cwd: sourceDir })
  await h.task.markRunStatusIn(STORE, 't-holdout', 'r-holdout', 'verified', 'tester')
  await h.task.recordReviewIn(STORE, {
    taskId: 't-holdout', runId: 'r-holdout', sessionId: 's-holdout', outcome: 'verified', evidenceRefs: [evidence.evidenceId], anomalies: [],
    criteria: evidence.verifierResults.map(item => ({ criterionId: item.criterionId, verdict: item.status, verifierId: item.verifierId, verifierVersion: item.verifierVersion })),
  }, 'tester')
}

async function fixture() {
  let h!: ScriptedLoop
  h = await startScriptedLoop({
    roots: [ROOT, 's-control'], evolution: { ledgerRoot: ledger }, supervision: { autoReview: 'off' },
    approvalService: 'native', approvalAnswer: ask => ask.toolName.startsWith('evolution_') ? undefined : 'allowed-once',
    script: (sessionId, index): readonly ScriptEntry[] => {
      if (sessionId === 's-control') return [
        { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE' } },
        { tool: 'evolution_apply', args: { proposalId: PROPOSAL } }, { text: 'done' },
      ]
      const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
      if (name.startsWith('[evolution-experiment:') || name.startsWith('recovery of') || index === 0) return [
        { waitFor: async () => {
          if ((await h.runForSession(sessionId)).task.objective.includes('holdout:'))
            writeFileSync(join(String(h.agent(sessionId).session.header.cwd), 'seed.txt'), '42')
        } },
        { tool: 'task_template_list', args: { catalogPath: ['general'] } },
        { tool: 'task_decompose', args: calls => {
          const result = calls.filter(call => call.sessionId === sessionId && call.name === 'task_template_list').at(-1)?.result?.text ?? '{}'
          const match = JSON.parse(result).entries?.find((item: { kind: string; templateRef?: { id: string } }) => item.kind === 'template' && item.templateRef?.id === ID)
          if (match === undefined) throw new Error('no recipe found in the run library')
          return { templateRef: match.templateRef, templateParameters: {} }
        } },
        { waitFor: async () => { await vi.waitFor(async () => expect((await h.runForSession(sessionId)).run.executionPhase).toBe('active'), { timeout: 10_000, interval: 10 }) } },
        { tool: 'task_submit_result', args: { summary: 'original parent answer ready for its unchanged judge' } }, { text: 'done' },
      ]
      if (name.startsWith('produce seed.txt')) return [
        { waitFor: async () => {
          const { task } = await h.runForSession(sessionId)
          writeFileSync(join(String(h.agent(sessionId).session.header.cwd), 'seed.txt'), task.objective.endsWith('41') ? '41' : '42')
        } }, { tool: 'task_submit_result', args: { summary: 'source value produced' } }, { text: 'done' },
      ]
      if (name.startsWith('consume seed.txt')) return [
        { waitFor: async () => {
          const cwd = String(h.agent(sessionId).session.header.cwd)
          writeFileSync(join(cwd, 'answer.txt'), existsSync(join(cwd, 'seed.txt')) ? readFileSync(join(cwd, 'seed.txt'), 'utf8') : 'missing-source')
        } }, { tool: 'task_submit_result', args: { summary: 'answer copied from the available source' } }, { text: 'done' },
      ]
      return [{ text: 'idle' }]
    },
  })
  await h.runtime.registerTaskTemplate(plan())
  const source = await h.begin({ objective: 'deliver the answer', acceptanceCriteria: criteria, requiredCapabilities: ['execute-task'] })
  await vi.waitFor(async () => expect((await h.snapshot(STORE)).tasks.find(task => task.taskId === source.taskId)?.status,
    JSON.stringify(h.calls.map(call => ({ name: call.name, result: call.result })))).toBe('failed'), { timeout: 15_000 })
  const historical = await h.snapshot(STORE)
  const oldRun = structuredClone(historical.runs.find(run => run.runId === source.runId)!)
  const oldEvidence = structuredClone(historical.evidence.filter(bundle => bundle.taskRunId === source.runId))
  const oldProposal = structuredClone(historical.proposals.all.find(item => item.kind !== 'root' && item.identity.parentRunId === source.runId)!)
  await seedHoldout(h, join(h.workspace, 'holdout'))
  const input = join(h.workspace, 'experiment-input'); mkdirSync(input)
  await h.task.recordDiagnosisIn(STORE, {
    diagnosisId: 'd-plan', taskId: source.taskId, observedFailure: 'consumer ran before source; source value is wrong',
    scope: 'direct-child content and DAG', localizedCause: 'recipe lacks the dependency and writes 41', evidenceRefs: oldEvidence.map(bundle => bundle.evidenceId),
    reviewRefs: [`${source.taskId}#${source.runId}`], confidence: 'high', proposals: [{ targetType: 'task_definition', targetId: ID, rationale: 'repair content and dependency' }],
  }, ROOT)
  await h.ctx.evolution.propose({ proposalId: PROPOSAL, targetType: 'task_definition', targetId: ID, baseVersion: '1', level: 'L2',
    rationale: 'repair content and ordering under the same parent goal', sourceRefs: ['diagnosis:d-plan'] }, ROOT)
  await h.ctx.evolution.candidate(PROPOSAL, { [ID]: '2' }, ROOT, { template: plan(2) })
  await h.ctx.evolution.prepare(PROPOSAL, ROOT)
  const spec = { proposalId: PROPOSAL, samples: [{ taskId: source.taskId, role: 'observed-failure' as const }, { taskId: 't-holdout', role: 'holdout' as const }],
    snapshot: { sourceDir: input }, model: modelSelectionOf({ provider: 'mock', model: 'mock' })!, budget: { note: 'recorded scripted model traffic' }, repetition: 0 }
  return { h, source, oldRun, oldEvidence, oldProposal, spec }
}

async function approve(h: ScriptedLoop, tool: string) {
  await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === tool), JSON.stringify(h.calls.filter(call => call.sessionId === 's-control'))).toBe(true), { timeout: 10_000 })
  h.review.answer(h.review.asks.findIndex(ask => ask.toolName === tool), 'allowed-once')
}

describe('Task decomposition recipe Evolution', () => {
  it('evaluates content and edges, publishes with approval and replans only on a new parent Run', async () => {
    const f = await fixture()
    const result = await f.h.ctx.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
    expect(result.report.verdict, JSON.stringify(result.report.samples)).toBe('fixed')
    expect(result.report.samples.map(sample => sample.candidate.outcome)).toEqual(['verified', 'verified'])
    await f.h.ctx.evolution.checkPromotion(PROPOSAL)
    const snapshotBefore = await f.h.snapshot(STORE)
    const candidateSession = snapshotBefore.runs.find(run => run.runId === result.report.samples[0]!.candidate.runId)!.sessionId
    const query = f.h.ctx.sessionQuery
    const readSession = query.readSession.bind(query)
    const logSpy = vi.spyOn(query, 'readSession').mockImplementation(async (...args) => {
      const read = await readSession(...args)
      if (String(args[0]) !== candidateSession) return read
      return { ...read, events: read.events.map(event => {
        if (event.type !== 'tool/call' || event.data.name !== 'task_decompose') return event
        return { ...event, data: { ...event.data, arguments: JSON.stringify({ reason: 'same batch without selecting the frozen recipe', children: [] }) } }
      }) }
    })
    await expect(f.h.ctx.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/no logged recipe consumption/)
    logSpy.mockRestore()
    const original = f.h.task.openStore.bind(f.h.task)
    for (const kind of ['provenance', 'batch', 'edge', 'consumption'] as const) {
      const spy = vi.spyOn(f.h.task, 'openStore').mockImplementation(async storeId => {
        const snapshot = structuredClone(await original(storeId))
        const parent = snapshot.runs.find(run => run.runId === result.report.samples[0]!.candidate.runId)!
        const proposal = snapshot.proposals.all.find(item => item.kind !== 'root' && item.identity.parentRunId === parent.runId)!
        if (proposal.kind === 'root') throw new Error('expected decomposition')
        if (kind === 'provenance') delete proposal.identity.templateRef
        if (kind === 'batch') proposal.batch[0]!.dependsOn = []
        if (kind === 'edge') snapshot.edges = snapshot.edges.filter(edge => edge.to !== parent.batches![0]!.memberTaskIds[0])
        if (kind === 'consumption') delete proposal.consumption
        return snapshot
      })
      await expect(f.h.ctx.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/recipe|decomposition|consumption/)
      spy.mockRestore()
    }
    await f.h.ctx.evolution.gate(PROPOSAL, {
      targetFailureFixed: 'original parent oracle verified', originalAcceptanceMaintained: 'same frozen command', existingRegressionMaintained: 'independent holdout verified',
      noUnacceptableSideEffects: 'isolated frozen libraries and workspaces', holdoutPerformanceAcceptable: 'verified', resourceCostAcceptable: 'traffic measured', regressionEvidenceRefs: [result.reportPath],
    }, ROOT)
    f.h.userSays('publish the evaluated content and dependency repair', 's-control')
    await approve(f.h, 'evolution_decide'); await approve(f.h, 'evolution_apply')
    await vi.waitFor(async () => expect((await f.h.ctx.evolution.get(PROPOSAL)).status).toBe('applied'), { timeout: 10_000 })
    const recovered = await f.h.runtime.recoverRootTask(STORE, {
      sourceTaskId: f.source.taskId, sourceRunId: f.source.runId, sourceDiagnosisId: 'd-plan', requestKey: 'recipe-replan', proposalIds: [PROPOSAL],
    }, { sessionId: ROOT })
    await vi.waitFor(async () => expect((await f.h.snapshot(STORE)).runs.find(run => run.runId === recovered.runId)?.status).toBe('verified'), { timeout: 15_000 })
    const snapshot = await f.h.snapshot(STORE)
    const proposal = snapshot.proposals.all.find(item => item.kind !== 'root' && item.identity.parentRunId === recovered.runId)!
    if (proposal.kind === 'root' || proposal.consumption?.kind === 'root') throw new Error('expected recipe batch')
    expect(proposal.identity.templateRef).toMatchObject({ id: ID, version: 2 })
    expect(proposal.batch[0]!.dependsOn).toEqual([1])
    const ids = proposal.consumption!.childTaskIds
    expect(snapshot.edges).toContainEqual({ from: ids[1], to: ids[0] })
    const consumer = snapshot.runs.find(run => run.taskId === ids[0])!
    const producer = snapshot.runs.find(run => run.taskId === ids[1])!
    expect(Date.parse(consumer.startedAt)).toBeGreaterThanOrEqual(Date.parse(producer.finishedAt!))
    expect(snapshot.runs.find(run => run.runId === f.source.runId)).toEqual(f.oldRun)
    expect(snapshot.evidence.filter(bundle => bundle.taskRunId === f.source.runId)).toEqual(f.oldEvidence)
    expect(snapshot.proposals.byId[f.oldProposal.proposalId]).toEqual(f.oldProposal)
    expect(snapshot.tasks.find(task => task.taskId === f.source.taskId)?.acceptanceCriteria[0]?.command).toBe(GOAL)
    expect((await f.h.runtime.findTaskTemplates())[0]?.templateRef.version).toBe(2)
  }, 60_000)
})

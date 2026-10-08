/** Task recipes use the existing proposal and child scheduler under a fixed parent oracle. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskTemplate } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { modelSelectionOf } from '../../evolution/src/index.ts'
import { defineEvolutionReplayTool } from '../../agent-singularity/src/tools/evolution-replay.ts'
import { registerTaskTemplate } from '../../task-runtime/src/index.ts'
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

async function fixture(holdoutCandidate = '42') {
  let h!: ScriptedLoop
  h = await startScriptedLoop({
    roots: [ROOT], supervisors: ['s-control'], graphRootFor: () => ROOT, evolution: { ledgerRoot: ledger }, approvalService: 'native', approvalAnswer: ask => ask.toolName.startsWith('evolution_') ? undefined : 'allowed-once',
    script: (sessionId, index): readonly ScriptEntry[] => {
      // The supervisor's spawn carries the fixture's kickoff, which the spec's own
      // `userSays` turn claims; the chain runs on that turn.
      if (sessionId === 's-control') return [
        { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE' } },
        { tool: 'evolution_apply', args: { proposalId: PROPOSAL } }, { text: 'done' },
      ]
      const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
      const cwd = String(h.agent(sessionId).session.header.cwd)
      if (cwd.includes('/t-holdout/')) return [
        { waitFor: async () => {
          expect((await h.runForSession(sessionId)).task.objective).toContain('holdout:')
          writeFileSync(join(cwd, 'answer.txt'), cwd.endsWith('/candidate') ? holdoutCandidate : '42')
        } },
        { tool: 'task_submit_result', args: { summary: 'independent leaf answer ready for its unchanged judge' } }, { text: 'done' },
      ]
      if (name.startsWith('[evolution-experiment:') || name.startsWith('recovery of') || index === 0) return [
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
  await registerTaskTemplate((await h.runtime.libraryForSession(ROOT)).taskTemplatesRoot, plan())
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
  // The deployment's evolution plane, resolved the way every entry resolves it:
  // scoped to the caller's graph library.
  const evolution = await h.ctx.evolution.forSession(ROOT)
  await evolution.propose({ proposalId: PROPOSAL, targetType: 'task_definition', targetId: ID, baseVersion: '1', level: 'L2',
    rationale: 'repair content and ordering under the same parent goal', sourceRefs: ['diagnosis:d-plan'] }, ROOT)
  await evolution.candidate(PROPOSAL, { [ID]: '2' }, ROOT, { template: plan(2) })
  await evolution.prepare(PROPOSAL, ROOT)
  const spec = { proposalId: PROPOSAL, samples: [{ taskId: source.taskId, role: 'observed-failure' as const }, { taskId: 't-holdout', role: 'holdout' as const }],
    snapshot: { sourceDir: input }, model: modelSelectionOf({ provider: 'mock', model: 'mock' })!, budget: { note: 'recorded scripted model traffic' }, repetition: 0 }
  return { h, evolution, source, oldRun, oldEvidence, oldProposal, spec }
}

async function approve(h: ScriptedLoop, tool: string) {
  await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === tool), JSON.stringify(h.calls.filter(call => call.sessionId === 's-control'))).toBe(true), { timeout: 10_000 })
  h.review.answer(h.review.asks.findIndex(ask => ask.toolName === tool), 'allowed-once')
}

describe('Task decomposition recipe Evolution', () => {
  it('evaluates content and edges, publishes with approval and replans only on a new parent Run', async () => {
    const f = await fixture()
    // The entry refuses a sample set that names no case the candidate is meant to
    // fix — the frozen block owes an observed-failure sample for its objective —
    // before anything is frozen or run.
    const noFailure = await defineEvolutionReplayTool(f.h.ctx).execute(
      { proposalId: PROPOSAL, taskIds: ['t-holdout'], holdoutTaskIds: [f.source.taskId] },
      { agent: f.h.agent(ROOT), signal: new AbortController().signal } as never,
    ) as string
    expect(noFailure).toContain('evolution_replay rejected:')
    expect(noFailure).toContain('must include at least one observed-failure')
    const result = await f.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
    expect(result.report.verdict, JSON.stringify(result.report.samples)).toBe('fixed')
    expect(result.report.samples.map(sample => sample.candidate.outcome)).toEqual(['verified', 'verified'])
    const reads = vi.spyOn(f.h.ctx.sessionQuery, 'readSession')
    await f.evolution.checkPromotion(PROPOSAL)
    const firstReads = reads.mock.calls.map(([sessionId]) => String(sessionId))
    expect(firstReads.length).toBeGreaterThan(0)
    expect(new Set(firstReads).size).toBe(firstReads.length)
    reads.mockClear()
    await f.evolution.checkPromotion(PROPOSAL)
    const freshReads = reads.mock.calls.map(([sessionId]) => String(sessionId))
    expect(freshReads.sort()).toEqual(firstReads.sort())
    reads.mockRestore()
    const snapshotBefore = await f.h.snapshot(STORE)
    const holdout = result.report.samples.find(sample => sample.taskId === 't-holdout')!
    expect(holdout.verdict).toBe('maintained')
    for (const side of ['baseline', 'candidate'] as const) {
      const task = snapshotBefore.tasks.find(task => task.taskId === holdout[side].taskId)!
      const run = snapshotBefore.runs.find(run => run.runId === holdout[side].runId)!
      expect(task.decompositionStatus).toBe('leaf')
      expect(task.childTaskIds).toEqual([])
      expect(run.batches ?? []).toEqual([])
      expect(f.h.calls.filter(call => call.sessionId === run.sessionId && call.name === 'task_decompose')).toEqual([])
    }
    const query = f.h.ctx.sessionQuery
    const readSession = query.readSession.bind(query)
    const original = f.h.task.openStore.bind(f.h.task)
    for (const side of ['baseline', 'candidate'] as const) {
      const session = snapshotBefore.runs.find(run => run.runId === result.report.samples[0]![side].runId)!.sessionId
      const logSpy = vi.spyOn(query, 'readSession').mockImplementation(async (...args) => {
        const read = await readSession(...args)
        if (String(args[0]) !== session) return read
        return { ...read, events: read.events.map(event => {
          if (event.type !== 'tool/call' || event.data.name !== 'task_decompose') return event
          return { ...event, data: { ...event.data, arguments: JSON.stringify({ reason: 'same batch without selecting the frozen recipe', children: [] }) } }
        }) }
      })
      await expect(f.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/no logged recipe consumption/)
      logSpy.mockRestore()
      for (const kind of ['provenance', 'batch', 'edge', 'consumption'] as const) {
        const spy = vi.spyOn(f.h.task, 'openStore').mockImplementation(async storeId => {
          const snapshot = structuredClone(await original(storeId))
          const parent = snapshot.runs.find(run => run.runId === result.report.samples[0]![side].runId)!
          const proposal = snapshot.proposals.all.find(item => item.kind !== 'root' && item.identity.parentRunId === parent.runId)!
          if (proposal.kind === 'root') throw new Error('expected decomposition')
          if (kind === 'provenance') delete proposal.identity.templateRef
          if (kind === 'batch') proposal.batch[0]!.contract.objective += ' changed'
          if (kind === 'edge') snapshot.edges.push({ from: parent.batches![0]!.memberTaskIds[0]!, to: parent.batches![0]!.memberTaskIds[1]! })
          if (kind === 'consumption') delete proposal.consumption
          return snapshot
        })
        await expect(f.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/recipe|decomposition|consumption/)
        spy.mockRestore()
      }
    }
    for (const historicalIntact of [true, false]) {
      const noRecipe = vi.spyOn(f.h.task, 'openStore').mockImplementation(async storeId => {
        const snapshot = structuredClone(await original(storeId))
        const runIds = new Set(result.report.samples.flatMap(sample => [sample.baseline.runId, sample.candidate.runId]))
        for (const proposal of snapshot.proposals.all)
          if (proposal.kind !== 'root' && (!historicalIntact || runIds.has(proposal.identity.parentRunId))) delete proposal.identity.templateRef
        const parent = snapshot.runs.find(run => run.runId === result.report.samples[0]!.candidate.runId)!
        const child = snapshot.tasks.find(task => task.taskId === parent.batches![0]!.memberTaskIds[0])!
        child.templateRef = { id: ID, version: 2, digest: result.report.frozen.taskDefinition!.candidate.digest }
        return snapshot
      })
      await expect(f.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(historicalIntact
        ? /template sample .* baseline consumed no frozen decomposition recipe/
        : /candidate parent replay consumed no frozen decomposition recipe/)
      noRecipe.mockRestore()
    }
    await f.evolution.gate(PROPOSAL, {
      targetFailureFixed: 'original parent oracle verified', originalAcceptanceMaintained: 'same frozen command', existingRegressionMaintained: 'independent holdout verified',
      noUnacceptableSideEffects: 'isolated frozen libraries and workspaces', holdoutPerformanceAcceptable: 'verified', resourceCostAcceptable: 'traffic measured', regressionEvidenceRefs: [result.reportPath],
    }, ROOT)
    f.h.userSays('publish the evaluated content and dependency repair', 's-control')
    await approve(f.h, 'evolution_decide')
    await approve(f.h, 'evolution_apply')
    await vi.waitFor(async () => expect((await f.evolution.get(PROPOSAL)).status).toBe('applied'), { timeout: 10_000 })
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
    expect((await f.h.runtime.findTaskTemplates(undefined, ROOT))[0]?.templateRef.version).toBe(2)
  }, 60_000)

  it('rejects promotion when an independent leaf holdout regresses', async () => {
    const f = await fixture('41')
    const result = await f.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
    expect(result.report.verdict).toBe('fixed-with-regression')
    expect(result.report.samples.find(sample => sample.taskId === 't-holdout')!.verdict).toBe('regressed')
    await expect(f.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/requires a clean independent parent result/)
  }, 30_000)
})

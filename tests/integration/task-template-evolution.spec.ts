/** A real model request discovers a repaired child template under an immutable parent oracle. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskTemplate } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { EvolutionService, modelSelectionOf } from '../../evolution/src/index.ts'
import type { CommitStage } from '../../evolution/src/commit.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptEntry,
  type ScriptedLoop,
} from '../support/scripted-loop.ts'

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const ID = 'answer-child'
const PROPOSAL = 'p-template'
const GOAL = 'test "$(cat answer.txt)" = 42'
const criteria = [{ criterionId: 'goal', description: 'answer is exactly 42', command: GOAL, verifierRef: 'command' }]
let ledger: string
beforeEach(() => {
  ledger = mkdtempSync(join(tmpdir(), 'template-evolution-'))
})
afterEach(async () => {
  await disposeScriptedLoops()
  rmSync(ledger, { recursive: true, force: true })
})

function template(command: string, version = 1): TaskTemplate {
  return {
    id: ID,
    version,
    catalogPath: ['general'],
    appliesTo: ['produce the answer'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective: 'produce answer.txt containing 42',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [{ criterionId: 'child', description: 'answer is 42', command, verifierRef: 'command' }],
    },
  }
}

async function historicalExample(h: ScriptedLoop, id: string, sourceDir: string, value: string) {
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'answer.txt'), value)
  await h.task.createTaskIn(
    STORE,
    {
      taskId: id,
      definitionRef: { taskType: 'historical-example', version: 1 },
      objective: id === 't-positive' ? 'holdout: deliver the answer' : 'deliver the answer',
      depth: 0,
      acceptanceCriteria: [
        {
          criterionId: 'goal',
          description: 'answer is exactly 42',
          command: GOAL,
          verifierRef: 'command',
          verificationMode: 'deterministic',
          mandatory: true,
          requiredEvidence: [],
        },
      ],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    },
    'tester',
  )
  await h.task.admitTaskIn(STORE, id, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(
    STORE,
    {
      taskId: id,
      runId: `r-${id}`,
      sessionId: `s-${id}`,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    'tester',
  )
  await h.task.markRunStatusIn(STORE, id, `r-${id}`, 'verifying', 'tester')
  const evidence = await h.verifier.verifyRun(STORE, `r-${id}`, { cwd: sourceDir })
  const status = value === '42' ? 'verified' : 'failed'
  await h.task.markRunStatusIn(STORE, id, `r-${id}`, status, 'tester')
  await h.task.recordReviewIn(
    STORE,
    {
      taskId: id,
      runId: `r-${id}`,
      sessionId: `s-${id}`,
      outcome: status,
      ...(status === 'failed' ? { localizedCause: 'answer differs from the independent oracle' } : {}),
      evidenceRefs: [evidence.evidenceId],
      anomalies: [],
      criteria: evidence.verifierResults.map(item => ({
        criterionId: item.criterionId,
        verdict: item.status,
        verifierId: item.verifierId,
        verifierVersion: item.verifierVersion,
      })),
    },
    'tester',
  )
}

async function fixture(command = GOAL, initial = false) {
  let h!: ScriptedLoop
  let recovery = false
  let allowRollback!: () => void
  const rollbackReady = new Promise<void>(resolve => {
    allowRollback = resolve
  })
  h = await startScriptedLoop({
    roots: [ROOT, 's-control'],
    evolution: { ledgerRoot: ledger },
    supervision: { autoReview: 'off' },
    approvalService: 'native',
    approvalAnswer: ask => (ask.toolName.startsWith('evolution_') ? undefined : 'allowed-once'),
    script: (sessionId, index): readonly ScriptEntry[] => {
      if (sessionId === 's-control')
        return [
          { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE' } },
          { tool: 'evolution_apply', args: { proposalId: PROPOSAL } },
          { waitFor: () => rollbackReady },
          { tool: 'evolution_rollback', args: { proposalId: PROPOSAL } },
          { text: 'done' },
        ]
      const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
      if (name.startsWith('[evolution-experiment:') || name.startsWith('recovery of') || index === 0) {
        if (name.startsWith('recovery of')) recovery = true
        return [
          { tool: 'task_template_list' },
          {
            tool: 'task_decompose',
            args: calls => {
              const list = calls
                .filter(call => call.sessionId === sessionId && call.name === 'task_template_list')
                .at(-1)
              const result = list?.result?.text ?? ''
              const match = result.startsWith('{') ? JSON.parse(result).entries?.find((item: { kind: string }) => item.kind === 'template') : undefined
              return {
                contractVersion: 1,
                reason: 'produce answer with the current reusable child contract',
                children: [
                  match === undefined
                    ? template('test \"$(cat answer.txt)\" = 41').contract
                    : { templateRef: match.templateRef, templateParameters: {} },
                ],
              }
            },
          },
          {
            waitFor: async () => {
              await vi.waitFor(
                async () => expect((await h.runForSession(sessionId)).run.executionPhase).toBe('active'),
                { timeout: 10_000, interval: 10 },
              )
              if ((await h.runForSession(sessionId)).task.objective.includes('holdout:'))
                writeFileSync(join(String(h.agent(sessionId).session.header.cwd), 'answer.txt'), '42')
            },
          },
          { tool: 'task_submit_result', args: { summary: 'the original parent answer is ready' } },
          { text: 'done' },
        ]
      }
      if (name.startsWith('produce answer.txt')) {
        return [
          {
            waitFor: async () => {
              const { task } = await h.runForSession(sessionId)
              writeFileSync(
                join(String(h.agent(sessionId).session.header.cwd), 'answer.txt'),
                task.acceptanceCriteria[0]?.command?.endsWith('= 41') ? '41' : '42',
              )
            },
          },
          { tool: 'task_submit_result', args: { summary: 'wrote the answer the child judge accepts' } },
          { text: 'done' },
        ]
      }
      return [{ text: 'idle' }]
    },
  })
  if (!initial) await h.runtime.registerTaskTemplate(template('test "$(cat answer.txt)" = 41'))
  const source = await h.begin({ objective: 'deliver the answer', acceptanceCriteria: criteria, requiredCapabilities: ['execute-task'] })
  await h.agent(ROOT).whenIdle()
  await vi.waitFor(
    async () =>
      expect(
        (await h.snapshot(STORE)).tasks.find(task => task.taskId === source.taskId)?.status,
        JSON.stringify(h.calls.map(call => ({ name: call.name, result: call.result }))),
      ).toBe('failed'),
    { timeout: 15_000 },
  )
  const old = structuredClone((await h.snapshot(STORE)).runs.find(run => run.runId === source.runId)!)
  const positiveDir = join(h.workspace, 'positive')
  const negativeDir = join(h.workspace, 'negative')
  await historicalExample(h, 't-positive', positiveDir, '42')
  await historicalExample(h, 't-negative', negativeDir, 'wrong')
  const snapshotDir = join(h.workspace, 'experiment-input')
  mkdirSync(snapshotDir)
  await h.task.recordDiagnosisIn(
    STORE,
    {
      diagnosisId: 'd-template',
      taskId: source.taskId,
      observedFailure: 'child delivers the wrong answer',
      scope: 'child contract',
      localizedCause: 'criterion expects 41',
      evidenceRefs: [],
      reviewRefs: [`${source.taskId}#${source.runId}`],
      confidence: 'high',
      proposals: [{ targetType: 'task_definition', targetId: ID, rationale: 'repair the child judge' }],
    },
    ROOT,
  )
  await h.ctx.evolution.propose(
    {
      proposalId: PROPOSAL,
      targetType: 'task_definition',
      targetId: ID,
      baseVersion: initial ? 'absent' : '1',
      level: 'L2',
      rationale: 'child judge expects the wrong answer',
      sourceRefs: ['diagnosis:d-template'],
    },
    ROOT,
  )
  await h.ctx.evolution.candidate(PROPOSAL, { [ID]: '2' }, ROOT, {
    template: template(command, initial ? 1 : 2),
    ...(initial
      ? {}
      : {
          criterionRepair: {
            positive: { taskId: 't-positive', sourceDir: positiveDir, parameters: {} },
            negative: { taskId: 't-negative', sourceDir: negativeDir, parameters: {} },
          },
        }),
  })
  await h.ctx.evolution.prepare(PROPOSAL, ROOT)
  const spec = {
    proposalId: PROPOSAL,
    samples: [
      { taskId: source.taskId, role: 'observed-failure' as const },
      { taskId: 't-positive', role: 'holdout' as const },
    ],
    snapshot: { sourceDir: snapshotDir },
    model: modelSelectionOf({ provider: 'mock', model: 'mock' })!,
    budget: { note: 'scripted model traffic is measured; no token ceiling is asserted' },
    repetition: 0,
  }
  return { h, source, old, spec, recovered: () => recovery, allowRollback }
}

async function answerApproval(h: ScriptedLoop, tool: string) {
  await vi.waitFor(
    () =>
      expect(
        h.review.asks.some(ask => ask.toolName === tool),
        JSON.stringify(
          h.calls
            .filter(call => call.sessionId === 's-control')
            .map(call => ({ name: call.name, result: call.result })),
        ),
      ).toBe(true),
    { timeout: 10_000 },
  )
  h.review.answer(
    h.review.asks.findIndex(ask => ask.toolName === tool),
    'allowed-once',
  )
}

function reopenEvolution(h: ScriptedLoop, interrupt?: CommitStage) {
  const context = new Context()
  for (const name of ['task', 'graphs', 'taskRuntime', 'verifier', 'sessionQuery'])
    context.provide(name, h.ctx.get(name))
  return new EvolutionService(context, {
    root: ledger,
    modelSelection: () => modelSelectionOf({ provider: 'mock', model: 'mock' }),
    ...(interrupt === undefined ? {} : {
      commitProbe: stage => {
        if (stage === interrupt) throw new Error(`template commit interrupted at ${stage}`)
      },
    }),
  })
}

describe('Task template Evolution', () => {
  it('replays the parent, promotes with actual approval, appends versions and lets the responsible parent replan', async () => {
    const f = await fixture()
    const result = await f.h.ctx.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
    expect(result.report.verdict, JSON.stringify(result.report.samples)).toBe('fixed')
    expect(result.report.samples.map(sample => sample.candidate.outcome)).toEqual(['verified', 'verified'])
    await f.h.ctx.evolution.checkPromotion(PROPOSAL)
    const readStore = f.h.task.openStore.bind(f.h.task)
    const guardEvidence = vi.spyOn(f.h.task, 'openStore').mockImplementation(async store => {
      const snapshot = structuredClone(await readStore(store))
      const guard = snapshot.tasks.find(task => task.objective.includes(':criterion-negative:candidate]'))!
      const bundle = snapshot.evidence.find(item => item.taskRunId === guard.runIds[0])!
      bundle.taskRunId = f.source.runId
      return snapshot
    })
    await expect(f.h.ctx.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/criterion guard evidence belongs/)
    guardEvidence.mockRestore()
    const count = (await f.h.snapshot(STORE)).runs.length
    const reopened = reopenEvolution(f.h)
    await reopened.resumeExperiment(result.experimentId, ROOT as SessionId, ROOT)
    expect((await f.h.snapshot(STORE)).runs).toHaveLength(count)
    await f.h.ctx.evolution.gate(
      PROPOSAL,
      {
        targetFailureFixed: 'independent parent now passes',
        originalAcceptanceMaintained: 'same original command',
        existingRegressionMaintained: 'positive preserved',
        noUnacceptableSideEffects: 'separate library and workspace on both arms',
        holdoutPerformanceAcceptable: 'holdout verified',
        resourceCostAcceptable: 'bounded runs',
        regressionEvidenceRefs: [result.reportPath],
      },
      ROOT,
    )
    f.h.userSays('review and publish the evaluated template', 's-control')
    await answerApproval(f.h, 'evolution_decide')
    await answerApproval(f.h, 'evolution_apply')
    await vi.waitFor(async () => expect((await f.h.ctx.evolution.get(PROPOSAL)).status).toBe('applied'), {
      timeout: 10_000,
    })
    expect((await f.h.runtime.findTaskTemplates())[0]?.templateRef.version).toBe(2)
    const parent = await f.h.runtime.recoverRootTask(
      STORE,
      {
        sourceTaskId: f.source.taskId,
        sourceRunId: f.source.runId,
        sourceDiagnosisId: 'd-template',
        requestKey: 'template-replan',
        proposalIds: [PROPOSAL],
      },
      { sessionId: ROOT },
    )
    await vi.waitFor(
      async () =>
        expect((await f.h.snapshot(STORE)).runs.find(run => run.runId === parent.runId)?.status).toBe('verified'),
      { timeout: 15_000 },
    )
    expect(f.recovered()).toBe(true)
    const snapshot = await f.h.snapshot(STORE)
    expect(snapshot.runs.find(run => run.runId === f.source.runId)).toEqual(f.old)
    expect(snapshot.tasks.find(task => task.taskId === f.source.taskId)?.acceptanceCriteria[0]?.command).toBe(GOAL)
    expect(
      snapshot.tasks.filter(task => task.parentTaskId === f.source.taskId).map(task => task.templateRef?.version),
    ).toEqual([1, 2])
    const candidateSession = snapshot.runs.find(run => run.taskTemplatesRoot?.endsWith('/candidate'))?.sessionId
    expect(candidateSession).toBeDefined()
    expect(
      f.h.requestsOf(candidateSession!).some(request => request.texts.some(text => text.includes('"version": 2'))),
    ).toBe(true)
    f.allowRollback()
    await answerApproval(f.h, 'evolution_rollback')
    await vi.waitFor(
      async () =>
        expect(
          (await f.h.ctx.evolution.get(PROPOSAL)).status,
          JSON.stringify(f.h.calls.filter(call => call.name === 'evolution_rollback')),
        ).toBe('rolledback'),
      {
        timeout: 10_000,
      },
    )
    expect((await f.h.runtime.findTaskTemplates())[0]?.templateRef.version).toBe(3)
    expect(JSON.parse(readFileSync(join(f.h.runtime.config.taskTemplatesRoot!, `${ID}@1.json`), 'utf8'))).toEqual(
      template('test "$(cat answer.txt)" = 41'),
    )
    expect(JSON.parse(readFileSync(join(f.h.runtime.config.taskTemplatesRoot!, `${ID}@2.json`), 'utf8'))).toEqual(
      template(GOAL, 2),
    )
    expect(f.h.eventsOf('s-control').filter(event => event.type === 'approval/asked').length).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('grows a first template from the free-contract fallback and rolls it back through the same commit', async () => {
    const f = await fixture(GOAL, true)
    expect(await f.h.runtime.findTaskTemplates()).toEqual([])
    expect((await f.h.ctx.evolution.get(PROPOSAL)).prepared?.templateBaseline).toBeNull()
    const result = await f.h.ctx.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
    expect(result.report.verdict).toBe('fixed')
    await f.h.ctx.evolution.gate(
      PROPOSAL,
      {
        targetFailureFixed: 'new child and original parent pass',
        originalAcceptanceMaintained: 'the original oracle is frozen',
        existingRegressionMaintained: 'holdout passes',
        noUnacceptableSideEffects: 'isolated workspaces',
        holdoutPerformanceAcceptable: 'verified',
        resourceCostAcceptable: 'traffic is recorded',
        regressionEvidenceRefs: [result.reportPath],
      },
      ROOT,
    )
    f.h.userSays('publish the first reusable child template', 's-control')
    await answerApproval(f.h, 'evolution_decide')
    await answerApproval(f.h, 'evolution_apply')
    await vi.waitFor(async () => expect((await f.h.ctx.evolution.get(PROPOSAL)).status).toBe('applied'), {
      timeout: 10_000,
    })
    expect((await f.h.runtime.findTaskTemplates())[0]?.templateRef.version).toBe(1)
    const before = await f.h.snapshot(STORE)
    const bound = before.tasks.find(task => task.templateRef?.id === ID && task.templateRef.version === 1)!
    expect(bound.contract?.objective).toBe('produce answer.txt containing 42')
    f.allowRollback()
    await answerApproval(f.h, 'evolution_rollback')
    await vi.waitFor(
      async () =>
        expect(
          (await f.h.ctx.evolution.get(PROPOSAL)).status,
          JSON.stringify(f.h.calls.filter(call => call.name === 'evolution_rollback')),
        ).toBe('rolledback'),
      {
        timeout: 10_000,
      },
    )
    expect(await f.h.runtime.findTaskTemplates()).toEqual([])
    expect((await f.h.snapshot(STORE)).tasks.find(task => task.taskId === bound.taskId)).toEqual(bound)
    expect((await f.h.snapshot(STORE)).runs.find(run => run.runId === f.source.runId)).toEqual(f.old)
  }, 40_000)

  it.each(['intent-recorded', 'write-renamed'] as const)(
    'reconciles a first publication interrupted at %s and its interrupted removal rollback',
    async stage => {
      const f = await fixture(GOAL, true)
      const result = await f.h.ctx.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
      await f.h.ctx.evolution.gate(PROPOSAL, {
        targetFailureFixed: 'original parent verified',
        originalAcceptanceMaintained: 'frozen oracle unchanged',
        existingRegressionMaintained: 'holdout verified',
        noUnacceptableSideEffects: 'separate library and workspace',
        holdoutPerformanceAcceptable: 'holdout verified',
        resourceCostAcceptable: 'recorded traffic',
        regressionEvidenceRefs: [result.reportPath],
      }, ROOT)
      await f.h.ctx.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:recovery-test')
      const snapshot = await f.h.snapshot(STORE)
      await expect(reopenEvolution(f.h, stage).apply(PROPOSAL, ROOT, 'approval:apply-test'))
        .rejects.toThrow(/template commit interrupted/)
      const applied = reopenEvolution(f.h)
      expect((await applied.get(PROPOSAL)).openIntent?.direction).toBe('apply')
      expect(await applied.reconcile()).toMatchObject([{
        result: stage === 'intent-recorded' ? 'completed-redone' : 'completed-written',
        direction: 'apply',
      }])
      expect((await applied.get(PROPOSAL)).status).toBe('applied')
      expect((await f.h.runtime.findTaskTemplates())[0]?.templateRef.version).toBe(1)
      await expect(reopenEvolution(f.h, 'commit-verified').rollback(PROPOSAL, ROOT, 'approval:rollback-test'))
        .rejects.toThrow(/template commit interrupted/)
      expect(existsSync(f.h.runtime.config.taskTemplatesRoot!)).toBe(true)
      expect(await f.h.runtime.findTaskTemplates()).toEqual([])
      const rolledback = reopenEvolution(f.h)
      expect((await rolledback.get(PROPOSAL)).openIntent?.direction).toBe('rollback')
      expect(await rolledback.reconcile()).toMatchObject([{ result: 'completed-written', direction: 'rollback' }])
      expect((await rolledback.get(PROPOSAL)).status).toBe('rolledback')
      expect(await rolledback.reconcile()).toEqual([])
      expect(await f.h.snapshot(STORE)).toEqual(snapshot)
    },
    40_000,
  )

  it('blocks an open template append before writing when a third party publishes a newer version', async () => {
    const f = await fixture()
    const result = await f.h.ctx.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)
    await f.h.ctx.evolution.gate(PROPOSAL, {
      targetFailureFixed: 'original parent verified',
      originalAcceptanceMaintained: 'frozen oracle unchanged',
      existingRegressionMaintained: 'holdout verified',
      noUnacceptableSideEffects: 'separate library and workspace',
      holdoutPerformanceAcceptable: 'holdout verified',
      resourceCostAcceptable: 'recorded traffic',
      regressionEvidenceRefs: [result.reportPath],
    }, ROOT)
    await f.h.ctx.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:drift-test')
    await expect(reopenEvolution(f.h, 'intent-recorded').apply(PROPOSAL, ROOT, 'approval:apply-test'))
      .rejects.toThrow(/template commit interrupted/)
    const version2 = join(f.h.runtime.config.taskTemplatesRoot!, `${ID}@2.json`)
    expect(existsSync(version2)).toBe(false)
    await f.h.runtime.registerTaskTemplate(template(GOAL, 3))
    const version3 = join(f.h.runtime.config.taskTemplatesRoot!, `${ID}@3.json`)
    const thirdParty = readFileSync(version3)
    const ledgerBefore = readFileSync(join(ledger, 'proposals.jsonl'))
    const reopened = reopenEvolution(f.h)
    expect(await reopened.reconcile()).toMatchObject([{
      result: 'blocked',
      detail: expect.stringContaining('template library changed'),
    }])
    expect(existsSync(version2)).toBe(false)
    expect(readFileSync(version3)).toEqual(thirdParty)
    expect(readFileSync(join(ledger, 'proposals.jsonl'))).toEqual(ledgerBefore)
    expect((await reopened.get(PROPOSAL)).openIntent?.direction).toBe('apply')
    expect((await reopened.get(PROPOSAL)).status).toBe('decided')
  }, 40_000)

  it('refuses the vacuous true criterion against the existing negative oracle case', async () => {
    const f = await fixture('true')
    await expect(f.h.ctx.evolution.runExperiment(f.spec, ROOT as SessionId, ROOT)).rejects.toThrow(
      /negative criterion promotion guard/,
    )
    await expect(f.h.ctx.evolution.checkPromotion(PROPOSAL)).rejects.toThrow()
    expect((await f.h.ctx.evolution.get(PROPOSAL)).status).toBe('prepared')
    expect((await f.h.runtime.findTaskTemplates())[0]?.templateRef.version).toBe(1)
    expect((await f.h.snapshot(STORE)).runs.find(run => run.runId === f.source.runId)).toEqual(f.old)
  }, 40_000)
})

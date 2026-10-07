/**
 * The platform RSI loop driver (F) on the real deployment: a graph that carries
 * `rsi` settings has its rounds scheduled from the platform — one supervision
 * per terminal root round, one next round opened through the runtime's own
 * recovery entry — and a supervisor that reports the loop closed stops it.
 *
 * Everything except the model is the deployment's own: the real DSH loop with a
 * scripted provider, the real `AgentRuntime`/`AgentLoop`, the real `TaskRuntime`
 * (so `recoverRootTask` really opens the next attempt), the real task store and
 * the real coordination ledger.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootTaskStoreId, taskTemplateDigest, type TaskTemplate } from '../../task/src/index.ts'
import type { ExperimentReport } from '../../evolution/src/index.ts'
import { readReviewAgentAttempts } from '../../agent-singularity/src/coordination/ledger.ts'
import {
  roundDiagnosisId,
  roundRequestKey,
  RsiLoopDriver,
} from '../../agent-singularity/src/coordination/rsi-loop.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const GRAPH = 'g1'
const RSI = { task: 'keep the delivered answer method improving', iterationRounds: 2, humanReview: false }
const NO_CHANGE_REPLY = '```json\n{"outcome":"no_change","reason":"no reusable method defect is supported by this round"}\n```'

const criterion = (command: string) => [
  { criterionId: 'goal', description: 'the delivered answer holds', command, verifierRef: 'command' },
]

let ledger: string
beforeEach(() => {
  ledger = mkdtempSync(join(tmpdir(), 'rsi-driver-'))
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', join(ledger, 'review'))
})
afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
  rmSync(ledger, { recursive: true, force: true })
})

/** The root submits; the supervisor explicitly concludes no shared change. */
function scriptOf(h: () => ScriptedLoop): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index): readonly ScriptEntry[] => {
    const name = h().spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
    if (name.startsWith('rsi supervisor')) return [{ text: NO_CHANGE_REPLY }]
    if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
    return [{ text: 'idle' }]
  }
}

/** A historical held-out task with an actual command-verifier verdict, not a fabricated pass record. */
async function verifiedTemplateHoldout(h: ScriptedLoop, command: string): Promise<string> {
  const taskId = 't-unseen-template-holdout'
  const runId = 'r-unseen-template-holdout'
  const source = join(h.workspace, 'historical-holdout')
  mkdirSync(source)
  writeFileSync(join(source, 'answer.txt'), '42')
  await h.task.createTaskIn(STORE, {
    taskId, definitionRef: { taskType: 'historical-holdout', version: 1 },
    objective: 'holdout: deliver the answer after checking the reusable child', depth: 0,
    acceptanceCriteria: [{ criterionId: 'goal', description: 'answer is exactly 42', command,
      verifierRef: 'command', verificationMode: 'deterministic', mandatory: true, requiredEvidence: [] }],
    requestedCapabilities: ['execute-task'], decompositionStatus: 'leaf', status: 'created', runIds: [], childTaskIds: [],
  }, ROOT)
  await h.task.admitTaskIn(STORE, taskId, ROOT, { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
    taskId, runId, sessionId: 's-historical-holdout', capabilitySnapshot: [], artifacts: [], verifierResults: [],
    status: 'running', startedAt: new Date().toISOString(),
  }, ROOT)
  await h.task.markRunStatusIn(STORE, taskId, runId, 'verifying', ROOT)
  const evidence = await h.verifier.verifyRun(STORE, runId, { cwd: source })
  expect(evidence.verifierResults.every(result => result.status === 'pass')).toBe(true)
  await h.task.markRunStatusIn(STORE, taskId, runId, 'verified', ROOT)
  await h.task.recordReviewIn(STORE, {
    taskId, runId, sessionId: 's-historical-holdout', outcome: 'verified', evidenceRefs: [evidence.evidenceId], anomalies: [],
    criteria: evidence.verifierResults.map(result => ({ criterionId: result.criterionId, verdict: result.status,
      verifierId: result.verifierId, verifierVersion: result.verifierVersion })),
  }, ROOT)
  return taskId
}

describe('the platform RSI loop driver on the real deployment', () => {
  it('supervises a verified round and opens its improvement round through the runtime recovery entry', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({ rsi: RSI, evolution: { ledgerRoot: ledger }, script: scriptOf(() => h) })
    const root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()
    expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified')

    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
    } finally {
      driver.stop()
    }

    const snapshot = await h.snapshot(root.storeId)
    // The round's diagnosis exists so the next round's recovery has a record to name.
    const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === roundDiagnosisId(GRAPH, 1))
    expect(diagnosis).toMatchObject({ taskId: root.taskId, proposals: [] })
    // The supervisor was spawned by the driver, under the round's own identity.
    const supervisor = h.spawns.find(spawn => spawn.name.startsWith('rsi supervisor'))
    expect(supervisor, JSON.stringify(h.spawns.map(spawn => spawn.name))).toBeDefined()
    expect(supervisor!.prompt).toContain(`Cite diagnosis:${roundDiagnosisId(GRAPH, 1)}`)
    expect(supervisor!.prompt).toContain('task_recover is deliberately not granted')
    expect(await readReviewAgentAttempts(STORE)).toEqual([
      expect.objectContaining({
        role: 'supervisor', diagnosisId: roundDiagnosisId(GRAPH, 1), started: true,
        settlement: expect.objectContaining({ status: 'recorded', note: 'no_change: no reusable method defect is supported by this round' }),
      }),
    ])
    // The next round is an improvement of the verified attempt, opened by the driver.
    const next = snapshot.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 2))
    expect(next?.recovery).toMatchObject({
      kind: 'improvement',
      sourceDiagnosisId: roundDiagnosisId(GRAPH, 1),
      sourceRunId: root.runId,
      reusedMembers: [],
    })
    expect(h.rsiProgressOf()).toMatchObject({ round: 2, phase: 'running' })
  }, 30_000)

  it('supervises a failed round with its review cause and opens a recovery round', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({ rsi: RSI, evolution: { ledgerRoot: ledger }, script: scriptOf(() => h) })
    const root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('false'),
    })
    await h.agent(ROOT).whenIdle()
    expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('failed')

    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
    } finally {
      driver.stop()
    }

    const snapshot = await h.snapshot(root.storeId)
    const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === roundDiagnosisId(GRAPH, 1))
    expect(diagnosis?.proposals).toEqual([])
    // The observation is the review's own recorded cause, verbatim.
    const review = snapshot.reviews.find(item => item.runId === root.runId)!
    expect(diagnosis?.observedFailure).toBe(review.localizedCause)
    const supervisor = h.spawns.find(spawn => spawn.name.startsWith('rsi supervisor'))
    expect(supervisor!.prompt).toContain('debug that failure')
    const next = snapshot.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 2))
    expect(next?.recovery).toMatchObject({ kind: 'recovery', sourceDiagnosisId: roundDiagnosisId(GRAPH, 1) })
    expect(h.rsiProgressOf()).toMatchObject({ round: 2, phase: 'running' })
  }, 30_000)

  it('stops the loop when its supervisor reports the loop must not continue', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      rsi: RSI,
      evolution: { ledgerRoot: ledger },
      script: (sessionId, index): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor'))
          return [{ text: '```json\n{"outcome":"closed","reason":"the contract cannot be satisfied"}\n```' }]
        if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
        return [{ text: 'idle' }]
      },
    })
    const root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()

    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
    } finally {
      driver.stop()
    }

    const snapshot = await h.snapshot(root.storeId)
    // No next round: the supervisor's explicit stop is the loop's own end.
    expect(snapshot.runs.some(run => run.recovery !== undefined)).toBe(false)
    expect(h.rsiProgressOf()).toMatchObject({ round: 1, phase: 'failed' })
    expect((h.rsiProgressOf() as { note: string }).note).toContain('the contract cannot be satisfied')
    const attempt = (await readReviewAgentAttempts(STORE)).find(item => item.role === 'supervisor')
    expect(attempt?.settlement?.status).toBe('closed')
  }, 30_000)

  it('does not reuse a verified child when the platform opens an improvement attempt', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      rsi: RSI,
      evolution: { ledgerRoot: ledger },
      script: (sessionId): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor')) return [{ text: NO_CHANGE_REPLY }]
        // The test drives each parent's real runtime contract/decomposition;
        // the child hands its own result through the actual DSH tool loop.
        if (sessionId === ROOT || name.startsWith('recovery of')) return [{ text: 'await the concrete task contract' }]
        return [{ tool: 'task_submit_result', args: { summary: 'the child result holds' } }, { text: 'delivered' }]
      },
    })
    const root = await h.begin({
      objective: 'deliver the answer with its verified child',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [
        ...criterion('true'),
        { criterionId: 'child-map', description: 'the attempt owns a verified child', mode: 'composite', mandatory: true,
          childEvidence: [{ childIndex: 0, criterionId: 'goal' }] },
      ],
    })
    await h.agent(ROOT).whenIdle()
    const childSpec = {
      reason: 'delegate the independently verified child',
      children: [{ objective: 'deliver the child answer', requiredCapabilities: ['execute-task'], acceptanceCriteria: criterion('true') }],
    }
    const firstBatch = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, childSpec)
    expect(firstBatch.status).toBe('admitted')
    expect((await h.runtime.awaitBatch(STORE, firstBatch.batchId)).map(result => result.status)).toEqual(['verified'])
    expect((await h.runtime.submitResult(ROOT, { summary: 'the original parent result holds' })).status).toBe('verified')
    const firstChild = firstBatch.childTaskIds[0]!

    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
      const started = await h.snapshot(STORE)
      const next = started.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 2))!
      expect(next.recovery).toMatchObject({ kind: 'improvement', reusedMembers: [] })
      expect((await h.task.runMembersIn(STORE, next.runId)).map(task => task.taskId)).toEqual([])
      expect(started.runs.find(run => run.runId === root.runId)?.status).toBe('verified')
      await h.agent(next.sessionId!).whenIdle()
      const secondBatch = await h.runtime.decomposeAndRun(STORE, root.taskId, next.runId, String(next.sessionId), childSpec)
      expect(secondBatch.status).toBe('admitted')
      expect(secondBatch.childTaskIds[0]).not.toBe(firstChild)
      expect((await h.runtime.awaitBatch(STORE, secondBatch.batchId)).map(result => result.status)).toEqual(['verified'])
      expect((await h.runtime.submitResult(String(next.sessionId), { summary: 'the new parent and child results hold' })).status).toBe('verified')
      const completed = await h.snapshot(STORE)
      expect(completed.runs.filter(run => run.taskId === firstChild)).toHaveLength(1)
      expect((await h.task.runMembersIn(STORE, next.runId)).map(task => task.taskId)).toEqual(secondBatch.childTaskIds)
      await driver.ensure(GRAPH)
      expect(h.rsiProgressOf()).toMatchObject({ round: 2, phase: 'done' })
      expect(h.spawns.filter(spawn => spawn.name.startsWith('rsi supervisor'))).toHaveLength(1)
    } finally {
      driver.stop()
    }
  }, 30_000)

  it('blocks an unfinished real proposal instead of accepting a contradictory no_change', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      rsi: RSI,
      evolution: { ledgerRoot: ledger },
      script: (sessionId, index): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor')) return [
          { tool: 'evolution_propose', args: {
            proposalId: 'p-unfinished', targetType: 'skill', targetId: 'future-method', baseVersion: '1', level: 'L1',
            rationale: 'the method candidate is still unfinished', sourceRefs: [`diagnosis:${roundDiagnosisId(GRAPH, 1)}`],
          } },
          { text: NO_CHANGE_REPLY },
        ]
        if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer holds' } }, { text: 'delivered' }]
        return [{ text: 'idle' }]
      },
    })
    const root = await h.begin({ objective: 'deliver the answer', requiredCapabilities: ['execute-task'], acceptanceCriteria: criterion('true') })
    await h.agent(ROOT).whenIdle()
    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
      expect((await h.ctx.evolution.list()).find(proposal => proposal.proposalId === 'p-unfinished')?.status).toBe('proposed')
      expect((await h.snapshot(STORE)).runs.some(run => run.recovery !== undefined)).toBe(false)
      expect(h.rsiProgressOf()).toMatchObject({ round: 1, phase: 'failed' })
      expect((h.rsiProgressOf() as { note: string }).note).toContain('p-unfinished [proposed]')
      expect((await readReviewAgentAttempts(STORE)).at(-1)?.settlement).toMatchObject({ status: 'closed' })
    } finally {
      driver.stop()
    }
  }, 30_000)

  it('retains the final failed execution without an extra publication phase', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({ rsi: { ...RSI, iterationRounds: 1 }, evolution: { ledgerRoot: ledger }, script: scriptOf(() => h) })
    const root = await h.begin({ objective: 'deliver the answer', requiredCapabilities: ['execute-task'], acceptanceCriteria: criterion('false') })
    await h.agent(ROOT).whenIdle()
    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
      expect((await h.snapshot(STORE)).runs.find(run => run.runId === root.runId)?.status).toBe('failed')
      expect(h.rsiProgressOf()).toMatchObject({ round: 1, phase: 'failed' })
      expect((h.rsiProgressOf() as { note: string }).note).toContain('final round failed')
      expect(h.spawns).toEqual([])
      expect(await readReviewAgentAttempts(STORE)).toEqual([])
    } finally {
      driver.stop()
    }
  }, 30_000)

  it('publishes a first TaskTemplate through the supervisor experiment chain and consumes its frozen binding in the driver recovery', async () => {
    const proposalId = 'p-rsi-first-template'
    const templateId = 'rsi-answer-child'
    const oracle = 'test "$(cat answer.txt)" = 42'
    const badChildJudge = 'test "$(cat answer.txt)" = 41'
    const candidate: TaskTemplate = {
      id: templateId, version: 1, catalogPath: ['general'], appliesTo: ['produce the answer'],
      parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
      contract: {
        objective: 'produce answer.txt containing 42', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'child', description: 'answer is exactly 42', command: oracle, verifierRef: 'command' }],
      },
    }
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    let holdoutTaskId!: string
    let cleanInputs!: string
    h = await startScriptedLoop({
      rsi: RSI,
      evolution: { ledgerRoot: ledger },
      approvalService: 'native',
      approvalAnswer: () => 'allowed-once',
      script: (sessionId): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor')) return [
          { tool: 'evolution_propose', args: {
            proposalId, targetType: 'task_definition', targetId: templateId, baseVersion: 'absent', level: 'L2',
            rationale: 'the one-off child accepts 41 but the independent parent oracle requires 42; extract the corrected reusable child contract',
            sourceRefs: [`diagnosis:${roundDiagnosisId(GRAPH, 1)}`],
          } },
          { tool: 'evolution_candidate', args: { proposalId, versionSet: { [templateId]: '1' }, mutationJson: JSON.stringify({ template: candidate }) } },
          { tool: 'evolution_prepare', args: { proposalId } },
          { tool: 'evolution_replay', args: {
            proposalId, taskIds: [root.taskId], holdoutTaskIds: [holdoutTaskId], snapshot: { sourceDir: cleanInputs },
            budget: { note: 'real scripted Run traffic is recorded; no unreported token ceiling is asserted' },
          } },
          { tool: 'evolution_gate', args: calls => {
            const answer = calls.filter(call => call.sessionId === sessionId && call.name === 'evolution_replay').at(-1)?.result?.text ?? ''
            const report = answer.match(/^report: (.+)$/m)?.[1]
            if (report === undefined) throw new Error(`the real replay produced no report: ${answer}`)
            return {
              proposalId, targetFailureFixed: 'the saved experiment fixes the independent parent oracle',
              originalAcceptanceMaintained: 'the original command is unchanged on both sides',
              existingRegressionMaintained: 'the independent historical holdout still passes',
              noUnacceptableSideEffects: 'each arm runs in its own copied input and frozen template library',
              holdoutPerformanceAcceptable: 'the holdout passes both arms', resourceCostAcceptable: 'Run traffic is recorded',
              regressionEvidenceRefs: [report],
            }
          } },
          { tool: 'evolution_decide', args: { proposalId, decision: 'PROMOTE' } },
          { tool: 'evolution_apply', args: { proposalId } },
          { text: 'the evaluated first child template is published; the platform owns the next execution' },
        ]
        if (sessionId === ROOT || name.startsWith('[evolution-experiment:') || name.startsWith('recovery of')) return [
          { tool: 'task_template_list' },
          { tool: 'task_decompose', args: calls => {
            const answer = calls.filter(call => call.sessionId === sessionId && call.name === 'task_template_list').at(-1)?.result?.text ?? ''
            const entry = answer.startsWith('{')
              ? JSON.parse(answer).entries?.find((item: { kind: string; templateRef?: { id: string } }) => item.kind === 'template' && item.templateRef?.id === templateId)
              : undefined
            return {
              reason: 'produce the answer with the currently available reusable child contract',
              children: [entry === undefined
                ? { ...candidate.contract, acceptanceCriteria: [{ criterionId: 'child', description: 'one-off child accepts 41', command: badChildJudge, verifierRef: 'command' }] }
                : { templateRef: entry.templateRef, templateParameters: {} }],
            }
          } },
          { waitFor: async () => {
            await vi.waitFor(async () => expect((await h.runForSession(sessionId)).run.executionPhase).toBe('active'), { timeout: 10_000, interval: 10 })
            // The held-out parent owns its final result independently of this
            // child method, so the baseline already passes that separate case.
            if ((await h.runForSession(sessionId)).task.objective.includes('holdout:'))
              writeFileSync(join(String(h.agent(sessionId).session.header.cwd), 'answer.txt'), '42')
          } },
          { tool: 'task_submit_result', args: { summary: 'the original parent answer is ready for its fixed oracle' } },
          { text: 'delivered' },
        ]
        if (name.startsWith('produce answer.txt')) return [
          { waitFor: async () => {
            const { task } = await h.runForSession(sessionId)
            writeFileSync(join(String(h.agent(sessionId).session.header.cwd), 'answer.txt'), task.acceptanceCriteria[0]?.command === badChildJudge ? '41' : '42')
          } },
          { tool: 'task_submit_result', args: { summary: 'the child result satisfies its bound contract' } },
          { text: 'delivered' },
        ]
        return [{ text: 'idle' }]
      },
    })
    root = await h.begin({ objective: 'deliver the answer', requiredCapabilities: ['execute-task'], acceptanceCriteria: criterion(oracle) })
    await vi.waitFor(async () => expect((await h.task.runIn(STORE, root.runId)).status).toBe('failed'), { timeout: 15_000 })
    const original = await h.snapshot(STORE)
    const originalRoot = original.tasks.find(task => task.taskId === root.taskId)!
    const oneOff = original.tasks.find(task => task.parentTaskId === root.taskId)!
    expect(oneOff.templateRef).toBeUndefined()
    expect(await h.runtime.findTaskTemplates()).toEqual([])
    holdoutTaskId = await verifiedTemplateHoldout(h, oracle)
    cleanInputs = join(h.workspace, 'clean-template-replay-input')
    mkdirSync(cleanInputs)
    const driver = new RsiLoopDriver(h.ctx, { log: () => {} })
    try {
      await driver.ensure(GRAPH)
      const publication = await h.ctx.evolution.get(proposalId)
      const supervisor = h.spawns.find(spawn => spawn.name.startsWith('rsi supervisor'))!
      expect(await readReviewAgentAttempts(STORE)).toEqual([expect.objectContaining({
        role: 'supervisor', source: { taskId: root.taskId, runId: root.runId },
        sessionId: supervisor.sessionId, diagnosisId: roundDiagnosisId(GRAPH, 1), started: true,
        settlement: expect.objectContaining({ status: 'recorded' }),
      })])
      const chain = ['evolution_propose', 'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply']
      const supervisedCalls = h.calls.filter(call => call.sessionId === supervisor.sessionId && chain.includes(call.name))
      expect(supervisedCalls.map(call => call.name)).toEqual(chain)
      for (const call of supervisedCalls) {
        expect(call.result?.isError, `${call.name}: ${call.result?.text}`).toBe(false)
        expect(call.result?.text, call.name).not.toContain('rejected:')
      }
      expect(publication.status, JSON.stringify(supervisedCalls.map(call => ({ name: call.name, result: call.result })))).toBe('applied')
      expect(publication.prepared?.templateBaseline).toBeNull()
      expect(publication.prepared?.templateCandidate?.digest).toBe(taskTemplateDigest(candidate))
      const [experiment] = await h.ctx.evolution.experiments(proposalId)
      const report = JSON.parse(readFileSync(join(ledger, experiment!.report), 'utf8')) as ExperimentReport
      expect(report.verdict).toBe('fixed')
      expect(report.frozen.taskDefinition?.baseline).toBeNull()
      expect(report.frozen.taskDefinition?.candidate.template).toEqual(candidate)
      expect(report.samples.find(sample => sample.taskId === root.taskId)).toMatchObject({ baseline: { outcome: 'failed' }, candidate: { outcome: 'verified' } })
      expect(report.samples.find(sample => sample.taskId === holdoutTaskId)).toMatchObject({ role: 'holdout', baseline: { outcome: 'verified' }, candidate: { outcome: 'verified' } })
      const sideIds = report.samples.flatMap(sample => [sample.baseline.runId, sample.candidate.runId])
      expect(new Set(sideIds).size).toBe(4)
      expect(sideIds).not.toContain(root.runId)
      const next = (await h.snapshot(STORE)).runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 2))!
      expect(next.recovery).toMatchObject({ kind: 'recovery', sourceRunId: root.runId, proposalIds: [proposalId] })
      await vi.waitFor(async () => expect((await h.task.runIn(STORE, next.runId)).status).toBe('verified'), { timeout: 15_000 })
      const completed = await h.snapshot(STORE)
      const memberIds = (await h.task.runMembersIn(STORE, next.runId)).map(task => task.taskId)
      const bound = completed.tasks.find(task => memberIds.includes(task.taskId) && task.templateRef?.id === templateId)!
      const boundRun = completed.runs.find(run => run.taskId === bound.taskId)!
      expect(bound.templateRef).toEqual({ id: templateId, version: 1, digest: taskTemplateDigest(candidate) })
      expect(bound.definitionRef).toMatchObject({ version: 1, digest: taskTemplateDigest(candidate) })
      expect(bound.contract?.objective).toBe(candidate.contract.objective)
      expect(bound.acceptanceCriteria[0]?.command).toBe(oracle)
      expect(boundRun).toMatchObject({ parentRunId: next.runId, status: 'verified' })
      expect(JSON.parse(readFileSync(join(h.runtime.config.taskTemplatesRoot!, `${templateId}@1.json`), 'utf8'))).toEqual(candidate)
      expect(completed.tasks.find(task => task.taskId === root.taskId)?.contract).toEqual(originalRoot.contract)
      expect(completed.tasks.find(task => task.taskId === oneOff.taskId)).toEqual(oneOff)
      expect(completed.runs.find(run => run.runId === root.runId)).toEqual(original.runs.find(run => run.runId === root.runId))
      expect(h.eventsOf(supervisor.sessionId).filter(event => event.type === 'approval/asked')).toHaveLength(2)
      await driver.ensure(GRAPH)
      expect(h.rsiProgressOf()).toMatchObject({ round: 2, phase: 'done' })
      expect(h.spawns.filter(spawn => spawn.name.startsWith('rsi supervisor'))).toHaveLength(1)
    } finally {
      driver.stop()
    }
  }, 60_000)
})

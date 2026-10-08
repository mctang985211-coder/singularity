import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { buildExperimentReport, EvolutionService, modelSelectionOf } from '../../evolution/src/index.ts'
import { defineEvolutionReplayTool } from '../../agent-singularity/src/tools/evolution-replay.ts'
import { registerTaskTemplate } from '../../task-runtime/src/task-template.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const METHOD = 'answer-route'
const MARKER = 'EXPERIENCE: verify the candidate answer against the independent oracle.'
const SKILL = `---\nname: ${METHOD}\ndescription: Produce and check the answer\n---\n${MARKER}\n`
const CRITERIA = [{ criterionId: 'answer', description: 'answer equals 42', command: 'test "$(cat answer.txt)" = 42', verifierRef: 'command' }]

afterEach(async () => { await disposeScriptedLoops() })

async function holdout(h: ScriptedLoop) {
  const cwd = join(h.workspace, 'holdout')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'answer.txt'), '42')
  await h.task.createTaskIn(STORE, { taskId: 't-holdout', definitionRef: { taskType: 'holdout', version: 1 },
    objective: 'holdout: deliver an answer', depth: 0,
    acceptanceCriteria: CRITERIA.map(item => ({ ...item, verificationMode: 'deterministic', mandatory: true, requiredEvidence: [] })),
    requestedCapabilities: ['execute-task'], decompositionStatus: 'leaf', status: 'created', runIds: [], childTaskIds: [] }, 'tester')
  await h.task.admitTaskIn(STORE, 't-holdout', 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, { taskId: 't-holdout', runId: 'r-holdout', sessionId: 's-holdout',
    status: 'running', capabilitySnapshot: [], artifacts: [], verifierResults: [], startedAt: new Date().toISOString() }, 'tester')
  await h.task.markRunStatusIn(STORE, 't-holdout', 'r-holdout', 'verifying', 'tester')
  const evidence = await h.verifier.verifyRun(STORE, 'r-holdout', { cwd })
  await h.task.markRunStatusIn(STORE, 't-holdout', 'r-holdout', 'verified', 'tester')
  await h.task.recordReviewIn(STORE, { taskId: 't-holdout', runId: 'r-holdout', sessionId: 's-holdout', outcome: 'verified',
    evidenceRefs: [evidence.evidenceId], anomalies: [], criteria: evidence.verifierResults.map(item => ({ criterionId: item.criterionId,
      verdict: item.status, verifierId: item.verifierId, verifierVersion: item.verifierVersion })) }, 'tester')
}

describe('a first graph-local Skill enters the complete RSI publication and consumption path', () => {
  it.each([true, false])('runs the complete graph-local publication and consumption chain (independent holdout: %s)', async withHoldout => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({ roots: [ROOT, 's-other'], evolution: { ledgerRoot: join('/tmp', `legacy-evolution-${Date.now()}`) },
      script: (sessionId): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('recovery of')) return [
          { tool: 'task_template_list', args: { catalogPath: ['general'] } },
          { tool: 'task_decompose', args: calls => {
            const text = calls.filter(call => call.sessionId === sessionId && call.name === 'task_template_list').at(-1)?.result?.text ?? '{}'
            const entry = JSON.parse(text).entries.find((row: { kind: string }) => row.kind === 'template')
            return { reason: 'reuse the reviewed Task and experience', children: [{ templateRef: entry.templateRef, templateParameters: {} }] }
          } },
          { waitFor: async () => { await vi.waitFor(async () => expect((await h.runForSession(sessionId)).run.executionPhase).toBe('active'), { timeout: 10_000 }) } },
          { tool: 'task_submit_result', args: { summary: 'delivered the template result' } }, { text: 'done' },
        ]
        if (sessionId === 's-other') return [{ text: 'idle' }]
        return [
          { waitFor: async () => {
            const { task, run } = await h.runForSession(sessionId)
            const learned = run.providerBinding?.skills.some(skill => skill.name === METHOD) === true
            writeFileSync(join(String(h.agent(sessionId).session.header.cwd), 'answer.txt'), learned || task.objective.includes('holdout:') ? '42' : '41')
          } },
          { tool: 'task_submit_result', args: { summary: 'wrote and checked the answer' } }, { text: 'done' },
        ]
      } })
    const source = await h.begin({ objective: 'deliver an answer', acceptanceCriteria: CRITERIA, requiredCapabilities: ['execute-task'] })
    await vi.waitFor(async () => expect((await h.snapshot(STORE)).runs.find(run => run.runId === source.runId)?.status).toBe('failed'), { timeout: 10_000 })
    if (withHoldout) await holdout(h)
    const library = await h.runtime.libraryForSession(ROOT)
    const evolution = await h.ctx.evolution.forSession(ROOT)
    await evolution.propose({ proposalId: 'p-method', targetType: 'skill', targetId: METHOD, baseVersion: 'absent', level: 'L1',
      rationale: 'capture an effective answer route', sourceRefs: [`${source.taskId}#${source.runId}`] }, ROOT)
    await evolution.candidate('p-method', { [METHOD]: '1' }, ROOT, { name: METHOD, content: SKILL })
    expect((await evolution.prepare('p-method', ROOT)).prepared).toMatchObject({ champion: 'absent', skillBaseline: null })
    const clean = join(h.workspace, 'clean-input')
    mkdirSync(clean)
    expect((await h.snapshot(STORE)).tasks).toHaveLength(withHoldout ? 2 : 1)
    const replay = defineEvolutionReplayTool(h.ctx)
    expect(replay.parameters).not.toHaveProperty('libraryId')
    const output = await replay.execute({ proposalId: 'p-method', taskIds: [source.taskId],
      ...(withHoldout ? { holdoutTaskIds: ['t-holdout'] } : {}), snapshot: { sourceDir: clean } },
      { agent: h.agent(ROOT), callId: 'call-experiment', signal: new AbortController().signal } as never)
    expect(output).toContain('verdict: fixed')
    if (!withHoldout) expect(output).toContain('transfer to unseen Tasks: unknown')
    const [view] = await evolution.experiments('p-method')
    const result = { report: buildExperimentReport(view!), reportPath: view!.report }
    expect(result.report.verdict).toBe('fixed')
    expect(result.report.frozen.libraryId).toBe(ROOT)
    expect(result.report.samples).toHaveLength(withHoldout ? 2 : 1)
    expect(result.report.frozen.productionBaseline).toBeUndefined()
    for (const sample of result.report.samples) {
      const snapshot = await h.snapshot(STORE)
      const baseline = snapshot.runs.find(run => run.runId === sample.baseline.runId)!
      const candidate = snapshot.runs.find(run => run.runId === sample.candidate.runId)!
      expect(baseline.providerBinding?.skills.some(skill => skill.name === METHOD)).toBe(false)
      expect(candidate.providerBinding?.skills.some(skill => skill.name === METHOD)).toBe(true)
      expect(h.requestsOf(candidate.sessionId).some(request => request.texts.some(text => text.includes(MARKER)))).toBe(true)
    }
    await evolution.gate('p-method', { targetFailureFixed: 'observed Task fixed', originalAcceptanceMaintained: 'same original acceptance',
      existingRegressionMaintained: withHoldout ? 'holdout verified' : 'graph-local observed Task and original oracle compared',
      noUnacceptableSideEffects: 'guidance only', holdoutPerformanceAcceptable: withHoldout ? 'holdout verified' : 'transfer to unseen Tasks remains unknown',
      resourceCostAcceptable: 'actual Run counters saved in report; token usage is unknown for this scripted provider', regressionEvidenceRefs: [result.reportPath] }, ROOT)
    for (const scope of [undefined, 's-other']) {
      const wrongScope = new EvolutionService(h.ctx.isolate('evolution'), { root: evolution.root, skillRoot: library.skillRoot,
        taskTemplatesRoot: library.taskTemplatesRoot, libraryId: scope, modelSelection: () => modelSelectionOf({ provider: 'mock', model: 'mock' }) })
      await expect(wrongScope.checkPromotion('p-method')).rejects.toThrow('different graph library or publication scope')
    }
    await evolution.decide('p-method', 'PROMOTE', ROOT, 'approval:test-decision')
    expect((await evolution.apply('p-method', ROOT, 'approval:test-apply')).targets).toEqual([join(library.skillRoot, METHOD, 'SKILL.md')])
    expect(readFileSync(join(library.skillRoot, METHOD, 'SKILL.md'), 'utf8')).toBe(SKILL)
    await expect((await h.ctx.evolution.forSession('s-other')).get('p-method')).rejects.toThrow('unknown proposal')
    await h.runtime.libraryReview(ROOT, { kind: 'skill', name: METHOD, version: 1, status: 'retained',
      reason: withHoldout ? 'real Task and independent holdout succeeded' : 'real Task comparison succeeded; fresh Task transfer unknown' })
    await registerTaskTemplate(library.taskTemplatesRoot, { id: 'answer-task', version: 1, catalogPath: ['general'], appliesTo: ['deliver answer'],
      parametersSchema: { type: 'object', properties: {}, additionalProperties: false }, contract: { objective: 'produce an answer using the reviewed route',
        requiredCapabilities: ['execute-task', `method:${METHOD}`], acceptanceCriteria: CRITERIA } })
    await h.task.recordDiagnosisIn(STORE, { diagnosisId: 'd-answer', taskId: source.taskId, observedFailure: 'answer misses the oracle', scope: 'execution',
      localizedCause: 'route not recorded', evidenceRefs: [], reviewRefs: [`${source.taskId}#${source.runId}`], confidence: 'high',
      proposals: [{ targetType: 'skill', targetId: METHOD, rationale: 'use reviewed route' }] }, ROOT)
    const recovery = await h.runtime.recoverRootTask(STORE, { sourceTaskId: source.taskId, sourceRunId: source.runId,
      sourceDiagnosisId: 'd-answer', requestKey: 'use-published-method', proposalIds: ['p-method'] }, { sessionId: ROOT })
    await vi.waitFor(async () => expect((await h.snapshot(STORE)).runs.find(run => run.runId === recovery.runId)?.status,
      JSON.stringify(h.calls.map(call => ({ name: call.name, result: call.result })))).toBe('verified'), { timeout: 15_000 })
    const snapshot = await h.snapshot(STORE)
    const consumed = snapshot.runs.find(run => run.providerBinding?.skills.some(skill => skill.name === METHOD) &&
      snapshot.tasks.find(task => task.taskId === run.taskId)?.templateRef?.id === 'answer-task')!
    expect(consumed).toBeDefined()
    expect(readFileSync(join(consumed.providerBinding!.snapshotRoot!, METHOD, 'SKILL.md'), 'utf8')).toBe(SKILL)
    expect(h.requestsOf(consumed.sessionId).some(request => request.texts.some(text => text.includes(MARKER)))).toBe(true)
    expect(snapshot.runs.find(run => run.runId === source.runId)?.status).toBe('failed')
    const interrupted = new EvolutionService(h.ctx.isolate('evolution'), { modelSelection: () => modelSelectionOf({ provider: 'mock', model: 'mock' }),
      commitProbe: stage => { if (stage === 'intent-recorded') throw new Error('process interrupted after recording the graph-local rollback intent') } })
    await expect((await interrupted.forSession(ROOT)).rollback('p-method', ROOT, 'approval:test-rollback')).rejects.toThrow('process interrupted')
    expect(JSON.parse(readFileSync(join(evolution.root, 'proposals.jsonl'), 'utf8').trim().split('\n').at(-1)!)).toMatchObject({ kind: 'commit_intent', direction: 'rollback' })
    const restarted = new EvolutionService(h.ctx.isolate('evolution'), { modelSelection: () => modelSelectionOf({ provider: 'mock', model: 'mock' }) })
    const recovered = await restarted.forSession(ROOT)
    expect(recovered.root).toBe(evolution.root)
    expect((await recovered.get('p-method')).status, JSON.stringify(await recovered.reconcile())).toBe('rolledback')
    expect(await recovered.openIntentTargets()).toEqual([])
    await expect(recovered.checkProductionBaseline('p-method')).resolves.toBeUndefined()
    await expect((await restarted.forSession('s-other')).get('p-method')).rejects.toThrow('unknown proposal')
  })
})

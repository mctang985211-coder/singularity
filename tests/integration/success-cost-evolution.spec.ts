/** Verified-source optimization through the actual model loop, experiment, human gates and production attempt. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildExperimentReport, costOf } from '../../evolution/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { skillContentDigest } from '../../task-runtime/src/index.ts'
import { readReviewAgentAttempts } from '../../agent-singularity/src/coordination/ledger.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'
import { writeCapabilityConfig } from '../support/capability-config.ts'

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const SKILL = 'cost-fixture-skill'
const ROW = 'cost-fixture-row'
const PROPOSAL = 'p-cost'
const HOLDOUT = 't-holdout'
const ANSWER = 'answer.txt'
const command = 'test "$(cat answer.txt)" = 42'
const optionalCriterion = { criterionId: 'optional', description: 'an optional observation',
  mandatory: false, verifierRef: 'command', command: 'false' }
const skillBody = (reads: number) => `---\nname: ${SKILL}\ndescription: deliver the answer\n---\n\nREADS:${reads}\nDeliver answer.txt containing 42.\n`
const candidateBody = skillBody(0)

let ledger: string
beforeEach(() => {
  ledger = mkdtempSync(join(tmpdir(), 'success-cost-'))
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', join(ledger, 'review'))
})
afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
  rmSync(ledger, { recursive: true, force: true })
})

async function holdout(h: ScriptedLoop, optionalFailure = false): Promise<void> {
  const criteria = [{ criterionId: 'goal', description: 'deliver 42', verificationMode: 'deterministic' as const,
    mandatory: true, requiredEvidence: [], verifierRef: 'command', command },
    ...(optionalFailure ? [{ ...optionalCriterion, verificationMode: 'deterministic' as const, requiredEvidence: [] }] : [])]
  await h.task.createTaskIn(STORE, { taskId: HOLDOUT, definitionRef: { taskType: 'root', version: 1 },
    objective: 'a held-out answer', depth: 0, acceptanceCriteria: criteria, requestedCapabilities: [ROW],
    decompositionStatus: 'leaf', status: 'created', runIds: [], childTaskIds: [] }, 'tester')
  await h.task.admitTaskIn(STORE, HOLDOUT, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, { taskId: HOLDOUT, runId: 'r-holdout', sessionId: 's-holdout-history',
    capabilitySnapshot: [ROW], artifacts: [], verifierResults: [], status: 'running', startedAt: new Date().toISOString() }, 'tester')
  await h.task.markRunStatusIn(STORE, HOLDOUT, 'r-holdout', 'verifying', 'tester')
  await h.task.recordEvidenceIn(STORE, { evidenceId: 'e-holdout', taskId: HOLDOUT, taskRunId: 'r-holdout',
    artifacts: [], claims: [], generatedAt: new Date().toISOString(),
    verifierResults: [{ criterionId: 'goal', status: 'pass', verifierId: 'command' },
      ...(optionalFailure ? [{ criterionId: 'optional', status: 'fail' as const, verifierId: 'command' }] : [])] }, 'tester')
  await h.task.markRunStatusIn(STORE, HOLDOUT, 'r-holdout', 'verified', 'tester')
  await h.task.recordReviewIn(STORE, { taskId: HOLDOUT, runId: 'r-holdout', sessionId: 's-holdout-history',
    outcome: 'verified', evidenceRefs: ['e-holdout'], anomalies: [],
    criteria: [{ criterionId: 'goal', verdict: 'pass', verifierId: 'command' },
      ...(optionalFailure ? [{ criterionId: 'optional', verdict: 'fail' as const, verifierId: 'command' }] : [])] }, 'tester')
}

async function fixture(candidateReads = 0, candidateFails = false, decomposed = false, capability = false) {
  let h!: ScriptedLoop
  let taskId = ''
  let runId = ''
  let diagnosisId = ''
  const cleanImprovement = candidateReads < 2 && !candidateFails && !decomposed
  const rows = { [ROW]: { skills: [SKILL], ...(capability ? { tools: ['filesystem'] } : {}) } }
  const capabilityConfig = capability ? await writeCapabilityConfig(join(ledger, 'config.yml'), rows) : undefined
  h = await startScriptedLoop({
    capabilities: rows, evolution: { ledgerRoot: ledger, ...(capabilityConfig === undefined ? {} : { capabilityConfig }) },
    supervision: { autoReview: 'off' },
    approvalAnswer: ask => ask.toolName === 'evolution_apply' ? undefined : 'allowed-once',
    script: (sessionId, index): readonly ScriptEntry[] => {
      const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
      if (name.startsWith('review ')) return [{ text: '```json\n' + JSON.stringify({
        observation: 'the source passed but read its task redundantly', conclusion: 'remove the repeated reads', confidence: 'high',
        proposals: [{ targetType: capability ? 'capability' : 'skill', targetId: capability ? ROW : SKILL, rationale: 'same acceptance with fewer calls' }],
      }) + '\n```' }]
      if (name.startsWith('supervisor for')) {
        diagnosisId = name.slice('supervisor for '.length)
        return [
          { tool: 'evolution_propose', args: { proposalId: PROPOSAL, targetType: capability ? 'capability' : 'skill', targetId: capability ? ROW : SKILL,
            baseVersion: 'v1', level: 'L2', rationale: 'remove redundant calls', sourceRefs: [`diagnosis:${diagnosisId}`] } },
          { tool: 'evolution_candidate', args: { proposalId: PROPOSAL, versionSet: { skill: 'v2' },
            mutationJson: JSON.stringify(capability ? { rows: { [ROW]: { skills: ['task-execution'], tools: ['filesystem'] } } } : { name: SKILL, content: candidateBody }) } },
          { tool: 'evolution_prepare', args: { proposalId: PROPOSAL } },
          { tool: 'evolution_replay', args: { proposalId: PROPOSAL, objective: 'tool-call-reduction',
            taskIds: [taskId], holdoutTaskIds: [HOLDOUT] } },
          { tool: 'evolution_gate', args: calls => ({ proposalId: PROPOSAL,
            targetFailureFixed: 'the frozen cost objective is evaluated in the report', originalAcceptanceMaintained: 'same command',
            existingRegressionMaintained: 'both outcomes recorded', noUnacceptableSideEffects: 'isolated workspaces',
            holdoutPerformanceAcceptable: 'the independent holdout ran', resourceCostAcceptable: 'measured subtree tool traffic',
            regressionEvidenceRefs: [/report: (\S+)/.exec(calls.find(call => call.name === 'evolution_replay')?.result?.text ?? '')?.[1] ?? 'missing-report'],
          }) },
          ...(cleanImprovement ? [
            { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE' } },
            { tool: 'evolution_apply', args: { proposalId: PROPOSAL } },
            { tool: 'task_recover', args: { sourceDiagnosisId: diagnosisId, requestKey: 'k-cost', mode: 'improve' } },
          ] as ScriptEntry[] : []),
          { text: '```json\n{"outcome":"closed","reason":"the measured result is recorded"}\n```' },
        ]
      }
      if (name.startsWith('[evolution-experiment:') || name.startsWith('recovery of')) {
        const cwd = String(h.agent(sessionId).session.header.cwd)
        const candidate = name.startsWith('recovery of') || cwd.endsWith('/candidate')
        // The scripted provider executes the candidate's intended behavior; the runtime's actual binding is checked below.
        writeFileSync(join(cwd, ANSWER), candidate && candidateFails ? 'wrong\n' : '42\n')
        const reads = candidate ? candidateReads : 2
        if (candidate && decomposed) return [
          { tool: 'task_decompose', args: { reason: 'inspect through a child', children: [{ objective: 'cost child',
            requiredCapabilities: [ROW], acceptanceCriteria: [{ criterionId: 'child-goal', description: 'inspect the answer', command: 'true' }] }] } },
          { waitFor: async () => {
            const { run } = await h.runForSession(sessionId)
            await h.runtime.awaitBatch(STORE, run.batchId!)
          } },
          { tool: 'task_submit_result', args: { summary: 'the child inspection is finished' } }, { text: 'delivered' },
        ]
        return [...Array.from({ length: reads }, () => ({ tool: 'task_read' })),
          { tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
      }
      if (name === 'cost child') return [{ tool: 'task_read' }, { tool: 'task_read' }, { tool: 'task_read' },
        { tool: 'task_submit_result', args: { summary: 'the child inspected the result' } }, { text: 'inspected' }]
      if (index === 0) {
        writeFileSync(join(h.checkout, ANSWER), '42\n')
        return [
          { tool: 'task_read' }, { tool: 'task_read' },
          { tool: 'task_submit_result', args: { summary: 'the original answer is delivered' } }, { text: 'delivered' },
          { tool: 'task_review_agent', args: () => ({ taskId, runId, reason: 'reduce redundant work' }) }, { text: 'reviewed' },
        ]
      }
      return [{ text: 'idle' }]
    },
  })
  mkdirSync(join(h.home, 'skills', SKILL), { recursive: true })
  writeFileSync(join(h.home, 'skills', SKILL, 'SKILL.md'), skillBody(2))
  const source = await h.begin({ objective: 'deliver the answer', requiredCapabilities: [ROW],
    acceptanceCriteria: [{ criterionId: 'goal', description: 'deliver 42', command, verifierRef: 'command' },
      ...(capability ? [optionalCriterion] : [])] })
  taskId = source.taskId
  runId = source.runId
  await h.agent(ROOT).whenIdle()
  expect((await h.snapshot(STORE)).runs.find(run => run.runId === runId)?.status).toBe('verified')
  await holdout(h, capability)
  // Each replay must earn the output, rather than inherit the source's completed artifact in its input snapshot.
  unlinkSync(join(h.checkout, ANSWER))
  h.userSays('review the successful result for redundant calls')
  await vi.waitFor(async () => expect((await h.ctx.evolution.get(PROPOSAL)).status,
    h.calls.filter(call => call.name.startsWith('evolution_')).map(call => call.result?.text).join('\n')).toBe(cleanImprovement ? 'decided' : 'gated'), { timeout: 20_000, interval: 25 })
  return { h, taskId, runId, diagnosisId }
}

describe('verified-source measured cost optimization', () => {
  it('finishes durable supervisor settlement before unloading an unanswered human gate', async () => {
    const f = await fixture()
    await vi.waitFor(() => expect(f.h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true))
    await f.h.dispose()
    const attempt = (await readReviewAgentAttempts(STORE)).find(item => item.role === 'supervisor')!
    expect(attempt.started).toBe(true)
    expect(attempt.settlement).toBeDefined()
    expect(attempt.settlement?.note).not.toContain('undefined')
    const settled = await readReviewAgentAttempts(STORE)
    await Promise.resolve()
    expect(await readReviewAgentAttempts(STORE)).toEqual(settled)
  }, 20_000)

  it('counts real child traffic, so fewer coordinator calls cannot hide a more expensive decomposition', async () => {
    const f = await fixture(0, false, true)
    const [experiment] = await f.h.ctx.evolution.experiments(PROPOSAL)
    const report = buildExperimentReport(experiment!)
    expect(report.verdict).toBe('regressed')
    const snapshot = await f.h.snapshot(STORE)
    for (const sample of report.samples) {
      const root = snapshot.reviews.find(review => review.runId === sample.candidate.runId)!
      expect(root.metrics?.toolCalls?.calls).toBe(2)
      const children = snapshot.runs.filter(run => run.parentRunId === sample.candidate.runId)
      expect(children).toHaveLength(1)
      expect(snapshot.reviews.find(review => review.runId === children[0]!.runId)?.metrics?.toolCalls?.calls).toBe(4)
      expect(sample.candidate.cost).toMatchObject({ status: 'reported', metrics: { toolCalls: { calls: 6 } } })
      expect(sample.baseline.cost).toMatchObject({ status: 'reported', metrics: { toolCalls: { calls: 3 } } })
    }
    await expect(f.h.ctx.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/clean improvement/)
  }, 40_000)

  it.each(['skill', 'capability'] as const)('preserves acceptance, asks a human, applies the measured %s and attributes its production improvement Run', async target => {
    const capability = target === 'capability'
    const f = await fixture(0, false, false, capability)
    const [experiment] = await f.h.ctx.evolution.experiments(PROPOSAL)
    const report = buildExperimentReport(experiment!)
    expect(report.frozen.objective).toBe('tool-call-reduction')
    expect(report.verdict).toBe('improved')
    expect(report.samples.map(sample => sample.verdict)).toEqual(['improved', 'maintained'])
    const snapshot = await f.h.snapshot(STORE)
    for (const sample of report.samples) {
      expect(sample.baseline.outcome).toBe('verified')
      expect(sample.candidate.outcome).toBe('verified')
      expect(sample.candidate.criteria).toEqual(sample.baseline.criteria)
      expect(sample.candidate.criteria.map(item => item.verdict)).toEqual(capability ? ['pass', 'fail'] : ['pass'])
      expect(sample.baseline.cost).toEqual(costOf(snapshot.reviews.find(review => review.runId === sample.baseline.runId), snapshot))
      expect(sample.candidate.cost).toEqual(costOf(snapshot.reviews.find(review => review.runId === sample.candidate.runId), snapshot))
      expect(sample.baseline.cost).toMatchObject({ status: 'reported', metrics: { toolCalls: { calls: 3 } } })
      expect(sample.candidate.cost).toMatchObject({ status: 'reported', metrics: { toolCalls: { calls: 1 } } })
    }
    expect((await f.h.snapshot(STORE)).runs.some(run => run.recovery !== undefined)).toBe(false)
    await vi.waitFor(() => expect(f.h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true), { timeout: 10_000 })
    f.h.review.answer(f.h.review.asks.findIndex(ask => ask.toolName === 'evolution_apply'), 'allowed-once')
    const recoveryCall = await vi.waitFor(() => {
      const call = f.h.calls.find(call => call.name === 'task_recover')
      expect(call?.result).toBeDefined()
      return call!
    }, { timeout: 10_000 })
    expect(f.h.calls.find(call => call.name === 'evolution_apply')?.result?.text).not.toContain('rejected')
    expect(recoveryCall.result?.text).not.toContain('rejected')
    const attempt = await vi.waitFor(async () => {
      const found = (await f.h.snapshot(STORE)).runs.find(run => run.recovery?.sourceDiagnosisId === f.diagnosisId)
      expect(found?.status).toBe('verified')
      return found!
    }, { timeout: 15_000, interval: 25 })
    expect(attempt.taskId).toBe(f.taskId)
    expect(attempt.recovery).toMatchObject({ kind: 'improvement', sourceRunId: f.runId, proposalIds: [PROPOSAL] })
    expect(readFileSync(join(f.h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(capability ? skillBody(2) : candidateBody)
    const final = await f.h.snapshot(STORE)
    expect(final.runs.find(run => run.runId === f.runId)?.status).toBe('verified')
    expect(final.reviews.find(review => review.runId === attempt.runId)?.criteria.map(item => item.verdict)).toEqual(capability ? ['pass', 'fail'] : ['pass'])
    if (capability) {
      expect(attempt.providerBinding?.skills.map(skill => skill.name)).toEqual(['task-execution'])
      expect(f.h.runtime.listCapabilities()[ROW]).toEqual({ skills: ['task-execution'], tools: ['filesystem'] })
    } else {
      expect(attempt.providerBinding?.skills.find(skill => skill.name === SKILL)?.contentDigest)
        .toBe(skillContentDigest({ skillMdSha256: (await f.h.ctx.evolution.get(PROPOSAL)).prepared!.skillContent!.sha256, resources: [] }))
    }
    await vi.waitFor(async () => expect((await readReviewAgentAttempts(STORE)).find(item => item.role === 'supervisor')?.settlement?.status).toBe('recorded'))
  }, 60_000)

  it.each([[2, false, 'not-improved'], [3, false, 'regressed'], [0, true, 'regressed']] as const)(
    'blocks promotion for candidate reads %s, failure %s: %s', async (reads, fails, verdict) => {
      const f = await fixture(reads, fails)
      const [experiment] = await f.h.ctx.evolution.experiments(PROPOSAL)
      expect(buildExperimentReport(experiment!).verdict).toBe(verdict)
      await expect(f.h.ctx.evolution.checkPromotion(PROPOSAL)).rejects.toThrow(/clean improvement/)
      expect(f.h.review.asks.filter(ask => ask.toolName.startsWith('evolution_'))).toHaveLength(0)
      expect((await f.h.snapshot(STORE)).runs.some(run => run.recovery !== undefined)).toBe(false)
      expect(readFileSync(join(f.h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(skillBody(2))
    }, 40_000,
  )
})

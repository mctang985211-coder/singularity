/**
 * S4-E §Q3, the rework's counterexamples as a persistent regression: an
 * experiment's frozen identity has to constrain the runs that really happen, and
 * the promotion gate has to read *those* runs' durable evidence — their own
 * session logs, their run bindings, the judges that decided them — instead of
 * comparing the experiment's opening value with today's.
 *
 * The deployment here is the real one: the real `AgentLoop` over a scripted
 * adapter (scripted *only* for the model's answers — every request the provider
 * sees is a real request on a real route), the real `TaskRuntime.replayTask`,
 * the real `AgentRuntime.spawn`, the real `VerifierRegistry`, the real
 * `EvolutionService` ledger and promotion gate. What the scripted worker writes
 * is decided per side by reading the run it belongs to, which is what a worker
 * working under the skill it loaded would do.
 *
 * The counterexamples §Q3 names, each asserted on the durable surface:
 *
 * 1. **Freeze A, move the deployment's default to B between the two sides, move
 *    it back before the experiment ends.** Every request both sides really made
 *    was on A — asserted on the adapter's own record *and* on each session's
 *    `request/header` events — and the promotion chain runs through.
 * 2. **A trace that really ran somewhere else.** The gate re-reads the session
 *    logs; a request recorded on another route is refused by name, and so is a
 *    deployment whose default is still B at promotion time.
 * 3. **The provider plane moved between the sides.** Changing the capability row
 *    after the first side settled makes the second side bind another revision;
 *    the gate refuses, while the untouched experiment — whose only difference is
 *    the promoted skill's own content — passes.
 * 4. **The judge was re-registered between the freeze and the first run.** The
 *    frozen version refuses the verdict the new instance produced — and the same
 *    experiment with no drift passes.
 *
 * Plus the fail-closed entry: a deployment that cannot name a *structured*
 * selection cannot freeze one, and is refused before a run, a ledger line or a
 * spawn.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, TaskSnapshot } from '../../task/src/index.ts'
import type { VerificationResult, VerifyRequest, Verifier } from '../../verifier/src/index.ts'
import { EvolutionService, modelSelectionOf } from '../../evolution/src/index.ts'
import type { ExperimentSpec, ModelSelection } from '../../evolution/src/index.ts'
import { defineEvolutionReplayTool } from '../../agent-singularity/src/tools/evolution-replay.ts'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId
const PROPOSAL = 'q3'
const SKILL = 'q3-frozen-skill'
const ROW = 'q3-capability'
/** The frozen provider route: a route of its own, so nothing else can answer for it. */
const FROZEN: ModelSelection = modelSelectionOf({ provider: 'alpha', model: 'alpha-model' })!
/** The route the deployment's default moves to between the two sides — never the frozen one. */
const MOVED = { provider: 'beta', model: 'beta-model' } as const
const PRODUCTION_BODY = skillText('WRITE:holdout.txt')
const CANDIDATE_BODY = skillText('WRITE:fix.txt\nWRITE:holdout.txt')

/** One skill body: `WRITE:<file>` for each answer file the skill tells its worker to produce. */
function skillText(body: string): string {
  return `---\nname: ${SKILL}\ndescription: the Q3 fixture skill\n---\n\n${body}\n`
}

afterEach(async () => {
  await disposeScriptedLoops()
})

/**
 * One criterion settled by a shell command in the run's own workspace. The
 * candidate side's worker writes `fix.txt`; the baseline side's does not (the
 * production skill's body says so), so the same contract really separates the
 * two sides.
 */
function criterion(criterionId: string, command: string, verifierRef?: string): AcceptanceCriterion {
  return {
    criterionId,
    description: 'the answer file is produced',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command,
    ...(verifierRef === undefined ? {} : { verifierRef }),
  }
}

/** The sample ids one experiment runs over. */
const FAIL_SAMPLE = 't-fix'
const HOLDOUT_SAMPLE = 't-holdout'

/**
 * One terminal sample as the store holds it: the historical record the
 * experiment's sample locates its case by, written through the store's own
 * service so the role rule reads exactly what a real history holds.
 */
async function writeSample(h: ScriptedLoop, storeId: string, input: {
  taskId: string
  runId: string
  objective: string
  acceptance: AcceptanceCriterion
  outcome: 'verified' | 'failed'
}): Promise<void> {
  await h.task.createTaskIn(storeId, {
    taskId: input.taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: input.objective,
    depth: 0,
    acceptanceCriteria: [input.acceptance],
    requestedCapabilities: [ROW],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(storeId, input.taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `s-${input.taskId}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${input.runId}`,
    taskRunId: input.runId,
    taskId: input.taskId,
    artifacts: [],
    verifierResults: [{ criterionId: input.acceptance.criterionId, status: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, input.outcome, 'tester')
  await h.task.recordReviewIn(storeId, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [],
    ...(input.outcome === 'failed' ? { localizedCause: 'the production skill never writes fix.txt' } : {}),
    criteria: [{ criterionId: input.acceptance.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
  }, 'tester')
}

/** A judge whose verdicts are its own: the criterion passes, under this instance's version. */
function testJudge(id: string, version: string): Verifier {
  return {
    id,
    version,
    supports: (mode: string) => mode === 'deterministic',
    verify: async (request: VerifyRequest): Promise<VerificationResult[]> => request.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: existsSync(join(request.cwd, criterion.criterionId === 'ac-fix' ? 'fix.txt' : 'holdout.txt')) ? 'pass' : 'fail',
      verifierId: id,
    })),
    selftest: {
      samples: [
        {
          name: 'positive',
          role: 'positive',
          expect: 'pass',
          criterion: { criterionId: 'ac', description: 'x', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true },
        },
        {
          name: 'negative',
          role: 'negative',
          expect: 'fail',
          criterion: { criterionId: 'ac', description: 'x', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true },
        },
      ],
    },
  } as unknown as Verifier
}

/**
 * What the worker of one replayed session does: it looks up the run it belongs
 * to, reads which side of which sample that run is, and writes the answer files
 * that side's skill produces. A real worker would do exactly this — the fixture
 * decides *what the skill says*, not whether the run happened.
 */
async function writeSideAnswers(h: ScriptedLoop, sessionId: string): Promise<void> {
  const { task } = await h.runtime.runForSession(sessionId)
  const objective = String(task.objective ?? '')
  // The replayed task's objective is "[<lineage>] <sampleTaskId>"; the lineage
  // ends in the side the run is (`evolution-experiment:<id>:<sample>:<side>`).
  const side = objective.includes(':candidate] ') ? 'candidate' : 'baseline'
  const cwd = h.agent(sessionId).session.header.cwd
  if (cwd === undefined) throw new Error(`the worker session ${sessionId} names no working directory`)
  await writeFile(join(cwd, 'holdout.txt'), 'holdout\n')
  if (side === 'candidate') await writeFile(join(cwd, 'fix.txt'), 'fix\n')
}

interface Fixture {
  h: ScriptedLoop
  evolution: EvolutionService
  storeId: string
  snapshotDir: string
  /** The deployment's default selection as the deployment resolves it — the value a settings write moves. */
  defaultSelection: { current: { provider: string; model: string } }
  /** Every worker session of the experiment, in spawn order (baseline and candidate, sample by sample). */
  workerSessions(): string[]
  /** The requests one worker session really made, as the adapter that answered them recorded. */
  routes(sessionId: string): string[]
  /** The `request/header` events one worker session's own durable log holds. */
  loggedHeaders(sessionId: string): string[]
  /** Remove the pinned judge and register a new instance of it at `version` — the re-registration arm. */
  reregisterJudge(version: string): Promise<void>
  spec(overrides?: Partial<ExperimentSpec>): ExperimentSpec
  snapshot(): Promise<TaskSnapshot>
}

/**
 * The whole fixture: the real scripted deployment, a production skill that never
 * writes `fix.txt`, a prepared candidate that does, and the two terminal samples.
 *
 * The scripted worker answers a request by looking up the run the asking session
 * belongs to and writing the answer files its sample's side is supposed to
 * produce. The deployment's default selection moves to {@link MOVED} when the
 * second side starts (script index 2, i.e. after the first side settled) and back
 * to the frozen route when the fourth does — the counterexample's "A → B → A".
 */
async function fixture(options: {
  /** Leave the deployment's default at B (skip the restore) — the "default moved" arm. */
  leaveDefaultMoved?: boolean
  /** Change the capability row after the first side settled — the "provider plane moved" arm. */
  moveProviderBetweenSides?: boolean
  /**
   * The judge the sample criteria pin (S4-E §Q3). Default: the deployment's own
   * registered `command` verifier. A case that needs to re-register the judge on
   * a new version names a test double of its own.
   */
  judge?: { id: string; version: string }
  /** Leave the sample criteria mode-only (no `verifierRef`) — the unpinned-judge arm. */
  unpinnedSample?: boolean
  /**
   * Re-register the pinned judge at this version on the first `replayTask` call —
   * after the experiment froze (it records the version the registry declared
   * then) and before the first side runs, which is the counterexample's window.
   */
  reregisterJudgeBeforeFirstRun?: string
  /** A deployment whose resolver cannot answer a structured selection. */
  unresolvableSelection?: boolean
} = {}): Promise<Fixture> {
  const defaultSelection = { current: { provider: FROZEN.provider, model: FROZEN.model } }
  let h!: ScriptedLoop
  const sessions: string[] = []
  const script = (sessionId: string, index: number): readonly ScriptEntry[] => {
    if (index === 0) return [{ text: 'root: the tree is active' }]
    sessions.push(sessionId)
    // Between the two sides of the first sample: the deployment's default moves,
    // exactly as a settings write would move it.
    if (index === 2) defaultSelection.current = { ...MOVED }
    if (index === 4 && options.leaveDefaultMoved !== true) {
      defaultSelection.current = { provider: FROZEN.provider, model: FROZEN.model }
    }
    return [
      { waitFor: async () => { await writeSideAnswers(h, sessionId) } },
      { tool: 'task_submit_result', args: { summary: 'the side is done' } },
      { text: 'worker: handed in' },
    ]
  }
  h = await startScriptedLoop({
    roots: [ROOT],
    providers: [FROZEN.provider, MOVED.provider],
    defaultSelection: () => defaultSelection.current,
    capabilities: { [ROW]: { skills: [SKILL], tools: ['filesystem'], preset: 'standard' } },
    script,
  })
  // The skill plane a run's binding registers its snapshot into (the same
  // registry every deployment mounts): without it a spawn that was bound to
  // content refuses, and the runs would never reach a request.
  await h.ctx.plugin(SkillRegistry, {})
  // The judge the samples pin: the deployment's own `command` verifier unless a
  // case names a test double of its own (only then is one registered).
  const judge = options.judge ?? { id: 'command', version: '1' }
  let offJudge: (() => void) | undefined
  if (options.judge !== undefined) offJudge = await h.verifier.register(testJudge(options.judge.id, options.judge.version), { testDouble: true })

  const skillRoot = join(h.home, 'skills')
  await mkdir(join(skillRoot, SKILL), { recursive: true })
  await writeFile(join(skillRoot, SKILL, 'SKILL.md'), PRODUCTION_BODY, 'utf8')

  const evolution = new EvolutionService(h.ctx, {
    root: join(h.workspace, 'evolution'),
    skillRoot,
    modelSelection: () => options.unresolvableSelection === true ? undefined : modelSelectionOf(defaultSelection.current),
  })
  await evolution.propose({
    proposalId: PROPOSAL,
    targetType: 'skill',
    targetId: SKILL,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the production skill never writes the answer the criterion asks for',
    sourceRefs: ['diagnosis:d1'],
  }, ROOT)
  await evolution.candidate(PROPOSAL, { skill: 'v2' }, ROOT, { name: SKILL, content: CANDIDATE_BODY })
  await evolution.prepare(PROPOSAL, ROOT)

  const root = await h.begin({
    objective: 'evaluate the candidate skill',
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the evaluation is delivered', command: 'true' }],
  })
  const snapshotDir = join(h.checkout, 'frozen-input')
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, 'input.txt'), 'the frozen input\n', 'utf8')
  await writeSample(h, root.storeId, {
    taskId: FAIL_SAMPLE,
    runId: 'r-fix-history',
    objective: 'the answer file is produced',
    acceptance: criterion('ac-fix', 'test -f fix.txt', options.unpinnedSample === true ? undefined : judge.id),
    outcome: 'failed',
  })
  await writeSample(h, root.storeId, {
    taskId: HOLDOUT_SAMPLE,
    runId: 'r-holdout-history',
    objective: 'the held-out answer file is produced',
    acceptance: criterion('ac-holdout', 'test -f holdout.txt', options.unpinnedSample === true ? undefined : judge.id),
    outcome: 'verified',
  })

  // Two real writes made in the one window the counterexamples name — after the
  // experiment froze (and, for the provider arm, after the first side settled)
  // and before the run they are about:
  // - the provider plane the second side resolves against moves;
  // - the pinned judge is re-registered at another version before the first side.
  if (options.moveProviderBetweenSides === true || options.reregisterJudgeBeforeFirstRun !== undefined) {
    const runtime = h.runtime as unknown as { replayTask: (...args: unknown[]) => Promise<unknown> }
    const replay = runtime.replayTask.bind(h.runtime)
    let replays = 0
    runtime.replayTask = async (...args: unknown[]) => {
      replays += 1
      if (replays === 1 && options.reregisterJudgeBeforeFirstRun !== undefined) await reregister(options.reregisterJudgeBeforeFirstRun)
      if (replays === 2 && options.moveProviderBetweenSides === true) {
        await h.runtime.applyCapabilityRow(ROW, { skills: [SKILL], tools: ['filesystem', 'bash'], preset: 'standard' })
      }
      return await (replay as (...inner: unknown[]) => Promise<unknown>)(...args)
    }
  }
  const reregister = async (version: string): Promise<void> => {
    offJudge?.()
    offJudge = await h.verifier.register(testJudge(judge.id, version), { testDouble: true })
  }

  return {
    h,
    evolution,
    storeId: root.storeId,
    snapshotDir,
    defaultSelection,
    workerSessions: () => [...sessions],
    routes: sessionId => h.requestsOf(sessionId).map(request => `${request.options.provider}/${request.options.model}`),
    loggedHeaders: sessionId => h.eventsOf(sessionId)
      .filter(event => event.type === 'request/header')
      .map(event => {
        const config = (event.data as { header?: { config?: { provider?: string; model?: string } } }).header?.config
        return `${String(config?.provider)}/${String(config?.model)}`
      }),
    reregisterJudge: reregister,
    spec: (overrides = {}) => ({
      proposalId: PROPOSAL,
      samples: [
        { taskId: FAIL_SAMPLE, role: 'observed-failure' as const },
        { taskId: HOLDOUT_SAMPLE, role: 'holdout' as const },
      ],
      snapshot: { sourceDir: snapshotDir },
      model: FROZEN,
      budget: { note: 'the fixture budget' },
      repetition: 0,
      ...overrides,
    }),
    snapshot: () => h.snapshot(root.storeId),
  }
}

/** The refusal message of one call, or `''` when it resolved. */
async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The six gate answers §F.2 requires, over one experiment report. */
function gateAnswers(reportPath: string) {
  return {
    targetFailureFixed: 'the candidate produces the answer the production skill does not',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the holdout still passes on both sides',
    noUnacceptableSideEffects: 'one file changes',
    holdoutPerformanceAcceptable: 'the held-out sample is maintained',
    resourceCostAcceptable: 'recorded, not inferred',
    regressionEvidenceRefs: [reportPath],
  }
}

describe('S4-E §Q3: the frozen identity constrains the runs that really happen', () => {
  it('keeps both sides on the frozen route when the deployment default moves to B between them and back', async () => {
    const f = await fixture()
    const result = await f.evolution.runExperiment(f.spec(), ROOT, ROOT)

    const debugSnapshot = await f.snapshot()
    expect(result.report.verdict).toBe('fixed')
    expect(result.report.frozen.model).toEqual(FROZEN)

    // Every worker's real requests, as the adapter that answered them recorded:
    // the frozen route on both sides of both samples, though the deployment's
    // default was B while the second side ran.
    const sessions = f.workerSessions()
    expect(sessions).toHaveLength(4)
    for (const sessionId of sessions) {
      const routes = f.routes(sessionId)
      expect(routes.length).toBeGreaterThan(0)
      expect(new Set(routes)).toEqual(new Set([`${FROZEN.provider}/${FROZEN.model}`]))
      // …and the durable surface says the same: the session's own request/header
      // events, which is what the promotion gate re-reads.
      const logged = f.loggedHeaders(sessionId)
      expect(logged.length).toBeGreaterThan(0)
      expect(new Set(logged)).toEqual(new Set([`${FROZEN.provider}/${FROZEN.model}`]))
    }

    // The run bindings are the frozen production provider identity, and the
    // promoted skill's own bytes are the one difference between the sides.
    const snapshot = await f.snapshot()
    for (const sample of result.report.samples) {
      const baselineRun = snapshot.runs.find(run => run.runId === sample.baseline.runId)!
      const candidateRun = snapshot.runs.find(run => run.runId === sample.candidate.runId)!
      expect(baselineRun.providerBinding?.registryRevision).toBe(candidateRun.providerBinding?.registryRevision)
      expect(baselineRun.providerBinding?.skills.map(skill => skill.name)).toEqual([SKILL])
      expect(candidateRun.providerBinding?.skills.map(skill => skill.name)).toEqual([SKILL])
      expect(candidateRun.providerBinding?.skills[0]!.contentDigest)
        .not.toBe(baselineRun.providerBinding?.skills[0]!.contentDigest)
    }

    // The promotion chain runs through on that evidence: gate, both human
    // approvals, the production write and its rollback.
    await f.evolution.gate(PROPOSAL, gateAnswers(result.reportPath), ROOT)
    await f.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')
    await f.evolution.apply(PROPOSAL, ROOT, 'approval:apply')
    expect(await readFile(join(f.h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE_BODY)
    await f.evolution.rollback(PROPOSAL, ROOT, 'approval:rollback')
    expect(await readFile(join(f.h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(PRODUCTION_BODY)
  })

  it('refuses a deployment whose default is still B at promotion time, though the runs themselves were frozen', async () => {
    const f = await fixture({ leaveDefaultMoved: true })
    const result = await f.evolution.runExperiment(f.spec(), ROOT, ROOT)
    for (const sessionId of f.workerSessions()) {
      expect(new Set(f.routes(sessionId))).toEqual(new Set([`${FROZEN.provider}/${FROZEN.model}`]))
    }
    const message = await refusal(f.evolution.checkPromotion(PROPOSAL))
    expect(message).toContain(`the experiment froze model selection "${FROZEN.label}"`)
    expect(message).toContain('but this deployment resolves "beta/beta-model" now')
    expect(result.report.verdict).toBe('fixed')
  })

  it('refuses a trace whose own session log shows a request on another route', async () => {
    const f = await fixture()
    await f.evolution.runExperiment(f.spec(), ROOT, ROOT)
    // The counterexample's "actually ran B" arm: the durable record — the
    // session log the gate reads — says one side's request went to B. Nothing in
    // the report or the frozen block says so; only the real evidence does.
    const session = f.workerSessions()[1]!
    ;(f.h.eventsOf(session) as SessionEvent[]).push({
      type: 'request/header',
      seq: 999,
      time: Date.now(),
      data: { header: { config: { provider: MOVED.provider, model: MOVED.model } }, reason: 'change' },
    } as unknown as SessionEvent)
    const message = await refusal(f.evolution.checkPromotion(PROPOSAL))
    expect(message).toContain('really made its requests on beta/beta-model')
    expect(message).toContain(`not on the frozen selection "${FROZEN.label}"`)
    // The refusal names the run: the evidence, not the report, decided it.
    expect(message).toMatch(/run "r-/)
  })

  it('refuses a provider plane that moved between the sides, while the untouched experiment passes', async () => {
    const moved = await fixture({ moveProviderBetweenSides: true })
    await moved.evolution.runExperiment(moved.spec(), ROOT, ROOT)
    const message = await refusal(moved.evolution.checkPromotion(PROPOSAL))
    expect(message).toContain('bound registry revision')
    expect(message).toContain('moved since the freeze')
  })

  it('refuses a judge re-registered at another version between the freeze and the first run', async () => {
    const f = await fixture({ judge: { id: 'q3-judge', version: '1' }, reregisterJudgeBeforeFirstRun: '2' })
    const result = await f.evolution.runExperiment(f.spec(), ROOT, ROOT)
    expect(result.report.verdict).toBe('fixed')

    // The frozen block pinned the judge the registry declared at freeze; the
    // runs were judged by the instance that replaced it.
    const [frozen] = await f.evolution.experiments(PROPOSAL)
    expect(frozen!.frozen.samples[0]!.criteria[0]!.verifierRef).toBe('q3-judge')
    expect(frozen!.frozen.samples[0]!.criteria[0]!.verifierVersion).toBe('1')
    expect(result.report.samples[0]!.candidate.criteria[0]!.verifierVersion).toBe('2')

    const message = await refusal(f.evolution.checkPromotion(PROPOSAL))
    expect(message).toContain('but the block froze it at 1')
    expect(message).toContain('a judge that moved since the freeze invalidates the evidence')
  })

  it('passes the same pinned judge when nothing about it moved', async () => {
    const f = await fixture({ judge: { id: 'q3-judge', version: '1' } })
    const result = await f.evolution.runExperiment(f.spec(), ROOT, ROOT)
    expect(result.report.verdict).toBe('fixed')
    expect(await refusal(f.evolution.checkPromotion(PROPOSAL))).toBe('')
  })

  it('refuses to freeze when the deployment cannot name a structured selection, before any run or ledger line', async () => {
    const f = await fixture({ unresolvableSelection: true })
    const before = await f.snapshot()
    // The tool path is where the deployment's own resolver is read — the direct
    // service path is handed a selection by its caller (`validateSpec` refuses a
    // bare string there).
    const tool = defineEvolutionReplayTool(f.h.ctx)
    const answer = await tool.execute(
      { proposalId: PROPOSAL, taskIds: [FAIL_SAMPLE], holdoutTaskIds: [HOLDOUT_SAMPLE] },
      { agent: { id: ROOT }, signal: new AbortController().signal } as never,
    ) as string
    expect(answer).toContain('evolution_replay rejected:')
    expect(answer).toContain('cannot name the model selection its runs share')
    expect(f.h.spawns).toHaveLength(0)
    expect(await f.evolution.experiments(PROPOSAL)).toHaveLength(0)
    const after = await f.snapshot()
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
  })

  it('refuses an experiment whose sample pins no verifierRef, before the first run or ledger line', async () => {
    // The rework's Q3 counterexample at the real entry: a criterion that names
    // only a mode would let the registry pick the judge after the freeze, so the
    // freeze refuses it — before a spawn, a run or an `experiment_started` line.
    const f = await fixture({ unpinnedSample: true })
    const before = await f.snapshot()
    const tool = defineEvolutionReplayTool(f.h.ctx)
    const answer = await tool.execute(
      { proposalId: PROPOSAL, taskIds: [FAIL_SAMPLE], holdoutTaskIds: [HOLDOUT_SAMPLE] },
      { agent: { id: ROOT }, signal: new AbortController().signal } as never,
    ) as string
    expect(answer).toContain('evolution_replay rejected:')
    expect(answer).toContain(`sample "${FAIL_SAMPLE}" criterion "ac-fix" pins no verifierRef`)
    expect(f.h.spawns).toHaveLength(0)
    expect(await f.evolution.experiments(PROPOSAL)).toHaveLength(0)
    const after = await f.snapshot()
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
  })
})

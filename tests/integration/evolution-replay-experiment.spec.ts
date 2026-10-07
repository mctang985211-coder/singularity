/**
 * S4-E §F.2 through the production tool: `evolution_replay` on a prepared skill
 * candidate is the two-sided experiment, from the tool entry to the ledger.
 *
 * The spec drives the *tool*, not the service: `evolution_replay` is registered
 * on the deployment's own tool registry and dispatched the way the loop
 * dispatches a call, so what is asserted is the wiring the model reaches —
 * schema, role derivation, the snapshot and model identities the tool supplies,
 * and the text the caller gets back. Underneath it everything is the real
 * deployment: the real task store and reducer, the real `TaskRuntime.replayTask`
 * with the caller's workspace, the real `AgentRuntime.spawn` over the real skill
 * plane, and the real `VerifierRegistry` with its command verifier. Only the
 * model loop is scripted.
 *
 * What this spec pins:
 *
 * 1. **Four new runs, one per side per sample.** Two samples (one observed
 *    failure, one holdout) × two sides, each a new replayed task of this
 *    experiment's own lineage — the historical records locate the cases and are
 *    never a side of the comparison.
 * 2. **Two workspaces that do not cross.** Each side's worker writes into the
 *    directory its own run was placed in; the bytes each side loaded identify
 *    which skill it ran, and neither directory holds the other's marker.
 * 3. **The sides are bound to the right content.** The baseline's worker loads
 *    the production `SKILL.md`, the candidate's loads the prepared bytes, and
 *    the frozen block carries both content digests, the input snapshot digest
 *    (computed independently here), the model identity the deployment supplied,
 *    the budget the call named, and the comparer version.
 * 4. **The report is traceable.** Every side cites a real task, run, review
 *    record and evidence bundle of this graph's store, and the report on disk
 *    is the report the tool rendered.
 * 5. **Refusals are named and side-effect free.** No failed sample, an empty
 *    holdout, overlapping lists, and a task that is not terminal are refused
 *    with nothing written — no ledger line, no run, no report.
 * 6. **Idempotency.** The same call again reuses every settled side: no new
 *    task, no new run, no new spawn, the same experiment id. A higher
 *    `repetition` is a new, separately frozen experiment.
 * 7. **Other target types keep the v1 path.** An `agent_preset` proposal is
 *    still manual: nothing runs, the v1 report is written, and no experiment
 *    record appears.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EvolutionService } from '../../evolution/src/index.ts'
import { overallExperimentVerdict } from '../../evolution/src/index.ts'
import type { ExperimentReport } from '../../evolution/src/index.ts'
import { deploymentModelSelection } from '../../agent-singularity/src/index.ts'
import { defineEvolutionApplyTool } from '../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionDecideTool } from '../../agent-singularity/src/tools/evolution-decide.ts'
import { defineEvolutionGateTool } from '../../agent-singularity/src/tools/evolution-gate.ts'
import { defineEvolutionReplayTool } from '../../agent-singularity/src/tools/evolution-replay.ts'
import { defineEvolutionRollbackTool } from '../../agent-singularity/src/tools/evolution-rollback.ts'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import { disposeRunStacks, sha256Of, startRunStack, type RunStack } from '../support/run-stack.ts'

const ROOT = 's-root' as SessionId
const PROPOSAL = 'p1'
const PRESET_PROPOSAL = 'p-preset'
const SKILL = 'replay-fixture-skill'
const PRESET = 'replay-fixture-preset'
/**
 * The capability row the fixture's samples request: one row granting the skill
 * they evaluate, so the experiment's frozen provider list resolves the provider
 * the candidate replaces — the entry the candidate side's registry revision
 * substitutes (K3). A sample whose rows resolve no provider has no candidate
 * revision to freeze, and the experiment refuses it before it runs.
 */
const ROW = 'replay-fixture-row'
/** The answer files a skill body tells its worker to write; the samples' criteria are `test -f <file>`. */
const ANSWER_FILES = ['fix.txt', 'keep.txt', 'holdout.txt']
const BUDGET = { maxTokens: 5_000, note: 'the fixture budget' }
/** What the deployment's own `agentDefaultModel` names — the identity a session without its own selection runs under. */
const MODEL = 'p/m'

/** The production skill: it never produces `fix.txt` — the historical failure the sample reproduces. */
const PRODUCTION_BODY = skillBody(['fix.txt'])
/** The candidate: it produces every answer file, so the failure is fixed and the holdout holds. */
const CANDIDATE_BODY = skillBody([])

/** The file each side's worker writes with the digest of the skill bytes it actually loaded. */
const MARKER = 'loaded-skill.sha256'

/**
 * One skill body in the fixture's own vocabulary: `WRITE:<file>` for an answer
 * file the skill produces, `SKIP:<file>` for one it does not. A loadable
 * `SKILL.md` (frontmatter included), so the bytes are the shape the deployment
 * reads.
 */
function skillBody(skips: readonly string[]): string {
  const body = ANSWER_FILES.map(file => (skips.includes(file) ? `SKIP:${file}` : `WRITE:${file}`)).join('\n')
  return `---\nname: ${SKILL}\ndescription: experiment fixture skill\n---\n\n${body}\n`
}

afterEach(async () => {
  await disposeRunStacks()
})

/** The replayed worker of one session: a parentless task whose run descends from a sample run. */
async function isReplayedWorker(h: RunStack, sessionId: SessionId): Promise<boolean> {
  const { task, run } = await h.runtime.runForSession(sessionId)
  return task.parentTaskId === undefined && run.parentRunId !== undefined
}

/**
 * The skill bytes the worker of one session would load: the overlay root its
 * spawn carried (the candidate the sandbox shadows production with), or the
 * production skill when it carried none. Read from the spawn the runtime
 * actually made, so which bytes each side ran is the deployment's own
 * resolution of the grant.
 */
function loadedSkillBody(h: RunStack, sessionId: SessionId): string {
  const request = h.spawns.find(item => String(item.sessionId) === String(sessionId))
  const roots = request?.grant?.skillRoots ?? []
  const file = roots.length > 0 ? join(roots[0]!, SKILL, 'SKILL.md') : join(h.home, 'skills', SKILL, 'SKILL.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** The scripted worker: it does what the skill it loaded says, and records which bytes those were. */
async function replayedWorker(h: RunStack, sessionId: SessionId, agent: Agent): Promise<void> {
  if (!await isReplayedWorker(h, sessionId)) return
  const body = loadedSkillBody(h, sessionId)
  await writeFile(join(agent.session.header.cwd, MARKER), `${sha256Of(body)}\n`)
  for (const file of ANSWER_FILES) {
    if (!body.includes(`WRITE:${file}`)) continue
    await writeFile(join(agent.session.header.cwd, file), `${file}\n`)
  }
}

/**
 * The recursive content digest of a directory, computed here so the frozen
 * snapshot identity is never confirmed against the implementation that produced
 * it: relative paths sorted, each with the SHA-256 of its bytes.
 */
async function independentDigest(directory: string): Promise<string> {
  const lines: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else lines.push(`${rel}\0${createHash('sha256').update(await readFile(join(current, entry.name))).digest('hex')}`)
    }
  }
  await walk(directory, '')
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/** The root contract the fixture's tree runs under; the intake is real, so it is stated. */
function rootContract(objective: string) {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

/** One command-settled criterion, as a historical sample carries it — pinned to the registered judge an experiment freezes with (S4-E §Q3). */
function criterion(criterionId: string, command: string): AcceptanceCriterion {
  return {
    criterionId,
    description: 'it holds',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command,
    verifierRef: 'command',
  }
}

/**
 * Write one terminal sample straight into the store through the store's own
 * service: the historical record a sample locates its case by. `outcome` is
 * what its latest review says — the role rule reads exactly that.
 */
async function writeSample(h: RunStack, storeId: string, input: {
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
    verifierResults: [{
      criterionId: input.acceptance.criterionId,
      status: input.outcome === 'verified' ? 'pass' : 'fail',
      verifierId: 'command',
    }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the answer file was never produced' } : {}),
  })
  await h.task.recordReviewIn(storeId, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [`the historical run sample "${input.taskId}" locates`],
    ...(input.outcome === 'failed' ? { localizedCause: 'the answer file was never produced' } : {}),
    criteria: [{
      criterionId: input.acceptance.criterionId,
      verdict: input.outcome === 'verified' ? 'pass' : 'fail',
      verifierId: 'command',
    }],
  }, 'tester')
}

interface Fixture {
  h: RunStack
  evolution: EvolutionService
  storeId: string
  /** The replay tool as the deployment's registry holds it. */
  replay(args: Record<string, unknown>): Promise<string>
  /** Any of the evolution tools, dispatched the way the loop dispatches one. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
}

/**
 * One fixture: the real stack with the plugin's own `evolution_replay` tool
 * registered on it, a production skill that never writes `fix.txt`, and a
 * prepared candidate beside it. `skipSamples` leaves the store empty for the
 * refusal cases that are about a call naming nothing usable.
 */
async function fixture(options: { candidateBody?: string; skipSamples?: boolean } = {}): Promise<Fixture> {
  let h!: RunStack
  h = await startRunStack({
    roots: [ROOT],
    capabilities: { [ROW]: { skills: [SKILL] } },
    evolution: true,
    worker: (sessionId: SessionId, agent: Agent) => replayedWorker(h, sessionId, agent),
  })
  const skillRoot = join(h.home, 'skills')
  await mkdir(join(skillRoot, SKILL), { recursive: true })
  await writeFile(join(skillRoot, SKILL, 'SKILL.md'), PRODUCTION_BODY, 'utf8')
  const candidateBody = options.candidateBody ?? CANDIDATE_BODY
  const evolution = new EvolutionService(h.ctx, {
    root: join(h.workspace, 'evolution'),
    skillRoot,
    // The deployment's model selection: the experiment freezes it, places every
    // replayed spawn under it, and the promotion gate re-reads the runs' own
    // requests against it (S4-E §F.2/§Q3).
    modelSelection: () => deploymentModelSelection(h.ctx),
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
  await evolution.candidate(PROPOSAL, { skill: 'v2' }, ROOT, { name: SKILL, content: candidateBody })
  await evolution.prepare(PROPOSAL, ROOT)

  const first = await h.root(ROOT, rootContract('evaluate the candidate skill'))
  // The caller session's own workspace: where the root's runs work, and the
  // directory the tool freezes as the experiment's input snapshot.
  await mkdir(join(h.checkout, 'nested'), { recursive: true })
  await writeFile(join(h.checkout, 'input.txt'), 'the frozen input\n', 'utf8')
  await writeFile(join(h.checkout, 'nested', 'threshold.txt'), '42\n', 'utf8')

  if (options.skipSamples !== true) {
    await writeSample(h, first.storeId, { taskId: 't-fix', runId: 'r-fix-history', objective: 'the answer file is produced', acceptance: criterion('ac-fix', 'test -f fix.txt'), outcome: 'failed' })
    await writeSample(h, first.storeId, { taskId: 't-holdout', runId: 'r-holdout-history', objective: 'the held-out answer file is produced', acceptance: criterion('ac-holdout', 'test -f holdout.txt'), outcome: 'verified' })
    await writeSample(h, first.storeId, { taskId: 't-regression', runId: 'r-regression-history', objective: 'the regression answer file is produced', acceptance: criterion('ac-keep', 'test -f keep.txt'), outcome: 'verified' })
  }
  // The switch is on, so the root allow-list carries these names; each one already
  // has a global stand-in on this stack, and a scoped registration shadows the global one.
  for (const tool of [
    defineEvolutionReplayTool(h.ctx),
    defineEvolutionGateTool(h.ctx),
    defineEvolutionDecideTool(h.ctx),
    defineEvolutionApplyTool(h.ctx),
    defineEvolutionRollbackTool(h.ctx),
  ]) {
    h.rootAgent(ROOT).ctx.tools.register(tool)
  }
  return {
    h,
    evolution,
    storeId: first.storeId,
    async replay(args) {
      const result = await h.call(h.rootAgent(ROOT), 'evolution_replay', args)
      expect(result.isError, result.text).toBe(false)
      return result.text
    },
    /** One evolution tool call as the loop dispatches it: the answer's own text, and its error flag. */
    async call(name: string, args: Record<string, unknown>) {
      const result = await h.call(h.rootAgent(ROOT), name, args)
      return { text: result.text, isError: result.isError }
    },
  }
}

/** The ledger's own lines, read from disk (the append-only file, never the service's memory). */
async function ledgerLines(f: Fixture): Promise<Record<string, unknown>[]> {
  const file = join(f.h.workspace, 'evolution', 'proposals.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The experiment report one tool answer names, read back from disk. */
async function reportOnDisk(f: Fixture, reportPath: string): Promise<ExperimentReport> {
  return JSON.parse(await readFile(join(f.h.workspace, 'evolution', reportPath), 'utf8')) as ExperimentReport
}

/** The side detail of one sample in a report. */
function side(report: ExperimentReport, taskId: string, which: 'baseline' | 'candidate') {
  const sample = report.samples.find(item => item.taskId === taskId)
  if (sample === undefined) throw new Error(`the report holds no sample ${taskId}`)
  return sample[which]
}

/** Every experiment id the ledger recorded, in order. */
async function experimentIds(f: Fixture): Promise<string[]> {
  return (await ledgerLines(f)).filter(line => line.kind === 'experiment_started').map(line => String(line.experimentId))
}

/** The newest experiment id in the ledger; a spec that wrote none fails loudly here rather than silently passing. */
async function experimentIdOf(f: Fixture): Promise<string> {
  const ids = await experimentIds(f)
  expect(ids.length).toBeGreaterThan(0)
  return ids[ids.length - 1]!
}

describe('S4-E: evolution_replay evaluates a skill candidate as the two-sided experiment', () => {
  it('runs both sides of every sample as new runs, in workspaces of their own, and renders the frozen identity', async () => {
    const f = await fixture()
    const before = await f.h.snapshot(f.storeId)
    const answer = await f.replay({
      proposalId: PROPOSAL,
      taskIds: ['t-fix'],
      holdoutTaskIds: ['t-holdout'],
      budget: BUDGET,
    })
    const experimentId = await experimentIdOf(f)
    const reportPath = `sandbox/${PROPOSAL}/exp-${experimentId}/experiment-report.json`

    // --- the model-facing answer names the experiment, the report and the verdict ---
    expect(answer).toContain(`proposal ${PROPOSAL} [experiment] skill ${SKILL} — verdict: fixed`)
    expect(answer).toContain('t-fix [observed-failure] baseline failed → candidate verified (ac-fix fail→pass) — fixed')
    expect(answer).toContain('t-holdout [holdout] baseline verified → candidate verified (no criterion diff) — maintained')
    expect(answer).toContain(`report: ${reportPath}`)
    expect(answer).toContain(`experiment ${experimentId}`)
    expect(answer).toContain(`model ${MODEL}`)
    // The baseline is this experiment's own new run, said in the answer's own words.
    expect(answer).toMatch(/every side above is a new run this experiment started/)
    expect(answer).not.toContain('champion')

    // --- the report on disk is the report the answer rendered ---
    const report = await reportOnDisk(f, reportPath)
    expect(report.formatVersion).toBe(3)
    expect(report.experimentId).toBe(experimentId)
    expect(report.verdict).toBe('fixed')
    expect(report.verdict).toBe(overallExperimentVerdict(report.samples))
    expect(report.samples.map(item => item.verdict)).toEqual(['fixed', 'maintained'])

    // --- the frozen identity: four sides' input, both contents, the model, the budget, the comparer ---
    const snapshotDigest = await independentDigest(f.h.checkout)
    // The door the tool reads for it: the caller session's own workspace, as the
    // runtime resolves it.
    expect(await f.h.runtime.workspacePathFor(ROOT)).toBe(f.h.checkout)
    expect(report.frozen.snapshot.digest).toBe(snapshotDigest)
    expect(report.frozen.snapshot.sourceDir).toBe(f.h.checkout)
    expect(report.frozen.candidate.sha256).toBe(sha256Of(CANDIDATE_BODY))
    expect(report.frozen.productionBaseline).toEqual({ name: SKILL, sha256: sha256Of(PRODUCTION_BODY) })
    expect(report.frozen.model).toEqual({ provider: 'p', model: 'm', label: 'p/m' })
    expect(report.frozen.budget).toEqual(BUDGET)
    expect(report.frozen.comparerVersion).toBe('experiment-comparer@2')
    expect(report.frozen.samples.map(sample => [sample.taskId, sample.role, sample.observed.outcome])).toEqual([
      ['t-fix', 'observed-failure', 'failed'],
      ['t-holdout', 'holdout', 'verified'],
    ])
    expect(report.frozenDigest).toMatch(/^[a-f0-9]{64}$/)

    // --- four new runs, two workspaces per sample, none of them the historical task ---
    const after = await f.h.snapshot(f.storeId)
    const created = after.tasks.filter(task => !before.tasks.some(previous => previous.taskId === task.taskId))
    expect(created).toHaveLength(4)
    for (const sample of report.samples) {
      for (const detail of [sample.baseline, sample.candidate]) {
        expect(detail.taskId).toBeDefined()
        expect(detail.taskId).not.toBe(sample.taskId)
        expect(detail.runId).toBeDefined()
        expect(detail.initialDigest).toBe(snapshotDigest)
        expect(detail.workspace).toContain(join(PROPOSAL, `exp-${experimentId}`, sample.taskId))
        // Every side cites a real run, review record and evidence of this store.
        const review = after.reviews.find(item => item.runId === detail.runId)
        expect(review).toBeDefined()
        expect(detail.reviewRef).toBe(`${detail.taskId}#${detail.runId}`)
        expect(detail.evidenceRefs).toEqual(review!.evidenceRefs)
        expect(detail.evidenceRefs.length).toBeGreaterThan(0)
        expect(detail.criteria.map(item => [item.criterionId, item.verdict, item.verifierId])).toHaveLength(1)
        expect(existsSync(detail.workspace)).toBe(true)
      }
      expect(sample.baseline.workspace).not.toBe(sample.candidate.workspace)
    }

    // --- each side ran the bytes it is bound to, and wrote only in its own workspace ---
    const fixBaseline = side(report, 't-fix', 'baseline')
    const fixCandidate = side(report, 't-fix', 'candidate')
    const productionDigest = sha256Of(PRODUCTION_BODY)
    const candidateDigest = sha256Of(CANDIDATE_BODY)
    expect(candidateDigest).not.toBe(productionDigest)
    // The digest each worker recorded is of the skill file it loaded through its
    // own spawn: the baseline resolved production, the candidate the sandbox.
    for (const sample of report.samples) {
      expect(readFileSync(join(sample.baseline.workspace, MARKER), 'utf8').trim()).toBe(productionDigest)
      expect(readFileSync(join(sample.candidate.workspace, MARKER), 'utf8').trim()).toBe(candidateDigest)
    }
    // The production skill writes no `fix.txt`; the candidate writes it — and the
    // file one side's run produced is in that side's own directory only.
    expect(fixBaseline.outcome).toBe('failed')
    expect(fixBaseline.criteria).toEqual([expect.objectContaining({ criterionId: 'ac-fix', verdict: 'fail', verifierId: 'command' })])
    expect(fixCandidate.outcome).toBe('verified')
    expect(existsSync(join(fixBaseline.workspace, 'fix.txt'))).toBe(false)
    expect(existsSync(join(fixCandidate.workspace, 'fix.txt'))).toBe(true)
    expect(existsSync(join(side(report, 't-holdout', 'baseline').workspace, 'fix.txt'))).toBe(false)
    expect(existsSync(join(side(report, 't-holdout', 'candidate').workspace, 'holdout.txt'))).toBe(true)
    // Both sides hold the frozen input (each workspace was built from the
    // snapshot) and neither holds the other's marker.
    for (const sample of report.samples) {
      for (const detail of [sample.baseline, sample.candidate]) {
        expect(existsSync(join(detail.workspace, 'input.txt'))).toBe(true)
        expect(readFileSync(join(detail.workspace, MARKER), 'utf8').trim())
          .toBe(detail.side === 'baseline' ? productionDigest : candidateDigest)
      }
    }

    // --- the ledger holds one frozen experiment and one record per side, and nothing else ---
    const lines = await ledgerLines(f)
    expect(lines.filter(line => line.kind === 'experiment_started')).toHaveLength(1)
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)
    expect(lines.filter(line => line.kind === 'replayed')).toHaveLength(0)
    expect(lines.filter(line => line.kind === 'proposed' || line.kind === 'candidate' || line.kind === 'prepared')).toHaveLength(3)
    // A skill proposal is not moved to `replayed`: its evaluation is an
    // experiment, and the promotion gate reads that experiment (the end-to-end
    // describe below drives exactly that chain).
    expect((await f.evolution.get(PROPOSAL)).status).toBe('prepared')
  })

  it('derives the observed-regression role from history when a verified task is named among the observed', async () => {
    const f = await fixture({ candidateBody: skillBody(['keep.txt']) })
    const answer = await f.replay({
      proposalId: PROPOSAL,
      taskIds: ['t-fix', 't-regression'],
      holdoutTaskIds: ['t-holdout'],
      budget: BUDGET,
    })
    const report = await reportOnDisk(f, `sandbox/${PROPOSAL}/exp-${await experimentIdOf(f)}/experiment-report.json`)
    expect(report.frozen.samples.map(sample => [sample.taskId, sample.role])).toEqual([
      ['t-fix', 'observed-failure'],
      ['t-regression', 'observed-regression'],
      ['t-holdout', 'holdout'],
    ])
    // The target is fixed and the observed regression broke: the overall verdict
    // carries both facts, and never reads as a plain fix.
    expect(report.samples.map(sample => sample.verdict)).toEqual(['fixed', 'regressed', 'maintained'])
    expect(report.verdict).toBe('fixed-with-regression')
    expect(answer).toContain('t-regression [observed-regression] baseline verified → candidate failed')
    expect(answer).toContain('(ac-keep pass→fail) — regressed')
    expect(answer).toContain('verdict: fixed-with-regression')
  })

  it('refuses a call with no failed sample, writing nothing', async () => {
    const f = await fixture()
    const before = await f.h.snapshot(f.storeId)
    const spawnsBefore = f.h.spawns.length
    const answer = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-holdout'], holdoutTaskIds: ['t-regression'], budget: BUDGET })
    expect(answer).toContain('evolution_replay rejected:')
    expect(answer).toContain('at least one observed-failure')
    expect(await ledgerLines(f)).toHaveLength(3)
    const after = await f.h.snapshot(f.storeId)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
    expect(f.h.spawns).toHaveLength(spawnsBefore)
    expect(existsSync(join(f.h.workspace, 'evolution', 'sandbox', PROPOSAL, 'exp'))).toBe(false)
  })

  it('refuses a call with an empty holdout, writing nothing', async () => {
    const f = await fixture()
    const before = await f.h.snapshot(f.storeId)
    const spawnsBefore = f.h.spawns.length
    const answer = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-fix'], budget: BUDGET })
    expect(answer).toContain('evolution_replay rejected:')
    expect(answer).toContain('holdoutTaskIds must name at least one task that did not select this candidate')
    const after = await f.h.snapshot(f.storeId)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(f.h.spawns).toHaveLength(spawnsBefore)
  })

  it('refuses overlapping lists and a sample with no terminal history, naming each and starting no run', async () => {
    const f = await fixture()
    const spawnsBefore = f.h.spawns.length
    const overlap = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-fix'], holdoutTaskIds: ['t-fix'], budget: BUDGET })
    expect(overlap).toContain('taskIds and holdoutTaskIds must not overlap or repeat')

    // A live case nobody settled: it carries no terminal history to read a role from.
    await f.h.task.createTaskIn(f.storeId, {
      taskId: 't-live',
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'a case still in flight',
      depth: 0,
      acceptanceCriteria: [criterion('ac-keep', 'test -f keep.txt')],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    const live = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-live'], holdoutTaskIds: ['t-holdout'], budget: BUDGET })
    expect(live).toContain('evolution_replay rejected:')
    expect(live).toContain('task "t-live" is created; only a terminal (verified or failed) task carries the history a role is read from')
    expect(f.h.spawns).toHaveLength(spawnsBefore)
    expect(await ledgerLines(f)).toHaveLength(3)
  })

  it('refuses an unknown sample and a candidate whose content moved, with the same service refusal', async () => {
    const f = await fixture()
    const spawnsBefore = f.h.spawns.length
    const unknown = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-nope'], holdoutTaskIds: ['t-holdout'], budget: BUDGET })
    expect(unknown).toContain('unknown task "t-nope" in this graph\'s task store')

    await writeFile(join(f.h.workspace, 'evolution', 'sandbox', PROPOSAL, 'skills', SKILL, 'SKILL.md'), 'tampered\n', 'utf8')
    const tampered = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-fix'], holdoutTaskIds: ['t-holdout'], budget: BUDGET })
    expect(tampered).toContain('evolution_replay rejected:')
    expect(tampered).toContain('no longer matches the content identity')
    expect(f.h.spawns).toHaveLength(spawnsBefore)
    // Nothing ran and nothing was recorded: the ledger holds the three lifecycle lines only.
    expect((await ledgerLines(f)).map(line => line.kind)).toEqual(['proposed', 'candidate', 'prepared'])
  })

  it('reuses every settled side on a repeat call, and a higher repetition freezes a new experiment', async () => {
    const f = await fixture()
    const first = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-fix'], holdoutTaskIds: ['t-holdout'], budget: BUDGET })
    const firstId = await experimentIdOf(f)
    const afterFirst = await f.h.snapshot(f.storeId)
    const linesAfterFirst = (await ledgerLines(f)).length
    const spawnsAfterFirst = f.h.spawns.length

    const second = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-fix'], holdoutTaskIds: ['t-holdout'], budget: BUDGET })
    expect(second).toContain(`experiment ${firstId}`)
    expect(second).toBe(first)
    const afterSecond = await f.h.snapshot(f.storeId)
    expect(afterSecond.tasks).toHaveLength(afterFirst.tasks.length)
    expect(afterSecond.runs).toHaveLength(afterFirst.runs.length)
    expect(f.h.spawns).toHaveLength(spawnsAfterFirst)
    expect((await ledgerLines(f)).length).toBe(linesAfterFirst)

    // A higher repetition is the explicit new experiment §F.2 allows: it runs
    // again — four new sides — under its own id and its own frozen block.
    const third = await f.replay({ proposalId: PROPOSAL, taskIds: ['t-fix'], holdoutTaskIds: ['t-holdout'], budget: BUDGET, repetition: 1 })
    const ids = await experimentIds(f)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(firstId)
    expect(third).toContain(`experiment ${ids[1]}`)
    expect(third).toContain('repetition 1')
    expect(f.h.spawns).toHaveLength(spawnsAfterFirst + 4)
    expect((await f.h.snapshot(f.storeId)).tasks).toHaveLength(afterFirst.tasks.length + 4)
  })

  it('refuses a non-skill target: no experiment, no run, no ledger write', async () => {
    const f = await fixture()
    await f.evolution.propose({
      proposalId: PRESET_PROPOSAL,
      targetType: 'agent_preset',
      targetId: PRESET,
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'the fixture preset needs the verification skill',
      sourceRefs: ['diagnosis:d2'],
    }, ROOT)

    const before = await f.h.snapshot(f.storeId)
    const spawnsBefore = f.h.spawns.length
    const linesBefore = await ledgerLines(f)
    const answer = await f.replay({ proposalId: PRESET_PROPOSAL, taskIds: ['t-fix'], holdoutTaskIds: ['t-holdout'] })
    // Unsupported preset changes stay records and never start an experiment.
    expect(answer).toContain('evolution_replay rejected:')
    expect(answer).toContain(`"agent_preset"`)
    expect(answer).toContain('this tool evaluates a prepared Task template, Skill or capability candidate')
    expect(answer).toContain('this target has no evaluator')
    expect((await f.evolution.get(PRESET_PROPOSAL)).status).toBe('proposed')
    // Nothing ran and nothing was written: no run, no spawn, no ledger line, no
    // experiment and no report.
    expect((await f.h.snapshot(f.storeId)).tasks).toHaveLength(before.tasks.length)
    expect(f.h.spawns).toHaveLength(spawnsBefore)
    expect((await ledgerLines(f)).map(line => line.kind)).toEqual(linesBefore.map(line => line.kind))
    expect((await ledgerLines(f)).map(line => line.kind)).not.toContain('experiment_started')
    expect(existsSync(join(f.h.workspace, 'evolution', 'sandbox', PRESET_PROPOSAL))).toBe(false)

    // The same shape is refused where its lifecycle would start, before any write.
    const candidateRefusal = await f.evolution
      .candidate(PRESET_PROPOSAL, { agentPreset: 'v2' }, ROOT, { presetId: PRESET, files: [{ path: 'preset.yml', content: 'preset: new\n' }] })
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(candidateRefusal).toContain('cannot become a candidate in this build')
    expect((await ledgerLines(f)).map(line => line.kind)).toEqual(linesBefore.map(line => line.kind))
  })
})

/**
 * S4-E §F.2 end to end through the production tools: the experiment is the
 * evidence, the gate cites its report, and only after the publication approval does
 * the candidate replace the production `SKILL.md` — from which `evolution_rollback`
 * restores the champion bytes. This is the chain EVAL-2's positive case asks for,
 * with the real ledger, store, runtime, spawn, verifier and both approvals
 * (the stack's approval seam answers `allowed-once`).
 */
describe('S4-E: the promotion gate promotes a fixed skill candidate end to end', () => {
  const gateAnswers = (refs: string[]) => ({
    targetFailureFixed: 'the target failure is fixed on the candidate side',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the held-out samples are maintained',
    noUnacceptableSideEffects: 'one SKILL.md changes',
    holdoutPerformanceAcceptable: 'no holdout degraded',
    resourceCostAcceptable: 'recorded from the runs',
    regressionEvidenceRefs: refs,
  })

  it('runs the experiment → gate → decide → apply → rollback, with each step asked of the real tools', async () => {
    const f = await fixture()
    const production = join(f.h.home, 'skills', SKILL, 'SKILL.md')
    expect(readFileSync(production, 'utf8')).toBe(PRODUCTION_BODY)

    // 1. The evaluation: both sides of both samples, as this experiment's own runs.
    //    The budget declares no cost ceiling, so a side whose cost the run never
    //    reported is recorded as unknown — never as a zero, and never a refusal
    //    (§F.2; a declared ceiling would be the other case).
    await f.replay({
      proposalId: PROPOSAL,
      taskIds: ['t-fix'],
      holdoutTaskIds: ['t-holdout'],
      budget: { note: 'no cost ceiling declared for this fixture run' },
    })
    const experimentId = await experimentIdOf(f)
    const reportPath = `sandbox/${PROPOSAL}/exp-${experimentId}/experiment-report.json`
    const experimentReport = await reportOnDisk(f, reportPath)
    for (const sample of experimentReport.samples) {
      expect(sample.baseline.cost.status === 'reported' || sample.baseline.cost.status === 'unknown').toBe(true)
      expect(sample.candidate.cost.status === 'reported' || sample.candidate.cost.status === 'unknown').toBe(true)
    }

    // 2. The gate: six answers over the experiment, whose report must be cited.
    const gateMissing = await f.call('evolution_gate', { proposalId: PROPOSAL, ...gateAnswers(['evidence:missing']) })
    expect(gateMissing.text).toContain('must cite its experiment report')
    const gated = await f.call('evolution_gate', { proposalId: PROPOSAL, ...gateAnswers([reportPath]) })
    expect(gated.isError, gated.text).toBe(false)
    expect(gated.text).toContain('[gated] gate answered 6/6')

    // 3. The model decision: PROMOTE is recorded, and nothing is written yet.
    const decided = await f.call('evolution_decide', { proposalId: PROPOSAL, decision: 'PROMOTE', note: 'the fix holds' })
    expect(decided.isError, decided.text).toBe(false)
    expect(decided.text).toContain('proposal p1 [decided] PROMOTE — the fix holds')
    expect(decided.text).toContain('nothing applied yet; continue with evolution_apply')
    expect(readFileSync(production, 'utf8')).toBe(PRODUCTION_BODY)

    // 4. The publication approval: the apply writes exactly the candidate bytes.
    const applied = await f.call('evolution_apply', { proposalId: PROPOSAL })
    expect(applied.isError, applied.text).toBe(false)
    expect(applied.text).toContain('proposal p1 [applied] L2 skill')
    expect(applied.text).toContain(`  - ${production}`)
    expect(readFileSync(production, 'utf8')).toBe(CANDIDATE_BODY)
    expect((await f.evolution.get(PROPOSAL)).status).toBe('applied')

    // 5. Rollback restores the champion snapshot, with its own approval.
    const rolledback = await f.call('evolution_rollback', { proposalId: PROPOSAL })
    expect(rolledback.isError, rolledback.text).toBe(false)
    expect(rolledback.text).toContain('champion restored')
    expect(readFileSync(production, 'utf8')).toBe(PRODUCTION_BODY)
    expect((await f.evolution.get(PROPOSAL)).status).toBe('rolledback')

    // Every step is on the ledger, in order, with the approval evidents the
    // tools passed to the service — and each production write is one commit:
    // its `commit_intent` line first, the completion that closes it after.
    const kinds = (await ledgerLines(f)).map(line => line.kind as string)
    expect(kinds).toEqual([
      'proposed', 'candidate', 'prepared',
      'experiment_started', 'experiment_sample', 'experiment_sample', 'experiment_sample', 'experiment_sample',
      'gated', 'decided', 'commit_intent', 'applied', 'commit_intent', 'rolledback',
    ])
    const lines = await ledgerLines(f)
    expect(lines.filter(line => line.kind === 'decided')[0]).toMatchObject({ decision: 'PROMOTE', approvalRef: expect.stringMatching(/^decision:/) })
    expect(lines.filter(line => line.kind === 'applied')[0]).toMatchObject({
      targets: [production],
      approvalRef: expect.stringMatching(/^approval:/),
      intentId: `${PROPOSAL}/apply`,
    })
    expect(lines.filter(line => line.kind === 'rolledback')[0]).toMatchObject({
      targets: [production],
      approvalRef: expect.stringMatching(/^approval:/),
      intentId: `${PROPOSAL}/rollback`,
    })
    // Each intent names the same grant and the same file set its completion
    // closes, so the two lines of one commit cannot describe different
    // operations: a guidance object is one file, and the intent names it.
    const intents = lines.filter(line => line.kind === 'commit_intent')
    expect(intents).toHaveLength(2)
    for (const intent of intents) {
      expect((intent.files as readonly { target: string }[]).map(file => file.target)).toEqual([production])
    }
    expect(intents[0]).toMatchObject({
      proposalId: PROPOSAL,
      direction: 'apply',
      approvalRef: (lines.filter(line => line.kind === 'applied')[0] as { approvalRef: string }).approvalRef,
    })
    expect(intents[1]).toMatchObject({
      proposalId: PROPOSAL,
      direction: 'rollback',
      approvalRef: (lines.filter(line => line.kind === 'rolledback')[0] as { approvalRef: string }).approvalRef,
    })
    // Nothing rewrote an earlier line: a skill candidate never takes `replayed`.
    expect(kinds).not.toContain('replayed')
  })

  it('refuses a skill candidate whose evidence is not a completed experiment, before any human is asked', async () => {
    const f = await fixture()
    const bare = await f.call('evolution_gate', { proposalId: PROPOSAL, ...gateAnswers(['evidence:missing']) })
    expect(bare.text).toContain('has no two-sided experiment')
    expect((await f.evolution.get(PROPOSAL)).status).toBe('prepared')

    const promote = await f.call('evolution_decide', { proposalId: PROPOSAL, decision: 'PROMOTE' })
    expect(promote.text).toContain('evolution_decide rejected:')
    expect(promote.text).toContain('is prepared; only a gated proposal can be decided')
    expect(await ledgerLines(f)).toHaveLength(3)
  })
})

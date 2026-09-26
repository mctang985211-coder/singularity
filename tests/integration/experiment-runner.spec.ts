/**
 * S4-E §F.2 end to end: the two-sided skill experiment on the real deployment —
 * the real task store, `TaskRuntime.replayTask` with the caller's workspace, the
 * real `AgentRuntime.spawn` over the real skill plane, and the real
 * `VerifierRegistry` with its command verifier.
 *
 * What the spec pins, and why each assertion is read from a durable surface:
 *
 * 1. **Both sides are new runs.** A sample's historical record locates the case;
 *    the baseline and the candidate are this experiment's own replayed tasks,
 *    each in its own workspace built from one frozen snapshot, and the baseline
 *    side carries no overlay at all (the production configuration) while the
 *    candidate side's overlay is the prepared sandbox's `skills/` — which is
 *    what makes the reported difference a difference the deployment's own
 *    shadowing produced, not a fixture invention.
 * 2. **The verdict is the evidence.** `verdict === overallExperimentVerdict(...)`
 *    recomputed from the report's own details, and the ledger's records rebuild
 *    the same report byte for byte.
 * 3. **Idempotency.** A repeat call reuses every recorded key: no new task, no
 *    new run, no new spawn, no new ledger line.
 * 4. **Impersonation is refused.** A report side citing the sample's own
 *    historical run is refused by the schema; a ledger line citing a run no run
 *    of this experiment's lineage created is refused by the service, and
 *    nothing is re-run.
 * 5. **A spent key belongs to its experiment.** The same key under a different
 *    frozen experiment (another model identity) is refused before any ledger
 *    write; a higher repetition is what freezes a new experiment.
 * 6. **Cancellation and restart.** A run that settled cancelled stops the
 *    experiment where it stands; a sample whose run the store still holds is
 *    settled from the store (terminal as it settled, otherwise `interrupted`)
 *    and is never re-run, however many times the experiment is resumed.
 * 7. **Cost is what the run reported.** A settled side carries its review
 *    record's metrics verbatim; a side that never settled reports `unknown`
 *    with its reason, never a zero.
 *
 * The model loop is replaced by run-stack's worker hook — the scripted worker
 * reads the skill bytes its own spawn would have loaded and does what they say,
 * which is exactly what a model would do with them. Everything else is the
 * deployment's own: the store, the runtime, the verifier, the ledger.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EvolutionService } from '../../evolution/src/index.ts'
import type { ExperimentResult, ExperimentSampleRecord, ExperimentSpec } from '../../evolution/src/index.ts'
import { assertExperimentReport, experimentLineage, modelSelectionOf, overallExperimentVerdict } from '../../evolution/src/index.ts'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import { disposeRunStacks, startRunStack, type RunStack } from '../support/run-stack.ts'

const ROOT = 's-root' as SessionId
const PROPOSAL = 'p1'
const SKILL = 'experiment-fixture-skill'
/** The answer files a skill body tells its worker to write; the criteria are `test -f <file>`. */
const ANSWER_FILES = ['fix.txt', 'keep.txt', 'holdout.txt']

/** The production skill: it never produces `fix.txt` — which is the historical failure the sample reproduces. */
const PRODUCTION_BODY = skillBody(['fix.txt'])
/** The candidate: it produces every answer file, so the failure is fixed and the holdout holds. */
const CANDIDATE_BODY = skillBody([])

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

/** The replayed worker of one session: a parentless task whose run descends from a champion run. */
async function isReplayedWorker(h: RunStack, sessionId: SessionId): Promise<boolean> {
  const { task, run } = await h.runtime.runForSession(sessionId)
  return task.parentTaskId === undefined && run.parentRunId !== undefined
}

/**
 * The skill bytes the worker of one session would load: the overlay root its
 * spawn carried (the candidate the sandbox shadows production with), or the
 * production skill when it carried none. Read from the spawn the runtime
 * actually made, so the two sides' difference is the deployment's own
 * resolution of the grant and not a fixture flag.
 */
function loadedSkillBody(h: RunStack, sessionId: SessionId): string {
  const request = h.spawns.find(item => String(item.sessionId) === String(sessionId))
  const roots = request?.grant?.skillRoots ?? []
  const file = roots.length > 0 ? join(roots[0]!, SKILL, 'SKILL.md') : join(h.home, 'skills', SKILL, 'SKILL.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** The scripted worker: it does what the skill it loaded says. */
async function replayedWorker(h: RunStack, sessionId: SessionId, agent: Agent): Promise<void> {
  if (!await isReplayedWorker(h, sessionId)) return
  const body = loadedSkillBody(h, sessionId)
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
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

/** One command-settled criterion, as a champion task carries it — pinned to the registered judge an experiment freezes with (S4-E §Q3). */
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
    requestedCapabilities: [],
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
  // The terminal review the sample's role is read from — the store requires it
  // to follow the terminal transition it declares, and a failed one to name
  // what failed.
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
  snapshotDir: string
  /** The candidate body the proposal was prepared with. */
  candidateBody: string
}

/** A latch one test releases from outside a parked worker body. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/**
 * One experiment fixture: the real stack, a production skill that never writes
 * `fix.txt`, a prepared candidate beside it (the walk this experiment evaluates),
 * and three terminal samples — `t-fix` (a failure the candidate is meant to
 * fix), `t-holdout` and `t-regression` (verified, and neither selected on).
 *
 * `worker` replaces the scripted turn for the cases that need to park one (a
 * cancellation), so the run a spec stops is a real in-flight replay.
 */
async function fixture(options: {
  candidateBody?: string
  worker?: (h: RunStack, sessionId: SessionId, agent: Agent) => Promise<void>
} = {}): Promise<Fixture> {
  let h!: RunStack
  h = await startRunStack({
    roots: [ROOT],
    worker: (sessionId: SessionId, agent: Agent) => (options.worker ?? replayedWorker)(h, sessionId, agent),
  })
  const skillRoot = join(h.home, 'skills')
  await mkdir(join(skillRoot, SKILL), { recursive: true })
  await writeFile(join(skillRoot, SKILL, 'SKILL.md'), PRODUCTION_BODY, 'utf8')
  const candidateBody = options.candidateBody ?? CANDIDATE_BODY
  const evolution = new EvolutionService(h.ctx, {
    root: join(h.workspace, 'evolution'),
    skillRoot,
    presetRoot: join(h.workspace, 'presets'),
    configFile: join(h.workspace, 'config.yml'),
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
  const snapshotDir = join(h.workspace, 'snapshot')
  await mkdir(join(snapshotDir, 'nested'), { recursive: true })
  await writeFile(join(snapshotDir, 'input.txt'), 'the frozen input\n', 'utf8')
  await writeFile(join(snapshotDir, 'nested', 'threshold.txt'), '42\n', 'utf8')

  await writeSample(h, first.storeId, { taskId: 't-fix', runId: 'r-fix-history', objective: 'the answer file is produced', acceptance: criterion('ac-fix', 'test -f fix.txt'), outcome: 'failed' })
  // A sample whose historical failure is real but does not live in the
  // acceptance it stores: the same criterion the new baseline run will judge
  // passed for the production skill, so a fresh baseline does *not* reproduce
  // the failure. Nothing may be claimed as fixed from it.
  await writeSample(h, first.storeId, { taskId: 't-slipped', runId: 'r-slipped-history', objective: 'the failure that did not reproduce', acceptance: criterion('ac-keep', 'test -f keep.txt'), outcome: 'failed' })
  await writeSample(h, first.storeId, { taskId: 't-holdout', runId: 'r-holdout-history', objective: 'the held-out answer file is produced', acceptance: criterion('ac-holdout', 'test -f holdout.txt'), outcome: 'verified' })
  await writeSample(h, first.storeId, { taskId: 't-regression', runId: 'r-regression-history', objective: 'the regression answer file is produced', acceptance: criterion('ac-keep', 'test -f keep.txt'), outcome: 'verified' })
  return { h, evolution, storeId: first.storeId, snapshotDir, candidateBody }
}

/** The experiment this spec runs, with the samples a case needs. */
function spec(fixture: Fixture, overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    proposalId: PROPOSAL,
    samples: [
      { taskId: 't-fix', role: 'observed-failure' },
      { taskId: 't-holdout', role: 'holdout' },
    ],
    snapshot: { sourceDir: fixture.snapshotDir },
    model: modelSelectionOf({ provider: 'scripted', model: 'run-stack' })!,
    budget: { maxTokens: 5_000, note: 'the fixture budget' },
    repetition: 0,
    ...overrides,
  }
}

/** The ledger's own lines, read from disk (the append-only file, never the service's memory). */
async function ledgerLines(fixture: Fixture): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(fixture.h.workspace, 'evolution', 'proposals.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The report file one result names, read back from disk as JSON. */
async function reportOnDisk(fixture: Fixture, result: ExperimentResult): Promise<unknown> {
  return JSON.parse(await readFile(join(fixture.h.workspace, 'evolution', result.reportPath), 'utf8'))
}

/** The side detail of one sample in a result. */
function side(result: ExperimentResult, taskId: string, which: 'baseline' | 'candidate') {
  const sample = result.report.samples.find(item => item.taskId === taskId)
  if (sample === undefined) throw new Error(`the report holds no sample ${taskId}`)
  return sample[which]
}

describe('S4-E: the two-sided skill experiment', () => {
  it('runs both sides of every sample as new runs, and reports a fix traceable to them', async () => {
    const f = await fixture()
    const before = await f.h.snapshot(f.storeId)
    const result = await f.evolution.runExperiment(spec(f), ROOT, ROOT)

    // --- the report is the frozen experiment's, and its verdict is its own evidence ---
    expect(result.report.formatVersion).toBe(2)
    expect(result.report.experimentId).toBe(result.experimentId)
    expect(result.report.verdict).toBe('fixed')
    expect(result.report.verdict).toBe(overallExperimentVerdict(result.report.samples))
    expect(result.report.samples.map(item => item.verdict)).toEqual(['fixed', 'maintained'])
    expect(() => assertExperimentReport(result.report)).not.toThrow()
    // The file on disk is the report the caller got, byte for byte.
    expect(await reportOnDisk(f, result)).toEqual(JSON.parse(JSON.stringify(result.report)))
    // Rebuilding it from the ledger's own records reproduces it exactly.
    const rebuilt = await f.evolution.experiment(result.experimentId)
    expect(rebuilt.samples).toHaveLength(4)
    expect(rebuilt.report).toBe(result.reportPath)

    // --- the frozen identity: the input snapshot digest, computed independently ---
    const snapshotDigest = await independentDigest(f.snapshotDir)
    expect(result.report.frozen.snapshot.digest).toBe(snapshotDigest)
    expect(result.report.frozen.snapshot.sourceDir).toBe(await realpath(f.snapshotDir))
    expect(result.report.frozen.candidate.sha256).toBe((await f.evolution.get(PROPOSAL)).prepared!.skillContent!.sha256)
    expect(result.report.frozen.model).toEqual(modelSelectionOf({ provider: 'scripted', model: 'run-stack' }))
    expect(result.report.frozen.budget).toEqual(spec(f).budget)
    expect(result.report.frozen.samples.map(sample => [sample.taskId, sample.role, sample.observed.runId])).toEqual([
      ['t-fix', 'observed-failure', 'r-fix-history'],
      ['t-holdout', 'holdout', 'r-holdout-history'],
    ])

    // --- both sides are this experiment's new runs, in two workspaces of their own ---
    const after = await f.h.snapshot(f.storeId)
    const created = after.tasks.filter(task => !before.tasks.some(previous => previous.taskId === task.taskId))
    expect(created).toHaveLength(4)
    for (const sample of result.report.samples) {
      for (const detail of [sample.baseline, sample.candidate]) {
        expect(detail.taskId).toBeDefined()
        expect(detail.taskId).not.toBe(sample.taskId)
        expect(detail.runId).toBeDefined()
        expect(detail.runId).not.toBe(result.report.frozen.samples.find(item => item.taskId === sample.taskId)!.observed.runId)
        expect(detail.initialDigest).toBe(snapshotDigest)
        expect(detail.criteria.map(item => [item.criterionId, item.verdict, item.verifierId])).toHaveLength(1)
        expect(existsSync(join(detail.workspace))).toBe(true)
      }
      expect(sample.baseline.workspace).not.toBe(sample.candidate.workspace)
      expect(sample.baseline.workspace).toContain(join(PROPOSAL, `exp-${result.experimentId}`, sample.taskId, 'baseline'))
      expect(sample.candidate.workspace).toContain(join(PROPOSAL, `exp-${result.experimentId}`, sample.taskId, 'candidate'))
    }

    // The baseline really is the production configuration and the candidate
    // really is the prepared bytes: the baseline run of the fix sample failed
    // (the production skill writes no `fix.txt`) while the candidate's passed,
    // and the two workspaces hold what each side's own run produced.
    const fix = side(result, 't-fix', 'baseline')
    expect(fix.outcome).toBe('failed')
    expect(fix.criteria).toEqual([expect.objectContaining({ criterionId: 'ac-fix', verdict: 'fail', verifierId: 'command' })])
    expect(side(result, 't-fix', 'candidate').outcome).toBe('verified')
    expect(existsSync(join(fix.workspace!, 'fix.txt'))).toBe(false)
    expect(existsSync(join(side(result, 't-fix', 'candidate').workspace!, 'fix.txt'))).toBe(true)
    // Both workspaces were built from the frozen snapshot, and each run wrote
    // only in its own: no byte of either reached the other.
    expect(existsSync(join(fix.workspace!, 'input.txt'))).toBe(true)
    expect(existsSync(join(side(result, 't-holdout', 'candidate').workspace!, 'holdout.txt'))).toBe(true)

    // --- every side cites the real run record and the real evidence ---
    for (const sample of result.report.samples) {
      for (const detail of [sample.baseline, sample.candidate]) {
        const review = after.reviews.find(item => item.runId === detail.runId)
        expect(review).toBeDefined()
        expect(detail.reviewRef).toBe(`${detail.taskId}#${detail.runId}`)
        expect(detail.evidenceRefs).toEqual(review!.evidenceRefs)
        expect(review!.evidenceRefs.length).toBeGreaterThan(0)
        // Cost is the record's own report, verbatim — or an honest unknown.
        if (detail.cost.status === 'reported') expect(detail.cost.metrics).toEqual(review!.metrics)
        else expect(detail.cost.reason.length).toBeGreaterThan(0)
      }
    }

    // --- the overlay is the deployment's own: the candidate spawn named the sandbox skills root ---
    const overlays = f.h.spawns.flatMap(request => request.grant?.skillRoots ?? [])
    expect(overlays).toHaveLength(2)
    for (const overlay of overlays) {
      expect(overlay).toBe(join(f.h.workspace, 'evolution', 'sandbox', PROPOSAL, 'skills'))
    }

    // --- the ledger holds the frozen experiment and one record per side, and nothing else ---
    const lines = await ledgerLines(f)
    expect(lines.filter(line => line.kind === 'experiment_started')).toHaveLength(1)
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)
    expect(lines.filter(line => line.kind === 'proposed' || line.kind === 'candidate' || line.kind === 'prepared')).toHaveLength(3)
  })

  it('refuses a snapshot link that escapes it before the first run, and leaves the linked file untouched', async () => {
    const f = await fixture()
    const outside = join(f.h.workspace, 'outside-shared.txt')
    await writeFile(outside, 'the production bytes\n', 'utf8')
    await symlink(outside, join(f.snapshotDir, 'shared'))

    const before = await f.h.snapshot(f.storeId)
    const linesBefore = (await ledgerLines(f)).length
    const spawnsBefore = f.h.spawns.length

    // The review's counterexample: `source/shared` is an absolute link to a file
    // outside the snapshot. Digesting the link's text — or copying the link —
    // would let the baseline run write through it, the candidate run read the
    // rewritten bytes, and both digests still equal the frozen one. The refusal
    // is the answer, and it comes before any run, any ledger line and any
    // workspace.
    await expect(f.evolution.runExperiment(spec(f), ROOT, ROOT)).rejects.toThrow(/outside the snapshot root/)

    expect(await readFile(outside, 'utf8')).toBe('the production bytes\n')
    expect((await ledgerLines(f)).length).toBe(linesBefore)
    expect(f.h.spawns).toHaveLength(spawnsBefore)
    const after = await f.h.snapshot(f.storeId)
    expect(after.tasks.map(task => task.taskId)).toEqual(before.tasks.map(task => task.taskId))
    expect(after.runs).toHaveLength(before.runs.length)
    // Nothing under the proposal's sandbox but the prepared skills: no experiment
    // directory, and no side's workspace anywhere.
    expect((await readdir(join(f.h.workspace, 'evolution', 'sandbox', PROPOSAL))).filter(name => name.startsWith('exp-'))).toEqual([])
  })

  it('materializes an internal snapshot link into each side\u2019s private workspace, so one side\u2019s write reaches neither the snapshot nor the other side', async () => {
    const f = await fixture({
      // The baseline side writes through the link's own path; the candidate side
      // writes nothing there, so what its copy holds is what the snapshot held.
      worker: async (h, sessionId, agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        await replayedWorker(h, sessionId, agent)
        const cwd = agent.session.header.cwd
        if (basename(cwd) !== 'baseline') return
        await writeFile(join(cwd, 'linked.txt'), 'written through the link\n')
        await writeFile(join(cwd, 'assets', 'added.txt'), 'written through the linked directory\n')
      },
    })
    // A real file, an absolute link to it, an absolute link to a directory with
    // a deep subtree under it, and an empty directory — every link resolves
    // inside the snapshot root, so the policy follows it to the content it names
    // and each side's copy is private.
    await writeFile(join(f.snapshotDir, 'real.txt'), 'the frozen bytes\n', 'utf8')
    await symlink(join(f.snapshotDir, 'real.txt'), join(f.snapshotDir, 'linked.txt'))
    await symlink(join(f.snapshotDir, 'nested'), join(f.snapshotDir, 'assets'))
    await mkdir(join(f.snapshotDir, 'nested', 'deep', 'deeper'), { recursive: true })
    await writeFile(join(f.snapshotDir, 'nested', 'deep', 'deeper', 'value.txt'), 'deep\n', 'utf8')
    await mkdir(join(f.snapshotDir, 'empty'))

    const result = await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    expect(result.report.verdict).toBe('fixed')

    // The snapshot was read, never written through: its link is still a link, its
    // real file still holds the frozen bytes, and nothing a side wrote through
    // the link is there.
    expect((await lstat(join(f.snapshotDir, 'linked.txt'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(f.snapshotDir, 'real.txt'), 'utf8')).toBe('the frozen bytes\n')
    expect(existsSync(join(f.snapshotDir, 'nested', 'added.txt'))).toBe(false)

    const baseline = side(result, 't-fix', 'baseline').workspace!
    const candidate = side(result, 't-fix', 'candidate').workspace!
    for (const workspace of [baseline, candidate]) {
      // Every link position is a real entry of this side's own copy — a file
      // where the link to a file was, a directory where the link to a directory
      // was — and the empty directory came along.
      expect((await lstat(join(workspace, 'linked.txt'))).isSymbolicLink()).toBe(false)
      expect((await lstat(join(workspace, 'assets'))).isSymbolicLink()).toBe(false)
      expect((await lstat(join(workspace, 'assets'))).isDirectory()).toBe(true)
      expect((await lstat(join(workspace, 'empty'))).isDirectory()).toBe(true)
      // The copy holds the bytes the snapshot held.
      expect(await readFile(join(workspace, 'assets', 'threshold.txt'), 'utf8')).toBe('42\n')
      expect(await readFile(join(workspace, 'assets', 'deep', 'deeper', 'value.txt'), 'utf8')).toBe('deep\n')
      expect(await readFile(join(workspace, 'nested', 'threshold.txt'), 'utf8')).toBe('42\n')
      expect(await readFile(join(workspace, 'input.txt'), 'utf8')).toBe('the frozen input\n')
      expect(await readFile(join(workspace, 'real.txt'), 'utf8')).toBe('the frozen bytes\n')
    }
    // The baseline's write through the link landed in the baseline's own copy…
    expect(await readFile(join(baseline, 'linked.txt'), 'utf8')).toBe('written through the link\n')
    expect(await readFile(join(baseline, 'assets', 'added.txt'), 'utf8')).toBe('written through the linked directory\n')
    // …while the candidate's copy still holds the frozen bytes — not the baseline
    // side's write — and never saw the file the baseline added.
    expect(await readFile(join(candidate, 'linked.txt'), 'utf8')).toBe('the frozen bytes\n')
    expect(existsSync(join(candidate, 'assets', 'added.txt'))).toBe(false)

    // Both sides were built from the frozen digest — and each build was proven
    // against it before its run.
    const frozenDigest = result.report.frozen.snapshot.digest
    for (const sample of result.report.samples) {
      for (const detail of [sample.baseline, sample.candidate]) expect(detail.initialDigest).toBe(frozenDigest)
    }
  })

  it('reuses every recorded key on a repeat call: no new run, no new spend, the same report', async () => {
    const f = await fixture()
    const first = await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    const afterFirst = await f.h.snapshot(f.storeId)
    const linesAfterFirst = (await ledgerLines(f)).length
    const spawnsAfterFirst = f.h.spawns.length

    const second = await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    expect(second.experimentId).toBe(first.experimentId)
    expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report))
    const afterSecond = await f.h.snapshot(f.storeId)
    expect(afterSecond.tasks).toHaveLength(afterFirst.tasks.length)
    expect(afterSecond.runs).toHaveLength(afterFirst.runs.length)
    expect(f.h.spawns).toHaveLength(spawnsAfterFirst)
    expect((await ledgerLines(f)).length).toBe(linesAfterFirst)
  })

  it('refuses a report side that cites the sample\u2019s own historical run or task', async () => {
    const f = await fixture()
    const result = await f.evolution.runExperiment(spec(f), ROOT, ROOT)

    const impersonated = structuredClone(result.report) as unknown as { samples: { baseline: { runId?: string } }[] }
    impersonated.samples[0]!.baseline.runId = 'r-fix-history'
    expect(() => assertExperimentReport(impersonated)).toThrow(/the sample's own historical run/)

    const sameTask = structuredClone(result.report) as unknown as { samples: { candidate: { taskId?: string } }[] }
    sameTask.samples[0]!.candidate.taskId = 't-fix'
    expect(() => assertExperimentReport(sameTask)).toThrow(/the sample's own historical task/)
  })

  it('refuses a spent key under a different frozen experiment, before any ledger write', async () => {
    const f = await fixture()
    await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    const before = await f.h.snapshot(f.storeId)
    const linesBefore = (await ledgerLines(f)).length
    const spawnsBefore = f.h.spawns.length

    // The same samples, another model identity: a different frozen experiment,
    // but the sample keys are the ones the first experiment already spent.
    await expect(f.evolution.runExperiment(spec(f, { model: modelSelectionOf({ provider: 'scripted', model: 'another-model' })! }), ROOT, ROOT))
      .rejects.toThrow(/is already recorded by experiment .* and its record is never/)
    expect((await ledgerLines(f)).length).toBe(linesBefore)
    const after = await f.h.snapshot(f.storeId)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(f.h.spawns).toHaveLength(spawnsBefore)

    // A higher repetition is the explicit new experiment §F.2 allows.
    const second = await f.evolution.runExperiment(spec(f, { repetition: 1 }), ROOT, ROOT)
    expect(second.experimentId).not.toBe('')
    expect(second.report.frozen.repetition).toBe(1)
    expect(second.report.verdict).toBe('fixed')
  })

  it('reads a reproduced-and-unfixed failure as both-failed, not as a fix', async () => {
    const f = await fixture({ candidateBody: skillBody(['fix.txt']) })
    const result = await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    expect(result.report.samples[0]!.verdict).toBe('both-failed')
    expect(result.report.verdict).toBe('both-failed')
    expect(side(result, 't-fix', 'baseline').outcome).toBe('failed')
    expect(side(result, 't-fix', 'candidate').outcome).toBe('failed')
  })

  it('reads a baseline that did not reproduce the failure as not-fixed, never as a fix', async () => {
    // `t-slipped` failed historically, but the acceptance it stores is one the
    // production skill satisfies: this run's baseline does not reproduce the
    // failure, so nothing was fixed — the honest verdict says so even though the
    // candidate passed.
    const f = await fixture()
    const unproduced = await f.evolution.runExperiment(spec(f, {
      samples: [
        { taskId: 't-slipped', role: 'observed-failure' },
        { taskId: 't-holdout', role: 'holdout' },
      ],
    }), ROOT, ROOT)
    expect(side(unproduced, 't-slipped', 'baseline').outcome).toBe('verified')
    expect(side(unproduced, 't-slipped', 'candidate').outcome).toBe('verified')
    expect(unproduced.report.samples[0]!.verdict).toBe('not-fixed')
    expect(unproduced.report.verdict).toBe('not-fixed')
  })

  it('reads a degraded observed-regression sample beside an unfixed target as regressed', async () => {
    const f = await fixture({ candidateBody: skillBody(['keep.txt']) })
    const result = await f.evolution.runExperiment(spec(f, {
      samples: [
        { taskId: 't-slipped', role: 'observed-failure' },
        { taskId: 't-regression', role: 'observed-regression' },
        { taskId: 't-holdout', role: 'holdout' },
      ],
    }), ROOT, ROOT)
    // The target was not fixed (its failure did not reproduce) and the
    // regression sample got worse: `regressed`, not `not-fixed`.
    expect(result.report.samples.map(item => item.verdict)).toEqual(['not-fixed', 'regressed', 'maintained'])
    expect(result.report.verdict).toBe('regressed')
    expect(side(result, 't-regression', 'baseline').outcome).toBe('verified')
    expect(side(result, 't-regression', 'candidate').outcome).toBe('failed')
    expect(side(result, 't-holdout', 'candidate').outcome).toBe('verified')
  })

  it('reads a fixed target beside a degraded holdout as fixed-with-regression', async () => {
    const f = await fixture({ candidateBody: skillBody(['holdout.txt']) })
    const result = await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    expect(result.report.samples.map(item => item.verdict)).toEqual(['fixed', 'regressed'])
    expect(result.report.verdict).toBe('fixed-with-regression')
  })

  it('stops on a cancelled run, settles what the store holds, and never re-runs a side that settled', async () => {
    const started = deferred()
    const parked = deferred()
    let replayedWorkers = 0
    const f = await fixture({
      worker: async (h, sessionId, agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        await replayedWorker(h, sessionId, agent)
        replayedWorkers += 1
        // The first side of the experiment parks until the spec cancels it; a
        // later side is only reached if the experiment failed to stop.
        if (replayedWorkers > 1) return
        started.resolve()
        await parked.promise
      },
    })

    const running = f.evolution.runExperiment(spec(f), ROOT, ROOT)
    const settled = running.then(() => undefined, (error: unknown) => error)
    try {
      await started.promise
      await f.h.runtime.cancelGraph(f.storeId, 'the caller cancelled the experiment')
    } finally {
      parked.resolve()
    }
    const failure = await settled
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/is incomplete — no record for .*resume experiment/)

    // What the store settled is what the ledger holds: the cancelled side, and
    // no report — an incomplete comparison is not evidence.
    const experimentId = (await f.evolution.experiments(PROPOSAL))[0]!.experimentId
    const cancelled = await f.evolution.experiment(experimentId)
    expect(cancelled.samples).toHaveLength(1)
    expect(cancelled.samples[0]).toMatchObject({ sampleTaskId: 't-fix', side: 'baseline', outcome: 'cancelled' })
    expect(cancelled.samples[0]!.initialDigest).toBe(await independentDigest(f.snapshotDir))
    expect(existsSync(join(f.h.workspace, 'evolution', cancelled.report))).toBe(false)

    // A process that died left a run nobody settled: the side's task is in the
    // store and has no terminal state — the shape the recovery path records as
    // interrupted instead of running it again.
    const crashedLineage = experimentLineage(experimentId, 't-holdout', 'baseline')
    await f.h.task.createTaskIn(f.storeId, {
      taskId: 't-crashed-replay',
      definitionRef: { taskType: 'root', version: 1 },
      objective: `[${crashedLineage}] a run nobody settled`,
      depth: 0,
      acceptanceCriteria: [criterion('ac-keep', 'test -f keep.txt')],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')

    const spawnsBeforeResume = f.h.spawns.length
    const resumed = await f.evolution.resumeExperiment(experimentId, ROOT, ROOT)

    // The cancelled baseline is `inconclusive` (a run that could not settle says
    // nothing about the candidate), and so is the side nobody settled — the
    // holdout's candidate did run and pass, but there is no baseline to compare.
    expect(resumed.report.samples.map(item => item.verdict)).toEqual(['inconclusive', 'inconclusive'])
    expect(resumed.report.verdict).toBe('inconclusive')
    expect(side(resumed, 't-fix', 'baseline').outcome).toBe('cancelled')
    const interrupted = side(resumed, 't-holdout', 'baseline')
    expect(interrupted.outcome).toBe('interrupted')
    expect(interrupted.taskId).toBe('t-crashed-replay')
    expect(interrupted.runId).toBeUndefined()
    expect(interrupted.reason).toMatch(/never re-runs an in-flight sample/)
    // A side that never settled reports unknown cost — never a zero.
    expect(interrupted.cost).toEqual({ status: 'unknown', reason: expect.stringContaining('never settled') })

    // The two sides that had never run did run (one spawn each); the cancelled
    // and the interrupted sides were not run at all.
    expect(f.h.spawns.length).toBe(spawnsBeforeResume + 2)
    const store = await f.h.snapshot(f.storeId)
    expect(store.tasks.find(task => task.taskId === 't-crashed-replay')!.runIds).toEqual([])
    const cancelledRun = store.runs.find(run => run.runId === cancelled.samples[0]!.runId)!
    expect(cancelledRun.status).toBe('cancelled')

    // However many times the experiment is called again, neither side is re-run
    // and no record is overwritten.
    const again = await f.evolution.runExperiment(spec(f), ROOT, ROOT)
    expect(JSON.stringify(again.report)).toBe(JSON.stringify(resumed.report))
    expect(f.h.spawns.length).toBe(spawnsBeforeResume + 2)
    const lines = await ledgerLines(f)
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)
    expect(lines.filter(line => line.kind === 'experiment_started')).toHaveLength(1)
  })
})

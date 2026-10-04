/**
 * Scripted recipe repair for the xv6 locks world: the coordinating template's
 * serial recipe runs its completion child before the fix child has produced the
 * marker, the completion child honestly fails the checker, a scripted supervisor
 * repairs the recipe through the real evolution chain, and a second root run
 * consumes the repaired version 2 recipe with its non-empty dependency edge.
 *
 * Everything except the model is the real deployment: the real TaskRuntime,
 * AgentRuntime, verifier registry (with the command verifier), evolution plane
 * and approval seam. The scripts are the model; the lab's own grader is the
 * judge, and it really runs (kalloctest + bcachetest for `modules`, the whole
 * `Score: 70/70` grade for `all`).
 *
 * @module tests/integration/xv6-lock-repair-evolution
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildExperimentReport } from '../../evolution/src/index.ts'
import { scanFailedReviewSources } from '../../agent-singularity/src/coordination/review-scan.ts'
import { rootTaskStoreId, type AcceptanceCriterion, type TaskTemplate } from '../../task/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'
import {
  ensureXv6ToolchainOnPath,
  prepareXv6Checkout,
  registerXv6RepairLibrary,
  repairedLockLabTemplate,
  resetLockLab,
  seedReferenceLockFix,
  xv6CheckoutTools,
  xv6ReferencePresent,
  xv6TestbedPresent,
  XV6_COMPLETE_MARKER,
  XV6_COMPLETION_CRITERION_ID,
  XV6_COMPLETION_LEAF_ID,
  XV6_COMPLETION_OBJECTIVE_PREFIX,
  XV6_FIX_LEAF_ID,
  XV6_FIX_MARKER,
  XV6_FIX_OBJECTIVE_PREFIX,
  XV6_LAB_CRITERION_ID,
  XV6_LAB_ID,
  XV6_LAB_OBJECTIVE_PREFIX,
  XV6_TIME_FILE,
  XV6_VERIFY_TIMEOUT_MS,
} from '../support/xv6-locks.ts'

const available = xv6TestbedPresent() && xv6ReferencePresent()
if (available) ensureXv6ToolchainOnPath()

const ROOT = 's-root'
const OPERATOR = 's-operator'
const ROOT2 = 's-root2'
const STORE = rootTaskStoreId(ROOT)
const STORE2 = rootTaskStoreId(ROOT2)
const PROPOSAL = 'p-repair-locklab'
/** The frozen failing sample: a coordinator-shaped task whose replay really re-expands the defective recipe. */
const FIX_SAMPLE = 'tf-fix-locklab'
const FIX_SAMPLE_RUN = 'r-fix-locklab-history'
/** The holdout: a second coordinator-shaped sample whose own criterion passes under both recipes. */
const HOLDOUT_SAMPLE = 'th-holdout-locks'
const HOLDOUT_RUN = 'r-holdout-locks-history'

/** The reviewer's answer: a task_definition proposal for the mis-ordered coordinating recipe. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the coordinator failed because its recipe ran the completion stage before the fix stage had written out/locks-fix.applied, and the honest completion stage refused to fabricate the completion artifacts",'
  + '"conclusion":"the xv6-lock-lab-optimization recipe lists the regression child at index 0 with no dependsOn, so it runs before the fix child at index 1; the minimal repair is regression.dependsOn [1]",'
  + '"confidence":"high","proposals":[{"targetType":"task_definition","targetId":"xv6-lock-lab-optimization",'
  + '"rationale":"adding dependsOn [1] to the regression child makes it start only after the fix child has verified"}]}\n```'

const cell = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

/** Resolved by the spec once the repaired template is applied, releasing the supervisor's turn. */
interface Cells {
  readonly applied: Promise<void>
  readonly resolveApplied: () => void
}

/** The repaired template the scripted supervisor publishes, filled in once the library is registered. */
interface World {
  repaired: TaskTemplate
}

const dirs: string[] = []
let releaseSupervisor: (() => void) | undefined
afterEach(async () => {
  releaseSupervisor?.()
  releaseSupervisor = undefined
  try {
    await disposeScriptedLoops()
  } finally {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
}, 600_000)

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xv6-lock-repair-evolution-'))
  dirs.push(dir)
  return dir
}

/** The template ref one `task_template_list` answer holds for the entry whose objective starts with `prefix`. */
function templateRefFrom(calls: readonly { sessionId: string; name: string; result?: { text: string } }[], prefix: string) {
  const listing = calls.filter(call => call.name === 'task_template_list' && call.result !== undefined).at(-1)
  const text = listing?.result?.text ?? ''
  const entries = text.startsWith('{')
    ? (JSON.parse(text) as { entries?: { kind: string; objective?: string; templateRef?: unknown }[] }).entries ?? []
    : []
  const match = entries.find(entry => entry.kind === 'template' && (entry.objective ?? '').startsWith(prefix))
  if (match?.templateRef === undefined) {
    throw new Error(`no task_template_list answer named a template whose objective starts with ${JSON.stringify(prefix)}`)
  }
  return match.templateRef
}

/** One entry that blocks until the caller's own run is handed back `active` (its batch has ended). */
function waitForActiveRun(loop: () => ScriptedLoop, sessionId: string): ScriptEntry {
  return {
    waitFor: async () => {
      const deadline = Date.now() + 120_000
      for (;;) {
        const { run } = await loop().runForSession(sessionId)
        if (run.executionPhase === 'active') return
        if (Date.now() > deadline) {
          throw new Error(`the run bound to ${sessionId} never returned active (phase ${String(run.executionPhase)})`)
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    },
  }
}

/** The scripted deployment's one model: every session branch runs the real tools from here. */
function buildScript(h: () => ScriptedLoop, cells: Cells, world: World): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, _index) => {
    const loop = h()
    const name = loop.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? ''
    if (String(sessionId) === OPERATOR) {
      return [
        { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE', note: 'the two-sided experiment fixes the frozen failure' } },
        { tool: 'evolution_apply', args: { proposalId: PROPOSAL } },
        { text: 'operator: decided and applied' },
      ]
    }
    if (String(sessionId) === ROOT) {
      return [
        { text: 'root: the shared lab defect is recorded; the supervisor owns the recipe repair' },
        { text: 'root: diagnosis noted' },
        { text: 'root: standing by' },
      ]
    }
    if (String(sessionId) === ROOT2) {
      return [
        { tool: 'task_template_list' },
        {
          tool: 'task_decompose',
          args: calls => ({
            reason: 'own the lab optimization as one coordinating child taken from the repaired template',
            children: [{ templateRef: templateRefFrom(calls, XV6_LAB_OBJECTIVE_PREFIX), decomposable: true }],
          }),
        },
        { text: 'root2: the coordinating child owns the repaired recipe' },
        waitForActiveRun(h, ROOT2),
        { tool: 'task_submit_result', args: { summary: 'the lab optimization ran under the repaired recipe' } },
        { text: 'root2: handed in' },
      ]
    }
    if (name.startsWith('supervisor for ')) {
      const diagnosisId = name.slice('supervisor for '.length)
      return [
        {
          tool: 'evolution_propose',
          args: {
            proposalId: PROPOSAL,
            level: 'L2',
            baseVersion: '1',
            targetType: 'task_definition',
            targetId: XV6_LAB_ID,
            rationale: 'the coordinator recipe binds the completion child with no dependency on the fix child',
            sourceRefs: [`diagnosis:${diagnosisId}`],
          },
        },
        {
          tool: 'evolution_candidate',
          args: {
            proposalId: PROPOSAL,
            versionSet: { [XV6_LAB_ID]: '2' },
            mutationJson: JSON.stringify({ template: world.repaired }),
          },
        },
        { tool: 'evolution_prepare', args: { proposalId: PROPOSAL } },
        { tool: 'evolution_replay', args: { proposalId: PROPOSAL, taskIds: [FIX_SAMPLE], holdoutTaskIds: [HOLDOUT_SAMPLE] } },
        {
          tool: 'evolution_gate',
          args: calls => {
            const replay = calls.filter(call => call.name === 'evolution_replay').at(-1)
            const report = /report: (\S+)/.exec(replay?.result?.text ?? '')?.[1]
            return {
              proposalId: PROPOSAL,
              targetFailureFixed: 'the frozen failing reproduction passes on the candidate library',
              originalAcceptanceMaintained: 'the fix and completion criteria and the parent oracle are unchanged',
              existingRegressionMaintained: 'the holdout reproduction passes on both libraries',
              noUnacceptableSideEffects: 'one appended template file, isolated side libraries',
              holdoutPerformanceAcceptable: 'the holdout passes on both sides',
              resourceCostAcceptable: 'recorded from the runs',
              regressionEvidenceRefs: report === undefined ? [] : [report],
            }
          },
        },
        // The same turn stays open through the apply, so the supervisor does not
        // go idle on a `gated` proposal.
        { waitFor: () => cells.applied },
        { text: 'supervisor: the repair is applied' },
      ]
    }
    if (name.startsWith('review ')) return [{ text: REVIEW_REPLY }, { text: 'review: recorded' }]
    // A replayed side: both frozen samples are coordinator-shaped, so each side
    // expands whichever recipe its frozen library holds. The spawn name is the
    // objective truncated to 40 characters, so the sample id itself is not
    // reliably readable here — the branch must not depend on it.
    if (name.startsWith('[evolution-experiment:')) {
      return [
        { tool: 'task_template_list' },
        {
          tool: 'task_decompose',
          args: calls => ({
            templateRef: templateRefFrom(calls, XV6_LAB_OBJECTIVE_PREFIX),
            templateParameters: {},
          }),
        },
        { text: 'reproduction: the recipe batch is running' },
        { tool: 'task_submit_result', args: { summary: 'the reproduction is handed in' } },
        { text: 'reproduction: handed in' },
      ]
    }
    if (name.startsWith(XV6_LAB_OBJECTIVE_PREFIX)) {
      return [
        { tool: 'task_template_list' },
        {
          tool: 'task_decompose',
          args: calls => ({
            templateRef: templateRefFrom(calls, XV6_LAB_OBJECTIVE_PREFIX),
            templateParameters: {},
          }),
        },
        { text: 'lab: the recipe batch is running' },
        waitForActiveRun(h, sessionId),
        { tool: 'task_submit_result', args: { summary: 'the lab recipe completed' } },
        { text: 'lab: handed in' },
      ]
    }
    if (name.startsWith(XV6_FIX_OBJECTIVE_PREFIX)) {
      return [
        {
          tool: 'bash',
          args: {
            command: `mkdir -p out && printf 'reference per-CPU allocator + bucketed buffer cache confirmed\\n' > ${XV6_FIX_MARKER}`,
          },
        },
        { tool: 'task_submit_result', args: { summary: 'confirmed the reference locks and wrote the fix marker' } },
        { text: 'fix: handed in' },
      ]
    }
    if (name.startsWith(XV6_COMPLETION_OBJECTIVE_PREFIX)) {
      let missing = false
      return [
        {
          // The honest leaf's FIRST act: is this run's fix marker there? The file
          // probe is the determinism the defect rests on.
          waitFor: async () => {
            const cwd = String(loop.agent(sessionId).session.header.cwd)
            missing = !existsSync(join(cwd, XV6_FIX_MARKER))
          },
        },
        {
          tool: 'bash',
          args: {
            command:
              `if test -f ${XV6_FIX_MARKER}; then echo 1 > ${XV6_TIME_FILE} && ` +
              `echo '{"complete":true}' > ${XV6_COMPLETE_MARKER}; fi`,
          },
        },
        {
          tool: 'task_submit_result',
          args: () => ({
            summary: missing
              ? `gap: ${XV6_FIX_MARKER} is missing, so no completion artifacts were written`
              : `wrote ${XV6_TIME_FILE} and ${XV6_COMPLETE_MARKER}`,
          }),
        },
        { text: 'completion: handed in' },
      ]
    }
    return [{ text: 'idle' }]
  }
}

/** A criterion in the shape a root contract / template spec takes (the runtime normalizes the rest). */
function specCriterion(criterionId: string, command: string) {
  return { criterionId, description: 'it holds', command }
}

/** A criterion in the shape the store records for a real admitted one. */
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
 * service: the historical record a task_definition experiment locates its case
 * by. `outcome` is what its latest review says — the role rule reads exactly that.
 */
async function writeSample(h: ScriptedLoop, input: {
  taskId: string
  runId: string
  objective: string
  acceptance: AcceptanceCriterion
  requiredCapabilities: string[]
  outcome: 'verified' | 'failed'
}): Promise<void> {
  const contract = {
    contractVersion: 1 as const,
    objective: input.objective,
    acceptanceCriteria: [input.acceptance],
    assumptions: [],
    constraints: [],
    requiredCapabilities: [...input.requiredCapabilities],
    templateScope: [['kernel']],
  }
  await h.task.createTaskIn(STORE, {
    taskId: input.taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: input.objective,
    depth: 0,
    acceptanceCriteria: [input.acceptance],
    requestedCapabilities: [...input.requiredCapabilities],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract,
  }, 'tester')
  await h.task.admitTaskIn(STORE, input.taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `s-${input.taskId}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, input.taskId, input.runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(STORE, {
    evidenceId: `e-${input.runId}`,
    taskRunId: input.runId,
    taskId: input.taskId,
    artifacts: [],
    verifierResults: [{
      criterionId: input.acceptance.criterionId,
      status: input.outcome === 'verified' ? 'pass' : 'fail',
      verifierId: 'command',
      exitCode: input.outcome === 'failed' ? 1 : 0,
    }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the completion stage ran before its fix and failed the honest check' } : {}),
  })
  await h.task.recordReviewIn(STORE, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [`the historical sample "${input.taskId}" locates`],
    ...(input.outcome === 'failed' ? { localizedCause: 'the coordinator recipe ran completion before fix' } : {}),
    criteria: [{ criterionId: input.acceptance.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
  }, 'tester')
}

/** The two frozen samples every case evaluates. */
async function writeSamples(h: ScriptedLoop): Promise<void> {
  await writeSample(h, {
    taskId: FIX_SAMPLE,
    runId: FIX_SAMPLE_RUN,
    objective: 'Reproduce the failing xv6 locks lab optimization work over the pre-seeded checkout',
    acceptance: criterion(
      XV6_LAB_CRITERION_ID,
      `bash -c 'test -f ${XV6_COMPLETE_MARKER} && bash checks/verify.sh all'`,
    ),
    requiredCapabilities: ['coordinate-tasks'],
    outcome: 'failed',
  })
  // The holdout is a coordinator-shaped case the candidate was not selected on:
  // it only requires the fix marker, so it passes under BOTH recipes (the fix leaf
  // always runs eventually) and guards the fix stage against the repair.
  await writeSample(h, {
    taskId: HOLDOUT_SAMPLE,
    runId: HOLDOUT_RUN,
    objective: 'Independently own the xv6 locks fix stage over the pre-seeded checkout',
    acceptance: criterion('holdout-fix-result', `bash -c 'test -f ${XV6_FIX_MARKER}'`),
    requiredCapabilities: ['coordinate-tasks'],
    outcome: 'verified',
  })
}

/** The ledger's own lines, read from disk (the append-only file, never the service's memory). */
function ledgerKinds(ledgerRoot: string): string[] {
  const file = join(ledgerRoot, 'proposals.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
    .map(line => String((JSON.parse(line) as { kind: string }).kind))
}

async function run(): Promise<void> {
  const ledgerRoot = join(scratch(), 'evolution')
  const applied = cell<void>()
  // Release the test-owned latch on failure as well as success. The adapter's
  // raceAbort also follows the turn signal; this avoids leaving its latch open.
  releaseSupervisor = applied.resolve
  const cells: Cells = { applied: applied.promise, resolveApplied: applied.resolve }
  const world: World = { repaired: undefined as unknown as TaskTemplate }
  let h!: ScriptedLoop
  h = await startScriptedLoop({
    roots: [ROOT, OPERATOR, ROOT2],
    capabilities: {
      'coordinate-tasks': { skills: ['task-coordination'] },
      'local-files': { skills: ['task-execution'], tools: ['filesystem'] },
    },
    script: (sessionId, index) => buildScript(() => h, cells, world)(sessionId, index),
    evolution: { ledgerRoot },
    // The evolution asks are held for the spec to answer: the person's two gates.
    approvalAnswer: ask => (ask.toolName.startsWith('evolution_') ? undefined : 'allowed-once'),
    verifyTimeoutMs: XV6_VERIFY_TIMEOUT_MS,
    tools: xv6CheckoutTools(),
  })
  // The lab the experiment freezes as its input snapshot: pristine, seeded with the
  // reference locks, and with every leftover marker removed so no replayed side can
  // eat a stale success.
  prepareXv6Checkout(h.checkout)
  seedReferenceLockFix(h.checkout)
  resetLockLab(h.checkout)
  const library = await registerXv6RepairLibrary(h.runtime, { distractors: 30 })
  world.repaired = repairedLockLabTemplate({ fix: library.fix, regression: library.regression })

  const root = await h.begin({
    objective:
      'Own the xv6 locks lab optimization and its fix/completion recipe over the pre-seeded reference checkout, and ' +
      'drive the recipe to a full grade through its coordinating child.',
    acceptanceCriteria: [specCriterion('root-goal', `bash -c 'test -f ${XV6_COMPLETE_MARKER}'`)],
    requiredCapabilities: ['coordinate-tasks'],
    templateScope: [['kernel']],
    constraints: [],
  })

  // ── the frozen samples the experiment will evaluate ──────────────────────
  await writeSamples(h)

  // ── the review produces the diagnosis and delivers it to the owner ───────
  const scan = await scanFailedReviewSources(h.ctx, STORE, {
    source: { taskId: FIX_SAMPLE, runId: FIX_SAMPLE_RUN },
  })
  expect(scan.entries[0]?.result).toBe('started')
  const diagnosis = await vi.waitFor(async () => {
    const found = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === FIX_SAMPLE)
    expect(found, JSON.stringify(scan.entries)).toBeDefined()
    return found!
  }, { timeout: 60_000, interval: 25 })
  expect(diagnosis.proposals.map(proposal => [proposal.targetType, proposal.targetId])).toEqual([
    ['task_definition', XV6_LAB_ID],
  ])
  // ── the scripted supervisor runs the whole evolution chain ───────────────
  await vi.waitFor(() => {
    const spawn = h.spawns.find(candidate => candidate.name.startsWith('supervisor for '))
    expect(spawn, JSON.stringify(h.spawns.map(candidate => candidate.name))).toBeDefined()
    return spawn!
  }, { timeout: 60_000, interval: 25 })
  await vi.waitFor(async () => {
    const view = await h.ctx.evolution.get(PROPOSAL).catch(() => undefined)
    expect(view?.proposalId, JSON.stringify(h.calls.filter(call => call.name.startsWith('evolution_')).map(call => [call.name, call.result?.isError, call.result?.text?.slice(0, 300)]))).toBe(PROPOSAL)
    return view!
  }, { timeout: 60_000, interval: 25 })
  const gated = await vi.waitFor(async () => {
    const proposal = await h.ctx.evolution.get(PROPOSAL)
    expect(proposal.status, JSON.stringify(h.calls.filter(call => call.name.startsWith('evolution_')).map(call => [call.name, call.result?.text?.slice(0, 200)]))).toBe('gated')
    return proposal
  }, { timeout: 1_200_000, interval: 250 })
  expect(gated.targetType).toBe('task_definition')
  expect(gated.targetId).toBe(XV6_LAB_ID)
  const [experiment] = await h.ctx.evolution.experiments(PROPOSAL)
  const report = buildExperimentReport(experiment!)
  expect(report.verdict).toBe('fixed')
  const fixSample = report.samples.find(sample => sample.taskId === FIX_SAMPLE)!
  expect(fixSample.role).toBe('observed-failure')
  expect(fixSample.baseline.outcome).toBe('failed')
  expect(fixSample.candidate.outcome).toBe('verified')
  const holdout = report.samples.find(sample => sample.taskId === HOLDOUT_SAMPLE)!
  expect(holdout.role).toBe('holdout')
  expect([holdout.baseline.outcome, holdout.candidate.outcome]).toEqual(['verified', 'verified'])

  // ── the honest gap leaf failed the real checker on the defective recipe ──
  const expId = report.experimentId
  const baselinePrefix = `[evolution-experiment:${expId}:${FIX_SAMPLE}:baseline] `
  const candidatePrefix = `[evolution-experiment:${expId}:${FIX_SAMPLE}:candidate] `
  const replayFinal = await h.snapshot(STORE)
  const baselineParent = replayFinal.tasks.find(task => task.objective.startsWith(baselinePrefix))
  const candidateParent = replayFinal.tasks.find(task => task.objective.startsWith(candidatePrefix))
  expect(baselineParent, `no replayed baseline task with objective ${JSON.stringify(baselinePrefix)}`).toBeDefined()
  expect(candidateParent).toBeDefined()
  const gapLeaf = replayFinal.tasks.find(
    task => task.parentTaskId === baselineParent!.taskId && task.templateRef?.id === XV6_COMPLETION_LEAF_ID,
  )
  const completionLeaf = replayFinal.tasks.find(
    task => task.parentTaskId === candidateParent!.taskId && task.templateRef?.id === XV6_COMPLETION_LEAF_ID,
  )
  expect(gapLeaf, 'the baseline replay admitted no completion child').toBeDefined()
  expect(completionLeaf, 'the candidate replay admitted no completion child').toBeDefined()
  expect(gapLeaf!.status).toBe('failed')
  expect(completionLeaf!.status).toBe('verified')
  const gapRun = replayFinal.runs.filter(item => item.taskId === gapLeaf!.taskId).at(-1)!
  const gapVerdict = replayFinal.evidence
    .filter(item => item.taskRunId === gapRun.runId)
    .flatMap(item => item.verifierResults)
    .find(item => item.criterionId === XV6_COMPLETION_CRITERION_ID)!
  expect(gapVerdict.verifierId).toBe('command')
  expect(gapVerdict.status).toBe('fail')
  expect(gapVerdict.exitCode).not.toBe(0)
  expect(gapRun.submission?.summary ?? '').toContain(XV6_FIX_MARKER)
  // The fix child really ran its own grader in the baseline side as well; only the
  // completion child's honest gap made the sample fail.
  const baselineFixLeaf = replayFinal.tasks.find(
    task => task.parentTaskId === baselineParent!.taskId && task.templateRef?.id === XV6_FIX_LEAF_ID,
  )!
  expect(baselineFixLeaf.status).toBe('verified')

  // ── a person decides and applies through the real seam ───────────────────
  h.userSays('decide and apply the repair', OPERATOR)
  await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_decide')).toBe(true), { timeout: 60_000, interval: 25 })
  h.review.answer(h.review.asks.findIndex(ask => ask.toolName === 'evolution_decide'), 'allowed-once')
  await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true), { timeout: 60_000, interval: 25 })
  h.review.answer(h.review.asks.findIndex(ask => ask.toolName === 'evolution_apply'), 'allowed-once')
  await vi.waitFor(async () => expect((await h.ctx.evolution.get(PROPOSAL)).status).toBe('applied'), { timeout: 120_000, interval: 25 })

  // ── the published library gained v2 and kept the defective v1 ────────────
  const templateLibrary = h.runtime.config.taskTemplatesRoot!
  const v1 = JSON.parse(readFileSync(join(templateLibrary, `${XV6_LAB_ID}@1.json`), 'utf8')) as {
    version: number
    contract: { acceptanceCriteria: unknown }
    decomposition: { children: { templateRef: { id: string }; dependsOn?: number[] }[] }
  }
  const v2 = JSON.parse(readFileSync(join(templateLibrary, `${XV6_LAB_ID}@2.json`), 'utf8')) as typeof v1
  const childIds = (template: typeof v1) => template.decomposition.children.map(child => child.templateRef.id)
  const childDeps = (template: typeof v1) => template.decomposition.children.map(child => child.dependsOn ?? [])
  expect(childIds(v1)).toEqual([XV6_COMPLETION_LEAF_ID, XV6_FIX_LEAF_ID])
  expect(childDeps(v1)).toEqual([[], []])
  expect(v1.version).toBe(1)
  expect(childIds(v2)).toEqual([XV6_COMPLETION_LEAF_ID, XV6_FIX_LEAF_ID])
  expect(childDeps(v2)).toEqual([[1], []])
  expect(v2.version).toBe(2)
  const publishedRecipeHasNonEmptyDependsOn = childDeps(v2).some(deps => deps.length > 0)
  expect(publishedRecipeHasNonEmptyDependsOn).toBe(true)
  expect(v1.contract.acceptanceCriteria).toEqual(v2.contract.acceptanceCriteria)
  const publishedEqualsFrozenCandidate =
    JSON.stringify(v2) === JSON.stringify(JSON.parse(readFileSync(
      join(ledgerRoot, 'sandbox', PROPOSAL, 'task-templates', 'candidate', `${XV6_LAB_ID}@2.json`), 'utf8')))
  expect(publishedEqualsFrozenCandidate).toBe(true)
  const kinds = ledgerKinds(ledgerRoot)
  const expectedSequence = ['proposed', 'candidate', 'prepared', 'experiment_started', 'gated', 'decided', 'commit_intent', 'applied']
  let cursor = 0
  for (const kind of kinds) if (kind === expectedSequence[cursor]) cursor += 1
  const ledgerWalkedProposedToApplied = cursor === expectedSequence.length
  expect(ledgerWalkedProposedToApplied).toBe(true)
  // Two samples (the observed failure and the holdout), each evaluated on both sides.
  expect(kinds.filter(kind => kind === 'experiment_sample')).toHaveLength(4)

  // ── a second root run consumes the repaired v2 recipe and its edge ───────
  cells.resolveApplied()
  // The first root run still holds the shared env, so the second root runs in its
  // own copy of the same checkout (pristine lab + reference locks, no markers).
  const checkout2 = join(h.workspace, 'env2')
  prepareXv6Checkout(checkout2)
  seedReferenceLockFix(checkout2)
  resetLockLab(checkout2)
  h.runtime.sessionWorkspaces.set(ROOT2, checkout2)
  h.recordRequest(
    'Own the xv6 locks lab optimization for the pre-seeded checkout through one coordinating child bound to the repaired template.',
    ROOT2,
  )
  const intake = await h.runtime.intakeRootContract(STORE2, ROOT2, {
    objective:
      'Own the xv6 locks lab optimization for the pre-seeded checkout through one coordinating child bound to the ' +
      'repaired xv6-lock-lab-optimization template (do not enumerate the fix/completion leaves at your own level).',
    acceptanceCriteria: [specCriterion('root-goal', `bash -c 'test -f ${XV6_COMPLETE_MARKER}'`)],
    requiredCapabilities: ['coordinate-tasks'],
    templateScope: [['kernel']],
    constraints: [],
  })
  expect(intake.status).toBe('activated')
  h.userSays('begin', ROOT2)
  await vi.waitFor(async () => {
    const snapshot = await h.snapshot(STORE2)
    expect(
      snapshot.tasks.find(task => task.taskId === intake.taskId)?.status,
      JSON.stringify(snapshot.tasks.map(task => [task.templateRef?.id, task.templateRef?.version, task.status])),
    ).toBe('verified')
  }, { timeout: 1_200_000, interval: 500 })

  const run2 = await h.snapshot(STORE2)
  const run2Lab = run2.tasks.find(task => task.templateRef?.id === XV6_LAB_ID)!
  expect(run2Lab.templateRef?.version).toBe(2)
  expect(run2Lab.status).toBe('verified')
  const run2Recipe = run2.proposals.all.find(item => item.kind !== 'root' &&
    item.identity.parentTaskId === run2Lab.taskId && item.status === 'admitted')!
  if (run2Recipe.kind === 'root' || run2Recipe.consumption?.kind === 'root') throw new Error('expected a recipe batch')
  expect(run2Recipe.identity.templateRef?.version).toBe(2)
  const run2ChildIds = run2Recipe.consumption.childTaskIds
  const admittedDeps = run2Recipe.batch.map(child => [...child.dependsOn])
  expect(admittedDeps).toEqual(childDeps(v2))
  const run2ConsumesNonEmptyEdges = admittedDeps.some(deps => deps.length > 0)
  expect(run2ConsumesNonEmptyEdges).toBe(true)
  const run2Edges = run2Recipe.batch.flatMap((child, index) =>
    child.dependsOn.map(from => ({ from: run2ChildIds[from], to: run2ChildIds[index] })))
  expect(run2.edges.filter(edge => run2ChildIds.includes(edge.from) && run2ChildIds.includes(edge.to))).toEqual(run2Edges)
  // The repaired order really reached the runtime: the fix child starts and verifies
  // before the completion child, whose own criterion then passes.
  const run2Fix = run2.tasks.find(task => task.parentTaskId === run2Lab.taskId && task.templateRef?.id === XV6_FIX_LEAF_ID)!
  const run2Completion = run2.tasks.find(task => task.parentTaskId === run2Lab.taskId && task.templateRef?.id === XV6_COMPLETION_LEAF_ID)!
  expect([run2Fix.status, run2Completion.status]).toEqual(['verified', 'verified'])
  expect(existsSync(join(checkout2, XV6_COMPLETE_MARKER))).toBe(true)
  expect(existsSync(join(checkout2, XV6_TIME_FILE))).toBe(true)

  // ── history is frozen and the defect stayed visible ──────────────────────
  const final = await h.snapshot(STORE)
  expect(final.tasks.find(task => task.taskId === root.taskId)).toBeDefined()
  expect(final.tasks.find(task => task.taskId === FIX_SAMPLE)?.status).toBe('failed')
  expect(final.tasks.find(task => task.taskId === FIX_SAMPLE)?.templateRef).toBeUndefined()
}

it.skipIf(!available)(
  'repairs a mis-ordered xv6 locks recipe through the scripted supervisor and runs the non-empty edge on the second root run',
  async () => {
    await run()
  },
  2_700_000,
)

/**
 * A6 interface ⑤, first half: the **whole capability chain** on one deployment,
 * from a real failing source to a recovered attempt that really uses the promoted
 * capability (plan §F.4, EVO-3).
 *
 * Every previous A6 spec proves one seam against its neighbour (the candidate
 * rules, the evidence gate, the recovery entry, the hand-off consumption). This
 * one runs the seams *in series*, on the real deployment, with the real model
 * loop, the real store, the real runtime, the real evolution plane and the real
 * tools — the only thing replaced is the model itself (a script, as every spec
 * built on `scripted-loop` does). The chain it walks:
 *
 * 1. the root's goal fails its own map over a member that fails;
 * 2. the root asks `task_review_agent` for that exact source, the reviewer runs
 *    for real and records a Diagnosis carrying a capability suggestion;
 * 3. the consumption takes the hand-off up and the **supervisor** starts — and
 *    then does the coordinating work itself, through its own tool calls:
 *    `evolution_propose` → `evolution_candidate` → `evolution_prepare` →
 *    `evolution_replay` (the two-sided experiment: the baseline refused at
 *    admission, the candidate really executed and judged) → `evolution_gate`;
 * 4. **a person** decides and applies, through the deployment's real
 *    `evolution_decide`/`evolution_apply` tools and the real approval seam (two
 *    held asks, both answered here) — the supervisor's own grant carries neither,
 *    which is why the operator session is the one that calls them;
 * 5. the supervisor calls `task_recover`, the runtime opens the failed goal's new
 *    attempt, and the attempt's member **requires the row the promotion just
 *    applied** — so the batch is admissible only because the capability is really
 *    in force — and the original acceptance criteria judge the result;
 * 6. the old failure is still readable, exactly as it was.
 *
 * The refusals are here too, each with the side effect it must not have: before
 * the apply, the recovery is refused by name with no run opened (asked of the
 * direct service entry, below the tool); while the attempt is in flight, another
 * key is refused by name; and a **successful** source's "faster or cheaper"
 * suggestion stays a readable record — named as unsupported for lack of a frozen
 * comparator — with no promotion, no application and no new run.
 *
 * `task_recover`'s schema is asserted to be exactly the two fields the plan
 * fixes: an adapter that quietly grew a field would be a second way to carry an
 * authorization, and the plan says the request carries none.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readReviewAgentAttempts, readSupervisorHandoff } from '../../agent-singularity/src/review-agent-ledger.ts'
import { consumePendingHandoffs } from '../../agent-singularity/src/evolution-handoff.ts'
import { buildReviewPack } from '../../agent-singularity/src/tools/task-review-pack.ts'
import { defineTaskRecoverTool } from '../../agent-singularity/src/tools/task-recover.ts'
import { buildExperimentReport } from '../../evolution/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { AcceptanceCriterion, TaskRun } from '../../task/src/index.ts'
import { writeCapabilityConfig } from '../support/capability-config.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId
/** The deployment's operator session: a live root whose model puts the person's two questions. */
const OPERATOR = 's-operator' as SessionId
const STORE = rootTaskStoreId(String(ROOT))
const PROPOSAL = 'p-chain'
/** The row the promotion installs, the samples require and the recovered attempt's member needs. */
const ROW = 'a6-chain-row'
const SKILL = 'a6-chain-skill'
/** The evidence file the candidate skill's body tells its worker to write. */
const ANSWER = 'chain-fixed.txt'
/** The row (and skill) production already holds, so the new row's tool labels are inside the authorized plane. */
const STORE_ROW = 'a6-chain-store-row'
const STORE_SKILL = 'a6-chain-store-skill'
const STORE_ENTRY = { skills: [STORE_SKILL], tools: ['filesystem'] }

/** The two samples the experiment evaluates: the historical failure the candidate fixes, and a holdout. */
const FIX_SAMPLE = 't-chain-fix'
const HOLDOUT_SAMPLE = 't-chain-holdout'

const ROOT_CONTRACT = {
  objective: 'ship the release',
  acceptanceCriteria: [
    { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
    {
      criterionId: 'root-map',
      description: 'the member the map names passed',
      mode: 'composite',
      mandatory: true,
      childEvidence: [{ childIndex: 0, criterionId: 'member-0' }],
    },
  ],
}

/** The reviewer's answer: a diagnosis about the failed source, carrying one capability suggestion. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the member failed its own criterion","conclusion":"the deployment grants no capability for the member",'
  + '"confidence":"high","proposals":[{"targetType":"capability","targetId":"' + ROW + '",'
  + '"rationale":"granting the member this row is what closes the gap"}]}\n```'

/** The reviewer's answer for a source that *succeeded*: the optimization suggestion this build cannot evaluate. */
const OPTIMIZE_REPLY = '```json\n'
  + '{"observation":"the member passed","conclusion":"the member could be made faster and cheaper",'
  + '"confidence":"medium","proposals":[{"targetType":"capability","targetId":"a6-chain-faster-row",'
  + '"rationale":"a leaner capability would make this case faster and cheaper"}]}\n```'

function skillText(body: string): string {
  return `---\nname: ${SKILL}\ndescription: A6 chain fixture skill\n---\n\n${body}\n`
}

const CANDIDATE_TEXT = skillText(`WRITE:${ANSWER}`)

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The new skill's execution declaration: the row grants it and the registered `command` verifier judges it. */
function sidecar(content: string): unknown {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: [ROW],
    precondition: 'the fixture gap is present',
    inputs: [],
    outputs: [],
    requiredTools: ['read', 'write'],
    verifier: { ref: 'command' },
    content: { skillMdSha256: sha256Hex(content), resources: [] },
  }
}

/** One command-settled criterion, as the samples and the attempt's members carry it. */
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

/** The facts a case's script reads that only exist once the run is under way. */
interface Cells {
  rootTaskId?: string
  rootRunId?: string
  diagnosisId?: string
  /** The latch the root's own turn waits on so the batch (and the samples) are ready before it hands its result in. */
  readonly batchDone: Promise<void>
  readonly resolveBatch: () => void
  /** The latch the supervisor waits on between preparing the evidence and asking for the recovery. */
  readonly decided: Promise<void>
  readonly resolveDecided: () => void
  /** The latch the recovered attempt waits on before it hands its result in. */
  readonly attemptSubmit: Promise<void>
  readonly resolveAttemptSubmit: () => void
}

const dirs: string[] = []

beforeEach(() => {
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  // Reviewer + supervisor: the same per-store allowance the A5 chain spends,
  // named here so this chain does not stop on it.
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '4')
})

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A directory of this case's own: the evolution ledger and the deployment's `config.yml` live in it. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'a6-chain-'))
  dirs.push(dir)
  return dir
}

async function runOf(h: ScriptedLoop, runId: string): Promise<TaskRun> {
  return (await h.snapshot(STORE)).runs.find(run => run.runId === runId)!
}

/** One criterion's verdicts on one run, as the store recorded them. */
async function verdict(h: ScriptedLoop, runId: string, criterionId: string) {
  return (await h.snapshot(STORE)).evidence
    .filter(item => item.taskRunId === runId)
    .flatMap(item => item.verifierResults)
    .find(item => item.criterionId === criterionId)
}

/** The members of one run, read from the store's own accumulation. */
async function membersOf(h: ScriptedLoop, runId: string): Promise<string[]> {
  return (await h.task.runMembersIn(STORE, runId)).map(task => task.taskId)
}

/** Write one terminal sample straight into the store through the store's own service. */
async function writeSample(h: ScriptedLoop, input: {
  taskId: string
  runId: string
  objective: string
  acceptance: AcceptanceCriterion
  outcome: 'verified' | 'failed'
}): Promise<void> {
  await h.task.createTaskIn(STORE, {
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
    // A sample is a task of its own (parentless), carrying its contract: the
    // replay binds the experiment's run to the champion's own contract.
    contract: {
      contractVersion: 1,
      objective: input.objective,
      acceptanceCriteria: [input.acceptance],
      assumptions: [],
      constraints: [],
      requiredCapabilities: [ROW],
    },
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
    verifierResults: [{ criterionId: input.acceptance.criterionId, status: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the capability could not run this case at all' } : {}),
  })
  await h.task.recordReviewIn(STORE, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [],
    ...(input.outcome === 'failed' ? { localizedCause: 'no provider could run this case' } : {}),
    criteria: [{ criterionId: input.acceptance.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
  }, 'tester')
}

/** The two samples every running case evaluates: the failed case the candidate fixes and a holdout. */
async function writeSamples(h: ScriptedLoop): Promise<void> {
  await writeSample(h, {
    taskId: FIX_SAMPLE,
    runId: `r-${FIX_SAMPLE}-history`,
    objective: `the case needs the ${ROW} capability`,
    acceptance: criterion('ac-chain-fix', `test -f ${ANSWER}`),
    outcome: 'failed',
  })
  await writeSample(h, {
    taskId: HOLDOUT_SAMPLE,
    runId: `r-${HOLDOUT_SAMPLE}-history`,
    objective: 'a held-out case the candidate must not break',
    acceptance: criterion('ac-chain-holdout', `test -f ${ANSWER}`),
    outcome: 'verified',
  })
}

/** What the case's script needs besides the sessions themselves. */
interface ScriptContext {
  readonly h: () => ScriptedLoop
  readonly cells: Cells
  readonly ledgerRoot: string
  readonly memberFails: boolean
  readonly review: string
  /** The successful-source case: the coordinator only asks for the recovery, which is refused. */
  readonly optimize: boolean
}

/**
 * The model every session in this chain is: the root that fails and asks for the
 * postmortem, the member, the reviewer, the supervisor that prepares the whole
 * candidate through its own tools and then asks for the recovery, the operator
 * that puts the person's two decisions, the experiment's worker (which does what
 * the skill it loaded says), and the recovered attempt, which re-runs the failed
 * position against the capability that was just applied.
 */
function script(context: ScriptContext): (sessionId: string, index: number) => readonly ScriptEntry[] {
  const { h, cells } = context
  return (sessionId, index) => {
    const loop = h()
    const spawn = loop.spawns.find(item => String(item.sessionId) === sessionId)
    const name = spawn?.name ?? ''
    if (String(sessionId) === String(OPERATOR)) {
      // The person's two gates, through the deployment's own tools: each asks the
      // human (the spec answers the ask) and records the approval reference the
      // runtime and this plane read.
      return [
        { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE', note: 'the two-sided evidence holds' } },
        { tool: 'evolution_apply', args: { proposalId: PROPOSAL } },
        { text: 'operator: decided and applied' },
      ]
    }
    if (name.startsWith('supervisor for')) {
      const diagnosisId = name.slice('supervisor for '.length)
      if (context.optimize) {
        // A hand-off whose source succeeded: the coordinator studies the
        // suggestion and asks for a recovery, which this build refuses by name.
        return [
          { tool: 'task_recover', args: { sourceDiagnosisId: diagnosisId, requestKey: 'k-optimize' } },
          { text: 'supervisor: the suggestion stays a record' },
        ]
      }
      return [
        {
          tool: 'evolution_propose',
          args: {
            proposalId: PROPOSAL,
            level: 'L2',
            baseVersion: 'v1',
            targetType: 'capability',
            targetId: ROW,
            rationale: 'the member needs the capability the deployment does not grant',
            sourceRefs: [`diagnosis:${diagnosisId}`],
          },
        },
        {
          tool: 'evolution_candidate',
          args: {
            proposalId: PROPOSAL,
            versionSet: { capabilityTable: 'config.yml#doc' },
            mutation: {
              rows: { [ROW]: { skills: [SKILL], tools: ['filesystem'] } },
              skill: { name: SKILL, content: CANDIDATE_TEXT, sidecar: sidecar(CANDIDATE_TEXT) },
            },
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
              targetFailureFixed: 'the refused baseline is fixed by the candidate run',
              originalAcceptanceMaintained: 'the acceptance identity is unchanged',
              existingRegressionMaintained: 'the holdout still passes on the candidate',
              noUnacceptableSideEffects: 'one row and one new skill directory',
              holdoutPerformanceAcceptable: 'the held-out case still passes',
              resourceCostAcceptable: 'recorded from the runs, not inferred',
              regressionEvidenceRefs: report === undefined ? [] : [report],
            }
          },
        },
        // The person's decision is what releases the recovery: the capability the
        // hand-off depends on has to be in force before the attempt is asked for.
        // The latch is read in this same turn (no text ends it in between): the
        // coordinator waits on its request, and the spec answers it once the
        // apply has committed.
        { waitFor: () => cells.decided },
        { tool: 'task_recover', args: { sourceDiagnosisId: diagnosisId, requestKey: 'k-chain' } },
        { text: 'supervisor: the attempt is open' },
      ]
    }
    if (name.startsWith('review ')) return [{ text: context.review }]
    if (name.startsWith('recovery of')) {
      // The attempt re-runs the failed position: its member needs the row the
      // promotion just applied, so the batch is admissible only because the
      // capability is really in force.
      return [
        {
          tool: 'task_decompose',
          args: {
            reason: 're-run the failed position against the applied capability',
            children: [{
              objective: 'the member, again',
              requiredCapabilities: [ROW],
              acceptanceCriteria: [{ criterionId: 'member-0', description: 'it holds', command: 'true' }],
            }],
          },
        },
        { text: 'attempt: the replacement is running' },
        { waitFor: () => cells.attemptSubmit },
        { tool: 'task_submit_result', args: { summary: 'the attempt is handed in' } },
        { text: 'attempt: handed in' },
      ]
    }
    if (name.startsWith('[evolution-experiment:')) {
      // The experiment's worker **is** this deployment's model: it does what the
      // skill its spawn loaded says, reading the same bytes from the sandbox the
      // candidate prepared (the fixture plays the worker, never the runtime).
      const file = sandboxAnswerFile(context.ledgerRoot)
      if (file !== undefined) {
        const cwd = String(loop.agent(sessionId).session.header.cwd)
        writeFileSync(join(cwd, file), `${file}\n`)
      }
      return [
        { tool: 'task_submit_result', args: { summary: 'the candidate side is done' } },
        { text: 'candidate: handed in' },
      ]
    }
    if (index === 0) {
      return [
        {
          tool: 'task_decompose',
          args: {
            reason: 'split the work',
            children: [{
              objective: 'the member that needs the capability',
              acceptanceCriteria: [{ criterionId: 'member-0', description: 'it holds', command: context.memberFails ? 'false' : 'true' }],
            }],
          },
        },
        { text: 'root: the batch is running' },
        { waitFor: () => cells.batchDone },
        { tool: 'task_submit_result', args: { summary: 'root: handed in' } },
        { text: 'root: handed in' },
        { tool: 'task_review_agent', args: { taskId: cells.rootTaskId!, runId: cells.rootRunId!, reason: 'what happened in that run?' } },
        { text: 'root: asked for the postmortem' },
      ]
    }
    return [
      { tool: 'task_submit_result', args: { summary: 'member: handed in' } },
      { text: 'member: handed in' },
    ]
  }
}

/** The file the prepared skill's body tells its worker to write, read from the sandbox the candidate materialized. */
function sandboxAnswerFile(ledgerRoot: string): string | undefined {
  try {
    const text = readFileSync(join(ledgerRoot, 'sandbox', PROPOSAL, 'skills', SKILL, 'SKILL.md'), 'utf8')
    return /WRITE:(\S+)/.exec(text)?.[1]
  } catch {
    return undefined
  }
}

async function startCase(options: { memberFails?: boolean; review?: string; optimize?: boolean } = {}): Promise<{ h: ScriptedLoop; cells: Cells; ledgerRoot: string; configFile: string }> {
  const batchDone = Promise.withResolvers<void>()
  const decided = Promise.withResolvers<void>()
  const attemptSubmit = Promise.withResolvers<void>()
  const cells: Cells = {
    batchDone: batchDone.promise,
    resolveBatch: batchDone.resolve,
    decided: decided.promise,
    resolveDecided: decided.resolve,
    attemptSubmit: attemptSubmit.promise,
    resolveAttemptSubmit: attemptSubmit.resolve,
  }
  const dir = scratch()
  const ledgerRoot = join(dir, 'evolution')
  const configFile = await writeCapabilityConfig(join(dir, 'config.yml'), { [STORE_ROW]: STORE_ENTRY })
  let h!: ScriptedLoop
  const context: ScriptContext = {
    h: () => h,
    cells,
    ledgerRoot,
    memberFails: options.memberFails ?? true,
    review: options.review ?? REVIEW_REPLY,
    optimize: options.optimize ?? false,
  }
  h = await startScriptedLoop({
    roots: [String(ROOT), String(OPERATOR)],
    capabilities: { [STORE_ROW]: STORE_ENTRY },
    script: script(context),
    evolution: { ledgerRoot, capabilityConfig: configFile },
  })
  // The production skill: a loadable object the deployment already grants under
  // its own row — the plane the new row's declarations are judged against.
  mkdirSync(join(h.home, 'skills', STORE_SKILL), { recursive: true })
  writeFileSync(join(h.home, 'skills', STORE_SKILL, 'SKILL.md'), `---\nname: ${STORE_SKILL}\ndescription: fixture production skill\n---\n\nnothing to do\n`)
  return { h, cells, ledgerRoot, configFile }
}

/** Drive the root's own failure and the review this case's chain starts from. */
async function failRoot(h: ScriptedLoop, cells: Cells, memberFails: boolean): Promise<void> {
  const root = await h.begin(ROOT_CONTRACT)
  cells.rootTaskId = root.taskId
  cells.rootRunId = root.runId
  const member = await vi.waitFor(async () => {
    const found = (await h.snapshot(STORE)).tasks.find(task => task.parentTaskId === root.taskId)
    expect(found).toBeDefined()
    return found!
  }, { timeout: 30_000, interval: 25 })
  const batchId = (await runOf(h, root.runId)).batchId!
  await h.runtime.awaitBatch(STORE, batchId)
  expect((await h.task.taskIn(STORE, member.taskId)).status).toBe(memberFails ? 'failed' : 'verified')
  await writeSamples(h)
  cells.resolveBatch()
  await vi.waitFor(async () => {
    expect((await h.snapshot(STORE)).reviews.some(review => review.taskId === root.taskId && review.outcome === (memberFails ? 'failed' : 'verified'))).toBe(true)
  }, { timeout: 30_000, interval: 25 })
  h.userSays('what happened in that run?', ROOT)
  const diagnosisId = await vi.waitFor(async () => {
    const found = (await h.snapshot(STORE)).diagnoses.find(diagnosis => diagnosis.taskId === root.taskId)
    expect(found).toBeDefined()
    return found!.diagnosisId
  }, { timeout: 30_000, interval: 25 })
  cells.diagnosisId = diagnosisId
}

/** Wait for the supervisor's spawn (its name is the hand-off it was delegated for) and answer with its session. */
async function supervisorSession(h: ScriptedLoop, diagnosisId: string): Promise<string> {
  await vi.waitFor(
    () => expect(h.spawns.filter(spawn => spawn.name === `supervisor for ${diagnosisId}`)).toHaveLength(1),
    { timeout: 30_000, interval: 25 },
  )
  return String(h.spawns.find(spawn => spawn.name === `supervisor for ${diagnosisId}`)!.sessionId)
}

describe('A6 EVO-3: the capability chain, from the failing source to the recovered attempt', () => {
  it('prepares the candidate through the supervisor, promotes it with a person, and recovers the goal against the applied row', async () => {
    const { h, cells, configFile } = await startCase()
    await failRoot(h, cells, true)
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === cells.rootTaskId!)!
    expect(diagnosis.proposals).toHaveLength(1)

    // ── the hand-off, and the coordinator's own candidate chain ──────────────
    await consumePendingHandoffs(h.ctx, STORE)
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)
    expect(await readSupervisorHandoff(STORE, diagnosis.diagnosisId)).toMatchObject({ sessionId: supervisor })
    const gated = await vi.waitFor(async () => {
      const proposal = await h.ctx.evolution.get(PROPOSAL)
      expect(proposal.status).toBe('gated')
      return proposal
    }, { timeout: 60_000, interval: 25 })
    expect(gated.targetType).toBe('capability')
    // The experiment the supervisor really ran: the production configuration
    // refused the baseline at admission (no Run, no champion) and the candidate
    // executed and passed the frozen judge.
    const [experiment] = await h.ctx.evolution.experiments(PROPOSAL)
    const report = buildExperimentReport(experiment!)
    expect(report.verdict).toBe('fixed')
    const fix = report.samples.find(sample => sample.taskId === FIX_SAMPLE)!
    expect(fix.baseline.outcome).toBe('not-admitted')
    expect(fix.baseline.admission).toMatchObject({ source: 'capability-gap', required: [ROW], missing: [ROW] })
    expect(fix.candidate.outcome).toBe('verified')

    // ── the capability is not in force yet: refused by name, nothing opened ──
    const runsBeforeApply = (await h.snapshot(STORE)).runs.length
    const notApplied = await h.ctx.evolution
      .coordinateRecovery({ sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-chain' }, { sessionId: supervisor })
      .then(() => '', error => String(error))
    expect(notApplied).toContain('capability change this hand-off depends on')
    expect(notApplied).toContain('is gated')
    expect(notApplied).toContain('is opened only after a person approves it and the apply commits it')
    expect((await h.snapshot(STORE)).runs).toHaveLength(runsBeforeApply)

    // ── a person decides and applies, through the deployment's own tools ─────
    h.userSays('the candidate is ready: decide it and apply it', OPERATOR)
    await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_decide')).toBe(true), { timeout: 60_000, interval: 25 })
    // The decide ask is a held question until a person answers it — two gates,
    // the decision and the apply, and the ask names the promotion.
    const decideAsk = h.review.asks.findIndex(ask => ask.toolName === 'evolution_decide')
    expect(h.review.asks[decideAsk]!.reason).toContain(`proposal ${PROPOSAL}`)
    expect(h.review.asks[decideAsk]!.reason).toContain(ROW)
    h.review.answer(decideAsk, 'allowed-once')
    await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true), { timeout: 60_000, interval: 25 })
    h.review.answer(h.review.asks.findIndex(ask => ask.toolName === 'evolution_apply'), 'allowed-once')
    await vi.waitFor(async () => expect((await h.ctx.evolution.get(PROPOSAL)).status).toBe('applied'), { timeout: 60_000, interval: 25 })
    expect(h.runtime.listCapabilities()[ROW]).toEqual({ skills: [SKILL], tools: ['filesystem'] })
    const config = await readFile(configFile, 'utf8')
    expect(config).toContain(`"${ROW}": {"skills":["${SKILL}"],"tools":["filesystem"]}`)
    expect(config).toContain(`${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }`)

    // ── the supervisor asks for the recovery; the runtime opens the attempt ──
    cells.resolveDecided()
    const attempt = await vi.waitFor(async () => {
      const found = (await h.snapshot(STORE)).runs.find(run => run.taskId === cells.rootTaskId! && run.recovery !== undefined)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 60_000, interval: 25 })
    expect(attempt.recovery).toMatchObject({ sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-chain' })
    const answer = h.calls.find(call => call.name === 'task_recover' && call.result !== undefined)!.result
    expect(answer?.isError).toBe(false)
    expect(answer?.text).toContain('a new attempt was opened')
    expect(answer?.text).toContain(`supervisor ${supervisor}`)

    // ── the in-flight exclusion, below the tool too: a second key opens nothing ─
    const runsBeforeSecondKey = (await h.snapshot(STORE)).runs.length
    const inFlight = await h.ctx.evolution
      .coordinateRecovery({ sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-other' }, { sessionId: supervisor })
      .then(() => '', error => String(error))
    // The attempt is live, so the second key is refused by name instead of
    // hot-swapping or doubling it — and the same key is answered from the record
    // the runtime wrote, never re-decided.
    expect(inFlight).toContain('is running')
    expect(inFlight).toContain('never hot-swaps a live run')
    expect((await h.snapshot(STORE)).runs).toHaveLength(runsBeforeSecondKey)
    const sameKey = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-chain' },
      { sessionId: supervisor },
    )
    expect(sameKey.attempt).toBe('existing')
    expect(sameKey.runId).toBe(attempt.runId)
    expect((await h.snapshot(STORE)).runs).toHaveLength(runsBeforeSecondKey)

    // ── the attempt's member needs the row the promotion applied ─────────────
    await vi.waitFor(async () => expect((await runOf(h, attempt.runId)).batchId).toBeDefined(), { timeout: 60_000, interval: 25 })
    await h.runtime.awaitBatch(STORE, (await runOf(h, attempt.runId)).batchId!)
    const attemptMembers = await membersOf(h, attempt.runId)
    expect(attemptMembers).toHaveLength(1)
    const replacement = attemptMembers[0]!
    const replacementTask = await h.task.taskIn(STORE, replacement)
    expect(replacementTask.requestedCapabilities).toEqual([ROW])
    const replacementRun = (await h.snapshot(STORE)).runs.find(run => run.taskId === replacement)!
    expect(replacementRun.capabilitySnapshot).toContain(SKILL)
    expect(replacementTask.status).toBe('verified')

    // ── the original acceptance criteria judge the attempt ───────────────────
    cells.resolveAttemptSubmit()
    await vi.waitFor(async () => expect((await runOf(h, attempt.runId)).status).toBe('verified'), { timeout: 60_000, interval: 25 })
    const mapVerdict = await verdict(h, attempt.runId, 'root-map')
    expect(mapVerdict?.status).toBe('pass')
    expect(mapVerdict?.details).toContain(`child #0 (${replacement})`)
    // …and the old failure is exactly what it was: the failed run, its review and
    // the diagnosis all stay readable beside the attempt.
    const final = await h.snapshot(STORE)
    expect(final.runs.find(run => run.runId === cells.rootRunId!)?.status).toBe('failed')
    expect(final.reviews.some(review => review.runId === cells.rootRunId! && review.outcome === 'failed')).toBe(true)
    expect(final.diagnoses.find(item => item.diagnosisId === diagnosis.diagnosisId)?.proposals).toHaveLength(1)
    expect(final.runs.filter(run => run.taskId === cells.rootTaskId!)).toHaveLength(2)
  }, 120_000)

  it('keeps a successful source\'s "faster or cheaper" suggestion readable, names the missing comparator, and opens nothing', async () => {
    const { h, cells } = await startCase({ memberFails: false, review: OPTIMIZE_REPLY, optimize: true })
    await failRoot(h, cells, false)
    const root = (await h.snapshot(STORE)).tasks.find(task => task.taskId === cells.rootTaskId!)!
    expect(root.status).toBe('verified')
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    expect(diagnosis.proposals.map(proposal => proposal.targetId)).toEqual(['a6-chain-faster-row'])

    // The hand-off is taken up (the suggestion stays readable and a coordinator
    // may study it), and the recovery it asks for is refused by name: this build
    // has no frozen metric or comparator that could judge "faster or cheaper".
    await consumePendingHandoffs(h.ctx, STORE)
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)
    const runsBefore = (await h.snapshot(STORE)).runs.length
    await vi.waitFor(() => expect(h.calls.some(call => call.name === 'task_recover' && call.result !== undefined)).toBe(true), { timeout: 60_000, interval: 25 })
    const answer = h.calls.find(call => call.name === 'task_recover' && call.result !== undefined)!.result!
    expect(answer.text).toContain('rejected')
    expect(answer.text).toContain('a successful source is not recovered')
    expect(answer.text).toContain('no frozen metric or comparator that could judge "faster or cheaper"')
    expect(answer.text).toContain('no promotion, no application and no new run')

    // Zero new runs, zero promotions, zero production writes — and the record the
    // suggestion lives in is untouched.
    const after = await h.snapshot(STORE)
    expect(after.runs).toHaveLength(runsBefore)
    expect(after.diagnoses.find(item => item.diagnosisId === diagnosis.diagnosisId)?.proposals).toEqual(diagnosis.proposals)
    expect(await h.ctx.evolution.list()).toEqual([])
    expect(h.runtime.listCapabilities()[STORE_ROW]).toMatchObject({ skills: [STORE_SKILL], tools: ['filesystem'] })
    expect(h.runtime.listCapabilities()['a6-chain-faster-row']).toBeUndefined()
    // A reader still sees the suggestion, and the hand-off that was delegated.
    const attempts = await readReviewAgentAttempts(STORE)
    const pack = buildReviewPack({
      snapshot: after,
      source: { taskId: root.taskId, runId: cells.rootRunId! },
      attempts,
      handoff: { enabled: true, attempts, budget: { used: attempts.filter(attempt => attempt.started).length, max: 4 } },
    })
    expect(pack).toContain('a leaner capability would make this case faster and cheaper')
    expect(pack).toContain(supervisor)
  }, 120_000)
})

describe('A6 EVO-5: the recovery adapter carries no authorization of its own', () => {
  it('declares exactly the two fields the plan fixes, and no approved flag, store or reuse list', () => {
    const tool = defineTaskRecoverTool({ get: () => ({}) } as never)
    const schema = tool.parameters as { properties: Record<string, { type?: string }>; required?: readonly string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['requestKey', 'sourceDiagnosisId'])
    expect([...(schema.required ?? [])].sort()).toEqual(['requestKey', 'sourceDiagnosisId'])
    expect(schema.properties.sourceDiagnosisId!.type).toBe('string')
    expect(schema.properties.requestKey!.type).toBe('string')
    // …and the definition carries no other field: an `approved` flag, a store id
    // or a reuse list would be an authorization the plan says the request has none of.
    for (const forbidden of ['approved', 'storeId', 'reuses', 'sourceTaskId', 'sourceRunId']) {
      expect(schema.properties, forbidden).not.toHaveProperty(forbidden)
    }
  })
})

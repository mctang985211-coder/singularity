/**
 * Opt-in real-model supervisor improvement: a shared template defect is
 * diagnosed, the supervisor repairs the Task definition through the full
 * evolution chain behind the human-approval seam, and a NEW input then passes
 * against the repaired library.
 *
 * Everything except the model is the real deployment: the real TaskRuntime,
 * AgentRuntime, verifier registry, evolution plane, approval seam, ledger and
 * experiment runner. The model is real for the business workers, the parent
 * coordinator, the supervisor and the experiment's replayed sides.
 *
 * The reviewer is the one place this spec may script. On commit c436d9d the
 * reviewer prompt names Task templates as proposal targets, so
 * the original all-real mode was tried: its diagnosis routed once (the real
 * supervisor translated the vocabulary and reached prepare), but it produced no
 * valid diagnosis in two of three attempts — the runtime validates cited refs
 * strictly — so the shipped mode is `hybrid`: it answers only the reviewer's
 * request from the spec's queue, with the terminal sample ids and the exact
 * mutation, and every other decision stays real. The trigger is the same
 * `scanFailedReviewSources` scan either way.
 *
 * The fixture bash path check is advisory, not an OS sandbox. The honest
 * report leaf's contract puts a freshness check first
 * (`out/stats.json` must be newer than `out/events.json`) and makes the gap path
 * a single `task_submit_result`, so a replay worker reports the missing or stale
 * input immediately instead of exploring.
 *
 * @module tests/integration/live-supervisor-repair
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import {
  textResponse,
  toolCallResponse,
} from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveApiConfig } from '../../../../tools/scripts/api-config.mjs'
import TokenMeter from '../../../../thirdparty/deepseek-harness/packages/llm/token-meter/lib/index.js'
import {
  deriveTurnTokenUsage,
  type TurnTokenUsage,
} from '../../../../thirdparty/deepseek-harness/packages/llm/token-meter/lib/types/turn-usage.js'
import { buildExperimentReport } from '../../evolution/src/index.ts'
import { reviewerBindingSource } from '../../agent-singularity/src/coordination/ledger.ts'
import { scanFailedReviewSources } from '../../agent-singularity/src/coordination/review-scan.ts'
import { rootTaskStoreId, type TaskTemplate, type TaskTemplateRef } from '../../task/src/index.ts'
import { disposeScriptedLoops, REAL_TOOLS, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'
import {
  aggregateTemplate,
  CASE_1,
  CASE_2,
  CHECKER,
  checkoutTools,
  expectedLog,
  LOG_CONSTRAINTS,
  misorderedPipelineTemplate,
  parseTemplate,
  reportTemplate,
  stageCriteria,
  unrelatedTemplate,
  type TemplateRegistry,
} from '../support/log-pipeline.ts'

/**
 * The defective pipeline v1 is a RECIPE defect, not a criterion defect: `[parse, report, aggregate]` with no `dependsOn`
 * (the "forgotten edge"), so the serial batch runs report before aggregate has produced `out/stats.json`. The criteria
 * are byte-identical between v1 and v2, so the repair is pure template CONTENT and `prepareTaskDefinition`
 * (`evolution/src/task-definition.ts:99-106`) never takes the criterion-repair branch that demands examples and an
 * independent parent oracle. The honest report leaf ({@link reportTemplate}`({ honestLeaf: true })`) is what keeps the
 * failure deterministic: it must report the missing input rather than fabricating it.
 */
function misorderedPipeline(refs: {
  parse: TaskTemplateRef
  aggregate: TaskTemplateRef
  report: TaskTemplateRef
}): TaskTemplate {
  const base = misorderedPipelineTemplate(refs)
  return {
    ...base,
    contract: {
      ...base.contract,
      objective:
        base.contract.objective +
        " Begin by expanding this contract's own recipe: call task_decompose with this template's exact templateRef at the top " +
        'level and no reason or children, so the runtime binds the parse, report and aggregate children in recipe order. Never ' +
        'author a stage contract inline, copy a stage objective by hand, or repair a stage template from here.',
      constraints: [
        ...LOG_CONSTRAINTS,
        "Expand this template's recipe with a top-level templateRef (omit `reason` and `children`); bind every stage child to its " +
          'provided template and never author, copy or repair a stage contract inline.',
        'A stage child that fails ends this pipeline: do NOT admit another batch, do NOT re-dispatch a failed stage, and do not ' +
          'work around the recipe yourself. Submit this task with a gap report naming the failed stage so the defect stays visible ' +
          'for its owner to repair.',
      ],
    },
  }
}

/** Register the log library with correct stage templates and the mis-ordered pipeline recipe. */
async function registerDefectiveLibrary(runtime: TemplateRegistry, distractors: number): Promise<void> {
  await runtime.registerTaskTemplate(parseTemplate())
  await runtime.registerTaskTemplate(reportTemplate({ honestLeaf: true }))
  await runtime.registerTaskTemplate(aggregateTemplate())
  for (let index = 0; index < distractors; index += 1) await runtime.registerTaskTemplate(unrelatedTemplate(index))
  const current = await runtime.findTaskTemplates()
  const ref = (id: string): TaskTemplateRef => {
    const match = current.find(item => item.templateRef.id === id)
    if (match === undefined) throw new Error(`the library holds no ${id} template`)
    return match.templateRef
  }
  await runtime.registerTaskTemplate(
    misorderedPipeline({
      parse: ref('parse-log-events'),
      aggregate: ref('aggregate-event-stats'),
      report: ref('render-stats-report'),
    }),
  )
}

const enabled = process.env.SINGULARITY_LIVE_SUPERVISOR_REPAIR === '1'
const PROGRESS_PATH = '/tmp/singularity-live-supervisor-repair-progress.json'
const EVIDENCE_OVERRIDE = process.env.SINGULARITY_LIVE_SUPERVISOR_EVIDENCE
/** Evidence output directory, or the file `SINGULARITY_LIVE_SUPERVISOR_EVIDENCE` names (relative to it, or absolute). */
const EVIDENCE_DIR = new URL('../../docs/', import.meta.url)
const EVIDENCE_PATH = EVIDENCE_OVERRIDE === undefined || EVIDENCE_OVERRIDE === ''
  ? new URL('2026-10-04-live-supervisor-repair.json', EVIDENCE_DIR)
  : new URL(EVIDENCE_OVERRIDE, EVIDENCE_DIR)
const REQUEST_ALLOWANCE = 300
/** `hybrid` scripts only the reviewer's diagnosis; `all-real` forwards the reviewer to the gateway too. */
const REVIEWER_MODE = process.env.SINGULARITY_LIVE_REVIEWER_MODE === 'all-real' ? 'all-real' : 'hybrid'
const LIVE_COMMAND = 'NODE_USE_ENV_PROXY=1 SINGULARITY_LIVE_SUPERVISOR_REPAIR=1' +
  (REVIEWER_MODE === 'all-real' ? ' SINGULARITY_LIVE_REVIEWER_MODE=all-real' : '') +
  (EVIDENCE_OVERRIDE === undefined || EVIDENCE_OVERRIDE === ''
    ? ''
    : ` SINGULARITY_LIVE_SUPERVISOR_EVIDENCE=${EVIDENCE_OVERRIDE}`) +
  ' pnpm exec vitest run --project integration packages/singularity/tests/integration/live-supervisor-repair.spec.ts'

// This host reaches the model gateway only through the configured HTTPS proxy, and Node 22's fetch ignores the proxy
// environment unless the process opted in at startup. Fail fast with the exact fix instead of eight retrying timeouts.
if (
  enabled &&
  (process.env.HTTPS_PROXY ?? process.env.https_proxy) !== undefined &&
  process.env.NODE_USE_ENV_PROXY !== '1'
) {
  throw new Error(
    'the live model gateway is reachable only through the configured HTTPS proxy, which Node fetch honours only when the ' +
      'process starts with NODE_USE_ENV_PROXY=1: relaunch with `NODE_USE_ENV_PROXY=1 SINGULARITY_LIVE_SUPERVISOR_REPAIR=1 ' +
      'pnpm exec vitest run --project integration packages/singularity/tests/integration/live-supervisor-repair.spec.ts`',
  )
}

const ROOT = 's-root'
const OPERATOR = 's-operator'
const ROOT2 = 's-root2'
const STORE = rootTaskStoreId(ROOT)
const STORE2 = rootTaskStoreId(ROOT2)
const PIPELINE = 'log-analytics-pipeline'
const PARSE = 'parse-log-events'
const REPORT = 'render-stats-report'

/** The nine evolution tools the supervisor's grant names (`handoff-rules.ts:14-34`), plus the real recovery adapter. */
const EVOLUTION_TOOLS: readonly string[] = [
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_rollback',
  'evolution_list',
]

/** Business sessions (root, coordinators, workers, reviewers, replayed sides): real tools, filesystem trio, no evolution chain. */
const BUSINESS_TOOLS = new Set<string>([
  ...REAL_TOOLS.filter(name => name !== 'task_review_agent'),
  'read',
  'write',
  'bash',
  'task_verify',
])

/** The supervisor uses the production template catalog and read-only investigation tools. */
const SUPERVISOR_ALLOWED = new Set<string>([
  ...EVOLUTION_TOOLS,
  'task_recover',
  'task_review_pack',
  'task_review_agent',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'task_template_list',
  'read',
])

const dirs: string[] = []
afterEach(async () => {
  await disposeScriptedLoops()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-supervisor-repair-'))
  dirs.push(dir)
  return dir
}

interface ProposalLike {
  readonly proposalId: string
  readonly status: string
  readonly targetType: string
  readonly targetId: string
  readonly sourceRefs: readonly string[]
  readonly decision?: string
}

/** The gate's six verbatim answers plus the evidence they cite, as the applied proposal folds them. */
interface GateAnswersLike {
  readonly targetFailureFixed: string
  readonly originalAcceptanceMaintained: string
  readonly existingRegressionMaintained: string
  readonly noUnacceptableSideEffects: string
  readonly holdoutPerformanceAcceptable: string
  readonly resourceCostAcceptable: string
  readonly regressionEvidenceRefs: readonly string[]
}

/** The experiment sides the gate was judged over, in the evidence's own shape. */
interface GateSampleLike {
  readonly taskId: string
  readonly role: string
  readonly baseline: { readonly outcome: string }
  readonly candidate: { readonly outcome: string }
}

interface GateRecord {
  readonly proposalId: string
  readonly answered: number
  readonly questions: number
  readonly answers: GateAnswersLike | null
  readonly regressionEvidenceRefs: readonly string[]
  readonly sampleCount: number
  readonly totalSides: number
  readonly gatePassedSides: number
  readonly sides: readonly { taskId: string; role: string; side: 'baseline' | 'candidate'; outcome: string }[]
}

/** The gate's six answers and the sides it passed, built from the applied proposal and its experiment. */
function buildGate(
  proposalId: string,
  gateAnswers: GateAnswersLike | undefined,
  samples: readonly GateSampleLike[],
): GateRecord {
  const answered = gateAnswers === undefined
    ? 0
    : [
        gateAnswers.targetFailureFixed,
        gateAnswers.originalAcceptanceMaintained,
        gateAnswers.existingRegressionMaintained,
        gateAnswers.noUnacceptableSideEffects,
        gateAnswers.holdoutPerformanceAcceptable,
        gateAnswers.resourceCostAcceptable,
      ].filter(answer => typeof answer === 'string' && answer.trim() !== '').length
  const sides = samples.flatMap(sample =>
    ([['baseline', sample.baseline.outcome], ['candidate', sample.candidate.outcome]] as const).map(
      ([side, outcome]) => ({ taskId: sample.taskId, role: sample.role, side, outcome }),
    ))
  const gatePassedSides = sides.filter(side => {
    const expected = side.role === 'observed-failure'
      ? side.side === 'baseline' ? 'failed' : 'verified'
      : 'verified'
    return side.outcome === expected
  }).length
  return {
    proposalId,
    answered,
    questions: 6,
    answers: gateAnswers ?? null,
    regressionEvidenceRefs: gateAnswers?.regressionEvidenceRefs ?? [],
    sampleCount: samples.length,
    totalSides: sides.length,
    gatePassedSides,
    sides,
  }
}

interface EvolutionApi {
  list(): Promise<readonly ProposalLike[]>
  get(proposalId: string): Promise<ProposalLike>
  experiments(proposalId: string): Promise<readonly unknown[]>
}

interface Requests {
  readonly sessionId: string
  readonly text: string
  readonly tools: string[]
}

/** The ledger's own line kinds, read from disk (never the service's memory). */
function ledgerKinds(ledgerRoot: string, proposalId?: string): string[] {
  const file = join(ledgerRoot, 'proposals.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { kind: string; proposalId: string })
    .filter(record => proposalId === undefined || record.proposalId === proposalId)
    .map(record => record.kind)
}

/** One tool call's dispatch record, as the loop's own fixture holds it. */
interface CallRecord {
  readonly callId: string
  readonly sessionId: string
  readonly name: string
  readonly args: unknown
  result?: { readonly isError: boolean; readonly text: string }
}

/** The ordered presence of the supervisor chain's tool calls in one session's dispatch record. */
function chainOf(calls: readonly CallRecord[], sessionId: string, proposalId?: string): string[] {
  const wanted = [
    'evolution_propose',
    'evolution_candidate',
    'evolution_prepare',
    'evolution_replay',
    'evolution_gate',
    'evolution_decide',
    'evolution_apply',
  ]
  const seen = calls.filter(call => call.sessionId === sessionId &&
    (proposalId === undefined || (call.args as { proposalId?: string }).proposalId === proposalId)).map(call => call.name)
  let at = 0
  const ordered: string[] = []
  for (const name of seen) {
    if (name === wanted[at]) {
      ordered.push(name)
      at += 1
    }
  }
  return ordered
}

/**
 * One thrown value as a bounded diagnostic line. Some fetch failures stringify as
 * `[object Object]`, so read the fields the gateway/undici actually populate
 * (name, message, code, status, cause) instead of trusting `String(error)`.
 */
function describeThrown(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return String(value)
  const record = value as {
    name?: unknown
    message?: unknown
    code?: unknown
    status?: unknown
    cause?: unknown
  }
  const parts: string[] = []
  const label = typeof record.name === 'string' && record.name !== '' ? record.name : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  if (label !== undefined && message !== undefined && message !== '') parts.push(`${label}: ${message}`)
  else if (label !== undefined) parts.push(label)
  else if (message !== undefined) parts.push(`message=${message}`)
  if (record.code !== undefined) parts.push(`code=${String(record.code)}`)
  if (record.status !== undefined) parts.push(`status=${String(record.status)}`)
  if (record.cause !== undefined && depth < 3) parts.push(`cause=${describeThrown(record.cause, depth + 1)}`)
  if (parts.length > 0) return parts.join(' ')
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * The four disjoint provider buckets this evidence reports. A bucket a provider
 * never reported is `null`, never zero: only `deriveTurnTokenUsage`'s own
 * per-turn proof of "every attempt reported it" turns one into a number.
 */
interface TokenTally {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  /** Completed turns whose provider usage the meter could prove. */
  readonly measuredTurns: number
  /** Completed turns it could not prove (scripted reviewer, aborted stream, partial attempt usage). */
  readonly turnsWithoutUsage: number
  /** Buckets rendered `null` because at least one measured turn — or every turn — never reported them. */
  readonly unreportedBuckets: readonly string[]
}

/** Sum the proofs of a set of turns; a bucket is null unless every one of them carried it. */
function tallyTokens(usages: readonly TurnTokenUsage[], turnsWithoutUsage: number): TokenTally {
  const bucket = (pick: (usage: TurnTokenUsage) => number | undefined): number | null =>
    usages.length > 0 && usages.every(usage => pick(usage) !== undefined)
      ? usages.reduce((sum, usage) => sum + pick(usage)!, 0)
      : null
  const inputTokens = usages.length > 0 ? usages.reduce((sum, usage) => sum + usage.uncachedInputTokens, 0) : null
  const outputTokens = usages.length > 0 ? usages.reduce((sum, usage) => sum + usage.outputTokens, 0) : null
  const cacheReadTokens = bucket(usage => usage.cacheReadTokens)
  const cacheWriteTokens = bucket(usage => usage.cacheWriteTokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    measuredTurns: usages.length,
    turnsWithoutUsage,
    unreportedBuckets: [
      ...inputTokens === null ? ['inputTokens'] : [],
      ...outputTokens === null ? ['outputTokens'] : [],
      ...cacheReadTokens === null ? ['cacheReadTokens'] : [],
      ...cacheWriteTokens === null ? ['cacheWriteTokens'] : [],
    ],
  }
}

/**
 * Fold every COMPLETE turn of one durable session log through the meter's own
 * `deriveTurnTokenUsage`, with the number of model requests the turn really
 * spent. One stream call always settles exactly one `assistant/attempt` (error)
 * or `assistant/message` (success) event, so that count also maps each turn back
 * to its entry in the spec's per-request phase trace.
 */
function sessionTurns(events: readonly SessionEvent[]): { usage: TurnTokenUsage | undefined; requests: number }[] {
  const turns: { usage: TurnTokenUsage | undefined; requests: number }[] = []
  let slice: SessionEvent[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      slice = [event]
      continue
    }
    if (slice.length === 0) continue
    slice.push(event)
    if (event.type !== 'turn/end') continue
    turns.push({
      usage: deriveTurnTokenUsage(slice),
      requests: slice.filter(item => item.type === 'assistant/attempt' || item.type === 'assistant/message').length,
    })
    slice = []
  }
  return turns
}

/**
 * The reviewer's scripted diagnosis (hybrid mode). It reads the store for the
 * terminal tasks the two-sided experiment must replay — the failed pipeline
 * coordinator (whose new children bind the side library) and a verified parse
 * holdout. It carries a complete candidate mutation. The real Supervisor reads
 * the source through the production task_template_list entry before preparing.
 */
async function reviewerReply(
  h: ScriptedLoop,
  storeId: string,
  reviewerSessionId: string,
  library: string,
): Promise<string> {
  const snapshot = await h.snapshot(storeId)
  const failedPipeline = snapshot.tasks.find(task => task.status === 'failed' && task.templateRef?.id === PIPELINE)
  const sample = failedPipeline?.taskId ?? ''
  const holdout =
    snapshot.tasks.find(task => task.status === 'verified' && task.templateRef?.id === PARSE)?.taskId ?? ''
  const diagnosisId = `review-agent-${reviewerSessionId}`
  const templateV1 = JSON.parse(readFileSync(join(library, `${PIPELINE}@1.json`), 'utf8')) as {
    decomposition: { children: { templateRef: { id: string } }[] }
    [key: string]: unknown
  }
  const [parseRef, reportRef, aggregateRef] = templateV1.decomposition.children
  const candidate = {
    ...templateV1,
    version: 2,
    decomposition: {
      reason: 'The three stages have independently checkable artifacts and a strict data dependency order.',
      children: [
        { templateRef: parseRef!.templateRef },
        { templateRef: aggregateRef!.templateRef, dependsOn: [0] },
        { templateRef: reportRef!.templateRef, dependsOn: [1] },
      ],
    },
  }
  const mutation = JSON.stringify({ template: candidate })
  const diagnosis = {
    observation:
      'the pipeline coordinator failed because its recipe bound the report stage with no dependency on the aggregation ' +
      'stage: the serial batch started report before aggregate had produced out/stats.json, and the honest report stage refused ' +
      'to fabricate the missing input.',
    conclusion:
      `the log-analytics-pipeline recipe is mis-ordered: its children are [parse, report, aggregate] with no dependsOn, so report ` +
      `runs before aggregate. Repair it through the evolution chain: evolution_propose {fromDiagnosis:{diagnosisId:` +
      `"${diagnosisId}",proposalIndex:0}, sourceRefs:["diagnosis:${diagnosisId}"], proposalId, level:"L2", baseVersion:"1"}, then ` +
      `evolution_candidate with versionSet {"log-analytics-pipeline":"2"} and mutationJson set to exactly the JSON below (a complete ` +
      `TaskTemplate whose recipe is [parse, aggregate, report] with aggregate dependsOn [0] and report dependsOn [1]; the criteria ` +
      `are unchanged), then evolution_prepare, evolution_replay with taskIds ["${sample}"] and holdoutTaskIds ["${holdout}"], ` +
      `evolution_gate citing the report path, evolution_decide PROMOTE, and evolution_apply. The mutationJson is: ${mutation}`,
    confidence: 'high',
    proposals: [
      {
        targetType: 'task_definition',
        targetId: PIPELINE,
        rationale:
          `ordering the recipe as [parse, aggregate, report] with aggregate dependsOn [0] and report dependsOn [1] makes report run ` +
          `after stats.json exists; evaluate it with taskIds ["${sample}"] and holdoutTaskIds ["${holdout}"]`,
      },
    ],
  }
  return '```json\n' + JSON.stringify(diagnosis) + '\n```'
}

// The dispose hook tears down the whole stack and can outlive the 120 s default on a failure path.
afterEach(disposeScriptedLoops, 600_000)

it.skipIf(!enabled)(
  'repairs a defective Task template through the real supervisor chain and verifies a new input against version 2',
  async () => {
    const api = resolveApiConfig()
    const startedAt = Date.now()
    const ledgerRoot = join(scratch(), 'evolution')
    const h = await startScriptedLoop({
      roots: [ROOT, OPERATOR, ROOT2],
      providers: [api.provider ?? 'deepseek'],
      defaultSelection: () => ({ provider: api.provider ?? 'deepseek', model: api.model! }),
      capabilities: {
        'coordinate-tasks': { skills: ['task-coordination'] },
        'local-files': { skills: ['task-execution'], tools: ['filesystem'] },
      },
      // Every session is answered by the llm/stream hook below; the script is unused.
      script: () => [],
      // The real evolution plane: the real ledger, ctx.evolution and the nine real tools.
      evolution: { ledgerRoot },
      // Select the failed-source path; the successful-root optimization path is covered separately.
      supervision: { autoReview: 'failed', maxRecoveryRounds: 3, maxImprovementRounds: 2, coordinationBudget: 12 },
      // The publication approval is answered through the deployment's own approval seam, not by a model.
      approvalAnswer: () => 'allowed-once',
      verifyTimeoutMs: 1_500_000,
      // The pipeline's own commands are seconds; a 25-minute bound only lets a model's stray `find /` stall the run.
      tools: checkoutTools({ bashTimeoutMs: 180_000 }),
    })
    await h.ctx.plugin(TokenMeter, {})
    // Mount the production delegation read seam; the fixture does not load the agent plugin.
    h.ctx.effect(() => h.ctx.singularityContext.registerReviewerBindingSource(reviewerBindingSource()))
    // The verifier uses the declared live-run budget.
    expect((h.ctx as unknown as { taskRuntime: { verifyTimeoutMs: number } }).taskRuntime.verifyTimeoutMs).toBe(
      1_500_000,
    )
    // The live request presents only executable tools, per role: the supervisor keeps the evolution chain and its
    // read-only investigation tools; every other session keeps the business surface (no evolution chain, no focused review).
    // The assemble context carries the asking agent as both `agent` and `scope`; the session id is read from whichever
    // shape this harness supplies, and one diagnostic line records it.
    let assembleDiagnosed = false
    h.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      interface ScopeLike {
        readonly sessionId?: unknown
        readonly session?: { readonly header?: { readonly id?: string } }
      }
      const asking = context as { agent?: ScopeLike; scope?: ScopeLike }
      const sessionId = String(
        asking.agent?.sessionId ??
          asking.scope?.sessionId ??
          asking.agent?.session?.header?.id ??
          asking.scope?.session?.header?.id ??
          '',
      )
      const spawnName = h.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? ''
      if (!assembleDiagnosed) {
        assembleDiagnosed = true
        process.stderr.write(
          `[live] assemble context keys: ${Object.keys((context ?? {}) as object).join(',')} agent=${asking.agent !== undefined} scope=${asking.scope !== undefined} session=${sessionId || '(none)'} spawn=${spawnName || '(root/business)'}\n`,
        )
      }
      const allowed = spawnName.startsWith('supervisor') ? SUPERVISOR_ALLOWED : BUSINESS_TOOLS
      // If the harness does not expose the session here, fall back to the grant: a composition that already carries an
      // evolution tool belongs to a coordination session that must keep its chain.
      const effective =
        sessionId === '' && assembled.tools.some(tool => tool.name.startsWith('evolution_'))
          ? SUPERVISOR_ALLOWED
          : allowed
      assembled.tools = assembled.tools.filter(tool => effective.has(tool.name))
      return assembled
    })
    mkdirSync(join(h.checkout, 'checks'), { recursive: true })
    writeFileSync(join(h.checkout, 'events.log'), CASE_1)
    writeFileSync(join(h.checkout, 'checks/verify.mjs'), CHECKER)
    // The defective library keeps the real checker; only the recipe ordering is broken.
    await registerDefectiveLibrary(h.runtime, 30)

    const evolution = (h.ctx as unknown as { evolution: EvolutionApi }).evolution
    const requests: Requests[] = []
    const phaseOf = { current: 'run1' as string }
    const requestCounts: Record<string, number> = { run1: 0, supervisor: 0, experiment: 0, run2: 0 }
    // The phase of every request a session makes, in order — the same
    // `phaseOf` partition `requestCounts` uses, kept per session so each
    // completed turn can be attributed to the window it opened in.
    const sessionRequestPhases = new Map<string, string[]>()
    const phase = (next: string): void => {
      phaseOf.current = next
      if (requestCounts[next] === undefined) requestCounts[next] = 0
    }
    let nudges = 0
    h.ctx.on('llm/stream', async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (requests.length >= REQUEST_ALLOWANCE) throw new Error('live validation exceeded its request allowance')
      const spawnName = h.spawns.find(spawn => String(spawn.sessionId) === String(options.sessionId))?.name ?? ''
      const sid = String(options.sessionId)
      const sessionPhases = sessionRequestPhases.get(sid) ?? []
      sessionPhases.push(phaseOf.current)
      sessionRequestPhases.set(sid, sessionPhases)
      inFlight.set(sid, (inFlight.get(sid) ?? 0) + 1)
      requests.push({
        sessionId: String(options.sessionId),
        text: JSON.stringify(options.messages),
        tools: options.tools?.map(tool => tool.name) ?? [],
      })
      requestCounts[phaseOf.current] = (requestCounts[phaseOf.current] ?? 0) + 1
      process.stderr.write(
        `[live] request #${requests.length} phase=${phaseOf.current} session=${spawnName || String(options.sessionId)} start ${new Date().toISOString()}\n`,
      )
      // The one scripted decision: the reviewer's diagnosis. Everything else reaches the gateway.
      if (REVIEWER_MODE === 'hybrid' && spawnName.startsWith('review ')) {
        const reply = await reviewerReply(h, STORE, String(options.sessionId), h.runtime.config.taskTemplatesRoot!)
        process.stderr.write(`[live] reviewer diagnosis scripted (hybrid)\n`)
        void writeFile(
          PROGRESS_PATH,
          JSON.stringify({ requests, calls: h.calls, snapshot: await h.snapshot(STORE) }, null, 2) + '\n',
        )
        yield* textResponse(reply)
        inFlight.set(sid, Math.max(0, (inFlight.get(sid) ?? 1) - 1))
        return
      }
      const messages = options.messages.flatMap(message => {
        const content = message.content
          .filter(block => block.type === 'text')
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('\n')
        if (message.role === 'developer') return content ? [{ role: 'user', content }] : []
        if (message.role === 'tool') return [{ role: 'tool', tool_call_id: message.toolCallId, content }]
        const calls = message.content
          .filter(block => block.type === 'tool-call')
          .map(block =>
            block.type === 'tool-call'
              ? { id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }
              : undefined,
          )
        return [{ role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) }]
      })
      const requestStartedAt = Date.now()
      let response: Awaited<ReturnType<typeof fetch>> | undefined
      let lastError: unknown
      let attempts = 0
      for (let attempt = 1; attempt <= 8 && response === undefined; attempt += 1) {
        attempts = attempt
        try {
          const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(240000)])
          response = await fetch(`${api.upstream}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${api.key}`,
              'User-Agent': api.userAgent,
            },
            body: JSON.stringify({
              model: api.model,
              messages,
              tools: options.tools?.map(tool => ({ type: 'function', function: tool })),
              max_tokens: 8000,
              stream: false,
            }),
            signal,
          })
        } catch (error) {
          lastError = error
          if (options.signal?.aborted === true) break
          await new Promise(resolve => setTimeout(resolve, Math.min(2000 * attempt, 10000)))
        }
      }
      // The gateway fetch is over: the session is no longer "in flight" even while it processes the answer.
      inFlight.set(sid, Math.max(0, (inFlight.get(sid) ?? 1) - 1))
      if (response === undefined) {
        process.stderr.write(
          `[live] request #${requests.length} gave up after ${attempts} attempts: ${describeThrown(lastError)}\n`,
        )
        throw lastError
      }
      if (!response.ok) throw new Error(`live model returned HTTP ${response.status}`)
      const result = await response.json()
      process.stderr.write(`[live] request #${requests.length} ok in ${Date.now() - requestStartedAt}ms\n`)
      await writeFile(
        PROGRESS_PATH,
        JSON.stringify({ requests, calls: h.calls, snapshot: await h.snapshot(STORE) }, null, 2) + '\n',
      )
      const answer = result.choices?.[0]?.message
      if (!answer) throw new Error('live model returned no assistant message')
      const calls = answer.tool_calls ?? []
      if (!calls.length && !answer.content) {
        process.stderr.write(`[live] empty assistant response finish=${result.choices?.[0]?.finish_reason} usage=${JSON.stringify(result.usage ?? {})}\n`)
      }
      let block = 0
      if (!calls.length) {
        for (const chunk of textResponse(answer.content ?? ''))
          if (chunk.type !== 'usage' && chunk.type !== 'finish') yield chunk
      }
      for (const call of calls) {
        const chunks = toolCallResponse(call.id, call.function.name, JSON.parse(call.function.arguments))
        for (const chunk of chunks)
          if (chunk.type !== 'usage' && chunk.type !== 'finish')
            yield 'index' in chunk ? { ...chunk, index: block } : chunk
        block += 1
      }
      expect(result.usage?.prompt_tokens, 'gateway must report actual prompt usage').toBeTypeOf('number')
      expect(result.usage?.completion_tokens, 'gateway must report actual completion usage').toBeTypeOf('number')
      const cacheReadTokens = result.usage.prompt_cache_hit_tokens ?? result.usage.prompt_tokens_details?.cached_tokens ?? 0
      // Carry through only buckets the gateway itself reported: `total_tokens`
      // is the provider's own exact total (the meter needs it to prove usage
      // when the route reports no cache-write bucket), and a cache-write counter
      // is included only when the route returns one — never invented as zero.
      const cacheWriteTokens = result.usage.prompt_cache_write_tokens
        ?? result.usage.prompt_cache_creation_tokens
        ?? result.usage.prompt_tokens_details?.cache_write_tokens
        ?? result.usage.prompt_tokens_details?.cache_creation_tokens
      yield {
        type: 'usage',
        usage: { inputTokens: result.usage.prompt_tokens - cacheReadTokens,
          outputTokens: result.usage.completion_tokens, cacheReadTokens,
          ...typeof result.usage.total_tokens === 'number' ? { totalTokens: result.usage.total_tokens } : {},
          ...typeof cacheWriteTokens === 'number' ? { cacheWriteTokens } : {} },
      }
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
    })
    // The watchdog persists progress and nudges an IDLE session: one whose own run is active (or that is the supervisor)
    // and that has neither a pending tool call nor an in-flight model request while all progress has been stagnant.
    // A session with a pending tool call is never prompted — wording at a legitimately long call can supersede its turn.
    const inFlight = new Map<string, number>()
    const nudgeCounts = new Map<string, number>()
    const NUDGE_WINDOW_MS = 180_000
    const NUDGE_CAP = 12
    let lastProgressAt = Date.now()
    let lastRequestCount = 0
    let lastCallCount = 0
    const watchdog = setInterval(() => {
      const now = Date.now()
      const callsNow = h.calls as readonly CallRecord[]
      if (requests.length !== lastRequestCount || callsNow.length !== lastCallCount) {
        lastRequestCount = requests.length
        lastCallCount = callsNow.length
        lastProgressAt = now
      }
      void h
        .snapshot(STORE)
        .then(async snapshot => {
          await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, snapshot }, null, 2) + '\n')
          if (now - lastProgressAt < NUDGE_WINDOW_MS) return
          // The supervisor is a coordination session; business sessions are eligible while their own run is active.
          // Experiment-side runs live in the same snapshot, so a stuck replay worker is covered here too.
          const candidates = new Set<string>()
          const supervisor = h.spawns.find(spawn => spawn.name.startsWith('supervisor'))
          if (supervisor !== undefined) candidates.add(String(supervisor.sessionId))
          for (const run of snapshot.runs) {
            if (run.status === 'running' && run.executionPhase === 'active' && run.sessionId !== undefined) {
              candidates.add(String(run.sessionId))
            }
          }
          let nudgedAny = false
          for (const sessionId of candidates) {
            if ((nudgeCounts.get(sessionId) ?? 0) >= NUDGE_CAP) continue
            if ((inFlight.get(sessionId) ?? 0) > 0) continue
            if (callsNow.some(call => call.sessionId === sessionId && call.result === undefined)) continue
            const count = (nudgeCounts.get(sessionId) ?? 0) + 1
            nudgeCounts.set(sessionId, count)
            nudges += 1
            nudgedAny = true
            process.stderr.write(
              `[live] nudge #${nudges} ${sessionId.slice(0, 14)} idle ${Math.round((now - lastProgressAt) / 1000)}s (session ${count}/${NUDGE_CAP})\n`,
            )
            try {
              void h.agentRuntime
                .prompt(h.agent(sessionId), [
                  {
                    type: 'text',
                    text: 'Your turn ended without settling this run. Continue your task, or state what blocks you.',
                  },
                ])
                .catch(error =>
                  process.stderr.write(`[live] nudge failed for ${sessionId.slice(0, 14)}: ${String(error)}\n`),
                )
            } catch {
              /* a session without a live agent cannot be nudged */
            }
          }
          if (nudgedAny) lastProgressAt = now
        })
        .catch(() => undefined)
    }, 15000)
    watchdog.unref?.()

    // ── provider token usage, folded by the meter's own deriveTurnTokenUsage ──
    // Shared by the success and failure evidence: a run that throws mid-way still
    // reports the phases that produced turns, and a phase with no completed turn
    // renders null buckets (named in unreportedBuckets) rather than a fabricated zero.
    const computeTokenUsage = () => {
      const phaseUsages: Record<string, TurnTokenUsage[]> = {}
      const phaseUnmeasured: Record<string, number> = {}
      for (const name of Object.keys(requestCounts)) {
        phaseUsages[name] = []
        phaseUnmeasured[name] = 0
      }
      const allUsages: TurnTokenUsage[] = []
      let allUnmeasured = 0
      const tokenSessions: Record<string, TokenTally & { label: string; firstPhase: string }> = {}
      for (const [sessionId, sessionPhases] of sessionRequestPhases) {
        const turns = sessionTurns(h.eventsOf(sessionId))
        const sessionUsages: TurnTokenUsage[] = []
        let unmeasured = 0
        let phaseCursor = 0
        for (const turn of turns) {
          // A turn's model requests are contiguous in the session's own request
          // order, so the phase of its first request is the window it opened in.
          const turnPhase = sessionPhases[phaseCursor] ?? sessionPhases.at(-1) ?? 'unknown'
          phaseCursor += turn.requests
          if (turn.usage === undefined) {
            unmeasured += 1
            if (phaseUnmeasured[turnPhase] !== undefined) phaseUnmeasured[turnPhase] += 1
            continue
          }
          sessionUsages.push(turn.usage)
          allUsages.push(turn.usage)
          if (phaseUsages[turnPhase] !== undefined) phaseUsages[turnPhase]!.push(turn.usage)
        }
        tokenSessions[sessionId] = {
          label: h.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? `root:${sessionId}`,
          firstPhase: sessionPhases[0] ?? 'unknown',
          ...tallyTokens(sessionUsages, unmeasured),
        }
      }
      const tokenPhases: Record<string, TokenTally> = {}
      const phasesWithoutCompletedTurns: string[] = []
      for (const name of Object.keys(requestCounts)) {
        const tally = tallyTokens(phaseUsages[name]!, phaseUnmeasured[name]!)
        tokenPhases[name] = tally
        if (tally.measuredTurns === 0 && tally.turnsWithoutUsage === 0) phasesWithoutCompletedTurns.push(name)
      }
      return {
        source:
          'deriveTurnTokenUsage(@deepseek-ai/dsh-token-meter) over every completed turn/start..turn/end slice of every session that made a model request',
        buckets:
          'inputTokens is uncached prompt input (uncachedInputTokens); cacheReadTokens/cacheWriteTokens are null unless every measured turn ' +
          'reported them — a bucket no route reported is never rendered as zero',
        attribution:
          'a turn is attributed to the phase of its first request; turns the meter could not prove are counted, not imputed; a phase that ' +
          'completed no turn renders null buckets (its unreportedBuckets names them) and is listed in phasesWithoutCompletedTurns',
        phases: tokenPhases,
        phasesWithoutCompletedTurns,
        total: tallyTokens(allUsages, allUnmeasured),
        sessions: tokenSessions,
      }
    }

    // Evidence preservation: if any terminal wait below throws, the run still leaves an honest document (never a stale
    // smoke artifact). The success path writes the full document and sets the flag; the catch writes the live state.
    let evidenceWritten = false
    const writeFailureEvidence = async (error: unknown): Promise<void> => {
      const snapshot = await h.snapshot(STORE).catch(() => undefined)
      const snapshot2 = await h.snapshot(STORE2).catch(() => undefined)
      const calls = h.calls as readonly CallRecord[]
      const supervisor = h.spawns.find(spawn => spawn.name.startsWith('supervisor for '))
      const chain = supervisor === undefined ? [] : chainOf(calls, String(supervisor.sessionId))
      const tasks = snapshot?.tasks ?? []
      const run2Tasks = snapshot2?.tasks ?? []
      const proposals = await evolution.list()
      const experiments = []
      const experimentReports: { proposalId: string; report: ReturnType<typeof buildExperimentReport> }[] = []
      for (const proposal of proposals) {
        for (const view of await evolution.experiments(proposal.proposalId)) {
          const experiment = view as Parameters<typeof buildExperimentReport>[0]
          try {
            const report = buildExperimentReport(experiment)
            experimentReports.push({ proposalId: proposal.proposalId, report })
            experiments.push({ proposalId: proposal.proposalId, experimentId: report.experimentId,
              verdict: report.verdict, samples: report.samples.map(sample => ({ taskId: sample.taskId, role: sample.role,
                baseline: sample.baseline.outcome, candidate: sample.candidate.outcome })) })
          } catch (reportError) {
            experiments.push({ proposalId: proposal.proposalId, experimentId: experiment.experimentId,
              error: String(reportError), settledSamples: experiment.samples })
          }
        }
      }
      // Gate evidence is real as soon as any proposal reached the gate; the most
      // advanced one wins, and a run that threw before any gate answer leaves null
      // rather than a fabricated record.
      const advancement = (status: string): number =>
        status === 'applied' ? 0 : status === 'decided' ? 1 : status === 'gated' ? 2 : 3
      let gate: ReturnType<typeof buildGate> | null = null
      for (const proposal of [...proposals].sort((left, right) => advancement(left.status) - advancement(right.status))) {
        const view = (await evolution.get(proposal.proposalId)) as ProposalLike & { gate?: GateAnswersLike }
        if (view.gate === undefined) continue
        const judged = experimentReports.filter(item => item.proposalId === proposal.proposalId).at(-1)?.report
        gate = buildGate(proposal.proposalId, view.gate, judged?.samples ?? [])
        break
      }
      const tokenUsage = computeTokenUsage()
      const assertions = {
        reportLeafFailedOnRealChecker: tasks.find(task => task.templateRef?.id === REPORT)?.status === 'failed',
        pipelineCoordinatorFailedOnRealChecker:
          tasks.find(task => task.templateRef?.id === PIPELINE)?.status === 'failed',
        diagnosisCarriesAProposal: (snapshot?.diagnoses ?? []).some(item => item.proposals.length > 0),
        supervisorSessionStarted: supervisor !== undefined,
        supervisorRanEvolutionChain:
          chain.join('>') ===
          'evolution_propose>evolution_candidate>evolution_prepare>evolution_replay>evolution_gate>evolution_decide>evolution_apply',
        run2Verified: (snapshot2?.tasks ?? []).some(
          task => task.parentTaskId === undefined && task.status === 'verified',
        ),
        noUnrelatedTemplatesInAnyRequest: requests.every(request => !request.text.includes('UNRELATED_DOMAIN_MARKER')),
      }
      const document = {
        date: '2026-10-04',
        test: 'tests/integration/live-supervisor-repair.spec.ts',
        command: LIVE_COMMAND,
        model: api.model,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
        method: `A ${REVIEWER_MODE} run that threw before its terminal assertions; this document is the live state at failure.`,
        assertions,
        cases: [
          {
            name: 'log-pipeline-shared-template-repair',
            reviewPath: REVIEWER_MODE,
            tree: {
              tasks: tasks.map(task => ({
                taskId: task.taskId,
                parentTaskId: task.parentTaskId,
                depth: task.depth,
                templateRef: task.templateRef,
                status: task.status,
              })),
              diagnoses: (snapshot?.diagnoses ?? []).map(diagnosis => ({
                diagnosisId: diagnosis.diagnosisId,
                proposals: diagnosis.proposals.map(item => [item.targetType, item.targetId]),
              })),
              // The second root's store is torn down after the test, so snapshot it
              // here when run2 already has tasks; a store that never started adds nothing.
              ...(snapshot2 !== undefined && run2Tasks.length > 0
                ? {
                    run2: {
                      storeId: STORE2,
                      tasks: run2Tasks.map(task => ({
                        taskId: task.taskId,
                        parentTaskId: task.parentTaskId,
                        depth: task.depth,
                        templateRef: task.templateRef,
                        decompositionStatus: task.decompositionStatus,
                        childTaskIds: task.childTaskIds,
                        status: task.status,
                      })),
                      edges: snapshot2.edges,
                    },
                  }
                : {}),
            },
            proposals,
            experiments,
            gate,
            tokenUsage,
            evolutionCalls: calls.filter(call => call.name.startsWith('evolution_')).map(call => ({
              tool: call.name, isError: call.result?.isError, result: call.result?.text.slice(0, 1500),
            })),
            requestCounts,
            requestTotal: requests.length,
            nudgeCount: nudges,
            nudgeSessions: Object.fromEntries(nudgeCounts),
            wallSeconds: (Date.now() - startedAt) / 1000,
          },
        ],
        limits:
          'The run threw before its terminal assertions; the document records the live store state and the assertions that could be resolved from it. ' +
          'tokenUsage covers every phase that completed a turn (phasesWithoutCompletedTurns names the ones that did not, with null buckets, never zero); ' +
          'gate is null when no proposal had recorded a gate before the throw.',
      }
      writeFileSync(EVIDENCE_PATH, JSON.stringify(document, null, 2) + '\n')
      await writeFile('/tmp/singularity-live-supervisor-repair.json', JSON.stringify(document, null, 2) + '\n')
    }

    try {
      // ── run 1: the mis-ordered recipe must fail the report leaf first, and the coordinator after it ──
      const root1 = await h.begin({
        objective:
          'Own the log-analytics pipeline and deliver its three stage artifacts from events.log. Call task_decompose exactly once with ' +
          'a reason and `children: [{ "templateRef": { "id": "log-analytics-pipeline", "version": 1 }, "decomposable": true }]` and ' +
          "nothing else: the runtime binds that child to the template, and the child then expands the template's recipe into the stage " +
          'children itself. Do not apply the template to yourself, do not enumerate the stage templates at your own level, and do not ' +
          'author a stage contract inline.',
        acceptanceCriteria: stageCriteria('pipeline'),
        requiredCapabilities: ['coordinate-tasks'],
        templateScope: [['logs']],
        constraints: LOG_CONSTRAINTS,
      })
      const pipelineTask = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).tasks.find(task => task.templateRef?.id === PIPELINE)
          expect(found).toBeDefined()
          return found!
        },
        { timeout: 1_200_000, interval: 500 },
      )
      expect(pipelineTask.templateRef?.version).toBe(1)
      const reportTask = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).tasks.find(
            task => task.templateRef?.id === REPORT && task.parentTaskId === pipelineTask.taskId,
          )
          expect(found).toBeDefined()
          return found!
        },
        { timeout: 1_200_000, interval: 500 },
      )
      // The report leaf runs before aggregate produced out/stats.json; the honest leaf reports the gap and fails the checker.
      await vi.waitFor(async () => expect((await h.task.taskIn(STORE, reportTask.taskId)).status).toBe('failed'), {
        timeout: 1_800_000,
        interval: 500,
      })
      const reportFailure = await (async () => {
        const snapshot = await h.snapshot(STORE)
        const run = snapshot.runs.filter(candidate => candidate.taskId === reportTask.taskId).at(-1)!
        const verdict = snapshot.evidence
          .filter(item => item.taskRunId === run.runId)
          .flatMap(item => item.verifierResults)
          .find(item => item.criterionId === 'report-result')
        const log =
          verdict?.logRef === undefined ? '' : readFileSync(join(h.workspace, 'evidence', verdict.logRef), 'utf8')
        return { run, verdict, log }
      })()
      expect(reportFailure.verdict, 'the report leaf must carry the command verifier verdict').toBeDefined()
      expect(reportFailure.verdict!.verifierId).toBe('command')
      expect(reportFailure.verdict!.status).toBe('fail')
      expect(reportFailure.log).toMatch(/missing/)
      await vi.waitFor(async () => expect((await h.task.taskIn(STORE, pipelineTask.taskId)).status).toBe('failed'), {
        timeout: 1_800_000,
        interval: 500,
      })
      const failure = await (async () => {
        const snapshot = await h.snapshot(STORE)
        const run = snapshot.runs.filter(candidate => candidate.taskId === pipelineTask.taskId).at(-1)!
        const verdict = snapshot.evidence
          .filter(item => item.taskRunId === run.runId)
          .flatMap(item => item.verifierResults)
          .find(item => item.criterionId === 'pipeline-result')!
        return { run, verdict }
      })()
      expect(failure.verdict.verifierId).toBe('command')
      expect(failure.verdict.status).toBe('fail')
      const runBeforeRepair = structuredClone(failure.run)
      // The failed review the automatic trigger would accept.
      await vi.waitFor(
        async () =>
          expect(
            (await h.snapshot(STORE)).reviews.some(
              review => review.taskId === pipelineTask.taskId && review.outcome === 'failed',
            ),
          ).toBe(true),
        { timeout: 120_000, interval: 250 },
      )

      // ── the review scan is the trigger: it spawns the reviewer, whose recorded diagnosis is consumed ──
      phase('supervisor')
      const scan = await scanFailedReviewSources(h.ctx, STORE, {
        source: { taskId: pipelineTask.taskId, runId: failure.run.runId },
      })
      expect(['started', 'existing']).toContain(scan.entries[0]?.result)
      const diagnosis = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === pipelineTask.taskId)
          expect(found).toBeDefined()
          // The reviewer's raw target vocabulary is its own; the authoritative target is the applied proposal below.
          expect(found!.proposals.length).toBeGreaterThanOrEqual(1)
          expect(found!.proposals.some(proposal => proposal.targetId.includes(PIPELINE))).toBe(true)
          return found!
        },
        { timeout: 120_000, interval: 250 },
      )
      const reviewerProposal = {
        targetType: diagnosis.proposals[0]!.targetType,
        targetId: diagnosis.proposals[0]!.targetId,
        rationale: diagnosis.proposals[0]!.rationale,
      }
      const supervisorSpawn = await vi.waitFor(
        () => {
          const spawn = h.spawns.find(candidate => candidate.name.startsWith('supervisor for '))
          expect(spawn).toBeDefined()
          return spawn!
        },
        { timeout: 120_000, interval: 250 },
      )
      const firstProposal = await vi.waitFor(
        async () => {
          const found = (await evolution.list()).find(item =>
            item.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`),
          )
          expect(found, JSON.stringify(requests.length)).toBeDefined()
          return found!
        },
        // The real supervisor may need a long reconnaissance; do not cut it off at ten minutes.
        { timeout: 1_800_000, interval: 3000 },
      )

      // ── the real supervisor runs the whole evolution chain ──
      phase('experiment')
      const applied = await vi.waitFor(
        async () => {
          const matches = (await evolution.list()).filter(item =>
            item.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`),
          )
          const current = matches.find(item => item.status === 'applied')
          expect(
            current?.status ?? matches.map(item => `${item.proposalId}:${item.status}`).join(','),
            JSON.stringify(
              (h.calls as readonly CallRecord[])
                .filter(call => call.name.startsWith('evolution_'))
                .map(call => [call.name, call.result?.text?.slice(0, 240)]),
            ),
          ).toBe('applied')
          return current!
        },
        // Four real-model side runs (observed failure + holdout, baseline + candidate) can take a long while.
        { timeout: 5_400_000, interval: 3000 },
      )
      expect(applied.targetType).toBe('task_definition')
      expect(applied.targetId).toBe(PIPELINE)
      const experiment = (await evolution.experiments(applied.proposalId)).at(-1)! as Parameters<
        typeof buildExperimentReport
      >[0]
      const report = buildExperimentReport(experiment)
      expect(report.verdict).toBe('fixed')
      const observedFailure = report.samples.find(sample => sample.role === 'observed-failure')
      expect(observedFailure).toBeDefined()
      expect(observedFailure!.baseline.outcome).toBe('failed')
      expect(observedFailure!.candidate.outcome).toBe('verified')

      // ── the publication approval, answered through the deployment's approval seam ──
      await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true), {
        timeout: 1_800_000,
        interval: 1000,
      })
      // A model may abandon an earlier proposal and re-propose; exactly one reaches applied.
      const diagnosisProposals = (await evolution.list()).filter(item =>
        item.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`),
      )
      expect(diagnosisProposals.filter(item => item.status === 'applied')).toHaveLength(1)

      // ── the library gained v2 while v1 stays mis-ordered; history is frozen ──
      const library = h.runtime.config.taskTemplatesRoot!
      const pipelineV1 = JSON.parse(readFileSync(join(library, `${PIPELINE}@1.json`), 'utf8'))
      const pipelineV2 = JSON.parse(readFileSync(join(library, `${PIPELINE}@2.json`), 'utf8'))
      const childIds = (template: { decomposition: { children: { templateRef: { id: string } }[] } }) =>
        template.decomposition.children.map(child => child.templateRef.id)
      const v1ChildIds = childIds(pipelineV1)
      const v2ChildIds = childIds(pipelineV2)
      // Publish the evaluated recipe exactly; the model may repair order, edges, or both.
      expect(childIds(pipelineV1)).toEqual(['parse-log-events', 'render-stats-report', 'aggregate-event-stats'])
      expect(childIds(pipelineV2)).toEqual(['parse-log-events', 'aggregate-event-stats', 'render-stats-report'])
      expect(pipelineV2).toEqual(JSON.parse(readFileSync(
        join(ledgerRoot, 'sandbox', applied.proposalId, 'task-templates', 'candidate', `${PIPELINE}@2.json`), 'utf8')))
      // The same comparison as a boolean for the evidence: the published library
      // file and the frozen candidate the experiment evaluated are the same content.
      const publishedEqualsFrozenCandidate = isDeepStrictEqual(pipelineV2, JSON.parse(readFileSync(
        join(ledgerRoot, 'sandbox', applied.proposalId, 'task-templates', 'candidate', `${PIPELINE}@2.json`), 'utf8')))
      expect(pipelineV1.contract.acceptanceCriteria).toEqual(pipelineV2.contract.acceptanceCriteria)
      const afterRepair = await h.snapshot(STORE)
      expect(afterRepair.runs.find(run => run.runId === failure.run.runId)).toEqual(runBeforeRepair)
      expect(afterRepair.tasks.find(task => task.taskId === pipelineTask.taskId)?.templateRef?.version).toBe(1)
      const kinds = ledgerKinds(ledgerRoot, applied.proposalId)
      const expectedSequence = [
        'proposed',
        'candidate',
        'prepared',
        'experiment_started',
        'gated',
        'decided',
        'commit_intent',
        'applied',
      ]
      let cursor = 0
      for (const kind of kinds) {
        if (kind === expectedSequence[cursor]) cursor += 1
      }
      expect(cursor).toBe(expectedSequence.length)

      // ── run 2: a NEW input against the repaired library must verify with version 2 ──
      phase('run2')
      writeFileSync(join(h.checkout, 'events.log'), CASE_2)
      rmSync(join(h.checkout, 'out'), { recursive: true, force: true })
      h.recordRequest(
        'Own the log-analytics pipeline for the new events.log and deliver its three stage artifacts through one coordinating child.',
        ROOT2,
      )
      const intake = await h.runtime.intakeRootContract(STORE2, ROOT2, {
        objective:
          'Own the log-analytics pipeline for the new events.log and deliver its three stage artifacts. Own the pipeline as one ' +
          'coordinating child taken from the `log-analytics-pipeline` template (do not enumerate the stage templates at your own level).',
        acceptanceCriteria: stageCriteria('pipeline'),
        requiredCapabilities: ['coordinate-tasks'],
        templateScope: [['logs']],
        constraints: LOG_CONSTRAINTS,
      })
      expect(intake.status).toBe('activated')
      h.userSays('begin', ROOT2)
      await vi.waitFor(
        async () => {
          const snapshot = await h.snapshot(STORE2)
          expect(
            snapshot.tasks.find(task => task.taskId === intake.taskId)?.status,
            JSON.stringify(snapshot.tasks.map(task => [task.templateRef?.id, task.status])),
          ).toBe('verified')
        },
        { timeout: 2_400_000, interval: 1000 },
      )
      const run2 = await h.snapshot(STORE2)
      const run2Pipeline = run2.tasks.filter(task => task.templateRef?.id === PIPELINE).at(-1)!
      expect(run2Pipeline.templateRef?.version).toBe(2)
      expect(run2Pipeline.status).toBe('verified')
      const run2Recipe = run2.proposals.all.find(item => item.kind !== 'root' &&
        item.identity.parentTaskId === run2Pipeline.taskId && item.status === 'admitted')!
      if (run2Recipe.kind === 'root' || run2Recipe.consumption?.kind === 'root') throw new Error('expected recipe batch')
      expect(run2Recipe.identity.templateRef).toEqual(run2Pipeline.templateRef)
      expect(run2Recipe.batch.map(child => child.contract.templateRef?.id)).toEqual(childIds(pipelineV2))
      expect(run2Recipe.batch.map(child => child.dependsOn)).toEqual(
        pipelineV2.decomposition.children.map((child: { dependsOn?: number[] }) => child.dependsOn ?? []))
      const run2ChildIds = run2Recipe.consumption!.childTaskIds
      expect(run2ChildIds).toHaveLength(3)
      const run2Edges = run2Recipe.batch.flatMap((child, index) => child.dependsOn.map(from =>
        ({ from: run2ChildIds[from], to: run2ChildIds[index] })))
      expect(run2.edges.filter(edge => run2ChildIds.includes(edge.from) && run2ChildIds.includes(edge.to))).toEqual(run2Edges)
      const expectation = expectedLog(CASE_2)
      const stats = JSON.parse(readFileSync(join(h.checkout, 'out/stats.json'), 'utf8'))
      const report2 = readFileSync(join(h.checkout, 'out/report.md'), 'utf8')
      expect(stats).toEqual(expectation.stats)
      const reportLines = new Set(report2.split('\n').map(line => line.trim()))
      for (const line of expectation.reportLines) expect(reportLines.has(line)).toBe(true)

      clearInterval(watchdog)

      // ── the assertions the evidence records ──
      const final = await h.snapshot(STORE)
      const chain = chainOf(h.calls as readonly CallRecord[], String(supervisorSpawn.sessionId), applied.proposalId)
      const templateRead = h.calls.find(call => call.sessionId === String(supervisorSpawn.sessionId) &&
        call.name === 'task_template_list' &&
        (call.args as { templateRef?: { id?: string } }).templateRef?.id === PIPELINE)
      const readTemplate = JSON.parse(templateRead?.result?.text ?? '{}')
      // The supervisor's read must return the production template itself — the same
      // id, version and whole decomposition as `log-analytics-pipeline@1.json`.
      const productionTemplateV1 = JSON.parse(readFileSync(join(library, `${PIPELINE}@1.json`), 'utf8'))
      const readProductionTemplate = readTemplate.template as
        | { id?: string; version?: number; decomposition?: unknown }
        | undefined
      const supervisorReadMatchesLibrary =
        readProductionTemplate?.id === productionTemplateV1.id &&
        readProductionTemplate?.version === productionTemplateV1.version &&
        isDeepStrictEqual(readProductionTemplate?.decomposition, productionTemplateV1.decomposition)
      const templateBound = final.tasks.filter(task => task.templateRef !== undefined).length

      // ── provider token usage, folded by the meter's own deriveTurnTokenUsage (shared with the failure path) ──
      const tokenUsage = computeTokenUsage()

      // ── the gate's detail, read back from the applied proposal and the report ──
      const appliedView = (await evolution.get(applied.proposalId)) as ProposalLike & { gate?: GateAnswersLike }
      const gate = buildGate(applied.proposalId, appliedView.gate, report.samples)

      const assertions = {
        reportLeafFailedOnRealChecker: reportFailure.verdict?.status === 'fail',
        pipelineCoordinatorFailedOnRealChecker: failure.verdict.status === 'fail',
        diagnosisProposesPipelineTemplate: diagnosis.proposals.some(proposal => proposal.targetId.includes(PIPELINE)),
        supervisorSessionStarted: String(supervisorSpawn.sessionId).length > 0,
        supervisorReadProductionTemplate: supervisorReadMatchesLibrary,
        supervisorRanEvolutionChain:
          chain.join('>') ===
          'evolution_propose>evolution_candidate>evolution_prepare>evolution_replay>evolution_gate>evolution_decide>evolution_apply',
        proposalApplied: appliedView.status === 'applied',
        exactlyOneProposalApplied: diagnosisProposals.filter(item => item.status === 'applied').length === 1,
        ledgerWalkedProposedToApplied: cursor === expectedSequence.length,
        experimentVerdictFixed: report.verdict === 'fixed',
        experimentBaselineFailedCandidateVerified:
          observedFailure?.baseline.outcome === 'failed' && observedFailure?.candidate.outcome === 'verified',
        publishedEqualsFrozenCandidate,
        libraryGainedV2AndKeptV1:
          pipelineV1.version === 1 && pipelineV2.version === 2 &&
          v1ChildIds.join('>') === 'parse-log-events>render-stats-report>aggregate-event-stats' &&
          v2ChildIds.join('>') === 'parse-log-events>aggregate-event-stats>render-stats-report',
        failedRunBindingFrozen:
          afterRepair.tasks.find(task => task.taskId === pipelineTask.taskId)?.templateRef?.version === 1,
        root1Terminal: ['failed', 'verified', 'cancelled'].includes((await h.task.taskIn(STORE, root1.taskId)).status),
        templateBoundTasksAtLeastThree: templateBound >= 3,
        everyRunBindsASkill: [...final.runs, ...run2.runs].every(run => (run.providerBinding?.skills.length ?? 0) > 0),
        noUnrelatedTemplatesInAnyRequest: requests.every(request => !request.text.includes('UNRELATED_DOMAIN_MARKER')),
        run2Verified: run2.tasks.find(task => task.taskId === intake.taskId)?.status === 'verified',
        run2PipelineBindsVersion2: run2Pipeline.templateRef?.version === 2,
        run2ConsumesVersion2Recipe: run2Recipe.identity.templateRef?.version === 2 && run2ChildIds.length === 3,
        run2StatsRecomputed:
          stats.total === expectation.stats.total && expectation.stats.total !== expectedLog(CASE_1).stats.total,
        tokenUsageRecorded:
          Object.values(tokenUsage.phases).every(phase => phase.measuredTurns > 0) &&
          tokenUsage.total.measuredTurns > 0 &&
          tokenUsage.total.inputTokens !== null &&
          tokenUsage.total.outputTokens !== null,
      }
      const wallSeconds = (Date.now() - startedAt) / 1000
      const evidence = {
        date: '2026-10-04',
        test: 'tests/integration/live-supervisor-repair.spec.ts',
        command: LIVE_COMMAND,
        model: api.model,
        result: Object.values(assertions).every(Boolean) ? 'passed' : 'failed',
        method:
          `A ${REVIEWER_MODE} run over the log-pipeline world: the mis-ordered log-analytics-pipeline v1 recipe ([parse, report, ` +
          'aggregate] with no dependsOn) runs the report stage before the aggregation stage produced out/stats.json, and the honest ' +
          'report leaf refuses to fabricate the input, failing the real checker; the coordinator then fails too because a mandatory ' +
          'child is unmet. The review scan spawns the reviewer, ' +
          'whose recorded diagnosis carries a task_definition proposal and is consumed into a supervisor hand-off; the supervisor is ' +
          'the real model and calls the real evolution chain (propose, candidate, prepare, replay, gate, decide, apply) with argument ' +
          'guidance only from the diagnosis text; the two-sided experiment replays a failed coordinator sample and a verified holdout ' +
          'through the real runtime under per-side frozen template libraries, with the real checker as the original acceptance; the ' +
          'publication approval is answered through the deployment approval seam; the publish appends log-analytics-pipeline@2.json and leaves ' +
          '@1 mis-ordered; and a second root run on CASE_2 verifies with the pipeline child bound to version 2. The repair is pure ' +
          'template CONTENT (recipe order and/or dependsOn; the criteria are byte-identical), so evolution_prepare never takes the ' +
          'criterion-repair branch. In all-real mode the Reviewer also uses the real model; in hybrid mode only its request is ' +
          'scripted. autoReview is pinned to ' +
          '"failed" for the failed-source path. The fixture mounts the production Reviewer delegation source and the Supervisor ' +
          'reads templates through task_template_list, with no separate template reader. The assemble filter keeps the evolution chain and ' +
          'task_review_agent only on the supervisor session. An idle session is nudged per session id — its own active run or the ' +
          'supervisor session, no pending call, no in-flight request, and globally stagnant progress for 180 seconds, capped at 12 ' +
          'nudges per session — with a ' +
          'neutral continuation that does not tutor the chain; a session with a pending tool call is never prompted. Two more ' +
          'fixture checks: the bash body detects unquoted paths outside the checkout and `..`/`~`/`$HOME` traversals (heredoc ' +
          'bodies and quoted spans are removed first, and only path-like absolute tokens count), and the honest report leaf checks ' +
          'first that out/stats.json is newer than out/events.json and makes the ' +
          'gap path a single task_submit_result so a replay worker reports the missing or stale input instead of exploring.',
        assertions,
        cases: [
          {
            name: 'log-pipeline-shared-template-repair',
            reviewPath: REVIEWER_MODE,
            failure: {
              report: {
                taskId: reportTask.taskId,
                templateId: REPORT,
                verdict: reportFailure.verdict?.status,
                exitCode: reportFailure.verdict?.exitCode,
                logRef: reportFailure.verdict?.logRef,
                logExcerpt: reportFailure.log.split('\n').slice(-8).join('\n'),
              },
              coordinator: {
                taskId: pipelineTask.taskId,
                templateId: PIPELINE,
                templateVersion: 1,
                verdict: failure.verdict.status,
                exitCode: failure.verdict.exitCode,
                logRef: failure.verdict.logRef,
              },
            },
            diagnosis: {
              diagnosisId: diagnosis.diagnosisId,
              observedFailure: diagnosis.observedFailure,
              localizedCause: diagnosis.localizedCause,
              scope: diagnosis.scope,
              reviewerProposal,
              proposals: diagnosis.proposals.map(item => [item.targetType, item.targetId]),
            },
            appliedProposalId: applied.proposalId,
            firstProposalId: firstProposal.proposalId,
            proposals: diagnosisProposals.map(item => ({
              proposalId: item.proposalId,
              status: item.status,
              targetType: item.targetType,
              targetId: item.targetId,
            })),
            ledgerKinds: kinds,
            experiment: {
              verdict: report.verdict,
              sampleCount: report.samples.length,
              totalSides: gate.totalSides,
              gatePassedSides: gate.gatePassedSides,
              samples: report.samples.map(sample => ({
                taskId: sample.taskId,
                role: sample.role,
                baseline: sample.baseline.outcome,
                candidate: sample.candidate.outcome,
              })),
            },
            gate,
            tokenUsage,
            library: {
              files: [`${PIPELINE}@1.json`, `${PIPELINE}@2.json`],
              publishedEqualsFrozenCandidate,
            },
            publishedRecipe: pipelineV2.decomposition,
            run2: {
              storeId: STORE2,
              taskId: intake.taskId,
              pipelineTaskId: run2Pipeline.taskId,
              pipelineVersion: run2Pipeline.templateRef?.version,
              recipeEdges: run2Edges,
              stats,
            },
            requestCounts,
            requestTotal: requests.length,
            nudgeCount: nudges,
            nudgeSessions: Object.fromEntries(nudgeCounts),
            wallSeconds,
            tree: {
              tasks: [...final.tasks, ...run2.tasks].map(task => ({
                taskId: task.taskId,
                parentTaskId: task.parentTaskId,
                depth: task.depth,
                templateRef: task.templateRef,
                status: task.status,
              })),
            },
          },
        ],
        limits:
          'One run on one machine: the experiment replays four real runs (a failed coordinator sample and a verified holdout, baseline ' +
          'and candidate), each of which authors its own artifacts, so the wall time is dominated by real-model latency and the run is ' +
          'sensitive to the supervisor naming the right sample ids and reconstructing the candidate mutation. The defect is a recipe ' +
          'mis-order (the "forgotten edge") whose determinism rests on the report leaf staying honest: a model that regenerates ' +
          'out/stats.json would mask the failure on either side, so the report template says its only input is the verified upstream ' +
          'artifact and forbids fabricating it. The Supervisor uses the real task_template_list entry through its recorded ' +
          'delegation; file tools stay checkout-only. The bash path check is an advisory fixture guard, not an OS sandbox. ' +
          'An idle supervision session is nudged by session id with a neutral continuation. autoReview is pinned ' +
          'to "failed"; the default "all" additionally reviews successful roots and excludes experiment replays. Use ' +
          'SINGULARITY_LIVE_REVIEWER_MODE=all-real for a real Reviewer.',
      }
      await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, snapshot: final }, null, 2) + '\n')
      writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')
      await writeFile('/tmp/singularity-live-supervisor-repair.json', JSON.stringify(evidence, null, 2) + '\n')
      evidenceWritten = true
      expect(Object.values(assertions).every(Boolean), JSON.stringify(assertions)).toBe(true)
      await h.dispose()
    } catch (error) {
      if (!evidenceWritten) await writeFailureEvidence(error)
      throw error
    }
  },
  10_800_000,
)

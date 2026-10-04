/**
 * Opt-in real-model supervisor repair for the xv6 locks world: run 1 really
 * executes the defective coordinating recipe (the completion child runs before
 * the fix child, honestly fails, and the coordinator fails with it), the
 * supervisor repairs the recipe through the full evolution chain behind the
 * human-approval seam, and a NEW root run then consumes the repaired version 2
 * recipe to a full `Score: 70/70`.
 *
 * The test prescribes no repair SHAPE (round 6's precedent: the shipped spec
 * dropped its `dependsOn` preset). Any version 2 the model publishes is accepted
 * as long as it is semantically correct — two leaves, the completion child
 * unable to start before the fix child verifies under the runtime's serial
 * index+dependency scheduling, criteria byte-identical to v1 — and as long as
 * the published bytes, the run-2 consumption and the grades agree with what was
 * actually evaluated.
 *
 * Everything except the model is the real deployment: the real TaskRuntime,
 * AgentRuntime, verifier registry (with the command verifier), evolution plane,
 * approval seam, ledger and experiment runner. The model is real for the
 * business workers, the parent coordinator, the supervisor and the experiment's
 * replayed sides.
 *
 * The reviewer is the one place this spec may script. The primary mode is
 * `all-real` (the reviewer is the real model too); `hybrid` answers only the
 * reviewer's request from the spec's queue, with the terminal sample ids and the
 * exact mutation, and every other decision stays real. The trigger is the same
 * `scanFailedReviewSources` scan either way.
 *
 * @module tests/integration/live-xv6-supervisor-repair
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
import { spawnSync } from 'node:child_process'
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
import { rootTaskStoreId, type TaskTemplate } from '../../task/src/index.ts'
import { disposeScriptedLoops, REAL_TOOLS, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'
import {
  ensureXv6ToolchainOnPath,
  prepareXv6Checkout,
  registerXv6RepairLibrary,
  resetLockLab,
  seedReferenceLockFix,
  xv6CheckoutTools,
  xv6Criteria,
  xv6ReferencePresent,
  xv6TestbedPresent,
  XV6_BASH_TIMEOUT_MS,
  XV6_COMPLETE_MARKER,
  XV6_COMPLETION_CRITERION_ID,
  XV6_COMPLETION_LEAF_ID,
  XV6_CONSTRAINTS,
  XV6_FIX_LEAF_ID,
  XV6_FIX_MARKER,
  XV6_LAB_CRITERION_ID,
  XV6_LAB_ID,
  XV6_VERIFY_TIMEOUT_MS,
} from '../support/xv6-locks.ts'

const enabled = process.env.SINGULARITY_LIVE_XV6_SUPERVISOR_REPAIR === '1'
const PROGRESS_PATH = '/tmp/singularity-live-xv6-supervisor-repair-progress.json'
const EVIDENCE_OVERRIDE = process.env.SINGULARITY_LIVE_XV6_EVIDENCE
/** Evidence output directory, or the file `SINGULARITY_LIVE_XV6_EVIDENCE` names (relative to it, or absolute). */
const EVIDENCE_DIR = new URL('../../docs/', import.meta.url)
const EVIDENCE_PATH = EVIDENCE_OVERRIDE === undefined || EVIDENCE_OVERRIDE === ''
  ? new URL('2026-10-04-live-xv6-supervisor-repair.json', EVIDENCE_DIR)
  : new URL(EVIDENCE_OVERRIDE, EVIDENCE_DIR)
const REQUEST_ALLOWANCE = 500
/** `hybrid` scripts only the reviewer's diagnosis; `all-real` forwards the reviewer to the gateway too. */
const REVIEWER_MODE = process.env.SINGULARITY_LIVE_REVIEWER_MODE === 'hybrid' ? 'hybrid' : 'all-real'
const LIVE_COMMAND = 'NODE_USE_ENV_PROXY=1 SINGULARITY_LIVE_XV6_SUPERVISOR_REPAIR=1' +
  (REVIEWER_MODE === 'hybrid' ? ' SINGULARITY_LIVE_REVIEWER_MODE=hybrid' : '') +
  (EVIDENCE_OVERRIDE === undefined || EVIDENCE_OVERRIDE === ''
    ? ''
    : ` SINGULARITY_LIVE_XV6_EVIDENCE=${EVIDENCE_OVERRIDE}`) +
  ' pnpm exec vitest run --project integration packages/singularity/tests/integration/live-xv6-supervisor-repair.spec.ts'

// This host reaches the model gateway only through the configured HTTPS proxy, and Node 22's fetch ignores the proxy
// environment unless the process opted in at startup. Fail fast with the exact fix instead of eight retrying timeouts.
if (
  enabled &&
  (process.env.HTTPS_PROXY ?? process.env.https_proxy) !== undefined &&
  process.env.NODE_USE_ENV_PROXY !== '1'
) {
  throw new Error(
    'the live model gateway is reachable only through the configured HTTPS proxy, which Node fetch honours only when the ' +
      'process starts with NODE_USE_ENV_PROXY=1: relaunch with `NODE_USE_ENV_PROXY=1 SINGULARITY_LIVE_XV6_SUPERVISOR_REPAIR=1 ' +
      'pnpm exec vitest run --project integration packages/singularity/tests/integration/live-xv6-supervisor-repair.spec.ts`',
  )
}

const ROOT = 's-root'
const OPERATOR = 's-operator'
const ROOT2 = 's-root2'
const STORE = rootTaskStoreId(ROOT)
const STORE2 = rootTaskStoreId(ROOT2)

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
  try {
    await disposeScriptedLoops()
  } finally {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
}, 600_000)

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-xv6-supervisor-repair-'))
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
  get(proposalId: string): Promise<ProposalLike & { gate?: GateAnswersLike }>
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
  readonly measuredTurns: number
  readonly turnsWithoutUsage: number
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
 * terminal tasks the two-sided experiment must replay — the failed coordinating
 * run (whose replay re-expands the recipe) and the verified fix leaf (the
 * untouched holdout). It carries a complete candidate mutation whose ONLY change
 * is the missing `dependsOn: [1]` edge.
 */
async function reviewerReply(
  h: ScriptedLoop,
  storeId: string,
  reviewerSessionId: string,
  library: string,
): Promise<string> {
  const snapshot = await h.snapshot(storeId)
  const failedCoordinator = snapshot.tasks.find(task => task.status === 'failed' && task.templateRef?.id === XV6_LAB_ID)
  const sample = failedCoordinator?.taskId ?? ''
  const holdout = snapshot.tasks.find(task => task.status === 'verified' && task.templateRef?.id === XV6_FIX_LEAF_ID)?.taskId ?? ''
  const diagnosisId = `review-agent-${reviewerSessionId}`
  const templateV1 = JSON.parse(readFileSync(join(library, `${XV6_LAB_ID}@1.json`), 'utf8')) as {
    version: number
    decomposition: { reason: string; children: { templateRef: { id: string } }[] }
    [key: string]: unknown
  }
  const children = templateV1.decomposition.children.map(child =>
    child.templateRef.id === XV6_COMPLETION_LEAF_ID ? { ...child, dependsOn: [1] } : { ...child })
  const candidate = {
    ...templateV1,
    version: 2,
    decomposition: { ...templateV1.decomposition, children },
  }
  const mutation = JSON.stringify({ template: candidate })
  const diagnosis = {
    observation:
      'the xv6-lock-lab-optimization coordinator failed because its recipe started the completion child (index 0) before the ' +
      `fix child (index 1) had written ${XV6_FIX_MARKER}: the completion criterion failed with the marker missing, and the ` +
      'honest completion leaf refused to fabricate the missing artifacts.',
    conclusion:
      `the xv6-lock-lab-optimization recipe is missing one dependency edge: the completion child needs dependsOn [1] so it ` +
      'starts only after the fix child verifies. Add ONLY the edge — do NOT reorder the children. Repair it through the evolution ' +
      `chain: evolution_propose {fromDiagnosis:{diagnosisId:"${diagnosisId}",proposalIndex:0}, ` +
      `sourceRefs:["diagnosis:${diagnosisId}"], proposalId, level:"L2", baseVersion:"1"}, then evolution_candidate with ` +
      `versionSet {"${XV6_LAB_ID}":"2"} and mutationJson set to exactly the JSON below (a complete TaskTemplate whose children keep ` +
      'the [completion, fix] order and whose completion child gains dependsOn [1]; the criteria are unchanged), then ' +
      `evolution_prepare, evolution_replay with taskIds ["${sample}"] and holdoutTaskIds ["${holdout}"], evolution_gate citing ` +
      `the report path, evolution_decide PROMOTE, and evolution_apply. The mutationJson is: ${mutation}`,
    confidence: 'high',
    proposals: [
      {
        targetType: 'task_definition',
        targetId: XV6_LAB_ID,
        rationale:
          `adding dependsOn [1] to the completion child makes it start only after the fix child has written ${XV6_FIX_MARKER}; ` +
          `evaluate it with taskIds ["${sample}"] and holdoutTaskIds ["${holdout}"]`,
      },
    ],
  }
  return '```json\n' + JSON.stringify(diagnosis) + '\n```'
}

const available = xv6TestbedPresent() && xv6ReferencePresent()
// The spec's own grader re-runs (and every tool body) spawn children that inherit
// `process.env`, so the user-space RISC-V toolchain must be on PATH before the run.
if (available) ensureXv6ToolchainOnPath()
it.skipIf(!enabled || !available)(
  'repairs a mis-ordered xv6 locks recipe through the real supervisor chain and grades a new run 70/70',
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
      // The human gates are answered through the deployment's own approval seam, not by a model.
      approvalAnswer: () => 'allowed-once',
      verifyTimeoutMs: XV6_VERIFY_TIMEOUT_MS,
      // The grader itself takes minutes under TCG; the shell bodies only write markers.
      tools: xv6CheckoutTools(),
    })
    await h.ctx.plugin(TokenMeter, {})
    // Mount the production delegation read seam; the fixture does not load the agent plugin.
    h.ctx.effect(() => h.ctx.singularityContext.registerReviewerBindingSource(reviewerBindingSource()))
    // The verifier uses the declared xv6-run budget.
    expect((h.ctx as unknown as { taskRuntime: { verifyTimeoutMs: number } }).taskRuntime.verifyTimeoutMs).toBe(
      XV6_VERIFY_TIMEOUT_MS,
    )
    // The live request presents only executable tools, per role: the supervisor keeps the evolution chain and its
    // read-only investigation tools; every other session keeps the business surface (no evolution chain, no focused review).
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

    const evolution = h.ctx.evolution as unknown as EvolutionApi
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
        process.stderr.write('[live] reviewer diagnosis scripted (hybrid)\n')
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
      const cacheReadTokens = result.usage.prompt_cache_hit_tokens ?? result.usage.prompt_tokens_details?.cached_tokens
      const inputTokens = result.usage.prompt_cache_miss_tokens
        ?? (typeof cacheReadTokens === 'number' ? result.usage.prompt_tokens - cacheReadTokens : undefined)
      // Carry through only buckets the gateway itself reported: `total_tokens`
      // is the provider's own exact total (the meter needs it to prove usage
      // when the route reports no cache-write bucket), and a cache-write counter
      // is included only when the route returns one — never invented as zero.
      const cacheWriteTokens = result.usage.prompt_cache_write_tokens
        ?? result.usage.prompt_cache_creation_tokens
        ?? result.usage.prompt_tokens_details?.cache_write_tokens
        ?? result.usage.prompt_tokens_details?.cache_creation_tokens
      // An aggregate prompt total alone cannot identify the uncached bucket.
      // Leave usage unavailable instead of pretending that unreported cache is zero.
      if (typeof inputTokens === 'number') {
        yield {
          type: 'usage',
          usage: { inputTokens,
            outputTokens: result.usage.completion_tokens,
            ...typeof cacheReadTokens === 'number' ? { cacheReadTokens } : {},
            ...typeof result.usage.total_tokens === 'number' ? { totalTokens: result.usage.total_tokens } : {},
            ...typeof cacheWriteTokens === 'number' ? { cacheWriteTokens } : {} },
        }
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
          const turnPhase = sessionPhases[phaseCursor] ?? sessionPhases.at(-1) ?? 'unknown'
          phaseCursor += turn.requests
          if (turn.usage === undefined) {
            unmeasured += 1
            allUnmeasured += 1
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
          'completed no turn renders null buckets (its unreportedBuckets names them) and is listed in phasesWithoutCompletedTurns; ' +
          'numeric buckets sum the measured turns only, so turnsWithoutUsage greater than zero makes the full cost unknown',
        phases: tokenPhases,
        phasesWithoutCompletedTurns,
        total: tallyTokens(allUsages, allUnmeasured),
        sessions: tokenSessions,
      }
    }

    /** One grader re-run outside the runtime, with the xv6 bash bound. */
    const regrade = (cwd: string) => {
      const result = spawnSync('bash', ['checks/verify.sh', 'all'], {
        cwd,
        encoding: 'utf8',
        timeout: XV6_BASH_TIMEOUT_MS,
        maxBuffer: 128 * 1024 * 1024,
      })
      const output = String(result.stdout ?? '') + String(result.stderr ?? '')
      const score = /Score: [0-9]+\/[0-9]+/.exec(output)?.[0] ?? 'Score: ?/?'
      const numeric = Number(/Score: ([0-9]+)\//.exec(score)?.[1] ?? Number.NaN)
      return { status: result.status ?? null, score, numeric, output }
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
        const view = await evolution.get(proposal.proposalId)
        if (view.gate === undefined) continue
        const judged = experimentReports.filter(item => item.proposalId === proposal.proposalId).at(-1)?.report
        gate = buildGate(proposal.proposalId, view.gate, judged?.samples ?? [])
        break
      }
      const tokenUsage = computeTokenUsage()
      const assertions = {
        regressionLeafFailedOnRealChecker: tasks.find(task => task.templateRef?.id === XV6_COMPLETION_LEAF_ID)?.status === 'failed',
        coordinatorFailedOnRealChecker: tasks.find(task => task.templateRef?.id === XV6_LAB_ID)?.status === 'failed',
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
        test: 'tests/integration/live-xv6-supervisor-repair.spec.ts',
        command: LIVE_COMMAND,
        model: api.model,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
        method: `A ${REVIEWER_MODE} run that threw before its terminal assertions; this document is the live state at failure.`,
        assertions,
        cases: [
          {
            name: 'xv6-locks-shared-recipe-repair',
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
      await writeFile('/tmp/singularity-live-xv6-supervisor-repair.json', JSON.stringify(document, null, 2) + '\n')
    }

    try {
      prepareXv6Checkout(h.checkout)
      seedReferenceLockFix(h.checkout)
      resetLockLab(h.checkout)
      // The defective world: the coordinator's recipe lists the completion child at
      // index 0 with no edge, so it starts before the fix child. `gapEvidence` makes
      // the honest failure name the missing artifact in the criterion log.
      await registerXv6RepairLibrary(h.runtime, { distractors: 30, gapEvidence: true })
      const library = h.runtime.config.taskTemplatesRoot!

      // ── run 1: the defective recipe fails the completion leaf, then the coordinator ──
      const root1 = await h.begin({
        objective:
          'Deliver the completed xv6 locks lab over the pre-seeded reference checkout and drive the lock optimization to a ' +
          'full grade. Own the effort as exactly one coordinating child: call task_decompose exactly once with a reason and ' +
          '`children: [{ "templateRef": { "id": "xv6-lock-lab-optimization", "version": 1 }, "decomposable": true }]`, and ' +
          'nothing else. The runtime binds that child to the template, and the child expands the template recipe into the ' +
          'fix and completion children itself, so do NOT enumerate those leaves at your own level and do NOT pass a ' +
          'top-level templateRef (that would replace your own decomposition with the recipe leaves). Do not author a stage ' +
          'artifact yourself.',
        acceptanceCriteria: xv6Criteria('all'),
        requiredCapabilities: ['coordinate-tasks'],
        templateScope: [['kernel']],
        constraints: [
          ...XV6_CONSTRAINTS,
          'Decompose exactly once: call task_decompose with a `reason` plus `children: [{ "templateRef": { "id": ' +
            '"xv6-lock-lab-optimization", "version": 1 }, "decomposable": true }]`. Never pass a top-level `templateRef` ' +
            'from the root, and never enumerate the fix/completion leaves at your own level — the coordinating child ' +
            'expands that recipe into those grandchildren.',
          'Every worker (including you) must keep calling tools until its result is submitted: never end a turn with ' +
            'plain text while your task is active — build, grade with `bash checks/verify.sh <stage>`, and finish with ' +
            'task_submit_result.',
        ],
      })
      const coordinatorTask = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).tasks.find(
            task => task.templateRef?.id === XV6_LAB_ID && task.templateRef.version === 1,
          )
          expect(found).toBeDefined()
          return found!
        },
        { timeout: 1_800_000, interval: 1000 },
      )
      const completionLeaf = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).tasks.find(
            task => task.parentTaskId === coordinatorTask.taskId && task.templateRef?.id === XV6_COMPLETION_LEAF_ID,
          )
          expect(found).toBeDefined()
          return found!
        },
        { timeout: 1_800_000, interval: 1000 },
      )
      const fixLeaf = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).tasks.find(
            task => task.parentTaskId === coordinatorTask.taskId && task.templateRef?.id === XV6_FIX_LEAF_ID,
          )
          expect(found).toBeDefined()
          return found!
        },
        { timeout: 1_800_000, interval: 1000 },
      )
      // The completion child runs first on the unfixed recipe and honestly fails the real checker.
      await vi.waitFor(async () => expect((await h.task.taskIn(STORE, completionLeaf.taskId)).status).toBe('failed'), {
        timeout: 1_800_000,
        interval: 1000,
      })
      const regressionFailure = await (async () => {
        const snapshot = await h.snapshot(STORE)
        const run = snapshot.runs.filter(candidate => candidate.taskId === completionLeaf.taskId).at(-1)!
        const verdict = snapshot.evidence
          .filter(item => item.taskRunId === run.runId)
          .flatMap(item => item.verifierResults)
          .find(item => item.criterionId === XV6_COMPLETION_CRITERION_ID)
        const log = verdict?.logRef === undefined ? '' : readFileSync(join(h.workspace, 'evidence', verdict.logRef), 'utf8')
        return { run, verdict, log }
      })()
      await vi.waitFor(async () => expect((await h.task.taskIn(STORE, fixLeaf.taskId)).status).toBe('verified'), {
        timeout: 1_800_000,
        interval: 1000,
      })
      await vi.waitFor(async () => expect((await h.task.taskIn(STORE, coordinatorTask.taskId)).status).toBe('failed'), {
        timeout: 1_800_000,
        interval: 1000,
      })
      const coordinatorFailure = await (async () => {
        const snapshot = await h.snapshot(STORE)
        const run = snapshot.runs.filter(candidate => candidate.taskId === coordinatorTask.taskId).at(-1)!
        const verdict = snapshot.evidence
          .filter(item => item.taskRunId === run.runId)
          .flatMap(item => item.verifierResults)
          .find(item => item.criterionId === XV6_LAB_CRITERION_ID)!
        return { run, verdict }
      })()
      const runBeforeRepair = structuredClone(coordinatorFailure.run)
      // The root may submit (and fail its own grade) or simply end; either way its run is terminal once its child failed.
      await vi.waitFor(
        async () =>
          expect(['failed', 'verified', 'cancelled']).toContain(
            (await h.task.taskIn(STORE, root1.taskId)).status,
          ),
        { timeout: 1_800_000, interval: 1000 },
      )
      // The spec re-runs the full grader itself, outside the runtime, and records the
      // score the defective order really earned (the missing time.txt loses one point).
      const run1Grade = regrade(h.checkout)
      process.stderr.write(`[live] run1 regrade: ${run1Grade.score}\n`)

      // ── the frozen experiment input is clean ────────────────────────────────
      resetLockLab(h.checkout)

      // ── the review produces the diagnosis and delivers it to the owner ──────
      await vi.waitFor(
        async () =>
          expect(
            (await h.snapshot(STORE)).reviews.some(
              review => review.taskId === coordinatorTask.taskId && review.outcome === 'failed',
            ),
          ).toBe(true),
        { timeout: 120_000, interval: 250 },
      )
      phase('supervisor')
      const scan = await scanFailedReviewSources(h.ctx, STORE, {
        source: { taskId: coordinatorTask.taskId, runId: coordinatorFailure.run.runId },
      })
      expect(['started', 'existing']).toContain(scan.entries[0]?.result)
      const diagnosis = await vi.waitFor(
        async () => {
          const found = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === coordinatorTask.taskId)
          expect(found).toBeDefined()
          // The reviewer's raw target vocabulary is its own; the authoritative target is the applied proposal below.
          expect(found!.proposals.length).toBeGreaterThanOrEqual(1)
          expect(found!.proposals.some(proposal => proposal.targetId.includes(XV6_LAB_ID))).toBe(true)
          return found!
        },
        { timeout: 120_000, interval: 250 },
      )
      const reviewerProposal = {
        targetType: diagnosis.proposals[0]!.targetType,
        targetId: diagnosis.proposals[0]!.targetId,
        rationale: diagnosis.proposals[0]!.rationale,
      }

      // ── the real supervisor runs the whole evolution chain ──────────────────
      const supervisorSpawn = await vi.waitFor(
        () => {
          const spawn = h.spawns.find(candidate => candidate.name.startsWith('supervisor for '))
          expect(spawn).toBeDefined()
          return spawn!
        },
        { timeout: 1_800_000, interval: 3000 },
      )
      // The supervisor's own first proposal marks the boundary between the two
      // token phases: everything up to here (the reviewer) is `supervisor`, and
      // the chain + experiment that follow are `experiment`.
      const firstProposal = await vi.waitFor(
        async () => {
          const found = (await evolution.list()).find(item =>
            item.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`),
          )
          expect(found, JSON.stringify(requests.length)).toBeDefined()
          return found!
        },
        { timeout: 1_800_000, interval: 3000 },
      )
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
      expect(applied.targetId).toBe(XV6_LAB_ID)
      const experiment = (await evolution.experiments(applied.proposalId)).at(-1)! as Parameters<
        typeof buildExperimentReport
      >[0]
      const report = buildExperimentReport(experiment)
      expect(report.verdict).toBe('fixed')
      const observedFailure = report.samples.find(sample => sample.role === 'observed-failure')
      expect(observedFailure).toBeDefined()
      expect(observedFailure!.baseline.outcome).toBe('failed')
      expect(observedFailure!.candidate.outcome).toBe('verified')
      const holdout = report.samples.find(sample => sample.role === 'holdout')
      expect(holdout).toBeDefined()

      // ── the human gates, answered through the deployment's approval seam ─────
      await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_decide')).toBe(true), {
        timeout: 1_800_000,
        interval: 1000,
      })
      await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true), {
        timeout: 1_800_000,
        interval: 1000,
      })
      // A model may abandon an earlier proposal and re-propose; exactly one reaches applied.
      const diagnosisProposals = (await evolution.list()).filter(item =>
        item.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`),
      )
      expect(diagnosisProposals.filter(item => item.status === 'applied')).toHaveLength(1)

      // ── the library gained v2 while v1 stays defective; history is frozen ───
      const v1 = JSON.parse(readFileSync(join(library, `${XV6_LAB_ID}@1.json`), 'utf8'))
      const v2 = JSON.parse(readFileSync(join(library, `${XV6_LAB_ID}@2.json`), 'utf8'))
      const childIds = (template: { decomposition: { children: { templateRef: { id: string } }[] } }) =>
        template.decomposition.children.map(child => child.templateRef.id)
      const childDeps = (template: { decomposition: { children: { dependsOn?: number[] }[] } }) =>
        template.decomposition.children.map(child => child.dependsOn ?? [])
      /**
       * The scheduling rule the runtime really implements (`task-runtime/src/orchestration/child.ts`
       * `driveRounds`): one independent child starts per round in array order, and a child starts
       * only once every position in its `dependsOn` has verified. With exactly two children that
       * makes "the completion child can never start before the fix child verifies" equivalent to
       * "it is ordered after the fix child, or gated on it".
       */
      const completionNotBeforeFix = (ids: readonly string[], deps: readonly (readonly number[])[]) => {
        const completionIndex = ids.indexOf(XV6_COMPLETION_LEAF_ID)
        const fixIndex = ids.indexOf(XV6_FIX_LEAF_ID)
        if (completionIndex < 0 || fixIndex < 0 || completionIndex === fixIndex) return false
        return fixIndex < completionIndex || (deps[completionIndex] ?? []).includes(fixIndex)
      }
      // v1 is the frozen defect, and it stays exactly as published.
      expect(childIds(v1)).toEqual([XV6_COMPLETION_LEAF_ID, XV6_FIX_LEAF_ID])
      expect(childDeps(v1)).toEqual([[], []])
      expect(v1.version).toBe(1)
      expect(completionNotBeforeFix(childIds(v1), childDeps(v1))).toBe(false)
      // v2 is the repair the model chose. Its SHAPE is not prescribed (round 6's
      // precedent: the test prescribes no dependency form, only semantics): the
      // recipe must compose exactly the two leaves and must gate the completion
      // child behind the fix child, while its criteria stay byte-identical.
      expect(v2.version).toBe(2)
      expect(childIds(v2)).toHaveLength(2)
      expect(new Set(childIds(v2))).toEqual(new Set([XV6_FIX_LEAF_ID, XV6_COMPLETION_LEAF_ID]))
      expect(v1.contract.acceptanceCriteria).toEqual(v2.contract.acceptanceCriteria)
      const publishedRecipeGatesCompletion = completionNotBeforeFix(childIds(v2), childDeps(v2))
      expect(publishedRecipeGatesCompletion).toBe(true)
      // Record the published edges as they are, whatever shape they have (no
      // non-empty requirement): the only structural demand is that every edge is
      // a well-formed reference to the sibling.
      const publishedRecipeEdges = childDeps(v2)
      const publishedEdgeSet = publishedRecipeEdges.flatMap((deps, to) =>
        deps.map(from => ({ from: childIds(v2)[from], to: childIds(v2)[to] })))
      const nonEmptyDependsOnPublishedLive = publishedRecipeEdges.some(deps => deps.length > 0)
      const publishedRecipeEdgesRecorded =
        publishedRecipeEdges.length === 2 &&
        publishedRecipeEdges.every((deps, to) =>
          deps.every(from => Number.isInteger(from) && from >= 0 && from < 2 && from !== to))
      const publishedEqualsFrozenCandidate = isDeepStrictEqual(
        v2,
        JSON.parse(readFileSync(join(ledgerRoot, 'sandbox', applied.proposalId, 'task-templates', 'candidate', `${XV6_LAB_ID}@2.json`), 'utf8')),
      )
      expect(publishedEqualsFrozenCandidate).toBe(true)
      const afterRepair = await h.snapshot(STORE)
      expect(afterRepair.runs.find(run => run.runId === coordinatorFailure.run.runId)).toEqual(runBeforeRepair)
      expect(afterRepair.tasks.find(task => task.taskId === coordinatorTask.taskId)?.templateRef?.version).toBe(1)
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

      // ── run 2: a NEW root run against the repaired library must grade 70/70 ──
      phase('run2')
      // The first root run still holds the shared env, so the second root runs in
      // its own copy of the same checkout (reference locks seeded, markers reset).
      const checkout2 = join(h.workspace, 'env2')
      mkdirSync(checkout2, { recursive: true })
      prepareXv6Checkout(checkout2)
      seedReferenceLockFix(checkout2)
      resetLockLab(checkout2)
      h.runtime.sessionWorkspaces.set(ROOT2, checkout2)
      const run2Objective =
        'Own the xv6 locks lab optimization for the pre-seeded reference checkout and drive it to a full grade through one ' +
        'coordinating child taken from the `xv6-lock-lab-optimization` template (the newest version from task_template_list). ' +
        'Call task_decompose exactly once with a reason and `children: [{ "templateRef": <that reference>, "decomposable": true }]`, ' +
        'and nothing else: the child expands the template recipe itself. Do not enumerate the fix/completion leaves at your own ' +
        'level, and do not author a stage artifact yourself.'
      h.recordRequest(run2Objective, ROOT2)
      const intake = await h.runtime.intakeRootContract(STORE2, ROOT2, {
        objective: run2Objective,
        acceptanceCriteria: [
          {
            criterionId: 'root-goal',
            description: 'the repaired recipe delivered the completion artifacts',
            command: `bash -c 'test -f ${XV6_COMPLETE_MARKER}'`,
          },
        ],
        requiredCapabilities: ['coordinate-tasks'],
        templateScope: [['kernel']],
        constraints: [
          ...XV6_CONSTRAINTS,
          'The lab is graded by the lab\'s own grader and by the independent checker `bash checks/verify.sh <stage>`. ' +
            'Do not reimplement, bypass or weaken either judge, and do not author the fix or completion artifacts at the root.',
        ],
      })
      expect(intake.status).toBe('activated')
      h.userSays('begin', ROOT2)
      await vi.waitFor(
        async () => {
          const snapshot = await h.snapshot(STORE2)
          expect(
            snapshot.tasks.find(task => task.taskId === intake.taskId)?.status,
            JSON.stringify(snapshot.tasks.map(task => [task.templateRef?.id, task.templateRef?.version, task.status])),
          ).toBe('verified')
        },
        { timeout: 2_400_000, interval: 1000 },
      )
      const run2 = await h.snapshot(STORE2)
      const run2Coordinator = run2.tasks.filter(task => task.templateRef?.id === XV6_LAB_ID).at(-1)!
      const run2Recipe = run2.proposals.all.find(item => item.kind !== 'root' &&
        item.identity.parentTaskId === run2Coordinator.taskId && item.status === 'admitted')!
      if (run2Recipe.kind === 'root' || run2Recipe.consumption?.kind === 'root') throw new Error('expected a recipe batch')
      const run2ChildIds = run2Recipe.consumption!.childTaskIds
      const run2AdmittedDeps = run2Recipe.batch.map(child => [...child.dependsOn])
      // The template leaf each admitted member is bound to, in batch order — what the
      // semantic gate below reads the same way it reads the published recipe.
      const run2LeafIds = run2ChildIds.map(taskId =>
        run2.tasks.find(task => task.taskId === taskId)?.templateRef?.id ?? '')
      const run2Edges = run2Recipe.batch.flatMap((child, index) =>
        child.dependsOn.map(from => ({ from: run2ChildIds[from], to: run2ChildIds[index] })))
      const run2GradeVerdict = (() => {
        const run = run2.runs.filter(candidate => candidate.taskId === run2Coordinator.taskId).at(-1)
        const verdict = run2.evidence
          .filter(item => item.taskRunId === run?.runId)
          .flatMap(item => item.verifierResults)
          .find(item => item.criterionId === XV6_LAB_CRITERION_ID)
        const log = verdict?.logRef === undefined ? '' : readFileSync(join(h.workspace, 'evidence', verdict.logRef), 'utf8')
        return { verdict, log }
      })()
      const run2Grade = regrade(checkout2)
      process.stderr.write(`[live] run2 regrade: ${run2Grade.score}\n`)

      // ── the assertions the evidence records ─────────────────────────────────
      const final = await h.snapshot(STORE)
      const chain = chainOf(h.calls as readonly CallRecord[], String(supervisorSpawn.sessionId), applied.proposalId)
      // The supervisor's exact read must return the production template itself — the
      // same id, version and whole decomposition as `xv6-lock-lab-optimization@1.json`.
      // Scan the results rather than the arguments: an exact read is any answer that
      // carries the whole `template` object for this id.
      const productionTemplateV1 = JSON.parse(readFileSync(join(library, `${XV6_LAB_ID}@1.json`), 'utf8'))
      const readProductionTemplate = (() => {
        for (const call of [...(h.calls as readonly CallRecord[])].reverse()) {
          if (call.sessionId !== String(supervisorSpawn.sessionId) || call.name !== 'task_template_list') continue
          const text = call.result?.text ?? ''
          if (!text.startsWith('{')) continue
          try {
            const parsed = JSON.parse(text) as
              { template?: { id?: string; version?: number; decomposition?: unknown } }
            if (parsed.template?.id === XV6_LAB_ID) return parsed.template
          } catch {
            /* a non-JSON answer is not an exact read */
          }
        }
        return undefined
      })()
      const supervisorReadMatchesLibrary =
        readProductionTemplate?.id === productionTemplateV1.id &&
        readProductionTemplate?.version === productionTemplateV1.version &&
        isDeepStrictEqual(readProductionTemplate?.decomposition, productionTemplateV1.decomposition)
      const templateBound = final.tasks.filter(task => task.templateRef !== undefined).length
      const tokenUsage = computeTokenUsage()
      const appliedView = await evolution.get(applied.proposalId)
      const gate = buildGate(applied.proposalId, appliedView.gate, report.samples)

      const run1ScoreFull = run1Grade.score === 'Score: 70/70'
      const run2ScoreFull = run2Grade.status === 0 && run2Grade.score === 'Score: 70/70'
      const assertions = {
        regressionLeafFailedOnRealChecker: regressionFailure.verdict?.status === 'fail',
        run1RegressionLeafGapVerdict:
          regressionFailure.verdict?.verifierId === 'command' &&
          regressionFailure.verdict?.status === 'fail' &&
          regressionFailure.log.includes('missing') &&
          regressionFailure.log.includes(XV6_FIX_MARKER),
        coordinatorFailedOnRealChecker: coordinatorFailure.verdict.status === 'fail',
        diagnosisProposesLockLabTemplate: diagnosis.proposals.some(proposal => proposal.targetId.includes(XV6_LAB_ID)),
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
        experimentHoldoutVerifiedBothSides:
          holdout?.baseline.outcome === 'verified' && holdout?.candidate.outcome === 'verified',
        publishedEqualsFrozenCandidate,
        libraryGainedV2AndKeptV1:
          v1.version === 1 && v2.version === 2 &&
          childIds(v1).join('>') === `${XV6_COMPLETION_LEAF_ID}>${XV6_FIX_LEAF_ID}` &&
          childDeps(v1).every(deps => deps.length === 0),
        publishedRecipeGatesCompletion,
        publishedRecipeEdgesRecorded,
        failedRunBindingFrozen:
          afterRepair.tasks.find(task => task.taskId === coordinatorTask.taskId)?.templateRef?.version === 1 &&
          isDeepStrictEqual(afterRepair.runs.find(run => run.runId === runBeforeRepair.runId), runBeforeRepair),
        root1Terminal: ['failed', 'verified', 'cancelled'].includes((await h.task.taskIn(STORE, root1.taskId)).status),
        templateBoundTasksAtLeastThree: templateBound >= 3,
        everyRunBindsASkill: [...final.runs, ...run2.runs].every(run => (run.providerBinding?.skills.length ?? 0) > 0),
        noUnrelatedTemplatesInAnyRequest: requests.every(request => !request.text.includes('UNRELATED_DOMAIN_MARKER')),
        run1GraderNotFull: !run1ScoreFull,
        run2GraderFull: run2ScoreFull,
        graderScoreImproved: Number.isFinite(run1Grade.numeric) && Number.isFinite(run2Grade.numeric) &&
          run2Grade.numeric > run1Grade.numeric,
        run2Verified: run2.tasks.find(task => task.taskId === intake.taskId)?.status === 'verified',
        run2CoordinatorBindsVersion2: run2Coordinator.templateRef?.version === 2,
        run2ConsumesVersion2Recipe:
          run2Recipe.identity.templateRef?.version === 2 &&
          run2ChildIds.length === 2 &&
          new Set(run2LeafIds).size === 2 &&
          completionNotBeforeFix(run2LeafIds, run2AdmittedDeps),
        run2ConsumesPublishedEdgesExactly:
          JSON.stringify(run2AdmittedDeps) === JSON.stringify(publishedRecipeEdges) &&
          JSON.stringify(run2.edges
            .filter(edge => run2ChildIds.includes(edge.from) && run2ChildIds.includes(edge.to))
            .map(edge => `${edge.from}->${edge.to}`).sort()) ===
            JSON.stringify(run2Edges.map(edge => `${edge.from}->${edge.to}`).sort()),
        run2GradeFull: run2GradeVerdict.verdict?.status === 'pass' && run2GradeVerdict.log.includes('Score: 70/70'),
        tokenUsageRecorded:
          Object.values(tokenUsage.phases).every(phaseTally => phaseTally.measuredTurns > 0) &&
          tokenUsage.total.measuredTurns > 0 &&
          tokenUsage.total.inputTokens !== null &&
          tokenUsage.total.outputTokens !== null,
      }
      const wallSeconds = (Date.now() - startedAt) / 1000
      const evidence = {
        date: '2026-10-04',
        test: 'tests/integration/live-xv6-supervisor-repair.spec.ts',
        command: LIVE_COMMAND,
        model: api.model,
        result: Object.values(assertions).every(Boolean) ? 'passed' : 'failed',
        method:
          `A ${REVIEWER_MODE} run over the xv6 locks world: the defective xv6-lock-lab-optimization v1 recipe lists the ` +
          `completion child at index 0 with no dependsOn, so it starts before the fix child at index 1; the honest completion ` +
          `leaf finds ${XV6_FIX_MARKER} missing and fails the real checker without fabricating it, and the coordinator fails ` +
          'with it (its own criterion needs the completion artifact and the full grade). The spec re-runs `bash checks/verify.sh ' +
          'all` itself to record the score the defective order really earned. The review scan spawns the reviewer, whose recorded ' +
          'diagnosis carries a task_definition proposal and is consumed into a supervisor hand-off; the supervisor is the real ' +
          'model and calls the real evolution chain (propose, candidate, prepare, replay, gate, decide, apply); the two-sided ' +
          'experiment replays the failed coordinator (observed failure) and the verified fix leaf (holdout) through the real ' +
          'runtime under per-side frozen template libraries, with the lab grader as the original acceptance; the human gates are ' +
          `answered through the deployment approval seam; the publish appends ${XV6_LAB_ID}@2.json, whose shape this spec does ` +
          'NOT prescribe — it accepts whatever version 2 the model publishes as long as it composes exactly the two leaves, ' +
          'cannot start the completion child before the fix child verifies under serial index+dependency scheduling (ordered ' +
          'after it, or gated on it), and keeps the criteria byte-identical — and leaves @1 defective; a second root run on a ' +
          'fresh checkout verifies with its coordinating child bound to version 2 and consumes exactly the published recipe ' +
          '(indices and edges), before the spec re-runs the full grade to 70/70. The repair is pure template CONTENT (order ' +
          'and/or a dependency edge; the criteria stay byte-identical), so evolution_prepare never takes the criterion-repair ' +
          `branch. In hybrid mode only the reviewer's request is scripted; in all-real mode it uses the real model too. autoReview ` +
          'is pinned to "failed". The assemble filter keeps the evolution chain and task_review_agent only on the supervisor session. ' +
          'An idle session is nudged per session id (its own active run or the supervisor session, no pending call, no in-flight ' +
          'request, globally stagnant progress for 180 seconds, capped at 12 nudges per session).',
        assertions,
        cases: [
          {
            name: 'xv6-locks-shared-recipe-repair',
            reviewPath: REVIEWER_MODE,
            failure: {
              regressionLeaf: {
                taskId: completionLeaf.taskId,
                templateId: XV6_COMPLETION_LEAF_ID,
                verdict: regressionFailure.verdict?.status,
                exitCode: regressionFailure.verdict?.exitCode,
                logRef: regressionFailure.verdict?.logRef,
                logExcerpt: regressionFailure.log.split('\n').slice(-8).join('\n'),
              },
              coordinator: {
                taskId: coordinatorTask.taskId,
                templateId: XV6_LAB_ID,
                templateVersion: 1,
                verdict: coordinatorFailure.verdict.status,
                exitCode: coordinatorFailure.verdict.exitCode,
                logRef: coordinatorFailure.verdict.logRef,
              },
              run1Grade: { score: run1Grade.score, exit: run1Grade.status },
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
              files: [`${XV6_LAB_ID}@1.json`, `${XV6_LAB_ID}@2.json`],
              publishedEqualsFrozenCandidate,
              nonEmptyDependsOnPublishedLive,
            },
            publishedRecipe: v2.decomposition,
            // The published shape as it really is: per-child dependsOn indices and the
            // derived edge set (no shape is prescribed; this is what run 2 must consume).
            publishedRecipeEdges,
            publishedRecipeLeafIds: childIds(v2),
            publishedEdges: publishedEdgeSet,
            publishedRecipeGatesCompletion,
            run2: {
              storeId: STORE2,
              taskId: intake.taskId,
              coordinatorTaskId: run2Coordinator.taskId,
              coordinatorVersion: run2Coordinator.templateRef?.version,
              admittedEdges: run2AdmittedDeps,
              edges: run2Edges,
              grade: { score: run2Grade.score, exit: run2Grade.status },
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
          'One run on one machine: run 1, the experiment replays (a failed coordinator and a verified fix leaf, baseline and ' +
          'candidate) and run 2 each build and grade real RISC-V guests under TCG, so the wall time is dominated by grader and ' +
          'model latency. The repair SHAPE is the model\'s choice (round 6\'s precedent: a spec must not prescribe a dependency ' +
          'form): the test only rejects a version 2 that fails the semantics (two leaves, completion unable to precede fix under ' +
          'serial index+dependency scheduling, criteria unchanged), the publish/consume consistency, or the grades. The defect is ' +
          'a missing dependency (or mis-order) whose determinism rests on the completion leaf staying honest: ' +
          'a model that fabricates the completion artifacts would mask it, so the completion template says its only input is this ' +
          "run's fix marker and forbids fabricating it. The lock-contention thresholds in kalloctest/bcachetest can be flaky under " +
          'a heavily loaded host. The spec re-runs `bash checks/verify.sh all` itself for run 1 and run 2, outside the runtime. ' +
          `The reviewer scripted only in hybrid mode; use SINGULARITY_LIVE_REVIEWER_MODE=hybrid for the cheap diagnosis. ` +
          'SINGULARITY_LIVE_XV6_EVIDENCE overrides the evidence output path.',
      }
      await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, snapshot: final }, null, 2) + '\n')
      writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')
      await writeFile('/tmp/singularity-live-xv6-supervisor-repair.json', JSON.stringify(evidence, null, 2) + '\n')
      evidenceWritten = true
      expect(Object.values(assertions).every(Boolean), JSON.stringify(assertions)).toBe(true)
    } catch (error) {
      if (!evidenceWritten) await writeFailureEvidence(error)
      throw error
    } finally {
      clearInterval(watchdog)
    }
  },
  14_400_000,
)

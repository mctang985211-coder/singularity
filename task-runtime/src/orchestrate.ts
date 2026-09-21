import { randomUUID } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  EvidenceBundle,
  ReviewBlocker,
  ReviewCriterion,
  ReviewDimensions,
  ReviewMetrics,
  ReviewOutcome,
  ReviewTokenUsage,
  ReviewToolCall,
  RunId,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskService,
  TaskSnapshot,
  TaskStatus,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot, resolvePermission, resolvePreset, workerBaseline, type CapabilityConfig, type PermissionSpec } from './capability.ts'
import { manifestMcpServers, resolveMcpServerSpecs, type McpEnvBinding } from './mcp-servers.ts'
import { buildHandoff, renderWorkerPrompt } from './handoff.ts'
import { renderWorkerContract } from './contract.ts'

/** Raised when the verifier service (ticket C2) is not loaded in the context. */
export class VerifierUnavailableError extends Error {
  override name = 'VerifierUnavailableError'
}

/** One admitted child plus the manifest it was admitted with. */
export interface ChildPlan {
  task: TaskInstance
  manifest: CapabilityManifest
  dependsOn: readonly number[]
  /** Caller-declared assumptions (`DecomposeChildSpec.assumptions`), merged into the handoff at spawn time. */
  assumptions?: readonly string[]
}

export interface ChildOutcome {
  taskId: TaskId
  runId?: RunId
  status: 'verified' | 'failed' | 'blocked' | 'cancelled'
  evidenceId?: string
}

export interface SpawnChildRequest {
  sessionId: string
  name: string
  prompt: string
  agentPreset?: string
  /** Permission preset the child session is switched to (capability-granted; absent keeps the default posture). */
  permissionPreset?: string
  /** Capability-derived authorization the agent runtime applies before the worker is published. */
  grant?: WorkerGrant
  /**
   * The child's contract as a marked block, registered as a system-prompt
   * section so the loop reprojects it into surface node 0 on every step instead
   * of leaving it only in the spawn prompt, which a fold can shadow.
   */
  contract?: string
  signal?: AbortSignal
}

/**
 * One task run's resource budget (KISS §5 "预算即法律": any exhaustion forces
 * the exit, never a silent degradation). Every member is optional; the runtime
 * resolves its shipped defaults per key.
 *
 * What the orchestrator can honestly enforce is bounded by what it can observe
 * of an in-flight run — and that is only the wall clock (it awaits the
 * worker's idle) plus, at terminal time, one best-effort read of the run's
 * session log and token projection ({@link OrchestrateEnv.observeSession}):
 *
 * - `wallTimeMs` — **enforced in flight**: the worker wait races the deadline;
 *   on exhaustion the agent is cancelled and the run settles failed with
 *   `budget exhausted: wallTimeMs (...)`, named as a budget exhaustion, not a
 *   criteria failure.
 * - `maxToolCalls` — **post-hoc check only**: the session log is readable only
 *   once the run has settled, so a breach lands as an anomaly on the terminal
 *   review record (the verdict stands — the evidence is real). It is never
 *   presented as in-flight enforcement.
 * - `tokens` — **post-hoc check only**: same terminal seam, and the runtime
 *   ships no default for it — the only observation is the whole-session
 *   cumulative projection, systematically high for a long-lived root session,
 *   so no honest constant exists. Configured, a breach is annotated the same
 *   way.
 * - `attempts` — **declared, not enforced**: the orchestrator has no retry
 *   branch (guide §3.1 Non-Goals), so a run-count cap has nothing to gate; the
 *   field ships with the rest so the retry branch has its knob when it lands.
 */
export interface BudgetConfig {
  maxToolCalls?: number
  tokens?: number
  wallTimeMs?: number
  attempts?: number
}

/** Per-call overrides the cascade forwards on every verifier call (ticket C2's `VerifyRunOptions`). */
export interface VerifyRunOptions {
  /** Working directory for criterion commands — the env checkout the workers ran in. */
  cwd?: string
  /** The verifier's own deadline for this call; the verifier kills whatever it started. */
  timeoutMs?: number
}

/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
export const VERIFY_SAFETY_MARGIN_MS = 15_000

/** Block reason for a child the batch never started because the caller cancelled it. */
const CANCELLED_BEFORE_START = 'cancelled by the caller before this child started'

/**
 * Raw, session-scoped facts the deployment's session services report for one
 * run's session. Deliberately plain data: the cascade never touches cordis, so
 * whoever implements {@link OrchestrateEnv.observeSession} does the reading and
 * name classification, and this module only assembles the record from it.
 *
 * Every member is optional because every read is best-effort: a deployment with
 * no session-query, no projections, or a session the reader cannot load reports
 * `undefined` rather than an empty object, and the corresponding record field is
 * then omitted instead of being written as 0.
 */
export interface SessionObservation {
  /** Whole-session token buckets from the session's `tokenUsage` projection. */
  tokens?: ReviewTokenUsage
  /** Tool traffic the session log shows; absent when no log was readable. */
  tools?: {
    /** One entry per distinct tool name, with its call count. */
    calls: ReviewToolCall[]
    /** How many `tool/result` events reported a failure. */
    failures: number
  }
  /** Skill names the session's `skill` calls loaded, in call order, duplicates preserved. */
  skillCalls?: string[]
  /** Human-intervention events in the session log (`approval/asked` plus the human-facing tools). */
  humanInterventions?: number
  /** `compaction/start` events observed in the session log. */
  compactions?: number
}

/** One record's derived review dimensions and effort metrics, either half possibly absent. */
export interface ReviewEnrichment {
  dimensions?: ReviewDimensions
  metrics?: ReviewMetrics
}

/** The service-supplied seam the cascade runs against (keeps this module free of cordis types). */
export interface OrchestrateEnv {
  task: TaskService
  actor: string
  defaultPreset?: string
  /** Optional preflight: throw when the deployment cannot mount this preset id (unknown or broken). */
  assertPreset?(preset: string): Promise<void>
  /**
   * Optional resolver for permission preset names to their knob bundle (the
   * `permissionPresets` registry's `resolve`). Required to rank and validate
   * capability-declared permissions; absent, the first declared name passes
   * through and the spawn's own `permissionPresets.set` validates it.
   */
  resolvePermissionSpec?(name: string): PermissionSpec
  /**
   * Optional env binding for capability-declared MCP servers
   * (`mcp-servers.ts`): the caller session's graph env, or `undefined` when
   * the session binds none. Consulted only when a manifest declares servers;
   * a declared server with no binding fails the spawn loudly.
   */
  resolveMcpEnv?(): Promise<McpEnvBinding | undefined>
  verifyTimeoutMs: number
  /** The resolved per-run budget; which member is enforced in flight, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  budget?: BudgetConfig
  /**
   * `Config.allowRuntimeDecomposition`, carried to the worker prompt: a `leaf`
   * worker has to be told the door is open before it can walk through it, and a
   * switch-off deployment must not be told otherwise.
   */
  allowRuntimeDecomposition: boolean
  spawn(request: SpawnChildRequest): Promise<AgentHandle>
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
  /** Optional tail reader for verifier logs (logRef relative to the verifier's evidence root); absent keeps logTail off failed records. */
  readLogTail?(logRef: string): Promise<string | undefined>
  /**
   * Optional session reader for the review record's dimensions and metrics
   * (§2.7.3): one read of a run's session log and token projection. Absent — or
   * a rejection — keeps only the store-derived facts; it can never fail a review.
   */
  observeSession?(sessionId: string): Promise<SessionObservation | undefined>
  onRunBound(sessionId: string, binding: { storeId: string; taskId: TaskId; runId: RunId }): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** One mandatory criterion the verifier did not pass, plus what the verifier said about it. */
interface UnmetCriterion {
  criterionId: string
  detail: string
}

/**
 * The KISS §4.3 UNKNOWN split, rendered into the orchestrator's feedback so a
 * reader never mistakes "the criterion was never tested" for "the judge is
 * broken" — confusing the two makes the system re-test the same thing
 * forever. Only an inconclusive verdict carries a kind; pass/fail need none.
 */
function unknownTag(result: VerificationResult): string {
  if (result.status !== 'inconclusive' || result.unknownKind === undefined) return ''
  return result.unknownKind === 'task'
    ? ' [unknown: task — the criterion was never tested]'
    : ` [unknown: verifier — the verifier could not judge] ${escalationHint(
      `the verifier "${result.verifierId}" could not judge criterion "${result.criterionId}"`,
      'the criterion was run and the judge itself failed',
      'fix or replace the verifier, then re-verify the criterion',
    )}`
}

function unmetMandatory(criteria: readonly AcceptanceCriterion[], results: readonly VerificationResult[]): UnmetCriterion[] {
  return criteria.filter(criterion => criterion.mandatory).flatMap(criterion => {
    const result = results.find(item => item.criterionId === criterion.criterionId)
    // KISS §5.1: a criterion explicitly labeled heuristic is judged and labeled,
    // never counted as a deterministic pass — a natural-language coverage signal
    // cannot close a criterion mechanically, whatever verdict a judge returned.
    if (criterion.heuristic === true) {
      return [{
        criterionId: criterion.criterionId,
        detail: `heuristic judgement${result === undefined ? '' : ` (verdict ${result.status})`} — explicitly labeled heuristic, not counted as a deterministic pass`,
      }]
    }
    if (result?.status === 'pass') return []
    return [{
      criterionId: criterion.criterionId,
      detail: result === undefined ? 'no result' : `${result.status}${unknownTag(result)}${result.details === undefined ? '' : ` (${result.details})`}`,
    }]
  })
}

function failureReason(unmet: readonly UnmetCriterion[]): string {
  return `mandatory criteria not satisfied: ${unmet.map(item => `${item.criterionId} ${item.detail}`).join(', ')}`
}

/** One required artifact reference no store evidence satisfies yet. */
interface MissingArtifact {
  criterionId: string
  ref: string
  /**
   * Which declaration the reference came from: `requires` is a verified
   * reference product, `accepts` a raw input whose existence is the whole
   * requirement. The blocked reason and the registered obligation say which,
   * so a reader knows what would close the gap.
   */
  requirement: 'requires' | 'accepts'
}

/**
 * The artifact references (per criterion) that no store evidence satisfies yet.
 * A reference matches an evidence id, an artifact kind, or an artifact id — the
 * three spellings a contract can name a product by. Judged at spawn time, never
 * at admission: existence needs the store snapshot.
 *
 * The two declarations differ in what "satisfied" means (P4, KISS §5.1):
 * `requiresArtifact` names a **verified reference product** — the producing run
 * must sit in the verified terminal state and its bundle must carry a passing
 * verdict, so a failed or still-running run's same-named product never closes
 * the gap — while `acceptsArtifact` names a **raw input** whose mere existence
 * in the store is the requirement.
 */
function missingRequiredArtifacts(
  criteria: readonly AcceptanceCriterion[],
  snapshot: TaskSnapshot,
): MissingArtifact[] {
  const present = new Set<string>()
  const verified = new Set<string>()
  for (const item of snapshot.evidence) {
    const run = snapshot.runs.find(candidate => candidate.runId === item.taskRunId)
    const refs = [item.evidenceId, ...item.artifacts.flatMap(artifact => [artifact.kind, artifact.artifactId])]
    for (const ref of refs) present.add(ref)
    if (run?.status === 'verified' && item.verifierResults.some(result => result.status === 'pass')) {
      for (const ref of refs) verified.add(ref)
    }
  }
  return criteria.flatMap(criterion => [
    ...(criterion.requiresArtifact ?? [])
      .filter(ref => !verified.has(ref))
      .map(ref => ({ criterionId: criterion.criterionId, ref, requirement: 'requires' as const })),
    ...(criterion.acceptsArtifact ?? [])
      .filter(ref => !present.has(ref))
      .map(ref => ({ criterionId: criterion.criterionId, ref, requirement: 'accepts' as const })),
  ])
}

/**
 * The authorization one admitted child runs under, built from its manifest:
 * the tools and skills its matched capabilities declared (labels already
 * expanded at admission), the baseline its worker prompt needs, and whether the
 * mounted preset's own tool plane stays — which it does exactly when a matched
 * capability named its own preset, because a foreign composition's tool names
 * are not ours to enumerate. The MCP plane joins separately:
 * {@link authorizedGrant} binds the manifest's server names to the run's env.
 */
function workerGrant(manifest: CapabilityManifest): WorkerGrant {
  return {
    capabilities: Object.entries(manifest.capabilities).map(([capability, entry]) => ({
      capability,
      tools: [...entry.tools],
      skills: [...entry.skills],
    })),
    baseline: workerBaseline(),
    keepPresetTools: Object.values(manifest.capabilities).some(entry => entry.preset !== undefined),
  }
}

/**
 * The full grant for one spawn: {@link workerGrant} plus the manifest's MCP
 * servers materialized against the run's env binding. Throws when a declared
 * server has no binding or its repo is absent from the env — inside the spawn
 * `try`, so the failure walks the run to `failed` with the cause named, the
 * same discipline as a dangling preset.
 */
async function authorizedGrant(env: OrchestrateEnv, manifest: CapabilityManifest): Promise<WorkerGrant> {
  const grant = workerGrant(manifest)
  if (manifestMcpServers(manifest).length === 0) return grant
  const binding = env.resolveMcpEnv === undefined ? undefined : await env.resolveMcpEnv()
  return { ...grant, mcpServers: resolveMcpServerSpecs(manifest, binding) }
}

/**
 * Copy the verifier's per-criterion results onto a review record, filling the
 * command from the criterion itself when the result omits it — the record
 * must show what was checked without a trip back into the evidence bundle.
 */
function reviewCriteria(criteria: readonly AcceptanceCriterion[], results: readonly VerificationResult[]): ReviewCriterion[] {
  return results.map(result => {
    const command = result.command ?? criteria.find(item => item.criterionId === result.criterionId)?.command
    return {
      criterionId: result.criterionId,
      verdict: result.status,
      ...(command === undefined ? {} : { command }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.logRef === undefined ? {} : { logRef: result.logRef }),
      ...(result.unknownKind === undefined ? {} : { unknownKind: result.unknownKind }),
    }
  })
}

/**
 * The review dimensions and the effort counters for one terminal record,
 * assembled from what the store already holds plus one optional session read.
 *
 * Everything here is a mechanically observed fact: counts, declared modes,
 * names, and raw token buckets. No field is a score, and no derivation applies a
 * threshold or an opinion — §2.7.3 keeps the "why" in Diagnosis. A dimension or
 * counter whose source is missing is left out entirely rather than defaulted to
 * zero, so an absent field always means "not observed" and never "observed as
 * nothing".
 *
 * Best-effort by contract: this runs inside the terminal transition, so any read
 * that fails degrades to an omitted field instead of costing the record.
 */
async function reviewEnrichment(
  env: OrchestrateEnv,
  storeId: string,
  taskId: TaskId,
  outcome: ReviewOutcome,
  run: TaskRun | undefined,
  criteria: readonly ReviewCriterion[] | undefined,
): Promise<ReviewEnrichment> {
  try {
    const task = await env.task.taskIn(storeId, taskId)
    const snapshot = await env.task.snapshotIn(storeId)
    const manifest = snapshot.capabilities[taskId]
    const observation = run === undefined || env.observeSession === undefined
      ? undefined
      : await env.observeSession(run.sessionId).catch(() => undefined)

    const grantedSkills = manifest === undefined
      ? undefined
      : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.skills))].sort()
    const grantedTools = manifest === undefined
      ? undefined
      : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.tools))].sort()
    /** Granted MCP servers' tool prefix (`mcp__<server>__`): their calls ride the spawn-mounted plane, outside the label/baseline vocabulary. */
    const mcpPrefixes = manifest === undefined
      ? []
      : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.mcpServers ?? []))].map(name => `mcp__${name}__`)
    const baseline = workerBaseline()
    const recorded = criteria ?? []
    /** Loaded skill names, deduplicated, and the ones no granted capability covers. */
    const loadedSkills = observation?.skillCalls === undefined ? undefined : [...new Set(observation.skillCalls)].sort()
    const contextEfficiency = observation === undefined || (observation.tokens === undefined && observation.compactions === undefined)
      ? undefined
      : {
        ...(observation.tokens === undefined ? {} : { tokens: { ...observation.tokens } }),
        ...(observation.compactions === undefined ? {} : { compactions: observation.compactions }),
      }

    const dimensions: ReviewDimensions = {
      outcomeCorrectness: {
        outcome,
        criteriaCount: recorded.length,
        unmetCriterionIds: recorded.filter(item => item.verdict !== 'pass').map(item => item.criterionId),
      },
      taskSpecification: {
        objectivePresent: task.objective.trim().length > 0,
        criteriaCount: task.acceptanceCriteria.length,
        criteriaWithCommand: task.acceptanceCriteria.filter(item => item.command !== undefined).length,
      },
      acceptance: {
        criteria: task.acceptanceCriteria.map(item => ({
          criterionId: item.criterionId,
          mode: item.verificationMode,
          hasCommand: item.command !== undefined,
          mandatory: item.mandatory,
        })),
      },
      decomposition: {
        depth: task.depth,
        decompositionStatus: task.decompositionStatus,
        childCount: task.childTaskIds.length,
        incomingEdges: snapshot.edges.filter(edge => edge.to === taskId).length,
        outgoingEdges: snapshot.edges.filter(edge => edge.from === taskId).length,
      },
      ...(manifest === undefined ? {} : {
        capabilityCoverage: {
          closure: manifest.closure,
          granted: capabilitySnapshot(manifest),
          missing: [...manifest.missing],
        },
      }),
      ...(grantedSkills === undefined ? {} : {
        skillFit: {
          granted: grantedSkills,
          ...(loadedSkills === undefined ? {} : {
            loaded: loadedSkills,
            loadedOutsideGrant: loadedSkills.filter(name => !grantedSkills.includes(name)),
          }),
        },
      }),
      ...(grantedTools === undefined ? {} : {
        toolFit: {
          granted: grantedTools,
          ...(observation?.tools === undefined ? {} : {
            called: observation.tools.calls.map(call => ({ ...call })),
            calledOutsideGrant: observation.tools.calls
              .map(call => call.name)
              .filter(name => !grantedTools.includes(name) && !baseline.includes(name)
                && !mcpPrefixes.some(prefix => name.startsWith(prefix)))
              .sort(),
          }),
        },
      }),
      ...(contextEfficiency === undefined ? {} : { contextEfficiency }),
    }

    const calls = observation?.tools === undefined
      ? undefined
      : observation.tools.calls.reduce((sum, call) => sum + call.count, 0)
    const metrics: ReviewMetrics = {
      ...(observation?.tokens === undefined ? {} : { tokens: { ...observation.tokens } }),
      ...(calls === undefined || observation?.tools === undefined
        ? {}
        : { toolCalls: { calls, failures: observation.tools.failures } }),
      ...(observation?.humanInterventions === undefined ? {} : { humanInterventions: observation.humanInterventions }),
      ...(run === undefined || task.runIds.length === 0 ? {} : { retries: task.runIds.length - 1 }),
      ...(criteria === undefined ? {} : { evidenceLogs: criteria.filter(item => item.logRef !== undefined).length }),
    }

    return {
      dimensions,
      ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
    }
  } catch {
    return {}
  }
}

/**
 * Safety net around one verifier call. The verifier holds its own deadline
 * (`timeoutMs` goes down with every call) and kills whatever it started, so
 * this only fires when a verifier ignores its deadline entirely: it gets
 * `timeoutMs + VERIFY_SAFETY_MARGIN_MS` before the cascade gives up on it,
 * marks the run failed, and walks on. The abandoned promise keeps a handler
 * attached — it may still settle (and reject) long after the race is lost, and
 * that must never surface as an unhandled rejection.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, runId: RunId): Promise<T> {
  work.catch(() => {})
  const budgetMs = timeoutMs + VERIFY_SAFETY_MARGIN_MS
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `task-runtime: verification of run "${runId}" timed out after ${budgetMs}ms (verifier deadline ${timeoutMs}ms + ${VERIFY_SAFETY_MARGIN_MS}ms safety margin)`,
    )), budgetMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

/** Hand the verifier its own deadline and keep the safety net one margin behind it. */
function verifyWithDeadline(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<EvidenceBundle> {
  return withTimeout(env.verifyRun(storeId, runId, { timeoutMs: env.verifyTimeoutMs }), env.verifyTimeoutMs, runId)
}

/**
 * The L4 exit pointer (KISS §7, VRTC plan phase 3.1), appended to the feedback
 * a root agent reads at each of the three trigger sites. The escalation ledger
 * and its tool live on the root plane (agent-singularity): a card carries a
 * human-approval gate that belongs on the root's tool surface, so the
 * orchestrator only points at the exit — it never calls across planes and never
 * blocks a cascade on a human answer.
 */
export function escalationHint(what: string, tried: string, suggested: string): string {
  return `L4 exit (KISS §7): report this to a human with the escalate tool — what: ${what}; tried: ${tried}; suggested: ${suggested}`
}

/** The forced-exit reason for an in-flight budget exhaustion (KISS §5: named as a budget exhaustion, never as a criteria failure). */
function budgetExhaustedReason(which: string, detail: string): string {
  return `budget exhausted: ${which} (${detail}; this is a budget exhaustion, not a criteria failure) — ${escalationHint(
    'the run cannot finish inside its wall-clock budget',
    'the run was cancelled at the deadline',
    'raise the budget, split the task, or accept the partial result',
  )}`
}

/**
 * The post-hoc half of the budget (see {@link BudgetConfig}): the members the
 * orchestrator cannot observe in flight are checked once, at terminal time,
 * against the run's session observation, and a breach is recorded as an
 * anomaly — never presented as enforcement, never flipping a verdict.
 * Best-effort like the enrichment read: no budget, no reader, or no
 * observation means no annotation.
 */
async function budgetBreaches(env: OrchestrateEnv, run: TaskRun): Promise<string[]> {
  const budget = env.budget
  if (budget === undefined || env.observeSession === undefined) return []
  if (budget.maxToolCalls === undefined && budget.tokens === undefined) return []
  const observation = await env.observeSession(run.sessionId).catch(() => undefined)
  if (observation === undefined) return []
  const breaches: string[] = []
  if (budget.maxToolCalls !== undefined && observation.tools !== undefined) {
    const calls = observation.tools.calls.reduce((sum, call) => sum + call.count, 0)
    if (calls > budget.maxToolCalls) {
      breaches.push(`budget exceeded: maxToolCalls (observed ${calls} tool calls over the limit ${budget.maxToolCalls}; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tool calls than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`)
    }
  }
  if (budget.tokens !== undefined && observation.tokens !== undefined) {
    const tokens = observation.tokens
    const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
    if (total > budget.tokens) {
      breaches.push(`budget exceeded: tokens (observed ${total} whole-session tokens over the limit ${budget.tokens}; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tokens than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`)
    }
  }
  return breaches
}

/** How a spawned worker's wait settled. */
type WorkerSettlement =
  | { kind: 'idle' }
  | { kind: 'aborted' }
  | { kind: 'failed'; reason: string }
  | { kind: 'budget-exhausted' }

/**
 * Await a spawned worker's idle under the caller's abort signal and the run's
 * wall-clock budget. The budget is the one member the orchestrator can enforce
 * in flight: on exhaustion it cancels the agent and reports
 * `budget-exhausted`, and the caller settles the run failed with a budget
 * reason — never a criteria failure (KISS §5: no silent degradation). The
 * losing branch of the race keeps its handlers attached, so a worker that
 * settles after its budget already fired never surfaces an unhandled
 * rejection.
 */
async function awaitWorker(handle: AgentHandle, signal: AbortSignal | undefined, wallTimeMs: number | undefined): Promise<WorkerSettlement> {
  const cancel = () => handle.agent.cancel({ kind: 'parent' })
  signal?.addEventListener('abort', cancel, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const idle: Promise<WorkerSettlement> = handle.agent.whenIdle()
      .then((): WorkerSettlement => ({ kind: 'idle' }))
      .catch((error): WorkerSettlement => isAborted(signal) ? { kind: 'aborted' } : { kind: 'failed', reason: message(error) })
    const branches: Promise<WorkerSettlement>[] = [idle]
    if (wallTimeMs !== undefined) {
      branches.push(new Promise<WorkerSettlement>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'budget-exhausted' }), wallTimeMs)
        if (typeof timer.unref === 'function') timer.unref()
      }))
    }
    const settled = await Promise.race(branches)
    if (settled.kind === 'budget-exhausted') cancel()
    // An abort that lands as the worker goes idle wins over the idle itself,
    // as it did before the budget branch existed.
    if (settled.kind === 'idle' && isAborted(signal)) return { kind: 'aborted' }
    return settled
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

async function evidenceRefsFor(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<string[]> {
  return (await env.task.snapshotIn(storeId)).evidence.filter(item => item.taskRunId === runId).map(item => item.evidenceId)
}

/** Run start → terminal transition in ms; the terminal mark just landed, so finishedAt is in the store. */
async function runDurationMs(env: OrchestrateEnv, storeId: string, run: TaskRun): Promise<number> {
  const finishedAt = (await env.task.runIn(storeId, run.runId)).finishedAt
  const end = finishedAt === undefined ? Date.now() : Date.parse(finishedAt)
  return Math.max(0, end - Date.parse(run.startedAt))
}

/** Tail of the first unmet criterion that has a log; a missing reader or log keeps the field off the record. */
async function failedLogTail(env: OrchestrateEnv, unmet: readonly UnmetCriterion[], results: readonly VerificationResult[]): Promise<string | undefined> {
  if (env.readLogTail === undefined) return undefined
  const logRef = unmet
    .map(item => results.find(result => result.criterionId === item.criterionId))
    .find(result => result?.logRef !== undefined)?.logRef
  if (logRef === undefined) return undefined
  try {
    return await env.readLogTail(logRef)
  } catch {
    return undefined
  }
}

/** Options for {@link recordTerminalReview}; a runless (blocked) record omits `run`. */
interface TerminalReviewOptions {
  run?: TaskRun
  localizedCause?: string
  anomalies?: readonly string[]
  relatedTaskIds?: readonly TaskId[]
  criteria?: readonly ReviewCriterion[]
  logTail?: string
  blockedBy?: readonly ReviewBlocker[]
}

/**
 * Every run walked to a terminal state gets exactly one review record, written
 * in the same moment right after the terminal status event — the discipline
 * the run cascade and the replay runner share. The dimensions and effort
 * metrics are derived alongside (§2.7.3) on a best-effort basis — see
 * {@link reviewEnrichment} — and never gate the record itself.
 */
async function recordTerminalReview(
  env: OrchestrateEnv,
  storeId: string,
  taskId: TaskId,
  outcome: ReviewOutcome,
  options: TerminalReviewOptions = {},
): Promise<void> {
  const enrichment = await reviewEnrichment(env, storeId, taskId, outcome, options.run, options.criteria)
  const breaches = options.run === undefined ? [] : await budgetBreaches(env, options.run)
  await env.task.recordReviewIn(storeId, {
    taskId,
    ...(options.run === undefined ? {} : { runId: options.run.runId, sessionId: options.run.sessionId }),
    outcome,
    evidenceRefs: options.run === undefined ? [] : await evidenceRefsFor(env, storeId, options.run.runId),
    anomalies: [...(options.anomalies ?? []), ...breaches],
    ...(options.localizedCause === undefined ? {} : { localizedCause: options.localizedCause }),
    ...(options.relatedTaskIds === undefined || options.relatedTaskIds.length === 0
      ? {}
      : { relatedTaskIds: [...options.relatedTaskIds] }),
    ...(options.run === undefined ? {} : { durationMs: await runDurationMs(env, storeId, options.run) }),
    ...(options.criteria === undefined ? {} : { criteria: options.criteria.map(item => ({ ...item })) }),
    ...(options.logTail === undefined ? {} : { logTail: options.logTail }),
    ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy.map(item => ({ ...item })) }),
    ...(enrichment.dimensions === undefined ? {} : { dimensions: enrichment.dimensions }),
    ...(enrichment.metrics === undefined ? {} : { metrics: enrichment.metrics }),
  }, env.actor)
}

/**
 * Refuse a dangling preset before the spawn attempt: when the deployment
 * cannot mount the resolved preset, throw an error naming the preset and the
 * capabilities that granted it — the spawn catch walks the run to `failed`
 * with that cause, so a bad capability table entry can never leave a ghost
 * task.
 */
async function assertPresetUsable(env: OrchestrateEnv, manifest: CapabilityManifest, preset: string | undefined): Promise<void> {
  if (preset === undefined || env.assertPreset === undefined) return
  try {
    await env.assertPreset(preset)
  } catch (error) {
    const grantedBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) => (entry.preset === preset ? [name] : []))
    throw new Error(`task-runtime: preset "${preset}"${grantedBy.length === 0 ? '' : ` granted by capabilities [${grantedBy.join(', ')}]`} is not mountable: ${message(error)}`)
  }
}

/**
 * The strictest permission preset a manifest's capabilities declare. Unknown
 * names throw here (through the registry's resolve) so the spawn catch walks
 * the run to `failed` with the cause named — same discipline as
 * assertPresetUsable. Without a spec resolver (test contexts) the first
 * declared name passes through and the spawn's own set() validates it.
 */
function permissionFor(env: OrchestrateEnv, manifest: CapabilityManifest): string | undefined {
  if (Object.values(manifest.capabilities).every(entry => entry.permission === undefined)) return undefined
  if (env.resolvePermissionSpec === undefined) {
    return Object.values(manifest.capabilities).find(entry => entry.permission !== undefined)?.permission
  }
  try {
    return resolvePermission(manifest, env.resolvePermissionSpec)
  } catch (error) {
    const declaredBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) => (entry.permission === undefined ? [] : [name]))
    throw new Error(`task-runtime: permission declared by capabilities [${declaredBy.join(', ')}] is not usable: ${message(error)}`)
  }
}

/**
 * Sequential run cascade over one admitted batch of children (RFC §47 MVP):
 * the first child whose dependencies are all `verified` is handed off and
 * spawned; its run is verified, then readiness is re-evaluated. A child whose
 * dependency failed, was cancelled, or never ran becomes `blocked`; an abort
 * cancels the in-flight child agent and marks its run `cancelled`. Once the
 * batch settles the parent run takes the verifier's verdict on its own
 * criteria — the composite acceptance that closes the loop.
 */
export async function runChildrenCascade(
  env: OrchestrateEnv,
  storeId: string,
  parentTask: TaskInstance,
  parentRun: TaskRun,
  plans: readonly ChildPlan[],
  reason: string,
  callerSessionId: string,
  signal?: AbortSignal,
): Promise<ChildOutcome[]> {
  const outcomes: Array<ChildOutcome | undefined> = plans.map(() => undefined)
  const remaining = new Set(plans.map((_plan, index) => index))
  const verified = new Set<number>()
  const childTaskIds = plans.map(plan => plan.task.taskId)
  const verify = (runId: RunId) => verifyWithDeadline(env, storeId, runId)

  /**
   * The cascade's recordReview shares the one terminal-record discipline with
   * the replay runner ({@link recordTerminalReview}). A run settled by a nested
   * decomposition is reviewed by that nested cascade (as its parent run),
   * never here.
   */
  const recordReview = (
    taskId: TaskId,
    outcome: ReviewOutcome,
    options: TerminalReviewOptions = {},
  ): Promise<void> => recordTerminalReview(env, storeId, taskId, outcome, options)

  /**
   * Converge every child the batch never started into its terminal state: a
   * runless `TaskBlocked` plus the one review record that declares it. A task
   * that never ran has no run to settle — `TaskCancelled` accepts only a
   * `running` task — so an aborted batch records its remaining children here
   * too, with `why` naming the cancellation instead of a dependency. Either way
   * no child is left `admitted`, and the parent's composite cause never names a
   * ghost.
   */
  const blockRemaining = async (why: (index: number) => string) => {
    const snapshot = await env.task.snapshotIn(storeId)
    for (const index of remaining) {
      const taskId = plans[index]!.task.taskId
      const reason = why(index)
      await env.task.markRunStatusIn(storeId, taskId, undefined as unknown as RunId, 'blocked', env.actor, { reason })
      await recordReview(taskId, 'blocked', {
        anomalies: [reason],
        relatedTaskIds: plans[index]!.dependsOn.map(dependency => plans[dependency]!.task.taskId),
        blockedBy: plans[index]!.dependsOn
          .filter(dependency => !verified.has(dependency))
          .map(dependency => {
            const blockerTaskId = plans[dependency]!.task.taskId
            const blockerStatus = snapshot.tasks.find(item => item.taskId === blockerTaskId)?.status
            return { taskId: blockerTaskId, outcome: blockerStatus ?? ('blocked' as TaskStatus) }
          }),
      })
      outcomes[index] = { taskId, status: 'blocked' }
    }
    remaining.clear()
  }

  while (remaining.size > 0) {
    if (isAborted(signal)) {
      await blockRemaining(() => CANCELLED_BEFORE_START)
      break
    }
    const ready = [...remaining]
      .filter(index => plans[index]!.dependsOn.every(dependency => verified.has(dependency)))
      .sort((a, b) => a - b)
    if (ready.length === 0) {
      await blockRemaining(index => {
        const failed = plans[index]!.dependsOn.filter(dependency => !verified.has(dependency))
        return `dependencies [${failed.map(dependency => plans[dependency]!.task.taskId).join(', ')}] did not verify`
      })
      break
    }

    const index = ready[0]!
    const plan = plans[index]!
    const childTaskId = plan.task.taskId
    const snapshot = await env.task.snapshotIn(storeId)
    const dependencyTaskIds = plan.dependsOn.map(dependency => plans[dependency]!.task.taskId)

    // Evidence dependencies (KISS §5.1): a criterion's `requiresArtifact` /
    // `acceptsArtifact` names kinds or ids that must exist in the store before
    // the criterion can be judged at all — the former as a verified reference
    // product, the latter as a raw input. Missing → the child never spawns; it
    // settles as a runless blocked task under the same discipline as
    // blockRemaining, its record's anomalies name the missing items, and each
    // missing item is registered as an obligation — a question the tree must
    // answer, not an action.
    const missingArtifacts = missingRequiredArtifacts(plan.task.acceptanceCriteria, snapshot)
    if (missingArtifacts.length > 0) {
      const reason = `missing required artifacts: ${missingArtifacts.map(item =>
        `${item.ref} (criterion ${item.criterionId}${item.requirement === 'accepts' ? '; raw input, any run state' : ''})`).join(', ')}`
      await env.task.markRunStatusIn(storeId, childTaskId, undefined as unknown as RunId, 'blocked', env.actor, { reason })
      await recordReview(childTaskId, 'blocked', {
        anomalies: [reason],
        relatedTaskIds: dependencyTaskIds,
      })
      for (const item of missingArtifacts) {
        const verified = item.requirement === 'requires'
        await env.task.recordObligationIn(storeId, {
          obligationId: `o-${randomUUID()}`,
          goal: `artifact/evidence "${item.ref}" required by task "${childTaskId}" criterion ${item.criterionId} does not exist in the task store${verified ? ' as a verified reference product' : ''}`,
          criterion: verified
            ? `the task store holds evidence or an artifact named "${item.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict`
            : `the task store holds evidence or an artifact named "${item.ref}" (evidence id, artifact kind, or artifact id)`,
          sourceTaskId: childTaskId,
        }, env.actor)
      }
      outcomes[index] = { taskId: childTaskId, status: 'blocked' }
      remaining.delete(index)
      continue
    }

    const dependencyEvidence = snapshot.evidence
      .filter(item => dependencyTaskIds.includes(item.taskId))
      .map(item => item.evidenceId)
    const handoff = buildHandoff({
      parentTask,
      parentRun,
      childTask: plan.task,
      reason,
      callerSessionId,
      // Contract assumptions are the caller's own plus the evidence the child's
      // verified dependencies produced — the reference truth downstream criteria
      // may rely on (KISS §5.1: ordering declared as evidence, not sequence).
      assumptions: [
        ...(plan.assumptions ?? []),
        ...dependencyEvidence.map(evidenceId => `dependency evidence "${evidenceId}" is verified and available as a reference`),
      ],
      relevantEvidence: dependencyEvidence,
    })
    await env.task.recordHandoffIn(storeId, handoff, env.actor)

    const sessionId = `s-${randomUUID()}`
    const name = plan.task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `child-${index + 1}`
    const agentPreset = resolvePreset(plan.manifest, env.defaultPreset)
    // The run exists before the spawn attempt so a spawn refusal can still walk
    // it to a terminal state — a child that never got an agent must not be left
    // admitted, or the parent's composite cause would name a task that never settles.
    const run: TaskRun = {
      runId: `r-${randomUUID()}`,
      taskId: childTaskId,
      sessionId,
      parentRunId: parentRun.runId,
      capabilitySnapshot: capabilitySnapshot(plan.manifest),
      ...(agentPreset !== undefined ? { agentPreset } : {}),
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    await env.task.startRunIn(storeId, run, env.actor)
    let handle: AgentHandle
    try {
      await assertPresetUsable(env, plan.manifest, agentPreset)
      const permissionPreset = permissionFor(env, plan.manifest)
      handle = await env.spawn({
        sessionId,
        name,
        prompt: renderWorkerPrompt(handoff, plan.task, { allowRuntimeDecomposition: env.allowRuntimeDecomposition }),
        // The same task the prompt table came from, rendered as the block the
        // agent runtime projects into the worker's system prompt.
        contract: renderWorkerContract(plan.task, handoff),
        grant: await authorizedGrant(env, plan.manifest),
        ...(agentPreset !== undefined ? { agentPreset } : {}),
        ...(permissionPreset !== undefined ? { permissionPreset } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      const reason = `spawn failed: ${message(error)}`
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason })
      await recordReview(childTaskId, 'failed', { run, localizedCause: reason, relatedTaskIds: dependencyTaskIds })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed' }
      remaining.delete(index)
      continue
    }

    env.onRunBound(sessionId, { storeId, taskId: childTaskId, runId: run.runId })

    const settled = await awaitWorker(handle, signal, env.budget?.wallTimeMs)
    if (settled.kind === 'aborted') {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'cancelled', env.actor, { reason: 'aborted by caller' })
      await recordReview(childTaskId, 'cancelled', { run, relatedTaskIds: dependencyTaskIds })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'cancelled' }
      remaining.delete(index)
      await blockRemaining(() => CANCELLED_BEFORE_START)
      break
    }
    if (settled.kind === 'budget-exhausted') {
      // KISS §5's forced exit: budget exhaustion settles the run failed with
      // the budget named as the cause — the L4 ESCALATE exit (plan phase 3.1)
      // takes over from here once it exists.
      const reason = budgetExhaustedReason('wallTimeMs', `worker run exceeded its wall-clock limit of ${env.budget?.wallTimeMs}ms`)
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason })
      await recordReview(childTaskId, 'failed', { run, localizedCause: reason, relatedTaskIds: dependencyTaskIds })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed' }
      remaining.delete(index)
      continue
    }
    if (settled.kind === 'failed') {
      const failed = settled.reason
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason: failed })
      await recordReview(childTaskId, 'failed', { run, localizedCause: failed, relatedTaskIds: dependencyTaskIds })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed' }
      remaining.delete(index)
      continue
    }

    // A child whose own worker decomposed further is settled by that nested
    // cascade: its run is terminal by the time the agent goes idle — and the
    // nested cascade already wrote this run's review record when it settled its
    // parent run. Adopt the run as this round's outcome — walking it through
    // verifying/verifyRun again would be an illegal transition on an already
    // verified task.
    const current = await env.task.runIn(storeId, run.runId)
    if (current.status === 'verified' || current.status === 'failed' || current.status === 'cancelled') {
      const evidenceId = current.status === 'verified'
        ? (await env.task.snapshotIn(storeId)).evidence.find(item => item.taskRunId === run.runId)?.evidenceId
        : undefined
      outcomes[index] = {
        taskId: childTaskId,
        runId: run.runId,
        status: current.status,
        ...(evidenceId === undefined ? {} : { evidenceId }),
      }
      if (current.status === 'verified') verified.add(index)
      remaining.delete(index)
      continue
    }

    await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'verifying', env.actor)
    let bundle: EvidenceBundle
    try {
      bundle = await verify(run.runId)
    } catch (error) {
      const reason = message(error)
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason })
      await recordReview(childTaskId, 'failed', { run, localizedCause: reason, relatedTaskIds: dependencyTaskIds })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed' }
      remaining.delete(index)
      if (error instanceof VerifierUnavailableError) {
        await blockRemaining(() => `verification is unavailable: ${reason}`)
        throw error
      }
      continue
    }
    const unmet = unmetMandatory(plan.task.acceptanceCriteria, bundle.verifierResults)
    if (unmet.length === 0) {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'verified', env.actor)
      await recordReview(childTaskId, 'verified', {
        run,
        relatedTaskIds: dependencyTaskIds,
        criteria: reviewCriteria(plan.task.acceptanceCriteria, bundle.verifierResults),
      })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'verified', evidenceId: bundle.evidenceId }
      verified.add(index)
    } else {
      const reason = failureReason(unmet)
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason })
      await recordReview(childTaskId, 'failed', {
        run,
        localizedCause: reason,
        relatedTaskIds: dependencyTaskIds,
        criteria: reviewCriteria(plan.task.acceptanceCriteria, bundle.verifierResults),
        logTail: await failedLogTail(env, unmet, bundle.verifierResults),
      })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed', evidenceId: bundle.evidenceId }
    }
    remaining.delete(index)
  }

  const settled = outcomes.map((outcome, index) => outcome ?? { taskId: plans[index]!.task.taskId, status: 'failed' })

  // Parent acceptance (RFC §47): the batch is settled, so the parent's own
  // criteria are judged now. A root task carries exactly one composite
  // criterion — pass iff every child verified — and the verifier decides, never
  // the caller: this only walks the parent run to the verdict it hears.
  if (isAborted(signal)) {
    await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'cancelled', env.actor, { reason: 'aborted by caller' })
    await recordReview(parentTask.taskId, 'cancelled', { run: parentRun, relatedTaskIds: childTaskIds })
    return settled
  }
  await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'verifying', env.actor)
  try {
    const parentBundle = await verify(parentRun.runId)
    const parentUnmet = unmetMandatory(parentTask.acceptanceCriteria, parentBundle.verifierResults)
    if (parentUnmet.length === 0) {
      await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'verified', env.actor)
      await recordReview(parentTask.taskId, 'verified', {
        run: parentRun,
        relatedTaskIds: childTaskIds,
        criteria: reviewCriteria(parentTask.acceptanceCriteria, parentBundle.verifierResults),
      })
    } else {
      const reason = failureReason(parentUnmet)
      await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'failed', env.actor, { reason })
      await recordReview(parentTask.taskId, 'failed', {
        run: parentRun,
        localizedCause: reason,
        relatedTaskIds: childTaskIds,
        criteria: reviewCriteria(parentTask.acceptanceCriteria, parentBundle.verifierResults),
        logTail: await failedLogTail(env, parentUnmet, parentBundle.verifierResults),
      })
    }
  } catch (error) {
    const reason = message(error)
    await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'failed', env.actor, { reason })
    await recordReview(parentTask.taskId, 'failed', { run: parentRun, localizedCause: reason, relatedTaskIds: childTaskIds })
    if (error instanceof VerifierUnavailableError) throw error
  }

  return settled
}

/**
 * Per-run overlay (guide §2.7.6, W15): candidate-side patches applied to ONE
 * replay run, never to the runtime's configuration. The evolution replay is
 * the only consumer; a normal run never carries one.
 */
export interface ReplayOverlay {
  /**
   * Whole-row capability replacements: an entry overrides the same-named row of
   * the configured table for this run's capability resolution (the same
   * whole-row semantics the sandbox's capability-table.patch.yml records).
   */
  capabilityOverrides?: Record<string, CapabilityConfig>
  /**
   * Extra skill roots forwarded to the worker grant (`WorkerGrant.skillRoots`):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   * skill layer, shadowing the same-name production skill for that worker alone.
   */
  extraSkillRoots?: string[]
  /**
   * Preset id mounted instead of the capability/default resolution. Must exist
   * in the deployment's preset roster — the roster scans constructor-fixed
   * roots only, so a sandbox-materialized preset is NOT mountable through this
   * seam (agent_preset replay stays manual in v1).
   */
  presetOverride?: string
}

/** Everything one replay run needs, pre-shaped by the caller (`TaskRuntime.replayTask`). */
export interface ReplayRunInit {
  /** The replayed task to create: parentless (depth 0), status `created`, objective already carrying the lineage tag. */
  task: TaskInstance
  /** The manifest resolved under the overlay. */
  manifest: CapabilityManifest
  /** Lineage marker (`evolution-replay:<proposalId>`), recorded on the review record's anomalies. */
  lineage: string
  /** The preset to mount; already overlay-resolved by the caller. */
  agentPreset?: string
  /** Worker prompt and its contract block, pre-rendered. Unused when `spawn` is false. */
  prompt?: string
  contract?: string
  /** Extra skill roots for the worker grant (overlay). */
  skillRoots?: readonly string[]
  /** false: deterministic criteria replay — no worker is spawned, the verifier alone settles the run. */
  spawn: boolean
  /** The champion run this replay stands in for, recorded as the run's parentRunId (execution lineage). */
  championRunId?: RunId
}

/** What one settled replay run reports back to the comparison report. */
export interface ReplayRunOutcome {
  taskId: TaskId
  runId: RunId
  status: 'verified' | 'failed' | 'cancelled'
  evidenceId?: string
  durationMs?: number
  criteria?: ReviewCriterion[]
}

/**
 * Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
 * the store, run it once through the real spawn + verify chain — or straight
 * through the verifier alone for a deterministic criteria replay — and settle
 * it with the cascade's own terminal-record discipline ({@link recordTerminalReview}),
 * the lineage tag on the record's anomalies. The replayed task is parentless
 * and the historical task it mirrors is never touched: a replay is a
 * comparison experiment, not a tree edit. A replay never decomposes (its
 * prompt says the door is closed), so there is no parent acceptance to settle.
 */
export async function runReplayTask(
  env: OrchestrateEnv,
  storeId: string,
  init: ReplayRunInit,
  signal?: AbortSignal,
): Promise<ReplayRunOutcome> {
  const task = init.task
  const anomalies = [init.lineage]
  await env.task.createTaskIn(storeId, task, env.actor)
  await env.task.admitTaskIn(storeId, task.taskId, env.actor, { decompositionStatus: 'leaf', manifest: init.manifest })

  const sessionId = `s-${randomUUID()}`
  // The run exists before the spawn attempt so a spawn refusal can still walk
  // it to a terminal state — same discipline as the cascade.
  const run: TaskRun = {
    runId: `r-${randomUUID()}`,
    taskId: task.taskId,
    sessionId,
    ...(init.championRunId === undefined ? {} : { parentRunId: init.championRunId }),
    capabilitySnapshot: capabilitySnapshot(init.manifest),
    ...(init.agentPreset === undefined ? {} : { agentPreset: init.agentPreset }),
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  await env.task.startRunIn(storeId, run, env.actor)

  const finish = async (status: 'verified' | 'failed' | 'cancelled', criteria?: ReviewCriterion[], evidenceId?: string): Promise<ReplayRunOutcome> => ({
    taskId: task.taskId,
    runId: run.runId,
    status,
    durationMs: await runDurationMs(env, storeId, run),
    ...(criteria === undefined ? {} : { criteria }),
    ...(evidenceId === undefined ? {} : { evidenceId }),
  })

  /** Hand the run to the verifier and settle it on the verdict — the cascade's own ending, minus the parent. */
  const verifyAndSettle = async (): Promise<ReplayRunOutcome> => {
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'verifying', env.actor)
    let bundle: EvidenceBundle
    try {
      bundle = await verifyWithDeadline(env, storeId, run.runId)
    } catch (error) {
      const reason = message(error)
      await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
      await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
      if (error instanceof VerifierUnavailableError) throw error
      return finish('failed')
    }
    const criteria = reviewCriteria(task.acceptanceCriteria, bundle.verifierResults)
    const unmet = unmetMandatory(task.acceptanceCriteria, bundle.verifierResults)
    if (unmet.length === 0) {
      await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'verified', env.actor)
      await recordTerminalReview(env, storeId, task.taskId, 'verified', { run, criteria, anomalies })
      return finish('verified', criteria, bundle.evidenceId)
    }
    const reason = failureReason(unmet)
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', {
      run,
      localizedCause: reason,
      criteria,
      logTail: await failedLogTail(env, unmet, bundle.verifierResults),
      anomalies,
    })
    return finish('failed', criteria, bundle.evidenceId)
  }

  if (!init.spawn) return verifyAndSettle()

  let handle: AgentHandle
  try {
    await assertPresetUsable(env, init.manifest, init.agentPreset)
    const permissionPreset = permissionFor(env, init.manifest)
    handle = await env.spawn({
      sessionId,
      name: task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `replay-${task.taskId}`,
      prompt: init.prompt ?? '',
      ...(init.contract === undefined ? {} : { contract: init.contract }),
      grant: { ...(await authorizedGrant(env, init.manifest)), ...(init.skillRoots === undefined ? {} : { skillRoots: [...init.skillRoots] }) },
      ...(init.agentPreset === undefined ? {} : { agentPreset: init.agentPreset }),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    const reason = `spawn failed: ${message(error)}`
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
    return finish('failed')
  }

  env.onRunBound(sessionId, { storeId, taskId: task.taskId, runId: run.runId })

  const settled = await awaitWorker(handle, signal, env.budget?.wallTimeMs)
  if (settled.kind === 'aborted') {
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'cancelled', env.actor, { reason: 'aborted by caller' })
    await recordTerminalReview(env, storeId, task.taskId, 'cancelled', { run, anomalies })
    return finish('cancelled')
  }
  if (settled.kind === 'budget-exhausted') {
    const reason = budgetExhaustedReason('wallTimeMs', `worker run exceeded its wall-clock limit of ${env.budget?.wallTimeMs}ms`)
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
    return finish('failed')
  }
  if (settled.kind === 'failed') {
    const failed = settled.reason
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason: failed })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: failed, anomalies })
    return finish('failed')
  }

  // A replay worker that decomposed anyway (the deployment's runtime-split
  // switch admits it) settled its own run through the nested cascade, which
  // also wrote the record. Adopt that terminal state instead of verifying
  // twice — the cascade's own adoption rule.
  const current = await env.task.runIn(storeId, run.runId)
  if (current.status === 'verified' || current.status === 'failed' || current.status === 'cancelled') {
    const snapshot = await env.task.snapshotIn(storeId)
    const record = snapshot.reviews.find(item => item.runId === run.runId)
    const evidenceId = current.status === 'verified'
      ? snapshot.evidence.find(item => item.taskRunId === run.runId)?.evidenceId
      : undefined
    return {
      taskId: task.taskId,
      runId: run.runId,
      status: current.status,
      ...(record?.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      ...(record?.criteria === undefined ? {} : { criteria: record.criteria.map(item => ({ ...item })) }),
      ...(evidenceId === undefined ? {} : { evidenceId }),
    }
  }

  return verifyAndSettle()
}

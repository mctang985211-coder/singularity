/**
 * Verification side: criteria judging, artifact gates, timeouts and escalation hints.
 */

import type {
  AcceptanceCriterion,
  EvidenceBundle,
  ReviewCriterion,
  RunId,
  RunStatus,
  TaskSnapshot,
  TaskStatus,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'
import { TERMINAL_RUN_STATUSES } from '@dangosys/dsh-singularity-task'
import type { MissingArtifact, OrchestrateEnv } from './types.ts'
import type { UnmetCriterion } from './types.ts'

/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
const VERIFY_SAFETY_MARGIN_MS = 15_000

/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * The KISS §4.3 UNKNOWN split, rendered into the orchestrator's feedback so a
 * reader never mistakes "the criterion was never tested" for "the judge is
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

export function unmetMandatory(
  criteria: readonly AcceptanceCriterion[],
  results: readonly VerificationResult[],
): UnmetCriterion[] {
  return criteria
    .filter(criterion => criterion.mandatory)
    .flatMap(criterion => {
      const result = results.find(item => item.criterionId === criterion.criterionId)
      /**
       * KISS §5.1: a criterion explicitly labeled heuristic is judged and labeled,
       * never counted as a deterministic pass — a natural-language coverage signal
       */
      if (criterion.heuristic === true) {
        return [
          {
            criterionId: criterion.criterionId,
            detail: `heuristic judgement${result === undefined ? '' : ` (verdict ${result.status})`} — explicitly labeled heuristic, not counted as a deterministic pass`,
          },
        ]
      }
      if (result?.status === 'pass') return []
      return [
        {
          criterionId: criterion.criterionId,
          detail:
            result === undefined
              ? 'no result'
              : `${result.status}${unknownTag(result)}${result.details === undefined ? '' : ` (${result.details})`}`,
        },
      ]
    })
}

export function failureReason(unmet: readonly UnmetCriterion[]): string {
  return `mandatory criteria not satisfied: ${unmet.map(item => `${item.criterionId} ${item.detail}`).join(', ')}`
}

/**
 * The artifact references (per criterion) that no store evidence satisfies yet.
 * A reference matches an evidence id, an artifact kind, or an artifact id — the
 */
export function missingRequiredArtifacts(
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

/** The one-line reason a set of missing references carries, shared by the spawn gate and the submission gate. */
export function missingArtifactReason(missing: readonly MissingArtifact[]): string {
  return `missing required artifacts: ${missing
    .map(
      item =>
        `${item.ref} (criterion ${item.criterionId}${item.requirement === 'accepts' ? '; raw input, any run state' : ''})`,
    )
    .join(', ')}`
}

/**
 * Copy the verifier's per-criterion results onto a review record, filling the
 * command from the criterion itself when the result omits it — the record
 */
export function reviewCriteria(
  criteria: readonly AcceptanceCriterion[],
  results: readonly VerificationResult[],
): ReviewCriterion[] {
  return results.map(result => {
    const command = result.command ?? criteria.find(item => item.criterionId === result.criterionId)?.command
    return {
      criterionId: result.criterionId,
      verdict: result.status,
      ...(result.verifierId === undefined ? {} : { verifierId: result.verifierId }),
      ...(result.verifierVersion === undefined ? {} : { verifierVersion: result.verifierVersion }),
      ...(command === undefined ? {} : { command }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.logRef === undefined ? {} : { logRef: result.logRef }),
      ...(result.unknownKind === undefined ? {} : { unknownKind: result.unknownKind }),
    }
  })
}

/**
 * Safety net around one verifier call. The verifier holds its own deadline
 * (`timeoutMs` goes down with every call) and kills whatever it started, so
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, runId: RunId): Promise<T> {
  work.catch(() => {})
  const budgetMs = timeoutMs + VERIFY_SAFETY_MARGIN_MS
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `task-runtime: verification of run "${runId}" timed out after ${budgetMs}ms (verifier deadline ${timeoutMs}ms + ${VERIFY_SAFETY_MARGIN_MS}ms safety margin)`,
          ),
        ),
      budgetMs,
    )
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

/**
 * Hand the verifier its own deadline, the workspace its run works in, and keep
 * the safety net one margin behind it. The run's placement workspace is what
 * the criterion commands run in: the verifier confines them to it, so a run
 * whose workspace this deployment still holds is judged in that workspace and
 * not in whatever directory the caller happened to work in.
 */
export async function verifyWithDeadline(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<EvidenceBundle> {
  const run = await env.task.runIn(storeId, runId)
  const cwd = run.placement?.workspacePath
  return withTimeout(
    env.verifyRun(storeId, runId, { ...(cwd === undefined ? {} : { cwd }), timeoutMs: env.verifyTimeoutMs }),
    env.verifyTimeoutMs,
    runId,
  )
}

/**
 * The L4 exit pointer (KISS §7, VRTC plan phase 3.1), appended to the feedback
 * a root agent reads at each of the three trigger sites. The escalation ledger
 */
export function escalationHint(what: string, tried: string, suggested: string): string {
  return `L4 exit (KISS §7): report this to a human with the escalate tool — what: ${what}; tried: ${tried}; suggested: ${suggested}`
}

/** Tail of the first unmet criterion that has a log; a missing reader or log keeps the field off the record. */
export async function failedLogTail(
  env: OrchestrateEnv,
  unmet: readonly UnmetCriterion[],
  results: readonly VerificationResult[],
): Promise<string | undefined> {
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

/**
 * ------------------------------------------------------------------------- *
 * Batch driving (A3 §3.1/§3.2/§3.6/§3.7)
 */

/** Run statuses that end a run: the states a batch adopts instead of driving further (the task package's own set). */
export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** Task statuses that end a child — a child in one of these is adopted, never started again. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['verified', 'failed', 'blocked', 'cancelled'])

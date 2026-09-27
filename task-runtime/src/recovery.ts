/**
 * The execution-recovery entry's own rules (A6, plan §F.4): one failed root
 * task's **new attempt** — a new root Run/Session in the same store — and the
 * evidence a passed sibling contributes to it.
 *
 * What lives here and what does not. The runtime's entry
 * (`TaskRuntime.recoverRootTask`) owns the sequencing: it re-checks the store's
 * facts, the capability rows, the limits and the attempt's idempotency, then
 * writes one new run and spawns its worker. What lives in *this* module is the
 * part of that judgement that is a pure function of the request and the store's
 * snapshot — the request's closed shape, which run is which attempt, what makes
 * two attempts the same content, and which reuse declarations are invalid — so
 * the rules can be read (and tested) without the service around them.
 *
 * Three boundaries the code below states and the entry then holds to:
 *
 * 1. **The runtime never decides policy that is not its store's.** It reads the
 *    source task, its contract and criteria, its runs, the diagnosis record and
 *    the limits — nothing else. It does not import evolution, does not read a
 *    promotion ledger, and has no parameter that could stand for a person's
 *    approval: "the capability change was approved and applied" is answered by
 *    the store and the effective table (the required rows exist and their
 *    providers pass the ordinary pre-check), never by a caller's flag.
 * 2. **An attempt is a run, and the run is the record.** "Which attempt is
 *    this?" is answered from the source task's runs and their `recovery`
 *    fields, and "is it in flight?" from the run's own status — there is no
 *    second table where an attempt could be in flight and its run terminal.
 * 3. **A reuse is a citation, not a copy.** A declaration names the sibling
 *    task, its own verified run, the evidence bundle, the criterion and the
 *    input/product references; every one of them is resolved against the store
 *    and the *original* acceptance map. A citation that does not resolve is a
 *    refusal that lists what it could not resolve — the agent then proposes the
 *    work again — and never a silently weaker binding.
 * @module @dangosys/dsh-singularity-task-runtime/recovery
 */

import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import type {
  RunId,
  RunMemberReuse,
  RunRecovery,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'

/**
 * One already verified sibling the new attempt reads at one of its leading
 * positions (plan §F.4, "已通过兄弟证据复用"): a citation of the task, the run
 * that verified it, the evidence bundle and the input/product references the
 * citation rests on.
 *
 * Every field is an identity the store can be asked about, because that is what
 * the refusal has to name when one of them does not resolve. Positions are the
 * run's leading slots (`0, 1, …` in declaration order), which is what
 * {@link RunMemberReuse} pins.
 */
export interface RootRecoveryReuse {
  /** The position in the attempt's member sequence this citation fills; must be its own index in the list. */
  childIndex: number
  /** The verified sibling task, a child of the source root task. */
  taskId: TaskId
  /** The sibling's own verified run — the one whose evidence is cited. */
  sourceRunId: RunId
  /** The evidence bundle under that run. */
  evidenceId: string
  /** The criterion the citation narrows to, when the original acceptance map names one for this position. */
  criterionId?: string
  /** Artifacts the citation names (artifact id or kind), all present in the cited bundle. */
  artifactRefs?: readonly string[]
  /** Input references the citation names, from the sibling's own declared input vocabulary. */
  inputRefs?: readonly string[]
}

/**
 * One recovery request, as the host composition layer hands it to the runtime
 * (plan §F.4: the tool and evolution's coordinator call this entry, and each
 * layer re-checks its own rules).
 *
 * The four identity fields are required and are the whole subject: *which* task
 * failed, *which* of its runs the failure is (or `null` when it had none — a
 * rejected admission, a blocked task), *which* diagnosis asks for the attempt,
 * and the caller's key. `reuses` is the optional second half: the siblings the
 * attempt reads instead of re-running, and nothing else about the work — what
 * to build and how is the new attempt's own proposals' business.
 */
export interface RootRecoveryRequest {
  sourceTaskId: TaskId
  /** The failed run of the source task, or `null` when the failure had no run. */
  sourceRunId: RunId | null
  /** The diagnosis this recovery is asked for; it must be a record of this store naming this task. */
  sourceDiagnosisId: string
  /** The caller's request key: one key names one attempt of one diagnosis. */
  requestKey: string
  /** The verified siblings the new attempt reads at its leading positions, in position order. */
  reuses?: readonly RootRecoveryReuse[]
}

/** The fields one request may carry: anything else is refused by name rather than ignored. */
const REQUEST_FIELDS: readonly string[] = ['sourceTaskId', 'sourceRunId', 'sourceDiagnosisId', 'requestKey', 'reuses']
/** The fields one reuse declaration may carry. */
const REUSE_FIELDS: readonly string[] = ['childIndex', 'taskId', 'sourceRunId', 'evidenceId', 'criterionId', 'artifactRefs', 'inputRefs']

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every reason one request cannot be a recovery request at all: an unknown
 * field (a caller may not smuggle a decision in), a missing or empty identity,
 * a `reuses` member that is not a declaration. Structural only — whether the
 * named task, run or diagnosis exists is the store's answer, asked after this
 * (and answered as a refusal of its own).
 */
export function recoveryRequestDefects(request: unknown): string[] {
  if (!isRecord(request)) return ['the request must be an object']
  const defects: string[] = []
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.includes(key)) {
      defects.push(`unknown field "${key}": a recovery request carries ${REQUEST_FIELDS.join(', ')} and nothing else`)
    }
  }
  if (!nonEmpty(request.sourceTaskId)) defects.push('sourceTaskId must be a non-empty task id')
  if (request.sourceRunId !== null && !nonEmpty(request.sourceRunId)) {
    defects.push('sourceRunId must be a non-empty run id or null (a failure that had no run)')
  }
  if (!nonEmpty(request.sourceDiagnosisId)) defects.push('sourceDiagnosisId must be a non-empty diagnosis id')
  if (!nonEmpty(request.requestKey)) defects.push('requestKey must be a non-empty string')
  if (request.reuses !== undefined) {
    if (!Array.isArray(request.reuses)) defects.push('reuses must be an array of declarations')
    else {
      request.reuses.forEach((entry, position) => {
        if (!isRecord(entry)) {
          defects.push(`reuses[${position}] must be an object`)
          return
        }
        for (const key of Object.keys(entry)) {
          if (!REUSE_FIELDS.includes(key)) defects.push(`reuses[${position}] has unknown field "${key}"`)
        }
        if (entry.childIndex !== position) {
          defects.push(
            `reuses[${position}].childIndex is ${JSON.stringify(entry.childIndex)}; a reused member occupies its own position (${position})`,
          )
        }
        for (const name of ['taskId', 'sourceRunId', 'evidenceId'] as const) {
          if (!nonEmpty(entry[name])) defects.push(`reuses[${position}].${name} must be a non-empty id`)
        }
        if (entry.criterionId !== undefined && !nonEmpty(entry.criterionId)) {
          defects.push(`reuses[${position}].criterionId must be a non-empty string when given`)
        }
        for (const name of ['artifactRefs', 'inputRefs'] as const) {
          const value = entry[name]
          if (value !== undefined && (!Array.isArray(value) || value.some(item => !nonEmpty(item)))) {
            defects.push(`reuses[${position}].${name} must be an array of non-empty references`)
          }
        }
      })
    }
  }
  return defects
}

/** The runs of one source task that are recovery attempts, in start order (which is the store's run order). */
export function recoveryAttemptsOf(snapshot: TaskSnapshot, sourceTaskId: TaskId): TaskRun[] {
  return snapshot.runs.filter(run => run.taskId === sourceTaskId && run.recovery !== undefined)
}

/** The attempt one request key names on a source task, or `undefined`. */
export function recoveryAttemptWithKey(snapshot: TaskSnapshot, sourceTaskId: TaskId, requestKey: string): TaskRun | undefined {
  return recoveryAttemptsOf(snapshot, sourceTaskId).find(run => run.recovery!.requestKey === requestKey)
}

/**
 * The attempt one diagnosis already has whose run has not settled, or
 * `undefined` — the mutual exclusion one diagnosis's recovery has (plan §F.4:
 * "无在途恢复尝试"). "In flight" is the run's own status and nothing else: a
 * run that is still `running` is an attempt still being made, and every
 * terminal status — verified, failed, cancelled, blocked — releases the
 * diagnosis for another key.
 */
export function inFlightRecoveryAttempt(snapshot: TaskSnapshot, sourceTaskId: TaskId, sourceDiagnosisId: string): TaskRun | undefined {
  return recoveryAttemptsOf(snapshot, sourceTaskId)
    .find(run => run.recovery!.sourceDiagnosisId === sourceDiagnosisId && run.status === 'running')
}

/**
 * What makes two attempts under one key the *same* attempt: the content the key
 * is bound to — the source run it recovers and the reuse it declares. A retry
 * of the same request reproduces this digest and is answered from the record; a
 * different content under the same key is a refusal by name (the rule every
 * request key in this runtime follows).
 */
export function recoveryAttemptDigest(recovery: Pick<RunRecovery, 'sourceRunId' | 'reusedMembers'>): string {
  return sha256Hex(canonicalize({
    sourceRunId: recovery.sourceRunId ?? null,
    reusedMembers: recovery.reusedMembers.map(member => ({
      childIndex: member.childIndex,
      taskId: member.taskId,
      sourceRunId: member.sourceRunId,
      evidenceId: member.evidenceId,
      criterionId: member.criterionId ?? null,
      artifactRefs: [...member.artifactRefs],
      inputRefs: [...member.inputRefs],
    })),
  }))
}

/** The request's own content identity, derived from the same fields the stored attempt carries. */
export function requestAttemptDigest(request: RootRecoveryRequest): string {
  return recoveryAttemptDigest({
    ...(request.sourceRunId === null ? {} : { sourceRunId: request.sourceRunId }),
    reusedMembers: (request.reuses ?? []).map(declaration => ({
      childIndex: declaration.childIndex,
      taskId: declaration.taskId,
      sourceRunId: declaration.sourceRunId,
      evidenceId: declaration.evidenceId,
      ...(declaration.criterionId === undefined ? {} : { criterionId: declaration.criterionId }),
      artifactRefs: [...(declaration.artifactRefs ?? [])],
      inputRefs: [...(declaration.inputRefs ?? [])],
    })),
  })
}

/** What a reuse declaration is judged against: the source task, its contract's map, and the failed attempt's own members. */
export interface ReuseContext {
  /** The source root task the attempt is opened for. */
  readonly source: TaskInstance
  /** The failed run the attempt recovers, when the failure had one. */
  readonly sourceRun?: TaskRun
  /** The members that failed run read, in position order — what `childIndex` names. */
  readonly sourceMembers: readonly TaskId[]
  readonly snapshot: TaskSnapshot
}

/** The input references one sibling task declares, across its criteria (`requiresArtifact`, `acceptsArtifact`, `protectedInputs`). */
function declaredInputsOf(task: TaskInstance): Set<string> {
  return new Set(task.acceptanceCriteria.flatMap(criterion => [
    ...(criterion.requiresArtifact ?? []),
    ...(criterion.acceptsArtifact ?? []),
    ...(criterion.protectedInputs ?? []).map(input => input.path),
  ]))
}

/** One declaration's citation, resolved against the store, or the reasons it does not resolve. */
function citationDefects(declaration: RootRecoveryReuse, context: ReuseContext, position: number): string[] {
  const at = `reuses[${position}]`
  const defects: string[] = []
  const sibling = context.snapshot.tasks.find(task => task.taskId === declaration.taskId)
  if (sibling === undefined) {
    return [`${at}: no task "${declaration.taskId}" exists in this store`]
  }
  if (sibling.parentTaskId !== context.source.taskId) {
    defects.push(`${at}: task "${sibling.taskId}" is a child of "${sibling.parentTaskId ?? '(none)'}", not of "${context.source.taskId}" — only a sibling of this attempt's own task is reusable`)
  }
  if (sibling.status !== 'verified') {
    defects.push(`${at}: sibling "${sibling.taskId}" is ${sibling.status}, not verified — only a passed sibling's evidence is reusable`)
  }
  const run = context.snapshot.runs.find(candidate => candidate.runId === declaration.sourceRunId)
  if (run === undefined) {
    defects.push(`${at}: no run "${declaration.sourceRunId}" exists in this store`)
    return defects
  }
  if (run.taskId !== declaration.taskId) {
    defects.push(`${at}: run "${run.runId}" belongs to task "${run.taskId}", not to the cited sibling "${declaration.taskId}"`)
  }
  if (run.status !== 'verified') {
    defects.push(`${at}: cited run "${run.runId}" is ${run.status}, not verified — only evidence of a verified run is reusable`)
  }
  const bundle = context.snapshot.evidence.find(item => item.evidenceId === declaration.evidenceId)
  if (bundle === undefined) {
    defects.push(`${at}: no evidence "${declaration.evidenceId}" exists in this store`)
    return defects
  }
  if (bundle.taskRunId !== run.runId || bundle.taskId !== run.taskId) {
    defects.push(
      `${at}: evidence "${bundle.evidenceId}" belongs to task "${bundle.taskId}"/run "${bundle.taskRunId}", ` +
      `not to the cited "${run.taskId}"/"${run.runId}"`,
    )
  }
  const products = new Set(bundle.artifacts.flatMap(artifact => [artifact.artifactId, artifact.kind]))
  for (const reference of declaration.artifactRefs ?? []) {
    if (!products.has(reference)) defects.push(`${at}: evidence "${bundle.evidenceId}" holds no artifact "${reference}" (by artifact id or kind)`)
  }
  const inputs = declaredInputsOf(sibling)
  for (const reference of declaration.inputRefs ?? []) {
    if (!inputs.has(reference)) {
      defects.push(`${at}: sibling "${sibling.taskId}" declares no input "${reference}" (requiresArtifact, acceptsArtifact or protectedInputs)`)
    }
  }
  if (declaration.criterionId !== undefined) {
    if (!sibling.acceptanceCriteria.some(criterion => criterion.criterionId === declaration.criterionId)) {
      defects.push(`${at}: sibling "${sibling.taskId}" declares no criterion "${declaration.criterionId}"`)
    } else {
      const verdict = bundle.verifierResults.find(result => result.criterionId === declaration.criterionId)
      if (verdict?.status !== 'pass') {
        defects.push(
          `${at}: criterion "${declaration.criterionId}" of sibling "${sibling.taskId}" carries ` +
          `${verdict === undefined ? 'no verdict' : `a "${verdict.status}" verdict`} in evidence "${bundle.evidenceId}" — only a passing verdict is reusable`,
        )
      }
    }
  }
  return defects
}

/**
 * Every reason the declared reuse cannot be a binding of the original
 * acceptance map — the "invalid reference" refusal, with the affected item
 * named per reason (plan §F.4: "无效引用拒绝并列出受影响项").
 *
 * Three questions, in the order a reader checks them:
 *
 * 1. **Does the position exist in the failed attempt?** The cited sibling must
 *    be the member the failed run reads at that very position (`childIndex`),
 *    which is what "the same position" means. A source that failed without a
 *    run — a rejected admission, a blocked task — has no member sequence to
 *    read positions from, so a reuse of it is refused by name rather than
 *    bound to a position nobody can check.
 * 2. **Does the citation resolve?** The sibling, its verified run, the bundle,
 *    the criterion's passing verdict, the artifacts and the declared inputs —
 *    {@link citationDefects}.
 * 3. **Does it agree with the original acceptance map?** Where the map names
 *    this position, the criterion it narrows to is the criterion the binding
 *    carries: a declaration that names nothing there, or names another
 *    criterion, is refused — the map is immutable and the attempt binds to it,
 *    never around it.
 */
export function reuseDefects(declarations: readonly RootRecoveryReuse[], context: ReuseContext): string[] {
  const defects: string[] = []
  const map = context.source.acceptanceCriteria.flatMap(criterion => criterion.childEvidence ?? [])
  declarations.forEach((declaration, position) => {
    const at = `reuses[${position}]`
    if (context.sourceRun === undefined) {
      defects.push(
        `${at}: source task "${context.source.taskId}" failed without a run, so there is no member sequence to read position ${position} from; ` +
        'a reuse is bound to the positions of the failed attempt and cannot be checked against nothing',
      )
    } else if (context.sourceMembers[position] !== declaration.taskId) {
      defects.push(
        `${at}: the failed run "${context.sourceRun.runId}" reads ${context.sourceMembers[position] === undefined ? 'no member' : `"${context.sourceMembers[position]}"`} ` +
        `at position ${position}, not the cited "${declaration.taskId}"`,
      )
    }
    defects.push(...citationDefects(declaration, context, position))
    const entry = map.find(item => item.childIndex === position)
    if (entry !== undefined && entry.criterionId !== undefined && entry.criterionId !== declaration.criterionId) {
      defects.push(
        `${at}: the original acceptance map narrows position ${position} to criterion "${entry.criterionId}", ` +
        `and this declaration ${declaration.criterionId === undefined ? 'names no criterion' : `names "${declaration.criterionId}"`}`,
      )
    }
  })
  return defects
}

/** The stored form of one declaration: the closed record the run carries. */
export function storedReuse(declaration: RootRecoveryReuse): RunMemberReuse {
  return {
    childIndex: declaration.childIndex,
    taskId: declaration.taskId,
    sourceRunId: declaration.sourceRunId,
    evidenceId: declaration.evidenceId,
    ...(declaration.criterionId === undefined ? {} : { criterionId: declaration.criterionId }),
    artifactRefs: [...(declaration.artifactRefs ?? [])],
    inputRefs: [...(declaration.inputRefs ?? [])],
  }
}

/**
 * The execution-recovery entry's own rules (A6, plan §F.4): one failed root
 * task's **new attempt** — a new root Run/Session in the same store — and the
 */

import { canonicalize, runMemberSlots, sha256Hex } from '@dangosys/dsh-singularity-task'
import type {
  ChildEvidenceRef,
  RunId,
  RunMemberReuse,
  RunMemberReuseRefusal,
  RunRecovery,
  RunStatus,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { missingRequiredArtifacts } from './orchestration/verify.ts'
import { isPlainObject, nonBlank, unknownFieldKeys } from './helpers.ts'

/**
 * One already verified sibling the new attempt reads at one of its leading
 * positions (plan §F.4, "已通过兄弟证据复用"): a citation of the task, the run
 */
export interface RootRecoveryReuse {
  /** The absolute position in the attempt's member sequence this citation claims; unique within one request. */
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

/** Which round a request asks for: `recovery` (the default) re-runs a failed source, `improve` re-runs a verified one. */
export type RecoveryMode = 'recovery' | 'improve'

/** The stored kind one mode writes into {@link RunRecovery.kind}. */
export function recoveryKindOf(mode: RecoveryMode | undefined): 'recovery' | 'improvement' {
  return mode === 'improve' ? 'improvement' : 'recovery'
}

/** The mode one stored kind was asked under; a record written before the field existed reads as a recovery. */
export function recoveryModeOf(kind: 'recovery' | 'improvement' | undefined): RecoveryMode {
  return kind === 'improvement' ? 'improve' : 'recovery'
}

/**
 * One recovery request, as the host composition layer hands it to the runtime
 * (plan §F.4: the tool and evolution's coordinator call this entry, and each
 */
export interface RootRecoveryRequest {
  sourceTaskId: TaskId
  /** The source run of the attempt, or `null` when the source had none; a failed run for `recovery`, a verified one for `improve`. */
  sourceRunId: RunId | null
  /** The diagnosis this recovery is asked for; it must be a record of this store naming this task. */
  sourceDiagnosisId: string
  /** The caller's request key: one key names one attempt of one diagnosis. */
  requestKey: string
  /**
   * Which round this is. Absent or `recovery` is the failed-source path; `improve` asks for an improvement round of a
   * verified source, judged by the same original criteria. The two spend separate per-source caps.
   */
  mode?: RecoveryMode
  /** Applied evolution proposals consumed by this new attempt, verified by recovery coordination. */
  proposalIds?: readonly string[]
  /** The verified siblings the new attempt reads at its leading positions, in position order. */
  reuses?: readonly RootRecoveryReuse[]
}

/** The fields one request may carry: anything else is refused by name rather than ignored. */
const REQUEST_FIELDS: readonly string[] = [
  'sourceTaskId',
  'sourceRunId',
  'sourceDiagnosisId',
  'requestKey',
  'mode',
  'reuses',
  'proposalIds',
]
/** The fields one reuse declaration may carry. */
const REUSE_FIELDS: readonly string[] = [
  'childIndex',
  'taskId',
  'sourceRunId',
  'evidenceId',
  'criterionId',
  'artifactRefs',
  'inputRefs',
]

/**
 * Every reason one request cannot be a recovery request at all: an unknown
 * field (a caller may not smuggle a decision in), a missing or empty identity,
 */
export function recoveryRequestDefects(request: unknown): string[] {
  if (!isPlainObject(request)) return ['the request must be an object']
  const defects: string[] = []
  for (const key of unknownFieldKeys(request, REQUEST_FIELDS)) {
    defects.push(`unknown field "${key}": a recovery request carries ${REQUEST_FIELDS.join(', ')} and nothing else`)
  }
  if (!nonBlank(request.sourceTaskId)) defects.push('sourceTaskId must be a non-empty task id')
  if (request.sourceRunId !== null && !nonBlank(request.sourceRunId)) {
    defects.push('sourceRunId must be a non-empty run id or null (a failure that had no run)')
  }
  if (!nonBlank(request.sourceDiagnosisId)) defects.push('sourceDiagnosisId must be a non-empty diagnosis id')
  if (!nonBlank(request.requestKey)) defects.push('requestKey must be a non-empty string')
  if (request.mode !== undefined && request.mode !== 'recovery' && request.mode !== 'improve') {
    defects.push('mode must be "recovery" (the default) or "improve"')
  }
  if (
    request.proposalIds !== undefined &&
    (!Array.isArray(request.proposalIds) ||
      request.proposalIds.some(id => !nonBlank(id)) ||
      new Set(request.proposalIds).size !== request.proposalIds.length)
  ) {
    defects.push('proposalIds must be an array of unique non-empty proposal ids')
  }
  if (request.reuses !== undefined) {
    if (!Array.isArray(request.reuses)) defects.push('reuses must be an array of declarations')
    else {
      const claimed = new Set<number>()
      request.reuses.forEach((entry, position) => {
        if (!isPlainObject(entry)) {
          defects.push(`reuses[${position}] must be an object`)
          return
        }
        for (const key of unknownFieldKeys(entry, REUSE_FIELDS)) {
          defects.push(`reuses[${position}] has unknown field "${key}"`)
        }
        if (!Number.isInteger(entry.childIndex) || (entry.childIndex as number) < 0) {
          defects.push(`reuses[${position}].childIndex must be a non-negative integer`)
        }
        for (const name of ['taskId', 'sourceRunId', 'evidenceId'] as const) {
          if (!nonBlank(entry[name])) defects.push(`reuses[${position}].${name} must be a non-empty id`)
        }
        if (entry.criterionId !== undefined && !nonBlank(entry.criterionId)) {
          defects.push(`reuses[${position}].criterionId must be a non-empty string when given`)
        }
        for (const name of ['artifactRefs', 'inputRefs'] as const) {
          const value = entry[name]
          if (value !== undefined && (!Array.isArray(value) || value.some(item => !nonBlank(item)))) {
            defects.push(`reuses[${position}].${name} must be an array of non-empty references`)
          }
        }
        if (Number.isInteger(entry.childIndex) && (entry.childIndex as number) >= 0) {
          if (claimed.has(entry.childIndex as number)) {
            defects.push(
              `reuses[${position}].childIndex ${entry.childIndex} is claimed by another entry; one position reads one member`,
            )
          }
          claimed.add(entry.childIndex as number)
        }
      })
    }
  }
  return defects
}

/** The runs of one source task that are recovery attempts, in start order (which is the store's run order). */
function recoveryAttemptsOf(snapshot: TaskSnapshot, sourceTaskId: TaskId): TaskRun[] {
  return snapshot.runs.filter(run => run.taskId === sourceTaskId && run.recovery !== undefined)
}

/** The attempt one request key names on a source task, or `undefined`. */
export function recoveryAttemptWithKey(
  snapshot: TaskSnapshot,
  sourceTaskId: TaskId,
  requestKey: string,
): TaskRun | undefined {
  return recoveryAttemptsOf(snapshot, sourceTaskId).find(run => run.recovery!.requestKey === requestKey)
}

/**
 * The attempt one diagnosis already has whose run has not settled, or
 * `undefined` — the mutual exclusion one diagnosis's recovery has (plan §F.4:
 */
export function inFlightRecoveryAttempt(
  snapshot: TaskSnapshot,
  sourceTaskId: TaskId,
  sourceDiagnosisId: string,
): TaskRun | undefined {
  return recoveryAttemptsOf(snapshot, sourceTaskId).find(
    run => run.recovery!.sourceDiagnosisId === sourceDiagnosisId && run.status === 'running',
  )
}

/**
 * What makes two attempts under one key the *same* attempt: the content the key
 * is bound to — the kind of round, the source run it reads and the reuse it declares. A retry
 */
export function recoveryAttemptDigest(
  recovery: Pick<RunRecovery, 'sourceRunId' | 'reusedMembers' | 'proposalIds'> & {
    readonly kind?: RunRecovery['kind']
  },
): string {
  return sha256Hex(
    canonicalize({
      kind: recovery.kind ?? 'recovery',
      sourceRunId: recovery.sourceRunId ?? null,
      ...(recovery.proposalIds?.length ? { proposalIds: [...recovery.proposalIds].sort() } : {}),
      reusedMembers: recovery.reusedMembers.map(member => ({
        childIndex: member.childIndex,
        taskId: member.taskId,
        sourceRunId: member.sourceRunId,
        evidenceId: member.evidenceId,
        criterionId: member.criterionId ?? null,
        artifactRefs: [...member.artifactRefs],
        inputRefs: [...member.inputRefs],
      })),
    }),
  )
}

/**
 * The source run one attempt reads, or `undefined` when the failure had none: a
 * `recovery` names a run that settled `failed`, an `improve` a verified one — and
 * an `improve` that names none reads the task's newest verified run.
 */
export function recoverySourceRun(
  source: TaskInstance,
  request: RootRecoveryRequest,
  snapshot: TaskSnapshot,
  kind: 'recovery' | 'improvement',
): TaskRun | undefined {
  const wanted: RunStatus = kind === 'improvement' ? 'verified' : 'failed'
  const which = kind === 'improvement' ? 'a verified' : 'a *failed*'
  if (request.sourceRunId !== null) {
    const run = snapshot.runs.find(candidate => candidate.runId === request.sourceRunId)
    if (run === undefined) {
      throw new Error(
        `task-runtime: store "${snapshot.id}" holds no run "${request.sourceRunId}"; the named source attempt does not exist`,
      )
    }
    if (run.taskId !== source.taskId) {
      throw new Error(
        `task-runtime: run "${run.runId}" belongs to task "${run.taskId}", not to the named source "${source.taskId}"; nothing was written`,
      )
    }
    if (run.status !== wanted) {
      throw new Error(
        `task-runtime: source run "${run.runId}" is ${run.status}; ${kind === 'improvement' ? 'an improvement round reads' : 'a recovery recovers'} ` +
          `${which} attempt (its run settled \`${wanted}\`), and this run is not one`,
      )
    }
    return run
  }
  const running = snapshot.runs.filter(run => run.taskId === source.taskId && run.status === 'running')
  if (running.length > 0) {
    throw new Error(
      `task-runtime: the request names no source run, but task "${source.taskId}" holds a run in flight (${running.map(run => run.runId).join(', ')}); ` +
        'a failure without a run is a task that never started, not one an attempt is running for',
    )
  }
  if (kind !== 'improvement') return undefined
  return [...snapshot.runs].reverse().find(run => run.taskId === source.taskId && run.status === 'verified')
}

/** The request's own content identity, derived from the same fields the stored attempt carries. */
export function requestAttemptDigest(request: RootRecoveryRequest): string {
  return recoveryAttemptDigest({
    kind: recoveryKindOf(request.mode),
    proposalIds: request.proposalIds === undefined ? undefined : [...request.proposalIds],
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

/** The rounds one source task has spent, counted from the runs its own `runIds` hold: the two kinds spend separate caps. */
export interface RecoveryRounds {
  /** Runs of the task that are recovery attempts of a failed source. */
  readonly recovery: number
  /** Runs of the task that are improvement attempts of a verified one. */
  readonly improvement: number
}

/** Count one source task's attempt runs by kind; a row written before `kind` existed is a recovery. */
export function recoveryRoundsOf(snapshot: TaskSnapshot, sourceTaskId: TaskId): RecoveryRounds {
  const attempts = snapshot.runs.filter(run => run.taskId === sourceTaskId && run.recovery !== undefined)
  return {
    recovery: attempts.filter(run => run.recovery!.kind !== 'improvement').length,
    improvement: attempts.filter(run => run.recovery!.kind === 'improvement').length,
  }
}

/** The coded refusal one exhausted per-source cap answers with (A7 §3): the caller's next move is to stop, not to retry. */
export class IterationCapRefusal extends Error {
  readonly code = 'iteration-cap'

  constructor(message: string) {
    super(message)
    this.name = 'IterationCapRefusal'
  }
}

/** What a reuse declaration is judged against: the source task, its contract's map, and the failed attempt's own members. */
export interface ReuseContext {
  /** The source root task the attempt is opened for. */
  readonly source: TaskInstance
  /** The failed run the attempt recovers, when the failure had one. */
  readonly sourceRun?: TaskRun
  /** The members that failed run read, **by position** — what `childIndex` names; an unfilled position is `undefined`. */
  readonly sourceMembers: readonly (TaskId | undefined)[]
  readonly snapshot: TaskSnapshot
}

/** The input references one sibling task declares, across its criteria (`requiresArtifact`, `acceptsArtifact`, `protectedInputs`). */
function declaredInputsOf(task: TaskInstance): Set<string> {
  return new Set(
    task.acceptanceCriteria.flatMap(criterion => [
      ...(criterion.requiresArtifact ?? []),
      ...(criterion.acceptsArtifact ?? []),
      ...(criterion.protectedInputs ?? []).map(input => input.path),
    ]),
  )
}

/** One declaration's citation, resolved against the store, or the reasons it does not resolve. */
function citationDefects(declaration: RootRecoveryReuse, context: ReuseContext, at: string): string[] {
  const defects: string[] = []
  const sibling = context.snapshot.tasks.find(task => task.taskId === declaration.taskId)
  if (sibling === undefined) {
    return [`${at}: no task "${declaration.taskId}" exists in this store`]
  }
  if (sibling.parentTaskId !== context.source.taskId) {
    defects.push(
      `${at}: task "${sibling.taskId}" is a child of "${sibling.parentTaskId ?? '(none)'}", not of "${context.source.taskId}" — only a sibling of this attempt's own task is reusable`,
    )
  }
  if (sibling.status !== 'verified') {
    defects.push(
      `${at}: sibling "${sibling.taskId}" is ${sibling.status}, not verified — only a passed sibling's evidence is reusable`,
    )
  }
  const run = context.snapshot.runs.find(candidate => candidate.runId === declaration.sourceRunId)
  if (run === undefined) {
    defects.push(`${at}: no run "${declaration.sourceRunId}" exists in this store`)
    return defects
  }
  if (run.taskId !== declaration.taskId) {
    defects.push(
      `${at}: run "${run.runId}" belongs to task "${run.taskId}", not to the cited sibling "${declaration.taskId}"`,
    )
  }
  if (run.status !== 'verified') {
    defects.push(
      `${at}: cited run "${run.runId}" is ${run.status}, not verified — only evidence of a verified run is reusable`,
    )
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
    if (!products.has(reference))
      defects.push(`${at}: evidence "${bundle.evidenceId}" holds no artifact "${reference}" (by artifact id or kind)`)
  }
  const inputs = declaredInputsOf(sibling)
  for (const reference of declaration.inputRefs ?? []) {
    if (!inputs.has(reference)) {
      defects.push(
        `${at}: sibling "${sibling.taskId}" declares no input "${reference}" (requiresArtifact, acceptsArtifact or protectedInputs)`,
      )
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
    } else if (context.sourceMembers[declaration.childIndex] !== declaration.taskId) {
      defects.push(
        `${at}: the failed run "${context.sourceRun.runId}" reads ${context.sourceMembers[declaration.childIndex] === undefined ? 'no member' : `"${context.sourceMembers[declaration.childIndex]}"`} ` +
          `at position ${declaration.childIndex}, not the cited "${declaration.taskId}"`,
      )
    }
    defects.push(...citationDefects(declaration, context, at))
    defects.push(...mapDefects(declaration, map, at))
    defects.push(...stalenessDefects(declaration, context.snapshot, at))
  })
  return defects
}

/**
 * Every reason a citation disagrees with the original acceptance map at the
 * position it claims: the map narrows a position to a criterion, to an evidence
 */
function mapDefects(declaration: RootRecoveryReuse, map: readonly ChildEvidenceRef[], at: string): string[] {
  const defects: string[] = []
  const entry = map.find(item => item.childIndex === declaration.childIndex)
  if (entry === undefined) return defects
  if (entry.criterionId !== undefined && entry.criterionId !== declaration.criterionId) {
    defects.push(
      `${at}: the original acceptance map narrows position ${declaration.childIndex} to criterion "${entry.criterionId}", ` +
        `and this declaration ${declaration.criterionId === undefined ? 'names no criterion' : `names "${declaration.criterionId}"`}`,
    )
  }
  if (
    entry.evidenceRef !== undefined &&
    declaration.evidenceId !== entry.evidenceRef &&
    !(declaration.artifactRefs ?? []).includes(entry.evidenceRef)
  ) {
    defects.push(
      `${at}: the original acceptance map narrows position ${declaration.childIndex} to evidence "${entry.evidenceRef}", which the cited bundle ` +
        `"${declaration.evidenceId}" does not carry (by evidence id, artifact id or artifact kind)`,
    )
  }
  return defects
}

/**
 * Whether the sibling's evidence still rests on what it rested on: every input
 * reference its own criteria declare (`requiresArtifact` as a verified reference
 */
function stalenessDefects(declaration: RootRecoveryReuse, snapshot: TaskSnapshot, at: string): string[] {
  const sibling = snapshot.tasks.find(task => task.taskId === declaration.taskId)
  if (sibling === undefined) return []
  return missingRequiredArtifacts(sibling.acceptanceCriteria, snapshot).map(
    issue =>
      `${at}: the sibling "${sibling.taskId}" declares ${issue.requirement === 'requires' ? 'a required product' : 'a raw input'} ` +
      `"${issue.ref}" (criterion ${issue.criterionId}), which the store does not hold now as a ` +
      `${issue.requirement === 'requires' ? 'verified reference product' : 'usable input'}`,
  )
}

/** What one attempt may read from a failed run: the citations its facts support, and the positions it could not bind. */
interface ReuseDerivation {
  /** The citations the failed run's own members and evidence support, by the positions they claim. */
  readonly bound: RootRecoveryReuse[]
  /**
   * The positions of the failed run that read a passed sibling the attempt
   * **cannot** bind, each with every reason it could not. The slot is left for
   */
  readonly unbound: RunMemberReuseRefusal[]
}

/**
 * What the failed run's own facts support as a reuse (plan §F.4: the binding
 * comes from the store, never from a caller's parameters).
 */
export function deriveReuse(context: ReuseContext): ReuseDerivation {
  const sourceRun = context.sourceRun
  if (sourceRun === undefined) return { bound: [], unbound: [] }
  const slots = runMemberSlots(sourceRun)
  const map = context.source.acceptanceCriteria.flatMap(criterion => criterion.childEvidence ?? [])
  const bound: RootRecoveryReuse[] = []
  const unbound: RunMemberReuseRefusal[] = []
  slots.forEach((taskId, childIndex) => {
    if (taskId === undefined) return
    const sibling = context.snapshot.tasks.find(task => task.taskId === taskId)
    if (sibling === undefined || sibling.status !== 'verified') return
    const at = `position ${childIndex}`
    const entry = map.find(item => item.childIndex === childIndex)
    /**
     * The sibling's own verified run and the bundle under it: the two identities
     * the citation stands on. A missing one is *not* invented here — the citation
     */
    const verifiedRun = context.snapshot.runs.find(run => run.taskId === taskId && run.status === 'verified')
    const bundle = context.snapshot.evidence.find(item => item.taskRunId === verifiedRun?.runId)
    const declaration: RootRecoveryReuse = {
      childIndex,
      taskId,
      sourceRunId: verifiedRun?.runId ?? '',
      evidenceId: bundle?.evidenceId ?? '',
      ...(entry?.criterionId === undefined ? {} : { criterionId: entry.criterionId }),
      artifactRefs: (bundle?.artifacts ?? []).flatMap(artifact => [artifact.artifactId, artifact.kind]),
      inputRefs: [...declaredInputsOf(sibling)],
    }
    const reasons = [
      ...citationDefects(declaration, context, at),
      ...mapDefects(declaration, map, at),
      ...stalenessDefects(declaration, context.snapshot, at),
    ]
    if (reasons.length === 0) bound.push(declaration)
    else {
      unbound.push({
        childIndex,
        taskId,
        ...(entry?.criterionId === undefined ? {} : { criterionId: entry.criterionId }),
        reasons,
      })
    }
  })
  return { bound, unbound }
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

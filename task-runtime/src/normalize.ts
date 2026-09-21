/**
 * The single normalization entry for one decomposition batch (construction
 * guide §4): raw caller input in, the canonical contract of every child with
 * its defaults filled and its criterion ids fixed, plus the identity the batch
 * is admitted under — or every reason it was refused, in one pass.
 *
 * Why one entry: the model-facing tool, the runtime's own decomposition path
 * and (later) a template adapter all have to produce the same contract facts,
 * and the store refuses an instance whose projection fields disagree with the
 * contract it carries. Adapting here — before an id is minted, a capability
 * resolved, or anything persisted — is what makes a rejected batch
 * side-effect-free, and it is why this module is pure.
 *
 * Closed on purpose. Every level declares exactly the fields the contract has,
 * and any other key is a refusal, never a silent drop: an attempt to raise a
 * budget (`budget`, `maxDepth`, `tokens`) or to pin a skill (`skills`) through
 * a field the runtime never reads must fail loudly, or the proposal would look
 * like it said something the runtime did not honour. Text is stored verbatim
 * (no trimming, no newline rewriting) — blankness is refused, byte identity
 * belongs to the digest.
 *
 * What this entry does *not* judge: the shape of `command` and of the P4
 * declarations (`requiresArtifact`, `acceptsArtifact`, `verifierRef`,
 * `childEvidence`, `heuristic`). Those rules live in `admission.ts`
 * (`contractDefects`, `independentAcceptanceDefects`) and are applied to the
 * normalized batch before anything is persisted; a duplicate here would be a
 * second place to keep in step. A declared mode is carried the same way.
 *
 * The identity covers where the batch came from (store, parent task and run,
 * caller), its contract language, the caller's reason, and the complete
 * ordered children — never the ids admission mints, so the same proposal
 * retried against the same parent keeps one identity, and never the limits it
 * was admitted under: those are recorded beside the digest, which is what lets
 * a later gate compare content and context separately.
 * @module @dangosys/dsh-singularity-task-runtime/normalize
 */

import {
  TASK_CONTRACT_VERSION,
  contractDigest,
  decompositionDigest,
} from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  AdmissionContext,
  ChildEvidenceRef,
  DecompositionAdmission,
  TaskContract,
  TaskContractVersion,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'

/** Where one batch came from: the store, the parent, its run, and the caller that submitted it. */
export interface DecompositionIdentityContext {
  storeId: string
  parentTaskId: string
  parentRunId: string
  callerSessionId: string
}

export interface NormalizationContext extends DecompositionIdentityContext {
  /** The limits in force, resolved by the caller from its configuration and recorded verbatim with the batch. */
  admissionContext: AdmissionContext
}

/** One normalized child: its contract plus the batch facts the identity covers. */
export interface NormalizedChild {
  contract: TaskContract
  dependsOn: number[]
  decomposable: boolean
  requiresIndependentAcceptance: boolean
}

export interface NormalizedBatch {
  contractVersion: TaskContractVersion
  children: NormalizedChild[]
  /** The batch identity and the limits it was admitted under, ready to be recorded with the decomposition. */
  admission: DecompositionAdmission
}

export type NormalizationResult = { ok: true; batch: NormalizedBatch } | { ok: false; reasons: string[] }

/** The batch fields, and nothing else: a key outside this set is refused. */
const BATCH_FIELDS: ReadonlySet<string> = new Set(['contractVersion', 'reason', 'children'])

/** The child fields, and nothing else. */
const CHILD_FIELDS: ReadonlySet<string> = new Set([
  'objective',
  'acceptanceCriteria',
  'requiredCapabilities',
  'dependsOn',
  'assumptions',
  'constraints',
  'decomposable',
  'requiresIndependentAcceptance',
])

/** The criterion fields, and nothing else. */
const CRITERION_FIELDS: ReadonlySet<string> = new Set([
  'criterionId',
  'description',
  'command',
  'mode',
  'mandatory',
  'requiredEvidence',
  'requiresArtifact',
  'acceptsArtifact',
  'verifierRef',
  'childEvidence',
  'heuristic',
])

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Non-blank text: the one check every string field shares. */
function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** A declared version value, rendered so a non-number cannot read like a number (`"1"` is not `1`). */
function declaredText(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value)
}

/**
 * A deep copy of declared contract data: primitives are immutable, arrays and
 * plain objects are rebuilt, so a caller mutating its input afterwards cannot
 * reach the normalized contract. Anything else is passed through unchanged — a
 * value no canonical form can carry is refused by the digest below, never
 * silently rewritten.
 */
function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => copyValue(item)) as unknown as T
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) copy[key] = copyValue(item)
    return copy as T
  }
  return value
}

/** Report every key a level does not declare. */
function unknownFields(source: Record<string, unknown>, allowed: ReadonlySet<string>, label: string, reasons: string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) reasons.push(`${label} declares unknown field ${JSON.stringify(key)}`)
  }
}

/** A required text field; a blank or non-string value is refused with the field named. */
function text(value: unknown, label: string, reasons: string[]): string {
  if (!nonBlank(value)) {
    reasons.push(`${label} must be a non-empty string`)
    return ''
  }
  return value
}

/**
 * A declared string collection: copied verbatim when it holds nothing but
 * non-blank strings, refused as one defect otherwise — a blank entry is
 * refused, not trimmed, and an omitted collection is the caller's `[]`.
 */
function stringList(value: unknown, label: string, reasons: string[]): string[] {
  if (!Array.isArray(value) || value.some(item => !nonBlank(item))) {
    reasons.push(`${label} must be an array of non-empty strings`)
    return []
  }
  return value.map(item => item as string)
}

/**
 * A `dependsOn` list: integers only, copied verbatim. Whether an index is in
 * range, points at itself, or closes a cycle is admission's judgement — it
 * needs the whole batch, which this entry never sees as a graph.
 */
function integerList(value: unknown, label: string, reasons: string[]): number[] {
  if (!Array.isArray(value) || value.some(item => !Number.isInteger(item))) {
    reasons.push(`${label} must be an array of integers`)
    return []
  }
  return value.map(item => item as number)
}

/** A boolean declaration: absent keeps the designed default, anything else is refused. */
function booleanField(value: unknown, fallback: boolean, label: string, reasons: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    reasons.push(`${label} must be a boolean`)
    return fallback
  }
  return value
}

/**
 * A value carried as declared. `command` and the P4 declarations are judged by
 * admission, so this entry only copies them: a shape those rules refuse never
 * reaches the store, and the cast is the boundary that says so.
 */
function carried<T>(value: unknown): T {
  return copyValue(value) as T
}

/**
 * One child's criteria list. Ids are fixed here — a declared id verbatim, an
 * absent one as `ac<childIndex + 1>-<criterionIndex + 1>`, the scheme the
 * runtime has always used — because the digest must not depend on spellings and
 * because a parent-level `childEvidence.criterionId` can only point at an id
 * that was fixed before its parent's criteria were accepted.
 *
 * A criterion that carried a defect is left out of the returned list: the batch
 * is refused as a whole, and the contract must describe only what a well-formed
 * declaration asked for.
 */
function normalizeCriteria(
  raw: readonly unknown[],
  childIndex: number,
  childLabel: string,
  reasons: string[],
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = []
  const seen = new Set<string>()
  const reportedDuplicate = new Set<string>()
  raw.forEach((value, index) => {
    const before = reasons.length
    const position = `${childLabel} criterion ${index + 1}`
    if (!isPlainObject(value)) {
      reasons.push(`${position} must be an object`)
      return
    }
    const declaredId = value.criterionId
    if (declaredId !== undefined && !nonBlank(declaredId)) reasons.push(`${position} criterionId must be a non-empty string`)
    const criterionId = nonBlank(declaredId) ? declaredId : `ac${childIndex + 1}-${index + 1}`
    const label = `${childLabel} criterion ${JSON.stringify(criterionId)}`

    unknownFields(value, CRITERION_FIELDS, label, reasons)
    // One reason per duplicated id, not one per extra occurrence: the caller has
    // to rename the id once, and a list of repeats would only pad the report.
    if (seen.has(criterionId) && !reportedDuplicate.has(criterionId)) {
      reasons.push(`${childLabel} declares criterion id ${JSON.stringify(criterionId)} more than once`)
      reportedDuplicate.add(criterionId)
    }
    seen.add(criterionId)

    const description = text(value.description, `${label} description`, reasons)
    const mandatory = booleanField(value.mandatory, true, `${label} mandatory`, reasons)
    const requiredEvidence = value.requiredEvidence === undefined
      ? []
      : stringList(value.requiredEvidence, `${label} requiredEvidence`, reasons)

    const command = value.command
    const criterion: AcceptanceCriterion = {
      criterionId,
      description,
      // A declared mode is carried verbatim, whatever it is; whether it names
      // one of the six judges is `contractDefects`' rule. Only an absent mode
      // is defaulted — the one decision here: a command means the verifier can
      // execute it, no command means a reviewer reads it. Absent means exactly
      // `undefined`: a declared `null` is a declaration, and defaulting it
      // would hand the criterion a judge the caller never named.
      verificationMode: carried<VerificationMode>(
        value.mode === undefined ? (command !== undefined ? 'deterministic' : 'review') : value.mode,
      ),
      requiredEvidence,
      mandatory,
      ...(command === undefined ? {} : { command: carried<string>(command) }),
      ...(value.requiresArtifact === undefined ? {} : { requiresArtifact: carried<string[]>(value.requiresArtifact) }),
      ...(value.acceptsArtifact === undefined ? {} : { acceptsArtifact: carried<string[]>(value.acceptsArtifact) }),
      ...(value.verifierRef === undefined ? {} : { verifierRef: carried<string>(value.verifierRef) }),
      ...(value.childEvidence === undefined ? {} : { childEvidence: carried<ChildEvidenceRef[]>(value.childEvidence) }),
      ...(value.heuristic === undefined ? {} : { heuristic: carried<boolean>(value.heuristic) }),
    }
    if (reasons.length > before) return
    criteria.push(criterion)
  })
  return criteria
}

/** One batch child, normalized; `undefined` exactly when it contributed a reason. */
function normalizeChild(raw: unknown, index: number, reasons: string[]): NormalizedChild | undefined {
  const before = reasons.length
  const label = `child ${index}`
  if (!isPlainObject(raw)) {
    reasons.push(`${label} must be an object`)
    return undefined
  }
  unknownFields(raw, CHILD_FIELDS, label, reasons)

  // The objective is stored byte-for-byte: a blank one is refused (nothing can
  // be verified against it) and a padded one keeps its padding — the contract
  // records what the caller asked for, not a tidied version of it.
  const objective = text(raw.objective, `${label} objective`, reasons)

  const rawCriteria = raw.acceptanceCriteria
  let criteria: AcceptanceCriterion[] = []
  if (!Array.isArray(rawCriteria)) reasons.push(`${label} acceptanceCriteria must be an array`)
  else criteria = normalizeCriteria(rawCriteria, index, label, reasons)

  const requiredCapabilities = raw.requiredCapabilities === undefined
    ? []
    : stringList(raw.requiredCapabilities, `${label} requiredCapabilities`, reasons)
  const assumptions = raw.assumptions === undefined ? [] : stringList(raw.assumptions, `${label} assumptions`, reasons)
  const constraints = raw.constraints === undefined ? [] : stringList(raw.constraints, `${label} constraints`, reasons)
  const dependsOn = raw.dependsOn === undefined ? [] : integerList(raw.dependsOn, `${label} dependsOn`, reasons)
  const decomposable = booleanField(raw.decomposable, false, `${label} decomposable`, reasons)
  const requiresIndependentAcceptance = booleanField(
    raw.requiresIndependentAcceptance,
    false,
    `${label} requiresIndependentAcceptance`,
    reasons,
  )

  if (reasons.length > before) return undefined
  return {
    contract: {
      contractVersion: TASK_CONTRACT_VERSION,
      objective,
      acceptanceCriteria: criteria,
      assumptions,
      constraints,
      requiredCapabilities,
    },
    dependsOn,
    decomposable,
    requiresIndependentAcceptance,
  }
}

/**
 * Normalize one decomposition proposal.
 *
 * Returns every defect it found, never the first: a caller revising a proposal
 * needs the whole list, and a batch that returns at all is one the digest could
 * describe. A refusal is a value, never a throw.
 */
export function normalizeDecomposition(spec: unknown, context: NormalizationContext): NormalizationResult {
  const reasons: string[] = []
  if (!isPlainObject(spec)) {
    return { ok: false, reasons: ['decomposition must be an object with a reason and a children array'] }
  }
  unknownFields(spec, BATCH_FIELDS, 'decomposition', reasons)

  // The version gate: absent is the legacy adapter (this build's version is the
  // one the runtime writes), declared must be a version whose field semantics
  // this build knows — reading a future contract with today's reader is the one
  // failure a version field exists to prevent.
  const declaredVersion = spec.contractVersion
  if (declaredVersion !== undefined && declaredVersion !== TASK_CONTRACT_VERSION) {
    reasons.push(`unknown contract version ${declaredText(declaredVersion)}: this runtime writes version ${TASK_CONTRACT_VERSION}`)
  }

  let reason = ''
  if (nonBlank(spec.reason)) reason = spec.reason
  else reasons.push('decomposition requires a non-blank reason')

  const children: NormalizedChild[] = []
  const rawChildren = spec.children
  if (rawChildren === undefined || (Array.isArray(rawChildren) && rawChildren.length === 0)) {
    reasons.push('decomposition requires at least one child')
  } else if (!Array.isArray(rawChildren)) {
    reasons.push('decomposition children must be an array')
  } else {
    rawChildren.forEach((raw, index) => {
      const child = normalizeChild(raw, index, reasons)
      if (child !== undefined) children.push(child)
    })
  }

  if (reasons.length > 0) return { ok: false, reasons }

  const contractVersion = TASK_CONTRACT_VERSION
  try {
    return {
      ok: true,
      batch: {
        contractVersion,
        children,
        admission: {
          proposalDigest: decompositionDigest({
            contractVersion,
            storeId: context.storeId,
            parentTaskId: context.parentTaskId,
            parentRunId: context.parentRunId,
            callerSessionId: context.callerSessionId,
            reason,
            children: children.map(child => ({
              contractDigest: contractDigest(child.contract),
              dependsOn: child.dependsOn,
              decomposable: child.decomposable,
              requiresIndependentAcceptance: child.requiresIndependentAcceptance,
            })),
          }),
          context: copyValue(context.admissionContext),
        },
      },
    }
  } catch (error) {
    // `canonicalize` refuses values JSON cannot round-trip (functions, symbols,
    // `NaN`, class instances): no digest of such a proposal could be compared
    // with a digest of a different value, so the batch is refused, not hashed.
    return { ok: false, reasons: [`decomposition content cannot be canonicalized: ${message(error)}`] }
  }
}

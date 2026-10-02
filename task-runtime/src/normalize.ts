/**
 * The single normalization entry for one decomposition batch (construction
 * guide §4): raw caller input in, the canonical contract of every child with
 */

import { TASK_CONTRACT_VERSION, contractDigest, decompositionDigest } from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  AdmissionContext,
  ChildEvidenceRef,
  DecompositionAdmission,
  DecompositionIdentity,
  ProtectedInputRef,
  TaskContract,
  TaskContractVersion,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import { isPlainObject, message, nonBlank, unknownFieldKeys } from './helpers.ts'

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
interface NormalizedChild {
  contract: TaskContract
  dependsOn: number[]
  decomposable: boolean
  requiresIndependentAcceptance: boolean
}

export interface NormalizedBatch {
  contractVersion: TaskContractVersion
  /** The caller's reason, verbatim — part of {@link decompositionIdentity}, so a writer that records the batch's identity records this text. */
  reason: string
  children: NormalizedChild[]
  /** The batch identity and the limits it was admitted under, ready to be recorded with the decomposition. */
  admission: DecompositionAdmission
}

/**
 * The identity one batch is digested over (§4): where it came from, which
 * contract language it is written in, the caller's reason, and the complete
 */
export function decompositionIdentity(
  context: DecompositionIdentityContext,
  reason: string,
  children: readonly NormalizedChild[],
): DecompositionIdentity {
  return {
    contractVersion: TASK_CONTRACT_VERSION,
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
  }
}

export type NormalizationResult = { ok: true; batch: NormalizedBatch } | { ok: false; reasons: string[] }

/** The batch fields, and nothing else: a key outside this set is refused. */
const BATCH_FIELDS: ReadonlySet<string> = new Set(['contractVersion', 'reason', 'children'])

/** The child fields, and nothing else. */
const CHILD_FIELDS: ReadonlySet<string> = new Set([
  'objective',
  'templateRef',
  'templateParameters',
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
  'protectedInputs',
])

/** A declared version value, rendered so a non-number cannot read like a number (`"1"` is not `1`). */
function declaredText(value: unknown): string {
  return typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value))
}

/**
 * A deep copy of declared contract data: primitives are immutable, arrays and
 * plain objects are rebuilt, so a caller mutating its input afterwards cannot
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
function unknownFields(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  reasons: string[],
): void {
  for (const key of unknownFieldKeys(source, allowed)) {
    reasons.push(`${label} declares unknown field ${JSON.stringify(key)}`)
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
 */
function carried<T>(value: unknown): T {
  return copyValue(value) as T
}

/**
 * One criterion list. Ids are fixed here — a declared id verbatim, an absent
 * one from `idOf` — because the digest must not depend on spellings and because
 */
function normalizeCriteria(
  raw: readonly unknown[],
  label: string,
  idOf: (index: number) => string,
  reasons: string[],
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = []
  const seen = new Set<string>()
  const reportedDuplicate = new Set<string>()
  raw.forEach((value, index) => {
    const before = reasons.length
    const position = `${label} criterion ${index + 1}`
    if (!isPlainObject(value)) {
      reasons.push(`${position} must be an object`)
      return
    }
    const declaredId = value.criterionId
    if (declaredId !== undefined && !nonBlank(declaredId))
      reasons.push(`${position} criterionId must be a non-empty string`)
    const criterionId = nonBlank(declaredId) ? declaredId : idOf(index)
    const criterionLabel = `${label} criterion ${JSON.stringify(criterionId)}`

    unknownFields(value, CRITERION_FIELDS, criterionLabel, reasons)
    // One reason per duplicated id, not one per extra occurrence: the caller has
    // to rename the id once, and a list of repeats would only pad the report.
    if (seen.has(criterionId) && !reportedDuplicate.has(criterionId)) {
      reasons.push(`${label} declares criterion id ${JSON.stringify(criterionId)} more than once`)
      reportedDuplicate.add(criterionId)
    }
    seen.add(criterionId)

    const description = text(value.description, `${criterionLabel} description`, reasons)
    const mandatory = booleanField(value.mandatory, true, `${criterionLabel} mandatory`, reasons)
    const requiredEvidence =
      value.requiredEvidence === undefined
        ? []
        : stringList(value.requiredEvidence, `${criterionLabel} requiredEvidence`, reasons)

    const command = value.command
    const criterion: AcceptanceCriterion = {
      criterionId,
      description,
      /**
       * A declared mode is carried verbatim, whatever it is; whether it names
       * one of the six judges is `contractDefects`' rule. Only an absent mode
       */
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
      /**
       * The fixed protected inputs, carried verbatim like the P4 declarations
       * (admission owns the shape rule). The runtime fixed their identity
       */
      ...(value.protectedInputs === undefined
        ? {}
        : { protectedInputs: carried<ProtectedInputRef[]>(value.protectedInputs) }),
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

  /**
   * The objective is stored byte-for-byte: a blank one is refused (nothing can
   * be verified against it) and a padded one keeps its padding — the contract
   */
  const objective = text(raw.objective, `${label} objective`, reasons)

  const rawCriteria = raw.acceptanceCriteria
  let criteria: AcceptanceCriterion[] = []
  if (!Array.isArray(rawCriteria)) reasons.push(`${label} acceptanceCriteria must be an array`)
  else
    criteria = normalizeCriteria(rawCriteria, label, criterionIndex => `ac${index + 1}-${criterionIndex + 1}`, reasons)

  const requiredCapabilities =
    raw.requiredCapabilities === undefined
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
      ...(raw.templateRef === undefined ? {} : {
        templateRef: carried<TaskContract['templateRef']>(raw.templateRef),
        templateParameters: carried<NonNullable<TaskContract['templateParameters']>>(raw.templateParameters ?? {}),
      }),
    },
    dependsOn,
    decomposable,
    requiresIndependentAcceptance,
  }
}

/**
 * Normalize one decomposition proposal.
 * Returns every defect it found, never the first: a caller revising a proposal
 */
export function normalizeDecomposition(spec: unknown, context: NormalizationContext): NormalizationResult {
  const reasons: string[] = []
  if (!isPlainObject(spec)) {
    return { ok: false, reasons: ['decomposition must be an object with a reason and a children array'] }
  }
  unknownFields(spec, BATCH_FIELDS, 'decomposition', reasons)

  /**
   * The version gate: absent is the legacy adapter (this build's version is the
   * one the runtime writes), declared must be a version whose field semantics
   */
  const declaredVersion = spec.contractVersion
  if (declaredVersion !== undefined && declaredVersion !== TASK_CONTRACT_VERSION) {
    reasons.push(
      `unknown contract version ${declaredText(declaredVersion)}: this runtime writes version ${TASK_CONTRACT_VERSION}`,
    )
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
        reason,
        children,
        admission: {
          proposalDigest: decompositionDigest(decompositionIdentity(context, reason, children)),
          context: copyValue(context.admissionContext),
        },
      },
    }
  } catch (error) {
    /**
     * `canonicalize` refuses values JSON cannot round-trip (functions, symbols,
     * `NaN`, class instances): no digest of such a proposal could be compared
     */
    return { ok: false, reasons: [`decomposition content cannot be canonicalized: ${message(error)}`] }
  }
}

/** The root contract's fields, and nothing else: a key outside this set is refused (A0 §2). */
const ROOT_CONTRACT_FIELDS: ReadonlySet<string> = new Set([
  'contractVersion',
  'objective',
  'templateRef',
  'templateParameters',
  'acceptanceCriteria',
  'assumptions',
  'constraints',
  'requiredCapabilities',
])

/**
 * The criterion id a root contract's criterion gets when it declares none:
 * `ac-<j>`, one flat list.
 */
function rootCriterionId(index: number): string {
  return `ac-${index + 1}`
}

export type RootNormalizationResult = { ok: true; contract: TaskContract } | { ok: false; reasons: string[] }

/**
 * Normalize one root contract (A0 §2–§3): the caller's single contract —
 * objective, criteria, assumptions, constraints, declared capabilities — in,
 */
export function normalizeRootContract(spec: unknown): RootNormalizationResult {
  const reasons: string[] = []
  if (!isPlainObject(spec)) {
    return { ok: false, reasons: ['root contract must be an object with an objective and an acceptanceCriteria array'] }
  }
  unknownFields(spec, ROOT_CONTRACT_FIELDS, 'root contract', reasons)

  const declaredVersion = spec.contractVersion
  if (declaredVersion !== undefined && declaredVersion !== TASK_CONTRACT_VERSION) {
    reasons.push(
      `unknown contract version ${declaredText(declaredVersion)}: this runtime writes version ${TASK_CONTRACT_VERSION}`,
    )
  }

  const label = 'root contract'
  const objective = text(spec.objective, `${label} objective`, reasons)

  const rawCriteria = spec.acceptanceCriteria
  let criteria: AcceptanceCriterion[] = []
  if (!Array.isArray(rawCriteria)) reasons.push(`${label} acceptanceCriteria must be an array`)
  else criteria = normalizeCriteria(rawCriteria, label, rootCriterionId, reasons)

  const assumptions =
    spec.assumptions === undefined ? [] : stringList(spec.assumptions, `${label} assumptions`, reasons)
  const constraints =
    spec.constraints === undefined ? [] : stringList(spec.constraints, `${label} constraints`, reasons)
  const requiredCapabilities =
    spec.requiredCapabilities === undefined
      ? []
      : stringList(spec.requiredCapabilities, `${label} requiredCapabilities`, reasons)

  if (reasons.length > 0) return { ok: false, reasons }
  return {
    ok: true,
    contract: {
      contractVersion: TASK_CONTRACT_VERSION,
      objective,
      acceptanceCriteria: criteria,
      assumptions,
      constraints,
      requiredCapabilities,
      ...(spec.templateRef === undefined ? {} : {
        templateRef: carried<TaskContract['templateRef']>(spec.templateRef),
        templateParameters: carried<NonNullable<TaskContract['templateParameters']>>(spec.templateParameters ?? {}),
      }),
    },
  }
}

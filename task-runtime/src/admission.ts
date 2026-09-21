import { reaches } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, DependencyEdge, TaskInstance, VerificationMode } from '@dangosys/dsh-singularity-task'
import { protectedInputDefects } from './protected-inputs.ts'

/** Modes whose criterion is executed by the command verifier and therefore needs `command`. */
const EXECUTABLE_MODES: readonly VerificationMode[] = ['deterministic', 'simulation', 'measurement']

/** Every mode a criterion may declare, in declaration order (`VerificationMode`); the list the mode rule names. */
const VERIFICATION_MODES: readonly VerificationMode[] = [
  'deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite',
]

/** Parent task plus the decomposition policy its caller grants it. */
export interface AdmissionParent extends TaskInstance {
  decompositionPolicy: {
    /** Whether this batch may proceed at all. */
    allowed: boolean
    /**
     * The parent is admitted `leaf`. With the runtime-decomposition switch off
     * that alone closes the policy, so the refusal below names the leaf rule
     * instead of leaving the model to guess whether a limit refused it — the
     * two causes need different follow-ups (do the work here vs. stay shallow).
     */
    leaf?: boolean
    maxDepth?: number
    maxChildren?: number
  }
}

/** One planned child at admission time; `dependsOn` indexes into the children array. */
export interface AdmissionChild {
  taskId: string
  objective: string
  acceptanceCriteria: readonly AcceptanceCriterion[]
  dependsOn?: readonly number[]
  /** Contract-level marker (P4): this child demands independent parent acceptance, so at least one of its criteria must carry a `childEvidence` map. */
  requiresIndependentAcceptance?: boolean
}

export type AdmissionVerdict = { ok: true } | { ok: false; reasons: string[] }

/**
 * Structural reasons one task's parent-acceptance declarations are malformed
 * (P4, KISS §6 C2). Shape only: whether a mapping target exists is judged at
 * acceptance time, never here. The ordinary decomposition path and the replay
 * path share this function so both judge the same declarations the same way.
 *
 * `label` names the task under validation (`task "t-1"`, `child 0 ("c1")`,
 * `replay of "t-1"`); every reason is prefixed with it.
 */
export function independentAcceptanceDefects(
  criteria: readonly AcceptanceCriterion[],
  requiresIndependentAcceptance: boolean | undefined,
  label: string,
): string[] {
  const reasons: string[] = []
  for (const criterion of criteria) {
    const where = `${label} criterion "${criterion.criterionId}"`
    if (criterion.acceptsArtifact !== undefined
      && (!Array.isArray(criterion.acceptsArtifact) || criterion.acceptsArtifact.some(ref => typeof ref !== 'string' || ref.trim().length === 0))) {
      reasons.push(`${where} acceptsArtifact must be an array of non-empty strings`)
    }
    if (criterion.heuristic !== undefined && typeof criterion.heuristic !== 'boolean') {
      reasons.push(`${where} heuristic must be a boolean`)
    }
    const map = criterion.childEvidence
    if (map !== undefined) {
      if (!Array.isArray(map)) {
        reasons.push(`${where} childEvidence must be an array of entries`)
      } else {
        map.forEach((entry, index) => {
          const at = `${where} childEvidence entry ${index}`
          if (typeof entry !== 'object' || entry === null) {
            reasons.push(`${at} must be an object`)
            return
          }
          if (!Number.isInteger(entry.childIndex) || entry.childIndex < 0) {
            reasons.push(`${at} childIndex must be a non-negative integer`)
          }
          if (entry.criterionId !== undefined && (typeof entry.criterionId !== 'string' || entry.criterionId.trim().length === 0)) {
            reasons.push(`${at} criterionId must be a non-empty string`)
          }
          if (entry.evidenceRef !== undefined && (typeof entry.evidenceRef !== 'string' || entry.evidenceRef.trim().length === 0)) {
            reasons.push(`${at} evidenceRef must be a non-empty string`)
          }
        })
        // Only the composite verifier reads the map, and a heuristic judgement
        // is never a mechanical check: a map on any other judge, or beside a
        // heuristic label, would be a declaration nobody acts on.
        if (map.length > 0 && criterion.verificationMode !== 'composite') {
          reasons.push(`${where} childEvidence requires verificationMode "composite" (the composite verifier is its only judge)`)
        }
        if (map.length > 0 && criterion.heuristic === true) {
          reasons.push(`${where} cannot be both heuristic and carry a childEvidence map: a heuristic judgement is never a mechanical check`)
        }
      }
    }
  }
  // The contract-level marker is a promise that acceptance rests on the task's
  // own evidence map. A missing, empty, or deleted map must refuse loudly —
  // silently falling back to the conjunction is the degradation the marker
  // exists to prevent.
  if (requiresIndependentAcceptance === true
    && !criteria.some(criterion => (criterion.childEvidence?.length ?? 0) > 0)) {
    reasons.push(`${label} requires independent parent acceptance but no acceptance criterion carries a childEvidence map (the composite conjunction alone cannot stand in for the root goal)`)
  }
  return reasons
}

/**
 * Whether a criterion declares a command a verifier could actually run. A
 * declared command that is blank — or not text at all — is as missing as an
 * absent one: nothing executable was handed to the judge.
 */
function hasCommand(command: unknown): boolean {
  return typeof command === 'string' && command.trim().length > 0
}

/**
 * Structural defects of one task's acceptance contract (T1, construction guide
 * §4): what has to hold before a contract can be admitted at all, whichever
 * entry wrote it — an ordinary decomposition child, a replay candidate, or
 * (later) a template instance. Texts, ids, modes, and the fixed form of a
 * criterion's protected acceptance inputs only; nothing here judges whether a
 * criterion is any good, and nothing here needs the store.
 *
 * The ordinary decomposition path and the replay path share this function so
 * that a rule can never hold on one and not on the other. The *parent* task's
 * own criteria are deliberately not put through it: a parent that already
 * exists was admitted when it was created, and T1 does not re-open contracts
 * that predate the normalized one — `checkDecomposition` still applies
 * {@link independentAcceptanceDefects} to the parent, which is its own P4
 * promise about a declaration the parent itself carries.
 *
 * `label` names the task under validation (`child 0 ("t-1")`, `replay of
 * "t-1"`); every reason is prefixed with it.
 */
export function contractDefects(criteria: readonly AcceptanceCriterion[], label: string): string[] {
  const reasons: string[] = []
  if (criteria.length === 0) {
    reasons.push(`${label} requires at least one acceptance criterion`)
    return reasons
  }
  const seen = new Set<string>()
  const reportedDuplicate = new Set<string>()
  for (const criterion of criteria) {
    const where = `${label} criterion "${criterion.criterionId}"`
    const description: unknown = criterion.description
    if (typeof description !== 'string' || description.trim().length === 0) {
      reasons.push(`${where} requires a non-empty description`)
    }
    if (!VERIFICATION_MODES.includes(criterion.verificationMode)) {
      reasons.push(`${where} verificationMode "${String(criterion.verificationMode)}" is not one of ${VERIFICATION_MODES.join(', ')}`)
    } else if (EXECUTABLE_MODES.includes(criterion.verificationMode) && !hasCommand(criterion.command)) {
      // The command verifier executes the criterion: without a command there is
      // nothing to run, and a criterion that can never be judged is not a task.
      reasons.push(`${where} (${criterion.verificationMode}) requires a command`)
    }
    // Duplicates are refused before the batch is persisted, not at acceptance:
    // a verdict names its criterion by id, so two criteria sharing one id make
    // every later verdict ambiguous. One reason per duplicated id, however many
    // times it repeats.
    if (seen.has(criterion.criterionId) && !reportedDuplicate.has(criterion.criterionId)) {
      reasons.push(`${label} declares criterion id "${criterion.criterionId}" more than once`)
      reportedDuplicate.add(criterion.criterionId)
    }
    seen.add(criterion.criterionId)
    // The fixed form of a criterion's protected acceptance inputs (S1-V slice
    // 2): the same rule for an ordinary decomposition child and for a replay
    // candidate, because `protectedInputDefects` is the only place that shape
    // is described. The declared (string) form is refused here too — reaching
    // admission with paths instead of digests means the runtime's fixing step
    // was bypassed, and no unfixed identity may be persisted.
    reasons.push(...protectedInputDefects([criterion], label))
  }
  // A contract whose every criterion is optional cannot settle: passing it would
  // mean nothing was required, and failing it would close nothing.
  if (!criteria.some(criterion => criterion.mandatory === true)) {
    reasons.push(`${label} requires at least one mandatory acceptance criterion`)
  }
  return reasons
}

/**
 * Structural admission checks for one decomposition batch (RFC §36). Pure:
 * every rule is validated up front and the caller persists only when the
 * verdict is `ok`, so admission is atomic for the whole batch.
 */
export function checkDecomposition(
  parent: AdmissionParent,
  children: readonly AdmissionChild[],
  existingEdges: readonly DependencyEdge[],
): AdmissionVerdict {
  const reasons: string[] = []
  const policy = parent.decompositionPolicy

  if (!policy.allowed) {
    reasons.push(policy.leaf === true
      ? `task "${parent.taskId}" decomposition is not allowed: it is admitted as leaf and runtime decomposition is off ` +
        '(allowRuntimeDecomposition: false), so only a task admitted decomposable may split'
      : `task "${parent.taskId}" decomposition is not allowed`)
  }
  if (policy.maxDepth !== undefined && parent.depth + 1 > policy.maxDepth) {
    reasons.push(`task "${parent.taskId}" children would exceed maxDepth ${policy.maxDepth} (depth ${parent.depth + 1})`)
  }
  if (policy.maxChildren !== undefined && children.length > policy.maxChildren) {
    reasons.push(`task "${parent.taskId}" would have ${children.length} children, above maxChildren ${policy.maxChildren}`)
  }
  if (children.length === 0) reasons.push(`task "${parent.taskId}" decomposition requires at least one child`)

  // The parent's own parent-acceptance declarations (P4): a stored task's
  // criteria are immutable, so the marker-plus-map rule is re-checked here on
  // every decomposition — a parent that demands independent acceptance can
  // never silently decompose under the bare conjunction.
  reasons.push(...independentAcceptanceDefects(
    parent.acceptanceCriteria,
    parent.requiresIndependentAcceptance,
    `task "${parent.taskId}"`,
  ))

  const plannedEdges: DependencyEdge[] = []
  children.forEach((child, index) => {
    const label = `child ${index} ("${child.taskId}")`
    if (child.objective.trim().length === 0) reasons.push(`${label} objective must be non-empty`)
    // Two separate judgements, both required: the contract's own structure
    // ({@link contractDefects}, shared with the replay path) and the P4
    // declarations a child carries about its parent's acceptance.
    reasons.push(...contractDefects(child.acceptanceCriteria, label))
    reasons.push(...independentAcceptanceDefects(child.acceptanceCriteria, child.requiresIndependentAcceptance, label))
    for (const criterion of child.acceptanceCriteria) {
      // `requiresArtifact` gets a shape check here and nothing more: whether the
      // named artifact exists is a spawn-time question (it needs the store
      // snapshot), so admission only refuses a malformed declaration.
      if (criterion.requiresArtifact !== undefined
        && (!Array.isArray(criterion.requiresArtifact) || criterion.requiresArtifact.some(ref => typeof ref !== 'string' || ref.trim().length === 0))) {
        reasons.push(`${label} criterion "${criterion.criterionId}" requiresArtifact must be an array of non-empty strings`)
      }
      // `verifierRef` gets a shape check here and nothing more: whether the id
      // is registered is a batch-level question (it needs the verifier
      // registry), so admission only refuses a malformed declaration.
      if (criterion.verifierRef !== undefined
        && (typeof criterion.verifierRef !== 'string' || criterion.verifierRef.trim().length === 0)) {
        reasons.push(`${label} criterion "${criterion.criterionId}" verifierRef must be a non-empty string`)
      }
    }
    for (const dependency of child.dependsOn ?? []) {
      if (!Number.isInteger(dependency) || dependency < 0 || dependency >= children.length) {
        reasons.push(`${label} dependsOn index ${dependency} is out of range`)
        continue
      }
      if (dependency === index) {
        reasons.push(`${label} cannot depend on itself`)
        continue
      }
      plannedEdges.push({ from: children[dependency]!.taskId, to: child.taskId })
    }
  })

  const edges = [...existingEdges, ...plannedEdges]
  const seen = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.from}→${edge.to}`
    if (seen.has(key)) reasons.push(`dependency "${key}" is declared more than once`)
    seen.add(key)
  }
  for (const edge of plannedEdges) {
    if (reaches(edges, edge.to, edge.from)) reasons.push(`dependency "${edge.from}" → "${edge.to}" creates a cycle`)
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

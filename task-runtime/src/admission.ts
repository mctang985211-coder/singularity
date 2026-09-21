import { reaches } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, DependencyEdge, TaskInstance, VerificationMode } from '@dangosys/dsh-singularity-task'

/** Modes whose criterion is executed by the command verifier and therefore needs `command`. */
const EXECUTABLE_MODES: readonly VerificationMode[] = ['deterministic', 'simulation', 'measurement']

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
    if (child.acceptanceCriteria.length === 0) reasons.push(`${label} requires at least one acceptance criterion`)
    reasons.push(...independentAcceptanceDefects(child.acceptanceCriteria, child.requiresIndependentAcceptance, label))
    for (const criterion of child.acceptanceCriteria) {
      if (EXECUTABLE_MODES.includes(criterion.verificationMode) && (criterion.command ?? '').trim().length === 0) {
        reasons.push(`${label} criterion "${criterion.criterionId}" (${criterion.verificationMode}) requires a command`)
      }
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

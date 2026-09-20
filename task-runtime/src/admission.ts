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
}

export type AdmissionVerdict = { ok: true } | { ok: false; reasons: string[] }

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

  const plannedEdges: DependencyEdge[] = []
  children.forEach((child, index) => {
    const label = `child ${index} ("${child.taskId}")`
    if (child.objective.trim().length === 0) reasons.push(`${label} objective must be non-empty`)
    if (child.acceptanceCriteria.length === 0) reasons.push(`${label} requires at least one acceptance criterion`)
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

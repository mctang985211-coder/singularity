/**
 * Protected acceptance inputs (S1-V slice 2, KISS §4.3): the admission-time
 * half of the identity a criterion's judge is later held to.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, ProtectedInputRef } from '@dangosys/dsh-singularity-task'
import type { DecomposeChildSpec, DecomposeSpec } from './types.ts'
import { isPlainObject, message, nonBlank, unknownFieldKeys } from './helpers.ts'

/**
 * The smallest shape this module fixes: a criterion that may carry a declared
 * id (the label it is reported under) and a `protectedInputs` value of unknown
 */
interface DeclaredProtectedInputs {
  criterionId?: string
  protectedInputs?: unknown
}

/**
 * The authoring form of one criterion's declaration: a non-empty array of
 * non-blank strings, in the order the caller wrote them.
 */
function declaredPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return []
  return value.every(item => nonBlank(item)) ? [...(value as string[])] : []
}

/**
 * The label one criterion is reported under: the declared id when it has one,
 * its position otherwise — the vocabulary `normalize.ts` names criteria with,
 */
function criterionLabel(childLabel: string, criterion: DeclaredProtectedInputs, index: number): string {
  const id = nonBlank(criterion.criterionId) ? JSON.stringify(criterion.criterionId) : index + 1
  return `${childLabel} criterion ${id}`
}

/**
 * Fix the byte identity of every declared protected input, against the
 * checkout directory the criterion's judge will run in.
 */
export async function fixProtectedInputs(
  paths: readonly string[],
  cwd: string | undefined,
  label: string,
): Promise<{ refs: ProtectedInputRef[]; reasons: string[] }> {
  if (paths.length === 0) return { refs: [], reasons: [] }
  if (cwd === undefined) {
    return {
      refs: [],
      reasons: [
        `${label} protectedInputs cannot be fixed: the session's checkout directory cannot be resolved ` +
          '(the session has no readable graph env binding), so the declared paths are refused rather than fixed against the wrong base',
      ],
    }
  }
  const refs: ProtectedInputRef[] = []
  const reasons: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    try {
      refs.push({ path, sha256: sha256Hex(await readFile(resolve(cwd, path))) })
    } catch (error) {
      reasons.push(`${label} protectedInputs path ${JSON.stringify(path)} cannot be read: ${message(error)}`)
    }
  }
  return { refs, reasons }
}

/**
 * Fix the declarations of one criterion list, rebuilding only the criteria that
 * declared one: every untouched criterion is carried by reference, and the
 */
export async function fixCriteriaProtectedInputs<T extends DeclaredProtectedInputs>(
  criteria: readonly T[],
  cwd: string | undefined,
  label: string,
): Promise<{ criteria: readonly T[]; reasons: string[] }> {
  const reasons: string[] = []
  /**
   * A criterion list that is not an array is a shape defect whichever entry
   * wrote it (`contractDefects` names it); carrying it here keeps the refusal
   */
  if (!Array.isArray(criteria)) return { criteria, reasons }
  const fixed: T[] = []
  for (const [index, criterion] of criteria.entries()) {
    const paths = declaredPaths(criterion.protectedInputs)
    if (paths.length === 0) {
      fixed.push(criterion)
      continue
    }
    const outcome = await fixProtectedInputs(paths, cwd, criterionLabel(label, criterion, index))
    reasons.push(...outcome.reasons)
    /**
     * The fixed form is the runtime's own normalized shape, which the declared
     * type cannot express (`CriterionSpec` declares paths): the cast is the
     */
    fixed.push(outcome.reasons.length === 0 ? ({ ...criterion, protectedInputs: outcome.refs } as T) : criterion)
  }
  return { criteria: fixed, reasons }
}

/**
 * Fix the declared protected inputs of a whole decomposition proposal before
 * anything else reads it: the runtime calls this ahead of the single
 */
export async function fixSpecProtectedInputs(
  spec: DecomposeSpec,
  cwd: string | undefined,
): Promise<{ spec: DecomposeSpec; reasons: string[] }> {
  const reasons: string[] = []
  /**
   * The spec's own shape is normalization's rule, not this walk's: a proposal
   * whose `children` (or a child's `acceptanceCriteria`) is not an array is
   */
  if (!Array.isArray(spec?.children)) return { spec, reasons }
  const children: DecomposeChildSpec[] = []
  for (const [index, child] of spec.children.entries()) {
    if (child === null || typeof child !== 'object' || !Array.isArray(child.acceptanceCriteria)) {
      children.push(child)
      continue
    }
    const outcome = await fixCriteriaProtectedInputs(child.acceptanceCriteria, cwd, `child ${index}`)
    reasons.push(...outcome.reasons)
    const touched = outcome.criteria.some((criterion, position) => criterion !== child.acceptanceCriteria[position])
    children.push(touched ? { ...child, acceptanceCriteria: outcome.criteria } : child)
  }
  const touched = children.some((child, index) => child !== spec.children[index])
  return { spec: touched ? { ...spec, children } : spec, reasons }
}

/**
 * Structural defects of the **fixed** form of every criterion's protected
 * inputs: each declaration must be an array of plain objects carrying exactly
 */
export function protectedInputDefects(criteria: readonly AcceptanceCriterion[], label: string): string[] {
  const reasons: string[] = []
  for (const criterion of criteria) {
    const where = `${label} criterion ${JSON.stringify(criterion.criterionId)}`
    const declared: unknown = criterion.protectedInputs
    if (declared === undefined) continue
    if (!Array.isArray(declared)) {
      reasons.push(
        `${where} protectedInputs must be an array of { path, sha256 } entries (declared paths are fixed by admission, never stored as strings)`,
      )
      continue
    }
    declared.forEach((entry, index) => {
      const at = `${where} protectedInputs entry ${index}`
      if (!isPlainObject(entry)) {
        reasons.push(`${at} must be an object with only path and sha256`)
        return
      }
      for (const key of unknownFieldKeys(entry, ['path', 'sha256'])) {
        reasons.push(`${at} declares unknown field ${JSON.stringify(key)}`)
      }
      if (!nonBlank(entry.path)) reasons.push(`${at} path must be a non-empty string`)
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        reasons.push(`${at} sha256 must be a lowercase 64-character hex digest`)
      }
    })
  }
  return reasons
}

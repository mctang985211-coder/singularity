/**
 * Protected acceptance inputs (S1-V slice 2, KISS §4.3): the admission-time
 * half of the identity a criterion's judge is later held to.
 *
 * Why identity has to be fixed at admission: a criterion that rests on an
 * acceptance script, a threshold file, or a fixture is only judgeable while
 * that input is the one the task was admitted against. Reading the file at
 * judgement time would let whoever executes the task rewrite the acceptance
 * script and turn a wrong product into a pass. Admission therefore reads each
 * declared path once, records the SHA-256 of its bytes beside the declared
 * path, and the verifier registry re-reads the same paths before judging — a
 * missing or modified input fails the criterion naming the path.
 *
 * The three rules this module owns, in one place so the ordinary decomposition
 * path, the replay path and the pre-judgement re-check cannot drift apart:
 *
 * 1. {@link fixProtectedInputs} fixes identities; it never writes anything.
 * 2. {@link fixSpecProtectedInputs} converts the declared string form into the
 *    fixed form before the single normalization entry ever sees the batch.
 *    That conversion is *not* normalization: the runtime performs it first,
 *    which is what puts the fixed digest — and not a later read — inside the
 *    contract and proposal identities.
 * 3. {@link protectedInputDefects} is the only shape check for the fixed form,
 *    shared by the decomposition and replay paths through
 *    `admission.contractDefects`.
 *
 * Only paths a criterion actually declares are protected. A criterion that
 * declares nothing carries no protection — nothing is read, nothing is
 * claimed — and must never be described as protected.
 * @module @dangosys/dsh-singularity-task-runtime/protected-inputs
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, ProtectedInputRef } from '@dangosys/dsh-singularity-task'
import type { DecomposeChildSpec, DecomposeSpec } from './index.ts'

/**
 * The smallest shape this module fixes: a criterion that may carry a declared
 * id (the label it is reported under) and a `protectedInputs` value of unknown
 * shape. Both the tool-facing authoring form (`CriterionSpec`, paths as
 * strings) and a stored criterion (the fixed refs) satisfy it.
 */
interface DeclaredProtectedInputs {
  criterionId?: string
  protectedInputs?: unknown
}

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

/**
 * The authoring form of one criterion's declaration: a non-empty array of
 * non-blank strings, in the order the caller wrote them.
 *
 * Everything else is *not* this generator's business. An absent declaration
 * says nothing was declared; the already-fixed form, a bare string, a mixed or
 * otherwise malformed array are left exactly as declared so
 * {@link protectedInputDefects} — through `admission.contractDefects` — refuses
 * them with a reason of their own. Fixing a malformed declaration instead of
 * refusing it would accept a shape nobody promised to read.
 */
function declaredPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return []
  return value.every(item => nonBlank(item)) ? [...(value as string[])] : []
}

/**
 * The label one criterion is reported under: the declared id when it has one,
 * its position otherwise — the vocabulary `normalize.ts` names criteria with,
 * so a caller reading a refusal sees one numbering, not two.
 */
function criterionLabel(childLabel: string, criterion: DeclaredProtectedInputs, index: number): string {
  const id = nonBlank(criterion.criterionId) ? JSON.stringify(criterion.criterionId) : index + 1
  return `${childLabel} criterion ${id}`
}

/**
 * Fix the byte identity of every declared protected input, against the
 * checkout directory the criterion's judge will run in.
 *
 * `paths` are the paths **as declared** (the caller's spellings, verbatim):
 * each is resolved against `cwd` for the read — an absolute path stays
 * absolute — while the returned ref keeps the declared spelling, so the
 * identity names what the caller wrote and not a tidied version of it. An
 * identical declaration repeated is read once and produces one entry, in
 * first-declaration order; two spellings of the same file stay two
 * declarations.
 *
 * Refusals are values, never throws: a path that cannot be read (missing,
 * unreadable, a directory) yields a reason naming the label and the path, and a
 * session whose checkout directory cannot be resolved (`cwd === undefined`)
 * yields one reason instead of fixing the declaration against the wrong base.
 * That refusal is whole-batch and absolute paths are not exempt: the checkout
 * names the directory the criterion's judge runs in, so a batch that cannot
 * name it cannot promise that what it fixed is what the re-check will compare —
 * and the refs of a batch refused for one path are never trustworthy either.
 * Nothing is ever written: the files are read and left byte-identical.
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
 * caller's input is never mutated — which is also why the returned list is
 * typed read-only.
 *
 * `label` is the position prefix a criterion is reported under (`child 0` on a
 * decomposition, `replay of "t-1"` on a replay); {@link criterionLabel} appends
 * the criterion's own id or position. A criterion whose fixing was refused is
 * carried unchanged — it never reaches the store, because the caller refuses
 * the whole batch on any reason — so no half-fixed identity can be read as a
 * fixed one.
 */
export async function fixCriteriaProtectedInputs<T extends DeclaredProtectedInputs>(
  criteria: readonly T[],
  cwd: string | undefined,
  label: string,
): Promise<{ criteria: readonly T[]; reasons: string[] }> {
  const reasons: string[] = []
  // A criterion list that is not an array is a shape defect whichever entry
  // wrote it (`contractDefects` names it); carrying it here keeps the refusal
  // readable instead of turning it into a crash.
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
    // The fixed form is the runtime's own normalized shape, which the declared
    // type cannot express (`CriterionSpec` declares paths): the cast is the
    // boundary that says so, and `protectedInputDefects` is the check that
    // refuses anything else.
    fixed.push(outcome.reasons.length === 0 ? { ...criterion, protectedInputs: outcome.refs } as T : criterion)
  }
  return { criteria: fixed, reasons }
}

/**
 * Fix the declared protected inputs of a whole decomposition proposal before
 * anything else reads it: the runtime calls this ahead of the single
 * normalization entry, so the contract the store receives — and both content
 * identities computed over it — describe the fixed byte identity rather than
 * the caller's paths.
 *
 * Absent declarations and every malformed shape are carried exactly as
 * declared, and a child nothing was fixed in is returned by reference: this
 * function converts the authoring form, it does not validate, so the reasons it
 * returns are only the ones fixing itself could produce.
 */
export async function fixSpecProtectedInputs(
  spec: DecomposeSpec,
  cwd: string | undefined,
): Promise<{ spec: DecomposeSpec; reasons: string[] }> {
  const reasons: string[] = []
  // The spec's own shape is normalization's rule, not this walk's: a proposal
  // whose `children` (or a child's `acceptanceCriteria`) is not an array is
  // carried verbatim so the caller still gets the readable normalization
  // refusal instead of a crash from a walk that was never meant to read it.
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
 * `path` (non-blank string) and `sha256` (lowercase 64-character hex). Shape
 * only — whether the file still hashes to that digest is the pre-judgement
 * re-check's question, and it needs the checkout, not this function.
 *
 * The ordinary decomposition path and the replay path share this function (via
 * `admission.contractDefects`) so one rule can never hold on one and not on the
 * other, and the declared string form is refused here as well: reaching
 * admission with paths instead of digests means the runtime's fixing step was
 * bypassed, which is exactly the state that must not be persisted. Every reason
 * is prefixed with `<label> criterion "<id>"`, the label the other contract
 * rules use.
 */
export function protectedInputDefects(criteria: readonly AcceptanceCriterion[], label: string): string[] {
  const reasons: string[] = []
  for (const criterion of criteria) {
    const where = `${label} criterion ${JSON.stringify(criterion.criterionId)}`
    const declared: unknown = criterion.protectedInputs
    if (declared === undefined) continue
    if (!Array.isArray(declared)) {
      reasons.push(`${where} protectedInputs must be an array of { path, sha256 } entries (declared paths are fixed by admission, never stored as strings)`)
      continue
    }
    declared.forEach((entry, index) => {
      const at = `${where} protectedInputs entry ${index}`
      if (!isPlainObject(entry)) {
        reasons.push(`${at} must be an object with only path and sha256`)
        return
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'path' && key !== 'sha256') reasons.push(`${at} declares unknown field ${JSON.stringify(key)}`)
      }
      if (!nonBlank(entry.path)) reasons.push(`${at} path must be a non-empty string`)
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        reasons.push(`${at} sha256 must be a lowercase 64-character hex digest`)
      }
    })
  }
  return reasons
}

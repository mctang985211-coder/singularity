/**
 * The three special semantics, proved rather than asserted:
 *
 * - a first Skill must be shown to have really been loaded by the candidate side;
 * - a capability the baseline cannot admit is proved by the runtime's own refusal;
 * - a template candidate must be shown to have really been instantiated, and its
 *   parent acceptance must stay independently judged.
 *
 * Every proof reads the runtime's sealed receipt; a fact the receipt does not
 * carry is a failure to prove, never an assumption.
 */

import type { ExecutionReceipt } from '@dangosys/dsh-singularity-task'
import type { EvaluationPlan, TrialResult } from '../types.ts'

/** One proved consumption: the asset kind, and the receipt facts that prove it. */
export interface ConsumptionProof {
  readonly kind: EvaluationPlan['kind']
  readonly proven: true
  readonly detail: string
}

/** The candidate side's skill use of one name, from the sealed receipt. */
function skillUseOf(receipt: ExecutionReceipt, name: string) {
  return receipt.skills.find(use => use.bound.some(skill => skill.name === name) || use.loaded.includes(name))
}

/** A first Skill is consumed only when the candidate side was both granted and actually shown to load it. */
export function proveSkillLoaded(input: { plan: EvaluationPlan; receipt: ExecutionReceipt; where: string }): ConsumptionProof {
  const name = input.plan.sides.candidate.skills.find(skill => !input.plan.sides.baseline.skills.some(other => other.name === skill.name))?.name
  if (name === undefined) {
    throw new Error(`${input.where}: the candidate side's plan adds no skill the baseline lacks; there is no first Skill to prove`)
  }
  const use = skillUseOf(input.receipt, name)
  if (use === undefined) {
    throw new Error(
      `${input.where}: the candidate side's receipt neither grants nor loads skill "${name}", so the first Skill was not consumed — a skill ` +
        "that never entered the run's own configuration is not measured by that run",
    )
  }
  if (!use.bound.some(skill => skill.name === name)) {
    throw new Error(`${input.where}: the candidate side's receipt loads skill "${name}" without granting it; the run's configuration is not the frozen one`)
  }
  if (!use.loaded.includes(name)) {
    throw new Error(
      `${input.where}: the candidate side granted skill "${name}" but its persisted session log shows no load of it — a first Skill is ` +
        'proved by the log, not by the plan',
    )
  }
  if (use.loadedOutsideGrant.length > 0) {
    throw new Error(
      `${input.where}: the candidate side loaded skills outside its grant (${use.loadedOutsideGrant.join(', ')}); the run consumed a ` +
        'configuration that was not the frozen one',
    )
  }
  return { kind: input.plan.kind, proven: true, detail: `skill "${name}" was granted and loaded by the candidate side (run ${use.runId})` }
}

/**
 * A capability the baseline cannot admit is proved by the runtime's own refusal:
 * the refusal travels verbatim, and the missing rows are named. Nothing is
 * inferred about cost — the absolute ceiling is the caller's own declaration.
 */
export function proveAdmissionRefusal(input: { plan: EvaluationPlan; candidate: TrialResult; where: string }): ConsumptionProof {
  if (input.candidate.outcome !== 'not-admitted') {
    throw new Error(
      `${input.where}: the candidate side is ${input.candidate.outcome}, not an admission refusal — a capability gap is proved by the ` +
        'runtime refusing the side, never by a side that ran',
    )
  }
  const admission = input.candidate.admission
  if (admission === undefined) {
    throw new Error(`${input.where}: the candidate side is not-admitted but carries no refusal; the reason the runtime refused it is missing`)
  }
  if (admission.source === 'capability-gap' && admission.missing.length === 0) {
    throw new Error(`${input.where}: a capability-gap refusal names no missing row; the gap it reports cannot be re-read`)
  }
  if (admission.reason.trim().length === 0) {
    throw new Error(`${input.where}: the admission refusal carries no reason text`)
  }
  return {
    kind: input.plan.kind,
    proven: true,
    detail:
      `the runtime refused the ${input.candidate.side} side (${admission.source})` +
      `${admission.missing.length === 0 ? '' : ` for rows ${admission.missing.map(row => JSON.stringify(row)).join(', ')}`}`,
  }
}

/**
 * A template candidate is consumed when the runtime's receipt observed the call
 * that instantiated it, and its parent acceptance is still judged by criteria
 * that are not the candidate's own.
 */
export function proveTemplateConsumed(input: {
  plan: EvaluationPlan
  /** The template id the draft proposes — the only reference the receipt's batches may name. */
  identity: string
  receipt: ExecutionReceipt
  /** The parent acceptance criterion ids the template candidate must not replace. */
  parentCriteria: readonly string[]
  where: string
}): ConsumptionProof {
  const batches = input.receipt.templates.filter(use => use.templateRef.id === input.identity)
  if (batches.length === 0) {
    throw new Error(
      `${input.where}: the candidate side's receipt consumed no task template (it holds ${input.receipt.templates.length} template ` +
        'batch(es)), so the candidate was never instantiated — a template nobody called is not measured',
    )
  }
  const observed = batches.filter(batch => batch.observation === 'observed')
  if (observed.length === 0) {
    throw new Error(
      `${input.where}: the candidate side's receipt records no confirmed instantiation of the candidate template (observations: ` +
        `${batches.map(batch => batch.observation).join(', ')})`,
    )
  }
  if (observed.some(batch => batch.childTaskIds.length === 0)) {
    throw new Error(`${input.where}: a confirmed instantiation decomposed no child task, so nothing was actually built from the template`)
  }
  const judged = new Set(input.receipt.review.criteria.map(criterion => criterion.criterionId))
  const lost = input.parentCriteria.filter(criterionId => !judged.has(criterionId))
  if (lost.length > 0) {
    throw new Error(
      `${input.where}: the candidate side's receipt judges no verdict for parent criteria ${lost.map(id => JSON.stringify(id)).join(', ')}; ` +
        'a template candidate keeps its independent parent acceptance, and the candidate never judges itself',
    )
  }
  return {
    kind: input.plan.kind,
    proven: true,
    detail: `template instantiated and observed (${observed.length} batch(es)), with the parent acceptance judged independently`,
  }
}

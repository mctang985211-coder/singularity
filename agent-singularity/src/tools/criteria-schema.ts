/** The acceptance-criterion JSON schema `task_decompose` and `task_intake` both declare: one property map, with the wording each tool writes handed in. @module @dangosys/dsh-singularity-agent/tools/criteria-schema */

import type { ObjectValueSchemaSpec, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

/** The wording each tool writes for the criterion members whose model-facing text differs. */
export interface CriterionWording {
  readonly description: string
  readonly criterionId: string
  readonly command: string
  readonly mode: string
  readonly requiresArtifact: string
  readonly acceptsArtifact: string
  readonly verifierRef: string
  readonly heuristic: string
  readonly protectedInputs: string
  /** The parent-level evidence map: decomposition declares it, intake omits it (a root contract has no batch to point into). */
  readonly childEvidence?: string
}

/** One closed criterion object; the two members both tools word identically live here. */
export function criterionSchema(wording: CriterionWording): ObjectValueSchemaSpec {
  const head: ParameterSchemaSpec = {
    description: { type: 'string', required: true, description: wording.description },
    criterionId: { type: 'string', description: wording.criterionId },
    command: { type: 'string', description: wording.command },
    mode: {
      type: 'string',
      enum: ['deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite'],
      description: wording.mode,
    },
    mandatory: { type: 'boolean', description: 'Whether the criterion must pass; default true' },
    requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence kinds the verifier must attach' },
    requiresArtifact: { type: 'array', items: { type: 'string' }, description: wording.requiresArtifact },
    acceptsArtifact: { type: 'array', items: { type: 'string' }, description: wording.acceptsArtifact },
    verifierRef: { type: 'string', description: wording.verifierRef },
  }
  const tail: ParameterSchemaSpec = {
    heuristic: { type: 'boolean', description: wording.heuristic },
    protectedInputs: { type: 'array', items: { type: 'string' }, description: wording.protectedInputs },
  }
  if (wording.childEvidence === undefined) {
    return { type: 'object', additionalProperties: false, properties: { ...head, ...tail } }
  }
  const childEvidence: ParameterSchemaSpec = {
    childEvidence: {
      type: 'array',
      description: wording.childEvidence,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childIndex: { type: 'integer', required: true, description: '0-based position of the member in the run\'s accumulated members: the batches this run admits, concatenated in admission order, so a later batch appends and never moves an earlier member' },
          criterionId: { type: 'string', description: 'The child criterion whose passing verdict is required' },
          evidenceRef: { type: 'string', description: 'The evidence id, artifact kind, or artifact id that must exist in the child\'s verified run evidence' },
        },
      },
    },
  }
  return { type: 'object', additionalProperties: false, properties: { ...head, ...childEvidence, ...tail } }
}

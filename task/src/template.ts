/** Reusable task contracts. A version is immutable; every instance pins its content digest. */
import { canonicalize, sha256Hex } from './contract.ts'
import type { ChildEvidenceRef, VerificationMode } from './types.ts'

export interface CriterionSpec {
  /**
   * Stable criterion id (T1). Omitted, the runtime generates one from the batch
   * position (`ac1-1`, `ac2-1`, …) — the scheme every criterion was numbered
   */
  criterionId?: string
  description: string
  command?: string
  mode?: VerificationMode
  mandatory?: boolean
  requiredEvidence?: string[]
  /**
   * Evidence dependencies (KISS §5.1): artifact/evidence kinds or ids that must
   * exist in the store before this criterion can be judged. Since P4 this
   */
  requiresArtifact?: string[]
  /**
   * Raw-input counterpart of `requiresArtifact` (P4): artifact/evidence kinds
   * or ids this criterion consumes, where mere existence in the store is the
   */
  acceptsArtifact?: string[]
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent dispatches by mode (the current behavior);
   */
  verifierRef?: string
  /**
   * The parent-level evidence map (KISS §6 C2, P4): which child of the
   * decomposing task this criterion rests on, by batch position, optionally
   */
  childEvidence?: ChildEvidenceRef[]
  /**
   * Labels this criterion's judgement heuristic (KISS §5.1, P4): the verdict is
   * marked as such and never counted as a deterministic pass. Mutually
   */
  heuristic?: boolean
  /**
   * Acceptance inputs this criterion's verdict rests on that the executing side
   * must not modify (S1-V slice 2): acceptance scripts, threshold files,
   */
  protectedInputs?: readonly string[]
}


export type TemplateParameter = string | number | boolean
export type TemplateParameters = Record<string, TemplateParameter>

export interface TaskTemplateRef {
  id: string
  version: number
  digest: string
}

/** The deliberately small supported JSON Schema vocabulary for template parameters. */
export interface TemplateParametersSchema {
  type: 'object'
  properties: Record<string, {
    type: 'string' | 'number' | 'integer' | 'boolean'
    description?: string
    enum?: TemplateParameter[]
  }>
  required?: string[]
  additionalProperties: false
}

export interface TaskTemplateContract {
  objective: string
  acceptanceCriteria: readonly CriterionSpec[]
  assumptions?: readonly string[]
  constraints?: readonly string[]
  requiredCapabilities?: readonly string[]
}

export interface TaskTemplate {
  id: string
  version: number
  /** Conditions the caller must check before choosing this template. */
  appliesTo: string[]
  parametersSchema: TemplateParametersSchema
  /** Complete authoring contract; {{name}} placeholders bind declared primitive parameters. */
  contract: TaskTemplateContract
}

/** Creation accepts either a full contract or a pinned template plus parameters. */
export interface TaskContractInput extends Partial<TaskTemplateContract> {
  templateRef?: TaskTemplateRef
  templateParameters?: TemplateParameters
}

export function taskTemplateDigest(template: TaskTemplate): string {
  return sha256Hex(canonicalize(template))
}

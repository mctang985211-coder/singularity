/**
 * The evolution plane's public vocabulary: the draft, the one frozen evaluation
 * plan, the single side-fact schema and the one report. Everything a legacy v4
 * ledger needed — a lifecycle status, a hand-filled version set, six gate
 * answers, a derivable champion and two provider identities — is gone: a second
 * representation of a fact the draft or the plan already carries is a regression.
 *
 * @module dsh-singularity-evolution/types
 */

import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'
import type { StrategyPolicy } from './strategy/policy.ts'

/** One environment revision reference: the immutable version a side is bound to. */
export interface RevisionRef {
  readonly revisionId: string
  /** The revision manifest's `contentDigest`. */
  readonly digest: string
  readonly libraryId: string
}

/** The three assets this plane evolves automatically. */
export type MethodAssetKind = 'skill' | 'task-template' | 'capability'

/** The candidate revision a draft proposes: a frozen directory plus the files it changes. */
export interface CandidateRevision {
  readonly revisionId: string
  /**
   * The candidate revision manifest's own `contentDigest`, which covers the
   * assets the revision holds and never the draft id or the staging timestamp —
   * so two drafts carrying the same bytes read the same digest, and the
   * strategy's same-bytes refutation can match on it.
   */
  readonly digest: string
  /** Candidate-relative files, in path order. */
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

/** One immutable draft. Replaces proposed → candidate → prepared → gated → decided. */
export interface MethodDraft {
  readonly draftId: string
  readonly kind: MethodAssetKind
  /** The asset's stable identity in the library (skill name / template id / capability row name). */
  readonly identity: string
  /** The revision the draft was written against, in place of a hand-filled version set. */
  readonly baseRevision: RevisionRef
  readonly candidateRevision: CandidateRevision
  readonly rationale: string
  readonly sourceRefs: readonly string[]
  readonly actor: string
  readonly at: string
}

/** The four states a draft can be in. */
export type DraftStatus = 'draft' | 'evaluated' | 'discarded' | 'published'

/** The resolved identity of one asset inside a revision. */
export interface AssetContentIdentity {
  readonly kind: MethodAssetKind
  readonly identity: string
  /** Digest of the asset's own content as the revision manifest records it. */
  readonly digest: string
  readonly present: boolean
}

/** One side's frozen plan. Both sides of one evaluation carry exactly this shape. */
export interface SidePlan {
  readonly side: 'baseline' | 'candidate'
  readonly revision: RevisionRef
  readonly capabilities: readonly string[]
  readonly registryRevision: string
  readonly mcpServers: readonly { readonly serverName: string; readonly templateDigest: string }[]
  readonly preset: string | null
  readonly skills: readonly FrozenProviderSkill[]
  readonly model: ModelSelection
  /** The original acceptance this side is judged by, frozen before anything runs. */
  readonly acceptance: readonly FrozenCriterion[]
}

/** The frozen scoring rules of one evaluation. */
export interface EvaluationRules {
  /** Absent means repair (the default original-acceptance success rate). */
  readonly objective?: EvaluationObjective
  readonly quality: { readonly metricId: string; readonly direction: 'higher-is-better'; readonly extractor: string }
  readonly guards: readonly { readonly id: string; readonly kind: 'acceptance' | 'holdout' | 'domain'; readonly bound: number }[]
  readonly floor?: { readonly key: string; readonly value: number }
}

/** The token ceiling a caller freezes with the evaluation. */
export interface EvaluationBudget {
  readonly maxTokens?: number
  readonly note?: string
}

/** One sample of a frozen plan. */
export interface PlannedSample {
  readonly taskId: string
  readonly role: ExperimentSampleRole
  readonly contractDigest: string
  readonly criteria: readonly FrozenCriterion[]
  readonly observed: { readonly outcome: 'verified' | 'failed'; readonly runId?: string }
  /** The runtime's own refusal of this sample's baseline side, frozen before anything runs. */
  readonly admission?: AdmissionRefusal
}

/** The frozen input both sides' workspaces are built from. */
export interface PlannedInput {
  readonly sourceDir: string
  readonly paths?: readonly string[]
  readonly rebaseFrom?: string
  readonly digest: string
}

/** The frozen strategy a plan carries, so a decision recomputes from record + report alone. */
export interface PlannedStrategy {
  readonly policy: StrategyPolicy
  readonly policyDigest: string
  readonly cohortDigest: string
}

/** The one frozen evaluation plan: two sides, the samples, the input, the rules and the budget. */
export interface EvaluationPlan {
  readonly planId: string
  readonly draftId: string
  readonly kind: MethodAssetKind
  readonly libraryId: string
  readonly sides: { readonly baseline: SidePlan; readonly candidate: SidePlan }
  readonly samples: readonly PlannedSample[]
  readonly input: PlannedInput
  readonly rules: EvaluationRules
  readonly budget: EvaluationBudget
  readonly repetition: number
  readonly evaluation?: OutcomeEvaluationPlan
  readonly overlay: { readonly baseline: string; readonly candidate: string }
  readonly strategy?: PlannedStrategy
  readonly schemaVersion: 'evaluation-plan@1'
}

/** Which way one trial settled. */
export type TrialOutcome = 'verified' | 'failed' | 'cancelled' | 'interrupted' | 'not-admitted'

/** One reading of a run subtree's cost. */
export type CostReading =
  | { readonly status: 'reported'; readonly tokens: import('@dangosys/dsh-singularity-task').ReviewTokenUsage; readonly toolCalls?: { readonly calls: number; readonly failures: number } }
  | { readonly status: 'unknown'; readonly reason: string }

/** One criterion's verdict on one side, with the verifier that decided it. */
export interface TrialCriterion {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail' | 'inconclusive'
  readonly verifierId?: string
  readonly verifierVersion?: string
  readonly command?: string
  readonly exitCode?: number
}

/** The runtime's own admission refusal of one side, verbatim. */
export interface AdmissionRefusal {
  readonly source: 'capability-gap' | 'provider-refused'
  readonly required: readonly string[]
  readonly missing: readonly string[]
  readonly reason: string
}

/** The normalized execution receipt of one trial: the runtime's own evidence, or an explicit gap. */
export interface ExecutionReceiptRef {
  readonly receiptId: string
  readonly digest: string
  readonly taskId?: string
  readonly runId?: string
  readonly reviewRef?: string
  readonly criteria: readonly TrialCriterion[]
  readonly evidenceRefs: readonly string[]
  readonly cost: CostReading
  readonly boundRevision: string
  readonly boundModel: string
  readonly workspace: string
  readonly workspaceDigest: string
  /** Present exactly when the receipt establishes every fact a consumer needs. */
  readonly complete: boolean
  readonly incompleteness?: readonly string[]
}

/** One side of one sample: the only side-fact schema this plane keeps. */
export interface TrialResult {
  readonly sampleTaskId: string
  readonly side: 'baseline' | 'candidate'
  readonly role: ExperimentSampleRole
  readonly outcome: TrialOutcome
  readonly receipt: ExecutionReceiptRef
  readonly admission?: AdmissionRefusal
  readonly reason?: string
  readonly actor: string
  readonly at: string
}

/** One sample's mechanical verdict. */
export type TrialSampleVerdict = 'fixed' | 'both-failed' | 'not-fixed' | 'improved' | 'not-improved' | 'maintained' | 'regressed' | 'inconclusive'

/** The evaluation's overall categorical verdict. */
export type EvaluationVerdict = 'fixed' | 'fixed-with-regression' | 'not-fixed' | 'both-failed' | 'improved' | 'not-improved' | 'regressed' | 'inconclusive'

export type EvaluationObjective = 'tool-call-reduction' | 'llm-outcome'

/** One non-compensatory guard's outcome. */
export interface GuardOutcome {
  readonly id: string
  readonly kind: 'acceptance' | 'holdout' | 'domain'
  readonly ok: boolean
  readonly detail: string
}

/** One sample's two sides and their verdict. */
export interface TrialComparison {
  readonly sampleTaskId: string
  readonly role: ExperimentSampleRole
  readonly baseline: TrialResult
  readonly candidate: TrialResult
  readonly verdict: TrialSampleVerdict
}

/** The numeric reading of one evaluation. */
export interface EvaluationScore {
  readonly quality: { readonly baseline: number; readonly candidate: number; readonly delta: number; readonly unit: string }
  readonly cost:
    | { readonly status: 'reported'; readonly baselineTokens: number; readonly candidateTokens: number; readonly relativeDelta: number }
    | { readonly status: 'unknown'; readonly reason: string }
  readonly uncertainty: { readonly basis: 'repeated-trials' | 'single-trial'; readonly repeats: number; readonly noiseBand: number | null; readonly reason?: string }
  readonly inconclusive: boolean
}

/** The one evaluation report: what the strategy reads and what a publish re-checks. */
export interface EvaluationReport {
  readonly formatVersion: 5
  readonly draftId: string
  readonly evaluationId: string
  readonly planId: string
  readonly libraryId: string
  readonly kind: MethodAssetKind
  readonly at: string
  readonly plan: EvaluationPlan
  readonly planDigest: string
  readonly evaluation?: OutcomeEvaluation
  readonly trials: readonly TrialComparison[]
  readonly score: EvaluationScore
  readonly guards: readonly GuardOutcome[]
  readonly verdict: EvaluationVerdict
}

/** The filter `methodList` accepts. */
export interface MethodListFilter {
  readonly status?: DraftStatus
  readonly kind?: MethodAssetKind
  readonly libraryId?: string
}

/** One skill as one frozen revision holds it. */
export interface RevisionSkillView {
  readonly name: string
  readonly version: number
  readonly contentDigest: string
  readonly contractDigest: string | null
  readonly status: 'temporary' | 'retained' | 'retired'
}

/** One task template as one frozen revision holds it. */
export interface RevisionTemplateView {
  readonly id: string
  readonly version: number
  readonly digest: string
  readonly status: 'temporary' | 'retained' | 'retired'
  readonly skills: readonly string[]
}

/** One frozen revision, projected to what this plane reads: identity, roots, entries and the two tables. */
export interface RevisionView {
  readonly ref: RevisionRef
  readonly root: string
  readonly skillRoot: string
  readonly taskTemplatesRoot: string
  readonly skills: readonly RevisionSkillView[]
  readonly templates: readonly RevisionTemplateView[]
  readonly capabilityRows: Readonly<Record<string, import('@dangosys/dsh-singularity-task-runtime').CapabilityConfig>>
  readonly mcpServers: Readonly<Record<string, import('@dangosys/dsh-singularity-task-runtime').McpServerTemplate>>
}

// ---------------------------------------------------------------------------
// The vocabulary the evaluation shares with the strategy and the tool layer:
// the model selection, the sample roles and the frozen acceptance.
// ---------------------------------------------------------------------------

/** The model selection one deployment's runs share, as that deployment resolves it. */
export interface ModelSelection {
  /** The registered provider route the runs go through. */
  provider: string
  /** The provider-owned model id. */
  model: string
  /** The adapter-owned reasoning effort, when the deployment selected one. */
  reasoningEffort?: string
  /** The per-request output ceiling, when the deployment selected one. */
  maxTokens?: number
  /** Derived display form `<provider>/<model>`, shown to humans and never parsed back. */
  label: string
}

/** Why a sample is in the evaluation: the role it was chosen for. */
export type ExperimentSampleRole = 'observed-failure' | 'observed-success' | 'observed-regression' | 'holdout'

/** One criterion's frozen identity: the acceptance condition as the sample's own task carried it. */
export interface FrozenCriterion {
  criterionId: string
  verificationMode: string
  command?: string
  /** SHA-256 over the criterion's protected input identities (`<path>\0<sha256>` lines, sorted); the empty list hashes too. */
  protectedInputsDigest: string
  /** The judge the criterion pins (`AcceptanceCriterion.verifierRef`), which every run of the side must still name. */
  verifierRef: string
  /** The pinned judge's registered version at freeze: the freeze refuses a judge that declares none. */
  verifierVersion: string
  /** How this criterion's judge identity is anchored, named at freeze so a later re-read keeps the same anchor. */
  verifierAnchor: string
}

/** One skill the side's own pre-check resolved. */
export interface FrozenProviderSkill {
  name: string
  role: 'execution-provider' | 'knowledge' | 'guidance'
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null
  /** `skillContentDigest` of the bytes the run is expected to load for this skill. */
  contentDigest: string
}

/** The llm-outcome rubric one plan freezes: the goal, the measurements and the independent judge. */
export interface OutcomeEvaluationPlan {
  goal: string
  rubric: string
  measurements: { id: string; command: string }[]
  judge: { model: ModelSelection; prompt: string; digest: string }
  /** The complete response when an LLM generated the rubric and commands. */
  generatedResponse?: string
  /** Authoritative four-bucket usage of the plan generation call. Omitted when unavailable. */
  generatedUsage?: import('@dangosys/dsh-singularity-task').ReviewTokenUsage
}

/** One measurement's saved result on one side of one sample. */
export interface OutcomeMeasurement {
  ref: string
  sampleTaskId: string
  side: 'baseline' | 'candidate'
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  workspace: string
  workspaceDigest: string
}

/** The independent judge's answer, one entry per frozen sample. */
export interface OutcomeJudgement {
  samples: {
    taskId: string
    verdict: 'improved' | 'not-improved' | 'regressed' | 'inconclusive'
    findings: { claim: string; evidenceRefs: string[] }[]
    uncertainties: string[]
  }[]
}

/** One saved independent judgement, with the digests that prove its input and response did not move. */
export interface OutcomeEvaluation {
  input: string
  inputDigest: string
  evidencePath: string
  evidenceDigest: string
  response: string
  responseDigest: string
  judgement: OutcomeJudgement
  /** Authoritative usage of the independent judge; missing means unknown, never free. */
  judgeUsage?: import('@dangosys/dsh-singularity-task').ReviewTokenUsage
}

/** One judge call's answer: the response text, and the call's own usage when the deployment reports one. */
export interface OutcomeModelResult {
  response: string
  usage?: import('@dangosys/dsh-singularity-task').ReviewTokenUsage
}

/** One call to the model that answers the frozen rubric or judges the evaluation. */
export type OutcomeModelCall = (
  model: ModelSelection,
  prompt: string,
  input: string,
  signal?: AbortSignal,
) => Promise<string | OutcomeModelResult>

/** The target types a legacy v4 proposal named; kept so a reader of the old projection can render them. */
export type LegacyTargetType = ProposalTargetType

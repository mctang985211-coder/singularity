import type { TaskDefinitionIdentity } from './task-definition.ts'
/** The evolution plane's public vocabulary: lifecycle levels and records, the decisions and the provider roles a promotion reports.
 * @module dsh-singularity-evolution/types */

import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'
import type { SkillProviderVerdict } from '@dangosys/dsh-singularity-task-runtime'
import type { McpServerTemplate, CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { McpServerIdentity, CapabilityRowIdentity } from './capability-candidate.ts'
import type { SkillContentIdentity } from './replay.ts'
import type { ModelSelection } from './replay.ts'
import type {
  ExperimentSampleRole,
  FrozenCriterion,
  FrozenProviderSkill,
  OutcomeEvaluation,
  OutcomeEvaluationPlan,
  OutcomeJudgement,
} from './replay.ts'
import type { OutcomeModelCall } from './experiment/spec.ts'
import type { StrategyPolicy } from './strategy/policy.ts'
import type { CommitFile, CommitStage } from './commit.ts'
import type { CapabilityTableIdentity } from './capability-config.ts'

import type { ExperimentJudgedRecord, ExperimentSampleRecord, ExperimentStartedRecord } from './experiment/spec.ts'

export type EvolutionLevel = 'L1' | 'L2' | 'L3' | 'L4'

export type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'gated' | 'decided' | 'applied' | 'rolledback'
/** The three frozen decision values of the Validation Gate (细化想法4.md §32). */
export type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH'

export const EVOLUTION_LEVELS: readonly EvolutionLevel[] = ['L1', 'L2', 'L3', 'L4']

export const EVOLUTION_DECISIONS: readonly EvolutionDecision[] = ['PROMOTE', 'REJECT', 'KEEP_FOR_FURTHER_RESEARCH']

/** The target types `evolution_apply`/`evolution_rollback` move mechanically: a skill object or a capability row. */
export const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[] = ['skill', 'capability', 'task_definition']

/** The skill mutation: the full `SKILL.md` text for the one skill object this build moves. */
export interface SkillMutation {
  name: string
  content: string
  /** Complete text resource set. Omission preserves the production resources. */
  resources?: Record<string, string>
}

/** The champion state of one prepared proposal: `captured` for a same-name update, `absent` when production held no object to snapshot. */
type ChampionState = 'captured' | 'absent'

/** Folded view of one `prepared` record. */
export interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null
  mechanical: boolean
  champion: ChampionState
  /** The content identity recorded for the materialized candidate object (P2) — the digest a promotion re-reads. */
  templateCandidate?: TaskDefinitionIdentity
  templateBaseline?: TaskDefinitionIdentity | null
  templateLibraries?: { baseline: string; candidate: string }
  skillContent?: SkillContentIdentity
  /** The content identity of the production object as it stood at prepare (P3) — `null` when there was none. */
  skillBaseline?: SkillContentIdentity | null
  /** The capability row a capability candidate fixes (A6): the whole row and the digest of its canonical bytes. */
  capabilityRow?: CapabilityRowIdentity
  /** The row the registry held at prepare (A6), with its frozen champion bytes. */
  capabilityBaseline?: CapabilityRowIdentity | null
  /** The capability table file's **composed identity**, frozen at prepare (A6, plan §F.4) so a third-party edit is a named stop. */
  capabilityTable?: CapabilityTableIdentity
  mcpServers?: McpServerIdentity
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[]
}

/** The minimal Validation Gate (细化想法4.md §32): the six verbatim questions a human answers, plus the evidence they cite. */
export interface GateAnswers {
  /** Answer to "1. Target failure fixed?" */
  targetFailureFixed: string
  /** Answer to "2. Original acceptance maintained?" */
  originalAcceptanceMaintained: string
  /** Answer to "3. Existing regression maintained?" */
  existingRegressionMaintained: string
  /** Answer to "4. No unacceptable side effects?" */
  noUnacceptableSideEffects: string
  /** Answer to "5. Holdout performance acceptable?" */
  holdoutPerformanceAcceptable: string
  /** Answer to "6. Resource cost acceptable?" */
  resourceCostAcceptable: string
  /** Evidence behind the regression/replay answers: evidence ids or paths, existence-checked, never executed. */
  regressionEvidenceRefs: string[]
}

/** One immutable ledger line, `formatVersion: 4` throughout (K3). A state line folds into one proposal's history. */
export type EvolutionRecord =
  | {
      formatVersion: 4
      kind: 'proposed'
      proposalId: string
      targetType: ProposalTargetType
      targetId: string
      baseVersion: string
      level: EvolutionLevel
      rationale: string
      sourceRefs: string[]
      actor: string
      at: string
    }
  | {
      formatVersion: 4
      kind: 'candidate'
      proposalId: string
      /** Complete version set the candidate aligns to (branch-model bookkeeping; this build creates no real branch). */
      versionSet: Record<string, string>
      /** The structured patch description, shaped and validated by the proposal's targetType. */
      mutation: unknown
      actor: string
      at: string
    }
  | {
      formatVersion: 4
      kind: 'prepared'
      proposalId: string
      /** Sandbox dir relative to the ledger root. Every prepare this build admits materializes one. */
      sandbox: string | null
      /** True on every prepare the fold admits: this build's candidate is a materialized mutation. */
      mechanical: boolean
      /** `captured` for a same-name skill update, `absent` for a capability candidate's new skill object (A6). */
      champion: ChampionState
      /** The content identity of the materialized candidate `SKILL.md` (P2) — the digest a promotion re-reads. */
      templateCandidate?: TaskDefinitionIdentity
      templateBaseline?: TaskDefinitionIdentity | null
      templateLibraries?: { baseline: string; candidate: string }
      skillContent?: SkillContentIdentity
      /** The content identity of the production `SKILL.md` as it stood at prepare (P3). */
      skillBaseline?: SkillContentIdentity | null
      /** The capability row a capability candidate fixed, with the digest of its canonical bytes (A6). */
      capabilityRow?: CapabilityRowIdentity
      /** The row the registry held at prepare, or `null` when it held none (A6); required on every capability prepare. */
      capabilityBaseline?: CapabilityRowIdentity | null
      /** The composed identity of the deployment's capability table file, frozen at prepare so a third-party edit is a named stop (A6). */
      capabilityTable?: CapabilityTableIdentity
      mcpServers?: McpServerIdentity
      /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
      files: string[]
      actor: string
      at: string
    }
  | { formatVersion: 4; kind: 'gated'; proposalId: string; gate: GateAnswers; actor: string; at: string }
  | {
      formatVersion: 4
      kind: 'decided'
      proposalId: string
      decision: EvolutionDecision
      note?: string
      /** The evolution_decide call that recorded the model decision. */
      approvalRef?: string
      actor: string
      at: string
    }
  | {
      formatVersion: 4
      kind: 'applied'
      proposalId: string
      /** Production write targets, in commit order — the whole file set of the object this apply wrote (absolute paths). */
      targets: string[]
      /** Human-review evidence: the approval call id of the evolution_apply request that granted this write. */
      approvalRef: string
      /** The open commit intent this completion closes (K2): the derived intent id. */
      intentId: string
      actor: string
      at: string
    }
  | {
      formatVersion: 4
      kind: 'rolledback'
      proposalId: string
      /** Production write targets of the rollback (restored champion file set), in commit order, for audit. */
      targets: string[]
      /** Human-review evidence: the approval call id of the evolution_rollback request that granted this write. */
      approvalRef: string
      /** The open commit intent this completion closes (K2) — see `applied`. */
      intentId: string
      actor: string
      at: string
    }
  /** The commit intent (K2) — see {@link CommitIntentRecord}. */
  | CommitIntentRecord
  /** The experiment family (S4-E §F.2): the two-sided skill evaluation's frozen start line and its sample records. */
  | ExperimentStartedRecord
  | ExperimentSampleRecord
  | ExperimentJudgedRecord

/** Which way one commit moves a production target. */
export type CommitDirection = 'apply' | 'rollback'

/** One `commit_intent` ledger line (K2, extended by A6): the durable "this is about to write" record. */
export interface CommitIntentRecord {
  /** The `proposals.jsonl` format version — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4
  kind: 'commit_intent'
  /** `<proposalId>/<direction>` — the derived id the completion line must repeat. */
  intentId: string
  proposalId: string
  direction: CommitDirection
  /** The human grant that authorised this commit (`approval:<callId>`), recorded on the completion as well. */
  approvalRef: string
  /** The object's fixed files, in commit order — `SKILL.md` first, the `SKILL.contract.json` second when the object carries an execution sidecar; empty for a row-only capability commit. */
  files: CommitFile[]
  /** The one capability row this commit moves (A6); absent for a skill commit. */
  capability?: CommitCapability
  actor: string
  at: string
}

/** The one capability row a `commit_intent` carries (A6): what the registry must hold before and after, and the bytes a recovery installs. */
export interface CommitCapability {
  name: string
  /** The row's canonical digest the registry must hold before the write; `null` when it must hold no row. */
  baselineSha256: string | null
  /** The row's canonical digest this direction installs; `null` when this direction removes the row. */
  contentSha256: string | null
  /** The recoverable row bytes, relative to the ledger root; absent when this direction removes the row. */
  source?: string
  mcpServers?: McpServerIdentity
  mcpSource?: string
}

/** Folded view of one open `commit_intent` record, as {@link EvolutionProposal} exposes it. */
export interface CommitIntentView {
  intentId: string
  proposalId: string
  direction: CommitDirection
  approvalRef: string
  /** The object's fixed files, in commit order; one or two entries, empty for a row-only capability commit (see {@link CommitIntentRecord.files}). */
  files: CommitFile[]
  /** The capability row this commit moves, when it carries one (A6). */
  capability?: CommitCapability
  actor: string
  at: string
}

/** Folded view of one `applied` or `rolledback` record. */
interface ApplyView {
  targets: string[]
  approvalRef: string
}

/** What an apply/rollback changed, returned to the tool layer. */
export interface ApplyOutcome {
  proposal: EvolutionProposal
  targets: string[]
  /** Set only when this call found a commit intent already open for the proposal. */
  recovered?: 'redone' | 'written'
  /** What the promotion check validated about the providers this apply put in place. */
  providers?: readonly PromotionProvider[]
}

/** One provider a promotion check judged, with the role it may be counted as. */
export interface PromotionProvider {
  /** The skill name a capability grants (or the candidate skill's own name). */
  readonly name: string
  /** `execution-provider` is the only role that may close an execution gap. */
  readonly role: 'execution-provider' | 'knowledge' | 'guidance'
  /** {@link skillContentDigest} of the bytes the verdict was taken from. */
  readonly contentDigest: string
  /** Execution providers only: the declared verifier ref, proven registered against the live vocabulary. */
  readonly verifierRef?: string
}

/** What a promotion check validated (S1-C item 3), returned by the gate and reported to the tool layer. */
export interface PromotionCheck {
  /** One entry per provider this promotion puts in place; empty for a target type that carries none (`agent_preset`, `task_definition`, bookkeeping-only). */
  readonly providers: readonly PromotionProvider[]
}

/** The task runtime as a promotion check reads it: the effective capability registry, resolved softly. */
export interface CapabilityRegistrySource {
  listCapabilities?(): Readonly<Record<string, CapabilityConfig>>
  listMcpServers?(): Readonly<Record<string, McpServerTemplate>>
}

/** The task runtime as a *commit* reads and moves it (A6): the one entry that reads and installs one capability row. */
export interface CapabilityRowWriter {
  readCapabilityRow?(name: string): Promise<CapabilityConfig | null>
  applyCapabilityRow?(
    name: string,
    entry: CapabilityConfig | null,
    options?: { commitTargets?: readonly string[]; commitRow?: string; mcpServers?: Record<string, McpServerTemplate | null> },
  ): Promise<void>
}

/** One accepted verdict as a promotion report entry: the role, the content it was taken from, and the verifier ref only an execution provider has. */
export function promotionProviderOf(verdict: Extract<SkillProviderVerdict, { valid: true }>): PromotionProvider {
  return {
    name: verdict.name,
    role: verdict.role,
    contentDigest: verdict.contentDigest,
    ...(verdict.role === 'execution-provider' ? { verifierRef: verdict.verifierRef } : {}),
  }
}

/** One provider role per line, for a decision or apply report. */
export function renderProviderRoles(providers: readonly PromotionProvider[]): string[] {
  return providers.map(provider => {
    if (provider.role === 'execution-provider') {
      return `provider: skill \`${provider.name}\` → execution-provider (verifier ${provider.verifierRef})`
    }
    if (provider.role === 'knowledge') {
      return `provider: skill \`${provider.name}\` → knowledge (loadable content; it does not close an execution gap)`
    }
    return `provider: skill \`${provider.name}\` → guidance (no sidecar; loadable guidance, not an execution provider)`
  })
}

/** The folded view of one proposal: its `proposed` record plus everything later records added. */
export interface EvolutionProposal {
  proposalId: string
  targetType: ProposalTargetType
  targetId: string
  baseVersion: string
  level: EvolutionLevel
  rationale: string
  sourceRefs: string[]
  status: EvolutionStatus
  versionSet?: Record<string, string>
  /** The candidate's structured mutation, verbatim as recorded. */
  mutation?: unknown
  prepared?: PreparedView
  gate?: GateAnswers
  decision?: EvolutionDecision
  decisionNote?: string
  /** Approval evidence of the decided record, when it carries one (every new record does). */
  decisionApprovalRef?: string
  applied?: ApplyView
  rolledback?: ApplyView
  /** The commit intent this proposal has open (K2): a production write is only settled once its intent is closed. */
  openIntent?: CommitIntentView
  /** One entry per ledger record, oldest first — derived, never stored. */
  history: { status: EvolutionStatus; actor: string; at: string }[]
}

export interface ProposeInput {
  proposalId: string
  targetType: ProposalTargetType
  targetId: string
  baseVersion: string
  level: EvolutionLevel
  rationale: string
  sourceRefs: string[]
}

export interface ListFilter {
  status?: EvolutionStatus
  targetType?: ProposalTargetType
  targetId?: string
}

/** Plugin config; every field optional — the constructor resolves defaults. */
export interface Config {
  /** Graph library identity supplied by the server when it constructs a scoped service. */
  libraryId?: string
  /** Directory of the ledger file `proposals.jsonl`; sandboxes materialize under it. Defaults to `$DSH_HOME/evolution`. */
  root?: string
  /** Production skill root — champion snapshots read from here; apply/rollback write here. Defaults to `$DSH_HOME/skills`. */
  skillRoot?: string
  /** The harness repo root: the parent of the `$DSH_HOME` fallback. */
  repoRoot?: string
  /** Resolves the model selection this plane freezes with an experiment and re-reads at promotion. */
  modelSelection?: () => ModelSelection | undefined
  /** The typed test seam of the commit path (K2, per-file since K3): it fires at each named stage. */
  commitProbe?: (stage: CommitStage, target?: string) => void
  /** The capability table's own file (A6): the deployment's `config.yml`, whose `task-runtime` capabilities row a capability commit writes. */
  capabilityConfig?: string
  /** The typed test seam of the capability-config write (A6), the same shape as the commit probe. */
  capabilityConfigProbe?: (stage: 'before-write' | 'staged' | 'written', row: string) => void
  /** Task template catalog root for this graph's library. When omitted the task-runtime default is used. */
  taskTemplatesRoot?: string
}

// ---------------------------------------------------------------------------
// v5 vocabulary (RRSI refactor, batch 3): the draft → evaluate → publish path.
// Everything below belongs to the new protocol; the v4 vocabulary above stays
// until the new pipeline replaces the evaluation machinery that still reads it.
// ---------------------------------------------------------------------------

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

// The model selection is one shape across the old and the new protocol; it is
// re-exported here so the new modules have one import site for it.
export type {
  ModelSelection,
  FrozenCriterion,
  FrozenProviderSkill,
  ExperimentSampleRole,
  OutcomeEvaluation,
  OutcomeEvaluationPlan,
  OutcomeJudgement,
}
export type { OutcomeModelCall }

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

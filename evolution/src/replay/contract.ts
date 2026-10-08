import type { McpServerIdentity } from '../capability-candidate.ts'
import type { RunMcpServerBinding } from '@dangosys/dsh-singularity-task'
import type { FrozenTaskDefinition } from '../task-definition.ts'
import type { ExperimentSnapshot } from './snapshot.ts'
/** The experiment contract: its frozen and reported schema, the comparison verdicts and the digest primitives.
 * @module dsh-singularity-evolution/replay/contract */

import type { ReviewMetrics } from '@dangosys/dsh-singularity-task'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'

/** One candidate side's relation to its baseline, as {@link compareReplaySides} reads it. */
export type SideRelation = 'not-worse' | 'worse' | 'inconclusive'

/** One criterion's verdict on one side, as the record / fresh run reported it. */
export interface ReplayCriterionSummary {
  criterionId: string
  verdict: 'pass' | 'fail' | 'inconclusive'
  command?: string
  exitCode?: number
}

/** The identity of one skill object's sidecar file (K3): the exact bytes and the declaration digest they normalize to. */
export interface SkillContractIdentity {
  /** SHA-256 over the exact `SKILL.contract.json` bytes. */
  sha256: string
  /** `skillContractDigest` of the sidecar — the normalized identity a registry revision and a run binding use. */
  contractDigest: string
}

/** The content identity of one skill object (P2): the skill name, the SHA-256 of `SKILL.md`, and its sidecar identity when it carries one. */
export interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string
  /** Lowercase SHA-256 hex over the exact `SKILL.md` file bytes — no trim, no newline conversion. */
  sha256: string
  /** Present exactly when the object carries an execution sidecar; see {@link SkillContractIdentity}. */
  contract?: SkillContractIdentity
  /** All resource files loaded with this Skill, in relative-path order. */
  resources?: { path: string; sha256: string }[]
}

/** One side of one task's comparison: an outcome and the criterion verdicts the run reported. */
export interface ReplaySideSummary {
  taskId: string
  runId?: string
  outcome: 'verified' | 'failed' | 'cancelled' | 'not-admitted'
  criteria: ReplayCriterionSummary[]
}

/** One criterion whose verdict differs between the sides (absent side = the criterion exists only on the other). */
export interface ReplayCriterionDiff {
  criterionId: string
  champion?: string
  candidate?: string
}

/** verified outranks failed; anything else (cancelled) has no rank and reads inconclusive. */
export const OUTCOME_RANK: Readonly<Record<string, number>> = { verified: 1, failed: 0 }

/** Compare one task's two sides. A regression is mechanical: the candidate's outcome rank and criterion verdicts decide it. */
export function compareReplaySides(
  champion: ReplaySideSummary,
  candidate: ReplaySideSummary,
): { verdictMatch: boolean; criteriaDiff: ReplayCriterionDiff[]; relation: SideRelation } {
  const championCriteria = new Map(champion.criteria.map(item => [item.criterionId, item.verdict]))
  const candidateCriteria = new Map(candidate.criteria.map(item => [item.criterionId, item.verdict]))
  const criteriaDiff: ReplayCriterionDiff[] = []
  for (const criterionId of new Set([...championCriteria.keys(), ...candidateCriteria.keys()])) {
    const before = championCriteria.get(criterionId)
    const after = candidateCriteria.get(criterionId)
    if (before !== after) {
      criteriaDiff.push({
        criterionId,
        ...(before === undefined ? {} : { champion: before }),
        ...(after === undefined ? {} : { candidate: after }),
      })
    }
  }
  const verdictMatch = champion.outcome === candidate.outcome && criteriaDiff.length === 0
  const championRank = OUTCOME_RANK[champion.outcome]
  const candidateRank = OUTCOME_RANK[candidate.outcome]
  if (candidateRank === undefined || championRank === undefined) {
    return { verdictMatch, criteriaDiff, relation: 'inconclusive' }
  }
  const regressedCriterion = criteriaDiff.some(diff => diff.champion === 'pass')
  const changedContract =
    criteriaDiff.some(diff => diff.champion === undefined || diff.candidate === undefined) ||
    champion.criteria.some(
      before => candidate.criteria.find(after => after.criterionId === before.criterionId)?.command !== before.command,
    )
  const relation: SideRelation =
    candidateRank < championRank || regressedCriterion ? 'worse' : changedContract ? 'inconclusive' : 'not-worse'
  return { verdictMatch, criteriaDiff, relation }
}

/** The comparer a report names, and the only one this build can re-check: `experiment-comparer@2`. */
export const EXPERIMENT_COMPARER_VERSION = 'experiment-comparer@2'

/** Why a sample is in the experiment: the role it was chosen for. */
export type ExperimentSampleRole = 'observed-failure' | 'observed-success' | 'observed-regression' | 'holdout'

export const EXPERIMENT_SAMPLE_ROLES: readonly ExperimentSampleRole[] = [
  'observed-failure',
  'observed-success',
  'observed-regression',
  'holdout',
]

/** Which side of one sample's comparison a run is: the frozen baseline, or the candidate. */
export type ExperimentSide = 'baseline' | 'candidate'

export const EXPERIMENT_SIDES: readonly ExperimentSide[] = ['baseline', 'candidate']

/** A side's settled outcome. `cancelled` is the runtime's own settlement of a stopped run; `interrupted` is a side with no terminal run. */
export type ExperimentOutcome = 'verified' | 'failed' | 'cancelled' | 'interrupted' | 'not-admitted'

export const EXPERIMENT_OUTCOMES: readonly ExperimentOutcome[] = [
  'verified',
  'failed',
  'cancelled',
  'interrupted',
  'not-admitted',
]

/** Which admission rule of the runtime refused one side of a capability sample (A6). */
export type ExperimentAdmissionSource = 'capability-gap' | 'provider-refused'

export const EXPERIMENT_ADMISSION_SOURCES: readonly ExperimentAdmissionSource[] = ['capability-gap', 'provider-refused']

/** The runtime's own refusal of one side of a capability sample (A6): the side is not admitted, never an invented failure run. */
export interface ExperimentAdmissionRefusal {
  source: ExperimentAdmissionSource
  /** The proposal this refusal belongs to — the candidate whose gap the side stands for. */
  proposalId: string
  /** The proposal's own source refs: the capability gap / diagnosis the candidate came from. */
  sourceRefs: string[]
  /** The sample's required capability rows this side's configuration had to resolve. */
  required: string[]
  /** The required rows that configuration did not hold; empty for a provider refusal. */
  missing: string[]
  /** The runtime's own refusal text, verbatim. */
  reason: string
}

/** One sample's mechanical verdict under its frozen repair or cost objective. */
export type ExperimentSampleVerdict =
  'fixed' | 'both-failed' | 'not-fixed' | 'improved' | 'not-improved' | 'maintained' | 'regressed' | 'inconclusive'

export const EXPERIMENT_SAMPLE_VERDICTS: readonly ExperimentSampleVerdict[] = [
  'fixed',
  'both-failed',
  'not-fixed',
  'improved',
  'not-improved',
  'maintained',
  'regressed',
  'inconclusive',
]

/** The experiment's categorical verdict, recomputed from every sample. */
export type ExperimentVerdict =
  'fixed' | 'fixed-with-regression' | 'not-fixed' | 'both-failed' | 'improved' | 'not-improved' | 'regressed' | 'inconclusive'

export const EXPERIMENT_VERDICTS: readonly ExperimentVerdict[] = [
  'fixed',
  'fixed-with-regression',
  'not-fixed',
  'both-failed',
  'improved',
  'not-improved',
  'regressed',
  'inconclusive',
]

/** The budget the caller freezes with the experiment (§F.2: samples, inputs, judges and token ceiling). */
export interface ExperimentBudget {
  /** Token ceiling for the whole experiment. */
  maxTokens?: number
  /** Free text: what the budget was derived from and why it is judged enough. */
  note?: string
}

/** A side's reported metrics. The tool-call objective sums toolCalls over every actual Run descendant; other fields retain their ReviewRecord scope. */
export type ExperimentCost = { status: 'reported'; metrics: ReviewMetrics } | { status: 'unknown'; reason: string }

/** Omission retains failure repair. Tool-call reduction compares complete executed Run subtrees. */
export type ExperimentObjective = 'tool-call-reduction' | 'llm-outcome'

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

export interface OutcomeMeasurement {
  ref: string
  sampleTaskId: string
  side: ExperimentSide
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  workspace: string
  workspaceDigest: string
}

export interface OutcomeJudgement {
  samples: {
    taskId: string
    verdict: 'improved' | 'not-improved' | 'regressed' | 'inconclusive'
    findings: { claim: string; evidenceRefs: string[] }[]
    uncertainties: string[]
  }[]
}

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

/** One criterion's verdict on one side, with the verifier that decided it (v1's report dropped the verifier identity; every generation since keeps it). */
export interface ExperimentCriterionDetail {
  criterionId: string
  verdict: 'pass' | 'fail' | 'inconclusive'
  /** The registered verifier that decided the verdict, copied from the run's ReviewRecord. */
  verifierId?: string
  /** The deciding instance's version, when it declared one. */
  verifierVersion?: string
  command?: string
  exitCode?: number
}

/** One side of one sample's comparison: this experiment's own run of that sample's side. */
export interface ExperimentSideDetail {
  /** The replayed task this side created — never the sample's historical task. Absent for a side whose run never reached the store. */
  taskId?: string
  role: ExperimentSampleRole
  side: ExperimentSide
  outcome: ExperimentOutcome
  /** The run this side created. Absent when no run reached the store. */
  runId?: string
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string
  /** Evidence ids the run's review record carries. */
  evidenceRefs: string[]
  /** The workspace this side's run went through, as the runtime resolved it. */
  workspace: string
  /** SHA-256 of the workspace's content right after it was built from the frozen snapshot. */
  initialDigest?: string
  criteria: ExperimentCriterionDetail[]
  cost: ExperimentCost
  /**
   * Why this side reads the way it does: required for `interrupted` (it has no
   * terminal run), and carried for `failed` when the store recorded the run's own
   * cause; absent otherwise.
   */
  reason?: string
  /** The runtime's own admission refusal, for a side that is `not-admitted` (A6). */
  admission?: ExperimentAdmissionRefusal
}

/** One sample's comparison: both sides, and the mechanical verdict over them. */
export interface ExperimentSampleComparison {
  /** The sample's historical task id — the case, not a baseline. */
  taskId: string
  role: ExperimentSampleRole
  baseline: ExperimentSideDetail
  candidate: ExperimentSideDetail
  verdict: ExperimentSampleVerdict
}

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

/** Read one selection as the structured identity, or `undefined` when it names no usable route. */
export function modelSelectionOf(
  selection:
    | {
        provider?: unknown
        model?: unknown
        reasoningEffort?: unknown
        maxTokens?: unknown
      }
    | undefined,
): ModelSelection | undefined {
  const provider =
    typeof selection?.provider === 'string' && selection.provider.length > 0 ? selection.provider : undefined
  const model = typeof selection?.model === 'string' && selection.model.length > 0 ? selection.model : undefined
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort =
    typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
      ? selection.reasoningEffort
      : undefined
  const maxTokens =
    typeof selection?.maxTokens === 'number' && Number.isFinite(selection.maxTokens) && selection.maxTokens > 0
      ? selection.maxTokens
      : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    label: `${provider}/${model}`,
  }
}

/** The `AgentOptions` a frozen selection travels as: the four members, verbatim, with no label. */
export function agentOptionsOf(selection: ModelSelection): {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
} {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    ...(selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens }),
  }
}

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

/** One skill the production configuration's pre-check resolved for a sample's baseline side. */
export interface FrozenProviderSkill {
  name: string
  role: 'execution-provider' | 'knowledge' | 'guidance'
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null
  /** `skillContentDigest` of the bytes the run is expected to load for this skill in the production configuration. */
  contentDigest: string
}

/** The provider identity the *production baseline* side of one sample must bind, frozen before the run. */
export interface FrozenProviderIdentity {
  /** The capability rows in play, sorted (the sample's required capabilities as the table holds them). */
  capabilities: string[]
  /** The registry revision the runtime's own pre-check produces for those rows. */
  registryRevision: string
  /** The registry revision the **candidate** side's run binding must carry: the composed table's revision. */
  candidateRegistryRevision: string
  /** The MCP server names those rows grant, sorted. Every side must bind exactly these, with a resolved template. */
  mcpServers: string[]
  /** Exact definitions each server resolved to before either side starts. */
  mcpBindings?: RunMcpServerBinding[]
  /** The preset those rows declare — one worker, one preset — or `null` when none is declared. */
  preset: string | null
  /** Every skill the rows' providers resolved to at freeze, sorted by name. */
  skills: FrozenProviderSkill[]
}

/** One side's frozen provider identity of a **capability** sample (A6): the composed table and its revision. */
export interface FrozenCapabilitySide {
  /** The capability rows in play, sorted (the sample's required capabilities the side's table resolves). */
  capabilities: string[]
  /** The registry revision the runtime's own pre-check produces over that side's table. */
  registryRevision: string
  /** The MCP server names those rows grant, sorted. */
  mcpServers: string[]
  /** Exact definitions each server resolved to before either side starts. */
  mcpBindings?: RunMcpServerBinding[]
  /** The preset those rows declare — one worker, one preset — or `null` when none declares one. */
  preset: string | null
  /** Every skill the rows' providers resolved to, sorted by name. */
  skills: FrozenProviderSkill[]
}

/** The production configuration's own refusal of one capability sample (A6), frozen before the run. */
export interface FrozenSampleAdmission {
  source: ExperimentAdmissionSource
  /** The sample's required capability rows. */
  required: string[]
  /** The required rows the production table did not hold; empty for a provider refusal. */
  missing: string[]
  /** How the freeze read the refusal (the runtime's own resolution/pre-check answer). */
  reason: string
}

/** The whole row one capability candidate installs (A6), frozen with the digest of its canonical bytes. */
export interface FrozenCapabilityRow {
  name: string
  entry: CapabilityConfig
  digest: string
}

/** The capability candidate one experiment evaluates (A6): the row it installs and the new skill when it carries one. */
export interface FrozenCapability {
  mcpServers?: McpServerIdentity
  row: FrozenCapabilityRow
  /** The row the registry held at prepare, or `null` when it held none. */
  baseline: FrozenCapabilityRow | null
  /** The proposal's own source refs — the capability gap / diagnosis the candidate came from. */
  sourceRefs: string[]
}

/** One sample's frozen identity: the case it locates and the acceptance criteria it was chosen for. */
export interface FrozenSample {
  taskId: string
  role: ExperimentSampleRole
  /** SHA-256 over the sample's contract as the replay mirrors it (objective, criteria, required capabilities). */
  contractDigest: string
  criteria: FrozenCriterion[]
  observed: { outcome: 'verified' | 'failed'; runId?: string }
  /** The provider identity the production-baseline side of a skill sample must bind (S4-E §Q3). */
  provider?: FrozenProviderIdentity
  /** A6: the production configuration's own refusal, when it cannot admit this sample at all. */
  admission?: FrozenSampleAdmission
  /** A6: what the candidate (overlay) side of a capability sample must bind. */
  candidateProvider?: FrozenCapabilitySide
}

/** The identity block fixed before the first run (§F.2). Everything a reader needs to reproduce the comparison. */
export interface FrozenExperiment {
  proposalId: string
  /** Server-bound graph scope; graph-local evidence leaves fresh Task transfer unknown without a holdout. */
  libraryId?: string
  objective?: ExperimentObjective
  evaluation?: OutcomeEvaluationPlan
  /** The repetition index this experiment froze. A higher index is a *different* experiment. */
  repetition: number
  /** The candidate object's content identity the candidate side runs against (the candidate half of the report's identity). */
  candidate?: SkillContentIdentity
  /** The production baseline the candidate object replaces, when prepare captured one (a replacement, not a new skill). */
  productionBaseline?: SkillContentIdentity
  /** The capability candidate this experiment evaluates (A6); absent for a skill experiment. */
  capability?: FrozenCapability
  taskDefinition?: FrozenTaskDefinition
  /** The model selection every run of this experiment is placed under (S4-E §Q3). */
  model: ModelSelection
  budget: ExperimentBudget
  samples: FrozenSample[]
  /** The input snapshot both sides' workspaces are built from, and its recursive content digest. */
  snapshot: ExperimentSnapshot & { digest: string }
  /** The comparer that produced the report's verdicts. */
  comparerVersion: string
  /** What each side runs under, in words: the candidate's overlay and the baseline's plain configuration. */
  overlay: { baseline: string; candidate: string }
}

/** One experiment's report: the frozen identity, every sample's two sides, and the verdict recomputable from them. */
export interface ExperimentReport {
  formatVersion: 3
  proposalId: string
  experimentId: string
  /** When this report's newest ledger record was written — a function of the records, never of the reading. */
  at: string
  frozen: FrozenExperiment
  frozenDigest: string
  evaluation?: OutcomeEvaluation
  samples: ExperimentSampleComparison[]
  verdict: ExperimentVerdict
}

/** JSON with object keys sorted recursively — the one serialization every digest is taken over. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Lowercase SHA-256 hex over {@link canonicalJson} of a value — the frozen-block digest primitive. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/** The digest of a whole frozen identity block; a report and its ledger record agree only when these agree. */
export function frozenDigestOf(frozen: FrozenExperiment): string {
  return digestOf(frozen)
}

/** SHA-256 over a criterion's protected input identities, in path order — the acceptance input identity of one criterion. */
export function protectedInputsDigest(inputs: readonly { path: string; sha256: string }[]): string {
  const lines = inputs.map(input => `${input.path}\0${input.sha256}`).sort()
  return sha256Hex(lines.join('\n'))
}

/** The outcome, acceptance verdicts and optional measured cost the frozen objective compares. */
export interface ExperimentSideComparison {
  outcome: ExperimentOutcome
  criteria: ExperimentCriterionDetail[]
  cost?: ExperimentCost
}

/**
 * Evolution admission track (guide §2.7.6/§2.7.7): an append-only ledger of
 * EvolutionProposals with the state machine proposed → candidate → prepared →
 * gated → decided. A candidate may carry a structured mutation; only then is
 * the prepared state reachable, and evolution_prepare materializes it into the
 * per-proposal sandbox (`<root>/sandbox/<proposalId>/`) plus a champion
 * snapshot of the current production target. A **skill** candidate — the only
 * candidate this build admits — is then evaluated by the two-sided experiment
 * of §F.2 (`evolution_replay`), recorded in the ledger's experiment family and
 * re-read by the promotion gate; the experiment is evidence, not a lifecycle
 * transition, so a skill proposal gates from prepared and never takes a
 * `replayed` record.
 *
 * `evolution_propose` and a Diagnosis may still record any targetType as a
 * suggestion, but a suggestion never becomes a candidate: `candidate` refuses
 * every non-skill targetType by name, and a capability, agent_preset,
 * task_definition or bookkeeping-only proposal therefore stays `proposed`
 * forever (§F.2; A6 introduces the capability evaluation beside this one).
 *
 * Only a **skill** PROMOTE is promotable in this build: `checkPromotion` refuses
 * every other target type by name, because this build's evaluator — the
 * two-sided experiment — evaluates a replacement of an existing single-file
 * `SKILL.md` and nothing else (§F.2: "没有支持的评估器就拒绝新晋升"; a historical
 * report is never upgraded into new evidence). A ledger written before this
 * narrowing still folds, v1 `replayed` lines included ({@link ReplayedView});
 * nothing current writes one, and an already-applied skill still rolls back.
 *
 * PROMOTE takes effect through `evolution_apply` (W16): the candidate's
 * `SKILL.md` is copied from the sandbox into production — decided → applied →
 * (optionally) rolledback — each transition only after its own human approval
 * granted through the native approval seam (done by the tools, not here). L4
 * proposals and every non-skill target type never apply: the ledger records
 * them and a human edits production by hand.
 *
 * Single-file skill candidates additionally carry a content identity (P2):
 * prepare records the SHA-256 of the exact bytes of the materialized
 * `skills/<name>/SKILL.md`, the experiment's frozen block must carry the same
 * identity, and the experiment's pre-run check, every promotion gate, and the
 * apply write re-read and re-verify that file — so the chain cannot validate
 * one file's content and apply another's. Identity is not functional correctness,
 * and it binds skill candidates only.
 *
 * A skill promotion additionally pins the production baseline (P3): prepare
 * records the SHA-256 of the production `skills/<name>/SKILL.md` from the same
 * single read that produced the champion snapshot, and the apply seams
 * (the tool's pre-approval precheck and the service entry immediately before
 * the production write) re-read that file and refuse unless it still matches.
 * A candidate prepared against a production skill that has since changed,
 * disappeared, changed type, or moved behind a symbolic link is a conflict:
 * nothing is written, no `applied` record is taken, and the caller is pointed
 * at a new candidate evaluated against the new production state. The guarantee
 * covers serial single-process calls and external changes between two calls —
 * it is not a cross-process lock and does not make apply atomic against a
 * writer that writes concurrently with it.
 *
 * Every promotion also passes the unified provider pre-check (S1-C item 3):
 * `checkPromotion` — the one precheck `evolution_decide`, `evolution_apply`
 * before it asks a human, and the service's own `decide` / `apply` call — reads
 * a skill candidate's sandbox directory through `validateSkillProvider`, the
 * validator admission and the config load. So `evolution_apply` is not the only
 * entry that knows what a usable provider is: an execution sidecar whose verifier
 * is unregistered or whose required tools the deployment cannot grant is refused
 * here, before an approval is burned and before anything is written, and a
 * knowledge or guidance provider is recorded as exactly that. The roles are
 * reported to the reviewer (`renderProviderRoles`) and carried on
 * {@link ApplyOutcome.providers}; nothing about them is persisted, and the
 * execution closure itself stays a property of the capability table.
 *
 * The evidence gate beside it (`assertSkillPromotionEvidence`, §F.2) re-reads
 * the proposal's newest experiment: a completed two-sided experiment whose
 * report the ledger's own records recompute to, whose sides are runs of that
 * experiment's lineage in the task store, whose frozen contracts, protected
 * inputs, judge versions and model selection still hold, whose verdict is `fixed`
 * and whose cost is known whenever the frozen budget declares a ceiling. All of
 * it is reads, and every condition is a named refusal.
 *
 * What a skill promotion promotes is one file: `writeProduction` writes the
 * candidate's `SKILL.md`, so a candidate whose sandbox directory carries
 * anything else — a `SKILL.contract.json`, a `references/` or `scripts/` tree,
 * any other entry — is refused by name at the same precheck. That is a stated
 * boundary of this executor, not a defect hidden behind it: the alternative
 * would be a promotion that reports an execution-provider role, or a content
 * identity covering files, for content production never receives. Multi-file
 * skill candidates need an executor that writes them; until then they are
 * refused before a human is asked.
 * @module dsh-singularity-evolution
 */

import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'
import {
  capabilityToolQuery,
  loadSkillSidecar,
  optionalService,
  readVerifiedFile,
  registeredVerifierIds,
  registeredVerifierVocabulary,
  unlistableVerifierRefusal,
  validateSkillProvider,
  walkVerified,
} from '@dangosys/dsh-singularity-task-runtime'
import type {
  CapabilityToolQuery,
  SkillProviderCandidate,
  SkillProviderVerdict,
} from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { ReplayRelation, ReplayVerdict, SkillContentIdentity } from './replay.ts'
import { canonicalJson, modelSelectionOf, REPLAY_RELATIONS, REPLAY_VERDICTS } from './replay.ts'
import type { ModelSelection } from './replay.ts'
import type {
  ExperimentKey,
  ExperimentResult,
  ExperimentSampleRecord,
  ExperimentSources,
  ExperimentSpec,
  ExperimentStartedRecord,
  ExperimentView,
} from './experiment.ts'
import {
  assertExperimentStartRecord,
  buildExperimentReport,
  foldExperiments,
  isExperimentRecord,
  resumeExperiment,
  runExperiment,
} from './experiment.ts'
import { assertSkillPromotionEvidence, noEvaluatorRefusal } from './promotion.ts'
import type { SkillPromotionSources } from './promotion.ts'

export type EvolutionLevel = 'L1' | 'L2' | 'L3' | 'L4'
export type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'replayed' | 'gated' | 'decided' | 'applied' | 'rolledback'
/** The three frozen decision values of the Validation Gate (细化想法4.md §32). */
export type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH'

export const EVOLUTION_LEVELS: readonly EvolutionLevel[] = ['L1', 'L2', 'L3', 'L4']
export const EVOLUTION_DECISIONS: readonly EvolutionDecision[] = ['PROMOTE', 'REJECT', 'KEEP_FOR_FURTHER_RESEARCH']

/**
 * The ledger's vocabulary of mechanical target types: the four whose mutations
 * older records materialized into a sandbox (`mechanical: true`). Mutations on
 * the other five target types (tool / decomposition_policy / workflow_policy /
 * verifier / runtime_policy) are free-form structured descriptions, recorded
 * with `mechanical: false` — bookkeeping only, never materialized.
 *
 * The fold validates an old record against this vocabulary, so the four stay
 * named here; `candidate` admits a **skill** candidate only, which is the one
 * type this build materializes, evaluates and promotes (§F.2).
 */
export const MECHANICAL_TARGET_TYPES: readonly ProposalTargetType[] = ['skill', 'agent_preset', 'capability', 'task_definition']

/** True for the target types whose mutations materialize mechanically into the sandbox. */
export function mutationMechanical(targetType: ProposalTargetType): boolean {
  return MECHANICAL_TARGET_TYPES.includes(targetType)
}

/**
 * The one target type `evolution_apply` promotes mechanically (W16): the
 * sandbox copy lands on the production skill root. Every other type has no
 * executor in this build — a capability row, an agent_preset directory and a
 * task_definition were written by an older build and are not written here.
 */
export const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[] = ['skill']

/**
 * The target types whose `applied` record the state machine still admits, so a
 * ledger written by an older build — which applied a preset directory or a
 * `config.yml` row — folds and stays readable. It is the recorded vocabulary,
 * not a capability of this build: {@link APPLYABLE_TARGET_TYPES} names the one
 * type an executor here has, and every other type is refused by name at
 * {@link EvolutionService.apply} and at the tools.
 */
const LEDGER_APPLIED_TARGET_TYPES: readonly ProposalTargetType[] = ['skill', 'agent_preset', 'capability']

/**
 * Whether a decided proposal's `applied` record is admissible: the decision is
 * PROMOTE, the level is not L4 (L4 harness evolution is human-run by rule,
 * §2.7.7 / §2.9.2), the target type is one the ledger admits, and a sandbox was
 * actually materialized (a mutation-less manual candidate has nothing to copy).
 */
function applyable(proposal: EvolutionProposal): boolean {
  return (
    proposal.decision === 'PROMOTE' &&
    proposal.level !== 'L4' &&
    LEDGER_APPLIED_TARGET_TYPES.includes(proposal.targetType) &&
    proposal.prepared?.sandbox != null
  )
}

/** skill mutation: the full SKILL.md text for `<skills root>/<name>/SKILL.md`. */
export interface SkillMutation {
  name: string
  content: string
}

/** Where the champion snapshot of one prepared proposal stands. */
export type ChampionState =
  /** Written under the sandbox's `champion/` dir. */
  | 'captured'
  /** The production target does not exist yet (new skill / capability / …) — champion: null. */
  | 'missing'
  /** Non-mechanical mutation: nothing materialized, no anchor. */
  | 'none'

export const CHAMPION_STATES: readonly ChampionState[] = ['captured', 'missing', 'none']

/**
 * Where a capability champion snapshot came from (W19, guide §4.2 #18). The
 * rows are the recorded vocabulary of ledgers written before this build
 * narrowed the lifecycle to skill:
 * - `config-text` — the row existed in config.yml; the snapshot also holds its
 *   verbatim source lines (`champion/capability-table.source.txt`) and rollback
 *   wrote those lines back byte-for-byte.
 * - `code-default` — the capability exists only in the code default table (no
 *   config.yml row); the snapshot holds the registry entry as the comparison
 *   anchor, and rollback removed the config.yml row so the default governs
 *   again (plus a runtime override back to the default entry).
 * - `missing` — the capability did not exist at all; rollback deleted what the
 *   apply added (`champion: 'missing'` carries the same fact; this field keeps
 *   the three-way distinction readable on one field).
 * Recorded on the `prepared` ledger record of capability proposals only, and
 * validated by the fold; no current entry writes one.
 */
export type ChampionSource = 'config-text' | 'code-default' | 'missing'

export const CHAMPION_SOURCES: readonly ChampionSource[] = ['config-text', 'code-default', 'missing']

/** Folded view of one `prepared` record. */
export interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null
  mechanical: boolean
  champion: ChampionState
  /** Recorded capability prepares only (W19); validated by the fold, never written now. */
  championSource?: ChampionSource
  /** Skill prepares only (P2): the content identity recorded for the materialized candidate `SKILL.md`. */
  skillContent?: SkillContentIdentity
  /**
   * Skill prepares only (P3): the content identity of the production
   * `skills/<name>/SKILL.md` as it stood at prepare — from the same single read
   * that produced the champion snapshot, so snapshot and digest can never
   * disagree. Absent on records written before the baseline was recorded, on
   * `champion: 'missing'` prepares (nothing was there to digest), and on every
   * non-skill targetType; a captured champion without it cannot prove its
   * baseline and refuses a new apply.
   */
  skillBaseline?: SkillContentIdentity
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[]
}

/**
 * The minimal Validation Gate (细化想法4.md §32, verbatim questions):
 *   1. Target failure fixed?
 *   2. Original acceptance maintained?
 *   3. Existing regression maintained?
 *   4. No unacceptable side effects?
 *   5. Holdout performance acceptable?
 *   6. Resource cost acceptable?
 * All six answers are required free text. Question 3 additionally requires
 * evidence refs (test/replay evidence ids or paths) whose existence is checked
 * — the track validates that the evidence is there, it never executes it.
 */
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

/** One immutable ledger line. A state migration appends a new record; nothing is ever rewritten in place. */
export type EvolutionRecord =
  | {
      formatVersion: 1
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
      formatVersion: 1
      kind: 'candidate'
      proposalId: string
      /** Complete version set the candidate aligns to (branch-model bookkeeping; v1 builds no real branch). */
      versionSet: Record<string, string>
      /**
       * Optional structured patch description, shaped by the proposal's
       * targetType (see the *Mutation interfaces). A candidate carrying one
       * must be prepared (sandbox materialization) before it can gate; a
       * mutation-less (manual) candidate gates directly.
       */
      mutation?: unknown
      actor: string
      at: string
    }
  | {
      formatVersion: 1
      kind: 'prepared'
      proposalId: string
      /** Sandbox dir relative to the ledger root, or null for a bookkeeping-only (non-mechanical) mutation. */
      sandbox: string | null
      mechanical: boolean
      champion: ChampionState
      /** Capability prepares only (W19): where the champion snapshot came from; absent on pre-W19 records. */
      championSource?: ChampionSource
      /**
       * Skill prepares only (P2): the content identity of the materialized
       * candidate `SKILL.md` — the skill name plus the SHA-256 of the exact
       * file bytes. Absent on records written before content binding and on
       * every non-skill targetType; those old skill candidates cannot be newly
       * promoted without a fresh candidate and evaluation.
       */
      skillContent?: SkillContentIdentity
      /**
       * Skill prepares only (P3): the content identity of the production
       * `SKILL.md` as it stood at prepare. Absent on records written before the
       * baseline was recorded and on every non-skill targetType; those old
       * skill candidates cannot be newly applied without a fresh candidate and
       * evaluation.
       */
      skillBaseline?: SkillContentIdentity
      /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
      files: string[]
      actor: string
      at: string
    }
  /**
   * The v1 candidate-vs-champion replay, recorded by a build that had that
   * evaluation. Nothing writes this line now — a skill candidate is evaluated
   * by the experiment family below — and the fold keeps reading it so a ledger
   * written before this narrowing still loads.
   */
  | {
      formatVersion: 1
      kind: 'replayed'
      proposalId: string
      /** SHA-256 of the report bytes. Historical records may lack it. */
      reportDigest?: string
      /** Report path relative to the ledger root (`sandbox/<proposalId>/replay-report.json`). */
      report: string
      /** Overall verdict: whether the candidate was not worse than the champion. */
      verdict: ReplayVerdict
      /** Per-task relation summary, observed then holdout. */
      tasks: { taskId: string; relation: ReplayRelation; holdout: boolean }[]
      actor: string
      at: string
    }
  | { formatVersion: 1; kind: 'gated'; proposalId: string; gate: GateAnswers; actor: string; at: string }
  | {
      formatVersion: 1
      kind: 'decided'
      proposalId: string
      decision: EvolutionDecision
      note?: string
      /**
       * Human-review evidence: the approval call id of the evolution_decide
       * request that granted this decision, the same `approval:<callId>` shape
       * as applied/rolledback. Optional in the record type only so ledger
       * lines written before this field existed still fold; every new decided
       * record carries it.
       */
      approvalRef?: string
      actor: string
      at: string
    }
  | {
      formatVersion: 1
      kind: 'applied'
      proposalId: string
      /** Production write targets, for audit (absolute paths; the capability entry describes its config.yml row). */
      targets: string[]
      /** Human-review evidence: the approval call id of the evolution_apply request that granted this write. */
      approvalRef: string
      actor: string
      at: string
    }
  | {
      formatVersion: 1
      kind: 'rolledback'
      proposalId: string
      /** Production write targets of the rollback (restored champion or deleted product), for audit. */
      targets: string[]
      /** Human-review evidence: the approval call id of the evolution_rollback request that granted this write. */
      approvalRef: string
      actor: string
      at: string
    }
  /**
   * The experiment family (S4-E §F.2): the two-sided skill evaluation's frozen
   * identity and its per-sample runs. These lines are not lifecycle transitions
   * — an experiment does not move a proposal's status — so the proposal fold
   * leaves them alone and {@link foldExperiments} folds them; a build that
   * predates them cannot fold a ledger that holds one, which is the one
   * compatibility limit of adding them (said in the delivery record, not
   * papered over). `formatVersion` stays 1: the envelope did not change.
   */
  | ExperimentStartedRecord
  | ExperimentSampleRecord

/** Folded view of one `applied` or `rolledback` record. */
export interface ApplyView {
  targets: string[]
  approvalRef: string
}

/** What an apply/rollback changed, returned to the tool layer. */
export interface ApplyOutcome {
  proposal: EvolutionProposal
  targets: string[]
  /**
   * What the promotion check validated about the providers this apply put in
   * place ({@link PromotionCheck.providers}): the candidate skill of a skill
   * apply, with the role it may be counted as, so a knowledge or guidance
   * provider is reported as such rather than presented as the execution
   * provider it is not. Empty when the target carries no provider. Not
   * persisted: the ledger's `applied` record keeps its shape, and a run's own
   * binding is where a selected role is recorded for real.
   */
  providers?: readonly PromotionProvider[]
}

/**
 * One provider a promotion check judged, with the role it may be counted as.
 * The role vocabulary is the validator's, not a second opinion: this value is
 * read off a {@link SkillProviderVerdict} the unified pre-check produced.
 */
export interface PromotionProvider {
  /** The skill name a capability grants (or the candidate skill's own name). */
  readonly name: string
  /**
   * `execution-provider` is the only role that may close an execution gap
   * (`executionProviders`); `knowledge` and `guidance` are loadable content a
   * promotion may put in place, and neither ever counts as an execution
   * provider — they are recorded, not upgraded.
   */
  readonly role: 'execution-provider' | 'knowledge' | 'guidance'
  /** {@link skillContentDigest} of the bytes the verdict was taken from. */
  readonly contentDigest: string
  /** Execution providers only: the declared verifier ref, proven registered against the live vocabulary. */
  readonly verifierRef?: string
}

/**
 * What a promotion check validated (S1-C item 3). Returned by
 * {@link EvolutionService.checkPromotion} so the entries that gate on it (the
 * two tools and the service's own `decide` / `apply`) can report the roles
 * instead of re-deriving them.
 */
export interface PromotionCheck {
  /** One entry per provider this promotion puts in place; empty for a target type that carries none (`agent_preset`, `task_definition`, bookkeeping-only). */
  readonly providers: readonly PromotionProvider[]
}

/** The task runtime as a promotion check reads it: the effective capability registry, resolved softly. */
interface CapabilityRegistrySource {
  listCapabilities?(): Readonly<Record<string, CapabilityConfig>>
}

/** One accepted verdict as a promotion report entry: the role, the content it was taken from, and the verifier ref only an execution provider has. */
function promotionProviderOf(verdict: Extract<SkillProviderVerdict, { valid: true }>): PromotionProvider {
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

/** Folded view of one `replayed` record — read from a ledger written before this build's narrowing. */
export interface ReplayedView {
  /** SHA-256 recorded at replay, when the record carried one. */
  reportDigest?: string
  /** Report path relative to the ledger root (`sandbox/<proposalId>/replay-report.json`). */
  report: string
  verdict: ReplayVerdict
  /** Per-task relation summary, observed then holdout. */
  tasks: { taskId: string; relation: ReplayRelation; holdout: boolean }[]
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
  /** The v1 candidate-vs-champion replay a ledger written before this build's narrowing holds; nothing writes one now. */
  replayed?: ReplayedView
  gate?: GateAnswers
  decision?: EvolutionDecision
  decisionNote?: string
  /** Approval evidence of the decided record, when it carries one (every new record does). */
  decisionApprovalRef?: string
  applied?: ApplyView
  rolledback?: ApplyView
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolution: EvolutionService
  }
}

/** Plugin config; every field optional — the constructor resolves defaults. */
export interface Config {
  /**
   * Directory of the ledger file `proposals.jsonl`; sandboxes materialize under
   * `<root>/sandbox/<proposalId>/`. Omitted resolves to `$DSH_HOME/evolution`,
   * falling back to `<repoRoot>/.dsh/evolution` when `DSH_HOME` is unset (same
   * derivation as the verifier's evidenceRoot).
   */
  root?: string
  /** Production skill root — champion snapshots read from here; apply/rollback write here. Defaults to `$DSH_HOME/skills`. */
  skillRoot?: string
  /**
   * Production agent-preset root. Resolved for the ledger's own root vocabulary
   * (an old record's targets name it) and pinned by the root regression; no
   * current entry writes here. Defaults to `$DSH_HOME/.agent-presets`.
   */
  presetRoot?: string
  /**
   * The production `config.yml`, resolved for the ledger's own root vocabulary
   * (an old capability record's targets name it) and pinned by the root
   * regression; no current entry edits it. Defaults to `<repoRoot>/config.yml`.
   */
  configFile?: string
  /**
   * The harness repo root: the parent of the `$DSH_HOME` fallback
   * (`<repoRoot>/.dsh`), the base of the default `config.yml`, and the base
   * relative evidence refs resolve against.
   *
   * It is a configuration member rather than something this package derives:
   * the ledger used to sit at the depth of the harness source tree, and this
   * package does not — a derivation here would silently move every default. The
   * assembly computes it at its own location (`new URL('../../../../',
   * import.meta.url)`) and passes it in. A direct construction that omits it
   * (a test, an embedding process) reads relative refs against the process's
   * working directory instead.
   */
  repoRoot?: string
  /**
   * Resolves the model selection this plane freezes with an experiment and
   * re-reads before a promotion — the deployment's own default selection, as a
   * structured `{ provider, model, reasoningEffort?, maxTokens? }` (S4-E §Q3).
   *
   * It is injected, not derived here: the deployment knows which selection its
   * sessions and the replay spawns run under, and the process this package runs
   * in has no agent of its own to ask. The assembly
   * (`@dangosys/dsh-singularity-agent`) wires it to the same source the
   * experiment tool freezes from — one resolver, so the selection a report is
   * frozen under is exactly the one the gate compares against, and the one every
   * replayed spawn is placed under.
   *
   * A selection must be structured to be usable: absent, answering nothing, or
   * answering something without a provider and a model is a refusal at both
   * entries (fail-closed). Neither silently skips the check, and the frozen
   * selection is never parsed back out of a display string.
   */
  modelSelection?: () => ModelSelection | undefined
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`evolution: ${field} must be a non-empty string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`evolution: ${field} has unknown key "${key}"`)
  }
}

/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function assertSegment(value: unknown, field: string): string {
  const text = nonEmpty(value, field)
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\') || isAbsolute(text)) {
    throw new Error(`evolution: ${field} must be a single safe path segment, got "${text}"`)
  }
  return text
}

/** A clean relative path: never absolute (posix or drive-letter), no `\`, no empty / `.` / `..` segments. */
function assertSandboxPath(value: unknown, field: string): string {
  const text = nonEmpty(value, field)
  if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || text.includes('\\') || text.includes('\0')) {
    throw new Error(`evolution: ${field} must be a relative path inside the sandbox, got "${text}"`)
  }
  if (text.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`evolution: ${field} must be a clean relative path (no empty / "." / ".." segments), got "${text}"`)
  }
  return text
}

/** Resolve `rel` under `base`, refusing anything that would land outside — the sandbox confinement belt. */
function resolveWithin(base: string, rel: string): string {
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) {
    throw new Error(`evolution: sandbox path "${rel}" escapes ${base}`)
  }
  return abs
}

/** Lowercase SHA-256 hex over exact bytes — the content identity primitive (P2). */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The production skill target as it stands right now (P3): null when nothing
 * is there, otherwise the exact bytes plus their SHA-256. Read through the same
 * component walk as the ledger root (`walkVerified`, shared with the skill
 * sidecar loader in task-runtime), so a production path that became a
 * directory, or that is a symbolic link (the file itself or an ancestor), is a
 * conflict the caller refuses — never a silent follow.
 */
async function readProductionSkill(skillRoot: string, name: string): Promise<{ bytes: Buffer; sha256: string } | null> {
  const walked = await walkVerified(skillRoot, join(name, 'SKILL.md'))
  if (walked.missing) return null
  const bytes = await readFile(walked.abs)
  return { bytes, sha256: sha256Hex(bytes) }
}

/**
 * Validate a candidate's mutation against the proposal's targetType. The four
 * mechanical types have fixed schemas and every path field is checked to stay
 * inside the sandbox; the five other types take any structured object and are
 * bookkeeping-only (mechanical: false).
 */
function validateMutation(
  targetType: ProposalTargetType,
  mutation: unknown,
  baseVersion: string,
): asserts mutation is Record<string, unknown> {
  if (!isRecord(mutation)) throw new Error('evolution: mutation must be an object')
  switch (targetType) {
    case 'skill': {
      assertOnlyKeys(mutation, ['name', 'content'], 'skill mutation')
      assertSegment(mutation.name, 'mutation.name')
      nonEmpty(mutation.content, 'mutation.content')
      return
    }
    case 'agent_preset': {
      assertOnlyKeys(mutation, ['presetId', 'files'], 'agent_preset mutation')
      assertSegment(mutation.presetId, 'mutation.presetId')
      if (!Array.isArray(mutation.files) || mutation.files.length === 0) {
        throw new Error('evolution: mutation.files must be a non-empty array of { path, content }')
      }
      mutation.files.forEach((file: unknown, index: number) => {
        if (!isRecord(file)) throw new Error(`evolution: mutation.files[${index}] must be an object`)
        assertOnlyKeys(file, ['path', 'content'], `mutation.files[${index}]`)
        assertSandboxPath(file.path, `mutation.files[${index}].path`)
        nonEmpty(file.content, `mutation.files[${index}].content`)
      })
      return
    }
    case 'capability': {
      assertOnlyKeys(mutation, ['name', 'entry'], 'capability mutation')
      nonEmpty(mutation.name, 'mutation.name')
      if (!isRecord(mutation.entry)) throw new Error('evolution: mutation.entry must be an object')
      assertOnlyKeys(mutation.entry, ['skills', 'tools', 'preset', 'permission', 'mcpServers'], 'mutation.entry')
      if (Object.keys(mutation.entry).length === 0) {
        throw new Error('evolution: mutation.entry must grant at least one of skills / tools / preset / permission / mcpServers')
      }
      for (const list of ['skills', 'tools', 'mcpServers'] as const) {
        const value = mutation.entry[list]
        if (value === undefined) continue
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
          throw new Error(`evolution: mutation.entry.${list} must be an array of non-empty strings`)
        }
      }
      for (const scalar of ['preset', 'permission'] as const) {
        if (mutation.entry[scalar] !== undefined) nonEmpty(mutation.entry[scalar], `mutation.entry.${scalar}`)
      }
      return
    }
    case 'task_definition': {
      assertOnlyKeys(mutation, ['baseVersion', 'definition'], 'task_definition mutation')
      const base = nonEmpty(mutation.baseVersion, 'mutation.baseVersion')
      if (base !== baseVersion) {
        throw new Error(`evolution: mutation.baseVersion "${base}" must equal the proposal's baseVersion "${baseVersion}"`)
      }
      if (!isRecord(mutation.definition) || Object.keys(mutation.definition).length === 0) {
        throw new Error("evolution: mutation.definition must be a non-empty object (the new version's definition fields)")
      }
      return
    }
    default:
      // tool / decomposition_policy / workflow_policy / verifier / runtime_policy:
      // any structured object, bookkeeping only (mechanical: false).
      return
  }
}

/**
 * Candidate versionSet payload validation, shared by the write path
 * (`candidate`) and the fold: a hand-forged ledger line must fail the same
 * checks a live append does.
 */
function validateVersionSet(versionSet: unknown): void {
  if (!isRecord(versionSet)) throw new Error('evolution: versionSet must be an object')
  const entries = Object.entries(versionSet)
  if (entries.length === 0) throw new Error('evolution: versionSet must record at least one version')
  for (const [key, value] of entries) {
    nonEmpty(key, 'versionSet key')
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`evolution: versionSet["${key}"] must be a non-empty string`)
    }
  }
}

/**
 * Gate-answers payload validation, shared by the write path (`gate`) and the
 * fold: all six answers non-empty, at least one regression evidence ref, every
 * ref a non-empty string. Evidence existence (disk path / caller-resolved id /
 * the replay report still sitting in the sandbox) stays write-path-only — the
 * fold never touches disk, so a ledger stays replayable after evidence files
 * rotate away.
 */
function validateGateAnswers(answers: unknown): void {
  if (!isRecord(answers)) throw new Error('evolution: gate answers must be an object')
  nonEmpty(answers.targetFailureFixed, 'gate answer "1. Target failure fixed?"')
  nonEmpty(answers.originalAcceptanceMaintained, 'gate answer "2. Original acceptance maintained?"')
  nonEmpty(answers.existingRegressionMaintained, 'gate answer "3. Existing regression maintained?"')
  nonEmpty(answers.noUnacceptableSideEffects, 'gate answer "4. No unacceptable side effects?"')
  nonEmpty(answers.holdoutPerformanceAcceptable, 'gate answer "5. Holdout performance acceptable?"')
  nonEmpty(answers.resourceCostAcceptable, 'gate answer "6. Resource cost acceptable?"')
  if (!Array.isArray(answers.regressionEvidenceRefs) || answers.regressionEvidenceRefs.length === 0) {
    throw new Error('evolution: the regression/replay answer must cite at least one evidence ref')
  }
  for (const ref of answers.regressionEvidenceRefs) nonEmpty(ref, 'regression evidence ref')
}

/**
 * The state machine, data-dependent at candidate: a candidate carrying a
 * mutation must be prepared (sandbox materialization) before anything else; a
 * mutation-less (manual) candidate gates directly — the pre-mutation shape old
 * ledgers replay against.
 *
 * A prepared **skill** candidate gates straight from prepared: its evaluation is
 * the two-sided experiment (§F.2), which is recorded in the ledger's experiment
 * family and is deliberately *not* a lifecycle transition — the proposal stays
 * `prepared` while its samples run — so {@link EvolutionService.gate} requires
 * the completed experiment instead of a `replayed` record.
 *
 * `replayed` and the `prepared → replayed → gated` arc of the four mechanical
 * types stay admissible for one reason only: a ledger written before this
 * build's narrowing holds those lines, and the fold has to replay the state
 * machine over them exactly as it was recorded. No current entry writes one —
 * `candidate` admits a skill candidate, this build's one candidate type, and
 * nothing evaluates a non-skill one. After the human decision, only a PROMOTE
 * on an applyable, materialized, sub-L4 mutation can be applied (W16), and only
 * an applied proposal can be rolled back.
 */
function nextStates(proposal: EvolutionProposal): readonly EvolutionStatus[] {
  switch (proposal.status) {
    case 'proposed':
      return ['candidate']
    case 'candidate':
      return proposal.mutation === undefined ? ['gated'] : ['prepared']
    case 'prepared':
      // A skill candidate gates straight from prepared (its evaluation is the
      // experiment); `replayed` stays reachable for it so a ledger written by the
      // pre-S4-E build — where a skill candidate did take a v1 report — folds.
      if (proposal.targetType === 'skill') return ['gated', 'replayed']
      return mutationMechanical(proposal.targetType) ? ['replayed'] : ['gated']
    case 'replayed':
      return ['gated']
    case 'gated':
      return ['decided']
    case 'decided':
      return applyable(proposal) ? ['applied'] : []
    case 'applied':
      return ['rolledback']
    case 'rolledback':
      return []
  }
}

/** The one transition check shared by live appends and replay, so an illegal migration reads identically in both. */
function assertTransition(current: EvolutionProposal, kind: EvolutionStatus): void {
  if (nextStates(current).includes(kind)) return
  const hint = current.status === 'candidate' && current.mutation !== undefined && kind === 'gated'
    ? ' — this candidate carries a mutation; record "prepared" first (evolution_prepare)'
    : current.status === 'decided' && kind === 'applied'
      ? current.decision !== 'PROMOTE'
        ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied`
        : ' — only a materialized skill mutation at L1–L3 applies; anything else stays a manual human edit'
      : ''
  throw new Error(`evolution: proposal "${current.proposalId}" is ${current.status}; cannot record "${kind}"${hint}`)
}

/**
 * The production write targets of an apply (and its matching rollback), for
 * the approval reason and the audit record — the human sees exactly what a
 * grant will touch. One file: the candidate's `SKILL.md`, which is what this
 * build's executor writes and restores.
 */
export function applyTargets(
  proposal: EvolutionProposal,
  roots: { skillRoot: string },
): string[] {
  if (proposal.targetType !== 'skill') return []
  return [join(roots.skillRoot, (proposal.mutation as SkillMutation).name, 'SKILL.md')]
}

/**
 * The entries of a candidate's own directory beyond the one file the skill
 * executor writes — `SKILL.md`'s siblings, a directory read as `name/`, sorted.
 * Empty for a single-file candidate, and also for a directory that cannot be
 * listed: a candidate with nothing there is then refused by the validator with
 * the defect its absence deserves (`skill-missing`), not by this boundary.
 */
async function unsupportedCandidateEntries(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.name !== 'SKILL.md')
    .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
}

/**
 * The Evolution plane ledger (plane separation: this store is independent of
 * the task store and refers to it by id only). Folding and appending share one
 * fold, so a corrupt or out-of-order log fails loudly instead of silently
 * drifting. Writes are serialized; the file is opened per append, so closing
 * the service is just draining the write queue. Sandbox materialization is the
 * only other write, confined to `<root>/sandbox/<proposalId>/`.
 */
export class EvolutionService extends Service {
  /** Absolute ledger directory resolved at construction. */
  readonly root: string
  /** Production skill root — champion snapshots read from here; apply/rollback write here. */
  readonly skillRoot: string
  /**
   * Production agent-preset root, resolved for the ledger's own root vocabulary
   * (an old record's targets name it). No current entry writes here: the only
   * executor this build has writes a single `SKILL.md`.
   */
  readonly presetRoot: string
  /**
   * Production config.yml, resolved for the ledger's own root vocabulary (an
   * old capability record's targets name it). No current entry edits it.
   */
  readonly configFile: string
  /** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
  readonly repoRoot: string
  /** The injected model-selection resolver, if the assembly wired one (see {@link Config.modelSelection}). */
  private readonly resolveModelSelection?: () => ModelSelection | undefined
  private records: EvolutionRecord[] = []
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolution')
    // Explicitly configured, never derived here: see Config.repoRoot.
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.resolveModelSelection = config.modelSelection
    const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, '.dsh')
    this.root = resolve(config.root ?? join(dshHome, 'evolution'))
    this.skillRoot = resolve(config.skillRoot ?? join(dshHome, 'skills'))
    this.presetRoot = resolve(config.presetRoot ?? join(dshHome, '.agent-presets'))
    this.configFile = resolve(config.configFile ?? join(this.repoRoot, 'config.yml'))
    this.loaded = this.load()
    ctx.effect(
      () => async () => {
        await this.writes
      },
      'evolution: drain writes',
    )
  }

  /** Ledger file path (`<root>/proposals.jsonl`). */
  get file(): string {
    return join(this.root, 'proposals.jsonl')
  }

  /**
   * The model selection this deployment's runs share — the one the experiment
   * freezes before anything runs, passes to each replayed spawn verbatim, and
   * the promotion gate re-reads from the runs' own session logs
   * ({@link Config.modelSelection}).
   *
   * Fail-closed: no resolver, a resolver that throws, or one that answers
   * anything but a structured selection with a provider and a model is a named
   * refusal. The experiment tool freezes this value, so a deployment that cannot
   * name its selection can neither evaluate nor promote a candidate — and
   * neither case silently skips the check.
   */
  modelSelection(): ModelSelection {
    let resolved: ModelSelection | undefined
    try {
      resolved = modelSelectionOf(this.resolveModelSelection?.())
    } catch (error) {
      throw new Error(
        `evolution: the model selection cannot be resolved (${error instanceof Error ? error.message : String(error)}) — ` +
        'the experiment freezes the selection its runs share and a promotion re-reads it, so a deployment that cannot name one ' +
        'neither evaluates nor promotes a candidate',
      )
    }
    if (resolved === undefined) {
      throw new Error(
        'evolution: this deployment cannot name the model selection its runs share — no model-selection resolver was injected (or it ' +
        'answered without a structured { provider, model } route); the two-sided experiment freezes the selection before anything ' +
        'runs and the promotion gate re-reads it from the runs\' own session logs, so a deployment that cannot name it can neither ' +
        'evaluate nor promote a candidate',
      )
    }
    return resolved
  }

  async propose(input: ProposeInput, actor: string): Promise<EvolutionProposal> {
    const record: EvolutionRecord = {
      formatVersion: 1,
      kind: 'proposed',
      proposalId: nonEmpty(input.proposalId, 'proposalId'),
      targetType: input.targetType,
      targetId: nonEmpty(input.targetId, 'targetId'),
      baseVersion: nonEmpty(input.baseVersion, 'baseVersion'),
      level: input.level,
      rationale: nonEmpty(input.rationale, 'rationale'),
      sourceRefs: input.sourceRefs,
      actor,
      at: new Date().toISOString(),
    }
    if (!EVOLUTION_LEVELS.includes(record.level)) throw new Error(`evolution: unknown level "${String(input.level)}"`)
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
      throw new Error('evolution: sourceRefs must name at least one source (diagnosisId / reviewRef / evidenceId)')
    }
    input.sourceRefs.forEach((ref, index) => nonEmpty(ref, `sourceRefs[${index}]`))
    await this.append(record)
    return this.get(record.proposalId)
  }

  /**
   * Move proposed → candidate, recording the complete version set the candidate
   * aligns to. `mutation` is the optional structured patch description, shaped
   * and checked against the proposal's targetType; a candidate carrying one
   * must be prepared before it can gate.
   *
   * **A skill candidate only** (§F.2): a capability, agent_preset,
   * task_definition or bookkeeping-only proposal stays the recorded suggestion
   * `evolution_propose` wrote and is refused here by name, before the first
   * ledger line of the candidate lifecycle. Its proposal keeps its place in the
   * ledger — a record is not a candidate.
   */
  async candidate(
    proposalId: string,
    versionSet: Record<string, string>,
    actor: string,
    mutation?: unknown,
  ): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'candidate')
    if (current.targetType !== 'skill') {
      throw new Error(
        `evolution: proposal "${proposalId}" targets "${current.targetType}", which cannot become a candidate in this build — ` +
        'the only candidate lifecycle here is a single-file SKILL.md replacement (evolution_prepare → the two-sided experiment ' +
        'evolution_replay → evolution_gate → evolution_apply), and no other target type has an evaluator until A6 introduces ' +
        'one, so its proposal stays a recorded proposal',
      )
    }
    validateVersionSet(versionSet)
    if (mutation !== undefined) validateMutation(current.targetType, mutation, current.baseVersion)
    await this.append({
      formatVersion: 1,
      kind: 'candidate',
      proposalId,
      versionSet: { ...versionSet },
      ...(mutation === undefined ? {} : { mutation: structuredClone(mutation) }),
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move candidate → prepared: materialize the skill mutation into
   * `<root>/sandbox/<proposalId>/` and snapshot the champion (the production
   * `SKILL.md`) under `champion/` — the anchor for the experiment's baseline and
   * for rollback. A production target that does not exist yet records
   * `champion: 'missing'` (champion: null). Materialization runs before the
   * ledger append; every write is confined to the sandbox dir.
   *
   * The candidate also records `skillContent` (P2): the name plus the SHA-256 of
   * the exact bytes of the file that was actually materialized (read back from
   * disk, never re-rendered from the mutation string), so the experiment, the
   * gates, and apply can verify this exact content later. The same single read
   * of the production file also yields `skillBaseline` (P3), the digest the
   * later apply compares the production target against.
   */
  async prepare(proposalId: string, actor: string): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'prepared')
    const mutation = current.mutation
    if (mutation === undefined) {
      // Unreachable via nextStates (a mutation-less candidate admits only
      // "gated"); stated so the invariant sits next to its use.
      throw new Error(`evolution: proposal "${proposalId}" carries no mutation; nothing to prepare`)
    }
    validateMutation(current.targetType, mutation, current.baseVersion)
    assertSegment(proposalId, 'proposalId')
    const dir = join(this.root, 'sandbox', proposalId)
    const written = await this.materialize(dir, current, mutation)
    const sandbox = `sandbox/${proposalId}`
    const { name } = mutation as unknown as SkillMutation
    const skillContent: SkillContentIdentity = {
      name,
      sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)),
    }
    await this.append({
      formatVersion: 1,
      kind: 'prepared',
      proposalId,
      sandbox,
      mechanical: true,
      champion: written.champion,
      ...(written.skillBaseline === undefined ? {} : { skillBaseline: written.skillBaseline }),
      skillContent,
      files: written.files,
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move candidate → gated (manual candidates), prepared → gated (skill
   * candidates), or replayed → gated (a ledger written before this build's
   * narrowing): all six Gate answers plus regression evidence refs. Every ref
   * must exist — a path on disk (relative to the repo root or absolute) or an id
   * the caller-side resolver knows (task-store evidence). Existence only;
   * nothing here executes anything. A **skill** proposal must have a completed
   * two-sided experiment and cite that experiment's report (§F.2); the six
   * answers are recorded over it.
   */
  async gate(
    proposalId: string,
    answers: GateAnswers,
    actor: string,
    refKnown?: (ref: string) => Promise<boolean>,
  ): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'gated')
    validateGateAnswers(answers)
    let experimentReport: string | undefined
    if (current.targetType === 'skill') {
      const [experiment] = await this.experiments(proposalId)
      if (experiment === undefined) {
        throw new Error(
          `evolution: skill proposal "${proposalId}" has no two-sided experiment — the gate answers must rest on both sides of ` +
          'every frozen sample, so evaluate the candidate with evolution_replay before gating it',
        )
      }
      try {
        buildExperimentReport(experiment)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — a skill candidate gates on a completed experiment only; ` +
          `resume experiment ${experiment.experimentId} (evolution_replay) before answering the gate`,
        )
      }
      experimentReport = experiment.report
    }
    if (experimentReport !== undefined) {
      if (!answers.regressionEvidenceRefs.includes(experimentReport)) {
        throw new Error(
          `evolution: a skill candidate's regression evidence must cite its experiment report "${experimentReport}" — the six ` +
          'answers are answered over that experiment, and the gate records the evidence they rest on',
        )
      }
      if (!existsSync(resolveWithin(this.root, experimentReport))) {
        throw new Error(`evolution: the experiment report "${experimentReport}" no longer exists under the ledger root`)
      }
    }
    for (const ref of answers.regressionEvidenceRefs) {
      if (experimentReport !== undefined && ref === experimentReport) continue
      const exists = this.refExistsOnDisk(ref) || (refKnown !== undefined && (await refKnown(ref)))
      if (!exists) {
        throw new Error(`evolution: regression evidence ref "${ref}" matches no known evidence id and no existing path`)
      }
    }
    await this.append({
      formatVersion: 1,
      kind: 'gated',
      proposalId,
      gate: { ...answers, regressionEvidenceRefs: [...answers.regressionEvidenceRefs] },
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move gated → decided. Callers (the evolution_decide tool) must have a
   * human grant from `ctx.approval.request` before calling this and pass its
   * call id as `approvalRef` (`approval:<callId>`, the applied/rolledback
   * shape) — the service only records, and the ref makes the human review
   * auditable from the ledger alone. A rejected or cancelled ask must never
   * reach this method.
   */
  async decide(proposalId: string, decision: EvolutionDecision, actor: string, approvalRef: string, note?: string): Promise<EvolutionProposal> {
    await this.assertNext(proposalId, 'decided')
    if (!EVOLUTION_DECISIONS.includes(decision)) {
      throw new Error(`evolution: decision must be one of ${EVOLUTION_DECISIONS.join(' / ')}`)
    }
    nonEmpty(approvalRef, 'approvalRef')
    if (note !== undefined) nonEmpty(note, 'note')
    if (decision === 'PROMOTE') await this.checkPromotion(proposalId)
    await this.append({
      formatVersion: 1,
      kind: 'decided',
      proposalId,
      decision,
      approvalRef,
      ...(note === undefined ? {} : { note }),
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move decided → applied: copy the sandbox materialization into production
   * (W16). Reachable only for a PROMOTE decision on a materialized skill
   * mutation at L1–L3 (the state machine itself refuses anything else — every
   * other target type has no executor in this build); the caller (the
   * evolution_apply tool) must hold a human grant from `ctx.approval.request`
   * first, exactly as for decide. The production write runs BEFORE the ledger
   * append, so a failed write leaves the proposal decided and retryable: the
   * sandbox `SKILL.md` replaces the production one (the champion snapshot
   * covers that file only, so the write is file-level, never a directory
   * delete).
   *
   * A skill apply re-verifies the production baseline (P3) after the human
   * grant and immediately before the write: the production target must still be
   * the one prepare recorded. A direct service call therefore cannot bypass the
   * check the tool already ran before asking for approval.
   *
   * The promotion check (S1-C item 3) runs here too, immediately before the
   * write and after the grant: a candidate whose provider role changed while the
   * human was deciding (a sidecar that appeared in the sandbox, a verifier that
   * was unregistered) is refused here, so no entry can write something a later
   * admission would have refused.
   */
  async apply(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    const current = await this.assertNext(proposalId, 'applied')
    nonEmpty(approvalRef, 'approvalRef')
    const promotion = await this.checkPromotion(proposalId)
    await this.checkProductionBaseline(proposalId)
    const outcome = await this.writeProduction(current, 'apply')
    await this.append({
      formatVersion: 1,
      kind: 'applied',
      proposalId,
      targets: outcome.targets,
      approvalRef,
      actor,
      at: new Date().toISOString(),
    })
    return { ...outcome, providers: promotion.providers, proposal: await this.get(proposalId) }
  }

  /**
   * Preflight for tools before asking for approval; mutation methods repeat the
   * check. Returns the providers the promotion would put in place, each with the
   * role it may be counted as, so the callers that already gate on this check
   * can report them.
   *
   * Only a `skill` proposal is promotable in this build (EVAL-4/§F.2): every
   * other target type is refused by name — a type with no evaluator gets no
   * promotion, and a record of one is never upgraded into new evidence
   * ({@link noEvaluatorRefusal}).
   *
   * For a skill candidate three checks run here, in this order, all of them
   * shared with the service entry the tools ultimately call:
   *
   * 1. P2: the candidate bytes must still be the ones prepare recorded.
   * 2. S1-C item 3: the provider check. The candidate's sandbox directory is
   *    judged by the same {@link validateSkillProvider} admission and config
   *    load the rest of the system uses, so `evolution_apply` is not the only
   *    entry that knows what a usable provider is — and a candidate carrying an
   *    execution sidecar with an unregistered verifier or ungranted tools is
   *    refused here, before a human is asked, before `decided` is recorded, and
   *    before anything is written.
   * 3. The evidence gate (`assertSkillPromotionEvidence`): a completed two-sided
   *    experiment whose report, runs, reviews, evidence, frozen inputs, judge,
   *    model, verdict and cost still hold. Every one of them is re-read from the
   *    ledger, the store and the production workspace — the tools run all of it
   *    before asking a human, and decide(PROMOTE) / apply run it again on the
   *    service entry, so evidence that moved while the human was deciding is
   *    still refused.
   */
  async checkPromotion(proposalId: string): Promise<PromotionCheck> {
    const proposal = await this.get(proposalId)
    if (proposal.targetType !== 'skill') throw noEvaluatorRefusal(proposal)
    if (proposal.prepared?.mechanical !== true || proposal.prepared.sandbox == null) {
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" has no materialized candidate — nothing this proposal names was ever ` +
        'evaluated; record a structured candidate and prepare it (evolution_candidate / evolution_prepare) before promoting it',
      )
    }
    // P2: the candidate bytes must still be the ones prepare recorded. This is
    // the shared identity check — the tools run it before asking a human, and
    // decide(PROMOTE) / apply run it again on the service entry, so a change
    // that lands while the human is deciding is still refused.
    await this.readVerifiedSkillCandidate(proposal)
    const providers = [await this.assertSkillCandidateProvider(proposal)]
    await assertSkillPromotionEvidence(this.promotionSources(), proposal)
    return { providers }
  }

  /**
   * The services the promotion gate re-reads from this context: the experiment
   * family of this same ledger, the task store the experiment names, the live
   * verifier vocabulary, this deployment's model selection and its session
   * logs. Resolved softly
   * one by one, so a context that cannot offer one gets a refusal naming it
   * rather than a gate that silently checks less.
   */
  private promotionSources(): SkillPromotionSources {
    const task = optionalService<SkillPromotionSources['task']>(this.ctx, 'task')
    if (task === undefined) {
      throw new Error(
        'evolution: the promotion gate re-reads the experiment\'s runs, reviews and evidence from the task store, and this ' +
        'context has no task service — the evidence cannot be checked, so nothing is promoted',
      )
    }
    return {
      root: this.root,
      experiments: proposalId => this.experiments(proposalId),
      task,
      verifierVocabulary: async () => {
        const vocabulary = await registeredVerifierVocabulary(this.ctx)
        return vocabulary === undefined ? undefined : { ids: vocabulary.ids, versions: vocabulary.versions }
      },
      modelSelection: () => this.modelSelection(),
      sessionLog: sessionId => this.sessionLog(sessionId),
    }
  }

  /**
   * One session's own durable log, read through the deployment's session plane
   * (`sessionQuery.readSession`) — the source the promotion gate re-reads a
   * run's real requests from (S4-E §Q3). `undefined` when the deployment cannot
   * serve the read at all, which the gate reports as a named refusal rather than
   * skipping the check; a session the store does not hold throws, and the gate
   * names that too.
   */
  private async sessionLog(sessionId: string): Promise<readonly SessionEvent[] | undefined> {
    const query = optionalService<{ readSession?(id: SessionId): Promise<{ events: readonly SessionEvent[] }> }>(this.ctx, 'sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') return undefined
    const read = await query.readSession(SessionId(sessionId))
    return read.events
  }

  /**
   * The candidate skill's provider verdict, taken from the directory the
   * promotion would write — plus the executor boundary this promotion cannot
   * cross.
   *
   * The boundary: `writeProduction` promotes a **single `SKILL.md`**, so a
   * candidate whose directory carries anything else (`SKILL.contract.json`, a
   * `references/` or `scripts/` tree, any other file) is refused here by name.
   * The executor is not being extended to multi-file candidates; what is being
   * refused is the promotion of a candidate whose declaration or resources
   * production would never receive — a promotion that reported an
   * `execution-provider` role (or a content identity covering files nobody
   * wrote) for content that does not exist is exactly the false record this
   * refusal prevents.
   *
   * Both the shape and the declaration are named when both are wrong: the
   * validator's own defects stay in the message with their codes, so this entry
   * reports the same defect vocabulary admission, config load and capability
   * replacement report for the same directory.
   */
  private async assertSkillCandidateProvider(proposal: EvolutionProposal): Promise<PromotionProvider> {
    const sandbox = proposal.prepared?.sandbox
    const { name } = proposal.mutation as unknown as SkillMutation
    if (sandbox == null) {
      throw new Error(`evolution: proposal "${proposal.proposalId}" names no sandbox; the candidate's provider role cannot be judged`)
    }
    const directory = resolveWithin(this.root, `${sandbox}/skills/${name}`)
    const unsupported = await unsupportedCandidateEntries(directory)
    const verdict = await this.providerVerdict({ name, directory })
    const defects = verdict.valid ? '' : verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
    if (unsupported.length > 0) {
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} carries ${unsupported.map(entry => JSON.stringify(entry)).join(', ')} — ` +
        'the skill executor promotes single-file SKILL.md candidates only, so a sidecar or resource this promotion would not write is ' +
        `refused rather than silently dropped${verdict.valid ? '' : `; the declared provider is unusable too — ${defects}`}`,
      )
    }
    if (!verdict.valid) {
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} is not a usable provider — ${defects}; ` +
        'a promotion writes only a skill a worker could load and, when it claims execution, only one whose verifier and tools the deployment can grant',
      )
    }
    return promotionProviderOf(verdict)
  }

  /**
   * One provider candidate judged by the unified validator, with the sources the
   * deployment actually has:
   *
   * - the effective capability table (the runtime registry — what a restart
   *   re-reads from `config.yml`), asked through `capabilityToolQuery`, so a
   *   capability's grant is read by the same resolution admission performs;
   * - the registered verifier vocabulary, `ready()` first, fail-closed: an
   *   execution sidecar whose ref cannot be proven registered against a live
   *   registry is refused with the same named defect the admission pre-check
   *   uses rather than assumed valid.
   *
   * A context with no runtime registry at all answers every capability question
   * as unreadable instead of as "granting nothing": an execution provider is then
   * refused (fail-closed), while knowledge and guidance — which make no tool
   * claim — are judged by the same validator as everywhere else.
   */
  private async providerVerdict(candidate: SkillProviderCandidate): Promise<SkillProviderVerdict> {
    const verifierRefs = await registeredVerifierIds(this.ctx)
    if (verifierRefs === undefined && candidate.directory !== undefined) {
      const loaded = await loadSkillSidecar(candidate.directory)
      if (loaded.sidecar?.type === 'execution') {
        return unlistableVerifierRefusal(candidate.name, candidate.directory, loaded.sidecar.verifier.ref)
      }
    }
    return validateSkillProvider(candidate, {
      verifierRefs: verifierRefs === undefined ? [] : [...verifierRefs],
      capabilityTools: this.capabilityToolAnswer(),
    })
  }

  /**
   * The capability table this service judges providers against: the running
   * registry, which is the table a restart re-reads from `config.yml` and the one
   * `evolution_prepare` snapshots the champion from. Absent (no task-runtime in
   * this context) means the table cannot be read — reported as an unreadable
   * grant rather than mistaken for an empty table.
   */
  private capabilityToolAnswer(): CapabilityToolQuery {
    const table = this.effectiveCapabilities()
    if (table !== undefined) return capabilityToolQuery(table)
    return () => ({
      known: false,
      reason:
        'the effective capability registry cannot be read in this context (no task-runtime service), so the tools this ' +
        'capability grants cannot be resolved',
    })
  }

  /** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
  private effectiveCapabilities(): Readonly<Record<string, CapabilityConfig>> | undefined {
    const runtime = optionalService<CapabilityRegistrySource>(this.ctx, 'taskRuntime')
    try {
      return runtime?.listCapabilities?.()
    } catch {
      return undefined
    }
  }

  /**
   * Read a prepared skill candidate's materialized bytes and verify them
   * against the content identity recorded at prepare (P2). The one read path
   * every stage shares: the experiment's pre-run check, every promotion gate,
   * and the apply write.
   * Throws — never silently re-digests — when the candidate file is missing,
   * is not a regular file, its path crosses a symbolic link, or its bytes no
   * longer match the recorded digest.
   */
  async readSkillCandidate(proposalId: string): Promise<Buffer> {
    return this.readVerifiedSkillCandidate(await this.get(proposalId))
  }

  /**
   * The production-baseline check (P3), on the apply seams only: the
   * evolution_apply tool runs it before asking a human, and `apply` runs it
   * again immediately before the production write, so a baseline that moved
   * while the human was deciding is still refused and a direct service call
   * cannot bypass it. Nothing here writes, merges, or overwrites — a conflict
   * only throws.
   *
   * `captured` requires a real regular file whose bytes still hash to the
   * digest prepare recorded; `missing` requires the target to still be absent.
   * A file that appeared, changed, disappeared, changed type (now a directory),
   * or sits behind a symbolic link (the file itself or an ancestor) is a
   * conflict. Only `targetType: skill` carries a baseline; every other
   * targetType passes untouched.
   */
  async checkProductionBaseline(proposalId: string): Promise<void> {
    await this.assertProductionBaseline(await this.get(proposalId))
  }

  private async assertProductionBaseline(proposal: EvolutionProposal): Promise<void> {
    if (proposal.targetType !== 'skill') return
    const prepared = proposal.prepared
    if (prepared?.mechanical !== true || prepared.sandbox == null) return
    const { name } = proposal.mutation as unknown as SkillMutation
    const target = `${this.skillRoot}/${name}/SKILL.md`
    const guidance =
      'create a new candidate from the current production state and re-evaluate it; ' +
      'an apply never overwrites a production skill it cannot verify'
    let current: { bytes: Buffer; sha256: string } | null
    try {
      current = await readProductionSkill(this.skillRoot, name)
    } catch (error) {
      throw new Error(
        `evolution: the production skill "${target}" is no longer a readable regular file ` +
        `(${(error as Error).message.replace(/^evolution: /, '')}) — ${guidance}`,
      )
    }
    if (prepared.champion === 'missing') {
      if (current !== null) {
        throw new Error(
          `evolution: skill proposal "${proposal.proposalId}" was prepared with no production "${target}", ` +
          `but the file exists now (sha256 ${current.sha256}) — ${guidance}`,
        )
      }
      return
    }
    const identity = prepared.skillBaseline
    if (identity === undefined) {
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" records no production baseline identity ` +
        `(it was prepared before the baseline was recorded) — ${guidance}`,
      )
    }
    if (current === null) {
      throw new Error(
        `evolution: the production skill "${target}" recorded at prepare (sha256 ${identity.sha256}) no longer exists — ${guidance}`,
      )
    }
    if (current.sha256 !== identity.sha256) {
      throw new Error(
        `evolution: the production skill "${target}" changed since prepare ` +
        `(sha256 ${current.sha256} != ${identity.sha256}) — ${guidance}`,
      )
    }
  }

  private async readVerifiedSkillCandidate(proposal: EvolutionProposal): Promise<Buffer> {
    if (proposal.targetType !== 'skill') {
      throw new Error(`evolution: candidate content identity binds skill proposals only, not "${proposal.targetType}"`)
    }
    const sandbox = proposal.prepared?.sandbox
    const identity = proposal.prepared?.skillContent
    if (sandbox == null || identity === undefined) {
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — ` +
        'it was prepared before content binding; propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized SKILL.md)',
      )
    }
    const rel = `${sandbox}/skills/${identity.name}/SKILL.md`
    const bytes = await readVerifiedFile(this.root, rel)
    const digest = sha256Hex(bytes)
    if (digest !== identity.sha256) {
      throw new Error(
        `evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare ` +
        `(sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
      )
    }
    return bytes
  }

  /**
   * Move applied → rolledback: undo the apply. Champion captured → restore the
   * champion `SKILL.md` snapshot; champion missing → delete the skill directory
   * the apply created. A record of another target type has no executor here:
   * this build writes and restores a single `SKILL.md` only, and an applied
   * capability row or preset directory is refused by name rather than touched.
   * Same approval discipline as apply: the tool asks a human first, the service
   * only executes and records.
   */
  async rollback(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    const current = await this.assertNext(proposalId, 'rolledback')
    nonEmpty(approvalRef, 'approvalRef')
    const outcome = await this.writeProduction(current, 'rollback')
    await this.append({
      formatVersion: 1,
      kind: 'rolledback',
      proposalId,
      targets: outcome.targets,
      approvalRef,
      actor,
      at: new Date().toISOString(),
    })
    return { ...outcome, proposal: await this.get(proposalId) }
  }

  /**
   * The production write behind apply/rollback: one `SKILL.md` at the candidate
   * name under the production skill root. `apply` writes the verified candidate
   * bytes, `rollback` the champion snapshot. Every path goes through
   * `resolveWithin`, so a write can never leave the production root it targets.
   */
  private async writeProduction(proposal: EvolutionProposal, direction: 'apply' | 'rollback'): Promise<Omit<ApplyOutcome, 'proposal'>> {
    if (proposal.targetType !== 'skill') {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores a single ` +
        `SKILL.md only, so there is no executor to ${direction} an applied ${proposal.targetType} record`,
      )
    }
    const sandbox = proposal.prepared?.sandbox
    const champion = proposal.prepared?.champion
    if (sandbox == null || champion === undefined || proposal.mutation === undefined) {
      throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`)
    }
    const { name } = proposal.mutation as unknown as SkillMutation
    const dst = resolveWithin(this.skillRoot, join(name, 'SKILL.md'))
    if (direction === 'rollback' && champion === 'missing') {
      await rm(resolveWithin(this.skillRoot, name), { recursive: true, force: true })
      return { targets: [`${resolveWithin(this.skillRoot, name)} (deleted — the apply had created it)`] }
    }
    if (direction === 'apply') {
      // P2: read the candidate once, verify the digest prepare recorded, and
      // write exactly those verified bytes. The path is never re-read after the
      // check, so a source replaced mid-apply cannot reach production unverified
      // — the whole apply refuses instead.
      const bytes = await this.readVerifiedSkillCandidate(proposal)
      await mkdir(dirname(dst), { recursive: true })
      await writeFile(dst, bytes)
      return { targets: [dst] }
    }
    const content = await readVerifiedFile(this.root, `${sandbox}/champion/skills/${name}/SKILL.md`)
    await mkdir(dirname(dst), { recursive: true })
    await writeFile(dst, content)
    return { targets: [dst] }
  }

  /** Folded view of one proposal, or throws on an unknown id. */
  async get(proposalId: string): Promise<EvolutionProposal> {
    await this.loaded
    const proposal = this.fold(this.records).get(proposalId)
    if (proposal === undefined) throw new Error(`evolution: unknown proposal "${proposalId}"`)
    return proposal
  }

  /** Folded views, newest proposal first, optionally filtered. */
  async list(filter: ListFilter = {}): Promise<EvolutionProposal[]> {
    await this.loaded
    const proposals = [...this.fold(this.records).values()].reverse()
    return proposals.filter(
      proposal =>
        (filter.status === undefined || proposal.status === filter.status) &&
        (filter.targetType === undefined || proposal.targetType === filter.targetType) &&
        (filter.targetId === undefined || proposal.targetId === filter.targetId),
    )
  }

  private refExistsOnDisk(ref: string): boolean {
    return existsSync(isAbsolute(ref) ? ref : resolve(this.repoRoot, ref))
  }

  /**
   * Early state-machine check so a wrong-state call reports the transition
   * error before any payload validation; `append` re-checks under the write
   * lock, which is the authoritative gate. Returns the folded proposal so
   * callers can validate payloads against targetType / baseVersion / mutation.
   */
  private async assertNext(proposalId: string, kind: EvolutionStatus): Promise<EvolutionProposal> {
    await this.loaded
    const current = this.fold(this.records).get(proposalId)
    if (current === undefined) throw new Error(`evolution: unknown proposal "${proposalId}"`)
    assertTransition(current, kind)
    return current
  }

  /**
   * Write the skill mutation into the sandbox dir `dir`, then the champion
   * snapshot. Every path goes through `resolveWithin`, so a write can never
   * land outside the sandbox; the production skill root is read-only here. The
   * champion is read exactly once (P3): those bytes become both the snapshot
   * and the recorded `skillBaseline` digest, so the two can never describe two
   * different reads of the production file.
   */
  private async materialize(
    dir: string,
    proposal: EvolutionProposal,
    mutation: Record<string, unknown>,
  ): Promise<{ files: string[]; champion: 'captured' | 'missing'; skillBaseline?: SkillContentIdentity }> {
    const files: string[] = []
    const write = async (rel: string, content: string): Promise<void> => {
      const abs = resolveWithin(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      files.push(rel)
    }
    // This build materializes a skill candidate and nothing else: `candidate`
    // admits no other target type, so the switch below has no other arm to take.
    const { name, content } = mutation as unknown as SkillMutation
    await write(`skills/${name}/SKILL.md`, content)
    // P3: one verified read of the production file yields the snapshot and
    // the baseline digest together; a production path that is a symlink or
    // not a regular file fails here instead of being followed.
    const production = await readProductionSkill(this.skillRoot, name)
    if (production === null) return { files, champion: 'missing' }
    await write(`champion/skills/${name}/SKILL.md`, production.bytes.toString('utf8'))
    return { files, champion: 'captured', skillBaseline: { name, sha256: production.sha256 } }
  }

  /**
   * Fold records into proposals, enforcing the state machine on every step:
   * proposed starts a new id; each later kind must be exactly an allowed next
   * state, and payload-bearing kinds re-run the write path's payload
   * validation (candidate versionSet/mutation, gate answers, the
   * prepared/replayed/applied/rolledback shapes), so a hand-forged line fails
   * load exactly as it would fail append. The same rules guard folding and live
   * appends, so an illegal migration is rejected identically in both paths —
   * including a record kind this build no longer writes, whose line still has
   * to be the shape the build that recorded it validated.
   *
   * The experiment family is not a lifecycle transition and is skipped here;
   * {@link foldLedger} folds it beside this fold.
   */
  private fold(records: readonly EvolutionRecord[]): Map<string, EvolutionProposal> {
    const proposals = new Map<string, EvolutionProposal>()
    for (const record of records) {
      if (isExperimentRecord(record)) continue
      const current = proposals.get(record.proposalId)
      if (record.kind === 'proposed') {
        if (current !== undefined) throw new Error(`evolution: proposal "${record.proposalId}" already exists`)
        proposals.set(record.proposalId, {
          proposalId: record.proposalId,
          targetType: record.targetType,
          targetId: record.targetId,
          baseVersion: record.baseVersion,
          level: record.level,
          rationale: record.rationale,
          sourceRefs: [...record.sourceRefs],
          status: 'proposed',
          history: [{ status: 'proposed', actor: record.actor, at: record.at }],
        })
        continue
      }
      if (current === undefined) throw new Error(`evolution: unknown proposal "${record.proposalId}"`)
      assertTransition(current, record.kind)
      current.history.push({ status: record.kind, actor: record.actor, at: record.at })
      switch (record.kind) {
        case 'candidate':
          validateVersionSet(record.versionSet)
          if (record.mutation !== undefined) {
            validateMutation(current.targetType, record.mutation, current.baseVersion)
            current.mutation = structuredClone(record.mutation)
          }
          current.versionSet = { ...record.versionSet }
          break
        case 'prepared': {
          const mechanical = mutationMechanical(current.targetType)
          if (record.mechanical !== mechanical) {
            throw new Error(
              `evolution: prepared record for "${record.proposalId}" marks mechanical=${record.mechanical}, ` +
              `but targetType "${current.targetType}" implies ${mechanical}`,
            )
          }
          if (!CHAMPION_STATES.includes(record.champion)) {
            throw new Error(`evolution: prepared record for "${record.proposalId}" has unknown champion state "${String(record.champion)}"`)
          }
          if (record.sandbox !== null && typeof record.sandbox !== 'string') {
            throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string sandbox`)
          }
          if (!Array.isArray(record.files) || record.files.some(file => typeof file !== 'string')) {
            throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`)
          }
          if (mechanical && (record.sandbox === null || record.champion === 'none')) {
            throw new Error(`evolution: prepared record for "${record.proposalId}" is mechanical but names no sandbox`)
          }
          if (!mechanical && (record.sandbox !== null || record.champion !== 'none' || record.files.length > 0)) {
            throw new Error(`evolution: prepared record for "${record.proposalId}" is bookkeeping-only but carries sandbox artifacts`)
          }
          if (record.championSource !== undefined) {
            if (!CHAMPION_SOURCES.includes(record.championSource)) {
              throw new Error(`evolution: prepared record for "${record.proposalId}" has unknown championSource "${String(record.championSource)}"`)
            }
            if (current.targetType !== 'capability') {
              throw new Error(`evolution: prepared record for "${record.proposalId}" carries championSource but targetType "${current.targetType}" is not capability`)
            }
            if ((record.championSource === 'missing') !== (record.champion === 'missing')) {
              throw new Error(
                `evolution: prepared record for "${record.proposalId}" has championSource "${record.championSource}" but champion "${record.champion}"`,
              )
            }
          }
          // P2: skillContent is optional (pre-binding records fold without it)
          // but when present it must be a real identity on a skill proposal.
          if (record.skillContent !== undefined) {
            if (current.targetType !== 'skill') {
              throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillContent but targetType "${current.targetType}" is not skill`)
            }
            if (!isRecord(record.skillContent) || typeof record.skillContent.name !== 'string' || record.skillContent.name.length === 0
              || typeof record.skillContent.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.skillContent.sha256)) {
              throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillContent identity`)
            }
          }
          // P3: skillBaseline is optional (pre-baseline records fold without
          // it) but when present it must be a real identity on a skill proposal.
          if (record.skillBaseline !== undefined) {
            if (current.targetType !== 'skill') {
              throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillBaseline but targetType "${current.targetType}" is not skill`)
            }
            if (!isRecord(record.skillBaseline) || typeof record.skillBaseline.name !== 'string' || record.skillBaseline.name.length === 0
              || typeof record.skillBaseline.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.skillBaseline.sha256)) {
              throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillBaseline identity`)
            }
          }
          current.prepared = {
            sandbox: record.sandbox,
            mechanical: record.mechanical,
            champion: record.champion,
            ...(record.championSource === undefined ? {} : { championSource: record.championSource }),
            ...(record.skillContent === undefined ? {} : { skillContent: { name: record.skillContent.name, sha256: record.skillContent.sha256 } }),
            ...(record.skillBaseline === undefined ? {} : { skillBaseline: { name: record.skillBaseline.name, sha256: record.skillBaseline.sha256 } }),
            files: [...record.files],
          }
          break
        }
        case 'replayed': {
          if (typeof record.report !== 'string' || record.report.length === 0) {
            throw new Error(`evolution: replayed record for "${record.proposalId}" has no report path`)
          }
          if (!REPLAY_VERDICTS.includes(record.verdict)) {
            throw new Error(`evolution: replayed record for "${record.proposalId}" has unknown verdict "${String(record.verdict)}"`)
          }
          if (!Array.isArray(record.tasks) || record.tasks.some(item => !isRecord(item) || typeof item.taskId !== 'string' || !REPLAY_RELATIONS.includes(item.relation as ReplayRelation) || typeof item.holdout !== 'boolean')) {
            throw new Error(`evolution: replayed record for "${record.proposalId}" has a malformed task summary`)
          }
          if (record.reportDigest !== undefined && !/^[a-f0-9]{64}$/.test(record.reportDigest)) {
            throw new Error(`evolution: replayed record for "${record.proposalId}" has an invalid report digest`)
          }
          current.replayed = {
            report: record.report, verdict: record.verdict, tasks: record.tasks.map(item => ({ ...item })),
            ...(record.reportDigest === undefined ? {} : { reportDigest: record.reportDigest }),
          }
          break
        }
        case 'gated':
          validateGateAnswers(record.gate)
          current.gate = record.gate
          break
        case 'decided':
          current.decision = record.decision
          if (record.note !== undefined) current.decisionNote = record.note
          // approvalRef is optional only so ledger lines written before the
          // field existed still fold; when present it must be real evidence.
          if (record.approvalRef !== undefined) {
            if (typeof record.approvalRef !== 'string' || record.approvalRef.length === 0) {
              throw new Error(`evolution: decided record for "${record.proposalId}" has an empty human-approval evidence ref`)
            }
            current.decisionApprovalRef = record.approvalRef
          }
          break
        case 'applied':
        case 'rolledback': {
          if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.some(target => typeof target !== 'string' || target.length === 0)) {
            throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list`)
          }
          if (typeof record.approvalRef !== 'string' || record.approvalRef.length === 0) {
            throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has no human-approval evidence ref`)
          }
          current[record.kind] = { targets: [...record.targets], approvalRef: record.approvalRef }
          break
        }
      }
      current.status = record.kind
    }
    return proposals
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const lines = text.split('\n').filter(line => line.trim().length > 0)
    const records: EvolutionRecord[] = lines.map((line, index) => {
      try {
        return JSON.parse(line) as EvolutionRecord
      } catch {
        throw new Error(`evolution: corrupt ledger line ${index + 1} in ${this.file}`)
      }
    })
    for (const record of records) {
      if (record.formatVersion !== 1) throw new Error(`evolution: unsupported ledger formatVersion "${String(record.formatVersion)}"`)
    }
    this.records = records
    this.foldLedger(this.records)
  }

  /**
   * Validate a whole ledger: the proposal lifecycle fold, then the experiment
   * fold beside it. Neither family's rules change because the other exists —
   * a lifecycle line is judged exactly as it always was, and an experiment line
   * gets its own checks ({@link foldExperiments}).
   */
  private foldLedger(records: readonly EvolutionRecord[]): Map<string, EvolutionProposal> {
    const proposals = this.fold(records)
    foldExperiments(records, proposals)
    return proposals
  }

  /** Validate the staged fold first; memory commits only after the line is on disk. */
  private async append(record: EvolutionRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      this.foldLedger([...this.records, record])
      await mkdir(this.root, { recursive: true })
      await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
      this.records = [...this.records, record]
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /* ------------------------------------------------------------------------ *
   * The two-sided experiment (S4-E §F.2): the ledger writes the orchestrator
   * calls, and the two entries the tool layer will wire up next.
   * ------------------------------------------------------------------------ */

  /** The folded views of every experiment, one per id — the ledger's experiment family, validated. */
  private experimentViews(): Map<string, ExperimentView> {
    return foldExperiments(this.records, this.fold(this.records))
  }

  /**
   * One experiment's folded view (its frozen block and every sample record
   * written under it), or a named refusal for an unknown id. This is the read
   * the promotion gate will take: the report is a function of these records, so
   * re-deriving it here is what lets a later stage refuse a report that no
   * longer matches the ledger.
   */
  async experiment(experimentId: string): Promise<ExperimentView> {
    await this.loaded
    const view = this.experimentViews().get(experimentId)
    if (view === undefined) throw new Error(`evolution: unknown experiment "${experimentId}"`)
    return view
  }

  /** Every experiment's folded view, newest first, optionally narrowed to one proposal. */
  async experiments(proposalId?: string): Promise<ExperimentView[]> {
    await this.loaded
    return [...this.experimentViews().values()]
      .filter(view => proposalId === undefined || view.proposalId === proposalId)
      .reverse()
  }

  /**
   * Record the frozen experiment, before its first run. Idempotent by identity:
   * the same frozen block under the same id is a no-op (a repeat call resumes
   * the same experiment rather than starting a second one), and a record that
   * already holds a different frozen block, budget or report path is refused —
   * the experiment id *is* the frozen identity, so a disagreement means the
   * ledger and the caller are not talking about the same experiment.
   */
  async recordExperimentStart(record: ExperimentStartedRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      // The line must stand on its own before anything is decided about it:
      // frozen block, digest, id, budget and report path all re-derived.
      assertExperimentStartRecord(record, this.fold(this.records))
      // Then the repeat rule. While the derivation above holds, one id can only
      // ever carry one frozen block — the id *is* the block's digest — so this
      // comparison is a second line of defence: a future derivation change may
      // not silently make a repeat call adopt a different frozen experiment.
      const prior = this.experimentViews().get(record.experimentId)
      if (prior !== undefined) {
        if (prior.frozenDigest !== record.frozenDigest || prior.proposalId !== record.proposalId
          || prior.report !== record.report || prior.storeId !== record.storeId
          || canonicalJson(prior.frozen) !== canonicalJson(record.frozen)) {
          throw new Error(
            `evolution: experiment "${record.experimentId}" is already recorded with a different frozen identity — ` +
            'an experiment id names one frozen block, its own report path and the task store its runs live in; changing any of ' +
            'them freezes a different experiment',
          )
        }
        return
      }
      const staged = [...this.records, record]
      foldExperiments(staged, this.fold(staged))
      await mkdir(this.root, { recursive: true })
      await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
      this.records = staged
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /**
   * Record one sample side, once. The key carries the run: a second record for
   * the same key is refused by the fold whatever it says, and a record that
   * disagrees with the experiment it names (a different candidate identity, a
   * different repetition, a sample the experiment never froze) is refused
   * before the line lands. Nothing here re-runs anything — the caller only
   * writes what a run already settled to.
   */
  async recordExperimentSample(record: ExperimentSampleRecord): Promise<void> {
    await this.append(record)
  }

  /**
   * The two-sided experiment entry (§F.2). The orchestrator itself lives in
   * `experiment.ts`; this method is the service's own door to it, resolving the
   * graph, task and runtime services from this context so the tool layer above
   * has exactly one call to make. It does not touch the promotion gate or the
   * lifecycle: an experiment is evidence, and what may be promoted from it is a
   * later stage's question.
   */
  async runExperiment(spec: ExperimentSpec, caller: SessionId, actor: string, options: { signal?: AbortSignal } = {}): Promise<ExperimentResult> {
    return runExperiment(this.experimentSources(), {
      spec,
      caller,
      actor,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /**
   * Continue a frozen experiment by id. Its specification *is* the recorded
   * frozen block, so a caller that lost the spec — a restart — can resume what
   * was frozen rather than guess at it; the block is re-derived and must
   * reproduce the recorded identity, so a candidate, contract, model or
   * snapshot that moved is refused rather than run under a new identity.
   */
  async resumeExperiment(experimentId: string, caller: SessionId, actor: string, options: { signal?: AbortSignal } = {}): Promise<ExperimentResult> {
    return resumeExperiment(this.experimentSources(), {
      experimentId,
      caller,
      actor,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /**
   * The services one experiment runs on, resolved softly: an experiment needs
   * the graph (for this graph's task store), the task store's reads, and the
   * runtime's replay entry. A context that cannot offer one refuses by name
   * instead of running an experiment that could not be judged against a store.
   */
  private experimentSources(): ExperimentSources {
    const graphs = optionalService<ExperimentSources['graphs']>(this.ctx, 'graphs')
    const task = optionalService<ExperimentSources['task']>(this.ctx, 'task')
    const taskRuntime = optionalService<ExperimentSources['taskRuntime']>(this.ctx, 'taskRuntime')
    if (graphs === undefined || task === undefined || taskRuntime === undefined) {
      throw new Error(
        'evolution: the two-sided experiment needs the graphs, task and taskRuntime services in this context ' +
        `(missing: ${[graphs === undefined ? 'graphs' : undefined, task === undefined ? 'task' : undefined, taskRuntime === undefined ? 'taskRuntime' : undefined].filter(Boolean).join(', ')})`,
      )
    }
    return {
      evolution: this,
      graphs,
      task,
      taskRuntime,
      // Both freeze-time reads go through the same entries every other consumer
      // uses: the judge vocabulary the criteria pin, and the runtime's own
      // capability table the provider identity is read from. A context that
      // cannot answer them makes the freeze fail by name (see experiment.ts)
      // rather than freezing a value nobody can compare against.
      verifierVocabulary: async () => {
        const vocabulary = await registeredVerifierVocabulary(this.ctx)
        return vocabulary === undefined ? undefined : { ids: vocabulary.ids, versions: vocabulary.versions }
      },
    }
  }
}

export default EvolutionService

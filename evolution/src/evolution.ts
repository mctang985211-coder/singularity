/**
 * Evolution admission track (guide §2.7.6/§2.7.7): an append-only ledger of
 * EvolutionProposals with the state machine proposed → candidate → prepared →
 * gated → decided. Every candidate carries a structured mutation — this build's
 * one candidate is a single-file `SKILL.md` replacement — and `prepared` is the
 * one state it admits: evolution_prepare reads the production `SKILL.md` it
 * replaces once, before any write, and materializes the mutation into the
 * per-proposal sandbox (`<root>/sandbox/<proposalId>/`) plus a champion snapshot
 * of those same bytes. A prepare whose production target is not there has
 * nothing to replace and is refused before any sandbox or ledger write. A
 * **skill** candidate — the only candidate this build admits — is then evaluated
 * by the two-sided experiment of §F.2 (`evolution_replay`), recorded in the
 * ledger's experiment family and re-read by the promotion gate; the experiment
 * is evidence, not a lifecycle transition, so a skill proposal gates from
 * prepared.
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
 * report is never upgraded into new evidence).
 *
 * The ledger is one format, `formatVersion: 3` (K2): every line a current
 * entry writes carries it, {@link EvolutionService} refuses a v1, a v2, an
 * unversioned or a mixed ledger at load, naming the line and the version it saw,
 * and every write door — the append funnel and the experiment start — refuses a
 * record declaring anything else before a byte changes. There is no dual-format
 * reader, no online migration and no fallback helper: an older ledger is archived
 * by the operator and a new one started (the persistence contract's own deployment
 * step), never migrated or read beside v3 lines.
 *
 * PROMOTE takes effect through `evolution_apply` (W16): the candidate's
 * `SKILL.md` is copied from the sandbox into production — decided → applied →
 * (optionally) rolledback — each transition only after its own human approval
 * granted through the native approval seam (done by the tools, not here). L4
 * proposals and every non-skill target type never apply: the ledger records
 * their suggestions without granting an executor in this build.
 *
 * A production write is one **commit** (K2), and the commit is durable before it
 * is effective: an `apply`/`rollback` persists a `commit_intent` line binding the
 * proposal, the direction, the human grant, the absolute target, the content
 * identity production must hold before and after, and a recoverable byte source
 * under the ledger root; then the target is replaced atomically (a same-directory
 * temp file, fsynced and renamed over it — never truncated); then, once the
 * rename has been read back and verified, the completion line
 * (`applied`/`rolledback`, carrying the same `intentId`) closes the intent at the
 * fold. Each of those facts is durable before the next one depends on it: the
 * source is confined to the ledger root, re-verified and fsynced (the file and
 * the directory holding it) *before* the intent that names it is appended, and
 * every ledger line — the intent, the completion and every lifecycle record —
 * goes through the service's one durable append (write, `fsync` the file,
 * `fsync` the directories that hold it), because a line that can be lost while
 * the write it justified survives is exactly the ledger a recovery cannot
 * reconcile. A completion with no matching open intent is refused, so the intent
 * cannot be skipped, and a crash between any two of those writes leaves exactly
 * one open intent for {@link EvolutionService.reconcile} — the explicit startup
 * or resume entry — to settle: the same operation is redone when production still
 * holds the pre-commit state, only the completion is recorded when production
 * already holds the committed content, and anything else (a source that is gone,
 * a target a third party rewrote or removed) stops by name with the intent left
 * open and nothing overwritten. Reconciliations and fresh commits share one
 * serial queue inside the service (single-process deployment: no distributed
 * lock, no background retry queue); because that queue spans one process only,
 * a fresh commit additionally refuses by name any production target another
 * proposal's open intent names, so it never moves a target out from under an
 * unfinished one. {@link EvolutionService.openIntentTargets} is the pure read a
 * loader or admission gate uses to see which production targets a commit still
 * has open.
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
 * What a skill promotion promotes is one file: the commit writes the
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

import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
import type { SkillContentIdentity } from './replay.ts'
import { canonicalJson, modelSelectionOf } from './replay.ts'
import type { ModelSelection } from './replay.ts'
import type { CommitHost, CommitRequest, CommitStage, ReconcileOutcome } from './commit.ts'
import { commitIntent, reconcileIntent, sha256Hex, syncDirectory } from './commit.ts'
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
export type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'gated' | 'decided' | 'applied' | 'rolledback'
/** The three frozen decision values of the Validation Gate (细化想法4.md §32). */
export type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH'

export const EVOLUTION_LEVELS: readonly EvolutionLevel[] = ['L1', 'L2', 'L3', 'L4']
export const EVOLUTION_DECISIONS: readonly EvolutionDecision[] = ['PROMOTE', 'REJECT', 'KEEP_FOR_FURTHER_RESEARCH']

/**
 * The one target type `evolution_apply` promotes mechanically (W16): the
 * sandbox copy lands on the production skill root. Every other type has no
 * executor in this build — a capability row, an agent_preset directory and a
 * task_definition were written by an older build and are not written here.
 */
export const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[] = ['skill']

/**
 * Whether a decided proposal's `applied` record is admissible: the decision is
 * PROMOTE, the level is not L4 (L4 harness evolution is human-run by rule,
 * §2.7.7 / §2.9.2), the target type is one this build can execute
 * ({@link APPLYABLE_TARGET_TYPES} — skill and nothing else), and a sandbox was
 * actually materialized. The state machine admits exactly what the current write
 * path writes: an `applied` record of a type no executor here has is refused at
 * the fold, the same way {@link EvolutionService.apply} refuses it live.
 */
function applyable(proposal: EvolutionProposal): boolean {
  return (
    proposal.decision === 'PROMOTE' &&
    proposal.level !== 'L4' &&
    APPLYABLE_TARGET_TYPES.includes(proposal.targetType) &&
    proposal.prepared?.sandbox != null
  )
}

/** skill mutation: the full SKILL.md text for `<skills root>/<name>/SKILL.md`. */
export interface SkillMutation {
  name: string
  content: string
}

/**
 * The champion snapshot of one prepared proposal. `captured` is the only state
 * there is: this build replaces an existing production `SKILL.md`, so a target
 * that is not there has nothing to prepare from and is refused before any
 * sandbox write, and every `prepared` record the fold admits carries the
 * snapshot's state. The bookkeeping-only prepare (`none` — nothing materialized,
 * no anchor) belonged to target types this build's candidate never admits and
 * has no producer or consumer left (S4-E 收尾).
 */
export type ChampionState = 'captured'

/** Folded view of one `prepared` record. */
export interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null
  mechanical: boolean
  champion: ChampionState
  /** The content identity recorded for the materialized candidate `SKILL.md` (P2) — every prepare records it. */
  skillContent?: SkillContentIdentity
  /**
   * The content identity of the production `skills/<name>/SKILL.md` as it stood
   * at prepare (P3) — from the same single read that produced the champion
   * snapshot, so snapshot and digest can never disagree. Every prepare records
   * it; a captured champion without it cannot prove its baseline and refuses a
   * new apply.
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

/**
 * One immutable ledger line, `formatVersion: 3` throughout (K2). A state
 * migration appends a new record; nothing is ever rewritten in place. The
 * version is the whole ledger's, not one line's: a line declaring anything but
 * 3 — or declaring nothing — makes the ledger refuse to load, and no entry here
 * writes one.
 */
export type EvolutionRecord =
  | {
      formatVersion: 3
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
      formatVersion: 3
      kind: 'candidate'
      proposalId: string
      /** Complete version set the candidate aligns to (branch-model bookkeeping; this build creates no real branch). */
      versionSet: Record<string, string>
      /**
       * The structured patch description, shaped by the proposal's targetType
       * (see the *Mutation interfaces) and always recorded: this build's
       * candidate is a single-file `SKILL.md` replacement, so a candidate that
       * carries nothing to materialize and evaluate would be a flow going
       * nowhere. Every line `candidate` writes holds one; a line written before
       * that rule (or by hand) folds to a candidate with no next state,
       * because `prepared` is the one transition a candidate admits.
       */
      mutation: unknown
      actor: string
      at: string
    }
  | {
      formatVersion: 3
      kind: 'prepared'
      proposalId: string
      /**
       * Sandbox dir relative to the ledger root. Every prepare this build
       * writes materializes one; nullable in the type only so a hand-forged
       * line naming none is refused by name at the fold.
       */
      sandbox: string | null
      /** True on every prepare the fold admits: this build's candidate is a materialized skill mutation. */
      mechanical: boolean
      /** Always `captured`: a prepare snapshots the production bytes it replaces. */
      champion: ChampionState
      /**
       * The content identity of the materialized candidate `SKILL.md` (P2) — the
       * skill name plus the SHA-256 of the exact file bytes. Required: the fold
       * refuses a prepare without it, so a candidate nothing can re-verify never
       * becomes a flow.
       */
      skillContent?: SkillContentIdentity
      /**
       * The content identity of the production `SKILL.md` as it stood at prepare
       * (P3), from the same read that produced the champion snapshot. Required:
       * the fold refuses a prepare without it, so a captured champion always
       * names the baseline a later apply compares production against.
       */
      skillBaseline?: SkillContentIdentity
      /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
      files: string[]
      actor: string
      at: string
    }
  | { formatVersion: 3; kind: 'gated'; proposalId: string; gate: GateAnswers; actor: string; at: string }
  | {
      formatVersion: 3
      kind: 'decided'
      proposalId: string
      decision: EvolutionDecision
      note?: string
      /**
       * Human-review evidence: the approval call id of the evolution_decide
       * request that granted this decision, the same `approval:<callId>` shape
       * as applied/rolledback. Required: `decide` writes it on both of its
       * paths, and the fold refuses a decided line without one.
       */
      approvalRef?: string
      actor: string
      at: string
    }
  | {
      formatVersion: 3
      kind: 'applied'
      proposalId: string
      /** Production write targets, for audit (absolute paths). */
      targets: string[]
      /** Human-review evidence: the approval call id of the evolution_apply request that granted this write. */
      approvalRef: string
      /**
       * The open commit intent this completion closes (K2): the
       * `commit_intent` line persisted before the write. Required — the fold
       * refuses a completion with no matching open intent.
       */
      intentId: string
      actor: string
      at: string
    }
  | {
      formatVersion: 3
      kind: 'rolledback'
      proposalId: string
      /** Production write targets of the rollback (restored champion or deleted product), for audit. */
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
  /**
   * The experiment family (S4-E §F.2): the two-sided skill evaluation's frozen
   * identity and its per-sample runs. These lines are not lifecycle transitions
   * — an experiment does not move a proposal's status — so the proposal fold
   * leaves them alone and {@link foldExperiments} folds them. Their records
   * carry the ledger's own `formatVersion: 3` as well; the experiment *report*
   * at `experiment-report.json` has its own, separate version field.
   */
  | ExperimentStartedRecord
  | ExperimentSampleRecord

/** Which way one commit moves a production target. */
export type CommitDirection = 'apply' | 'rollback'

/**
 * One `commit_intent` ledger line (K2): the durable "this apply/rollback is now
 * underway" record, written before production changes and closed by the
 * completion line that names the same `intentId`.
 *
 * It carries everything a recovery needs without trusting memory: which
 * proposal and direction, which human grant, the absolute production target, the
 * digest production must hold before the write (`baselineSha256`) and the digest
 * it must hold after (`contentSha256`), and the bytes to write again as a path
 * relative to the ledger root (`source`) — the candidate file for an apply, the
 * champion snapshot for a rollback. The id is derived, not chosen:
 * `<proposalId>/<direction>`.
 *
 * The line is not a lifecycle transition: it does not move the proposal's
 * status, so the proposal fold records it as {@link EvolutionProposal.openIntent}
 * and leaves the state machine alone. A proposal has at most one open intent,
 * and only one of them can close it (see the fold's admission rules).
 */
export interface CommitIntentRecord {
  /** The `proposals.jsonl` format version — the ledger is one format, `formatVersion: 3` (K2). */
  formatVersion: 3
  kind: 'commit_intent'
  /** `<proposalId>/<direction>` — the derived id the completion line must repeat. */
  intentId: string
  proposalId: string
  direction: CommitDirection
  /** The human grant that authorised this commit (`approval:<callId>`), recorded on the completion as well. */
  approvalRef: string
  /** The absolute production path this commit replaces. */
  target: string
  /** The digest production must hold before the write — the state a reconciliation redoes the write from. */
  baselineSha256: string
  /** The digest production must hold after the write. */
  contentSha256: string
  /** The recoverable bytes, relative to the ledger root. */
  source: string
  actor: string
  at: string
}

/** Folded view of one open `commit_intent` record, as {@link EvolutionProposal} exposes it. */
export interface CommitIntentView {
  intentId: string
  proposalId: string
  direction: CommitDirection
  approvalRef: string
  target: string
  baselineSha256: string
  contentSha256: string
  source: string
  actor: string
  at: string
}

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
   * Set only when this call found a commit intent already open for the proposal
   * and settled it instead of starting a new commit (K2): `redone` — production
   * still held the pre-commit state, so the same operation was carried out;
   * `written` — production already held the committed content (the write had
   * landed, its completion had not), so only the completion was recorded.
   * Absent on a fresh commit, and on a proposal with nothing open.
   */
  recovered?: 'redone' | 'written'
  /**
   * What the promotion check validated about the providers this apply put in
   * place ({@link PromotionCheck.providers}): the candidate skill of a skill
   * apply, with the role it may be counted as, so a knowledge or guidance
   * provider is reported as such rather than presented as the execution
   * provider it is not. Empty when the target carries no provider. Not
   * persisted: the ledger's `applied` record keeps its shape, and a run's own
   * binding is where a selected role is recorded for real. Absent when this
   * call settled an open intent: a recovery does not re-run the promotion gate
   * (the approval and the evidence it already rested on are on the ledger), so
   * it reports what it did and not a second provider verdict.
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
  /**
   * The commit intent this proposal has open (K2): a production write is
   * underway and its completion line has not been recorded. At most one at a
   * time. It does not move {@link status} — an interrupted apply is still
   * `decided`, an interrupted rollback still `applied` — which is exactly why a
   * retry can tell "nothing was committed yet" from "everything was".
   */
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
   * The harness repo root: the parent of the `$DSH_HOME` fallback
   * (`<repoRoot>/.dsh`) and the base relative evidence refs resolve against.
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
  /**
   * The typed test seam of the commit path (K2): it fires at each durable stage
   * of one commit — after the `commit_intent` line is on disk, after the new
   * bytes are staged and fsynced beside the production target but before the
   * rename, and after the rename has been read back and verified. Throwing from
   * it aborts the commit exactly where it stands: the intent stays open and no
   * later stage runs. That throw is an ordinary in-process exception, **not** a
   * process exit — `writeFileAtomic`'s own `catch` still removes the staging file
   * and the process keeps running — so it is a window-injection seam, and the
   * real exit (a killed process at one of those stages) is proven by the
   * nested-child cases in `tests/integration/k2-evolution-commit.spec.ts`. A
   * production deployment never sets it; there is no other way to observe or
   * interrupt a commit.
   */
  commitProbe?: (stage: CommitStage) => void
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

/**
 * Resolve `rel` under `base`, refusing anything that would land outside — the sandbox confinement belt.
 */
function resolveWithin(base: string, rel: string): string {
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) {
    throw new Error(`evolution: sandbox path "${rel}" escapes ${base}`)
  }
  return abs
}

/**
 * The directories a durable ledger append must fsync, in the order it fsyncs
 * them: the ledger root (the file's own entry), and — when the recursive `mkdir`
 * created directories — every directory between the root and the outermost one
 * it created, plus the parent that names that outermost directory. `mkdir` with
 * `recursive: true` returns exactly that outermost created directory (or
 * `undefined` when nothing was created), so walking up from the root always
 * reaches it: without this chain a power cut can take a freshly created ledger
 * directory, or a freshly created ledger file, while the write that referenced
 * it survives.
 */
function ledgerDirectories(root: string, created: string | undefined): readonly string[] {
  if (created === undefined) return [root]
  const directories: string[] = []
  for (let directory = root; ; directory = dirname(directory)) {
    directories.push(directory)
    if (directory === created) break
  }
  return [...directories, dirname(created)]
}

/**
 * The production skill target as it stands right now (P3): null when nothing
 * is there, otherwise the exact bytes plus their SHA-256. Read through the same
 * component walk as the ledger root (`walkVerified`, shared with the skill
 * sidecar loader in task-runtime), so a production path that became a
 * directory, or that is a symbolic link (the file itself or an ancestor), is a
 * conflict the caller refuses — never a silent follow. `relative` is the target
 * as a path under the skill root (`<name>/SKILL.md`); a commit's own target is
 * reduced to that shape before it is read here.
 */
async function readProductionSkill(skillRoot: string, relative: string): Promise<{ bytes: Buffer; sha256: string } | null> {
  const walked = await walkVerified(skillRoot, relative)
  if (walked.missing) return null
  const bytes = await readFile(walked.abs)
  return { bytes, sha256: sha256Hex(bytes) }
}

/** The production path of one skill's single file, as the executor writes and reads it. */
function productionSkillRelative(name: string): string {
  return join(name, 'SKILL.md')
}

/**
 * Validate a candidate's mutation. This build has exactly one candidate
 * mutation — the single-file `SKILL.md` replacement of §F.2 — so the schema is
 * the skill one and the only callers are the paths that already admitted a
 * skill candidate (the write path and the fold, which refuses a candidate of
 * any other target type first). A mutation of another target type has no
 * schema here, and is named rather than silently accepted: the old schemas
 * (agent_preset, capability, task_definition) and the bookkeeping-only default
 * belonged to a lifecycle this build no longer has.
 */
function validateMutation(
  targetType: ProposalTargetType,
  mutation: unknown,
): asserts mutation is Record<string, unknown> {
  if (!isRecord(mutation)) throw new Error('evolution: mutation must be an object')
  if (targetType !== 'skill') {
    throw new Error(
      `evolution: a "${targetType}" mutation has no schema in this build — the only candidate lifecycle here is a single-file ` +
      'SKILL.md replacement, and every other target type is a recorded proposal',
    )
  }
  assertOnlyKeys(mutation, ['name', 'content'], 'skill mutation')
  assertSegment(mutation.name, 'mutation.name')
  nonEmpty(mutation.content, 'mutation.content')
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
 * The state machine. A candidate is a mutation — this build's candidate is a
 * single-file `SKILL.md` replacement — so a candidate has exactly one next
 * state: `prepared` (sandbox materialization). There is no mutation-less
 * candidate and no direct candidate → gated arc: a proposal with nothing to
 * evaluate is a recorded proposal, not a flow.
 *
 * A prepared **skill** candidate gates straight from prepared: its evaluation is
 * the two-sided experiment (§F.2), which is recorded in the ledger's experiment
 * family and is deliberately *not* a lifecycle transition — the proposal stays
 * `prepared` while its samples run — so {@link EvolutionService.gate} requires
 * the completed experiment. The machine admits what the current entries write
 * and nothing else: `candidate` admits a skill candidate — this build's one
 * candidate type — and there is no other arc to take. After the human decision,
 * only a PROMOTE on an applyable, materialized, sub-L4 mutation can be applied
 * (W16), and only an applied proposal can be rolled back.
 */
function nextStates(proposal: EvolutionProposal): readonly EvolutionStatus[] {
  switch (proposal.status) {
    case 'proposed':
      return ['candidate']
    case 'candidate':
      return ['prepared']
    case 'prepared':
      // A skill candidate gates straight from prepared: its evaluation is the
      // experiment, which does not move the proposal.
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
  const hint = current.status === 'candidate'
    ? ' — record "prepared" first (evolution_prepare), the sandbox materialization this candidate\'s mutation needs'
    : current.status === 'decided' && kind === 'applied'
      ? current.decision !== 'PROMOTE'
        ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied`
        : ' — only a materialized skill mutation at L1–L3 applies in this build'
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
 * One format, one check (K2): every line this ledger reads, folds or writes
 * declares `formatVersion: 3`, and nothing else — no v1, no v2, no missing
 * version, no mix. The same refusal guards all three doors the record type
 * cannot guard on its own: the load (per line, naming the file and the line),
 * the {@link EvolutionService.append} funnel every lifecycle, commit and sample
 * write goes through, and {@link EvolutionService.recordExperimentStart}, which
 * folds the experiment family first and then appends through the same durable
 * append that funnel uses. A record that declares anything else is refused
 * before it is folded or written, and the caller's step is the persistence
 * contract's: archive the old ledger and start a new one.
 *
 * The version moved with the commit mechanism: a v2 ledger has no
 * `commit_intent` lines and its completions carry no `intentId`, so a write to
 * such a ledger could not be reconciled — reading one is refused instead of
 * appending beside it.
 *
 * `position` names the line or the record in the operator's own vocabulary
 * (e.g. `ledger line 3 in /…/proposals.jsonl`), so the message points at the
 * bytes that are wrong rather than at the entry that noticed them.
 */
function assertLedgerFormatVersion(record: { formatVersion?: unknown }, position: string): void {
  if (record.formatVersion === 3) return
  throw new Error(
    `evolution: ${position} declares formatVersion ${JSON.stringify(record.formatVersion ?? null)} — ` +
    'this build reads and writes formatVersion 3 only, so a v1, a v2, an unversioned or a mixed ledger is refused before any new ' +
    'record is appended (archive the old ledger and start a new one; no migration, no dual-format read and no older-record reader ' +
    'is offered, because a v2 ledger carries no commit intent for a production write to be reconciled against)',
  )
}

/**
 * Commit-intent payload validation, shared by the write path ({@link
 * EvolutionService.apply} / {@link EvolutionService.rollback} through
 * `commit.ts`) and the fold: every field a recovery needs is present, both
 * content identities are real SHA-256 hex, and the direction is one of the two
 * the commit path has. A hand-forged line fails exactly as a live append would.
 */
function validateCommitIntent(record: CommitIntentRecord): void {
  const nonEmptyFields = [
    ['proposalId', record.proposalId],
    ['intentId', record.intentId],
    ['approvalRef', record.approvalRef],
    ['target', record.target],
    ['source', record.source],
    ['actor', record.actor],
    ['at', record.at],
  ] as const
  for (const [field, value] of nonEmptyFields) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `evolution: commit_intent record for proposal "${String(record.proposalId)}" has no ${field} — an intent names the proposal, ` +
        'the direction, the human approval, the production target, both content identities, the bytes to write again and its actor, ' +
        'so a line missing any of them cannot be reconciled',
      )
    }
  }
  if (record.direction !== 'apply' && record.direction !== 'rollback') {
    throw new Error(
      `evolution: commit_intent record for proposal "${record.proposalId}" declares direction ${JSON.stringify(record.direction ?? null)} ` +
      '— a commit intent is "apply" or "rollback"',
    )
  }
  for (const [field, value] of [['baselineSha256', record.baselineSha256], ['contentSha256', record.contentSha256]] as const) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(
        `evolution: commit_intent record for proposal "${record.proposalId}" has no valid ${field} (${JSON.stringify(value ?? null)}) — ` +
        'an intent binds the exact bytes production must hold before the write and the exact bytes it must hold after',
      )
    }
  }
  if (record.target !== resolve(record.target)) {
    throw new Error(
      `evolution: commit_intent record for proposal "${record.proposalId}" names target "${record.target}" — an intent names the ` +
      'absolute production path it commits',
    )
  }
}

/**
 * The Evolution plane ledger (plane separation: this store is independent of
 * the task store and refers to it by id only). Folding and appending share one
 * fold, so a corrupt or out-of-order log fails loudly instead of silently
 * drifting. Writes are serialized, and every line is appended durably — the file
 * is opened for append, written, fsynced and closed per line, and the
 * directories that hold it are fsynced too — so closing the service is just
 * draining the write queue. Sandbox materialization is the only other write,
 * confined to `<root>/sandbox/<proposalId>/`.
 */
export class EvolutionService extends Service {
  /** Absolute ledger directory resolved at construction. */
  readonly root: string
  /** Production skill root — champion snapshots read from here; apply/rollback write here. */
  readonly skillRoot: string
  /** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
  readonly repoRoot: string
  /** The injected model-selection resolver, if the assembly wired one (see {@link Config.modelSelection}). */
  private readonly resolveModelSelection?: () => ModelSelection | undefined
  /** The commit path's typed test seam, if this instance was built with one (see {@link Config.commitProbe}). */
  private readonly commitProbe?: (stage: CommitStage) => void
  private records: EvolutionRecord[] = []
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private commits: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolution')
    // Explicitly configured, never derived here: see Config.repoRoot.
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.resolveModelSelection = config.modelSelection
    this.commitProbe = config.commitProbe
    const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, '.dsh')
    this.root = resolve(config.root ?? join(dshHome, 'evolution'))
    this.skillRoot = resolve(config.skillRoot ?? join(dshHome, 'skills'))
    this.loaded = this.load()
    ctx.effect(
      () => async () => {
        // Commits first: each one's appends are already queued behind them, so
        // draining the write chain afterwards is what makes the ledger complete.
        await this.commits
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
      formatVersion: 3,
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
   * aligns to and the structured patch it carries. `mutation` is required and
   * shaped by the proposal's targetType: a candidate the ledger cannot
   * materialize and evaluate is a flow going nowhere, so it is refused here,
   * before the first candidate line is written. A proposal whose mutation does
   * not survive {@link validateMutation} stays exactly as it was.
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
    mutation: unknown,
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
    validateMutation(current.targetType, mutation)
    await this.append({
      formatVersion: 3,
      kind: 'candidate',
      proposalId,
      versionSet: { ...versionSet },
      mutation: structuredClone(mutation),
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move candidate → prepared: confirm the production `SKILL.md` this candidate
   * replaces, materialize the skill mutation into `<root>/sandbox/<proposalId>/`
   * and snapshot those same champion bytes under `champion/` — the anchor for
   * the experiment's baseline and for rollback.
   *
   * The production read comes first, before any sandbox or ledger write: this
   * build replaces an existing single-file `SKILL.md`, so a target that is not
   * there has nothing to prepare, and a prepare that found none writes nothing
   * at all. That one read yields both the snapshot and `skillBaseline` (P3),
   * the digest the later apply compares the production target against.
   *
   * The candidate also records `skillContent` (P2): the name plus the SHA-256 of
   * the exact bytes of the file that was actually materialized (read back from
   * disk, never re-rendered from the mutation string), so the experiment, the
   * gates, and apply can verify this exact content later.
   */
  async prepare(proposalId: string, actor: string): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'prepared')
    // Every candidate the fold admits carries a validated mutation: `candidate`
    // refuses to write one without, and the fold re-runs the same
    // {@link validateMutation}, so there is no mutation-less candidate to guard
    // against here. The assert also narrows the view's `unknown` mutation.
    const mutation = current.mutation
    validateMutation(current.targetType, mutation)
    assertSegment(proposalId, 'proposalId')
    const { name } = mutation as unknown as SkillMutation
    // P3: one verified read of the production file, before anything is
    // written, yields the snapshot and the baseline digest together. A
    // production path that is a symlink or not a regular file fails here
    // instead of being followed, and a missing target is refused by name
    // rather than prepared against nothing.
    const production = await readProductionSkill(this.skillRoot, productionSkillRelative(name))
    if (production === null) {
      throw new Error(
        `evolution: the production skill "${join(this.skillRoot, name, 'SKILL.md')}" does not exist, so proposal ` +
        `"${proposalId}" has nothing to replace — this build prepares and promotes a replacement of an existing single-file ` +
        'SKILL.md only; a new skill cannot be evaluated or promoted by this path',
      )
    }
    const dir = join(this.root, 'sandbox', proposalId)
    const written = await this.materialize(dir, mutation, production)
    const sandbox = `sandbox/${proposalId}`
    const skillContent: SkillContentIdentity = {
      name,
      sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)),
    }
    await this.append({
      formatVersion: 3,
      kind: 'prepared',
      proposalId,
      sandbox,
      mechanical: true,
      champion: 'captured',
      skillBaseline: written.skillBaseline,
      skillContent,
      files: written.files,
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move prepared → gated: all six Gate answers plus regression evidence refs.
   * Every ref must exist — a path on disk (relative to the repo root or
   * absolute) or an id the caller-side resolver knows (task-store evidence).
   * Existence only; nothing here executes anything. A **skill** proposal must
   * have a completed two-sided experiment and cite that experiment's report
   * (§F.2); the six answers are recorded over it.
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
      formatVersion: 3,
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
      formatVersion: 3,
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
   * (W16), as one commit. Reachable only for a PROMOTE decision on a materialized
   * skill mutation at L1–L3 (the state machine itself refuses anything else —
   * every other target type has no executor in this build); the caller (the
   * evolution_apply tool) must hold a human grant from `ctx.approval.request`
   * first, exactly as for decide. The sandbox `SKILL.md` replaces the production
   * one (the champion snapshot covers that file only, so the write is
   * file-level, never a directory delete).
   *
   * The commit order is the recovery rule (K2): the `commit_intent` line is
   * persisted first — proposal, direction, this approval, the absolute target,
   * the content identity production must hold before (`prepared.skillBaseline`
   * P3) and after (`prepared.skillContent` P2), and the sandbox candidate as the
   * recoverable source — then the target is replaced atomically, then the
   * `applied` record closes the intent. A failure at any stage leaves the intent
   * open and nothing half-written: the production file is one complete version or
   * the other, and {@link reconcile} (or a retry of this call) settles the intent
   * from what production actually holds. Nothing here trusts a promise or a
   * caller-supplied "approved".
   *
   * A skill apply re-verifies the production baseline (P3) after the human
   * grant and before the intent is recorded: the production target must still be
   * the one prepare recorded. A direct service call therefore cannot bypass the
   * check the tool already ran before asking for approval.
   *
   * A fresh commit also refuses, before that baseline check, a production target
   * another proposal's open commit intent names
   * ({@link assertTargetUncommitted}): the serial queue spans one process, and
   * without the per-target gate the second of two proposals prepared against the
   * same bytes would read the version the first is still committing over, pass
   * its own baseline check and move the target.
   *
   * The promotion check (S1-C item 3) runs here too, before the intent is
   * recorded: a candidate whose provider role changed while the human was
   * deciding (a sidecar that appeared in the sandbox, a verifier that was
   * unregistered) is refused here, so no entry can write something a later
   * admission would have refused.
   *
   * When this proposal already has an open intent — the process died before the
   * completion landed — this call does not ask for another approval and does not
   * re-run the promotion gate: the recorded intent already binds the grant and
   * the content it was approved against, and the only question left is what
   * production holds. It settles that intent ({@link reconcile}, one intent) and
   * reports it as {@link ApplyOutcome.recovered}.
   */
  async apply(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    await this.assertNext(proposalId, 'applied')
    nonEmpty(approvalRef, 'approvalRef')
    return this.commitExclusive(async () => {
      const proposal = await this.get(proposalId)
      const open = proposal.openIntent
      if (open !== undefined) {
        if (open.direction !== 'apply') {
          throw new Error(
            `evolution: proposal "${proposalId}" has an open rollback commit intent ("${open.intentId}") — apply cannot complete a ` +
            'rollback; settle that intent (reconcile, or evolution_rollback) before applying anything',
          )
        }
        const recovered = await this.settleOpenIntent(open)
        return { targets: [open.target], recovered, proposal: await this.get(proposalId) }
      }
      this.assertTargetUncommitted(proposal)
      const promotion = await this.checkPromotion(proposalId)
      await this.checkProductionBaseline(proposalId)
      // P2: read the candidate once, verify the digest prepare recorded, and
      // commit exactly those verified bytes. A source replaced mid-apply cannot
      // reach production unverified — the whole commit refuses instead.
      const bytes = await this.readVerifiedSkillCandidate(proposal)
      await commitIntent(this.commitHost(), this.commitRequest(proposal, 'apply', actor, approvalRef), bytes)
      return { targets: [this.commitTarget(proposal)], providers: promotion.providers, proposal: await this.get(proposalId) }
    })
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
   * The boundary: the commit promotes a **single `SKILL.md`**, so a
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
   * The prepare-time baseline is a real regular file whose bytes still hash to
   * the digest prepare recorded. A file that changed, disappeared, changed type
   * (now a directory), or sits behind a symbolic link (the file itself or an
   * ancestor) is a conflict. Only `targetType: skill` carries a baseline; every
   * other targetType passes untouched.
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
      current = await readProductionSkill(this.skillRoot, productionSkillRelative(name))
    } catch (error) {
      throw new Error(
        `evolution: the production skill "${target}" is no longer a readable regular file ` +
        `(${(error as Error).message.replace(/^evolution: /, '')}) — ${guidance}`,
      )
    }
    const identity = prepared.skillBaseline
    if (identity === undefined) {
      // The fold requires the baseline on every prepared record, so this branch
      // is a belt for the view's optional field rather than a reachable state.
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" records no production baseline identity — ${guidance}`,
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
      // The fold requires both on every prepared record, so this branch is a
      // belt for the view's optional fields rather than a reachable state.
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — ` +
        'propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized SKILL.md)',
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
   * Move applied → rolledback: undo the apply by restoring the champion
   * `SKILL.md` snapshot taken at prepare, as one commit — the same intent →
   * atomic write → completion order as apply, so an interrupted rollback is
   * recoverable the same way. A record of another target type has no executor
   * here: this build writes and restores a single `SKILL.md` only, and an
   * applied capability row or preset directory is refused by name rather than
   * touched. Same approval discipline as apply: the tool asks a human first, the
   * service only executes and records.
   *
   * A rollback restores *this* proposal's baseline and nothing else, so both
   * ends are re-verified before the intent is recorded: production must still
   * carry exactly the content this proposal applied (`prepared.skillContent`,
   * P2), and the champion snapshot must still hash to the baseline prepare
   * recorded (`prepared.skillBaseline`, P3). A target a later proposal — or any
   * other writer — changed since is refused by name with nothing written, and so
   * is a snapshot that can no longer reproduce the bytes it captured: neither
   * may be papered over by restoring an old version on top of a newer one.
   *
   * As in {@link apply}, an open intent of this proposal is settled rather than
   * duplicated, and the result reports the recovery; an open intent of another
   * proposal that names the same target refuses this rollback by name before
   * anything is read or written ({@link assertTargetUncommitted}).
   */
  async rollback(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    await this.assertNext(proposalId, 'rolledback')
    nonEmpty(approvalRef, 'approvalRef')
    return this.commitExclusive(async () => {
      const proposal = await this.get(proposalId)
      const open = proposal.openIntent
      if (open !== undefined) {
        if (open.direction !== 'rollback') {
          throw new Error(
            `evolution: proposal "${proposalId}" has an open apply commit intent ("${open.intentId}") — rollback cannot complete an ` +
            'apply; settle that intent (reconcile, or evolution_apply) before rolling anything back',
          )
        }
        const recovered = await this.settleOpenIntent(open)
        return { targets: [open.target], recovered, proposal: await this.get(proposalId) }
      }
      this.assertTargetUncommitted(proposal)
      const request = this.commitRequest(proposal, 'rollback', actor, approvalRef)
      const prepared = proposal.prepared!
      const identity = prepared.skillContent!
      const current = await readProductionSkill(this.skillRoot, productionSkillRelative((proposal.mutation as SkillMutation).name))
      if (current === null || current.sha256 !== identity.sha256) {
        throw new Error(
          `evolution: the production skill "${request.target}" does not hold the content proposal "${proposalId}" applied ` +
          `(sha256 ${current?.sha256 ?? 'missing'} != ${identity.sha256}) — a rollback restores the baseline of the version this ` +
          'proposal applied, and a target another writer (or a later proposal) changed is left exactly as it is: nothing was written ' +
          'and no commit intent was recorded',
        )
      }
      const champion = await readVerifiedFile(this.root, request.source)
      const digest = sha256Hex(champion)
      if (digest !== prepared.skillBaseline!.sha256) {
        throw new Error(
          `evolution: the champion snapshot "${request.source}" of proposal "${proposalId}" no longer hashes to the production ` +
          `baseline recorded at prepare (sha256 ${digest} != ${prepared.skillBaseline!.sha256}) — the snapshot cannot restore the ` +
          'bytes it captured: nothing was written and no commit intent was recorded',
        )
      }
      await commitIntent(this.commitHost(), request, champion)
      return { targets: [request.target], proposal: await this.get(proposalId) }
    })
  }

  /**
   * Settle every open commit intent, in ledger order (K2) — the explicit startup
   * and resume entry. Nothing calls this implicitly: no read path, no `get` /
   * `list`, and no tool call reconciles as a side effect, so a query stays a
   * query and a deployment decides when a recovery is due.
   *
   * Each intent is settled by {@link settleOpenIntent} under the same serial
   * queue a fresh commit takes, and each outcome is reported by name:
   * `completed-redone` (production still held the pre-commit state, so the same
   * write was carried out), `completed-written` (production already held the
   * committed content, so only the completion was recorded) or `blocked` (a
   * source that is gone or changed, a target that holds neither state — the
   * intent stays open and nothing is overwritten). A blocked intent does not
   * throw: the rest of the batch is still settled, and the caller decides what a
   * human does about it. A real I/O failure of a redo write is not a blocked
   * commit and does throw.
   *
   * Repeating it is free: a settled intent has no open intent left, so the fold
   * refuses a second completion and this call reports nothing for it.
   */
  async reconcile(): Promise<ReconcileOutcome[]> {
    await this.loaded
    const outcomes: ReconcileOutcome[] = []
    for (const intent of this.openIntents(this.fold(this.records))) {
      const outcome = await this.commitExclusive(async () => {
        const open = this.fold(this.records).get(intent.proposalId)?.openIntent
        if (open === undefined || open.intentId !== intent.intentId) return undefined
        return reconcileIntent(this.commitHost(), open)
      })
      if (outcome !== undefined) outcomes.push(outcome)
    }
    return outcomes
  }

  /**
   * The production targets a commit has left open (K2), in ledger order — the
   * pure read an admission gate or a loader uses to see what must not be loaded
   * until a reconciliation settled it. It writes nothing, and it never
   * reconciles: settling is {@link reconcile}'s call to make, at the moment the
   * deployment decides recovery is due.
   */
  async openIntentTargets(): Promise<readonly string[]> {
    await this.loaded
    return this.openIntents(this.fold(this.records)).map(intent => intent.target)
  }

  /** Every commit intent still open, in ledger order — one per proposal at most, validated by the fold. */
  private openIntents(proposals: ReadonlyMap<string, EvolutionProposal>): CommitIntentView[] {
    const open: CommitIntentView[] = []
    const seen = new Set<string>()
    for (const record of this.records) {
      if (record.kind !== 'commit_intent') continue
      const intent = proposals.get(record.proposalId)?.openIntent
      if (intent === undefined || intent.intentId !== record.intentId || seen.has(intent.intentId)) continue
      seen.add(intent.intentId)
      open.push(intent)
    }
    return open
  }

  /**
   * Settle one open intent for a caller that named it (an apply/rollback retry),
   * where a blocked commit is the caller's answer and not a batch's footnote:
   * the named stop is thrown with the reason intact.
   */
  private async settleOpenIntent(intent: CommitIntentView): Promise<'redone' | 'written'> {
    const outcome = await reconcileIntent(this.commitHost(), intent)
    if (outcome.result === 'blocked') {
      throw new Error(outcome.detail ?? `evolution: commit intent "${intent.intentId}" cannot be settled`)
    }
    return outcome.result === 'completed-redone' ? 'redone' : 'written'
  }

  /**
   * The commit request one apply/rollback binds, read off the prepared record
   * the proposal already carries: the absolute target (the same path
   * {@link applyTargets} names to the human), the content identity production
   * must hold before and after, and the recoverable source under the ledger
   * root. `apply` commits the candidate over the recorded baseline; `rollback`
   * commits the champion snapshot over the content the apply installed — the two
   * digests swap, and nothing else about the two directions differs.
   */
  private commitRequest(
    proposal: EvolutionProposal,
    direction: CommitDirection,
    actor: string,
    approvalRef: string,
  ): CommitRequest {
    if (proposal.targetType !== 'skill') {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores a single ` +
        `SKILL.md only, so there is no executor to ${direction} an applied ${proposal.targetType} record`,
      )
    }
    const prepared = proposal.prepared
    const content = prepared?.skillContent
    const baseline = prepared?.skillBaseline
    if (prepared?.sandbox == null || prepared.champion !== 'captured' || proposal.mutation === undefined
      || content === undefined || baseline === undefined) {
      // The fold admits only a materialized skill prepare (sandbox, champion
      // snapshot, mutation and both identities present), so this is the belt
      // that narrows the view for the commit below rather than a reachable state.
      throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`)
    }
    const { name } = proposal.mutation as unknown as SkillMutation
    if (content.name !== name || baseline.name !== name) {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" records content identities for skill "${content.name}/${baseline.name}" but its ` +
        `mutation names "${name}" — the commit cannot write one skill's verified bytes onto another skill's target`,
      )
    }
    return direction === 'apply'
      ? {
          proposalId: proposal.proposalId,
          direction,
          approvalRef,
          target: this.commitTarget(proposal),
          baselineSha256: baseline.sha256,
          contentSha256: content.sha256,
          source: `${prepared.sandbox}/skills/${name}/SKILL.md`,
          actor,
        }
      : {
          proposalId: proposal.proposalId,
          direction,
          approvalRef,
          target: this.commitTarget(proposal),
          baselineSha256: content.sha256,
          contentSha256: baseline.sha256,
          source: `${prepared.sandbox}/champion/skills/${name}/SKILL.md`,
          actor,
        }
  }

  /** The one production path a commit of this proposal may write: `<skillRoot>/<name>/SKILL.md`, confined to the skill root. */
  private commitTarget(proposal: EvolutionProposal): string {
    return resolveWithin(this.skillRoot, productionSkillRelative((proposal.mutation as SkillMutation).name))
  }

  /**
   * A fresh commit of `proposal` refuses, by name, a production target another
   * proposal's open commit intent names. {@link commitExclusive} serializes one
   * process's commits and nothing else, so a second commit queued behind an
   * unfinished first one would read the pre-commit bytes, pass its own baseline
   * check and move the target, leaving the first intent with no commit path left
   * to settle it: `blocked` by name, its target refused by admission until
   * something restores the bytes that intent names as its baseline. The
   * per-target gate is what stops that. It is in-process, per production target
   * and under the deployment's existing single-writer constraint — not a
   * distributed lock, not a queue and not a retry loop; the intent is settled
   * first, by {@link reconcile} or by a retry of the proposal that owns it.
   *
   * Only a materialized skill mutation has a commit target this build may write:
   * every other proposal keeps the named refusal its own entry produces
   * ({@link checkPromotion}, {@link commitRequest}).
   */
  private assertTargetUncommitted(proposal: EvolutionProposal): void {
    if (proposal.targetType !== 'skill' || proposal.mutation === undefined) return
    const target = this.commitTarget(proposal)
    for (const other of this.fold(this.records).values()) {
      const intent = other.openIntent
      if (intent === undefined || other.proposalId === proposal.proposalId) continue
      if (resolve(intent.target) !== target) continue
      throw new Error(
        `evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction ` +
        `"${intent.direction}") names the production target "${target}" — proposal "${proposal.proposalId}" does not commit over ` +
        "another proposal's unsettled intent; settle that intent first (reconcile, or a retry of the proposal that owns it): " +
        'nothing was written and no commit intent was recorded',
      )
    }
  }

  /**
   * The narrow host the commit path runs on (see `commit.ts`): the roots a
   * target and a source resolve against, the service's own verified reads — P2
   * for a candidate, the walk-verified production read, the ledger-root read for
   * a snapshot — the append funnel every line goes through (format check, staged
   * fold, serialized write), and the probe seam. The commit path owns the order;
   * the service owns what may be read and what a line must say.
   */
  private commitHost(): CommitHost {
    return {
      root: this.root,
      skillRoot: this.skillRoot,
      append: record => this.append(record),
      readSource: async (source, sha256) => {
        const bytes = await readVerifiedFile(this.root, source)
        const digest = sha256Hex(bytes)
        if (digest !== sha256) {
          throw new Error(
            `the recorded source "${source}" no longer holds the committed bytes (sha256 ${digest} != ${sha256}); recorded ` +
            'identities are never re-digested',
          )
        }
        return bytes
      },
      readProduction: relative => readProductionSkill(this.skillRoot, relative),
      probe: stage => this.commitProbe?.(stage),
    }
  }

  /**
   * Serialize one commit — its intent, its production write and its completion —
   * behind every commit already running or queued, and behind every write the
   * ledger funnel has not appended yet. This is a single-process queue, not a
   * cross-process lock: the deployment's one-writer constraint still stands, and
   * a second process is not excluded. Serialization is not what keeps two
   * proposals on one target apart — a queued second commit would read the
   * pre-commit bytes and refuse only if its own baseline check happened to
   * disagree — so a fresh commit also refuses a target another proposal's open
   * intent names ({@link assertTargetUncommitted}).
   */
  private async commitExclusive<T>(run: () => Promise<T>): Promise<T> {
    const chained = this.commits.then(run)
    this.commits = chained.then(
      () => undefined,
      () => undefined,
    )
    return chained
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
   * snapshot from the production bytes the caller already read (P3: one read,
   * before anything was written — those bytes become the snapshot and the
   * recorded `skillBaseline` digest together, so the two can never describe two
   * different reads of the production file). Every path goes through
   * `resolveWithin`, so a write can never land outside the sandbox; the
   * production skill root is read-only here.
   */
  private async materialize(
    dir: string,
    mutation: Record<string, unknown>,
    production: { bytes: Buffer; sha256: string },
  ): Promise<{ files: string[]; skillBaseline: SkillContentIdentity }> {
    const files: string[] = []
    const write = async (rel: string, content: string | Buffer): Promise<void> => {
      const abs = resolveWithin(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
      files.push(rel)
    }
    // This build materializes a skill candidate and nothing else: `candidate`
    // admits no other target type, so there is no other arm to take.
    const { name, content } = mutation as unknown as SkillMutation
    await write(`skills/${name}/SKILL.md`, content)
    await write(`champion/skills/${name}/SKILL.md`, production.bytes)
    return { files, skillBaseline: { name, sha256: production.sha256 } }
  }

  /**
   * Fold records into proposals, enforcing the state machine on every step:
   * proposed starts a new id; each later kind must be exactly an allowed next
   * state, and payload-bearing kinds re-run the write path's payload
   * validation (candidate versionSet/mutation, gate answers, the
   * prepared/applied/rolledback shapes), so a hand-forged line fails
   * load exactly as it would fail append. The same rules guard folding and live
   * appends, so an illegal migration is rejected identically in both paths.
   *
   * The fold admits the shape the current entries write and nothing else (S4-E
   * 收尾): a candidate is a skill mutation, a prepared record carries both
   * content identities a prepare captured, and a decided record names the human
   * approval that granted it. A line missing any of them is refused here,
   * before any later entry can act on the state it would have folded to.
   *
   * Commit intents (K2) fold here too, because they are the one place where a
   * ledger line is judged against the *other* lines around it: a `commit_intent`
   * is admitted only for a proposal in the state its direction commits (`apply`
   * from decided, `rollback` from applied), only with the derived id
   * `<proposalId>/<direction>`, and only when the proposal has no other open
   * intent; an `applied`/`rolledback` completion is admitted only when it closes
   * the open intent of its own direction — same id, same approval, that exact
   * target — and it closes it. So a completion cannot be recorded without its
   * intent, cannot borrow another approval or another target, and cannot be
   * recorded twice: the second line has nothing left to close.
   *
   * The experiment family is not a lifecycle transition and is skipped here;
   * {@link foldLedger} folds it beside this fold.
   */
  private fold(records: readonly EvolutionRecord[]): Map<string, EvolutionProposal> {
    const proposals = new Map<string, EvolutionProposal>()
    for (const record of records) {
      if (isExperimentRecord(record)) continue
      if (record.kind === 'commit_intent') {
        const current = proposals.get(record.proposalId)
        if (current === undefined) throw new Error(`evolution: unknown proposal "${record.proposalId}"`)
        validateCommitIntent(record)
        const intent: CommitIntentView = {
          intentId: record.intentId,
          proposalId: record.proposalId,
          direction: record.direction,
          approvalRef: record.approvalRef,
          target: record.target,
          baselineSha256: record.baselineSha256,
          contentSha256: record.contentSha256,
          source: record.source,
          actor: record.actor,
          at: record.at,
        }
        if (record.intentId !== `${record.proposalId}/${record.direction}`) {
          throw new Error(
            `evolution: commit_intent record for "${record.proposalId}" names intentId "${record.intentId}" — an intent's id is ` +
            `"<proposalId>/<direction>", so this one is "${record.proposalId}/${record.direction}"`,
          )
        }
        if (current.openIntent !== undefined) {
          throw new Error(
            `evolution: proposal "${record.proposalId}" already has the open commit intent "${current.openIntent.intentId}" — one ` +
            `commit at a time: the intent for "${record.intentId}" is refused until that one is completed or settled`,
          )
        }
        const requiredStatus: EvolutionStatus = record.direction === 'apply' ? 'decided' : 'applied'
        if (current.status !== requiredStatus) {
          throw new Error(
            `evolution: commit_intent record "${record.intentId}" needs proposal "${record.proposalId}" to be ${requiredStatus} ` +
            `(it is ${current.status}) — an apply commits a decided proposal and a rollback an applied one`,
          )
        }
        current.openIntent = intent
        continue
      }
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
        case 'candidate': {
          // One candidate lifecycle (S4-E 收尾): a skill candidate carrying the
          // mutation this build materializes. A hand-forged line of another
          // target type, or without a mutation, has no next state here, so it
          // is refused where a live `candidate` call would refuse it.
          if (current.targetType !== 'skill') {
            throw new Error(
              `evolution: candidate record for "${record.proposalId}" targets "${current.targetType}" — this build's candidate ` +
              'lifecycle is a single-file SKILL.md replacement only, and no other target type has an evaluator here',
            )
          }
          validateVersionSet(record.versionSet)
          validateMutation(current.targetType, record.mutation)
          current.mutation = structuredClone(record.mutation)
          current.versionSet = { ...record.versionSet }
          break
        }
        case 'prepared': {
          // One prepared shape (S4-E 收尾): the materialized skill prepare, with
          // both content identities it captured. The bookkeeping-only prepare
          // (mechanical: false, no sandbox, no champion) belonged to target
          // types this build's candidate never admits, so it is refused here.
          if (record.mechanical !== true || record.champion !== 'captured'
            || typeof record.sandbox !== 'string' || record.sandbox.length === 0) {
            throw new Error(
              `evolution: prepared record for "${record.proposalId}" is not a materialized skill prepare ` +
              `(mechanical=${String(record.mechanical)}, champion=${JSON.stringify(record.champion ?? null)}, ` +
              `sandbox=${JSON.stringify(record.sandbox ?? null)}) — this build prepares a single-file SKILL.md replacement only`,
            )
          }
          if (!Array.isArray(record.files) || record.files.some(file => typeof file !== 'string')) {
            throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`)
          }
          // P2/P3, required (S4-E 收尾): a prepare without the candidate's
          // content identity or without the production baseline it read is a
          // prepare whose evidence cannot be re-proved, and no entry here writes
          // one.
          const skillContent = record.skillContent
          if (!isRecord(skillContent) || typeof skillContent.name !== 'string' || skillContent.name.length === 0
            || typeof skillContent.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(skillContent.sha256)) {
            throw new Error(
              `evolution: prepared record for "${record.proposalId}" has no valid skillContent identity — every prepare records the ` +
              'content identity of the materialized candidate SKILL.md',
            )
          }
          const skillBaseline = record.skillBaseline
          if (!isRecord(skillBaseline) || typeof skillBaseline.name !== 'string' || skillBaseline.name.length === 0
            || typeof skillBaseline.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(skillBaseline.sha256)) {
            throw new Error(
              `evolution: prepared record for "${record.proposalId}" has no valid skillBaseline identity — every prepare records the ` +
              'production baseline it read before materializing the candidate',
            )
          }
          current.prepared = {
            sandbox: record.sandbox,
            mechanical: true,
            champion: 'captured',
            skillContent: { name: skillContent.name, sha256: skillContent.sha256 },
            skillBaseline: { name: skillBaseline.name, sha256: skillBaseline.sha256 },
            files: [...record.files],
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
          // The human review is not optional (S4-E 收尾): `decide` writes the
          // approval call id of the request that granted the decision on both of
          // its paths — PROMOTE and REJECT — so a decided line without one is a
          // line no entry here writes.
          if (typeof record.approvalRef !== 'string' || record.approvalRef.length === 0) {
            throw new Error(
              `evolution: decided record for "${record.proposalId}" has no human-approval evidence ref — every decision this build ` +
              'records was granted through a human approval and carries that call id',
            )
          }
          current.decisionApprovalRef = record.approvalRef
          break
        case 'applied':
        case 'rolledback': {
          if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.some(target => typeof target !== 'string' || target.length === 0)) {
            throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list`)
          }
          if (typeof record.approvalRef !== 'string' || record.approvalRef.length === 0) {
            throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has no human-approval evidence ref`)
          }
          // K2: the completion closes the open intent of its own direction, and
          // only that one. Everything it claims — the intent id, the approval,
          // the exact target — must be the intent's, so a completion can never
          // describe a grant or a path the recorded commit never named.
          if (typeof record.intentId !== 'string' || record.intentId.length === 0) {
            throw new Error(
              `evolution: ${record.kind} record for "${record.proposalId}" names no commit intent — every completion this build ` +
              'writes closes the `commit_intent` line its commit persisted before the write, and carries that intentId',
            )
          }
          const open = current.openIntent
          const expectedDirection: CommitDirection = record.kind === 'applied' ? 'apply' : 'rollback'
          if (open === undefined) {
            throw new Error(
              `evolution: ${record.kind} record for "${record.proposalId}" closes no open commit intent — a production write is ` +
              `recorded as one commit (commit_intent first, the atomic write, then ${record.kind}), so a completion with no matching ` +
              'open intent is refused',
            )
          }
          if (open.direction !== expectedDirection || open.intentId !== record.intentId) {
            throw new Error(
              `evolution: ${record.kind} record for "${record.proposalId}" names commit intent "${record.intentId}", but the open ` +
              `intent of that proposal is "${open.intentId}" (${open.direction}) — a ${expectedDirection} completion closes its own ` +
              `${expectedDirection} intent and nothing else`,
            )
          }
          if (record.approvalRef !== open.approvalRef) {
            throw new Error(
              `evolution: ${record.kind} record for "${record.proposalId}" carries approval ${JSON.stringify(record.approvalRef)}, not ` +
              `the approval the open intent "${open.intentId}" recorded (${JSON.stringify(open.approvalRef)}) — the completion is ` +
              'written for the grant the commit was authorised by, never a second one',
            )
          }
          if (record.targets.length !== 1 || record.targets[0] !== open.target) {
            throw new Error(
              `evolution: ${record.kind} record for "${record.proposalId}" names targets ${JSON.stringify(record.targets)}, but the ` +
              `open intent "${open.intentId}" commits ${JSON.stringify([open.target])} — a completion records the exact target its ` +
              'intent committed',
            )
          }
          current[record.kind] = { targets: [...record.targets], approvalRef: record.approvalRef }
          current.openIntent = undefined
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
    // One format, one check (K2): the ledger is `formatVersion: 3`, and every
    // line must say so. A v1, a v2, an unversioned or a mixed ledger is refused
    // here — at load, before any entry can append — naming the line and the
    // version it saw. There is no dual-format read, no online migration and no
    // fallback helper.
    for (const [index, record] of records.entries()) {
      assertLedgerFormatVersion(record, `ledger line ${index + 1} in ${this.file}`)
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

  /**
   * Validate the staged fold first; memory commits only once the line's bytes
   * have reached the file. The format check runs before the fold, so a record
   * declaring another version is refused before it can be folded — and, because
   * nothing is written until the fold has accepted the staged ledger, before a
   * byte changes on disk. The line itself goes through
   * {@link appendLedgerLine}, the ledger's one durable append.
   */
  private async append(record: EvolutionRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      assertLedgerFormatVersion(record, `the ${record.kind} record for proposal "${record.proposalId}"`)
      this.foldLedger([...this.records, record])
      await this.appendLedgerLine(record, () => {
        this.records = [...this.records, record]
      })
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /**
   * The ledger's one durable write path: append one whole line and make it
   * durable before returning — `open` for append, write the entire line, `fsync`
   * the file, close, and then `fsync` the ledger root together with every
   * directory the recursive `mkdir` just created (plus the parent that names the
   * outermost of them), so neither a freshly created ledger file nor a freshly
   * created ledger directory can be lost by a power cut while the write that
   * referenced it survives. {@link append} and {@link recordExperimentStart} both
   * come through here, so nothing writes the ledger beside this method — the
   * funnel every lifecycle, commit and sample line takes is also the funnel that
   * makes it durable.
   *
   * The line goes out through `writeFile`, not a single `write`: `writeFile`
   * writes the whole payload in as many calls as that takes (the behaviour
   * `appendFile` had), so a filesystem that accepts only part of the payload in
   * one call cannot leave a truncated JSON line behind — a fragment would be
   * fsynced as if it were the record, and the ledger would no longer load.
   *
   * `adopt` runs exactly once, immediately after the whole line reaches the
   * file: from that moment the caller's in-memory ledger holds the record the
   * file holds, so a later call in this process sees the line it is really
   * looking at instead of appending a second one.
   *
   * What a failure leaves behind, step by step:
   *
   * - the directory could not be created or the file could not be opened —
   *   nothing was written: the file is byte-identical to what it held and memory
   *   is untouched;
   * - the write failed — a mid-write failure (a full disk, an I/O error) can have
   *   put part of the line in the file before it reported, so the file is
   *   truncated back to the size it had before this call: a fragment is never
   *   left for the next load to refuse the whole ledger over, and memory stays
   *   untouched. If even that truncate fails, the error says so and says the
   *   ledger may hold a partial line — it never pretends the file is clean;
   * - the file's or a directory's fsync failed — the *whole* line is in the file
   *   (and adopted in memory) but is not durable: a named error naming the ledger
   *   path and the failed step, because the caller must not continue as if the
   *   write the line would justify had happened.
   */
  private async appendLedgerLine(record: EvolutionRecord, adopt: () => void): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const step = `the ${record.kind} record for proposal "${record.proposalId}"`
    const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
    let created: string | undefined
    try {
      created = await mkdir(this.root, { recursive: true })
    } catch (error) {
      throw new Error(
        `evolution: the ledger directory ${this.root} could not be created (${reason(error)}) — ${step} is not written and not ` +
        'durable, so nothing may depend on it',
      )
    }
    let handle: FileHandle | undefined
    try {
      try {
        handle = await open(this.file, 'a')
      } catch (error) {
        throw new Error(
          `evolution: the ledger file ${this.file} could not be opened for append (${reason(error)}) — ${step} is not written: the line ` +
          'is not durable and nothing may depend on it',
        )
      }
      // The length this append starts from: a write that fails part-way is rolled
      // back to it, so a fragment never survives into the ledger.
      let length: number
      try {
        length = (await handle.stat()).size
      } catch (error) {
        throw new Error(
          `evolution: the ledger file ${this.file} could not be measured before appending ${step} (${reason(error)}) — the line is not ` +
          'written and nothing may depend on it',
        )
      }
      try {
        await handle.writeFile(line, 'utf8')
        adopt()
      } catch (error) {
        try {
          await handle.truncate(length)
        } catch (restore) {
          throw new Error(
            `evolution: ${step} could not be written to the ledger ${this.file} (${reason(error)}) and the file could not be truncated ` +
            `back to the ${length} bytes it held before this call (${reason(restore)}) — the ledger may hold a partial line no record ` +
            'explains; the line is not durable, so nothing may depend on it and no write it would have justified may proceed',
          )
        }
        throw new Error(
          `evolution: ${step} could not be written to the ledger ${this.file} (${reason(error)}) — the ledger is back to the ${length} ` +
          'bytes it held before this call, so no fragment was left behind; the line is not durable and nothing may depend on it, so no ' +
          'write it would have justified may proceed',
        )
      }
      try {
        await handle.sync()
      } catch (error) {
        throw new Error(
          `evolution: ${step} was written to the ledger ${this.file} but could not be fsynced (${reason(error)}) — the line is not ` +
          'durable, so nothing may depend on it and no write it would have justified may proceed',
        )
      }
    } finally {
      await handle?.close().catch(() => {})
    }
    for (const directory of ledgerDirectories(this.root, created)) {
      try {
        await syncDirectory(directory)
      } catch (error) {
        throw new Error(
          `evolution: the ledger directory ${directory} could not be fsynced after appending ${step} to ${this.file} ` +
          `(${reason(error)}) — whether the line survives a power cut is unknown, so it must not be treated as durable`,
        )
      }
    }
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
      // One format at this door too, before anything is decided about the
      // record — and before the idempotent return below: a v1 line that repeats
      // an experiment's identity must be refused, not silently accepted as the
      // repeat of what the ledger already holds.
      assertLedgerFormatVersion(record, `the experiment_started record for "${record.experimentId}"`)
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
      // The same durable append the lifecycle funnel uses: this is the ledger's
      // second (and only other) write door, and it writes through the one path.
      await this.appendLedgerLine(record, () => {
        this.records = staged
      })
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

/**
 * Evolution admission track (guide §2.7.6/§2.7.7): an append-only ledger of
 * EvolutionProposals with the state machine proposed → candidate → prepared →
 * gated → decided. Every candidate carries a structured mutation, and `prepared`
 * is the one state it admits: evolution_prepare reads the production skill
 * object it replaces once, before any write, and materializes the mutation into
 * the per-proposal sandbox (`<root>/sandbox/<proposalId>/`) plus a champion
 * snapshot of those same bytes. A prepare whose production target is not there
 * has nothing to replace and is refused before any sandbox or ledger write. A
 * **skill** candidate — the only candidate this build admits — is then evaluated
 * by the two-sided experiment of §F.2 (`evolution_replay`), recorded in the
 * ledger's experiment family and re-read by the promotion gate; the experiment
 * is evidence, not a lifecycle transition, so a skill proposal gates from
 * prepared.
 *
 * The unit a candidate replaces is a whole skill **object** (K3), and an object
 * is a fixed shape: guidance is one file (`SKILL.md`), and an execution provider
 * is two (`SKILL.md` plus the `SKILL.contract.json` beside it), with
 * `content.resources` empty. Everything else is refused by name at prepare —
 * a knowledge sidecar, declared resources, a broken declaration, a directory
 * whose bytes do not match what it declares — because a candidate that silently
 * drops a file would not be the object production is asked to load. An execution
 * object's sidecar is never authored by the model: the model submits the new
 * `SKILL.md` text, and the sidecar is the production declaration with exactly
 * `content.skillMdSha256` replaced, so a content update can never move a
 * capability, a required tool, a verifier or a port.
 *
 * `evolution_propose` and a Diagnosis may still record any targetType as a
 * suggestion, but a suggestion never becomes a candidate: `candidate` refuses
 * every non-skill targetType by name, and a capability, agent_preset,
 * task_definition or bookkeeping-only proposal therefore stays `proposed`
 * forever (§F.2; A6 introduces the capability evaluation beside this one).
 *
 * Only a **skill** PROMOTE is promotable in this build: `checkPromotion` refuses
 * every other target type by name, because this build's evaluator — the
 * two-sided experiment — evaluates a replacement of an existing loadable skill
 * object and nothing else (§F.2: "没有支持的评估器就拒绝新晋升"; a historical
 * report is never upgraded into new evidence).
 *
 * The ledger is one format, `formatVersion: 4` (K3): every line a current
 * entry writes carries it, {@link EvolutionService} refuses a v1, a v2, an
 * unversioned or a mixed ledger at load, naming the line and the version it saw,
 * and every write door — the append funnel and the experiment start — refuses a
 * record declaring anything else before a byte changes. There is no dual-format
 * reader, no online migration and no fallback helper: an older ledger is archived
 * by the operator and a new one started (the persistence contract's own deployment
 * step), never migrated or read beside v4 lines.
 *
 * PROMOTE takes effect through `evolution_apply` (W16): the candidate object is
 * copied from the sandbox into production — decided → applied → (optionally)
 * rolledback — each transition only after its own human approval granted through
 * the native approval seam (done by the tools, not here). L4 proposals and every
 * non-skill target type never apply: the ledger records their suggestions
 * without granting an executor in this build.
 *
 * A production write is one **commit** (K2), and the commit is durable before it
 * is effective: an `apply`/`rollback` persists a `commit_intent` line binding the
 * proposal, the direction, the human grant, and the object's **whole fixed file
 * set** — every absolute target, the content identity production must hold before
 * and after that file, and a recoverable byte source under the ledger root; then
 * each target is replaced atomically (a same-directory temp file, fsynced and
 * renamed over it — never truncated), in the intent's own order; then, once every
 * rename has been read back and the whole directory has been verified as one
 * loadable object carrying this direction's identity, the completion line
 * (`applied`/`rolledback`, carrying the same `intentId`) closes the intent at the
 * fold. Each of those facts is durable before the next one depends on it: every
 * source is confined to the ledger root, re-verified and fsynced (the file and
 * the directories holding it) *before* the intent that names it is appended, and
 * every ledger line — the intent, the completion and every lifecycle record —
 * goes through the service's one durable append (write, `fsync` the file,
 * `fsync` the directories that hold it), because a line that can be lost while
 * the write it justified survives is exactly the ledger a recovery cannot
 * reconcile. A completion with no matching open intent is refused, so the intent
 * cannot be skipped, and a crash between any two of those writes — including
 * between the two files of one object, where production holds a `SKILL.md` its
 * on-disk declaration no longer covers — leaves exactly one open intent for
 * {@link EvolutionService.reconcile} — the explicit startup or resume entry — to
 * settle: the same operation is redone when production still holds the pre-commit
 * state, the files already carrying the committed content have their durability
 * re-established, only the completion is recorded when production already holds
 * the committed content everywhere, and anything else (a source that is gone, a
 * file a third party rewrote or removed) stops by name with the intent left open
 * and nothing overwritten. Reconciliations and fresh commits share one serial
 * queue inside the service (single-process deployment: no distributed lock, no
 * background retry queue); because that queue spans one process only, a fresh
 * commit additionally refuses by name any production *directory* another
 * proposal's open intent touches — one intent covers a directory's fixed file set
 * together, so a target naming either file refuses the whole object — and never
 * moves a target out from under an unfinished one.
 * {@link EvolutionService.openIntentTargets} is the pure read a loader or
 * admission gate uses to see which production files a commit still has open (all
 * files of every open intent, flattened).
 *
 * Skill candidates additionally carry a content identity (P2) of the whole
 * object: prepare records the SHA-256 of the exact bytes of the materialized
 * `skills/<name>/SKILL.md` — plus, when the object has an execution sidecar, the
 * exact-byte SHA-256 and the canonical `contractDigest` of the materialized
 * `skills/<name>/SKILL.contract.json` — the experiment's frozen block must carry
 * the same identity, and the experiment's pre-run check, every promotion gate,
 * and the apply write re-read and re-verify those files, including that the
 * sidecar is present exactly when the identity says it is — so the chain cannot
 * validate one file's content and apply another's, and cannot validate a
 * guidance object and install an execution one. Identity is not functional
 * correctness, and it binds skill candidates only.
 *
 * A skill promotion additionally pins the production baseline (P3): prepare
 * records the identity of the production object — both files, from the same
 * single read that produced the champion snapshot — and the apply seams (the
 * tool's pre-approval precheck and the service entry immediately before the
 * production write) re-read those files and refuse unless they still match, a
 * sidecar that appeared where the baseline had none included. A candidate
 * prepared against a production object that has since changed, disappeared,
 * changed type, or moved behind a symbolic link is a conflict: nothing is
 * written, no `applied` record is taken, and the caller is pointed at a new
 * candidate evaluated against the new production state. The guarantee covers
 * serial single-process calls and external changes between two calls — it is not
 * a cross-process lock and does not make apply atomic against a writer that
 * writes concurrently with it.
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
 * execution closure itself stays a property of the capability table. Beside the
 * validator, the same precheck holds the candidate to the shape the prepared
 * identity fixed — exactly `SKILL.md`, plus `SKILL.contract.json` when and only
 * when the object has an execution sidecar — and re-derives the sidecar from the
 * champion's own bytes plus the candidate `SKILL.md` digest, so a declaration
 * that moved under the candidate's feet (an escalated `requiredTools`, a
 * different verifier) is refused by name rather than promoted.
 *
 * The evidence gate beside it (`assertSkillPromotionEvidence`, §F.2) re-reads
 * the proposal's newest experiment: a completed two-sided experiment whose
 * report the ledger's own records recompute to, whose sides are runs of that
 * experiment's lineage in the task store, whose frozen contracts, protected
 * inputs, judge versions and model selection still hold, whose verdict is `fixed`
 * and whose cost is known whenever the frozen budget declares a ceiling. All of
 * it is reads, and every condition is a named refusal.
 *
 * What a skill promotion promotes is that fixed file set and nothing else: the
 * commit writes the candidate's `SKILL.md` and, for an execution object, the
 * derived `SKILL.contract.json`; a sandbox directory carrying any other entry —
 * a `references/` or `scripts/` tree, a stray file — is refused by name at the
 * same precheck. That is a stated boundary of this executor, not a defect hidden
 * behind it: resources are outside this ticket, so an object that needs them is
 * refused before a human is asked rather than promoted with its resources
 * silently dropped.
 * @module dsh-singularity-evolution
 */

import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
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
  serializeSkillSidecar,
  sidecarWithSkillMd,
  SKILL_SIDECAR_FILE,
  skillContractDigest,
  unlistableVerifierRefusal,
  validateSkillProvider,
  walkVerified,
} from '@dangosys/dsh-singularity-task-runtime'
import type {
  CapabilityToolQuery,
  SkillProviderCandidate,
  SkillProviderVerdict,
  SkillSidecar,
} from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { SkillContentIdentity } from './replay.ts'
import { canonicalJson, modelSelectionOf } from './replay.ts'
import type { ModelSelection } from './replay.ts'
import type { CommitFile, CommitHost, CommitRequest, CommitStage, ReconcileOutcome } from './commit.ts'
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

/**
 * The skill mutation: the full `SKILL.md` text for
 * `<skills root>/<name>/SKILL.md`. It is the whole input a candidate may submit
 * — the object's other fixed file, when it has one, is derived from production
 * at prepare rather than authored here, so a mutation can only ever change the
 * text a worker reads and never the declaration that authorises it.
 */
export interface SkillMutation {
  name: string
  content: string
}

/**
 * The champion snapshot of one prepared proposal. `captured` is the only state
 * there is: this build replaces an existing production skill object, so a target
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
  /**
   * The content identity recorded for the materialized candidate object (P2) —
   * the `SKILL.md`, plus the derived `SKILL.contract.json` when the object
   * carries an execution sidecar. Every prepare records it.
   */
  skillContent?: SkillContentIdentity
  /**
   * The content identity of the production object as it stood at prepare (P3) —
   * the same files, read once before anything was written, so the champion
   * snapshot and the identity can never describe two different reads. Every
   * prepare records it; a captured champion without it cannot prove its baseline
   * and refuses a new apply. Its `contract` presence matches `skillContent`'s:
   * the object's shape is fixed at prepare, and a record whose two halves
   * disagree describes a role change no prepare performs.
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
 * One immutable ledger line, `formatVersion: 4` throughout (K3). A state
 * migration appends a new record; nothing is ever rewritten in place. The
 * version is the whole ledger's, not one line's: a line declaring anything but
 * 4 — or declaring nothing — makes the ledger refuse to load, and no entry here
 * writes one.
 */
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
      /**
       * The structured patch description, shaped by the proposal's targetType
       * (see the *Mutation interfaces) and always recorded: this build's
       * candidate is a `SKILL.md` replacement of an existing skill object, so a
       * candidate that carries nothing to materialize and evaluate would be a
       * flow going nowhere. Every line `candidate` writes holds one; a line
       * written before that rule (or by hand) folds to a candidate with no next
       * state, because `prepared` is the one transition a candidate admits.
       */
      mutation: unknown
      actor: string
      at: string
    }
  | {
      formatVersion: 4
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
  | { formatVersion: 4; kind: 'gated'; proposalId: string; gate: GateAnswers; actor: string; at: string }
  | {
      formatVersion: 4
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
      formatVersion: 4
      kind: 'applied'
      proposalId: string
      /** Production write targets, in commit order — the whole file set of the object this apply wrote (absolute paths). */
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
  /**
   * The experiment family (S4-E §F.2): the two-sided skill evaluation's frozen
   * identity and its per-sample runs. These lines are not lifecycle transitions
   * — an experiment does not move a proposal's status — so the proposal fold
   * leaves them alone and {@link foldExperiments} folds them. Their records
   * carry the ledger's own `formatVersion: 4` as well; the experiment *report*
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
 * proposal and direction, which human grant, and the object's **whole fixed file
 * set** ({@link CommitFile}, one or two entries, in commit order) — for every
 * file its absolute production target, the digest that file must hold before the
 * write (`baselineSha256`), the digest it must hold after (`contentSha256`), and
 * the bytes to write again as a path relative to the ledger root (`source`: the
 * candidate file for an apply, the champion snapshot for a rollback). The id is
 * derived, not chosen: `<proposalId>/<direction>`.
 *
 * The line is not a lifecycle transition: it does not move the proposal's
 * status, so the proposal fold records it as {@link EvolutionProposal.openIntent}
 * and leaves the state machine alone. A proposal has at most one open intent,
 * and only one of them can close it (see the fold's admission rules).
 */
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
  /** The object's fixed files, in commit order — `SKILL.md` first, the `SKILL.contract.json` second when the object carries an execution sidecar. */
  files: CommitFile[]
  actor: string
  at: string
}

/** Folded view of one open `commit_intent` record, as {@link EvolutionProposal} exposes it. */
export interface CommitIntentView {
  intentId: string
  proposalId: string
  direction: CommitDirection
  approvalRef: string
  /** The object's fixed files, in commit order; one or two entries (see {@link CommitIntentRecord.files}). */
  files: CommitFile[]
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
   * The typed test seam of the commit path (K2, per-file since K3): it fires at
   * each durable stage of one commit — after the `commit_intent` line is on disk
   * (`intent-recorded`); after the new bytes of one file are staged and fsynced
   * beside its production target but before the rename, and after that rename
   * has been read back and verified (`write-staged` / `write-renamed`, each
   * carrying the file's target, so a caller can open the window *between* the
   * two files of one object as well as inside one file's write); and after every
   * file is written and the whole object has passed the service's own
   * loadability-and-identity re-read, with only the completion line left
   * (`commit-verified`). Throwing from it aborts the commit exactly where it
   * stands: the intent stays open and no later stage runs. That throw is an
   * ordinary in-process exception, **not** a process exit — `writeFileAtomic`'s
   * own `catch` still removes the staging file it had written and the process
   * keeps running — so it is a window-injection seam, and the real exit (a
   * killed process at one of those stages) is proven by the nested-child cases
   * in `tests/integration/k2-evolution-commit.spec.ts`. A production deployment
   * never sets it; there is no other way to observe or interrupt a commit.
   */
  commitProbe?: (stage: CommitStage, target?: string) => void
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

/** The production path of one skill object's `SKILL.md`, as the executor writes and reads it. */
function productionSkillRelative(name: string): string {
  return join(name, 'SKILL.md')
}

/** The production path of one skill object's sidecar file, beside the `SKILL.md`. */
function productionSidecarRelative(name: string): string {
  return join(name, SKILL_SIDECAR_FILE)
}

/**
 * One skill object's declared sidecar, parsed from the exact bytes that were
 * read — the same bytes its identity covers. Callers only reach this with bytes
 * the loader has already accepted as a text JSON declaration, so the parse is a
 * reading of what was verified, not a second guess at it.
 */
function loadedSidecar(bytes: Buffer): SkillSidecar {
  return JSON.parse(bytes.toString('utf8')) as SkillSidecar
}

/**
 * The candidate sidecar of one execution object: the production declaration with
 * exactly `content.skillMdSha256` replaced by the candidate `SKILL.md` digest,
 * serialized deterministically. This is the one place a candidate object gains
 * its second file, and it is a *derivation*, never an authored patch: the
 * capabilities, ports, required tools, verifier and (empty) resource list are
 * the production object's, so a content update cannot escalate a declaration —
 * the derivation consistency check at promotion re-derives the same bytes from
 * the champion snapshot and refuses any candidate whose sidecar disagrees.
 */
function candidateSidecar(production: SkillSidecar, skillMdSha256: string): string {
  return serializeSkillSidecar(sidecarWithSkillMd(production, skillMdSha256))
}

/**
 * Fold a sidecar's declared data into a {@link SkillContractIdentity}: the exact
 * bytes' SHA-256 and the canonical declaration digest a registry revision and a
 * run binding use. Both come from the same bytes, so an identity is never
 * assembled from two different reads.
 */
function contractIdentityOf(bytes: Buffer): { sha256: string; contractDigest: string } {
  return { sha256: sha256Hex(bytes), contractDigest: skillContractDigest(loadedSidecar(bytes)) }
}

/**
 * Validate a candidate's mutation. This build has exactly one candidate
 * mutation — the `SKILL.md` text replacing an existing skill object's own
 * (§F.2) — so the schema is the skill one and the only callers are the paths
 * that already admitted a skill candidate (the write path and the fold, which
 * refuses a candidate of any other target type first). A mutation of another
 * target type has no schema here, and is named rather than silently accepted:
 * the old schemas (agent_preset, capability, task_definition) and the
 * bookkeeping-only default belonged to a lifecycle this build no longer has.
 * The unknown key check is the "no sidecar patch" rule: the model submits
 * `{ name, content }` and nothing else, and a sidecar is derived at prepare
 * rather than accepted here.
 */
function validateMutation(
  targetType: ProposalTargetType,
  mutation: unknown,
): asserts mutation is Record<string, unknown> {
  if (!isRecord(mutation)) throw new Error('evolution: mutation must be an object')
  if (targetType !== 'skill') {
    throw new Error(
      `evolution: a "${targetType}" mutation has no schema in this build — the only candidate lifecycle here is a ` +
      'SKILL.md replacement of an existing skill object, and every other target type is a recorded proposal',
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
 * `SKILL.md` replacement of an existing skill object — so a candidate has
 * exactly one next state: `prepared` (sandbox materialization). There is no
 * mutation-less candidate and no direct candidate → gated arc: a proposal with
 * nothing to evaluate is a recorded proposal, not a flow.
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
 * grant will touch. The object's fixed file set: the candidate's `SKILL.md`,
 * plus the `SKILL.contract.json` beside it when the prepared object carries an
 * execution sidecar — one or two paths, in commit order.
 */
export function applyTargets(
  proposal: EvolutionProposal,
  roots: { skillRoot: string },
): string[] {
  if (proposal.targetType !== 'skill') return []
  const name = (proposal.mutation as SkillMutation).name
  const files = [join(roots.skillRoot, name, 'SKILL.md')]
  if (proposal.prepared?.skillContent?.contract !== undefined) {
    files.push(join(roots.skillRoot, name, SKILL_SIDECAR_FILE))
  }
  return files
}

/**
 * One format, one check (K3): every line this ledger reads, folds or writes
 * declares `formatVersion: 4`, and nothing else — no v1, no v2, no v3, no
 * missing version, no mix. The same refusal guards all three doors the record
 * type cannot guard on its own: the load (per line, naming the file and the
 * line), the {@link EvolutionService.append} funnel every lifecycle, commit and
 * sample write goes through, and
 * {@link EvolutionService.recordExperimentStart}, which folds the experiment
 * family first and then appends through the same durable append that funnel
 * uses. A record that declares anything else is refused before it is folded or
 * written, and the caller's step is the persistence contract's: archive the old
 * ledger and start a new one.
 *
 * The version moved with the object a commit covers: a v3 ledger records one
 * file per intent (`target`, `baselineSha256`, `contentSha256`, `source`) and a
 * prepare's identity without a sidecar half, so it cannot describe a two-file
 * commit and a write beside it could not be reconciled — reading one is refused
 * instead of appending beside it.
 *
 * `position` names the line or the record in the operator's own vocabulary
 * (e.g. `ledger line 3 in /…/proposals.jsonl`), so the message points at the
 * bytes that are wrong rather than at the entry that noticed them.
 */
function assertLedgerFormatVersion(record: { formatVersion?: unknown }, position: string): void {
  if (record.formatVersion === 4) return
  throw new Error(
    `evolution: ${position} declares formatVersion ${JSON.stringify(record.formatVersion ?? null)} — ` +
    'this build reads and writes formatVersion 4 only, so a v1, a v2, a v3, an unversioned or a mixed ledger is refused before any ' +
    'new record is appended (archive the old ledger and start a new one; no migration, no dual-format read and no older-record reader ' +
    'is offered, because a ledger written before v4 records one file per commit intent and no sidecar half in a prepare identity, so ' +
    'a two-file commit against it could not be reconciled)',
  )
}

/**
 * Commit-intent payload validation, shared by the write path ({@link
 * EvolutionService.apply} / {@link EvolutionService.rollback} through
 * `commit.ts`) and the fold: every field a recovery needs is present, the file
 * set has the fixed shape of one skill object (one or two entries, in commit
 * order: `SKILL.md` first, the `SKILL.contract.json` of the same directory
 * second when there is one), every digest is real SHA-256 hex, every target is
 * absolute, and the direction is one of the two the commit path has. A
 * hand-forged line fails exactly as a live append would.
 */
function validateCommitIntent(record: CommitIntentRecord): void {
  const nonEmptyFields = [
    ['proposalId', record.proposalId],
    ['intentId', record.intentId],
    ['approvalRef', record.approvalRef],
    ['actor', record.actor],
    ['at', record.at],
  ] as const
  for (const [field, value] of nonEmptyFields) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `evolution: commit_intent record for proposal "${String(record.proposalId)}" has no ${field} — an intent names the proposal, ` +
        'the direction, the human approval, the fixed file set it commits, the bytes to write again for every file and its actor, ' +
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
  const files = record.files
  if (!Array.isArray(files) || files.length === 0 || files.length > 2) {
    throw new Error(
      `evolution: commit_intent record for proposal "${record.proposalId}" names ${Array.isArray(files) ? `${files.length} file(s)` : 'no file list'} ` +
      '— one skill object is a fixed file set of one or two files: SKILL.md, and SKILL.contract.json when the object carries an ' +
      'execution sidecar',
    )
  }
  files.forEach((file, index) => {
    const at = `commit_intent record for proposal "${record.proposalId}" file ${index}`
    if (!isRecord(file)) {
      throw new Error(`evolution: ${at} is not an object carrying target, baselineSha256, contentSha256, source`)
    }
    for (const [field, value] of [['target', file.target], ['source', file.source]] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`evolution: ${at} has no ${field} — every file names its absolute production path and its recoverable source`)
      }
    }
    for (const [field, value] of [['baselineSha256', file.baselineSha256], ['contentSha256', file.contentSha256]] as const) {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(
          `evolution: ${at} has no valid ${field} (${JSON.stringify(value ?? null)}) — an intent binds, for every file, the exact ` +
          'bytes production must hold before the write and the exact bytes it must hold after',
        )
      }
    }
    if (file.target !== resolve(file.target)) {
      throw new Error(
        `evolution: ${at} names target "${file.target}" — an intent names the absolute production paths it commits`,
      )
    }
    if (basename(file.target) !== (index === 0 ? 'SKILL.md' : SKILL_SIDECAR_FILE)) {
      throw new Error(
        `evolution: ${at} names target "${file.target}" — the file set of one skill object is ordered and fixed: SKILL.md first, ` +
        `and, when the object carries an execution sidecar, ${SKILL_SIDECAR_FILE} second`,
      )
    }
    if (index > 0 && dirname(file.target) !== dirname(files[0]!.target)) {
      throw new Error(
        `evolution: ${at} names target "${file.target}" beside "${files[0]!.target}" — the files of one skill object live in one ` +
        'directory, the one a loader reads whole',
      )
    }
  })
}

/**
 * One half of a prepared record's frozen identity, validated and normalized: the
 * skill name, the `SKILL.md` digest, and — when, and only when, the object
 * carries an execution sidecar — the sidecar's exact-byte digest and canonical
 * declaration digest. Shared by the write path's shape (its producer is
 * `prepare`) and the fold, so a hand-forged line fails exactly as a live append
 * would.
 *
 * `field` is the record's own member name (`skillContent` / `skillBaseline`),
 * which is also what the refusal names — the operator reads the line, not this
 * function.
 */
function preparedIdentity(value: unknown, field: string, proposalId: string): SkillContentIdentity {
  const at = `prepared record for "${proposalId}"`
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(
      `evolution: ${at} has no valid ${field} identity — every prepare records the content identity of the object's files ` +
      `(${field === 'skillContent'
        ? 'the materialized candidate SKILL.md'
        : 'the production SKILL.md it read before materializing the candidate'})`,
    )
  }
  const contract = value.contract
  if (contract === undefined) return { name: value.name, sha256: value.sha256 }
  if (!isRecord(contract) || typeof contract.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contract.sha256)
    || typeof contract.contractDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contract.contractDigest)) {
    throw new Error(
      `evolution: ${at} ${field}.contract must be { sha256, contractDigest } with both lowercase 64-character hex digests — an ` +
      'object with an execution sidecar records that file by its exact bytes and by the declaration identity a registry revision absorbs',
    )
  }
  return {
    name: value.name,
    sha256: value.sha256,
    contract: { sha256: contract.sha256, contractDigest: contract.contractDigest },
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
  private readonly commitProbe?: (stage: CommitStage, target?: string) => void
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
      formatVersion: 4,
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
        'the only candidate lifecycle here is a SKILL.md replacement of an existing skill object (evolution_prepare → the two-sided ' +
        'experiment evolution_replay → evolution_gate → evolution_apply), and no other target type has an evaluator until A6 ' +
        'introduces one, so its proposal stays a recorded proposal',
      )
    }
    validateVersionSet(versionSet)
    validateMutation(current.targetType, mutation)
    await this.append({
      formatVersion: 4,
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
   * Move candidate → prepared: confirm the production skill **object** this
   * candidate replaces, materialize the mutation into
   * `<root>/sandbox/<proposalId>/` and snapshot those same production bytes
   * under `champion/` — the anchor for the experiment's baseline and for
   * rollback.
   *
   * The production read comes first, before any sandbox or ledger write, and it
   * is one verified read of the whole directory (`loadSkillSidecar`, the same
   * loader a worker's provider check uses), so the object is frozen as it really
   * is. A production directory with no readable `SKILL.md` has nothing to
   * replace and is refused before anything is written. Anything else that makes
   * the directory *not* the object it claims — a declaration that does not match
   * the bytes, a file no sidecar names, an unreadable or unsupported entry —
   * carries loader defects and is refused by name, because a candidate built
   * from a directory nobody could describe would let a file disappear between
   * prepare and apply. A knowledge sidecar and an execution sidecar with
   * declared resources are refused too: this ticket's object is guidance or an
   * execution provider with `resources: []`.
   *
   * What is materialized is the object's fixed file set. Guidance is the
   * candidate `SKILL.md` and the champion `SKILL.md`. An execution object also
   * gets the candidate's `SKILL.contract.json` — the production declaration with
   * only `content.skillMdSha256` rewritten to the candidate's bytes, serialized
   * deterministically — and the production sidecar's exact bytes under
   * `champion/`.
   *
   * The candidate and the baseline each record a full content identity
   * (`skillContent` P2 / `skillBaseline` P3): the name, the SHA-256 of the exact
   * bytes of every materialized file (read back from disk, never re-rendered
   * from the mutation string), and — for an execution object — the file digest
   * and canonical digest of its sidecar. The two identities' shapes agree by
   * construction, so the fold can treat a disagreement as a role change it must
   * refuse.
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
    const directory = join(this.skillRoot, name)
    // P3: one verified read of the production object, before anything is
    // written, yields the champion snapshot and the baseline identity together.
    // A production path that is a symlink or not a regular file fails inside the
    // loader; a missing directory or `SKILL.md` is refused by name here rather
    // than prepared against nothing.
    const loaded = await loadSkillSidecar(directory)
    if (loaded.content === undefined) {
      throw new Error(
        `evolution: the production skill "${join(directory, 'SKILL.md')}" does not exist, so proposal ` +
        `"${proposalId}" has nothing to replace — this build prepares and promotes a replacement of an existing loadable skill ` +
        'object only; a new skill cannot be evaluated or promoted by this path',
      )
    }
    if (loaded.defects.length > 0) {
      const defects = loaded.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
      throw new Error(
        `evolution: the production skill "${directory}" is not the loadable object its files claim — ${defects}; this build freezes ` +
        'a complete object (SKILL.md, and the SKILL.contract.json it declares when the object has one), and a directory a loader ' +
        'refuses cannot be the baseline a candidate must reproduce: nothing was written',
      )
    }
    if (loaded.sidecar?.type === 'knowledge') {
      throw new Error(
        `evolution: the production skill "${directory}" carries a knowledge sidecar, and a same-name improvement of a knowledge skill ` +
        'is refused by name in this build — the object this executor promotes is guidance (no sidecar) or an execution provider ' +
        '(SKILL.md plus SKILL.contract.json with no resources), so nothing was written',
      )
    }
    if (loaded.sidecar !== undefined && loaded.sidecar.content.resources.length > 0) {
      throw new Error(
        `evolution: the production skill "${directory}" declares ${loaded.sidecar.content.resources.length} resource(s) ` +
        `(${loaded.sidecar.content.resources.map(resource => JSON.stringify(resource.path)).join(', ')}), and this build promotes an ` +
        'object whose content identity covers SKILL.md alone — resources need an executor that writes them, so nothing was written',
      )
    }
    // The bytes the object is frozen from: read once, through the same
    // walk-verified read the rest of the plane uses, and checked against the
    // loader's own verdict — so the snapshot, the recorded identity and the
    // declaration that was validated all describe one read of one object.
    const productionSkillMd = await readVerifiedFile(this.skillRoot, productionSkillRelative(name))
    if (sha256Hex(productionSkillMd) !== loaded.content.skillMdSha256) {
      throw new Error(
        `evolution: the production skill "${join(directory, 'SKILL.md')}" changed while proposal "${proposalId}" was being prepared ` +
        '(its bytes no longer hash to the digest the loader had just validated) — freezing a second read would record a baseline ' +
        'nothing checked, so nothing was written',
      )
    }
    const productionSidecar = loaded.sidecar === undefined
      ? undefined
      : await readVerifiedFile(this.skillRoot, productionSidecarRelative(name))
    if (productionSidecar !== undefined && skillContractDigest(loadedSidecar(productionSidecar)) !== skillContractDigest(loaded.sidecar!)) {
      throw new Error(
        `evolution: the production skill "${join(directory, SKILL_SIDECAR_FILE)}" changed while proposal "${proposalId}" was being ` +
        'prepared (its declaration is no longer the one the loader had just validated) — nothing was written',
      )
    }
    const dir = join(this.root, 'sandbox', proposalId)
    const written = await this.materialize(dir, mutation, {
      skillMd: productionSkillMd,
      ...(productionSidecar === undefined ? {} : { sidecar: productionSidecar }),
    })
    const sandbox = `sandbox/${proposalId}`
    const candidateSkillMd = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)
    const skillContent: SkillContentIdentity = {
      name,
      sha256: sha256Hex(candidateSkillMd),
      ...(loaded.sidecar === undefined
        ? {}
        : { contract: contractIdentityOf(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`)) }),
    }
    await this.append({
      formatVersion: 4,
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
      formatVersion: 4,
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
      formatVersion: 4,
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
   * first, exactly as for decide. The candidate object's fixed file set
   * replaces production's — `SKILL.md` and, when the object carries an execution
   * sidecar, the derived `SKILL.contract.json` (the champion snapshot covers
   * those files only, so the write is file-level, never a directory delete).
   *
   * The commit order is the recovery rule (K2): the `commit_intent` line is
   * persisted first — proposal, direction, this approval, every target of the
   * object's file set, the content identities production must hold before
   * (`prepared.skillBaseline` P3) and after (`prepared.skillContent` P2) for
   * each file, and the sandbox candidate files as the recoverable sources — then
   * each file is replaced atomically, then the `applied` record closes the
   * intent. A failure at any stage leaves the intent open and nothing
   * half-written: every production file is one complete version or the other,
   * and {@link reconcile} (or a retry of this call) settles the intent from what
   * production actually holds — including the window where only the first file
   * was replaced. Nothing here trusts a promise or a caller-supplied "approved".
   *
   * A skill apply re-verifies the production baseline (P3) after the human
   * grant and before the intent is recorded: the production object must still be
   * the one prepare recorded, both files. A direct service call therefore cannot
   * bypass the check the tool already ran before asking for approval.
   *
   * A fresh commit also refuses, before that baseline check, a production
   * **directory** another proposal's open commit intent touches
   * ({@link assertTargetUncommitted}): the serial queue spans one process, and
   * without the per-object gate the second of two proposals prepared against the
   * same bytes would read the version the first is still committing over, pass
   * its own baseline check and move the target.
   *
   * The promotion check (S1-C item 3) runs here too, before the intent is
   * recorded: a candidate whose provider role or file shape changed while the
   * human was deciding (a sidecar that appeared in or vanished from the sandbox,
   * a declaration that moved, a verifier that was unregistered) is refused here,
   * so no entry can write something a later admission would have refused.
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
        return { targets: open.files.map(file => file.target), recovered, proposal: await this.get(proposalId) }
      }
      this.assertTargetUncommitted(proposal)
      const promotion = await this.checkPromotion(proposalId)
      await this.checkProductionBaseline(proposalId)
      // P2: read the candidate object once, verify every digest prepare
      // recorded, and commit exactly those verified bytes. A source replaced
      // mid-apply cannot reach production unverified — the whole commit refuses
      // instead.
      const candidate = await this.readVerifiedSkillCandidate(proposal)
      const request = this.commitRequest(proposal, 'apply', actor, approvalRef)
      await commitIntent(this.commitHost(), request, [candidate.skillMd, ...(candidate.sidecar === undefined ? [] : [candidate.sidecar])])
      return { targets: request.files.map(file => file.target), providers: promotion.providers, proposal: await this.get(proposalId) }
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
   * The candidate object's provider verdict, taken from the directory the
   * promotion would write — plus the two boundaries this promotion cannot cross.
   *
   * The shape boundary (K3): the commit promotes the **fixed file set of one
   * skill object** — `SKILL.md`, plus the `SKILL.contract.json` beside it when
   * and only when the prepared identity says the object has an execution
   * sidecar. So a candidate directory that carries anything else (`references/`,
   * `scripts/`, a stray file) is refused by name, and so is a directory whose
   * file set does not match the frozen shape in either direction: a sidecar that
   * appeared where the identity records none, or one that is missing where the
   * identity records it. The role must agree with that shape too — two files
   * load as an execution provider, one file as guidance — so a candidate that
   * turned into the other kind of object is refused here rather than promoted as
   * something the frozen experiment never evaluated.
   *
   * The derivation boundary: for an execution object the candidate sidecar is
   * not the model's to write. It is re-derived here from the champion snapshot's
   * own sidecar bytes and the candidate `SKILL.md` digest, and compared with the
   * sandbox sidecar byte for byte (and by canonical digest) — so an escalated
   * `requiredTools`, a swapped verifier or any other declaration change between
   * prepare and promotion is refused by name. The champion side is checked too:
   * its bytes must still hash to the baseline identity's sidecar digest, or the
   * derivation would be built on bytes the prepare never recorded.
   *
   * Both the shape and the declaration are named when both are wrong: the
   * validator's own defects stay in the message with their codes, so this entry
   * reports the same defect vocabulary admission, config load and capability
   * replacement report for the same directory.
   */
  private async assertSkillCandidateProvider(proposal: EvolutionProposal): Promise<PromotionProvider> {
    const sandbox = proposal.prepared?.sandbox
    const identity = proposal.prepared?.skillContent
    const baseline = proposal.prepared?.skillBaseline
    const { name } = proposal.mutation as unknown as SkillMutation
    if (sandbox == null || identity === undefined) {
      throw new Error(`evolution: proposal "${proposal.proposalId}" names no sandbox or no candidate identity; the candidate's provider role cannot be judged`)
    }
    const directory = resolveWithin(this.root, `${sandbox}/skills/${name}`)
    const expectedFiles = identity.contract === undefined ? ['SKILL.md'] : ['SKILL.md', SKILL_SIDECAR_FILE]
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // A directory that cannot be listed is the validator's to refuse, with
      // the defect its absence deserves (`skill-missing`), not this boundary's.
      entries = []
    }
    const present = entries.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort()
    const unexpected = present.filter(entry => !expectedFiles.includes(entry))
    const missing = expectedFiles.filter(file => !present.includes(file))
    if (unexpected.length > 0 || missing.length > 0) {
      const parts = [
        unexpected.length === 0 ? undefined : `carries ${unexpected.map(entry => JSON.stringify(entry)).join(', ')}`,
        missing.length === 0 ? undefined : `is missing ${missing.map(entry => JSON.stringify(entry)).join(', ')}`,
      ].filter((part): part is string => part !== undefined)
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} ${parts.join(' and ')} — one skill object is a fixed file set ` +
        `(${expectedFiles.map(file => JSON.stringify(file)).join(', ')}, the shape prepare froze), so a candidate whose files moved ` +
        'is refused rather than promoted as an object the frozen evidence never described',
      )
    }
    const verdict = await this.providerVerdict({ name, directory })
    const defects = verdict.valid ? '' : verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
    if (!verdict.valid) {
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} is not a usable provider — ${defects}; ` +
        'a promotion writes only a skill a worker could load and, when it claims execution, only one whose verifier and tools the deployment can grant',
      )
    }
    if (identity.contract === undefined) {
      if (verdict.role !== 'guidance') {
        throw new Error(
          `evolution: skill candidate "${name}" at ${directory} loads as ${verdict.role}, but the object prepare froze is guidance ` +
          '(no sidecar) — a candidate that changed roles is not the object the experiment evaluated, so the promotion is refused',
        )
      }
      return promotionProviderOf(verdict)
    }
    if (verdict.role !== 'execution-provider') {
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} loads as ${verdict.role}, but the object prepare froze carries an ` +
        'execution sidecar — a candidate that changed roles is not the object the experiment evaluated, so the promotion is refused',
      )
    }
    const contract = identity.contract
    const championSidecar = await readVerifiedFile(this.root, `${sandbox}/champion/skills/${name}/${SKILL_SIDECAR_FILE}`)
    if (baseline?.contract === undefined || sha256Hex(championSidecar) !== baseline.contract.sha256) {
      throw new Error(
        `evolution: the champion snapshot of proposal "${proposal.proposalId}" no longer holds the sidecar bytes prepare recorded ` +
        `(sha256 ${sha256Hex(championSidecar)} != ${baseline?.contract?.sha256 ?? 'none recorded'}) — the candidate sidecar is derived ` +
        'from those bytes, so a snapshot that moved cannot be the declaration this promotion would install',
      )
    }
    const candidate = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)
    if (sha256Hex(candidate) !== identity.sha256) {
      throw new Error(
        `evolution: skill candidate "${sandbox}/skills/${name}/SKILL.md" no longer matches the content identity recorded at prepare ` +
        `(sha256 ${sha256Hex(candidate)} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
      )
    }
    const expectedSidecar = candidateSidecar(loadedSidecar(championSidecar), identity.sha256)
    const sandboxSidecar = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`)
    const sandboxText = sandboxSidecar.toString('utf8')
    if (sandboxText !== expectedSidecar || sha256Hex(sandboxSidecar) !== contract.sha256) {
      throw new Error(
        `evolution: the candidate sidecar of skill "${name}" is not the declaration derived from production — the production object ` +
        '(the champion snapshot) with only content.skillMdSha256 rewritten to the candidate SKILL.md digest; a content update may not ' +
        'move capabilities, required tools, verifier or any other declaration field, so the promotion is refused',
      )
    }
    if (verdict.contractDigest !== contract.contractDigest) {
      throw new Error(
        `evolution: the candidate sidecar of skill "${name}" loads to declaration digest ${verdict.contractDigest}, not the ` +
        `${contract.contractDigest} prepared and recorded — a declaration the record does not name is not one this promotion may install`,
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
   * Read a prepared skill candidate's materialized object and verify it against
   * the content identity recorded at prepare (P2): the `SKILL.md` bytes, plus
   * the sidecar bytes when and only when the identity records a sidecar. The one
   * read path every stage shares: the experiment's pre-run check, every promotion
   * gate, and the apply write. Throws — never silently re-digests — when a
   * recorded file is missing, is not a regular file, its path crosses a symbolic
   * link, its bytes no longer match the recorded digest, or the sidecar's
   * presence does not match the recorded shape.
   */
  async readSkillCandidate(proposalId: string): Promise<{ skillMd: Buffer; sidecar?: Buffer }> {
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
   * The prepare-time baseline is a real, complete object: its `SKILL.md` bytes
   * still hash to the recorded digest, and — when the baseline records a
   * sidecar — the production `SKILL.contract.json` is there with exactly the
   * bytes prepare recorded. A missing file, a file that changed, changed type
   * (now a directory), or sits behind a symbolic link (the file itself or an
   * ancestor) is a conflict, and so is a sidecar that appeared beside a baseline
   * that had none: the shape production would be loaded in has changed, which is
   * a third party's edit like any other. Only `targetType: skill` carries a
   * baseline; every other targetType passes untouched.
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
    const identity = prepared.skillBaseline
    if (identity === undefined) {
      // The fold requires the baseline on every prepared record, so this branch
      // is a belt for the view's optional field rather than a reachable state.
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" records no production baseline identity — ${guidance}`,
      )
    }
    let current: { bytes: Buffer; sha256: string } | null
    try {
      current = await readProductionSkill(this.skillRoot, productionSkillRelative(name))
    } catch (error) {
      throw new Error(
        `evolution: the production skill "${target}" is no longer a readable regular file ` +
        `(${(error as Error).message.replace(/^evolution: /, '')}) — ${guidance}`,
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
    let sidecar: { bytes: Buffer; sha256: string } | null
    try {
      sidecar = await readProductionSkill(this.skillRoot, productionSidecarRelative(name))
    } catch (error) {
      throw new Error(
        `evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" is no longer a readable regular file ` +
        `(${(error as Error).message.replace(/^evolution: /, '')}) — ${guidance}`,
      )
    }
    if (identity.contract !== undefined) {
      if (sidecar === null) {
        throw new Error(
          `evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" recorded at prepare ` +
          `(sha256 ${identity.contract.sha256}) no longer exists — ${guidance}`,
        )
      }
      if (sidecar.sha256 !== identity.contract.sha256) {
        throw new Error(
          `evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" changed since prepare ` +
          `(sha256 ${sidecar.sha256} != ${identity.contract.sha256}) — ${guidance}`,
        )
      }
      return
    }
    if (sidecar !== null) {
      throw new Error(
        `evolution: the production skill "${name}" now carries a ${SKILL_SIDECAR_FILE} the baseline prepare recorded did not have ` +
        `(sha256 ${sidecar.sha256}) — the object production would load is not the object the candidate was prepared and evaluated ` +
        `against; ${guidance}`,
      )
    }
  }

  private async readVerifiedSkillCandidate(proposal: EvolutionProposal): Promise<{ skillMd: Buffer; sidecar?: Buffer }> {
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
        'propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized files)',
      )
    }
    const rel = `${sandbox}/skills/${identity.name}/SKILL.md`
    const skillMd = await readVerifiedFile(this.root, rel)
    const digest = sha256Hex(skillMd)
    if (digest !== identity.sha256) {
      throw new Error(
        `evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare ` +
        `(sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
      )
    }
    const sidecarRel = `${sandbox}/skills/${identity.name}/${SKILL_SIDECAR_FILE}`
    let sidecar: Buffer | undefined
    try {
      sidecar = await readVerifiedFile(this.root, sidecarRel)
    } catch (error) {
      const reason = (error as Error).message.replace(/^verified-read: /, '')
      if (identity.contract === undefined) {
        // The identity records guidance: the read itself is the probe for the
        // shape. "Missing" is the right shape; anything else (a symlink, a
        // directory in the file's place) is an entry the guidance object never had.
        if (/is missing under/.test((error as Error).message)) return { skillMd }
        throw new Error(
          `evolution: skill candidate "${sidecarRel}" is present but cannot be read as a real file (${reason}), while the content ` +
          'identity recorded at prepare is guidance (no sidecar) — propose a new candidate and re-evaluate it',
        )
      }
      throw new Error(
        `evolution: skill candidate "${sidecarRel}" recorded at prepare (sha256 ${identity.contract.sha256}) cannot be read as a real ` +
        `file (${reason}) — propose a new candidate and re-evaluate it`,
      )
    }
    if (identity.contract === undefined) {
      throw new Error(
        `evolution: skill candidate "${sidecarRel}" exists in the sandbox, but the content identity recorded at prepare is guidance ` +
        '(no sidecar) — the candidate is no longer the object the experiment evaluated: propose a new candidate and re-evaluate it',
      )
    }
    const sidecarDigest = sha256Hex(sidecar)
    if (sidecarDigest !== identity.contract.sha256) {
      throw new Error(
        `evolution: skill candidate "${sidecarRel}" no longer matches the content identity recorded at prepare ` +
        `(sha256 ${sidecarDigest} != ${identity.contract.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
      )
    }
    return { skillMd, sidecar }
  }

  /**
   * Move applied → rolledback: undo the apply by restoring the champion snapshot
   * taken at prepare, as one commit — the same intent → atomic write →
   * completion order as apply, so an interrupted rollback is recoverable the
   * same way, including between the two files of one object. A record of another
   * target type has no executor here: this build writes and restores the fixed
   * file set of one skill object only, and an applied capability row or preset
   * directory is refused by name rather than touched. Same approval discipline
   * as apply: the tool asks a human first, the service only executes and records.
   *
   * A rollback restores *this* proposal's baseline and nothing else, so both
   * ends are re-verified per file before the intent is recorded: every
   * production file must still carry exactly the content this proposal applied
   * (`prepared.skillContent`, P2), and every champion snapshot file must still
   * hash to the baseline prepare recorded (`prepared.skillBaseline`, P3). A file
   * a later proposal — or any other writer — changed since is refused by name
   * with nothing written, and so is a snapshot that can no longer reproduce the
   * bytes it captured: neither may be papered over by restoring an old version
   * on top of a newer one.
   *
   * As in {@link apply}, an open intent of this proposal is settled rather than
   * duplicated, and the result reports the recovery; an open intent of another
   * proposal that commits the same skill directory refuses this rollback by name
   * before anything is read or written ({@link assertTargetUncommitted}).
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
        return { targets: open.files.map(file => file.target), recovered, proposal: await this.get(proposalId) }
      }
      this.assertTargetUncommitted(proposal)
      const request = this.commitRequest(proposal, 'rollback', actor, approvalRef)
      const prepared = proposal.prepared!
      const applied = prepared.skillContent!
      const name = (proposal.mutation as SkillMutation).name
      // Both files the proposal applied must still be exactly what it applied,
      // and both champion files must still hash to the baseline prepare
      // recorded — for an execution object that is two files per end. A target
      // another writer (or a later proposal) changed is left exactly as it is;
      // a snapshot that can no longer reproduce the bytes it captured is
      // refused too. Either way nothing is written and no intent is recorded.
      for (const [index, file] of request.files.entries()) {
        const relative = index === 0 ? productionSkillRelative(name) : productionSidecarRelative(name)
        const expected = index === 0 ? applied.sha256 : applied.contract!.sha256
        const current = await readProductionSkill(this.skillRoot, relative)
        if (current === null || current.sha256 !== expected) {
          throw new Error(
            `evolution: the production file "${file.target}" does not hold the content proposal "${proposalId}" applied ` +
            `(sha256 ${current?.sha256 ?? 'missing'} != ${expected}) — a rollback restores the baseline of the object this proposal ` +
            'applied, and a file another writer (or a later proposal) changed is left exactly as it is: nothing was written and no ' +
            'commit intent was recorded',
          )
        }
      }
      const championFiles: Buffer[] = []
      for (const [index, file] of request.files.entries()) {
        const expected = index === 0 ? prepared.skillBaseline!.sha256 : prepared.skillBaseline!.contract!.sha256
        const snapshot = await readVerifiedFile(this.root, file.source)
        const digest = sha256Hex(snapshot)
        if (digest !== expected) {
          throw new Error(
            `evolution: the champion snapshot "${file.source}" of proposal "${proposalId}" no longer hashes to the production ` +
            `baseline recorded at prepare (sha256 ${digest} != ${expected}) — the snapshot cannot restore the bytes it captured: ` +
            'nothing was written and no commit intent was recorded',
          )
        }
        championFiles.push(snapshot)
      }
      await commitIntent(this.commitHost(), request, championFiles)
      return { targets: request.files.map(file => file.target), proposal: await this.get(proposalId) }
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
    return this.openIntents(this.fold(this.records)).flatMap(intent => intent.files.map(file => file.target))
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
   * the proposal already carries: every file of the object's fixed set with its
   * absolute target (the same paths {@link applyTargets} names to the human), the
   * content identity production must hold before and after that file, and the
   * recoverable source under the ledger root. `apply` commits the candidate files
   * over the recorded baseline; `rollback` commits the champion snapshot files
   * over the content the apply installed — the two identities swap per file, and
   * nothing else about the two directions differs. The order is the object's:
   * `SKILL.md` first, the sidecar second when there is one.
   */
  private commitRequest(
    proposal: EvolutionProposal,
    direction: CommitDirection,
    actor: string,
    approvalRef: string,
  ): CommitRequest {
    if (proposal.targetType !== 'skill') {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores the fixed ` +
        `file set of one skill object only, so there is no executor to ${direction} an applied ${proposal.targetType} record`,
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
    const contentContract = content.contract
    const baselineContract = baseline.contract
    if ((contentContract === undefined) !== (baselineContract === undefined)) {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" records a candidate object and a production baseline of different shapes ` +
        `(${contentContract === undefined ? 'guidance' : 'execution'} vs ${baselineContract === undefined ? 'guidance' : 'execution'}) ` +
        '— a commit moves one object between two versions of the same shape',
      )
    }
    const targets = this.commitTargets(proposal)
    const skillMd: CommitFile = direction === 'apply'
      ? {
          target: targets[0]!,
          baselineSha256: baseline.sha256,
          contentSha256: content.sha256,
          source: `${prepared.sandbox}/skills/${name}/SKILL.md`,
        }
      : {
          target: targets[0]!,
          baselineSha256: content.sha256,
          contentSha256: baseline.sha256,
          source: `${prepared.sandbox}/champion/skills/${name}/SKILL.md`,
        }
    const files: CommitFile[] = [skillMd]
    if (contentContract !== undefined && baselineContract !== undefined) {
      files.push(direction === 'apply'
        ? {
            target: targets[1]!,
            baselineSha256: baselineContract.sha256,
            contentSha256: contentContract.sha256,
            source: `${prepared.sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`,
          }
        : {
            target: targets[1]!,
            baselineSha256: contentContract.sha256,
            contentSha256: baselineContract.sha256,
            source: `${prepared.sandbox}/champion/skills/${name}/${SKILL_SIDECAR_FILE}`,
          })
    }
    return { proposalId: proposal.proposalId, direction, approvalRef, files, actor }
  }

  /**
   * The production paths a commit of this proposal may write: the object's fixed
   * file set under `<skillRoot>/<name>/` — `SKILL.md` always, and the
   * `SKILL.contract.json` beside it when the prepared identity records an
   * execution sidecar — each confined to the skill root, in commit order.
   */
  private commitTargets(proposal: EvolutionProposal): string[] {
    const name = (proposal.mutation as SkillMutation).name
    const targets = [resolveWithin(this.skillRoot, productionSkillRelative(name))]
    if (proposal.prepared?.skillContent?.contract !== undefined) {
      targets.push(resolveWithin(this.skillRoot, productionSidecarRelative(name)))
    }
    return targets
  }

  /**
   * A fresh commit of `proposal` refuses, by name, a production **directory**
   * another proposal's open commit intent touches. {@link commitExclusive}
   * serializes one process's commits and nothing else, so a second commit queued
   * behind an unfinished first one would read the pre-commit bytes, pass its own
   * baseline check and move the target, leaving the first intent with no commit
   * path left to settle it: `blocked` by name, its target refused by admission
   * until something restores the bytes that intent names as its baseline. The
   * per-object gate is what stops that; it matches on the directory that holds
   * the files, because one intent covers a skill's fixed file set together — a
   * second proposal prepared against the same skill is blocked by whichever file
   * of the other intent this proposal's file set shares a directory with. It is
   * in-process, per production object and under the deployment's existing
   * single-writer constraint — not a distributed lock, not a queue and not a
   * retry loop; the intent is settled first, by {@link reconcile} or by a retry
   * of the proposal that owns it.
   *
   * Only a materialized skill mutation has commit targets this build may write:
   * every other proposal keeps the named refusal its own entry produces
   * ({@link checkPromotion}, {@link commitRequest}).
   */
  private assertTargetUncommitted(proposal: EvolutionProposal): void {
    if (proposal.targetType !== 'skill' || proposal.mutation === undefined) return
    const directories = new Set(this.commitTargets(proposal).map(target => dirname(target)))
    for (const other of this.fold(this.records).values()) {
      const intent = other.openIntent
      if (intent === undefined || other.proposalId === proposal.proposalId) continue
      const shared = intent.files.map(file => dirname(resolve(file.target))).find(directory => directories.has(directory))
      if (shared === undefined) continue
      throw new Error(
        `evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction ` +
        `"${intent.direction}") commits the production skill directory "${shared}" — proposal "${proposal.proposalId}" does not ` +
        "commit over another proposal's unsettled intent; settle that intent first (reconcile, or a retry of the proposal that owns " +
        'it): nothing was written and no commit intent was recorded',
      )
    }
  }

  /**
   * The narrow host the commit path runs on (see `commit.ts`): the roots a
   * target and a source resolve against, the service's own verified reads — P2
   * for a candidate, the walk-verified production read, the ledger-root read for
   * a snapshot — the append funnel every line goes through (format check, staged
   * fold, serialized write), the whole-object verification that closes a commit,
   * and the probe seam. The commit path owns the order; the service owns what
   * may be read, what a line must say, and what "production is the object this
   * direction promised" means.
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
      verifyCommitted: intent => this.verifyCommitted(intent),
      probe: (stage, target) => this.commitProbe?.(stage, target),
    }
  }

  /**
   * The whole-object verification a commit runs after its last file is written
   * and before the completion is recorded — in a fresh commit and in every
   * reconciliation branch that records one.
   *
   * It reads production the way a loader does (`loadSkillSidecar` through the
   * same {@link providerVerdict} every promotion uses, so the verdict carries
   * the verifier vocabulary and the capability table this deployment really
   * has) and requires that the directory *is* one loadable object carrying the
   * identity this direction promised:
   *
   * - the verdict is valid — no defect of any kind: a `SKILL.md` a declaration
   *   does not cover, a declaration the bytes do not match, a file nobody
   *   declares, a file set the shape rules refuse;
   * - the role matches the file set the intent committed: two files load as an
   *   execution provider, one file as guidance (a knowledge verdict is
   *   impossible here, and would be refused by the same comparison);
   * - `SKILL.md` carries the digest the first file's record named;
   * - with two files, the production sidecar's exact bytes hash to the second
   *   file's record, and the loaded declaration digest is the one the direction
   *   promised — for an apply the candidate identity prepare recorded, for a
   *   rollback the production baseline it recorded. This is also what makes the
   *   completion a statement about the registry: `contractDigest` is exactly the
   *   identity a registry revision absorbs, so by the time the completion line
   *   is written, the registry's own view of the skill is already the new object.
   *
   * A throw is a named refusal: the intent stays open, no completion is
   * recorded, and the caller and the next reconciliation both see the same
   * refusal rather than a settled commit a loader would not accept. It never
   * writes: this check reads production as it stands.
   */
  private async verifyCommitted(intent: CommitIntentView): Promise<void> {
    const skillMd = intent.files[0]!
    const directory = dirname(skillMd.target)
    const name = basename(directory)
    const twoFiles = intent.files.length === 2
    const verdict = await this.providerVerdict({ name, directory })
    const defects = verdict.valid ? '' : verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
    if (!verdict.valid) {
      throw new Error(
        `evolution: the production skill object "${directory}" does not load after the ${intent.direction} of proposal ` +
        `"${intent.proposalId}" — ${defects}; the commit intent stays open and no completion is recorded, because production is ` +
        'neither the state before the commit nor a loadable object',
      )
    }
    const expectedRole = twoFiles ? 'execution-provider' : 'guidance'
    if (verdict.role !== expectedRole) {
      throw new Error(
        `evolution: the production skill object "${directory}" loads as ${verdict.role} after the ${intent.direction} of proposal ` +
        `"${intent.proposalId}", not as the ${expectedRole} its committed file set describes — the commit intent stays open and no ` +
        'completion is recorded',
      )
    }
    if (verdict.content.skillMdSha256 !== skillMd.contentSha256) {
      throw new Error(
        `evolution: the production file "${skillMd.target}" does not carry the committed content after the ${intent.direction} of ` +
        `proposal "${intent.proposalId}" (sha256 ${verdict.content.skillMdSha256} != ${skillMd.contentSha256}) — the commit intent ` +
        'stays open and no completion is recorded',
      )
    }
    if (!twoFiles) return
    if (verdict.role !== 'execution-provider') return
    const sidecarFile = intent.files[1]!
    const sidecar = await readVerifiedFile(this.skillRoot, productionSidecarRelative(name))
    const sidecarDigest = sha256Hex(sidecar)
    if (sidecarDigest !== sidecarFile.contentSha256) {
      throw new Error(
        `evolution: the production file "${sidecarFile.target}" does not carry the committed content after the ${intent.direction} of ` +
        `proposal "${intent.proposalId}" (sha256 ${sidecarDigest} != ${sidecarFile.contentSha256}) — the commit intent stays open and ` +
        'no completion is recorded',
      )
    }
    const proposal = await this.get(intent.proposalId)
    const promised = intent.direction === 'apply' ? proposal.prepared?.skillContent : proposal.prepared?.skillBaseline
    if (promised?.contract === undefined || verdict.contractDigest !== promised.contract.contractDigest) {
      throw new Error(
        `evolution: the production skill "${name}" loads to declaration digest ${verdict.contractDigest} after the ${intent.direction} ` +
        `of proposal "${intent.proposalId}", not the ${promised?.contract?.contractDigest ?? 'identity without a sidecar half'} this ` +
        'direction recorded — the commit intent stays open and no completion is recorded, because the object a registry would absorb ' +
        'is not the one the proposal promised',
      )
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
   * Write the candidate object into the sandbox dir `dir`, then the champion
   * snapshot from the production bytes the caller already read (P3: one read of
   * the production files, before anything was written — those bytes become the
   * snapshot and the recorded `skillBaseline` identity together, so the two can
   * never describe two different reads). The candidate's sidecar, when the
   * object has one, is *derived* here ({@link candidateSidecar}) and not taken
   * from the mutation: the model submits `SKILL.md` text and nothing else. Every
   * path goes through `resolveWithin`, so a write can never land outside the
   * sandbox; the production skill root is read-only here.
   */
  private async materialize(
    dir: string,
    mutation: Record<string, unknown>,
    production: { skillMd: Buffer; sidecar?: Buffer },
  ): Promise<{ files: string[]; skillBaseline: SkillContentIdentity }> {
    const files: string[] = []
    const write = async (rel: string, content: string | Buffer): Promise<void> => {
      const abs = resolveWithin(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
      files.push(rel)
    }
    // This build materializes a skill candidate and nothing else: `candidate`
    // admits no other target type, so there is no other arm to take. The
    // candidate's file set is written first, then the champion's, so the
    // recorded `files` list reads candidate-first.
    const { name, content } = mutation as unknown as SkillMutation
    const candidateMd = Buffer.from(content, 'utf8')
    await write(`skills/${name}/SKILL.md`, candidateMd)
    if (production.sidecar !== undefined) {
      await write(`skills/${name}/${SKILL_SIDECAR_FILE}`, candidateSidecar(loadedSidecar(production.sidecar), sha256Hex(candidateMd)))
    }
    await write(`champion/skills/${name}/SKILL.md`, production.skillMd)
    if (production.sidecar !== undefined) {
      await write(`champion/skills/${name}/${SKILL_SIDECAR_FILE}`, production.sidecar)
      return {
        files,
        skillBaseline: {
          name,
          sha256: sha256Hex(production.skillMd),
          contract: contractIdentityOf(production.sidecar),
        },
      }
    }
    return { files, skillBaseline: { name, sha256: sha256Hex(production.skillMd) } }
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
   * `<proposalId>/<direction>`, only with a well-formed fixed file set, and only
   * when the proposal has no other open intent; an `applied`/`rolledback`
   * completion is admitted only when it closes the open intent of its own
   * direction — same id, same approval, that exact file set in the intent's own
   * order — and it closes it. So a completion cannot be recorded without its
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
          files: record.files.map(file => ({ ...file })),
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
              'lifecycle is a SKILL.md replacement of an existing skill object, and no other target type has an evaluator here',
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
              `sandbox=${JSON.stringify(record.sandbox ?? null)}) — this build prepares a replacement of one skill object only`,
            )
          }
          if (!Array.isArray(record.files) || record.files.some(file => typeof file !== 'string')) {
            throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`)
          }
          // P2/P3, required (S4-E 收尾): a prepare without the candidate's
          // content identity or without the production baseline it read is a
          // prepare whose evidence cannot be re-proved, and no entry here writes
          // one. Each identity is the whole object's since K3: the SKILL.md
          // digest, plus — exactly when the object has an execution sidecar —
          // the sidecar's exact-byte digest and its canonical declaration digest.
          const skillContent = preparedIdentity(record.skillContent, 'skillContent', record.proposalId)
          const skillBaseline = preparedIdentity(record.skillBaseline, 'skillBaseline', record.proposalId)
          // The object's shape is fixed at prepare: one half with a sidecar and
          // the other without describes a role change between candidate and
          // production that no prepare performs, so the record is refused rather
          // than folded into a commit that could only write one of the two.
          if ((skillContent.contract === undefined) !== (skillBaseline.contract === undefined)) {
            throw new Error(
              `evolution: prepared record for "${record.proposalId}" mixes object shapes — its candidate identity is ` +
              `${skillContent.contract === undefined ? 'guidance (no sidecar)' : 'an execution object (with a sidecar)'} while its ` +
              `production baseline is ${skillBaseline.contract === undefined ? 'guidance (no sidecar)' : 'an execution object (with a sidecar)'} ` +
              '— one prepare freezes one object, so a candidate that changed roles is refused at the fold',
            )
          }
          current.prepared = {
            sandbox: record.sandbox,
            mechanical: true,
            champion: 'captured',
            skillContent,
            skillBaseline,
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
          const expectedTargets = open.files.map(file => file.target)
          if (record.targets.length !== expectedTargets.length || record.targets.some((target, index) => target !== expectedTargets[index])) {
            throw new Error(
              `evolution: ${record.kind} record for "${record.proposalId}" names targets ${JSON.stringify(record.targets)}, but the ` +
              `open intent "${open.intentId}" commits ${JSON.stringify(expectedTargets)} — a completion records the exact file set its ` +
              'intent committed, in the intent\'s own order',
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
    // One format, one check (K2): the ledger is `formatVersion: 4`, and every
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

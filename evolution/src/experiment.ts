/**
 * The two-sided experiment (§F.2): the one evaluation this plane runs for a
 * candidate that replaces an existing skill object (`SKILL.md`, plus the
 * `SKILL.contract.json` beside it when the object carries an execution sidecar)
 * — and, since A6, for a **capability candidate**: one whole capability row plus
 * the new execution skill it may grant.
 *
 * The v1 replay compared a candidate against a historical record. This module
 * runs the comparison the plan actually asks for: for every frozen sample, one
 * **new** run of the baseline and one **new** run of the candidate, both from
 * one frozen input snapshot, each in its own workspace, all of it under one
 * frozen identity block — samples, input snapshot, judge, model, budget,
 * candidate content and comparison rules. The historical record locates the
 * case and nothing else: a sample's `observed` identity says which failure it
 * reproduces, and every side of the report is a run *this* experiment created.
 *
 * What is frozen before the first run, and why the report is traceable:
 * - `frozen.samples` — each sample's task, role, contract digest and the
 *   acceptance identity (criteria, modes, commands, protected input digests) the
 *   replay mirrors into both sides;
 * - `frozen.snapshot` — the source directory's recursive content digest; both
 *   workspaces are built from it and each side's initial digest must equal it.
 *   A symbolic link is not an input of its own: the snapshot's policy
 *   (`snapshot-input.ts`) follows it to the content it names, copies that
 *   content privately into each side, and refuses a link that escapes the
 *   snapshot, loops or names something unreadable before any run starts;
 * - `frozen.candidate` / `frozen.productionBaseline` — the content identity of
 *   the **complete object** the candidate side runs and of the production skill
 *   it replaces: the `SKILL.md` bytes, plus the `SKILL.contract.json`'s exact
 *   bytes and canonical declaration when the object carries an execution sidecar
 *   (K3). A guidance object is complete with one file, and presence *is* the
 *   shape;
 * - `frozen.model` and `frozen.budget` — the deployment's structured model
 *   selection and the caller's budget, both fixed before the first side. The
 *   selection is handed to every run verbatim as its `agentOptions` (S4-E §Q3),
 *   so both sides — and whatever a side's worker decomposes into — run on the
 *   route it names whatever the deployment's default becomes afterwards; the
 *   promotion gate re-reads it from the runs' own session logs. The budget
 *   bounds the *whole experiment*, and this plane enforces it as far as what is
 *   known allows: a declared `maxTokens` is compared with the token total the
 *   sides already settled reported, and no further side is started once that
 *   total has consumed the ceiling. What a settled run spent is only readable
 *   once it settled, so a side that crossed the ceiling stays recorded as it is
 *   and the promotion gate refuses it — neither this plane nor the gate reports
 *   a strict zero overspend it cannot prove. Time is not this plane's budget
 *   member at all: a Run's clock is the runtime's own (`rootBudget.wallTimeMs`
 *   when configured, and the per-run `Config.budget.wallTimeMs` fallback), and
 *   nothing here places a second one;
 * - each sample's `frozen.samples[i].provider` — the provider identity the
 *   production baseline side of that sample must bind, read before anything runs
 *   through the runtime's own pre-check (rows, registry revision, MCP servers,
 *   preset and every resolved skill), and the registry revision the candidate
 *   side must bind beside it: the same rows and provider list with the improved
 *   skill's declaration digest replaced by the candidate object's own. The two
 *   revisions are frozen separately, because an execution candidate's derived
 *   sidecar moves that skill's declaration and the revision absorbs it. Each
 *   side's criterion judge is frozen with its `verifierRef` and the version the
 *   registry declared then; a criterion that pins no ref, names one the registry
 *   does not hold, or pins one whose version the registry does not declare is
 *   refused here, before a ledger line and before a run: ordinary tasks keep mode
 *   dispatch, an experiment's judge must be nameable before it starts;
 * - `frozen.comparerVersion` and `frozen.overlay` — how the verdicts are
 *   computed and what each side ran under.
 * `frozenDigest` covers the block, and the experiment id derives from it: a
 * differently frozen experiment is a *different* experiment, never a re-run of
 * this one.
 *
 * The runs go through the existing replay entry — `taskRuntime.replayTask` with
 * `options.workspace` naming the side's own directory (S4-E item 2), and the
 * candidate side's overlay: `extraSkillRoots` pointing at the prepared sandbox's
 * `skills/` for a skill candidate, and both `capabilityOverrides` and
 * `extraSkillRoots` for a capability candidate (A6), so the candidate side runs
 * on exactly the row and the bytes `prepare` froze. Nothing here executes a run,
 * judges a criterion or writes production: the baseline side carries no overlay
 * at all, so it runs under the production configuration.
 *
 * A capability sample's production baseline may not be admissible at all: the
 * effective table does not hold a row the sample requires, or the pre-check
 * refuses its provider. That is the gap the candidate is evaluated against, and
 * the sample freezes it as an admission refusal — the baseline side is then
 * really offered to the runtime, refused, and recorded as `not-admitted` with
 * the runtime's own words, the gap and the proposal it belongs to. No Task, no
 * Run, no champion and no failure run is ever invented in its place, and the
 * candidate side still has to be a run that passed the frozen judge.
 *
 * Idempotency (§F.2). One sample side is keyed by `(proposalId,
 * preparedContentDigest, sampleTaskId, side, repetition)` — the content member
 * being the digest of the candidate's complete identity (K3), so two objects
 * that differ in their sidecar are two keys — and the ledger holds at most one
 * record per key:
 * - a recorded key is reused — no run, no new spend, and the record is never
 *   overwritten; a call that reaches an existing key under a different frozen
 *   experiment is refused by name (a new experiment needs a higher repetition);
 * - a key whose run the store still holds but which has no record (a process
 *   that died mid-experiment) is settled from the store: a terminal run is
 *   recorded exactly as it settled, a run that never settled is recorded
 *   `interrupted` — the experiment never re-runs it;
 * - a key with no run at all has never been spent: the experiment starts it.
 * The report is a function of the ledger records, `at` included (the newest
 * record's timestamp, never the reading's), so re-reading an experiment
 * reproduces the same report bytes.
 *
 * Cost is never invented: a side whose review record reports no metrics is
 * `{ status: 'unknown' }` with its reason, never a zero. Nothing here records
 * how long a side took: the experiment's evidence is what it spent in tokens,
 * and the Run's own clock is the runtime's business.
 *
 * Nothing is cleaned up. Both workspaces stay under
 * `<ledger root>/sandbox/<proposalId>/exp-<experimentId>/<sampleTaskId>/<side>/`
 * for as long as the evidence is cited, and the report lands beside them at
 * `<ledger root>/sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`.
 * @module dsh-singularity-evolution/experiment
 */

import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, ReviewCriterion, ReviewRecord, TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type {
  CapabilityConfig,
  ReplayRunOutcome,
  ReplayTaskOptions,
} from '@dangosys/dsh-singularity-task-runtime'
import { registryRevision, resolveCapabilities } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal } from './evolution.ts'
import type { PreparedCapability } from './capability-candidate.ts'
import { capabilityOverlay, capabilityRowIdentity } from './capability-candidate.ts'
import type {
  ExperimentAdmissionRefusal,
  ExperimentBudget,
  ExperimentCost,
  ExperimentReport,
  ExperimentSampleComparison,
  ExperimentSampleRole,
  ExperimentSide,
  ExperimentSideDetail,
  FrozenCapability,
  FrozenCapabilitySide,
  FrozenCriterion,
  FrozenExperiment,
  FrozenProviderIdentity,
  FrozenProviderSkill,
  FrozenSample,
  FrozenSampleAdmission,
  ModelSelection,
  SkillContentIdentity,
} from './replay.ts'
import {
  agentOptionsOf,
  assertAdmissionRecord,
  assertExperimentReport,
  assertFrozenExperiment,
  canonicalJson,
  compareExperimentSides,
  digestOf,
  EXPERIMENT_COMPARER_VERSION,
  EXPERIMENT_OUTCOMES,
  EXPERIMENT_SAMPLE_ROLES,
  EXPERIMENT_SIDES,
  frozenDigestOf,
  overallExperimentVerdict,
  protectedInputsDigest,
} from './replay.ts'
import { walkSnapshotInput } from './snapshot-input.ts'

/** One sample as the caller's specification names it. */
export interface ExperimentSampleSpec {
  taskId: string
  role: ExperimentSampleRole
}

/**
 * The experiment a caller freezes before anything runs (§F.2). Everything here
 * is fixed *before* the first run: samples and their roles, the input snapshot
 * both sides are built from, the model identity, the budget, and the repetition
 * index. Changing any member freezes a different experiment.
 */
export interface ExperimentSpec {
  proposalId: string
  samples: ExperimentSampleSpec[]
  /** The directory whose recursive content is the frozen input both workspaces are built from. */
  snapshot: { sourceDir: string }
  /**
   * The deployment's own model selection, frozen before the first run (S4-E
   * §Q3). It reaches every run verbatim as its `agentOptions`, so both sides —
   * and whatever a side's worker decomposes into — run on the route it names,
   * whatever the deployment's default selection becomes afterwards. The
   * promotion gate re-reads the selection off the runs' own session logs.
   */
  model: ModelSelection
  budget: ExperimentBudget
  /**
   * This experiment's repetition index. `0` is the first run of the frozen
   * experiment; a higher index is a new, separately budgeted experiment (§F.2:
   * only an explicit new experiment may run and charge budget again).
   */
  repetition: number
}

/** One experiment call: the frozen specification, the session it runs as, and the caller's cancellation. */
export interface ExperimentRequest {
  readonly spec: ExperimentSpec
  /** The session every replayed run of this experiment is run as. */
  readonly caller: SessionId
  readonly actor: string
  readonly signal?: AbortSignal
}

/**
 * The idempotency key of one sample side (§F.2). All five members together
 * name one run; the module doc says what a repeat of a key means.
 */
export interface ExperimentKey {
  proposalId: string
  /**
   * The digest of the prepared candidate's **complete** content identity (K3):
   * the name, the `SKILL.md` digest, and the sidecar's exact-byte and canonical
   * digests when the object has one. Two candidates whose sidecars differ are
   * two different objects, so they are two different keys — a re-serialized or
   * rewritten declaration can never reuse the run that evaluated another one.
   */
  preparedContentDigest: string
  sampleTaskId: string
  side: ExperimentSide
  repetition: number
}

/** One `experiment_started` ledger line: the frozen experiment, recorded before the first run. */
export interface ExperimentStartedRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4
  kind: 'experiment_started'
  proposalId: string
  experimentId: string
  frozen: FrozenExperiment
  frozenDigest: string
  /** The frozen budget, carried on the record as well as inside the block (the fold requires the two to agree). */
  budget: ExperimentBudget
  /** Report path relative to the ledger root (`sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`). */
  report: string
  /**
   * The task store every run of this experiment was created in, so a later
   * reader (the promotion gate) can re-read the sides' runs, reviews and
   * evidence without a caller session. Written by the orchestrator; absent only
   * on a record written before the field existed, which the gate refuses by name.
   */
  storeId?: string
  actor: string
  at: string
}

/**
 * One `experiment_sample` ledger line: one sample side's run and what it settled
 * to. Written once per key and never overwritten; a side with no terminal run (a
 * process that died mid-experiment) records `interrupted` and is never re-run
 * under the same key.
 */
export interface ExperimentSampleRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4
  kind: 'experiment_sample'
  proposalId: string
  experimentId: string
  /**
   * Key part: the digest of the complete candidate content identity this run
   * went through (K3) — `SKILL.md`, and the sidecar's two digests when the
   * object has one.
   */
  preparedContentDigest: string
  sampleTaskId: string
  side: ExperimentSide
  repetition: number
  /** The replayed task this side created. Absent for a side whose run never reached the store. */
  taskId?: string
  /** The run this side created. Absent for a side whose run never reached the store. */
  runId?: string
  outcome: ExperimentSideDetail['outcome']
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string
  /** Evidence ids the run's review record (or, when it has none, the store's evidence bundles) carries. */
  evidenceRefs: string[]
  /** The run's per-criterion verdicts, with the verifier that decided each — the report's criterion detail. */
  criteria: ReviewCriterion[]
  /** The workspace this side's run went through. */
  workspace: string
  /**
   * The frozen snapshot digest the workspace was built from. A run started by
   * this call measures it right after the build; a side settled from the store
   * after a crash records the digest the workspace *was built from* — by then
   * the run has written into the directory, so re-digesting it would measure the
   * run's output, not its input. Absent only for an `interrupted` side whose
   * workspace cannot be re-proved.
   */
  initialDigest?: string
  cost: ExperimentCost
  /** Why this side has no terminal run; required for `interrupted`. */
  reason?: string
  /**
   * The runtime's own admission refusal, carried by a `not-admitted` side (A6):
   * the side produced no Task and no Run, so this record stands in their place.
   */
  admission?: ExperimentAdmissionRefusal
  actor: string
  at: string
}

export type ExperimentRecord = ExperimentStartedRecord | ExperimentSampleRecord

/**
 * The idempotency key's content member (K3, A6): the digest of the candidate's
 * **complete** content identity — {@link digestOf} of the identity `prepare`
 * recorded, so the name, the `SKILL.md` bytes and, when the object has an
 * execution sidecar, the sidecar's exact bytes and canonical declaration are all
 * part of the key. Two candidates that differ in any of them are two objects,
 * and a key spent on one is never reused for the other.
 *
 * A capability candidate's identity is the **capability** block (the row it
 * installs, the row it moves and the gap it came from) together with the new
 * skill object when it carries one — the row alone would let two candidates
 * that differ only in their skill bytes share a key, and the skill alone would
 * let two rows share one.
 */
export function preparedContentDigestOf(frozen: { candidate?: SkillContentIdentity; capability?: FrozenCapability }): string {
  if (frozen.capability !== undefined) {
    return digestOf({ capability: frozen.capability, ...(frozen.candidate === undefined ? {} : { candidate: frozen.candidate }) })
  }
  if (frozen.candidate === undefined) {
    throw new Error('experiment: a frozen block with neither a candidate object nor a capability candidate has no identity to key a sample by')
  }
  return digestOf(frozen.candidate)
}

/** True for a record of the experiment family — the lines the proposal fold must leave alone. */
export function isExperimentRecord(record: { kind: string }): record is ExperimentRecord {
  return record.kind === 'experiment_started' || record.kind === 'experiment_sample'
}

/** One experiment's folded view: its started record plus every sample record written under it. */
export interface ExperimentView {
  experimentId: string
  proposalId: string
  frozen: FrozenExperiment
  frozenDigest: string
  budget: ExperimentBudget
  report: string
  /** The task store this experiment's runs were created in (see {@link ExperimentStartedRecord.storeId}). */
  storeId?: string
  /** The `experiment_started` record's own timestamp. */
  at: string
  /** Sample records in ledger order. */
  samples: ExperimentSampleRecord[]
}

/**
 * The ledger as this module uses it: the proposal it evaluates, the prepared
 * candidate's verified bytes, the folded experiment family, and the two
 * append-only writes. `EvolutionService` is the only implementation.
 */
export interface ExperimentLedger {
  /** Absolute ledger directory; the sandbox, the workspaces and the report live under it. */
  readonly root: string
  get(proposalId: string): Promise<EvolutionProposal>
  /**
   * Read the prepared candidate object's files — `SKILL.md`, and the sidecar
   * when and only when the recorded identity has one — and verify them against
   * that identity (P2); throws otherwise.
   */
  readSkillCandidate(proposalId: string): Promise<{ skillMd: Buffer; sidecar?: Buffer }>
  /**
   * Read a prepared **capability** candidate back out of its sandbox and verify
   * every byte against the identities prepare recorded (A6): the frozen row, the
   * new skill's two files when it carries one, and the champion row when the
   * registry held one. Throws otherwise. The evaluation freezes exactly these
   * bytes, so what an experiment mounts is what a commit would install.
   */
  readCapabilityCandidate(proposalId: string): Promise<PreparedCapability>
  /** One experiment's folded view; throws on an unknown id. */
  experiment(experimentId: string): Promise<ExperimentView>
  /**
   * Every experiment folded under one proposal, newest first. One call answers
   * both questions a run has about the ledger: which sample keys are already
   * spent, and by which frozen experiment.
   */
  experiments(proposalId: string): Promise<ExperimentView[]>
  /** Record the frozen experiment (idempotent by identity: an identical record is a no-op, a different one refuses). */
  recordExperimentStart(record: ExperimentStartedRecord): Promise<void>
  /** Record one sample side. A key that is already recorded refuses a different content by name. */
  recordExperimentSample(record: ExperimentSampleRecord): Promise<void>
}

/** One accepted provider verdict, as a freeze reads it off the runtime's own pre-check (the members it records, and no more). */
export interface PrecheckSkillVerdict {
  readonly valid: boolean
  readonly name: string
  readonly role?: string
  readonly contractDigest?: string | null
  readonly contentDigest?: string
  readonly defects?: readonly { readonly code: string; readonly detail: string }[]
}

/** The runtime's provider pre-check as the freeze consumes it (`TaskRuntime.capabilityProviderReport`). */
export interface ProviderPrecheckView {
  readonly capabilities: readonly { readonly capability: string; readonly skills: readonly PrecheckSkillVerdict[] }[]
  readonly revision: string
}

/** The services one experiment reads, as the caller's context holds them. */
export interface ExperimentSources {
  readonly evolution: ExperimentLedger
  readonly graphs: { graphForSession(sessionId: SessionId): Promise<{ readonly rootSessionId: SessionId }> }
  readonly task: { openStore(storeId: string): Promise<TaskSnapshot> }
  readonly taskRuntime: {
    replayTask(storeId: string, championTaskId: string, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>
    /**
     * The runtime's own provider pre-check for one session's viewpoint (S4-E
     * §Q3): the freeze reads the production configuration's provider identity
     * for a sample's rows through the same entry `capability_list` renders, so
     * the identity a gate later compares against is the runtime's own
     * conclusion, never this plane's guess.
     */
    capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheckView>
    /**
     * The runtime's own pre-check over a capability table the experiment names
     * (A6): the candidate overlay's table, with the sandbox skill root in front
     * of discovery — the same function the replay's own admission runs, so what
     * the freeze records as the candidate side's expectation is the runtime's
     * own conclusion about the configuration that side will really run under.
     */
    precheckCapabilityTable?(request: {
      capabilities: readonly string[]
      table: Readonly<Record<string, CapabilityConfig>>
      extraRoots: readonly string[]
    }): Promise<ProviderPrecheckView>
    /** The effective capability table, as the runtime holds it — the rows a pre-check covered and the servers they grant. */
    listCapabilities?(): Readonly<Record<string, CapabilityConfig>>
  }
  /**
   * The registered judge vocabulary at freeze time (S4-E §Q3), or `undefined`
   * when the deployment cannot list it — which is a named refusal for every
   * criterion, since a frozen criterion has to pin a registered versioned
   * verifier. Read through the same helper every provider check uses.
   */
  verifierVocabulary?(): Promise<VerifierVocabularyView | undefined>
}

/** What one experiment call produced. */
export interface ExperimentResult {
  proposalId: string
  experimentId: string
  /** The report as recorded; its bytes are exactly the file at {@link ExperimentResult.reportPath}. */
  report: ExperimentReport
  /** Report path relative to the ledger root. */
  reportPath: string
  /** The folded ledger view the report was recomputed from. */
  experiment: ExperimentView
}

/** A run state that means the run is over, whatever it settled to. */
const TERMINAL_RUN_STATUSES: readonly string[] = ['verified', 'failed', 'cancelled']

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`experiment: ${field} must be a non-empty string`)
  }
  return value
}

/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function safeSegment(value: unknown, field: string): string {
  const text = nonEmpty(value, field)
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\') || isAbsolute(text)) {
    throw new Error(`experiment: ${field} must be a single safe path segment, got "${text}"`)
  }
  return text
}

function isHex64(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Lowercase SHA-256 hex over exact bytes. */
function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The lineage tag one sample side's replayed task carries — how a run is found again after a crash. */
export function experimentLineage(experimentId: string, sampleTaskId: string, side: ExperimentSide): string {
  return `evolution-experiment:${experimentId}:${sampleTaskId}:${side}`
}

/** The experiment id: a digest of the proposal and the frozen block, so a differently frozen experiment never shares one. */
export function experimentIdOf(proposalId: string, frozenDigest: string): string {
  return digestOf({ proposalId, frozenDigest }).slice(0, 16)
}

/** The report path one experiment's evidence lands at, relative to the ledger root. */
export function experimentReportPath(proposalId: string, experimentId: string): string {
  return `sandbox/${proposalId}/exp-${experimentId}/experiment-report.json`
}

/** The one string form of a sample key (map key, refusals, the ledger's own uniqueness check). */
export function experimentSampleKey(key: ExperimentKey): string {
  return [key.proposalId, key.preparedContentDigest, key.sampleTaskId, key.side, key.repetition].join('\0')
}

/** A sample key as a reader sees it: the sample and the side it names. */
export function experimentSampleLabel(key: ExperimentKey): string {
  return `${key.sampleTaskId}/${key.side}#${key.repetition}`
}

/**
 * The recursive content digest of a directory — the input snapshot identity
 * (§F.2): every regular file's relative path and byte digest, sorted by path,
 * hashed together. A symbolic link is not an input of its own: the snapshot's
 * policy (`snapshot-input.ts`) resolves every link inside the root first, so the
 * digest covers the bytes a workspace built from the snapshot holds — a link to
 * a file contributes that file's bytes, a link to a directory contributes the
 * subtree it names, and whatever the target text spells contributes nothing. A
 * link that escapes the root, loops, or names something unreadable is refused by
 * name, never ignored into a digest the source does not have.
 */
export async function directoryDigest(directory: string): Promise<string> {
  const lines: string[] = []
  await walkSnapshotInput(directory, async entry => {
    if (entry.kind !== 'file') return
    lines.push(`${entry.rel}\0${sha256Hex(entry.bytes)}`)
  })
  return sha256Hex(lines.join('\n'))
}

/** The task's latest review record — its terminal outcome is what makes a sample a sample. */
function latestReview(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

function reviewRefOf(review: ReviewRecord): string {
  return `${review.taskId}#${review.runId ?? 'no-run'}`
}

/**
 * What one side cost, as the run's own review record reported it. `unknown` is
 * a first-class answer and never a zero: a record that carries no metrics, or
 * metrics with no token and no tool-call counters, is reported with the reason
 * it could not be read.
 */
function costOf(review: ReviewRecord | undefined): ExperimentCost {
  if (review === undefined) {
    return { status: 'unknown', reason: 'the run settled no review record, so no cost was reported for it' }
  }
  const metrics = review.metrics
  if (metrics === undefined) {
    return { status: 'unknown', reason: "the run's review record carries no metrics, so no cost was reported for it" }
  }
  if (metrics.tokens === undefined && metrics.toolCalls === undefined) {
    return { status: 'unknown', reason: "the run's review record carries metrics but no token and no tool-call counters" }
  }
  return { status: 'reported', metrics: structuredClone(metrics) }
}

/**
 * The evidence ids of one run: the review record's own list, or the store's
 * bundles for that run when there is no review. Exported because the promotion
 * gate re-reads exactly this fact from the store — one rule for what a side's
 * evidence is, not two.
 */
export function evidenceRefsOf(snapshot: TaskSnapshot, runId: string | undefined, review: ReviewRecord | undefined): string[] {
  if (review !== undefined) return [...review.evidenceRefs]
  if (runId === undefined) return []
  return snapshot.evidence.filter(bundle => bundle.taskRunId === runId).map(bundle => bundle.evidenceId)
}

/** The review record's criteria, or the run's own verdicts when the review carries none. */
function criteriaOf(review: ReviewRecord | undefined, outcome: ReplayRunOutcome | undefined): ReviewCriterion[] {
  return structuredClone([...(review?.criteria ?? outcome?.criteria ?? [])])
}

/** One criterion as the report carries it: the verdict plus the verifier that decided it (v1's report dropped the identity). */
function criterionDetail(criterion: ReviewCriterion): ExperimentSideDetail['criteria'][number] {
  return {
    criterionId: criterion.criterionId,
    verdict: criterion.verdict,
    ...(criterion.verifierId === undefined ? {} : { verifierId: criterion.verifierId }),
    ...(criterion.verifierVersion === undefined ? {} : { verifierVersion: criterion.verifierVersion }),
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    ...(criterion.exitCode === undefined ? {} : { exitCode: criterion.exitCode }),
  }
}

/** What one experiment call evaluates: the proposal, its sandbox, and the identity it froze the candidate as. */
interface ExperimentCandidate {
  proposal: EvolutionProposal
  sandbox: string
  /** The skill object the candidate side runs (a skill candidate, or a capability candidate's new skill). */
  candidate?: SkillContentIdentity
  /** The capability candidate's frozen identity (A6); absent for a skill candidate. */
  capability?: FrozenCapability
  /** The candidate-side overlay of a capability candidate: the row override and the sandbox skill root. */
  overlay?: { capabilityOverrides: Record<string, CapabilityConfig>; extraSkillRoots: string[] }
}

/**
 * The proposal this experiment may evaluate, and the candidate identity it runs
 * against. Two candidate kinds have an evaluator in this build (A6):
 *
 * - a **skill** candidate replaces an existing skill object's bytes; the
 *   candidate's files are re-verified here (P2) before anything runs — the
 *   `SKILL.md` alone for guidance, both files when the object carries an
 *   execution sidecar;
 * - a **capability** candidate installs one whole capability row and may carry
 *   one new execution skill; its frozen row, champion row and skill files are
 *   re-read and re-verified the same way (`readPreparedCapability`), and the
 *   overlay the candidate side runs under is read off that verified record
 *   (`capabilityOverlay`), so the evaluation mounts exactly what a commit would
 *   install.
 *
 * Every other target type has no evaluator: a record of one is never upgraded
 * into evidence.
 */
async function experimentCandidate(sources: ExperimentSources, proposalId: string): Promise<ExperimentCandidate> {
  const proposal = await sources.evolution.get(proposalId)
  if (proposal.targetType !== 'skill' && proposal.targetType !== 'capability') {
    throw new Error(
      `proposal ${proposalId} targets "${proposal.targetType}"; the two-sided experiment evaluates a skill candidate or a ` +
      'capability candidate (A6) only',
    )
  }
  if (proposal.status !== 'prepared') {
    throw new Error(`proposal ${proposalId} is ${proposal.status}; only a prepared proposal can be evaluated`)
  }
  const prepared = proposal.prepared
  // The checks below narrow the view's optional fields; every one of them is
  // also enforced by the ledger fold, so a prepared proposal reached here is
  // already a materialized prepare with its content identities.
  if (prepared === undefined || prepared.sandbox === null || !prepared.mechanical) {
    throw new Error(`proposal ${proposalId} has no materialized candidate; prepare it before evaluating it`)
  }
  if (proposal.targetType === 'capability') {
    if (prepared.capabilityRow === undefined) {
      throw new Error(
        `proposal ${proposalId} carries no frozen capability row — a capability prepare records the row it installs and the row it ` +
        'moves, so a proposal without them has nothing this experiment could compare',
      )
    }
    // P2/P3 before anything runs: every byte is the one prepare recorded.
    const verified = await sources.evolution.readCapabilityCandidate(proposalId)
    const identity = capabilityRowIdentity(verified.row)
    if (identity.digest !== prepared.capabilityRow.digest || identity.name !== prepared.capabilityRow.name) {
      throw new Error(
        `proposal ${proposalId} prepared capability row "${prepared.capabilityRow.name}" (${prepared.capabilityRow.digest}), but the ` +
        `sandbox holds row "${identity.name}" (${identity.digest}) — the two must be the same row before anything runs`,
      )
    }
    const baselineRow = verified.baseline === undefined
      ? null
      : capabilityRowIdentity({ name: prepared.capabilityRow.name, entry: verified.baseline.entry })
    const recordedBaseline = prepared.capabilityBaseline ?? null
    const baseline = recordedBaseline === null ? null : { name: recordedBaseline.name, entry: recordedBaseline.entry, digest: recordedBaseline.digest }
    if ((baselineRow === null) !== (baseline === null)
      || (baselineRow !== null && baseline !== null && baselineRow.digest !== baseline.digest)) {
      throw new Error(
        `proposal ${proposalId} records capability baseline ${baseline?.digest ?? 'no row'}, but the sandbox holds ` +
        `${baselineRow?.digest ?? 'none'} — the row this candidate moves cannot be re-proved, so nothing runs under it`,
      )
    }
    return {
      proposal,
      sandbox: prepared.sandbox,
      capability: {
        row: { name: prepared.capabilityRow.name, entry: verified.row.entry, digest: prepared.capabilityRow.digest },
        baseline,
        sourceRefs: [...proposal.sourceRefs],
      },
      ...(prepared.skillContent === undefined ? {} : { candidate: prepared.skillContent }),
      overlay: capabilityOverlay(proposal, { root: sources.evolution.root }),
    }
  }
  const candidate = prepared.skillContent
  if (candidate === undefined) {
    throw new Error(
      `proposal ${proposalId} carries no candidate content identity — ` +
      'propose a new candidate and prepare it',
    )
  }
  // P2 before anything runs: the file must still be exactly the bytes prepare recorded.
  await sources.evolution.readSkillCandidate(proposalId)
  return { proposal, sandbox: prepared.sandbox, candidate }
}

/** The specification's own shape, before anything is read or frozen. */
function validateSpec(spec: ExperimentSpec): void {
  nonEmpty(spec.proposalId, 'proposalId')
  if (spec.model === null || typeof spec.model !== 'object'
    || typeof spec.model.provider !== 'string' || spec.model.provider.length === 0
    || typeof spec.model.model !== 'string' || spec.model.model.length === 0) {
    throw new Error(
      'experiment: model must be the structured selection { provider, model } the runs are placed under — a bare string names no ' +
      'route a spawn can be given, so nothing may be frozen under it',
    )
  }
  if (typeof spec.snapshot?.sourceDir !== 'string' || spec.snapshot.sourceDir.trim().length === 0) {
    throw new Error('experiment: snapshot.sourceDir must be the directory both sides are built from')
  }
  if (!Number.isInteger(spec.repetition) || spec.repetition < 0) {
    throw new Error("experiment: repetition must be the experiment's non-negative integer repeat index")
  }
  if (!Array.isArray(spec.samples) || spec.samples.length === 0) {
    throw new Error('experiment: samples must name at least one sample')
  }
  const seen = new Set<string>()
  for (const [index, sample] of spec.samples.entries()) {
    safeSegment(sample.taskId, `samples[${index}].taskId`)
    if (seen.has(sample.taskId)) throw new Error(`experiment: samples[${index}] repeats task "${sample.taskId}"`)
    seen.add(sample.taskId)
    if (!EXPERIMENT_SAMPLE_ROLES.includes(sample.role)) {
      throw new Error(`experiment: samples[${index}].role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(' / ')}`)
    }
  }
}

/** The role a sample must have been chosen for, against the historical record it carries. */
function assertSampleRole(sample: ExperimentSampleSpec, task: TaskInstance, review: ReviewRecord): void {
  const required = sample.role === 'observed-failure' ? 'failed' : 'verified'
  if (review.outcome !== required) {
    throw new Error(
      `sample "${sample.taskId}" is an ${sample.role} but its latest review record is "${review.outcome}", not "${required}" — ` +
      'a sample must be the case its role names',
    )
  }
  if (task.status !== review.outcome) {
    throw new Error(`sample "${sample.taskId}" is ${task.status} but its latest review record is "${review.outcome}"; the two must agree`)
  }
}

/** The registered judge vocabulary one freeze reads: the ids and declared versions the runs are judged by. */
export interface VerifierVocabularyView {
  readonly ids: readonly string[]
  readonly versions: Readonly<Record<string, string>>
}

/**
 * One criterion's frozen judge identity (S4-E §Q3), read from the criterion's
 * own declaration and the registry as it stands *before* the first run.
 *
 * An experiment's judge must be nameable before it runs, so every criterion
 * must pin a `verifierRef` the registry holds *and* declares a version for:
 * the registered instance is what the verdicts are recalled against, and a
 * criterion that leaves the choice to mode dispatch — or names a judge nobody
 * can find or version — is refused here, before the ledger and before any run.
 * Ordinary tasks keep mode dispatch; this rule is the experiment freeze's own.
 */
function frozenCriterionOf(criterion: AcceptanceCriterion, where: string, vocabulary: VerifierVocabularyView | undefined): FrozenCriterion {
  const inputs = criterion.protectedInputs ?? []
  for (const input of inputs) {
    if (typeof input?.path !== 'string' || input.path.length === 0 || !isHex64(input?.sha256)) {
      throw new Error(
        `the sample's criterion "${criterion.criterionId}" carries a protected input that was never fixed to { path, sha256 } — ` +
        'an acceptance input nobody fixed is not a frozen input',
      )
    }
  }
  const ref = criterion.verifierRef
  if (ref === undefined) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins no verifierRef — the judge a verdict belongs to is fixed before the first ` +
      'run, so a criterion that lets the registry choose by mode cannot be frozen; pin the registered, versioned verifier that decides it',
    )
  }
  if (vocabulary === undefined) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins verifier "${ref}" but this deployment cannot list its verifier registry ` +
      '(verifierIds()/verifierVersions() are unavailable), so the judge identity cannot be frozen — an experiment whose judge nobody ' +
      'can name is refused before it runs',
    )
  }
  if (!vocabulary.ids.includes(ref)) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins verifier "${ref}", which the registry does not hold ` +
      `(registered: ${vocabulary.ids.length === 0 ? 'none' : vocabulary.ids.join(', ')}) — the criterion would be judged inconclusive ` +
      'by a judge that does not exist; name a registered verifier before freezing the experiment',
    )
  }
  const declared = vocabulary.versions[ref]
  if (declared === undefined) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins verifier "${ref}", which the registry holds but declares no version for — ` +
      'a verdict belongs to the instance that judged it, so a judge nobody can recall by version is refused before the experiment runs',
    )
  }
  return {
    criterionId: criterion.criterionId,
    verificationMode: criterion.verificationMode,
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    protectedInputsDigest: protectedInputsDigest(inputs),
    verifierRef: ref,
    verifierVersion: declared,
    verifierAnchor: `registered verifier "${ref}" declares version "${declared}"`,
  }
}

/**
 * The provider identity the production baseline side of one sample must bind
 * (S4-E §Q3): the runtime's own pre-check over the rows the sample's required
 * capabilities resolve to, run from the caller's viewpoint before anything
 * runs, plus the MCP servers and preset the effective table declares for those
 * rows. Every value here is read from the deployment's own configuration — the
 * pre-check's revision is the runtime's own conclusion, not a guess this plane
 * makes.
 *
 * The candidate side's expectation is frozen beside it (K3): with the improved
 * skill's declaration digest substituted by the candidate object's own
 * ({@link candidateRegistryRevisionOf}), the same pure function the runtime
 * itself uses. The substituting entry must be in the resolved list — the skill
 * this experiment replaces is what its rows grant — so a list that does not hold
 * it is a named refusal, not a revision derived over half a configuration.
 *
 * Refused by name when the deployment cannot answer (no runtime pre-check, a
 * row the table does not hold, a refused provider, conflicting presets): a
 * sample whose provider identity cannot be fixed is not an experiment this
 * build may run.
 */
async function frozenProviderIdentity(input: {
  sources: ExperimentSources
  caller: SessionId
  sampleTaskId: string
  required: readonly string[]
  /** The candidate object this experiment prepares to promote: what its side's registry revision substitutes. */
  candidate: SkillContentIdentity
  where: string
}): Promise<FrozenProviderIdentity> {
  const { sources, caller, required, candidate, where } = input
  const table = sources.taskRuntime.listCapabilities?.()
  if (table === undefined) {
    throw new Error(
      `${where} cannot fix the provider identity the production baseline runs under: this deployment's task runtime exposes no ` +
      'capability table (listCapabilities), so which rows, servers and skills the sample resolves to is not knowable before it runs — ' +
      'the experiment is refused rather than run under an identity nobody can compare against',
    )
  }
  const missing = [...new Set(required)].filter(name => table[name] === undefined).sort()
  if (missing.length > 0) {
    throw new Error(
      `${where} requires ${missing.length > 1 ? 'capabilities' : 'capability'} [${missing.join(', ')}], which the effective capability ` +
      'table does not hold — the runtime would refuse the replay for a capability gap after freezing; name rows the deployment has',
    )
  }
  const rows = [...new Set(required)].sort()
  let precheck: ProviderPrecheckView
  try {
    precheck = await sources.taskRuntime.capabilityProviderReport(caller, rows)
  } catch (error) {
    throw new Error(
      `${where} cannot run the runtime's provider pre-check over rows [${rows.join(', ') || 'none'}] (${error instanceof Error ? error.message : String(error)}) — ` +
      'the provider identity the production baseline would bind cannot be fixed, so the experiment is refused before it runs',
    )
  }
  const refused = precheck.capabilities.flatMap(row => row.skills.filter(skill => !skill.valid).map(skill =>
    `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map(defect => `${defect.code}: ${defect.detail}`).join('; ')})`))
  if (refused.length > 0) {
    throw new Error(
      `${where} resolves to providers the deployment cannot use, so the production baseline could not run under them:\n- ${refused.join('\n- ')}`,
    )
  }
  const skills: FrozenProviderSkill[] = precheck.capabilities
    .flatMap(row => row.skills)
    .filter(skill => skill.valid)
    .filter((skill, index, all) => all.findIndex(entry => entry.name === skill.name) === index)
    .map((skill): FrozenProviderSkill => {
      const role = skill.role
      if (role !== 'execution-provider' && role !== 'knowledge' && role !== 'guidance') {
        throw new Error(`${where} resolved skill "${skill.name}" to an unknown role "${String(role)}"; the provider identity cannot be frozen`)
      }
      if (typeof skill.contentDigest !== 'string' || skill.contentDigest.length === 0) {
        throw new Error(`${where} resolved skill "${skill.name}" without a content digest; the provider identity cannot be frozen`)
      }
      return {
        name: skill.name,
        role,
        contractDigest: skill.contractDigest ?? null,
        contentDigest: skill.contentDigest,
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const mcpServers = [...new Set(rows.flatMap(row => table[row]?.mcpServers ?? []))].sort()
  const declaredPresets = new Set(rows.flatMap(row => {
    const preset = table[row]?.preset
    return preset === undefined ? [] : [preset]
  }))
  if (declaredPresets.size > 1) {
    throw new Error(
      `${where}'s rows declare conflicting presets (${[...declaredPresets].sort().join(', ')}); one worker requires one preset, so the ` +
      'runtime would refuse the replay — split the rows or align the presets before freezing the experiment',
    )
  }
  return {
    capabilities: rows,
    registryRevision: precheck.revision,
    candidateRegistryRevision: candidateRegistryRevisionOf({ table, skills, candidate, where }),
    mcpServers,
    preset: declaredPresets.size === 0 ? null : [...declaredPresets][0]!,
    skills,
  }
}

/** One frozen side identity built from one pre-check's verdicts, refusing a deployment whose providers are unusable or whose roles are unknown. */
function frozenCapabilitySideOf(input: {
  precheck: ProviderPrecheckView
  table: Readonly<Record<string, CapabilityConfig>>
  rows: readonly string[]
  where: string
}): FrozenCapabilitySide {
  const { precheck, table, rows, where } = input
  const refused = refusedProviderLines(precheck)
  if (refused.length > 0) {
    throw new Error(`${where} resolves to providers the deployment cannot use:\n- ${refused.join('\n- ')}`)
  }
  const skills: FrozenProviderSkill[] = precheck.capabilities
    .flatMap(row => row.skills)
    .filter(skill => skill.valid)
    .filter((skill, index, all) => all.findIndex(entry => entry.name === skill.name) === index)
    .map((skill): FrozenProviderSkill => {
      const role = skill.role
      if (role !== 'execution-provider' && role !== 'knowledge' && role !== 'guidance') {
        throw new Error(`${where} resolved skill "${skill.name}" to an unknown role "${String(role)}"; the provider identity cannot be frozen`)
      }
      if (typeof skill.contentDigest !== 'string' || skill.contentDigest.length === 0) {
        throw new Error(`${where} resolved skill "${skill.name}" without a content digest; the provider identity cannot be frozen`)
      }
      return { name: skill.name, role, contractDigest: skill.contractDigest ?? null, contentDigest: skill.contentDigest }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const declaredPresets = new Set(rows.flatMap(row => {
    const preset = table[row]?.preset
    return preset === undefined ? [] : [preset]
  }))
  if (declaredPresets.size > 1) {
    throw new Error(
      `${where}'s rows declare conflicting presets (${[...declaredPresets].sort().join(', ')}); one worker requires one preset, so the ` +
      'runtime would refuse the replay — split the rows or align the presets before freezing the experiment',
    )
  }
  return {
    capabilities: [...rows],
    registryRevision: precheck.revision,
    mcpServers: [...new Set(rows.flatMap(row => table[row]?.mcpServers ?? []))].sort(),
    preset: declaredPresets.size === 0 ? null : [...declaredPresets][0]!,
    skills,
  }
}

/** Every provider one pre-check refused, as a refusal line names it — the one rendering the freeze and the admission record share. */
function refusedProviderLines(precheck: ProviderPrecheckView): string[] {
  return precheck.capabilities.flatMap(row => row.skills.filter(skill => !skill.valid).map(skill =>
    `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map(defect => `${defect.code}: ${defect.detail}`).join('; ')})`))
}

/**
 * What the two sides of one **capability** sample are frozen against (A6).
 *
 * The candidate side runs under the prepared overlay: the capability table the
 * overlay produces (the effective table with the candidate's one row folded in)
 * and the sandbox skill root in front of discovery. That configuration must
 * admit every row the sample requires — a candidate that cannot run the sample
 * it is supposed to fix is refused here, before the first run — and its provider
 * identity is read through the runtime's own pre-check over exactly that table
 * (`precheckCapabilityTable`), so the revision the side's run has to bind is the
 * runtime's own conclusion, not a value this plane derives.
 *
 * The production side runs under the effective table as it stands. A row the
 * table does not hold, or a provider the pre-check refuses, is **not** a refusal
 * of the experiment: it is the gap the candidate is evaluated against, and it is
 * recorded as that sample's frozen admission expectation
 * ({@link FrozenSampleAdmission}) — the baseline side is `not-admitted`, no run
 * exists for it and none is invented. A production side that resolves cleanly
 * freezes the ordinary provider identity beside the overlay one.
 */
async function frozenCapabilitySample(input: {
  sources: ExperimentSources
  caller: SessionId
  sampleTaskId: string
  required: readonly string[]
  overlay: { capabilityOverrides: Record<string, CapabilityConfig>; extraSkillRoots: string[] }
}): Promise<{ provider?: FrozenProviderIdentity; admission?: FrozenSampleAdmission; candidateProvider: FrozenCapabilitySide }> {
  const { sources, caller, overlay, sampleTaskId } = input
  const where = `sample "${sampleTaskId}"`
  const table = sources.taskRuntime.listCapabilities?.()
  if (table === undefined) {
    throw new Error(
      `${where} cannot fix the provider identities a capability experiment compares: this deployment's task runtime exposes no ` +
      'capability table (listCapabilities), so which rows, servers and skills each side resolves to is not knowable before it runs — ' +
      'the experiment is refused rather than run under identities nobody can compare against',
    )
  }
  const rows = [...new Set(input.required)].sort()
  const overlayTable = { ...table, ...overlay.capabilityOverrides }
  const overlayManifest = resolveCapabilities(rows, overlayTable)
  if (overlayManifest.missing.length > 0) {
    throw new Error(
      `${where} requires ${overlayManifest.missing.length > 1 ? 'capabilities' : 'capability'} ` +
      `[${overlayManifest.missing.join(', ')}], which the candidate overlay does not resolve — the candidate side could not run the case ` +
      'the candidate is evaluated on, so the experiment is refused before it runs',
    )
  }
  if (sources.taskRuntime.precheckCapabilityTable === undefined) {
    throw new Error(
      `${where} cannot fix the provider identity the candidate overlay produces: this deployment's task runtime exposes no capability ` +
      'pre-check over a table the caller names, so what the candidate side would load cannot be frozen before it runs',
    )
  }
  const candidateProvider = frozenCapabilitySideOf({
    precheck: await sources.taskRuntime.precheckCapabilityTable({
      capabilities: rows,
      table: overlayTable,
      extraRoots: [...overlay.extraSkillRoots],
    }),
    table: overlayTable,
    rows,
    where: `${where} candidate side`,
  })
  const manifest = resolveCapabilities(rows, table)
  if (manifest.missing.length > 0) {
    // The production configuration cannot resolve the sample's rows at all: the
    // baseline refused admission, and that refusal — with the gap it stands for —
    // is what the sample freezes for its baseline side.
    return {
      admission: {
        source: 'capability-gap',
        required: rows,
        missing: [...manifest.missing].sort(),
        reason:
          `the effective capability table does not hold ${manifest.missing.map(name => JSON.stringify(name)).join(', ')}, so the ` +
          `production configuration cannot admit this sample (the runtime's own resolution reports a closure gap)`,
      },
      candidateProvider,
    }
  }
  const precheck = await sources.taskRuntime.capabilityProviderReport(caller, rows)
  const refused = refusedProviderLines(precheck)
  if (refused.length > 0) {
    return {
      admission: {
        source: 'provider-refused',
        required: rows,
        missing: [],
        reason: `the production configuration resolves providers this deployment cannot use:\n- ${refused.join('\n- ')}`,
      },
      candidateProvider,
    }
  }
  const productionSide = frozenCapabilitySideOf({ precheck, table, rows, where: `${where} production side` })
  return {
    provider: {
      capabilities: rows,
      registryRevision: productionSide.registryRevision,
      // A capability sample's candidate side is the overlay, frozen as
      // `candidateProvider` above; this member repeats the production revision
      // so a capability sample keeps the one side shape every sample uses, and
      // no reader of a capability sample takes it for a substitution.
      candidateRegistryRevision: productionSide.registryRevision,
      mcpServers: productionSide.mcpServers,
      preset: productionSide.preset,
      skills: productionSide.skills,
    },
    candidateProvider,
  }
}

/**
 * The registry revision the **candidate** side of one sample must bind (K3):
 * the runtime's own {@link registryRevision} over the same capability table and
 * the same resolved provider list, with the improved skill's declaration digest
 * replaced by the candidate object's own (`null` for a guidance candidate —
 * which leaves the revision equal to the production one, because nothing about
 * the list changed).
 *
 * This is the one substitution the candidate overlay is supposed to produce: an
 * execution candidate's sidecar rewrites `content.skillMdSha256`, its canonical
 * declaration digest moves with the body, and the revision that folds every
 * provider's declaration absorbs that. Recomputing it here — rather than
 * letting a promotion derive it — is what makes the value a *frozen
 * expectation* both sides are compared against separately.
 *
 * A provider list that does not hold the improved skill is refused by name: the
 * list is what the substitution is defined over, and the experiment is refused
 * before it runs rather than frozen with a revision nobody can re-derive.
 */
function candidateRegistryRevisionOf(input: {
  table: Readonly<Record<string, CapabilityConfig>>
  skills: readonly FrozenProviderSkill[]
  candidate: SkillContentIdentity
  where: string
}): string {
  const { table, skills, candidate, where } = input
  if (!skills.some(skill => skill.name === candidate.name)) {
    throw new Error(
      `${where} resolves no provider named "${candidate.name}", the skill this experiment replaces — the candidate side's registry ` +
      'revision is the frozen provider list with that skill\'s declaration digest substituted, so a list that does not hold it cannot ' +
      'say what the candidate side resolves to; the experiment is refused before it runs',
    )
  }
  const candidateDigest = candidate.contract?.contractDigest ?? null
  return registryRevision(
    table,
    skills.map(skill => ({
      name: skill.name,
      contractDigest: skill.name === candidate.name ? candidateDigest : skill.contractDigest,
    })),
  )
}

/** What one sample's two sides are frozen against: a skill sample's production identity, or a capability sample's production/overlay pair. */
type SampleProviders = Pick<FrozenSample, 'provider' | 'admission' | 'candidateProvider'>

/** Freeze one sample from its store record: what the case is, the acceptance the replay mirrors into both sides, and the provider identities. */
function frozenSampleOf(
  sample: ExperimentSampleSpec,
  task: TaskInstance,
  review: ReviewRecord,
  providers: SampleProviders,
  vocabulary: VerifierVocabularyView | undefined,
): FrozenSample {
  if (task.acceptanceCriteria.length === 0) {
    throw new Error(`sample "${sample.taskId}" carries no acceptance criteria; there is nothing for the two sides to be judged by`)
  }
  const where = `sample "${sample.taskId}"`
  return {
    taskId: sample.taskId,
    role: sample.role,
    contractDigest: digestOf({
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      requiredCapabilities: task.requestedCapabilities,
    }),
    criteria: task.acceptanceCriteria.map(criterion => frozenCriterionOf(criterion, where, vocabulary)),
    observed: {
      outcome: review.outcome === 'failed' ? 'failed' : 'verified',
      ...(review.runId === undefined ? {} : { runId: review.runId }),
    },
    ...providers,
  }
}

/** One content identity as a frozen block carries it: the whole object's identity, copied member by member (never shared). */
function frozenIdentityOf(identity: SkillContentIdentity): SkillContentIdentity {
  return {
    name: identity.name,
    sha256: identity.sha256,
    ...(identity.contract === undefined
      ? {}
      : { contract: { sha256: identity.contract.sha256, contractDigest: identity.contract.contractDigest } }),
  }
}

/**
 * Build the frozen identity block (§F.2), then check it against the schema the
 * report and the ledger share. The candidate and production-baseline identities
 * are frozen whole (K3): the `SKILL.md` digest and, when the object carries an
 * execution sidecar, the sidecar's exact-byte digest and canonical declaration
 * digest — so a promotion can compare the evidence's object with prepare's
 * member by member, and an object that changed shape cannot borrow the other
 * shape's diff.
 *
 * A capability candidate (A6) freezes what it really has: the one row it
 * installs and the registry row it moves, the gap it came from, and — when it
 * carries a new skill — that object's whole identity. A row-only candidate has
 * no skill identity, which is why `candidate` is optional here and the schema
 * requires exactly one of the two to name the candidate.
 */
function freezeExperiment(input: {
  proposalId: string
  spec: ExperimentSpec
  candidate?: SkillContentIdentity
  productionBaseline?: SkillContentIdentity
  capability?: FrozenCapability
  sandbox: string
  snapshotDigest: string
  samples: FrozenSample[]
}): FrozenExperiment {
  const candidate = input.candidate
  const capability = input.capability
  const frozen: FrozenExperiment = {
    proposalId: input.proposalId,
    repetition: input.spec.repetition,
    ...(candidate === undefined ? {} : { candidate: frozenIdentityOf(candidate) }),
    ...(input.productionBaseline === undefined ? {} : { productionBaseline: frozenIdentityOf(input.productionBaseline) }),
    ...(capability === undefined
      ? {}
      : {
        capability: {
          row: { name: capability.row.name, entry: structuredClone(capability.row.entry), digest: capability.row.digest },
          baseline: capability.baseline === null
            ? null
            : { name: capability.baseline.name, entry: structuredClone(capability.baseline.entry), digest: capability.baseline.digest },
          sourceRefs: [...capability.sourceRefs],
        },
      }),
    model: {
      provider: input.spec.model.provider,
      model: input.spec.model.model,
      ...(input.spec.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.spec.model.reasoningEffort }),
      ...(input.spec.model.maxTokens === undefined ? {} : { maxTokens: input.spec.model.maxTokens }),
      label: `${input.spec.model.provider}/${input.spec.model.model}`,
    },
    budget: { ...input.spec.budget },
    samples: input.samples,
    snapshot: { sourceDir: resolve(input.spec.snapshot.sourceDir), digest: input.snapshotDigest },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: {
      baseline: 'none — the baseline runs under the production configuration',
      candidate: capability === undefined
        ? `extraSkillRoots: [${input.sandbox}/skills] — the complete candidate object: ` +
          `${candidate!.contract === undefined
            ? `the guidance object "${candidate!.name}" (SKILL.md alone, no sidecar)`
            : `the execution object "${candidate!.name}" (SKILL.md plus the derived SKILL.contract.json)`}, ` +
          'loaded whole through the runtime\'s own discovery'
        : `capabilityOverrides: { "${capability.row.name}": the prepared row }` +
          `${candidate === undefined
            ? ' and no extra skill root — a row-only candidate adds no object'
            : `, extraSkillRoots: [${input.sandbox}/skills] — the new execution object "${candidate.name}" ` +
              '(SKILL.md plus the SKILL.contract.json beside it), loaded whole through the runtime\'s own discovery'}`,
    },
  }
  assertFrozenExperiment(frozen)
  return frozen
}

/**
 * Build one side's workspace from the frozen snapshot, then prove it holds
 * exactly the frozen bytes.
 *
 * The copy is the snapshot's own traversal (`snapshot-input.ts`), not `cp`.
 * `cp` keeps a symbolic link a link, and a kept link is a shared target: a run
 * that writes through it writes the source the snapshot was taken from, or
 * another side's copy. Rebuilding the tree's resolved content instead gives this
 * side a real file where a link to a file was and a real directory where a link
 * to a directory was, so the workspace is private by construction — and it is
 * what lets the digest below describe the snapshot and this copy as one input.
 */
async function buildWorkspace(sourceDir: string, target: string, snapshotDigest: string): Promise<string> {
  // A key that reaches this point has no run in the store, so nothing in the
  // directory is evidence: rebuild from the frozen snapshot rather than merge
  // into whatever an earlier attempt that never ran left there.
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await walkSnapshotInput(sourceDir, async entry => {
    const at = join(target, entry.rel)
    if (entry.kind === 'directory') {
      await mkdir(at, { recursive: true, mode: entry.mode })
      return
    }
    await mkdir(dirname(at), { recursive: true })
    await writeFile(at, entry.bytes, { mode: entry.mode })
  })
  const real = await realpath(target)
  const digest = await directoryDigest(real)
  if (digest !== snapshotDigest) {
    throw new Error(
      `the workspace "${real}" was built from the frozen snapshot but hashes to ${digest}, not the frozen ${snapshotDigest}; ` +
      'the build did not reproduce the frozen input, so nothing runs in it',
    )
  }
  return real
}

/**
 * What reading one run out of the store produced — the one place store facts
 * become record facts. A terminal settlement is recorded exactly as it stands; a
 * run that never settled is an interruption, with the store's own description of
 * where it stands as the reason.
 */
interface RunFacts {
  outcome: ExperimentSideDetail['outcome']
  taskId?: string
  runId?: string
  review?: ReviewRecord
  criteria: ReviewCriterion[]
  evidenceRefs: string[]
  terminal: boolean
  detail: string
}

function runFactsOf(snapshot: TaskSnapshot, task: TaskInstance, settled: ReplayRunOutcome | undefined): RunFacts {
  const runId = settled?.runId ?? task.runIds[task.runIds.length - 1]
  const run = runId === undefined ? undefined : snapshot.runs.find(item => item.runId === runId)
  const review = runId === undefined ? undefined : snapshot.reviews.find(item => item.runId === runId)
  const outcome = review !== undefined && TERMINAL_RUN_STATUSES.includes(review.outcome)
    ? review.outcome
    : run !== undefined && TERMINAL_RUN_STATUSES.includes(run.status)
      ? run.status
      : undefined
  const detail = runId === undefined
    ? "the store holds no run of this side's task"
    : run === undefined
      ? `the store holds no run "${runId}" of this side's task`
      : `the store holds run ${run.runId} as ${run.status}${run.executionPhase === undefined ? '' : ` (${run.executionPhase})`} with no terminal review record`
  const outcomeValue: ExperimentSideDetail['outcome'] = outcome === undefined
    ? 'interrupted'
    : (outcome as ExperimentSideDetail['outcome'])
  return {
    outcome: outcomeValue,
    taskId: task.taskId,
    ...(runId === undefined ? {} : { runId }),
    ...(review === undefined ? {} : { review }),
    criteria: criteriaOf(review, settled),
    evidenceRefs: evidenceRefsOf(snapshot, runId, review),
    terminal: outcome !== undefined,
    detail,
  }
}

/** The one ledger line a sample side writes, from the facts its run settled to. */
function sampleRecord(input: {
  view: ExperimentView
  sample: FrozenSample
  side: ExperimentSide
  outcome: ExperimentSideDetail['outcome']
  taskId?: string
  runId?: string
  review?: ReviewRecord
  criteria: ReviewCriterion[]
  evidenceRefs: string[]
  workspace: string
  initialDigest?: string
  cost: ExperimentCost
  reason?: string
  /** The runtime's own admission refusal, for a side the runtime refused before a run existed (A6). */
  admission?: ExperimentAdmissionRefusal
  actor: string
}): ExperimentSampleRecord {
  return {
    formatVersion: 4,
    kind: 'experiment_sample',
    proposalId: input.view.proposalId,
    experimentId: input.view.experimentId,
    preparedContentDigest: preparedContentDigestOf(input.view.frozen),
    sampleTaskId: input.sample.taskId,
    side: input.side,
    repetition: input.view.frozen.repetition,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    outcome: input.outcome,
    ...(input.review === undefined ? {} : { reviewRef: reviewRefOf(input.review) }),
    evidenceRefs: [...input.evidenceRefs],
    criteria: input.criteria,
    workspace: input.workspace,
    ...(input.initialDigest === undefined ? {} : { initialDigest: input.initialDigest }),
    cost: input.cost,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.admission === undefined ? {} : { admission: structuredClone(input.admission) }),
    actor: input.actor,
    at: new Date().toISOString(),
  }
}

/**
 * One sample side that has a run in the store but no record: a process died
 * between starting the run and recording it. The store's terminal state is what
 * gets recorded — as it stands, never re-run. A run that never settled is
 * recorded `interrupted` with the store's own description of where it stands,
 * and the workspace's frozen digest is the one it was built from (the run has
 * written into the directory since; see the module doc).
 */
function recoveredSampleRecord(input: {
  view: ExperimentView
  sample: FrozenSample
  side: ExperimentSide
  task: TaskInstance
  snapshot: TaskSnapshot
  workspace: string
  actor: string
}): ExperimentSampleRecord {
  const facts = runFactsOf(input.snapshot, input.task, undefined)
  if (!facts.terminal) {
    return sampleRecord({
      view: input.view,
      sample: input.sample,
      side: input.side,
      outcome: 'interrupted',
      ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
      ...(facts.runId === undefined ? {} : { runId: facts.runId }),
      criteria: [],
      evidenceRefs: [],
      workspace: input.workspace,
      cost: { status: 'unknown', reason: 'the run never settled, so it reported no cost' },
      reason:
        `${facts.detail} — the experiment settles what the store holds and never re-runs an in-flight sample; ` +
        'resume it, or freeze a new experiment at a higher repetition, to run this side again',
      actor: input.actor,
    })
  }
  return sampleRecord({
    view: input.view,
    sample: input.sample,
    side: input.side,
    outcome: facts.outcome,
    ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
    ...(facts.runId === undefined ? {} : { runId: facts.runId }),
    ...(facts.review === undefined ? {} : { review: facts.review }),
    criteria: facts.criteria,
    evidenceRefs: facts.evidenceRefs,
    workspace: input.workspace,
    initialDigest: input.view.frozen.snapshot.digest,
    cost: costOf(facts.review),
    actor: input.actor,
  })
}

/** One side's detail as the report carries it, read off the ledger record and nothing else. */
function sideDetailOf(view: ExperimentView, sample: FrozenSample, side: ExperimentSide): ExperimentSideDetail {
  const record = view.samples.find(item => item.sampleTaskId === sample.taskId && item.side === side)
  if (record === undefined) throw new Error(`experiment: sample ${sample.taskId}/${side} has no record`)
  return {
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    role: sample.role,
    side,
    outcome: record.outcome,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.reviewRef === undefined ? {} : { reviewRef: record.reviewRef }),
    evidenceRefs: [...record.evidenceRefs],
    workspace: record.workspace,
    ...(record.initialDigest === undefined ? {} : { initialDigest: record.initialDigest }),
    criteria: record.criteria.map(criterionDetail),
    cost: record.cost,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.admission === undefined ? {} : { admission: structuredClone(record.admission) }),
  }
}

/** The key one frozen sample's side has under one experiment. */
export function experimentSampleKeyOf(view: Pick<ExperimentView, 'proposalId' | 'frozen'>, sampleTaskId: string, side: ExperimentSide): ExperimentKey {
  return {
    proposalId: view.proposalId,
    preparedContentDigest: preparedContentDigestOf(view.frozen),
    sampleTaskId,
    side,
    repetition: view.frozen.repetition,
  }
}

/**
 * Build the v3 report from the ledger records alone — the same records always
 * give the same report, its `at` included. An experiment missing a side has no
 * report: an incomplete comparison is not evidence, and saying so is the honest
 * answer.
 */
export function buildExperimentReport(view: ExperimentView): ExperimentReport {
  const missing = view.frozen.samples.flatMap(sample =>
    EXPERIMENT_SIDES
      .filter(side => !view.samples.some(item => item.sampleTaskId === sample.taskId && item.side === side))
      .map(side => `${sample.taskId}/${side}`))
  if (missing.length > 0) {
    throw new Error(`experiment ${view.experimentId} is incomplete — no record for ${missing.join(', ')}; the settled runs stay recorded`)
  }
  const samples: ExperimentSampleComparison[] = view.frozen.samples.map(sample => {
    const baseline = sideDetailOf(view, sample, 'baseline')
    const candidate = sideDetailOf(view, sample, 'candidate')
    return {
      taskId: sample.taskId,
      role: sample.role,
      baseline,
      candidate,
      verdict: compareExperimentSides(sample.role, baseline, candidate),
    }
  })
  const at = [view.at, ...view.samples.map(record => record.at)].reduce((left, right) => (left > right ? left : right))
  const report: ExperimentReport = {
    formatVersion: 3,
    proposalId: view.proposalId,
    experimentId: view.experimentId,
    at,
    frozen: view.frozen,
    frozenDigest: view.frozenDigest,
    samples,
    verdict: overallExperimentVerdict(samples),
  }
  assertExperimentReport(report)
  return report
}

/** The store one experiment reads: the caller's graph root, exactly as the v1 replay resolves it. */
async function experimentStore(sources: ExperimentSources, caller: SessionId): Promise<{ storeId: string; snapshot: TaskSnapshot }> {
  try {
    const graph = await sources.graphs.graphForSession(caller)
    const storeId = rootTaskStoreId(graph.rootSessionId)
    return { storeId, snapshot: await sources.task.openStore(storeId) }
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The token total one settled side reported: the four buckets the run's own
 * session projection carries, summed exactly the way the runtime's own post-hoc
 * budget check sums them (`budgetBreaches`). `undefined` for a side that
 * reported none — what nobody reported adds nothing to what is known, and is
 * never read as a zero.
 */
function tokensOfRecord(record: ExperimentSampleRecord): number | undefined {
  if (record.cost.status !== 'reported') return undefined
  const tokens = record.cost.metrics.tokens
  if (tokens === undefined || typeof tokens !== 'object') return undefined
  const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  return Number.isFinite(total) && total >= 0 ? total : undefined
}

/** The known token total of a set of settled sides: every reported four-bucket sum, added up. */
function reportedTokensSpent(records: readonly ExperimentSampleRecord[]): number {
  return records.reduce((sum, record) => sum + (tokensOfRecord(record) ?? 0), 0)
}

/**
 * Whether the frozen budget still leaves room for one more side to start (S4-E
 * §F.2; the progress review's Q1: the maximum bounds the *whole experiment*, not
 * one side).
 *
 * `maxTokens` is the one ceiling: the sides already settled report a known
 * total, and no further side is started once that total has consumed the
 * ceiling. The next side's own spend is not knowable before it settles, so
 * starting one into an exhausted budget could only overshoot, and the promotion
 * gate refuses a recorded total above the ceiling either way.
 *
 * The refusal is named and carries the numbers; the settled runs stay in the
 * task store and the ledger as what this experiment spent.
 */
function assertBudgetAllowsStart(input: {
  experimentId: string
  budget: ExperimentBudget
  spentTokens: number
  settledSides: number
  /** The side this start would be, for the refusal to name what it declines. */
  where: string
}): void {
  const { experimentId, budget, spentTokens, settledSides, where } = input
  if (budget.maxTokens !== undefined && spentTokens >= budget.maxTokens) {
    const left = budget.maxTokens - spentTokens
    const position = left > 0 ? `${left} tokens left` : left === 0 ? 'the ceiling exactly consumed' : `${-left} over the ceiling`
    throw new Error(
      `evolution: experiment "${experimentId}" is stopped by its frozen budget — maxTokens ${budget.maxTokens} is the whole ` +
      `experiment's ceiling and its ${settledSides} settled side(s) already report ${spentTokens} tokens (${position}), so no further ` +
      `sample side is started (${where} would have been next); the settled runs stay in the task store and the ledger as what this ` +
      'experiment spent, and a promotion whose recorded total passes the ceiling is refused rather than inferred',
    )
  }
}

/**
 * Attempt one capability sample's baseline side for real, and return the
 * runtime's own refusal text (A6).
 *
 * The frozen block already says the production configuration cannot admit this
 * sample — the row is missing or its provider is refused — but *that* is not
 * proof of anything at run time: the side is really offered to the runtime, its
 * whole admission chain runs against the real table, and only a refusal that
 * left nothing behind is recorded. What is checked around the attempt:
 *
 * - the replay must **refuse**, not run: an outcome here means the production
 *   configuration admits the sample now, which contradicts the frozen block, so
 *   the experiment stops by name instead of recording either story;
 * - the store must hold **no task** of this side's lineage: anything persisted
 *   is a run, and a run means this was not an admission refusal;
 * - the runtime's own current answer must still say the same thing (the rows do
 *   not resolve, or the pre-check refuses them) — an unrelated failure that
 *   happened to precede a run is not an admission refusal of the frozen kind;
 * - the refusal must be the runtime's own (`task-runtime: …`), never another
 *   layer's error read as one.
 */
async function refusedBaselineRun(input: {
  sources: ExperimentSources
  storeId: string
  sample: FrozenSample
  lineage: string
  workspace: string
  agentOptions: ReplayTaskOptions['agentOptions']
  caller: SessionId
  signal?: AbortSignal
}): Promise<string> {
  const { sources, storeId, sample, lineage, workspace, caller } = input
  const admission = sample.admission!
  let refusal: string | undefined
  let returned: ReplayRunOutcome | undefined
  try {
    returned = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
      lineage,
      workspace: { path: workspace },
      agentOptions: { ...input.agentOptions },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, caller)
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  if (returned !== undefined) {
    throw new Error(
      `evolution: the production configuration admitted sample "${sample.taskId}" (replay settled ${returned.status}) although the ` +
      `experiment froze its refusal at admission — the configuration moved since the experiment froze, so freeze a new experiment ` +
      'rather than record either story for this side',
    )
  }
  const after = await sources.task.openStore(storeId)
  const persisted = after.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
  if (persisted !== undefined) {
    throw new Error(
      `evolution: the baseline side of sample "${sample.taskId}" was expected to be refused at admission, but the store holds task ` +
      `"${persisted.taskId}" of this side's own lineage — a side that reached the store is a run, and a run is not an admission refusal`,
    )
  }
  const message = refusal ?? 'the runtime refused this replay without a message'
  if (!message.startsWith('task-runtime: ')) {
    throw new Error(
      `evolution: the baseline side of sample "${sample.taskId}" failed before its run for a reason that is not the runtime's own ` +
      `admission refusal (${message}) — the side is not recorded as not-admitted`,
    )
  }
  const table = sources.taskRuntime.listCapabilities?.()
  if (table === undefined) {
    throw new Error(
      `evolution: the effective capability table cannot be read now, so the admission refusal of sample "${sample.taskId}" cannot be ` +
      're-proved — nothing was recorded for this side',
    )
  }
  const stillRefused = admission.source === 'capability-gap'
    ? resolveCapabilities(admission.required, table).missing.length > 0
    : refusedProviderLines(await sources.taskRuntime.capabilityProviderReport(caller, admission.required)).length > 0
  if (!stillRefused) {
    throw new Error(
      `evolution: sample "${sample.taskId}" was frozen as refused at admission (${admission.source}), but the runtime no longer ` +
      `refuses it — the configuration moved since the freeze; freeze a new experiment rather than record a refusal that no longer holds`,
    )
  }
  return message
}

/**
 * Run — or continue — the frozen two-sided experiment, and return the report the
 * ledger records. Idempotent per sample key: a recorded side is reused, an
 * in-flight side is settled from the store and never re-run, and only a side
 * that never ran is started. Every refusal throws with its reason, and the runs
 * that did settle stay in the task store and in the ledger.
 *
 * The frozen budget bounds this whole experiment on the one entry point this
 * plane has: the token total the settled sides reported. A side the budget has no
 * room for is not started, and the refusal names the ceiling and the recorded
 * total; what a settled side really spent is the gate's half of the same rule.
 * Each Run's clock is the runtime's own — this plane places none.
 */
export async function runExperiment(sources: ExperimentSources, request: ExperimentRequest): Promise<ExperimentResult> {
  const { spec, caller, actor } = request
  validateSpec(spec)
  const { sandbox, candidate, capability, overlay, proposal } = await experimentCandidate(sources, spec.proposalId)
  const { storeId, snapshot } = await experimentStore(sources, caller)
  // The judge vocabulary the criteria are frozen against, read before anything
  // is written: a criterion that pins no ref, an unregistered one, or one the
  // registry declares no version for is a refusal here, not an inconclusive
  // verdict after a run.
  const vocabulary = await sources.verifierVocabulary?.()
  const samples: FrozenSample[] = []
  for (const sample of spec.samples) {
    const task = snapshot.tasks.find(item => item.taskId === sample.taskId)
    if (task === undefined) throw new Error(`unknown sample task "${sample.taskId}" in this graph's task store`)
    if (task.status !== 'verified' && task.status !== 'failed') {
      throw new Error(`sample "${sample.taskId}" is ${task.status}; only a terminal (verified or failed) sample can be evaluated`)
    }
    const review = latestReview(snapshot, task)
    if (review === undefined) {
      throw new Error(`sample "${sample.taskId}" has no review record on its latest run; there is no case to reproduce`)
    }
    assertSampleRole(sample, task, review)
    // Before anything runs: what each side of this sample must bind, read
    // through the runtime's own pre-check. A skill sample freezes the
    // production identity the baseline side binds; a capability sample (A6)
    // freezes the overlay identity its candidate side binds, beside either the
    // production identity (production admits the sample) or the production
    // refusal that stands in the baseline side's place.
    const providers: SampleProviders = capability === undefined
      ? {
        provider: await frozenProviderIdentity({
          sources,
          caller,
          sampleTaskId: sample.taskId,
          required: task.requestedCapabilities,
          candidate: candidate!,
          where: `sample "${sample.taskId}"`,
        }),
      }
      : await frozenCapabilitySample({
        sources,
        caller,
        sampleTaskId: sample.taskId,
        required: task.requestedCapabilities,
        overlay: overlay!,
      })
    samples.push(frozenSampleOf(sample, task, review, providers, vocabulary))
  }
  const frozen = freezeExperiment({
    proposalId: spec.proposalId,
    spec,
    ...(candidate === undefined ? {} : { candidate }),
    ...(proposal.prepared?.skillBaseline == null ? {} : { productionBaseline: proposal.prepared.skillBaseline }),
    ...(capability === undefined ? {} : { capability }),
    sandbox,
    snapshotDigest: await directoryDigest(spec.snapshot.sourceDir),
    samples,
  })
  // The model selection, verbatim, as every side's `agentOptions` (S4-E §Q3):
  // the runtime forwards it to the real spawn, and the frozen block keeps the
  // structured value the gate re-reads from the runs' own session logs. The
  // effort member is the deployment's own branded id coming back through the
  // frozen block, which is why it is handed back as `AgentOptions` rather than
  // re-typed here.
  const agentOptions = agentOptionsOf(frozen.model) as ReplayTaskOptions['agentOptions']
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(spec.proposalId, frozenDigest)
  const sandboxRel = `${sandbox}/exp-${experimentId}`

  // One read of every experiment this proposal already has, before anything is
  // written: the key map decides reuse, and a key another *frozen* experiment
  // already spent refuses the call here — before a run, before a ledger line.
  const recorded = new Map<string, ExperimentSampleRecord>()
  for (const previous of await sources.evolution.experiments(spec.proposalId)) {
    for (const record of previous.samples) recorded.set(experimentSampleKey(record), record)
  }
  for (const sample of frozen.samples) {
    for (const side of EXPERIMENT_SIDES) {
      const key = experimentSampleKeyOf({ proposalId: spec.proposalId, frozen }, sample.taskId, side)
      const prior = recorded.get(experimentSampleKey(key))
      if (prior !== undefined && prior.experimentId !== experimentId) throw sameKeyRefusal(key, prior, experimentId)
    }
  }

  await sources.evolution.recordExperimentStart({
    formatVersion: 4,
    kind: 'experiment_started',
    proposalId: spec.proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: experimentReportPath(spec.proposalId, experimentId),
    storeId,
    actor,
    at: new Date().toISOString(),
  })
  const view = await sources.evolution.experiment(experimentId)

  // The frozen budget's one count, read off the ledger once (§F.2; the review's
  // Q1): the token total every side already settled has reported, so a restart
  // continues the same count rather than resetting it.
  const budget = view.frozen.budget
  let spentTokens = reportedTokensSpent(view.samples)
  let settledSides = view.samples.length

  let started = 0
  try {
    sampleLoop: for (const sample of view.frozen.samples) {
      for (const side of EXPERIMENT_SIDES) {
        const key = experimentSampleKeyOf(view, sample.taskId, side)
        const lineage = experimentLineage(view.experimentId, sample.taskId, side)
        const workspace = resolve(sources.evolution.root, sandboxRel, sample.taskId, side)
        const prior = recorded.get(experimentSampleKey(key))
        if (prior !== undefined) {
          assertRecordedRunOrigin(snapshot, lineage, key, prior)
          continue
        }
        if (request.signal?.aborted) break sampleLoop
        const inFlight = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
        if (inFlight !== undefined) {
          const recovered = recoveredSampleRecord({ view, sample, side, task: inFlight, snapshot, workspace, actor })
          await sources.evolution.recordExperimentSample(recovered)
          recorded.set(experimentSampleKey(key), recovered)
          spentTokens += tokensOfRecord(recovered) ?? 0
          settledSides += 1
          continue
        }
        // Before this side spends anything: the whole-experiment budget. The
        // known total is read from the ledger (never reset by a restart), and a
        // side the budget no longer has room for is not started — by name, with
        // the numbers, rather than silently.
        assertBudgetAllowsStart({
          experimentId: view.experimentId,
          budget,
          spentTokens,
          settledSides,
          where: `sample "${sample.taskId}" ${side} side`,
        })
        const real = await buildWorkspace(spec.snapshot.sourceDir, workspace, view.frozen.snapshot.digest)
        // A6: the frozen production configuration refuses this sample, so its
        // baseline side is really attempted — the runtime runs its own admission
        // chain against the real table and refuses it — and the refusal is what
        // gets recorded. No Run is created, none is invented, and a production
        // configuration that admits the sample now is a drift this experiment
        // cannot record: the block froze the refusal.
        if (side === 'baseline' && sample.admission !== undefined) {
          const refusal = await refusedBaselineRun({
            sources,
            storeId,
            sample,
            lineage,
            workspace: real,
            agentOptions,
            caller,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          const admitted = sampleRecord({
            view,
            sample,
            side,
            outcome: 'not-admitted',
            criteria: [],
            evidenceRefs: [],
            workspace: real,
            cost: {
              status: 'unknown',
              reason: 'the runtime refused this side at admission, so no run exists and no cost was reported for it',
            },
            admission: {
              source: sample.admission.source,
              proposalId: view.proposalId,
              sourceRefs: [...(view.frozen.capability?.sourceRefs ?? [])],
              required: [...sample.admission.required],
              missing: [...sample.admission.missing],
              reason: refusal,
            },
            actor,
          })
          await sources.evolution.recordExperimentSample(admitted)
          recorded.set(experimentSampleKey(key), admitted)
          settledSides += 1
          continue
        }
        const outcome = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
          lineage,
          workspace: { path: real },
          agentOptions: { ...agentOptions },
          ...(side === 'candidate'
            ? { overlay: overlay ?? { extraSkillRoots: [resolve(sources.evolution.root, sandbox, 'skills')] } }
            : {}),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }, caller)
        if (outcome.workspace !== undefined && outcome.workspace !== real) {
          throw new Error(
            `the replay of "${sample.taskId}" reported workspace "${outcome.workspace}" but was given "${real}"; ` +
            "a side's frozen input and the directory its run went through must be the same directory",
          )
        }
        const after = await sources.task.openStore(storeId)
        const replayed = after.tasks.find(item => item.taskId === outcome.taskId)
        if (replayed === undefined) {
          throw new Error(`the replay of "${sample.taskId}" created task "${outcome.taskId}", which the store does not hold`)
        }
        const facts = runFactsOf(after, replayed, outcome)
        const fresh = sampleRecord({
          view,
          sample,
          side,
          outcome: facts.outcome,
          ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
          ...(facts.runId === undefined ? {} : { runId: facts.runId }),
          ...(facts.review === undefined ? {} : { review: facts.review }),
          criteria: facts.criteria,
          evidenceRefs: facts.evidenceRefs,
          workspace: real,
          initialDigest: view.frozen.snapshot.digest,
          cost: costOf(facts.review),
          actor,
        })
        await sources.evolution.recordExperimentSample(fresh)
        recorded.set(experimentSampleKey(key), fresh)
        spentTokens += tokensOfRecord(fresh) ?? 0
        settledSides += 1
        started += 1
        // A run that settled cancelled is a stop somebody asked for: no further
        // side is started under it, and the settled ones stay recorded.
        if (facts.outcome === 'cancelled') break sampleLoop
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (started === 0) throw error instanceof Error ? error : new Error(message)
    throw new Error(
      `${message} (the experiment stopped; ${started} sample run(s) it started settled and stay in the ledger and the task store ` +
      `as evidence — resume experiment ${experimentId} to continue it)`,
    )
  }

  const finalView = await sources.evolution.experiment(experimentId)
  let report: ExperimentReport
  try {
    report = buildExperimentReport(finalView)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} — resume experiment ${experimentId} to continue it`)
  }
  const abs = resolve(sources.evolution.root, finalView.report)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { proposalId: finalView.proposalId, experimentId, report, reportPath: finalView.report, experiment: finalView }
}

/**
 * Resume a frozen experiment by id: its specification *is* the frozen block, so
 * a caller needs to remember nothing but the id. The block is re-derived from
 * the current world before anything runs, and the re-derivation must reproduce
 * the recorded one — a candidate, a sample contract, a model or a snapshot that
 * moved since the experiment froze is refused by name rather than run under a
 * different identity.
 */
export async function resumeExperiment(
  sources: ExperimentSources,
  request: { experimentId: string; caller: SessionId; actor: string; signal?: AbortSignal },
): Promise<ExperimentResult> {
  const view = await sources.evolution.experiment(request.experimentId)
  const spec: ExperimentSpec = {
    proposalId: view.proposalId,
    samples: view.frozen.samples.map(sample => ({ taskId: sample.taskId, role: sample.role })),
    snapshot: { sourceDir: view.frozen.snapshot.sourceDir },
    model: view.frozen.model,
    budget: view.frozen.budget,
    repetition: view.frozen.repetition,
  }
  return runExperiment(sources, {
    spec,
    caller: request.caller,
    actor: request.actor,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
}

/**
 * A recorded sample that cites a run this experiment did not create is refused:
 * the historical champion locates the case and is never a baseline, so a record
 * whose run no run of this experiment's own lineage created is not reused, and
 * nothing downstream is allowed to read it as evidence.
 */
function assertRecordedRunOrigin(snapshot: TaskSnapshot, lineage: string, key: ExperimentKey, record: ExperimentSampleRecord): void {
  if (record.runId === undefined) return
  const task = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
  if (task === undefined || !task.runIds.includes(record.runId)) {
    throw new Error(
      `experiment: the recorded sample ${experimentSampleLabel(key)} cites run "${record.runId}", which no run of this ` +
      `experiment's own replay (lineage ${lineage}) created — the historical record locates the case and is never a baseline; ` +
      'the record and the store disagree, so nothing here is reused',
    )
  }
}

/** One sample key a different frozen experiment already spent (§F.2: a re-run needs an explicit new experiment). */
function sameKeyRefusal(key: ExperimentKey, prior: ExperimentSampleRecord, experimentId: string): Error {
  return new Error(
    `experiment: sample ${experimentSampleLabel(key)} is already recorded by experiment ${prior.experimentId} ` +
    `(frozen at ${prior.at}), which is not this one (${experimentId}) — the key is spent and its record is never ` +
    'overwritten; freeze a new experiment at a higher repetition to run this side again',
  )
}

/* -------------------------------------------------------------------------- *
 * The ledger family: record validation and the fold
 * -------------------------------------------------------------------------- */

/**
 * Validate one `experiment_started` line in its own right: the proposal it names
 * exists, the experiment id, frozen digest, budget and report path are exactly
 * what the frozen block derives. Used by the fold and by the service's own write
 * path, so a line that reaches the append is checked the same way one read back
 * from the file is.
 */
export function assertExperimentStartRecord(record: ExperimentStartedRecord, proposals: ReadonlyMap<string, EvolutionProposal>): void {
  if (proposals.get(record.proposalId) === undefined) {
    throw new Error(`evolution: experiment_started record for unknown proposal "${record.proposalId}"`)
  }
  if (typeof record.experimentId !== 'string' || !/^[a-f0-9]{16}$/.test(record.experimentId)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an invalid experiment id`)
  }
  assertFrozenExperiment(record.frozen)
  if (record.frozen.proposalId !== record.proposalId) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" freezes proposal "${record.frozen.proposalId}"`)
  }
  if (record.frozenDigest !== frozenDigestOf(record.frozen)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has a digest that does not match its frozen block`)
  }
  if (canonicalJson(record.budget) !== canonicalJson(record.frozen.budget)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" carries a budget that is not the frozen one`)
  }
  if (record.experimentId !== experimentIdOf(record.proposalId, record.frozenDigest)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an id that does not match its frozen identity`)
  }
  if (record.report !== experimentReportPath(record.proposalId, record.experimentId)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" names a report path outside its own sandbox`)
  }
  if (record.storeId !== undefined && (typeof record.storeId !== 'string' || record.storeId.length === 0)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has a malformed task store id`)
  }
  nonEmpty(record.actor, 'experiment_started actor')
  nonEmpty(record.at, 'experiment_started at')
}

function assertSampleCriteria(criteria: unknown, field: string): asserts criteria is ReviewCriterion[] {
  if (!Array.isArray(criteria)) throw new Error(`evolution: ${field} must be an array`)
  const ids = new Set<string>()
  for (const criterion of criteria) {
    if (criterion === null || typeof criterion !== 'object'
      || typeof (criterion as ReviewCriterion).criterionId !== 'string' || (criterion as ReviewCriterion).criterionId.length === 0
      || !['pass', 'fail', 'inconclusive'].includes((criterion as ReviewCriterion).verdict)
      || ids.has((criterion as ReviewCriterion).criterionId)) {
      throw new Error(`evolution: ${field} has an invalid or duplicate criterion verdict`)
    }
    const detail = criterion as ReviewCriterion
    for (const member of ['verifierId', 'verifierVersion', 'command'] as const) {
      if (detail[member] !== undefined && (typeof detail[member] !== 'string' || detail[member].length === 0)) {
        throw new Error(`evolution: ${field} has a malformed ${member}`)
      }
    }
    if (detail.exitCode !== undefined && typeof detail.exitCode !== 'number') {
      throw new Error(`evolution: ${field} has a malformed exit code`)
    }
    ids.add(detail.criterionId)
  }
}

function assertExperimentSample(record: ExperimentSampleRecord, view: ExperimentView | undefined, key: ExperimentKey): void {
  const field = `experiment_sample record for ${experimentSampleLabel(key)}`
  if (view === undefined) {
    throw new Error(`evolution: ${field} names unknown experiment "${record.experimentId}"`)
  }
  if (view.proposalId !== record.proposalId) throw new Error(`evolution: ${field} names a different proposal than its experiment`)
  if (record.preparedContentDigest !== preparedContentDigestOf(view.frozen)) {
    throw new Error(`evolution: ${field} names a candidate content identity that is not the experiment's own`)
  }
  if (record.repetition !== view.frozen.repetition) {
    throw new Error(`evolution: ${field} names a repetition that is not the experiment's own`)
  }
  if (!view.frozen.samples.some(sample => sample.taskId === record.sampleTaskId)) {
    throw new Error(`evolution: ${field} names sample "${record.sampleTaskId}", which the experiment never froze`)
  }
  if (!EXPERIMENT_SIDES.includes(record.side)) {
    throw new Error(`evolution: ${field} has an unknown side "${String(record.side)}"`)
  }
  if (!EXPERIMENT_OUTCOMES.includes(record.outcome)) {
    throw new Error(`evolution: ${field} has an unknown outcome "${String(record.outcome)}"`)
  }
  for (const member of ['taskId', 'runId', 'reviewRef'] as const) {
    if (record[member] !== undefined && (typeof record[member] !== 'string' || record[member].length === 0)) {
      throw new Error(`evolution: ${field} has a malformed ${member}`)
    }
  }
  if (typeof record.workspace !== 'string' || record.workspace.length === 0) {
    throw new Error(`evolution: ${field} names no workspace`)
  }
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)) {
    throw new Error(`evolution: ${field} has a malformed evidence ref list`)
  }
  assertSampleCriteria(record.criteria, `${field} criteria`)
  if (record.cost === null || typeof record.cost !== 'object') throw new Error(`evolution: ${field} has no cost`)
  if (record.cost.status === 'unknown') {
    if (typeof record.cost.reason !== 'string' || record.cost.reason.length === 0) {
      throw new Error(`evolution: ${field} reports an unknown cost without saying why`)
    }
  } else if (record.cost.status !== 'reported' || record.cost.metrics === null || typeof record.cost.metrics !== 'object') {
    throw new Error(`evolution: ${field} has a malformed cost report`)
  }
  if (record.outcome === 'not-admitted') {
    // A6: the runtime refused this side at admission. The record is the
    // refusal and nothing else — no run, no evidence, no criteria — and only a
    // baseline side may carry it.
    if (record.side !== 'baseline') {
      throw new Error(
        `evolution: ${field} records the candidate side as not-admitted — a candidate the runtime will not admit produced no run, so ` +
        'it fixed nothing and cannot stand as a fix; only a baseline side may be not-admitted',
      )
    }
    if (record.admission === undefined) {
      throw new Error(`evolution: ${field} is not-admitted without the runtime's refusal — a side with no run must record why`)
    }
    assertAdmissionRecord(record.admission, field)
    if (record.taskId !== undefined || record.runId !== undefined || record.reviewRef !== undefined) {
      throw new Error(
        `evolution: ${field} is not-admitted and cites a task, a run or a review — a refused side produced no run, and a failure run ` +
        'invented in its place is not evidence',
      )
    }
    if (record.evidenceRefs.length > 0 || record.criteria.length > 0) {
      throw new Error(`evolution: ${field} is not-admitted and cites evidence or criteria — no run produced any`)
    }
    return
  }
  if (record.admission !== undefined) {
    throw new Error(`evolution: ${field} carries an admission refusal but settled as "${String(record.outcome)}"`)
  }
  if (record.outcome === 'interrupted') {
    if (typeof record.reason !== 'string' || record.reason.length === 0) {
      throw new Error(`evolution: ${field} is interrupted and must carry the reason it has no terminal run`)
    }
    return
  }
  if (record.initialDigest === undefined || !isHex64(record.initialDigest)) {
    throw new Error(`evolution: ${field} settled a run and must carry the frozen digest its workspace was built from`)
  }
}

/**
 * Fold the ledger's experiment family: every `experiment_started` opens an
 * experiment, every `experiment_sample` must belong to one, and the sample key
 * is unique across the whole ledger. A hand-forged line fails exactly the checks
 * a live write passes — the frozen block is re-hashed, the id re-derived, the
 * budget re-compared, and the record's key parts re-checked against the
 * experiment it claims — so the read path and the write path agree on what a
 * record is.
 *
 * The proposal fold is the other half of the same ledger and is not this
 * function's business; the caller passes its result in for the one cross-check
 * that spans the two (`experiment_started` must name a real proposal).
 */
export function foldExperiments(
  records: readonly { kind: string }[],
  proposals: ReadonlyMap<string, EvolutionProposal>,
): Map<string, ExperimentView> {
  const views = new Map<string, ExperimentView>()
  const keys = new Set<string>()
  for (const raw of records) {
    if (!isExperimentRecord(raw)) continue
    const record = raw as ExperimentStartedRecord | ExperimentSampleRecord
    if (record.kind === 'experiment_started') {
      if (views.has(record.experimentId)) {
        throw new Error(`evolution: experiment "${record.experimentId}" is recorded twice`)
      }
      assertExperimentStartRecord(record, proposals)
      views.set(record.experimentId, {
        experimentId: record.experimentId,
        proposalId: record.proposalId,
        frozen: record.frozen,
        frozenDigest: record.frozenDigest,
        budget: record.budget,
        report: record.report,
        ...(record.storeId === undefined ? {} : { storeId: record.storeId }),
        at: record.at,
        samples: [],
      })
      continue
    }
    const view = views.get(record.experimentId)
    const key: ExperimentKey = {
      proposalId: record.proposalId,
      preparedContentDigest: record.preparedContentDigest,
      sampleTaskId: record.sampleTaskId,
      side: record.side,
      repetition: record.repetition,
    }
    assertExperimentSample(record, view, key)
    const id = experimentSampleKey(key)
    if (keys.has(id)) {
      throw new Error(`evolution: sample ${experimentSampleLabel(key)} is recorded twice; a recorded run is never overwritten or re-run`)
    }
    keys.add(id)
    view!.samples.push(record)
  }
  return views
}

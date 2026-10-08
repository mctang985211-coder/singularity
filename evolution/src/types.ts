import type { TaskDefinitionIdentity } from './task-definition.ts'
/** The evolution plane's public vocabulary: lifecycle levels and records, the decisions and the provider roles a promotion reports.
 * @module dsh-singularity-evolution/types */

import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'
import type { SkillProviderVerdict } from '@dangosys/dsh-singularity-task-runtime'
import type { McpServerTemplate, CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { McpServerIdentity, CapabilityRowIdentity } from './capability-candidate.ts'
import type { SkillContentIdentity } from './replay.ts'
import type { ModelSelection } from './replay.ts'
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

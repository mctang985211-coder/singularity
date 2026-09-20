/**
 * Evolution admission track v1 (guide §2.7.6/§2.7.7): an append-only ledger of
 * EvolutionProposals with the state machine proposed → candidate → prepared →
 * (replayed for mechanical mutations) → gated → decided. A candidate may carry
 * a structured mutation; only then is the prepared state reachable, and
 * evolution_prepare materializes it into the per-proposal sandbox
 * (`<root>/sandbox/<proposalId>/`) plus a champion snapshot of the current
 * production target. A mechanical mutation must then be replayed
 * (`evolution_replay`): the candidate runs against historical terminal tasks of
 * the same graph under a per-run overlay, the comparison lands in
 * `sandbox/<id>/replay-report.json`, and the gate requires that report in its
 * regression evidence. PROMOTE takes effect through `evolution_apply` (W16):
 * the three materialized mechanical types (skill / agent_preset / capability)
 * are copied from the sandbox into production — decided → applied →
 * (optionally) rolledback — each transition only after its own human approval
 * granted through the native approval seam (done by the tools, not here). L4
 * proposals, the five bookkeeping-only types, and task_definition never apply:
 * the ledger records them and a human edits production by hand.
 * @module dsh-singularity-agent
 */

import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { ReplayRelation, ReplayReport, ReplayVerdict } from './replay.ts'
import { assertReplayPromotable, assertReplayReport, REPLAY_RELATIONS, REPLAY_VERDICTS } from './replay.ts'
import { editCapabilityRow, readCapabilityRowSource, restoreCapabilityRowSource } from './config-edit.ts'
import type { CapabilityRowResult } from './config-edit.ts'

export type { ProposalTargetType } from '@dangosys/dsh-singularity-task'
export type {
  ReplayCriterionDiff,
  ReplayCriterionSummary,
  ReplayRelation,
  ReplayReport,
  ReplaySideSummary,
  ReplayTaskComparison,
  ReplayVerdict,
} from './replay.ts'
export { compareReplaySides, overallReplayVerdict, REPLAY_RELATIONS, REPLAY_VERDICTS } from './replay.ts'

export type EvolutionLevel = 'L1' | 'L2' | 'L3' | 'L4'
export type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'replayed' | 'gated' | 'decided' | 'applied' | 'rolledback'
/** The three frozen decision values of the Validation Gate (细化想法4.md §32). */
export type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH'

export const EVOLUTION_LEVELS: readonly EvolutionLevel[] = ['L1', 'L2', 'L3', 'L4']
export const EVOLUTION_DECISIONS: readonly EvolutionDecision[] = ['PROMOTE', 'REJECT', 'KEEP_FOR_FURTHER_RESEARCH']

/**
 * The four target types whose mutations this version materializes mechanically
 * into the sandbox. Mutations on the other five target types (tool /
 * decomposition_policy / workflow_policy / verifier / runtime_policy) are
 * free-form structured descriptions, recorded with `mechanical: false` —
 * bookkeeping only, never materialized.
 */
export const MECHANICAL_TARGET_TYPES: readonly ProposalTargetType[] = ['skill', 'agent_preset', 'capability', 'task_definition']

/** True for the target types whose mutations materialize mechanically into the sandbox. */
export function mutationMechanical(targetType: ProposalTargetType): boolean {
  return MECHANICAL_TARGET_TYPES.includes(targetType)
}

/**
 * The three target types `evolution_apply` promotes mechanically (W16): the
 * sandbox copy lands on a real production root. task_definition stays manual
 * (the task store keeps no definitions registry — W14's fidelity cap), and the
 * five bookkeeping-only types never materialized anything to apply.
 */
export const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[] = ['skill', 'agent_preset', 'capability']

/**
 * Whether a decided proposal may record `applied`: the decision is PROMOTE,
 * the level is not L4 (L4 harness evolution is human-run by rule, §2.7.7 /
 * §2.9.2), the target type is one of the three applyable mechanical ones, and
 * a sandbox was actually materialized (a mutation-less manual candidate has
 * nothing to copy).
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

/** agent_preset mutation: full file contents, paths relative to the preset directory. */
export interface AgentPresetMutation {
  presetId: string
  files: { path: string; content: string }[]
}

/**
 * capability mutation: one entry of the task-runtime capability table
 * (`{ skills?, tools?, preset?, permission?, mcpServers? }`); takes effect with
 * whole-row replacement semantics, and only when a human edits production.
 */
export interface CapabilityMutation {
  name: string
  entry: CapabilityConfig
}

/** task_definition mutation: the new version's definition fields, deltaing from baseVersion. */
export interface TaskDefinitionMutation {
  baseVersion: string
  definition: Record<string, unknown>
}

export type MechanicalMutation = SkillMutation | AgentPresetMutation | CapabilityMutation | TaskDefinitionMutation

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
 * Where a capability champion snapshot came from (W19, guide §4.2 #18):
 * - `config-text` — the row existed in config.yml; the snapshot also holds its
 *   verbatim source lines (`champion/capability-table.source.txt`) and rollback
 *   writes those lines back byte-for-byte.
 * - `code-default` — the capability exists only in the code default table (no
 *   config.yml row); the snapshot holds the registry entry as the comparison
 *   anchor, and rollback removes the config.yml row so the default governs
 *   again (plus a runtime override back to the default entry).
 * - `missing` — the capability did not exist at all; rollback deletes what the
 *   apply added (`champion: 'missing'` carries the same fact; this field keeps
 *   the three-way distinction readable on one field).
 * Recorded on the `prepared` ledger record of capability proposals only;
 * records written before this field existed carry no `championSource`, hold a
 * registry-form snapshot, and roll back exactly as they always did.
 */
export type ChampionSource = 'config-text' | 'code-default' | 'missing'

export const CHAMPION_SOURCES: readonly ChampionSource[] = ['config-text', 'code-default', 'missing']

/** Folded view of one `prepared` record. */
export interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null
  mechanical: boolean
  champion: ChampionState
  /** Capability prepares only (W19): where the champion snapshot came from; absent on pre-W19 records. */
  championSource?: ChampionSource
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[]
}

/**
 * Champion content the caller resolves for the target types whose production
 * state lives outside this plane (plane separation: the ledger never reads the
 * task store or the capability registry itself; skill/preset champions it reads
 * from the production roots directly). Pass null when the production target is
 * known absent; omitting the key for a capability / task_definition prepare is
 * an error.
 */
export interface PrepareChampion {
  /**
   * The mutation-named capability's current effective entry (taskRuntime.listCapabilities), or null when new.
   * Kept as the comparison anchor and the runtime-override payload; the rollback
   * text anchor is the config.yml row's source text, which the service reads
   * itself (W19).
   */
  capabilityEntry?: CapabilityConfig | null
  /** The baseVersion definition snapshot from the task store, or null when unresolvable. */
  taskDefinition?: unknown
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
      /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
      files: string[]
      actor: string
      at: string
    }
  | {
      formatVersion: 1
      kind: 'replayed'
      proposalId: string
      /** SHA-256 of the report bytes. Historical records may lack it; those cannot newly promote. */
      reportDigest?: string
      /** Report path relative to the ledger root (`sandbox/<proposalId>/replay-report.json`). */
      report: string
      /** Overall verdict: whether the candidate is not worse than the champion. */
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
   * Capability only: the row now in effect — the candidate entry on apply, the
   * restored champion entry on rollback, null when the rollback removed a
   * newly-added row. The tool mirrors it into the runtime registry so the
   * change takes effect without a restart.
   */
  capability?: { name: string; entry: CapabilityConfig | null }
}

/** Folded view of one `replayed` record. */
export interface ReplayedView {
  /** SHA-256 recorded at replay; required for new promotion of a mechanical candidate. */
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
   * falling back to `<repo root>/.dsh/evolution` when `DSH_HOME` is unset (same
   * derivation as the verifier's evidenceRoot).
   */
  root?: string
  /** Production skill root — champion snapshots read from here; apply/rollback write here. Defaults to `$DSH_HOME/skills`. */
  skillRoot?: string
  /** Production agent-preset root — champion snapshots read from here; apply/rollback write here. Defaults to `$DSH_HOME/.agent-presets`. */
  presetRoot?: string
  /**
   * The production `config.yml` whose document-1 task-runtime row a capability
   * apply/rollback edits (text-level surgery on that one row; every other byte
   * is preserved). Defaults to `<repo root>/config.yml`.
   */
  configFile?: string
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
 * ledgers replay against. A prepared MECHANICAL mutation must then be replayed
 * (candidate vs champion over this graph's historical terminal tasks) before it
 * can gate; a bookkeeping-only (non-mechanical) one has nothing to replay and
 * gates from prepared. After the human decision, only a PROMOTE on an
 * applyable, materialized, sub-L4 mutation can be applied (W16), and only an
 * applied proposal can be rolled back.
 */
function nextStates(proposal: EvolutionProposal): readonly EvolutionStatus[] {
  switch (proposal.status) {
    case 'proposed':
      return ['candidate']
    case 'candidate':
      return proposal.mutation === undefined ? ['gated'] : ['prepared']
    case 'prepared':
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
    : current.status === 'prepared' && mutationMechanical(current.targetType) && kind === 'gated'
      ? ' — this mutation was materialized; record "replayed" first (evolution_replay)'
      : current.status === 'decided' && kind === 'applied'
        ? current.decision !== 'PROMOTE'
          ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied`
          : ' — only a materialized skill / agent_preset / capability mutation at L1–L3 applies; anything else stays a manual human edit'
        : ''
  throw new Error(`evolution: proposal "${current.proposalId}" is ${current.status}; cannot record "${kind}"${hint}`)
}

/**
 * The capability patch file: a YAML header recording the whole-row replacement
 * semantics, then the entry as one JSON object line (JSON is valid YAML 1.2, so
 * the artifact stays parseable without a YAML dependency).
 */
function capabilityPatchYaml(proposalId: string, name: string, entry: CapabilityConfig): string {
  return [
    `# Evolution capability patch — proposal ${proposalId}, capability "${name}"`,
    '# Apply semantics: whole-row replacement — this entry replaces the row for this name',
    "# under `capabilities:` in config.yml doc 1's task-runtime line verbatim (no deep merge).",
    '# Sandbox artifact only: nothing applies it automatically; a human edit of production',
    '# is the only way it takes effect.',
    JSON.stringify({ [name]: entry }),
    '',
  ].join('\n')
}

/**
 * Champion twin of the patch file: the entry currently in effect, same whole-row
 * semantics. Comparison anchor and runtime-override payload; the rollback text
 * anchor is the source-text snapshot (`capability-table.source.txt`) when the
 * row lives in config.yml (W19).
 */
function championEntryYaml(name: string, entry: CapabilityConfig): string {
  return [
    `# Champion snapshot — capability "${name}" as in effect at prepare time`,
    '# (task-runtime capability registry). Anchor for candidate-vs-champion diff and',
    '# rollback; whole-row replacement semantics, same as the patch file.',
    JSON.stringify({ [name]: entry }),
    '',
  ].join('\n')
}

/** Read back the champion capability snapshot: the single JSON line under the `#` header, keyed by the capability name. */
function parseChampionEntry(text: string, name: string): CapabilityConfig {
  const line = text.split('\n').map(item => item.trim()).filter(item => item.length > 0 && !item.startsWith('#')).at(-1)
  if (line === undefined) throw new Error('evolution: the champion capability snapshot carries no entry line')
  const parsed: unknown = JSON.parse(line)
  if (!isRecord(parsed) || !(name in parsed) || !isRecord(parsed[name])) {
    throw new Error(`evolution: the champion capability snapshot does not hold an entry for "${name}"`)
  }
  return parsed[name] as CapabilityConfig
}

/**
 * The production write targets of an apply (and its matching rollback), for
 * the approval reason and the audit record — the human sees exactly what a
 * grant will touch.
 */
export function applyTargets(
  proposal: EvolutionProposal,
  roots: { skillRoot: string; presetRoot: string; configFile: string },
): string[] {
  const mutation = proposal.mutation
  switch (proposal.targetType) {
    case 'skill':
      return [join(roots.skillRoot, (mutation as SkillMutation).name, 'SKILL.md')]
    case 'agent_preset':
      return [join(roots.presetRoot, (mutation as AgentPresetMutation).presetId)]
    case 'capability':
      return [`${roots.configFile} — document 1 task-runtime capabilities row "${(mutation as CapabilityMutation).name}"`]
    default:
      return []
  }
}

/** All files under `dir` as `/`-joined relative paths, sorted for a deterministic ledger record. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      for (const nested of await listFiles(join(dir, entry.name))) files.push(`${entry.name}/${nested}`)
    } else {
      files.push(entry.name)
    }
  }
  return files
}

/**
 * The Evolution plane ledger (plane separation: this store is independent of
 * the task store and refers to it by id only). Replay and append share one
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
  /** Production agent-preset root — champion snapshots read from here; apply/rollback write here. */
  readonly presetRoot: string
  /** Production config.yml a capability apply/rollback edits. */
  readonly configFile: string
  /** Repo root that relative evidence paths resolve against. */
  readonly repoRoot: string
  private records: EvolutionRecord[] = []
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolution')
    this.repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
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
   */
  async candidate(
    proposalId: string,
    versionSet: Record<string, string>,
    actor: string,
    mutation?: unknown,
  ): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'candidate')
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
   * Move candidate → prepared: materialize a mechanical mutation into
   * `<root>/sandbox/<proposalId>/` and snapshot the champion (the current
   * production target) under `champion/` — the anchor for candidate-vs-champion
   * comparison and rollback. A production target that does not exist yet
   * records `champion: 'missing'` (champion: null). Non-mechanical mutations
   * materialize nothing and record `mechanical: false`. Materialization runs
   * before the ledger append; every write is confined to the sandbox dir.
   */
  async prepare(proposalId: string, actor: string, champion: PrepareChampion = {}): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'prepared')
    const mutation = current.mutation
    if (mutation === undefined) {
      // Unreachable via nextStates (a mutation-less candidate admits only
      // "gated"); stated so the invariant sits next to its use.
      throw new Error(`evolution: proposal "${proposalId}" carries no mutation; nothing to prepare`)
    }
    validateMutation(current.targetType, mutation, current.baseVersion)
    const mechanical = mutationMechanical(current.targetType)
    let sandbox: string | null = null
    let championState: ChampionState = 'none'
    let championSource: ChampionSource | undefined
    let files: string[] = []
    if (mechanical) {
      if (current.targetType === 'capability' && !('capabilityEntry' in champion)) {
        throw new Error('evolution: preparing a capability mutation requires champion.capabilityEntry (pass null when the capability is new)')
      }
      if (current.targetType === 'task_definition' && !('taskDefinition' in champion)) {
        throw new Error('evolution: preparing a task_definition mutation requires champion.taskDefinition (pass null when the base definition is unresolvable)')
      }
      assertSegment(proposalId, 'proposalId')
      const dir = join(this.root, 'sandbox', proposalId)
      const written = await this.materialize(dir, current, mutation, champion)
      sandbox = `sandbox/${proposalId}`
      championState = written.champion
      championSource = written.championSource
      files = written.files
    }
    await this.append({
      formatVersion: 1,
      kind: 'prepared',
      proposalId,
      sandbox,
      mechanical,
      champion: championState,
      ...(championSource === undefined ? {} : { championSource }),
      files,
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move prepared → replayed: record the outcome of the candidate-vs-champion
   * replay (the `evolution_replay` tool ran it) and write the comparison report
   * to `<sandbox>/replay-report.json`. Only a prepared mechanical mutation can
   * be replayed; the report is validated against the proposal (manual mode is
   * the agent_preset v1 boundary — the preset roster cannot mount
   * sandbox-materialized presets — and every other targetType must carry
   * executed evidence). The report write is confined to the sandbox; the ledger
   * record cites it by root-relative path, and the gate later requires that
   * path in its regression evidence.
   */
  async replay(proposalId: string, actor: string, report: unknown): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'replayed')
    assertReplayReport(current, report)
    const sandbox = current.prepared?.sandbox
    if (sandbox === undefined || sandbox === null) {
      throw new Error(`evolution: proposal "${proposalId}" names no sandbox; cannot place the replay report`)
    }
    const rel = `${sandbox}/replay-report.json`
    const abs = resolveWithin(this.root, rel)
    await mkdir(dirname(abs), { recursive: true })
    const content = `${JSON.stringify(report, null, 2)}\n`
    await writeFile(abs, content, 'utf8')
    await this.append({
      formatVersion: 1,
      kind: 'replayed',
      proposalId,
      reportDigest: createHash('sha256').update(content).digest('hex'),
      report: rel,
      verdict: report.verdict,
      tasks: [
        ...report.observed.map(item => ({ taskId: item.taskId, relation: item.relation, holdout: false })),
        ...report.holdout.tasks.map(item => ({ taskId: item.taskId, relation: item.relation, holdout: true })),
      ],
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /**
   * Move candidate → gated (manual candidates), prepared → gated
   * (bookkeeping-only mutations), or replayed → gated (mechanical mutations):
   * all six Gate answers plus regression evidence refs. Every ref must exist —
   * a path on disk (relative to the repo root or absolute) or an id the
   * caller-side resolver knows (task-store evidence). Existence only; nothing
   * here executes anything. A replayed proposal must additionally cite its
   * replay report path; its contents must match the recorded digest and schema.
   */
  async gate(
    proposalId: string,
    answers: GateAnswers,
    actor: string,
    refKnown?: (ref: string) => Promise<boolean>,
  ): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'gated')
    validateGateAnswers(answers)
    // A mechanical mutation reaches the gate only through a replay; the gate
    // must cite the same report that was validated and recorded at replay.
    if (current.replayed !== undefined) {
      const report = current.replayed.report
      if (!answers.regressionEvidenceRefs.includes(report)) {
        throw new Error(`evolution: a replayed candidate's regression evidence must cite the replay report "${report}"`)
      }
      if (!existsSync(resolveWithin(this.root, report))) {
        throw new Error(`evolution: the replay report "${report}" no longer exists under the ledger root`)
      }
      await this.readRecordedReplay(current)
    }
    for (const ref of answers.regressionEvidenceRefs) {
      // The replay report is ledger-root-relative; its existence was checked above.
      if (current.replayed !== undefined && ref === current.replayed.report) continue
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
   * (W16). Reachable only for a PROMOTE decision on a materialized skill /
   * agent_preset / capability mutation at L1–L3 (the state machine itself
   * refuses anything else); the caller (the evolution_apply tool) must hold a
   * human grant from `ctx.approval.request` first, exactly as for decide.
   * Production writes run BEFORE the ledger append, so a failed write leaves
   * the proposal decided and retryable. skill: the sandbox SKILL.md replaces
   * the production one (the champion snapshot covers that file only, so the
   * write is file-level, never a directory delete). agent_preset: whole-dir
   * replacement (the champion snapshot is the full directory). capability:
   * text-level surgery on the one capabilities row in config.yml document 1 —
   * the runtime registry is NOT hot-reloaded by that edit; the tool mirrors
   * the row into the running TaskRuntime afterwards.
   */
  async apply(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    const current = await this.assertNext(proposalId, 'applied')
    nonEmpty(approvalRef, 'approvalRef')
    await this.checkPromotion(proposalId)
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
    return { ...outcome, proposal: await this.get(proposalId) }
  }

  /** Preflight for tools before asking for approval; mutation methods repeat the check. */
  async checkPromotion(proposalId: string): Promise<void> {
    const proposal = await this.get(proposalId)
    if (proposal.prepared?.mechanical !== true) return
    assertReplayPromotable(await this.readRecordedReplay(proposal))
  }

  private async readRecordedReplay(proposal: EvolutionProposal): Promise<ReplayReport> {
    const replay = proposal.replayed
    if (replay?.reportDigest === undefined) {
      throw new Error('evolution: replay has no report digest; run a new candidate replay before promotion')
    }
    const content = await readFile(resolveWithin(this.root, replay.report), 'utf8')
    if (createHash('sha256').update(content).digest('hex') !== replay.reportDigest) {
      throw new Error('evolution: replay report changed after recording; candidate must be evaluated again')
    }
    const report: unknown = JSON.parse(content)
    assertReplayReport(proposal, report)
    return report
  }

  /**
   * Move applied → rolledback: undo the apply. Champion captured → restore the
   * snapshot (skill SKILL.md written back, preset directory replaced,
   * capability row restored — verbatim from `champion/capability-table.source.txt`
   * for a `config-text` champion (W19), row removed for a `code-default`
   * champion so the code default governs again, registry-form restore from
   * `champion/capability-table.entry.yml` for pre-W19 records);
   * champion missing → delete what the apply created (production skill/preset
   * dir removed, capability row dropped). Same approval discipline as apply:
   * the tool asks a human first, the service only executes and records.
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
   * The production write behind apply/rollback. The write side is picked by
   * `direction`; every path goes through `resolveWithin`, so a write can never
   * leave the production root it targets.
   */
  private async writeProduction(proposal: EvolutionProposal, direction: 'apply' | 'rollback'): Promise<Omit<ApplyOutcome, 'proposal'>> {
    const sandbox = proposal.prepared?.sandbox
    const champion = proposal.prepared?.champion
    if (sandbox == null || champion === undefined || proposal.mutation === undefined) {
      throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`)
    }
    switch (proposal.targetType) {
      case 'skill': {
        const { name } = proposal.mutation as unknown as SkillMutation
        const dst = resolveWithin(this.skillRoot, join(name, 'SKILL.md'))
        if (direction === 'rollback' && champion === 'missing') {
          await rm(resolveWithin(this.skillRoot, name), { recursive: true, force: true })
          return { targets: [`${resolveWithin(this.skillRoot, name)} (deleted — the apply had created it)`] }
        }
        const src = resolveWithin(this.root, direction === 'apply' ? `${sandbox}/skills/${name}/SKILL.md` : `${sandbox}/champion/skills/${name}/SKILL.md`)
        const content = await readFile(src, 'utf8')
        await mkdir(dirname(dst), { recursive: true })
        await writeFile(dst, content, 'utf8')
        return { targets: [dst] }
      }
      case 'agent_preset': {
        const { presetId } = proposal.mutation as unknown as AgentPresetMutation
        const dst = resolveWithin(this.presetRoot, presetId)
        if (direction === 'rollback' && champion === 'missing') {
          await rm(dst, { recursive: true, force: true })
          return { targets: [`${dst} (deleted — the apply had created it)`] }
        }
        const src = resolveWithin(this.root, direction === 'apply' ? `${sandbox}/.agent-presets/${presetId}` : `${sandbox}/champion/.agent-presets/${presetId}`)
        await rm(dst, { recursive: true, force: true })
        await mkdir(dirname(dst), { recursive: true })
        await cp(src, dst, { recursive: true })
        return { targets: [dst] }
      }
      case 'capability': {
        const { name, entry } = proposal.mutation as unknown as CapabilityMutation
        const text = await readFile(this.configFile, 'utf8')
        let row: CapabilityConfig | null
        let edited: CapabilityRowResult
        if (direction === 'apply') {
          row = entry
          edited = editCapabilityRow(text, name, row)
        } else if (champion === 'missing') {
          row = null
          edited = editCapabilityRow(text, name, null)
        } else if (proposal.prepared?.championSource === 'config-text') {
          // W19: write the prepare-time source lines back verbatim — the
          // registry-form entry (its schema fills default arrays the source
          // never spelled out) only feeds the runtime override.
          row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), 'utf8'), name)
          const source = await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.source.txt`), 'utf8')
          edited = restoreCapabilityRowSource(text, name, source)
        } else if (proposal.prepared?.championSource === 'code-default') {
          // The champion lives in the code default table: drop the config.yml
          // row so the default governs again, and restore the default entry in
          // the runtime registry.
          row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), 'utf8'), name)
          edited = editCapabilityRow(text, name, null)
        } else {
          // Pre-W19 record: the champion snapshot is the registry-form entry.
          row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), 'utf8'), name)
          edited = editCapabilityRow(text, name, row)
        }
        await writeFile(this.configFile, edited.text, 'utf8')
        return {
          targets: [`${this.configFile} — document 1 task-runtime capabilities row "${name}" (${edited.action})`],
          capability: { name, entry: row === null ? null : structuredClone(row) },
        }
      }
      default:
        throw new Error(`evolution: targetType "${proposal.targetType}" never applies mechanically`)
    }
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
   * The verbatim source lines of the capability's row in the production
   * config.yml (W19), or null when the file or the row is absent — the latter
   * meaning the capability comes from the code default table. A config.yml
   * without a task-runtime capabilities mapping fails loudly, exactly as an
   * apply would.
   */
  private async capabilityRowSource(name: string): Promise<string | null> {
    let text: string
    try {
      text = await readFile(this.configFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return readCapabilityRowSource(text, name)
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
   * Write one mechanical mutation into the sandbox dir `dir`, then the champion
   * snapshot. Every path goes through `resolveWithin`, so a write can never
   * land outside the sandbox; production roots are read-only here. Capability
   * champions carry a `championSource` (W19): the rollback anchor is the
   * config.yml row's verbatim source text when the row exists there.
   */
  private async materialize(
    dir: string,
    proposal: EvolutionProposal,
    mutation: Record<string, unknown>,
    champion: PrepareChampion,
  ): Promise<{ files: string[]; champion: 'captured' | 'missing'; championSource?: ChampionSource }> {
    const files: string[] = []
    const write = async (rel: string, content: string): Promise<void> => {
      const abs = resolveWithin(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      files.push(rel)
    }
    switch (proposal.targetType) {
      case 'skill': {
        const { name, content } = mutation as unknown as SkillMutation
        await write(`skills/${name}/SKILL.md`, content)
        const championFile = join(this.skillRoot, name, 'SKILL.md')
        if (!existsSync(championFile)) return { files, champion: 'missing' }
        await write(`champion/skills/${name}/SKILL.md`, await readFile(championFile, 'utf8'))
        return { files, champion: 'captured' }
      }
      case 'agent_preset': {
        const { presetId, files: presetFiles } = mutation as unknown as AgentPresetMutation
        for (const file of presetFiles) await write(`.agent-presets/${presetId}/${file.path}`, file.content)
        const championDir = join(this.presetRoot, presetId)
        if (!existsSync(championDir)) return { files, champion: 'missing' }
        const target = resolveWithin(dir, `champion/.agent-presets/${presetId}`)
        await mkdir(dirname(target), { recursive: true })
        await cp(championDir, target, { recursive: true })
        for (const rel of await listFiles(target)) files.push(`champion/.agent-presets/${presetId}/${rel}`)
        return { files, champion: 'captured' }
      }
      case 'capability': {
        const { name, entry } = mutation as unknown as CapabilityMutation
        await write('capability-table.patch.yml', capabilityPatchYaml(proposal.proposalId, name, entry))
        if (champion.capabilityEntry == null) return { files, champion: 'missing', championSource: 'missing' }
        // The registry-form entry stays as the candidate-vs-champion comparison
        // anchor and the runtime-override payload; the rollback anchor is the
        // config.yml row's verbatim source text when the row exists there
        // (W19, guide §4.2 #18), else the capability is a code default and the
        // rollback removes the applied row.
        await write('champion/capability-table.entry.yml', championEntryYaml(name, champion.capabilityEntry))
        const source = await this.capabilityRowSource(name)
        if (source === null) return { files, champion: 'captured', championSource: 'code-default' }
        await write('champion/capability-table.source.txt', `${source}\n`)
        return { files, champion: 'captured', championSource: 'config-text' }
      }
      case 'task_definition': {
        await write('task-definition.json', `${JSON.stringify((mutation as unknown as TaskDefinitionMutation).definition, null, 2)}\n`)
        if (champion.taskDefinition == null) return { files, champion: 'missing' }
        await write('champion/task-definition.json', `${JSON.stringify(champion.taskDefinition, null, 2)}\n`)
        return { files, champion: 'captured' }
      }
      default:
        throw new Error(`evolution: targetType "${proposal.targetType}" has no mechanical materialization`)
    }
  }

  /**
   * Fold records into proposals, enforcing the state machine on every step:
   * proposed starts a new id; each later kind must be exactly an allowed next
   * state, and payload-bearing kinds re-run the write path's payload
   * validation (candidate versionSet/mutation, gate answers, the
   * prepared/replayed/applied/rolledback shapes), so a hand-forged line fails
   * load exactly as it would fail append. The same rules guard replay and live
   * appends, so an illegal migration is rejected identically in both paths.
   */
  private fold(records: readonly EvolutionRecord[]): Map<string, EvolutionProposal> {
    const proposals = new Map<string, EvolutionProposal>()
    for (const record of records) {
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
          current.prepared = {
            sandbox: record.sandbox,
            mechanical: record.mechanical,
            champion: record.champion,
            ...(record.championSource === undefined ? {} : { championSource: record.championSource }),
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
    this.fold(this.records)
  }

  /** Validate the staged fold first; memory commits only after the line is on disk. */
  private async append(record: EvolutionRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      this.fold([...this.records, record])
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
}

export default EvolutionService

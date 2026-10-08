/**
 * The seams one evaluation runs on: the draft ledger, the frozen environment,
 * the task store and the runtime's replay entry. Every one of them is an
 * interface here, so the pipeline is exercised in a spec without a live runtime
 * and the deployment wires its own implementation once.
 */

import type { ReviewTokenUsage, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig, EnvironmentRevisionManifest, McpServerTemplate, ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { MethodLedger } from '../draft/draft.ts'
import type { RevisionView } from '../types.ts'

/** One side of one sample as the runtime's own pre-check reports it. */
export interface PrecheckSkillVerdict {
  readonly valid: boolean
  readonly name: string
  readonly role?: string
  readonly contractDigest?: string | null
  readonly contentDigest?: string
  readonly defects?: readonly { readonly code: string; readonly detail: string }[]
}

/** The runtime's provider pre-check answer, as a freeze reads it. */
export interface ProviderPrecheckView {
  readonly capabilities: readonly {
    readonly capability: string
    readonly skills: readonly PrecheckSkillVerdict[]
    readonly refusals?: readonly { readonly code: string; readonly detail: string }[]
  }[]
  readonly revision: string
}

/** The registered judge vocabulary, or `undefined` when the deployment cannot list one. */
export interface VerifierVocabulary {
  readonly ids: readonly string[]
  readonly versions: Readonly<Record<string, string>>
}

/** Every provider one pre-check refused, as a refusal line names it — the one rendering a freeze and an admission record share. */
export function refusedProviderLines(precheck: ProviderPrecheckView): string[] {
  return precheck.capabilities.flatMap(row => [
    ...(row.refusals ?? []).map(item => `${row.capability}: ${item.code}: ${item.detail}`),
    ...row.skills
      .filter(skill => !skill.valid)
      .map(
        skill =>
          `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map(defect => `${defect.code}: ${defect.detail}`).join('; ')})`,
      ),
  ])
}

/** The environment and replay surface one evaluation reads. */
export interface EvaluationRuntime {
  /** The graph's root task store, derived from the caller's own graph. */
  storeOfSession(sessionId: string): Promise<string>
  /** The active revision of the caller's library. */
  activeRevision(sessionId: string): Promise<RevisionView>
  /** One frozen revision by id, refusing an id the library does not hold. */
  revision(sessionId: string, revisionId: string): Promise<RevisionView>
  /** The capability rows in force for one caller (the active revision's rows). */
  capabilitiesForSession(sessionId: string): Promise<Readonly<Record<string, CapabilityConfig>>>
  /** The runtime's own pre-check over the rows in force for one caller. */
  capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheckView>
  /** The runtime's own pre-check over a table the caller names — the candidate revision's own table. */
  precheckCapabilityTable(request: {
    readonly capabilities: readonly string[]
    readonly table: Readonly<Record<string, CapabilityConfig>>
    readonly extraRoots: readonly string[]
    readonly mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
  }): Promise<ProviderPrecheckView>
  /** Every MCP template the deployment defines. */
  mcpServers(): Readonly<Record<string, McpServerTemplate>>
  maxActiveWorkers(): number
  /** One replay of one sample's side, under the configuration the caller names. */
  replayTask(storeId: string, sampleTaskId: string, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>
}

/** Where the frozen manifest of a revision is read from, when a caller has one. */
export type RevisionManifestOf = (revisionId: string) => EnvironmentRevisionManifest | undefined

/** Everything one evaluation reads and writes. */
export interface EvaluationSources {
  readonly ledger: MethodLedger
  readonly runtime: EvaluationRuntime
  readonly tasks: {
    openStore(storeId: string): Promise<TaskSnapshot>
    /** The runtime-sealed receipt of one run, or `undefined` when it holds none. */
    receiptFor(storeId: string, runId: string): Promise<import('@dangosys/dsh-singularity-task').ExecutionReceipt | undefined>
    /** Seal one settled run's receipt; absent when the deployment seals through its own settlement only. */
    sealReceipt?(storeId: string, taskId: string, runId: string): Promise<unknown>
  }
  /** The registered judge vocabulary at freeze time; `undefined` is a deployment that cannot list one. */
  verifierVocabulary(): Promise<VerifierVocabulary | undefined>
  /** The directory reports, workspaces and judge evidence live under. */
  readonly root: string
  /** The library this plane serves. */
  readonly libraryId: string
  /** The caller every replay and read runs as. */
  readonly caller: string
}

/** The token total of one reading, or `undefined` when the reading is not whole. */
export function tokenTotalOf(tokens: ReviewTokenUsage | undefined): number | undefined {
  if (tokens === undefined) return undefined
  const values = [tokens.uncachedInputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens]
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
  return values.reduce((sum, value) => sum + value, 0)
}

/**
 * The deployment's own wiring of the evaluation seams: the graph's library, the
 * runtime's replay and receipt entries, the task store and the judge vocabulary.
 * Everything the pipeline needs that only a live deployment can answer is bound
 * here, once.
 */

import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig, EnvironmentRevision, EnvironmentRevisionManifest, McpServerTemplate, ProviderPrecheck } from '@dangosys/dsh-singularity-task-runtime'
import {
  libraryRoots,
  optionalService,
  precheckProviders,
  readPointer,
  readRevision,
  registeredVerifierIds,
  registeredVerifierVocabulary,
  revisionCapabilityRows,
} from '@dangosys/dsh-singularity-task-runtime'
import type { TaskRuntime } from '@dangosys/dsh-singularity-task-runtime'
import type { MethodLedger } from '../draft/draft.ts'
import type { EvaluationRuntime, EvaluationSources, ProviderPrecheckView, VerifierVocabulary } from '../pipeline/sources.ts'
import type { RevisionRef, RevisionView } from '../types.ts'

/** The deployments whose libraries this plane serves; one per graph. */
interface GraphRegistry {
  graphForSession(session: SessionId): Promise<{ rootSessionId: SessionId }>
}

interface TaskStoreSource {
  openStore(storeId: string): Promise<import('@dangosys/dsh-singularity-task').TaskSnapshot>
}

/** Where one graph's library lives; the runtime's own default when the deployment names none. */
export function environmentHomeOf(runtime: TaskRuntime): string {
  const configured = (runtime.config as { environmentRevisionRoot?: string }).environmentRevisionRoot
  if (configured !== undefined) return configured
  const bindings = (runtime.config as { runBindingRoot?: string }).runBindingRoot
  if (bindings !== undefined && basename(dirname(resolve(bindings))) === 'singularity') return dirname(dirname(resolve(bindings)))
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** One frozen revision as this plane reads it. */
export function revisionViewOf(revision: EnvironmentRevision): RevisionView {
  const manifest: EnvironmentRevisionManifest = revision.manifest
  const ref: RevisionRef = { revisionId: manifest.revisionId, digest: manifest.contentDigest, libraryId: manifest.libraryId }
  return {
    ref,
    root: revision.root,
    skillRoot: revision.skillRoot,
    taskTemplatesRoot: revision.taskTemplatesRoot,
    skills: manifest.skills.map(skill => ({
      name: skill.name,
      version: skill.version,
      contentDigest: skill.contentDigest,
      contractDigest: skill.contractDigest,
      status: skill.status,
    })),
    templates: manifest.taskTemplates.map(entry => ({
      id: entry.templateRef.id,
      version: entry.templateRef.version,
      digest: entry.templateRef.digest,
      status: entry.status,
      skills: [...entry.skills],
    })),
    capabilityRows: revisionCapabilityRows(manifest),
    mcpServers: manifest.capabilities.mcpServers,
  }
}

/** The open-commit view the runtime's provider pre-check asks for; the pointer transaction is the exclusion point now. */
const NO_OPEN_COMMITS = {
  openIntentTargets: async (): Promise<readonly string[]> => [],
  openIntentCapabilities: async (): Promise<readonly string[]> => [],
}

/** Build the seams one evaluation runs on, from the deployment's own services. */
export function evaluationSourcesOf(input: {
  ctx: Context
  caller: string
  root: string
  libraryId: string
  ledger: MethodLedger
}): EvaluationSources {
  const runtime = optionalService<TaskRuntime>(input.ctx, 'taskRuntime')
  if (runtime === undefined) {
    throw new Error('evolution: this deployment offers no task runtime, so no revision, replay or receipt can be read; nothing was evaluated')
  }
  const graphs = optionalService<GraphRegistry>(input.ctx, 'graphs')
  const task = optionalService<TaskStoreSource>(input.ctx, 'task')
  if (task === undefined) {
    throw new Error('evolution: this deployment offers no task service, so the store an evaluation reads cannot be opened')
  }
  const home = environmentHomeOf(runtime)

  const rootsFor = async (sessionId: string) => {
    if (graphs === undefined) {
      throw new Error(`evolution: this deployment offers no graph registry, so the library of session "${sessionId}" cannot be resolved`)
    }
    const graph = await graphs.graphForSession(SessionId(sessionId))
    return libraryRoots(String(graph.rootSessionId), home)
  }
  const readFrozen = async (sessionId: string, revisionId: string): Promise<RevisionView> => {
    const roots = await rootsFor(sessionId)
    const revision = await readRevision(roots, revisionId)
    if (revision === undefined) {
      throw new Error(`evolution: library "${roots.id}" holds no revision "${revisionId}"; a bound revision is a frozen directory`)
    }
    return revisionViewOf(revision)
  }

  const environment: EvaluationRuntime = {
    async storeOfSession(sessionId: string): Promise<string> {
      if (graphs === undefined) throw new Error(`evolution: session "${sessionId}" has no graph in this deployment`)
      const graph = await graphs.graphForSession(SessionId(sessionId))
      return rootTaskStoreId(String(graph.rootSessionId))
    },
    async activeRevision(sessionId: string): Promise<RevisionView> {
      const roots = await rootsFor(sessionId)
      const pointer = await readPointer(roots)
      if (pointer === null) {
        throw new Error(
          `evolution: library "${roots.id}" holds no active revision; a candidate is evaluated against the revision it was written against, ` +
            'so a library without one has nothing to compare',
        )
      }
      return await readFrozen(sessionId, pointer.revisionId)
    },
    revision: readFrozen,
    capabilitiesForSession: (sessionId: string) => runtime.capabilitiesForSession(sessionId),
    capabilityProviderReport: async (sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheckView> =>
      (await runtime.capabilityProviderReport(sessionId, capabilities)) as ProviderPrecheckView,
    async precheckCapabilityTable(request: {
      capabilities: readonly string[]
      table: Readonly<Record<string, CapabilityConfig>>
      extraRoots: readonly string[]
      mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
    }): Promise<ProviderPrecheckView> {
      const verifierRefs = await registeredVerifierIds(input.ctx)
      return (await precheckProviders({
        capabilities: request.capabilities,
        table: request.table,
        mcpRegistry: request.mcpRegistry ?? {},
        view: { extraRoots: [...request.extraRoots] },
        ...(verifierRefs === undefined ? {} : { verifierRefs }),
        commitLedger: NO_OPEN_COMMITS,
      })) as ProviderPrecheck
    },
    mcpServers: () => (runtime.config.mcpServers ?? {}) as Readonly<Record<string, McpServerTemplate>>,
    maxActiveWorkers: () => runtime.config.maxActiveWorkers ?? 2,
    replayTask: (storeId, sampleTaskId, options, callerSessionId) =>
      runtime.replayTask(storeId, sampleTaskId, options, callerSessionId),
  }

  return {
    ledger: input.ledger,
    runtime: environment,
    tasks: {
      openStore: (storeId: string) => task.openStore(storeId),
      receiptFor: (storeId: string, runId: string) => runtime.receiptFor(storeId, runId),
      sealReceipt: (storeId: string, taskId: string, runId: string) => runtime.sealRunReceipt(storeId, taskId, runId),
    },
    async verifierVocabulary(): Promise<VerifierVocabulary | undefined> {
      const vocabulary = await registeredVerifierVocabulary(input.ctx)
      return vocabulary === undefined ? undefined : { ids: vocabulary.ids, versions: vocabulary.versions }
    },
    root: input.root,
    libraryId: input.libraryId,
    caller: input.caller,
  }
}

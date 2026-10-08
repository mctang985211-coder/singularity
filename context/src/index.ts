/** Singularity's domain read core (A2+A1): what a live session may read, and what it says. @module dsh-singularity/context */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import { assembleSingularityContext } from './assembly.ts'
import { loadCaller } from './bindings/resolve.ts'
import type { CoordinationBindingSource } from './bindings/coordination.ts'
import type { BindingDeps, LoadedCaller } from './bindings/types.ts'
import { contractProjection } from './reads/contract.ts'
import { dynamicProjection } from './reads/dynamic.ts'
import { questionProjection } from './reads/questions.ts'
import { contextRead } from './reads/reference-read.ts'
import { taskRead } from './reads/task-read.ts'
import { taskStatus } from './reads/task-status.ts'
import type { ProjectedRead } from './refusals.ts'
import type { ContextReadQuery, EnvPathSource, ReadDeps, StatusQuery } from './types.ts'
import { GraphViewService } from './view/service.ts'

export {
  assembleSingularityContext,
  AssemblyRefusalError,
  QUESTIONS_CONTEXT_NAME,
  QUESTIONS_CONTEXT_ORDER,
  STATE_CONTEXT_NAME,
  STATE_CONTEXT_ORDER,
  WORKER_CONTRACT_ORDER,
  WORKER_CONTRACT_SECTION,
} from './assembly.ts'
export { loadCaller } from './bindings/resolve.ts'
export { CoordinationBindingError, readCoordination, delegatorStanding } from './bindings/coordination.ts'
export type {
  CoordinationBinding,
  CoordinationBindingSource,
  CoordinationRead,
  CoordinationRole,
  DelegatorStanding,
} from './bindings/coordination.ts'
export { isGraphMember } from './bindings/types.ts'
export type {
  BindingDeps,
  CallerBase,
  CallerGraph,
  CallerResolution,
  CallerUnbound,
  GraphRecordFacts,
  LoadedCaller,
  MembershipEdge,
  MembershipNode,
  ReadOnlyGraphs,
  ReadOnlyTaskRuntime,
  ReadOnlyTaskStore,
} from './bindings/types.ts'
export { budgetList, CONTEXT_OUTPUT_LIMIT_BYTES, omissionLine, OutputBudget, sliceUtf8, utf8Bytes } from './limits.ts'
export type { OmissionReport, Utf8Slice } from './limits.ts'
export { contractProjection } from './reads/contract.ts'
export { dynamicProjection, relatedEntries } from './reads/dynamic.ts'
export type { RelatedEntry } from './reads/dynamic.ts'
export { notActivatedLines } from './reads/guards.ts'
export { questionProjection } from './reads/questions.ts'
export { contextRead } from './reads/reference-read.ts'
export { taskRead } from './reads/task-read.ts'
export { taskStatus } from './reads/task-status.ts'
export { NAMED_REFUSALS, read, refused } from './refusals.ts'
export type {
  NamedRefusal,
  ProjectedRead,
  ProjectedReadOk,
  ProjectedReadRefused,
  ReadContinuation,
} from './refusals.ts'
export {
  constraintItems,
  contractLines,
  criteriaLines,
  handoffFor,
  handoffLines,
  handoffReferences,
  latestRun,
  rootAncestor,
  runPhaseCell,
  runPhaseSuffix,
  taskSummaryLine,
} from './render/fields.ts'
export {
  bindingLines,
  diagnosisRecordText,
  evidenceRecordText,
  renderRunBinding,
  reviewRecordText,
  runRecordText,
  taskRecordText,
} from './render/records.ts'
export type {
  ContextReadQuery,
  EnvPathSource,
  ReadDeps,
  ReviewReference,
  SessionEventReference,
  SessionQueryReads,
  StatusQuery,
  StatusScope,
} from './types.ts'
export { GraphViewService, ReadSourceUnavailableError } from './view/service.ts'
export type { ViewFactSource } from './view/service.ts'
export { LegacyCompletionError, PROGRESS_NOTE_LIMIT, deriveProgress, readCompletion } from './view/facts.ts'
export type {
  CoordinationAssignmentFacts,
  CoordinationCompletionFacts,
  CoordinationFactsReader,
  GraphKey,
  MethodFactsReader,
  ViewFactSources,
} from './view/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityContext: SingularityContextService
  }
}

export class SingularityContextService extends Service {
  static inject = ['task', 'graphs', 'taskRuntime', 'sessionQuery']

  /** The one registered coordination binding source, when this deployment has one. */
  private coordinationSource: CoordinationBindingSource | undefined

  constructor(ctx: Context) {
    super(ctx, 'singularityContext')
    new GraphViewService(ctx)
  }

  /** Mount the one `system-prompt/assemble` waterfall listener this service owns. */
  [Service.init](): void {
    this.ctx.effect(
      () =>
        this.ctx.on('system-prompt/assemble', (assembly, context, next) =>
          assembleSingularityContext(this, assembly, context, next),
        ),
      'singularityContext: system-prompt assembly',
    )
  }

  /** Register the one coordination binding source; the returned disposer removes it again. */
  registerCoordinationBindingSource(source: CoordinationBindingSource): () => void {
    const previous = this.coordinationSource
    this.coordinationSource = source
    return () => {
      if (this.coordinationSource === source) this.coordinationSource = previous
    }
  }

  /** The domain a live session may read, from durable facts. */
  async resolveCaller(sessionId: string, signal?: AbortSignal): Promise<LoadedCaller['resolution']> {
    return (await this.load(sessionId, signal)).resolution
  }

  /** The caller's own complete contract and run (A2 §D `task_read`). */
  async taskRead(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead> {
    return await taskRead(this.readDeps(), await this.load(sessionId, signal))
  }

  /** The project status view: the caller's relations, or the whole domain (A2 §D `task_status`). */
  async taskStatus(sessionId: string, query: StatusQuery = {}, signal?: AbortSignal): Promise<ProjectedRead> {
    return await taskStatus(this.readDeps(), await this.load(sessionId, signal), query)
  }

  /** One record of the caller's own domain, by reference (A2 §D `context_read`). */
  async contextRead(sessionId: string, query: ContextReadQuery, signal?: AbortSignal): Promise<ProjectedRead> {
    return await contextRead(this.readDeps(), await this.load(sessionId, signal), query, signal)
  }

  /** The immutable half of the caller's context: contract, root briefing, handoff (A2 §D/§9). */
  async contractProjection(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead> {
    return await contractProjection(this.readDeps(), await this.load(sessionId, signal))
  }

  /** The dynamic half: run state, gate phase, recovery marker, related tasks (A2 §D/§9). */
  async dynamicProjection(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead> {
    return await dynamicProjection(this.readDeps(), await this.load(sessionId, signal))
  }

  /** The question plane (A4 §F.1/§7.3): open questions, and answers no read has been shown. */
  async questionProjection(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead> {
    return await questionProjection(this.readDeps(), await this.load(sessionId, signal))
  }

  /** The caller's own loaded domain, resolved once for every plane of one model request. */
  async load(sessionId: string, signal?: AbortSignal): Promise<LoadedCaller> {
    signal?.throwIfAborted()
    return await loadCaller(this.bindingDeps(), sessionId, signal)
  }

  /** One plane of a caller already loaded — the assembly's own doors. */
  async contractFor(caller: LoadedCaller): Promise<ProjectedRead> {
    return await contractProjection(this.readDeps(), caller)
  }

  async dynamicFor(caller: LoadedCaller): Promise<ProjectedRead> {
    return await dynamicProjection(this.readDeps(), caller)
  }

  async questionsFor(caller: LoadedCaller): Promise<ProjectedRead> {
    return await questionProjection(this.readDeps(), caller)
  }

  /** Retrieve the current visible catalog before the model decides its next children. */
  async templatesFor(caller: LoadedCaller): Promise<string> {
    if (caller.resolution.kind === 'worker' && !this.ctx.taskRuntime.allowsRuntimeDecomposition()) return ''
    const page = await this.ctx.taskRuntime.listTaskTemplates({ limit: 10 }, caller.resolution.sessionId)
    return '# Visible Task templates\n' + JSON.stringify(page) +
      '\nUse task_template_list for another page, a narrower catalogPath, or the full exact templateRef. ' +
      'Choose an applicable template and parameters, or a complete standard contract when none applies. Instance history is recorded automatically; reusable templates are published selectively through Evolution.'
  }

  private bindingDeps(): BindingDeps {
    return {
      task: this.ctx.task,
      graphs: this.ctx.graphs,
      taskRuntime: this.ctx.taskRuntime,
      ...(this.coordinationSource === undefined ? {} : { coordinationSource: this.coordinationSource }),
    }
  }

  private readDeps(): ReadDeps {
    const envBuilder = this.envBuilder()
    return {
      ...this.bindingDeps(),
      sessionQuery: this.ctx.sessionQuery,
      ...(envBuilder === undefined ? {} : { envBuilder }),
    }
  }

  /** The env builder this deployment mounts, when it mounts one. */
  private envBuilder(): EnvPathSource | undefined {
    return this.ctx.get('envBuilder') as EnvPathSource | undefined
  }
}

export default SingularityContextService

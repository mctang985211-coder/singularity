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
import type { BindingDeps, LoadedCaller, ReviewerBindingSource } from './bindings/types.ts'
import { contractProjection } from './reads/contract.ts'
import { dynamicProjection } from './reads/dynamic.ts'
import { questionProjection } from './reads/questions.ts'
import { contextRead } from './reads/reference-read.ts'
import { taskRead } from './reads/task-read.ts'
import { taskStatus } from './reads/task-status.ts'
import type { ProjectedRead } from './refusals.ts'
import type { ContextReadQuery, EnvPathSource, ReadDeps, StatusQuery } from './types.ts'

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
export { ReviewerBindingError, isGraphMember } from './bindings/types.ts'
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
  ReviewerBindingRecord,
  ReviewerBindingSource,
} from './bindings/types.ts'
export { CONTEXT_OUTPUT_LIMIT_BYTES, omissionLine, OutputBudget, sliceUtf8, utf8Bytes } from './limits.ts'
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityContext: SingularityContextService
  }
}

export class SingularityContextService extends Service {
  static inject = ['task', 'graphs', 'taskRuntime', 'sessionQuery']

  /** The one registered delegation source, when this deployment has one. */
  private reviewerSource: ReviewerBindingSource | undefined

  constructor(ctx: Context) {
    super(ctx, 'singularityContext')
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

  /** Register the one reviewer-delegation source; the returned disposer removes it again. */
  registerReviewerBindingSource(source: ReviewerBindingSource): () => void {
    const previous = this.reviewerSource
    this.reviewerSource = source
    return () => {
      if (this.reviewerSource === source) this.reviewerSource = previous
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

  private bindingDeps(): BindingDeps {
    return {
      task: this.ctx.task,
      graphs: this.ctx.graphs,
      taskRuntime: this.ctx.taskRuntime,
      ...(this.reviewerSource === undefined ? {} : { reviewerSource: this.reviewerSource }),
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

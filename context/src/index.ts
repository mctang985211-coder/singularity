/**
 * Singularity's domain read core (A2+A1, dispatch subgoal 2): one place that
 * answers "what may this session read, and what does it say".
 *
 * The service resolves a **live caller** to a read domain from durable facts —
 * published graph membership and the persistent `TaskStarted` record, plus the
 * reviewer ledger for a delegation that has no business run — and then reads
 * records of that domain only. It never recovers, never adopts, never reconciles
 * and never waits: a store that is still recovering answers with its facts and a
 * `recovery` marker, and every outcome is one of the named results in
 * {@link NamedRefusal}.
 *
 * Consumers: the tool adapters (`task_read`, `task_status`, `context_read`) and
 * the prompt assembly consume these methods directly; both read the same service,
 * so the two views cannot describe different stores.
 * @module dsh-singularity-context
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@deepseek-ai/dsh-session-query'
import {
  loadCaller,
  type BindingDeps,
  type CallerResolution,
  type LoadedCaller,
  type ReviewerBindingSource,
} from './bindings.ts'
import {
  contextRead,
  contractProjection,
  dynamicProjection,
  taskRead,
  taskStatus,
  type ContextReadQuery,
  type EnvPathSource,
  type ReadDeps,
  type StatusQuery,
} from './projections.ts'
import type { ProjectedRead } from './refusals.ts'

export * from './bindings.ts'
export * from './limits.ts'
export * from './not-activated.ts'
export * from './projections.ts'
export * from './refusals.ts'
export * from './render.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityContext: SingularityContextService
  }
}

export class SingularityContextService extends Service {
  static inject = ['task', 'graphs', 'taskRuntime', 'sessionQuery']

  /** The registered delegation sources, in registration order; a later registration answers after an earlier one. */
  private readonly reviewerSources: ReviewerBindingSource[] = []

  constructor(ctx: Context) {
    super(ctx, 'singularityContext')
  }

  /**
   * Register the narrow source this deployment reads reviewer delegations from
   * (the reviewer ledger). Returns the disposer that removes it again, so a
   * plugin that unloads takes its binding source with it.
   */
  registerReviewerBindingSource(source: ReviewerBindingSource): () => void {
    this.reviewerSources.push(source)
    return () => {
      const index = this.reviewerSources.indexOf(source)
      if (index >= 0) this.reviewerSources.splice(index, 1)
    }
  }

  /**
   * The domain a live session may read, from durable facts. Tools and assembly
   * call this directly when they need the role (or the store) rather than a
   * rendered read.
   */
  async resolveCaller(sessionId: string, signal?: AbortSignal): Promise<CallerResolution> {
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

  private async load(sessionId: string, signal?: AbortSignal): Promise<LoadedCaller> {
    signal?.throwIfAborted()
    return await loadCaller(this.bindingDeps(), sessionId, signal)
  }

  private bindingDeps(): BindingDeps {
    return {
      task: this.ctx.task,
      graphs: this.ctx.graphs,
      taskRuntime: this.ctx.taskRuntime,
      reviewerSources: [...this.reviewerSources],
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

  /**
   * The env builder, when this deployment mounts one: the optional source the
   * obligation-coverage line walks up from. Read through `ctx.get`, because a
   * deployment without it must still answer every other read.
   */
  private envBuilder(): EnvPathSource | undefined {
    const ctx = this.ctx as unknown as {
      get?: (name: string) => unknown
      envBuilder?: EnvPathSource
    }
    return (ctx.get?.('envBuilder') ?? ctx.envBuilder) as EnvPathSource | undefined
  }
}

export default SingularityContextService

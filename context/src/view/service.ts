/**
 * The one projection of a graph's read state: its access mode, its active
 * revision, its latest evaluation and its derived progress — one cache, one
 * fact fingerprint, and no fallback when a fact producer is missing.
 * @module @dangosys/dsh-singularity-context/view-service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { GraphProtocol } from '@dangosys/dsh-singularity-graphs'
import { graphAccessWire } from '@dangosys/dsh-singularity-graphs/wire'
import type {
  GraphEvaluationWire,
  GraphRevisionWire,
  GraphViewWire,
} from '@dangosys/dsh-singularity-graphs/wire'
import { rootTaskStoreId, sha256Hex } from '@dangosys/dsh-singularity-task'
import { deriveProgress } from './facts.ts'
import type { CoordinationAssignmentFacts, CoordinationFactsReader, MethodFactsReader } from './types.ts'

/** Which producer a read needed and did not have; the route maps this to a named refusal. */
export type ViewFactSource = 'coordination' | 'method'

/** A read that cannot answer because this deployment registers no such fact producer. */
export class ReadSourceUnavailableError extends Error {
  readonly code = 'read-source-unavailable'
  readonly source: ViewFactSource

  constructor(source: ViewFactSource, detail: string) {
    super(detail)
    this.name = 'ReadSourceUnavailableError'
    this.source = source
  }
}

/** The graph fields a view reads off the registry record. */
interface ViewGraph {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly rootSessionId: string
  readonly protocol?: GraphProtocol
  readonly rsi?: { readonly iterationRounds: number }
}

/** The facts one fingerprint covers: the registry record and the three method/coordination answers. */
interface ViewFacts {
  readonly graph: ViewGraph
  readonly key: string
  readonly revision: GraphRevisionWire | null
  readonly evaluation: GraphEvaluationWire | null
  readonly assignments: readonly CoordinationAssignmentFacts[]
}

/**
 * The fingerprint of one graph's read facts: the registry record, the revision,
 * the evaluation and the assignment states. Two reads of the same facts carry
 * the same generation, so a cached projection can never be handed out for a
 * different state.
 */
function generationOf(facts: ViewFacts): number {
  const digest = sha256Hex(JSON.stringify([
    [
      facts.graph.id,
      facts.graph.name,
      facts.graph.createdAt,
      facts.graph.protocol?.id ?? null,
      facts.graph.rsi?.iterationRounds ?? null,
    ],
    facts.key,
    facts.revision === null ? null : [facts.revision.revisionId, facts.revision.manifestDigest, facts.revision.origin, facts.revision.publishedAt],
    facts.evaluation === null
      ? null
      : [
          facts.evaluation.state,
          facts.evaluation.reportRef,
          facts.evaluation.candidateRef,
          facts.evaluation.decidedAt,
          facts.evaluation.decision ?? null,
        ],
    facts.assignments
      .map(assignment => `${assignment.assignmentId}@${assignment.state}@${assignment.completion?.at ?? ''}`)
      .sort(),
  ]))
  return Number.parseInt(digest.slice(0, 13), 16)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityGraphView: GraphViewService
  }
}

/**
 * A graph's version, evaluation, access mode and derived progress, from the one
 * registered fact source per plane. Web and tools read exactly this projection;
 * a missing producer is refused by name rather than answered with a default.
 */
export class GraphViewService extends Service {
  static inject = ['graphs', 'task', 'taskRuntime']

  private coordination: CoordinationFactsReader | undefined
  private method: MethodFactsReader | undefined
  private readonly cached = new Map<string, { readonly epoch: number; readonly view: GraphViewWire }>()
  /** Bumped by every change the stores publish; a projection made under an older epoch is stale. */
  private epoch = 0

  constructor(ctx: Context) {
    super(ctx, 'singularityGraphView')
    this.watchEvents()
  }

  /** Every store change a projection reads is a reason to reduce it again. */
  private watchEvents(): void {
    // `graph/change` is the graph store's own event; this package reads graphs
    // through the registry and does not depend on the graph package's types.
    const on = this.ctx.on.bind(this.ctx) as unknown as (name: string, listener: () => void) => () => void
    on('graphs/change', () => this.invalidate())
    on('task/change', () => this.invalidate())
    on('graph/change', () => this.invalidate())
  }

  /** Register the one coordination fact source; the returned disposer removes it again. */
  registerCoordinationFacts(reader: CoordinationFactsReader): () => void {
    const previous = this.coordination
    this.coordination = reader
    this.invalidate()
    return () => {
      if (this.coordination !== reader) return
      this.coordination = previous
      this.invalidate()
    }
  }

  /** Register the one method fact source; the returned disposer removes it again. */
  registerMethodFacts(reader: MethodFactsReader): () => void {
    const previous = this.method
    this.method = reader
    this.invalidate()
    return () => {
      if (this.method !== reader) return
      this.method = previous
      this.invalidate()
    }
  }

  /** One graph's complete read state, from the facts the current epoch covers. */
  async view(graphId: string): Promise<GraphViewWire> {
    const cached = this.cached.get(graphId)
    if (cached !== undefined && cached.epoch === this.epoch) return cached.view
    const facts = await this.facts(graphId)
    const view: GraphViewWire = {
      formatVersion: 2,
      graph: { id: facts.graph.id, name: facts.graph.name, createdAt: facts.graph.createdAt },
      access: graphAccessWire(facts.graph),
      revision: facts.revision,
      evaluation: facts.evaluation,
      progress: deriveProgress(facts.graph.rsi?.iterationRounds, facts.assignments),
      generation: generationOf(facts),
    }
    this.cached.set(graphId, { epoch: this.epoch, view })
    return view
  }

  /** Every registered graph's view, in the registry's own order, from the same cache. */
  async summaries(): Promise<readonly GraphViewWire[]> {
    const graphs = await this.ctx.graphs.list()
    return await Promise.all(graphs.map(graph => this.view(graph.id)))
  }

  /** The facts the projection is made of; a producer this deployment lacks refuses the read by name. */
  private async facts(graphId: string): Promise<ViewFacts> {
    const coordination = this.requireCoordination()
    const method = this.requireMethod()
    const graph = await this.ctx.graphs.get(graphId)
    const key = rootTaskStoreId(graph.rootSessionId)
    const [revision, evaluation, assignments] = await Promise.all([
      method.activeRevision(key),
      method.latestEvaluation(key),
      coordination.assignments(key),
    ])
    return { graph, key, revision, evaluation, assignments }
  }

  private requireCoordination(): CoordinationFactsReader {
    if (this.coordination === undefined) {
      throw new ReadSourceUnavailableError(
        'coordination',
        'no coordination fact source is registered in this deployment, so a graph\'s progress cannot be reduced from its assignments',
      )
    }
    return this.coordination
  }

  private requireMethod(): MethodFactsReader {
    if (this.method === undefined) {
      throw new ReadSourceUnavailableError(
        'method',
        'no method fact source is registered in this deployment, so a graph\'s active revision and latest evaluation cannot be read',
      )
    }
    return this.method
  }

  private invalidate(): void {
    this.epoch += 1
    this.cached.clear()
  }
}

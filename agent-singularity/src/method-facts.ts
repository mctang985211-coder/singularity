/**
 * The method plane's facts, handed to the one read model that owns a graph's
 * projection: the effective revision the environment pointer holds, and the
 * latest draft's evaluation as the v5 ledger folds it. Both are read from the
 * same stores the `method_*` tools read, so what the console shows and what a
 * model is told cannot drift apart. This module derives no projection of its
 * own — `GraphViewService` is the only place one exists, and a store key this
 * plane cannot resolve answers `null` rather than a default that looks like a
 * fact.
 *
 * @module @dangosys/dsh-singularity-agent/method-facts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MethodFactsReader } from '@dangosys/dsh-singularity-context'
import type { GraphEvaluationWire, GraphRevisionWire } from '@dangosys/dsh-singularity-graphs'
import { evaluationSourcesOf, methodList, openMethodLedger } from '@dangosys/dsh-singularity-evolution'
import type { DraftView } from '@dangosys/dsh-singularity-evolution'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { hasLegacyLayout, listPointerCompletions, optionalService, readPointer } from '@dangosys/dsh-singularity-task-runtime'
import type { EnvironmentPointerCompletion, LibraryRoots } from '@dangosys/dsh-singularity-task-runtime'

/** The graph registry this reader resolves a store key back to its root session through. */
interface GraphRegistry {
  list(): Promise<readonly GraphRecordLike[]>
}

/** One registry record, as this reader reads it: the root session the key derives from, and the mode. */
interface GraphRecordLike {
  readonly rootSessionId: string
  readonly rsi?: { readonly humanReview: boolean } | null
}

/** The environment plane entry this reader resolves a caller's library through. */
interface MethodEnvironment {
  libraryRootsForSession(sessionId: string): Promise<LibraryRoots>
}

/** One library the reader resolved, with the graph's own decision mode and protocol. */
interface Resolved {
  readonly caller: string
  readonly library: LibraryRoots
  readonly protocol: 'environment-revision' | 'legacy' | 'uninitialized'
  readonly humanReview: boolean
}

/**
 * The graph a store key names: the one registry record whose root store is this
 * key. The projection's own key is `rootTaskStoreId(rootSessionId)`, so the
 * reader resolves it back through the registry rather than parsing the id's
 * shape — a key no graph publishes resolves to nothing.
 */
async function resolve(ctx: Context, graphKey: string): Promise<Resolved | undefined> {
  const graphs = optionalService<GraphRegistry>(ctx, 'graphs')
  const runtime = optionalService<MethodEnvironment>(ctx, 'taskRuntime')
  if (graphs === undefined || runtime === undefined) return undefined
  const graph = (await graphs.list()).find(entry => rootTaskStoreId(String(entry.rootSessionId)) === graphKey)
  if (graph === undefined) return undefined
  const caller = String(graph.rootSessionId)
  const library = await runtime.libraryRootsForSession(caller)
  return {
    caller,
    library,
    protocol: (await hasLegacyLayout(library)) ? 'legacy' : 'environment-revision',
    // An unmanned graph resolves its own approvals as the platform policy's; the
    // console shows that source rather than attributing it to a person.
    humanReview: graph.rsi?.humanReview !== false,
  }
}

/** A legacy library holds no v5 draft ledger and no pointer, so both method facts are absent rather than refused. */
function legacy(resolved: Resolved): boolean {
  return resolved.protocol === 'legacy'
}

/** The settled switch that installed one pointer's revision, or nothing for a library's first revision. */
function settledSwitch(completions: readonly EnvironmentPointerCompletion[], revisionId: string): EnvironmentPointerCompletion | undefined {
  for (let index = completions.length - 1; index >= 0; index -= 1) {
    const completion = completions[index]!
    if (completion.revisionId === revisionId) return completion
  }
  return undefined
}

/** The effective revision the library's pointer holds, or `null` for a root the v5 plane never wrote. */
async function activeRevisionOf(resolved: Resolved): Promise<GraphRevisionWire | null> {
  const pointer = await readPointer(resolved.library)
  if (pointer === null) return null
  const settled = settledSwitch(await listPointerCompletions(resolved.library), pointer.revisionId)
  const origin: GraphRevisionWire['origin'] =
    settled === undefined ? 'graph-initial' : settled.direction === 'rollback' ? 'rolled-back' : 'published'
  return {
    revisionId: pointer.revisionId,
    manifestDigest: pointer.manifestDigest,
    origin,
    publishedAt: pointer.publishedAt,
  }
}

/** The `at` of the last record that moved one draft, or `null` when the ledger holds none. */
function lastAtOf(view: DraftView): string | null {
  return view.history[view.history.length - 1]?.at ?? null
}

/** The `at` of one draft's evaluation record, from the trail the fold derived. */
function evaluationAtOf(view: DraftView): string | null {
  for (let index = view.history.length - 1; index >= 0; index -= 1) {
    const entry = view.history[index]!
    if (entry.kind === 'evaluation') return entry.at
  }
  return null
}

/**
 * One draft as the graph's latest evaluation: the state its own record puts it
 * in, the report it settled, and the decision that moved it. A draft merely
 * staged is `screening`; a frozen plan without a verdict is `evaluating`; a
 * settled verdict is `decided`, and a published or discarded draft carries the
 * decision its record recorded. Nothing here recomputes a verdict.
 */
function evaluationOf(view: DraftView, humanReview: boolean): GraphEvaluationWire {
  const candidateRef = view.draft.draftId
  const reportRef = view.evaluation?.reportPath ?? null
  const outcome = view.rolledback !== undefined ? 'rollback' : view.status === 'discarded' ? 'discard' : view.status === 'published' ? 'promote' : null
  if (outcome === null) {
    if (view.evaluation === undefined) {
      return { state: view.plan === undefined ? 'screening' : 'evaluating', reportRef, candidateRef, decidedAt: null }
    }
    return { state: 'decided', reportRef, candidateRef, decidedAt: evaluationAtOf(view) }
  }
  const at = view.rolledback?.at ?? view.published?.at ?? lastAtOf(view) ?? new Date().toISOString()
  return {
    state: view.status === 'discarded' ? 'rejected' : view.rolledback !== undefined ? 'decided' : 'published',
    reportRef,
    candidateRef,
    decidedAt: at,
    decision: { kind: outcome, source: { kind: humanReview ? 'human' : 'platform_policy' }, at },
  }
}

/**
 * The read model's one method fact producer: the environment pointer and the v5
 * ledger, resolved from the graph registry alone. A deployment without a
 * registry or a task runtime answers nothing, so the projection refuses by name
 * rather than reading a default.
 */
export function methodFactsReader(ctx: Context): MethodFactsReader {
  return {
    async activeRevision(graphKey: string): Promise<GraphRevisionWire | null> {
      const resolved = await resolve(ctx, graphKey)
      if (resolved === undefined || legacy(resolved)) return null
      return await activeRevisionOf(resolved)
    },
    async latestEvaluation(graphKey: string): Promise<GraphEvaluationWire | null> {
      const resolved = await resolve(ctx, graphKey)
      if (resolved === undefined || legacy(resolved)) return null
      const ledger = await openMethodLedger({ root: resolved.library.root, libraryId: resolved.library.id })
      const sources = evaluationSourcesOf({
        ctx,
        caller: resolved.caller,
        root: resolved.library.root,
        libraryId: resolved.library.id,
        ledger,
      })
      const drafts = methodList(sources, {})
      const latest = drafts[drafts.length - 1]
      if (latest === undefined) return null
      return evaluationOf(latest, resolved.humanReview)
    },
  }
}

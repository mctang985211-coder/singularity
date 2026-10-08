/**
 * What the platform knows about the method a graph is running: the active
 * revision, and the method records this round produced. Both are soft reads —
 * a deployment that has not mounted the environment plane answers `unknown`, and
 * an absent answer stays absent rather than becoming a fabricated one.
 *
 * The derived fields a supervisor completion carries (`methodDecision`,
 * `approval`) are computed here and nowhere else, from records the model cannot
 * write.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/method-read
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldMethods, openMethodLedger } from '@dangosys/dsh-singularity-evolution'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type { CompletionApproval } from './store.ts'
import { readCoordinationRows } from './store.ts'

/** One method record a round produced, as the completion derives from it. */
export interface RoundMethodRecord {
  readonly action: 'publish' | 'rollback' | 'discard'
  readonly revisionId: string | null
  readonly approvalRef: string | null
  readonly decidedBy: 'human' | 'operator' | 'platform_policy'
  readonly reason: string
}

/** The environment plane this module reads through, as the runtime answers it. */
interface EnvironmentPlane {
  activeEnvironmentView?(sessionId: string): Promise<{ readonly revisionId: string }>
  libraryForSession?(sessionId: string): Promise<{ readonly id: string; readonly root: string }>
}

function environmentPlane(ctx: Context): EnvironmentPlane | undefined {
  return optionalService<EnvironmentPlane>(ctx, 'taskRuntime')
}

/** The graph registry, read softly: the mode one graph runs its method in. */
interface GraphReader {
  graphForSession(sessionId: SessionId): Promise<{ rsi?: { humanReview?: boolean } | null }>
}

/** Whether this graph's method publication is decided by the platform policy rather than a person. */
async function platformDecided(ctx: Context, graphId: string): Promise<boolean> {
  const graphs = optionalService<GraphReader>(ctx, 'graphs')
  if (graphs === undefined) return false
  try {
    return (await graphs.graphForSession(SessionId(graphId))).rsi?.humanReview === false
  } catch {
    return false
  }
}

/** The revision this graph is running now, or `undefined` when no environment plane can answer. */
export async function activeMethodRevision(
  ctx: Context,
  rootSessionId: string,
): Promise<{ readonly revisionId: string } | undefined> {
  const plane = environmentPlane(ctx)
  try {
    const view = await plane?.activeEnvironmentView?.(rootSessionId)
    return view === undefined ? undefined : { revisionId: view.revisionId }
  } catch {
    return undefined
  }
}

/**
 * The method records one business round produced, read from this graph's own v5
 * ledger (`<library>/methods.jsonl`) and bounded by the round's own assignment:
 * a record counts for this round when it was appended after the round's
 * supervisor was assigned. A deployment that has not mounted the environment
 * plane answers nothing — the completion then reports `retain`/`trial` rather
 * than a promotion nobody recorded.
 */
export async function roundMethodRecords(
  ctx: Context,
  graphId: string,
  businessRound: number,
): Promise<readonly RoundMethodRecord[]> {
  const plane = environmentPlane(ctx)
  if (plane?.libraryForSession === undefined) return []
  const boundary = await roundBoundaryOf(graphId, businessRound)
  if (boundary === undefined) return []
  let library: { readonly id: string; readonly root: string }
  try {
    library = await plane.libraryForSession(graphId)
  } catch {
    return []
  }
  let views
  try {
    const ledger = await openMethodLedger({ root: library.root, libraryId: library.id })
    views = [...foldMethods(ledger.records()).values()]
  } catch {
    return []
  }
  const platform = await platformDecided(ctx, graphId)
  const records: RoundMethodRecord[] = []
  for (const view of views) {
    const published = view.published
    if (published !== undefined && published.at >= boundary) {
      records.push({
        action: 'publish',
        revisionId: published.revisionId,
        approvalRef: published.approvalRef ?? null,
        decidedBy: platform ? 'platform_policy' : 'human',
        reason: `draft ${view.draft.draftId} published as revision ${published.revisionId}`,
      })
    }
    const rolledback = view.rolledback
    if (rolledback !== undefined && rolledback.at >= boundary) {
      records.push({
        action: 'rollback',
        revisionId: rolledback.revisionId,
        approvalRef: rolledback.approvalRef ?? null,
        decidedBy: platform ? 'platform_policy' : 'human',
        reason: `draft ${view.draft.draftId} rolled back to revision ${rolledback.revisionId}`,
      })
    }
    const discardedAt = lastHistoryAt(view.history, 'discard')
    if (view.status === 'discarded' && discardedAt !== undefined && discardedAt >= boundary) {
      records.push({
        action: 'discard',
        revisionId: null,
        approvalRef: null,
        decidedBy: 'operator',
        reason: view.discardReason ?? `draft ${view.draft.draftId} discarded`,
      })
    }
  }
  return records.sort((left, right) => (left.action < right.action ? -1 : left.action > right.action ? 1 : 0))
}

/** The `at` of the last record of one kind in a draft's own history, or nothing. */
function lastHistoryAt(history: readonly { readonly kind: string; readonly at: string }[], kind: string): string | undefined {
  let at: string | undefined
  for (const entry of history) if (entry.kind === kind) at = entry.at
  return at
}

/** When this round's supervisor was assigned: the lower bound a record must be appended after to belong to this round. */
async function roundBoundaryOf(graphId: string, businessRound: number): Promise<string | undefined> {
  let rows
  try {
    rows = (await readCoordinationRows()) ?? []
  } catch {
    return undefined
  }
  const at = rows
    .filter((row): row is Extract<(typeof rows)[number], { kind: 'assignment' }> => row.kind === 'assignment')
    .filter(row => row.graphId === graphId && row.role === 'supervisor')
    .filter(row => row.subject.kind === 'round' && row.subject.businessRound === businessRound)
    .map(row => row.at)
    .sort()
  return at[0]
}

/** The last element of a list, or nothing. */
function lastOf<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[items.length - 1]
}

/** The platform's own account of what this round decided about the method. */
export function methodDecisionOf(
  records: readonly RoundMethodRecord[],
  trialCandidateRef: string | undefined,
): { readonly methodDecision: 'retain' | 'trial' | 'promote' | 'discard' | 'rollback'; readonly approval?: CompletionApproval } {
  const discarded = lastOf(records.filter(record => record.action === 'discard'))
  const rolledback = lastOf(records.filter(record => record.action === 'rollback'))
  const published = lastOf(records.filter(record => record.action === 'publish'))
  if (rolledback !== undefined) return { methodDecision: 'rollback', ...approvalOf(rolledback) }
  if (published !== undefined) return { methodDecision: 'promote', ...approvalOf(published) }
  if (discarded !== undefined) return { methodDecision: 'discard', ...approvalOf(discarded) }
  if (trialCandidateRef !== undefined)
    return { methodDecision: 'trial', approval: { source: 'platform_policy', ref: `trial:${trialCandidateRef}` } }
  return { methodDecision: 'retain' }
}

/** The approval source one publish/rollback record carried, when it carried one. */
function approvalOf(record: RoundMethodRecord): { readonly approval?: CompletionApproval } {
  if (record.approvalRef === null) return {}
  return {
    approval: {
      source: record.decidedBy === 'human' ? 'human' : 'platform_policy',
      ref: record.approvalRef,
    },
  }
}

/** Whether this round's search should continue; the search step never changes the business action. */
export function searchNextOf(input: {
  readonly steering?: 'explore' | 'stop-search'
  readonly businessRound: number
  readonly rounds: number
}): 'explore' | 'stop' {
  if (input.steering === 'stop-search') return 'stop'
  return input.businessRound >= input.rounds ? 'stop' : 'explore'
}

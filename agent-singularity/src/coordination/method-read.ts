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
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type { CompletionApproval } from './store.ts'

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
  libraryForSession?(sessionId: string): Promise<{ readonly root: string }>
}

function environmentPlane(ctx: Context): EnvironmentPlane | undefined {
  return optionalService<EnvironmentPlane>(ctx, 'taskRuntime')
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
 * The method records one business round produced. The round-scoped record store
 * belongs to the method tool surface; until it lands, no deployment can answer
 * and this returns nothing — which the completion reports as `retain`/`trial`
 * rather than as a promotion nobody recorded.
 */
export async function roundMethodRecords(
  _ctx: Context,
  _graphId: string,
  _businessRound: number,
): Promise<readonly RoundMethodRecord[]> {
  return []
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

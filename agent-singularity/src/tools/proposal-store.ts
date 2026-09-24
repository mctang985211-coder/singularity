/**
 * The store one proposal call belongs to (A0 §1.5, stage-D defect 1; A2: the
 * location now goes through the context read core's trusted binding).
 *
 * A worker's store is the graph store its run lives in, and a root session's
 * store is the graph's root store whether or not its contract is activated —
 * a root before acceptance has no run, and that is exactly the state in which
 * it has to read the proposal holding its contract (`task_intake`'s answers
 * and the root prompt both send it to `task_proposal_read`). Both facts come
 * from `ctx.singularityContext.resolveCaller`, the same session→graph→store
 * binding every other read uses, never from an argument the caller passed.
 *
 * A caller with no binding of its own — a plain member, a reviewer whose
 * delegation does not make it a worker, a session in no graph — gets the same
 * refusal the runtime's own lookup answered with before this door existed:
 * the proposal tools do not widen such a session into a store.
 * @module dsh-singularity-agent/tools/proposal-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@dangosys/dsh-singularity-context'

/** The store one proposal call belongs to; see the module doc. */
export async function proposalStoreFor(ctx: Context, sessionId: SessionId): Promise<string> {
  const resolution = await ctx.singularityContext.resolveCaller(sessionId)
  if (resolution.kind === 'worker' || resolution.kind === 'root') return resolution.storeId
  throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`)
}

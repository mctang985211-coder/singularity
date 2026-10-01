import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'

/** The live agent a coordination node spawns from — the shape `ToolRunContext.agent` and the agent registry both answer with. */
export type ReviewParentAgent = NonNullable<ToolRunContext['agent']>

const STORE_PREFIX = 'sg-t-'

/** The owner session of a root task store, or `undefined` for an id this deployment did not build. The parse is re-checked */
export function ownerSessionOfStore(storeId: string): string | undefined {
  if (!storeId.startsWith(STORE_PREFIX)) return undefined
  const sessionId = storeId.slice(STORE_PREFIX.length)
  return sessionId.length > 0 && rootTaskStoreId(sessionId) === storeId ? sessionId : undefined
}

/** The live root agent of one root task store: the owner session the store id derives, resolved against this process's agent registry — `undefined` when the parse fails or the session is not live here. */
export function liveRootAgentOf(
  ctx: Context,
  storeId: string,
): { readonly sessionId: string; readonly agent: ReviewParentAgent } | undefined {
  const sessionId = ownerSessionOfStore(storeId)
  if (sessionId === undefined) return undefined
  const registry = optionalService<{ get(id: string): ReviewParentAgent | undefined }>(ctx, 'agents')
  const agent = registry?.get(sessionId)
  return agent === undefined ? undefined : { sessionId, agent }
}

/** The ref a reader uses for one review source (`<taskId>#<runId>`, or `<taskId>#no-run`). */
export function reviewRef(source: { readonly taskId: string; readonly runId?: string | null }): string {
  return `${source.taskId}#${source.runId ?? 'no-run'}`
}

/** Whether two review sources are the same source. */
export function sameSource(
  left: { readonly taskId: string; readonly runId: string | null },
  right: { readonly taskId: string; readonly runId: string | null },
): boolean {
  return left.taskId === right.taskId && left.runId === right.runId
}

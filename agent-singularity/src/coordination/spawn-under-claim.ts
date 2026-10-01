/** The claim-and-spawn ritual both coordination triggers share: claim the attempt inside its admission region, spawn under the ledger's delegation read-back, and settle a spawn that never reached model input (A5/A6). @module @dangosys/dsh-singularity-agent/spawn-under-claim */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type { ReviewParentAgent } from './identity.ts'
import {
  readReviewerDelegation,
  settleReviewAgentAttempt,
  type ReviewAgentAdmission,
  type ReviewAgentAttemptRequest,
} from './ledger.ts'

/** What one claim-and-spawn ended as: the live handle, or the failure that left the attempt settled `interrupted`. */
export type ClaimedSpawn =
  | { readonly kind: 'spawned'; readonly handle: Awaited<ReturnType<Context['agentRuntime']['spawn']>> }
  | { readonly kind: 'spawn-failed'; readonly failure: string }

/** One coordination agent to spawn under its claim. */
export interface ClaimedSpawnRequest {
  readonly ctx: Context
  /** The admission region the caller already decided in — the claim is written inside it. */
  readonly admission: ReviewAgentAdmission
  readonly storeId: string
  readonly request: ReviewAgentAttemptRequest
  /** The pre-allocated coordination session: the attempt's identity and the spawn's own id. */
  readonly sessionId: SessionId
  /** The task the attempt is for, as the started row and the settlement record it. */
  readonly taskId: string
  /** The session the attempt runs for (the caller). */
  readonly actor: string
  /** The live parent whose spawn publishes the coordination node. */
  readonly parent: ReviewParentAgent
  readonly name: string
  readonly preset: string
  readonly grant: WorkerGrant
  /** The first request, built after the claim so it reads the ledger the claim is now part of. */
  readonly prompt: () => string | Promise<string>
  readonly signal?: AbortSignal
  /** What the read-back refusal names, with the role: `task_review_agent: the delegation of reviewer session`. */
  readonly errorLabel: string
  /** What the settlement note names before the failure: `spawn failed`, `the supervisor could not be spawned`. */
  readonly failureLabel: string
}

/** Claim the attempt and spawn its agent, or record the attempt interrupted when the spawn never reached model input. */
export async function spawnUnderClaim(input: ClaimedSpawnRequest): Promise<ClaimedSpawn> {
  await input.admission.claim(input.request)
  const prompt = await input.prompt()
  let spawnFailure: string | undefined
  const handle = await input.ctx.agentRuntime.spawn(input.parent, {
    sessionId: input.sessionId,
    name: input.name,
    prompt: [{ type: 'text', text: prompt }],
    agentPreset: input.preset,
    grant: input.grant,
    // The delegation ledger is written between "the agent is a published graph
    // member" and "its first model input" (A2 §D): the read-back is the check.
    beforePrompt: async () => {
      await input.admission.start({ taskId: input.taskId, sessionId: input.sessionId, actor: input.actor })
      const back = await readReviewerDelegation(input.sessionId)
      if (back === undefined || back.rootStoreId !== input.storeId || back.taskId !== input.taskId) {
        throw new Error(
          `${input.errorLabel} "${input.sessionId}" could not be read back from the ledger ` +
          `(expected task ${input.taskId} in ${input.storeId}); no model input was sent`,
        )
      }
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }).catch((error: unknown) => {
    spawnFailure = error instanceof Error ? error.message : String(error)
    return undefined
  })
  if (handle === undefined) {
    // A spawn that failed before its started row spent nothing, but its claim
    // stands: recording the terminal fact is what lets the source be taken up.
    await settleReviewAgentAttempt({
      rootStoreId: input.storeId, taskId: input.taskId, sessionId: input.sessionId,
      status: 'interrupted', note: `${input.failureLabel}: ${spawnFailure ?? 'unknown error'}`,
    }).catch(() => undefined)
    return { kind: 'spawn-failed', failure: spawnFailure ?? 'unknown error' }
  }
  return { kind: 'spawned', handle }
}

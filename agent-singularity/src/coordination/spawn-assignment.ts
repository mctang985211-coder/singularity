/**
 * Assignment before spawn: the row is written and flushed first, the agent is
 * spawned second, and the spawn's own `beforePrompt` reads the row back — so a
 * coordination session can never reach model input without a durable record of
 * what it was asked to do, and a crash between the two leaves a row a restart
 * can reconcile.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/spawn-assignment
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import { graphAgentOptions } from '@dangosys/dsh-singularity-graphs'
import { appendAssignment, readCoordinationBinding, recordCompletion, type CoordinationRole } from './store.ts'
import { bindingOfAssignment, interrupted } from './completion.ts'
import { assignmentOf, type AssignmentRequest } from './assignment.ts'
import type { ReviewParentAgent } from './identity.ts'

/** The handle a coordination spawn returns, as the runtime's own door answers it. */
export type CoordinationSpawnHandle = Awaited<ReturnType<Context['agentRuntime']['spawn']>>

/** What one assignment and its spawn ended as. */
export type AssignedSpawn =
  | { readonly kind: 'spawned'; readonly handle: CoordinationSpawnHandle }
  | { readonly kind: 'spawn-failed'; readonly failure: string }

/** One coordination agent to write down and then spawn. */
export interface SpawnAssignmentRequest {
  readonly ctx: Context
  readonly request: AssignmentRequest
  readonly parent: ReviewParentAgent
  readonly name: string
  readonly preset: string
  readonly grant: WorkerGrant
  readonly role: CoordinationRole
  readonly prompt: () => string | Promise<string>
  readonly signal?: AbortSignal
}

/** Write the assignment, spawn the agent, and let the spawn's own door read the row back. */
export async function spawnAssignment(input: SpawnAssignmentRequest): Promise<AssignedSpawn> {
  const { ctx, request } = input
  const row = assignmentOf(request, new Date().toISOString())
  await appendAssignment(row)
  const prompt = await input.prompt()
  const pinned = graphAgentOptions(await ctx.graphs.graphForSession(input.parent.id))
  let failure: string | undefined
  const handle = await ctx.agentRuntime
    .spawn(input.parent, {
      sessionId: request.sessionId,
      name: input.name,
      prompt: [{ type: 'text', text: prompt }],
      agentPreset: input.preset,
      grant: input.grant,
      permissionPreset: 'danger-full-access',
      coordinationRole: input.role,
      ...(pinned === undefined ? {} : { agentOptions: pinned }),
      // The row is already flushed; this door is the check that what spawns is
      // what was written, and it runs between publication and model input.
      beforePrompt: async () => {
        const binding = await readCoordinationBinding(String(request.sessionId)).catch(() => undefined)
        if (
          binding === undefined ||
          binding.graphId !== request.key.graphId ||
          binding.rootStoreId !== request.storeId ||
          binding.role !== request.key.role
        )
          throw new Error(
            `coordination: the assignment of session "${String(request.sessionId)}" could not be read back from ` +
              `${request.storeId} (expected ${request.key.role} of graph ${request.key.graphId}); no model input was sent`,
          )
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error)
      return undefined
    })
  if (handle === undefined) {
    // The session never reached model input. Recording the terminal fact is what
    // keeps the work item retryable and bounded instead of silently in flight.
    await recordCompletion(
      interrupted(
        bindingOfAssignment(row, false),
        `the coordination session could not be spawned: ${failure ?? 'unknown error'}`,
      ),
    ).catch(() => undefined)
    return { kind: 'spawn-failed', failure: failure ?? 'unknown error' }
  }
  return { kind: 'spawned', handle }
}

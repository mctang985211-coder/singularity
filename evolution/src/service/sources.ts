/** The soft service lookups this plane makes: the effective capability table and the session plane.
 * @module dsh-singularity-evolution/service/sources */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { optionalService, registeredVerifierVocabulary } from '@dangosys/dsh-singularity-task-runtime'
import type { McpServerTemplate, CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityRegistrySource } from '../types.ts'

/** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
export function effectiveCapabilitiesOf(ctx: Context): Readonly<Record<string, CapabilityConfig>> | undefined {
  const runtime = optionalService<CapabilityRegistrySource>(ctx, 'taskRuntime')
  try {
    return runtime?.listCapabilities?.()
  } catch {
    return undefined
  }
}

/** One session's own durable log, read through the deployment's session plane, or `undefined` when it cannot be read. */
export async function sessionLog(ctx: Context, sessionId: string): Promise<readonly SessionEvent[] | undefined> {
  const query = optionalService<{ readSession?(id: SessionId): Promise<{ events: readonly SessionEvent[] }> }>(
    ctx,
    'sessionQuery',
  )
  if (query === undefined || typeof query.readSession !== 'function') return undefined
  const read = await query.readSession(SessionId(sessionId))
  return read.events
}

/** The registered verifier vocabulary, normalized, or `undefined` when the deployment cannot list one. */
export async function verifierVocabularyOf(
  ctx: Context,
): Promise<{ ids: readonly string[]; versions: Readonly<Record<string, string>> } | undefined> {
  const vocabulary = await registeredVerifierVocabulary(ctx)
  return vocabulary === undefined ? undefined : { ids: vocabulary.ids, versions: vocabulary.versions }
}

/** Deployment server definitions, read freshly for every candidate or commit. */
export function effectiveMcpServersOf(ctx: Context): Readonly<Record<string, McpServerTemplate>> {
  const runtime = optionalService<CapabilityRegistrySource>(ctx, 'taskRuntime')
  return runtime?.listMcpServers?.() ?? {}
}

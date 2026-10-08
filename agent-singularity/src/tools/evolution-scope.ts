import type { Context } from '@deepseek-ai/cordis'
import type { EvolutionService } from '@dangosys/dsh-singularity-evolution'

/** Resolve the Evolution ledger for the caller's graph.  The compatibility
 * fallback is intentionally only for embedders without a graph library (unit
 * fixtures and the legacy direct API); a live TaskRuntime always supplies the
 * graph library and therefore cannot silently use another graph's ledger. */
export async function evolutionForSession(ctx: Context, caller: string): Promise<EvolutionService> {
  const service = ctx.evolution as unknown as EvolutionService & { forSession?: (sessionId: string) => Promise<EvolutionService> }
  if (typeof service.forSession !== 'function') return service
  return service.forSession(caller)
}

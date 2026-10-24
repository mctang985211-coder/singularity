import type { Envelope } from '../protocol/envelope.ts'
import { foldSubjects } from '../protocol/fold.ts'
import { ProtocolRegistry } from '../protocol/registry.ts'
import { declareTaskProtocol, TASK_PROTOCOL, TASK_VERSION, type TaskState } from './protocol.ts'

/**
 * The task protocol, declared once here so a caller hands this projection a log rather than a
 * reading of one: how those facts are reduced is this module's business, exactly as it is for
 * `strategy/published-assets.ts`.
 */
const FOLD = new ProtocolRegistry()
declareTaskProtocol(FOLD)

/**
 * The declared methods of `revisionId` in `environmentId` that no run consumed below `cutoff`.
 *
 * Declaration order is kept and a name declared twice is answered twice: the deployment's manifest
 * is its own format, and this projection does not edit it.
 */
export function unconsumedMethods(
  entries: readonly Envelope[],
  environmentId: string,
  revisionId: string,
  declared: readonly string[],
  cutoff: number,
): readonly string[] {
  const belowCutoff = entries.filter(entry => entry.seq < cutoff)
  const consumed = new Set<string>()
  for (const task of foldSubjects<TaskState>(FOLD, belowCutoff, TASK_PROTOCOL, TASK_VERSION).values()) {
    for (const run of Object.values(task.runs)) {
      if (run.revision.environmentId !== environmentId || run.revision.revisionId !== revisionId) continue
      for (const record of run.consumed)
        if (record.mode === 'read' || record.mode === 'invoked') consumed.add(record.method)
    }
  }
  return declared.filter(method => !consumed.has(method))
}

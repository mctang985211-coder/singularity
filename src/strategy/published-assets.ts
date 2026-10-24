import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../environment/protocol.ts'
import type { Envelope } from '../protocol/envelope.ts'
import { foldSubject } from '../protocol/fold.ts'
import { ProtocolRegistry } from '../protocol/registry.ts'
import { structuralEditsOf } from './edits.ts'

const FOLD = new ProtocolRegistry()
declareEnvironmentProtocol(FOLD)

/** Accepted edits are publication changes. The first head establishes the bootstrap baseline. */
export function publishedAssetsBelow(
  entries: readonly Envelope[],
  environmentId: string,
  cutoff: number,
): readonly string[] {
  const prefix = entries.filter(entry => entry.seq < cutoff)
  const environment = foldSubject<EnvironmentState>(
    FOLD,
    prefix,
    ENVIRONMENT_PROTOCOL,
    ENVIRONMENT_VERSION,
    environmentId,
  )
  if (environment === undefined) return []
  const accepted = new Set<string>()
  for (const entry of prefix) {
    if (
      entry.protocol !== ENVIRONMENT_PROTOCOL ||
      entry.version !== ENVIRONMENT_VERSION ||
      entry.subject !== environmentId ||
      entry.kind !== ENVIRONMENT_KINDS.pointerSwitched
    )
      continue
    const { expected, to } = entry.payload as { expected: string; to: string }
    if (expected === '') continue
    for (const edit of structuralEditsOf(
      environment.revisions[expected]!.manifest,
      environment.revisions[to]!.manifest,
    ))
      accepted.add(edit.asset)
  }
  return [...accepted]
}

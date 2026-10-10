/**
 * E2 (`docs/tdd-seams.md` §4): the declared methods nothing consumed, over the facts of one log.
 *
 * Pinning a run to a revision proves nothing about which of that revision's methods were used
 * (`review.md` §4 R08), so `task@5` records one `method/consumed` fact per use and this projection
 * answers the question that follows: **which of the method names a revision declares have no
 * consumption fact below a cutoff.**
 *
 * **One projection, one owner.** `declared` is the list of method names the revision declares, read
 * by the **deployment** from its own manifest format: this protocol does not define somebody else's
 * manifest, and it does not guess one when the deployment cannot read it. The comparison — a
 * declared name against the recorded facts — lives here, once.
 *
 * **The revision is named by (environment, revision id).** `environment@2` refuses an id twice with
 * different content, so within an environment an id *is* a content identity and this projection does
 * not need a digest it would have nothing to check against. Which revision a consumption fact
 * belongs to is not read off the fact anyway: the reducer refuses a fact whose revision is not the
 * one its run pinned, so the run's pin is that value.
 *
 * **The cutoff bounds every fact read** (`seq < cutoff`), so a consumption recorded after the
 * history was frozen cannot add itself to it (`review.md` R03), and one prefix always answers the
 * same. The facts are folded by `task@5`'s own reducers rather than filtered by hand, so a fact this
 * build cannot read is refused instead of being half-understood.
 *
 * @module singularity-core/task/consumption
 */

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
      for (const record of run.consumed) consumed.add(record.method)
    }
  }
  return declared.filter(method => !consumed.has(method))
}

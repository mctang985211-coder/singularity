/**
 * The draft write door: one immutable draft on the v5 ledger, and its discard.
 * A draft id is allocated by the environment store and carried through both
 * stores, so the draft directory and the ledger line agree on one id.
 */

import { foldMethods } from '../ledger/fold.ts'
import type { DraftView } from '../ledger/fold.ts'
import { validateDraftRecord } from '../ledger/records.ts'
import type { EvolutionRecordV5 } from '../ledger/records.ts'
import type { CandidateRevision, MethodAssetKind, MethodListFilter, RevisionRef } from '../types.ts'

/** The ledger seam every write door of the new protocol runs on. */
export interface MethodLedger {
  readonly libraryId: string
  records(): readonly EvolutionRecordV5[]
  append(record: EvolutionRecordV5): Promise<void>
}

/** What one draft is created from; the id is the environment store's own. */
export interface DraftRequest {
  readonly draftId: string
  readonly kind: MethodAssetKind
  readonly identity: string
  readonly baseRevision: RevisionRef
  readonly candidateRevision: CandidateRevision
  readonly rationale: string
  readonly sourceRefs: readonly string[]
  readonly actor: string
}

/** The folded view of one draft, or a refusal naming it. */
export function draftView(ledger: MethodLedger, draftId: string): DraftView {
  const view = foldMethods(ledger.records()).get(draftId)
  if (view === undefined) throw new Error(`evolution: unknown draft "${draftId}"`)
  return view
}

/** Every draft of one library, newest first, optionally filtered. */
export function draftViews(ledger: MethodLedger, filter: MethodListFilter = {}): DraftView[] {
  return [...foldMethods(ledger.records()).values()]
    .filter(
      view =>
        (filter.status === undefined || view.status === filter.status) &&
        (filter.kind === undefined || view.draft.kind === filter.kind) &&
        (filter.libraryId === undefined || view.libraryId === filter.libraryId),
    )
    .reverse()
}

/** Create one draft. The caller allocated the id; this door only records it. */
export async function createDraft(ledger: MethodLedger, request: DraftRequest): Promise<DraftView> {
  const existing = foldMethods(ledger.records()).get(request.draftId)
  if (existing !== undefined) {
    throw new Error(`evolution: draft "${request.draftId}" already exists on this ledger`)
  }
  const record: EvolutionRecordV5 = {
    formatVersion: 5,
    kind: 'draft',
    draftId: request.draftId,
    libraryId: ledger.libraryId,
    assetKind: request.kind,
    identity: request.identity,
    baseRevision: request.baseRevision,
    candidateRevision: request.candidateRevision,
    rationale: request.rationale,
    sourceRefs: [...request.sourceRefs],
    actor: request.actor,
    at: new Date().toISOString(),
  }
  validateDraftRecord(record)
  await ledger.append(record)
  return draftView(ledger, request.draftId)
}

/** Discard one open draft, with the reason a reader will see. A published or discarded draft takes no discard. */
export async function discardDraft(
  ledger: MethodLedger,
  input: { draftId: string; reason: string; actor: string },
): Promise<DraftView> {
  const view = draftView(ledger, input.draftId)
  if (view.status === 'discarded') {
    throw new Error(`evolution: draft "${input.draftId}" is already discarded (${view.discardReason ?? 'no reason recorded'})`)
  }
  if (view.status === 'published') {
    throw new Error(
      `evolution: draft "${input.draftId}" is published as revision "${view.published?.revisionId}"; a published draft is rolled back, not discarded`,
    )
  }
  const record: EvolutionRecordV5 = {
    formatVersion: 5,
    kind: 'discard',
    draftId: input.draftId,
    reason: input.reason,
    actor: input.actor,
    at: new Date().toISOString(),
  }
  validateDraftRecord(record)
  await ledger.append(record)
  return draftView(ledger, input.draftId)
}

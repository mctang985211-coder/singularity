/** `context_read`: one record of the caller's own domain, by reference (A2 §D/A2-5). @module @dangosys/dsh-singularity-context/reads-reference-read */

import type {
  Diagnosis,
  EvidenceBundle,
  ReviewRecord,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { CallerResolution, LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, sliceUtf8, utf8Bytes } from '../limits.ts'
import { refused, read, type NamedRefusal, type ProjectedRead } from '../refusals.ts'
import {
  diagnosisRecordText,
  evidenceRecordText,
  reviewRecordText,
  runRecordText,
  taskRecordText,
} from '../render/records.ts'
import type { ContextReadQuery, ReadDeps, ReviewReference, SessionEventReference } from '../types.ts'
import { sessionEventRead } from '../session/session-event-read.ts'
import { sessionRead } from '../session/session-read.ts'
import { readableTaskIds, storeSource, TASK_PAGE_MIN_BYTES, unboundRead } from './guards.ts'

/** One located record: the store object plus the identity the result prints. */
interface LocatedRecord {
  readonly identity: string
  readonly record: TaskInstance | TaskRun | EvidenceBundle | ReviewRecord | Diagnosis
}

/** The record text one located record renders to — the kind decides, never a property sniff. */
async function recordTextOf(
  deps: ReadDeps,
  snapshot: TaskSnapshot,
  kind: Exclude<ContextReadQuery['kind'], 'session'>,
  record: LocatedRecord['record'],
): Promise<string> {
  switch (kind) {
    case 'task':
      return taskRecordText(record as TaskInstance)
    case 'run':
      return await runRecordText(deps.taskRuntime, record as TaskRun, snapshot)
    case 'evidence':
      return evidenceRecordText(snapshot, record as EvidenceBundle)
    case 'review':
      return reviewRecordText(record as ReviewRecord)
    case 'diagnosis':
      return diagnosisRecordText(record as Diagnosis)
  }
}

function unknownDetail(noun: string, ref: string, snapshot: TaskSnapshot): string {
  return (
    `no ${noun} "${ref}" in your graph's task store (it holds ${snapshot.tasks.length} tasks); ` +
    'ids from another graph are not readable here, and a reference never widens the read domain.'
  )
}

/** Resolve one reference inside the caller's own store; never outside it. */
function locateRecord(
  snapshot: TaskSnapshot,
  kind: Exclude<ContextReadQuery['kind'], 'session'>,
  ref: ContextReadQuery['ref'],
): LocatedRecord | { readonly refusal: NamedRefusal; readonly detail: string } {
  if (kind === 'review') {
    const { taskId, runId = null } = ref as ReviewReference
    const task = snapshot.tasks.find(item => item.taskId === taskId)
    if (task === undefined) {
      return {
        refusal: 'not-found',
        detail: `task "${taskId}" is not in your graph's task store, so the review reference does not resolve inside the caller's domain.`,
      }
    }
    const review = [...snapshot.reviews]
      .reverse()
      .find(item => item.taskId === taskId && (item.runId ?? null) === runId)
    if (review !== undefined) return { identity: `${taskId}#${runId ?? 'no-run'}`, record: review }
    const others = snapshot.reviews.filter(item => item.taskId === taskId)
    if (others.length === 0) {
      return {
        refusal: 'not-found',
        detail: `task "${taskId}" has no review record in this store, so the reference names nothing.`,
      }
    }
    return {
      refusal: 'stale-reference',
      detail:
        `task "${taskId}" has review records, but none for run "${runId ?? '(none)'}": this store holds ` +
        `${others.map(item => `${item.taskId}#${item.runId ?? 'no-run'} (${item.outcome})`).join(', ')}. ` +
        'The reference names a review that does not exist for that run.',
    }
  }
  const id = ref as string
  switch (kind) {
    case 'task': {
      const task = snapshot.tasks.find(item => item.taskId === id)
      return task === undefined
        ? { refusal: 'not-found', detail: unknownDetail('task', id, snapshot) }
        : { identity: id, record: task }
    }
    case 'run': {
      const run = snapshot.runs.find(item => item.runId === id)
      return run === undefined
        ? { refusal: 'not-found', detail: unknownDetail('run', id, snapshot) }
        : { identity: id, record: run }
    }
    case 'evidence': {
      const evidence = snapshot.evidence.find(item => item.evidenceId === id)
      if (evidence === undefined) return { refusal: 'not-found', detail: unknownDetail('evidence', id, snapshot) }
      if (!snapshot.tasks.some(item => item.taskId === evidence.taskId)) {
        return {
          refusal: 'stale-reference',
          detail: `evidence "${id}" names task "${evidence.taskId}", which this store does not hold: the reference is stale.`,
        }
      }
      return { identity: id, record: evidence }
    }
    case 'diagnosis': {
      const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === id)
      if (diagnosis === undefined) return { refusal: 'not-found', detail: unknownDetail('diagnosis', id, snapshot) }
      if (!snapshot.tasks.some(item => item.taskId === diagnosis.taskId)) {
        return {
          refusal: 'stale-reference',
          detail: `diagnosis "${id}" names task "${diagnosis.taskId}", which this store does not hold: the reference is stale.`,
        }
      }
      return { identity: id, record: diagnosis }
    }
  }
}

/** `context_read` (A2 §D/A2-5): one record of the caller's own domain, by reference. */
export async function contextRead(
  deps: ReadDeps,
  loaded: LoadedCaller,
  query: ContextReadQuery,
  signal?: AbortSignal,
): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution as Extract<CallerResolution, { kind: 'unbound' }>)
  signal?.throwIfAborted()
  const kind = query.kind

  if (kind === 'session') {
    if (typeof query.ref === 'string') {
      return await sessionRead(deps, loaded, query.ref, query.offset, query.limit, signal)
    }
    return await sessionEventRead(deps, loaded, query.ref as SessionEventReference, query.offset, query.limit, signal)
  }
  const snapshot = loaded.snapshot
  if (snapshot === undefined) {
    return refused(
      'not-activated',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so it holds no ${kind} record to read.`,
    )
  }

  const allowed = readableTaskIds(loaded)
  const readable = allowed === undefined ? snapshot : {
    ...snapshot,
    tasks: snapshot.tasks.filter(record => allowed.has(record.taskId)),
    runs: snapshot.runs.filter(record => allowed.has(record.taskId)),
    evidence: snapshot.evidence.filter(record => allowed.has(record.taskId)),
    reviews: snapshot.reviews.filter(record => allowed.has(record.taskId)),
    diagnoses: snapshot.diagnoses.filter(record => allowed.has(record.taskId)),
  }
  const found = locateRecord(readable, kind, query.ref)
  if ('refusal' in found) return refused(found.refusal, found.detail)
  const recordText = await recordTextOf(deps, snapshot, kind, found.record)
  const offset = Math.max(0, Math.trunc(query.offset ?? 0))
  const limit = Math.min(
    CONTEXT_OUTPUT_LIMIT_BYTES,
    Math.max(TASK_PAGE_MIN_BYTES, Math.trunc(query.limit ?? CONTEXT_OUTPUT_LIMIT_BYTES)),
  )
  const total = utf8Bytes(recordText)
  const banner = [
    `# context_read ${kind} ${found.identity}`,
    `store ${resolution.storeId} of graph "${resolution.graph.id}" — record ${total} UTF-8 bytes; this page starts at byte ${offset}`,
    ...(offset > total ? ['the offset is past the end of the record: this page is empty'] : []),
  ].join('\n')
  // The page carries `limit` bytes of the record; the banner and the continuation
  // footer ride inside the one output bound, never on top of it.
  const pageBudget = Math.max(1, Math.min(limit, CONTEXT_OUTPUT_LIMIT_BYTES - utf8Bytes(banner) - 96))
  const slice = sliceUtf8(recordText, offset, pageBudget)
  const footer = slice.done
    ? `(end of record at byte ${slice.nextOffset})`
    : `(more of this record follows: ask again with offset ${slice.nextOffset})`
  const text = [banner, '', slice.text, '', footer].join('\n')
  return read(text, storeSource(resolution.graph, resolution.storeId, `read the ${kind} record`), {
    hasMore: !slice.done,
    nextOffset: slice.nextOffset,
  })
}

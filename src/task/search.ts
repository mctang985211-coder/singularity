import { assertClosedKeys } from '../protocol/envelope.ts'
import { defineKind, type KindRule } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import { digest, record, requireRun, text } from './shape.ts'
import { requireResponsible } from './responsibility.ts'
import type { TaskState } from './protocol.ts'
import { revisionRef, REVISION_MEMBERS } from './shape.ts'
import type { RevisionRef } from './protocol.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fileAttachmentRef } from './run.ts'

export interface ProposalBatch {
  readonly batchId: string
  readonly incumbent: RevisionRef
  readonly editBudget: 1
  readonly historyCutoff: number
  readonly untried: readonly string[]
  readonly prune: boolean
  readonly slots: readonly { readonly path: string; readonly contentDigest: string; readonly proposal: FileAttachmentRef }[]
  readonly outcomes: readonly { readonly slot: number; readonly status: string; readonly detail: string; readonly revision?: RevisionRef }[]
  readonly settled: boolean
}

export interface SearchState {
  readonly runId: string
  readonly maxProposals: number
  readonly batches?: readonly ProposalBatch[]
}

function working(state: TaskState, actor: string, runId: string): void {
  requireResponsible(state, actor, 'RSI search')
  const run = requireRun(state, runId, 'RSI search')
  if (run.purpose !== 'improve' || run.status !== 'running' || run.stage !== 'working')
    refuse('illegal-transition', 'search belongs to a working RSI Run')
}

/** Frozen slots and their outcomes share the Task log; the Run owns submission and termination. */
export function searchKinds(): Readonly<Record<string, KindRule<TaskState>>> {
  return {
    'rsi/batch-opened': defineKind<TaskState, Omit<ProposalBatch, 'outcomes' | 'settled'>, {}>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['batchId', 'incumbent', 'editBudget', 'historyCutoff', 'untried', 'prune', 'slots'], nested: {},
      parse: raw => {
        const row = record(raw, 'proposal batch'), budget = row['editBudget']
        if (budget !== 1 || !Number.isSafeInteger(row['historyCutoff']) || (row['historyCutoff'] as number) < 0 || typeof row['prune'] !== 'boolean' || !Array.isArray(row['untried']) || row['untried'].some(a => !['workflow', 'template', 'skill', 'tool'].includes(String(a))) || new Set(row['untried']).size !== row['untried'].length || !Array.isArray(row['slots']) || !row['slots'].length || row['slots'].length > 3)
          refuse('malformed-payload', 'batch needs one to three slots and a positive edit budget')
        const slots = row['slots'].map(raw => {
          const slot = record(raw, 'batch slot')
          assertClosedKeys(slot, ['path', 'contentDigest', 'proposal'], 'batch slot')
          const contentDigest = digest(slot, 'contentDigest', 'batch slot')
          return { path: text(slot, 'path', 'batch slot'), contentDigest,
            proposal: fileAttachmentRef(slot['proposal'], contentDigest, 'batch slot.proposal') }
        })
        if (new Set(slots.map(s => s.contentDigest)).size !== slots.length) refuse('malformed-payload', 'duplicate batch slot')
        return { batchId: text(row, 'batchId', 'batch'), incumbent: revisionRef(row['incumbent'], 'batch incumbent', REVISION_MEMBERS), editBudget: 1, historyCutoff: row['historyCutoff'] as number, untried: row['untried'] as string[], prune: row['prune'] as boolean, slots }
      },
      reduce: (state, fact, payload) => {
        const search = state.search
        if (!search) refuse('illegal-transition', 'freeze search before planning proposal slots')
        working(state, fact.actor, search.runId)
        if (state.transfer !== undefined) refuse('illegal-transition', 'search ended; champion is frozen')
        if (search.batches?.some(b => !b.settled)) refuse('illegal-transition', 'proposal batch is pending; finish the frozen batch first')
        if (state.rounds?.some(r => r.status === 'pending')) refuse('illegal-transition', 'evaluation is pending; wait for its committed outcome')
        if ((search.batches ?? []).reduce((n, b) => n + b.slots.length, 0) + payload.slots.length > search.maxProposals)
          refuse('illegal-transition', 'proposal budget exhausted, including invalid slots')
        if (search.batches?.some(b => b.batchId === payload.batchId)) refuse('illegal-transition', 'batch was already attempted')
        return { ...state, search: { ...search, batches: [...(search.batches ?? []), { ...payload, outcomes: [], settled: false }] } }
      },
    }),
    'rsi/batch-slot-settled': defineKind<TaskState, { batchId: string; slot: number; status: string; detail: string; revision?: RevisionRef }, {}>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['batchId', 'slot', 'status', 'detail', 'revision'], nested: {},
      parse: raw => { const row = record(raw, 'batch outcome'), slot = row['slot']; if (!Number.isSafeInteger(slot) || (slot as number) < 0) refuse('malformed-payload', 'invalid batch slot'); return {
        batchId: text(row, 'batchId', 'batch outcome'), slot: slot as number, status: text(row, 'status', 'batch outcome'), detail: text(row, 'detail', 'batch outcome'),
        ...(row['revision'] === undefined ? {} : { revision: revisionRef(row['revision'], 'slot revision', REVISION_MEMBERS) }),
      } },
      reduce: (state, fact, payload) => {
        const search = state.search!, batch = search?.batches?.find(b => b.batchId === payload.batchId)
        if (batch === undefined || batch.settled || payload.slot >= batch.slots.length || batch.outcomes.some(o => o.slot === payload.slot)) refuse('illegal-transition', 'slot is not pending')
        working(state, fact.actor, search.runId)
        return { ...state, search: { ...search, batches: search.batches!.map(b => b === batch ? { ...b, outcomes: [...b.outcomes, payload] } : b) } }
      },
    }),
    'rsi/batch-ended': defineKind<TaskState, { batchId: string }, {}>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['batchId'], nested: {}, parse: raw => ({ batchId: text(record(raw, 'batch end'), 'batchId', 'batch end') }),
      reduce: (state, fact, payload) => {
        const search = state.search!, batch = search?.batches?.find(b => b.batchId === payload.batchId)
        if (!batch || batch.settled || batch.outcomes.length !== batch.slots.length) refuse('illegal-transition', 'every planned slot must settle')
        working(state, fact.actor, search.runId)
        return { ...state, search: { ...search, batches: search.batches!.map(b => b === batch ? { ...b, settled: true } : b) } }
      },
    }),
    'rsi/search-opened': defineKind<TaskState, { runId: string; maxProposals: number }, {}>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['runId', 'maxProposals'], nested: {},
      parse: raw => {
        const row = record(raw, 'search')
        const maxProposals = row['maxProposals']
        if (!Number.isSafeInteger(maxProposals) || (maxProposals as number) < 1)
          refuse('malformed-payload', 'maxProposals must be a positive safe integer')
        return { runId: text(row, 'runId', 'search'), maxProposals: maxProposals as number }
      },
      reduce: (state, envelope, payload) => {
        working(state, envelope.actor, payload.runId)
        if (state.search !== undefined) refuse('illegal-transition', 'search is already frozen')
        return { ...state, search: payload }
      },
    }),
  }
}

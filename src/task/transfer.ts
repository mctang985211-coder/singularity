import { defineKind, type KindRule } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import { digest, record, revisionRef, REVISION_MEMBERS, text } from './shape.ts'
import { requireResponsible } from './responsibility.ts'
import type { RevisionRef, TaskState } from './protocol.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fileAttachmentRef, FILE_ATTACHMENT_MEMBERS } from './run.ts'

export interface TransferState {
  readonly baseline: RevisionRef
  readonly champion: RevisionRef
  readonly suiteDigest: string
  readonly executionProfileDigest: string
  readonly roundId: string
  readonly consumed: boolean
  readonly outcome?: 'improved' | 'no-improvement' | 'insufficient-evidence'
  readonly report?: FileAttachmentRef
}
function owner(state: TaskState, actor: string): void {
  requireResponsible(state, actor, 'transfer validation')
  const run = Object.values(state.runs).at(-1)
  if (run?.purpose !== 'improve' || run.status !== 'running' || run.stage !== 'submitted' || state.rounds?.some(r => r.status === 'pending') || state.search?.batches?.some(b => !b.settled))
    refuse('illegal-transition', 'validation requires a submitted report and settled search work')
}
export function transferKinds(): Readonly<Record<string, KindRule<TaskState>>> {
  return {
    'rsi/transfer-frozen': defineKind<TaskState, Omit<TransferState, 'consumed' | 'outcome' | 'report'>, {}>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['baseline', 'champion', 'suiteDigest', 'executionProfileDigest', 'roundId'], nested: {},
      parse: raw => { const row = record(raw, 'transfer'); return {
        baseline: revisionRef(row['baseline'], 'baseline', REVISION_MEMBERS), champion: revisionRef(row['champion'], 'champion', REVISION_MEMBERS),
        suiteDigest: digest(row, 'suiteDigest', 'transfer'), executionProfileDigest: digest(row, 'executionProfileDigest', 'transfer'), roundId: text(row, 'roundId', 'transfer'),
      } },
      reduce: (state, fact, payload) => {
        owner(state, fact.actor)
        if (state.transfer !== undefined) refuse('illegal-transition', 'champion is already frozen')
        return { ...state, transfer: { ...payload, consumed: false } }
      },
    }),
    'rsi/transfer-started': defineKind<TaskState, { suiteDigest: string }, {}>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['suiteDigest'], nested: {},
      parse: raw => ({ suiteDigest: digest(record(raw, 'tranche'), 'suiteDigest', 'tranche') }),
      reduce: (state, fact, payload) => {
        owner(state, fact.actor)
        if (state.transfer === undefined || state.transfer.consumed || state.transfer.suiteDigest !== payload.suiteDigest) refuse('illegal-transition', 'validation tranche unavailable')
        return { ...state, transfer: { ...state.transfer, consumed: true } }
      },
    }),
    'rsi/transfer-settled': defineKind<TaskState, { outcome: NonNullable<TransferState['outcome']>; report: FileAttachmentRef }, { report: typeof FILE_ATTACHMENT_MEMBERS }>({
      guarantees: { appended: true }, emitter: 'scheduler', members: ['outcome', 'report'], nested: { report: FILE_ATTACHMENT_MEMBERS },
      parse: raw => {
        const row = record(raw, 'transfer result'), outcome = row['outcome']
        if (outcome !== 'improved' && outcome !== 'no-improvement' && outcome !== 'insufficient-evidence') refuse('malformed-payload', 'unknown transfer outcome')
        return { outcome, report: fileAttachmentRef(row['report'], undefined, 'transfer.report') }
      },
      reduce: (state, fact, payload) => {
        const run = Object.values(state.runs).at(-1)
        if (run?.purpose === 'improve' && run.status === 'failed' && payload.outcome === 'insufficient-evidence')
          requireResponsible(state, fact.actor, 'settle interrupted validation')
        else owner(state, fact.actor)
        if (!state.transfer?.consumed || state.transfer.outcome !== undefined) refuse('illegal-transition', 'validation must be consumed once')
        return { ...state, transfer: { ...state.transfer, ...payload } }
      },
    }),
  }
}

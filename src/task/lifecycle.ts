import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { isDeepStrictEqual } from 'node:util'
import { defineKind, type KindRule } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import { assertClosedKeys } from '../protocol/envelope.ts'
import { requireResponsible } from './responsibility.ts'
import { record, text, requireRun, revisionRef, REVISION_MEMBERS } from './shape.ts'
import type { RevisionRef, TaskState } from './protocol.ts'
export interface RoundRequest {
  readonly runId: string
  readonly roundId: string
  readonly round: number
  readonly incumbent: RevisionRef
  readonly candidates: readonly RevisionRef[]
  readonly status: 'pending' | 'completed' | 'failed'
  readonly error?: string
}
export interface TaskClosure {
  readonly runId: string
  readonly reason: 'accepted' | 'failed'
}
export interface RSIStatus {
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly detail: string
  readonly trace?: FileAttachmentRef
}
export function lifecycleKinds(): Readonly<Record<string, KindRule<TaskState>>> {
  return {
    'task/closed': defineKind<TaskState, TaskClosure, {}>({
      guarantees: { appended: true },
      emitter: 'scheduler',
      members: ['runId', 'reason'],
      nested: {},
      parse: (raw) => {
        const row = record(raw, 'task closure'),
          reason = text(row, 'reason', 'task closure')
        if (!['accepted', 'failed'].includes(reason))
          refuse('malformed-payload', 'unknown task closure')
        return { runId: text(row, 'runId', 'task closure'), reason: reason as TaskClosure['reason'] }
      },
      reduce: (state, envelope, payload) => {
        requireResponsible(state, envelope.actor, 'close Task')
        const run = requireRun(state, payload.runId, 'close Task')
        if (
          state.closure !== undefined ||
          run.status === 'running' ||
          Object.values(state.runs).at(-1)?.runId !== payload.runId ||
          (payload.reason === 'accepted') !== (run.status === 'verified')
        )
          refuse('illegal-transition', 'closure requires the last terminal Run and its actual outcome')
        return { ...state, closure: payload }
      },
    }),
    'rsi/status': defineKind<TaskState, RSIStatus, {}>({
      guarantees: { appended: true },
      emitter: 'scheduler',
      members: ['status', 'detail', 'trace'],
      nested: {},
      parse: (raw) => {
        const row = record(raw, 'RSI status'),
          status = text(row, 'status', 'RSI status')
        if (!['pending', 'running', 'completed', 'failed'].includes(status))
          refuse('malformed-payload', 'unknown RSI status')
        const trace = row['trace'] === undefined ? undefined : record(row['trace'], 'sealed trajectory')
        if (trace !== undefined) {
          assertClosedKeys(trace, ['attachmentId', 'name', 'bytes'], 'sealed trajectory')
          text(trace, 'name', 'sealed trajectory')
          if (
            !/^sha256:[0-9a-f]{64}$/.test(text(trace, 'attachmentId', 'sealed trajectory')) ||
            !Number.isSafeInteger(trace['bytes']) ||
            (trace['bytes'] as number) < 0
          )
            refuse('malformed-payload', 'invalid sealed trajectory')
        }
        if (status === 'running' && trace === undefined)
          refuse('malformed-payload', 'RSI must freeze its trajectory before analysis')
        return {
          status: status as RSIStatus['status'],
          detail: text(row, 'detail', 'RSI status'),
          ...(trace === undefined ? {} : { trace: trace as unknown as FileAttachmentRef }),
        }
      },
      reduce: (state, _envelope, payload) => {
        if (state.closure === undefined) refuse('illegal-transition', 'RSI follows Task closure')
        const allowed =
          state.rsi === undefined
            ? ['pending']
            : state.rsi.status === 'pending'
              ? ['running', 'failed']
              : state.rsi.status === 'running'
                ? ['completed', 'failed']
                : state.rsi.status === 'failed' && state.rsi.trace !== undefined && isDeepStrictEqual(payload.trace, state.rsi.trace)
                  ? ['running']
                : []
        if (!allowed.includes(payload.status)) refuse('illegal-transition', 'invalid RSI transition')
        return { ...state, rsi: { ...state.rsi, ...payload } }
      },
    }),
    'rsi/round-requested': defineKind<TaskState, Omit<RoundRequest, 'status' | 'error'>, {}>({
      guarantees: { appended: true },
      emitter: 'scheduler',
      members: ['runId', 'roundId', 'round', 'incumbent', 'candidates'],
      nested: {},
      parse: (raw) => {
        const row = record(raw, 'round request')
        const round = row['round']
        if (!Number.isSafeInteger(round) || (round as number) < 1) refuse('malformed-payload', 'round must be positive')
        if (!Array.isArray(row['candidates']) || row['candidates'].length === 0)
          refuse('malformed-payload', 'round needs candidates')
        const candidates = row['candidates'].map((ref) => revisionRef(ref, 'candidate', REVISION_MEMBERS))
        if (new Set(candidates.map(ref => ref.digest)).size !== candidates.length)
          refuse('malformed-payload', 'round candidates must be unique revisions')
        return {
          runId: text(row, 'runId', 'round request'),
          roundId: text(row, 'roundId', 'round request'),
          round: round as number,
          incumbent: revisionRef(row['incumbent'], 'incumbent', REVISION_MEMBERS),
          candidates,
        }
      },
      reduce: (state, envelope, payload) => {
        requireResponsible(state, envelope.actor, 'request evaluation')
        const run = requireRun(state, payload.runId, 'request evaluation')
        if (
          run.purpose !== 'improve' ||
          run.status !== 'running' ||
          run.stage !== 'working' ||
          state.rounds?.some((r) => r.roundId === payload.roundId || r.status === 'pending')
        )
          refuse('illegal-transition', 'evaluation requires a unique working RSI request')
        return { ...state, rounds: [...(state.rounds ?? []), { ...payload, status: 'pending' }] }
      },
    }),
    'rsi/round-settled': defineKind<TaskState, { roundId: string; status: 'completed' | 'failed'; error?: string }, {}>(
      {
        guarantees: { appended: true },
        emitter: 'scheduler',
        members: ['roundId', 'status', 'error'],
        nested: {},
        parse: (raw) => {
          const row = record(raw, 'round outcome')
          if (row['status'] !== 'completed' && row['status'] !== 'failed')
            refuse('malformed-payload', 'invalid round outcome')
          return {
            roundId: text(row, 'roundId', 'round outcome'),
            status: row['status'],
            ...(row['error'] === undefined ? {} : { error: text(row, 'error', 'round outcome') }),
          }
        },
        reduce: (state, _envelope, payload) => {
          if (!state.rounds?.some((r) => r.roundId === payload.roundId && r.status === 'pending'))
            refuse('illegal-transition', 'round is not pending')
          return {
            ...state,
            rounds: state.rounds.map((r) => (r.roundId === payload.roundId ? { ...r, ...payload } : r)),
          }
        },
      },
    ),
  }
}

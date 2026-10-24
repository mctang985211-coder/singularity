import { AGENT_ROLE } from '../agent/protocol.ts'
import { defineKind, type KindRule } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import type { TaskState } from './protocol.ts'
import { record, requireRun, text } from './shape.ts'
import { requireResponsible } from './responsibility.ts'

/** Simplified from Singularity task/question: one direct-parent exchange, pinned to both Runs. */
export interface TaskQuestion {
  readonly questionId: string
  readonly runId: string
  readonly parentId: string
  readonly parentRunId: string
  readonly parentIdentity: string
  readonly parentAgentId: string
  readonly question: string
  readonly blocking: boolean
  readonly seq: number
  readonly answers: readonly TaskAnswer[]
}
export interface TaskAnswer {
  readonly answerId: string
  readonly answer: string
  readonly resolves: boolean
  readonly evidence: readonly string[]
  readonly seq: number
}
type Ask = Omit<TaskQuestion, 'seq' | 'answers'>
type Answer = Omit<TaskAnswer, 'seq'> & { readonly questionId: string }
const bool = (row: Record<string, unknown>, key: string): boolean => {
  if (typeof row[key] !== 'boolean') refuse('malformed-payload', `${key} must be boolean`)
  return row[key] as boolean
}
export const openQuestions = (state: TaskState, runId: string): readonly TaskQuestion[] =>
  (state.questions ?? []).filter(q => q.runId === runId && !q.answers.some(a => a.resolves))

export function questionKinds(): Readonly<Record<string, KindRule<TaskState>>> {
  return {
    'task/question-asked': defineKind<TaskState, Ask, {}>({
      guarantees: { appended: true },
      emitter: AGENT_ROLE,
      members: [
        'questionId',
        'runId',
        'parentId',
        'parentRunId',
        'parentIdentity',
        'parentAgentId',
        'question',
        'blocking',
      ],
      nested: {},
      parse: raw => {
        const row = record(raw, 'question')
        return {
          questionId: text(row, 'questionId', 'question'),
          runId: text(row, 'runId', 'question'),
          parentId: text(row, 'parentId', 'question'),
          parentRunId: text(row, 'parentRunId', 'question'),
          parentIdentity: text(row, 'parentIdentity', 'question'),
          parentAgentId: text(row, 'parentAgentId', 'question'),
          question: text(row, 'question', 'question'),
          blocking: bool(row, 'blocking'),
        }
      },
      reduce: (state, envelope, payload) => {
        requireResponsible(state, envelope.actor, 'ask parent')
        const run = requireRun(state, payload.runId, 'ask parent')
        if (
          run.status !== 'running' ||
          run.stage !== 'working' ||
          state.questions?.some(q => q.questionId === payload.questionId)
        )
          refuse('illegal-transition', 'a new question requires a working Run and a unique identity')
        return { ...state, questions: [...(state.questions ?? []), { ...payload, seq: envelope.seq, answers: [] }] }
      },
    }),
    'task/question-answered': defineKind<TaskState, Answer, {}>({
      guarantees: { appended: true },
      emitter: AGENT_ROLE,
      members: ['questionId', 'answerId', 'answer', 'resolves', 'evidence'],
      nested: {},
      parse: raw => {
        const row = record(raw, 'answer')
        const evidence = row['evidence']
        if (
          !Array.isArray(evidence) ||
          evidence.some(id => typeof id !== 'string' || !id) ||
          new Set(evidence).size !== evidence.length
        )
          refuse('malformed-payload', 'answer evidence must be distinct Task references')
        return {
          questionId: text(row, 'questionId', 'answer'),
          answerId: text(row, 'answerId', 'answer'),
          answer: text(row, 'answer', 'answer'),
          resolves: bool(row, 'resolves'),
          evidence: evidence as string[],
        }
      },
      reduce: (state, envelope, payload) => {
        const question = state.questions?.find(q => q.questionId === payload.questionId)
        if (question === undefined || question.parentIdentity !== envelope.actor)
          refuse('not-responsible', 'only the recorded direct parent may answer this question')
        const run = requireRun(state, question.runId, 'answer child')
        if (
          run.status !== 'running' ||
          run.stage !== 'working' ||
          question.answers.some(a => a.resolves || a.answerId === payload.answerId)
        )
          refuse('illegal-transition', 'the question or asking Run has settled')
        const { questionId: _questionId, ...answer } = payload
        return {
          ...state,
          questions: state.questions!.map(q =>
            q === question ? { ...q, answers: [...q.answers, { ...answer, seq: envelope.seq }] } : q,
          ),
        }
      },
    }),
  }
}

/** The question plane: what a run owes an answer to, and what it has not read (A4 §F.1/§7.3). @module @dangosys/dsh-singularity-context/reads-questions */

import { questionsAwaitingAnswerOf } from '@dangosys/dsh-singularity-task'
import type { QuestionAnswerRecord, QuestionRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, budgetList, itemsClause } from '../limits.ts'
import { refused, read, type ProjectedRead } from '../refusals.ts'
import { eventReference } from '../session/page.ts'
import type { ReadDeps } from '../types.ts'
import { byString, resolveProjectionTarget, storeSource } from './guards.ts'

/** What nothing was proven about. */
const NOTHING_CONSUMED: ReadonlySet<string> = new Set()

/** The message identities one Session's own history proves its model has seen (A4 §7.3). */
async function consumedMessageIds(deps: ReadDeps, sessionId: string): Promise<ReadonlySet<string>> {
  const log = await deps.sessionQuery.readSession(sessionId)
  const ids = new Set<string>()
  for (const event of log.events.slice(log.inheritedEventCount)) {
    if (event.type === 'user/message') ids.add(String(event.data.id))
  }
  return ids
}

/** The order both lists print in: `askedAt` ascending, stable for same-millisecond asks. */
function byAskedAt(left: QuestionRecord, right: QuestionRecord): number {
  return byString(left.askedAt, right.askedAt)
}

/** One question line: the identity, the asking run, the blocking flag, and where the body is. */
function questionEntry(snapshot: TaskSnapshot, question: QuestionRecord): string {
  const task = snapshot.runs.find(run => run.runId === question.childRunId)?.taskId
  const from = `from child run ${question.childRunId}${task === undefined ? '' : ` (task ${task})`}`
  return (
    `- ${question.questionId} — ${from}, blocking: ${question.blocking ? 'yes' : 'no'}, asked ${question.askedAt}` +
    `\n  body: \`context_read\` kind:"session" ref:${eventReference(question.questionRef.sessionId, question.questionRef.seq)}`
  )
}

/** One answer line: the identity, the question it answers, the resolution, and where the body is. */
function answerEntry(question: QuestionRecord, answer: QuestionAnswerRecord): string {
  return (
    `- ${answer.answerId} — the answer to question ${question.questionId}, resolves: ${answer.resolves ? 'yes' : 'no'}, ` +
    `answered ${answer.answeredAt}` +
    `\n  body: \`context_read\` kind:"session" ref:${eventReference(answer.answerRef.sessionId, answer.answerRef.seq)}`
  )
}

/** One bounded list of question or answer lines: the entries in ask order, then the list's guidance. */
function questionList(
  budget: OutputBudget,
  heading: string,
  entries: readonly string[],
  guidance: string,
  scope: string,
  recovery: string,
): 'ok' | 'too-large' {
  const shown = budgetList(budget, {
    header: ['', heading],
    units: entries,
    lines: entry => [entry],
    tail: count => [
      ...(count === entries.length ? [] : [itemsClause(scope, recovery, entries.length, entries.length - count)]),
      guidance,
    ],
  })
  return shown === undefined ? 'too-large' : 'ok'
}

/** The question plane (A4 §F.1/§7.3): open questions owed, and answers no read has been shown. */
export async function questionProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const target = resolveProjectionTarget(loaded, {
    member: 'it asks no parent and answers no child; questions belong to the runs that hold them.',
    delegation: 'there is no delegated run whose questions could be projected.',
  })
  if (target.kind === 'refused') return target.read
  const { resolution } = target
  const snapshot = target.snapshot
  const source = storeSource(resolution.graph, resolution.storeId, "projected the caller's pending questions")
  const run = resolution.kind === 'worker' || resolution.kind === 'root' ? resolution.run : undefined
  if (snapshot === undefined || run === undefined) return read('', source)
  if (snapshot.questions === undefined) {
    return refused(
      'unreadable',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" answered with a snapshot that carries no question index, so ` +
        'the questions it holds cannot be read; a view built without them would report "no questions" for a store that has some.',
    )
  }

  const asked = [...questionsAwaitingAnswerOf(snapshot, run.runId)].sort(byAskedAt)
  const answers: { readonly question: QuestionRecord; readonly answer: QuestionAnswerRecord }[] = []
  for (const question of [...snapshot.questions.all].sort(byAskedAt)) {
    if (question.childRunId !== run.runId) continue
    for (const answer of question.answers ?? []) answers.push({ question, answer })
  }
  let consumed: ReadonlySet<string> = NOTHING_CONSUMED
  if (answers.length > 0) {
    try {
      consumed = await consumedMessageIds(deps, resolution.sessionId)
    } catch {
      // No proof means keep the reference: every recorded answer stays in the
      // view and a later assembly re-derives the fold.
      consumed = NOTHING_CONSUMED
    }
  }
  const unread = answers.filter(item => !consumed.has(item.answer.messageId))
  if (asked.length === 0 && unread.length === 0) return read('', source)

  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    '# Pending questions (coordination)',
    `role: ${resolution.kind}`,
    `graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
    "unanswered questions and answers not yet shown to have been read — derived from the store's question facts, never a phase change",
  ]
  if (budget.addAll(header) > 0) {
    return refused(
      'context-too-large',
      `the pending-questions header of store "${resolution.storeId}" does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, ` +
        'and a coordination view is never returned as a fragment of itself; nothing is reported in place of it.',
    )
  }

  if (asked.length > 0) {
    const guidance =
      'Answer a question with `task_answer` {questionId, requestKey, answer, resolves}; `resolves:false` keeps it open, and the ' +
      "body is at the reference on the question's line."
    const outcome = questionList(
      budget,
      `## Questions waiting for your answer (${asked.length})`,
      asked.map(question => questionEntry(snapshot, question)),
      guidance,
      'pending questions',
      'the questions this view could not carry stay open in the store',
    )
    if (outcome === 'too-large') return questionViewTooLarge(resolution.storeId, 'questions waiting for an answer')
  }

  if (unread.length > 0) {
    const guidance =
      'Read an answer at the reference on its line: it stays here until your own Session shows it was put in front of you.'
    const outcome = questionList(
      budget,
      `## Answers waiting to be read (${unread.length})`,
      unread.map(item => answerEntry(item.question, item.answer)),
      guidance,
      'unread answers',
      'the answers this view could not carry stay unread in the store',
    )
    if (outcome === 'too-large') return questionViewTooLarge(resolution.storeId, 'answers waiting to be read')
  }

  return read(budget.text(), source)
}

/** The refusal of a question list the output bound could not lay out at all. */
function questionViewTooLarge(storeId: string, what: string): ProjectedRead {
  return refused(
    'context-too-large',
    `the ${what} of store "${storeId}" do not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a coordination view is ` +
      'never returned as a fragment of itself; nothing is reported in place of it.',
  )
}

/**
 * A4-1, end to end on the real loop (plan §F.1): the question protocol as the
 * deployment actually runs it — a model call, the shipped tool, the Task store,
 * the DSH message, the write gate, and the next request, twice over.
 *
 * What is real in every case below, and why each of them matters:
 * - the **shipped tools** (`task_ask_parent`/`task_answer`, sub-goal ③c): the
 *   scripted model calls them by name, so the identity, the citation into the
 *   caller's own Session and the declaration are the tool layer's own work;
 * - the **real provider-side full path** of one call: the loop's `tool/call`
 *   event, the write gate's decision, the tool's execution, the runtime's
 *   entries, `TaskService`'s store and reducer, the real durable DSH inbox, and
 *   the loop's next assembly — nothing between the model and the store is a
 *   double, and the *only* thing scripted is what the model says;
 * - the **context assembly** (A2/A4 §7.2–§7.3): every request is assembled by the
 *   deployment's own waterfall, so what a case asserts about a request is what
 *   the model would have been shown.
 *
 * The acceptance this file carries is A4-1: a child asks a *waiting* parent, the
 * question reaches the parent's own model request, the parent answers, the answer
 * reaches the child's own request — with no synchronous wait between two loops —
 * and the same exchange relays one level further (grandchild → middle → root and
 * back) without deadlocking anywhere. Each step asserts the three records
 * agreeing: the Task store's question/answer identities, the identity and source
 * of the `user/message` the target Session really took into history, and the
 * write gate's state for the run each record names.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { blockingQuestionsOf, questionIdOf } from '../../task/src/index.ts'
import type { QuestionAnswerRecord, QuestionRecord } from '../../task/src/index.ts'
import type { DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptEntry,
  type ScriptedLoop,
  type ToolCallRecord,
} from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId

afterEach(async () => {
  await disposeScriptedLoops()
})

/** One child spec: a goal and a criterion a command can settle. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/** The root contract every case runs under (A0 §1.2). */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** The session the runtime spawned, by spawn order (the root is not among them). */
function spawnOf(h: ScriptedLoop, index: number): string {
  const spawn = h.spawns[index]
  if (spawn === undefined) throw new Error(`no spawn ${index} was recorded`)
  return spawn.sessionId
}

/** Wait until the store holds one batch id on a session's run, and return it. */
async function batchIdOf(h: ScriptedLoop, sessionId: string): Promise<string> {
  await vi.waitFor(async () => {
    const { run } = await h.runForSession(sessionId)
    expect(run.batchId).toBeDefined()
  })
  return (await h.runForSession(sessionId)).run.batchId as string
}

/** One recorded call of a name in one session, as soon as it reported a result (a deny reports one too). */
async function callOf(h: ScriptedLoop, name: string, sessionId: string, where?: (call: ToolCallRecord) => boolean): Promise<ToolCallRecord> {
  return await vi.waitFor(() => {
    const call = h.calls.find(item => item.name === name && item.sessionId === sessionId && item.result !== undefined && (where?.(item) ?? true))
    expect(call, `${name} in ${sessionId}`).toBeDefined()
    return call as ToolCallRecord
  })
}

/** The phase one session's run is in, as the store holds it. */
async function phaseOf(h: ScriptedLoop, sessionId: string): Promise<string | undefined> {
  return (await h.runForSession(sessionId)).run.executionPhase
}

/** The run id one session is bound to. */
async function runIdOf(h: ScriptedLoop, sessionId: string): Promise<string> {
  return (await h.runForSession(sessionId)).run.runId
}

/** One request of a session that carried a text, in request order — the proof the model was shown it. */
async function requestCarrying(h: ScriptedLoop, sessionId: string, needle: string) {
  return await vi.waitFor(() => {
    const request = h.requestsOf(sessionId).find(candidate => candidate.texts.join('\n').includes(needle))
    expect(request, `a request of ${sessionId} carrying "${needle}"`).toBeDefined()
    return request!
  })
}

/** Every `user/message` one session's own log holds, as the loop wrote it into history. */
function messagesOf(h: ScriptedLoop, sessionId: string): readonly UserMessage[] {
  return h.eventsOf(sessionId).flatMap((event: SessionEvent) => (event.type === 'user/message' ? [event.data as UserMessage] : []))
}

/** Every durable inbox insert one Session's log holds under one identity. */
function insertsOf(h: ScriptedLoop, sessionId: string, messageId: string): number {
  return h.eventsOf(sessionId).filter(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => String(message.id) === messageId)).length
}

/**
 * Wait until one target Session has claimed an identity into its own history,
 * then read the entry. A claim is the only proof the model was given the
 * message (§F.1): the inbox insert alone says nothing about whether a step read
 * it, and the claim is written by the loop before the request it belongs to.
 */
async function claimedIn(h: ScriptedLoop, sessionId: string, messageId: string): Promise<UserMessage> {
  return await vi.waitFor(() => {
    const [message] = messagesOf(h, sessionId).filter(candidate => candidate.id === messageId)
    expect(message, `session "${sessionId}" claiming message "${messageId}"`).toBeDefined()
    return message!
  })
}

/** Every history entry one target Session holds under one identity (two would mean a duplicate delivery). */
function claimsOf(h: ScriptedLoop, sessionId: string, messageId: string): readonly UserMessage[] {
  return messagesOf(h, sessionId).filter(message => message.id === messageId)
}

/** Wait for one question record in the store's snapshot, then read it. */
async function questionIn(h: ScriptedLoop, storeId: string, questionId: string): Promise<QuestionRecord> {
  return await vi.waitFor(async () => {
    const question = (await h.snapshot(storeId)).questions?.byId[questionId]
    expect(question, `question ${questionId} in ${storeId}`).toBeDefined()
    return question!
  })
}

/** Wait for the one answer a question holds, then read it. */
async function answerOf(h: ScriptedLoop, storeId: string, questionId: string): Promise<QuestionAnswerRecord> {
  return await vi.waitFor(async () => {
    const answers = (await h.snapshot(storeId)).questions?.byId[questionId]?.answers ?? []
    expect(answers, `an answer to ${questionId}`).toHaveLength(1)
    return answers[0]!
  })
}

/**
 * The one wait every case in this file uses to keep a worker where the case wants
 * it: the entry is served inside a request that then parks, so the session is
 * mid-turn — not idle — while the spec makes its assertions. An idle worker is a
 * different state for the runtime to read (the no-progress budget watches it, and
 * a run that settles closes its own questions), and none of that is this file's
 * subject.
 */
function hold(): { readonly until: Promise<void>; readonly release: () => void } {
  const gate = Promise.withResolvers<void>()
  return { until: gate.promise, release: () => { gate.resolve() } }
}

describe('a child asks its waiting parent (A4-1)', () => {
  it('shows the question in the parent\'s own request, answers it from waiting_children, and releases the child with the answer in its request', async () => {
    // The root's script parks one request behind a latch, then reads its own state
    // and answers in the *next* step. `begin` queues a kickoff turn of the
    // fixture's own, so which turn takes the latch is not this case's business —
    // what the latch guarantees is that the answer *behind* it can only be
    // dispatched once the spec has released it, and the spec releases it only
    // after the child's own call has put the question on the record. The answer
    // therefore cites exactly the question the store holds, with no race between
    // two loops. The `task_read` step is what makes the question and the
    // coordination plane the model was shown one request *behind* the answer:
    // both are assembled into the request, and that same request's step answers.
    const questionKnown = Promise.withResolvers<void>()
    const childParks = hold()
    let questionId = ''
    const h = await startScriptedLoop({
      probes: ['write'],
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { text: 'root: the batch is the runtime\'s now' },
            { waitFor: () => questionKnown.promise },
            { tool: 'task_read', args: {} },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { text: 'root: answered my child, still waiting on my batch' },
          ]
        }
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds for this run?' } },
          { text: 'child: waiting for an answer' },
          { tool: 'write', args: { path: 'child-write.txt', content: 'released' } },
          { waitFor: () => childParks.until },
        ]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    await batchIdOf(h, ROOT)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const child = spawnOf(h, 0)
    const childRunId = await runIdOf(h, child)
    const rootRunId = await runIdOf(h, ROOT)
    questionId = questionIdOf({ childRunId, requestKey: 'k1' })

    // The child's own model call went through the shipped tool: the runtime read
    // the body back from this call's own `tool/call`, recorded the question under
    // the caller's citation, and blocked the run. The call returned at the
    // delivery — it did not wait for the parent to answer, which is what keeps the
    // two loops off each other.
    const askCall = await callOf(h, 'task_ask_parent', child)
    expect(askCall.result?.isError).toBe(false)
    expect(askCall.result?.text).toContain(`question ${questionId} recorded for your direct parent (run ${rootRunId})`)
    expect(askCall.result?.text).toContain(`message m-${questionId} is in your parent's session`)
    expect(askCall.result?.text).toContain('This run is now blocked on that answer')
    expect(askCall.result?.text).not.toContain('the frozen contract holds')
    // …and the question it recorded is still unanswered: the call returned at the
    // delivery, not at the answer, and the parent's own turn is a separate loop.
    expect((await h.snapshot(root.storeId)).questions?.byId[questionId]?.answers ?? []).toEqual([])
    expect(h.runtime.gate.questionsBlocked(child)).toBe(true)
    // The gate refuses what the block closes, and names the question rather than
    // the phase (the run is `active`: a wait is not a closed phase).
    const deniedNow = h.runtime.gate.decide(child, 'write')
    expect(deniedNow.allow).toBe(false)
    expect(deniedNow.allow === false ? deniedNow.reason : '').toContain('waiting on an unresolved blocking question')
    expect(deniedNow.allow === false ? deniedNow.reason : '').toContain('phase is "active"')

    // The parent is a waiting parent — its own batch is what it is doing — and it
    // receives the question in its own model request: the relayed message, and the
    // assembled coordination plane beside it.
    await vi.waitFor(async () => expect(await phaseOf(h, ROOT)).toBe('waiting_children'))
    questionKnown.resolve()
    const parentRequest = await requestCarrying(h, ROOT, questionId)
    expect(parentRequest.texts.join('\n')).toContain(`[task-question ${questionId}] which contract holds for this run?`)
    expect(parentRequest.texts.join('\n')).toContain('## Questions waiting for your answer (1)')

    // The parent's answer went through the shipped tool too, from a phase whose
    // writes are closed, and the run stays exactly in that phase.
    const answerCall = await callOf(h, 'task_answer', ROOT)
    expect(answerCall.result?.isError).toBe(false)
    expect(answerCall.result?.text).toContain(`recorded for question ${questionId}`)
    expect(answerCall.result?.text).toContain('`resolves: true` releases exactly that question')
    expect(await phaseOf(h, ROOT)).toBe('waiting_children')

    // Three records of one exchange, agreeing identity by identity.
    const question = await questionIn(h, root.storeId, questionId)
    const answer = await answerOf(h, root.storeId, questionId)
    expect(question.childRunId).toBe(childRunId)
    expect(question.parentRunId).toBe(rootRunId)
    expect(question.blocking).toBe(true)
    expect(question.questionRef.sessionId).toBe(child)
    // The tool's own answer names the identity the store recorded — the two are
    // the same record, written by the runtime under the model's own citation.
    expect(answerCall.result?.text).toContain(`answer ${answer.answerId} recorded for question ${questionId}`)
    expect(answer.parentRunId).toBe(rootRunId)
    expect(answer.resolves).toBe(true)
    expect(answer.answerRef.sessionId).toBe(ROOT)
    // The message the target Session took into history is the identity the store
    // recorded, and its source is a delegation — an agent's message, never the
    // human's own (`source.kind === 'user'` is the person's marker).
    const asked = await claimedIn(h, ROOT, question.messageId)
    expect(asked.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: child })
    expect(insertsOf(h, ROOT, question.messageId)).toBe(1)
    expect(claimsOf(h, ROOT, question.messageId)).toHaveLength(1)
    const answered = await claimedIn(h, child, answer.messageId)
    expect(answered.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: ROOT })
    expect(insertsOf(h, child, answer.messageId)).toBe(1)
    expect(claimsOf(h, child, answer.messageId)).toHaveLength(1)
    // The gate agrees with the store's own derivation: the answer released that
    // question, and only that one.
    expect(h.runtime.gate.questionsBlocked(child)).toBe(false)
    expect(blockingQuestionsOf(await h.snapshot(root.storeId), childRunId)).toEqual([])

    // The child's next request is the proof the model was given the answer — and
    // the work the block closed is admitted again, without a phase change.
    const childRequest = await requestCarrying(h, child, answer.answerId)
    expect(childRequest.texts.join('\n')).toContain(`[task-answer ${answer.answerId} for ${questionId}] the frozen contract holds`)
    const write = await callOf(h, 'write', child)
    expect(write.result?.isError).toBe(false)
    expect(h.executed.some(name => name.includes('child-write.txt'))).toBe(true)
    expect(await phaseOf(h, child)).toBe('active')
    childParks.release()
  }, 30_000)

  it('answers a non-blocking question from the same waiting parent, leaving the child\'s write gate open throughout', async () => {
    const questionKnown = Promise.withResolvers<void>()
    const childParks = hold()
    const childHeld = hold()
    let questionId = ''
    const h = await startScriptedLoop({
      probes: ['write'],
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { text: 'root: waiting on my batch' },
            { waitFor: () => questionKnown.promise },
            { tool: 'task_read', args: {} },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId, requestKey: 'a1', answer: 'a note, not a gate', resolves: true }) },
            { text: 'root: noted' },
          ]
        }
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'a note, not a block', blocking: false } },
          { tool: 'write', args: { path: 'child-write.txt', content: 'never blocked' } },
          { waitFor: () => childHeld.until },
          // A step boundary between the hold and the rest: the request that parks
          // on the hold is the one built before the answer, and the step after it
          // is the one assembled with the answer in it.
          { tool: 'task_read', args: {} },
          { tool: 'write', args: { path: 'child-write-after.txt', content: 'still open' } },
          { waitFor: () => childParks.until },
        ]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    await batchIdOf(h, ROOT)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const child = spawnOf(h, 0)
    questionId = questionIdOf({ childRunId: await runIdOf(h, child), requestKey: 'k1' })

    const askCall = await callOf(h, 'task_ask_parent', child)
    expect(askCall.result?.isError).toBe(false)
    expect(askCall.result?.text).toContain('This run is not blocked')
    // A non-blocking question blocks nothing: the child keeps deciding its own
    // work while the question is open, and the write it makes next is admitted.
    expect(h.runtime.gate.questionsBlocked(child)).toBe(false)
    const write = await callOf(h, 'write', child)
    expect(write.result?.isError).toBe(false)
    const beforeAnswer = (await h.runForSession(child)).run.runId
    expect((await h.snapshot(root.storeId)).questions?.byId[questionId]?.answers ?? []).toEqual([])
    expect(h.runtime.gate.decide(child, 'task_submit_result')).toEqual({ allow: true })

    questionKnown.resolve()
    const parentRequest = await requestCarrying(h, ROOT, questionId)
    expect(parentRequest.texts.join('\n')).toContain('## Questions waiting for your answer (1)')
    const question = await questionIn(h, root.storeId, questionId)
    expect(question.blocking).toBe(false)
    const answer = await answerOf(h, root.storeId, questionId)
    expect(blockingQuestionsOf(await h.snapshot(root.storeId), question.childRunId)).toEqual([])
    expect(claimsOf(h, ROOT, question.messageId)).toHaveLength(1)
    // The never-blocked child: the answer reaches the same run, which is still the
    // one working — no phase change, no second run, and the next step in its own
    // turn is where the words land.
    childHeld.release()
    const answered = await claimedIn(h, child, answer.messageId)
    expect(answered.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: ROOT })
    const childRequest = await requestCarrying(h, child, answer.answerId)
    expect(childRequest.texts.join('\n')).toContain(`[task-answer ${answer.answerId} for ${questionId}] a note, not a gate`)
    const afterAnswer = await callOf(h, 'write', child, call => (call.args as { path?: string }).path === 'child-write-after.txt')
    expect(afterAnswer.result?.isError).toBe(false)
    expect((await h.runForSession(child)).run.runId).toBe(beforeAnswer)
    childParks.release()
  }, 30_000)
})

describe('a question relayed through a waiting middle to the root (A4-1, three levels)', () => {
  it('carries grandchild → middle → root and back, one level at a time, with every middle write still refused', async () => {
    // Two latches, one per level, each parking the request that will answer until
    // the level above has put its question on the record: the root's answer can
    // then only cite the relayed question, and the middle's answer can only cite
    // the grandchild's — neither is derived from a race between two loops. The two
    // holds keep the workers where the case's assertions need them.
    const relayKnown = Promise.withResolvers<void>()
    const grandchildKnown = Promise.withResolvers<void>()
    const grandchildParks = hold()
    const middleParks = hold()
    let grandchildQuestionId = ''
    let relayedQuestionId = ''
    const h = await startScriptedLoop({
      probes: ['write'],
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) {
          // The root: one batch, then it reads its state and answers the middle's
          // relayed question from the request that was shown it.
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('middle work') } },
            { text: 'root: waiting on my batch' },
            { waitFor: () => relayKnown.promise },
            { tool: 'task_read', args: {} },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId: relayedQuestionId, requestKey: 'a-root', answer: 'my child decides under the frozen contract', resolves: true }) },
            { text: 'root: answered my child' },
          ]
        }
        if (index === 1) {
          // The middle: a waiting parent with a batch of its own. Woken by its
          // grandchild's question, it relays the question to *its* parent, and
          // woken by the root's answer it answers the grandchild — never writing.
          return [
            { tool: 'task_decompose', args: { reason: 'split my own work', children: children('grandchild work') } },
            { text: 'middle: waiting on my own batch' },
            { tool: 'task_ask_parent', args: { requestKey: 'k-mid', question: 'my grandchild asks which contract holds: may I decide it?' } },
            { text: 'middle: relayed to my parent' },
            { waitFor: () => grandchildKnown.promise },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId: grandchildQuestionId, requestKey: 'a-mid', answer: 'the frozen contract holds, decided one level up', resolves: true }) },
            { tool: 'write', args: { path: 'middle-write.txt', content: 'never' } },
            { waitFor: () => middleParks.until },
          ]
        }
        // The grandchild: asks its direct parent, then is released by the answer.
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k-gc', question: 'which contract applies to me?' } },
          { text: 'grandchild: waiting for an answer' },
          { tool: 'write', args: { path: 'grandchild-write.txt', content: 'released' } },
          { waitFor: () => grandchildParks.until },
        ]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    await batchIdOf(h, ROOT)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const middle = spawnOf(h, 0)
    await batchIdOf(h, middle)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(2))
    const grandchild = spawnOf(h, 1)
    const rootRunId = await runIdOf(h, ROOT)
    const middleRunId = await runIdOf(h, middle)
    const grandchildRunId = await runIdOf(h, grandchild)
    grandchildQuestionId = questionIdOf({ childRunId: grandchildRunId, requestKey: 'k-gc' })
    relayedQuestionId = questionIdOf({ childRunId: middleRunId, requestKey: 'k-mid' })

    // Both parents are waiting parents for the whole exchange, and the middle's
    // own batch is still the thing it is doing.
    await vi.waitFor(async () => expect(await phaseOf(h, ROOT)).toBe('waiting_children'))
    await vi.waitFor(async () => expect(await phaseOf(h, middle)).toBe('waiting_children'))
    expect(h.runtime.gate.phaseOf(middle)).toBe('waiting_children')

    // Level one: the grandchild's shipped call reaches the middle's own request,
    // which is what makes the middle able to relay it at all.
    const grandchildAsk = await callOf(h, 'task_ask_parent', grandchild)
    expect(grandchildAsk.result?.isError).toBe(false)
    expect(grandchildAsk.result?.text).toContain('This run is now blocked on that answer')
    grandchildKnown.resolve()
    const middleRequest = await requestCarrying(h, middle, grandchildQuestionId)
    expect(middleRequest.texts.join('\n')).toContain(`[task-question ${grandchildQuestionId}] which contract applies to me?`)
    expect(middleRequest.texts.join('\n')).toContain('## Questions waiting for your answer (1)')
    expect(h.runtime.gate.questionsBlocked(grandchild)).toBe(true)

    // Level two: the middle relays through the same shipped tool, and the root —
    // which nothing drives on the middle's behalf — receives it in its own
    // request. The relay's own question blocks the middle in the meantime.
    const relayCall = await callOf(h, 'task_ask_parent', middle)
    expect(relayCall.result?.isError).toBe(false)
    expect(relayCall.result?.text).toContain(`question ${relayedQuestionId} recorded for your direct parent (run ${rootRunId})`)
    expect(relayCall.result?.text).not.toContain('my child decides under the frozen contract')
    const relayed = await questionIn(h, root.storeId, relayedQuestionId)
    expect(relayed.childRunId).toBe(middleRunId)
    expect(relayed.parentRunId).toBe(rootRunId)
    expect(relayed.blocking).toBe(true)
    // The relay returned at the delivery and the root has not answered it yet: the
    // middle's step is not waiting on the root's turn anywhere.
    expect(relayed.answers ?? []).toEqual([])
    // The relay blocks the middle while the root has not answered it: a parent's
    // own question is a question like any other.
    expect(h.runtime.gate.questionsBlocked(middle)).toBe(true)
    relayKnown.resolve()
    const rootRequest = await requestCarrying(h, ROOT, relayedQuestionId)
    expect(rootRequest.texts.join('\n')).toContain(`[task-question ${relayedQuestionId}] my grandchild asks which contract holds: may I decide it?`)
    expect(rootRequest.texts.join('\n')).toContain('## Questions waiting for your answer (1)')
    const relayClaim = await claimedIn(h, ROOT, relayed.messageId)
    expect(relayClaim.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: middle })
    expect(insertsOf(h, ROOT, relayed.messageId)).toBe(1)
    expect(claimsOf(h, ROOT, relayed.messageId)).toHaveLength(1)

    // The root answers the middle; the middle's own block is what the answer
    // releases, and the middle's request then carries it.
    const rootAnswerCall = await callOf(h, 'task_answer', ROOT)
    expect(rootAnswerCall.result?.isError).toBe(false)
    const rootAnswer = await answerOf(h, root.storeId, relayedQuestionId)
    expect(rootAnswer.resolves).toBe(true)
    expect(rootAnswer.parentRunId).toBe(rootRunId)
    expect(await phaseOf(h, ROOT)).toBe('waiting_children')
    expect(h.runtime.gate.questionsBlocked(middle)).toBe(false)
    const middleWoken = await requestCarrying(h, middle, rootAnswer.answerId)
    expect(middleWoken.texts.join('\n')).toContain(`[task-answer ${rootAnswer.answerId} for ${relayedQuestionId}] my child decides under the frozen contract`)
    const rootAnswerClaim = await claimedIn(h, middle, rootAnswer.messageId)
    expect(rootAnswerClaim.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: ROOT })

    // The middle answers its grandchild — from a phase whose writes are closed,
    // and through the shipped tool.
    const middleAnswerCall = await callOf(h, 'task_answer', middle)
    expect(middleAnswerCall.result?.isError).toBe(false)
    const middleAnswer = await answerOf(h, root.storeId, grandchildQuestionId)
    expect(middleAnswer.parentRunId).toBe(middleRunId)
    expect(middleAnswer.resolves).toBe(true)
    const middleAnswerClaim = await claimedIn(h, grandchild, middleAnswer.messageId)
    expect(middleAnswerClaim.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: middle })
    expect(insertsOf(h, grandchild, middleAnswer.messageId)).toBe(1)
    expect(claimsOf(h, grandchild, middleAnswer.messageId)).toHaveLength(1)

    // Level three: the grandchild's next request carries the answer, and the work
    // its block closed is admitted again.
    const grandchildRequest = await requestCarrying(h, grandchild, middleAnswer.answerId)
    expect(grandchildRequest.texts.join('\n')).toContain(
      `[task-answer ${middleAnswer.answerId} for ${grandchildQuestionId}] the frozen contract holds, decided one level up`,
    )
    const grandchildWrite = await callOf(h, 'write', grandchild)
    expect(grandchildWrite.result?.isError).toBe(false)
    expect(h.executed.some(name => name.includes('grandchild-write.txt'))).toBe(true)

    // The middle never got a write gate back: with both of its questions closed
    // it is still a waiting parent, and the write it attempted is refused for the
    // phase — not for a question, which is the sharper statement (A4 §F.1:
    // `waiting_children` is never turned `active` by an answer).
    const middleWrite = await callOf(h, 'write', middle)
    expect(middleWrite.result?.isError).toBe(true)
    expect(middleWrite.result?.text).toContain('phase "waiting_children"')
    expect(middleWrite.result?.text).not.toContain('waiting on an unresolved blocking question')
    expect(h.executed.some(name => name.includes('middle-write.txt'))).toBe(false)
    expect(h.runtime.gate.decide(middle, 'write').allow).toBe(false)
    expect(await phaseOf(h, middle)).toBe('waiting_children')
    expect(h.runtime.gate.phaseOf(middle)).toBe('waiting_children')

    // Every question the store holds, with the identity each was addressed to:
    // two questions, one per level, and no third one anywhere.
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.questions?.all.map(question => question.questionId).sort()).toEqual([relayedQuestionId, grandchildQuestionId].sort())
    expect(blockingQuestionsOf(snapshot, grandchildRunId)).toEqual([])
    expect(blockingQuestionsOf(snapshot, middleRunId)).toEqual([])
    expect(blockingQuestionsOf(snapshot, rootRunId)).toEqual([])
    grandchildParks.release()
    middleParks.release()
  }, 60_000)
})

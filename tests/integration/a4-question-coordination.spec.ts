import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import { blockingQuestionsOf, questionIdOf } from '../../task/src/index.ts'
import type { TaskEvent } from '../../task/src/index.ts'
import type { DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptedLoop,
  type ScriptEntry,
  type ToolCallRecord,
} from '../support/scripted-loop.ts'

/**
 * A4 acceptance on the real loop (plan §F.1): the question protocol's runtime
 * half — the blocking write gate, the two orchestration entries, the delivery
 * identities they record, and the budget that still ends a blocked wait.
 *
 * What is real in every case below: the deployment's own tool registry and
 * waterfall (so a denial is the gate's decision and a probe records whether a
 * body ran at all), the real `TaskService` and its reducer, the real
 * `ExecutionGate` (its `decide` is in the call path), real DSH sessions with the
 * real durable inbox, the real `AgentRuntime` delivery path, and the real batch
 * drivers of `task-runtime`. What is scripted is the model's answers, and
 * nothing else.
 *
 * The two question tools are kept as stand-ins in these stacks
 * (`questionTools: 'stand-in'`): these cases drive the runtime entries
 * themselves, and what a tool layer *does* is hand the runtime the caller's own
 * call id. That is exactly what these specs do — the scripted call leaves the
 * real `tool/call` event in the caller's session, and the spec calls the runtime
 * entry with that citation. The shipped definitions, and the model-driven turns
 * that run them end to end, are A4 sub-goal ③c's own spec
 * (`a4-question-loop.spec.ts`). The store, the gate and the delivery are never
 * faked here, and the gate's decision on `task_ask_parent`/`task_answer` is
 * asserted through the real waterfall before any entry is called. One case is
 * the exception, and on purpose: the replay case that has a worker decompose for
 * real runs the shipped `task_decompose`/`task_ask_parent`/`task_answer`, because
 * what it covers — the checkout a replay run holds while its own batch is
 * admitted — is only reachable through the production tool path.
 *
 * The tree the blocking cases use is three layers deep on purpose
 * (`root → middle → grandchild`): the grandchild and the middle are workers (the
 * worker baseline carries the question tools), the middle is in
 * `waiting_children` with a batch of its own, and the middle is whom the
 * grandchild asks — the direct parent the protocol allows to answer. That makes
 * "the waiting parent answers and still cannot write" observable in the same
 * tree as "the blocked child is released by exactly the answer that resolves its
 * question".
 */

const ROOT = 's-root' as SessionId
/** The session of the child a replay task really owns (see the replay cases: its parent task is the replay's). */
const REPLAY_CHILD = 's-replay-child'

afterEach(async () => {
  await disposeScriptedLoops()
})

/** One child spec: a goal and a criterion a command can settle. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/** The root contract every case runs under (A0 §1.2): one goal, one criterion a command settles. */
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

/** Every task event one store appended, read back from its own session log. */
function taskEventsOf(h: ScriptedLoop, storeId: string): TaskEvent[] {
  return h.eventsOf(storeId).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** Wait for one question record in the store's snapshot, then read it. */
async function questionOf(h: ScriptedLoop, storeId: string, questionId: string) {
  return await vi.waitFor(async () => {
    const question = (await h.snapshot(storeId)).questions?.byId[questionId]
    expect(question, `question ${questionId} in ${storeId}`).toBeDefined()
    return question!
  })
}

/** Every durable inbox insert one Session's log holds under one identity. */
function insertsOf(h: ScriptedLoop, sessionId: string, messageId: string): number {
  return h.eventsOf(sessionId).filter(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => String(message.id) === messageId)).length
}

/**
 * Wait until one target Session has claimed an identity into its own history,
 * then read the entry — the proof the message reached the loop's own state rather
 * than only the target's inbox.
 */
async function claimedIn(h: ScriptedLoop, sessionId: string, messageId: string) {
  return await vi.waitFor(() => {
    const claimed = h.eventsOf(sessionId)
      .flatMap(event => (event.type === 'user/message' ? [event.data] : []))
      .find(message => String(message.id) === messageId)
    expect(claimed, `session ${sessionId} claiming message ${messageId}`).toBeDefined()
    return claimed!
  })
}

/** One request of a session that carried a text, in request order — the proof the model was shown it. */
async function requestCarrying(h: ScriptedLoop, sessionId: string, needle: string) {
  return await vi.waitFor(() => {
    const request = h.requestsOf(sessionId).find(candidate => candidate.texts.join('\n').includes(needle))
    expect(request, `a request of ${sessionId} carrying "${needle}"`).toBeDefined()
    return request!
  })
}

describe('the write gate under a question block (A4 §F.1)', () => {
  it('denies writes, decomposition and submission while a blocking question is open, and lets reads and coordination through', async () => {
    const proceed = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    let grandchildRunId = ''
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      probes: ['write', 'task_decompose', 'task_submit_result'],
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('middle work') } },
            { waitFor: () => released.promise },
            { text: 'root: the batch is the runtime\'s now' },
          ]
        }
        if (index === 1) {
          // The middle: it holds a batch of its own, then answers the question
          // its grandchild asks — from `waiting_children`, which is the phase the
          // protocol says may answer and may not write.
          return [
            { tool: 'task_decompose', args: { reason: 'split my own work', children: children('grandchild work') } },
            { waitFor: () => proceed.promise },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId: questionIdOf({ childRunId: grandchildRunId, requestKey: 'k1' }), requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { tool: 'write', args: { path: 'middle-write.txt', content: 'no' } },
            { waitFor: () => released.promise },
            { text: 'middle: answered, still waiting on my batch' },
          ]
        }
        // The grandchild: ask, then try every effect a closed phase refuses.
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds for this run?' } },
          { waitFor: () => proceed.promise },
          { tool: 'write', args: { path: 'child-write.txt', content: 'no' } },
          { tool: 'task_decompose', args: { reason: 'not yet', children: children('stillborn') } },
          { tool: 'task_submit_result', args: { summary: 'nothing to hand in yet' } },
          { tool: 'task_read', args: {} },
          { waitFor: () => released.promise },
          { tool: 'write', args: { path: 'child-write-after.txt', content: 'yes' } },
          { text: 'grandchild: released' },
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
    await vi.waitFor(async () => expect((await h.runForSession(grandchild)).run.executionPhase).toBe('active'))
    grandchildRunId = (await h.runForSession(grandchild)).run.runId

    // The question tool is admitted while the grandchild is still `active`, and
    // the entry records the ask under the caller's own citation.
    const askCall = await callOf(h, 'task_ask_parent', grandchild)
    expect(askCall.result?.isError).toBe(false)
    const askedOutcome = await h.runtime.askParentQuestion(grandchild, { callId: askCall.callId, requestKey: 'k1', blocking: true })
    expect(askedOutcome.created).toBe(true)
    expect(askedOutcome.question.blocking).toBe(true)
    expect(askedOutcome.question.childRunId).toBe(grandchildRunId)
    expect(askedOutcome.question.parentRunId).toBe((await h.runForSession(middle)).run.runId)
    expect(askedOutcome.question.questionRef.sessionId).toBe(grandchild)
    expect(askedOutcome.delivery).toEqual({ messageId: askedOutcome.question.messageId, status: 'delivered' })
    expect(h.runtime.gate.questionsBlocked(grandchild)).toBe(true)
    // The parent really received it: its own session's durable inbox holds the
    // recorded identity, and the text carries the question id.
    const delivered = h.eventsOf(middle).filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => String(message.id) === askedOutcome.question.messageId))
    expect(delivered).toHaveLength(1)
    // Both other turns may proceed now: the middle to answer, the grandchild to
    // try the effects its own block closes.
    proceed.resolve()

    // The blocked run: the real waterfall refuses the write, the decomposition
    // and the submission, naming the question and the phase it did not change.
    for (const name of ['write', 'task_decompose', 'task_submit_result']) {
      const denied = await callOf(h, name, grandchild)
      expect(denied.result?.isError, name).toBe(true)
      expect(denied.result?.text, name).toContain('waiting on an unresolved blocking question')
      expect(denied.result?.text, name).toContain(`"${name}" is denied`)
      expect(denied.result?.text, name).toContain('phase is "active"')
      expect(denied.result?.text, name).not.toContain('produce effects are closed')
    }
    // No denied body ever ran, and nothing was left in flight to drain.
    expect(h.executed.filter(name => name.startsWith('write:') || name.startsWith('task_decompose:') || name.startsWith('task_submit_result:'))).toEqual([])
    expect(h.runtime.gate.inFlightWrites(grandchild)).toEqual([])
    // A read in the same state still answers, from the store.
    const read = await callOf(h, 'task_read', grandchild)
    expect(read.result?.isError).toBe(false)

    // The middle answers from `waiting_children`: the answer is admitted, and the
    // parent's own write is still refused by its phase — an answer never buys a
    // waiting parent the write gate back.
    const answerCall = await callOf(h, 'task_answer', middle)
    expect(answerCall.result?.isError).toBe(false)
    const answerOutcome = await h.runtime.answerParentQuestion(middle, {
      callId: answerCall.callId,
      questionId: questionIdOf({ childRunId: grandchildRunId, requestKey: 'k1' }),
      requestKey: 'a1',
      resolves: true,
    })
    expect(answerOutcome.created).toBe(true)
    expect(answerOutcome.delivery).toEqual({ messageId: answerOutcome.answer.messageId, status: 'delivered' })
    expect(h.runtime.gate.questionsBlocked(grandchild)).toBe(false)
    const middleWrite = await callOf(h, 'write', middle)
    expect(middleWrite.result?.isError).toBe(true)
    expect(middleWrite.result?.text).toContain('phase "waiting_children"')
    expect(h.executed.some(name => name.includes('middle-write.txt'))).toBe(false)

    // The released grandchild writes again — the block was the only thing that
    // refused it, and the phase is what it always was.
    expect(h.runtime.gate.decide(grandchild, 'write')).toEqual({ allow: true })
    released.resolve()
    const after = await callOf(h, 'write', grandchild, call => (call.args as { path?: string }).path === 'child-write-after.txt')
    await vi.waitFor(() => expect(after.result).toBeDefined())
    expect(after.result?.isError).toBe(false)
    expect(h.executed.some(name => name.includes('child-write-after.txt'))).toBe(true)
    // The store's own derivation agrees with the gate.
    const snapshot = await h.snapshot(root.storeId)
    expect(blockingQuestionsOf(snapshot, grandchildRunId)).toEqual([])
    expect(snapshot.questions?.all).toHaveLength(1)
  })

  it('releases exactly the question an answer resolves, so a second open question keeps the run blocked', async () => {
    const bothAsked = Promise.withResolvers<void>()
    const firstAnswered = Promise.withResolvers<void>()
    const secondAnswered = Promise.withResolvers<void>()
    let childRunId = ''
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      probes: ['write'],
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('middle work') } },
            { text: 'root: the batch is the runtime\'s now' },
          ]
        }
        if (index === 1) {
          // Out of order on purpose: the second question is answered first.
          return [
            { tool: 'task_decompose', args: { reason: 'split my own work', children: children('grandchild work') } },
            { waitFor: () => bothAsked.promise },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId: questionIdOf({ childRunId, requestKey: 'k2' }), requestKey: 'a2', answer: 'the second one holds', resolves: true }) },
            { waitFor: () => secondAnswered.promise },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId: questionIdOf({ childRunId, requestKey: 'k1' }), requestKey: 'a1', answer: 'the first one holds', resolves: true }) },
            { text: 'middle: both answered' },
          ]
        }
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'first question' } },
          { tool: 'task_ask_parent', args: { requestKey: 'k2', question: 'second question' } },
          { waitFor: () => secondAnswered.promise },
          { tool: 'write', args: { path: 'child-after-second.txt', content: 'no' } },
          { waitFor: () => firstAnswered.promise },
          { tool: 'write', args: { path: 'child-after-first.txt', content: 'yes' } },
          { text: 'grandchild: released' },
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
    await vi.waitFor(async () => expect((await h.runForSession(grandchild)).run.executionPhase).toBe('active'))
    childRunId = (await h.runForSession(grandchild)).run.runId

    // Two blocking questions under two keys: each is its own record, and each
    // keeps the run blocked on its own.
    const firstId = questionIdOf({ childRunId, requestKey: 'k1' })
    const secondId = questionIdOf({ childRunId, requestKey: 'k2' })
    for (const [key, id] of [['k1', firstId], ['k2', secondId]] as const) {
      const call = await callOf(h, 'task_ask_parent', grandchild, item => (item.args as { requestKey?: string }).requestKey === key)
      const outcome = await h.runtime.askParentQuestion(grandchild, { callId: call.callId, requestKey: key, blocking: true })
      expect(outcome.created).toBe(true)
      expect(outcome.question.questionId).toBe(id)
    }
    let snapshot = await h.snapshot(root.storeId)
    expect(blockingQuestionsOf(snapshot, childRunId)).toHaveLength(2)
    bothAsked.resolve()

    // The answer to the *second* question lands first: that question closes, the
    // other stays open, and the run is still blocked by it.
    const secondAnswer = await callOf(h, 'task_answer', middle, item => (item.args as { questionId?: string }).questionId === secondId)
    const second = await h.runtime.answerParentQuestion(middle, { callId: secondAnswer.callId, questionId: secondId, requestKey: 'a2', resolves: true })
    expect(second.created).toBe(true)
    expect(h.runtime.gate.questionsBlocked(grandchild)).toBe(true)
    snapshot = await h.snapshot(root.storeId)
    expect(blockingQuestionsOf(snapshot, childRunId).map(question => question.questionId)).toEqual([firstId])
    secondAnswered.resolve()
    const stillBlocked = await callOf(h, 'write', grandchild, item => (item.args as { path?: string }).path === 'child-after-second.txt')
    expect(stillBlocked.result?.isError).toBe(true)
    expect(stillBlocked.result?.text).toContain('waiting on an unresolved blocking question')
    expect(h.executed.some(name => name.includes('child-after-second.txt'))).toBe(false)

    // The answer to the first closes the last block: only now can the run write.
    const firstAnswer = await callOf(h, 'task_answer', middle, item => (item.args as { questionId?: string }).questionId === firstId)
    const first = await h.runtime.answerParentQuestion(middle, { callId: firstAnswer.callId, questionId: firstId, requestKey: 'a1', resolves: true })
    expect(first.created).toBe(true)
    expect(h.runtime.gate.questionsBlocked(grandchild)).toBe(false)
    snapshot = await h.snapshot(root.storeId)
    expect(blockingQuestionsOf(snapshot, childRunId)).toEqual([])
    firstAnswered.resolve()
    const released = await callOf(h, 'write', grandchild, item => (item.args as { path?: string }).path === 'child-after-first.txt')
    expect(released.result?.isError).toBe(false)
    expect(h.executed.some(name => name.includes('child-after-first.txt'))).toBe(true)
    // Both answers are on the record, one per question, in the order the store
    // applied them.
    expect(snapshot.questions?.byId[firstId]?.answers?.map(answer => answer.answerId)).toHaveLength(1)
    expect(snapshot.questions?.byId[secondId]?.answers?.map(answer => answer.answerId)).toHaveLength(1)
  })
})

describe('the orchestration entries (A4 §F.1)', () => {
  it('delivers under the recorded identity, answers a same-key retry from the record, and refuses a forged or tampered claim with no side effect', async () => {
    const again = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }]
        : [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          { waitFor: () => again.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          // A call the child is allowed to make and has no business making: it
          // answers a question that was never asked of it.
          { tool: 'task_answer', args: { questionId: 'q-none', requestKey: 'a1', answer: 'mine to answer', resolves: true } },
          { waitFor: () => finished.promise },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    await batchIdOf(h, ROOT)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const child = spawnOf(h, 0)
    await vi.waitFor(async () => expect((await h.runForSession(child)).run.status).toBe('running'))

    const firstCall = await callOf(h, 'task_ask_parent', child)
    const asked = await h.runtime.askParentQuestion(child, { callId: firstCall.callId, requestKey: 'k1', blocking: true })
    expect(asked.created).toBe(true)
    expect(asked.delivery).toEqual({ messageId: asked.question.messageId, status: 'delivered' })
    const messageId = asked.question.messageId
    const copies = (): number => h.eventsOf(ROOT).filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => String(message.id) === messageId)).length
    expect(copies()).toBe(1)
    const eventsBefore = taskEventsOf(h, root.storeId).length
    const askedBefore = taskEventsOf(h, root.storeId).filter(event => event.kind === 'QuestionAsked').length

    // A retry is a *new* tool call with the same key and the same words: the
    // store answers it from the record it holds, so the same identity is
    // delivered and nothing at all is written.
    again.resolve()
    const retryCall = await callOf(h, 'task_ask_parent', child, call => call.callId !== firstCall.callId)
    const retried = await h.runtime.askParentQuestion(child, { callId: retryCall.callId, requestKey: 'k1', blocking: true })
    expect(retried.created).toBe(false)
    expect(retried.question.messageId).toBe(messageId)
    expect(retried.delivery).toEqual({ messageId, status: 'already-present' })
    expect(copies()).toBe(1)
    expect(taskEventsOf(h, root.storeId).filter(event => event.kind === 'QuestionAsked')).toHaveLength(askedBefore)
    expect(taskEventsOf(h, root.storeId).length).toBe(eventsBefore)

    // A caller that cites a call that does not exist, another session's call, or
    // a claim its own message does not carry is refused by name — before the
    // store is touched and without a single delivery.
    const rootCall = (await callOf(h, 'task_decompose', ROOT)).callId
    const refusals: [string, () => Promise<unknown>, RegExp][] = [
      ['an unknown call id', () => h.runtime.askParentQuestion(child, { callId: 'call-that-never-was', requestKey: 'k9', blocking: true }), /holds no tool\/call "call-that-never-was"/],
      ["another session's call", () => h.runtime.askParentQuestion(child, { callId: rootCall, requestKey: 'k9', blocking: true }), /holds no tool\/call/],
      ['a tampered request key', () => h.runtime.askParentQuestion(child, { callId: retryCall.callId, requestKey: 'k-other', blocking: true }), /claims request key "k-other", but the cited call/],
      ['a tampered blocking declaration', () => h.runtime.askParentQuestion(child, { callId: retryCall.callId, requestKey: 'k1', blocking: false }), /claims blocking=false, but the cited call/],
      ['an ask cited as an answer', () => h.runtime.answerParentQuestion(child, { callId: retryCall.callId, questionId: asked.question.questionId, requestKey: 'a1', resolves: true }), /is "task_ask_parent", not "task_answer"/],
      ['a tampered answer question id', () => h.runtime.answerParentQuestion(child, {
        callId: (h.calls.find(call => call.name === 'task_answer' && call.sessionId === child) as ToolCallRecord).callId,
        questionId: 'q-other',
        requestKey: 'a1',
        resolves: true,
      }), /claims question "q-other", but the cited call/],
    ]
    for (const [what, attempt, pattern] of refusals) {
      await expect(attempt(), what).rejects.toThrow(pattern)
    }
    expect(taskEventsOf(h, root.storeId).length).toBe(eventsBefore)
    expect(copies()).toBe(1)

    // The store is still the arbiter of who may answer: the child's own claim
    // passes the source check and is refused by the reducer, because the
    // question was addressed to the root's run and not to the child's.
    const childAnswer = h.calls.find(call => call.name === 'task_answer' && call.sessionId === child) as ToolCallRecord
    await expect(h.runtime.answerParentQuestion(child, { callId: childAnswer.callId, questionId: 'q-none', requestKey: 'a1', resolves: true }))
      .rejects.toThrow(/unknown question "q-none"/)
    expect(taskEventsOf(h, root.storeId).length).toBe(eventsBefore)
    expect(copies()).toBe(1)
    finished.resolve()
  })

  it('delivers a non-blocking question without blocking anything', async () => {
    const finished = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }]
        : [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'a note, not a block', blocking: false } },
          { waitFor: () => finished.promise },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    await batchIdOf(h, ROOT)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const child = spawnOf(h, 0)
    await vi.waitFor(async () => expect((await h.runForSession(child)).run.status).toBe('running'))
    const call = await callOf(h, 'task_ask_parent', child)
    const asked = await h.runtime.askParentQuestion(child, { callId: call.callId, requestKey: 'k1', blocking: false })
    expect(asked.created).toBe(true)
    expect(asked.question.blocking).toBe(false)
    expect(asked.delivery.status).toBe('delivered')
    // It is a real question, on the record and in the parent's inbox…
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.questions?.all.map(question => question.questionId)).toEqual([asked.question.questionId])
    const copies = h.eventsOf(ROOT).filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => String(message.id) === asked.question.messageId))
    expect(copies).toHaveLength(1)
    // …and it blocks nothing: the asking run keeps its write gate.
    expect(h.runtime.gate.questionsBlocked(child)).toBe(false)
    expect(h.runtime.gate.decide(child, 'write')).toEqual({ allow: true })
    expect(h.runtime.gate.decide(child, 'task_submit_result')).toEqual({ allow: true })
    finished.resolve()
  })
})

describe('the budget still ends a blocked wait (A4 §F.1)', () => {
  it('cancels a run whose question is never answered when its wall time runs out, voiding the derivation and owing no delivery', async () => {
    const started = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      // The run's own wall time is this case's clock: the child asks, goes idle
      // waiting for an answer, and the deadline is what ends the wait.
      budget: { wallTimeMs: 250 },
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { waitFor: () => started.promise },
            { text: 'root: waiting for the child' },
          ]
        }
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          { waitFor: () => started.promise },
          { text: 'child: waiting for an answer that never comes' },
        ]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    await batchIdOf(h, ROOT)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const child = spawnOf(h, 0)
    await vi.waitFor(async () => expect((await h.runForSession(child)).run.status).toBe('running'))
    const childRunId = (await h.runForSession(child)).run.runId
    const call = await callOf(h, 'task_ask_parent', child)
    const asked = await h.runtime.askParentQuestion(child, { callId: call.callId, requestKey: 'k1', blocking: true })
    expect(asked.delivery.status).toBe('delivered')
    expect(h.runtime.gate.questionsBlocked(child)).toBe(true)

    // The wait is a wait, not a stay of execution: the deadline cancels the run
    // with the budget reason, and the gate closes as terminal.
    const run = await vi.waitFor(async () => {
      const current = (await h.runForSession(child)).run
      expect(current.status).toBe('failed')
      return current
    }, { timeout: 20_000 })
    const snapshot = await h.snapshot(root.storeId)
    const review = snapshot.reviews.find(item => item.runId === childRunId)
    expect(review?.outcome).toBe('failed')
    expect(review?.localizedCause).toContain('wallTimeMs')
    expect(run.executionPhase).toBe('active')
    // The question stays on the record as audit and stops blocking: a settled
    // run is released from the derivation without any cancellation event.
    expect(snapshot.questions?.all.map(question => question.questionId)).toEqual([asked.question.questionId])
    expect(blockingQuestionsOf(snapshot, childRunId)).toEqual([])
    expect(h.runtime.gate.questionsBlocked(child)).toBe(false)
    expect(h.runtime.gate.phaseOf(child)).toBe('terminal')
    // And nothing is owed any more: the reconciliation pass finds no delivery
    // for a question whose runs have settled.
    const reconciled = await h.runtime.reconcileStore(root.storeId)
    expect(reconciled.questionDeliveries).toEqual([])
  }, 30_000)
})

/**
 * Write one terminal champion task into the store the way a finished tree leaves
 * one: the record a replay descends from (W15's experiment lineage, not a Task
 * parent). Built through the store's own service so the replay's subject is the
 * historical shape and not a fixture invention.
 */
async function writeChampion(h: ScriptedLoop, storeId: string): Promise<string> {
  const taskId = 't-champion'
  const runId = 'r-champion'
  await h.task.createTaskIn(storeId, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'champion work',
    depth: 0,
    acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(storeId, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId,
    taskId,
    sessionId: 's-champion',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verified', 'tester')
  return taskId
}

describe('questions inside a replay (A4 §F.1)', () => {
  it("refuses a parentless replay task's ask by name, with no question and no delivery", async () => {
    const keep = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) return [{ waitFor: () => keep.promise }]
        // The replay's own session: it asks, and then waits — a lot like a worker
        // whose addressee does not exist.
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'who owns me?' } },
          { waitFor: () => keep.promise },
        ]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    // A finished task gives the replay its champion. The replay is a task of its
    // own with no Task parent — its `parentRunId` is experiment lineage (W15) —
    // which is the whole reason a question asked from it has no addressee.
    const champion = await writeChampion(h, root.storeId)
    h.runtime.replayTask(root.storeId, champion, { lineage: 'evolution-replay:p1' }, ROOT).catch(() => undefined)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const replaySession = spawnOf(h, 0)
    await vi.waitFor(async () => expect((await h.runForSession(replaySession)).run.status).toBe('running'))
    const call = await callOf(h, 'task_ask_parent', replaySession)
    const eventsBefore = taskEventsOf(h, root.storeId).length
    const inboxBefore = h.eventsOf(ROOT).filter(event => event.type === 'agent/inbox/spliced').length
    const replayInboxBefore = h.eventsOf(replaySession).filter(event => event.type === 'agent/inbox/spliced').length
    await expect(h.runtime.askParentQuestion(replaySession, { callId: call.callId, requestKey: 'k1', blocking: true }))
      .rejects.toThrow(/has no parent task; a root or parentless replay task cannot ask a parent/)
    // Nothing was written and nothing was sent: no question event, no inbox entry
    // anywhere in the tree, and the replay's own run keeps its gate.
    expect(taskEventsOf(h, root.storeId).length).toBe(eventsBefore)
    expect(taskEventsOf(h, root.storeId).filter(event => event.kind === 'QuestionAsked')).toEqual([])
    expect(h.eventsOf(ROOT).filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(inboxBefore)
    expect(h.eventsOf(replaySession).filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(replayInboxBefore)
    expect(h.runtime.gate.questionsBlocked(replaySession)).toBe(false)
    expect(h.runtime.gate.decide(replaySession, 'write')).toEqual({ allow: true })
    keep.resolve()
  }, 30_000)

  it('carries a question from a real child of a replay task to the replay session, under the same rules', async () => {
    const childAsked = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<void>()
    const keep = Promise.withResolvers<void>()
    let questionId = ''
    let childRunId = ''
    const h = await startScriptedLoop({
      // These cases drive the runtime entries themselves: the question tools stay
      // the fixture's stand-ins so the scripted call leaves nothing but the
      // `tool/call` citation the entry is handed (the shipped definitions are
      // ③c's, and its own spec runs them).
      questionTools: 'stand-in',
      script: (sessionId, index): readonly ScriptEntry[] => {
        // The replay's own child: it asks its direct parent, which is the replay
        // task — the case §F.1 allows inside an experiment.
        if (sessionId === REPLAY_CHILD) {
          return [
            { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract applies to me?' } },
            { waitFor: () => childAsked.promise },
            { tool: 'task_read', args: {} },
            { waitFor: () => answered.promise },
            { waitFor: () => keep.promise },
          ]
        }
        // The replay session (the root's first spawn): it answers its child.
        if (index === 1) {
          return [
            { waitFor: () => childAsked.promise },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId: questionIdOf({ childRunId, requestKey: 'k1' }), requestKey: 'a1', answer: 'the champion contract holds', resolves: true }) },
            { waitFor: () => keep.promise },
          ]
        }
        return [{ waitFor: () => keep.promise }]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId)
    h.runtime.replayTask(root.storeId, champion, { lineage: 'evolution-replay:p1' }, ROOT).catch(() => undefined)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const replaySession = spawnOf(h, 0)
    const replayRun = await vi.waitFor(async () => {
      const bound = await h.runForSession(replaySession)
      expect(bound.run.status).toBe('running')
      return bound.run
    })
    // The replay's own child: written through the store's admission, the shape a
    // decomposition leaves. This case keeps the pure Task relation as a
    // regression — the child's parent task is the replay's task, so the question
    // has a real addressee — and it is no longer the only way to reach one: the
    // case below has the replay's worker decompose for real through the shipped
    // tool, which is the production path.
    await h.task.createTaskIn(root.storeId, {
      taskId: 't-replay-child',
      definitionRef: { taskType: 'root', version: 1 },
      parentTaskId: replayRun.taskId,
      objective: 'replay child work',
      depth: 1,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(root.storeId, 't-replay-child', 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(root.storeId, {
      runId: 'r-replay-child',
      taskId: 't-replay-child',
      sessionId: REPLAY_CHILD,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      executionPhase: 'active',
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')
    childRunId = 'r-replay-child'
    // The child's Session has to be live for its model to make the call this case
    // cites; the fixture mints it the way a spawn does (the real loop's factory),
    // because the run above was written by the store rather than by a spawn.
    const made = await h.ctx.agents.create({
      sessionId: SessionId(REPLAY_CHILD),
      meta: { cwd: h.checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async () => {},
    })
    expect(String(made.agent.id)).toBe(REPLAY_CHILD)
    const child = await h.runtime.runForSession(REPLAY_CHILD)
    expect(child.run.runId).toBe(childRunId)
    expect(child.task.parentTaskId).toBe(replayRun.taskId)
    h.userSays('begin the replay child work', REPLAY_CHILD)

    const call = await callOf(h, 'task_ask_parent', REPLAY_CHILD)
    const asked = await h.runtime.askParentQuestion(REPLAY_CHILD, { callId: call.callId, requestKey: 'k1', blocking: true })
    questionId = asked.question.questionId
    expect(asked.created).toBe(true)
    expect(asked.question.parentRunId).toBe(replayRun.runId)
    expect(asked.delivery).toEqual({ messageId: asked.question.messageId, status: 'delivered' })
    // The replay session received it, and the block is live: the child's write is
    // refused while the question is open.
    const copies = h.eventsOf(replaySession).filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => String(message.id) === asked.question.messageId))
    expect(copies).toHaveLength(1)
    expect(h.runtime.gate.questionsBlocked(REPLAY_CHILD)).toBe(true)
    expect(blockingQuestionsOf(await h.snapshot(root.storeId), childRunId).map(question => question.questionId)).toEqual([questionId])
    childAsked.resolve()

    // The replay session answers (its own worker surface carries the tool), and
    // the answer releases exactly that child.
    const answerCall = await callOf(h, 'task_answer', replaySession)
    expect(answerCall.result?.isError).toBe(false)
    const answerOutcome = await h.runtime.answerParentQuestion(replaySession, { callId: answerCall.callId, questionId, requestKey: 'a1', resolves: true })
    expect(answerOutcome.created).toBe(true)
    expect(h.runtime.gate.questionsBlocked(REPLAY_CHILD)).toBe(false)
    answered.resolve()
    const after = await h.snapshot(root.storeId)
    // The answer released exactly that child, and the replay's own run is still
    // the experiment's: one run for its task, one question, no second run. (The
    // gate's *phase* for this session is the binding the runtime does when it
    // spawns or adopts a session; this child's Session was minted by the fixture,
    // so the case reads the block the entry pushed and the store's own derivation
    // rather than a write probe.)
    expect(blockingQuestionsOf(after, childRunId)).toEqual([])
    expect(after.questions?.byId[questionId]?.answers?.map(answer => answer.resolves)).toEqual([true])
    expect(after.runs.filter(run => run.taskId === replayRun.taskId)).toHaveLength(1)
    expect(after.questions?.all.map(question => question.questionId)).toEqual([questionId])
    keep.resolve()
  }, 30_000)

  it('carries a question from the child the replay really decomposed, through the shipped tools', async () => {
    const questionKnown = Promise.withResolvers<void>()
    const childReleased = Promise.withResolvers<void>()
    const keep = Promise.withResolvers<void>()
    let questionId = ''
    const h = await startScriptedLoop({
      // This one case runs the *shipped* question tools, and it is the only way to
      // cover what it covers: a spawning replay's worker really decomposes, which
      // is what makes the replay's own checkout a live question (A3 §3.4) — the
      // child's ask and the replay's answer are then model calls through the
      // deployment's own definitions, so the tool waterfall, the runtime entries,
      // the store and the durable inbox are all the production ones.
      questionTools: 'shipped',
      probes: ['write'],
      script: (_sessionId, index): readonly ScriptEntry[] => {
        if (index === 0) return [{ waitFor: () => keep.promise }]
        if (index === 1) {
          // The replay's own worker (the root's first spawn): it decomposes for
          // real, then answers the child that batch spawned.
          return [
            { tool: 'task_decompose', args: { reason: 'split the replayed work', children: children('replay child work') } },
            { text: 'replay: the batch is the runtime\'s now' },
            { waitFor: () => questionKnown.promise },
            { tool: 'task_read', args: {} },
            { tool: 'task_answer', args: (): Record<string, unknown> => ({ questionId, requestKey: 'a1', answer: 'the champion contract holds', resolves: true }) },
            { text: 'replay: answered my child' },
            { waitFor: () => keep.promise },
          ]
        }
        // The child the replay decomposed: it asks its direct parent — the replay
        // task — and the block its own ask opens is what refuses the write it
        // attempts in the same turn.
        return [
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract applies to me?' } },
          { tool: 'write', args: { path: 'child-write-blocked.txt', content: 'no' } },
          { text: 'child: waiting for an answer' },
          { waitFor: () => childReleased.promise },
          { tool: 'write', args: { path: 'child-write-after.txt', content: 'yes' } },
          { waitFor: () => keep.promise },
        ]
      },
    })
    const root = await h.begin(ROOT_CONTRACT)
    const champion = await writeChampion(h, root.storeId)
    h.runtime.replayTask(root.storeId, champion, { lineage: 'evolution-replay:p1' }, ROOT).catch(() => undefined)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
    const replaySession = spawnOf(h, 0)
    const replayRun = await vi.waitFor(async () => {
      const bound = await h.runForSession(replaySession)
      expect(bound.run.status).toBe('running')
      return bound.run
    })

    // The replay's worker decomposes through the shipped tool and the real
    // admission. The checkout the batch's own §3.4 check reads is the one the
    // replay run holds, and that hold names this task — which is the whole reason
    // the call gets past the check instead of being refused as another writer's.
    const decomposeCall = await callOf(h, 'task_decompose', replaySession)
    expect(decomposeCall.result?.isError).toBe(false)
    expect(decomposeCall.result?.text).toContain(`decomposed ${replayRun.taskId} into 1 children`)
    await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(2))
    const child = spawnOf(h, 1)
    const childBound = await h.runForSession(child)
    expect(childBound.task.parentTaskId).toBe(replayRun.taskId)
    const childRunId = childBound.run.runId
    questionId = questionIdOf({ childRunId, requestKey: 'k1' })

    // The child's own model call went through the shipped tool: the runtime read
    // the body back from that call's citation, addressed it to its direct parent
    // (the replay's run) and blocked the child at the delivery.
    const askCall = await callOf(h, 'task_ask_parent', child)
    expect(askCall.result?.isError).toBe(false)
    expect(askCall.result?.text).toContain(`question ${questionId} recorded for your direct parent (run ${replayRun.runId})`)
    expect(askCall.result?.text).toContain('This run is now blocked on that answer')
    const question = await questionOf(h, root.storeId, questionId)
    expect(question.childRunId).toBe(childRunId)
    expect(question.parentRunId).toBe(replayRun.runId)
    expect(question.blocking).toBe(true)
    expect(h.runtime.gate.questionsBlocked(child)).toBe(true)
    // The block is live in the real waterfall: the write the same turn attempts
    // next is refused, and its body never ran.
    const blockedWrite = await callOf(h, 'write', child, call => (call.args as { path?: string }).path === 'child-write-blocked.txt')
    expect(blockedWrite.result?.isError).toBe(true)
    expect(blockedWrite.result?.text).toContain('waiting on an unresolved blocking question')
    expect(h.executed.some(name => name.includes('child-write-blocked.txt'))).toBe(false)
    // …and the replay's own session really received it: its durable inbox holds the
    // recorded identity, and the loop claimed that identity into its history.
    expect(insertsOf(h, replaySession, question.messageId)).toBe(1)
    const asked = await claimedIn(h, replaySession, question.messageId)
    expect(asked.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: child })

    // The waiting replay — its own batch is what it is doing — sees the question
    // in its own request and answers with the shipped tool.
    questionKnown.resolve()
    const replayRequest = await requestCarrying(h, replaySession, questionId)
    expect(replayRequest.texts.join('\n')).toContain(`[task-question ${questionId}] which contract applies to me?`)
    expect(replayRequest.texts.join('\n')).toContain('## Questions waiting for your answer (1)')
    const answerCall = await callOf(h, 'task_answer', replaySession)
    expect(answerCall.result?.isError).toBe(false)
    expect(answerCall.result?.text).toContain('`resolves: true` releases exactly that question')
    const [answer] = (await h.snapshot(root.storeId)).questions?.byId[questionId]?.answers ?? []
    expect(answer?.parentRunId).toBe(replayRun.runId)
    expect(answer?.resolves).toBe(true)
    expect(answerCall.result?.text).toContain(`answer ${answer!.answerId} recorded for question ${questionId}`)
    // The answer reached exactly that child — its own inbox, its own history — and
    // released the block the ask opened.
    expect(insertsOf(h, child, answer!.messageId)).toBe(1)
    const answered = await claimedIn(h, child, answer!.messageId)
    expect(answered.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: replaySession })
    expect(h.runtime.gate.questionsBlocked(child)).toBe(false)
    expect(blockingQuestionsOf(await h.snapshot(root.storeId), childRunId)).toEqual([])
    // The released child's next step is admitted: the block was the only thing
    // that refused it.
    childReleased.resolve()
    const released = await callOf(h, 'write', child, call => (call.args as { path?: string }).path === 'child-write-after.txt')
    expect(released.result?.isError).toBe(false)
    expect(h.executed.some(name => name.includes('child-write-after.txt'))).toBe(true)
    // One question, one answer, one child, one run for the replay task: a real
    // decomposition inside a replay is an ordinary batch and nothing more — it did
    // not turn the replay into a second root or a second run of its task.
    const after = await h.snapshot(root.storeId)
    expect(after.questions?.all.map(item => item.questionId)).toEqual([questionId])
    expect(after.tasks.filter(task => task.parentTaskId === replayRun.taskId)).toHaveLength(1)
    expect(after.runs.filter(run => run.taskId === replayRun.taskId)).toHaveLength(1)
    keep.resolve()
  }, 30_000)
})

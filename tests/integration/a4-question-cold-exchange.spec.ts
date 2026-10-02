import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import { answerMessageText, questionMessageText } from '../../agent-runtime/src/index.ts'
import { questionIdOf } from '../../task/src/index.ts'
import type { RunId } from '../../task/src/index.ts'
import {
  workspace,
  type ScriptEntry,
  children,
  Boot,
  ROOT,
  STORE,
  askWhileParentBusy,
} from './a4-question-cold-recovery.fixture.ts'

describe('a question relayed through a waiting middle across the restart (A4-1, three levels)', () => {
  it('brings the middle and the grandchild back, and carries grandchild → middle → root and back', async () => {
    const dir = workspace()
    const grandchildDown = Promise.withResolvers<void>()
    const grandchildAsked = Promise.withResolvers<void>()
    const recovered = Promise.withResolvers<void>()
    const grandchildCanSubmit = Promise.withResolvers<void>()
    let middleSession = ''
    let grandchildSession = ''
    let middleRun: RunId = '' as RunId
    let grandchildRun: RunId = '' as RunId
    let relayQuestionId = ''
    let grandchildQuestionId = ''

    const middleScript: readonly ScriptEntry[] = [
      { tool: 'task_decompose', args: { reason: 'split my own work', children: children('grandchild work') } },
      { text: "middle: my batch is the runtime's now" },
      { waitFor: () => grandchildAsked.promise },
      {
        tool: 'task_ask_parent',
        args: { requestKey: 'k-mid', question: 'my grandchild asks which contract holds: may I decide it?' },
      },
      { text: 'middle: relayed to my parent' },
    ]
    const first = await Boot.open(dir, {
      script: (_sessionId, index) => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('middle work') } },
            { text: "root: the batch is the runtime's now" },
          ]
        }
        if (index === 1) return middleScript
        return [
          { waitFor: () => grandchildDown.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k-gc', question: 'which contract applies to me?' } },
          { waitFor: () => Promise.resolve() },
        ]
      },
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(2), { timeout: 20_000 })
    middleSession = first.spawns[0] as string
    grandchildSession = first.spawns[1] as string
    middleRun = (await first.runOf(middleSession)).runId
    grandchildRun = (await first.runOf(grandchildSession)).runId
    relayQuestionId = questionIdOf({ childRunId: middleRun, requestKey: 'k-mid' })
    grandchildQuestionId = questionIdOf({ childRunId: grandchildRun, requestKey: 'k-gc' })

    // The root is not live when the middle relays, and the grandchild's question
    // reaches the *middle* while it is: the relay's intent is durable and its
    // delivery is owed (the first crash point one level up).
    await first.agentRuntime.stopAgents([SessionId(ROOT)])
    grandchildDown.resolve()
    await vi.waitFor(
      () =>
        expect(first.calls.some(call => call.name === 'task_ask_parent' && call.sessionId === grandchildSession)).toBe(
          true,
        ),
      { timeout: 20_000 },
    )
    await vi.waitFor(async () => expect((await first.question(grandchildQuestionId))?.parentRunId).toBe(middleRun), {
      timeout: 20_000,
    })
    grandchildAsked.resolve()
    await vi.waitFor(async () => expect(await first.question(relayQuestionId)).toBeDefined(), { timeout: 20_000 })
    const relayed = await first.question(relayQuestionId)
    expect(relayed?.parentRunId).toBe((await first.runOf(ROOT)).runId)
    expect(first.copiesOf(ROOT, relayed!.messageId)).toBe(0)
    await first.crash()

    // The second process: both non-root parents are recovered — the grandchild as
    // a blocked asker, the middle as the waiting parent that owns the answer — and
    // the relay the first process could not deliver reaches the root.
    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        // A second boot spawns nothing: every worker here is a *resumed* session,
        // so the script is keyed by identity — the ids the first boot reported —
        // and an unexpected session is refused rather than answered wrongly.
        if (sessionId === ROOT) {
          return [
            { waitFor: () => recovered.promise },
            {
              tool: 'task_answer',
              args: () => ({
                questionId: relayQuestionId,
                requestKey: 'a-root',
                answer: 'my child decides under the frozen contract',
                resolves: true,
              }),
            },
            { text: 'root: answered my child' },
            // The root's own batch ends when the middle verifies, and the wake it
            // gets for it (K1 §2) is the turn that carries this submission.
            { tool: 'task_submit_result', args: { summary: 'root work delivered' } },
            { text: 'root: submitted' },
          ]
        }
        if (sessionId === middleSession) {
          return [
            {
              tool: 'task_answer',
              args: () => ({
                questionId: grandchildQuestionId,
                requestKey: 'a-mid',
                answer: 'the frozen contract holds, decided one level up',
                resolves: true,
              }),
            },
            { text: 'middle: answered my grandchild' },
            // Its own batch ends when the grandchild verifies: the parent is handed
            // back its execution and told, and *its* submission is what its criteria
            // judge — the runtime submits for nobody (K1 §2).
            { tool: 'task_submit_result', args: { summary: 'middle work delivered' } },
            { text: 'middle: submitted' },
          ]
        }
        if (sessionId === grandchildSession) {
          return [
            { waitFor: () => grandchildCanSubmit.promise },
            { tool: 'task_submit_result', args: { summary: 'grandchild work delivered' } },
            { text: 'grandchild: submitted' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    await second.adopt()
    expect(second.ctx.agents.get(SessionId(middleSession)), 'the waiting middle is live again').toBeDefined()
    expect(second.ctx.agents.get(SessionId(grandchildSession)), 'the blocked grandchild is live again').toBeDefined()
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(ROOT)
            .some(text =>
              text.includes(
                questionMessageText(relayQuestionId, 'my grandchild asks which contract holds: may I decide it?'),
              ),
            ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    recovered.resolve()

    // Level two: the root answers the middle, the middle's own block clears, and
    // its request carries the answer.
    const rootAnswer = await vi.waitFor(
      async () => {
        const answer = (await second.snapshot()).questions?.byId[relayQuestionId]?.answers?.[0]
        expect(answer, `an answer to ${relayQuestionId}`).toBeDefined()
        return answer!
      },
      { timeout: 20_000 },
    )
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(middleSession)
            .some(text =>
              text.includes(
                answerMessageText(rootAnswer.answerId, relayQuestionId, 'my child decides under the frozen contract'),
              ),
            ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(middleSession, rootAnswer.messageId)).toBe(1)

    // Level three: the middle answers its grandchild from a phase whose writes are
    // closed, and the grandchild's next request carries it — then the child submits,
    // both batches end, and each parent hands in its own result in the turn its
    // batch-end message wakes (K1 §2).
    const middleAnswer = await vi.waitFor(
      async () => {
        const answer = (await second.snapshot()).questions?.byId[grandchildQuestionId]?.answers?.[0]
        expect(answer, `an answer to ${grandchildQuestionId}`).toBeDefined()
        return answer!
      },
      { timeout: 20_000 },
    )
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(grandchildSession)
            .some(text =>
              text.includes(
                answerMessageText(
                  middleAnswer.answerId,
                  grandchildQuestionId,
                  'the frozen contract holds, decided one level up',
                ),
              ),
            ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, relayed!.messageId)).toBe(1)
    // The middle answered from a phase whose writes are closed and stayed there:
    // an answer releases a question, never the parent's write gate (A4 §F.1).
    expect(second.runtime.gate.phaseOf(middleSession)).toBe('waiting_children')
    grandchildCanSubmit.resolve()
    await vi.waitFor(() => expect(second.copiesOf(grandchildSession, middleAnswer.messageId)).toBe(1), {
      timeout: 20_000,
    })

    const settled = await vi.waitFor(
      async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.runs.find(run => run.runId === grandchildRun)?.status).toBe('verified')
        expect(snapshot.runs.find(run => run.runId === middleRun)?.status).toBe('verified')
        expect(snapshot.runs.find(run => run.sessionId === ROOT)?.status).toBe('verified')
        return snapshot
      },
      { timeout: 30_000 },
    )
    // Identity by identity: two questions, two answers, one inbox entry each, and
    // the middle stayed in `waiting_children` until its child could submit:
    // an answer releases a question, never the parent's write gate (A4 §F.1).
    expect(settled.questions?.all.map(question => question.questionId).sort()).toEqual(
      [relayQuestionId, grandchildQuestionId].sort(),
    )
    expect(second.runtime.gate.questionsBlocked(grandchildSession)).toBe(false)
    expect(second.runtime.gate.questionsBlocked(middleSession)).toBe(false)
    expect(settled.runs.filter(run => run.status === 'verified')).toHaveLength(3)
    await second.dispose()
  }, 90_000)
})

describe('cold recovery closes the loop (A4 §F.1)', () => {
  it('recovers the blocked child and its waiting parent, and the answer reaches the child’s own request', async () => {
    const dir = workspace()
    const parentDown = Promise.withResolvers<void>()
    const asked = Promise.withResolvers<void>()
    // The parent's first request after the restart is woken by the recovered
    // question inside the recovery barrier (A2 §E refuses business calls while a
    // store is recovering), so the script parks it: the case releases the answer
    // once the activation it awaited has completed, which is the order a real
    // deployment reaches the same state in.
    const recovered = Promise.withResolvers<void>()
    let questionId = ''
    let childSession = ''
    let childRun: RunId = '' as RunId

    const first = await Boot.open(dir, {
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: "root: the batch is the runtime's now" },
            ]
          : [
              { waitFor: () => parentDown.promise },
              { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
              { waitFor: () => asked.promise },
            ],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    childSession = first.spawns[0] as string
    childRun = (await first.runOf(childSession)).runId
    questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })

    // The parent is not live when the child asks: the intent is recorded and the
    // delivery is `unavailable` — the first crash point of the exchange, and the
    // state a worker's ask reaches whenever its parent is not running.
    await first.agentRuntime.stopAgents([SessionId(ROOT)])
    parentDown.resolve()
    await vi.waitFor(
      () =>
        expect(first.calls.some(call => call.name === 'task_ask_parent' && call.sessionId === childSession)).toBe(true),
      { timeout: 20_000 },
    )
    await vi.waitFor(() => expect(first.question(questionId)).resolves.toBeDefined(), { timeout: 20_000 })
    const recorded = await first.question(questionId)
    expect(recorded?.blocking).toBe(true)
    expect(recorded?.messageId).toBe(`m-${questionId}`)
    expect(first.copiesOf(ROOT, recorded!.messageId)).toBe(0)
    await first.crash()

    // The second process: the root session comes back through the runtime's own
    // root entry, the store is adopted, and the recovery pass brings the blocked
    // child's Session back under the same identity before anything is delivered.
    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: (sessionId, index) =>
        sessionId === ROOT || index === 0
          ? [
              { waitFor: () => recovered.promise },
              {
                tool: 'task_answer',
                args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }),
              },
              { text: "root: answered my child, my batch is the runtime's" },
            ]
          : [{ tool: 'task_submit_result', args: { summary: 'child work delivered' } }, { text: 'child: submitted' }],
    })
    await second.root()
    await second.adopt()
    // The recovery pass brought the blocked child's Session back under its own
    // identity before it delivered anything: same Session, same Run, live here.
    const resumedChild = second.ctx.agents.get(SessionId(childSession))
    expect(resumedChild, 'the recovered child Session is live under the same identity').toBeDefined()
    const recovery = await second.runtime.reconcileStore(STORE)
    // A second activation has nothing to resume: the run is this process's own
    // live work now, so the pass reads it as live rather than as recovery's — the
    // same rule that keeps a spawned worker out of a later pass.
    expect(recovery.questionResumes).toEqual([])
    const held = await second.snapshot()
    const childRunRecord = held.runs.find(run => run.runId === childRun)
    expect(childRunRecord?.status).toBe('running')
    expect(childRunRecord?.sessionId).toBe(childSession)
    expect(second.runtime.gate.questionsBlocked(childSession)).toBe(true)
    // The question the first process could not deliver reached the parent exactly
    // once, and the parent's own model request carries it.
    expect(second.copiesOf(ROOT, recorded!.messageId)).toBe(1)
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(ROOT)
            .some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, recorded!.messageId)).toBe(1)

    // The parent answers through the shipped tool; the answer reaches the asking
    // child's own request, and the child — the same Session and the same Run —
    // submits the work the block had held back. The answer is released only now:
    // the barrier this case awaited has completed, so the store is admissible.
    await vi.waitFor(() => expect(second.adapter.textsOf(ROOT).length).toBeGreaterThan(0), { timeout: 20_000 })
    recovered.resolve()
    await vi.waitFor(
      () =>
        expect(
          second.calls.some(
            call => call.name === 'task_answer' && call.sessionId === ROOT && call.result !== undefined,
          ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    const answerCall = second.calls.find(
      call => call.name === 'task_answer' && call.sessionId === ROOT && call.result !== undefined,
    )
    expect(answerCall?.result?.isError).toBe(false)
    expect(answerCall?.result?.text).toContain(`recorded for question ${questionId}`)
    const answered = await vi.waitFor(
      async () => {
        const snapshot = await second.snapshot()
        const answer = snapshot.questions?.byId[questionId]?.answers?.[0]
        expect(answer, `an answer to ${questionId}`).toBeDefined()
        return answer!
      },
      { timeout: 20_000 },
    )
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(childSession)
            .some(text => text.includes(answerMessageText(answered.answerId, questionId, 'the frozen contract holds'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    await vi.waitFor(() => expect(second.copiesOf(childSession, answered.messageId)).toBe(1), { timeout: 20_000 })
    expect(second.runtime.gate.questionsBlocked(childSession)).toBe(false)

    // The child's submission runs through the real chain: verification, the child's
    // terminal state, and the batch end that hands the parent back its own decision
    // — no manual cancellation anywhere in the case, and no submission made on the
    // parent's behalf (K1 §2).
    const settled = await vi.waitFor(
      async () => {
        const snapshot = await second.snapshot()
        const childReview = snapshot.reviews.find(review => review.runId === childRun)
        expect(snapshot.runs.find(run => run.runId === childRun)?.status, JSON.stringify(childReview ?? null)).toBe(
          'verified',
        )
        expect(snapshot.runs.find(run => run.sessionId === ROOT)?.executionPhase).toBe('active')
        return snapshot
      },
      { timeout: 30_000 },
    )
    expect(settled.runs).toHaveLength(2)
    expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
    // The child's verification is the batch's own settlement and carries its one
    // terminal review; the parent's acceptance has not run — it is the parent's own
    // submission that starts it.
    const rootRun = settled.runs.find(run => run.sessionId === ROOT)!
    expect(rootRun.status).toBe('running')
    expect(rootRun.batchId).toBeUndefined()
    expect(settled.reviews.filter(review => review.outcome === 'verified')).toHaveLength(1)
    expect(settled.reviews.some(review => review.runId === rootRun.runId)).toBe(false)
    // The tell follows the phase change (the run is handed back first, then the
    // message is delivered), so the copy is awaited rather than assumed.
    await vi.waitFor(() => expect(second.copiesOf(ROOT, `m-batchend-${rootRun.batches?.[0]?.batchId}`)).toBe(1), {
      timeout: 20_000,
    })
    // One domain effect per identity: one question, one answer, one inbox entry
    // on each side — and the same messageId the first process recorded.
    expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
    expect(second.copiesOf(ROOT, recorded!.messageId)).toBe(1)
    await vi.waitFor(() => expect(second.copiesOf(childSession, answered.messageId)).toBe(1), { timeout: 20_000 })
    await second.dispose()
  }, 60_000)
})

/**
 * The crash points of one exchange, each driven from a real `QuestionAsked`
 * through the shipped tool and each reopened over the same directory (A4-3).
 * What they share: the intent is always the store's own record, the identity is
 * always `m-<questionId>`, and the pass that runs after the restart is the
 * deployment's recovery entry — never a hand-built intent.
 *
 * Where a killed process's lost write buffer is the difference between two
 * states, the fixture removes those bytes from the artifact and says so at the
 * drop site ({@link Boot.loseLastSplice}); everything else is the deployment's own
 * writing.
 *
 * Which point lives where: **point 1** (the intent is recorded and never
 * delivered) is the opening of the closed-loop case above, where the parent is
 * not live when the child asks and the shipped tool reports `unavailable` with
 * zero copies in the target's artifact; **points 2–4** are the three flush
 * boundaries below, all on the addressee side — the case is a
 * `waiting_children` parent, the answer side is the last case, whose addressee
 * is the `active` child. The two phases are therefore both in the set, and the
 * replay half of A4-3 is its own case below.
 */
describe('the crash points of one exchange, reopened (A4-3)', () => {
  it('(2) redelivers an append that never reached the disk', async () => {
    const dir = workspace()
    const { boot, questionId, messageId, childSession } = await askWhileParentBusy(dir)
    // The delivery confirmed the pending splice and the parent has not read it.
    expect(boot.copiesOf(ROOT, messageId)).toBe(1)
    await boot.crash()
    // A process killed inside its durability barrier loses the bytes it reported:
    // the fixture removes exactly those bytes (the trailing splice) from the
    // artifact, and the target's log holds nothing of this identity.
    boot.loseLastSplice(ROOT)
    expect(boot.copiesOf(ROOT, messageId)).toBe(0)

    const second = await Boot.open(dir, {
      graph: boot.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: read the recovered question' }]
        if (sessionId === childSession) return [{ text: 'child: still waiting' }]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    // The recovery barrier's own pass is what delivers it: the identity the first
    // process reported but did not leave behind is owed, and the pass makes it.
    await second.adopt()
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    // …and a second activation has nothing left to deliver: the same identity is
    // present, so no copy is added.
    const reports = await second.runtime.reconcileStore(STORE)
    expect(
      reports.questionDeliveries.filter(delivery => delivery.messageId === messageId).map(delivery => delivery.status),
    ).toEqual(['already-present'])
    // One domain effect: one durable copy, and the parent's own request carries
    // the words the first process could not leave behind.
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(ROOT)
            .some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    await second.dispose()
  }, 60_000)

  it('(3) does not insert a second copy of an append that is durable and unclaimed, and wakes the Session that holds it', async () => {
    const dir = workspace()
    const { boot, questionId, messageId, childSession } = await askWhileParentBusy(dir)
    expect(boot.copiesOf(ROOT, messageId)).toBe(1)
    await boot.crash()

    const second = await Boot.open(dir, {
      graph: boot.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: read the question from my restored inbox' }]
        if (sessionId === childSession) return [{ text: 'child: still waiting' }]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    await second.adopt()
    const reports = await second.runtime.reconcileStore(STORE)
    expect(reports.questionDeliveries.filter(delivery => delivery.messageId === messageId)).toEqual([
      { subject: `question "${questionId}"`, messageId, status: 'already-present' },
    ])
    // The message survived the restart exactly once — a retry that steered a
    // second copy would show up here as two.
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    // Nothing would have woken the restored Session (a retry of an
    // already-present identity sends no steer), so the runtime's own notice does
    // — and the model's first request carries both the question and that notice.
    const wake = await vi.waitFor(
      () => {
        const notice = second
          .messagesOf(ROOT)
          .find(message =>
            message.content.some(
              block => block.type === 'text' && block.text.includes('coordination input it has not read'),
            ),
          )
        expect(notice, 'the runtime wakes the Session that holds an unread delivery').toBeDefined()
        return notice!
      },
      { timeout: 20_000 },
    )
    // The wake is the deployment's own voice, never a person's, and it carries no
    // question body: the words stay in the recorded relay.
    expect(wake.source.kind).toBe('task-runtime')
    const noticeText = wake.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(noticeText).not.toContain('which contract holds?')
    expect(noticeText).toContain(messageId)
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(ROOT)
            .some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    await second.dispose()
  }, 60_000)

  it('(4) redelivers when the claim left the inbox and the history never took it', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const first = await Boot.open(dir, {
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: 'root: waiting' },
            ]
          : [
              { waitFor: () => childGo.promise },
              { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
              { hang: true },
            ],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    const messageId = `m-${questionId}`

    // The production driver's claim: pending input leaves the inbox before the
    // request is assembled, and `user/message` is written only after assembly.
    // The parked request is the process dying inside that window.
    const parked = first.parkAfterClaim(ROOT)
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await parked.claimed
    expect(first.copiesOf(ROOT, messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: read the redelivered question' }]
        if (sessionId === childSession) return [{ text: 'child: still waiting' }]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    // The barrier's pass redelivers what the claim never left behind, and a
    // second activation finds it present.
    await second.adopt()
    const reports = await second.runtime.reconcileStore(STORE)
    expect(
      reports.questionDeliveries.filter(delivery => delivery.messageId === messageId).map(delivery => delivery.status),
    ).toEqual(['already-present'])
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(ROOT)
            .some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    // The redelivered identity is the one that lands, once: the claim the dead
    // process made is not a copy, and the history holds exactly one entry.
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    expect(second.messagesOf(ROOT).filter(message => message.id === messageId)).toHaveLength(1)
    await second.dispose()
  }, 60_000)

  it('carries an answer across the restart to the child that was offline when it was written', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const answerGo = Promise.withResolvers<void>()
    // The recovered child is woken by the answer *inside* the barrier (A2 §E
    // refuses business calls while a store is recovering), so its turn parks and
    // the case releases it once the activation it awaited is complete — the same
    // order a deployment reaches, where the model reads the refusal and retries.
    const recovered = Promise.withResolvers<void>()
    let childSession = ''
    let childRun: RunId = '' as RunId
    let questionId = ''

    const first = await Boot.open(dir, {
      script: (sessionId, index) => {
        if (index === 0 || sessionId === ROOT) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { text: "root: the batch is the runtime's now" },
            { waitFor: () => answerGo.promise },
            {
              tool: 'task_answer',
              args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }),
            },
            { text: 'root: answered' },
          ]
        }
        return [
          { waitFor: () => childGo.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          { hang: true },
        ]
      },
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    childSession = first.spawns[0] as string
    childRun = (await first.runOf(childSession)).runId
    questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })

    // The child asks while its parent is live, and is stopped before the parent
    // answers: the answer's intent is durable and its delivery is owed to a
    // Session nobody holds — the answer side of the first crash point.
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await first.agentRuntime.stopAgents([SessionId(childSession)])
    answerGo.resolve()
    const written = await vi.waitFor(
      async () => {
        const answer = (await first.question(questionId))?.answers?.[0]
        expect(answer, `an answer to ${questionId}`).toBeDefined()
        return answer!
      },
      { timeout: 20_000 },
    )
    expect(first.copiesOf(childSession, written.messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: my child is answered' }]
        if (sessionId === childSession)
          return [
            { waitFor: () => recovered.promise },
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted' },
          ]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    await second.adopt()
    expect(second.copiesOf(childSession, written.messageId)).toBe(1)
    const reports = await second.runtime.reconcileStore(STORE)
    expect(
      reports.questionDeliveries
        .filter(delivery => delivery.messageId === written.messageId)
        .map(delivery => delivery.status),
    ).toEqual(['already-present'])
    // The child is the same Session and the same Run, and its next request is the
    // proof it was given the answer the first process could not deliver.
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(childSession)
            .some(text => text.includes(answerMessageText(written.answerId, questionId, 'the frozen contract holds'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(childSession, written.messageId)).toBe(1)
    expect(second.runtime.gate.questionsBlocked(childSession)).toBe(false)
    recovered.resolve()
    const settled = await vi.waitFor(
      async () => {
        const snapshot = await second.snapshot()
        const childReview = snapshot.reviews.find(review => review.runId === childRun)
        const status = snapshot.runs.find(run => run.runId === childRun)?.status
        expect(
          status,
          JSON.stringify({
            review: childReview ?? null,
            calls: second.calls
              .filter(c => c.sessionId === childSession)
              .map(c => ({ name: c.name, err: c.result?.isError, text: c.result?.text?.slice(0, 200) ?? 'in-flight' })),
            block: second.runtime.gate.questionsBlocked(childSession),
            phase: second.runtime.gate.phaseOf(childSession),
          }),
        ).toBe('verified')
        expect(snapshot.questions?.byId[questionId]?.answers).toHaveLength(1)
        return snapshot
      },
      { timeout: 30_000 },
    )
    expect(settled.runs.find(run => run.sessionId === childSession)?.runId).toBe(childRun)
    await second.dispose()
  }, 60_000)
})

/**
 * What a recovered wait refuses and what ends it (A4 §F.1 + G §5.25): a wait
 * whose Session cannot be brought back fails its activation by name and is left
 * exactly where the crash left it, and a wait that is recovered still runs under
 * the deadline it started with.
 */
describe('what a recovered wait refuses and what ends it (A4 §F.1)', () => {
  it('fails the activation by name when its Session cannot be brought back, and revives nothing', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const first = await Boot.open(dir, {
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: 'root: waiting' },
            ]
          : [
              { waitFor: () => childGo.promise },
              { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
              { hang: true },
            ],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await first.crash()
    // The store lost the session's bytes: its identity is on the record, the
    // Session that would have to come back is gone.
    first.removeSession(childSession)

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: () => [{ text: 'nothing to do' }],
    })
    await second.root()
    // G §5.25: a resume that cannot be established fails the activation by name
    // and mutates nothing — the wait is not settled by a substitute verdict.
    await expect(second.adopt()).rejects.toThrow(/session ".*" does not exist/)
    const held = await second.snapshot()
    // The refusal is named by its cause and revives nothing: the run stays where
    // the crash left it, no Session was created, and no answer exists.
    expect(held.runs.find(candidate => candidate.runId === childRun)?.status).toBe('running')
    expect(second.ctx.agents.get(SessionId(childSession))).toBeUndefined()
    expect(held.questions?.byId[questionId]?.answers ?? []).toEqual([])
    await second.dispose()
  }, 60_000)

  it('resumes the replay parent and carries its child’s question across the restart', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    // The replay is woken by the recovered question inside the barrier, so its
    // answer waits for the activation this case awaits (A2 §E refuses business
    // calls while a store is recovering).
    const recovered = Promise.withResolvers<void>()
    let replaySession = ''
    let childSession = ''
    let replayRun: RunId = '' as RunId
    let replayTaskId = ''
    let childRun: RunId = '' as RunId

    const first = await Boot.open(dir, {
      script: (_sessionId, index) => {
        if (index === 0) return [{ text: "root: the replay is the runtime's" }]
        if (index === 1) {
          // The replay's own worker: it decomposes for real, which is what makes
          // the replay session a waiting parent with a batch of its own.
          return [
            {
              tool: 'task_decompose',
              args: { reason: 'split the replayed work', children: children('replay child work') },
            },
            { text: "replay: the batch is the runtime's now" },
          ]
        }
        return [
          { waitFor: () => childGo.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract applies to me?' } },
          { hang: true },
        ]
      },
    })
    await first.begin()
    const champion = await first.writeChampion()
    const replaying = first.runtime.replayTask(STORE, champion, { lineage: 'evolution-replay:p1' }, ROOT)
    replaying.catch(() => undefined)
    await vi.waitFor(() => expect(first.spawns.length).toBeGreaterThanOrEqual(1), { timeout: 20_000 })
    replaySession = first.spawns[0] as string
    replayRun = (await first.runOf(replaySession)).runId
    replayTaskId = (await first.runOf(replaySession)).taskId
    // The replay's worker really decomposed: a child run exists under the replay
    // task, and it is the run the question will be asked from.
    await vi.waitFor(() => expect(first.spawns.length).toBeGreaterThanOrEqual(2), { timeout: 20_000 })
    childSession = first.spawns[1] as string
    childRun = (await first.runOf(childSession)).runId
    await vi.waitFor(async () => expect((await first.runOf(replaySession)).executionPhase).toBe('waiting_children'), {
      timeout: 20_000,
    })
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })

    // The replay worker is not live when its child asks (the parentless-replay
    // rule does not apply here: the *child's* parent is the replay task, and its
    // question is legal) — so the intent is recorded and the delivery is owed.
    await first.agentRuntime.stopAgents([SessionId(replaySession)])
    childGo.resolve()
    await vi.waitFor(
      () =>
        expect(
          first.calls.some(
            call => call.name === 'task_ask_parent' && call.sessionId === childSession && call.result !== undefined,
          ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    const recorded = await vi.waitFor(
      async () => {
        const question = await first.question(questionId)
        expect(question).toBeDefined()
        return question!
      },
      { timeout: 20_000 },
    )
    expect(recorded.parentRunId).toBe(replayRun)
    expect(first.copiesOf(replaySession, recorded.messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: nothing but the replayed tree' }]
        if (sessionId === replaySession)
          return [
            { waitFor: () => recovered.promise },
            {
              tool: 'task_answer',
              args: () => ({
                questionId,
                requestKey: 'a1',
                answer: 'the champion contract holds, decided by the replay',
                resolves: true,
              }),
            },
            { text: 'replay: answered my child' },
            // Its child's verification ends the replay's batch and hands the replay
            // run back its execution: the turn that wake opens is the one that hands
            // in the replay's own result (K1 §2).
            { tool: 'task_submit_result', args: { summary: 'replay work delivered' } },
            { text: 'replay: submitted' },
          ]
        if (sessionId === childSession)
          return [
            { tool: 'task_submit_result', args: { summary: 'replay child work delivered' } },
            { text: 'child: submitted' },
          ]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    await second.adopt()
    // The replay run is a waiting parent that participates in the question: its
    // Session comes back under its own identity, and so does the child's.
    expect(second.ctx.agents.get(SessionId(replaySession)), 'the replay parent is live again').toBeDefined()
    expect(second.ctx.agents.get(SessionId(childSession)), 'the asking child is live again').toBeDefined()
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(replaySession)
            .some(text => text.includes(questionMessageText(questionId, 'which contract applies to me?'))),
        ).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(replaySession, recorded.messageId)).toBe(1)
    recovered.resolve()

    const answered = await vi.waitFor(
      async () => {
        const answer = (await second.snapshot()).questions?.byId[questionId]?.answers?.[0]
        expect(answer, `an answer to ${questionId}`).toBeDefined()
        return answer!
      },
      { timeout: 20_000 },
    )
    await vi.waitFor(
      () =>
        expect(
          second.adapter
            .textsOf(childSession)
            .some(text =>
              text.includes(
                answerMessageText(answered.answerId, questionId, 'the champion contract holds, decided by the replay'),
              ),
            ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    await vi.waitFor(() => expect(second.copiesOf(childSession, answered.messageId)).toBe(1), { timeout: 20_000 })
    // The replayed tree settles by the ordinary rules: the child's submission,
    // the replay's batch ending and handing the replay run its own decision, and
    // the replay's own submission, which its verifier judges. The durable
    // experiment identity this case can read back is the replayed task's own
    // contract — its objective carries the lineage tag — while the review
    // record's anomaly is written by whichever process owns the settlement
    // (the in-memory lineage map does not survive the restart, and the replay
    // experiment's own record is A6/S2-R's subject, not this ticket's).
    const settled = await vi.waitFor(
      async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
        expect(snapshot.runs.find(run => run.runId === replayRun)?.status).toBe('verified')
        expect(snapshot.reviews.find(review => review.runId === replayRun)?.outcome).toBe('verified')
        return snapshot
      },
      { timeout: 30_000 },
    )
    // The question's own Task relation is what made the exchange legal: the
    // replay's child asks the *replay task*, which is its direct parent (a
    // parentless replay's own ask would have been refused by name).
    const replayChild = await second
      .snapshot()
      .then(snapshot =>
        snapshot.tasks.find(task => task.taskId === (settled.runs.find(run => run.runId === childRun)?.taskId ?? '')),
      )
    expect(replayChild?.parentTaskId).toBe(replayTaskId)
    expect(settled.tasks.find(task => task.taskId === replayTaskId)?.objective).toContain('[evolution-replay:p1]')
    expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
    expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
    await second.dispose()
  }, 90_000)
})

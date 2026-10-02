import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import { answerMessageText, questionMessageText } from '../../agent-runtime/src/index.ts'
import { questionIdOf, TaskService } from '../../task/src/index.ts'
import type { RunId } from '../../task/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import {
  Boot,
  STORE,
  type DispatchedCall,
  children,
  ROOT,
  workspace,
  askWhileParentBusy,
  ROOT_CONTRACT,
} from './a4-question-cold-recovery.fixture.ts'

/**
 * The wake order a recovered store owes (A2 §E + A4 §F.1). Every case here
 * scripts the woken Session's **first** request as the business call its wake is
 * about — no `waitFor` in the model's script, nothing waits for the barrier on
 * the Session's behalf — so the exchange either completes from that wake or
 * fails where the recovery door refuses it.
 *
 * The interleaving is not left to a race. Each case holds the barrier's own
 * store read (the one the completion takes after its pass returned), so the
 * window between "the pass ran" and "the store is ready" is provably open while
 * the case looks at what reached the model: the read runs for real and carries
 * its own value, only its return is held — the lever `cancellation-gate.spec.ts`
 * already uses on this barrier. A delivery made inside that window wakes a model
 * whose first call the door refuses with nothing to wake it again; a delivery
 * held until the ready handle does the waking is answered by that first call.
 */
describe('a recovery wake waits for the ready handle (A4 §F.1)', () => {
  /**
   * Hold the barrier's first store read after its pass returned — the read the
   * completion takes at the barrier's own tail — so a case can look at what the
   * pass woke while the store is provably not ready yet.
   */
  function holdBarrierAfterPass(boot: Boot): { entered: Promise<void>; release: () => void } {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let armed = false
    const reconcile = boot.runtime.reconcileStore.bind(boot.runtime)
    const read = boot.task.snapshotIn.bind(boot.task)
    vi.spyOn(boot.runtime, 'reconcileStore').mockImplementation(
      async (...args: Parameters<TaskRuntime['reconcileStore']>) => {
        const report = await reconcile(...args)
        armed = true
        return report
      },
    )
    vi.spyOn(boot.task, 'snapshotIn').mockImplementation(async (...args: Parameters<TaskService['snapshotIn']>) => {
      const snapshot = await read(...args)
      if (armed && args[0] === STORE) {
        armed = false
        entered.resolve()
        await release.promise
      }
      return snapshot
    })
    return {
      entered: entered.promise,
      release: () => {
        release.resolve()
      },
    }
  }

  /**
   * Refuse every store read the completion takes after its pass returned — the
   * door a half-recovered store must fail at, and the reads its own bookkeeping
   * swallows included, so the completion's own read cannot escape the fault.
   */
  function failBarrierAfterPass(boot: Boot, message: string): void {
    let armed = false
    const reconcile = boot.runtime.reconcileStore.bind(boot.runtime)
    const read = boot.task.snapshotIn.bind(boot.task)
    vi.spyOn(boot.runtime, 'reconcileStore').mockImplementation(
      async (...args: Parameters<TaskRuntime['reconcileStore']>) => {
        const report = await reconcile(...args)
        armed = true
        return report
      },
    )
    vi.spyOn(boot.task, 'snapshotIn').mockImplementation(async (...args: Parameters<TaskService['snapshotIn']>) => {
      if (armed && args[0] === STORE) throw new Error(message)
      return await read(...args)
    })
  }

  /**
   * Whether one Session's next request is served within the window — a bounded
   * look at the adapter, never a waiter inside the model's script.
   */
  async function wokenWithin(boot: Boot, sessionId: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (boot.adapter.requestsOf(sessionId).length > 0) return true
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return false
  }

  /** The first dispatched call one Session made under one name, once its result is in. */
  async function firstCall(boot: Boot, sessionId: string, name: string): Promise<DispatchedCall> {
    return await vi.waitFor(
      () => {
        const call = boot.calls.find(
          candidate => candidate.name === name && candidate.sessionId === sessionId && candidate.result !== undefined,
        )
        expect(
          call,
          `${name} from "${sessionId}"; dispatched: ${JSON.stringify(boot.calls.map(candidate => ({ name: candidate.name, session: candidate.sessionId, error: candidate.result?.isError ?? null })))}`,
        ).toBeDefined()
        return call!
      },
      { timeout: 20_000 },
    )
  }

  /** One boot driven to the first crash point: the child asked while its parent was not live, so the intent is durable and its delivery owed. */
  async function askWhileParentGone(
    dir: string,
  ): Promise<{ boot: Boot; childSession: string; childRun: RunId; questionId: string; messageId: string }> {
    const childGo = Promise.withResolvers<void>()
    const boot = await Boot.open(dir, {
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: "root: the batch is the runtime's now" },
            ]
          : [
              { waitFor: () => childGo.promise },
              { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
              { hang: true },
            ],
    })
    await boot.begin()
    await vi.waitFor(() => expect(boot.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = boot.spawns[0] as string
    const childRun = (await boot.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    await boot.agentRuntime.stopAgents([SessionId(ROOT)])
    childGo.resolve()
    await vi.waitFor(
      () =>
        expect(
          boot.calls.some(
            call => call.name === 'task_ask_parent' && call.sessionId === childSession && call.result !== undefined,
          ),
        ).toBe(true),
      { timeout: 20_000 },
    )
    await vi.waitFor(async () => expect(await boot.question(questionId)).toBeDefined(), { timeout: 20_000 })
    return { boot, childSession, childRun, questionId, messageId: `m-${questionId}` }
  }

  it('delivers the recovered question only once its store is ready, and the woken parent answers with its first call', async () => {
    const dir = workspace()
    const { boot: first, childSession, childRun, questionId, messageId } = await askWhileParentGone(dir)
    expect(first.copiesOf(ROOT, messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) {
          return [
            {
              tool: 'task_answer',
              args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }),
            },
            { text: 'root: answered my child' },
          ]
        }
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted, my batch may settle' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, ROOT, 1_500)
      hold.release()
      await adopting
      // The parent's first request is the one the delivery opened, and it answers
      // through the shipped tool: nothing is refused and the model retries nothing.
      const answerCall = await firstCall(second, ROOT, 'task_answer')
      expect(answerCall.result!.isError, answerCall.result!.text).toBe(false)
      expect(answerCall.result!.text).toContain(`recorded for question ${questionId}`)
      expect(woken, 'the recovery delivery woke the parent before its store was ready').toBe(false)
      // The wake carried the question itself, and it is durable exactly once.
      expect(
        second.adapter
          .requestsOf(ROOT)[0]
          ?.texts.some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
      ).toBe(true)
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
      // The answer reaches the asking child's own request; the child submits and
      // the batch settles under the identities the first process bound.
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
                text.includes(answerMessageText(answered.answerId, questionId, 'the frozen contract holds')),
              ),
          ).toBe(true),
        { timeout: 20_000 },
      )
      expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
      const settled = await vi.waitFor(
        async () => {
          const snapshot = await second.snapshot()
          expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
          // The child's verification ends the root's batch: the root is handed back
          // its own execution and told, not judged (K1 §2).
          expect(snapshot.runs.find(run => run.sessionId === ROOT)?.executionPhase).toBe('active')
          return snapshot
        },
        { timeout: 30_000 },
      )
      expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
      expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
      const rootRun = settled.runs.find(run => run.sessionId === ROOT)!
      expect(rootRun.status).toBe('running')
      expect(rootRun.batchId).toBeUndefined()
      expect(settled.reviews.some(review => review.runId === rootRun.runId)).toBe(false)
      await vi.waitFor(() => expect(second.copiesOf(ROOT, `m-batchend-${rootRun.batches?.[0]?.batchId}`)).toBe(1), {
        timeout: 20_000,
      })
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('wakes a durable unread delivery only once its store is ready, and the first call acts on it', async () => {
    const dir = workspace()
    const { boot: first, childSession, questionId, messageId } = await askWhileParentBusy(dir)
    const childRun = (await first.runOf(childSession)).runId
    expect(first.copiesOf(ROOT, messageId)).toBe(1)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) {
          return [
            {
              tool: 'task_answer',
              args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }),
            },
            { text: 'root: answered the question I was woken for' },
          ]
        }
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted, my batch may settle' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, ROOT, 1_500)
      hold.release()
      await adopting
      const answerCall = await firstCall(second, ROOT, 'task_answer')
      expect(answerCall.result!.isError, answerCall.result!.text).toBe(false)
      expect(answerCall.result!.text).toContain(`recorded for question ${questionId}`)
      expect(woken, 'the recovery notice woke the parent before its store was ready').toBe(false)
      // The retry of an already-present identity steered no second copy: the inbox
      // keeps the one the first process left, and the request that acts on it
      // carries both it and the runtime's own notice.
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
      expect(
        second.adapter
          .requestsOf(ROOT)[0]
          ?.texts.some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
      ).toBe(true)
      // The child's next request carries the answer the parent's first call wrote,
      // and the child submits the work the question held back.
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
                text.includes(answerMessageText(answered.answerId, questionId, 'the frozen contract holds')),
              ),
          ).toBe(true),
        { timeout: 20_000 },
      )
      expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
      const settled = await vi.waitFor(
        async () => {
          const snapshot = await second.snapshot()
          expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
          // The batch ending hands the root back its execution and tells it so; the
          // verdict is the root's own to ask for (K1 §2).
          expect(snapshot.runs.find(run => run.sessionId === ROOT)?.executionPhase).toBe('active')
          return snapshot
        },
        { timeout: 30_000 },
      )
      expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
      const rootRun = settled.runs.find(run => run.sessionId === ROOT)!
      expect(rootRun.status).toBe('running')
      expect(rootRun.batchId).toBeUndefined()
      expect(settled.reviews.some(review => review.runId === rootRun.runId)).toBe(false)
      await vi.waitFor(() => expect(second.copiesOf(ROOT, `m-batchend-${rootRun.batches?.[0]?.batchId}`)).toBe(1), {
        timeout: 20_000,
      })
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('carries a recovered answer to the child, whose first call submits the work the wait held back', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const answerGo = Promise.withResolvers<void>()
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
    let childSession = ''
    let childRun: RunId = '' as RunId
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    childSession = first.spawns[0] as string
    childRun = (await first.runOf(childSession)).runId
    questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    // The child asks while its parent is live, and is stopped before the answer is
    // written: the answer's delivery is owed to a Session nobody holds.
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
        if (sessionId === ROOT) return [{ text: 'root: my child has what it waited for' }]
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted, nothing left to wait for' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, childSession, 1_500)
      hold.release()
      await adopting
      const submitCall = await firstCall(second, childSession, 'task_submit_result')
      expect(submitCall.result!.isError, submitCall.result!.text).toBe(false)
      expect(woken, 'the recovered answer woke the child before its store was ready').toBe(false)
      expect(
        second.adapter
          .requestsOf(childSession)[0]
          ?.texts.some(text =>
            text.includes(answerMessageText(written.answerId, questionId, 'the frozen contract holds')),
          ),
      ).toBe(true)
      expect(second.copiesOf(childSession, written.messageId)).toBe(1)
      const settled = await vi.waitFor(
        async () => {
          const snapshot = await second.snapshot()
          expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
          expect(snapshot.runs.find(run => run.sessionId === ROOT)?.executionPhase).toBe('active')
          return snapshot
        },
        { timeout: 30_000 },
      )
      expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
      // The root's batch ended with its child, and the root has its own decision
      // back — told once, and not judged (K1 §2).
      const rootRun = settled.runs.find(run => run.sessionId === ROOT)!
      expect(rootRun.status).toBe('running')
      expect(rootRun.batchId).toBeUndefined()
      expect(settled.reviews.some(review => review.runId === rootRun.runId)).toBe(false)
      await vi.waitFor(() => expect(second.copiesOf(ROOT, `m-batchend-${rootRun.batches?.[0]?.batchId}`)).toBe(1), {
        timeout: 20_000,
      })
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('drops the wake when the barrier fails: no request, no write, and the next activation delivers', async () => {
    const dir = workspace()
    const { boot: first, childSession, questionId, messageId } = await askWhileParentGone(dir)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) {
          return [
            {
              tool: 'task_answer',
              args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }),
            },
            { text: 'root: answered my child' },
          ]
        }
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    failBarrierAfterPass(
      second,
      "the store could not be read to initialize its sessions' gates after recovery (injected)",
    )
    try {
      await expect(second.adopt()).rejects.toThrow('injected')
      // The failed barrier woke nothing and delivered nothing: the question is
      // still the record's own intent, with no turn started from it.
      expect(second.copiesOf(ROOT, messageId)).toBe(0)
      expect(second.adapter.requestsOf(ROOT)).toHaveLength(0)
      vi.restoreAllMocks()
      await expect(second.question(questionId)).resolves.toBeDefined()
      // The next explicit activation is the retry: it delivers, and the parent's
      // first request answers through the shipped tool.
      await second.adopt()
      const answerCall = await firstCall(second, ROOT, 'task_answer')
      expect(answerCall.result!.isError, answerCall.result!.text).toBe(false)
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it("drops the wake when the barrier is cancelled: no request, no write, and the question stays the record's", async () => {
    const dir = workspace()
    const { boot: first, childSession, questionId, messageId } = await askWhileParentGone(dir)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: nothing to answer here' }]
        if (sessionId === childSession) return [{ text: 'child: waiting, nothing to do' }]
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      await second.runtime.cancelGraph(STORE, 'the graph was removed')
      hold.release()
      await adopting.catch(() => undefined)
      // The cancelled barrier neither delivered the question nor wrote an answer,
      // and the question's own record is untouched for the next reader.
      expect(second.copiesOf(ROOT, messageId)).toBe(0)
      expect(
        second.adapter
          .requestsOf(ROOT)
          .flatMap(request => request.texts)
          .some(text => text.includes(questionMessageText(questionId, 'which contract holds?'))),
      ).toBe(false)
      const held = await second.snapshot()
      expect(held.questions?.byId[questionId]?.messageId).toBe(messageId)
      expect(held.questions?.byId[questionId]?.answers ?? []).toEqual([])
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('holds the activation notice for the ready handle too: the root the recovery activated decomposes on its first call', async () => {
    const dir = workspace()
    // The contract is intaken under a review policy, so it stays a proposal; the
    // decision is written through the store's own entry and the process dies
    // before any continuation ran.
    const first = await Boot.open(dir, {
      script: () => [{ text: 'root: nothing before the restart' }],
      generatedTaskReview: 'all',
    })
    await first.root()
    const submitted = await first.runtime.intakeRootContract(STORE, ROOT, ROOT_CONTRACT)
    if (submitted.status !== 'pending_review') throw new Error(`the contract was not left waiting: ${submitted.status}`)
    const stored = (await first.snapshot()).proposals?.byId[submitted.proposalId]
    if (stored === undefined || stored.kind !== 'root') throw new Error('the store lost the root contract proposal')
    await first.task.decideProposalIn(
      STORE,
      {
        proposalId: stored.proposalId,
        outcome: 'approved',
        proposalDigest: stored.proposalDigest,
        admissionContextDigest: stored.admissionContextDigest,
        reviewContextDigest: stored.reviewContextDigest,
        decidedBy: `approval:${ROOT}`,
        decidedAt: new Date().toISOString(),
      },
      `approval:${ROOT}`,
    )
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      generatedTaskReview: 'all',
      script: (_sessionId, index) =>
        index === 0
          ? [
              { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
              { text: "root: the batch is the runtime's" },
            ]
          : [{ text: 'child: nothing to deliver' }],
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, ROOT, 1_500)
      hold.release()
      // The adoption activated the root itself (no other entry ran here), and the
      // notice it owes the session is a wake: it waits for the same ready handle
      // the recovered deliveries do.
      await adopting
      const decompose = await firstCall(second, ROOT, 'task_decompose')
      expect(decompose.result!.isError, decompose.result!.text).toBe(false)
      expect(woken, 'the activation notice woke the root before its store was ready').toBe(false)
      const activated = await vi.waitFor(
        async () => {
          const snapshot = await second.snapshot()
          expect(snapshot.tasks).toHaveLength(1)
          expect(snapshot.runs).toHaveLength(1)
          return snapshot
        },
        { timeout: 20_000 },
      )
      expect(activated.tasks[0]?.objective).toBe(ROOT_CONTRACT.objective)
      expect(activated.runs[0]?.sessionId).toBe(ROOT)
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)
})

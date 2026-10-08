import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ROOT_PROPOSAL_TASK_ID, rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskEvent, TaskProposal, TaskSnapshot } from '../../task/src/index.ts'
import type { DecomposeAdmissionResult, DecomposeChildSpec, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptedLoop,
  type ScriptedReviewAsk,
  type ToolCallRecord,
} from '../support/scripted-loop.ts'

/**
 * T2 acceptance on the real loop: what a deployment's review policy does when
 * the model is a real agent loop with a script behind it, the review channel is
 * the deployment's own (`ProposalReviewService` mounted at the service
 * assembly), and the decision travels through the same approval seam a person's
 * answer does.
 *
 * What each group of cases exists for, and why a runtime-level test cannot show
 * it through this fixture:
 *
 * 1. The policy decides what a *caller* sees: under `off` the batch runs and the
 *   record says so; under `all` the tool answers with a proposal id and nothing
 *   else happens — no child task, no spawn, no `TaskDecomposed`, the parent still
 *   `decomposable`. That is asserted against the store, the store's own event
 *   log, and the spawn record, not against the tool's prose.
 * 2. A person is asked through the deployment's channel and the decision is what
 *   admits the batch: the ask is counted (a refusal path asserts *zero* asks),
 *   it carries the whole saved batch, and the answer is recorded under the
 *   channel's own decider identity. The runtime continues the batch by itself —
 *   no further model call — and the children run to `verified`.
 * 3. Nothing about the gate depends on the tool: a direct `decomposeAndRun` or
 *   `continueProposal` call under `all` is held exactly as the tool is, and a
 *   decision that names a different batch than the stored one is refused by the
 *   store's own reducer.
 * 4. The record is what an approval binds: a rejection, a withdrawn ask and an
 *   absent answerer all leave the batch un-admitted; a revision is new content
 *   with a new request key and a `supersedes` reference, and the refused record
 *   is kept as it was; a resolution that moved between the review and the
 *   approval marks the proposal `stale`, and a parent run that ended marks it
 *   `expired` — a late approval never dispatches.
 * 5. The proposal flow adds no management surface: a worker's own composition
 *   holds the coordination tools it needs and none that could decide a
 *   proposal, and a replayed task never enters a review at all.
 *
 * The model is scripted ({@link startScriptedLoop}), the review answerer is the
 * spec's, and everything else — the loop, the runtime, the store, the verifier,
 * the channel, the workspace gate — is the deployment's own code.
 *
 * A case that runs a batch to its end asserts the whole chain: the proposal's
 * record (status, decision, consumption, the events behind them), the batch
 * (its children ran, how many workers were spawned, what the store holds), each
 * child's own verdict, and the parent's composite acceptance — which the
 * **parent's own** submission starts (K1 §2: a batch end hands the run back
 * `active` and submits nothing on its behalf), so a case that reads a terminal
 * parent hands the root's result in through {@link handInRoot} first.
 */

const ROOT = 's-root' as SessionId

afterEach(async () => {
  await disposeScriptedLoops()
})

/** One child spec: a goal and a criterion a command settles. */
const children = (objective: string, extra: Partial<DecomposeChildSpec> = {}): DecomposeSpec['children'] => [{
  objective, requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
  ...extra,
}]

/** The `task_decompose` arguments one batch of one child is scripted with. */
const batch = (objective: string, extra: Partial<DecomposeChildSpec> = {}): Record<string, unknown> => ({
  reason: 'split the work',
  children: children(objective, extra),
})

/** The `task_decompose` then finish script a root runs when it does not wait for anything. */
const decomposeThenFinish = (objective: string, extra: Partial<DecomposeChildSpec> = {}): readonly { readonly tool: string; readonly args?: unknown }[] => [
  { tool: 'task_decompose', args: batch(objective, extra) },
  { text: 'root: the batch is the runtime\'s now' },
]

/** The one-child worker script: hand the work in and stop. */
const workerScript = (summary: string): readonly { readonly tool: string; readonly args?: unknown }[] => [
  { tool: 'task_submit_result', args: { summary } },
  { text: 'worker: handed in' },
]

/** Every task event one store appended, read back off the loop's own session log. */
function taskEvents(h: ScriptedLoop, storeId: string): TaskEvent[] {
  return h.eventsOf(storeId).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/**
 * The **batch** proposals one store holds. The root session's own intake wrote a
 * proposal too — the contract that became the root — and it is a different
 * subject with its own lifecycle: every assertion below is about a batch, so the
 * root's record is named away rather than counted as one.
 */
function batchProposals(snapshot: TaskSnapshot): TaskProposal[] {
  return (snapshot.proposals?.all ?? []).filter(proposal => proposal.kind !== 'root')
}

/** The proposal events one store recorded for a **batch**: the root contract's own records ride the reserved envelope task id. */
function batchProposalEvents(h: ScriptedLoop, storeId: string): TaskEvent[] {
  return taskEvents(h, storeId).filter(event =>
    event.kind.startsWith('TaskProposal') && event.taskId !== ROOT_PROPOSAL_TASK_ID)
}

/** The `ordinal`-th dispatch of one tool, once it reported a result. */
async function answered(h: ScriptedLoop, name: string, ordinal = 0, sessionId: string = ROOT): Promise<ToolCallRecord> {
  await vi.waitFor(() => {
    expect(h.calls.filter(call => call.name === name && call.sessionId === sessionId && call.result !== undefined).length).toBeGreaterThan(ordinal)
  })
  return h.calls.filter(call => call.name === name && call.sessionId === sessionId)[ordinal]!
}

/** The answer text of the `ordinal`-th dispatch of one tool. */
function resultTextOf(calls: readonly ToolCallRecord[], name: string, ordinal = 0): string {
  return calls.filter(call => call.name === name)[ordinal]!.result!.text
}

/** The proposal id a `task_decompose` answer names — the record the call is addressed by. */
function proposalIdOf(text: string): string {
  const match = /proposal (p-[0-9a-f]{64})/.exec(text)
  if (match === null) throw new Error(`the answer named no proposal id: ${text}`)
  return match[1]!
}

/** The `index`-th **batch** review ask the channel made, waited for. */
async function askAt(h: ScriptedLoop, index: number): Promise<ScriptedReviewAsk> {
  await vi.waitFor(() => expect(h.review.batchAsks.length).toBeGreaterThan(index))
  return h.review.batchAsks[index]!
}

/** One proposal as the store holds it. */
async function proposalOf(h: ScriptedLoop, storeId: string, proposalId: string): Promise<TaskProposal> {
  const snapshot = await h.snapshot(storeId)
  const proposal = snapshot.proposals?.byId[proposalId]
  if (proposal === undefined) throw new Error(`store "${storeId}" holds no proposal "${proposalId}"`)
  return proposal
}

/** The proposal status the store holds, waited for. */
async function statusOf(h: ScriptedLoop, storeId: string, proposalId: string, expected: string): Promise<TaskProposal> {
  await vi.waitFor(async () => expect((await proposalOf(h, storeId, proposalId)).status).toBe(expected))
  return await proposalOf(h, storeId, proposalId)
}

/** The batch id the store recorded on the root run — the admission's own fact, waited for. A probe that races the handback reads the identity from the run's accumulation, where the batch end leaves it. */
async function rootBatchId(h: ScriptedLoop): Promise<string> {
  await vi.waitFor(async () => {
    const run = (await h.runForSession(ROOT)).run
    expect(run.batchId ?? run.batches?.at(-1)?.batchId).toBeDefined()
  }, { timeout: 20_000, interval: 25 })
  const run = (await h.runForSession(ROOT)).run
  return (run.batchId ?? run.batches!.at(-1)!.batchId)!
}

/** Let the channel finish settling one ask on its own side: for an outcome that writes nothing, nothing follows. */
async function settleChannel(): Promise<void> {
  await new Promise(resolve => { setImmediate(resolve) })
  await new Promise(resolve => { setImmediate(resolve) })
}

/**
 * Wait for the runtime to have spawned `count` workers. The window is generous on
 * purpose: a spawn is asynchronous by protocol — the admission commit, the
 * driver's drain of the parent session and the worker's own minting all happen
 * after the call that admitted the batch returns — and this suite runs many spec
 * files in parallel forks, where that chain has been measured at ~1.6 s. What a
 * case asserts is that the worker is there; the verdicts that follow are read
 * from the store, so the timeout is a bound on the wait, never evidence about the
 * protocol. When it does expire, the failure names what the store holds instead
 * of only reporting an empty spawn list.
 */
async function spawned(h: ScriptedLoop, count: number): Promise<void> {
  try {
    await vi.waitFor(() => expect(h.spawns).toHaveLength(count), { timeout: 20_000, interval: 25 })
  } catch (error) {
    const snapshot = await h.snapshot(rootTaskStoreId(String(ROOT)))
    const run = (await h.runForSession(ROOT)).run
    const causes = snapshot.reviews.map(item => item.localizedCause ?? item.outcome).join('; ')
    throw new Error(
      `no worker was spawned: the root run is ${run.status}/${run.executionPhase ?? 'no phase'} and its reviews say ${causes === '' ? 'nothing yet' : causes} (${String(error)})`,
    )
  }
}


/**
 * The root's own hand-in (K1 §2). A batch end gives the run back its execution
 * and submits nothing on its behalf, so the parent's acceptance is started by
 * the parent's own submission — the entry `task_submit_result` adapts — and this
 * is where a case whose subject is the review policy states that step. The
 * handback is asserted first: the run really is back at work with no verdict, or
 * the submission would be a call the protocol had not admitted yet.
 */
async function handInRoot(h: ScriptedLoop, root: { storeId: string; taskId: string; runId: string }): Promise<string> {
  const handedBack = await h.task.runIn(root.storeId, root.runId)
  expect(handedBack.executionPhase).toBe('active')
  expect(handedBack.submission).toBeUndefined()
  const settled = await h.runtime.submitResult(ROOT, { summary: 'the root hands in the result its batch produced' })
  return settled.status
}


/**
 * The root contract every case in this file runs under (A0 §1.2): one goal, one
 * criterion a command settles. The intake is the real one — a root exists only
 * because a contract passed it — so the contract is stated here explicitly rather
 * than defaulted: a root contract owes at least one mandatory criterion judged by
 * something other than the composite conjunction.
 */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

describe('the review policy on the real loop (T2 §5)', () => {
  it('runs the batch under policy off, asks nobody, and records that policy on the proposal', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => (index === 0 ? decomposeThenFinish('align the ball') : workerScript('aligned the ball')),
    })
    const root = await h.begin(ROOT_CONTRACT)
    const answer = await answered(h, 'task_decompose')
    expect(answer.result?.isError).toBe(false)
    expect(answer.result?.text).toContain('decomposed')

    await spawned(h, 1)
    const outcomes = await h.runtime.awaitBatch(root.storeId, await rootBatchId(h))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // Nobody was asked: under `off` the audit record is the policy itself, never
    // a missing approval — the root contract's own intake included, since the same
    // policy governs both subjects.
    expect(h.review.asks).toHaveLength(0)
    const proposal = batchProposals(await h.snapshot(root.storeId))[0]!
    expect(proposal.policy).toBe('off')
    expect(proposal.status).toBe('admitted')
    expect(proposal.decision).toBeUndefined()
    expect(proposal.consumption?.childTaskIds).toEqual(outcomes.map(outcome => outcome.taskId))

    const events = batchProposalEvents(h, root.storeId)
    expect(events.filter(event => event.kind === 'TaskProposalSubmitted')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskProposalDecided')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'TaskProposalPhaseChanged')).toHaveLength(0)
    // The child did the work and was verified, and the parent's own composite
    // acceptance — started by its own submission, not by the batch — passed with it.
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect(await handInRoot(h, root)).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
  })

  it('holds the batch under policy all: nothing exists until a recorded decision, and the answer then runs it', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => (index === 0 ? decomposeThenFinish('align the ball') : workerScript('aligned the ball')),
    })
    const root = await h.begin(ROOT_CONTRACT)
    const answer = await answered(h, 'task_decompose')
    expect(answer.result?.isError).toBe(false)
    expect(answer.result?.text).toContain('waiting for a review')
    expect(answer.result?.text).toContain('No child task exists, no worker was spawned, and this task is not decomposed')
    const proposalId = proposalIdOf(answer.result!.text)

    // The person is asked through the deployment's own channel, in the owner
    // session of the store, with the whole saved batch as the material.
    const ask = await askAt(h, 0)
    expect(ask.sessionId).toBe(String(ROOT))
    expect(ask.toolName).toBe('task_decompose')
    expect(ask.reason).toContain(`Batch review — proposal ${proposalId} [pending_review] (policy all, trigger: submitted)`)
    expect(ask.reason).toContain('- child 0: align the ball')
    expect(ask.reason).toContain('acceptance criteria:')
    expect(ask.reason).toContain('- proposal digest (sha256):')
    expect(ask.reason).toContain('- admission context digest (the limits above):')
    expect(ask.reason).toContain('- review context digest (the resolution above):')

    // Nothing was admitted: no child, no spawn, no decomposition, no admission —
    // and the parent is still the task that may decompose.
    const waiting = await proposalOf(h, root.storeId, proposalId)
    expect(waiting.status).toBe('pending_review')
    expect(waiting.policy).toBe('all')
    expect(waiting.decision).toBeUndefined()
    expect(waiting.consumption).toBeUndefined()
    expect(h.spawns).toHaveLength(0)
    const before = await h.snapshot(root.storeId)
    expect(before.tasks).toHaveLength(1)
    expect(before.runs).toHaveLength(1)
    expect(before.reviews).toHaveLength(0)
    expect(before.tasks[0]!.decompositionStatus).toBe('decomposable')
    expect(before.tasks[0]!.childTaskIds).toEqual([])
    // The root's own creation and activation are on the same log (the intake that
    // made the session's root), so each count names the batch it is about.
    const events = taskEvents(h, root.storeId)
    expect(events.filter(event => event.kind === 'TaskCreated')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskDecomposed')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'TaskProposalAdmitted' && event.taskId !== ROOT_PROPOSAL_TASK_ID)).toHaveLength(0)

    // The answer is what admits it, and the runtime then drives the batch by
    // itself: the model is not asked for anything further.
    h.review.answerBatch(0, 'allowed-once')
    await spawned(h, 1)
    const outcomes = await h.runtime.awaitBatch(root.storeId, await rootBatchId(h))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const admitted = await proposalOf(h, root.storeId, proposalId)
    expect(admitted.status).toBe('admitted')
    expect(admitted.decision?.outcome).toBe('approved')
    expect(admitted.decision?.decidedBy).toBe(`approval:${String(ROOT)}`)
    expect(admitted.decision?.proposalDigest).toBe(admitted.proposalDigest)
    expect(admitted.decision?.admissionContextDigest).toBe(admitted.admissionContextDigest)
    expect(admitted.decision?.reviewContextDigest).toBe(admitted.reviewContextDigest)
    const admissions = taskEvents(h, root.storeId).filter(event =>
      event.kind === 'TaskProposalAdmitted' && event.taskId !== ROOT_PROPOSAL_TASK_ID)
    expect(admissions).toHaveLength(1)
    expect(admissions[0]!.payload.childTaskIds).toEqual(admitted.consumption!.childTaskIds)
    const after = await h.snapshot(root.storeId)
    expect(new Set(after.tasks.map(task => task.taskId)))
      .toEqual(new Set([root.taskId, ...admitted.consumption!.childTaskIds]))
    // The approved batch is the batch that ran: its child verified, and the
    // parent's own acceptance — started by its own submission — settled on the
    // children's verdicts.
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect(await handInRoot(h, root)).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
  })

  it('refuses an illegal batch by name before any review is requested, and leaves no trace', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: () => [
        {
          tool: 'task_decompose',
          args: {
            reason: 'split the work',
            children: [{ objective: 'nothing is required', requiredCapabilities: ['execute-task'], acceptanceCriteria: [{ description: 'nothing is required here', command: 'true', mandatory: false }] }],
          },
        },
        { tool: 'task_decompose', args: { ...batch('a batch cannot carry a policy'), generatedTaskReview: 'off' } },
        { text: 'root: both were refused' },
      ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const first = await answered(h, 'task_decompose', 0)
    const second = await answered(h, 'task_decompose', 1)

    expect(first.result?.isError).toBe(false)
    expect(first.result?.text).toContain('task_decompose rejected')
    expect(first.result?.text).toContain('requires at least one mandatory acceptance criterion')
    expect(second.result?.text).toContain('task_decompose rejected')
    expect(second.result?.text).toContain('declares unknown field "generatedTaskReview"')

    // §5's 坏提案不弹审批: nothing was shown to a person — the only ask this
    // store's channel made is the setup root contract's own, which `begin` answered
    // — and the store holds no batch proposal, no child, no decomposition, no
    // admission.
    expect(h.review.batchAsks).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    const snapshot = await h.snapshot(root.storeId)
    expect(batchProposals(snapshot)).toHaveLength(0)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]!.childTaskIds).toEqual([])
    const events = batchProposalEvents(h, root.storeId)
    expect(events.filter(event => event.kind === 'TaskProposalSubmitted')).toHaveLength(0)
    expect(taskEvents(h, root.storeId).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(0)
    expect(taskEvents(h, root.storeId).filter(event => event.kind === 'TaskCreated')).toHaveLength(1)
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('admits nothing when the answer is %s', async outcome => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => (index === 0 ? decomposeThenFinish('align the ball') : workerScript('aligned the ball')),
    })
    const root = await h.begin(ROOT_CONTRACT)
    const spec: DecomposeSpec = { reason: 'split the work', children: children('align the ball') }
    const answer = await answered(h, 'task_decompose')
    const proposalId = proposalIdOf(answer.result!.text)
    await askAt(h, 0)

    h.review.answerBatch(0, outcome)
    if (outcome === 'rejected') {
      // A refusal is a fact on the record, under the channel's own decider and
      // with the reason it can honestly state.
      const refused = await statusOf(h, root.storeId, proposalId, 'rejected')
      expect(refused.decision?.outcome).toBe('rejected')
      expect(refused.decision?.decidedBy).toBe(`approval:${String(ROOT)}`)
      expect(refused.decision?.reason).toContain(`the owner refused this batch through the approval channel (session "${String(ROOT)}")`)
    } else {
      // A withdrawn ask and an absent answerer are states of the ask, never a
      // decision this channel may invent: the proposal keeps waiting, and the
      // same request is still answered from the record (which asks again,
      // because a caller asking again is evidence somebody is still waiting).
      await settleChannel()
      expect((await proposalOf(h, root.storeId, proposalId)).status).toBe('pending_review')
      const again = await h.runtime.submitDecompositionProposal(root.storeId, root.taskId, root.runId, ROOT, spec)
      expect(again.existing).toBe(true)
      expect(again.status).toBe('pending_review')
      expect((await proposalOf(h, root.storeId, proposalId)).decision).toBeUndefined()
      expect(h.review.batchAsks).toHaveLength(2)
    }

    // No batch, no child, no worker, no admission — whatever the answer was.
    expect(h.spawns).toHaveLength(0)
    expect(h.calls.filter(call => call.name === 'task_decompose' && call.sessionId === ROOT)).toHaveLength(1)
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect((await proposalOf(h, root.storeId, proposalId)).consumption).toBeUndefined()
    const events = batchProposalEvents(h, root.storeId)
    expect(taskEvents(h, root.storeId).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
  })

  it('lets a refused agent read the refusal off the record and run a revised batch', async () => {
    // The model-protocol fixture (T3): a scripted caller whose first batch is
    // refused by the review, who reads the refusal from the saved record and
    // revises it — new content, a new request key, `supersedes` naming the
    // refused one — and whose revision is approved and then runs to `verified`.
    // It proves the wiring and the state a live caller moves through; it says
    // nothing about whether a real model writes a good revision.
    const refused = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_decompose', args: batch('align the ball') },
          // The caller waits until the refusal is on the record before it reads.
          { waitFor: () => refused.promise },
          { tool: 'task_proposal_read', args: calls => ({ proposalId: proposalIdOf(resultTextOf(calls, 'task_decompose')) }) },
          {
            tool: 'task_decompose',
            args: calls => ({
              reason: 'the refusal asked for a batch a verifier can settle',
              requestKey: 'rk-revision-1',
              supersedes: proposalIdOf(resultTextOf(calls, 'task_decompose')),
              children: children('align the ball and prove it'),
            }),
          },
          { text: 'root: the revision is the runtime\'s now' },
        ]
        : workerScript('aligned the ball and proved it'),
    })
    const root = await h.begin(ROOT_CONTRACT)
    const firstAnswer = await answered(h, 'task_decompose', 0)
    const firstId = proposalIdOf(firstAnswer.result!.text)
    const ask = await askAt(h, 0)
    expect(ask.reason).toContain('- child 0: align the ball')

    h.review.answerBatch(0, 'rejected')
    await statusOf(h, root.storeId, firstId, 'rejected')
    refused.resolve()

    // The caller read the refusal off the record: the channel's reason, on the
    // stored proposal, through the tool the root's own composition holds.
    const read = await answered(h, 'task_proposal_read')
    expect(read.result?.isError).toBe(false)
    expect(read.result?.text).toContain(`proposal ${firstId} [rejected] policy all`)
    expect(read.result?.text).toContain('decision: rejected by approval:s-root')
    expect(read.result?.text).toContain('the owner refused this batch through the approval channel')

    const revisionAnswer = await answered(h, 'task_decompose', 1)
    expect(revisionAnswer.result?.isError).toBe(false)
    expect(revisionAnswer.result?.text).toContain('waiting for a review')
    const revisionId = proposalIdOf(revisionAnswer.result!.text)
    expect(revisionId).not.toBe(firstId)
    const revision = await proposalOf(h, root.storeId, revisionId)
    expect(revision.status).toBe('pending_review')
    expect(revision.supersedes).toBe(firstId)
    expect(revision.requestKey).toBe('rk-revision-1')
    // A revision is new content: a new batch digest, hence its own id.
    expect(revision.proposalDigest).not.toBe((await proposalOf(h, root.storeId, firstId)).proposalDigest)

    await askAt(h, 1)
    h.review.answerBatch(1, 'allowed-once')
    await spawned(h, 1)
    const outcomes = await h.runtime.awaitBatch(root.storeId, await rootBatchId(h))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // The revision ran and the refused record is exactly as it was: an approval
    // never travels, and a revision never rewrites the record it replaces.
    const after = await h.snapshot(root.storeId)
    expect(after.proposals!.byId[firstId]!.status).toBe('rejected')
    expect(after.proposals!.byId[firstId]!.consumption).toBeUndefined()
    expect(after.proposals!.byId[revisionId]!.status).toBe('admitted')
    expect(after.tasks.map(task => task.taskId)).toEqual([root.taskId, ...after.proposals!.byId[revisionId]!.consumption!.childTaskIds])
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect(await handInRoot(h, root)).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
    expect(h.review.batchAsks).toHaveLength(2)
  })

  it('holds a direct service call exactly as the tool, and admits it only from a recorded decision', async () => {
    const h = await startScriptedLoop({ generatedTaskReview: 'all', script: (_sessionId, index) => (index === 0 ? [] : workerScript('aligned the ball')) })
    const root = await h.begin(ROOT_CONTRACT)
    const spec: DecomposeSpec = { reason: 'split the work', children: children('align the ball') }

    // No tool call anywhere: the compatibility entry is the same gate.
    const direct = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, spec) as DecomposeAdmissionResult
    expect(direct.status).toBe('pending_review')
    const proposalId = direct.proposalId
    const ask = await askAt(h, 0)
    expect(ask.reason).toContain('- child 0: align the ball')
    expect(ask.reason).toContain(`proposal ${proposalId}`)

    // The continuation is not a way around it: it reports the wait and admits
    // nothing while the decision is outstanding.
    const waiting = await h.runtime.continueProposal(root.storeId, proposalId, ROOT)
    expect(waiting.status).toBe('pending_review')
    expect(h.spawns).toHaveLength(0)
    expect(h.calls.filter(call => call.name === 'task_decompose')).toHaveLength(0)

    h.review.answerBatch(0, 'allowed-once')
    await spawned(h, 1)
    const outcomes = await h.runtime.awaitBatch(root.storeId, await rootBatchId(h))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await proposalOf(h, root.storeId, proposalId)).status).toBe('admitted')
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect(await handInRoot(h, root)).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
  })

  it('refuses a decision that names a different batch, a different limit set or a different resolution', async () => {
    const h = await startScriptedLoop({ generatedTaskReview: 'all', script: () => decomposeThenFinish('align the ball') })
    const root = await h.begin(ROOT_CONTRACT)
    const answer = await answered(h, 'task_decompose')
    const proposalId = proposalIdOf(answer.result!.text)
    await askAt(h, 0)
    const stored = await proposalOf(h, root.storeId, proposalId)
    const decidedAt = new Date().toISOString()
    const claim = {
      proposalId,
      outcome: 'approved' as const,
      proposalDigest: stored.proposalDigest,
      admissionContextDigest: stored.admissionContextDigest,
      reviewContextDigest: stored.reviewContextDigest,
      decidedBy: `approval:${String(ROOT)}`,
      decidedAt,
    }

    // The store is the one that binds a decision to the record: a decision naming
    // another batch, another limit set or another resolution never lands.
    await expect(h.task.decideProposalIn(root.storeId, { ...claim, proposalDigest: 'sha256-tampered' }, claim.decidedBy))
      .rejects.toThrow(/decision digest "sha256-tampered" does not match the stored proposal digest/)
    await expect(h.task.decideProposalIn(root.storeId, { ...claim, admissionContextDigest: 'sha256-tampered' }, claim.decidedBy))
      .rejects.toThrow(/decision admission context digest "sha256-tampered" does not match the stored admission context digest/)
    await expect(h.task.decideProposalIn(root.storeId, { ...claim, reviewContextDigest: 'sha256-tampered' }, claim.decidedBy))
      .rejects.toThrow(/decision review context digest "sha256-tampered" does not match the stored review context digest/)
    await expect(h.task.decideProposalIn(root.storeId, { ...claim, reviewContextDigest: undefined } as never, claim.decidedBy))
      .rejects.toThrow(/approval requires the review context digest it was decided against/)

    // Nothing moved, and the decision built from the record is the one that works.
    const unchanged = await proposalOf(h, root.storeId, proposalId)
    expect(unchanged.status).toBe('pending_review')
    expect(unchanged.decision).toBeUndefined()
    expect(h.spawns).toHaveLength(0)
    expect(batchProposalEvents(h, root.storeId).filter(event => event.kind === 'TaskProposalDecided')).toHaveLength(0)

    const decided = await h.runtime.decideProposal(root.storeId, proposalId, { outcome: 'approved' }, claim.decidedBy)
    expect(decided.status).toBe('admitted')
    await spawned(h, 1)
  })

  it('records a late approval as expired when the parent run has ended, and dispatches nothing', async () => {
    const h = await startScriptedLoop({ generatedTaskReview: 'all', script: () => decomposeThenFinish('align the ball') })
    const root = await h.begin(ROOT_CONTRACT)
    const answer = await answered(h, 'task_decompose')
    const proposalId = proposalIdOf(answer.result!.text)
    await askAt(h, 0)

    // The run ends while the decision is still with the person: §6's late
    // approval may only invalidate the proposal.
    await h.task.markRunStatusIn(root.storeId, root.taskId, root.runId, 'cancelled', ROOT, { reason: 'the caller ended it' })
    h.review.answerBatch(0, 'allowed-once')

    const expired = await statusOf(h, root.storeId, proposalId, 'expired')
    expect(expired.decision?.outcome).toBe('expired')
    expect(expired.decision?.decidedBy).toBe(`approval:${String(ROOT)}`)
    expect(expired.decision?.reason).toContain('the approval arrived after the batch could be dispatched')
    expect(expired.decision?.reason).toContain('is cancelled')
    expect(expired.consumption).toBeUndefined()
    expect(h.spawns).toHaveLength(0)
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.tasks).toHaveLength(1)
    const decisions = batchProposalEvents(h, root.storeId).filter(event => event.kind === 'TaskProposalDecided')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.payload.outcome).toBe('expired')
    expect(batchProposalEvents(h, root.storeId).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
  })

  it('marks an approved batch stale when its capability resolution moved, and never transfers the approval', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      capabilities: { 'align-capability': { skills: ['task-execution'], tools: ['bash'] } },
      script: () => decomposeThenFinish('align the ball with the granted tools', { requiredCapabilities: ['align-capability'] }),
    })
    const root = await h.begin(ROOT_CONTRACT)
    const answer = await answered(h, 'task_decompose')
    const proposalId = proposalIdOf(answer.result!.text)
    const stored = await proposalOf(h, root.storeId, proposalId)
    await askAt(h, 0)

    // The row this batch resolved against changes while the person decides: the
    // resolution the review covered is not the one an admission would run under.
    // A library row moves by pointer transaction now — draft, stage, publish —
    // and the pointer switch is what the staleness check reads.
    const active = await h.runtime.libraryRead(String(ROOT))
    const draft = await h.runtime.createDraft(String(ROOT))
    await h.runtime.stageDraftEdit(String(ROOT), draft.draftId, {
      kind: 'capability',
      edit: {
        name: 'align-capability',
        entry: { skills: ['task-execution'], tools: ['filesystem'] },
        actor: String(ROOT),
      },
    })
    await h.runtime.publishRevision(String(ROOT), {
      direction: 'publish',
      source: { kind: 'draft', draftId: draft.draftId },
      expected: { revisionId: active.revisionId, generation: active.generation },
      actor: String(ROOT),
    })
    h.review.answerBatch(0, 'allowed-once')

    const stale = await statusOf(h, root.storeId, proposalId, 'stale')
    expect(stale.decision?.outcome).toBe('approved')
    expect(stale.decision?.reviewContextDigest).toBe(stored.reviewContextDigest)
    expect(stale.consumption).toBeUndefined()
    expect(h.spawns).toHaveLength(0)
    const phases = batchProposalEvents(h, root.storeId).filter(event => event.kind === 'TaskProposalPhaseChanged')
    expect(phases).toHaveLength(1)
    expect(phases[0]!.payload.to).toBe('stale')
    expect(phases[0]!.payload.reason).toContain('the capability resolution moved (manifest digest')
    expect(batchProposalEvents(h, root.storeId).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.tasks).toHaveLength(1)
  })

  it('gives a worker no tool that could decide a proposal, and the root the coordination tools it needs', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => (index === 0 ? decomposeThenFinish('align the ball') : workerScript('aligned the ball')),
    })
    const root = await h.begin(ROOT_CONTRACT)
    await spawned(h, 1)
    const gateOutcomes = await h.runtime.awaitBatch(root.storeId, await rootBatchId(h))
    expect(gateOutcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.task.taskIn(root.storeId, gateOutcomes[0]!.taskId)).status).toBe('verified')
    expect(await handInRoot(h, root)).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
    const worker = h.agent(h.spawns[0]!.sessionId)

    // A worker that proposed its own batch holds the coordination tools of that
    // batch — read the record, continue it, withdraw it — and nothing else.
    const names = h.visible(worker)
    for (const kept of [
      'task_read', 'task_status', 'task_decompose', 'task_submit_result', 'task_cancel', 'capability_list', 'task_template_list',
      'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel',
    ]) {
      expect(names, kept).toContain(kept)
    }
    // The platform plane stays the root's: no graph, HITL, review/diagnosis or
    // evolution tool reaches a worker, and no tool of that plane could decide a
    // proposal (the decision is the channel's, at the service assembly).
    for (const stripped of [
      'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve',
      'evolution_propose', 'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate',
      'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list',
      'escalate', 'task_review_pack', 'task_review_agent', 'task_diagnose',
    ]) {
      expect(names, stripped).not.toContain(stripped)
    }
    expect(names.filter(name => /propos[^_]*_(decide|approve|deny)/.test(name))).toEqual([])

    const rootNames = h.visible(h.agent(ROOT))
    for (const name of ['task_decompose', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel']) {
      expect(rootNames, name).toContain(name)
    }
  })

  it('denies a proposal continuation while the run is waiting on its batch, and answers the read side', async () => {
    // The gate's classification of the three proposal tools (T2/T3 with A3's
    // allow-list): reading a record and withdrawing one are coordination, but
    // continuing a proposal can admit a batch — the same effect as decomposing —
    // so a run that has stopped deciding its own work may not do it.
    let proposalId = ''
    const childInFlight = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_decompose', args: batch('align the ball') },
          { waitFor: () => childInFlight.promise },
          { tool: 'task_proposal_continue', args: () => ({ proposalId }) },
          { tool: 'task_proposal_read', args: () => ({ proposalId }) },
          { text: 'root: only the read side answered' },
        ]
        : [
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'aligned the ball' } },
          { text: 'worker: handed in' },
        ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    const answer = await answered(h, 'task_decompose')
    expect(answer.result?.isError).toBe(false)
    const batchId = await rootBatchId(h)
    await spawned(h, 1)
    proposalId = batchProposals(await h.snapshot(root.storeId))[0]!.proposalId
    childInFlight.resolve()

    const denied = await answered(h, 'task_proposal_continue')
    expect(denied.result?.isError).toBe(true)
    expect(denied.result?.text).toContain('phase "waiting_children"')
    expect(denied.result?.text).toContain('"task_proposal_continue" is denied')
    // A denied call never ran, so nothing is left in flight for the drain to wait for.
    expect(h.runtime.gate.inFlightWrites(ROOT)).toEqual([])

    // The read side answers in the same phase, from the stored record.
    const read = await answered(h, 'task_proposal_read')
    expect(read.result?.isError).toBe(false)
    expect(read.result?.text).toContain(`proposal ${proposalId} [admitted] policy off`)

    release.resolve()
    const outcomes = await h.runtime.awaitBatch(root.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect(await handInRoot(h, root)).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
  })

  it('keeps a worker whose own batch waits for a review idle without a submission reminder', async () => {
    // The known wait (§6/§7.4): a worker that proposed a batch and is waiting for
    // its review is idle by protocol and needs no submission reminder.
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => [
        { tool: 'task_decompose', args: batch(index === 0 ? 'the outer child' : 'a nested child') },
        { text: 'batch proposed' },
      ],
    })
    const root = await h.begin(ROOT_CONTRACT)
    // The root's own batch is approved by the person, so the child really runs.
    await askAt(h, 0)
    h.review.answerBatch(0, 'allowed-once')
    await spawned(h, 1)
    const child = h.spawns[0]!.sessionId
    // The child proposed its own batch: that proposal waits, and the child idles.
    const childProposal = await proposalIdOf((await answered(h, 'task_decompose', 0, child)).result!.text)
    const ask = await askAt(h, 1)
    expect(ask.reason).toContain('- child 0: a nested child')
    await vi.waitFor(async () => expect((await h.runForSession(child)).run.executionPhase).toBe('active'))

    // The cancellation is the deterministic release: the driver settles the
    // outer batch only here, so the waiting child's terminal state is on the record.
    const outcomes = await h.runtime.cancelBatch(root.storeId, await rootBatchId(h), ROOT)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const childRun = (await h.runForSession(child)).run
    expect(taskEvents(h, root.storeId).filter(event => event.kind === 'RunProgressMarked' && event.runId === childRun.runId)).toHaveLength(0)
    expect(h.requestsOf(child).some(request => request.texts.some(text => text.includes('went idle without submitting')))).toBe(false)
    expect((await h.task.runIn(root.storeId, childRun.runId)).status).toBe('cancelled')
    const review = (await h.snapshot(root.storeId)).reviews.find(item => item.runId === childRun.runId)
    expect(review?.localizedCause ?? '').not.toContain('no progress')
    // The cancellation ended the whole tree, and the waiting proposal is untouched
    // by the ending of the run around it.
    expect((await proposalOf(h, root.storeId, childProposal)).status).toBe('pending_review')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')
  })

  it('never routes a replay through the review, whatever the policy', async () => {
    const h = await startScriptedLoop({ generatedTaskReview: 'all', script: () => [] })
    const root = await h.begin(ROOT_CONTRACT)
    // A terminal champion to replay: written through the store's own service, so
    // the replay's subject is the historical record and not a fixture invention.
    const championTaskId = 't-champion'
    const championRunId = 'r-champion'
    await h.task.createTaskIn(root.storeId, {
      taskId: championTaskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'champion work',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, ROOT)
    await h.task.admitTaskIn(root.storeId, championTaskId, ROOT, { decompositionStatus: 'leaf' })
    await h.task.startRunIn(root.storeId, {
      runId: championRunId,
      taskId: championTaskId,
      sessionId: 's-champion',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, ROOT)
    await h.task.markRunStatusIn(root.storeId, championTaskId, championRunId, 'verifying', ROOT)
    await h.task.recordEvidenceIn(root.storeId, {
      evidenceId: `e-${championRunId}`,
      taskRunId: championRunId,
      taskId: championTaskId,
      artifacts: [],
      verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'command' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, ROOT)
    await h.task.markRunStatusIn(root.storeId, championTaskId, championRunId, 'verified', ROOT)

    const replay = await h.runtime.replayTask(root.storeId, championTaskId, { lineage: 'evolution-replay:p1', spawn: false }, ROOT)
    expect(replay.status).toBe('verified')
    // No review, no proposal: a replay is an evaluation entry, not a new batch —
    // and the only ask this store's channel ever made is the setup root contract's
    // own, which `begin` answered.
    expect(h.review.batchAsks).toHaveLength(0)
    expect(h.review.rootAsks).toHaveLength(1)
    expect(batchProposals(await h.snapshot(root.storeId))).toHaveLength(0)
    expect(batchProposalEvents(h, root.storeId)).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    expect(h.visible(h.agent(ROOT)).length).toBeGreaterThan(0)
  })
})

import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { TaskProposalRoot } from '../../../task/src/index.ts'
import { rootProposalDigest, rootProposalId, rootTaskStoreId } from '../../../task/src/index.ts'
import type { RootContractSpec } from '../../src/index.ts'
import { resolveRootBudget } from '../../src/index.ts'
import { seedLegacyRoot } from '../../../tests/support/legacy-root.ts'
import { pluginNotice } from '../support/person-request.ts'
import { pinSkillHome } from '../support/skill-roots.ts'
import {
  type Harness,
  harness,
  STORE,
  ROOT_SESSION,
  rootContract,
  proposalOf,
  taskEvents,
  batchSpec,
  childSpec,
  REVIEWER,
  approveInStore,
  storeTaskEvents,
} from './proposal-lifecycle.fixture.ts'

/** A second root session, so "the store this contract was sent to" has a wrong answer available (A0 §1.10). */
const BETA = 's-beta'

/** One session of this fixture's durable log, written where the persistence stub keeps it. */
function seedSession(h: Harness, sessionId: string, events: readonly SessionEvent[]): void {
  h.sessions.set(sessionId, {
    header: { id: sessionId, cwd: '.', agentPreset: 'standard' } as unknown as SessionHeader,
    events: [...events],
  })
}

/**
 * The root contract's own lifecycle (A0 §1–§2), through the same entries and the
 * same store as every batch above: the intake that submits *and* activates, the
 * review gate that holds a goal before it becomes a task, the re-check ladder a
 * root contract runs instead of a parent's state, the one-root rule, and the
 * recovery pass that finishes what a crash interrupted.
 *
 * The subject is deliberately *not* a batch: a root contract has no parent task
 * and no parent run, so every question the batch path asks of a parent is asked
 * here of the store's own root — and the two answers that matter are "no root
 * task exists yet" and "one already does".
 */
describe('TaskRuntime root contract intake (A0 §1–§2)', () => {
  test('off activates one root in a single call, records policy-off, and answers a retry from the record', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    // The store exists before the contract does (A0 §1.1): a graph opens it, the
    // intake fills it. What it holds at that point is what the "before" state is.
    await h.task.createStore(STORE)
    const before = await h.task.snapshotIn(STORE)
    expect(before.tasks).toHaveLength(0)
    expect(before.runs).toHaveLength(0)
    // The root budget's honest diagnostic before anything was accepted: there is
    // no root task, so there is no owner to measure a tree against.
    const unowned = resolveRootBudget(before, { maxRuns: 10 })
    expect(unowned.ok).toBe(false)
    if (unowned.ok) throw new Error('unreachable')
    expect(unowned.reason).toContain('holds no root task')

    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    expect(activated.status).toBe('activated')
    if (activated.status !== 'activated') throw new Error('unreachable')

    // The audit record: born `ready` under policy `off`, activated with no
    // decision on it — `policy-off` is a fact, not a missing approval — and the
    // consumption names the very task and run the activation minted.
    const proposal = await proposalOf(h, activated.proposalId)
    expect(proposal.kind).toBe('root')
    expect(proposal.policy).toBe('off')
    expect(proposal.status).toBe('admitted')
    expect(proposal.decision).toBeUndefined()
    if (proposal.kind !== 'root' || proposal.consumption?.kind !== 'root') throw new Error('unreachable')
    expect(proposal.consumption.rootTaskId).toBe(activated.taskId)
    expect(proposal.consumption.rootRunId).toBe(activated.runId)
    expect(proposal.identity.rootSessionId).toBe(ROOT_SESSION)
    expect(h.reviewCalls).toHaveLength(0)

    // One task, one run, one admission — and the root really decides its own work.
    const after = await h.task.snapshotIn(STORE)
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(after.tasks[0]?.parentTaskId).toBeUndefined()
    expect(after.tasks[0]?.depth).toBe(0)
    expect(after.tasks[0]?.contract?.objective).toBe('ship the release')
    expect(after.runs[0]?.sessionId).toBe(ROOT_SESSION)
    expect(after.runs[0]?.status).toBe('running')
    expect(after.runs[0]?.executionPhase).toBe('active')
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect((await h.runtime.runForSession(ROOT_SESSION)).run.runId).toBe(activated.runId)
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated')).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)

    // The budget now has its owner: the accepted instant is the root run's own
    // `startedAt`, which is what "the root run's `startedAt` is the acceptance
    // instant" means when a reader has only the store (A3 §3.5, A0 §1.7).
    const owned = resolveRootBudget(after, { maxRuns: 10 })
    expect(owned.ok).toBe(true)
    if (!owned.ok) throw new Error('unreachable')
    expect(owned.rootTaskId).toBe(activated.taskId)
    expect(owned.acceptedAt).toBe(after.runs[0]?.startedAt)

    // The same contract asked for again is the same request: one proposal, one
    // root, and the answer is the record.
    const again = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    expect(again.status).toBe('activated')
    if (again.status !== 'activated') throw new Error('unreachable')
    expect(again.proposalId).toBe(activated.proposalId)
    expect(again.taskId).toBe(activated.taskId)
    expect(again.runId).toBe(activated.runId)
    const repeated = await h.task.snapshotIn(STORE)
    expect(repeated.tasks).toHaveLength(1)
    expect(repeated.runs).toHaveLength(1)
    expect(repeated.proposals?.all).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated')).toHaveLength(1)

    // And the root is a live tree: a batch under it is admitted and accounted to
    // the same budget (the accounting the acceptance instant above is for).
    const batch = await h.runtime.decomposeAndRun(
      STORE,
      activated.taskId,
      activated.runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (batch.status !== 'admitted') throw new Error('unreachable')
    expect((await h.runtime.awaitBatch(STORE, batch.batchId)).map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('all holds the goal: no task, no run, no spawn, no wake-up until a recorded decision', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.task.createStore(STORE)
    const before = await h.task.snapshotIn(STORE)

    const pending = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    expect(pending.status).toBe('pending_review')
    if (pending.status !== 'pending_review') throw new Error('unreachable')

    const waiting = await proposalOf(h, pending.proposalId)
    expect(waiting.status).toBe('pending_review')
    expect(waiting.policy).toBe('all')
    expect(waiting.decision).toBeUndefined()
    expect(waiting.consumption).toBeUndefined()
    // Zero side effects beyond the proposal record: no task, no run, no
    // notification, and no worker — the goal is not a tree yet.
    const afterSubmit = await h.task.snapshotIn(STORE)
    expect(afterSubmit.tasks).toHaveLength(before.tasks.length)
    expect(afterSubmit.runs).toHaveLength(before.runs.length)
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated')).toHaveLength(0)
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(h.notifications).toHaveLength(0)

    // A person is shown the *contract*, not a digest: the review request carries
    // the goal and its criteria, and says which kind of subject it is.
    expect(h.reviewCalls).toEqual([
      {
        storeId: STORE,
        trigger: 'submitted',
        proposalId: pending.proposalId,
        status: 'pending_review',
        kind: 'root',
        hasBatch: false,
        parentObjective: 'ship the release',
        childObjectives: [],
        childCriteria: ['ship the release:root-goal:ship the release is delivered'],
        obligations: 0,
      },
    ])

    // A continuation while it waits writes nothing and activates nothing.
    const again = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(again.status).toBe('pending_review')
    expect((await proposalOf(h, pending.proposalId)).status).toBe('pending_review')

    // The decision is what creates the root, and the approval is continued in the
    // same call on the recorded facts.
    const decided = await h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.outcome).toBe('approved')
    expect(decided.continuation?.status).toBe('activated')
    if (decided.continuation?.status !== 'activated') throw new Error('unreachable')
    const activated = decided.continuation
    const live = await h.task.snapshotIn(STORE)
    expect(live.tasks).toHaveLength(1)
    expect(live.runs).toHaveLength(1)
    expect(live.tasks[0]?.taskId).toBe(activated.taskId)
    // The root session is told its goal is live (best-effort, through the existing
    // owner notice): the session that asked is the session that hears about it.
    expect(h.notifications.some(item => item.sessionId === ROOT_SESSION && item.text.includes('root contract'))).toBe(
      true,
    )

    // A decided proposal is not activated twice: the continuation answers from
    // its own consumption, and no second root appears.
    const repeated = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(repeated.status).toBe('activated')
    if (repeated.status !== 'activated') throw new Error('unreachable')
    expect(repeated.taskId).toBe(activated.taskId)
    expect(repeated.runId).toBe(activated.runId)
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
  })

  test('a replaced contract carries the policy it was born under: a rejection is terminal and a revision is a new proposal', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.task.createStore(STORE)
    const first = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    if (first.status !== 'pending_review') throw new Error('unreachable')

    const rejected = await h.runtime.decideProposal(
      STORE,
      first.proposalId,
      {
        outcome: 'rejected',
        reason: 'the goal is not the one the user asked for',
      },
      REVIEWER,
    )
    expect(rejected.outcome).toBe('rejected')
    expect(rejected.continuation).toBeUndefined()
    const refused = await proposalOf(h, first.proposalId)
    expect(refused.status).toBe('rejected')
    expect(refused.consumption).toBeUndefined()
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)

    // A revision is new content: a new key, a new proposal id, and it references
    // the record it replaces instead of editing it.
    const revised = await h.runtime.submitRootContractProposal(
      STORE,
      ROOT_SESSION,
      rootContract('ship the release on time'),
      {
        supersedes: first.proposalId,
      },
    )
    expect(revised.proposalId).not.toBe(first.proposalId)
    expect(revised.status).toBe('pending_review')
    const stored = await proposalOf(h, revised.proposalId)
    expect(stored.supersedes).toBe(first.proposalId)
    expect(stored.status).toBe('pending_review')
    // The old record is kept exactly as it was — a rejection is a fact, not an edit.
    expect((await proposalOf(h, first.proposalId)).status).toBe('rejected')

    const decided = await h.runtime.decideProposal(STORE, revised.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.continuation?.status).toBe('activated')
  })

  test('the re-check ladder refuses a moved admission context and a moved resolution, naming each, and activates nothing', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    await h.task.createStore(STORE)
    // Submission only: the proposal is recorded `ready` and nothing is created —
    // the state an intake is in between its two halves (and the state a crash
    // between them leaves behind).
    const submitted = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, rootContract('ship the release'))
    expect(submitted.status).toBe('ready')
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(0)

    // The limits in force move before the contract is continued: the approval
    // covered the limits it was reviewed under, and a deployment that changed them
    // invalidates it rather than transferring it (T2/T3 §6, A0 §3).
    const moved = h.restart({ maxChildren: 5 })
    await moved.task.openStore(STORE)
    const stale = await moved.runtime.continueProposal(STORE, submitted.proposalId, ROOT_SESSION)
    expect(stale.status).toBe('stale')
    expect(stale.detail).toContain('the limits in force moved')
    expect((await proposalOf(moved, submitted.proposalId)).status).toBe('stale')
    expect((await moved.task.snapshotIn(STORE)).tasks).toHaveLength(0)
    expect(moved.spawned).toHaveLength(0)
  })

  test('the re-check ladder names a moved capability resolution as stale, and a second root as expired', async () => {
    const home = pinSkillHome('ball-align')
    expect(home).toBeDefined()
    const h = harness({
      config: {
        generatedTaskReview: 'off',
        capabilities: { 'design-ball': { skills: ['ball-align'] } },
      },
    })
    await h.task.createStore(STORE)
    const contract: RootContractSpec = {
      objective: 'align the ball',
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the ball is aligned', command: 'true' }],
      requiredCapabilities: ['design-ball'],
    }
    const submitted = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, contract)
    expect(submitted.status).toBe('ready')
    // Two more contracts are asked for while no root exists yet — the store's
    // one-root gate is a fact about what it *holds*, so proposing beside a waiting
    // proposal is allowed and only activation settles the competition.
    const winner = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, {
      objective: 'a different goal entirely', requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [{ criterionId: 'other', description: 'the other goal holds', command: 'true' }],
    })
    const loser = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, {
      objective: 'a third goal', requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [{ criterionId: 'third', description: 'the third goal holds', command: 'true' }],
    })

    // The row this contract resolved is replaced: the contract text is untouched,
    // but what it resolves to is not what was recorded — so the re-check marks the
    // proposal stale and says which part moved.
    const moved = h.restart({ capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } } })
    await moved.task.openStore(STORE)
    const stale = await moved.runtime.continueProposal(STORE, submitted.proposalId, ROOT_SESSION)
    expect(stale.status).toBe('stale')
    expect(stale.detail).toContain('the resolution this contract was reviewed against moved')
    expect(stale.detail).toContain('the capability resolution moved')
    expect((await moved.task.snapshotIn(STORE)).tasks).toHaveLength(0)

    // The first contract to activate takes the store's one root; the other one can
    // no longer become it, and is expired by name rather than queued behind the
    // winner.
    const activated = await moved.runtime.continueProposal(STORE, winner.proposalId, ROOT_SESSION)
    expect(activated.status).toBe('activated')
    const refused = await moved.runtime.continueProposal(STORE, loser.proposalId, ROOT_SESSION)
    expect(refused.status).toBe('expired')
    expect(refused.detail).toContain('already holds root task')
    const snapshot = await moved.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.proposals?.all.filter(proposal => proposal.status === 'admitted')).toHaveLength(1)
  })

  test('a restart with the policy tightened sends an unactivated off-born contract for review, and activates it only after the decision', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    await h.task.createStore(STORE)
    // Submitted but not continued: the state an intake born under `off` leaves if
    // nothing ever continues it (`submitRootContractProposal` is the entry that
    // stops there), and the state a crash between the two halves also leaves.
    const submitted = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, rootContract('ship the release'))
    expect(submitted.status).toBe('ready')
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(0)

    // The deployment tightens to `all` before anything activated it: §5 reaches
    // whatever has not run, root contracts included.
    const tightened = h.restart({ generatedTaskReview: 'all' })
    await tightened.task.openStore(STORE)
    const waiting = await tightened.runtime.continueProposal(STORE, submitted.proposalId, ROOT_SESSION)
    expect(waiting.status).toBe('pending_review')
    expect(waiting.detail).toContain('was sent for review')
    // Zero side effects: no root task, no run, no spawn — and the review is asked
    // from the stored contract.
    const afterTighten = await proposalOf(tightened, submitted.proposalId)
    expect(afterTighten.status).toBe('pending_review')
    expect(afterTighten.policy).toBe('off')
    expect(afterTighten.decision).toBeUndefined()
    expect((await tightened.task.snapshotIn(STORE)).tasks).toHaveLength(0)
    expect(tightened.reviewCalls).toEqual([
      {
        storeId: STORE,
        trigger: 'tightened',
        proposalId: submitted.proposalId,
        status: 'pending_review',
        kind: 'root',
        hasBatch: false,
        parentObjective: 'ship the release',
        childObjectives: [],
        childCriteria: ['ship the release:root-goal:ship the release is delivered'],
        obligations: 0,
      },
    ])
    expect(tightened.spawned).toHaveLength(0)

    // Loosening the policy again is not a release: only a recorded decision moves
    // a waiting proposal, and the decision activates it.
    const loosened = tightened.restart({ generatedTaskReview: 'off' })
    await loosened.task.openStore(STORE)
    expect((await loosened.runtime.continueProposal(STORE, submitted.proposalId, ROOT_SESSION)).status).toBe(
      'pending_review',
    )
    const decided = await loosened.runtime.decideProposal(
      STORE,
      submitted.proposalId,
      { outcome: 'approved' },
      REVIEWER,
    )
    const continuation = decided.continuation
    if (continuation?.status !== 'activated') throw new Error('unreachable')
    const snapshot = await loosened.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]?.taskId).toBe(continuation.taskId)
    expect(snapshot.runs).toHaveLength(1)
  })

  test('a late approval on a store that already holds a root is recorded as expired, never as an approval that creates one', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.task.createStore(STORE)
    // Two proposals waiting at once: neither store has a root yet, so both may be
    // submitted (the one-root gate is a fact about the store, and it holds).
    const first = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    const second = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship it again, differently'))
    if (first.status !== 'pending_review' || second.status !== 'pending_review') throw new Error('unreachable')

    const approved = await h.runtime.decideProposal(STORE, second.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(approved.continuation?.status).toBe('activated')

    // The approval of the other contract arrives when the store already has its
    // root: §6's rule is that a late approval may only invalidate, so what lands is
    // `expired` with the root named — and the one root stays the one root.
    const late = await h.runtime.decideProposal(STORE, first.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(late.outcome).toBe('expired')
    expect(late.detail).toContain('already holds root task')
    expect((await proposalOf(h, first.proposalId)).status).toBe('expired')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
  })

  test('recovery finishes a decision that was saved but never activated, and leaves an activated root alone', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.task.createStore(STORE)
    const submitted = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    if (submitted.status !== 'pending_review') throw new Error('unreachable')
    // Crash point ①: the approval is on the record and the process that made it
    // never continued it. Written through the store's own entry, which is what a
    // process that died between the decision and the continuation leaves.
    await approveInStore(h, submitted.proposalId)
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(0)

    const restarted = h.restart()
    // The restart's own door (A2 §E): the activation barrier, which runs the
    // recovery pass *and* re-binds the session with its gate — the read door no
    // longer writes the gate, so this is the one place the phase comes back.
    const rebound = await restarted.runtime.adoptRoot(STORE, ROOT_SESSION)
    // The barrier's pass re-checked the contract and activated it: one root,
    // its run bound in this process, and nothing left unresolved.
    expect(rebound).toMatchObject({ adopted: true })
    const activated = await proposalOf(restarted, submitted.proposalId)
    expect(activated.status).toBe('admitted')
    if (activated.kind !== 'root' || activated.consumption?.kind !== 'root') throw new Error('unreachable')
    const snapshot = await restarted.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.tasks[0]?.taskId).toBe(activated.consumption.rootTaskId)
    expect((await restarted.runtime.runForSession(ROOT_SESSION)).run.runId).toBe(activated.consumption.rootRunId)
    expect(restarted.runtime.gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect(restarted.notifications.some(item => item.text.includes('root contract'))).toBe(true)

    // Crash point ②: the activation commit is durable and the process that wrote
    // it is gone. The store's own root is the answer — reopened, adopted, bound —
    // and no second task, run or proposal consumption appears.
    const crashed = h.restart()
    await crashed.task.openStore(STORE)
    const adopted = await crashed.runtime.adoptRoot(STORE, ROOT_SESSION)
    expect(adopted).toMatchObject({
      adopted: true,
      taskId: activated.consumption.rootTaskId,
      runId: activated.consumption.rootRunId,
    })
    const report2 = await crashed.runtime.reconcileStore(STORE)
    expect(report2.unresolvedProposals).toEqual([])
    const after = await crashed.task.snapshotIn(STORE)
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(after.proposals?.all.filter(proposal => proposal.status === 'admitted')).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated')).toHaveLength(1)
  })

  test('a waiting goal whose store found its root while the process was down is expired by the recovery pass', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.task.createStore(STORE)
    const waiting = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('the goal that waits'))
    const other = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('the goal that runs'))
    if (waiting.status !== 'pending_review' || other.status !== 'pending_review') throw new Error('unreachable')
    expect(
      (await h.runtime.decideProposal(STORE, other.proposalId, { outcome: 'approved' }, REVIEWER)).continuation?.status,
    ).toBe('activated')

    // The waiting proposal is still `pending_review` on the record while the store
    // now holds a root: the recovery pass reads that as an intake that can no
    // longer happen and expires it, naming the root it lost to.
    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const report = await restarted.runtime.reconcileStore(STORE)
    // The expiry is reported the way the batch path reports a stale loser: it is a
    // terminal fact a reader should see, not a silent deletion of the record.
    expect(report.unresolvedProposals).toHaveLength(1)
    expect(report.unresolvedProposals[0]?.status).toBe('expired')
    const expired = await proposalOf(restarted, waiting.proposalId)
    expect(expired.status).toBe('expired')
    expect(expired.decision?.reason).toContain('already holds root task')
    const snapshot = await restarted.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
  })

  test('a root contract that could never run is refused before a proposal exists, with nothing written', async () => {
    const h = harness()
    await h.task.createStore(STORE)
    const before = await h.task.snapshotIn(STORE)

    // The old shape: one mandatory criterion, the composite conjunction. It is a
    // valid *child* contract and not a root goal, and the refusal says which rule
    // it broke.
    await expect(
      h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
        objective: 'all children verified', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [
          {
            criterionId: 'root-children-verified',
            description: 'all mandatory children verified',
            mode: 'composite',
            mandatory: true,
          },
        ],
      }),
    ).rejects.toThrow(/verificationMode !== "composite"/)

    // Every other machine rule still applies, and every refusal is whole: no
    // proposal, no task, no obligation, no review request.
    await expect(
      h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
        objective: '   ', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ description: 'it holds', command: 'true' }],
      }),
    ).rejects.toThrow(/objective must be a non-empty string/)
    await expect(
      h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
        objective: 'an unregistered judge', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [
          {
            criterionId: 'x',
            description: 'it holds',
            mode: 'deterministic',
            command: 'true',
            mandatory: true,
            verifierRef: 'no-such-verifier',
          },
        ],
      }),
    ).rejects.toThrow(/no-such-verifier/)
    await expect(
      h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
        objective: 'a field nobody reads', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ description: 'it holds', command: 'true' }],
        budget: 1000,
      } as unknown as RootContractSpec),
    ).rejects.toThrow(/unknown field "budget"/)

    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(h.reviewCalls).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(h.notifications).toHaveLength(0)
  })

  test('a store that already holds a root refuses a new intake by name, whatever root it holds', async () => {
    const h = harness()
    await h.task.createStore(STORE)
    const first = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    if (first.status !== 'activated') throw new Error('unreachable')

    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('a different goal'))).rejects.toThrow(
      /already holds root task/,
    )
    // Nothing about the second attempt exists: no proposal, no task, no run.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.proposals?.all).toHaveLength(1)
    expect(snapshot.tasks).toHaveLength(1)
  })

  test('an old graph is history: its legacy root is not re-intaken, and it still decomposes and completes', async () => {
    const h = harness()
    // The shape the graph entry used to create — objective = the graph's name, one
    // mandatory composite criterion — seeded through the fixture that exists for
    // exactly this, because no entry can produce it any more (A0 §1.6).
    const legacy = await seedLegacyRoot({
      task: h.task,
      runtime: h.runtime,
      storeId: STORE,
      rootSessionId: ROOT_SESSION,
      objective: 'the old graph name',
    })
    const stored = await h.task.taskIn(STORE, legacy.taskId)
    expect(stored.contract?.objective).toBe('the old graph name')
    expect(stored.contract?.acceptanceCriteria.map(criterion => criterion.criterionId)).toEqual([
      'root-children-verified',
    ])

    // An intake on such a store is refused by name: the root it holds is history,
    // and a changed goal is a new graph rather than a second root here.
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('a goal for today'))).rejects.toThrow(
      /already holds root task/,
    )
    expect((await h.task.snapshotIn(STORE)).proposals?.all ?? []).toHaveLength(0)

    // And the old tree still works: its batch is admitted, runs and completes, and
    // the root's own composite criterion accepts it exactly as it always did.
    const batch = await h.runtime.decomposeAndRun(
      STORE,
      legacy.taskId,
      legacy.runId,
      ROOT_SESSION,
      batchSpec([childSpec('legacy work')]),
    )
    if (batch.status !== 'admitted') throw new Error('unreachable')
    expect((await h.runtime.awaitBatch(STORE, batch.batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    // The legacy root's own acceptance is its own submission, like every other
    // parent's (K1 §2).
    expect(
      await h.runtime.submitResult(ROOT_SESSION, { summary: 'the legacy tree reports what its batch delivered' }),
    ).toMatchObject({ status: 'verified' })
    expect((await h.task.taskIn(STORE, legacy.taskId)).status).toBe('verified')
    // Reading it is not a rewrite: the store still holds one task, one run and the
    // contract it was created with.
    const after = await h.task.snapshotIn(STORE)
    expect(after.tasks).toHaveLength(2)
    expect(after.tasks.find(task => task.taskId === legacy.taskId)?.contract?.objective).toBe('the old graph name')
  })
})

/**
 * The origin rule (A0 §1.10): a root contract is intaken for a session whose own
 * durable log carries a request of the person's, and only into that session's own
 * store. The cases here are the counterexamples the rule exists for — a store
 * that is not the session's, a session nobody spoke to, a log that cannot be read
 * — plus the ladder's own door, because a record written before this rule existed
 * must not be able to *become* a root either.
 */
describe("the root contract's origin (A0 §1.10)", () => {
  test("refuses a contract sent to a store that is not the session's own, naming both ids and the session's own store", async () => {
    const h = harness()
    const other = rootTaskStoreId(BETA)

    // The session that carried the request is the root session; the store handed
    // in belongs to a different one. Nothing about the contract itself is wrong —
    // this is attribution alone, which is why it is its own refusal.
    await expect(h.runtime.intakeRootContract(other, ROOT_SESSION, rootContract('ship the release'))).rejects.toThrow(
      /the root contract of session "root-session" was refused: store "sg-t-s-beta" is not this session's own store \("sg-t-root-session"\)/,
    )
    // The other door into a submission — the half of the intake that records
    // rather than activates — refuses it the same way, before any record exists.
    await expect(
      h.runtime.submitRootContractProposal(other, ROOT_SESSION, rootContract('ship the release')),
    ).rejects.toThrow(/is not this session's own store/)

    // Zero side effects, read back from the deployment rather than from the prose:
    // neither store exists (the refused intake must not even create the target
    // one), no task event was written anywhere, nobody was asked and every worker
    // count stays zero.
    expect(h.sessions.has(other)).toBe(false)
    expect(h.sessions.has(STORE)).toBe(false)
    expect(storeTaskEvents(h, other)).toEqual([])
    expect(storeTaskEvents(h, STORE)).toEqual([])
    expect(h.reviewCalls).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(h.notifications).toHaveLength(0)
  })

  test('refuses a contract for a session whose own log holds no request of the person — a notice the runtime sent is not one', async () => {
    const h = harness()
    const quiet = 's-quiet'
    // The session heard from the runtime and from nobody else: `user/message`
    // events exist on its log, all of them plugin-sourced. A model that read this
    // session and reported "the user wants X" has no request behind the claim.
    seedSession(h, quiet, [
      pluginNotice('the root contract of this session was activated: task t-1, run r-1'),
      pluginNotice('batch b-1 verified'),
    ])
    const quietStore = rootTaskStoreId(quiet)

    await expect(
      h.runtime.intakeRootContract(quietStore, quiet, rootContract('a goal nobody asked for')),
    ).rejects.toThrow(
      /the root contract of session "s-quiet" was refused: this session's own log holds no message from the person \(no `user\/message` event with source\.kind "user", the marker DSH reserves for host-attested human input\)/,
    )

    expect(h.sessions.has(quietStore)).toBe(false)
    expect(storeTaskEvents(h, quietStore)).toEqual([])
    expect(h.reviewCalls).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(h.notifications).toHaveLength(0)
    // The session's own log is exactly what it was: a refusal reads, it never writes.
    expect(h.sessions.get(quiet)?.events).toHaveLength(2)
  })

  test("refuses when the session's own log cannot be read: no reader mounted, or no such session", async () => {
    const h = harness()
    // A deployment that mounts no session-persistence service cannot establish the
    // origin, and "could not check" is a refusal rather than a silent pass.
    const mounted = h.ctx.sessionPersistence
    delete h.ctx.sessionPersistence
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))).rejects.toThrow(
      /the root contract of session "root-session" was refused: this deployment mounts no session-persistence service/,
    )
    expect(h.sessions.has(STORE)).toBe(false)
    h.ctx.sessionPersistence = mounted

    // The same fact from the other side: a session whose log does not exist makes
    // the open fail, and the failure is named rather than read as "no request".
    const ghost = 's-ghost'
    await expect(
      h.runtime.intakeRootContract(rootTaskStoreId(ghost), ghost, rootContract('ship the release')),
    ).rejects.toThrow(
      /the root contract of session "s-ghost" was refused: its own log could not be read \(missing session s-ghost\)/,
    )
    expect(h.sessions.has(rootTaskStoreId(ghost))).toBe(false)

    // And a session that *does* have a log with the person's request is untouched
    // by either refusal: the same contract intakes normally.
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
    expect(activated.status).toBe('activated')
  })

  test('an already-recorded cross-attributed proposal cannot be activated: the ladder refuses before its first write', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    await h.task.createStore(STORE)
    // A well-formed record of the shape the probe left behind: session BETA's
    // contract, attributed to session BETA, and written into a store that is not
    // that session's. The service refuses to *make* such a record now (the cases
    // above); this one starts from one, which is what a store written before this
    // rule existed holds.
    const submitted = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, rootContract('ship the release'))
    const legit = await proposalOf(h, submitted.proposalId)
    if (legit.kind !== 'root') throw new Error('unreachable')
    const betaStore = rootTaskStoreId(BETA)
    const requestKey = 'rk-beta-contract-in-a-store-that-is-not-hers'
    const identity = { ...legit.identity, storeId: betaStore, rootSessionId: BETA, requestKey }
    const cross: TaskProposalRoot = {
      ...legit,
      requestKey,
      proposalId: rootProposalId(identity),
      identity,
      proposalDigest: rootProposalDigest(identity),
    }
    await h.task.submitProposalIn(STORE, cross, BETA)

    // A root in that store, so the ladder's *first* step — the expiry of a store
    // whose root somebody else became — is reachable too: the refusal has to come
    // before that write, not merely before the activation.
    await seedLegacyRoot({
      task: h.task,
      runtime: h.runtime,
      storeId: STORE,
      rootSessionId: ROOT_SESSION,
      objective: 'the name of some old graph',
    })

    const noticesBefore = h.notifications.length
    await expect(h.runtime.continueProposal(STORE, cross.proposalId, BETA)).rejects.toThrow(
      /the root contract of session "s-beta" was refused: store "sg-t-root-session" is not this session's own store \("sg-t-s-beta"\)/,
    )

    // Zero side effects: the proposal is exactly where it was — not expired by the
    // ladder's first step, and with no phase change or admission behind it — and
    // the store still holds the one legacy root it started with.
    expect((await h.runtime.proposalIn(STORE, cross.proposalId)).status).toBe('ready')
    expect(storeTaskEvents(h, STORE).filter(event => event.kind === 'TaskProposalPhaseChanged')).toEqual([])
    expect(storeTaskEvents(h, STORE).filter(event => event.kind === 'TaskProposalAdmitted')).toEqual([])
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.tasks[0]?.objective).toBe('the name of some old graph')
    expect(h.spawned).toHaveLength(0)
    expect(h.notifications).toHaveLength(noticesBefore)
  })

  test('does not ask a person about a waiting contract whose origin is not established', async () => {
    // The record is built through the runtime's own submission under `off` (which
    // asks nobody) and then written into the quiet session's store through the
    // store's own entry, as a `pending_review` contract — the shape a store
    // written before this rule existed, or by any other hand, holds.
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const quiet = 's-quiet'
    // A session nobody spoke to: the runtime's own notice is all that is on it.
    seedSession(h, quiet, [pluginNotice('batch b-1 verified')])
    const quietStore = rootTaskStoreId(quiet)
    await h.task.createStore(quietStore)
    const submitted = await h.runtime.submitRootContractProposal(
      STORE,
      ROOT_SESSION,
      rootContract('a goal nobody asked for'),
    )
    const legit = await proposalOf(h, submitted.proposalId)
    if (legit.kind !== 'root') throw new Error('unreachable')
    const requestKey = 'rk-contract-for-a-session-nobody-spoke-to'
    const identity = { ...legit.identity, storeId: quietStore, rootSessionId: quiet, requestKey }
    const waiting: TaskProposalRoot = {
      ...legit,
      status: 'pending_review',
      policy: 'all',
      requestKey,
      proposalId: rootProposalId(identity),
      identity,
      proposalDigest: rootProposalDigest(identity),
    }
    await h.task.submitProposalIn(quietStore, waiting, quiet)

    // Recovery of that store. A contract whose request cannot be established can
    // never activate, so a person must not be asked to decide it: the pass reports
    // it unresolved by name instead, and asks nobody.
    const report = await h.runtime.reconcileStore(quietStore)
    expect(h.reviewCalls).toHaveLength(0)
    expect(report.unresolvedProposals).toHaveLength(1)
    expect(report.unresolvedProposals[0]).toMatchObject({ proposalId: waiting.proposalId, status: 'pending_review' })
    expect(report.unresolvedProposals[0]!.reason).toContain('the root contract of session "s-quiet" was refused')
    expect(report.unresolvedProposals[0]!.reason).toContain('holds no message from the person')

    // Nothing was created and nothing was written: the contract still waits, and
    // the pass left no phase change, no admission and no task behind it.
    expect((await h.runtime.proposalIn(quietStore, waiting.proposalId)).status).toBe('pending_review')
    expect(storeTaskEvents(h, quietStore).filter(event => event.kind === 'TaskProposalPhaseChanged')).toEqual([])
    expect(storeTaskEvents(h, quietStore).filter(event => event.kind === 'TaskProposalAdmitted')).toEqual([])
    expect(storeTaskEvents(h, quietStore).filter(event => event.kind === 'TaskCreated')).toEqual([])
    const snapshot = await h.task.snapshotIn(quietStore)
    expect(snapshot.tasks).toHaveLength(0)
    expect(snapshot.runs).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(h.notifications).toHaveLength(0)

    // The adoption door answers the same, and asks nobody either: it names the
    // waiting proposal and reports that it created nothing.
    const adopted = await h.runtime.adoptRoot(quietStore, quiet)
    expect(adopted.adopted).toBe(false)
    if (adopted.adopted) throw new Error('unreachable')
    expect(adopted.detail).toContain(`"${waiting.proposalId}" (pending_review)`)
    expect(adopted.detail).toContain('created no task, no run and no proposal')
    expect(h.reviewCalls).toHaveLength(0)
  })
})

/*
 * K2: the recovery barrier's production reconciliation.
 *
 * `adoptRoot` is what a graph activation awaits and what a restarted root
 * session walks through, so it is the one place a deployment asks whether an
 * interrupted apply/rollback left production behind its ledger. The service is
 * read softly (`optionalService(ctx, 'evolution')`, declared structurally in
 * `src/index.ts` — this package never imports the evolution package), a blocked
 * outcome is reported by name without failing the barrier (the admission gate
 * refuses the provider whose target it names), and a real failure of the
 * reconciliation fails the barrier rather than taking a store over.
 */
describe('the recovery barrier reconciles an open production commit first', () => {
  /** A fresh store id no other case in this file holds: the barrier creates it. */
  const FRESH = 'sg-k2-barrier'

  /** The reconciliation one barrier reported, as the runtime hands it to the warning door. */
  function warningsSeen(h: Harness): string[] {
    const warnings: string[] = []
    h.ctx.logger = () => ({
      warn: (message: string) => {
        warnings.push(message)
      },
    })
    return warnings
  }

  test('reconciles before the store is touched, and reports a blocked intent without failing the barrier', async () => {
    const h = harness()
    const order: string[] = []
    const task = h.task as unknown as { createStore(id: string): Promise<void> }
    const createStore = task.createStore.bind(task)
    task.createStore = async (id: string) => {
      order.push('store')
      return createStore(id)
    }
    const reconcile = vi.fn(async () => {
      order.push('reconcile')
      return [
        {
          intentId: 's1/apply',
          proposalId: 's1',
          direction: 'apply',
          targets: ['/production/skills/verify/SKILL.md'],
          result: 'completed-redone',
        },
        {
          // The real K3 shape: every file the intent committed, in intent order —
          // the warning must name them, not a field the outcome does not carry.
          intentId: 's2/apply',
          proposalId: 's2',
          direction: 'apply',
          targets: ['/production/skills/other/SKILL.md', '/production/skills/other/SKILL.contract.json'],
          result: 'blocked',
          detail: 'the production target holds a version no commit of this proposal wrote',
        },
      ]
    })
    h.ctx.evolution = { reconcile }
    const warnings = warningsSeen(h)

    const adopted = await h.runtime.adoptRoot(FRESH, ROOT_SESSION)
    expect(order).toEqual(['reconcile', 'store'])
    expect(reconcile).toHaveBeenCalledTimes(1)
    // The blocked intent did not stop the adoption: it is reported with its own
    // identity and reason, and the provider it names stays under the gate.
    expect(adopted.adopted).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"s2/apply"')
    expect(warnings[0]).toContain('apply of proposal "s2"')
    expect(warnings[0]).toContain('/production/skills/other/SKILL.md, /production/skills/other/SKILL.contract.json')
    expect(warnings[0]).toContain('the production target holds a version no commit of this proposal wrote')
  })

  test('a reconciliation failure fails the barrier, naming the cause and leaving the store untouched', async () => {
    const h = harness()
    const order: string[] = []
    const task = h.task as unknown as { createStore(id: string): Promise<void> }
    const createStore = task.createStore.bind(task)
    task.createStore = async (id: string) => {
      order.push('store')
      return createStore(id)
    }
    h.ctx.evolution = {
      reconcile: async () => {
        order.push('reconcile')
        throw new Error('evolution: ledger line 1 in /tmp/x/proposals.jsonl declares formatVersion 1')
      },
    }

    await expect(h.runtime.adoptRoot(FRESH, ROOT_SESSION)).rejects.toThrow(
      /could not be reconciled before this store was recovered.*declares formatVersion 1/,
    )
    // Nothing was taken over: the barrier failed before its first store read.
    expect(order).toEqual(['reconcile'])
  })

  test('a deployment with no evolution service adopts exactly as before', async () => {
    const h = harness()
    const adopted = await h.runtime.adoptRoot(FRESH, ROOT_SESSION)
    expect(adopted.adopted).toBe(false)
  })
})

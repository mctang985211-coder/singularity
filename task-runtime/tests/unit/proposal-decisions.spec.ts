import { TASK_GUIDANCE } from '../support/skill-roots.ts'
import { describe, expect, test } from 'vitest'
import type { TaskEvent } from '../../../task/src/index.ts'
import { ROOT_PROPOSAL_TASK_ID } from '../../../task/src/index.ts'
import type { Config, DecomposeSpec } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'
import {
  type Harness,
  taskEvents,
  harness,
  createRoot,
  STORE,
  ROOT_SESSION,
  batchSpec,
  childSpec,
  proposalOf,
  consumedBatch,
  childTasks,
  batchAdmissions,
  REVIEWER,
} from './proposal-lifecycle.fixture.ts'

/**
 * Every proposal event this store recorded for a **batch**. A root contract's own
 * proposal rides the reserved envelope task id (`ROOT_PROPOSAL_TASK_ID`), so a
 * case about a batch's proposal never counts the root intake's records — those are
 * a different subject with its own cases.
 */
function batchProposalEvents(h: Harness): TaskEvent[] {
  return taskEvents(h).filter(event => event.kind.startsWith('TaskProposal') && event.taskId !== ROOT_PROPOSAL_TASK_ID)
}

describe('TaskRuntime review policy (§5)', () => {
  test('policy off admits synchronously, records policy-off and never asks a person', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)

    const admitted = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    expect(admitted.status).toBe('admitted')
    if (admitted.status !== 'admitted') throw new Error('unreachable')
    expect(admitted.childTaskIds).toHaveLength(1)

    // The audit record: born `ready` under policy `off`, and no review was ever
    // requested — `policy-off` is a fact, not a missing approval.
    const proposal = await proposalOf(h, admitted.proposalId)
    expect(proposal.policy).toBe('off')
    expect(proposal.status).toBe('admitted')
    expect(proposal.decision).toBeUndefined()
    expect(consumedBatch(proposal).childTaskIds).toEqual(admitted.childTaskIds)
    expect(h.reviewCalls).toHaveLength(0)
    expect(h.channel.requestReview).not.toHaveBeenCalled()

    // And the batch really ran: the children settled through the driver.
    const outcomes = await h.runtime.awaitBatch(STORE, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('policy all holds the batch: no child, no spawn, no decomposition, no admission until a recorded decision', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const before = await h.task.snapshotIn(STORE)

    const pending = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    expect(pending.status).toBe('pending_review')
    if (pending.status !== 'pending_review') throw new Error('unreachable')

    const proposal = await proposalOf(h, pending.proposalId)
    expect(proposal.policy).toBe('all')
    expect(proposal.status).toBe('pending_review')
    expect(proposal.decision).toBeUndefined()
    expect(proposal.consumption).toBeUndefined()

    // Zero side effects beyond the proposal record itself: the parent still holds
    // no child, no run started for one, the parent is not decomposed, and the
    // store holds no TaskCreated or TaskDecomposed for this batch.
    const after = await h.task.snapshotIn(STORE)
    expect(childTasks(after, taskId)).toHaveLength(0)
    expect(after.runs).toHaveLength(before.runs.length)
    expect(after.edges).toHaveLength(0)
    expect(after.tasks.find(task => task.taskId === taskId)?.decompositionStatus).toBe('decomposable')
    expect(h.spawned).toHaveLength(0)
    expect(taskEvents(h).some(event => event.kind === 'TaskCreated' && event.taskId !== taskId)).toBe(false)
    expect(taskEvents(h).some(event => event.kind === 'TaskDecomposed')).toBe(false)
    expect(batchAdmissions(h)).toHaveLength(0)

    // The review of *this batch* was requested exactly once, and the request
    // carried the batch (a reviewer has to be shown the contracts, not only a
    // digest). The root's own intake asked for its contract in the setup, which is
    // the subject of its own case below.
    expect(h.reviewCalls.filter(call => call.kind === 'decomposition')).toEqual([
      {
        storeId: STORE,
        trigger: 'submitted',
        proposalId: pending.proposalId,
        status: 'pending_review',
        kind: 'decomposition',
        hasBatch: true,
        parentObjective: 'ship the release',
        childObjectives: ['task a'],
        childCriteria: ['task a:ac1-1:task a works'],
        obligations: 0,
      },
    ])

    // A continuation while it waits writes nothing and admits nothing.
    const again = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(again.status).toBe('pending_review')
    expect((await proposalOf(h, pending.proposalId)).status).toBe('pending_review')
    expect(h.spawned).toHaveLength(0)
  })

  test('an invalid batch is refused before any approval could be raised, and leaves no trace', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const before = await h.task.snapshotIn(STORE)

    // All-optional criteria: the machine rules refuse this batch, and §5 is
    // explicit that a bad batch never reaches a person.
    await expect(
      h.runtime.decomposeAndRun(
        STORE,
        taskId,
        runId,
        ROOT_SESSION,
        batchSpec([
          childSpec('task a', {
            acceptanceCriteria: [{ description: 'nothing is required', command: 'true', mandatory: false }],
          }),
        ]),
      ),
    ).rejects.toThrow(/requires at least one mandatory acceptance criterion/)

    expect(h.reviewCalls.filter(call => call.kind === 'decomposition')).toHaveLength(0)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  test('a policy the runtime cannot execute refuses to start, and a batch cannot carry the policy itself', async () => {
    const h = harness()
    // The configuration schema types the member, but a deployment that builds the
    // runtime directly bypasses it: an unknown mode refuses to start rather than
    // admitting unreviewed batches.
    expect(() => new TaskRuntime(h.ctx as never, { generatedTaskReview: 'risk' as Config['generatedTaskReview'], capabilities: TASK_GUIDANCE })).toThrow(
      /generatedTaskReview is "risk"; the review policy is "off" or "all"/,
    )

    const { taskId, runId } = await createRoot(h)
    // The policy belongs to the deployment: a batch-level key is refused by name
    // by the one normalization entry, never dropped and never honoured.
    await expect(
      h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
        reason: 'split the work',
        generatedTaskReview: 'off',
        children: [childSpec('task a')],
      } as unknown as DecomposeSpec),
    ).rejects.toThrow(/declares unknown field "generatedTaskReview"/)
  })
})

describe('TaskRuntime proposal decisions (§6)', () => {
  test('an approval admits the batch it was made against, and the decision binds all three identities', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (pending.status !== 'pending_review') throw new Error('unreachable')

    const decided = await h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.outcome).toBe('approved')
    expect(decided.status).toBe('admitted')
    expect(decided.continuation?.status).toBe('admitted')

    const proposal = await proposalOf(h, pending.proposalId)
    expect(proposal.status).toBe('admitted')
    expect(proposal.decision).toEqual({
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: expect.any(String),
    })
    // The approved batch became exactly the tasks the consumption names.
    expect(childTasks(await h.task.snapshotIn(STORE), taskId).map(task => task.taskId)).toEqual(
      consumedBatch(proposal).childTaskIds,
    )
    const outcomes = await h.runtime.awaitBatch(
      STORE,
      decided.continuation?.status === 'admitted' ? decided.continuation.batchId : '',
    )
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('a tampered decision is refused by the reducer: an approval never travels to another digest', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const proposal = await proposalOf(h, pending.proposalId)
    const before = await h.task.snapshotIn(STORE)

    // A decision naming another dossier, another context or another resolution is
    // not a decision about this batch — the store refuses each by name.
    await expect(
      h.task.decideProposalIn(
        STORE,
        {
          proposalId: pending.proposalId,
          outcome: 'approved',
          proposalDigest: '0'.repeat(64),
          admissionContextDigest: proposal.admissionContextDigest,
          reviewContextDigest: proposal.reviewContextDigest,
          decidedBy: REVIEWER,
          decidedAt: new Date().toISOString(),
        },
        REVIEWER,
      ),
    ).rejects.toThrow(/does not match the stored proposal digest/)
    await expect(
      h.task.decideProposalIn(
        STORE,
        {
          proposalId: pending.proposalId,
          outcome: 'approved',
          proposalDigest: proposal.proposalDigest,
          admissionContextDigest: '1'.repeat(64),
          reviewContextDigest: proposal.reviewContextDigest,
          decidedBy: REVIEWER,
          decidedAt: new Date().toISOString(),
        },
        REVIEWER,
      ),
    ).rejects.toThrow(/does not match the stored admission context digest/)
    await expect(
      h.task.decideProposalIn(
        STORE,
        {
          proposalId: pending.proposalId,
          outcome: 'approved',
          proposalDigest: proposal.proposalDigest,
          admissionContextDigest: proposal.admissionContextDigest,
          decidedBy: REVIEWER,
          decidedAt: new Date().toISOString(),
        },
        REVIEWER,
      ),
    ).rejects.toThrow(/approval requires the review context digest/)
    await expect(
      h.task.decideProposalIn(
        STORE,
        {
          proposalId: pending.proposalId,
          outcome: 'approved',
          proposalDigest: proposal.proposalDigest,
          admissionContextDigest: proposal.admissionContextDigest,
          reviewContextDigest: '2'.repeat(64),
          decidedBy: REVIEWER,
          decidedAt: new Date().toISOString(),
        },
        REVIEWER,
      ),
    ).rejects.toThrow(/does not match the stored review context digest/)

    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect((await proposalOf(h, pending.proposalId)).status).toBe('pending_review')
    expect(h.spawned).toHaveLength(0)
  })

  test('a rejection is terminal, keeps the batch unadmitted, and a revision is new content under a new key', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const first = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    if (first.status !== 'pending_review') throw new Error('unreachable')

    const rejected = await h.runtime.decideProposal(
      STORE,
      first.proposalId,
      { outcome: 'rejected', reason: 'the criterion is not checkable' },
      REVIEWER,
    )
    expect(rejected.status).toBe('rejected')
    expect((await proposalOf(h, first.proposalId)).decision?.reason).toBe('the criterion is not checkable')
    expect(h.spawned).toHaveLength(0)
    expect(taskEvents(h).some(event => event.kind === 'TaskDecomposed')).toBe(false)

    // A revision: different content (a stricter criterion) under its own key,
    // naming the proposal it replaces. It does not inherit the rejection's
    // opposite — it waits for its own decision.
    const revision = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([
        childSpec('task a', {
          acceptanceCriteria: [
            { description: 'task a works', command: 'true' },
            { description: 'task a is also measured', command: 'true' },
          ],
        }),
      ]),
      { supersedes: first.proposalId },
    )
    expect(revision.proposalId).not.toBe(first.proposalId)
    expect(revision.status).toBe('pending_review')
    expect(revision.existing).toBe(false)
    const stored = await proposalOf(h, revision.proposalId)
    expect(stored.supersedes).toBe(first.proposalId)
    expect(stored.requestKey).not.toBe((await proposalOf(h, first.proposalId)).requestKey)

    // Approving the revision admits it; the rejected record stays as it was.
    const decided = await h.runtime.decideProposal(STORE, revision.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.status).toBe('admitted')
    expect((await proposalOf(h, first.proposalId)).status).toBe('rejected')
  })

  test('a machine refusal cannot be revised away by weakening the contract, and a revision that satisfies the rule is admitted', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)
    const allOptional = {
      acceptanceCriteria: [{ description: 'nothing is required', command: 'true', mandatory: false }],
    }

    // The refusal: no mandatory criterion (and it is refused again below, from a
    // *different* submission — this is not a rule that a second attempt fixes).
    await expect(
      h.runtime.submitDecompositionProposal(
        STORE,
        taskId,
        runId,
        ROOT_SESSION,
        batchSpec([childSpec('task a', allOptional)]),
      ),
    ).rejects.toThrow(/requires at least one mandatory acceptance criterion/)

    const withHeuristic = batchSpec([
      childSpec('task a', {
        acceptanceCriteria: [{ description: 'task a works', command: 'true', mandatory: false, heuristic: true }],
      }),
    ])
    await expect(h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, withHeuristic)).rejects.toThrow(
      /requires at least one mandatory acceptance criterion/,
    )

    // Nothing was persisted by either attempt.
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(0)
    expect(batchProposalEvents(h)).toHaveLength(0)

    // The legal fix — one mandatory criterion — is admitted, which is what makes
    // the two refusals above a rule rather than a wall.
    const admitted = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    expect(admitted.status).toBe('admitted')
    expect(
      (await h.runtime.awaitBatch(STORE, admitted.status === 'admitted' ? admitted.batchId : '')).map(
        outcome => outcome.status,
      ),
    ).toEqual(['verified'])
  })

  test('a withdrawal by anybody but the proposing session is refused; the proposing session cancels', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (pending.status !== 'pending_review') throw new Error('unreachable')

    await expect(h.runtime.cancelProposal(STORE, pending.proposalId, REVIEWER)).rejects.toThrow(
      /can only be withdrawn|was submitted by session/,
    )
    const cancelled = await h.runtime.cancelProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(cancelled.status).toBe('cancelled')
    expect((await proposalOf(h, pending.proposalId)).status).toBe('cancelled')
    expect(h.spawned).toHaveLength(0)

    // A later approval of a cancelled proposal is an illegal transition, refused
    // by the reducer: a withdrawal cannot be undone by a late decision.
    await expect(
      h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER),
    ).rejects.toThrow(/illegal proposal transition "cancelled" → "approved"/)
  })

  test('with no review channel the proposal stays pending and says so — a request is never an approval', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    delete h.ctx.proposalReviewChannel

    const pending = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const submission = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(submission.existing).toBe(true)
    expect(submission.review?.requested).toBe(false)
    expect(submission.review?.detail).toContain('no review channel is mounted')
    expect((await proposalOf(h, pending.proposalId)).status).toBe('pending_review')
    expect(h.spawned).toHaveLength(0)

    // A channel that answers "nobody is watching" is the same state, reported the
    // same way.
    h.ctx.proposalReviewChannel = h.channel
    h.setReviewRequested(false)
    const quiet = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(quiet.review?.requested).toBe(false)
    expect(quiet.review?.detail).toBe('nobody is watching')
    expect((await proposalOf(h, pending.proposalId)).status).toBe('pending_review')
  })
})

describe('TaskRuntime request keys (§6)', () => {
  test('the same request is answered from the record: same key and same content never builds a second proposal', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])

    const first = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, spec)
    const second = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, spec)
    expect(second.proposalId).toBe(first.proposalId)
    expect(second.existing).toBe(true)
    expect(second.status).toBe('pending_review')
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(1)
    expect(batchProposalEvents(h).filter(event => event.kind === 'TaskProposalSubmitted')).toHaveLength(1)
  })

  test('the same key with different content is refused by name, and a revision gets its own key', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)

    const first = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
      {
        requestKey: 'caller-key-1',
      },
    )
    await expect(
      h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task b')]), {
        requestKey: 'caller-key-1',
      }),
    ).rejects.toThrow(
      /request key "caller-key-1" is already bound to proposal "p-[0-9a-f]+", whose batch is a different one/,
    )

    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(1)

    // …and a *different* key is refused as well while that proposal is in
    // flight, by name and with nothing recorded (K1 §1: one proposal per run).
    await expect(
      h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task b')]), {
        requestKey: 'caller-key-2',
      }),
    ).rejects.toThrow(/decomposition refused: an open decomposition proposal must be continued or cancelled/)
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(1)

    // The derived key of the same caller for *different* content differs, which
    // is what makes a revision a new request rather than a rewrite — and a
    // revision withdraws the proposal it replaces (one at a time).
    await h.runtime.cancelProposal(STORE, first.proposalId, ROOT_SESSION)
    const derivedA = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task c')]),
    )
    await h.runtime.cancelProposal(STORE, derivedA.proposalId, ROOT_SESSION)
    const derivedB = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task d')]),
    )
    expect((await proposalOf(h, derivedA.proposalId)).requestKey).not.toBe(
      (await proposalOf(h, derivedB.proposalId)).requestKey,
    )
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(3)
  })
})

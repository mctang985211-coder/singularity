import { describe, expect, test, vi } from 'vitest'
import type { TaskProposal } from '../../../task/src/index.ts'
import { batchIdFor } from '../../../task/src/index.ts'
import type { DecomposeSpec } from '../../src/index.ts'
import { decompositionIdentity, isOpenProposal, openProposalOf } from '../../src/index.ts'
import { decompositionDigest } from '../../../task/src/contract.ts'
import { taskProposalId } from '../../../task/src/proposal.ts'
import type { TaskProposalDecomposition } from '../../../task/src/proposal.ts'
import {
  type Harness,
  STORE,
  proposalOf,
  ROOT_SESSION,
  harness,
  createRoot,
  batchSpec,
  childSpec,
  REVIEWER,
  batchAdmissions,
  approveInStore,
  taskEvents,
  childTasks,
  consumedBatch,
} from './proposal-lifecycle.fixture.ts'

/** One stored proposal's batch content, with the kind named rather than assumed. */
function storedBatch(proposal: TaskProposal): readonly {
  contract: { objective: string; acceptanceCriteria: readonly { criterionId: string; description: string }[] }
}[] {
  if (proposal.kind === 'root')
    throw new Error(`proposal "${proposal.proposalId}" is a root contract; it carries one contract and no batch`)
  return proposal.batch
}

/**
 * The proposal record a racing process leaves behind (K1 §3): a batch for a run
 * that already holds one.
 *
 * The runtime refuses a second proposal for a run that already has one, which is
 * what makes this state unreachable inside one process — so the raced record is
 * built from a record the runtime itself wrote (its content, its admission and
 * review contexts and their digests are the runtime's own) and re-addressed to
 * the run under test. Only the identity moves: that is exactly what a second
 * process's submission for the same run is.
 */
async function seedRacedProposal(
  h: Harness,
  spec: DecomposeSpec,
  target: { taskId: string; runId: string },
): Promise<string> {
  const elsewhere = await createSecondParent(h)
  const template = await h.runtime.submitDecompositionProposal(
    STORE,
    elsewhere.taskId,
    elsewhere.runId,
    elsewhere.sessionId,
    spec,
    { requestKey: 'k-raced-template' },
  )
  const captured = (await proposalOf(h, template.proposalId)) as TaskProposalDecomposition
  const identity = decompositionIdentity(
    { storeId: STORE, parentTaskId: target.taskId, parentRunId: target.runId, callerSessionId: ROOT_SESSION },
    captured.identity.reason,
    // The stored children are the normalized ones the runtime wrote (same four
    // fields the identity covers), so they go back in unchanged.
    captured.batch.map(child => ({
      contract: child.contract,
      dependsOn: [...child.dependsOn],
      decomposable: child.decomposable,
      requiresIndependentAcceptance: child.requiresIndependentAcceptance,
    })),
  )
  const raced: TaskProposalDecomposition = {
    ...captured,
    proposalId: taskProposalId(identity),
    requestKey: 'k-raced',
    identity,
    proposalDigest: decompositionDigest(identity),
  }
  await h.task.submitProposalIn(STORE, raced, ROOT_SESSION)
  return raced.proposalId
}

/**
 * A second parent task with its own active run, authored directly in the store.
 * It exists for the checks that need a parent of their own *and* the real root
 * untouched: its session is not the store's root session, so it claims no root
 * budget of its own (the rule a replay's parentless task follows).
 */
async function createSecondParent(h: Harness): Promise<{ taskId: string; runId: string; sessionId: string }> {
  const taskId = 't-second-parent'
  const runId = 'r-second-parent'
  const sessionId = 'second-parent-session'
  const contract = {
    contractVersion: 1 as const,
    objective: 'a second tree to propose into',
    acceptanceCriteria: [
      {
        criterionId: 'sp-1',
        description: 'the second parent works',
        verificationMode: 'deterministic' as const,
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      },
    ],
    assumptions: [],
    constraints: [],
    requiredCapabilities: ['execute-task'],
  }
  await h.task.createTaskIn(
    STORE,
    {
      taskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: contract.objective,
      depth: 0,
      acceptanceCriteria: contract.acceptanceCriteria,
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
      contract,
    },
    'tester',
  )
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'decomposable' })
  await h.task.startRunIn(
    STORE,
    {
      runId,
      taskId,
      sessionId,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      executionPhase: 'active',
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    'tester',
  )
  return { taskId, runId, sessionId }
}

describe('TaskRuntime post-approval re-check (§6)', () => {
  test('a parent run that ended takes the approval down with it: expired, named, and nothing dispatched', async () => {
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

    await h.task.markRunStatusIn(STORE, taskId, runId, 'cancelled', 'tester', { reason: 'the run was stopped' })
    const decided = await h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)

    expect(decided.outcome).toBe('expired')
    expect(decided.status).toBe('expired')
    expect(decided.reason).toContain('the parent run')
    const proposal = await proposalOf(h, pending.proposalId)
    expect(proposal.status).toBe('expired')
    expect(proposal.decision?.outcome).toBe('expired')
    expect(proposal.decision?.decidedBy).toBe(REVIEWER)
    expect(h.spawned).toHaveLength(0)
    expect(batchAdmissions(h)).toHaveLength(0)
  })

  test('a capability resolution that moved marks the approval stale, naming what moved', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.runtime.applyCapabilityRow('build-thing', { skills: ['task-execution'], tools: ['bash'] })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a', { requiredCapabilities: ['build-thing'] })])

    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await approveInStore(h, pending.proposalId)
    await h.runtime.applyCapabilityRow('build-thing', { skills: ['task-execution'], tools: ['filesystem'] })

    const continued = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION, { spec })
    expect(continued.status).toBe('stale')
    if (continued.status !== 'stale') throw new Error('unreachable')
    expect(continued.reason).toContain('the resolution this batch was reviewed against moved')
    expect(continued.reason).toContain('capability resolution moved')
    const proposal = await proposalOf(h, pending.proposalId)
    expect(proposal.status).toBe('stale')
    // The approval stays readable, and nothing of the batch ran.
    expect(proposal.decision?.outcome).toBe('approved')
    expect(h.spawned).toHaveLength(0)
    expect(taskEvents(h).some(event => event.kind === 'TaskDecomposed')).toBe(false)
  })

  test('a verifier this deployment can no longer name marks the batch stale rather than admitting it', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([
      childSpec('task a', {
        acceptanceCriteria: [{ description: 'task a works', command: 'true', verifierRef: 'command' }],
      }),
    ])

    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await approveInStore(h, pending.proposalId)
    h.dropVerifierId('command')

    const continued = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION, { spec })
    expect(continued.status).toBe('stale')
    if (continued.status !== 'stale') throw new Error('unreachable')
    expect(continued.reason).toContain('references unknown verifier "command"')
    expect((await proposalOf(h, pending.proposalId)).status).toBe('stale')
    expect(h.spawned).toHaveLength(0)
  })

  test('limits that moved between the submission and the approval mark the batch stale', async () => {
    const h = harness({ config: { generatedTaskReview: 'all', maxDepth: 4, budget: { maxToolCalls: 150 } } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await approveInStore(h, pending.proposalId)

    // The deployment restarts under a tighter growth guardrail: the batch content
    // is unchanged, the limits an approval bound are not.
    const h2 = h.restart({ maxChildren: 2 })
    await h2.task.openStore(STORE)
    const continued = await h2.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION, { spec })
    expect(continued.status).toBe('stale')
    if (continued.status !== 'stale') throw new Error('unreachable')
    expect(continued.reason).toContain('the limits in force moved')
    expect((await h2.runtime.proposalIn(STORE, pending.proposalId)).status).toBe('stale')
    expect(h2.spawned).toHaveLength(0)
  })

  test('two approved batches for one parent admit exactly one, and the loser is marked stale with its reason', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const specA = batchSpec([childSpec('task a')], 'split one way')
    const specB = batchSpec([childSpec('task b')], 'split another way')
    // One proposal at a time (K1 §1): the second submission is refused by name
    // while the first is in flight, so two proposals for one run can only arise
    // the way an approval from elsewhere does — written into the store by a
    // process that raced this one (a second process's approval).
    const first = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, specA)
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, specB)).rejects.toThrow(
      /decomposition refused: an open decomposition proposal must be continued or cancelled/,
    )
    await approveInStore(h, first.proposalId)

    // The first proposal is admitted, and the run now holds an unfinished batch.
    const admitted = await h.runtime.continueProposal(STORE, first.proposalId, ROOT_SESSION, { spec: specA })
    expect(admitted.status).toBe('admitted')
    if (admitted.status !== 'admitted') throw new Error('unreachable')

    // The raced approval's proposal is written directly into the store — the
    // shape a second process's interleaving leaves — and its continuation has to
    // meet the state the run is in *now*, not the one it proposed into.
    const secondProposal = await seedRacedProposal(h, specB, { taskId, runId })
    await approveInStore(h, secondProposal)
    const loser = await h.runtime.continueProposal(STORE, secondProposal, ROOT_SESSION, { spec: specB })
    expect(loser.status).toBe('stale')
    if (loser.status !== 'stale') throw new Error('unreachable')
    expect(loser.reason).toContain(`already waiting on batch "${admitted.batchId}"`)
    expect((await proposalOf(h, secondProposal)).status).toBe('stale')

    const snapshot = await h.task.snapshotIn(STORE)
    expect(childTasks(snapshot, taskId)).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(1)
    // The winner's batch is the one that exists, bound to the winner's proposal.
    const winnerProposal = await proposalOf(h, first.proposalId)
    expect(winnerProposal.status).toBe('admitted')
    expect(consumedBatch(winnerProposal).childTaskIds).toEqual(childTasks(snapshot, taskId).map(task => task.taskId))
    expect(await h.runtime.awaitBatch(STORE, consumedBatch(winnerProposal).batchId)).toHaveLength(1)
  })

  test('a continuation re-checks the run it is about: a run that left the deciding phase is refused by name', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const first = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
      {
        requestKey: 'k-before-submit',
      },
    )
    await approveInStore(h, first.proposalId)

    // The run hands its own result in while the approval waits: a late
    // continuation must re-check what the run *is*, not what it was when the
    // batch was proposed (K1 §3). The refusal is by name, and it writes nothing:
    // the run's state can still be a fact of somebody else's settlement.
    expect(await h.runtime.submitResult(ROOT_SESSION, { summary: 'the run is done here' })).toMatchObject({
      status: 'verified',
    })
    await expect(
      h.runtime.continueProposal(STORE, first.proposalId, ROOT_SESSION, { spec: batchSpec([childSpec('task a')]) }),
    ).rejects.toThrow(/only an active run may admit a batch/)
    const after = await proposalOf(h, first.proposalId)
    expect(after.status).toBe('approved')
    expect(taskEvents(h).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
    expect(childTasks(await h.task.snapshotIn(STORE), taskId)).toHaveLength(0)
  })

  test('a batch that ended hands the run back: the same run proposes and admits a second batch, members accumulating', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)

    const first = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')], 'the first round'),
    )
    if (first.status !== 'admitted') throw new Error('unreachable')
    expect((await h.runtime.awaitBatch(STORE, first.batchId)).map(outcome => outcome.status)).toEqual(['verified'])

    // The run took execution back with its first batch's members accumulated,
    // and nothing about the first batch's proposal holds it any more.
    const handedBack = await h.task.runIn(STORE, runId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.batchId).toBeUndefined()
    expect(handedBack.batches?.map(batch => batch.memberTaskIds)).toEqual([first.childTaskIds])

    const second = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task b')], 'the second round'),
    )
    if (second.status !== 'admitted') throw new Error('unreachable')
    expect(second.batchId).not.toBe(first.batchId)
    expect((await h.runtime.awaitBatch(STORE, second.batchId)).map(outcome => outcome.status)).toEqual(['verified'])

    // The old members are not renumbered and the new batch names its own: one
    // run, two batches, in admission order (K1 §4).
    const accumulated = await h.task.runIn(STORE, runId)
    expect(accumulated.batches?.map(batch => batch.batchId)).toEqual([first.batchId, second.batchId])
    expect(accumulated.batches?.map(batch => batch.memberTaskIds)).toEqual([first.childTaskIds, second.childTaskIds])
    expect((await h.task.runMembersIn(STORE, runId)).map(task => task.taskId)).toEqual([
      ...first.childTaskIds,
      ...second.childTaskIds,
    ])
    // Each batch is read back as its own, never as the task's whole child list.
    expect((await h.runtime.awaitBatch(STORE, first.batchId)).map(outcome => outcome.taskId)).toEqual(
      first.childTaskIds,
    )
    expect((await h.runtime.awaitBatch(STORE, second.batchId)).map(outcome => outcome.taskId)).toEqual(
      second.childTaskIds,
    )
  })

  test('a continuation is idempotent: an admitted proposal answers with its own batch and never admits twice', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const decided = await h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    if (decided.continuation?.status !== 'admitted') throw new Error('unreachable')

    const again = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION, { spec })
    expect(again.status).toBe('admitted')
    if (again.status !== 'admitted') throw new Error('unreachable')
    expect(again.batchId).toBe(decided.continuation.batchId)
    expect(again.childTaskIds).toEqual(decided.continuation.childTaskIds)
    expect(batchAdmissions(h)).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated' && event.taskId !== taskId)).toHaveLength(1)
  })

  test('a restart continues an approved proposal from the store alone, and a re-presented batch is only ever a confirmation', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await approveInStore(h, pending.proposalId)

    // A process that never held the batch continues it from the record: the
    // proposal carries the contracts the approval was made against (§6).
    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const continued = await restarted.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(continued.status).toBe('admitted')
    if (continued.status !== 'admitted') throw new Error('unreachable')
    await restarted.runtime.awaitBatch(STORE, continued.batchId)
    expect(restarted.spawned).toHaveLength(1)
    const admitted = await restarted.runtime.proposalIn(STORE, pending.proposalId)
    expect(consumedBatch(admitted).childTaskIds).toEqual(continued.childTaskIds)
    // The tasks that exist are the stored batch's contracts — the content a
    // reviewer read, not a copy somebody re-sent.
    const child = (await restarted.task.snapshotIn(STORE)).tasks.find(task => task.taskId === continued.childTaskIds[0])
    expect(child?.contract?.objective).toBe('task a')
    expect(child?.objective).toBe(storedBatch(admitted)[0]?.contract.objective)

    // A re-presented batch is a confirmation, not a substitute. The same batch is
    // accepted (a second continuation is answered from the consumption anyway),
    // and a *different* one is refused by name.
    const second = await createSecondParent(h)
    const third = await h.runtime.submitDecompositionProposal(
      STORE,
      second.taskId,
      second.runId,
      second.sessionId,
      batchSpec([childSpec('task b')]),
    )
    const thirdProposal = await proposalOf(h, third.proposalId)
    await h.task.decideProposalIn(
      STORE,
      {
        proposalId: third.proposalId,
        outcome: 'approved',
        proposalDigest: thirdProposal.proposalDigest,
        admissionContextDigest: thirdProposal.admissionContextDigest,
        reviewContextDigest: thirdProposal.reviewContextDigest,
        decidedBy: REVIEWER,
        decidedAt: new Date().toISOString(),
      },
      REVIEWER,
    )
    const fourth = h.restart()
    await fourth.task.openStore(STORE)
    await expect(
      fourth.runtime.continueProposal(STORE, third.proposalId, second.sessionId, {
        spec: batchSpec([childSpec('task c')]),
      }),
    ).rejects.toThrow(/is a different one/)
    expect(fourth.spawned).toHaveLength(0)
    // The matching batch is accepted and admits exactly the stored content.
    const confirmed = await fourth.runtime.continueProposal(STORE, third.proposalId, second.sessionId, {
      spec: batchSpec([childSpec('task b')]),
    })
    expect(confirmed.status).toBe('admitted')
    if (confirmed.status !== 'admitted') throw new Error('unreachable')
    const thirdChild = (await fourth.task.snapshotIn(STORE)).tasks.find(
      task => task.taskId === confirmed.childTaskIds[0],
    )
    expect(thirdChild?.contract?.objective).toBe('task b')
  })

  test('a batch tampered with in the store — bypassing the service — is refused by name when the store is replayed', async () => {
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

    // A hand-edited log: the stored content no longer hashes to the identity it
    // was submitted with. Nothing here goes through the service — the reducer is
    // what has to catch it, and it does so by name at replay.
    const events = h.sessions.get(STORE)?.events as unknown as {
      data: { kind: string; payload: { proposal?: { batch: { contract: { objective: string } }[] } } }
    }[]
    // The *batch's* submission, not the root intake's: the root's own proposal
    // rides the reserved envelope id and carries a contract instead of children.
    const submitted = events.find(
      event =>
        event.data.kind === 'TaskProposalSubmitted' &&
        (event.data.payload.proposal as { batch?: unknown } | undefined)?.batch !== undefined,
    )
    if (submitted?.data.payload.proposal === undefined) throw new Error('unreachable')
    submitted.data.payload.proposal.batch[0]!.contract.objective = 'task a, quietly rewritten'

    const restarted = h.restart()
    await expect(restarted.task.openStore(STORE)).rejects.toThrow(
      /contract digest ".*" does not match its identity digest/,
    )
  })
})

describe('TaskRuntime recovery (§6 restart and idempotency)', () => {
  test('crash point 1: a waiting proposal survives a restart untouched, and only a recorded decision moves it', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const eventsBefore = taskEvents(h).length

    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const report = await restarted.runtime.reconcileStore(STORE)

    // Still pending, still unadmitted, and nothing wrote: recovery does not
    // decide, and it does not pretend the batch ran.
    const proposal = await restarted.runtime.proposalIn(STORE, pending.proposalId)
    expect(proposal.status).toBe('pending_review')
    expect(proposal.decision).toBeUndefined()
    expect(taskEvents(h).length).toBe(eventsBefore)
    expect(restarted.spawned).toHaveLength(0)
    // Nothing was left undone: the review was asked again, from the *saved*
    // facts — the request carries the batch the store holds, not a summary — so
    // the person who has to decide sees the contracts the proposal recorded.
    expect(report.unresolvedProposals).toEqual([])
    expect(restarted.reviewCalls).toEqual([
      {
        storeId: STORE,
        trigger: 'recovered',
        proposalId: pending.proposalId,
        status: 'pending_review',
        kind: 'decomposition',
        hasBatch: true,
        parentObjective: 'ship the release',
        childObjectives: ['task a'],
        // The display material is the *saved batch*: the criteria the proposal
        // recorded, criterion id and description included.
        childCriteria: storedBatch(proposal).flatMap(child =>
          child.contract.acceptanceCriteria.map(
            criterion => `${child.contract.objective}:${criterion.criterionId}:${criterion.description}`,
          ),
        ),
        obligations: 0,
      },
    ])

    // A decision in the new process is recorded *and* continued from the store:
    // the approval taken after the restart is the same batch, and it runs.
    const decided = await restarted.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.status).toBe('admitted')
    expect(decided.continuation?.status).toBe('admitted')
    if (decided.continuation?.status !== 'admitted') throw new Error('unreachable')
    await restarted.runtime.awaitBatch(STORE, decided.continuation.batchId)
    expect(restarted.spawned).toHaveLength(1)
    expect(batchAdmissions(h)).toHaveLength(1)
  })

  test('crash point 2: an approval saved before a restart is continued by the recovery pass, and the batch is admitted once', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    // The decision is on the record and the process that made it is gone before
    // the continuation ran.
    const proposal = await proposalOf(h, pending.proposalId)
    await h.task.decideProposalIn(
      STORE,
      {
        proposalId: pending.proposalId,
        outcome: 'approved',
        proposalDigest: proposal.proposalDigest,
        admissionContextDigest: proposal.admissionContextDigest,
        reviewContextDigest: proposal.reviewContextDigest,
        decidedBy: REVIEWER,
        decidedAt: new Date().toISOString(),
      },
      REVIEWER,
    )

    // A *different* process — the process that crashed and was reopened — is the
    // one that recovers: it never held the batch, and no caller re-presents
    // anything.
    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const report = await restarted.runtime.reconcileStore(STORE)
    expect(report.unresolvedProposals).toEqual([])
    const continued = await restarted.runtime.proposalIn(STORE, pending.proposalId)
    expect(continued.status).toBe('admitted')
    expect(consumedBatch(continued).childTaskIds).toHaveLength(1)
    const snapshot = await restarted.task.snapshotIn(STORE)
    expect(childTasks(snapshot, taskId).map(task => task.taskId)).toEqual(consumedBatch(continued).childTaskIds)
    // No second batch, one consumption, and the recovered batch is driven to its
    // settlement by the process that adopted the store.
    expect(taskEvents(h).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(1)
    expect(batchAdmissions(h)).toHaveLength(1)
    const outcomes = await restarted.runtime.awaitBatch(STORE, consumedBatch(continued).batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The tasks are the stored batch's content, and the ids are stable across the
    // recovery (a later continuation answers from the same consumption).
    const again = await restarted.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(again.status === 'admitted' ? again.childTaskIds : []).toEqual(consumedBatch(continued).childTaskIds)
  })

  test('crash point 3: a committed admission is driven again from the same batch, never admitted a second time', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a'), childSpec('task b')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const proposal = await proposalOf(h, pending.proposalId)

    // The state a crash between "admission committed" and "first spawn" leaves:
    // the children, the parent's phase change and the consumption are the store's
    // already, written through the real entries, and no driver exists for them.
    // The approval and the re-check that make an admission legal from `ready` are
    // on the record too, exactly as the runtime writes them.
    await h.task.decideProposalIn(
      STORE,
      {
        proposalId: pending.proposalId,
        outcome: 'approved',
        proposalDigest: proposal.proposalDigest,
        admissionContextDigest: proposal.admissionContextDigest,
        reviewContextDigest: proposal.reviewContextDigest,
        decidedBy: REVIEWER,
        decidedAt: new Date().toISOString(),
      },
      REVIEWER,
    )
    await h.task.changeProposalPhaseIn(
      STORE,
      {
        proposalId: pending.proposalId,
        to: 'ready',
        reason: 'the post-approval re-check passed (seeded: this test starts after it)',
      },
      ROOT_SESSION,
    )
    const childTaskIds = ['t-crash-a', 't-crash-b']
    const derivedBatchId = batchIdFor(runId, pending.proposalId)
    const children = childTaskIds.map((taskId_, index) => ({
      taskId: taskId_,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: taskId,
      objective: `task ${index}`,
      depth: 1,
      acceptanceCriteria: [
        {
          criterionId: `ac${index + 1}-1`,
          description: `task ${index} works`,
          verificationMode: 'deterministic' as const,
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
        },
      ],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'leaf' as const,
      status: 'created' as const,
      runIds: [],
      childTaskIds: [],
    }))
    await h.task.admitBatchIn(
      STORE,
      taskId,
      runId,
      children,
      'tester',
      [],
      undefined,
      [
        { capabilities: { 'execute-task': { tools: [], skills: ['task-execution'] } }, missing: [], closure: 'closed' },
        { capabilities: { 'execute-task': { tools: [], skills: ['task-execution'] } }, missing: [], closure: 'closed' },
      ],
      {
        proposalId: pending.proposalId,
        proposalDigest: proposal.proposalDigest,
        reviewContextDigest: proposal.reviewContextDigest,
        parentRunId: runId,
        batchId: derivedBatchId,
        childTaskIds,
        admittedAt: new Date().toISOString(),
      },
    )
    expect((await proposalOf(h, pending.proposalId)).status).toBe('admitted')
    expect(h.spawned).toHaveLength(0)

    // A restarted process reconciles the store: the waiting batch is restarted
    // from its own record, and the proposal is not consumed again.
    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const report = await restarted.runtime.reconcileStore(STORE)
    expect(report.unresolvedProposals).toEqual([])
    const outcomes = await restarted.runtime.awaitBatch(STORE, derivedBatchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(outcomes.map(outcome => outcome.taskId)).toEqual(childTaskIds)
    expect(childTasks(await restarted.task.snapshotIn(STORE), taskId).map(task => task.taskId)).toEqual(childTaskIds)
    expect(batchAdmissions(h)).toHaveLength(1)
  })

  test('crash point 4: a settled run is reconnected by identity and its batch is never rebuilt', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)
    const admitted = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (admitted.status !== 'admitted') throw new Error('unreachable')
    await h.runtime.awaitBatch(STORE, admitted.batchId)
    const childSession = h.spawned[0]?.sessionId as string
    const eventsBefore = taskEvents(h).length

    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const bound = await restarted.runtime.runForSession(childSession)
    expect(bound.task.taskId).toBe(admitted.childTaskIds[0])
    const report = await restarted.runtime.reconcileStore(STORE)
    expect(report.unresolvedProposals).toEqual([])
    // Nothing was rebuilt: the same runs, the same children, the same admission.
    expect(taskEvents(h).length).toBe(eventsBefore)
    expect(restarted.spawned).toHaveLength(0)
    const proposal = await restarted.runtime.proposalIn(STORE, admitted.proposalId)
    expect(proposal.status).toBe('admitted')
    expect(consumedBatch(proposal).childTaskIds).toEqual(admitted.childTaskIds)
  })

  test('a restart with the policy tightened sends an unadmitted off-born batch for review, and never admits it unreviewed', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const submitted = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, spec)
    expect((await proposalOf(h, submitted.proposalId)).status).toBe('ready')

    const tightened = h.restart({ generatedTaskReview: 'all' })
    await tightened.task.openStore(STORE)
    const report = await tightened.runtime.reconcileStore(STORE)
    expect(report.unresolvedProposals).toEqual([
      {
        proposalId: submitted.proposalId,
        status: 'pending_review',
        reason: expect.stringContaining('sent for review'),
      },
    ])
    expect((await tightened.runtime.proposalIn(STORE, submitted.proposalId)).status).toBe('pending_review')
    expect(tightened.spawned).toHaveLength(0)

    // The tightened process does not admit it even when its content is presented;
    // the review is now the only way forward.
    const continued = await tightened.runtime.continueProposal(STORE, submitted.proposalId, ROOT_SESSION, { spec })
    expect(continued.status).toBe('pending_review')
    expect(tightened.spawned).toHaveLength(0)
  })

  test('a restart with the policy loosened does not release a proposal that is already waiting', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')

    const loosened = h.restart({ generatedTaskReview: 'off' })
    await loosened.task.openStore(STORE)
    const report = await loosened.runtime.reconcileStore(STORE)
    // Loosening the policy is not a release: the proposal stays waiting, and the
    // review is asked again (a waiting proposal keeps waiting until a decision,
    // §5) rather than quietly released or admitted.
    expect(report.unresolvedProposals).toEqual([])
    expect(loosened.reviewCalls.map(call => call.trigger)).toEqual(['recovered'])
    const continued = await loosened.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION, { spec })
    expect(continued.status).toBe('pending_review')
    expect((await loosened.runtime.proposalIn(STORE, pending.proposalId)).status).toBe('pending_review')
    expect(loosened.spawned).toHaveLength(0)
  })
})

describe('TaskRuntime known waits (§7.4)', () => {
  test('a worker whose own batch is waiting for a review is a known wait: no round is marked and nothing is stopped', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const submitted = await h.runtime.decomposeAndRun(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    if (submitted.status !== 'pending_review') throw new Error('unreachable')
    await h.runtime.decideProposal(STORE, submitted.proposalId, { outcome: 'approved' }, REVIEWER)

    // The spawned worker proposes its own split (policy `all`, so it waits) and
    // then goes idle without submitting: an expected protocol wait.
    let firstIdle = true
    h.setIdleBehavior(async sessionId => {
      if (!firstIdle) return
      firstIdle = false
      const snapshot = await h.task.snapshotIn(STORE)
      const child = childTasks(snapshot, taskId)[0]
      if (child === undefined) throw new Error('no spawned child')
      const workerRun = snapshot.runs.find(run => run.taskId === child.taskId)
      if (workerRun === undefined) throw new Error('the worker has no run')
      await h.runtime.decomposeAndRun(
        STORE,
        child.taskId,
        workerRun.runId,
        sessionId,
        batchSpec([childSpec('grandchild')]),
      )
    })
    await vi.waitFor(() =>
      expect(h.reviewCalls.filter(call => call.kind === 'decomposition' && call.trigger === 'submitted')).toHaveLength(
        2,
      ),
    )

    const child = childTasks(await h.task.snapshotIn(STORE), taskId)[0] as { taskId: string }
    const workerRun = (await h.task.snapshotIn(STORE)).runs.find(run => run.taskId === child.taskId) as {
      runId: string
    }

    // The cancellation is the deterministic release: the driver settles the batch
    // only here, so the waiting child's terminal state is on the
    // record by the time this returns.
    const outcomes = await h.runtime.cancelBatch(STORE, (await h.task.runIn(STORE, runId)).batchId!, ROOT_SESSION)
    expect(
      taskEvents(h).filter(event => event.kind === 'RunProgressMarked' && event.runId === workerRun.runId),
    ).toHaveLength(0)
    expect(
      h.notifications.some(
        item => item.sessionId === h.spawned[0]?.sessionId && item.text.includes('went idle without submitting'),
      ),
    ).toBe(false)
    expect((await h.task.runIn(STORE, workerRun.runId)).status).toBe('cancelled')
    expect(h.cancelled).toContain(h.spawned[0]?.sessionId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const review = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === workerRun.runId)
    expect(review?.localizedCause ?? '').not.toContain('no progress')
  })
})

describe('TaskRuntime pre-check scope and obligations (§2)', () => {
  test('the pre-check records the capability gap exactly once, and a contract defect before it records nothing at all', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)

    // A contract defect refuses before the capability stage: the pre-check wrote
    // nothing, so there is no obligation to show.
    await expect(
      h.runtime.submitDecompositionProposal(
        STORE,
        taskId,
        runId,
        ROOT_SESSION,
        batchSpec([childSpec('task a', { acceptanceCriteria: [{ description: '', command: 'true' }] })]),
      ),
    ).rejects.toThrow(/criterion "ac1-1" description must be a non-empty string/)
    expect((await h.task.snapshotIn(STORE)).obligations).toHaveLength(0)

    // A capability gap is a fact: the refusal carries it, and the submission
    // raises exactly one obligation per missing capability on the parent — once
    // per refusal, never twice for one refusal (the pre-check wrote nothing).
    const gapSpec = batchSpec([childSpec('task a', { requiredCapabilities: ['fly-to-moon'] })])
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, gapSpec)).rejects.toThrow(
      /capability gap/,
    )
    const obligations = (await h.task.snapshotIn(STORE)).obligations
    expect(obligations).toHaveLength(1)
    expect(obligations[0]?.sourceTaskId).toBe(taskId)
    expect(obligations[0]?.goal).toContain('capability "fly-to-moon" required by child 0')
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, gapSpec)).rejects.toThrow(
      /capability gap/,
    )
    const repeated = (await h.task.snapshotIn(STORE)).obligations
    expect(repeated).toHaveLength(2)
    expect(repeated[1]?.goal).toBe(obligations[0]?.goal)

    // Refused batches leave no proposal and never ask a person (the root's own
    // intake was reviewed in the setup; nothing was asked about either batch).
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(0)
    expect(h.reviewCalls.filter(call => call.kind === 'decomposition')).toHaveLength(0)
    expect(h.spawned).toHaveLength(0)
  })

  test('the review context records what the batch actually resolved against, and only that', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([
      childSpec('task a', {
        acceptanceCriteria: [
          { description: 'judged by the command verifier', command: 'true', verifierRef: 'command' },
          { description: 'also judged the same way', command: 'true', verifierRef: 'command' },
        ],
      }),
    ])

    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const proposal = await proposalOf(h, pending.proposalId)
    // The verifier list is the ids this batch pins, deduplicated; the manifest
    // digest is the folded identity of its resolution. Neither claims a content
    // version this registry cannot report.
    expect(proposal.reviewContext.verifiers).toEqual([{ verifierId: 'command' }])
    expect(proposal.reviewContext.capabilityManifestDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(proposal.reviewContextDigest).toMatch(/^[0-9a-f]{64}$/)

    // An unrelated capability row is not part of what this batch resolved: adding
    // one does not invalidate the review.
    await approveInStore(h, pending.proposalId)
    await h.runtime.applyCapabilityRow('unrelated-thing', { tools: ['bash'] })
    const continued = await h.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION, { spec })
    expect(continued.status).toBe('admitted')
  })

  test('an open proposal is exactly the unadmitted one, which is what the known wait reads', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    expect(isOpenProposal(await proposalOf(h, pending.proposalId))).toBe(true)
    expect(openProposalOf(await h.task.snapshotIn(STORE), taskId, runId)?.proposalId).toBe(pending.proposalId)
    // A run of the same task that is not the one the proposal names is not
    // waiting on it.
    expect(openProposalOf(await h.task.snapshotIn(STORE), taskId, 'r-other')).toBeUndefined()

    const decided = await h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.status).toBe('admitted')
    expect(isOpenProposal(await proposalOf(h, pending.proposalId))).toBe(false)
    expect(openProposalOf(await h.task.snapshotIn(STORE), taskId, runId)).toBeUndefined()
  })
})

describe('TaskRuntime compatibility entry (§6)', () => {
  test('a decided-against batch is refused by name from the compatibility entry', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a')])
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'rejected', reason: 'not this' }, REVIEWER)

    // The same call again finds the rejected record and says so: a rejection is
    // not something a retry of the same batch can move past.
    await expect(h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)).rejects.toThrow(
      /is rejected \(proposal p-[0-9a-f]+\): proposal "p-[0-9a-f]+" is rejected; nothing was admitted/,
    )
    expect(h.spawned).toHaveLength(0)
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(1)
  })

  test('off returns the batch, all returns the waiting proposal, and an approval then admits it through the same entry', async () => {
    const off = harness({ config: { generatedTaskReview: 'off' } })
    const offRoot = await createRoot(off)
    const admitted = await off.runtime.decomposeAndRun(
      STORE,
      offRoot.taskId,
      offRoot.runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a')]),
    )
    expect(admitted).toMatchObject({ status: 'admitted', batchId: batchIdFor(offRoot.runId, admitted.proposalId) })
    expect(admitted.status === 'admitted' ? admitted.childTaskIds : []).toHaveLength(1)

    const on = harness({ config: { generatedTaskReview: 'all' } })
    const onRoot = await createRoot(on)
    const spec = batchSpec([childSpec('task a')])
    const pending = await on.runtime.decomposeAndRun(STORE, onRoot.taskId, onRoot.runId, ROOT_SESSION, spec)
    expect(pending.status).toBe('pending_review')
    expect(pending.status === 'pending_review' ? pending.detail : '').toContain('waiting for a review')

    // The approval is what turns the same request into a batch, and the retry of
    // the same request under the compatibility entry completes it.
    const decided = await on.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.status).toBe('admitted')
    const retried = await on.runtime.decomposeAndRun(STORE, onRoot.taskId, onRoot.runId, ROOT_SESSION, spec)
    expect(retried.status).toBe('admitted')
    expect(retried.status === 'admitted' ? retried.childTaskIds : []).toEqual(
      decided.continuation?.status === 'admitted' ? decided.continuation.childTaskIds : [],
    )
  })
})

describe('TaskRuntime root budget through the proposal path (§6)', () => {
  test('a proposal reserves nothing, a withdrawal refunds nothing, and the budget is accounted at admission', async () => {
    const h = harness({ config: { generatedTaskReview: 'all', rootBudget: { maxRuns: 2 } } })
    const { taskId, runId } = await createRoot(h)
    const runsBefore = (await h.task.snapshotIn(STORE)).runs.length

    // A batch of two children would need two more runs of a budget that has one
    // slot left. Proposing it reserves nothing: a proposal waiting for a review
    // holds no run slot (the accounting stays where the side effect is, §6).
    const tooBig = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a'), childSpec('task b')]),
    )
    expect((await proposalOf(h, tooBig.proposalId)).status).toBe('pending_review')
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore)

    // Withdrawing it refunds nothing either — there was nothing to refund, and a
    // re-proposal does not start the budget over.
    await h.runtime.cancelProposal(STORE, tooBig.proposalId, ROOT_SESSION)
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore)

    // The accounting happens at admission. An oversized batch proposed in its own
    // right is recorded — a proposal holds no run slot — and it is the admission
    // that refuses it, from the store's own count.
    const oversized = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task a'), childSpec('task b')], 'the same oversized split, proposed again'),
    )
    expect((await proposalOf(h, oversized.proposalId)).status).toBe('pending_review')
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore)
    const decision = await h.runtime.decideProposal(STORE, oversized.proposalId, { outcome: 'approved' }, REVIEWER)
    // The approval landed and the continuation could not admit the batch, so the
    // answer is the pair of facts: the outcome, and where the proposal stands —
    // `ready`, the phase a passed re-check leaves it in.
    expect(decision.outcome).toBe('approved')
    expect(decision.status).toBe('ready')
    expect(decision.detail).toContain('the root budget allows 2 run(s)')
    // The approval and the re-check that passed are both on the record — `ready`
    // is where the phase machine leaves a batch that may run — while the
    // admission itself was refused, so nothing is consumed and a later
    // continuation may admit the same batch once the budget allows it.
    const refusedProposal = await proposalOf(h, oversized.proposalId)
    expect(refusedProposal.status).toBe('ready')
    expect(refusedProposal.consumption).toBeUndefined()
    expect(refusedProposal.decision?.outcome).toBe('approved')
    await h.runtime.cancelProposal(STORE, oversized.proposalId, ROOT_SESSION)

    // A batch that fits is admitted, and the run it starts is what the budget
    // then counts.
    const fits = await h.runtime.submitDecompositionProposal(
      STORE,
      taskId,
      runId,
      ROOT_SESSION,
      batchSpec([childSpec('task c')]),
    )
    const admitted = await h.runtime.decideProposal(STORE, fits.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(admitted.status).toBe('admitted')
    if (admitted.continuation?.status !== 'admitted') throw new Error('unreachable')
    await h.runtime.awaitBatch(STORE, admitted.continuation.batchId)
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore + 1)

    // No slot is left now. The count is the store's, so it is read where the
    // batch would start: another tree's proposal is refused by name before it is
    // recorded, and nothing about it exists afterwards.
    const second = await createSecondParent(h)
    await expect(
      h.runtime.submitDecompositionProposal(
        STORE,
        second.taskId,
        second.runId,
        second.sessionId,
        batchSpec([childSpec('task d')]),
      ),
    ).rejects.toThrow(/decomposition refused: root run budget is exhausted/)
    expect(h.spawned).toHaveLength(1)
  })
})

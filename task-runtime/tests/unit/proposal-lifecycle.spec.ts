/**
 * The T2/T3 proposal lifecycle, end to end through the real runtime and store:
 * the review policy's two modes, the pure pre-check's ordering, the approval's
 * binding, the post-approval re-check, the request-key rules and the crash
 * points of §5–§6. Everything here reads its conclusions back from the store
 * (the proposal record, the task graph, the event log) or from a counting
 * channel — never from a writer's return value, which is what makes these tests
 * about the mechanism rather than about the API's shape.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  EvidenceBundle,
  TaskEvent,
  TaskProposal,
  VerificationResult,
} from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, DecomposeSpec } from '../../src/index.ts'
import {
  TaskRuntime,
  isOpenProposal,
  openProposalOf,
} from '../../src/index.ts'
import { releaseSkillHomes } from '../support/skill-roots.ts'

const ROOT_SESSION = 'root-session'
const REVIEWER = 'reviewer-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/** One review request the runtime made, as the channel saw it. */
interface ReviewCall {
  readonly storeId: string
  readonly trigger: string
  readonly proposalId: string
  readonly status: string
  readonly hasBatch: boolean
  /** §5's display content, as the request carried it: the parent's objective, the children's contracts, the obligations on the parent. */
  readonly parentObjective: string
  readonly childObjectives: readonly string[]
  readonly childCriteria: readonly string[]
  readonly obligations: number
}

function harness(
  options: { config?: Partial<Config>; shared?: Map<string, StoredSession>; sessionIds?: string[] } = {},
) {
  const sessions = options.shared ?? new Map<string, StoredSession>()
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }

  const spawned: { sessionId: string; name: string; prompt: string }[] = []
  const cancelled: string[] = []
  const notifications: { sessionId: string; text: string }[] = []
  const liveAgents = new Map<string, unknown>()
  let idleBehavior: ((sessionId: string) => Promise<void>) | undefined
  const parentAgent = {
    id: ROOT_SESSION,
    status: 'idle',
    followup: (message: { content: readonly { text?: string }[] }) => {
      notifications.push({ sessionId: ROOT_SESSION, text: message.content.map(block => block.text ?? '').join('\n') })
    },
    cancel: vi.fn(() => {}),
  }
  const agentRuntime = {
    spawn: vi.fn(async (_parent: unknown, request: {
      sessionId: string
      name: string
      prompt: Array<{ type: 'text'; text: string }>
    }) => {
      spawned.push({
        sessionId: request.sessionId,
        name: request.name,
        prompt: request.prompt.map(block => block.text).join('\n'),
      })
      let releaseIdle: (() => void) | undefined
      const agent = {
        id: request.sessionId,
        cancel: vi.fn(() => {
          cancelled.push(request.sessionId)
          releaseIdle?.()
        }),
        whenIdle: vi.fn(() => new Promise<void>((resolve, reject) => {
          releaseIdle = resolve
          void (idleBehavior ?? defaultIdle)(request.sessionId).then(resolve, reject)
        })),
        followup: (message: { content: readonly { text?: string }[] }) => {
          notifications.push({ sessionId: request.sessionId, text: message.content.map(block => block.text ?? '').join('\n') })
        },
      }
      liveAgents.set(request.sessionId, agent)
      return { agent, dispose: vi.fn(async () => {}) }
    }),
  }
  const graphs = {
    graphForSession: vi.fn(async (_sessionId: string) => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: ROOT_SESSION,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
      createdAt: 0,
      ready: true,
    })),
  }

  let taskService!: TaskService
  let verifierIds = ['command', 'composite', 'review']
  const verifier = {
    verifierIds: vi.fn(() => verifierIds),
    verifyRun: vi.fn(async (storeId: string, runId: string): Promise<EvidenceBundle> => {
      const run = await taskService.runIn(storeId, runId)
      const instance = await taskService.taskIn(storeId, run.taskId)
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'pass',
        verifierId: 'fake-verifier',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: run.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: 'fake-verifier',
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await taskService.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    }),
  }

  /**
   * The review channel (T2/T3 §5): a counting stand-in for the approval channel
   * stage C wires. `requested: false` models a deployment that shows nothing.
   */
  const reviewCalls: ReviewCall[] = []
  let reviewRequested = true
  const channel = {
    requestReview: vi.fn(async (request: {
      storeId: string
      trigger: string
      proposal: TaskProposal
      parentTask: { objective: string }
      batch: { children: readonly { contract: { objective: string; acceptanceCriteria: readonly { criterionId: string; description: string }[] } }[] }
      obligations: readonly unknown[]
    }) => {
      reviewCalls.push({
        storeId: request.storeId,
        trigger: request.trigger,
        proposalId: request.proposal.proposalId,
        status: request.proposal.status,
        hasBatch: request.batch !== undefined,
        parentObjective: request.parentTask.objective,
        childObjectives: request.batch.children.map(child => child.contract.objective),
        childCriteria: request.batch.children.flatMap(child =>
          child.contract.acceptanceCriteria.map(criterion => `${child.contract.objective}:${criterion.criterionId}:${criterion.description}`)),
        obligations: request.obligations.length,
      })
      return reviewRequested ? { requested: true, detail: 'asked the reviewer' } : { requested: false, detail: 'nobody is watching' }
    }),
  }

  const listeners = new Map<string, Set<(...args: never[]) => unknown>>()
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: () => {},
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) (listener as (...a: unknown[]) => unknown)(...args)
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    sessionPersistence: persistence,
    agentRuntime,
    agents: { get: (sessionId: string) => (sessionId === ROOT_SESSION ? parentAgent : liveAgents.get(sessionId) ?? { id: sessionId }) },
    graphs,
    proposalReviewChannel: channel,
  }
  taskService = new TaskService(ctx as never)
  ctx.task = taskService
  ctx.verifier = verifier
  const runtime = new TaskRuntime(ctx as never, options.config as Config | undefined)
  const defaultIdle = async (sessionId: string): Promise<void> => {
    await runtime.submitResult(sessionId, { summary: `done: ${sessionId}` })
  }
  return {
    ctx,
    sessions,
    task: taskService,
    runtime,
    verifier,
    channel,
    reviewCalls,
    spawned,
    cancelled,
    notifications,
    setReviewRequested: (value: boolean) => { reviewRequested = value },
    dropVerifierId: (id: string) => { verifierIds = verifierIds.filter(item => item !== id) },
    setIdleBehavior: (behavior: (sessionId: string) => Promise<void>) => { idleBehavior = behavior },
    /** A second runtime over the same store: a deployment restart with a different configuration (and no in-memory batch content). */
    restart: (config?: Partial<Config>) => harness({ config: { ...options.config, ...config }, shared: sessions }),
  }
}

type Harness = ReturnType<typeof harness>

async function createRoot(h: Harness, objective = 'ship the release') {
  return h.runtime.createRootTask(STORE, { objective, rootSessionId: ROOT_SESSION }, ROOT_SESSION)
}

function childSpec(objective: string, overrides: Record<string, unknown> = {}) {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    ...overrides,
  } as DecomposeSpec['children'][number]
}

function batchSpec(children: DecomposeSpec['children'], reason = 'split the work'): DecomposeSpec {
  return { reason, children }
}

function taskEvents(h: Harness): TaskEvent[] {
  const stored = h.sessions.get(STORE)
  if (stored === undefined) throw new Error('no store session')
  return stored.events
    .filter(event => event.type === 'task/event')
    .map(event => (event as unknown as { data: TaskEvent }).data)
}

function childTasks(snapshot: { tasks: readonly { taskId: string; parentTaskId?: string }[] }, parentTaskId: string) {
  return snapshot.tasks.filter(task => task.parentTaskId === parentTaskId)
}

async function proposalOf(h: Harness, proposalId: string): Promise<TaskProposal> {
  return await h.runtime.proposalIn(STORE, proposalId)
}

/**
 * Write an approval the way a process that died between the decision and the
 * continuation leaves it: on the record, uncontinued, with nothing else written.
 */
async function approveInStore(h: Harness, proposalId: string): Promise<void> {
  const proposal = await proposalOf(h, proposalId)
  await h.task.decideProposalIn(STORE, {
    proposalId,
    outcome: 'approved',
    proposalDigest: proposal.proposalDigest,
    admissionContextDigest: proposal.admissionContextDigest,
    reviewContextDigest: proposal.reviewContextDigest,
    decidedBy: REVIEWER,
    decidedAt: new Date().toISOString(),
  }, REVIEWER)
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
    acceptanceCriteria: [{
      criterionId: 'sp-1',
      description: 'the second parent works',
      verificationMode: 'deterministic' as const,
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    assumptions: [],
    constraints: [],
    requiredCapabilities: [],
  }
  await h.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: contract.objective,
    depth: 0,
    acceptanceCriteria: contract.acceptanceCriteria,
    requestedCapabilities: [],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract,
  }, 'tester')
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'decomposable' })
  await h.task.startRunIn(STORE, {
    runId,
    taskId,
    sessionId,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  return { taskId, runId, sessionId }
}

describe('TaskRuntime review policy (§5)', () => {
  test('policy off admits synchronously, records policy-off and never asks a person', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)

    const admitted = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    expect(admitted.status).toBe('admitted')
    if (admitted.status !== 'admitted') throw new Error('unreachable')
    expect(admitted.childTaskIds).toHaveLength(1)

    // The audit record: born `ready` under policy `off`, and no review was ever
    // requested — `policy-off` is a fact, not a missing approval.
    const proposal = await proposalOf(h, admitted.proposalId)
    expect(proposal.policy).toBe('off')
    expect(proposal.status).toBe('admitted')
    expect(proposal.decision).toBeUndefined()
    expect(proposal.consumption?.childTaskIds).toEqual(admitted.childTaskIds)
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

    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
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
    expect(taskEvents(h).some(event => event.kind === 'TaskProposalAdmitted')).toBe(false)

    // The review was requested exactly once, and the request carried the batch
    // (a reviewer has to be shown the contracts, not only a digest).
    expect(h.reviewCalls).toEqual([{
      storeId: STORE,
      trigger: 'submitted',
      proposalId: pending.proposalId,
      status: 'pending_review',
      hasBatch: true,
      parentObjective: 'ship the release',
      childObjectives: ['task a'],
      childCriteria: ['task a:ac1-1:task a works'],
      obligations: 0,
    }])

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
    await expect(h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([
      childSpec('task a', { acceptanceCriteria: [{ description: 'nothing is required', command: 'true', mandatory: false }] }),
    ]))).rejects.toThrow(/requires at least one mandatory acceptance criterion/)

    expect(h.channel.requestReview).not.toHaveBeenCalled()
    expect(h.reviewCalls).toHaveLength(0)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  test('a policy the runtime cannot execute refuses to start, and a batch cannot carry the policy itself', async () => {
    const h = harness()
    // The configuration schema types the member, but a deployment that builds the
    // runtime directly bypasses it: an unknown mode refuses to start rather than
    // admitting unreviewed batches.
    expect(() => new TaskRuntime(h.ctx as never, { generatedTaskReview: 'risk' } as unknown as Config)).toThrow(
      /generatedTaskReview is "risk"; the review policy is "off" or "all"/,
    )

    const { taskId, runId } = await createRoot(h)
    // The policy belongs to the deployment: a batch-level key is refused by name
    // by the one normalization entry, never dropped and never honoured.
    await expect(h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      generatedTaskReview: 'off',
      children: [childSpec('task a')],
    } as unknown as DecomposeSpec)).rejects.toThrow(/declares unknown field "generatedTaskReview"/)
  })
})

describe('TaskRuntime proposal decisions (§6)', () => {
  test('an approval admits the batch it was made against, and the decision binds all three identities', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
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
    expect(childTasks(await h.task.snapshotIn(STORE), taskId).map(task => task.taskId)).toEqual(proposal.consumption?.childTaskIds)
    const outcomes = await h.runtime.awaitBatch(STORE, decided.continuation?.status === 'admitted' ? decided.continuation.batchId : '')
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('a tampered decision is refused by the reducer: an approval never travels to another digest', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const proposal = await proposalOf(h, pending.proposalId)
    const before = await h.task.snapshotIn(STORE)

    // A decision naming another dossier, another context or another resolution is
    // not a decision about this batch — the store refuses each by name.
    await expect(h.task.decideProposalIn(STORE, {
      proposalId: pending.proposalId,
      outcome: 'approved',
      proposalDigest: '0'.repeat(64),
      admissionContextDigest: proposal.admissionContextDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)).rejects.toThrow(/does not match the stored proposal digest/)
    await expect(h.task.decideProposalIn(STORE, {
      proposalId: pending.proposalId,
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: '1'.repeat(64),
      reviewContextDigest: proposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)).rejects.toThrow(/does not match the stored admission context digest/)
    await expect(h.task.decideProposalIn(STORE, {
      proposalId: pending.proposalId,
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)).rejects.toThrow(/approval requires the review context digest/)
    await expect(h.task.decideProposalIn(STORE, {
      proposalId: pending.proposalId,
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      reviewContextDigest: '2'.repeat(64),
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)).rejects.toThrow(/does not match the stored review context digest/)

    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect((await proposalOf(h, pending.proposalId)).status).toBe('pending_review')
    expect(h.spawned).toHaveLength(0)
  })

  test('a rejection is terminal, keeps the batch unadmitted, and a revision is new content under a new key', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const first = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    if (first.status !== 'pending_review') throw new Error('unreachable')

    const rejected = await h.runtime.decideProposal(STORE, first.proposalId, { outcome: 'rejected', reason: 'the criterion is not checkable' }, REVIEWER)
    expect(rejected.status).toBe('rejected')
    expect((await proposalOf(h, first.proposalId)).decision?.reason).toBe('the criterion is not checkable')
    expect(h.spawned).toHaveLength(0)
    expect(taskEvents(h).some(event => event.kind === 'TaskDecomposed')).toBe(false)

    // A revision: different content (a stricter criterion) under its own key,
    // naming the proposal it replaces. It does not inherit the rejection's
    // opposite — it waits for its own decision.
    const revision = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([
      childSpec('task a', {
        acceptanceCriteria: [
          { description: 'task a works', command: 'true' },
          { description: 'task a is also measured', command: 'true' },
        ],
      }),
    ]), { supersedes: first.proposalId })
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
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([
      childSpec('task a', allOptional),
    ]))).rejects.toThrow(/requires at least one mandatory acceptance criterion/)

    const withHeuristic = batchSpec([childSpec('task a', {
      acceptanceCriteria: [{ description: 'task a works', command: 'true', mandatory: false, heuristic: true }],
    })])
    await expect(h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, withHeuristic)).rejects.toThrow(
      /requires at least one mandatory acceptance criterion/,
    )

    // Nothing was persisted by either attempt.
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(0)
    expect(taskEvents(h).some(event => event.kind === 'TaskProposalSubmitted')).toBe(false)

    // The legal fix — one mandatory criterion — is admitted, which is what makes
    // the two refusals above a rule rather than a wall.
    const admitted = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    expect(admitted.status).toBe('admitted')
    expect((await h.runtime.awaitBatch(STORE, admitted.status === 'admitted' ? admitted.batchId : '')).map(outcome => outcome.status))
      .toEqual(['verified'])
  })

  test('a withdrawal by anybody but the proposing session is refused; the proposing session cancels', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
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
    await expect(h.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)).rejects.toThrow(
      /illegal proposal transition "cancelled" → "approved"/,
    )
  })

  test('with no review channel the proposal stays pending and says so — a request is never an approval', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    delete h.ctx.proposalReviewChannel

    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
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
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalSubmitted')).toHaveLength(1)
  })

  test('the same key with different content is refused by name, and a revision gets its own key', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)

    await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]), {
      requestKey: 'caller-key-1',
    })
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task b')]), {
      requestKey: 'caller-key-1',
    })).rejects.toThrow(/request key "caller-key-1" is already bound to proposal "p-[0-9a-f]+", whose batch is a different one/)

    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(1)

    // The derived key of the same caller for *different* content differs, which
    // is what makes a revision a new request rather than a rewrite.
    const derivedA = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task c')]))
    const derivedB = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task d')]))
    expect((await proposalOf(h, derivedA.proposalId)).requestKey)
      .not.toBe((await proposalOf(h, derivedB.proposalId)).requestKey)
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(3)
  })
})

describe('TaskRuntime post-approval re-check (§6)', () => {
  test('a parent run that ended takes the approval down with it: expired, named, and nothing dispatched', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
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
    expect(taskEvents(h).some(event => event.kind === 'TaskProposalAdmitted')).toBe(false)
  })

  test('a capability resolution that moved marks the approval stale, naming what moved', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    await h.runtime.applyCapabilityRow('build-thing', { tools: ['bash'] })
    const { taskId, runId } = await createRoot(h)
    const spec = batchSpec([childSpec('task a', { requiredCapabilities: ['build-thing'] })])

    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, spec)
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await approveInStore(h, pending.proposalId)
    await h.runtime.applyCapabilityRow('build-thing', { tools: ['filesystem'] })

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
    const spec = batchSpec([childSpec('task a', {
      acceptanceCriteria: [{ description: 'task a works', command: 'true', verifierRef: 'command' }],
    })])

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
    const first = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, specA)
    const second = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, specB)
    await approveInStore(h, first.proposalId)
    await approveInStore(h, second.proposalId)

    // Both continuations race for the same parent. One parent decomposes once
    // (§6), so exactly one may win — the runtime serializes them per parent and
    // the loser's re-check sees the parent it was proposed for already gone.
    const [one, two] = await Promise.all([
      h.runtime.continueProposal(STORE, first.proposalId, ROOT_SESSION, { spec: specA }),
      h.runtime.continueProposal(STORE, second.proposalId, ROOT_SESSION, { spec: specB }),
    ])
    const statuses = [one.status, two.status].sort()
    expect(statuses).toEqual(['admitted', 'stale'])
    const stale = one.status === 'stale' ? one : two
    expect(stale.status === 'stale' ? stale.reason : '').toContain('already has a batch')

    const snapshot = await h.task.snapshotIn(STORE)
    expect(childTasks(snapshot, taskId)).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(1)
    // The winner's batch is the one that exists, bound to the winner's proposal.
    const winner = one.status === 'admitted' ? first : second
    const winnerProposal = await proposalOf(h, winner.proposalId)
    expect(winnerProposal.status).toBe('admitted')
    expect(winnerProposal.consumption?.childTaskIds).toEqual(childTasks(snapshot, taskId).map(task => task.taskId))
    expect(await h.runtime.awaitBatch(STORE, winnerProposal.consumption?.batchId as string))
      .toHaveLength(1)
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
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
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
    expect(admitted.consumption?.childTaskIds).toEqual(continued.childTaskIds)
    // The tasks that exist are the stored batch's contracts — the content a
    // reviewer read, not a copy somebody re-sent.
    const child = (await restarted.task.snapshotIn(STORE)).tasks.find(task => task.taskId === continued.childTaskIds[0])
    expect(child?.contract?.objective).toBe('task a')
    expect(child?.objective).toBe(admitted.batch[0]?.contract.objective)

    // A re-presented batch is a confirmation, not a substitute. The same batch is
    // accepted (a second continuation is answered from the consumption anyway),
    // and a *different* one is refused by name.
    const second = await createSecondParent(h)
    const third = await h.runtime.submitDecompositionProposal(STORE, second.taskId, second.runId, second.sessionId, batchSpec([childSpec('task b')]))
    const thirdProposal = await proposalOf(h, third.proposalId)
    await h.task.decideProposalIn(STORE, {
      proposalId: third.proposalId,
      outcome: 'approved',
      proposalDigest: thirdProposal.proposalDigest,
      admissionContextDigest: thirdProposal.admissionContextDigest,
      reviewContextDigest: thirdProposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)
    const fourth = h.restart()
    await fourth.task.openStore(STORE)
    await expect(fourth.runtime.continueProposal(STORE, third.proposalId, second.sessionId, { spec: batchSpec([childSpec('task c')]) }))
      .rejects.toThrow(/is a different one/)
    expect(fourth.spawned).toHaveLength(0)
    // The matching batch is accepted and admits exactly the stored content.
    const confirmed = await fourth.runtime.continueProposal(STORE, third.proposalId, second.sessionId, {
      spec: batchSpec([childSpec('task b')]),
    })
    expect(confirmed.status).toBe('admitted')
    if (confirmed.status !== 'admitted') throw new Error('unreachable')
    const thirdChild = (await fourth.task.snapshotIn(STORE)).tasks.find(task => task.taskId === confirmed.childTaskIds[0])
    expect(thirdChild?.contract?.objective).toBe('task b')
  })

  test('a batch tampered with in the store — bypassing the service — is refused by name when the store is replayed', async () => {
    const h = harness({ config: { generatedTaskReview: 'all' } })
    const { taskId, runId } = await createRoot(h)
    const pending = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    if (pending.status !== 'pending_review') throw new Error('unreachable')

    // A hand-edited log: the stored content no longer hashes to the identity it
    // was submitted with. Nothing here goes through the service — the reducer is
    // what has to catch it, and it does so by name at replay.
    const events = h.sessions.get(STORE)?.events as unknown as { data: { kind: string; payload: { proposal?: { batch: { contract: { objective: string } }[] } } } }[]
    const submitted = events.find(event => event.data.kind === 'TaskProposalSubmitted')
    if (submitted?.data.payload.proposal === undefined) throw new Error('unreachable')
    submitted.data.payload.proposal.batch[0]!.contract.objective = 'task a, quietly rewritten'

    const restarted = h.restart()
    await expect(restarted.task.openStore(STORE)).rejects.toThrow(/contract digest ".*" does not match its identity digest/)
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
    expect(restarted.reviewCalls).toEqual([{
      storeId: STORE,
      trigger: 'recovered',
      proposalId: pending.proposalId,
      status: 'pending_review',
      hasBatch: true,
      parentObjective: 'ship the release',
      childObjectives: ['task a'],
      // The display material is the *saved batch*: the criteria the proposal
      // recorded, criterion id and description included.
      childCriteria: proposal.batch.flatMap(child =>
        child.contract.acceptanceCriteria.map(criterion => `${child.contract.objective}:${criterion.criterionId}:${criterion.description}`)),
      obligations: 0,
    }])

    // A decision in the new process is recorded *and* continued from the store:
    // the approval taken after the restart is the same batch, and it runs.
    const decided = await restarted.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(decided.status).toBe('admitted')
    expect(decided.continuation?.status).toBe('admitted')
    if (decided.continuation?.status !== 'admitted') throw new Error('unreachable')
    await restarted.runtime.awaitBatch(STORE, decided.continuation.batchId)
    expect(restarted.spawned).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
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
    await h.task.decideProposalIn(STORE, {
      proposalId: pending.proposalId,
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)

    // A *different* process — the process that crashed and was reopened — is the
    // one that recovers: it never held the batch, and no caller re-presents
    // anything.
    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const report = await restarted.runtime.reconcileStore(STORE)
    expect(report.unresolvedProposals).toEqual([])
    const continued = await restarted.runtime.proposalIn(STORE, pending.proposalId)
    expect(continued.status).toBe('admitted')
    expect(continued.consumption?.childTaskIds).toHaveLength(1)
    const snapshot = await restarted.task.snapshotIn(STORE)
    expect(childTasks(snapshot, taskId).map(task => task.taskId)).toEqual(continued.consumption?.childTaskIds)
    // No second batch, one consumption, and the recovered batch is driven to its
    // settlement by the process that adopted the store.
    expect(taskEvents(h).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(1)
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    const outcomes = await restarted.runtime.awaitBatch(STORE, continued.consumption?.batchId as string)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The tasks are the stored batch's content, and the ids are stable across the
    // recovery (a later continuation answers from the same consumption).
    const again = await restarted.runtime.continueProposal(STORE, pending.proposalId, ROOT_SESSION)
    expect(again.status === 'admitted' ? again.childTaskIds : []).toEqual(continued.consumption?.childTaskIds)
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
    await h.task.decideProposalIn(STORE, {
      proposalId: pending.proposalId,
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    }, REVIEWER)
    await h.task.changeProposalPhaseIn(STORE, {
      proposalId: pending.proposalId,
      to: 'ready',
      reason: 'the post-approval re-check passed (seeded: this test starts after it)',
    }, ROOT_SESSION)
    const childTaskIds = ['t-crash-a', 't-crash-b']
    const children = childTaskIds.map((taskId_, index) => ({
      taskId: taskId_,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: taskId,
      objective: `task ${index}`,
      depth: 1,
      acceptanceCriteria: [{
        criterionId: `ac${index + 1}-1`,
        description: `task ${index} works`,
        verificationMode: 'deterministic' as const,
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf' as const,
      status: 'created' as const,
      runIds: [],
      childTaskIds: [],
    }))
    await h.task.admitBatchIn(STORE, taskId, runId, children, 'tester', [], undefined, [
      { capabilities: {}, missing: [], closure: 'closed' },
      { capabilities: {}, missing: [], closure: 'closed' },
    ], {
      proposalId: pending.proposalId,
      proposalDigest: proposal.proposalDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      batchId: `b-${taskId}`,
      childTaskIds,
      admittedAt: new Date().toISOString(),
    })
    expect((await proposalOf(h, pending.proposalId)).status).toBe('admitted')
    expect(h.spawned).toHaveLength(0)

    // A restarted process reconciles the store: the waiting batch is restarted
    // from its own record, and the proposal is not consumed again.
    const restarted = h.restart()
    await restarted.task.openStore(STORE)
    const report = await restarted.runtime.reconcileStore(STORE)
    expect(report.unresolvedProposals).toEqual([])
    const outcomes = await restarted.runtime.awaitBatch(STORE, `b-${taskId}`)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(outcomes.map(outcome => outcome.taskId)).toEqual(childTaskIds)
    expect(childTasks(await restarted.task.snapshotIn(STORE), taskId).map(task => task.taskId)).toEqual(childTaskIds)
    expect(taskEvents(h).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
  })

  test('crash point 4: a settled run is reconnected by identity and its batch is never rebuilt', async () => {
    const h = harness({ config: { generatedTaskReview: 'off' } })
    const { taskId, runId } = await createRoot(h)
    const admitted = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
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
    expect(proposal.consumption?.childTaskIds).toEqual(admitted.childTaskIds)
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
    expect(report.unresolvedProposals).toEqual([{
      proposalId: submitted.proposalId,
      status: 'pending_review',
      reason: expect.stringContaining('sent for review'),
    }])
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

describe('TaskRuntime no-progress rule and known waits (§7.4)', () => {
  test('a worker whose own batch is waiting for a review is a known wait: no round is marked and nothing is stopped', async () => {
    const h = harness({ config: { generatedTaskReview: 'all', noProgressRounds: 1 } })
    const { taskId, runId } = await createRoot(h)
    const submitted = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    if (submitted.status !== 'pending_review') throw new Error('unreachable')
    await h.runtime.decideProposal(STORE, submitted.proposalId, { outcome: 'approved' }, REVIEWER)

    // The spawned worker proposes its own split (policy `all`, so it waits) and
    // then goes idle without submitting: exactly the state a no-progress rule
    // must not read as stagnation.
    let firstIdle = true
    h.setIdleBehavior(async sessionId => {
      if (!firstIdle) return
      firstIdle = false
      const snapshot = await h.task.snapshotIn(STORE)
      const child = childTasks(snapshot, taskId)[0]
      if (child === undefined) throw new Error('no spawned child')
      const workerRun = snapshot.runs.find(run => run.taskId === child.taskId)
      if (workerRun === undefined) throw new Error('the worker has no run')
      await h.runtime.decomposeAndRun(STORE, child.taskId, workerRun.runId, sessionId, batchSpec([childSpec('grandchild')]))
    })
    await vi.waitFor(() => expect(h.reviewCalls.filter(call => call.trigger === 'submitted')).toHaveLength(2))

    const child = childTasks(await h.task.snapshotIn(STORE), taskId)[0] as { taskId: string }
    const workerRun = (await h.task.snapshotIn(STORE)).runs.find(run => run.taskId === child.taskId) as { runId: string }

    // The cancellation is the deterministic release: the driver settles the batch
    // only here, so everything the no-progress rule did (or did not do) is on the
    // record by the time this returns.
    const outcomes = await h.runtime.cancelBatch(STORE, submitted.status === 'pending_review' ? `b-${taskId}` : '', ROOT_SESSION)
    expect(taskEvents(h).filter(event => event.kind === 'RunProgressMarked' && event.runId === workerRun.runId)).toHaveLength(0)
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
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([
      childSpec('task a', { acceptanceCriteria: [{ description: '', command: 'true' }] }),
    ]))).rejects.toThrow(/criterion "ac1-1" description must be a non-empty string/)
    expect((await h.task.snapshotIn(STORE)).obligations).toHaveLength(0)

    // A capability gap is a fact: the refusal carries it, and the submission
    // raises exactly one obligation per missing capability on the parent — once
    // per refusal, never twice for one refusal (the pre-check wrote nothing).
    const gapSpec = batchSpec([childSpec('task a', { requiredCapabilities: ['fly-to-moon'] })])
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, gapSpec)).rejects.toThrow(/capability gap/)
    const obligations = (await h.task.snapshotIn(STORE)).obligations
    expect(obligations).toHaveLength(1)
    expect(obligations[0]?.sourceTaskId).toBe(taskId)
    expect(obligations[0]?.goal).toContain('capability "fly-to-moon" required by child 0')
    await expect(h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, gapSpec)).rejects.toThrow(/capability gap/)
    const repeated = (await h.task.snapshotIn(STORE)).obligations
    expect(repeated).toHaveLength(2)
    expect(repeated[1]?.goal).toBe(obligations[0]?.goal)

    // Refused batches leave no proposal and never ask a person.
    expect(await h.runtime.proposalsForParent(STORE, taskId)).toHaveLength(0)
    expect(h.channel.requestReview).not.toHaveBeenCalled()
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
    const admitted = await off.runtime.decomposeAndRun(STORE, offRoot.taskId, offRoot.runId, ROOT_SESSION, batchSpec([childSpec('task a')]))
    expect(admitted).toMatchObject({ status: 'admitted', batchId: `b-${offRoot.taskId}` })
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
    expect(retried.status === 'admitted' ? retried.childTaskIds : []).toEqual(decided.continuation?.status === 'admitted' ? decided.continuation.childTaskIds : [])
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
    const tooBig = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([
      childSpec('task a'),
      childSpec('task b'),
    ]))
    expect((await proposalOf(h, tooBig.proposalId)).status).toBe('pending_review')
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore)

    // Withdrawing it refunds nothing either — there was nothing to refund, and a
    // re-proposal does not start the budget over.
    await h.runtime.cancelProposal(STORE, tooBig.proposalId, ROOT_SESSION)
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore)

    // The accounting happens at admission: a batch that fits is admitted, and the
    // run it starts is what the budget then counts.
    const fits = await h.runtime.submitDecompositionProposal(STORE, taskId, runId, ROOT_SESSION, batchSpec([childSpec('task c')]))
    const admitted = await h.runtime.decideProposal(STORE, fits.proposalId, { outcome: 'approved' }, REVIEWER)
    expect(admitted.status).toBe('admitted')
    if (admitted.continuation?.status !== 'admitted') throw new Error('unreachable')
    await h.runtime.awaitBatch(STORE, admitted.continuation.batchId)
    expect((await h.task.snapshotIn(STORE)).runs.length).toBe(runsBefore + 1)

    // No slot is left now: another parent's approved batch is refused by name,
    // the approval stays on the record and nothing is consumed.
    const second = await createSecondParent(h)
    const refused = await h.runtime.submitDecompositionProposal(STORE, second.taskId, second.runId, second.sessionId, batchSpec([
      childSpec('task d'),
    ]))
    const decision = await h.runtime.decideProposal(STORE, refused.proposalId, { outcome: 'approved' }, REVIEWER)
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
    const refusedProposal = await proposalOf(h, refused.proposalId)
    expect(refusedProposal.status).toBe('ready')
    expect(refusedProposal.consumption).toBeUndefined()
    expect(refusedProposal.decision?.outcome).toBe('approved')
    expect(h.spawned).toHaveLength(1)
  })
})

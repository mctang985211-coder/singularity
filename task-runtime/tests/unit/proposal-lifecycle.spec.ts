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
  TaskProposalBatchConsumption,
  TaskProposalRoot,
  VerificationResult,
} from '../../../task/src/index.ts'
import {
  ROOT_PROPOSAL_TASK_ID,
  TaskService,
  batchIdFor,
  rootProposalDigest,
  rootProposalId,
  rootTaskStoreId,
} from '../../../task/src/index.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../src/index.ts'
import {
  TaskRuntime,
  decompositionIdentity,
  isOpenProposal,
  openProposalOf,
  resolveRootBudget,
} from '../../src/index.ts'
import { decompositionDigest } from '../../../task/src/contract.ts'
import { taskProposalId } from '../../../task/src/proposal.ts'
import type { TaskProposalDecomposition } from '../../../task/src/proposal.ts'
import { seedLegacyRoot } from '../../../tests/support/legacy-root.ts'
import { personRequest, pluginNotice } from '../support/person-request.ts'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'

const ROOT_SESSION = 'root-session'
/** A second root session, so "the store this contract was sent to" has a wrong answer available (A0 §1.10). */
const BETA = 's-beta'
const REVIEWER = 'reviewer-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/**
 * One review request the runtime made, as the channel saw it. The subject is
 * discriminated by kind because the two arms show different material: a batch is
 * displayed under its parent's goal, a root contract *is* the goal.
 */
interface ReviewCall {
  readonly storeId: string
  readonly trigger: string
  readonly proposalId: string
  readonly status: string
  readonly kind: 'decomposition' | 'root'
  readonly hasBatch: boolean
  /** §5's display content: the parent's objective for a batch, the contract's own objective for a root contract. */
  readonly parentObjective: string
  readonly childObjectives: readonly string[]
  readonly childCriteria: readonly string[]
  readonly obligations: number
}

function harness(
  options: { config?: Partial<Config>; shared?: Map<string, StoredSession>; sessionIds?: string[] } = {},
) {
  const sessions = options.shared ?? new Map<string, StoredSession>()
  // The person asked. This is the request every root intake below stands on, on
  // the surface the runtime reads it from (A0 §1.10): the root session's own
  // durable log, seeded once — `restart()` shares this map, exactly as a durable
  // log outlives the process. The rule is the *existence* of a message whose
  // source is the person, so one message stands for the request.
  if (!sessions.has(ROOT_SESSION)) {
    sessions.set(ROOT_SESSION, {
      header: { id: ROOT_SESSION, cwd: '.', agentPreset: 'standard' } as unknown as SessionHeader,
      events: [personRequest('ship the release')],
    })
  }
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => {
          stored.events.push(...events)
        },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => {
          stored.events.push(...events)
        },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }

  /** One spawn request, as the runtime handed it to the agent runtime; a task-worker spawn carries no prompt (A2). */
  const spawned: { sessionId: string; name: string; prompt?: string; taskWorker?: boolean }[] = []
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
    spawn: vi.fn(
      async (
        _parent: unknown,
        request: {
          sessionId: string
          name: string
          prompt?: Array<{ type: 'text'; text: string }>
          taskWorker?: boolean
        },
      ) => {
        spawned.push({
          sessionId: request.sessionId,
          name: request.name,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt.map(block => block.text).join('\n') }),
          ...(request.taskWorker === undefined ? {} : { taskWorker: request.taskWorker }),
        })
        let releaseIdle: (() => void) | undefined
        const agent = {
          id: request.sessionId,
          cancel: vi.fn(() => {
            cancelled.push(request.sessionId)
            releaseIdle?.()
          }),
          whenIdle: vi.fn(
            () =>
              new Promise<void>((resolve, reject) => {
                releaseIdle = resolve
                void (idleBehavior ?? defaultIdle)(request.sessionId).then(resolve, reject)
              }),
          ),
          followup: (message: { content: readonly { text?: string }[] }) => {
            notifications.push({
              sessionId: request.sessionId,
              text: message.content.map(block => block.text ?? '').join('\n'),
            })
          },
        }
        liveAgents.set(request.sessionId, agent)
        return { agent, dispose: vi.fn(async () => {}) }
      },
    ),
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
  type ReviewSubject = {
    storeId: string
    trigger: string
    proposal: TaskProposal
    obligations: readonly unknown[]
  } & (
    | {
        kind?: undefined
        parentTask: { objective: string }
        batch: {
          children: readonly {
            contract: { objective: string; acceptanceCriteria: readonly { criterionId: string; description: string }[] }
          }[]
        }
      }
    | {
        kind: 'root'
        contract: { objective: string; acceptanceCriteria: readonly { criterionId: string; description: string }[] }
        rootSessionId: string
      }
  )
  const channel = {
    requestReview: vi.fn(async (request: ReviewSubject) => {
      const root = request.kind === 'root'
      reviewCalls.push({
        storeId: request.storeId,
        trigger: request.trigger,
        proposalId: request.proposal.proposalId,
        status: request.proposal.status,
        kind: root ? 'root' : 'decomposition',
        hasBatch: !root,
        parentObjective: root ? request.contract.objective : request.parentTask.objective,
        childObjectives: root ? [] : request.batch.children.map(child => child.contract.objective),
        childCriteria: root
          ? request.contract.acceptanceCriteria.map(
              criterion => `${request.contract.objective}:${criterion.criterionId}:${criterion.description}`,
            )
          : request.batch.children.flatMap(child =>
              child.contract.acceptanceCriteria.map(
                criterion => `${child.contract.objective}:${criterion.criterionId}:${criterion.description}`,
              ),
            ),
        obligations: request.obligations.length,
      })
      return reviewRequested
        ? { requested: true, detail: 'asked the reviewer' }
        : { requested: false, detail: 'nobody is watching' }
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
    agents: {
      get: (sessionId: string) =>
        sessionId === ROOT_SESSION ? parentAgent : (liveAgents.get(sessionId) ?? { id: sessionId }),
    },
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
    setReviewRequested: (value: boolean) => {
      reviewRequested = value
    },
    dropVerifierId: (id: string) => {
      verifierIds = verifierIds.filter(item => item !== id)
    },
    setIdleBehavior: (behavior: (sessionId: string) => Promise<void>) => {
      idleBehavior = behavior
    },
    /** A second runtime over the same store: a deployment restart with a different configuration (and no in-memory batch content). */
    restart: (config?: Partial<Config>) => harness({ config: { ...options.config, ...config }, shared: sessions }),
  }
}

type Harness = ReturnType<typeof harness>

/**
 * Activate a root the way a deployment does — through the intake entry (A0
 * §1.2–§1.4) — with this spec's own root contract. Most cases below are about what
 * happens to a *proposal* after a root exists, so the contract is the fixture; it
 * is stated here rather than defaulted because the root's acceptance is its own
 * decision (at least one mandatory criterion judged by something other than the
 * composite conjunction) and a plausible-looking default would hide the rule.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

async function createRoot(h: Harness, objective = 'ship the release'): Promise<{ taskId: string; runId: string }> {
  const submitted = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract(objective))
  if (submitted.status === 'activated') return { taskId: submitted.taskId, runId: submitted.runId }
  // Under policy `all` a root contract waits for a decision like every other
  // proposal (§1.3): the setup approves it the way a reviewer would, so the case
  // under test starts from an activated root rather than from a waiting one.
  const decided = await h.runtime.decideProposal(STORE, submitted.proposalId, { outcome: 'approved' }, REVIEWER)
  if (decided.continuation?.status !== 'activated') {
    throw new Error(`the root contract was not activated: ${decided.detail}`)
  }
  return { taskId: decided.continuation.taskId, runId: decided.continuation.runId }
}

/**
 * The batch consumption one stored proposal recorded. A proposal record is a
 * union of two kinds, and every case in this file is about a decomposition batch:
 * a root contract reaching this reader would be a different bug, so it is named
 * rather than read as a batch.
 */
function consumedBatch(proposal: TaskProposal): TaskProposalBatchConsumption {
  const consumption = proposal.consumption
  if (consumption === undefined || consumption.kind === 'root') {
    throw new Error(`proposal "${proposal.proposalId}" holds no batch consumption (status ${proposal.status})`)
  }
  return consumption
}

/** One stored proposal's batch content, with the kind named rather than assumed. */
function storedBatch(proposal: TaskProposal): readonly {
  contract: { objective: string; acceptanceCriteria: readonly { criterionId: string; description: string }[] }
}[] {
  if (proposal.kind === 'root')
    throw new Error(`proposal "${proposal.proposalId}" is a root contract; it carries one contract and no batch`)
  return proposal.batch
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

/**
 * Every proposal event this store recorded for a **batch**. A root contract's own
 * proposal rides the reserved envelope task id (`ROOT_PROPOSAL_TASK_ID`), so a
 * case about a batch's proposal never counts the root intake's records — those are
 * a different subject with its own cases.
 */
function batchProposalEvents(h: Harness): TaskEvent[] {
  return taskEvents(h).filter(event => event.kind.startsWith('TaskProposal') && event.taskId !== ROOT_PROPOSAL_TASK_ID)
}

/**
 * The proposal-admitted events this store recorded for a **batch**. Every root
 * contract activation writes one of its own (the consumption that records which
 * proposal became the root), and a case about a batch's consumption must not count
 * it — the two are different records of different kinds.
 */
function batchAdmissions(h: Harness): TaskEvent[] {
  return taskEvents(h).filter(
    event => event.kind === 'TaskProposalAdmitted' && (event.payload as { kind?: string }).kind !== 'root',
  )
}

/** Every task event one store appended, read back off the persistence log the store wrote through. */
function taskEvents(h: Harness, storeId = STORE): TaskEvent[] {
  if (!h.sessions.has(storeId)) throw new Error(`no session "${storeId}"`)
  return storeTaskEvents(h, storeId)
}

/**
 * Every task event one store appended — or none at all when the store was never
 * created, which is a state a refusal can leave (A0 §1.1: the store a refused
 * intake must not have opened). Both arms are what a side-effect check reads, so
 * the reader tolerates the missing store instead of throwing at it.
 */
function storeTaskEvents(h: Harness, storeId: string): TaskEvent[] {
  return (h.sessions.get(storeId)?.events ?? [])
    .filter(event => event.type === 'task/event')
    .map(event => (event as unknown as { data: TaskEvent }).data)
}

/** One session of this fixture's durable log, written where the persistence stub keeps it. */
function seedSession(h: Harness, sessionId: string, events: readonly SessionEvent[]): void {
  h.sessions.set(sessionId, {
    header: { id: sessionId, cwd: '.', agentPreset: 'standard' } as unknown as SessionHeader,
    events: [...events],
  })
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
  await h.task.decideProposalIn(
    STORE,
    {
      proposalId,
      outcome: 'approved',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      decidedBy: REVIEWER,
      decidedAt: new Date().toISOString(),
    },
    REVIEWER,
  )
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
    requiredCapabilities: [],
  }
  await h.task.createTaskIn(
    STORE,
    {
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
    expect(() => new TaskRuntime(h.ctx as never, { generatedTaskReview: 'risk' } as unknown as Config)).toThrow(
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
    ).rejects.toThrow(/already has a proposal in flight/)
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
      /already has a proposal in flight/,
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
      requestedCapabilities: [],
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
        { capabilities: {}, missing: [], closure: 'closed' },
        { capabilities: {}, missing: [], closure: 'closed' },
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

    // The accounting happens at admission: a batch that fits is admitted, and the
    // run it starts is what the budget then counts.
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

    // No slot is left now: another parent's approved batch is refused by name,
    // the approval stays on the record and nothing is consumed.
    const second = await createSecondParent(h)
    const refused = await h.runtime.submitDecompositionProposal(
      STORE,
      second.taskId,
      second.runId,
      second.sessionId,
      batchSpec([childSpec('task d')]),
    )
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
      objective: 'a different goal entirely',
      acceptanceCriteria: [{ criterionId: 'other', description: 'the other goal holds', command: 'true' }],
    })
    const loser = await h.runtime.submitRootContractProposal(STORE, ROOT_SESSION, {
      objective: 'a third goal',
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
        objective: 'all children verified',
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
        objective: '   ',
        acceptanceCriteria: [{ description: 'it holds', command: 'true' }],
      }),
    ).rejects.toThrow(/objective must be a non-empty string/)
    await expect(
      h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
        objective: 'an unregistered judge',
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
        objective: 'a field nobody reads',
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

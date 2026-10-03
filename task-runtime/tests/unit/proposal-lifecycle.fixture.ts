import { TASK_GUIDANCE } from '../support/skill-roots.ts'
/**
 * The T2/T3 proposal lifecycle, end to end through the real runtime and store:
 * the review policy's two modes, the pure pre-check's ordering, the approval's
 * binding, the post-approval re-check, the request-key rules and the crash
 * points of §5–§6. Everything here reads its conclusions back from the store
 * (the proposal record, the task graph, the event log) or from a counting
 * channel — never from a writer's return value, which is what makes these tests
 * about the mechanism rather than about the API's shape.
 */

import { afterEach, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  EvidenceBundle,
  TaskEvent,
  TaskProposal,
  TaskProposalBatchConsumption,
  VerificationResult,
} from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'
import { personRequest } from '../support/person-request.ts'
import { releaseSkillHomes } from '../support/skill-roots.ts'

export const ROOT_SESSION = 'root-session'

export const REVIEWER = 'reviewer-session'

export const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

export interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/**
 * One review request the runtime made, as the channel saw it. The subject is
 * discriminated by kind because the two arms show different material: a batch is
 * displayed under its parent's goal, a root contract *is* the goal.
 */
export interface ReviewCall {
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

export function harness(
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
  const runtime = new TaskRuntime(ctx as never, {
    ...options.config,
    capabilities: { ...TASK_GUIDANCE, ...options.config?.capabilities },
  })
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

export type Harness = ReturnType<typeof harness>

/**
 * Activate a root the way a deployment does — through the intake entry (A0
 * §1.2–§1.4) — with this spec's own root contract. Most cases below are about what
 * happens to a *proposal* after a root exists, so the contract is the fixture; it
 * is stated here rather than defaulted because the root's acceptance is its own
 * decision (at least one mandatory criterion judged by something other than the
 * composite conjunction) and a plausible-looking default would hide the rule.
 */
export function rootContract(objective: string): RootContractSpec {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

export async function createRoot(
  h: Harness,
  objective = 'ship the release',
): Promise<{ taskId: string; runId: string }> {
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
export function consumedBatch(proposal: TaskProposal): TaskProposalBatchConsumption {
  const consumption = proposal.consumption
  if (consumption === undefined || consumption.kind === 'root') {
    throw new Error(`proposal "${proposal.proposalId}" holds no batch consumption (status ${proposal.status})`)
  }
  return consumption
}

export function childSpec(objective: string, overrides: Record<string, unknown> = {}) {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    ...overrides,
  } as NonNullable<DecomposeSpec['children']>[number]
}

export function batchSpec(children: DecomposeSpec['children'], reason = 'split the work'): DecomposeSpec {
  return { reason, children }
}

/**
 * The proposal-admitted events this store recorded for a **batch**. Every root
 * contract activation writes one of its own (the consumption that records which
 * proposal became the root), and a case about a batch's consumption must not count
 * it — the two are different records of different kinds.
 */
export function batchAdmissions(h: Harness): TaskEvent[] {
  return taskEvents(h).filter(
    event => event.kind === 'TaskProposalAdmitted' && (event.payload as { kind?: string }).kind !== 'root',
  )
}

/** Every task event one store appended, read back off the persistence log the store wrote through. */
export function taskEvents(h: Harness, storeId = STORE): TaskEvent[] {
  if (!h.sessions.has(storeId)) throw new Error(`no session "${storeId}"`)
  return storeTaskEvents(h, storeId)
}

/**
 * Every task event one store appended — or none at all when the store was never
 * created, which is a state a refusal can leave (A0 §1.1: the store a refused
 * intake must not have opened). Both arms are what a side-effect check reads, so
 * the reader tolerates the missing store instead of throwing at it.
 */
export function storeTaskEvents(h: Harness, storeId: string): TaskEvent[] {
  return (h.sessions.get(storeId)?.events ?? [])
    .filter(event => event.type === 'task/event')
    .map(event => (event as unknown as { data: TaskEvent }).data)
}

export function childTasks(
  snapshot: { tasks: readonly { taskId: string; parentTaskId?: string }[] },
  parentTaskId: string,
) {
  return snapshot.tasks.filter(task => task.parentTaskId === parentTaskId)
}

export async function proposalOf(h: Harness, proposalId: string): Promise<TaskProposal> {
  return await h.runtime.proposalIn(STORE, proposalId)
}

/**
 * Write an approval the way a process that died between the decision and the
 * continuation leaves it: on the record, uncontinued, with nothing else written.
 */
export async function approveInStore(h: Harness, proposalId: string): Promise<void> {
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

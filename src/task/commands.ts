import type { ControlReadCut, ControlSessionStore } from '../control/session-store.ts'
import type { Envelope } from '../protocol/envelope.ts'
import type { Decision, EmitInput } from '../protocol/memory-log.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../environment/protocol.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunSubmission, type TaskState } from './protocol.ts'
import { unadjudicatedCriteria, unmetCriteria, verdictFor } from './run.ts'
import { projectTree } from './tree.ts'
import type { BubbleInput, BubbleTool } from './bubble.ts'
import type { DecompositionChild } from './decomposition.ts'

/** What the deployment holds for one agent: the subjects-table key its acts are bound to. */
export interface HeldAgent {
  readonly as: string
}

/** A verdict as its producer reports it. Who judged is filled in from the criterion, never passed. */
export interface VerdictInput {
  readonly runId: string
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  readonly implementationDigest: string
  readonly artifactDigest: string
  readonly inputDigests: readonly BubbleInput[]
  readonly detail?: string
}

export interface TaskCommandOptions {
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
  /** The identities this deployment holds, keyed by agent id. An absent agent is not held. */
  readonly agents: ReadonlyMap<string, HeldAgent>
  /** The verifier implementations this deployment can run, by the digest of their own bytes. */
  readonly implementations: readonly { readonly ref: string; readonly version: string; readonly implementationDigest: string }[]
}

export interface AgentCommands {
  admit(input: { readonly commandId: string; readonly taskId: string; readonly contract: unknown }, as?: string): Promise<Envelope>
  decompose(input: { readonly commandId: string; readonly parentTaskId: string; readonly children: readonly DecompositionChild[] }, as?: string): Promise<Envelope>
  assign(input: { readonly commandId: string; readonly taskId: string; readonly agentId: string }, as?: string): Promise<Envelope>
  reassign(input: { readonly commandId: string; readonly taskId: string; readonly from: string; readonly agentId: string }, as?: string): Promise<Envelope>
  startRun(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly revision: RevisionRef
  }, as?: string): Promise<Envelope>
  openBubble(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly inputs: readonly BubbleInput[]
    readonly workspace: { readonly kind: string; readonly ref: string }
    readonly model: string
    readonly tools: readonly BubbleTool[]
    readonly conditions: readonly string[]
  }, as?: string): Promise<Envelope>
  beginSubmission(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly requestId: string
    readonly requestDigest: string
  }, as?: string): Promise<Decision>
  submitRun(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly submission: RunSubmission
  }, as?: string): Promise<Envelope>
  failRun(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly reason?: string
  }, as?: string): Promise<Envelope>
}

export interface TaskCommands extends AgentCommands {
  settle(
    input: { readonly commandId: string; readonly taskId: string; readonly runId: string },
    as?: string,
  ): Promise<Envelope>
  /** Not reachable from `forAgent`: producing a verdict is a verifier's act, not an agent's. */
  recordVerdict(input: { readonly commandId: string; readonly taskId: string; readonly verdict: VerdictInput }): Promise<Envelope>
  recordConsumption(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly revision: RevisionRef
    readonly method: string
    readonly source: string
  }): Promise<Envelope>
  forAgent(agentId: string): AgentCommands
}

interface Cut {
  readonly task: (taskId: string) => TaskState | undefined
  readonly agent: (agentId: string) => AgentState | undefined
  readonly tasks: () => ReadonlyMap<string, TaskState>
  readonly environments: () => ReadonlyMap<string, EnvironmentState>
}

export function createTaskCommands(options: TaskCommandOptions): TaskCommands {
  // One binding is one executor. The log tells agents apart by the identity their acts stamp, so a
  // deployment that binds two agents to one key has declared executors it cannot tell apart, and
  // every responsibility check would compare a fact against itself.
  const holderOf = new Map<string, string>()
  for (const [agentId, held] of options.agents) {
    const holder = holderOf.get(held.as)
    if (holder !== undefined)
      refuse(
        'malformed-declaration',
        `agents "${holder}" and "${agentId}" are both bound to ${JSON.stringify(held.as)}; one binding is one executor, and two agents whose facts stamp one identity are one agent the log cannot tell apart`,
      )
    holderOf.set(held.as, agentId)
  }
  const commands: TaskCommands = {
    admit: (input, as) => emitRaw(options, input.commandId, TASK_KINDS.admitted, input.taskId, { contract: input.contract }, as),

    decompose: (input, as) =>
      emitRaw(options, input.commandId, TASK_KINDS.decomposed, input.parentTaskId, { children: input.children }, as),

    assign: (input, as) => {
      // The identity is filled from the deployment's table, so a caller supplies what it did and
      // never who it is. Holding it is a deployment fact; the node is a log fact.
      const identity = requireHeldBinding(options, input.agentId, `assign task "${input.taskId}"`).identity
      return emitRaw(options, input.commandId, TASK_KINDS.assigned, input.taskId, { agentId: input.agentId, agentIdentity: identity }, as, () =>
        requireOpenedNode(cutOf(options), input.agentId, `assign task "${input.taskId}"`),
      )
    },

    reassign: (input, as) => {
      const identity = requireHeldBinding(options, input.agentId, `transfer task "${input.taskId}"`).identity
      return emitRaw(
        options,
        input.commandId,
        TASK_KINDS.reassigned,
        input.taskId,
        { from: input.from, agentId: input.agentId, agentIdentity: identity },
        as,
        () => requireOpenedNode(cutOf(options), input.agentId, `transfer task "${input.taskId}"`),
      )
    },

    startRun: (input, as) =>
      emitRaw(options, input.commandId, TASK_KINDS.runStarted, input.taskId, { runId: input.runId, revision: input.revision }, as, () => {
        const cut = cutOf(options)
        const task = cut.task(input.taskId)
        if (task === undefined || task.contract === undefined)
          refuse('illegal-transition', `cannot start a run for task "${input.taskId}": it has no admitted contract, so there is nothing to accept`)
        // Cross-entity 1: the revision must exist, in the named environment, with the content
        // the pin claims. This reuses the environment slice's own check, not a second one.
        assertPinnedRevision(input.revision, cut.environments(), `run "${input.runId}" of task "${input.taskId}"`)
        // Cross-entity 2: someone must be answerable, and it must be an agent this deployment
        // holds with an opened node. The identity comparison itself is the reducer's.
        if (task.responsibility === undefined)
          refuse(
            'not-responsible',
            `cannot start a run for task "${input.taskId}": no agent is responsible for it, so no attempt is answerable`,
          )
        requireOpenedNode(cut, task.responsibility.agentId, `start a run for task "${input.taskId}"`)
        // Cross-entity 3: if a plan declares this task, the plan's gate decides. Readiness
        // already subsumes dependencies, budget and admission, and carries its own reason.
        requirePlanAllows(cut, input.taskId)
      }),

    openBubble: (input, as) =>
      // The whole declared context goes through: rebuilding the payload from three of its members is
      // how a required member silently disappears between the caller and the reducer.
      emitRaw(options, input.commandId, TASK_KINDS.bubbleOpened, input.taskId, {
        runId: input.runId,
        inputs: input.inputs,
        workspace: input.workspace,
        model: input.model,
        tools: input.tools,
        conditions: input.conditions,
      }, as),

    beginSubmission: async (input, as) => {
      let fresh = false
      const envelope = await emitRaw(options, input.commandId, TASK_KINDS.runSubmitting, input.taskId, {
        runId: input.runId,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
      }, as, () => {
        const own = projectTree(cutOf(options).tasks()).find(plan => plan.parentTaskId === input.taskId)
        const pending = own?.children.filter(child => child.status !== 'verified') ?? []
        if (pending.length > 0)
          refuse('illegal-transition', `cannot submit task "${input.taskId}" while its sub-task ${pending.map(child => `"${child.taskId}" (${child.status})`).join(', ')} has not verified`)
        fresh = true
      })
      return { envelope, fresh }
    },

    submitRun: (input, as) =>
      emitRaw(options, input.commandId, TASK_KINDS.runSubmitted, input.taskId, { runId: input.runId, submission: input.submission }, as),

    failRun: (input, as) =>
      emitRaw(
        options,
        input.commandId,
        TASK_KINDS.runFailed,
        input.taskId,
        input.reason === undefined ? { runId: input.runId } : { runId: input.runId, reason: input.reason },
        as,
      ),

    // The one command whose *kind* is the state's to choose, so its request is produced inside the
    // store's serial region rather than before the queue: `settleRequest` reads the evidence there
    // and returns the fact that evidence is.
    settle: (input, as) => options.store.emit(() => settleRequest(options, input, as)) as Promise<Envelope>,

    recordVerdict: input => {
      // Who judged is filled from the criterion rather than passed in. The criterion cannot change
      // after admission - a second `task/admitted` is refused by the reducer, and the record is the
      // reducer's - so this fill cannot disagree with the check handed to the append path below,
      // and that check is what refuses a verdict this deployment cannot have produced.
      const criterion = requireCriterion(cutOf(options), input.taskId, input.verdict.criterionId)
      return emitRaw(
        options,
        input.commandId,
        TASK_KINDS.evidenceProduced,
        input.taskId,
        {
          runId: input.verdict.runId,
          criterionId: input.verdict.criterionId,
          verdict: input.verdict.verdict,
          verifierRef: criterion.verifierRef,
          verifierVersion: criterion.verifierVersion,
          implementationDigest: input.verdict.implementationDigest,
          artifactDigest: input.verdict.artifactDigest,
          inputDigests: input.verdict.inputDigests,
          ...(input.verdict.detail === undefined ? {} : { detail: input.verdict.detail }),
        },
        undefined,
        () => {
          const now = requireCriterion(cutOf(options), input.taskId, input.verdict.criterionId)
          if (input.verdict.implementationDigest !== now.implementationDigest)
            refuse(
              'wrong-verifier',
              `criterion "${input.verdict.criterionId}" names the implementation ${now.implementationDigest.slice(0, 12)}…, but the verdict came from ${input.verdict.implementationDigest.slice(0, 12)}…`,
            )
          if (!options.implementations.some(entry => entry.implementationDigest === input.verdict.implementationDigest))
            refuse(
              'unregistered-verifier',
              `this deployment holds no implementation with digest ${input.verdict.implementationDigest.slice(0, 12)}…, so it cannot have produced this verdict`,
            )
        },
      )
    },

    recordConsumption: input =>
      // The revision stays the caller's claim rather than being filled from the run's pin: a
      // deployment that recorded consumption against a stale revision gets the reducer's refusal
      // named after that revision, instead of the claim being silently rewritten into a true one.
      emitRaw(options, input.commandId, TASK_KINDS.methodConsumed, input.taskId, {
        runId: input.runId,
        revision: input.revision,
        method: input.method,
        source: input.source,
      }),

    forAgent: agentId => {
      // The narrow view does not hand back a judging method at all: the boundary is the absence of
      // the method, rather than a rule the agent is trusted to respect. And the surface is bound:
      // every fact it produces stamps this agent's identity, resolved from the deployment's one
      // table through the store, so the log attributes the act to the executor that drove it and a
      // responsibility check compares the caller against the holder instead of against itself.
      const { as } = requireHeldBinding(options, agentId, `act as agent "${agentId}"`)
      return {
        admit: input => commands.admit(input, as),
        decompose: input => commands.decompose(input, as),
        assign: input => commands.assign(input, as),
        reassign: input => commands.reassign(input, as),
        startRun: input => commands.startRun(input, as),
        openBubble: input => commands.openBubble(input, as),
        beginSubmission: input => commands.beginSubmission(input, as),
        submitRun: input => commands.submitRun(input, as),
        failRun: input => commands.failRun(input, as),
      }
    },
  }

  return commands
}

function cutOf(options: TaskCommandOptions): Cut {
  const cut: ControlReadCut = options.store.load()
  return {
    task: taskId => cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId),
    agent: agentId => cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, agentId),
    tasks: () => cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION),
    environments: () => cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
  }
}

/** The binding one held agent's acts stamp, and the identity that binding resolves to. */
function requireHeldBinding(options: TaskCommandOptions, agentId: string, action: string): { as: string; identity: string } {
  const held = options.agents.get(agentId)
  if (held === undefined)
    refuse(
      'unknown-emitter-role',
      `cannot ${action}: agent "${agentId}" is not one this deployment holds (known: ${[...options.agents.keys()].sort().join(', ') || 'none'})`,
    )
  const identity = options.store.identityOf(held.as)
  if (identity === undefined)
    refuse(
      'unknown-emitter-role',
      `cannot ${action}: agent "${agentId}" is bound to ${JSON.stringify(held.as)}, which this deployment's store holds no identity for, so no fact of its could be stamped`,
    )
  return { as: held.as, identity }
}

/** The log half: a held agent whose node was never opened has no session backing it. */
function requireOpenedNode(cut: Cut, agentId: string, action: string): void {
  if (cut.agent(agentId) === undefined)
    refuse(
      'unknown-emitter-role',
      `cannot ${action}: agent "${agentId}" is held by this deployment but has no opened node in this log, so no session backs it`,
    )
}

function requirePlanAllows(cut: Cut, taskId: string): void {
  const plans = projectTree(cut.tasks())
  for (const view of plans) {
    const child = view.children.find(entry => entry.taskId === taskId)
    if (child === undefined) continue
    if (child.status === 'ready') continue
    refuse(
      'illegal-transition',
      `cannot start a run for sub-task "${taskId}" of plan "${view.parentTaskId}": it is ${child.status}${
        child.reason === null ? '' : ` (${child.reason})`
      }`,
    )
  }
  const own = plans.find(view => view.parentTaskId === taskId)
  if (own === undefined) return
  const running = own.children.filter(child => child.status === 'running')
  if (running.length === 0) return
  refuse(
    'illegal-transition',
    `cannot start a run for task "${taskId}": its own sub-task ${running
      .map(child => `"${child.taskId}"`)
      .join(', ')} ${running.length === 1 ? 'is' : 'are'} running, and the parent does not work on an acceptance it has delegated while the delegate is still working — wait for the sub-task to settle`,
  )
}

/** The criterion a verdict must belong to, or a refusal naming why there is none. */
function requireCriterion(cut: Cut, taskId: string, criterionId: string) {
  const task = cut.task(taskId)
  if (task === undefined || task.contract === undefined)
    refuse('illegal-transition', `cannot record a verdict for task "${taskId}": it has no admitted contract to decide against`)
  const criterion = task.contract.criteria.find(entry => entry.criterionId === criterionId)
  if (criterion === undefined) refuse('unknown-criterion', `task "${taskId}" does not declare criterion "${criterionId}", so nothing decides it`)
  return criterion
}

function settleRequest(
  options: TaskCommandOptions,
  input: { readonly commandId: string; readonly taskId: string; readonly runId: string },
  as?: string,
): EmitInput {
  const cut = cutOf(options)
  const task = cut.task(input.taskId)
  if (task === undefined || task.contract === undefined)
    refuse('unknown-run', `cannot settle run "${input.runId}" of task "${input.taskId}": it has no admitted contract, so it never started a run`)
  const run = task.runs[input.runId]
  if (run === undefined) refuse('unknown-run', `cannot settle run "${input.runId}": task "${input.taskId}" never started it`)

  const unadjudicated = unadjudicatedCriteria(task.contract, run)
  if (unadjudicated.length > 0)
    refuse(
      'unadjudicated-criterion',
      `cannot settle run "${input.runId}": ${unadjudicated
        .map(criterion => `"${criterion.criterionId}" has no verdict from ${criterion.verifierRef}@${criterion.verifierVersion}`)
        .join('; ')}; a run settles only once every criterion has been decided`,
    )

  const common = { commandId: input.commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, subject: input.taskId }
  const unmet = unmetCriteria(task.contract, run)
  if (unmet.length === 0) return { ...common, kind: TASK_KINDS.runVerified, payload: { runId: input.runId } }

  // Every criterion without a passing verdict holds a failing one — the unadjudicated were refused
  // above — so the settlement carries the first failure's own words rather than a summary of them.
  // A failing verdict with no detail stays without one: the view reports "none recorded".
  const failing = unmet.map(criterion => verdictFor(run, criterion)).find(evidence => evidence !== undefined)
  const reason = failing?.detail
  return {
    ...common,
    kind: TASK_KINDS.runFailed,
    payload: reason === undefined ? { runId: input.runId } : { runId: input.runId, reason },
    ...(as === undefined ? {} : { as }),
  }
}

async function emitRaw(
  options: TaskCommandOptions,
  commandId: string,
  kind: string,
  subject: string,
  payload: unknown,
  as?: string,
  require?: () => void,
): Promise<Envelope> {
  return options.store.emit({ commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, subject, payload, ...(as === undefined ? {} : { as }) }, require) as Promise<Envelope>
}

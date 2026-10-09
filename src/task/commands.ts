/**
 * The trusted command boundary: the one place cross-entity preconditions are checked, and the only
 * surface through which facts are produced.
 *
 * A per-subject reducer is pure and sees one subject, which is correct — but it means the
 * conditions that span entities (does the revision this run pins actually exist, has the agent been
 * opened, is the sub-task ready, is its budget spent) cannot be decided there. Discovering them
 * afterwards in a projection is a diagnosis, not a check: by then the work has already been
 * scheduled. So they are decided here, **inside the serial region that produces the fact**.
 *
 * Two properties make the region real:
 *
 * 1. **Every command goes through this service's queue**, and the committed read cut is taken
 *    inside that queued step, immediately before the emit. A check performed outside the queue, or
 *    against a cut read earlier, is a check against a state that may already be gone.
 * 2. **A command decides the parts a caller must not.** `assignTask` fills the responsible identity
 *    from the deployment's own table rather than from its argument, and `recordVerdict` fills the
 *    verifier's ref and version from the frozen criterion. A caller supplies what it did; it does
 *    not supply who it is.
 *
 * The agent-facing view is narrower than this service on purpose: `forAgent` omits
 * `recordVerdict`, so the path that produces a verdict is not reachable from the path an agent
 * drives. That is the whole of "an agent cannot emit its own verdict" — a method it does not have,
 * rather than a rule it is asked to respect.
 *
 * @module singularity-core/task/commands
 */

import type { ControlSessionStore } from '../control/session-store.ts'
import type { Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../environment/protocol.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import { foldSubjects } from '../protocol/fold.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from './protocol.ts'
import { projectTree } from './tree.ts'
import type { BubbleInput } from './bubble.ts'
import type { DecompositionChild } from './decomposition.ts'

/** What the deployment holds for one agent: the identity that stands for it in the log. */
export interface HeldAgent {
  readonly identity: string
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

/**
 * The commands an agent drives: it may plan, delegate and attempt, but not judge.
 *
 * Every command carries its own `commandId`, because command identity is the caller's business
 * identity for the act - "the attempt to start run r1" - and the log answers a retry with the fact
 * it already committed. Deriving one here from the state would make two different commands collide
 * on one id, and the second would silently replay the first.
 */
export interface AgentCommands {
  admit(input: { readonly commandId: string; readonly taskId: string; readonly contract: unknown }): Promise<Envelope>
  decompose(input: { readonly commandId: string; readonly parentTaskId: string; readonly children: readonly DecompositionChild[] }): Promise<Envelope>
  assign(input: { readonly commandId: string; readonly taskId: string; readonly agentId: string }): Promise<Envelope>
  reassign(input: { readonly commandId: string; readonly taskId: string; readonly from: string; readonly agentId: string }): Promise<Envelope>
  startRun(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly revision: RevisionRef
  }): Promise<Envelope>
  openBubble(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly inputs: readonly BubbleInput[]
    readonly workspace: { readonly kind: string; readonly ref: string }
  }): Promise<Envelope>
  failRun(input: {
    readonly commandId: string
    readonly taskId: string
    readonly runId: string
    readonly reason?: string
  }): Promise<Envelope>
}

export interface TaskCommands extends AgentCommands {
  /** Not reachable from `forAgent`: producing a verdict is a verifier's act, not an agent's. */
  recordVerdict(input: { readonly commandId: string; readonly taskId: string; readonly verdict: VerdictInput }): Promise<Envelope>
  forAgent(agentId: string): AgentCommands
}

/** Everything one command reads, taken from the committed cut inside the queued step. */
interface Cut {
  readonly task: (taskId: string) => TaskState | undefined
  readonly agent: (agentId: string) => AgentState | undefined
  readonly tasks: ReadonlyMap<string, TaskState>
  /** Every environment the log holds, for the pin check that must tell "absent" from "mismatched". */
  readonly environments: ReadonlyMap<string, EnvironmentState>
}

export function createTaskCommands(options: TaskCommandOptions): TaskCommands {
  let queue: Promise<unknown> = Promise.resolve()

  /** Run one command inside the serial region: read the cut, decide, then produce the fact. */
  function command<Result>(step: (cut: Cut) => Promise<Result>): Promise<Result> {
    const run = async (): Promise<Result> => step(cutOf(options))
    const queued = queue.then(run, run)
    queue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  const commands: TaskCommands = {
    admit: input => command(() => emitRaw(options, input.commandId, TASK_KINDS.admitted, input.taskId, { contract: input.contract })),

    decompose: input =>
      command(() => emitRaw(options, input.commandId, TASK_KINDS.decomposed, input.parentTaskId, { children: input.children })),

    assign: input =>
      command(() => {
        // The identity is filled from the deployment's table, so a caller supplies what it did and
        // never who it is. Holding it is a deployment fact; the node is a log fact.
        const identity = requireHeldIdentity(options, input.agentId, `assign task "${input.taskId}"`)
        return emitRaw(options, input.commandId, TASK_KINDS.assigned, input.taskId, { agentId: input.agentId, agentIdentity: identity }, () =>
          requireOpenedNode(cutOf(options), input.agentId, `assign task "${input.taskId}"`),
        )
      }),

    reassign: input =>
      command(() => {
        const identity = requireHeldIdentity(options, input.agentId, `transfer task "${input.taskId}"`)
        return emitRaw(
          options,
          input.commandId,
          TASK_KINDS.reassigned,
          input.taskId,
          { from: input.from, agentId: input.agentId, agentIdentity: identity },
          () => requireOpenedNode(cutOf(options), input.agentId, `transfer task "${input.taskId}"`),
        )
      }),

    startRun: input =>
      command(() =>
        emitRaw(
          options,
          input.commandId,
          TASK_KINDS.runStarted,
          input.taskId,
          { runId: input.runId, revision: input.revision },
          () => {
            const cut = cutOf(options)
            const task = cut.task(input.taskId)
            if (task === undefined || task.contract === undefined)
              refuse('illegal-transition', `cannot start a run for task "${input.taskId}": it has no admitted contract, so there is nothing to accept`)
            // Cross-entity 1: the revision must exist, in the named environment, with the content
            // the pin claims. This reuses the environment slice's own check, not a second one.
            assertPinnedRevision(input.revision, cut.environments, `run "${input.runId}" of task "${input.taskId}"`)
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
          },
        ),
      ),

    openBubble: input =>
      command(() =>
        emitRaw(options, input.commandId, TASK_KINDS.bubbleOpened, input.taskId, {
          runId: input.runId,
          inputs: input.inputs,
          workspace: input.workspace,
        }),
      ),

    failRun: input =>
      command(() =>
        emitRaw(
          options,
          input.commandId,
          TASK_KINDS.runFailed,
          input.taskId,
          input.reason === undefined ? { runId: input.runId } : { runId: input.runId, reason: input.reason },
        ),
      ),

    recordVerdict: input =>
      command(() => {
        // The payload has to be final before it is parsed, so the criterion is read here to fill
        // the verifier's ref and version - a read, inside the serial region, not a decision. The
        // decisions all live in the preconditions below, which run only when a fact is appended.
        const cut = cutOf(options)
        const criterion = requireCriterion(cut, input.taskId, input.verdict.criterionId)
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
      }),

    forAgent: agentId => {
      // The narrow view does not hand back a judging method at all: the boundary is the absence of
      // the method, rather than a rule the agent is trusted to respect.
      if (!options.agents.has(agentId))
        refuse(
          'unknown-emitter-role',
          `agent "${agentId}" is not one this deployment holds, so it has no command surface here (known: ${[...options.agents.keys()].sort().join(', ') || 'none'})`,
        )
      return {
        admit: commands.admit,
        decompose: commands.decompose,
        assign: commands.assign,
        reassign: commands.reassign,
        startRun: commands.startRun,
        openBubble: commands.openBubble,
        failRun: commands.failRun,
      }
    },
  }

  return commands
}

/** The committed cut: folded from the store's fixed read, never from a live mutable view. */
function cutOf(options: TaskCommandOptions): Cut {
  const log = options.store.load()
  const tasks = foldSubjects<TaskState>(options.registry, log.entries(), TASK_PROTOCOL, TASK_VERSION)
  const environments = new Map<string, EnvironmentState>()
  for (const subject of new Set(log.entriesOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).map(entry => entry.subject))) {
    const state = log.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, subject)
    if (state !== undefined) environments.set(subject, state)
  }
  return {
    tasks,
    environments,
    task: taskId => tasks.get(taskId),
    agent: agentId => log.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, agentId),
  }
}

/** The identity this deployment holds for one agent. A deployment fact, not a log fact. */
function requireHeldIdentity(options: TaskCommandOptions, agentId: string, action: string): string {
  const held = options.agents.get(agentId)
  if (held === undefined)
    refuse(
      'unknown-emitter-role',
      `cannot ${action}: agent "${agentId}" is not one this deployment holds (known: ${[...options.agents.keys()].sort().join(', ') || 'none'})`,
    )
  return held.identity
}

/** The log half: a held agent whose node was never opened has no session backing it. */
function requireOpenedNode(cut: Cut, agentId: string, action: string): void {
  if (cut.agent(agentId) === undefined)
    refuse(
      'unknown-emitter-role',
      `cannot ${action}: agent "${agentId}" is held by this deployment but has no opened node in this log, so no session backs it`,
    )
}

/**
 * If any plan declares this task as a sub-task, the plan's gate decides.
 *
 * The tree's own status is the gate: `ready` means every dependency verified and the budget is not
 * spent. Anything else is refused with the tree's own reason, so the operator reads the same
 * sentence here as in a projection.
 */
function requirePlanAllows(cut: Cut, taskId: string): void {
  for (const view of projectTree(cut.tasks)) {
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

/**
 * Produce one fact, with its cross-subject preconditions handed to the append path.
 *
 * They are not run here, immediately before the call, because command identity has to be decided
 * first: a re-delivered command was already decided, and deciding it again against a state that has
 * moved on turns "give me back the result I lost" into a refusal.
 */
async function emitRaw(
  options: TaskCommandOptions,
  commandId: string,
  kind: string,
  subject: string,
  payload: unknown,
  require?: () => void,
): Promise<Envelope> {
  return options.store.emit({ commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, subject, payload }, require) as Promise<Envelope>
}

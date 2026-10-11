/**
 * Scheduling: an admitted plan's ready sub-tasks, each run by a real DSH child session, so a sub-task's
 * run is attributable to the agent that did it rather than to the parent that planned it.
 *
 * It never decides that a sub-task is startable — `ready` is `projectTree`'s verdict and the command
 * boundary refuses the others anyway. What it owns is *when* to act: nothing here runs on a timer.
 *
 * @module @dangosys/dsh-singularity-next/scheduler
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

import { closeAgentSession } from '../../src/runtime/agent-session.ts'
import { openChildSession, type ChildSession, type ChildSessionRequest, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { workspaceOf } from './submission.ts'
import { prepareWorkspace } from './workspace.ts'

/**
 * The instruction a child is given, composed from its own committed contract.
 *
 * It carries **no domain vocabulary**: the criterion is named by the work it judges, and the artifact by
 * the caption the contract already holds. A deployment that changes its domain changes what the child is
 * told without this module being edited, which is the same rule the rest of this package lives under.
 */
function instructionFor(state: TaskState, workspace: string, artifact: string): string {
  const contract = state.contract
  if (contract === undefined) refuse('illegal-transition', `sub-task "${state.taskId}" has no contract, so there is nothing to instruct a session with`)
  return [
    `You are the agent responsible for the sub-task "${state.taskId}".`,
    `Goal: ${contract.goal}`,
    `Your workspace is ${workspace}, already prepared with the material this sub-task is judged on.`,
    `Work there, then submit through your own tool surface: \`singularity_submit_program\` records the attempt and runs the criterion's own verifier, whose verdict is the only one that counts.`,
    `Your work is judged against the criterion ${contract.criteria.map(criterion => `"${criterion.criterionId}"`).join(', ')}, read from the artifact "${artifact}".`,
    `A refusal is information: read its code and detail, change what it names, and try again while your budget allows.`,
  ].join('\n')
}

/**
 * The route a child runs on, read from its parent's own header.
 *
 * **Not inherited.** DSH's `create` takes a provider and a model or the child has neither, and a child
 * with no route fails its first step with a bare upstream error far from this call. Reading it from the
 * parent's header rather than from configuration keeps one source for "what model is this work running
 * under" — the same value the parent's own bubbles name.
 */
function modelOf(parent: Agent): { provider: string; model: string } {
  const header = parent.session.requestHeader()
  if (header === undefined)
    refuse(
      'malformed-declaration',
      `agent "${parent.id}" has no request header, so the route a child of it would run on cannot be read; a child runs on a named route or it does not run`,
    )
  return { provider: header.config.provider, model: header.config.model }
}

/** The live children one deployment holds, keyed by the sub-task each is working. */
export interface Scheduler {
  /** Open a session for every ready sub-task that has none. Idempotent: the session set is the state. */
  advance(parent: Agent | undefined): Promise<readonly string[]>
  /**
   * Re-scan the plans after a run settled, under the parent this scheduler last opened children with.
   *
   * **This is what makes a dependency mean anything.** Only a verified run satisfies a sub-task, so a
   * child that verifies makes its dependents `ready` — and if nothing re-scans at that moment, the plan
   * commits, the first sub-task runs, and the rest of it never starts. Advancing only from `decompose`
   * would leave every dependency in the system decorative.
   *
   * The parent is the one the plan was advanced under rather than the agent that settled the run: a
   * child is the plan's child, and opening its sibling under the child's own session would make every
   * sub-task a grandchild of the one before it.
   */
  settled(): Promise<readonly string[]>
  /** Stop and release every child this scheduler opened. Returns the exits that failed, by name. */
  close(): Promise<readonly string[]>
}

/**
 * How one child session is actually opened.
 *
 * A port, because *when* a session is opened and *what* it is told are this module's rules, while how a
 * DSH child agent is created is the runtime's business — and a spec that had to build a real agent
 * session to assert the rules would be asserting the runtime instead.
 */
export type OpenChild = (request: ChildSessionRequest) => Promise<ChildSession>

/**
 * One scheduler per deployment, holding its own children.
 *
 * The set is the idempotence: a sub-task with a live session is skipped, so a boot, a reload and a
 * second caller all converge on "the sessions that should exist" without a guard to keep in sync.
 */
export function createScheduler(apparatus: Apparatus, seams: ChildSessionSeams, open: OpenChild = request => openChildSession(seams, request)): Scheduler {
  const live = new Map<string, ChildSession>()
  let parent: Agent | undefined
  const openReady = async (under: Agent): Promise<readonly string[]> => {
    const opened: string[] = []
    for (const plan of projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION))) {
      for (const child of plan.children) {
        if (child.status !== 'ready' || live.has(child.taskId)) continue
        try {
          opened.push(await openOne(apparatus, under, live, child.taskId, open))
        } catch (error) {
          // One child that cannot open does not stop its siblings, and the failure is named rather than
          // swallowed. This matters most in the settle path: the run that just settled *did* settle, and
          // an unrelated child's failure must not be reported to the model as its submission failing —
          // nor may it silently prevent the rest of the plan from starting. `advance` is idempotent, so
          // the child that failed is retried by the next scan while this one carries on.
          process.stderr.write(
            `singularity: sub-task "${child.taskId}" could not be started (${plan.parentTaskId}); its plan is unaffected and the next advance retries it: ${error instanceof Error ? error.message : String(error)}\n`,
          )
        }
      }
    }
    return opened
  }
  return {
    advance: async given => {
      if (given === undefined)
        refuse(
          'malformed-declaration',
          'a plan is ready to be advanced with no parent agent to open child sessions under; a child is somebody\'s child, and one opened without a parent would have no preset, no route and no write-lease owner',
        )
      parent = given
      return await openReady(given)
    },
    settled: async () => {
      // Nothing was ever advanced, so this deployment holds no plan whose children this process could
      // open — and saying so is better than returning an empty list that reads like "nothing was ready".
      if (parent === undefined) return []
      return await openReady(parent)
    },
    close: async () => {
      const failures: string[] = []
      for (const [taskId, session] of live) {
        try {
          session.stop()
          await closeAgentSession(taskId)
          live.delete(taskId)
        } catch (error) {
          failures.push(`${taskId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return failures
    },
  }
}

/**
 * Open one child session and give it its instruction.
 *
 * The workspace is prepared first, because the instruction says it is ready — and the child's task
 * already exists by definition, since `ready` means the plan's child has an admitted contract and a
 * budget left. `say` is where the run actually starts: `openChildSession` composes the agent, and the
 * message is what makes it work.
 */
async function openOne(apparatus: Apparatus, parent: Agent, live: Map<string, ChildSession>, childTaskId: string, open: OpenChild): Promise<string> {
  const state = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, childTaskId)
  if (state === undefined || state.contract === undefined)
    refuse('illegal-transition', `sub-task "${childTaskId}" is called ready by its plan but this control holds no admitted contract for it, so there is no work to hand to a session`)
  const workspace = workspaceOf(apparatus, childTaskId)
  await prepareWorkspace(apparatus.domain, workspace)
  // Annotated rather than inferred: the request is this module's whole contract with the child-session
  // seam, so a field that stops being accepted has to fail here rather than at the seam's own call site.
  const request: ChildSessionRequest = {
    agentId: childTaskId,
    cwd: workspace,
    parent,
    model: modelOf(parent),
    compose: () => undefined,
  }
  const session = await open(request)
  live.set(childTaskId, session)
  try {
    await session.say(instructionFor(state, workspace, apparatus.domain.artifact))
  } catch (error) {
    // A child whose instruction could not be delivered is not left in the map: it holds a write lease,
    // and a lease whose owner nobody can address again is the leak this module exists to avoid.
    live.delete(childTaskId)
    await closeAgentSession(childTaskId).catch(() => undefined)
    throw error
  }
  return childTaskId
}

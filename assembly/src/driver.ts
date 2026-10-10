/**
 * The driver: the host's service, and the surface one call drives.
 *
 * `forCall(exec)` resolves the live caller into a surface that runs as *that* caller — its own key, its
 * own node, no field in any tool schema to claim one — and the store, with recovery, opens here first.
 * `read()` and the projection behind it live in `snapshot.ts`, where a reader with no call to make can
 * be told about them.
 *
 * @module @dangosys/dsh-singularity-next/driver
 */

import { mkdir } from 'node:fs/promises'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { DecompositionChild } from '../../src/task/decomposition.ts'
import { projectReceipt, projectTask, type ReceiptView, type TaskView } from '../../src/task/view.ts'
import { bindCaller, callerOf, openApparatus, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import type { Domain } from './domain.ts'
import { taskIdOf } from './ids.ts'
import { repair } from './repair.ts'
import { createScheduler, type Scheduler } from './scheduler.ts'
import { submit, workspaceOf, type Submission } from './submission.ts'
import { prepareWorkspace } from './workspace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularity: TaskService
  }
}
/** The host service: per-call surfaces for the tools, and one read projection for everything else. */
export interface TaskService {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  /** Open a session for every ready sub-task that has none. `undefined` is refused, never defaulted. */
  advance(parent: Agent | undefined): Promise<readonly string[]>
}
export interface AgentTaskSurface {
  propose(input: { readonly goal: string }): Promise<Proposal>
  /** Declare a plan for a task the caller holds, then open what it made ready. */
  decompose(input: { readonly taskId: string; readonly children: readonly DecompositionChild[] }): Promise<PlanRecord>
  submit(input: { readonly taskId: string; readonly program: string }): Promise<Submission>
  status(input: { readonly taskId: string }): Promise<Status>
}

export interface PlanRecord {
  readonly taskId: string
  /** The sub-tasks this call opened sessions for: the plan's own `ready` set at this cut. */
  readonly opened: readonly string[]
}

export interface Proposal {
  readonly taskId: string
  readonly workspace: string
  readonly criterionId: string
  readonly phase: TaskView['phase']
}

export interface Status {
  readonly phase: TaskView['phase']
  readonly runs: number
  /** Null while no attempt has settled: a receipt is what a terminal run leaves behind. */
  readonly receipt: ReceiptView | null
}

export interface DriverOptions {
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
}

export interface TaskDriver {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  /** Open a session for every ready sub-task that has none, under this deployer's own agent. */
  advance(parent: Agent | undefined): Promise<readonly string[]>
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence)
  await repair(apparatus)
  const scheduler = createScheduler(apparatus, options.seams)
  return {
    forCall: exec => {
      const caller = callerOf(exec.agent)
      const callId = String(exec.callId)
      return {
        propose: input => propose(apparatus, caller, input),
        decompose: input => decompose(apparatus, scheduler, caller, exec.agent, input),
        submit: input => submit(apparatus, caller, callId, input),
        status: input => status(apparatus, caller, input),
      }
    },
    read: async () => snapshotOf(apparatus),
    advance: parent => scheduler.advance(parent),
    close: async () => {
      // The children go first: each holds a session write lease this process took, and the store's own
      // close would leave those leases with no owner if the process outlived them.
      await scheduler.close()
      await apparatus.store.close()
    },
  }
}

/**
 * Record a plan and start what it made ready.
 *
 * The plan is committed first, the sessions second: a plan whose sub-tasks never started is a readable
 * fact an operator can act on, while a session whose task nobody admitted would be work the log cannot
 * attribute. A failure to open one does not undo the plan — `advance` is idempotent, so the next advance
 * retries exactly the children that have no session yet.
 */
async function decompose(
  apparatus: Apparatus,
  scheduler: Scheduler,
  caller: Caller,
  parent: Agent | undefined,
  input: { readonly taskId: string; readonly children: readonly DecompositionChild[] },
): Promise<PlanRecord> {
  await bindCaller(apparatus, caller)
  await apparatus.tasks.forAgent(caller.agentId).decompose({ commandId: `decompose:${input.taskId}`, parentTaskId: input.taskId, children: input.children })
  return { taskId: input.taskId, opened: await scheduler.advance(parent) }
}

/**
 * Admit one task for the caller and assign it to them: both run through `forAgent`, so responsibility
 * is the identity the live agent resolves to.
 *
 * The workspace is prepared from the domain's own material before the task is admitted, so a refusal to
 * stage happens before any fact claims the task exists. Both submissions start from the same bytes: a
 * `program` shape has only its protected input staged, and a `source` shape additionally has its seed.
 */
async function propose(apparatus: Apparatus, caller: Caller, input: { readonly goal: string }): Promise<Proposal> {
  await bindCaller(apparatus, caller)
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, input.goal)
  const workspace = workspaceOf(apparatus, taskId)
  await mkdir(workspace, { recursive: true })
  await prepareWorkspace(apparatus.domain, workspace)
  const [declared] = apparatus.domain.inputs
  if (declared === undefined)
    refuse('malformed-declaration', 'the domain declares no input, so a task proposed here would have nothing to be judged against')
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.admit({
    commandId: `admit:${taskId}`,
    taskId,
    contract: { goal: input.goal, inputs: [declared.path], criteria: [apparatus.domain.criterion] },
  })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  return { taskId, workspace, criterionId: apparatus.domain.criterion.criterionId, phase: projectTask(taskStateOf(apparatus, taskId)).phase }
}
async function status(apparatus: Apparatus, caller: Caller, input: { readonly taskId: string }): Promise<Status> {
  const state = taskStateOf(apparatus, input.taskId)
  // A read is still a read of somebody's task: the holder's, and nobody else's. It commits nothing.
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', `task "${input.taskId}" is the responsibility of agent "${state.responsibility?.agentId ?? 'nobody'}", so agent "${caller.agentId}" cannot read it`)
  const view = projectTask(state)
  const latest = view.runs.at(-1)
  if (latest === undefined || latest.status === 'running') return { phase: view.phase, runs: view.runs.length, receipt: null }
  return {
    phase: view.phase,
    runs: view.runs.length,
    receipt: projectReceipt(apparatus.registry, apparatus.store.load().entries(), input.taskId, latest.runId),
  }
}

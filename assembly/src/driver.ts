/**
 * The driver: the host's service, and the surface one call drives.
 *
 * `forCall(exec)` resolves the live caller into a surface that runs as *that* caller — its own key, its
 * own node, no field in any tool schema to claim one — and the store, with recovery, opens here first.
 *
 * @module @dangosys/dsh-singularity-next/driver
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { refuse } from '../../src/protocol/refusal.ts'
import { projectReceipt, projectTask, type ReceiptView, type TaskView } from '../../src/task/view.ts'
import { bindCaller, callerOf, openApparatus, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { Domain } from './domain.ts'
import { taskIdOf } from './ids.ts'
import { repair } from './repair.ts'
import { submit, workspaceOf, type Submission } from './submission.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularity: { forCall(exec: ToolRunContext): AgentTaskSurface }
  }
}
export interface AgentTaskSurface {
  propose(input: { readonly goal: string; readonly input: string }): Promise<Proposal>
  submit(input: { readonly taskId: string; readonly program: string }): Promise<Submission>
  status(input: { readonly taskId: string }): Promise<Status>
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
}

export interface TaskDriver {
  forCall(exec: ToolRunContext): AgentTaskSurface
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence)
  await repair(apparatus)
  return {
    forCall: exec => {
      const caller = callerOf(exec.agent)
      const callId = String(exec.callId)
      return {
        propose: input => propose(apparatus, caller, input),
        submit: input => submit(apparatus, caller, callId, input),
        status: input => status(apparatus, caller, input),
      }
    },
    // The workspace and the committed facts belong to the deployment; closing releases the writer only.
    close: () => apparatus.store.close(),
  }
}

/**
 * Admit one task for the caller and assign it to them: both run through `forAgent`, so responsibility
 * is the identity the live agent resolves to.
 */
async function propose(apparatus: Apparatus, caller: Caller, input: { readonly goal: string; readonly input: string }): Promise<Proposal> {
  await bindCaller(apparatus, caller)
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, input.goal)
  const workspace = workspaceOf(apparatus, taskId)
  const inputPath = join(workspace, apparatus.domain.inputPath)
  await mkdir(dirname(inputPath), { recursive: true })
  await writeFile(inputPath, input.input, 'utf8')
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.admit({
    commandId: `admit:${taskId}`,
    taskId,
    contract: { goal: input.goal, inputs: [apparatus.domain.inputPath], criteria: [apparatus.domain.criterion] },
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

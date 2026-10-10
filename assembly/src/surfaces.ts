/**
 * What one call does: the operations a caller's surface exposes.
 *
 * Separate from `driver.ts`, which opens the deployment. These are the acts, read by whoever asks why a
 * call did what it did; the driver is read by whoever asks what is mounted at all.
 *
 * @module @dangosys/dsh-singularity-next/surfaces
 */

import { mkdir } from 'node:fs/promises'

import type { Agent } from '@deepseek-ai/dsh-agent'

import { refuse } from '../../src/protocol/refusal.ts'
import { projectReceipt, projectTask } from '../../src/task/view.ts'
import { bindCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { PlanRecord, PlannedChild, Proposal, Status } from './driver.ts'
import { taskIdOf } from './ids.ts'
import type { Scheduler } from './scheduler.ts'
import { workspaceOf, type Submission } from './submission.ts'
import { prepareWorkspace } from './workspace.ts'

export type { Submission }

/**
 * Record a plan and start what it made ready.
 *
 * **The order is the rule.** Each sub-task is admitted and assigned *before* the plan names it: a plan
 * that declares a task nobody admitted describes work that can never start, because `projectTree` shows
 * such a child as `missing` and never as `ready`. The first version of this function did exactly that,
 * and the sub-task probe found it by never opening a session.
 *
 * The caller supplies keys, goals and dependencies; this layer supplies the identity and the contract.
 * Committing the plan and starting the sessions are separate steps: `advance` is idempotent, so a failure
 * to open one leaves the next advance to retry exactly the children with no session.
 */
export { submit as submitTo } from './submission.ts'

export async function decompose(
  apparatus: Apparatus,
  scheduler: Scheduler,
  caller: Caller,
  parent: Agent | undefined,
  input: { readonly taskId: string; readonly children: readonly PlannedChild[] },
): Promise<PlanRecord> {
  await bindCaller(apparatus, caller)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const declared = apparatus.domain.inputs[0]!

  // One entry per sub-task the model asked for: a stable id derived from its key, a contract from the
  // deployment's own criterion, and a workspace staged from the same material its parent's was.
  const named = await Promise.all(
    input.children.map(async child => {
      const taskId = taskIdOf(apparatus.controlId, input.taskId, child.key)
      const workspace = workspaceOf(apparatus, taskId)
      await mkdir(workspace, { recursive: true })
      await prepareWorkspace(apparatus.domain, workspace)
      return { taskId, contract: { goal: child.goal, inputs: [declared.path], criteria: [apparatus.domain.criterion] }, child }
    }),
  )
  // The children may depend on each other by key, so the dependency set is translated through the same
  // mapping that named them: a plan that kept the model's keys would declare dependencies on tasks that
  // do not exist, which is the defect this whole function exists to avoid.
  const byKey = new Map(input.children.map((child, index) => [child.key, named[index]!.taskId]))
  for (const entry of named) {
    await commands.admit({ commandId: `admit:${entry.taskId}`, taskId: entry.taskId, contract: entry.contract })
    await commands.assign({ commandId: `assign:${entry.taskId}`, taskId: entry.taskId, agentId: caller.agentId })
  }
  await commands.decompose({
    commandId: `decompose:${input.taskId}`,
    parentTaskId: input.taskId,
    children: named.map(entry => ({
      taskId: entry.taskId,
      dependsOn: entry.child.dependsOn.map(key => {
        const resolved = byKey.get(key)
        if (resolved === undefined)
          refuse('malformed-declaration', `sub-task "${entry.child.key}" declares a dependency on "${key}", which is not one of the keys this plan declares; a dependency outside the batch cannot be scheduled`)
        return resolved
      }),
      supports: entry.child.supports,
      maxRuns: entry.child.maxRuns,
    })),
  })
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
export async function propose(apparatus: Apparatus, caller: Caller, input: { readonly goal: string }): Promise<Proposal> {
  await bindCaller(apparatus, caller)
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, input.goal)
  const workspace = workspaceOf(apparatus, taskId)
  await mkdir(workspace, { recursive: true })
  await prepareWorkspace(apparatus.domain, workspace)
  const declared = apparatus.domain.inputs[0]!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.admit({
    commandId: `admit:${taskId}`,
    taskId,
    contract: { goal: input.goal, inputs: [declared.path], criteria: [apparatus.domain.criterion] },
  })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  return { taskId, workspace, criterionId: apparatus.domain.criterion.criterionId, phase: projectTask(taskStateOf(apparatus, taskId)).phase }
}
export async function status(apparatus: Apparatus, caller: Caller, input: { readonly taskId: string }): Promise<Status> {
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
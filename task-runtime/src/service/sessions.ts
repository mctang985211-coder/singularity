/**
 * Session and workspace lifecycle: adoption, drains, ownership and lookups.
 */

import type { TaskRuntime } from './runtime.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RunId, TaskId, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { blockingQuestionsOf, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { DrainResult, JobsView } from '../gate.ts'
import type { AdoptedWorkerResume, AdoptedWorkerResumeRequest } from '../orchestration/types.ts'
import { pendingCoordinationOf } from '../question.ts'
import { appendNotice } from './notify.ts'
import { priorRoundNoticeForRun } from './root-recovery.ts'
import { WorkspaceBusyError, describeOwner, normalizeWorkspacePath } from '../workspace.ts'
import { drainSession } from '../gate.ts'
import type { WorkspaceOwner } from '../workspace.ts'
import type { RunBinding } from '../config.ts'
import { message, now } from '../helpers.ts'

export async function resumeAdoptedWorkerSession(
  self: TaskRuntime,
  request: AdoptedWorkerResumeRequest,
): Promise<AdoptedWorkerResume> {
  const sessionId = request.run.sessionId
  const continuing = self.startedSessions.has(sessionId)
  /**
   * A session already live here is one this process holds: the resume is not
   * repeated (it would be an ownership conflict by construction), and only the
   */
  const live = self.agentOrUndefined(sessionId) !== undefined
  const bound = self.sessions.get(sessionId)
  if (live && (bound === undefined || bound.storeId !== request.storeId || bound.runId !== request.run.runId)) {
    throw new Error(`task-runtime: Session "${sessionId}" is live under another owner or Run binding`)
  }
  if (!live) {
    const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
    await self.context.agentRuntime.resumeWorkerAgent({
      sessionId: SessionId(sessionId),
      scope: { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId },
      run: {
        storeId: request.storeId,
        taskId: request.run.taskId,
        runId: request.run.runId,
        sessionId: SessionId(sessionId),
        ...(request.run.agentPreset === undefined ? {} : { agentPreset: request.run.agentPreset }),
        capabilitySnapshot: request.run.capabilitySnapshot,
      },
      grant: request.grant,
      ...(request.permissionPreset === undefined ? {} : { permissionPreset: request.permissionPreset }),
      taskWorker: request.taskWorker,
    })
  }
  self.sessions.set(sessionId, { storeId: request.storeId, taskId: request.run.taskId, runId: request.run.runId })
  self.startedSessions.add(sessionId)
  await applyResumedSessionGate(self, request.storeId, sessionId, request.run.runId)
  if (!live) {
    const drained = await drainAdoptedSession(self, sessionId)
    if (!drained.confirmed) {
      await stopAdoptedSession(self, sessionId)
      throw new Error(
        `task-runtime: managed work of Session "${sessionId}" could not be confirmed stopped: ${drained.pending.join('; ')}`,
      )
    }
  }
  const snapshot = await self.context.task.snapshotIn(request.storeId)
  const blockedOnOwnQuestion = blockingQuestionsOf(snapshot, request.run.runId).length > 0
  const coordinationPending =
    request.run.executionPhase === 'waiting_children' && pendingCoordinationOf(snapshot, request.run.runId).length > 0
  if (!continuing && (request.run.executionPhase === 'active' || coordinationPending)) {
    const prior = priorRoundNoticeForRun(snapshot, request.run)
    const notice =
      'task-runtime: continue this same Run from the persisted conversation. Check any interrupted tool action without a receipt before repeating it; handle any unresolved Task questions from the conversation, then continue work allowed in your current execution phase and submit when ready.' +
      (prior === undefined ? '' : `\n${prior}`)
    if (blockedOnOwnQuestion) appendNotice(self, sessionId, notice)
    else self.notifyWhenReady(sessionId, notice)
  }
  return { status: 'live' }
}

export async function applyResumedSessionGate(
  self: TaskRuntime,
  storeId: string,
  sessionId: string,
  runId: RunId,
): Promise<void> {
  const token = self.executionGate.decisionToken(sessionId)
  const snapshot = await self.context.task.snapshotIn(storeId)
  const run = snapshot.runs.find(candidate => candidate.runId === runId)
  if (run === undefined) throw new Error(`task-runtime: resumed Run "${runId}" is absent from store "${storeId}"`)
  gatePhaseFromStore(self, sessionId, run, storeId, token)
  self.executionGate.applyStoreQuestionsBlocked(sessionId, blockingQuestionsOf(snapshot, runId).length > 0, token)
}

export async function drainAdoptedSession(self: TaskRuntime, sessionId: string): Promise<DrainResult> {
  return await drainSession(self.executionGate, sessionId, {
    timeoutMs: self.config.writeDrainTimeoutMs,
    jobs: self.softService<JobsView>('jobs'),
    agent: self.agentOrUndefined(sessionId),
  })
}

export async function stopAdoptedSession(self: TaskRuntime, sessionId: string): Promise<void> {
  try {
    await self.context.agentRuntime.stopAgents([SessionId(sessionId)])
  } catch (error) {
    self.warn(`session ${sessionId}: the resumed worker could not be stopped again (${message(error)})`)
  }
}

export async function rebuildWorkspaceOwnership(self: TaskRuntime, storeId: string): Promise<void> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const rootTaskId = snapshot.tasks.find(task => task.parentTaskId === undefined)?.taskId
  // The checkout is held by the run bound to the root session — or by a recovery
  // attempt of that task, whose own session replaces the source run's.
  const rootRun =
    snapshot.runs.find(run => run.status === 'running' && rootTaskStoreId(run.sessionId) === storeId) ??
    snapshot.runs.find(run => run.status === 'running' && run.taskId === rootTaskId && run.recovery !== undefined)
  if (rootRun === undefined) {
    await releaseStoreWorkspace(self, storeId)
    return
  }
  const workspace = await workspacePathForSession(self, rootRun.sessionId)
  if (workspace === undefined) return
  const held = self.workspaces.ownerOf(workspace)
  if (held !== undefined) {
    if (held.storeId !== storeId)
      throw new Error(`task-runtime: workspace ${workspace} is held by ${describeOwner(held)}`)
    return
  }
  const adoption = await self.workspaces.reconcileAdopt(workspace)
  if (!adoption.adopted) throw new Error(`task-runtime: cannot take over workspace ${workspace}: ${adoption.reason}`)
  let owner: WorkspaceOwner = { kind: 'run', storeId, taskId: rootRun.taskId, runId: rootRun.runId, since: now() }
  await self.workspaces.claim(workspace, owner)
  let run = rootRun
  while (run.executionPhase === 'waiting_children') {
    const batch = run.batches?.find(batch => batch.batchId === run.batchId)
    if (batch === undefined)
      throw new Error(`task-runtime: Run "${run.runId}" has no identifiable persisted child batch`)
    const next: WorkspaceOwner = { kind: 'batch', storeId, taskId: run.taskId, batchId: batch.batchId, since: now() }
    await self.workspaces.push(workspace, owner, next)
    owner = next
    const children = snapshot.runs.filter(
      child => child.status === 'running' && batch.memberTaskIds.includes(child.taskId),
    )
    if (children.length > 1)
      throw new Error(`task-runtime: batch "${batch.batchId}" holds multiple running workspace writers`)
    if (children.length === 0) break
    run = children[0]!
    const childOwner: WorkspaceOwner = { kind: 'run', storeId, taskId: run.taskId, runId: run.runId, since: now() }
    await self.workspaces.push(workspace, owner, childOwner)
    owner = childOwner
  }
}

export async function releaseStoreWorkspace(self: TaskRuntime, storeId: string): Promise<void> {
  if (self.workspaces === undefined) return
  const sessionId = recoverySessionFor(self, undefined, storeId)
  const workspace = await workspacePathForSession(self, sessionId)
  if (workspace === undefined) return
  for (;;) {
    const top = self.workspaces.ownerOf(workspace)
    if (top === undefined) return
    if (top.storeId !== storeId) {
      self.warn(
        `workspace ${workspace} holds a layer of store ${top.storeId} (${top.kind}) while store ${storeId} is being cancelled; ` +
          "only this process's own layers are released here",
      )
      return
    }
    await self.workspaces.release(workspace, top)
  }
}

export function recoverySessionFor(self: TaskRuntime, snapshot: TaskSnapshot | undefined, storeId: string): string {
  const rootRun = snapshot?.runs.find(
    run => run.taskId === snapshot.tasks.find(task => task.parentTaskId === undefined)?.taskId,
  )
  if (rootRun !== undefined) return rootRun.sessionId
  for (const [sessionId, binding] of self.sessions) {
    if (binding.storeId === storeId) return sessionId
  }
  return storeId
}

export async function sessionForStore(self: TaskRuntime, storeId: string): Promise<string> {
  try {
    return recoverySessionFor(self, await self.context.task.snapshotIn(storeId), storeId)
  } catch {
    return storeId
  }
}

export async function runForSession(
  self: TaskRuntime,
  sessionId: string,
): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {
  const found = await lookupRun(self, sessionId)
  if (found === undefined) throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`)
  return found
}

export function allowsRuntimeDecomposition(self: TaskRuntime): boolean {
  return self.config.allowRuntimeDecomposition
}

export function gatePhaseFromStore(
  self: TaskRuntime,
  sessionId: string,
  run: TaskRun,
  storeId: string,
  token: number,
): void {
  if (self.closingStores.has(storeId) && self.executionGate.phaseOf(sessionId) !== undefined) return
  const phase = self.runGatePhase(run)
  if (phase === undefined) return
  self.executionGate.applyStorePhase(sessionId, phase, token)
}

export async function lookupRun(
  self: TaskRuntime,
  sessionId: string,
): Promise<{ storeId: string; task: TaskInstance; run: TaskRun } | undefined> {
  const binding = self.sessions.get(sessionId)
  if (binding !== undefined) {
    const resolved = await resolveBinding(self, binding)
    if (resolved !== undefined) return resolved
    self.sessions.delete(sessionId)
  }
  let rootSessionId: string
  try {
    const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
    rootSessionId = graph.rootSessionId
  } catch {
    return undefined
  }
  const storeId = rootTaskStoreId(rootSessionId)
  let snapshot: TaskSnapshot
  try {
    snapshot = await self.context.task.openStore(storeId)
    reindex(self, storeId, snapshot)
  } catch {
    return undefined
  }
  const rebinding = self.sessions.get(sessionId)
  if (rebinding === undefined) return undefined
  return await resolveBinding(self, rebinding)
}

export async function resolveBinding(
  self: TaskRuntime,
  binding: RunBinding,
): Promise<{ storeId: string; task: TaskInstance; run: TaskRun } | undefined> {
  try {
    const [task, run] = await Promise.all([
      self.context.task.taskIn(binding.storeId, binding.taskId),
      self.context.task.runIn(binding.storeId, binding.runId),
    ])
    return { storeId: binding.storeId, task, run }
  } catch {
    return undefined
  }
}

export function reindex(self: TaskRuntime, storeId: string, snapshot: TaskSnapshot): void {
  for (const run of snapshot.runs) {
    self.sessions.set(run.sessionId, { storeId, taskId: run.taskId, runId: run.runId })
  }
}

export async function workspacePathForSession(self: TaskRuntime, sessionId: string): Promise<string | undefined> {
  const path = await self.envPathForSession(sessionId)
  if (path === undefined) return undefined
  try {
    return await normalizeWorkspacePath(path)
  } catch (error) {
    self.warn(`workspace ownership is skipped for session ${sessionId}: ${message(error)}`)
    return undefined
  }
}

export async function workspacePathFor(self: TaskRuntime, sessionId: string): Promise<string | undefined> {
  return self.envPathForSession(sessionId)
}

export async function assertWorkspaceHeldBy(
  self: TaskRuntime,
  workspace: string,
  storeId: string,
  parentTask: TaskInstance,
  parentRunId: RunId,
): Promise<void> {
  if (self.workspaces === undefined) return
  const top = self.workspaces.ownerOf(workspace)
  if (top === undefined) {
    throw new WorkspaceBusyError(
      workspace,
      undefined,
      undefined,
      `store ${storeId} does not hold this workspace in this process; the run ${parentRunId} would be writing into a checkout ` +
        'nobody claimed (claim it through the graph entry, or resolve the ownership marker first)',
    )
  }
  if (top.storeId !== storeId) {
    throw new WorkspaceBusyError(
      workspace,
      top,
      top.since,
      `it is held by another store (${top.storeId}), not by ${storeId}`,
    )
  }
  if (top.taskId === parentTask.taskId) return
  /**
   * An ancestor of this task holds it: the delegation chain the nested-child
   * case walks (a grandchild's own decomposition happens under its parent's
   */
  let ancestor = parentTask.parentTaskId
  while (ancestor !== undefined) {
    if (top.taskId === ancestor) return
    ancestor = await ancestorTaskIdFor(self, storeId, ancestor)
  }
  throw new WorkspaceBusyError(
    workspace,
    top,
    top.since,
    `it is held by ${top.kind} ${top.taskId ?? top.batchId ?? ''}, which is not run ${parentRunId}'s own run, its batch, or one of its ancestors`,
  )
}

export async function ancestorTaskIdFor(
  self: TaskRuntime,
  storeId: string,
  taskId: TaskId,
): Promise<TaskId | undefined> {
  try {
    return (await self.context.task.taskIn(storeId, taskId)).parentTaskId
  } catch {
    return undefined
  }
}

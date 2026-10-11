import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { RunState } from '../../src/task/protocol.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { runIdOf, sha256 } from './ids.ts'
import { prepareWorkspace } from './workspace.ts'

export const workspaceOf = (apparatus: Apparatus, taskId: string, runId: string): string =>
  join(apparatus.workspaceRoot, 'tasks', taskId, 'runs', runId)

export async function startAttempt(apparatus: Apparatus, caller: Caller, taskId: string, operationId: string): Promise<RunState> {
  const runId = runIdOf(apparatus.controlId, caller.sessionId, operationId)
  const recorded = taskStateOf(apparatus, taskId).runs[runId]
  if (recorded?.bubble !== undefined) return recorded
  const basis = sha256(`${apparatus.domain.templateDigest}\u0000${taskId}`)
  const revisionId = `rev-${basis.slice(0, 16)}`
  await apparatus.environments.createRevision({
    commandId: `revision:${basis}`, environmentId: apparatus.controlId, revisionId,
    manifest: { taskTemplate: apparatus.domain.templateDigest, task: taskId },
  })
  const revision = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, apparatus.controlId)?.revisions[revisionId]
  if (revision === undefined) refuse('unknown-revision', `revision "${revisionId}" is not committed`)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.startRun({ commandId: `start:${runId}`, taskId, runId,
    revision: { environmentId: apparatus.controlId, revisionId, digest: revision.contentDigest } })
  const workspace = workspaceOf(apparatus, taskId, runId)
  try {
    await prepareWorkspace(apparatus.domain, workspace)
    await commands.openBubble({ commandId: `bubble:${taskId}/${runId}`, taskId, runId,
      inputs: apparatus.domain.inputs.map(input => ({ name: input.path, digest: input.digest })),
      workspace: { kind: 'dir', ref: workspace }, model: caller.model,
      tools: [{ name: 'node', version: process.version, implementationDigest: await toolchainDigest() }], conditions: [] })
  } catch (error) {
    await commands.failRun({ commandId: `prepare-failed:${taskId}/${runId}`, taskId, runId, reason: String(error) })
    throw error
  }
  return taskStateOf(apparatus, taskId).runs[runId]!
}

let toolchain: Promise<string> | undefined
const toolchainDigest = (): Promise<string> => (toolchain ??= readFile(process.execPath).then(sha256))

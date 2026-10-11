import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { RevisionRef, RunState } from '../../src/task/protocol.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { templateOf } from './domain.ts'
import { resolveInputs } from './inputs.ts'
import { runIdOf, sha256 } from './ids.ts'
import { prepareWorkspace } from './workspace.ts'
import { loadMethod } from './method.ts'
import { consumeMethod } from './method-run.ts'

export const workspaceOf = (apparatus: Apparatus, taskId: string, runId: string): string =>
  join(apparatus.workspaceRoot, 'tasks', taskId, 'runs', runId)

export async function startAttempt(apparatus: Apparatus, caller: Caller, taskId: string, operationId: string, method?: RevisionRef): Promise<RunState> {
  const runId = runIdOf(apparatus.controlId, caller.sessionId, operationId)
  const state = taskStateOf(apparatus, taskId)
  const recorded = state.runs[runId]
  if (recorded?.bubble !== undefined) return recorded
  const contract = state.contract!
  const domain = method === undefined ? apparatus.domain : (await loadMethod(apparatus, method)).domain
  const template = templateOf(domain, contract.template)
  const inputs = resolveInputs(apparatus, contract, domain)
  const manifest = { task: taskId, taskTemplate: contract.template,
    ...(method === undefined ? {} : { method }),
    inputSources: inputs.map(({ name, digest, source }) => ({ name, digest, source })) }
  const basis = sha256(JSON.stringify(manifest))
  const revisionId = `rev-${basis.slice(0, 16)}`
  await apparatus.environments.createRevision({
    commandId: `revision:${basis}`, environmentId: apparatus.controlId, revisionId,
    manifest,
  })
  const revision = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, apparatus.controlId)?.revisions[revisionId]
  if (revision === undefined) refuse('unknown-revision', `revision "${revisionId}" is not committed`)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const start = () => commands.startRun({ commandId: `start:${runId}`, taskId, runId,
    revision: { environmentId: apparatus.controlId, revisionId, digest: revision.contentDigest } })
  if (apparatus.budget === undefined) await start()
  else await apparatus.budget.startRun(taskId, runId, start)
  const workspace = workspaceOf(apparatus, taskId, runId)
  try {
    await prepareWorkspace(template, inputs, workspace)
    await commands.openBubble({ commandId: `bubble:${taskId}/${runId}`, taskId, runId,
      inputs: inputs.map(({ name, digest }) => ({ name, digest })),
      workspace: { kind: 'dir', ref: workspace }, model: caller.model,
      tools: [{ name: 'node', version: process.version, implementationDigest: await toolchainDigest() }, ...(domain.measurement?.tools ?? [])],
      conditions: domain.measurement?.conditions ?? [] })
    if (method !== undefined) await consumeMethod(apparatus, taskId, taskStateOf(apparatus, taskId).runs[runId]!, 'template', `template:${method.digest}/${template.id}`)
  } catch (error) {
    await commands.failRun({ commandId: `prepare-failed:${taskId}/${runId}`, taskId, runId, reason: String(error) })
    throw error
  }
  return taskStateOf(apparatus, taskId).runs[runId]!
}

let toolchain: Promise<string> | undefined
const toolchainDigest = (): Promise<string> => (toolchain ??= readFile(process.execPath).then(sha256))

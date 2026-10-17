import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stoppedExplorationOf } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { RevisionRef, RunState } from '../../src/task/protocol.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { templateOf, type Domain } from './domain.ts'
import { resolveInputs } from './inputs.ts'
import { runIdOf, sha256 } from './ids.ts'
import { prepareWorkspace } from './workspace.ts'
import { bindingsForContract, loadMethod } from './method.ts'
import { consumeMethod } from './method-run.ts'

export const workspaceOf = (apparatus: Apparatus, taskId: string, runId: string): string =>
  join(apparatus.workspaceRoot, 'tasks', taskId, 'runs', runId)

export async function startAttempt(apparatus: Apparatus, caller: Caller, taskId: string, operationId: string, method: RevisionRef, context?: { domain: Domain; purpose: RunState['purpose']; relatedTo?: RunState['relatedTo'] },
): Promise<RunState> {
  const stopped = stoppedExplorationOf(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), taskId)
  if (stopped !== undefined) refuse('illegal-transition', `exploration ${stopped.taskId} was stopped: ${stopped.reason}`)
  const runId = runIdOf(apparatus.controlId, caller.sessionId, operationId)
  const state = taskStateOf(apparatus, taskId)
  if (state.runs[runId]?.bubble !== undefined) return state.runs[runId]!
  const contract = state.contract!
  const loaded = await loadMethod(apparatus, method)
  const domain = context?.domain ?? loaded.domain
  const bindings = bindingsForContract(contract, loaded.assets)
  const template = contract.template === undefined ? undefined : templateOf(domain, contract.template)
  const inputs = await resolveInputs(apparatus, taskId, contract, domain)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.startRun({ commandId: `start:${runId}`, taskId, runId,
    revision: method,
      purpose: context?.purpose ?? 'solve',
      ...(context?.relatedTo === undefined ? {} : { relatedTo: context.relatedTo }),
    })
  const workspace = workspaceOf(apparatus, taskId, runId)
  try {
    const frozen = await Promise.all(
      inputs.map(async (input) => ({
        name: input.name,
        digest: input.digest,
        ...(input.source.kind === 'artifact' ? { producerRunId: input.source.runId } : {}),
        attachment: await apparatus.attachments.saveFile({ name: input.name, data: await input.read() }),
      })),
    )
    await prepareWorkspace(template ?? { artifact: contract.artifact }, inputs, workspace)
    await commands.openBubble({ commandId: `bubble:${taskId}/${runId}`, taskId, runId,
      inputs: frozen,
      workspace: { kind: 'dir', ref: workspace }, model: caller.model,
      tools: [{ name: 'node', version: process.version, implementationDigest: await toolchainDigest() }, ...(domain.measurement?.tools ?? []),
        ...bindings.tools.map((tool) => ({ name: `method:${tool.name}`, version: tool.digest,
          implementationDigest: tool.digest })),
      ],
      conditions: domain.measurement?.conditions ?? [],
    })
    if (template !== undefined) await consumeMethod(apparatus, taskId, taskStateOf(apparatus, taskId).runs[runId]!, `template:${template.id}`, `template:${template.id}`,
      )
  } catch (error) {
    await commands.failRun({ commandId: `prepare-failed:${taskId}/${runId}`, taskId, runId, reason: String(error) })
    throw error
  }
  return taskStateOf(apparatus, taskId).runs[runId]!
}

let toolchain: Promise<string> | undefined
const toolchainDigest = (): Promise<string> => (toolchain ??= readFile(process.execPath).then(sha256))

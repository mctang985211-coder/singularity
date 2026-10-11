import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { createAgentNodeCommands } from '../../src/agent/commands.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, AGENT_ROLE, declareAgentProtocol } from '../../src/agent/protocol.ts'
import { ControlSessionStore } from '../../src/control/session-store.ts'
import { createEnvironmentCommands } from '../../src/environment/commands.ts'
import { declareEnvironmentProtocol, ENVIRONMENT_ROLE, PUBLISHER_ROLE } from '../../src/environment/protocol.ts'
import { declareMeasureProtocol } from '../../src/measure/protocol.ts'
import { declareStrategyProtocol, STRATEGY_ROLE } from '../../src/strategy/protocol.ts'
import { declareReleaseProtocol, APPROVER_ROLE } from '../../src/release/protocol.ts'
import { ProtocolRegistry } from '../../src/protocol/registry.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { createTaskCommands, type HeldAgent, type TaskCommands } from '../../src/task/commands.ts'
import type { Bubble } from '../../src/task/bubble.ts'
import { declareTaskProtocol, SCHEDULER_ROLE, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf, type TaskState } from '../../src/task/protocol.ts'
import type { Domain } from './domain.ts'

export interface Apparatus {
  readonly attachments: Pick<AttachmentStore, 'saveFile' | 'readFileStream'>
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
  readonly tasks: TaskCommands
  readonly environments: ReturnType<typeof createEnvironmentCommands>
  readonly agents: ReturnType<typeof createAgentNodeCommands>
  readonly held: Map<string, HeldAgent>
}
function subjectsOf(controlId: string, domain: Domain): Record<string, string> {
  const subjects: Record<string, string> = {
    [SCHEDULER_ROLE]: `${controlId}:scheduler`,
    [AGENT_ROLE]: `${controlId}:runtime`,
    [ENVIRONMENT_ROLE]: `${controlId}:environment`,
    [STRATEGY_ROLE]: `${controlId}:strategy`,
    [PUBLISHER_ROLE]: `${controlId}:publisher`,
    [APPROVER_ROLE]: `${controlId}:approver`,
  }
  for (const verifier of domain.verifiers)
    subjects[verifierRoleOf({ verifierRef: verifier.ref, verifierVersion: verifier.version })] = `${controlId}:verifier:${verifier.ref}@${verifier.version}`
  return subjects
}
export async function openApparatus(controlId: string, workspaceRoot: string, domain: Domain, persistence: SessionPersistence,
  attachments: Apparatus['attachments']): Promise<Apparatus> {
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareAgentProtocol(registry)
  declareEnvironmentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  declareReleaseProtocol(registry)
  const store = await ControlSessionStore.open({ persistence, controlId, registry, subjects: subjectsOf(controlId, domain), cwd: workspaceRoot })
  const held = new Map<string, HeldAgent>()
  return {
    attachments,
    controlId,
    workspaceRoot,
    domain,
    store,
    registry,
    held,
    tasks: createTaskCommands({ store, registry, agents: held, implementations: domain.verifiers }),
    environments: createEnvironmentCommands({ store, registry }),
    agents: createAgentNodeCommands({ store, registry }),
  }
}
export interface Caller {
  readonly agentId: string
  readonly sessionId: string
    readonly model: Bubble['model']
}
export function callerOf(agent: Agent | undefined): Caller {
  if (agent === undefined)
    refuse('unknown-emitter-role', 'this call arrived with no agent, and every fact this package produces is attributed to a caller; an anonymous call is refused rather than attributed to whoever the deployment happens to hold')
  const header = agent.session.requestHeader()
  if (header === undefined)
    refuse('malformed-declaration', `agent "${agent.id}" has no request header, so the model that produced this program cannot be named; a bubble names what actually ran, never a guess`)
  return { agentId: agent.id, sessionId: agent.session.id, model: { provider: header.config.provider, model: header.config.model } }
}
export function declareCaller(apparatus: Apparatus, agentId: string): string {
  const key = `agent:${agentId}`
  apparatus.store.declareSubject(key, `${apparatus.controlId}:agent:${agentId}`)
  apparatus.held.set(agentId, { as: key })
  return key
}
export async function bindCaller(apparatus: Apparatus, caller: Caller): Promise<string> {
  const key = declareCaller(apparatus, caller.agentId)
  if (apparatus.store.load().stateOf(AGENT_PROTOCOL, AGENT_VERSION, caller.agentId) === undefined)
    await apparatus.agents.open({ commandId: `agent:${caller.agentId}`, agentId: caller.agentId, sessionId: caller.sessionId, role: 'root' })
  return key
}
export function taskStateOf(apparatus: Apparatus, taskId: string): TaskState {
  const state = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId)
  if (state === undefined || state.contract === undefined)
    refuse('illegal-transition', `task "${taskId}" has no admitted contract in this control, so there is nothing to read or submit to`)
  return state
}

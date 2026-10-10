/**
 * One live control store over a real JSONL session, with the three protocols declared, plus the
 * facts a command-boundary spec needs: an opened agent, a created revision, and a planned parent.
 *
 * Shared so a spec about preconditions and a spec about revision pinning can both stay small. The
 * cleanup hook is registered here, because vitest collects the hooks of every module in the
 * importing file's graph.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach } from 'vitest'

import {
  AGENT_ROLE,
  createAgentNodeCommands,
  createEnvironmentCommands,
  createTaskCommands,
  declareAgentProtocol,
  declareEnvironmentProtocol,
  declareTaskProtocol,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  ProtocolRegistry,
  ProtocolRegistry as Registry,
  verifierRoleOf,
  type EnvironmentState,
} from '../src/index.ts'
import { ControlSessionStore } from '../src/control/session-store.ts'
import { contract as parentContract, INTEGRATION_VERIFIER, SCHEDULER, UNIT_IMPLEMENTATION, UNIT_VERIFIER } from './task-fixtures.ts'

export const PARENT = 'task-parent'
export const CHILD = 'task-child'
export const RUN = 'run-1'
export const AGENT = 'agent-1'
export const ENVIRONMENT = 'library-1'
export const REVISION = 'r0001'
export const MANIFEST = { skills: ['count'] }

const SUBJECTS: Readonly<Record<string, string>> = {
  scheduler: SCHEDULER,
  [ENVIRONMENT_ROLE]: 'environment-service',
  [AGENT_ROLE]: 'runtime-service',
  [verifierRoleOf({ verifierRef: UNIT_VERIFIER, verifierVersion: '1' })]: 'unit-verifier-service',
  [verifierRoleOf({ verifierRef: INTEGRATION_VERIFIER, verifierVersion: '1' })]: 'integration-verifier-service',
}

export function registry(): ProtocolRegistry {
  const made = new Registry()
  declareTaskProtocol(made)
  declareEnvironmentProtocol(made)
  declareAgentProtocol(made)
  return made
}

export interface Deployment {
  readonly store: ControlSessionStore
  readonly persistence: SessionPersistence
  readonly root: string
  readonly context: Context
  readonly registry: ProtocolRegistry
}

const deployments: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const live of deployments.splice(0)) {
    await live.context.fiber.dispose()
    await rm(live.root, { recursive: true, force: true })
  }
})

/** One live control store over a real JSONL session, with its three protocols declared. */
export async function deployment(subjects: Readonly<Record<string, string>> = SUBJECTS): Promise<Deployment> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-commands-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  deployments.push({ context, root })
  const made = registry()
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence,
    controlId: 'commands',
    registry: made,
    subjects,
  })
  return { store, persistence: context.sessionPersistence, root, context, registry: made }
}

/** The revision the run pins, created through the environment protocol's own command owner. */
export async function createRevision(live: Deployment): Promise<void> {
  await createEnvironmentCommands({ store: live.store, registry: live.registry }).createRevision({
    commandId: 'revision',
    environmentId: ENVIRONMENT,
    revisionId: REVISION,
    manifest: MANIFEST,
  })
}

/** The agent node the assignment needs, recorded by the runtime's own command owner. */
export async function openAgent(live: Deployment): Promise<void> {
  await createAgentNodeCommands({ store: live.store, registry: live.registry }).open({
    commandId: 'agent',
    agentId: AGENT,
    sessionId: `singularity:agent:${AGENT}`,
    role: 'worker',
  })
}

export function commandsFor(live: Deployment, agents = new Map([[AGENT, { as: 'scheduler' }]])) {
  return createTaskCommands({
    store: live.store,
    registry: live.registry,
    agents,
    implementations: [{ ref: UNIT_VERIFIER, version: '1', implementationDigest: UNIT_IMPLEMENTATION }],
  })
}

/** The digest the created revision actually has, read back from the store rather than assumed. */
export function revisionDigest(live: Deployment): string {
  const state = live.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)
  const digest = state?.revisions[REVISION]?.contentDigest
  if (digest === undefined) throw new Error('the revision was not created')
  return digest
}

export const pin = (live: Deployment, overrides: Partial<{ environmentId: string; revisionId: string; digest: string }> = {}) => ({
  environmentId: ENVIRONMENT,
  revisionId: REVISION,
  digest: revisionDigest(live),
  ...overrides,
})

/** A parent with a plan whose only child is `CHILD`, admitted, assigned and ready to start. */
export async function planned(live: Deployment, maxRuns = 1) {
  const commands = commandsFor(live)
  await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })
  await commands.admit({
    commandId: 'admit-child',
    taskId: CHILD,
    contract: {
      goal: 'do the counting part',
      inputs: ['fixture/words.txt'],
      criteria: [{ criterionId: 'part', statement: 'the part counts', verifierRef: UNIT_VERIFIER, verifierVersion: '1', implementationDigest: UNIT_IMPLEMENTATION }],
    },
  })
  // The holder plans: `task/decomposed` requires the actor to be the task's responsible agent, so
  // the parent is assigned before its plan is declared.
  await commands.assign({ commandId: 'assign-parent', taskId: PARENT, agentId: AGENT })
  await commands.decompose({
    commandId: 'plan',
    parentTaskId: PARENT,
    children: [{ taskId: CHILD, dependsOn: [], supports: ['correctness'], maxRuns }],
  })
  await commands.assign({ commandId: 'assign-child', taskId: CHILD, agentId: AGENT })
  return commands
}


/**
 * A task with its contract, its runs and its verifiers, as the fixtures every task spec shares.
 *
 * Two registered verifier implementations, so a verdict can come from the wrong one and be
 * refused. The trusted identities are keyed by emitter role, which for a verdict is
 * `verifier:<ref>@<version>` — so a deployment literally cannot emit a verdict for an
 * implementation it does not hold.
 */

import {
  declareTaskProtocol,
  ProtocolRegistry,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRoleOf,
  type EmitInput,
  type TaskContract,
} from '../src/index.ts'

export const TASK_ID = 'task-a'
export const RUN_ID = 'run-1'
export const SCHEDULER = 'runtime-1'
export const UNIT_VERIFIER = 'unit-verifier'
export const INTEGRATION_VERIFIER = 'integration-verifier'
export const ARTIFACT = 'b'.repeat(64)
/** The content digest of each verifier *implementation*, as its deployment computed it. */
export const UNIT_IMPLEMENTATION = 'd'.repeat(64)
export const INTEGRATION_IMPLEMENTATION = 'e'.repeat(64)

/**
 * The verifier implementations this deployment can currently run, as
 * `id@version#implementationDigest`. A deployment that swapped the code behind a name is not
 * running this entry, which is the hole the digest closes.
 */
export const VERIFIERS = [
  `${UNIT_VERIFIER}@1#${UNIT_IMPLEMENTATION}`,
  `${INTEGRATION_VERIFIER}@1#${INTEGRATION_IMPLEMENTATION}`,
]

/** The trusted identities held, keyed by emitter role. */
export const SUBJECTS: Readonly<Record<string, string>> = {
  scheduler: SCHEDULER,
  [verifierRoleOf({ verifierRef: UNIT_VERIFIER, verifierVersion: '1' })]: 'unit-verifier-service',
  [verifierRoleOf({ verifierRef: INTEGRATION_VERIFIER, verifierVersion: '1' })]: 'integration-verifier-service',
}

/** The named inputs every run in these fixtures declares it executed against. */
export const BUBBLE_INPUTS = [{ name: 'fixture/words.txt', digest: 'f'.repeat(64) }]

/** One revision the run is pinned to, named by its environment and content identity. */
export const REVISION = { environmentId: 'library-1', revisionId: 'r0001', digest: 'a'.repeat(64) }

export function taskRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  return registry
}

/** A contract whose two criteria are decided by two different verifier implementations. */
export function contract(): TaskContract {
  return {
    goal: 'implement a word counter',
    inputs: ['fixture/words.txt'],
    criteria: [
      {
        criterionId: 'correctness',
        statement: 'counts match the golden file',
        verifierRef: UNIT_VERIFIER,
        verifierVersion: '1',
        implementationDigest: UNIT_IMPLEMENTATION,
      },
      {
        criterionId: 'limits',
        statement: 'rejects input over 1 MiB',
        verifierRef: INTEGRATION_VERIFIER,
        verifierVersion: '1',
        implementationDigest: INTEGRATION_IMPLEMENTATION,
      },
    ],
  }
}

let counter = 0

function emit(kind: string, payload: unknown, commandId?: string): EmitInput {
  counter += 1
  return {
    commandId: commandId ?? `task-cmd-${counter}`,
    protocol: TASK_PROTOCOL,
    version: TASK_VERSION,
    kind,
    subject: TASK_ID,
    payload,
  }
}

export const admitted = (value: TaskContract = contract(), commandId?: string): EmitInput =>
  emit(TASK_KINDS.admitted, { contract: value }, commandId)
export const assigned = (commandId?: string, agentIdentity: string = SCHEDULER): EmitInput =>
  emit(TASK_KINDS.assigned, { agentId: 'agent-1', agentIdentity }, commandId)
export const started = (runId = RUN_ID): EmitInput => emit(TASK_KINDS.runStarted, { runId, revision: REVISION })
export const bubbleOpened = (runId = RUN_ID): EmitInput =>
  emit(TASK_KINDS.bubbleOpened, { runId, inputs: BUBBLE_INPUTS, workspace: { kind: 'git', ref: 'refs/heads/main' } })
export const judged = (
  criterionId: string,
  verifierRef: string,
  verdict: 'pass' | 'fail' = 'pass',
  options: {
    runId?: string
    verifierVersion?: string
    implementationDigest?: string
    artifactDigest?: string
    inputDigests?: readonly { readonly name: string; readonly digest: string }[]
    detail?: string
  } = {},
): EmitInput =>
  emit(TASK_KINDS.evidenceProduced, {
    runId: options.runId ?? RUN_ID,
    criterionId,
    verdict,
    verifierRef,
    verifierVersion: options.verifierVersion ?? '1',
    implementationDigest: options.implementationDigest ?? (verifierRef === UNIT_VERIFIER ? UNIT_IMPLEMENTATION : INTEGRATION_IMPLEMENTATION),
    artifactDigest: options.artifactDigest ?? ARTIFACT,
    inputDigests: options.inputDigests ?? BUBBLE_INPUTS,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  })
export const verified = (runId = RUN_ID): EmitInput => emit(TASK_KINDS.runVerified, { runId })
export const failed = (reason?: string, runId = RUN_ID): EmitInput =>
  emit(TASK_KINDS.runFailed, reason === undefined ? { runId } : { runId, reason })

/** The whole slice: admit, start, judge both criteria with their own verifiers, settle. */
export const sliceCommands = (): readonly EmitInput[] => [
  admitted(),
  assigned(),
  started(),
  bubbleOpened(),
  judged('correctness', UNIT_VERIFIER),
  judged('limits', INTEGRATION_VERIFIER),
  verified(),
]

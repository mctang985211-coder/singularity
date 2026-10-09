/**
 * A task with its contract, its runs and its verifiers, as the fixtures every task spec shares.
 *
 * Two registered verifiers, so a verdict can come from the wrong one and be refused.
 */

import {
  declareTaskProtocol,
  ProtocolRegistry,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRegistryOf,
  type EmitInput,
  type TaskContract,
} from '../src/index.ts'

export const TASK_ID = 'task-a'
export const RUN_ID = 'run-1'
export const EXECUTOR = 'worker-session'
export const UNIT_VERIFIER = 'unit-verifier'
export const INTEGRATION_VERIFIER = 'integration-verifier'

/** The verifiers this deployment has registered. */
export const VERIFIERS = [`${UNIT_VERIFIER}@1`, `${INTEGRATION_VERIFIER}@1`]

/** One revision the run is pinned to. */
export const REVISION = { revisionId: 'r0001', digest: 'a'.repeat(64) }

export function taskRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry, verifierRegistryOf(VERIFIERS))
  return registry
}

/** A contract whose two criteria are decided by two different verifiers. */
export function contract(): TaskContract {
  return {
    goal: 'implement a word counter',
    inputs: ['fixture/words.txt'],
    criteria: [
      { criterionId: 'correctness', statement: 'counts match the golden file', verifierRef: UNIT_VERIFIER, verifierVersion: '1' },
      { criterionId: 'limits', statement: 'rejects input over 1 MiB', verifierRef: INTEGRATION_VERIFIER, verifierVersion: '1' },
    ],
  }
}

const emit = (kind: string, actor: string, payload: unknown): EmitInput => ({
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind,
  subject: TASK_ID,
  actor,
  payload,
})

export const admitted = (value: TaskContract = contract(), actor = 'root'): EmitInput =>
  emit(TASK_KINDS.admitted, actor, { contract: value })
export const started = (runId = RUN_ID, actor = EXECUTOR): EmitInput =>
  emit(TASK_KINDS.runStarted, actor, { runId, revision: REVISION })
export const judged = (criterionId: string, actor: string, verdict: 'pass' | 'fail' = 'pass', runId = RUN_ID): EmitInput =>
  emit(TASK_KINDS.evidenceProduced, actor, { runId, criterionId, verdict, detail: `${verdict} on ${criterionId}` })
export const verified = (runId = RUN_ID, actor = 'root'): EmitInput => emit(TASK_KINDS.runVerified, actor, { runId })
export const failed = (reason = 'the golden file never matched', runId = RUN_ID, actor = 'root'): EmitInput =>
  emit(TASK_KINDS.runFailed, actor, { runId, reason })

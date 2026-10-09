/**
 * The task protocol: a contract, its runs, and the independent verdicts that settle them.
 *
 * Three invariants live in the reducers, which is why they cannot be talked around:
 *
 * 1. **A criterion is decided by a named verifier.** The actor of an `evidence/produced` fact
 *    must be exactly the `verifierRef` its criterion names — not a similar one, not a proxy.
 * 2. **An executor never judges its own run.** The verifier that decides a criterion must not
 *    be the actor that ran it, even when the executor happens to be a registered verifier.
 * 3. **A run settles verified only when every criterion has a passing verdict.** No partial
 *    acceptance, no "close enough", and the run's terminal state is the only place a receipt
 *    could ever come from.
 *
 * The verifier registry is captured by the declaration's closures, so the fold enforces the
 * first two purely: a fact that violates them is refused at fold time, not at the caller.
 *
 * @module singularity-core/task/protocol
 */

import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import { assertContract, contractDigest, type TaskContract, type VerifierRegistry } from './contract.ts'

export const TASK_PROTOCOL = 'task'
export const TASK_VERSION = 1

/** The method revision a run is pinned to. Pin the digest too: an id alone can be re-pointed. */
export interface RevisionRef {
  readonly revisionId: string
  readonly digest: string
}

export type RunStatus = 'running' | 'verified' | 'failed'

/** One verifier's verdict on one criterion of one run. */
export interface EvidenceRecord {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  readonly actor: string
  readonly detail: string
  readonly at: string
}

export interface RunState {
  readonly runId: string
  readonly actor: string
  readonly revision: RevisionRef
  readonly startedAt: string
  readonly status: RunStatus
  readonly evidence: readonly EvidenceRecord[]
  readonly finishedAt?: string
  readonly failureReason?: string
}

/** The folded state of one task. `subject` in every envelope is this task's id. */
export interface TaskState {
  readonly taskId: string
  readonly contract?: TaskContract
  readonly contractDigest?: string
  readonly admittedBy?: string
  readonly admittedAt?: string
  readonly runs: Readonly<Record<string, RunState>>
}

export const TASK_KINDS = {
  admitted: 'task/admitted',
  runStarted: 'run/started',
  evidenceProduced: 'evidence/produced',
  runVerified: 'run/verified',
  runFailed: 'run/failed',
} as const

function field(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    refuse('malformed-envelope', `a ${TASK_PROTOCOL} payload must be an object, got ${payload === null ? 'null' : typeof payload}`)
  return payload as Record<string, unknown>
}

function text(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-envelope', `${where} needs a non-empty ${key}, got ${value === null ? 'null' : typeof value}`)
  return value
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The run a fact names, or a refusal naming the run. */
function requireRun(state: TaskState, runId: string, where: string): RunState {
  const run = state.runs[runId]
  if (run === undefined) refuse('unknown-run', `${where} names run "${runId}", which task "${state.taskId}" never started`)
  return run
}

/** One revision reference, pinned by id and digest. */
function revisionOf(raw: unknown, where: string): RevisionRef {
  const record = field(raw)
  return { revisionId: text(record, 'revisionId', where), digest: text(record, 'digest', where) }
}

/**
 * Declare the task protocol. Call once at load with the deployment's verifier registry; the
 * registry is captured here, so every fold of this protocol enforces it.
 */
export function declareTaskProtocol(registry: ProtocolRegistry, verifiers: VerifierRegistry): void {
  registry.declare<TaskState>(TASK_PROTOCOL, TASK_VERSION, {
    initialState: { taskId: '', runs: {} },
    kinds: {
      [TASK_KINDS.admitted]: {
        guarantee: 'G1',
        reduce: (state, envelope) => {
          if (state.contract !== undefined)
            refuse(
              'illegal-transition',
              `task "${state.taskId}" already carries a contract admitted at ${state.admittedAt ?? 'an unrecorded time'}; a later contract is a different task`,
            )
          const where = `${TASK_KINDS.admitted} #${envelope.seq}`
          const contract = assertContract(field(envelope.payload)['contract'], `${where} contract`, verifiers)
          return {
            taskId: envelope.subject,
            contract,
            contractDigest: contractDigest(contract),
            admittedBy: envelope.actor,
            admittedAt: envelope.at,
            runs: {},
          }
        },
      },

      [TASK_KINDS.runStarted]: {
        guarantee: 'G1',
        reduce: (state, envelope) => {
          const where = `${TASK_KINDS.runStarted} #${envelope.seq}`
          if (state.contract === undefined)
            refuse('illegal-transition', `${where} arrived before task "${envelope.subject}" carried a contract`)
          const payload = field(envelope.payload)
          const runId = text(payload, 'runId', where)
          if (state.runs[runId] !== undefined)
            refuse('illegal-transition', `${where} starts run "${runId}" again; one run id is one attempt`)
          const revision = revisionOf(payload['revision'], `${where} revision`)
          return {
            ...state,
            runs: {
              ...state.runs,
              [runId]: {
                runId,
                actor: envelope.actor,
                revision,
                startedAt: envelope.at,
                status: 'running' as const,
                evidence: [],
              },
            },
          }
        },
      },

      [TASK_KINDS.evidenceProduced]: {
        guarantee: 'G1',
        reduce: (state, envelope) => {
          const where = `${TASK_KINDS.evidenceProduced} #${envelope.seq}`
          if (state.contract === undefined)
            refuse('illegal-transition', `${where} arrived before task "${envelope.subject}" carried a contract`)
          const payload = field(envelope.payload)
          const runId = text(payload, 'runId', where)
          const criterionId = text(payload, 'criterionId', where)
          const run = requireRun(state, runId, where)
          if (run.status !== 'running')
            refuse('illegal-transition', `${where} judges run "${runId}", which already settled ${run.status}`)

          const criterion = state.contract.criteria.find(candidate => candidate.criterionId === criterionId)
          if (criterion === undefined)
            refuse('unknown-criterion', `${where} names criterion "${criterionId}", which task "${state.taskId}" does not declare`)

          // Invariant 1: the named verifier decides, and nobody else.
          if (envelope.actor !== criterion.verifierRef)
            refuse(
              'self-reported-evidence',
              `${where} decides criterion "${criterionId}" as "${envelope.actor}", but that criterion names verifier "${criterion.verifierRef}"`,
            )
          // Invariant 2: an executor never judges its own run, even when it is a registered verifier.
          if (envelope.actor === run.actor)
            refuse(
              'self-reported-evidence',
              `${where}: actor "${envelope.actor}" executed run "${runId}" and cannot also decide its criterion "${criterionId}"`,
            )

          if (run.evidence.some(entry => entry.criterionId === criterionId))
            refuse(
              'evidence-conflict',
              `${where}: criterion "${criterionId}" of run "${runId}" already carries a verdict from ${run.evidence.find(entry => entry.criterionId === criterionId)?.actor ?? 'a verifier'}; one criterion has one verdict`,
            )

          const verdict = payload['verdict']
          if (verdict !== 'pass' && verdict !== 'fail')
            refuse('malformed-envelope', `${where} needs verdict "pass" or "fail", got ${JSON.stringify(verdict ?? null)}`)

          return {
            ...state,
            runs: {
              ...state.runs,
              [runId]: {
                ...run,
                evidence: [
                  ...run.evidence,
                  {
                    criterionId,
                    verdict,
                    actor: envelope.actor,
                    detail: optionalText(payload, 'detail') ?? '',
                    at: envelope.at,
                  },
                ],
              },
            },
          }
        },
      },

      [TASK_KINDS.runVerified]: {
        guarantee: 'G1',
        reduce: (state, envelope) => {
          const where = `${TASK_KINDS.runVerified} #${envelope.seq}`
          if (state.contract === undefined)
            refuse('illegal-transition', `${where} arrived before task "${envelope.subject}" carried a contract`)
          const runId = text(field(envelope.payload), 'runId', where)
          const run = requireRun(state, runId, where)
          if (run.status !== 'running')
            refuse('illegal-transition', `${where} settles run "${runId}" again; it is already ${run.status}`)

          // Invariant 3: every criterion needs a passing verdict. No partial acceptance.
          const unanswered = state.contract.criteria.filter(
            criterion => !run.evidence.some(entry => entry.criterionId === criterion.criterionId && entry.verdict === 'pass'),
          )
          if (unanswered.length > 0)
            refuse(
              'unadjudicated-criterion',
              `${where} cannot settle run "${runId}" verified: ${unanswered
                .map(criterion => `"${criterion.criterionId}" has no passing verdict from ${criterion.verifierRef}`)
                .join('; ')}`,
            )

          return { ...state, runs: { ...state.runs, [runId]: { ...run, status: 'verified' as const, finishedAt: envelope.at } } }
        },
      },

      [TASK_KINDS.runFailed]: {
        guarantee: 'G1',
        reduce: (state, envelope) => {
          const where = `${TASK_KINDS.runFailed} #${envelope.seq}`
          const payload = field(envelope.payload)
          const runId = text(payload, 'runId', where)
          const run = requireRun(state, runId, where)
          if (run.status !== 'running')
            refuse('illegal-transition', `${where} settles run "${runId}" again; it is already ${run.status}`)
          const reason = optionalText(payload, 'reason') ?? 'no reason recorded'
          return {
            ...state,
            runs: { ...state.runs, [runId]: { ...run, status: 'failed' as const, finishedAt: envelope.at, failureReason: reason } },
          }
        },
      },
    },
  })
}

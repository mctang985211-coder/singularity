import { searchKinds, type SearchState } from './search.ts'
import { workflowLimitsKind, type WorkflowLimits } from './budget.ts'
import { transferKinds, type TransferState } from './transfer.ts'
import { lifecycleKinds, type TaskClosure, type RSIStatus, type RoundRequest } from './lifecycle.ts'
import { questionKinds, type TaskQuestion } from './questions.ts'
import { digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type MemberSet, type ProtocolRegistry } from '../protocol/registry.ts'
import { AGENT_ROLE } from '../agent/protocol.ts'
import { assertContractShape, CONTRACT_MEMBERS, contractDigest, type TaskContract } from './contract.ts'
import { bubbleOpenedKind, type BubbleInput } from './bubble.ts'
import { decomposedKind, explorationsStoppedKind, type Decomposition } from './decomposition.ts'
import { assignedKind, reassignedKind, type Responsibility } from './responsibility.ts'
import { record } from './shape.ts'
import {
  evidenceProducedKind,
  methodConsumedKind,
  runFailedKind,
  runStartedKind,
  runSubmittedKind,
  runVerifiedKind,
  type RunState,
} from './run.ts'

/** The run's own shape, re-exported here: every reader of the task protocol reads it from here. */
export type { EvidenceRecord, RunState, RunStatus, RunSubmission } from './run.ts'

export const TASK_PROTOCOL = 'task'
export const TASK_VERSION = 25

/** The trusted role that admits contracts and starts, settles or fails runs. */
export const SCHEDULER_ROLE = 'scheduler'

/** The trusted role a verdict must come from: the verifier implementation the criterion names. */
export function verifierRoleOf(payload: { verifierRef: string; verifierVersion: string }): string {
  return `verifier:${payload.verifierRef}@${payload.verifierVersion}`
}

export function recordedVerdictDigest(
  state: TaskState,
  where: string,
  { runId, criterionId, artifactDigest,
  }: { readonly runId: string; readonly criterionId: string; readonly artifactDigest: string },
): string {
  const run = state.runs[runId]
  if (run === undefined) refuse('unknown-run', `${where} cites a verdict of run "${runId}", which task "${state.taskId}" never started`)
  const evidence = run.evidence.find(
    (entry) => entry.criterionId === criterionId && entry.artifactDigest === artifactDigest,
  )
  if (evidence === undefined)
    refuse(
      'illegal-transition',
      `${where} cites a verdict of criterion "${criterionId}" on artifact ${artifactDigest.slice(0, 12)}…, which run "${runId}" holds no evidence for; record the verdict before citing it`,
    )
  return verdictDigestOf(runId, evidence)
}

function verdictDigestOf(
  runId: string,
  evidence: {
    readonly reviewId: string
    readonly criterionId: string
    readonly verdict: string
    readonly verifierRef: string
    readonly verifierVersion: string
    readonly implementationDigest: string
    readonly artifactDigest: string
    readonly inputDigests: readonly BubbleInput[]
    readonly detail?: string
  },
): string {
  return digestOf({
    runId,
    reviewId: evidence.reviewId,
    criterionId: evidence.criterionId,
    verdict: evidence.verdict,
    verifierRef: evidence.verifierRef,
    verifierVersion: evidence.verifierVersion,
    implementationDigest: evidence.implementationDigest,
    artifactDigest: evidence.artifactDigest,
    inputDigests: evidence.inputDigests,
    ...(evidence.detail === undefined ? {} : { detail: evidence.detail }),
  })
}

export interface RevisionRef {
  readonly environmentId: string
  readonly revisionId: string
  readonly digest: string
}

/** The folded state of one task. `subject` in every envelope is this task's id. */
export interface TaskState {
  readonly taskId: string
  readonly contract?: TaskContract
  readonly contractDigest?: string
  readonly admittedBy?: string
  readonly admittedAt?: string
  readonly closure?: TaskClosure
  readonly rsi?: RSIStatus
  readonly rounds?: readonly RoundRequest[]
  readonly search?: SearchState
  readonly workflowLimits?: WorkflowLimits
  readonly learning?: boolean
  readonly transfer?: TransferState
  readonly questions?: readonly TaskQuestion[]
  readonly decomposition?: Decomposition
  /** Who is answerable for this task. A task without one cannot be worked on at all. */
  readonly responsibility?: Responsibility
  readonly runs: Readonly<Record<string, RunState>>
}

export const TASK_KINDS = {
  admitted: 'task/admitted',
  decomposed: 'task/decomposed',
  explorationsStopped: 'task/explorations-stopped',
  assigned: 'task/assigned',
  reassigned: 'task/reassigned',
  bubbleOpened: 'bubble/opened',
  runStarted: 'run/started',
  runSubmitted: 'run/submitted',
  evidenceProduced: 'evidence/produced',
  runVerified: 'run/verified',
  runFailed: 'run/failed',
  methodConsumed: 'method/consumed',
} as const

export function declareTaskProtocol(registry: ProtocolRegistry): void {
  registry.declare<TaskState>(TASK_PROTOCOL, TASK_VERSION, {
    initialState: { taskId: '', runs: {} },
    kinds: {
      ...lifecycleKinds(),
      ...searchKinds(),
      ...questionKinds(),
      ...transferKinds(),
      'workflow/limits-frozen': workflowLimitsKind(),
      'learning/configured': defineKind<TaskState, { enabled: boolean }, {}>({
        guarantees: { appended: true }, emitter: SCHEDULER_ROLE, members: ['enabled'], nested: {},
        parse: raw => {
          const row = record(raw, 'learning policy')
          if (typeof row['enabled'] !== 'boolean') refuse('malformed-payload', 'learning.enabled must be boolean')
          return { enabled: row['enabled'] }
        },
        reduce: (state, _fact, payload) => {
          if (state.contract === undefined || state.learning !== undefined || Object.keys(state.runs).length)
            refuse('illegal-transition', 'freeze learning once before the first Run')
          return { ...state, learning: payload.enabled }
        },
      }),
      [TASK_KINDS.admitted]: defineKind<TaskState, { contract: TaskContract }, { contract: MemberSet }>({
        guarantees: { appended: true },
        members: ['contract'],
        // The contract's own members are declared here and handed to `contract.ts`'s reader, so this
        // entry is what closes the contract; each criterion inside it is one level down and is closed
        // by that same module's criterion reader.
        nested: { contract: CONTRACT_MEMBERS },
        emitter: SCHEDULER_ROLE,
        parse: (raw, where, nested) => {
          const source = record(raw, where)
          return { contract: assertContractShape(source['contract'], `${where}.contract`, nested.contract) }
        },
        reduce: (state, envelope, payload) => {
          if (state.contract !== undefined)
            refuse(
              'illegal-transition',
              `task "${state.taskId}" already carries a contract admitted at ${state.admittedAt ?? 'an unrecorded time'}; a later contract is a different task`,
            )
          for (const input of payload.contract.inputs)
            if (input.source.kind === 'artifact' && input.source.taskId === envelope.subject)
              refuse('malformed-contract', `task "${envelope.subject}" declares its own artifact as input "${input.name}"`,
              )
          return {
            taskId: envelope.subject,
            contract: payload.contract,
            contractDigest: contractDigest(payload.contract),
            admittedBy: envelope.actor,
            admittedAt: envelope.at,
            runs: {},
          }
        },
      }),

      [TASK_KINDS.decomposed]: decomposedKind(TASK_KINDS.decomposed, SCHEDULER_ROLE),
      [TASK_KINDS.explorationsStopped]: explorationsStoppedKind(TASK_KINDS.explorationsStopped, SCHEDULER_ROLE),
      [TASK_KINDS.assigned]: assignedKind(TASK_KINDS.assigned, SCHEDULER_ROLE),
      [TASK_KINDS.reassigned]: reassignedKind(TASK_KINDS.reassigned, SCHEDULER_ROLE),
      [TASK_KINDS.bubbleOpened]: bubbleOpenedKind(TASK_KINDS.bubbleOpened, SCHEDULER_ROLE),

      [TASK_KINDS.runStarted]: runStartedKind(TASK_KINDS.runStarted, SCHEDULER_ROLE),
      [TASK_KINDS.runSubmitted]: runSubmittedKind(TASK_KINDS.runSubmitted, SCHEDULER_ROLE),
      // The role *is* the implementation: `verifierRoleOf` reads it out of the payload the criterion
      // was already checked against, and the log refuses the fact when the deployment holds no such
      // identity.
      [TASK_KINDS.evidenceProduced]: evidenceProducedKind(TASK_KINDS.evidenceProduced, verifierRoleOf),
      [TASK_KINDS.runVerified]: runVerifiedKind(TASK_KINDS.runVerified, SCHEDULER_ROLE),
      [TASK_KINDS.runFailed]: runFailedKind(TASK_KINDS.runFailed, SCHEDULER_ROLE),
      // The apparatus's own role, never the scheduler's and never an agent's: what a run consumed is
      // recorded by the thing that ran it, not by the candidate that wants credit for it.
      [TASK_KINDS.methodConsumed]: methodConsumedKind(TASK_KINDS.methodConsumed, AGENT_ROLE),
    },
  })
}

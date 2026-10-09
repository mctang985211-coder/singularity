/**
 * The task protocol: a contract, its runs, and the independent verdicts that settle them.
 *
 * Three invariants live in the reducers, which is why nothing can talk around them:
 *
 * 1. **An executor never judges its own run.** The emitter role of a verdict must differ from the
 *    role that started the run. Roles and identities are stamped by the log from the kind's
 *    declaration, so no caller can claim to be a verifier — the check is not on a caller's word.
 * 2. **A verdict belongs to the verifier implementation its criterion names.** The emitter role is
 *    `verifier:<ref>@<version>`, so a deployment must actually hold that implementation's identity
 *    to emit its verdicts, and the reducer refuses a verdict whose implementation is not the
 *    criterion's.
 * 3. **A run settles verified only when every criterion has a passing verdict**, and the refusal
 *    names the criterion that is missing. No partial acceptance.
 *
 * What admission checks and what the fold checks are deliberately different. Admission requires
 * that the criterion's verifier is runnable **now**; the fold only reads the recorded shape, so a
 * log stays explainable after a verifier retires.
 *
 * Payloads are closed: an undeclared member is a refusal, and a missing optional member stays
 * missing rather than becoming an invented value.
 *
 * @module singularity-core/task/protocol
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import { assertContractShape, contractDigest, type TaskContract } from './contract.ts'
import { assertInputsBound, bubbleOpenedKind, inputList, type Bubble, type BubbleInput } from './bubble.ts'
import { decomposedKind, type Decomposition } from './decomposition.ts'
import { assignedKind, reassignedKind, requireResponsible, type Responsibility } from './responsibility.ts'
import { digest, maybeText, record, requireContractOf, requireRun, settled, text } from './shape.ts'

export const TASK_PROTOCOL = 'task'
/**
 * Version 3. Older versions are **refused by name, with no compatibility layer**: this stack has no
 * distributed ledger to migrate, and review §5 is explicit that "no old data here" is not a licence
 * to change a version in place.
 *
 * The bump is batched deliberately. What changed is not one field but the shape of a verdict and
 * the parties to a task: `evidence/produced` gained a **required** `inputDigests`, and
 * responsibility (`task/assigned` / `task/reassigned`) became a precondition of starting work.
 * Batching them into one version means one historical interpretation, not three.
 */
export const TASK_VERSION = 3

/** The trusted role that admits contracts and starts, settles or fails runs. */
export const SCHEDULER_ROLE = 'scheduler'

/** The trusted role a verdict must come from: the verifier implementation the criterion names. */
export function verifierRoleOf(payload: { verifierRef: string; verifierVersion: string }): string {
  return `verifier:${payload.verifierRef}@${payload.verifierVersion}`
}

/**
 * The method revision a run is pinned to. Pin the digest too: an id alone can be re-pointed.
 *
 * The environment is named because a revision id is only unique **within** an environment; without
 * it, "which revision is this run pinned to" would have to be guessed by searching every
 * environment, and two environments could both hold a revision with that id.
 */
export interface RevisionRef {
  readonly environmentId: string
  readonly revisionId: string
  readonly digest: string
}

export type RunStatus = 'running' | 'verified' | 'failed'

/** One verifier's verdict on one criterion of one run. */
export interface EvidenceRecord {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  /** Which verifier implementation decided it: the criterion's own, or the fold refuses. */
  readonly verifierRef: string
  readonly verifierVersion: string
  /**
   * The content digest of the implementation that actually decided it. A verdict recorded for
   * implementation A cannot be inherited by implementation B, even if B keeps A's name and version.
   */
  readonly implementationDigest: string
  /** The artifact content the verdict was formed on. A later artifact change does not inherit it. */
  readonly artifactDigest: string
  /** The named inputs the verdict was formed against: exactly the bubble's, or the fold refuses. */
  readonly inputDigests: readonly BubbleInput[]
  /** The emitter role and identity the log stamped. Never what a caller asked for. */
  readonly emitter: string
  readonly actor: string
  readonly detail?: string
  readonly at: string
}

export interface RunState {
  readonly runId: string
  readonly emitter: string
  readonly actor: string
  readonly revision: RevisionRef
  readonly startedAt: string
  readonly status: RunStatus
  /** The declared execution context. A verdict about this run is bound to its inputs. */
  readonly bubble?: Bubble
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
  /**
   * The fixed plan, when this task has one. Declared once and never revised: a plan that could be
   * edited would make "which sub-task accepted which criterion" unanswerable after the fact.
   */
  readonly decomposition?: Decomposition
  /** Who is answerable for this task. A task without one cannot be worked on at all. */
  readonly responsibility?: Responsibility
  readonly runs: Readonly<Record<string, RunState>>
}

export const TASK_KINDS = {
  admitted: 'task/admitted',
  decomposed: 'task/decomposed',
  assigned: 'task/assigned',
  reassigned: 'task/reassigned',
  bubbleOpened: 'bubble/opened',
  runStarted: 'run/started',
  evidenceProduced: 'evidence/produced',
  runVerified: 'run/verified',
  runFailed: 'run/failed',
} as const

const APPENDED = { appended: true } as const

/**
 * Declare the task protocol. Call once at load. The deployment's runnable verifiers are not
 * captured here: what can run today is a command-time question, not a replay-time one.
 */
export function declareTaskProtocol(registry: ProtocolRegistry): void {
  registry.declare<TaskState>(TASK_PROTOCOL, TASK_VERSION, {
    initialState: { taskId: '', runs: {} },
    kinds: {
      [TASK_KINDS.admitted]: defineKind<TaskState, { contract: TaskContract }>({
        guarantees: APPENDED,
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const source = record(raw, `${TASK_KINDS.admitted} payload`)
          assertClosedKeys(source, ['contract'], `${TASK_KINDS.admitted} payload`)
          return { contract: assertContractShape(source['contract'], `${TASK_KINDS.admitted} payload.contract`) }
        },
        reduce: (state, envelope, payload) => {
          if (state.contract !== undefined)
            refuse(
              'illegal-transition',
              `task "${state.taskId}" already carries a contract admitted at ${state.admittedAt ?? 'an unrecorded time'}; a later contract is a different task`,
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
      [TASK_KINDS.assigned]: assignedKind(TASK_KINDS.assigned, SCHEDULER_ROLE),
      [TASK_KINDS.reassigned]: reassignedKind(TASK_KINDS.reassigned, SCHEDULER_ROLE),
      [TASK_KINDS.bubbleOpened]: bubbleOpenedKind(TASK_KINDS.bubbleOpened, SCHEDULER_ROLE),

      [TASK_KINDS.runStarted]: defineKind<TaskState, { runId: string; revision: RevisionRef }>({
        guarantees: APPENDED,
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const where = `${TASK_KINDS.runStarted} payload`
          const source = record(raw, where)
          assertClosedKeys(source, ['runId', 'revision'], where)
          const revision = record(source['revision'], `${where}.revision`)
          assertClosedKeys(revision, ['environmentId', 'revisionId', 'digest'], `${where}.revision`)
          return {
            runId: text(source, 'runId', where),
            revision: {
              environmentId: text(revision, 'environmentId', `${where}.revision`),
              revisionId: text(revision, 'revisionId', `${where}.revision`),
              digest: digest(revision, 'digest', `${where}.revision`),
            },
          }
        },
        reduce: (state, envelope, payload) => {
          const where = `${TASK_KINDS.runStarted} #${envelope.seq}`
          requireContractOf(state, where, envelope.subject)
          // Responsibility is a precondition, not a label: work nobody is answerable for is not
          // started, and after a transfer the previous holder's attempt is refused by name.
          requireResponsible(state, envelope.actor, where)
          if (state.runs[payload.runId] !== undefined)
            refuse('illegal-transition', `${where} starts run "${payload.runId}" again; one run id is one attempt`)
          return {
            ...state,
            runs: {
              ...state.runs,
              [payload.runId]: {
                runId: payload.runId,
                emitter: envelope.emitter,
                actor: envelope.actor,
                revision: payload.revision,
                startedAt: envelope.at,
                status: 'running',
                evidence: [],
              },
            },
          }
        },
      }),

      [TASK_KINDS.evidenceProduced]: defineKind<
        TaskState,
        {
          runId: string
          criterionId: string
          verdict: 'pass' | 'fail'
          verifierRef: string
          verifierVersion: string
          implementationDigest: string
          artifactDigest: string
          inputDigests: readonly BubbleInput[]
          detail?: string
        }
      >({
        guarantees: APPENDED,
        // The role *is* the implementation: a deployment must hold that verifier's identity to
        // emit its verdicts, and the log refuses the fact when it does not.
        emitter: payload => verifierRoleOf(payload),
        parse: raw => {
          const where = `${TASK_KINDS.evidenceProduced} payload`
          const source = record(raw, where)
          assertClosedKeys(
            source,
            ['runId', 'criterionId', 'verdict', 'verifierRef', 'verifierVersion', 'implementationDigest', 'artifactDigest', 'inputDigests', 'detail'],
            where,
          )
          const verdict = source['verdict']
          if (verdict !== 'pass' && verdict !== 'fail')
            refuse('malformed-payload', `${where}.verdict must be "pass" or "fail", got ${JSON.stringify(verdict ?? null)}`)
          const detail = maybeText(source, 'detail', where)
          return {
            runId: text(source, 'runId', where),
            criterionId: text(source, 'criterionId', where),
            verdict,
            verifierRef: text(source, 'verifierRef', where),
            verifierVersion: text(source, 'verifierVersion', where),
            implementationDigest: digest(source, 'implementationDigest', where),
            artifactDigest: digest(source, 'artifactDigest', where),
            inputDigests: inputList(source['inputDigests'], `${where}.inputDigests`),
            ...(detail === undefined ? {} : { detail }),
          }
        },
        reduce: (state, envelope, payload) => {
          const where = `${TASK_KINDS.evidenceProduced} #${envelope.seq}`
          const contract = requireContractOf(state, where, envelope.subject)
          const run = requireRun(state, payload.runId, where)
          if (run.status !== 'running')
            refuse('illegal-transition', `${where} judges run "${payload.runId}", which already settled ${run.status}`)

          const criterion = contract.criteria.find(candidate => candidate.criterionId === payload.criterionId)
          if (criterion === undefined)
            refuse('unknown-criterion', `${where} names criterion "${payload.criterionId}", which task "${envelope.subject}" does not declare`)

          // Invariant 1: the executor never judges its own run — by role, and by identity, so a
          // deployment that binds one identity to both roles is refused rather than trusted.
          if (envelope.emitter === run.emitter || envelope.actor === run.actor)
            refuse(
              'self-reported-evidence',
              `${where}: "${envelope.actor}" (role ${envelope.emitter}) started run "${payload.runId}" and cannot also judge its criterion "${payload.criterionId}"`,
            )
          // Invariant 2: the verdict belongs to the implementation the criterion names.
          if (criterion.verifierRef !== payload.verifierRef || criterion.verifierVersion !== payload.verifierVersion)
            refuse(
              'wrong-verifier',
              `${where} decides criterion "${payload.criterionId}" as ${payload.verifierRef}@${payload.verifierVersion}, but that criterion names ${criterion.verifierRef}@${criterion.verifierVersion}`,
            )
          // ...and to that implementation's *content*, not merely its name. A ref and a version can
          // be re-pointed at different code; a digest cannot.
          if (criterion.implementationDigest !== payload.implementationDigest)
            refuse(
              'wrong-verifier',
              `${where} was formed by the implementation ${payload.implementationDigest.slice(0, 12)}…, but criterion "${payload.criterionId}" names the implementation ${criterion.implementationDigest.slice(0, 12)}…`,
            )

          // A verdict is bound to the inputs the run declared it executed against. Without this,
          // swapping an input after the fact would leave the old pass standing.
          assertInputsBound(run.bubble, payload.inputDigests, where)

          if (run.evidence.some(entry => entry.criterionId === payload.criterionId))
            refuse(
              'evidence-conflict',
              `${where}: criterion "${payload.criterionId}" of run "${payload.runId}" already carries a verdict from ${run.evidence.find(entry => entry.criterionId === payload.criterionId)?.actor ?? 'a verifier'}; one criterion has one verdict`,
            )

          return {
            ...state,
            runs: {
              ...state.runs,
              [payload.runId]: {
                ...run,
                evidence: [
                  ...run.evidence,
                  {
                    criterionId: payload.criterionId,
                    verdict: payload.verdict,
                    verifierRef: payload.verifierRef,
                    verifierVersion: payload.verifierVersion,
                    implementationDigest: payload.implementationDigest,
                    artifactDigest: payload.artifactDigest,
                    inputDigests: payload.inputDigests,
                    emitter: envelope.emitter,
                    actor: envelope.actor,
                    ...(payload.detail === undefined ? {} : { detail: payload.detail }),
                    at: envelope.at,
                  },
                ],
              },
            },
          }
        },
      }),

      [TASK_KINDS.runVerified]: defineKind<TaskState, { runId: string }>({
        guarantees: APPENDED,
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const where = `${TASK_KINDS.runVerified} payload`
          const source = record(raw, where)
          assertClosedKeys(source, ['runId'], where)
          return { runId: text(source, 'runId', where) }
        },
        reduce: (state, envelope, payload) => {
          const where = `${TASK_KINDS.runVerified} #${envelope.seq}`
          const contract = requireContractOf(state, where, envelope.subject)
          const run = requireRun(state, payload.runId, where)
          if (run.status !== 'running')
            refuse('illegal-transition', `${where} settles run "${payload.runId}" again; it is already ${run.status}`)

          // Invariant 3: every criterion needs a passing verdict from its own implementation.
          const unanswered = contract.criteria.filter(
            criterion =>
              !run.evidence.some(
                entry =>
                  entry.criterionId === criterion.criterionId &&
                  entry.verdict === 'pass' &&
                  entry.verifierRef === criterion.verifierRef &&
                  entry.verifierVersion === criterion.verifierVersion,
              ),
          )
          if (unanswered.length > 0)
            refuse(
              'unadjudicated-criterion',
              `${where} cannot settle run "${payload.runId}" verified: ${unanswered
                .map(criterion => `"${criterion.criterionId}" has no passing verdict from ${criterion.verifierRef}@${criterion.verifierVersion}`)
                .join('; ')}`,
            )

          return { ...state, runs: { ...state.runs, [payload.runId]: settled(run, 'verified', envelope.at) } }
        },
      }),

      [TASK_KINDS.runFailed]: defineKind<TaskState, { runId: string; reason?: string }>({
        guarantees: APPENDED,
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const where = `${TASK_KINDS.runFailed} payload`
          const source = record(raw, where)
          assertClosedKeys(source, ['runId', 'reason'], where)
          const reason = maybeText(source, 'reason', where)
          return { runId: text(source, 'runId', where), ...(reason === undefined ? {} : { reason }) }
        },
        reduce: (state, envelope, payload) => {
          const where = `${TASK_KINDS.runFailed} #${envelope.seq}`
          const run = requireRun(state, payload.runId, where)
          if (run.status !== 'running')
            refuse('illegal-transition', `${where} settles run "${payload.runId}" again; it is already ${run.status}`)
          // A missing reason stays missing: the view reports "none recorded", it does not invent one.
          return { ...state, runs: { ...state.runs, [payload.runId]: settled(run, 'failed', envelope.at, payload.reason) } }
        },
      }),
    },
  })
}

/**
 * The run: one attempt at a task — how it starts, what judged it, how it settled, and what it used.
 *
 * Extracted from `protocol.ts` when E2's `method/consumed` kind pushed that file over its budget.
 * The split is by responsibility, not by line count: every kind here is a fact about **one run**,
 * every rule below is decided on the task's own subject, and `protocol.ts` keeps the task-level
 * facts, the declared surface and the version note — the division `bubble.ts` makes for the bubble.
 *
 * Three invariants live in these reducers, which is why nothing can talk around them:
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
 * **`method/consumed`** (E2, `docs/tdd-seams.md` §4) is a fact about one run for the same reason:
 * pinning a revision proves nothing about which of its methods were used (R08), so the apparatus
 * records what the run actually loaded — at the revision that run pinned, and with the source the
 * claim came from. The emitter is the runtime role, never the scheduler and never an agent: a
 * candidate's own agent saying "I used the method" is precisely the self-report the rest of this
 * stack refuses.
 *
 * @module singularity-core/task/run
 */

import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule, type MemberSet } from '../protocol/registry.ts'
import { sameRevision } from '../strategy/protocol.ts'
import { assertInputsBound, BUBBLE_INPUT_MEMBERS, inputList, type Bubble, type BubbleInput } from './bubble.ts'
import { requireResponsible } from './responsibility.ts'
import { digest, maybeText, record, requireContractOf, requireRun, revisionRef, REVISION_MEMBERS, settled, text } from './shape.ts'
import type { RevisionRef, TaskState } from './protocol.ts'

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

/**
 * One method the apparatus recorded a run as consuming, and where that claim came from.
 *
 * The revision the fact named is **not** kept here: the reducer refuses a fact whose revision is not
 * the run's pin, so the run's own `revision` is that value, and a second copy of it in this record
 * would be a value stated twice with nothing keeping the two in step.
 */
interface MethodConsumption {
  readonly method: string
  readonly source: string
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
  /** What this run actually used, in the order the apparatus recorded it. */
  readonly consumed: readonly MethodConsumption[]
  readonly finishedAt?: string
  readonly failureReason?: string
}

const APPENDED = { appended: true } as const
const METHOD_CONSUMED_MEMBERS = ['runId', 'revision', 'method', 'source'] as const
const RUN_STARTED_MEMBERS = ['runId', 'revision'] as const
const RUN_VERIFIED_MEMBERS = ['runId'] as const
const RUN_FAILED_MEMBERS = ['runId', 'reason'] as const
const EVIDENCE_PRODUCED_MEMBERS = ['runId', 'criterionId', 'verdict', 'verifierRef', 'verifierVersion', 'implementationDigest', 'artifactDigest', 'inputDigests', 'detail'] as const

/** `run/started`: one attempt at a task, pinned to the revision it will be judged against. */
export function runStartedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; revision: RevisionRef }, { revision: MemberSet }>({
    guarantees: APPENDED,
    // The closed set is a declared value, and it is the one the parse boundary enforces: a list
    // written here at the call site — or a conditional one, as the fifth review wrote — cannot
    // widen what the log accepts, and the inventory compares this declaration rather than a sample.
    members: RUN_STARTED_MEMBERS,
    nested: { revision: REVISION_MEMBERS },
    emitter,
    parse: (raw, where, nested) => {
      const source = record(raw, where)
      return { runId: text(source, 'runId', where), revision: revisionRef(source['revision'], `${where}.revision`, nested.revision) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
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
            consumed: [],
          },
        },
      }
    },
  })
}

/** `evidence/produced`: one verifier's verdict on one criterion. The role *is* the implementation. */
export function evidenceProducedKind(
  kind: string,
  emitter: (payload: { readonly verifierRef: string; readonly verifierVersion: string }) => string,
): KindRule<TaskState> {
  return defineKind<
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
    },
    { inputDigests: MemberSet }
  >({
    guarantees: APPENDED,
    members: EVIDENCE_PRODUCED_MEMBERS,
    // `inputDigests[]` is closed by `inputList`, which is handed this one set: the declaration is what
    // closes each entry, so a reader cannot widen the shape without the declaration changing.
    nested: { inputDigests: BUBBLE_INPUT_MEMBERS },
    // The role *is* the implementation: a deployment must hold that verifier's identity to
    // emit its verdicts, and the log refuses the fact when it does not.
    emitter,
    parse: (raw, where, nested) => {
      const source = record(raw, where)
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
        inputDigests: inputList(source['inputDigests'], `${where}.inputDigests`, nested.inputDigests),
        ...(detail === undefined ? {} : { detail }),
      }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
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
  })
}

/** `run/verified`: the run settles, and only once every criterion has a passing verdict. */
export function runVerifiedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string }, {}>({
    guarantees: APPENDED,
    members: RUN_VERIFIED_MEMBERS,
    nested: {},
    emitter,
    parse: raw => {
      const where = `${kind} payload`
      const source = record(raw, where)
      return { runId: text(source, 'runId', where) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
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
  })
}

/** `run/failed`: the run settles the other way. A missing reason stays missing. */
export function runFailedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; reason?: string }, {}>({
    guarantees: APPENDED,
    members: RUN_FAILED_MEMBERS,
    nested: {},
    emitter,
    parse: raw => {
      const where = `${kind} payload`
      const source = record(raw, where)
      const reason = maybeText(source, 'reason', where)
      return { runId: text(source, 'runId', where), ...(reason === undefined ? {} : { reason }) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const run = requireRun(state, payload.runId, where)
      if (run.status !== 'running')
        refuse('illegal-transition', `${where} settles run "${payload.runId}" again; it is already ${run.status}`)
      // A missing reason stays missing: the view reports "none recorded", it does not invent one.
      return { ...state, runs: { ...state.runs, [payload.runId]: settled(run, 'failed', envelope.at, payload.reason) } }
    },
  })
}

/**
 * `method/consumed` (E2): the apparatus records that a run used one method of the revision it was
 * pinned to, and where that claim comes from.
 *
 * Four rules, all on the task's own subject:
 *
 * 1. **The run exists.** A consumption fact about an attempt nobody started is refused by name.
 * 2. **The revision is the run's pin** (`sameRevision`: environment, revision id and content
 *    digest). A method version the run was never pinned to is not one it can have consumed, so
 *    "I used something I was not pinned to" is not expressible.
 * 3. **One `(runId, method)` pair is consumed once.** A second fact for the same pair is
 *    `evidence-conflict`, exactly as a second verdict on one criterion is.
 * 4. **`source` is required and non-empty** — parsed by the closed payload, not defaulted. It
 *    answers "where does this claim come from", and a claim with no source is not a record.
 *
 * What it deliberately does **not** decide: whether the run has settled. Consumption is what the
 * apparatus observed while the attempt ran, and a report written after the settlement is still a
 * record of it; refusing those would refuse the honest order of a real execution.
 */
export function methodConsumedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; revision: RevisionRef; method: string; source: string }, { revision: MemberSet }>({
    guarantees: APPENDED,
    members: METHOD_CONSUMED_MEMBERS,
    nested: { revision: REVISION_MEMBERS },
    emitter,
    parse: (raw, where, nested) => {
      const source = record(raw, where)
      return {
        runId: text(source, 'runId', where),
        revision: revisionRef(source['revision'], `${where}.revision`, nested.revision),
        method: text(source, 'method', where),
        source: text(source, 'source', where),
      }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const run = requireRun(state, payload.runId, where)
      if (!sameRevision(run.revision, payload.revision))
        refuse(
          'evidence-input-mismatch',
          `${where} records run "${payload.runId}" consuming method "${payload.method}" at ${payload.revision.environmentId} revision ${payload.revision.revisionId} (${payload.revision.digest.slice(0, 12)}…), but that run is pinned to revision ${run.revision.revisionId} (${run.revision.digest.slice(0, 12)}…); a method version the run was not pinned to is not one it consumed`,
        )
      if (run.consumed.some(entry => entry.method === payload.method))
        refuse(
          'evidence-conflict',
          `${where}: run "${payload.runId}" already consumed method "${payload.method}" (recorded as ${JSON.stringify(run.consumed.find(entry => entry.method === payload.method)?.source ?? '')}); one (run, method) pair is consumed once`,
        )
      return {
        ...state,
        runs: {
          ...state.runs,
          [payload.runId]: { ...run, consumed: [...run.consumed, { method: payload.method, source: payload.source }] },
        },
      }
    },
  })
}

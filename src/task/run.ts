import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { refuse } from '../protocol/refusal.ts'
import { assertClosedKeys } from '../protocol/envelope.ts'
import { defineKind, type KindRule, type MemberSet } from '../protocol/registry.ts'
import { assertInputsBound, BUBBLE_INPUT_MEMBERS, inputList, type Bubble, type BubbleInput } from './bubble.ts'
import type { AcceptanceCriterion, TaskContract } from './contract.ts'
import { requireResponsible } from './responsibility.ts'
import { digest, maybeText, record, requireContractOf, requireRun, revisionRef, REVISION_MEMBERS, sameRevision, settled, text } from './shape.ts'
import type { RevisionRef, TaskState } from './protocol.ts'

export type RunStatus = 'running' | 'verified' | 'failed'
type RunStage = 'working' | 'submitting' | 'submitted'
type RunFailureCause = 'acceptance' | 'runtime'

export interface RunSubmission {
  readonly executionFailure?: string
  readonly requestId: string
  readonly requestDigest: string
  readonly programDigest: string
  readonly artifactDigest: string
  readonly inputDigests: readonly BubbleInput[]
  readonly files: {
    readonly program: FileAttachmentRef
    readonly artifact: FileAttachmentRef
    readonly inputs: readonly { readonly name: string; readonly attachment: FileAttachmentRef }[]
  }
  readonly source: { readonly sessionId: string; readonly eventCount: number; readonly digest: string }
}

/** One verifier's verdict on one criterion of one run. */
export interface EvidenceRecord {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  /** Which verifier implementation decided it: the criterion's own, or the fold refuses. */
  readonly verifierRef: string
  readonly verifierVersion: string
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
  readonly stage: RunStage
  readonly request?: { readonly id: string; readonly digest: string }
  readonly submission?: RunSubmission
  readonly submittedAt?: string
  /** The declared execution context. A verdict about this run is bound to its inputs. */
  readonly bubble?: Bubble
  readonly evidence: readonly EvidenceRecord[]
  /** What this run actually used, in the order the apparatus recorded it. */
  readonly consumed: readonly MethodConsumption[]
  readonly finishedAt?: string
  readonly failureReason?: string
  readonly failureCause?: RunFailureCause
}

const APPENDED = { appended: true } as const
const METHOD_CONSUMED_MEMBERS = ['runId', 'revision', 'method', 'source'] as const
const RUN_STARTED_MEMBERS = ['runId', 'revision'] as const
const RUN_SUBMITTING_MEMBERS = ['runId', 'requestId', 'requestDigest'] as const
const RUN_SUBMITTED_MEMBERS = ['runId', 'submission'] as const
const SUBMISSION_MEMBERS = ['requestId', 'requestDigest', 'programDigest', 'artifactDigest', 'inputDigests', 'files', 'source', 'executionFailure'] as const
const SUBMISSION_FILES_MEMBERS = ['program', 'artifact', 'inputs'] as const
const FILE_ATTACHMENT_MEMBERS = ['attachmentId', 'name', 'bytes'] as const
const INPUT_ATTACHMENT_MEMBERS = ['name', 'attachment'] as const
const SOURCE_MEMBERS = ['sessionId', 'eventCount', 'digest'] as const
const RUN_VERIFIED_MEMBERS = ['runId'] as const
const RUN_FAILED_MEMBERS = ['runId', 'cause', 'reason'] as const
const EVIDENCE_PRODUCED_MEMBERS = ['runId', 'criterionId', 'verdict', 'verifierRef', 'verifierVersion', 'implementationDigest', 'artifactDigest', 'inputDigests', 'detail'] as const

function fileAttachmentRef(raw: unknown, expectedDigest: string, where: string): FileAttachmentRef {
  const source = record(raw, where)
  assertClosedKeys(source, FILE_ATTACHMENT_MEMBERS, where)
  const attachmentId = text(source, 'attachmentId', where)
  const contentDigest = /^sha256:([0-9a-f]{64})$/.exec(attachmentId)?.[1]
  if (contentDigest === undefined)
    refuse('malformed-payload', `${where}.attachmentId must be a sha256:<hex> attachment ID`)
  const bytes = source['bytes']
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)
    refuse('malformed-payload', `${where}.bytes must be a non-negative safe integer`)
  if (contentDigest !== expectedDigest)
    refuse('malformed-payload', `${where}.attachmentId must equal the submitted content digest`)
  return { attachmentId: attachmentId as FileAttachmentRef['attachmentId'], name: text(source, 'name', where), bytes }
}

function submissionFiles(raw: unknown, programDigest: string, artifactDigest: string, inputs: readonly BubbleInput[], where: string): RunSubmission['files'] {
  const source = record(raw, where)
  assertClosedKeys(source, SUBMISSION_FILES_MEMBERS, where)
  const files = source['inputs']
  if (!Array.isArray(files) || files.length !== inputs.length)
    refuse('malformed-payload', `${where}.inputs must name exactly the submitted inputs in order`)
  return {
    program: fileAttachmentRef(source['program'], programDigest, `${where}.program`),
    artifact: fileAttachmentRef(source['artifact'], artifactDigest, `${where}.artifact`),
    inputs: files.map((raw, index) => {
      const at = `${where}.inputs[${index}]`
      const entry = record(raw, at)
      assertClosedKeys(entry, INPUT_ATTACHMENT_MEMBERS, at)
      const name = text(entry, 'name', at)
      const input = inputs[index]!
      if (name !== input.name)
        refuse('malformed-payload', `${at}.name must equal submitted input ${JSON.stringify(input.name)}`)
      return { name, attachment: fileAttachmentRef(entry['attachment'], input.digest, `${at}.attachment`) }
    }),
  }
}

export function verdictFor(run: RunState, criterion: AcceptanceCriterion): EvidenceRecord | undefined {
  return run.evidence.find(
    entry =>
      entry.criterionId === criterion.criterionId &&
      entry.verifierRef === criterion.verifierRef &&
      entry.verifierVersion === criterion.verifierVersion,
  )
}

/** The criteria this run holds **no verdict at all** for, from each criterion's own verifier. */
export function unadjudicatedCriteria(contract: TaskContract, run: RunState): readonly AcceptanceCriterion[] {
  return contract.criteria.filter(criterion => verdictFor(run, criterion) === undefined)
}

/** The criteria this run holds **no passing** verdict for: a missing verdict and a failing one alike. */
export function unmetCriteria(contract: TaskContract, run: RunState): readonly AcceptanceCriterion[] {
  return contract.criteria.filter(criterion => verdictFor(run, criterion)?.verdict !== 'pass')
}

/** `run/started`: one attempt at a task, pinned to the revision it will be judged against. */
export function runStartedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; revision: RevisionRef }, { revision: MemberSet }>({
    guarantees: APPENDED,
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
      const running = Object.values(state.runs).find(run => run.status === 'running')
      if (running !== undefined)
        refuse('illegal-transition', `${where} cannot start run "${payload.runId}" while run "${running.runId}" is running; one task has one unsettled attempt`)
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
            stage: 'working',
            evidence: [],
            consumed: [],
          },
        },
      }
    },
  })
}

export function runSubmittingKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; requestId: string; requestDigest: string }, {}>({
    guarantees: APPENDED,
    members: RUN_SUBMITTING_MEMBERS,
    nested: {},
    emitter,
    parse: (raw, where) => {
      const source = record(raw, where)
      return { runId: text(source, 'runId', where), requestId: text(source, 'requestId', where), requestDigest: digest(source, 'requestDigest', where) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const run = requireRun(state, payload.runId, where)
      requireResponsible(state, envelope.actor, where)
      if (run.status !== 'running' || run.stage !== 'working')
        refuse('illegal-transition', `${where} cannot begin submission of run "${payload.runId}" in ${run.status}/${run.stage}`)
      if (run.bubble === undefined)
        refuse('illegal-transition', `${where} cannot begin submission before run "${payload.runId}" declares its bubble`)
      if (run.evidence.length !== 0)
        refuse('illegal-transition', `${where} cannot begin submission after run "${payload.runId}" has already been judged`)
      return {
        ...state,
        runs: { ...state.runs, [payload.runId]: { ...run, stage: 'submitting', request: { id: payload.requestId, digest: payload.requestDigest } } },
      }
    },
  })
}

export function runSubmittedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; submission: RunSubmission }, { submission: MemberSet }>({
    guarantees: APPENDED,
    members: RUN_SUBMITTED_MEMBERS,
    nested: { submission: SUBMISSION_MEMBERS },
    emitter,
    parse: (raw, where, nested) => {
      const payload = record(raw, where)
      const at = `${where}.submission`
      const submission = record(payload['submission'], at)
      assertClosedKeys(submission, nested.submission, at)
      const sourceAt = `${at}.source`
      const source = record(submission['source'], sourceAt)
      assertClosedKeys(source, SOURCE_MEMBERS, sourceAt)
      const eventCount = source['eventCount']
      if (typeof eventCount !== 'number' || !Number.isSafeInteger(eventCount) || eventCount < 0)
        refuse('malformed-payload', `${sourceAt}.eventCount must be a non-negative safe integer`)
      const executionFailure = maybeText(submission, 'executionFailure', at)
      const programDigest = digest(submission, 'programDigest', at)
      const artifactDigest = digest(submission, 'artifactDigest', at)
      const inputDigests = inputList(submission['inputDigests'], `${at}.inputDigests`, BUBBLE_INPUT_MEMBERS)
      return {
        runId: text(payload, 'runId', where),
        submission: {
          requestId: text(submission, 'requestId', at),
          requestDigest: digest(submission, 'requestDigest', at),
          programDigest,
          artifactDigest,
          inputDigests,
          files: submissionFiles(submission['files'], programDigest, artifactDigest, inputDigests, `${at}.files`),
          source: { sessionId: text(source, 'sessionId', sourceAt), eventCount, digest: digest(source, 'digest', sourceAt) },
          ...(executionFailure === undefined ? {} : { executionFailure }),
        },
      }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const run = requireRun(state, payload.runId, where)
      requireResponsible(state, envelope.actor, where)
      if (run.status !== 'running' || run.stage !== 'submitting')
        refuse('illegal-transition', `${where} cannot submit run "${payload.runId}" in ${run.status}/${run.stage}`)
      if (run.request?.id !== payload.submission.requestId || run.request.digest !== payload.submission.requestDigest)
        refuse('command-conflict', `${where} does not match the submission request reserved for run "${payload.runId}"`)
      assertInputsBound(run.bubble, payload.submission.inputDigests, where)
      return {
        ...state,
        runs: { ...state.runs, [payload.runId]: { ...run, stage: 'submitted', submission: payload.submission, submittedAt: envelope.at } },
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
      verdict: 'pass' | 'fail' | 'partial' | 'unknown'
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
      if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'partial' && verdict !== 'unknown')
        refuse('malformed-payload', `${where}.verdict must be pass, fail, partial or unknown, got ${JSON.stringify(verdict ?? null)}`)
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
      if (run.submission?.executionFailure !== undefined) refuse('illegal-transition', `${where} cannot judge a failed program execution`)
      if (run.stage === 'submitting')
        refuse('illegal-transition', `${where} cannot judge run "${payload.runId}" before its submission is sealed`)

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
      if (run.submission !== undefined && run.submission.artifactDigest !== payload.artifactDigest)
        refuse('evidence-input-mismatch', `${where} judges artifact ${payload.artifactDigest}, but run "${payload.runId}" submitted ${run.submission.artifactDigest}`)

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
      if (run.submission?.executionFailure !== undefined)
        refuse('illegal-transition', `${where} cannot verify run "${payload.runId}" after a failed program execution`)

      // Invariant 3: every criterion needs a passing verdict from its own implementation. Which
      // verdict counts as a criterion's is `verdictFor`'s rule, asked here rather than restated.
      const unanswered = unmetCriteria(contract, run)
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

/** Failed acceptance may be retried within budget; runtime failure stops delegated work. */
export function runFailedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; cause: RunFailureCause; reason?: string }, {}>({
    guarantees: APPENDED,
    members: RUN_FAILED_MEMBERS,
    nested: {},
    emitter,
    parse: raw => {
      const where = `${kind} payload`
      const source = record(raw, where)
      const cause = source['cause']
      if (cause !== 'acceptance' && cause !== 'runtime')
        refuse('malformed-payload', `${where}.cause must be acceptance or runtime`)
      const reason = maybeText(source, 'reason', where)
      return { runId: text(source, 'runId', where), cause, ...(reason === undefined ? {} : { reason }) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const run = requireRun(state, payload.runId, where)
      requireResponsible(state, envelope.actor, where)
      if (run.status !== 'running')
        refuse('illegal-transition', `${where} settles run "${payload.runId}" again; it is already ${run.status}`)
      if (payload.cause === 'acceptance') {
        if (run.submission?.executionFailure !== undefined)
          refuse('illegal-transition', `${where} cannot record acceptance after a failed program execution`)
        const contract = requireContractOf(state, where, envelope.subject)
        if (unadjudicatedCriteria(contract, run).length > 0 || unmetCriteria(contract, run).length === 0)
          refuse('unadjudicated-criterion', `${where} requires complete verdicts with at least one failing criterion`)
      }
      return { ...state, runs: { ...state.runs, [payload.runId]: {
        ...settled(run, 'failed', envelope.at, payload.reason), failureCause: payload.cause,
      } } }
    },
  })
}

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
      if (run.status !== 'running' || run.stage !== 'working')
        refuse('illegal-transition', `${where} cannot record method consumption for run "${payload.runId}" in ${run.status}/${run.stage}`)
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

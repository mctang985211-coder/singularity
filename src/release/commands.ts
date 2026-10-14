import { createHash } from 'node:crypto'
import type { ControlSessionStore } from '../control/session-store.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../environment/protocol.ts'
import { digestOf, type Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, recordedVerdictDigest, type TaskState } from '../task/protocol.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { decisionDraftOf } from './decision.ts'
import { RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, releaseDraftOf, type ReleaseDraft, type ReleaseState } from './protocol.ts'

export interface ReleaseCommandOptions {
  readonly store: ControlSessionStore
}
export interface ReleaseCommands {
  draft(input: { readonly commandId: string; readonly revision: RevisionRef }): Promise<Envelope>
  draftFromDecision(input: { readonly commandId: string; readonly roundId: string }): Promise<Envelope>
  approveReview(input: { readonly commandId: string; readonly environmentId: string; readonly revisionId: string; readonly draftDigest: string;
    readonly witness: { readonly taskId: string; readonly runId: string; readonly subjectDigest: string; readonly artifactDigest: string; readonly evidenceDigest: string; readonly agentId: string } }): Promise<Envelope>
  publish(input: { readonly commandId: string; readonly environmentId: string; readonly expected: string; readonly to: string }): Promise<Envelope>
}

export function createReleaseCommands(options: ReleaseCommandOptions): ReleaseCommands {
  const emit = (commandId: string, kind: string, subject: string, payload: unknown, require?: () => void) =>
    options.store.emit({ commandId, protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind, subject, payload }, require)
  const validate = (environmentId: string, draft: ReleaseDraft): void => {
    const cut = options.store.load()
    assertPinnedRevision({ environmentId, revisionId: draft.revisionId, digest: draft.contentDigest },
      cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'release target')
    if (draft.basis.kind === 'decision') {
      const current = decisionDraftOf(cut, draft.basis.roundId)
      if (current.environmentId !== environmentId || digestOf(current.draft) !== digestOf(draft))
        refuse('stale-approval', 'the draft does not bind the committed winner, report and decision')
      if (cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, environmentId)!.pointer !== draft.basis.expected)
        refuse('illegal-transition', 'the release decision expected head has moved')
    }
  }
  return {
    draft: input => {
      const draft = releaseDraftOf(input.revision, { kind: 'bootstrap' })
      return emit(input.commandId, RELEASE_KINDS.drafted, input.revision.environmentId, draft,
        () => validate(input.revision.environmentId, draft))
    },
    draftFromDecision: input => {
      const { environmentId, draft } = decisionDraftOf(options.store.load(), input.roundId)
      return emit(input.commandId, RELEASE_KINDS.drafted, environmentId, draft, () => validate(environmentId, draft))
    },
    approveReview: input => emit(input.commandId, RELEASE_KINDS.approved, input.environmentId, {
      revisionId: input.revisionId, draftDigest: input.draftDigest, approvedBy: input.witness.agentId,
      approvalId: `${input.witness.taskId}/${input.witness.runId}/${input.witness.evidenceDigest}`,
      review: input.witness,
    }, () => {
      const cut = options.store.load()
      const standing = cut.stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, input.environmentId)!
      const task = cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, input.witness.taskId)
      const run = task?.runs[input.witness.runId]
      if (run?.status !== 'verified' || task!.responsibility?.agentId !== input.witness.agentId ||
        run.bubble!.inputs[0]!.digest !== input.witness.subjectDigest || run.submission!.artifactDigest !== input.witness.artifactDigest ||
        recordedVerdictDigest(task!, 'release review', { runId: input.witness.runId, criterionId: 'review-approved', artifactDigest: input.witness.artifactDigest }) !== input.witness.evidenceDigest)
        refuse('unapproved-revision', 'publication requires exact independent review evidence')
      const execution = assertPinnedRevision(run.revision, cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'release reviewer')
      const context = (execution.manifest as { context: { inputs: { digest: string; content: string }[] } }).context
      const frozen = context.inputs.find(entry => entry.digest === input.witness.subjectDigest)!
      const bytes = Buffer.from(frozen.content, 'base64')
      if (createHash('sha256').update(bytes).digest('hex') !== input.witness.subjectDigest)
        refuse('digest-mismatch', 'release review frozen subject bytes changed')
      const subject = JSON.parse(bytes.toString('utf8')) as { draft: ReleaseDraft; assets: unknown }
      const target = assertPinnedRevision({ environmentId: input.environmentId, revisionId: input.revisionId, digest: standing.contentDigest },
        cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'reviewed release')
      const draft = { revisionId: standing.revisionId, contentDigest: standing.contentDigest, draftDigest: standing.draftDigest, basis: standing.basis }
      if (input.draftDigest !== standing.draftDigest || digestOf(subject.draft) !== digestOf(draft) || digestOf(subject.assets) !== target.contentDigest)
        refuse('unapproved-revision', 'independent review does not bind the standing draft and exact assets')
    }),
    publish: input => options.store.emit({ commandId: input.commandId, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.pointerSwitched, subject: input.environmentId, payload: { expected: input.expected, to: input.to } }, () => {
      const release = options.store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, input.environmentId)
      if (release === undefined || release.draftDigest === '')
        refuse('unapproved-revision', `cannot release revision "${input.to}" in environment "${input.environmentId}": no draft is on the table`)
      if (release.approvedBy === undefined) refuse('unapproved-revision', `revision "${release.revisionId}" carries no approval`)
      if (release.revisionId !== input.to)
        refuse('unapproved-revision', `the standing approval authorises revision "${release.revisionId}", not "${input.to}"`)
      const draft: ReleaseDraft = { revisionId: release.revisionId, contentDigest: release.contentDigest,
        draftDigest: release.draftDigest, basis: release.basis! }
      if (draft.basis.kind === 'decision' && input.expected !== draft.basis.expected)
        refuse('illegal-transition', 'publication cannot rebase the approved decision expected head')
      validate(input.environmentId, draft)
    }),
  }
}

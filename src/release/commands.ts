import type { ControlSessionStore } from '../control/session-store.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState,
} from '../environment/protocol.ts'
import { digestOf, type Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../review/protocol.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { decisionDraftOf } from './decision.ts'
import { RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, releaseDraftOf, type ReleaseDraft, type ReleaseState,
} from './protocol.ts'

export interface ReleaseCommandOptions {
  readonly store: ControlSessionStore
  readonly require?: () => void
}
export interface ReleaseCommands {
  draft(input: { readonly commandId: string; readonly revision: RevisionRef }): Promise<Envelope>
  draftFromDecision(input: { readonly commandId: string; readonly roundId: string }): Promise<Envelope>
  approveReview(input: { readonly commandId: string
    readonly environmentId: string
    readonly revisionId: string
    readonly draftDigest: string
    readonly witness: {
      readonly reviewId: string
      readonly subjectDigest: string
      readonly artifactDigest: string
      readonly agentId: string } }): Promise<Envelope>
  publish(input: { readonly commandId: string
    readonly environmentId: string
    readonly expected: string
    readonly to: string }): Promise<Envelope>
}

export function createReleaseCommands(options: ReleaseCommandOptions): ReleaseCommands {
  const emit = (commandId: string, kind: string, subject: string, payload: unknown, require?: () => void) =>
    options.store.emit({ commandId, protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind, subject, payload }, () => {
      options.require?.()
      require?.()
    },
    )
  const validate = (environmentId: string, draft: ReleaseDraft): void => {
    const cut = options.store.load()
    assertPinnedRevision({ environmentId, revisionId: draft.revisionId, digest: draft.contentDigest },
      cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'release target',
    )
    if (draft.basis.kind === 'decision') {
      const current = decisionDraftOf(cut, draft.basis.roundId)
      if (current.environmentId !== environmentId || digestOf(current.draft) !== digestOf(draft))
        refuse('stale-approval', 'the draft does not bind the committed winner, report and decision')
      if (cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, environmentId)!.pointer !== draft.basis.expected)
        refuse('illegal-transition', 'the release decision expected head has moved')
    }
  }
  return {
    draft: (input) => {
      const draft = releaseDraftOf(input.revision, { kind: 'bootstrap' })
      return emit(input.commandId, RELEASE_KINDS.drafted, input.revision.environmentId, draft,
        () => validate(input.revision.environmentId, draft),
      )
    },
    draftFromDecision: (input) => {
      const { environmentId, draft } = decisionDraftOf(options.store.load(), input.roundId)
      return emit(input.commandId, RELEASE_KINDS.drafted, environmentId, draft, () => validate(environmentId, draft))
    },
    approveReview: (input) => emit(input.commandId, RELEASE_KINDS.approved, input.environmentId, {
      revisionId: input.revisionId, draftDigest: input.draftDigest, approvedBy: input.witness.agentId,
      approvalId: input.witness.reviewId,
      review: input.witness,
    }, () => {
      const cut = options.store.load()
      const standing = cut.stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, input.environmentId)!
      const review = cut.stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, input.witness.reviewId)
          const target = review?.target
          if (
            review?.status !== 'completed' ||
            review.agentId !== input.witness.agentId ||
            review.subjectDigest !== input.witness.subjectDigest ||
            review.result!.attachmentId !== `sha256:${input.witness.artifactDigest}` ||
            review.findings!.some((f) => f.verdict !== 'pass') ||
            target?.kind !== 'publication' ||
            target.environmentId !== input.environmentId ||
            target.revisionId !== input.revisionId ||
            target.draftDigest !== standing.draftDigest ||
            input.draftDigest !== standing.draftDigest ||
            target.assetsDigest !== standing.contentDigest
          )
            refuse(
              'unapproved-revision',
              'publication requires the completed independent review of this exact draft and assets',
            )
        },
      ),
    publish: (input) => options.store.emit({ commandId: input.commandId, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.pointerSwitched, subject: input.environmentId, payload: { expected: input.expected, to: input.to },
        }, () => {
      options.require?.()
      const release = options.store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, input.environmentId)
      if (release === undefined || release.draftDigest === '')
        refuse('unapproved-revision', `cannot release revision "${input.to}" in environment "${input.environmentId}": no draft is on the table`,
            )
      if (release.approvedBy === undefined) refuse('unapproved-revision', `revision "${release.revisionId}" carries no approval`)
      if (release.revisionId !== input.to)
        refuse('unapproved-revision', `the standing approval authorises revision "${release.revisionId}", not "${input.to}"`,
            )
      const draft: ReleaseDraft = { revisionId: release.revisionId, contentDigest: release.contentDigest,
        draftDigest: release.draftDigest, basis: release.basis!,
          }
      if (draft.basis.kind === 'decision' && input.expected !== draft.basis.expected)
        refuse('illegal-transition', 'publication cannot rebase the approved decision expected head')
      validate(input.environmentId, draft)
    },
      ),
  }
}

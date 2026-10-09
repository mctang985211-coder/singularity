/**
 * The release command boundary: draft, approve, publish — the only surface that produces a release
 * fact or moves an environment's head.
 *
 * **Why a boundary at all.** A release fact is about a revision, and the revision is a fact of the
 * *environment's* subject. One subject's reducer never sees another's facts, so "the revision this
 * draft binds actually exists at that content" cannot be decided in `release@1`. It is decided here,
 * inside the store's commit region, as the `require` step handed to the append path: it reads the
 * committed cut at the moment it runs, so the state it decides against is the state the fact will be
 * appended to. A check performed earlier, against a cut read earlier, is a check against a state
 * that may already be gone.
 *
 * **What the caller supplies, and what it does not.** A caller supplies the pin — environment,
 * revision id, content digest — because that is the difference being released, and the log confirms
 * it or refuses with `unknown-revision`. A caller supplies `approvedBy`, because the human identity
 * belongs to the native approval act and nowhere else. A caller never supplies the emitter: the
 * `scheduler` and `approver` roles are stamped by the log from the declarations, so the identity
 * that drafts cannot approve its own draft.
 *
 * **Why `approve` carries no `require`.** Both of its rules — a draft exists, and the offered digest
 * is that draft's — are rules about this one subject, so they live in the reducer (design §2). A
 * second copy at the boundary would be a rule free to disagree with the one that decides.
 *
 * **Publishing is the pointer switch, so it is a command here, not a kind there.** `environment@2`
 * owns the compare-and-swap; the half it cannot see — that the target is a revision a human
 * approved, at the content this environment holds — is this command's precondition. Refusing there
 * is `unapproved-revision`; refusing the switch itself is the reducer's `illegal-transition`.
 *
 * @module singularity-core/release/commands
 */

import type { ControlReadCut, ControlSessionStore } from '../control/session-store.ts'
import type { Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import {
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../environment/protocol.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from './protocol.ts'

export interface ReleaseCommandOptions {
  readonly store: ControlSessionStore
}

/**
 * The publication path, as the deployment's own identities drive it.
 *
 * Every command carries its own `commandId`: command identity is the caller's identity for the act
 * ("the approval of r0001 by alice"), and the log answers a retry with the fact it already
 * committed, so a lost reply does not become a second draft or a second approval.
 */
export interface ReleaseCommands {
  /**
   * Record that this revision's content is the draft to be approved.
   *
   * The pin is verified against the revisions the log created, so the recorded digest is the digest
   * the log holds and not a caller's copy of it.
   */
  draft(input: { readonly commandId: string; readonly revision: RevisionRef }): Promise<Envelope>
  /**
   * Record a human's authorisation of the drafted content. `draftDigest` is what the approver saw:
   * when it is not the draft's, the fact is refused with `stale-approval`.
   */
  approve(input: {
    readonly commandId: string
    readonly revisionId: string
    readonly draftDigest: string
    readonly approvedBy: string
  }): Promise<Envelope>
  /**
   * Move one environment's head onto an approved revision.
   *
   * `expected` is the head this switch is based on — the empty string names an environment whose
   * head is empty. A head that moved in the meantime refuses the switch (`illegal-transition`) and
   * is never re-based.
   */
  publish(input: {
    readonly commandId: string
    readonly environmentId: string
    readonly expected: string
    readonly to: string
  }): Promise<Envelope>
}

export function createReleaseCommands(options: ReleaseCommandOptions): ReleaseCommands {
  return {
    draft: input =>
      emitRelease(options, input.commandId, RELEASE_KINDS.drafted, input.revision.revisionId, { draftDigest: input.revision.digest }, () =>
        assertPinnedRevision(
          input.revision,
          options.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
          `release/drafted for revision "${input.revision.revisionId}" of environment "${input.revision.environmentId}"`,
        ),
      ),

    approve: input =>
      emitRelease(options, input.commandId, RELEASE_KINDS.approved, input.revisionId, {
        draftDigest: input.draftDigest,
        approvedBy: input.approvedBy,
      }),

    publish: input =>
      options.store.emit(
        {
          commandId: input.commandId,
          protocol: ENVIRONMENT_PROTOCOL,
          version: ENVIRONMENT_VERSION,
          kind: ENVIRONMENT_KINDS.pointerSwitched,
          subject: input.environmentId,
          payload: { expected: input.expected, to: input.to },
        },
        () => {
          const cut = options.store.load()
          const approved = approvedContentOf(cut, input.environmentId, input.to)
          // The cross-subject half: the approval bound a content digest, and this environment must
          // hold that content under that id. `assertPinnedRevision` is the environment slice's own
          // resolution — the same one a run's pin goes through — so a pointer cannot be published
          // onto an id this environment created with *different* content.
          assertPinnedRevision(
            { environmentId: input.environmentId, revisionId: input.to, digest: approved },
            cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
            `publish to revision "${input.to}"`,
          )
        },
      ),
  }
}

/** One release fact, with its cross-subject preconditions handed to the append path. */
function emitRelease(
  options: ReleaseCommandOptions,
  commandId: string,
  kind: string,
  subject: string,
  payload: unknown,
  require?: () => void,
): Promise<Envelope> {
  return options.store.emit(
    { commandId, protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind, subject, payload },
    require,
  ) as Promise<Envelope>
}

/**
 * The content digest an approval bound, or a refusal naming which half of "approved content" is
 * missing.
 *
 * A revision that exists but carries no approval and a revision no release fact mentions are the
 * same next move for the caller — nothing approved this content, so get it approved — which is why
 * they are one code. Which of the two happened is still spelled out in the detail, because "the
 * pipeline never drafted it" and "a reviewer has not looked yet" are different people's problems.
 */
function approvedContentOf(cut: ControlReadCut, environmentId: string, revisionId: string): string {
  const release = cut.stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, revisionId)
  const drafted = release?.draftDigest ?? ''
  if (drafted === '' || release?.approvedBy === undefined)
    refuse(
      'unapproved-revision',
      `cannot move the head of environment "${environmentId}" to revision "${revisionId}": ${
        drafted === ''
          ? 'no release fact names it, so no content of it was ever drafted'
          : `its draft of content ${drafted.slice(0, 12)}… carries no approval`
      }; the head names content a human approved, so draft this revision and approve that content first`,
    )
  return drafted
}

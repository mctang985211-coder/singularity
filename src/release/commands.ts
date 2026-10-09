/**
 * The release command boundary: draft, approve, publish — the only surface that produces a release
 * fact or moves an environment's head.
 *
 * **Why a boundary at all.** A release fact is about an environment's revision, and the revision is
 * a fact of that environment's own subject. One subject's reducer never sees another's facts, so
 * "the revision this draft binds actually exists at that content" cannot be decided in `release@1`.
 * It is decided here, inside the store's commit region, as the `require` step handed to the append
 * path: it reads the committed cut at the moment it runs, so the state it decides against is the
 * state the fact will be appended to. A check performed earlier, against a cut read earlier, is a
 * check against a state that may already be gone.
 *
 * **What the caller supplies, and what it does not.** A caller supplies the pin — environment,
 * revision id, content digest — because that is the difference being released, and the log confirms
 * it or refuses with `unknown-revision`. A caller supplies `approvedBy`, because the human identity
 * belongs to the native approval act and nowhere else. A caller never supplies the emitter: the
 * `scheduler` and `approver` roles are stamped by the log from the declarations, so the identity
 * that drafts cannot approve its own draft.
 *
 * **The native ask runs before the commit region, and the fact is decided after it.** An ask waits
 * for a person; holding the store's serial region while somebody thinks would serialize the whole
 * deployment behind a human. So the ask settles first, and the reducer then decides the fact against
 * the state as it is *now*. A grant for content that is no longer on the table therefore does not
 * become an approval — the reducer refuses it (`stale-approval`, `illegal-transition`) — which is
 * the same discipline as "re-validate the approved content at publish time", applied one step
 * earlier.
 *
 * **Why `approve` carries no `require`.** All of its rules — a draft exists, it is the revision the
 * approval names, the digest is that draft's, and it is not approved twice — are rules about one
 * subject, so they live in the reducer (design §2). A second copy at the boundary would be a rule
 * free to disagree with the one that decides.
 *
 * **Publishing is the pointer switch, so it is a command here, not a kind there.** `environment@2`
 * owns the compare-and-swap; the half it cannot see — that the target is the revision this
 * environment's standing approval authorises, at the content the environment holds — is this
 * command's precondition. Refusing there is `unapproved-revision` or `unknown-revision`; refusing
 * the switch itself is the reducer's `illegal-transition`.
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
import { APPROVAL_GRANT, askForApproval, type ApprovalAsk, type ApprovalSeams } from '../runtime/approval.ts'
import { RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from './protocol.ts'

export interface ReleaseCommandOptions {
  readonly store: ControlSessionStore
  /**
   * The composed native-approval seams, `{ approval: ctx.approval, feed: ctx }`. **Absent means this
   * deployment cannot record an approval at all**: there is no default answerer and no fallback
   * grant, so `approve` refuses by name rather than recording consent nobody gave.
   */
  readonly approvalSeams?: ApprovalSeams | undefined
}

/**
 * The publication path, as the deployment's own identities drive it.
 *
 * Every command carries its own `commandId`: command identity is the caller's identity for the act
 * ("the approval of r0001 in library-1 by alice"), and the log answers a retry with the fact it
 * already committed, so a lost reply does not become a second draft or a second approval.
 */
export interface ReleaseCommands {
  /**
   * Put one revision's content on the table for this environment.
   *
   * The pin is verified against the revisions the log created, so the recorded digest is the digest
   * the log holds and not a caller's copy of it. A draft supersedes the previous one and clears its
   * approval; drafting the same content twice is refused.
   */
  draft(input: { readonly commandId: string; readonly revision: RevisionRef }): Promise<Envelope>
  /**
   * Record a human's authorisation of the drafted content.
   *
   * `ask` is the native question: the live agent that asks, and the tool the question is about. The
   * answer must be exactly `'allowed-once'` **and** attributable to one `approval/asked` id, or no
   * fact is recorded. `draftDigest` is what the approver saw: when it is not the draft's, the fact is
   * refused with `stale-approval`.
   */
  approve(input: {
    readonly commandId: string
    readonly environmentId: string
    readonly revisionId: string
    readonly draftDigest: string
    readonly approvedBy: string
    readonly ask: ApprovalAsk
  }): Promise<Envelope>
  /**
   * Move one environment's head onto the revision its standing approval authorises.
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
      emitRelease(options, input.commandId, RELEASE_KINDS.drafted, input.revision.environmentId, {
        revisionId: input.revision.revisionId,
        draftDigest: input.revision.digest,
      }, () =>
        assertPinnedRevision(
          input.revision,
          options.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
          `release/drafted for revision "${input.revision.revisionId}" of environment "${input.revision.environmentId}"`,
        ),
      ),

    approve: async input => {
      const attempt = await askForApproval(options.approvalSeams ?? {}, input.ask)
      if (attempt.outcome !== APPROVAL_GRANT || attempt.approvalId === undefined)
        refuse(
          'unapproved-revision',
          `cannot approve revision "${input.revisionId}" of environment "${input.environmentId}": the native ask answered ${JSON.stringify(
            attempt.outcome,
          )}${
            attempt.approvalId === undefined ? ' and its audit id could not be attributed to one question' : ''
          }; only ${JSON.stringify(APPROVAL_GRANT)} is a grant, so nothing was authorised and no approval is recorded`,
        )
      return emitRelease(options, input.commandId, RELEASE_KINDS.approved, input.environmentId, {
        revisionId: input.revisionId,
        draftDigest: input.draftDigest,
        approvedBy: input.approvedBy,
        approvalId: attempt.approvalId,
      })
    },

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
          // hold that content under that revision id. `assertPinnedRevision` is the environment
          // slice's own resolution — the same one a run's pin goes through — so a pointer cannot be
          // published onto content this environment does not hold, even when the approval is real
          // for some other revision of the same id.
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
 * The content digest the environment's standing approval authorises, or a refusal naming which half
 * of "approved content" is missing.
 *
 * Three different situations reach the same code, because the caller's next move is the same one —
 * nothing is approved for this target, so get it approved. Which of them happened is still spelled
 * out in the detail: nothing drafted (the pipeline has not proposed anything), drafted but not
 * approved (a reviewer has not looked yet), and approved for another revision (the pipeline is
 * pointing at something nobody approved).
 */
function approvedContentOf(cut: ControlReadCut, environmentId: string, revisionId: string): string {
  const release = cut.stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)
  if (release === undefined || release.draftDigest === '')
    refuse(
      'unapproved-revision',
      `cannot move the head of environment "${environmentId}" to revision "${revisionId}": no draft is on the table, so no content of it was ever approved`,
    )
  if (release.approvedBy === undefined)
    refuse(
      'unapproved-revision',
      `cannot move the head of environment "${environmentId}" to revision "${revisionId}": its draft of content ${release.draftDigest.slice(
        0,
        12,
      )}… carries no approval`,
    )
  if (release.revisionId !== revisionId)
    refuse(
      'unapproved-revision',
      `cannot move the head of environment "${environmentId}" to revision "${revisionId}": the standing approval authorises revision "${release.revisionId}", not "${revisionId}"`,
    )
  return release.draftDigest
}

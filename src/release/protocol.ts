/**
 * The release protocol: the record that one environment's next revision was **drafted and
 * authorised**, content and all.
 *
 * **The subject is the environment; the revision is a member.** A release is one head transition of
 * one environment, and a revision id is unique only *within* an environment — two environments may
 * both hold an `r0001`, for different content. Keying this protocol by the bare revision id made one
 * environment's approval answer for another environment's content; keying it by the environment
 * makes "one draft on the table at a time" the rule, and forces every fact to say which revision it
 * is about.
 *
 * **What the native approval seam contributes, and what it cannot.** DSH's approval binds to a
 * `ToolCallId` and an agent, carries no payload digest, copies no arguments, and its `allowed-once`
 * grant is not persisted (`docs/context.md` §10). So the seam can only ever establish *that a human
 * authorised this act*; it cannot establish *what* was authorised. The missing half is ours, and
 * three different mechanisms carry three different things:
 *
 * 1. the **role-stamped emitter** (`APPROVER_ROLE`, never the scheduler that drafts) is the
 *    authority: an approval cannot come from the identity that proposed the content;
 * 2. `approvalId` is the **audit identity** of the native act — the `approval/asked` id of the
 *    question, whose answer had to be `'allowed-once'` before this fact existed at all;
 * 3. `draftDigest` is the **binding**: the content digest the approver saw, which must be the digest
 *    the draft holds, or the fact is refused with `stale-approval`.
 *
 * (`approvedBy` names which human, beside the stamped actor: the role is the authority, the member
 * is the attribution.)
 *
 * **Approval is not publication.** There is no publish kind here on purpose: publishing is the
 * environment pointer switch (`environment@2`), so "the head never names an unapproved revision" is
 * one precondition on one conditional fact, rather than a state machine that can disagree with the
 * pointer it is supposed to gate.
 *
 * **What `stale-approval` can actually catch.** A draft is one-shot and `environment@2` refuses the
 * same revision id at different content, so the drafted *content* cannot move under one id. The
 * reachable mistake is therefore the one this refusal names: the approval carries content **other
 * than what is on the table** — the human approved something else, or an older revision's digest
 * arrived under a newer revision's name. The approval is refused rather than trimmed to fit, because
 * an approval the log adjusts authorises nothing a human saw.
 *
 * @module singularity-core/release/protocol
 */

import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import { SCHEDULER_ROLE } from '../task/protocol.ts'

export const RELEASE_PROTOCOL = 'release'

/**
 * Version 1: the whole protocol, declared once. There is no version 0 to be compatible with, and a
 * later member addition is a bump (design §2: adding a member means a new version, always).
 */
export const RELEASE_VERSION = 1

/**
 * The trusted role that records approvals — **distinct from the role that drafts**, which is the
 * scheduler's (`SCHEDULER_ROLE`). Deliberately a different held identity, for the same reason a
 * verdict's emitter may not be the role that started the run: if the identity that proposes content
 * could also authorise it, the log would record a self-approval and the human step would be
 * decoration. A deployment that holds no identity for this role cannot record an approval at all —
 * `unknown-emitter-role` — which is what makes "a human authorised this" mechanical rather than
 * promised.
 */
export const APPROVER_ROLE = 'approver'

export const RELEASE_KINDS = {
  drafted: 'release/drafted',
  approved: 'release/approved',
} as const

const APPENDED = { appended: true } as const
const DRAFTED_MEMBERS = ['revisionId', 'draftDigest'] as const
const APPROVED_MEMBERS = ['revisionId', 'draftDigest', 'approvedBy', 'approvalId'] as const

/**
 * The folded state of one environment's release: the draft on the table, and its approval.
 *
 * The empty string in `revisionId` and `draftDigest` means **nothing is drafted** — neither a
 * revision id nor a digest is ever empty, so the sentinel cannot be confused with content. A new
 * draft replaces both and clears the approval; a boolean beside them would be a second copy of the
 * same truth, free to disagree.
 */
export interface ReleaseState {
  /** The revision this environment's draft is about. Empty exactly when nothing is drafted. */
  readonly revisionId: string
  /** The content digest the draft bound. Equal to the created revision's digest, checked at draft. */
  readonly draftDigest: string
  /** The human identity the approval seam supplied. Present exactly when the draft is approved. */
  readonly approvedBy?: string
  /**
   * The `approval/asked` id the approval rests on. Present exactly when `approvedBy` is. No reducer
   * reads it, and it stays anyway: it is the audit identity of the native act, the one thing neither
   * `approvedBy` (which human) nor the stamped approver role nor `commandId` (our own retry id)
   * carries, and the deployment's approval probes read it back against the host's ask log.
   */
  readonly approvalId?: string
}

const SHA256 = /^[0-9a-f]{64}$/

function record(raw: unknown, where: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    refuse(
      'malformed-payload',
      `${where} must be an object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw}`,
    )
  return raw as Record<string, unknown>
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0)
    refuse(
      'malformed-payload',
      `${where}.${key} must be a non-empty string, got ${value === null ? 'null' : typeof value}`,
    )
  return value
}

/** A content digest, not a digest-shaped claim: the reducer's `stale-approval` compares these. */
function digest(source: Record<string, unknown>, key: string, where: string): string {
  const value = text(source, key, where)
  if (!SHA256.test(value))
    refuse(
      'malformed-payload',
      `${where}.${key} must be a sha256 content digest, got ${JSON.stringify(value)}; an approval that names nothing identifiable binds nothing`,
    )
  return value
}

/**
 * Declare the release protocol. Call once at load.
 *
 * The deployment binds two identities: the scheduler's (`SCHEDULER_ROLE`, whichever service drafts
 * content) and this protocol's `APPROVER_ROLE` (the human authorisation the native approval seam
 * carries). They are bound separately, so the same identity cannot do both.
 */
export function declareReleaseProtocol(registry: ProtocolRegistry): void {
  registry.declare<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, {
    initialState: { revisionId: '', draftDigest: '' },
    kinds: {
      [RELEASE_KINDS.drafted]: defineKind<ReleaseState, { revisionId: string; draftDigest: string }, {}>({
        guarantees: APPENDED,
        members: DRAFTED_MEMBERS,
        nested: {},
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const where = `${RELEASE_KINDS.drafted} payload`
          const source = record(raw, where)
          return { revisionId: text(source, 'revisionId', where), draftDigest: digest(source, 'draftDigest', where) }
        },
        reduce: (state, envelope, payload) => {
          const where = `${RELEASE_KINDS.drafted} #${envelope.seq}`
          // A draft that changes nothing is a mistake, not a confirmation: the content on the table
          // is already this, and re-recording it would drop an approval for no reason.
          if (state.revisionId === payload.revisionId && state.draftDigest === payload.draftDigest)
            refuse(
              'illegal-transition',
              `${where} drafts revision "${payload.revisionId}" of environment "${envelope.subject}" with the content already on the table (${payload.draftDigest.slice(
                0,
                12,
              )}…); a draft that changes nothing adds nothing`,
            )
          // A new draft supersedes the standing one and **clears its approval**: an approval binds
          // the content a human saw, and that content is no longer what is on the table. Both facts
          // stay in the log — a reader can still fold the earlier cut — but no later publish may rest
          // on the superseded grant.
          return { revisionId: payload.revisionId, draftDigest: payload.draftDigest }
        },
      }),
      [RELEASE_KINDS.approved]: defineKind<
        ReleaseState,
        { revisionId: string; draftDigest: string; approvedBy: string; approvalId: string },
        {}
      >({
        guarantees: APPENDED,
        members: APPROVED_MEMBERS,
        nested: {},
        emitter: APPROVER_ROLE,
        parse: raw => {
          const where = `${RELEASE_KINDS.approved} payload`
          const source = record(raw, where)
          return {
            revisionId: text(source, 'revisionId', where),
            draftDigest: digest(source, 'draftDigest', where),
            approvedBy: text(source, 'approvedBy', where),
            approvalId: text(source, 'approvalId', where),
          }
        },
        reduce: (state, envelope, payload) => {
          const where = `${RELEASE_KINDS.approved} #${envelope.seq}`
          // An approval is about a draft. Without one there is no content in this subject for the
          // approval to be about, so it is a state violation rather than a staleness.
          if (state.draftDigest === '')
            refuse(
              'illegal-transition',
              `${where} approves a revision of environment "${envelope.subject}", which has no draft; approval authorises a drafted difference, and this environment has none on the table`,
            )
          // ... and about **the** draft. Without this, an approval naming another revision whose
          // content happens to digest the same would be recorded as authorising a revision no human
          // was shown, because a digest alone cannot tell two identical contents apart.
          if (payload.revisionId !== state.revisionId)
            refuse(
              'illegal-transition',
              `${where} approves revision "${payload.revisionId}" but environment "${envelope.subject}" has revision "${state.revisionId}" on the table; an approval answers the draft it is about, so approve "${state.revisionId}" or draft "${payload.revisionId}" first`,
            )
          // The binding itself. When the digest is not the draft's, the human approved content other
          // than what is on the table, and the approval is refused rather than trimmed to fit.
          if (payload.draftDigest !== state.draftDigest)
            refuse(
              'stale-approval',
              `${where} approves content ${payload.draftDigest.slice(0, 12)}… but the draft of revision "${
                state.revisionId
              }" in environment "${envelope.subject}" is ${state.draftDigest.slice(
                0,
                12,
              )}…; an approval binds the content a human saw, so approve what is on the table rather than something else`,
            )
          // One approval per draft. A second approval cannot be a stronger authorisation of the same
          // content, and accepting it would leave two humans' names on one act of authorising.
          if (state.approvedBy !== undefined)
            refuse(
              'illegal-transition',
              `${where} approves revision "${state.revisionId}" of environment "${envelope.subject}" again (already approved by "${state.approvedBy}"); a second approval is a different act, not a repetition of this one`,
            )
          return {
            revisionId: state.revisionId,
            draftDigest: state.draftDigest,
            approvedBy: payload.approvedBy,
            approvalId: payload.approvalId,
          }
        },
      }),
    },
  })
}

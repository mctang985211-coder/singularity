/**
 * The release protocol: the record that one revision's **content** was drafted and authorised.
 *
 * **What the native approval seam gives us, and what it cannot.** DSH's approval binds to a
 * `ToolCallId` and an agent, carries no payload digest, copies no arguments, and its `allowed-once`
 * grant is not persisted (`docs/context.md` §10). So the seam can only ever establish *that a human
 * authorised this act*; it cannot establish *what* was authorised. The missing half is ours:
 * `release/drafted` binds the content digest the log holds for the revision, and `release/approved`
 * carries the digest the approver actually saw — the reducer refuses it with `stale-approval` when
 * it is not the draft's. Approval therefore binds a specific difference, not an id and not a
 * promise that somebody looked. (The previous system set `guards.bound` true without binding
 * anything: `review.md` R07.)
 *
 * **Approval is not publication.** There is no publish kind here on purpose: publishing is the
 * environment pointer switch (`environment@2`), so "the head never names an unapproved revision" is
 * one precondition on one conditional fact, rather than a state machine that can disagree with the
 * pointer it is supposed to gate.
 *
 * **The subject is the revision id**, as frozen in the design (§7). One consequence is deliberate
 * and worth stating: a revision id names exactly one content *within one environment*, and
 * `environment@2` refuses only the same id in the same environment, so two environments may hold
 * the same id for different content. A release fact is keyed by the id, so the environment that
 * holds it is re-resolved by the command layer — `publish` refuses a revision whose approved content
 * is not what the target environment holds. Releasing colliding ids in two environments at once
 * therefore needs a different subject shape, which is a version bump, not something a reducer can
 * decide.
 *
 * Every payload here is closed, and neither kind accepts a member the log cannot check: the draft's
 * digest is checked against the created revision at the command boundary, and the approval's digest
 * against the draft in the reducer.
 *
 * @module singularity-core/release/protocol
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'

export const RELEASE_PROTOCOL = 'release'

/**
 * Version 1: the whole protocol, declared once. There is no version 0 to be compatible with, and a
 * later member addition is a bump (design §2: adding a member means a new version, always).
 */
export const RELEASE_VERSION = 1

/** The trusted role that records drafts. Held by the pipeline, never by a reviewer. */
export const RELEASE_ROLE = 'release'

/**
 * The trusted role that records approvals. Deliberately a different identity from `RELEASE_ROLE`:
 * the act that proposes content and the act that authorises it must not be the same held identity,
 * for the same reason a verdict's emitter may not be the role that started the run. What the native
 * approval seam contributes is the human behind this role.
 */
export const APPROVER_ROLE = 'approver'

export const RELEASE_KINDS = {
  drafted: 'release/drafted',
  approved: 'release/approved',
} as const

/**
 * The folded state of one release. The subject is the revision id, so the state does not repeat it.
 *
 * `draftDigest` is empty exactly when nothing was drafted — a digest is never empty, so the
 * sentinel cannot be confused with content. `approvedBy` is present exactly when the release is
 * approved. A boolean beside either would be a second copy of the same truth, free to disagree.
 */
export interface ReleaseState {
  /** The content digest the draft bound. Equal to the created revision's digest, checked at draft. */
  readonly draftDigest: string
  /** The human identity the approval seam supplied. Present exactly when this release is approved. */
  readonly approvedBy?: string
}

const APPENDED = { appended: true } as const
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
 * The deployment binds two identities: one for `RELEASE_ROLE` (whatever computes and records
 * drafts) and one for `APPROVER_ROLE` (the human authorisation the native approval seam carries).
 */
export function declareReleaseProtocol(registry: ProtocolRegistry): void {
  registry.declare<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, {
    initialState: { draftDigest: '' },
    kinds: {
      [RELEASE_KINDS.drafted]: defineKind<ReleaseState, { draftDigest: string }>({
        guarantees: APPENDED,
        emitter: RELEASE_ROLE,
        parse: raw => {
          const where = `${RELEASE_KINDS.drafted} payload`
          const source = record(raw, where)
          assertClosedKeys(source, ['draftDigest'], where)
          return { draftDigest: digest(source, 'draftDigest', where) }
        },
        reduce: (state, envelope, payload) => {
          // One draft per revision. A second draft cannot be "a correction": the content it would
          // bind is either the same content (the first draft already said so, so nothing moved) or
          // different content under one id, which `environment@2` refuses. Either way the honest
          // answer is a new revision id, so this refusal names that replacement.
          if (state.draftDigest !== '')
            refuse(
              'illegal-transition',
              `${RELEASE_KINDS.drafted} #${envelope.seq} drafts revision "${envelope.subject}" twice (already drafted with content ${state.draftDigest.slice(
                0,
                12,
              )}…); a changed draft is a new revision, not a second draft of this one`,
            )
          return { draftDigest: payload.draftDigest }
        },
      }),
      [RELEASE_KINDS.approved]: defineKind<ReleaseState, { draftDigest: string; approvedBy: string }>({
        guarantees: APPENDED,
        emitter: APPROVER_ROLE,
        parse: raw => {
          const where = `${RELEASE_KINDS.approved} payload`
          const source = record(raw, where)
          assertClosedKeys(source, ['draftDigest', 'approvedBy'], where)
          return { draftDigest: digest(source, 'draftDigest', where), approvedBy: text(source, 'approvedBy', where) }
        },
        reduce: (state, envelope, payload) => {
          const where = `${RELEASE_KINDS.approved} #${envelope.seq}`
          // An approval is about a draft. Without one there is no content in this subject for the
          // approval to be about, so it is a state violation rather than a staleness.
          if (state.draftDigest === '')
            refuse(
              'illegal-transition',
              `${where} approves revision "${envelope.subject}", which has no draft; approval authorises a drafted difference, and this release has none`,
            )
          // The binding itself. The digest is what the approver saw; when it is not the draft's, the
          // content under consideration moved between the approval and this fact, and the approval
          // is refused rather than trimmed to fit whatever the log now holds.
          if (payload.draftDigest !== state.draftDigest)
            refuse(
              'stale-approval',
              `${where} approves content ${payload.draftDigest.slice(0, 12)}… but the draft of revision "${
                envelope.subject
              }" is ${state.draftDigest.slice(
                0,
                12,
              )}…; an approval binds the content a human saw, so changed content needs a new approval rather than this one`,
            )
          // One approval per release. A second approval cannot be a stronger authorisation of the
          // same content, and accepting it would leave two humans' names on one act of authorising.
          if (state.approvedBy !== undefined)
            refuse(
              'illegal-transition',
              `${where} approves revision "${envelope.subject}" again (already approved by "${state.approvedBy}"); a second approval is a different act, not a repetition of this one`,
            )
          return { draftDigest: state.draftDigest, approvedBy: payload.approvedBy }
        },
      }),
    },
  })
}

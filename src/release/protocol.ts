import { assertClosedKeys, digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import { count } from '../strategy/plan.ts'
import { SCHEDULER_ROLE } from '../task/protocol.ts'
import { digest, record, text } from '../task/shape.ts'
import type { RevisionRef } from '../task/protocol.ts'

export const RELEASE_PROTOCOL = 'release'
export const RELEASE_VERSION = 3
export const APPROVER_ROLE = 'approver'
export const RELEASE_KINDS = { drafted: 'release/drafted', approved: 'release/approved' } as const

export type ReleaseBasis = { readonly kind: 'bootstrap' } | {
  readonly kind: 'decision'
  readonly roundId: string
  readonly decisionSeq: number
  readonly decisionDigest: string
  readonly evaluationId: string
  readonly reportDigest: string
  readonly expected: string
}
export interface ReleaseDraft {
  readonly revisionId: string
  readonly contentDigest: string
  readonly draftDigest: string
  readonly basis: ReleaseBasis
}
export interface ReleaseState {
  readonly revisionId: string
  readonly contentDigest: string
  readonly draftDigest: string
  readonly basis?: ReleaseBasis
  readonly approvedBy?: string
  readonly review?: unknown
  readonly approvalId?: string
}
const BASIS_MEMBERS = ['kind', 'roundId', 'decisionSeq', 'decisionDigest', 'evaluationId', 'reportDigest', 'expected'] as const

export function releaseDraftOf(revision: RevisionRef, basis: ReleaseBasis): ReleaseDraft {
  return { revisionId: revision.revisionId, contentDigest: revision.digest, draftDigest: digestOf({ revision, basis }), basis }
}

function readBasis(raw: unknown, where: string, members: readonly string[]): ReleaseBasis {
  const source = record(raw, where)
  assertClosedKeys(source, members, where)
  if (source['kind'] === 'bootstrap') {
    assertClosedKeys(source, ['kind'], where)
    return { kind: 'bootstrap' }
  }
  if (source['kind'] !== 'decision') refuse('malformed-payload', `${where}.kind must be bootstrap or decision`)
  return { kind: 'decision', roundId: text(source, 'roundId', where), decisionSeq: count(source, 'decisionSeq', where),
    decisionDigest: digest(source, 'decisionDigest', where), evaluationId: text(source, 'evaluationId', where),
    reportDigest: digest(source, 'reportDigest', where), expected: text(source, 'expected', where) }
}

export function declareReleaseProtocol(registry: ProtocolRegistry): void {
  registry.declare<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, {
    initialState: { revisionId: '', contentDigest: '', draftDigest: '' },
    kinds: {
      [RELEASE_KINDS.drafted]: defineKind<ReleaseState, ReleaseDraft, { basis: readonly string[] }>({
        guarantees: { appended: true }, members: ['revisionId', 'contentDigest', 'draftDigest', 'basis'],
        nested: { basis: BASIS_MEMBERS }, emitter: SCHEDULER_ROLE,
        parse: (raw, where, nested) => {
          const source = record(raw, where)
          return { revisionId: text(source, 'revisionId', where), contentDigest: digest(source, 'contentDigest', where),
            draftDigest: digest(source, 'draftDigest', where), basis: readBasis(source['basis'], `${where}.basis`, nested.basis) }
        },
        reduce: (state, envelope, payload) => {
          const expected = releaseDraftOf({ environmentId: envelope.subject, revisionId: payload.revisionId, digest: payload.contentDigest }, payload.basis)
          if (payload.draftDigest !== expected.draftDigest)
            refuse('digest-mismatch', 'the draft digest does not bind its revision and release basis')
          if (state.draftDigest === payload.draftDigest)
            refuse('illegal-transition', `drafting revision "${payload.revisionId}" changes nothing on the table`)
          return payload
        },
      }),
      [RELEASE_KINDS.approved]: defineKind<ReleaseState, { revisionId: string; draftDigest: string; approvedBy: string; approvalId: string; review?: unknown }, {}>({
        guarantees: { appended: true }, members: ['revisionId', 'draftDigest', 'approvedBy', 'approvalId', 'review'], nested: {}, emitter: APPROVER_ROLE,
        parse: (raw, where) => {
          const source = record(raw, where)
          return { revisionId: text(source, 'revisionId', where), draftDigest: digest(source, 'draftDigest', where),
            approvedBy: text(source, 'approvedBy', where), approvalId: text(source, 'approvalId', where), ...(source['review'] === undefined ? {} : { review: source['review'] }) }
        },
        reduce: (state, _envelope, payload) => {
          if (state.draftDigest === '') refuse('illegal-transition', 'the environment has no draft to approve')
          if (payload.revisionId !== state.revisionId)
            refuse('illegal-transition', `approval names revision "${payload.revisionId}" but "${state.revisionId}" is on the table`)
          if (payload.draftDigest !== state.draftDigest)
            refuse('stale-approval', `approval names draft ${payload.draftDigest.slice(0, 12)} but the table holds ${state.draftDigest.slice(0, 12)}`)
          if (state.approvedBy !== undefined) refuse('illegal-transition', `the draft is already approved by "${state.approvedBy}"`)
          return { ...state, approvedBy: payload.approvedBy, approvalId: payload.approvalId, ...(payload.review === undefined ? {} : { review: payload.review }) }
        },
      }),
    },
  })
}

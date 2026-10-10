/**
 * The environment protocol: an environment is a subject, its revisions are content-addressed, and
 * its head is a pointer moved by exactly one conditional fact.
 *
 * An "environment" here is not a process, a sandbox or a directory. It is the **subject** the facts
 * about one environment are keyed by, so one log can carry many environments without one's facts
 * reaching another's fold.
 *
 * Four invariants live in the reducer, which is why no caller can talk around them:
 *
 * 1. **Content is self-authenticating.** The payload declares no digest member — the shape is
 *    closed, so offering one is a refusal — and the reducer computes `digestOf(manifest)` itself.
 *    A revision's identity is therefore its content, not a caller's claim about it.
 * 2. **Same id, same content is idempotent.** Recording a revision again is accepted and leaves the
 *    state *unchanged*, including the moment it was first recorded.
 * 3. **Same id, different content is `revision-conflict`.** Two different manifests cannot share one
 *    revision id, and the refusal names both digests.
 * 4. **The head only moves by compare-and-swap, and only onto a revision this environment created.**
 *    `pointer/switched` is the stack's one conditional update: the reducer compares `expected`
 *    against the head it holds right now, so of two switches that name the same head exactly one is
 *    recorded and the other is refused rather than re-based. A no-op switch is refused too — a
 *    switch that changes nothing is a mistake, not idempotence.
 *
 * No kind here can change a revision that already exists, so "the revision a run pinned" is a fact
 * a reader can re-derive rather than a convention a writer is asked to respect.
 *
 * The manifest must be losslessly JSON: it is the input to a digest, and JSON turns `NaN` into
 * `null` and drops `undefined` members, so without that restriction two different contents could
 * carry one content identity.
 *
 * @module singularity-core/environment/protocol
 */

import { assertLosslessJson, digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'

export const ENVIRONMENT_PROTOCOL = 'environment'
/**
 * Version 2. Version 1 is refused by name (`version-mismatch`), with no compatibility layer: a
 * version is one interpretation of history, and this stack has no distributed ledger to migrate.
 *
 * - 1: `revision/created` only. An environment had revisions and no head, so "which revision is
 *   current" could only be answered outside the log — the exact place §8 forbids storing it.
 * - 2: added `pointer/switched`, the stack's **one** conditional update, and the derived head
 *   `pointer` on the state. The kind is declared atomic because one switch is one complete act:
 *   there is no two-fact publish that a crash could leave half-done.
 */
export const ENVIRONMENT_VERSION = 2

/** The trusted role that creates revisions. The deployment binds an identity for it. */
export const ENVIRONMENT_ROLE = 'environment'

/**
 * The trusted role that may move the head. A separate identity from `ENVIRONMENT_ROLE` on purpose:
 * creating content and publishing content are different acts, so the identity that mints revisions
 * cannot, by itself, make one of them current.
 */
export const PUBLISHER_ROLE = 'publisher'

/** One revision as the fold holds it: its content identity, and the content that produced it. */
export interface RevisionState {
  readonly revisionId: string
  /** `digestOf(manifest)`, computed by the reducer. Never read from a payload. */
  readonly contentDigest: string
  readonly manifest: unknown
  /** When the creating fact was recorded, from the envelope. A re-recording does not update it. */
  readonly at: string
}

/** The folded state of one environment. `subject` in every envelope is this environment's id. */
export interface EnvironmentState {
  readonly environmentId: string
  readonly revisions: Readonly<Record<string, RevisionState>>
  /**
   * The head: the revision this environment currently points at. **Absent means the head is empty**
   * — it is never defaulted to the first or the newest revision, because "nothing has been published
   * yet" and "the first revision is published" are different states and a reader must be able to
   * tell them apart.
   */
  readonly pointer?: string
}

export const ENVIRONMENT_KINDS = {
  revisionCreated: 'revision/created',
  pointerSwitched: 'pointer/switched',
} as const

const APPENDED = { appended: true } as const

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

/**
 * The head a switch compares against, as the payload names it.
 *
 * The empty string names the **empty head**. `pointer` is absent until a switch sets it, and a
 * compare-and-swap needs one name for the state it is replacing; leaving `expected` non-empty would
 * make the first switch impossible, and inventing a revision for it would be the "default to the
 * first revision" this protocol refuses. So the empty head has a name, and a switch from it says so.
 */
function head(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string')
    refuse(
      'malformed-payload',
      `${where}.${key} must be a string, got ${value === null ? 'null' : typeof value}; the empty string names an environment whose head is empty`,
    )
  return value
}

/** How a head reads in a refusal: unset is named as such, not printed as an empty pair of quotes. */
function headName(value: string): string {
  return value === '' ? 'empty' : `"${value}"`
}

/** One revision of one environment, or `undefined` when that environment never created that id. */
function revisionOf(state: EnvironmentState, revisionId: string): RevisionState | undefined {
  // Own keys only: `toString` and `__proto__` are not revision ids.
  return Object.hasOwn(state.revisions, revisionId) ? state.revisions[revisionId] : undefined
}

/**
 * Declare the environment protocol. Call once at load. The deployment binds the `environment`
 * role to one trusted identity, which is the only one that may create a revision, and the
 * `publisher` role to another, which is the only one that may move the head.
 */
export function declareEnvironmentProtocol(registry: ProtocolRegistry): void {
  registry.declare<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, {
    initialState: { environmentId: '', revisions: {} },
    kinds: {
      [ENVIRONMENT_KINDS.revisionCreated]: defineKind<EnvironmentState, { revisionId: string; manifest: unknown }, {}>({
        guarantees: APPENDED,
        members: ['revisionId', 'manifest'],
        nested: {},
        emitter: ENVIRONMENT_ROLE,
        parse: raw => {
          const where = `${ENVIRONMENT_KINDS.revisionCreated} payload`
          const source = record(raw, where)
          // Closed by the declaration above: a payload cannot even offer a `contentDigest` member,
          // let alone be believed.
          if (!Object.hasOwn(source, 'manifest'))
            refuse('malformed-payload', `${where} is missing "manifest"; a revision without content is not a revision`)
          const manifest = source['manifest']
          // The reducer digests this value, so it must round-trip through JSON exactly.
          assertLosslessJson(manifest, `${where}.manifest`)
          return { revisionId: text(source, 'revisionId', where), manifest }
        },
        reduce: (state, envelope, payload) => {
          const where = `${ENVIRONMENT_KINDS.revisionCreated} #${envelope.seq}`
          // Invariant 1: the digest is computed here, from the content, and never read from a payload.
          const contentDigest = digestOf(payload.manifest)
          const existing = revisionOf(state, payload.revisionId)

          if (existing !== undefined) {
            // Invariant 2: the same id with the same content is the same fact. Accept it and leave
            // the state exactly as it was — a re-recording does not move `at` or re-mint anything.
            if (existing.contentDigest === contentDigest) return state
            // Invariant 3: one revision id names one content. The tamper case: the manifest offered
            // for an existing id digests differently from the one that created it.
            refuse(
              'revision-conflict',
              `${where} re-creates revision "${payload.revisionId}" with content ${
                contentDigest.slice(0, 12)
              }… but that id was created with ${existing.contentDigest.slice(
                0,
                12,
              )}…; a revision id names exactly one content`,
            )
          }

          return {
            // The head is carried over. Creating a revision does not publish it, and a state
            // rebuild that dropped `pointer` would silently move the head back to empty.
            ...state,
            environmentId: envelope.subject,
            revisions: {
              ...state.revisions,
              [payload.revisionId]: {
                revisionId: payload.revisionId,
                contentDigest,
                manifest: payload.manifest,
                at: envelope.at,
              },
            },
          }
        },
      }),
      [ENVIRONMENT_KINDS.pointerSwitched]: defineKind<EnvironmentState, { expected: string; to: string }, {}>({
        // The stack's one conditional update, declared as such: the guarantee is what the
        // `single-conditional-owner` gate and the registry's `conditionalOwner` read.
        guarantees: { appended: true, conditional: true, atomicFact: true },
        members: ['expected', 'to'],
        nested: {},
        emitter: PUBLISHER_ROLE,
        parse: raw => {
          const where = `${ENVIRONMENT_KINDS.pointerSwitched} payload`
          const source = record(raw, where)
          // `to` is a revision id, so it is non-empty; `expected` may be empty and then names the
          // empty head. A payload cannot offer a content digest here: what `to` names is resolved
          // against the revisions this environment actually created.
          return { expected: head(source, 'expected', where), to: text(source, 'to', where) }
        },
        reduce: (state, envelope, payload) => {
          const where = `${ENVIRONMENT_KINDS.pointerSwitched} #${envelope.seq}`
          // 1. The head may only name a revision **this** environment created. The revisions are in
          // this same state, so this is an in-subject rule and not a projection: a pointer into
          // another environment's revisions cannot be expressed at all.
          if (revisionOf(state, payload.to) === undefined)
            refuse(
              'unknown-revision',
              `${where} moves the head of environment "${envelope.subject}" to revision "${payload.to}", which that environment never created (created revisions: ${
                Object.keys(state.revisions).sort().join(', ') || 'none'
              }); a head names created content`,
            )
          // 2. The compare-and-swap. This is the whole of "two concurrent switches with one
          // expected head: exactly one commits" — the loser is refused, never re-based onto the
          // winner's head, because a re-based publish would put content in front of users that
          // nobody selected against the state it landed in.
          const current = state.pointer ?? ''
          if (current !== payload.expected)
            refuse(
              'illegal-transition',
              `${where} expects the head of environment "${envelope.subject}" to be ${headName(
                payload.expected,
              )}, but it is ${headName(
                current,
              )}; a switch against a head that already moved is refused, and the caller re-reads the head rather than retrying this fact`,
            )
          // 3. A switch that changes nothing is an error, not idempotence: an operator who asks for
          // it has lost track of the head, and recording the fact would hide that. (Re-delivering
          // the *same command* is idempotent — that is command identity's job, not this rule's.)
          if (payload.to === payload.expected)
            refuse(
              'illegal-transition',
              `${where} switches the head of environment "${envelope.subject}" to "${payload.to}", which is already the head; a no-op switch is a mistake, not a publication`,
            )
          return { ...state, pointer: payload.to }
        },
      }),
    },
  })
}

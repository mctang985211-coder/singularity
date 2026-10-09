/**
 * The environment protocol: an environment is a subject, and its revisions are content-addressed.
 *
 * An "environment" here is not a process, a sandbox or a directory. It is the **subject** the facts
 * about one environment are keyed by, so one log can carry many environments without one's facts
 * reaching another's fold.
 *
 * Three invariants live in the reducer, which is why no caller can talk around them:
 *
 * 1. **Content is self-authenticating.** The payload declares no digest member — the shape is
 *    closed, so offering one is a refusal — and the reducer computes `digestOf(manifest)` itself.
 *    A revision's identity is therefore its content, not a caller's claim about it.
 * 2. **Same id, same content is idempotent.** Recording a revision again is accepted and leaves the
 *    state *unchanged*, including the moment it was first recorded.
 * 3. **Same id, different content is `revision-conflict`.** Two different manifests cannot share one
 *    revision id, and the refusal names both digests.
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

import { assertClosedKeys, assertLosslessJson, digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'

export const ENVIRONMENT_PROTOCOL = 'environment'
export const ENVIRONMENT_VERSION = 1

/** The trusted role that creates revisions. The deployment binds an identity for it. */
export const ENVIRONMENT_ROLE = 'environment'

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
}

export const ENVIRONMENT_KINDS = {
  revisionCreated: 'revision/created',
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

/** One revision of one environment, or `undefined` when that environment never created that id. */
function revisionOf(state: EnvironmentState, revisionId: string): RevisionState | undefined {
  // Own keys only: `toString` and `__proto__` are not revision ids.
  return Object.hasOwn(state.revisions, revisionId) ? state.revisions[revisionId] : undefined
}

/**
 * Declare the environment protocol. Call once at load. The deployment binds the `environment`
 * role to one trusted identity; nothing else may create a revision.
 */
export function declareEnvironmentProtocol(registry: ProtocolRegistry): void {
  registry.declare<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, {
    initialState: { environmentId: '', revisions: {} },
    kinds: {
      [ENVIRONMENT_KINDS.revisionCreated]: defineKind<EnvironmentState, { revisionId: string; manifest: unknown }>({
        guarantees: APPENDED,
        emitter: ENVIRONMENT_ROLE,
        parse: raw => {
          const where = `${ENVIRONMENT_KINDS.revisionCreated} payload`
          const source = record(raw, where)
          // Closed: a payload cannot even offer a `contentDigest` member, let alone be believed.
          assertClosedKeys(source, ['revisionId', 'manifest'], where)
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
    },
  })
}

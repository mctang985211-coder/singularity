/**
 * The one envelope.
 *
 * Every durable fact in this system — session-scoped or library-scoped — travels in this
 * shape: a named subject, a declared kind, the actor that emitted it, and a digest over its
 * own body. The envelope is **closed**: an unknown member is a refusal, never ignored.
 *
 * The digest covers the body only (`digest` excluded), so a fact's identity is exactly what
 * it claims, and a tampered payload is a named refusal rather than a silent reinterpretation.
 *
 * @module singularity-core/protocol/envelope
 */

import { createHash } from 'node:crypto'
import { refuse } from './refusal.ts'

/** The one envelope. `Payload` stays typed per kind; the frame never interprets it. */
export interface Envelope<Payload = unknown> {
  /** The fact family, e.g. `task`, `method`, `graph`. */
  readonly protocol: string
  /** The family's own version, a positive integer. */
  readonly version: number
  /** The fact kind within that family. */
  readonly kind: string
  /** What the fact is about: the id whose fold state this fact advances. */
  readonly subject: string
  /** Who emitted it. */
  readonly actor: string
  /** When, as an ISO-8601 instant. */
  readonly at: string
  /** Position in this log, from 0, contiguous. */
  readonly seq: number
  /** The previous fact's digest, or `null` for the first fact in a log. */
  readonly prevDigest: string | null
  readonly payload: Payload
  /** sha256 of the canonical body. */
  readonly digest: string
}

/** The body the digest covers, and the only members an envelope may carry. */
export type EnvelopeBody = Omit<Envelope, 'digest'>

export const ENVELOPE_MEMBERS = [
  'protocol',
  'version',
  'kind',
  'subject',
  'actor',
  'at',
  'seq',
  'prevDigest',
  'payload',
  'digest',
] as const

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** Deterministic JSON: object keys sorted, so equal values always digest equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]))
}

/** sha256 over the canonical form of any value. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** The digest an envelope must carry for its own body. */
export function digestOfBody(body: EnvelopeBody): string {
  return digestOf(body)
}

/** Frame one body into a complete envelope. The only place a digest is minted. */
export function sealEnvelope(body: EnvelopeBody): Envelope {
  return { ...body, digest: digestOfBody(body) }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function requireMember(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) refuse('malformed-envelope', `envelope is missing ${JSON.stringify(key)}`)
  return record[key]
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = requireMember(record, key)
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-envelope', `envelope ${key} must be a non-empty string, got ${describe(value)}`)
  return value
}

function requireCount(record: Record<string, unknown>, key: string): number {
  const value = requireMember(record, key)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    refuse('malformed-envelope', `envelope ${key} must be an integer >= 0, got ${describe(value)}`)
  return value
}

/**
 * Read one envelope at the protocol boundary.
 *
 * The members are checked first (closed set), then each field's type, then the digest. A
 * fact whose body changed since it was written is refused here, before any reducer sees it.
 */
export function assertEnvelope(raw: unknown): Envelope {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    refuse('malformed-envelope', `an envelope is an object, got ${describe(raw)}`)
  const record = raw as Record<string, unknown>

  for (const key of Object.keys(record)) {
    if (!(ENVELOPE_MEMBERS as readonly string[]).includes(key))
      refuse(
        'malformed-envelope',
        `unknown envelope member ${JSON.stringify(key)}; the envelope is closed (known: ${ENVELOPE_MEMBERS.join(', ')})`,
      )
  }

  const protocol = requireText(record, 'protocol')
  const kind = requireText(record, 'kind')
  const subject = requireText(record, 'subject')
  const actor = requireText(record, 'actor')
  const at = requireText(record, 'at')
  const version = requireCount(record, 'version')
  if (version < 1) refuse('malformed-envelope', `envelope version must be >= 1, got ${version}`)
  const seq = requireCount(record, 'seq')

  const prevDigest = requireMember(record, 'prevDigest')
  if (prevDigest !== null && (typeof prevDigest !== 'string' || !DIGEST_PATTERN.test(prevDigest)))
    refuse('malformed-envelope', `envelope prevDigest must be null or a sha256 hex digest, got ${describe(prevDigest)}`)

  if (!('payload' in record)) refuse('malformed-envelope', 'envelope is missing "payload"')
  const payload = record['payload']

  const digest = requireText(record, 'digest')
  if (!DIGEST_PATTERN.test(digest))
    refuse('malformed-envelope', `envelope digest must be a sha256 hex digest, got ${JSON.stringify(digest)}`)

  const body: EnvelopeBody = { protocol, version, kind, subject, actor, at, seq, prevDigest, payload }
  const computed = digestOfBody(body)
  if (computed !== digest)
    refuse('digest-mismatch', `envelope ${protocol}/${kind} #${seq} carries digest ${digest.slice(0, 12)}… but its body reads ${computed.slice(0, 12)}…`)

  return { ...body, digest }
}

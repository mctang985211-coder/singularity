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
 * **Why `seq`, `prevDigest` and `at` stay when the carrier already supplies a sequence and a time.**
 * `review.md` U02 read them as a second copy of the medium's `SessionEvent.seq`/`time`; the split is
 * by authority. The carrier owns the **physical** position — which event in the session, what an
 * append continues, what a readback is addressed by. This frame owns **the log's** position, link and
 * instant: `seq` is the unit every cut is expressed in (the frozen `historyCutoff`,
 * `publishedAssetsBelow`, `ControlReadCut.entriesOf`), and `adopt` verifies contiguity and chain links
 * on `seq`/`prevDigest` alone, so a log read back from a medium is checked on its own terms; `at` is
 * the instant reducers record, which the carrier's `time` never reaches them. The two agree today only
 * because a control session carries nothing but control events — the log keeps its own so it stays
 * foldable with no carrier to ask, which is how every spec uses it. Re-open U02 only with an owner for
 * the cuts.
 *
 * @module singularity-core/protocol/envelope
 */

import { createHash } from 'node:crypto'
import { refuse, type RefusalCode } from './refusal.ts'

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
  /**
   * The caller's own id for the command that produced this fact.
   *
   * It travels in the frame because it is provenance, not payload: after a crash between commit and
   * reply, the successor must recognize a redelivered command from the facts alone. A command id
   * that lived only in the writer's memory made recovery impossible — the successor could not tell
   * "already committed" from "never seen", and the domain reducer then refused the redelivery as an
   * illegal transition.
   */
  readonly commandId: string
  /**
   * The trusted role that produced the fact, from the kind's own declaration. A caller cannot
   * choose this: it is what makes "an executor never judges its own run" checkable on roles.
   */
  readonly emitter: string
  /** The identity the emitter role resolved to at commit time. Also never caller-supplied. */
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
  'commandId',
  'emitter',
  'actor',
  'at',
  'seq',
  'prevDigest',
  'payload',
  'digest',
] as const

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/**
 * Read one value as **losslessly** JSON, or refuse it by name.
 *
 * Content identity is the one place where a silent coercion is fatal: `JSON.stringify` turns
 * `NaN` into `null` and drops `undefined` members, so `digestOf({v: NaN})` would equal
 * `digestOf({v: null})` and `digestOf({v: undefined})` would equal `digestOf({})`. Two facts
 * that are not the same would carry the same content identity. This walks the value and refuses
 * anything JSON cannot round-trip exactly; it is a domain restriction, not a serializer.
 */
export function assertLosslessJson(value: unknown, where: string, seen = new Set<object>()): void {
  if (value === null) return
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return
    case 'number':
      if (!Number.isFinite(value))
        refuse('not-lossless-json', `${where} is ${String(value)}, which JSON round-trips as null`)
      // `-0` and `0` are distinct numbers that JSON writes identically, so they would share one
      // content identity. Same class as NaN/null: a silent coercion inside the identity itself.
      if (Object.is(value, -0)) refuse('not-lossless-json', `${where} is -0, which JSON round-trips as 0`)
      return
    case 'object':
      break
    default:
      // undefined, function, symbol, bigint: JSON drops or mangles each of them.
      refuse('not-lossless-json', `${where} is a ${typeof value}, which JSON cannot round-trip`)
  }

  const container = value as object
  if (seen.has(container)) refuse('not-lossless-json', `${where} is cyclic; JSON cannot round-trip it`)
  seen.add(container)
  try {
    if (Array.isArray(container)) {
      for (const [index, entry] of container.entries()) assertLosslessJson(entry, `${where}[${index}]`, seen)
      return
    }
    const prototype: unknown = Object.getPrototypeOf(container)
    if (prototype !== Object.prototype && prototype !== null)
      refuse('not-lossless-json', `${where} is a ${container.constructor?.name ?? 'non-plain object'}, whose members JSON would not restore`)
    for (const [key, entry] of Object.entries(container)) assertLosslessJson(entry, `${where}.${key}`, seen)
  } finally {
    seen.delete(container)
  }
}

/** Deterministic JSON: object keys sorted, so equal values always digest equally. */
export function canonicalJson(value: unknown): string {
  assertLosslessJson(value, 'canonicalJson input')
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

/**
 * Refuse a record that carries a member outside its declared set.
 *
 * A closed shape is how "unknown field" becomes an error instead of a silently ignored typo.
 * Both the frame and every domain payload use this one rule; they differ only in which refusal
 * code names the violation.
 */
export function assertClosedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  code: RefusalCode = 'malformed-payload',
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key))
      refuse(code, `${where} carries unknown member ${JSON.stringify(key)}; the shape is closed (known: ${allowed.join(', ')})`)
  }
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

  assertClosedKeys(record, ENVELOPE_MEMBERS, 'envelope', 'malformed-envelope')

  const protocol = requireText(record, 'protocol')
  const kind = requireText(record, 'kind')
  const subject = requireText(record, 'subject')
  const commandId = requireText(record, 'commandId')
  const emitter = requireText(record, 'emitter')
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
  // A payload that JSON cannot round-trip would carry a content identity it does not have.
  assertLosslessJson(payload, `envelope ${protocol}/${kind} #${seq} payload`)

  const digest = requireText(record, 'digest')
  if (!DIGEST_PATTERN.test(digest))
    refuse('malformed-envelope', `envelope digest must be a sha256 hex digest, got ${JSON.stringify(digest)}`)

  const body: EnvelopeBody = { protocol, version, kind, subject, commandId, emitter, actor, at, seq, prevDigest, payload }
  const computed = digestOfBody(body)
  if (computed !== digest)
    refuse('digest-mismatch', `envelope ${protocol}/${kind} #${seq} carries digest ${digest.slice(0, 12)}… but its body reads ${computed.slice(0, 12)}…`)

  return { ...body, digest }
}

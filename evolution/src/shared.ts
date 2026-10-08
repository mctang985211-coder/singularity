/** The shared primitives of this package: canonical JSON, its digests, the shape guards and the one coded refusal.
 * @module dsh-singularity-evolution/shared */

import { isAbsolute } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'

/** Whether a value is a lowercase 64-character SHA-256 hex digest. */
export function isHex64(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** The evolution-prefixed refusal every guard raises when a value fails its check. */
export function evolutionFail(detail: string): Error {
  return new Error(`evolution: ${detail}`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function nonEmpty(value: unknown, field: string, fail: (detail: string) => Error = evolutionFail): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw fail(`${field} must be a non-empty string`)
  return value
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  fail: (detail: string) => Error = evolutionFail,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw fail(`${field} has unknown key "${key}"`)
  }
}

/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
export function assertSegment(value: unknown, field: string, fail: (detail: string) => Error = evolutionFail): string {
  const text = nonEmpty(value, field, fail)
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\') || isAbsolute(text)) {
    throw fail(`${field} must be a single safe path segment, got "${text}"`)
  }
  return text
}

/** One coded refusal, carrying its machine-readable code as the message's second word. */
export function codedRefusal(code: string, detail: string): Error {
  return new Error(`evolution: ${code}: ${detail}`)
}

/** JSON with object keys sorted recursively: the one serialization every new-protocol digest is taken over. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Lowercase SHA-256 hex over {@link canonicalJson} of a value — the v5 ledger's digest primitive. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

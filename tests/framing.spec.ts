/**
 * The append path and the envelope: what makes a recorded fact trustworthy.
 *
 * Covers the two required properties that belong to framing (append and fold), plus the ones
 * that make them worth anything: durability across reopen, tamper detection, chain linkage,
 * a single writer, and a closed envelope.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  assertEnvelope,
  canonicalJson,
  digestOf,
  digestOfBody,
  ENVELOPE_MEMBERS,
  foldSubject,
  foldSubjects,
  ProtocolLog,
  sealEnvelope,
  type Envelope,
  type EnvelopeBody,
  type Guarantee,
  type KindRule,
  type LogOptions,
  type ProtocolSpec,
  type RefusalCode,
} from '../src/index.ts'
import {
  AUDIT_V1,
  asyncRefusalOf,
  bumped,
  chainOf,
  closed,
  DEMO_V1,
  demoRegistry,
  newLogPath,
  noted,
  opened,
  refusalOf,
  type Gate,
  type Journal,
} from './fixtures.ts'

/** One valid envelope body, shared by the envelope and kind-rule specs. */
const body = (): EnvelopeBody => ({
  protocol: 'demo',
  version: 1,
  kind: 'opened',
  subject: 'gate-a',
  actor: 'test',
  at: '2026-10-09T00:00:00.000Z',
  seq: 0,
  prevDigest: null,
  payload: {},
})

let logPath: string

beforeEach(async () => {
  logPath = await newLogPath()
})

describe('the one append path', () => {
  it('appends facts in order and folds each protocol to its own subject state', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry, { now: () => '2026-10-09T00:00:00.000Z' })

    await log.emit(opened())
    await log.emit(bumped())
    await log.emit(bumped())
    await log.emit(noted('first'))

    const entries = log.entries()
    expect(entries.map(entry => entry.seq)).toEqual([0, 1, 2, 3])
    expect(entries.map(entry => entry.kind)).toEqual(['opened', 'bumped', 'bumped', 'noted'])
    expect(entries[0]?.prevDigest).toBeNull()
    for (const [index, entry] of entries.entries()) {
      if (index > 0) expect(entry.prevDigest).toBe(entries[index - 1]?.digest)
    }

    const gates = foldSubjects<Gate>(registry, entries, 'demo', 1)
    expect(gates.get('gate-a')).toEqual({ open: true, bumps: 2 })
    const journals = foldSubjects<Journal>(registry, entries, 'audit', 1)
    expect(journals.get('gate-a')).toEqual({ notes: ['first'] })
    expect(log.entriesOf('demo', 1)).toHaveLength(3)
  })

  it('truthfully reports no state for a subject the log never saw', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(opened())

    // Absent is absent: a missing subject is never answered with the initial state.
    expect(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-never-seen')).toBeUndefined()
    expect(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-a')).toEqual({ open: true, bumps: 0 })
  })

  it('is durable: a reopened log folds to the same state', async () => {
    const registry = demoRegistry()
    const first = await ProtocolLog.open(logPath, registry)
    await first.emit(opened())
    await first.emit(bumped())

    const reopened = await ProtocolLog.open(logPath, registry)
    expect(reopened.entries()).toHaveLength(2)
    expect(foldSubject<Gate>(registry, reopened.entries(), 'demo', 1, 'gate-a')).toEqual({ open: true, bumps: 1 })
  })

  it('holds exactly one writer per log', async () => {
    const registry = demoRegistry()
    const first = await ProtocolLog.open(logPath, registry)
    const second = await ProtocolLog.open(logPath, registry)

    await first.emit(opened())
    const refusal = await asyncRefusalOf(() => second.emit(bumped()))
    expect(refusal.code).toBe<RefusalCode>('concurrent-writer')
    expect(refusal.detail).toContain(logPath)
  })

  it('accepts an injected clock so a fold is reproducible', async () => {
    const options: LogOptions = { now: () => '2026-01-01T00:00:00.000Z' }
    const log = await ProtocolLog.open(logPath, demoRegistry(), options)
    const first = await log.emit(opened())
    const second = await log.emit(bumped())
    expect([first.at, second.at]).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  })

  it('keeps its append cursor equal to a fresh fold of its own entries', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(opened('gate-a'))
    await log.emit(bumped('gate-a'))
    await log.emit(opened('gate-b'))

    // The cursor is an optimization, never a second interpretation: it must equal the fold.
    expect(log.stateOf<Gate>('demo', 1, 'gate-a')).toEqual(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-a'))
    expect(log.stateOf<Gate>('demo', 1, 'gate-b')).toEqual(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-b'))
    expect(log.stateOf<Gate>('demo', 1, 'never-seen')).toBeUndefined()
  })

  it('refuses to open a log whose recorded sequence is illegal', async () => {
    // What a log written by an older or buggier build looks like: framing and chain are fine,
    // the sequence is not. Loading replay it, so the refusal lands at open, not at a later read.
    const entries = chainOf([
      { kind: 'closed', subject: 'gate-a' },
      { kind: 'bumped', subject: 'gate-a' },
    ])
    await writeFile(logPath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8')

    const refusal = await asyncRefusalOf(() => ProtocolLog.open(logPath, demoRegistry()))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
  })
})

describe('the one envelope', () => {
  it('is closed: an unknown member is a refusal, never ignored', () => {
    const sealed = sealEnvelope(body())
    expect(assertEnvelope(sealed).digest).toBe(sealed.digest)
    expect(ENVELOPE_MEMBERS).toHaveLength(10)

    const widened = refusalOf(() => assertEnvelope({ ...sealed, note: 'extra' }))
    expect(widened.code).toBe<RefusalCode>('malformed-envelope')
    expect(widened.detail).toContain('closed')

    const missing = { ...sealed } as Record<string, unknown>
    delete missing['actor']
    expect(refusalOf(() => assertEnvelope(missing)).code).toBe<RefusalCode>('malformed-envelope')
    expect(refusalOf(() => assertEnvelope({ ...sealed, digest: 'nope' })).code).toBe<RefusalCode>('malformed-envelope')
    expect(refusalOf(() => assertEnvelope({ ...sealed, version: 0 })).code).toBe<RefusalCode>('malformed-envelope')
    expect(refusalOf(() => assertEnvelope('not an object')).code).toBe<RefusalCode>('malformed-envelope')
  })

  it('digests deterministically, independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }))
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }))
    expect(digestOfBody({ ...body(), payload: { b: 1, a: 2 } })).toBe(sealEnvelope({ ...body(), payload: { b: 1, a: 2 } }).digest)
  })

  it('detects a tampered payload as a digest mismatch', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(opened())
    await log.emit(noted('honest'))

    const lines = (await readFile(logPath, 'utf8')).split('\n').filter(line => line.length > 0)
    await writeFile(logPath, `${lines.map(line => line.replace('"honest"', '"forged"')).join('\n')}\n`, 'utf8')

    const refusal = await asyncRefusalOf(() => ProtocolLog.open(logPath, registry))
    expect(refusal.code).toBe<RefusalCode>('digest-mismatch')
  })

  it('detects a broken chain', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(opened())

    // A well-formed fact that links to nothing, appended behind a fact that already exists.
    const orphan = sealEnvelope({ ...body(), kind: 'bumped', seq: 1, prevDigest: '0'.repeat(64) }) as Envelope
    await appendFile(logPath, `${JSON.stringify(orphan)}\n`, 'utf8')

    const refusal = await asyncRefusalOf(() => ProtocolLog.open(logPath, registry))
    expect(refusal.code).toBe<RefusalCode>('chain-broken')
    expect(refusal.detail).toContain('predecessor')
  })
})

describe('the kind rule', () => {
  it('exposes its guarantee, and a reducer is the only authority on legality', () => {
    const registry = demoRegistry()
    const rule: KindRule<Gate> = registry.ruleFor<Gate>('demo', 1, 'opened')
    expect(rule.guarantee).toBe<Guarantee>('G1')
    expect(rule.reduce({ open: false, bumps: 9 }, sealEnvelope(body()))).toEqual({ open: true, bumps: 0 })

    const spec: ProtocolSpec<Gate> = DEMO_V1
    expect(Object.keys(spec.kinds)).toHaveLength(3)
    expect(Object.keys(AUDIT_V1.kinds)).toEqual(['noted'])
  })
})

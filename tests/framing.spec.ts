/**
 * The append path, the fold engine and the envelope: what makes a recorded fact trustworthy.
 *
 * Covers append, fold, durability across reopen, tamper detection, chain linkage, a single
 * writer, the append cursor agreeing with a fresh fold, and the read projection's isolation.
 */


import { describe, expect, it } from 'vitest'

import {
  assertEnvelope,
  assertLosslessJson,
  canonicalJson,
  digestOf,
  digestOfBody,
  ENVELOPE_MEMBERS,
  foldSubject,
  foldSubjects,
  MemoryLog,
  sealEnvelope,
  type Envelope,
  type EnvelopeBody,
  type KindRule,
  type LogOptions,
  type ProtocolSpec,
  type RefusalCode,
} from '../src/index.ts'
import {
  AUDIT_V1,
  bumped,
  chainOf,
  closed,
  DEMO_SUBJECTS,
  DEMO_V1,
  demoRegistry,
  noted,
  openDemoLog,
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
  commandId: 'probe-command',
  emitter: 'writer',
  actor: 'writer-1',
  at: '2026-10-09T00:00:00.000Z',
  seq: 0,
  prevDigest: null,
  payload: {},
})

describe('the one append path', () => {
  it('appends facts in order and folds each protocol to its own subject state', async () => {
    const registry = demoRegistry()
    const log = new MemoryLog(registry, { subjects: DEMO_SUBJECTS, now: () => '2026-10-09T00:00:00.000Z' })

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

  it('stamps the author from the declared emitter role, never from the caller', async () => {
    const log = openDemoLog()
    const opening = await log.emit(opened())
    const note = await log.emit(noted('second protocol'))

    expect(opening.emitter).toBe('writer')
    expect(opening.actor).toBe('writer-1')
    expect(note.emitter).toBe('auditor')
    expect(note.actor).toBe('auditor-1')
  })

  it('serializes concurrent commits instead of handing two facts the same seq', async () => {
    const log = openDemoLog()

    // The reviewer's counterexample: two concurrent emits both read seq 0, and the log could not
    // be reopened. Neither half of an emit awaits, so run-to-completion is already the total order;
    // a caller that awaits between the halves owns the serialization itself.
    const results = await Promise.all([log.emit(opened()), log.emit(bumped()), log.emit(closed()), log.emit(opened('gate-b'))])
    expect(results.map(entry => entry.seq)).toEqual([0, 1, 2, 3])
    expect(new Set(results.map(entry => entry.seq)).size).toBe(4)

    const adopted = MemoryLog.adopt(log.entries(), demoRegistry(), { subjects: DEMO_SUBJECTS })
    expect(adopted.entries()).toHaveLength(4)
  })

  it('adopting the recorded facts replays the same state', async () => {
    const registry = demoRegistry()
    const first = new MemoryLog(registry, { subjects: DEMO_SUBJECTS })
    await first.emit(opened())
    await first.emit(bumped())

    // Durability, the crash barrier and the cross-process lease belong to DSH session persistence.
    // What this store owes is that the facts a medium hands back replay identically.
    const adopted = MemoryLog.adopt(first.entries(), registry, { subjects: DEMO_SUBJECTS })
    expect(adopted.entries()).toHaveLength(2)
    expect(adopted.stateAt<Gate>('demo', 1, 'gate-a', adopted.count)).toEqual({ open: true, bumps: 1 })
    expect(adopted.entries()).toEqual(first.entries())
  })

  it('decides without recording, so a medium that never confirmed leaves no trace', async () => {
    const log = openDemoLog()
    await log.emit(opened())

    const decision = log.decide(bumped())
    expect(decision.fresh).toBe(true)
    expect(decision.envelope.seq).toBe(1)
    // Sealed and legal, and the log has not moved: a caller that owns the durability barrier is the
    // only one who can make this fact real, and until it does, no reader can see it.
    expect(log.entries()).toHaveLength(1)
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', log.count)).toEqual({ open: true, bumps: 0 })

    log.record(decision)
    expect(log.entries()).toHaveLength(2)
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', log.count)).toEqual({ open: true, bumps: 1 })
  })

  it('records only a decision this log made, and only once', async () => {
    const first = openDemoLog()
    await first.emit(opened())
    const decision = first.decide(bumped())

    // Another log is another chain. A refused record must also leave the decision intact, or a
    // mistaken caller could consume the only handle to a fact it never recorded.
    const other = openDemoLog()
    expect(refusalOf(() => other.record(decision)).code).toBe<RefusalCode>('illegal-transition')
    expect(refusalOf(() => other.record({ envelope: decision.envelope, fresh: true })).code).toBe<RefusalCode>('illegal-transition')

    first.record(decision)
    expect(refusalOf(() => first.record(decision)).code).toBe<RefusalCode>('illegal-transition')

    // A decision taken before a fact that has since been recorded would leave a hole in the chain.
    const stale = first.decide(closed())
    await first.emit(opened('gate-b'))
    const refusal = refusalOf(() => first.record(stale))
    expect(refusal.code).toBe<RefusalCode>('chain-broken')
    expect(refusal.detail).toContain('hole')
  })

  it('answers a redelivered command with the fact it committed, and says so', async () => {
    const log = openDemoLog()
    const request = opened()
    const committed = log.emit(request)

    // This is what a lost reply has to be told apart from a new command, and it is the answer
    // itself rather than a sequence number a caller has to interpret.
    const again = log.decide(request)
    expect(again.fresh).toBe(false)
    expect(again.envelope.digest).toBe(committed.digest)
    expect(log.entries()).toHaveLength(1)

    // And it is not a fact waiting to be recorded: `fresh: false` is the whole answer, and the
    // second half of the emit must not append the fact a second time.
    expect(refusalOf(() => log.record(again)).code).toBe<RefusalCode>('illegal-transition')
    expect(log.entries()).toHaveLength(1)
  })

  it('reads a cut as of that cut, so a value read at a cut never moves', async () => {
    const registry = demoRegistry()
    const log = new MemoryLog(registry, { subjects: DEMO_SUBJECTS })
    await log.emit(opened())
    await log.emit(bumped())
    const cut = log.count
    await log.emit(closed())
    await log.emit(opened('gate-b'))

    // The facts below a cut never change, so the state at that cut is the state it always was.
    // This is what a reader's fixed cut means, and it is why a read costs nothing at the head.
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', cut)).toEqual({ open: true, bumps: 1 })
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', cut)).toEqual(
      foldSubject<Gate>(registry, log.entries().slice(0, cut), 'demo', 1, 'gate-a'),
    )
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', log.count)).toEqual({ open: false, bumps: 0 })
    expect(log.statesAt<Gate>('demo', 1, cut).get('gate-a')).toEqual({ open: true, bumps: 1 })
    expect(log.statesAt<Gate>('demo', 1, cut).has('gate-b')).toBe(false)
  })

  it('truthfully reports no state for a subject the log never saw', async () => {
    const registry = demoRegistry()
    const log = openDemoLog()
    await log.emit(opened())

    // Absent is absent: a missing subject is never answered with the initial state.
    expect(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-never-seen')).toBeUndefined()
    expect(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-a')).toEqual({ open: true, bumps: 0 })
  })

  it('keeps its append cursor equal to a fresh fold of its own entries', async () => {
    const registry = demoRegistry()
    const log = openDemoLog()
    await log.emit(opened('gate-a'))
    await log.emit(bumped('gate-a'))
    await log.emit(opened('gate-b'))

    // The cursor is an optimization, never a second interpretation: it must equal the fold.
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', log.count)).toEqual(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-a'))
    expect(log.stateAt<Gate>('demo', 1, 'gate-b', log.count)).toEqual(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-b'))
    expect(log.stateAt<Gate>('demo', 1, 'never-seen', log.count)).toBeUndefined()
  })

  it('accepts an injected clock so a fold is reproducible', async () => {
    const options: LogOptions = { subjects: DEMO_SUBJECTS, now: () => '2026-01-01T00:00:00.000Z' }
    const log = new MemoryLog(demoRegistry(), options)
    const first = await log.emit(opened())
    const second = await log.emit(bumped())
    expect([first.at, second.at]).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  })

  it('hands out its facts as a copy, so nothing outside can append an unsealed one', async () => {
    const log = openDemoLog()
    await log.emit(opened())

    // A handed-out live array would let a caller push a fact no reducer accepted and no digest
    // sealed — the store's sequence and chain are invariants, not a shared buffer.
    const handed = log.entries() as Envelope[]
    const last = log.entries().at(-1)
    if (last === undefined) throw new Error('expected a recorded fact')
    handed.push(sealEnvelope({ ...body(), kind: 'bumped', seq: 1, prevDigest: last.digest }) as Envelope)

    expect(log.entries()).toHaveLength(1)
    expect(log.stateAt<Gate>('demo', 1, 'gate-a', log.count)).toEqual({ open: true, bumps: 0 })
  })

  it('refuses to adopt a sequence no append path could produce', () => {
    const entries = chainOf([
      { kind: 'closed', subject: 'gate-a' },
      { kind: 'bumped', subject: 'gate-a' },
    ])
    const refusal = refusalOf(() => MemoryLog.adopt(entries, demoRegistry(), { subjects: DEMO_SUBJECTS }))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('demo/bumped #1')
  })
})

describe('the one envelope', () => {
  it('is closed: an unknown member is a refusal, never ignored', () => {
    const sealed = sealEnvelope(body())
    expect(assertEnvelope(sealed).digest).toBe(sealed.digest)
    expect(ENVELOPE_MEMBERS).toHaveLength(12)

    const widened = refusalOf(() => assertEnvelope({ ...sealed, note: 'extra' }))
    expect(widened.code).toBe<RefusalCode>('malformed-envelope')
    expect(widened.detail).toContain('closed')

    const missing = { ...sealed } as Record<string, unknown>
    delete missing['emitter']
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

  it('refuses a content identity JSON cannot round-trip, instead of colliding', () => {
    // The reviewer's counterexample: JSON turns NaN into null and drops undefined members, so
    // these pairs used to digest alike. Two different facts must not share a content identity.
    expect(refusalOf(() => digestOf({ v: Number.NaN })).code).toBe<RefusalCode>('not-lossless-json')
    expect(refusalOf(() => digestOf({ v: Number.POSITIVE_INFINITY })).code).toBe<RefusalCode>('not-lossless-json')
    expect(refusalOf(() => digestOf({ v: undefined })).code).toBe<RefusalCode>('not-lossless-json')
    expect(refusalOf(() => digestOf(undefined)).code).toBe<RefusalCode>('not-lossless-json')
    expect(refusalOf(() => digestOf({ v: () => 1 })).code).toBe<RefusalCode>('not-lossless-json')
    expect(refusalOf(() => digestOf({ v: new Date(0) })).code).toBe<RefusalCode>('not-lossless-json')

    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(refusalOf(() => digestOf(cyclic)).code).toBe<RefusalCode>('not-lossless-json')

    // `-0` and `0` are distinct numbers that JSON writes identically, so they would collide too.
    expect(refusalOf(() => digestOf({ v: -0 })).code).toBe<RefusalCode>('not-lossless-json')

    // The values that are losslessly JSON still digest, and still ignore key order.
    expect(() => assertLosslessJson({ a: [1, 'two', null, true] }, 'probe')).not.toThrow()
  })

  it('detects a tampered payload as a digest mismatch', async () => {
    const log = openDemoLog()
    await log.emit(opened())
    await log.emit(noted('honest'))

    // What a medium would hand back if somebody edited it: the same fact with a changed body.
    const original = log.entries()
    const last = original.at(-1)
    if (last === undefined) throw new Error('expected a recorded fact')
    const tampered = [...original.slice(0, -1), { ...last, payload: { text: 'forged' } }]

    const refusal = refusalOf(() => MemoryLog.adopt(tampered, demoRegistry(), { subjects: DEMO_SUBJECTS }))
    expect(refusal.code).toBe<RefusalCode>('digest-mismatch')
  })

  it('detects a broken chain', async () => {
    const log = openDemoLog()
    await log.emit(opened())

    // A well-formed fact that links to nothing, recorded behind a fact that already exists.
    const orphan = sealEnvelope({ ...body(), kind: 'bumped', seq: 1, prevDigest: '0'.repeat(64) }) as Envelope

    const refusal = refusalOf(() => MemoryLog.adopt([...log.entries(), orphan], demoRegistry(), { subjects: DEMO_SUBJECTS }))
    expect(refusal.code).toBe<RefusalCode>('chain-broken')
    expect(refusal.detail).toContain('predecessor')
  })
})

describe('the kind rule', () => {
  it('exposes its guarantees, and a reducer is the only authority on legality', () => {
    const registry = demoRegistry()
    const rule: KindRule<Gate> = registry.ruleFor<Gate>('demo', 1, 'opened')
    expect(rule.guarantees).toEqual({ appended: true })
    expect(rule.emitter({})).toBe('writer')
    expect(rule.parse({}, 'probe')).toEqual({})
    expect(rule.reduce({ open: false, bumps: 9 }, sealEnvelope(body()), {})).toEqual({ open: true, bumps: 0 })

    const spec: ProtocolSpec<Gate> = DEMO_V1
    expect(Object.keys(spec.kinds)).toHaveLength(3)
    expect(Object.keys(AUDIT_V1.kinds)).toEqual(['noted'])
  })
})

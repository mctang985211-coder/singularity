/**
 * The append path, the fold engine and the envelope: what makes a recorded fact trustworthy.
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
    // Position, kind and chain link in one ordered read: each entry links to the one before it, and
    // the first links to nothing.
    expect(entries.map(entry => [entry.seq, entry.kind])).toEqual([
      [0, 'opened'],
      [1, 'bumped'],
      [2, 'bumped'],
      [3, 'noted'],
    ])
    for (const [index, entry] of entries.entries()) {
      expect(entry.prevDigest).toBe(index === 0 ? null : entries[index - 1]?.digest)
    }

    // Two protocols in one log: each folds its own facts to its own subject state, and a read by
    // protocol returns exactly that protocol's facts.
    const gates = foldSubjects<Gate>(registry, entries, 'demo', 1)
    const journals = foldSubjects<Journal>(registry, entries, 'audit', 1)
    expect([gates.get('gate-a'), journals.get('gate-a'), log.entriesOf('demo', 1).length]).toEqual([
      { open: true, bumps: 2 },
      { notes: ['first'] },
      3,
    ])
  })

  it('stamps the author from the declared emitter role, never from the caller', async () => {
    const log = openDemoLog()
    const opening = await log.emit(opened())
    const note = await log.emit(noted('second protocol'))

    expect([opening.emitter, opening.actor]).toEqual(['writer', 'writer-1'])
    expect([note.emitter, note.actor]).toEqual(['auditor', 'auditor-1'])
  })

  it('serializes concurrent commits instead of handing two facts the same seq', async () => {
    const log = openDemoLog()

    // The reviewer's counterexample: two concurrent emits both read seq 0, and the log could not
    // be reopened. Neither half of an emit awaits, so run-to-completion is already the total order;
    // a caller that awaits between the halves owns the serialization itself.
    const results = await Promise.all([
      log.emit(opened()),
      log.emit(bumped()),
      log.emit(closed()),
      log.emit(opened('gate-b')),
    ])
    // Four sequence numbers, each distinct and in the order the emits ran: this one read says both.
    expect(results.map(entry => entry.seq)).toEqual([0, 1, 2, 3])

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
    // Both facts replayed into the state they made, and the entries handed back unchanged.
    expect([adopted.count, adopted.stateAt<Gate>('demo', 1, 'gate-a', adopted.count)]).toEqual([
      2,
      { open: true, bumps: 1 },
    ])
    expect(adopted.entries()).toEqual(first.entries())
  })

  it('decides without recording, so a medium that never confirmed leaves no trace', async () => {
    const log = openDemoLog()
    await log.emit(opened())

    const decision = log.decide(bumped())
    // Fresh, and sealed at the next sequence number.
    expect(decision).toMatchObject({ fresh: true, envelope: { seq: 1 } })
    // Sealed and legal, and the log has not moved: a caller that owns the durability barrier is the
    // only one who can make this fact real, and until it does, no reader can see it.
    expect([log.entries().length, log.stateAt<Gate>('demo', 1, 'gate-a', log.count)]).toEqual([
      1,
      { open: true, bumps: 0 },
    ])

    log.record(decision)
    expect([log.entries().length, log.stateAt<Gate>('demo', 1, 'gate-a', log.count)]).toEqual([
      2,
      { open: true, bumps: 1 },
    ])
  })

  it('records only a decision this log made, and only once', async () => {
    const first = openDemoLog()
    await first.emit(opened())
    const decision = first.decide(bumped())

    // Another log is another chain, and a decision object rebuilt by hand is not this log's either.
    // A refused record must also leave the decision intact, or a mistaken caller could consume the
    // only handle to a fact it never recorded.
    const other = openDemoLog()
    expect([
      refusalOf(() => other.record(decision)).code,
      refusalOf(() => other.record({ envelope: decision.envelope, fresh: true })).code,
    ]).toEqual<RefusalCode[]>(['illegal-transition', 'illegal-transition'])

    first.record(decision)
    expect(refusalOf(() => first.record(decision)).code).toBe<RefusalCode>('illegal-transition')

    // A decision taken before a fact that has since been recorded would leave a hole in the chain.
    const stale = first.decide(closed())
    await first.emit(opened('gate-b'))
    expect(refusalOf(() => first.record(stale))).toMatchObject({
      code: 'chain-broken',
      detail: expect.stringContaining('hole'),
    })
  })

  it('answers a redelivered command with the fact it committed, and says so', async () => {
    const log = openDemoLog()
    const request = opened()
    const committed = log.emit(request)

    // This is what a lost reply has to be told apart from a new command, and it is the answer
    // itself rather than a sequence number a caller has to interpret.
    const again = log.decide(request)
    expect(again).toMatchObject({ fresh: false, envelope: { digest: committed.digest } })

    // And it is not a fact waiting to be recorded: `fresh: false` is the whole answer, and the
    // second half of the emit must not append the fact a second time. The redelivered decision
    // above read the same log, so one read of the log at the end covers both halves.
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
    // And the whole-log read at the same cut: every subject below it, and no subject above it.
    const states = log.statesAt<Gate>('demo', 1, cut)
    expect([states.get('gate-a'), states.has('gate-b')]).toEqual([{ open: true, bumps: 1 }, false])
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

    // The cursor is an optimization, never a second interpretation: it must equal the fold, subject
    // by subject.
    expect([
      log.stateAt<Gate>('demo', 1, 'gate-a', log.count),
      log.stateAt<Gate>('demo', 1, 'gate-b', log.count),
    ]).toEqual([
      foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-a'),
      foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-b'),
    ])
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

    // The push reached the caller's copy and nothing else: one fact in the log, and a fold that
    // never saw a bump.
    expect([log.entries().length, log.stateAt<Gate>('demo', 1, 'gate-a', log.count)]).toEqual([
      1,
      { open: true, bumps: 0 },
    ])
  })

  it('refuses to adopt a sequence no append path could produce', () => {
    const entries = chainOf([
      { kind: 'closed', subject: 'gate-a' },
      { kind: 'bumped', subject: 'gate-a' },
    ])
    const refusal = refusalOf(() => MemoryLog.adopt(entries, demoRegistry(), { subjects: DEMO_SUBJECTS }))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('demo/bumped #1') })
  })
})

describe('the one envelope', () => {
  it('is closed: an unknown member is a refusal, never ignored', () => {
    const sealed = sealEnvelope(body())
    expect(assertEnvelope(sealed).digest).toBe(sealed.digest)
    expect(ENVELOPE_MEMBERS).toHaveLength(12)

    // An unknown member is refused by name, where it was seen: a closed frame, not a lenient one.
    const widened = refusalOf(() => assertEnvelope({ ...sealed, note: 'extra' }))
    expect(widened).toMatchObject({ code: 'malformed-envelope', detail: expect.stringContaining('closed') })

    // Missing, altered, the wrong version, not an object at all: four ways to be framed wrongly, all
    // refused the same way.
    const missing = { ...sealed } as Record<string, unknown>
    delete missing['emitter']
    const wrongly = [missing, { ...sealed, digest: 'nope' }, { ...sealed, version: 0 }, 'not an object']
    expect(wrongly.map(value => refusalOf(() => assertEnvelope(value)).code)).toEqual<RefusalCode[]>(
      Array<RefusalCode>(4).fill('malformed-envelope'),
    )
  })

  it('digests deterministically, independent of key order', () => {
    // Key order is not content: neither the canonical form nor the digest reads it.
    expect([canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), digestOf({ a: 1, b: 2 })]).toEqual([
      canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }),
      digestOf({ b: 2, a: 1 }),
    ])
    expect(digestOfBody({ ...body(), payload: { b: 1, a: 2 } })).toBe(
      sealEnvelope({ ...body(), payload: { b: 1, a: 2 } }).digest,
    )
  })

  it('refuses a content identity JSON cannot round-trip, instead of colliding', () => {
    // The reviewer's counterexample: JSON turns NaN into null and drops undefined members, so
    // these pairs used to digest alike. Two different facts must not share a content identity.
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const unroundtrippable = [
      { v: Number.NaN },
      { v: Number.POSITIVE_INFINITY },
      { v: undefined },
      undefined,
      { v: () => 1 },
      { v: new Date(0) },
      cyclic,
    ]
    expect(unroundtrippable.map(value => refusalOf(() => digestOf(value)).code)).toEqual<RefusalCode[]>(
      Array<RefusalCode>(7).fill('not-lossless-json'),
    )

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

    const refusal = refusalOf(() =>
      MemoryLog.adopt([...log.entries(), orphan], demoRegistry(), { subjects: DEMO_SUBJECTS }),
    )
    expect(refusal).toMatchObject({ code: 'chain-broken', detail: expect.stringContaining('predecessor') })
  })
})

describe('the kind rule', () => {
  it('exposes its guarantees, and a reducer is the only authority on legality', () => {
    const registry = demoRegistry()
    const rule: KindRule<Gate> = registry.ruleFor<Gate>('demo', 1, 'opened')
    // One kind rule: what it guarantees, who may emit it, how a payload is read, and what it makes
    // of the state it is given — the reducer is the only authority on legality.
    expect([
      rule.guarantees,
      rule.emitter({}),
      rule.parse({}, 'probe'),
      rule.reduce({ open: false, bumps: 9 }, sealEnvelope(body()), {}),
    ]).toEqual([{ appended: true }, 'writer', {}, { open: true, bumps: 0 }])

    // And each protocol declares its own closed set of kinds.
    const spec: ProtocolSpec<Gate> = DEMO_V1
    expect([Object.keys(spec.kinds).length, Object.keys(AUDIT_V1.kinds)]).toEqual([3, ['noted']])
  })
})

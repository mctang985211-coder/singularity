/**
 * The version gate, the guarantee vocabulary, the emitter discipline, and command identity:
 * everything the stack refuses, each refused by name.
 */

import { describe, expect, it } from 'vitest'

import {
  defineKind,
  foldSubject,
  foldSubjects,
  MemoryLog,
  ProtocolRegistry,
  REFUSAL_CODES,
  refuse,
  type EmitInput,
  type Guarantees,
  type ProtocolSpec,
  type RefusalCode,
} from '../src/index.ts'
import {
  asyncRefusalOf,
  AUDIT_V1,
  bumped,
  chainOf,
  closed,
  DEMO_SUBJECTS,
  DEMO_V1,
  demoRegistry,
  openDemoLog,
  opened,
  POINTER_V1,
  refusalOf,
  type Gate,
  type Journal,
} from './fixtures.ts'

describe('the one version gate', () => {
  it('refuses an unknown protocol, then an unknown version, then an unknown kind', async () => {
    const log = openDemoLog()
    expect((await asyncRefusalOf(() => log.emit({ ...opened(), protocol: 'nope' }))).code).toBe<RefusalCode>('unknown-protocol')
    expect((await asyncRefusalOf(() => log.emit({ ...opened(), version: 7 }))).code).toBe<RefusalCode>('version-mismatch')
    expect((await asyncRefusalOf(() => log.emit({ ...opened(), kind: 'slammed' }))).code).toBe<RefusalCode>('unknown-kind')
    // The gate runs before the append: nothing reached the disk.
    expect(log.entries()).toHaveLength(0)
  })

  it('refuses an inherited member name as a kind, not as a function', () => {
    const registry = demoRegistry()
    // The reviewer's counterexample: property lookup reached Object.prototype, so these were
    // returned as "rules" instead of being refused.
    for (const kind of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const refusal = refusalOf(() => registry.ruleFor('demo', 1, kind))
      expect(refusal).toMatchObject({ code: 'unknown-kind', detail: expect.stringContaining('declares no kind') })
    }
  })

  it('reports what it does declare, so a refusal names the alternative', () => {
    const registry = demoRegistry()
    expect(registry.versionsOf('demo')).toEqual([1])
    expect(registry.kindsOf('demo', 1)).toEqual(['bumped', 'closed', 'opened'])
    expect(refusalOf(() => registry.versionsOf('nope')).detail).toContain('demo')
  })

  it('applies on adopt too: facts naming a protocol this build does not know are refused', async () => {
    const written = openDemoLog()
    await written.emit(opened())
    // A deployment that no longer declares `demo` cannot explain its facts, so it refuses them
    // rather than skipping them — the reviewer's load-gate counterexample, on the adopt path.
    const narrowed = new ProtocolRegistry()
    narrowed.declare<Journal>('audit', 1, AUDIT_V1)
    const refusal = refusalOf(() => MemoryLog.adopt(written.entries(), narrowed, { subjects: DEMO_SUBJECTS }))
    expect(refusal.code).toBe<RefusalCode>('unknown-protocol')
  })
})

describe('the guarantee vocabulary', () => {
  it('composes: a fact may be appended, business-atomic and conditional at once', () => {
    const registry = new ProtocolRegistry()
    registry.declare('pointer', 1, POINTER_V1)
    expect(registry.ruleFor('pointer', 1, 'switched').guarantees).toEqual({ appended: true, conditional: true, atomicFact: true })
    expect(registry.conditionalOwner()).toBe('pointer')
  })

  it('refuses a guarantee combination that cannot hold', () => {
    const registry = new ProtocolRegistry()
    const derivedAndAppended: ProtocolSpec<unknown> = { initialState: {}, kinds: { x: defineKind<unknown, Record<string, never>>({ guarantees: { appended: true, derived: true }, emitter: 'writer', parse: () => ({}), reduce: state => state }) } }
    expect(refusalOf(() => registry.declare('demo', 1, derivedAndAppended)).code).toBe<RefusalCode>('unknown-guarantee')
    const conditionalOnly: ProtocolSpec<unknown> = { initialState: {}, kinds: { y: defineKind<unknown, Record<string, never>>({ guarantees: { appended: false, conditional: true }, emitter: 'writer', parse: () => ({}), reduce: state => state }) } }
    expect(refusalOf(() => registry.declare('demo', 1, conditionalOnly)).code).toBe<RefusalCode>('unknown-guarantee')
  })

  it('refuses a derived kind at the log boundary: derived state is folded, never written', async () => {
    const registry = new ProtocolRegistry()
    registry.declare<{ total: number }>('demo', 2, { initialState: { total: 0 }, kinds: {
      counted: defineKind<{ total: number }, { by: number }>({ guarantees: { appended: true }, emitter: 'writer', parse: raw => {
        const by = (raw as { by?: unknown }).by
        if (typeof by !== 'number' || !Number.isInteger(by)) refuse('malformed-payload', 'counted.by must be an integer')
        return { by }
      }, reduce: (state, _envelope, payload) => ({ total: state.total + payload.by }) }),
      summary: defineKind<{ total: number }, Record<string, never>>({ guarantees: { appended: false, derived: true }, emitter: 'writer', parse: () => ({}), reduce: state => state }),
    } })
    const log = new MemoryLog(registry, { subjects: DEMO_SUBJECTS })
    await log.emit({ commandId: 'c1', protocol: 'demo', version: 2, kind: 'counted', subject: 's', payload: { by: 3 } })
    const refusal = await asyncRefusalOf(() => log.emit({ commandId: 'c2', protocol: 'demo', version: 2, kind: 'summary', subject: 's', payload: {} }))
    expect(refusal.code).toBe<RefusalCode>('derived-not-persistable')
    expect(foldSubject<{ total: number }>(registry, log.entries(), 'demo', 2, 's')).toEqual({ total: 3 })
  })

  it('allows exactly one conditional-update owner, and a refused claim leaves none behind', () => {
    const registry = new ProtocolRegistry()
    registry.declare('pointer', 1, POINTER_V1)
    const rival: ProtocolSpec<unknown> = { initialState: {}, kinds: { moved: defineKind<unknown, Record<string, never>>({ guarantees: { appended: true, conditional: true }, emitter: 'writer', parse: () => ({}), reduce: state => state }) } }
    expect(refusalOf(() => registry.declare('rival', 1, rival)).code).toBe<RefusalCode>('second-conditional-owner')
    expect(registry.conditionalOwner()).toBe('pointer')
  })
})

describe('declaration is all-or-nothing', () => {
  /** The reviewer's counterexample: the owner was claimed before the rest was validated. */
  it('leaves no conditional owner behind when a later kind is invalid', () => {
    const registry = new ProtocolRegistry()
    const spec: ProtocolSpec<unknown> = { initialState: {}, kinds: {
      claims: defineKind<unknown, Record<string, never>>({ guarantees: { appended: true, conditional: true }, emitter: 'writer', parse: () => ({}), reduce: state => state }),
      broken: defineKind<unknown, Record<string, never>>({ guarantees: { appended: true, bogus: true } as unknown as Guarantees, emitter: 'writer', parse: () => ({}), reduce: state => state }),
    } }
    expect(refusalOf(() => registry.declare('broken-protocol', 1, spec)).code).toBe<RefusalCode>('unknown-guarantee')
    expect([registry.conditionalOwner(), refusalOf(() => registry.versionsOf('broken-protocol')).code]).toEqual([undefined, 'unknown-protocol'])
  })

  it('refuses a declaration it cannot honour, all before publishing', () => {
    const registry = new ProtocolRegistry()
    expect([refusalOf(() => registry.declare('demo', 0, DEMO_V1)).code, refusalOf(() => registry.declare('', 1, DEMO_V1)).code, refusalOf(() => registry.declare('demo', 1, { initialState: {}, kinds: {} })).code]).toEqual(['malformed-declaration', 'malformed-declaration', 'malformed-declaration'])
    registry.declare<Gate>('demo', 1, { initialState: { open: false, bumps: 0 }, kinds: { opened: { guarantees: { appended: true }, emitter: () => '', parse: () => ({}), reduce: () => ({ open: true, bumps: 0 }) } } })
    // A duplicate is refused, and the original declaration still answers.
    expect([refusalOf(() => registry.declare('demo', 1, DEMO_V1)).code, registry.kindsOf('demo', 1)]).toEqual(['duplicate-declaration', ['opened']])
  })
})

describe('the emitter discipline', () => {
  it('refuses a fact whose role this deployment holds no identity for', async () => {
    const registry = demoRegistry()
    // A deployment that holds the auditor but not the writer.
    const log = new MemoryLog(registry, { subjects: { auditor: 'auditor-1' } })
    const refusal = await asyncRefusalOf(() => log.emit(opened()))
    expect(refusal).toMatchObject({ code: 'unknown-emitter-role', detail: expect.stringContaining('writer') })
    expect(log.entries()).toHaveLength(0)
  })

  it('offers no parameter for an author, so a caller cannot claim a role', async () => {
    const log = openDemoLog()
    const input = { ...opened(), actor: 'auditor-1', emitter: 'auditor' } as unknown as EmitInput
    const envelope = await log.emit(input)
    // Whatever the caller wrote is ignored: the kind's declared role decides.
    expect([envelope.emitter, envelope.actor]).toEqual(['writer', 'writer-1'])
  })
})

describe('command identity', () => {
  it('returns the recorded fact when the same command is delivered twice', async () => {
    const log = openDemoLog()
    const command: EmitInput = { commandId: 'same-command', protocol: 'demo', version: 1, kind: 'opened', subject: 'gate-a', payload: {} }
    const first = await log.emit(command)
    const again = await log.emit(command)
    expect([again.digest, again.seq]).toEqual([first.digest, first.seq])
    // A redelivery is not a second fact.
    expect(log.entries()).toHaveLength(1)
  })

  it('refuses the same command id carrying a different request', async () => {
    const log = openDemoLog()
    await log.emit({ commandId: 'c-fixed', protocol: 'demo', version: 1, kind: 'opened', subject: 'gate-a', payload: {} })
    const refusal = await asyncRefusalOf(() => log.emit({ commandId: 'c-fixed', protocol: 'demo', version: 1, kind: 'opened', subject: 'gate-b', payload: {} }))
    expect(refusal).toMatchObject({ code: 'command-conflict', detail: expect.stringContaining('c-fixed') })
    expect(log.entries()).toHaveLength(1)
  })

  it('recognises a lost reply from the facts alone, after a successor adopts them', async () => {
    // The reviewer's gap: a command committed, its reply never arrived, and the process died. The
    // successor has only the recorded facts, so command identity must be recoverable from them —
    // otherwise "already committed" is indistinguishable from "never seen", and the domain reducer
    // refuses the redelivery as an illegal transition instead of returning the original result.
    const log = openDemoLog()
    const command: EmitInput = { commandId: 'lost-reply', protocol: 'demo', version: 1, kind: 'opened', subject: 'gate-a', payload: {} }
    const committed = await log.emit(command)
    const successor = MemoryLog.adopt(log.entries(), demoRegistry(), { subjects: DEMO_SUBJECTS })
    const recovered = await successor.emit(command)
    expect([recovered.digest, recovered.seq]).toEqual([committed.digest, committed.seq])
    // And the same id carrying a different request is still a conflict, not a second fact.
    const conflict = await asyncRefusalOf(() => successor.emit({ ...command, subject: 'gate-b' }))
    expect(conflict.code).toBe<RefusalCode>('command-conflict')
  })
})

describe('illegal transitions', () => {
  it('refuses a bump on a closed gate at fold time, and the fold scope decides who is affected', () => {
    const registry = demoRegistry()
    // gate-b is closed and then bumped. No append path would write this, which is the point.
    const entries = chainOf([{ kind: 'opened', subject: 'gate-a' }, { kind: 'bumped', subject: 'gate-a' }, { kind: 'bumped', subject: 'gate-a' }, { kind: 'opened', subject: 'gate-b' }, { kind: 'closed', subject: 'gate-b' }, { kind: 'bumped', subject: 'gate-b' }])
    // foldSubject is the isolation boundary: gate-a still reads, though gate-b's sequence is broken.
    expect(foldSubject<Gate>(registry, entries, 'demo', 1, 'gate-a')).toEqual({ open: true, bumps: 2 })
    // foldSubjects is the whole-store read and fails closed on that same sequence.
    const refusal = refusalOf(() => foldSubjects<Gate>(registry, entries, 'demo', 1))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('demo/bumped #5') })
  })

  it('refuses an illegal fact at append time, so the log never records a sequence it would reject', async () => {
    const log = openDemoLog()
    await log.emit(opened('gate-b'))
    await log.emit(closed('gate-b'))
    const refusal = await asyncRefusalOf(() => log.emit(bumped('gate-b')))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(log.entries()).toHaveLength(2)
  })

  it('lets a tenant declare its own compare-and-swap and refuses a stale expectation', async () => {
    const registry = new ProtocolRegistry()
    registry.declare('pointer', 1, POINTER_V1)
    const log = new MemoryLog(registry, { subjects: DEMO_SUBJECTS })
    const emit = (commandId: string, expected: string, to: string): EmitInput => ({ commandId, protocol: 'pointer', version: 1, kind: 'switched', subject: 'env-1', payload: { expected, to } })
    await log.emit(emit('p1', 'r0001', 'r0002'))
    const stale = await asyncRefusalOf(() => log.emit(emit('p2', 'r0001', 'r0003')))
    expect(stale).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('active revision is "r0002"') })
    expect(log.stateAt('pointer', 1, 'env-1', log.count)).toEqual({ revision: 'r0002', generation: 1 })
  })
})

describe('the one refusal contract', () => {
  it('carries a stable code and a readable detail on every refusal', () => {
    const registry = demoRegistry()
    const refusal = refusalOf(() => registry.ruleFor('demo', 1, 'slammed'))
    expect(refusal).toMatchObject({ code: 'unknown-kind', detail: expect.stringContaining('bumped') })
    expect(REFUSAL_CODES).toContain(refusal.code)
  })
})

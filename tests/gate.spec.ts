/**
 * The version gate, the guarantee ladder, and illegal transitions: what the stack refuses.
 *
 * Covers the two remaining required properties (an unknown version, and an illegal transition),
 * plus the declarations that make a refusal trustworthy — and the two fold scopes, which are a
 * deliberate decision rather than an accident.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  foldSubject,
  foldSubjects,
  GUARANTEES,
  ProtocolLog,
  ProtocolRegistry,
  REFUSAL_CODES,
  refuse,
  type Guarantee,
  type ProtocolSpec,
  type RefusalCode,
} from '../src/index.ts'
import {
  AUDIT_V1,
  asyncRefusalOf,
  bumped,
  closed,
  DEMO_V1,
  demoRegistry,
  newLogPath,
  opened,
  refusalOf,
  type Gate,
  type Journal,
} from './fixtures.ts'

let logPath: string

beforeEach(async () => {
  logPath = await newLogPath()
})

describe('the one version gate', () => {
  it('refuses an unknown protocol, then an unknown version, then an unknown kind', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry)

    expect((await asyncRefusalOf(() => log.emit({ ...opened(), protocol: 'nope' }))).code).toBe<RefusalCode>('unknown-protocol')
    expect((await asyncRefusalOf(() => log.emit({ ...opened(), version: 7 }))).code).toBe<RefusalCode>('version-mismatch')
    expect((await asyncRefusalOf(() => log.emit({ ...opened(), kind: 'slammed' }))).code).toBe<RefusalCode>('unknown-kind')

    // The gate runs before the append: nothing reached the disk.
    expect(log.entries()).toHaveLength(0)
    expect(await (await import('node:fs/promises')).readFile(logPath, 'utf8').catch(() => '')).toBe('')
  })

  it('reports what it does declare, so a refusal names the alternative', () => {
    const registry = demoRegistry()
    expect(registry.versionsOf('demo')).toEqual([1])
    expect(registry.kindsOf('demo', 1)).toEqual(['bumped', 'closed', 'opened'])
    expect(refusalOf(() => registry.versionsOf('nope')).detail).toContain('demo')
  })

  it('applies on load too: a log carrying a protocol this build does not know is refused', async () => {
    const written = await ProtocolLog.open(logPath, demoRegistry())
    await written.emit(opened())

    const narrowed = new ProtocolRegistry()
    narrowed.declare<Journal>('audit', 1, AUDIT_V1)
    expect((await asyncRefusalOf(() => ProtocolLog.open(logPath, narrowed))).code).toBe<RefusalCode>('unknown-protocol')
  })
})

describe('the one guarantee ladder', () => {
  it('refuses a derived kind at the log boundary', async () => {
    const registry = new ProtocolRegistry()
    registry.declare<{ total: number }>('demo', 2, {
      initialState: { total: 0 },
      kinds: {
        counted: {
          guarantee: 'G1',
          reduce: (state, envelope) => ({ total: state.total + Number((envelope.payload as { by?: unknown }).by ?? 0) }),
        },
        summary: { guarantee: 'G4', reduce: state => state },
      },
    })
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit({ protocol: 'demo', version: 2, kind: 'counted', subject: 's', actor: 'test', payload: { by: 3 } })

    const refusal = await asyncRefusalOf(() =>
      log.emit({ protocol: 'demo', version: 2, kind: 'summary', subject: 's', actor: 'test', payload: {} }),
    )
    expect(refusal.code).toBe<RefusalCode>('g4-not-persistable')
    expect(foldSubject<{ total: number }>(registry, log.entries(), 'demo', 2, 's')).toEqual({ total: 3 })
  })

  it('allows exactly one protocol to own compare-and-swap', () => {
    const registry = new ProtocolRegistry()
    const switched: ProtocolSpec<{ revision: string }> = {
      initialState: { revision: 'r0001' },
      kinds: {
        switched: {
          guarantee: 'G3',
          reduce: (_state, envelope) => ({ revision: String((envelope.payload as { to: string }).to) }),
        },
      },
    }
    registry.declare('pointer', 1, switched)
    expect(registry.g3Owner()).toBe('pointer')

    const rival: ProtocolSpec<unknown> = { initialState: {}, kinds: { moved: { guarantee: 'G3', reduce: state => state } } }
    expect(refusalOf(() => registry.declare('rival', 1, rival)).code).toBe<RefusalCode>('second-g3-instance')
    expect(registry.g3Owner()).toBe('pointer')
  })

  it('refuses a declaration it cannot honour', () => {
    const registry = new ProtocolRegistry()
    const bad: ProtocolSpec<unknown> = {
      initialState: {},
      kinds: { x: { guarantee: 'G9' as unknown as Guarantee, reduce: state => state } },
    }
    expect(refusalOf(() => registry.declare('demo', 1, bad)).code).toBe<RefusalCode>('unknown-guarantee')
    expect(refusalOf(() => registry.declare('demo', 0, DEMO_V1)).code).toBe<RefusalCode>('malformed-declaration')
    expect(refusalOf(() => registry.declare('', 1, DEMO_V1)).code).toBe<RefusalCode>('malformed-declaration')
    expect(refusalOf(() => registry.declare('demo', 1, { initialState: {}, kinds: {} })).code).toBe<RefusalCode>('malformed-declaration')

    registry.declare<Gate>('demo', 1, DEMO_V1)
    expect(refusalOf(() => registry.declare('demo', 1, DEMO_V1)).code).toBe<RefusalCode>('duplicate-declaration')
    expect(GUARANTEES).toEqual(['G1', 'G2', 'G3', 'G4'])
  })
})

describe('illegal transitions', () => {
  it('refuses a bump on a closed gate, and the fold scope decides who is affected', async () => {
    const registry = demoRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(opened('gate-a'))
    await log.emit(bumped('gate-a'))
    await log.emit(bumped('gate-a'))
    await log.emit(opened('gate-b'))
    await log.emit(closed('gate-b'))
    await log.emit(bumped('gate-b'))

    // foldSubject is the isolation boundary: gate-a still reads, though gate-b's sequence is broken.
    expect(foldSubject<Gate>(registry, log.entries(), 'demo', 1, 'gate-a')).toEqual({ open: true, bumps: 2 })

    // foldSubjects is the whole-store read and fails closed on that same sequence.
    const refusal = refusalOf(() => foldSubjects<Gate>(registry, log.entries(), 'demo', 1))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('demo/bumped #5')
  })
})

describe('the one refusal contract', () => {
  it('carries a stable code and a readable detail on every refusal', () => {
    const registry = demoRegistry()
    const refusal = refusalOf(() => registry.ruleFor('demo', 1, 'slammed'))
    expect(refusal.code).toBe<RefusalCode>('unknown-kind')
    expect(refusal.detail).toContain('bumped')
    expect(REFUSAL_CODES).toContain(refusal.code)
    expect(refusalOf(() => refuse('unknown-protocol', 'x')).code).toBe<RefusalCode>('unknown-protocol')
  })
})

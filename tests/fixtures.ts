/**
 * Two fake protocols and the helpers the protocol specs share.
 *
 * No business payload enters these files: `demo` is a one-way gate, `audit` is a second protocol
 * proved to share the same log, and `pointer` is a third whose single kind carries the one
 * conditional-update discipline. Their only job is to make the frame falsifiable.
 */

import {
  assertClosedKeys,
  defineKind,
  MemoryLog,
  ProtocolRefusal,
  ProtocolRegistry,
  refuse,
  sealEnvelope,
  type EmitInput,
  type Envelope,
  type ProtocolSpec,
  type Refusal,
} from '../src/index.ts'

/** The subject state of `demo`: a one-way gate that counts bumps while open. */
export interface Gate {
  readonly open: boolean
  readonly bumps: number
}

/** The subject state of `audit`: a second protocol in the same log. */
export interface Journal {
  readonly notes: readonly string[]
}

/** The trusted identities this deployment holds. A kind whose role is absent here cannot emit. */
export const DEMO_SUBJECTS: Readonly<Record<string, string>> = {
  writer: 'writer-1',
  auditor: 'auditor-1',
  pointer: 'pointer-service',
}

/** Every demo payload is empty and closed, so a stray member is a refusal. */
function emptyPayload(raw: unknown, where: string): Record<string, never> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    refuse('malformed-payload', `${where} must be an object`)
  assertClosedKeys(raw as Record<string, unknown>, [], where)
  return {}
}

const APPENDED = { appended: true } as const

export const DEMO_V1: ProtocolSpec<Gate> = {
  initialState: { open: false, bumps: 0 },
  kinds: {
    opened: defineKind<Gate, Record<string, never>>({
      guarantees: APPENDED,
      emitter: 'writer',
      parse: (raw, where) => emptyPayload(raw, where),
      reduce: () => ({ open: true, bumps: 0 }),
    }),
    bumped: defineKind<Gate, Record<string, never>>({
      guarantees: APPENDED,
      emitter: 'writer',
      parse: (raw, where) => emptyPayload(raw, where),
      reduce: (state, envelope) => {
        if (!state.open) refuse('illegal-transition', `demo/bumped #${envelope.seq} arrived while the subject is closed`)
        return { open: true, bumps: state.bumps + 1 }
      },
    }),
    closed: defineKind<Gate, Record<string, never>>({
      guarantees: APPENDED,
      emitter: 'writer',
      parse: (raw, where) => emptyPayload(raw, where),
      reduce: () => ({ open: false, bumps: 0 }),
    }),
  },
}

export const AUDIT_V1: ProtocolSpec<Journal> = {
  initialState: { notes: [] },
  kinds: {
    noted: defineKind<Journal, { text: string }>({
      guarantees: APPENDED,
      emitter: 'auditor',
      parse: (raw, where) => {
        const source = raw as Record<string, unknown>
        assertClosedKeys(source, ['text'], where)
        const text = source['text']
        if (typeof text !== 'string' || text.length === 0) refuse('malformed-payload', `${where}.text must be a non-empty string`)
        return { text }
      },
      reduce: (state, _envelope, payload) => ({ notes: [...state.notes, payload.text] }),
    }),
  },
}

/** Both fake protocols, as a deployment would declare them once at load. */
export function demoRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  registry.declare<Gate>('demo', 1, DEMO_V1)
  registry.declare<Journal>('audit', 1, AUDIT_V1)
  return registry
}

/** The one conditional-update protocol, for the guarantees spec. */
export const POINTER_V1: ProtocolSpec<{ revision: string; generation: number }> = {
  initialState: { revision: 'r0001', generation: 0 },
  kinds: {
    switched: defineKind<{ revision: string; generation: number }, { expected: string; to: string }>({
      guarantees: { appended: true, conditional: true, atomicFact: true },
      emitter: 'pointer',
      parse: (raw, where) => {
        const source = raw as Record<string, unknown>
        assertClosedKeys(source, ['expected', 'to'], where)
        const expected = source['expected']
        const to = source['to']
        if (typeof expected !== 'string' || expected.length === 0) refuse('malformed-payload', `${where}.expected must be a non-empty string`)
        if (typeof to !== 'string' || to.length === 0) refuse('malformed-payload', `${where}.to must be a non-empty string`)
        return { expected, to }
      },
      reduce: (state, envelope, payload) => {
        // The compare-and-swap the tenant declares: a stale expectation is refused here.
        if (state.revision !== payload.expected)
          refuse(
            'illegal-transition',
            `pointer/switched #${envelope.seq} expects "${payload.expected}" but the active revision is "${state.revision}"`,
          )
        return { revision: payload.to, generation: state.generation + 1 }
      },
    }),
  },
}

export function openDemoLog(registry: ProtocolRegistry = demoRegistry()): MemoryLog {
  return new MemoryLog(registry, { subjects: DEMO_SUBJECTS })
}

/**
 * A correctly framed, correctly chained sequence of `demo` facts built in memory.
 *
 * The append path refuses an illegal sequence before writing it, so the only way to test what a
 * *fold* does with one is to hand it a sequence no append path produced — which is also exactly
 * what a log written by an older or buggier build looks like.
 */
export function chainOf(facts: readonly { kind: string; subject: string }[]): Envelope[] {
  const entries: Envelope[] = []
  for (const fact of facts) {
    entries.push(
      sealEnvelope({
        protocol: 'demo',
        version: 1,
        kind: fact.kind,
        subject: fact.subject,
        commandId: `chain-${entries.length}`,
        emitter: 'writer',
        actor: 'writer-1',
        at: `2026-10-09T00:00:0${entries.length}.000Z`,
        seq: entries.length,
        prevDigest: entries.at(-1)?.digest ?? null,
        payload: {},
      }),
    )
  }
  return entries
}

/** Run a synchronous step and return the refusal it raised. */
export function refusalOf(step: () => unknown): Refusal {
  try {
    step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected the step to refuse')
}

/** Run an asynchronous step and return the refusal it raised. */
export async function asyncRefusalOf(step: () => unknown): Promise<Refusal> {
  try {
    await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected the step to refuse')
}

let commandCounter = 0

/** One fact to record, with a fresh command id so a repeat is never accidental. */
export function fact(kind: string, subject = 'gate-a', payload: unknown = {}): EmitInput {
  commandCounter += 1
  return { commandId: `cmd-${commandCounter}`, protocol: 'demo', version: 1, kind, subject, payload }
}

export const opened = (subject = 'gate-a'): EmitInput => fact('opened', subject)
export const bumped = (subject = 'gate-a'): EmitInput => fact('bumped', subject)
export const closed = (subject = 'gate-a'): EmitInput => fact('closed', subject)
export const noted = (text: string): EmitInput => ({
  commandId: `cmd-${(commandCounter += 1)}`,
  protocol: 'audit',
  version: 1,
  kind: 'noted',
  subject: 'gate-a',
  payload: { text },
})

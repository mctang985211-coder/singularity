/**
 * Two fake protocols and the helpers the protocol specs share.
 *
 * No business payload enters these files: `demo` is a one-way gate, `audit` is a second
 * protocol proved to share the same log. Their only job is to make the frame falsifiable.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
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

export const DEMO_V1: ProtocolSpec<Gate> = {
  initialState: { open: false, bumps: 0 },
  kinds: {
    opened: { guarantee: 'G1', reduce: () => ({ open: true, bumps: 0 }) },
    bumped: {
      guarantee: 'G1',
      reduce: (state, envelope) => {
        if (!state.open) refuse('illegal-transition', `demo/bumped #${envelope.seq} arrived while the subject is closed`)
        return { open: true, bumps: state.bumps + 1 }
      },
    },
    closed: { guarantee: 'G1', reduce: () => ({ open: false, bumps: 0 }) },
  },
}

export const AUDIT_V1: ProtocolSpec<Journal> = {
  initialState: { notes: [] },
  kinds: {
    noted: {
      guarantee: 'G1',
      reduce: (state, envelope) => ({
        notes: [...state.notes, String((envelope.payload as { text?: unknown }).text ?? '')],
      }),
    },
  },
}

/** Both fake protocols, as a deployment would declare them once at load. */
export function demoRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  registry.declare<Gate>('demo', 1, DEMO_V1)
  registry.declare<Journal>('audit', 1, AUDIT_V1)
  return registry
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
export async function asyncRefusalOf(step: () => Promise<unknown>): Promise<Refusal> {
  try {
    await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected the step to refuse')
}

/** A fresh path in a fresh temporary directory, so no spec shares state with another. */
export async function newLogPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-core-'))
  return join(directory, 'singularity.log')
}

/**
 * A correctly framed, correctly chained sequence of `demo` facts built in memory.
 *
 * The append path refuses an illegal sequence before writing it, so the only way to test what
 * a *fold* does with one is to hand it a sequence no append path produced — which is also
 * exactly what a log written by an older or buggier build looks like.
 */
export function chainOf(facts: readonly { kind: string; subject: string; payload?: unknown }[]): Envelope[] {
  const entries: Envelope[] = []
  for (const fact of facts) {
    entries.push(
      sealEnvelope({
        protocol: 'demo',
        version: 1,
        kind: fact.kind,
        subject: fact.subject,
        actor: 'test',
        at: `2026-10-09T00:00:0${entries.length}.000Z`,
        seq: entries.length,
        prevDigest: entries.at(-1)?.digest ?? null,
        payload: fact.payload ?? {},
      }),
    )
  }
  return entries
}

export const opened = (subject = 'gate-a'): EmitInput => ({ protocol: 'demo', version: 1, kind: 'opened', subject, actor: 'test', payload: {} })
export const bumped = (subject = 'gate-a'): EmitInput => ({ protocol: 'demo', version: 1, kind: 'bumped', subject, actor: 'test', payload: {} })
export const closed = (subject = 'gate-a'): EmitInput => ({ protocol: 'demo', version: 1, kind: 'closed', subject, actor: 'test', payload: {} })
export const noted = (text: string): EmitInput => ({ protocol: 'audit', version: 1, kind: 'noted', subject: 'gate-a', actor: 'test', payload: { text } })

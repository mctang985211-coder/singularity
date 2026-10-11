/** Driver specs use a persistence and execution port double with real domain commands and projection. */

import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadResult,
  type SessionPersistence,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ControlEventData } from '../../src/control/session-store.ts'
import { digestOf, type Envelope } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { Config } from '../src/index.ts'
import { openDriver, type AgentTaskSurface } from '../src/driver.ts'
import { loadDomain } from '../src/domain.ts'
import type { Admission, Execution } from '../src/execution.ts'
import { spawnProcess } from '../src/process.ts'

/**
 * The medium: every event in memory, with one hook that makes an append die like a killed process. It
 * is a plain object rather than a `Service`, because a provided service is proxied and a proxy cannot
 * carry private fields — and the store only ever asks a medium for `open` and `create`.
 */
export class FakePersistence {
  readonly events: SessionEvent[] = []
  #header: SessionHeader | undefined
  #failOn: string | undefined

  /** Refuse the next append carrying this fact kind: the process dying between two committed facts. */
  failAppendOf(kind: string): void {
    this.#failOn = kind
  }

  /** The fact kind one append would carry, read the way the store writes it. */
  kindOf(events: readonly SessionEvent[]): string | undefined {
    const data = events[0]?.data as ControlEventData | undefined
    return data?.payload.kind
  }

  /** True once for the append a simulated crash kills, and false for every other one. */
  failsNow(kind: string | undefined): boolean {
    if (this.#failOn === undefined || this.#failOn !== kind) return false
    this.#failOn = undefined
    return true
  }

  async create(header: SessionHeader): Promise<SessionHandle> {
    if (this.#header !== undefined) throw new Error(`session ${this.#header.id} already exists`)
    this.#header = header
    return new FakeHandle(this, header, 'write')
  }

  async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const header = this.#header
    if (header === undefined || header.id !== id) throw new SessionPersistenceNotFoundError(id)
    return new FakeHandle(this, header, access)
  }

  async flush(): Promise<void> {}

  async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const header = this.#header
    if (header === undefined || header.id !== id) return undefined
    return { header, revision: SessionPersistenceRevision(`fake:${header.id}:${this.events.length}`), eventCount: this.events.length }
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    const header = this.#header
    return header === undefined ? [] : [{ header, revision: SessionPersistenceRevision(`fake:${header.id}:${this.events.length}`), eventCount: this.events.length }]
  }
}

class FakeHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)
  readonly header: SessionHeader
  readonly access: SessionAccess
  readonly #medium: FakePersistence

  constructor(medium: FakePersistence, header: SessionHeader, access: SessionAccess) {
    this.#medium = medium
    this.header = header
    this.access = access
  }

  get id(): SessionId {
    return this.header.id
  }

  async read(offset = 0, length?: number): Promise<SessionHandleReadResult> {
    const { events } = this.#medium
    return { eventState: 'detached', events: structuredClone(events.slice(offset, length === undefined ? events.length : offset + length)) }
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    const kind = this.#medium.kindOf(events)
    // The dead process never wrote the fact: nothing is carried over, and the next mount adopts only
    // what was really committed.
    if (this.#medium.failsNow(kind)) throw new Error(`the process died before ${kind} was written`)
    assertContiguous(this.id, events, this.#medium.events.length)
    this.#medium.events.push(...structuredClone(events))
  }

  async flush(): Promise<void> {
    await this.#medium.flush()
  }

  async close(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

/** Every committed fact, as the log carries it. */
export function factsOf(medium: FakePersistence): readonly Envelope[] {
  return medium.events.map(event => (event.data as ControlEventData).payload)
}

/** The kinds of every committed fact, in order. */
export function kindsOf(medium: FakePersistence): readonly string[] {
  return factsOf(medium).map(fact => fact.kind)
}

/** An agent-shaped caller: an id, a session with its own id, and the request header in force. */
export function agentFor(agentId: string, sessionId: string, model = 'model-under-test'): Agent {
  return { id: agentId, session: { id: sessionId, requestHeader: () => ({ config: { provider: 'test', model } }) } } as unknown as Agent
}

/** One tool call: the live agent that made it, and DSH's own call id. */
export function execFor(agent: Agent, callId: string): ToolRunContext {
  return { callId, agent, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** This fixed execution double does not claim real DSH transcript provenance. */
export const fakeExecution = (_admission: Admission): Execution => ({
  assertCaller: exec => {
    if (exec.agent === undefined) refuse('unknown-emitter-role', 'the execution double received an agentless call')
    return exec.agent
  },
  drain: async () => undefined,
  sealTranscript: async exec => {
    if (exec.agent === undefined) refuse('unknown-emitter-role', 'the execution double received an agentless call')
    const sessionId = String(exec.agent.session.id)
    return { sessionId, eventCount: 0, digest: digestOf({ testDouble: true, sessionId, eventCount: 0, events: [] }) }
  },
  close: async () => undefined,
})

export const attachmentsAt = (root: string): LocalAttachmentStore =>
  new LocalAttachmentStore(new Context(), { dshHome: join(root, 'dsh-home') })

/** Compose the real driver with explicit test ports; host apply is covered separately. */
export async function mount(config: Config, medium = new FakePersistence()): Promise<{ ctx: Context; medium: FakePersistence }> {
  const ctx = new Context()
  const driver = await openDriver({
    ...config,
    domain: await loadDomain(config.domainDir, spawnProcess),
    persistence: medium as unknown as SessionPersistence,
    attachments: attachmentsAt(config.workspaceRoot),
    seams: ctx,
    execution: fakeExecution,
  })
  ctx.provide('singularity', driver)
  ctx.effect(() => () => driver.close())
  return { ctx, medium }
}

/** The service one mount provides: what a tool call reaches for its own surface. */
export function serviceOf(ctx: Context): { forCall(exec: ToolRunContext): AgentTaskSurface } {
  return ctx.singularity
}

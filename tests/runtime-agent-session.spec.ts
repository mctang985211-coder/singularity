/**
 * The agent-session seams, unit by unit, without a full runtime.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { controlSessionIdOf } from '../src/control/session-store.ts'
import type { RefusalCode } from '../src/index.ts'
import {
  assertRuntimeSeams,
  closeAgentSession,
  openAgentSession,
  type AgentSessionRequest,
  type OpenedAgentSession,
} from '../src/runtime/agent-session.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'

/** The module's seam shape, named through its own signature: this spec mounts no agent runtime. */
type Seams = Parameters<typeof assertRuntimeSeams>[0]

/** One recorded create-or-resume call, so the decision itself is observable. */
interface RecordedCall {
  readonly kind: 'create' | 'resume'
  readonly sessionId: string
}

interface HarnessOptions {
  /** What `stat` answers: `true` means the medium already holds a session for the derived id. */
  readonly persisted?: boolean
  readonly createFails?: unknown
  readonly resumeFails?: unknown
  /** Fail the first `dispose()` only, so a retried close can succeed. */
  readonly disposeFailsOnce?: unknown
}

/**
 * A stubbed seam set. `dispose` takes a tick, so "the lease was released **before** close resolved"
 */
function harness(options: HarnessOptions = {}) {
  const calls: RecordedCall[] = []
  const disposed: string[] = []
  const teardown = { failures: options.disposeFailsOnce === undefined ? 0 : 1, error: options.disposeFailsOnce }
  const seams: Record<string, unknown> = {
    sessionPersistence: { stat: async (id: string) => (options.persisted === true ? { header: { id } } : undefined) },
    sessions: {},
    agentLoop: {},
    agents: {
      create: async (create: { sessionId: string }) => {
        calls.push({ kind: 'create', sessionId: create.sessionId })
        if (options.createFails !== undefined) throw options.createFails
        return handleFor(create.sessionId, disposed, teardown)
      },
      resume: async (resume: { resumeSessionId: string }) => {
        calls.push({ kind: 'resume', sessionId: resume.resumeSessionId })
        if (options.resumeFails !== undefined) throw options.resumeFails
        return handleFor(resume.resumeSessionId, disposed, teardown)
      },
    },
  }
  return { context: seams as Seams, seams, calls, disposed }
}

function handleFor(sessionId: string, disposed: string[], teardown: { failures: number; error: unknown }) {
  return {
    agent: { id: sessionId },
    dispose: async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      if (teardown.failures > 0) {
        teardown.failures -= 1
        throw teardown.error
      }
      disposed.push(sessionId)
    },
  }
}

const deployments: { readonly root: string; readonly context: Context }[] = []

afterEach(async () => {
  for (const live of deployments.splice(0)) {
    await live.context.fiber.dispose()
    await rm(live.root, { recursive: true, force: true })
  }
})

describe('the load-time seam assertion', () => {
  it('refuses a context missing every seam, naming each one', () => {
    const refusal = refusalOf(() => assertRuntimeSeams({} as Seams))
    expect(refusal).toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('ctx.sessionPersistence') })
    expect(refusal.detail).toContain('ctx.sessionPersistence')
  })

  it('names only the absent seam, and accepts a context that has them all', () => {
    const live = harness()
    expect(() => assertRuntimeSeams(live.context)).not.toThrow()

    const partial = { ...live.seams }
    delete partial['agents']
    const refusal = refusalOf(() => assertRuntimeSeams(partial as Seams))
    expect([refusal.detail.includes('ctx.agents'), refusal.detail.includes('ctx.sessions')]).toEqual([true, false])
    for (const name of ['ctx.sessionPersistence', 'ctx.agentLoop']) expect(refusal.detail).not.toContain(name)
  })

  it('refuses a real cordis context that has the persistence service but nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singularity-agent-seams-'))
    const context = new Context()
    await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    deployments.push({ root, context })

    // The mounted plugin really provides its service: the assertion must not name what is there.
    const refusal = refusalOf(() => assertRuntimeSeams(context))
    expect(refusal.detail).toContain('ctx.sessions')
    expect([refusal.code, refusal.detail.includes('ctx.sessionPersistence')]).toEqual(['malformed-declaration', false])
  })
})

describe('a seam read inside a plugin that did not inject it', () => {
  /**
   * The trap this pins, reproduced the way it actually happened.
   *
   * A cordis plugin context **throws** on a property read of a service the plugin did not declare in
   * `inject` — `cannot get property "sessions" without inject` — so `ctx.sessions` is not "the service
   * or undefined", it is the service or an exception. The assertion above passed anyway, because a
   * bare `Context` and a plain object both lack the proxy that enforces it: only a context *inside a
   * plugin whose inject list omits the name* behaves this way, which is exactly the deployment the
   * assembly runs in. The sub-task probe found this in a real profile (five `without inject` results in
   * one session), which is why the check now reads through `ctx.get` and why this witness exists.
   */
  it('throws on a property read, and answers undefined through get', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singularity-seam-trap-'))
    const parent = new Context()
    await parent.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    deployments.push({ root, context: parent })

    const inside: Record<string, unknown> = {}
    // A plugin that provides nothing and injects nothing: the shape every optional-seam reader runs in.
    await parent.plugin({
      name: 'seam-trap-probe',
      apply: (pluginCtx: Context) => {
        inside['property'] = (() => {
          try {
            return { value: (pluginCtx as unknown as Record<string, unknown>)['sessions'] }
          } catch (error) {
            return { threw: error instanceof Error ? error.message : String(error) }
          }
        })()
        inside['get'] = { value: (pluginCtx as unknown as { get(name: string): unknown }).get('sessions') }
      },
    })

    // The property read is the trap; `get` is the question this module now asks.
    expect(inside['property']).toMatchObject({ threw: expect.stringContaining('without inject') })
    expect(inside['get']).toEqual({ value: undefined })

    // And the module's own check reaches its named refusal rather than letting that throw escape.
    await parent.plugin({
      name: 'seam-trap-assert',
      apply: (pluginCtx: Context) => {
        inside['refusal'] = (() => {
          try {
            assertRuntimeSeams(pluginCtx as unknown as Seams)
            return undefined
          } catch (error) {
            return error instanceof ProtocolRefusal ? error.refusal : { code: 'not-a-refusal', detail: String(error) }
          }
        })()
      },
    })
    expect(inside['refusal']).toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('ctx.sessions') })
  })
})

describe('the derived session id', () => {
  it('derives one session id per agent id, stably and without collisions', async () => {
    const live = harness()
    const first = await openAgentSession(live.context, { agentId: 'task:7', resume: false })
    expect(first.sessionId).toBe('singularity:agent:task:7')
    await closeAgentSession('task:7')

    const again = await openAgentSession(live.context, { agentId: 'task:7', resume: false })
    expect(again.sessionId).toBe(first.sessionId)

    // The collision witness: an implementation that made the id "path safe" by replacing `:` would
    // map these two agent ids onto one session, and the second would resume the first's history.
    const separator = await openAgentSession(live.context, { agentId: 'task-7', resume: false })
    expect(separator.sessionId).not.toBe(first.sessionId)

    // The other namespace over the same persistence root: one raw id, two session ids.
    expect(first.sessionId).not.toBe(controlSessionIdOf('task:7'))

    await closeAgentSession('task:7')
    await closeAgentSession('task-7')
  })

  it('refuses an empty agent id by name, before any seam is touched', async () => {
    const live = harness()
    const request: AgentSessionRequest = { agentId: '', resume: false }
    const opened: Promise<OpenedAgentSession> = openAgentSession(live.context, request)
    const refusal = await asyncRefusalOf(() => opened)
    expect(refusal.code).toBe<RefusalCode>('malformed-declaration')
    expect(live.calls).toHaveLength(0)
    expect((await asyncRefusalOf(() => closeAgentSession(''))).code).toBe<RefusalCode>('malformed-declaration')
  })
})

describe('creating and resuming', () => {
  it.each([undefined, 2])('creates managed children with native lineage from parent depth %s', async depth => {
    const context = new Context()
    await context.plugin(SessionStore)
    const live = harness()
    const parent = { session: { id: SessionId('business-root'), header: { delegationDepth: depth } } } as unknown as Agent
    const create = live.seams['agents'] as AgentRegistry
    create.create = async options => {
      expect(options.parentAgent).toBe(parent)
      const session = context.sessions.create(options.sessionId, { meta: options.meta! })
      expect(session.header).toMatchObject({ cwd: '/isolated/task/run', parentSession: 'business-root',
        origin: 'subagent', delegationDepth: (depth ?? 0) + 1, agentPreset: 'singularity-next' })
      return handleFor(options.sessionId, live.disposed, { failures: 0, error: undefined }) as never
    }
    try {
      await openAgentSession(live.context, { agentId: 'managed-lineage', resume: false, parent,
        cwd: '/isolated/task/run', preset: 'singularity-next' })
      await closeAgentSession('managed-lineage')
      expect(live.disposed).toEqual(['singularity:agent:managed-lineage'])
    } finally { await context.fiber.dispose() }
  })

  it('retains live parent ownership when resuming legacy child history without rewriting its header', async () => {
    const live = harness({ persisted: true })
    const parent = {} as Agent
    const registry = live.seams['agents'] as AgentRegistry
    registry.resume = async options => {
      expect(options.parentAgent).toBe(parent)
      expect(options).not.toHaveProperty('meta')
      return handleFor(options.resumeSessionId, live.disposed, { failures: 0, error: undefined }) as never
    }
    await openAgentSession(live.context, { agentId: 'legacy-lineage', resume: true, parent, cwd: '/isolated/task/run' })
    await closeAgentSession('legacy-lineage')
    expect(live.disposed).toEqual(['singularity:agent:legacy-lineage'])
  })

  it('refuses resume when the exact session has no persisted history', async () => {
    const live = harness()
    await expect(openAgentSession(live.context, { agentId: 'never-created', resume: true })).rejects.toThrow('resume requires persisted history')
    expect(live.calls).toEqual([])
  })

  it('resumes a persisted session for the same exact id and reports resumed', async () => {
    const live = harness({ persisted: true })
    const opened = await openAgentSession(live.context, { agentId: 'persisted', resume: true })
    expect([opened.resumed, opened.sessionId, live.calls]).toEqual([true, 'singularity:agent:persisted', [{ kind: 'resume', sessionId: 'singularity:agent:persisted' }]])
    await closeAgentSession('persisted')
  })

  it('refuses a fresh create over persisted history instead of overwriting it', async () => {
    const live = harness({ persisted: true })
    const refusal = await asyncRefusalOf(() => openAgentSession(live.context, { agentId: 'taken', resume: false }))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('singularity:agent:taken') })
    expect(live.calls).toHaveLength(0)
  })

  it('names the write lease when resume finds another live handle holding it', async () => {
    const live = harness({ persisted: true, resumeFails: new SessionAlreadyOwnedError(SessionId('singularity:agent:held')) })
    const refusal = await asyncRefusalOf(() => openAgentSession(live.context, { agentId: 'held', resume: true }))
    expect(refusal).toMatchObject({ code: 'concurrent-writer', detail: expect.stringContaining('singularity:agent:held') })
  })

  it('propagates an unnamed repair failure with its original identity', async () => {
    // The measured trap: this refusal is a bare `Error`, so `instanceof` against the exported error
    // classes cannot identify it — the module must still hand back a named refusal with the text.
    const ragged = new Error('append seq mismatch for "singularity:agent:ragged": expected 2 at index 0, got 99')
    expect(ragged).not.toBeInstanceOf(SessionAlreadyOwnedError)

    const live = harness({ persisted: true, resumeFails: ragged })
    await expect(openAgentSession(live.context, { agentId: 'ragged', resume: true })).rejects.toBe(ragged)
  })

  it('does not label an agent setup or provider failure as a persistence failure', async () => {
    const error = new Error('provider stream_read_error during setup')
    const live = harness({ createFails: error })
    await expect(openAgentSession(live.context, { agentId: 'setup-failed', resume: false })).rejects.toBe(error)
  })
})

describe('closing', () => {
  it('releases the lease before it resolves, then stays idempotent', async () => {
    const live = harness()
    await openAgentSession(live.context, { agentId: 'closable', resume: false })

    // `dispose` takes a tick: nothing is released until the awaited teardown completes.
    await closeAgentSession('closable')
    await closeAgentSession('closable')
    expect(live.disposed).toEqual(['singularity:agent:closable'])

    // The claim is gone, so the same session id can be opened again.
    const reopened = await openAgentSession(live.context, { agentId: 'closable', resume: false })
    expect(reopened.sessionId).toBe('singularity:agent:closable')
    await closeAgentSession('closable')
  })

  it('disposes once when two callers close at the same time', async () => {
    const live = harness()
    await openAgentSession(live.context, { agentId: 'shared-close', resume: false })
    await Promise.all([closeAgentSession('shared-close'), closeAgentSession('shared-close')])
    expect(live.disposed).toEqual(['singularity:agent:shared-close'])
  })

  it('keeps the claim when its teardown fails, so a retry can release the lease', async () => {
    const live = harness({ disposeFailsOnce: new Error('teardown listener failed') })
    await openAgentSession(live.context, { agentId: 'stubborn', resume: false })

    const failure = await asyncRefusalOf(() => closeAgentSession('stubborn'))
    expect(failure).toMatchObject({ code: 'write-not-durable', detail: expect.stringContaining('teardown listener failed') })
    expect(live.disposed).toHaveLength(0)

    // The failed claim stayed registered, so a second close really releases the lease.
    await closeAgentSession('stubborn')
    expect(live.disposed).toEqual(['singularity:agent:stubborn'])
  })

  it('refuses a second claim for the same id, and keeps the first lease releasable', async () => {
    const live = harness()
    await openAgentSession(live.context, { agentId: 'live-agent', resume: false })

    // The stub medium would grant a second handle (its `stat` says nothing is persisted), so only
    // the module's own claim bookkeeping stops a second claim from replacing the first.
    const refusal = await asyncRefusalOf(() => openAgentSession(live.context, { agentId: 'live-agent', resume: false }))
    expect(refusal.code).toBe<RefusalCode>('concurrent-writer')
    expect(live.disposed).toHaveLength(0)

    await closeAgentSession('live-agent')
    expect(live.disposed).toHaveLength(1)
  })

  it('refuses a second context claiming one session id, and keeps the first lease releasable', async () => {
    const first = harness()
    const second = harness()
    await openAgentSession(first.context, { agentId: 'one-lease', resume: false })

    const refusal = await asyncRefusalOf(() => openAgentSession(second.context, { agentId: 'one-lease', resume: false }))
    expect(refusal.code).toBe<RefusalCode>('concurrent-writer')
    expect(second.disposed).toEqual([])

    await closeAgentSession('one-lease')
    expect(first.disposed).toEqual(['singularity:agent:one-lease'])
  })
})

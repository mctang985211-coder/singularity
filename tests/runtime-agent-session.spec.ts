/**
 * The agent-session seams, unit by unit, without a full runtime.
 *
 * Every spec pins a decision this module makes on its own, so it can fail for its own reason:
 *
 * 1. **A missing seam is refused by name, at load.** A cordis service whose plugin was mounted
 *    without its `inject` dependency is silently `undefined`; the refusal must name *each* absent
 *    seam, and must not name a seam that is really there. One case mounts the real persistence
 *    plugin over a real cordis `Context` (`tests/control-store.spec.ts` technique) so the
 *    "present" half is a real service, not a stub.
 * 2. **The session id is derived, stably, and no two agent ids collide.** The collision witness is
 *    the plausible wrong implementation that made the id *path safe* by replacing `:`, which would
 *    map `task:7` and `task-7` onto one session. The control store's namespace, which shares the
 *    same persistence root, must stay disjoint for the same raw id.
 * 3. **Create and resume are distinguished by what the medium holds**, not by the caller's wish: a
 *    session that was never created is created (`resumed: false`), a persisted one is resumed
 *    (`resumed: true`), and a fresh create over persisted history is refused rather than overwrite.
 * 4. **Resume takes the write lease, and its failures keep an identity.** `SessionAlreadyOwnedError`
 *    becomes our `concurrent-writer`, and a bare repair `Error` — one `instanceof` cannot identify —
 *    still becomes a named refusal carrying the upstream text.
 * 5. **Close is ordered and idempotent.** The lease is released before `closeAgentSession` resolves,
 *    two concurrent closes dispose once, a failed close stays retryable, and a refused second claim
 *    — same context or another one — never costs the first claimant its lease.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

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
 * is falsifiable: a close that did not await the teardown would see nothing disposed yet.
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
    expect(refusal.code).toBe<RefusalCode>('malformed-declaration')
    for (const name of ['ctx.sessionPersistence', 'ctx.sessions', 'ctx.agents', 'ctx.agentLoop'])
      expect(refusal.detail).toContain(name)
  })

  it('names only the absent seam, and accepts a context that has them all', () => {
    const live = harness()
    expect(() => assertRuntimeSeams(live.context)).not.toThrow()

    const partial = { ...live.seams }
    delete partial['agents']
    const refusal = refusalOf(() => assertRuntimeSeams(partial as Seams))
    expect(refusal.detail).toContain('ctx.agents')
    for (const name of ['ctx.sessionPersistence', 'ctx.sessions', 'ctx.agentLoop']) expect(refusal.detail).not.toContain(name)
  })

  it('refuses a real cordis context that has the persistence service but nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singularity-agent-seams-'))
    const context = new Context()
    await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    deployments.push({ root, context })

    // The mounted plugin really provides its service: the assertion must not name what is there.
    expect(typeof context.sessionPersistence?.stat).toBe('function')
    const refusal = refusalOf(() => assertRuntimeSeams(context))
    expect(refusal.code).toBe<RefusalCode>('malformed-declaration')
    for (const name of ['ctx.sessions', 'ctx.agents', 'ctx.agentLoop']) expect(refusal.detail).toContain(name)
    expect(refusal.detail).not.toContain('ctx.sessionPersistence')
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
  it('creates a session that was never created, even when the caller asked to resume', async () => {
    const live = harness()
    const opened = await openAgentSession(live.context, { agentId: 'never-created', resume: true })
    expect(opened.resumed).toBe(false)
    expect(live.calls).toEqual([{ kind: 'create', sessionId: 'singularity:agent:never-created' }])
    await closeAgentSession('never-created')
  })

  it('resumes a persisted session for the same exact id and reports resumed', async () => {
    const live = harness({ persisted: true })
    const opened = await openAgentSession(live.context, { agentId: 'persisted', resume: true })
    expect(opened.resumed).toBe(true)
    expect(opened.sessionId).toBe('singularity:agent:persisted')
    expect(live.calls).toEqual([{ kind: 'resume', sessionId: 'singularity:agent:persisted' }])
    await closeAgentSession('persisted')
  })

  it('refuses a fresh create over persisted history instead of overwriting it', async () => {
    const live = harness({ persisted: true })
    const refusal = await asyncRefusalOf(() => openAgentSession(live.context, { agentId: 'taken', resume: false }))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('singularity:agent:taken')
    expect(live.calls).toHaveLength(0)
  })

  it('names the write lease when resume finds another live handle holding it', async () => {
    const live = harness({ persisted: true, resumeFails: new SessionAlreadyOwnedError(SessionId('singularity:agent:held')) })
    const refusal = await asyncRefusalOf(() => openAgentSession(live.context, { agentId: 'held', resume: true }))
    expect(refusal.code).toBe<RefusalCode>('concurrent-writer')
    expect(refusal.detail).toContain('write lease')
  })

  it('keeps an unnamed repair failure identifiable, text included', async () => {
    // The measured trap: this refusal is a bare `Error`, so `instanceof` against the exported error
    // classes cannot identify it — the module must still hand back a named refusal with the text.
    const ragged = new Error('append seq mismatch for "singularity:agent:ragged": expected 2 at index 0, got 99')
    expect(ragged).not.toBeInstanceOf(SessionAlreadyOwnedError)

    const live = harness({ persisted: true, resumeFails: ragged })
    const refusal = await asyncRefusalOf(() => openAgentSession(live.context, { agentId: 'ragged', resume: true }))
    expect(refusal.code).toBe<RefusalCode>('write-not-durable')
    expect(refusal.detail).toContain('append seq mismatch')
  })
})

describe('closing', () => {
  it('releases the lease before it resolves, then stays idempotent', async () => {
    const live = harness()
    await openAgentSession(live.context, { agentId: 'closable', resume: false })

    // `dispose` takes a tick: nothing is released until the awaited teardown completes.
    await closeAgentSession('closable')
    expect(live.disposed).toEqual(['singularity:agent:closable'])
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
    expect(failure.code).toBe<RefusalCode>('write-not-durable')
    expect(failure.detail).toContain('teardown listener failed')
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
    expect(live.disposed).toHaveLength(1)

    await closeAgentSession('live-agent')
    expect(live.disposed).toHaveLength(2)
  })

  it('refuses a second context claiming one session id, and keeps the first lease releasable', async () => {
    const first = harness()
    const second = harness()
    await openAgentSession(first.context, { agentId: 'one-lease', resume: false })

    const refusal = await asyncRefusalOf(() => openAgentSession(second.context, { agentId: 'one-lease', resume: false }))
    expect(refusal.code).toBe<RefusalCode>('concurrent-writer')
    // The refused open released the handle it had just created: no lease without a holder.
    expect(second.disposed).toEqual(['singularity:agent:one-lease'])

    await closeAgentSession('one-lease')
    expect(first.disposed).toEqual(['singularity:agent:one-lease'])
  })
})

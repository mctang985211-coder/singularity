/**
 * The native approval seam, and what a non-grant means for the release command.
 *
 * `release/approved` must rest on a native act whose answer was `'allowed-once'` and whose
 * `approval/asked` id we can name. Two claims are tested here, and they are different claims:
 *
 *   - the **seam module**: the load-time refusal names every absent seam; the closed outcome is
 *     passed through rather than reinterpreted; the audit id is attributed only when the ask's
 *     window holds exactly one question for the asking session; the subscription is always closed,
 *     including when the ask rejects; and an unanswered ask is a named refusal rather than consent;
 *   - the **command contract**: no answer other than the grant — and no grant without an
 *     attributable audit id — may leave an approval fact behind, and a deployment that composed no
 *     seam cannot approve at all.
 *
 * The service here is a deployment double: the real `ctx.approval` (audit pair, answerer waterfall,
 * fail-closed `'unavailable'`) is observed in `scripts/release-probe.mjs`, where a real turn asks it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { ProtocolRegistry } from '../src/index.ts'
import { ControlSessionStore } from '../src/control/session-store.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  PUBLISHER_ROLE,
  type EnvironmentState,
} from '../src/environment/protocol.ts'
import { APPROVER_ROLE, declareReleaseProtocol, RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from '../src/release/protocol.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import {
  APPROVAL_GRANT,
  askForApproval,
  assertApprovalSeams,
  type ApprovalAsk,
  type ApprovalSeams,
} from '../src/runtime/approval.ts'
import { SCHEDULER_ROLE } from '../src/task/protocol.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'

const ENVIRONMENT = 'library-1'
const REVISION = 'r0001'
const MANIFEST = { skills: ['count-words'] } as const
const ALICE = 'human:alice'

type Listener = (session: Session, event: SessionEvent) => void

/** One `approval/asked` event, shaped as the native service appends it: the id is all we read. */
const askedEvent = (id: string): SessionEvent => ({ type: 'approval/asked', data: { id } }) as unknown as SessionEvent

const sessionOf = (id: string): Session => ({ id }) as unknown as Session

interface SeamOptions {
  readonly outcome?: string
  readonly asks?: readonly string[]
  readonly foreignAsks?: readonly string[]
  readonly throwWith?: unknown
}

/**
 * A deployment double for the native seam: it answers `outcome`, and its feed delivers exactly the
 * `approval/asked` events the test asks for — ours, another session's, or none.
 */
function seam(options: SeamOptions = {}) {
  const listeners = new Set<Listener>()
  const session = sessionOf('agent-1')
  const agent = { session } as unknown as Agent
  const requests: ApprovalAsk[] = []
  const seams: ApprovalSeams = {
    approval: {
      request: async request => {
        requests.push(request)
        if (options.throwWith !== undefined) throw options.throwWith
        for (const listener of [...listeners]) {
          for (const id of options.asks ?? []) listener(session, askedEvent(id))
          for (const id of options.foreignAsks ?? []) listener(sessionOf('someone-else'), askedEvent(id))
        }
        return options.outcome ?? APPROVAL_GRANT
      },
    },
    feed: { on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) } },
  }
  return { agent, session, seams, listeners, requests }
}

const ask = (agent: Agent) => ({ agent, toolName: 'release_approve', callId: 'call-1', reason: 'publishing is a decision' })

describe('the load-time seam assertion names every absent seam', () => {
  it('refuses a deployment with no approval service and no append feed', () => {
    const refusal = refusalOf(() => assertApprovalSeams({}))
    expect(refusal).toMatchObject({ code: 'malformed-declaration', detail: expect.stringMatching(/ctx\.approval.*ctx\.on\('session\/event'\)/) })
  })

  it('names only the seam that is missing, and accepts a deployment that has both', () => {
    const double = seam()
    const noFeed = refusalOf(() => assertApprovalSeams({ approval: double.seams.approval }))
    expect(noFeed.detail).toContain("ctx.on('session/event')")
    expect(noFeed.detail).not.toContain('ctx.approval')
    expect(refusalOf(() => assertApprovalSeams({ feed: double.seams.feed })).detail).toContain('ctx.approval')
    expect(() => assertApprovalSeams(double.seams)).not.toThrow()
  })
})

describe('one ask, one audit id', () => {
  it('reports the outcome with the id of the one question the window holds, and closes the feed', async () => {
    const double = seam({ asks: ['audit-1'] })

    const attempt = await askForApproval(double.seams, ask(double.agent))

    expect(attempt).toEqual({ outcome: APPROVAL_GRANT, approvalId: 'audit-1' })
    expect(double.requests).toEqual([{ agent: double.agent, toolName: 'release_approve', callId: 'call-1', reason: 'publishing is a decision' }])
    // The subscription is per ask: a listener left behind would collect the next question's id too.
    expect(double.listeners.size).toBe(0)
  })

  it('passes every other outcome through unchanged, so the caller decides what consent is', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      const double = seam({ outcome, asks: ['audit-1'] })
      expect(await askForApproval(double.seams, ask(double.agent))).toEqual({ outcome, approvalId: 'audit-1' })
    }
  })

  it('reports no id when two questions land in the window, rather than picking one', async () => {
    const double = seam({ asks: ['audit-1', 'audit-2'] })
    expect(await askForApproval(double.seams, ask(double.agent))).toEqual({ outcome: APPROVAL_GRANT })
  })

  it('reports no id when the only question in the window belongs to another session', async () => {
    const double = seam({ foreignAsks: ['audit-1'] })
    expect(await askForApproval(double.seams, ask(double.agent))).toEqual({ outcome: APPROVAL_GRANT })
  })

  it('refuses an ask that never settled, and still closes the feed', async () => {
    const double = seam({ throwWith: new Error('approval.request() outside an open turn') })

    const refusal = await asyncRefusalOf(() => askForApproval(double.seams, ask(double.agent)))
    expect(refusal).toMatchObject({ code: 'write-not-durable', detail: expect.stringContaining('outside an open turn') })
    expect(double.listeners.size).toBe(0)
  })
})

const SUBJECTS: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ROLE]: 'environment-service',
  [PUBLISHER_ROLE]: 'publisher-service',
  [SCHEDULER_ROLE]: 'scheduler-service',
  [APPROVER_ROLE]: 'approval-seam',
}

const deployments: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const entry of deployments.splice(0)) {
    await entry.context.fiber.dispose()
    await rm(entry.root, { recursive: true, force: true })
  }
})

/** One live control store with both protocols declared, for the command half of the contract. */
async function live(): Promise<ControlSessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-approval-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  deployments.push({ context, root })
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareReleaseProtocol(registry)
  return ControlSessionStore.open({ persistence: context.sessionPersistence, controlId: 'approval', registry, subjects: SUBJECTS })
}

/** A drafted revision, so the command's rules are decided against a real draft. */
async function drafted(): Promise<{ store: ControlSessionStore; digest: string }> {
  const store = await live()
  await store.emit({ commandId: 'create-1', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION, kind: ENVIRONMENT_KINDS.revisionCreated, subject: ENVIRONMENT, payload: { revisionId: REVISION, manifest: MANIFEST } })
  const digest = store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)?.revisions[REVISION]?.contentDigest
  if (digest === undefined) throw new Error('the revision was not created')
  await createReleaseCommands({ store }).draft({ commandId: 'draft-1', revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest } })
  return { store, digest }
}

const releaseOf = (store: ControlSessionStore): ReleaseState | undefined =>
  store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, ENVIRONMENT)

describe('a release approval exists only on the exact grant, attributed to one question', () => {
  async function attempt(options: SeamOptions) {
    const { store, digest } = await drafted()
    const double = seam(options)
    const refusal = await asyncRefusalOf(() => createReleaseCommands({ store, approvalSeams: double.seams }).approve({ commandId: 'approve-1', environmentId: ENVIRONMENT, revisionId: REVISION, draftDigest: digest, approvedBy: ALICE, ask: ask(double.agent) }))
    return { refusal, state: releaseOf(store) }
  }

  it('refuses every answer that is not the grant, and records nothing', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed-twice']) {
      const { refusal, state } = await attempt({ outcome, asks: ['audit-1'] })
      expect(refusal).toMatchObject({ code: 'unapproved-revision', detail: expect.stringContaining(outcome) })
      expect(state?.approvedBy).toBeUndefined()
    }
  })

  it('refuses a grant whose audit identity cannot be attributed to one question', async () => {
    const { refusal, state } = await attempt({ asks: ['audit-1', 'audit-2'] })
    expect(refusal).toMatchObject({ code: 'unapproved-revision', detail: expect.stringContaining('audit id') })
    expect(state?.approvedBy).toBeUndefined()
  })

  it('refuses to approve at all when this deployment composed no approval seam', async () => {
    const { store, digest } = await drafted()
    const double = seam()
    const refusal = await asyncRefusalOf(() => createReleaseCommands({ store }).approve({ commandId: 'approve-1', environmentId: ENVIRONMENT, revisionId: REVISION, draftDigest: digest, approvedBy: ALICE, ask: ask(double.agent) }))
    expect(refusal).toMatchObject({ code: 'malformed-declaration', detail: expect.stringMatching(/ctx\.approval.*ctx\.on\('session\/event'\)/) })
    expect(releaseOf(store)?.approvedBy).toBeUndefined()
  })
})

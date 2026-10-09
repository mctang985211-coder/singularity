/**
 * `release@1`: an approval binds the content a human saw, in one environment, and nothing else.
 *
 * `review.md` R07 is the defect this prevents: an approval recorded while binding nothing (the
 * previous system set `guards.bound` true and never wired its recompute check). Here the three
 * mechanisms are deliberately different things — the role-stamped emitter is the *authority*, the
 * native `approvalId` is the act's *audit identity*, and `draftDigest` is the *binding*.
 *
 * Three layers decide, so all three are exercised: the command boundary (the cross-subject half,
 * inside the store's commit region), the native seam (a grant must be exactly `'allowed-once'` and
 * attributable to one question; a deployment double stands in here, and `scripts/release-probe.mjs`
 * observes the real service), and the reducer — reached through hand-framed logs too, because a fold
 * re-parses and re-reduces every fact, and a rule only the append path applies is not a rule.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { digestOf, foldSubjects, MemoryLog, ProtocolRegistry, sealEnvelope, type EmitInput, type Envelope, type RefusalCode } from '../src/index.ts'
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
import { APPROVER_ROLE, declareReleaseProtocol, RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from '../src/release/protocol.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import type { ApprovalSeams } from '../src/runtime/approval.ts'
import { SCHEDULER_ROLE } from '../src/task/protocol.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'

const ENVIRONMENT = 'library-1'
const OTHER_ENVIRONMENT = 'library-2'
const REVISION = 'r0001'
const OTHER_REVISION = 'r0002'
const MANIFEST = { skills: ['count-words'] } as const
const OTHER_MANIFEST = { skills: ['count-words', 'bounded-size'] } as const

/** The identities the deployment holds. The role that drafts and the role that approves differ. */
const SCHEDULER = 'scheduler-service'
const APPROVAL_SEAM = 'approval-seam'
const ALICE = 'human:alice'

const SUBJECTS: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ROLE]: 'environment-service',
  [PUBLISHER_ROLE]: 'publisher-service',
  [SCHEDULER_ROLE]: SCHEDULER,
  [APPROVER_ROLE]: APPROVAL_SEAM,
}

type Listener = (session: Session, event: SessionEvent) => void
interface SeamDouble {
  readonly agent: Agent
  readonly seams: ApprovalSeams
}

/** One `approval/asked` event, shaped as the native service appends it: the id is all we read. */
const askedEvent = (id: string): SessionEvent => ({ type: 'approval/asked', data: { id } }) as unknown as SessionEvent

/**
 * A deployment double for the native seam: it answers `outcome`, and its feed carries one
 * `approval/asked` for the asking agent — or none at all, which is the unattributable case.
 */
function seam(outcome = 'allowed-once', approvalId: string | null = 'audit-1'): SeamDouble {
  const listeners = new Set<Listener>()
  const agent = { session: { id: 'agent-1' } } as unknown as Agent
  const seams: ApprovalSeams = {
    approval: {
      request: async () => {
        if (approvalId !== null) for (const listener of [...listeners]) listener(agent.session, askedEvent(approvalId))
        return outcome
      },
    },
    feed: { on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) } },
  }
  return { agent, seams }
}

/** Draft, approve and publish through the command boundary, so each call site stays one line. */
function draft(store: ControlSessionStore, revisionId: string, digest: string, environmentId = ENVIRONMENT, commandId = `draft-${revisionId}`) {
  return createReleaseCommands({ store }).draft({ commandId, revision: { environmentId, revisionId, digest } })
}

type ApproveOptions = { revisionId?: string; draftDigest?: string; approvedBy?: string; environmentId?: string; commandId?: string }

function approve(store: ControlSessionStore, double: SeamDouble, options: ApproveOptions = {}) {
  const environmentId = options.environmentId ?? ENVIRONMENT
  const revisionId = options.revisionId ?? REVISION
  return createReleaseCommands({ store, approvalSeams: double.seams }).approve({
    commandId: options.commandId ?? 'approve-1', environmentId, revisionId,
    draftDigest: options.draftDigest ?? contentDigest(store, revisionId, environmentId),
    approvedBy: options.approvedBy ?? ALICE,
    ask: { agent: double.agent, toolName: 'release_approve' },
  })
}

function publish(store: ControlSessionStore, to = REVISION, expected = '', environmentId = ENVIRONMENT, commandId = 'publish-1') {
  return createReleaseCommands({ store }).publish({ commandId, environmentId, expected, to })
}

const deployments: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const entry of deployments.splice(0)) {
    await entry.context.fiber.dispose()
    await rm(entry.root, { recursive: true, force: true })
  }
})

/** One live control store over a real JSONL session, with the environment and release declared. */
async function live(): Promise<{ store: ControlSessionStore; registry: ProtocolRegistry }> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-release-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  deployments.push({ context, root })
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareReleaseProtocol(registry)
  return { store: await ControlSessionStore.open({ persistence: context.sessionPersistence, controlId: 'release', registry, subjects: SUBJECTS }), registry }
}

/** The digest the log holds, read back rather than assumed. */
function contentDigest(store: ControlSessionStore, revisionId = REVISION, environmentId = ENVIRONMENT): string {
  const revision = store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, environmentId)?.revisions[revisionId]
  if (revision === undefined) throw new Error(`revision ${revisionId} was not created in ${environmentId}`)
  return revision.contentDigest
}

async function createRevision(store: ControlSessionStore, revisionId: string, manifest: unknown, environmentId = ENVIRONMENT): Promise<string> {
  const payload = { revisionId, manifest }
  await store.emit({ commandId: `create-${environmentId}-${revisionId}`, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION, kind: ENVIRONMENT_KINDS.revisionCreated, subject: environmentId, payload })
  return contentDigest(store, revisionId, environmentId)
}

function releaseState(store: ControlSessionStore, environmentId = ENVIRONMENT): ReleaseState | undefined {
  return store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)
}

/** A log with the release protocol alone, for what the reducer decides without any environment. */
function releaseLog(subjects: Readonly<Record<string, string>> = SUBJECTS): MemoryLog {
  const registry = new ProtocolRegistry()
  declareReleaseProtocol(registry)
  return new MemoryLog(registry, { subjects })
}

let counter = 0
function rawFact(kind: string, payload: unknown, subject = ENVIRONMENT): EmitInput {
  counter += 1
  return { commandId: `raw-${counter}`, protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind, subject, payload }
}

/** A hand-framed fact, as a log written by another build looks to a fold. */
function sealed(seq: number, kind: string, payload: unknown, subject: string, prevDigest: string | null): Envelope {
  const drafted = kind === RELEASE_KINDS.drafted
  return sealEnvelope({
    protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind, subject, commandId: `hand-${seq}`,
    emitter: drafted ? SCHEDULER_ROLE : APPROVER_ROLE, actor: drafted ? SCHEDULER : APPROVAL_SEAM,
    at: `2026-10-10T00:00:0${seq}.000Z`, seq, prevDigest, payload,
  })
}

/** A fresh fold of hand-framed or recorded release facts: the reducer's own verdict. */
function folded(entries: readonly Envelope[], subject = ENVIRONMENT): ReleaseState | undefined {
  const registry = new ProtocolRegistry()
  declareReleaseProtocol(registry)
  return foldSubjects<ReleaseState>(registry, entries, RELEASE_PROTOCOL, RELEASE_VERSION).get(subject)
}

const approved = (revisionId: string, digest: string, approvedBy = ALICE, approvalId = 'audit-1') => ({ revisionId, draftDigest: digest, approvedBy, approvalId })
const environments = (state: ReleaseState | undefined): string | undefined => state?.draftDigest

describe('the draft binds the content the log holds, for one environment', () => {
  it('records the created revision’s own digest, under the environment it belongs to', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)

    const envelope = await draft(store, REVISION, digest)

    expect(envelope.subject).toBe(ENVIRONMENT)
    expect(envelope.payload).toEqual({ revisionId: REVISION, draftDigest: digestOf(MANIFEST) })
    expect(envelope.emitter).toBe(SCHEDULER_ROLE)
    expect(releaseState(store)).toEqual({ revisionId: REVISION, draftDigest: digest })
  })

  it('refuses a draft whose digest is not the content that revision was created with', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)

    // The right id at the digest of *other* content: what a re-pointed id would look like.
    const refusal = await asyncRefusalOf(() => draft(store, REVISION, digestOf(OTHER_MANIFEST), ENVIRONMENT, 'draft-wrong'))
    expect(refusal.code).toBe<RefusalCode>('unknown-revision')
    expect(refusal.detail).toContain(REVISION)
    expect(releaseState(store)).toBeUndefined()
  })

  it('refuses a draft of a revision this environment never created', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)

    const refusal = await asyncRefusalOf(() => draft(store, 'r9999', digestOf(MANIFEST), ENVIRONMENT, 'draft-ghost'))
    expect(refusal.code).toBe<RefusalCode>('unknown-revision')
    expect(refusal.detail).toContain('r9999')
  })

  it('refuses a draft that changes nothing', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    await draft(store, REVISION, digest)

    const refusal = await asyncRefusalOf(() => draft(store, REVISION, digest, ENVIRONMENT, 'draft-again'))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('changes nothing')
    expect(releaseState(store)?.draftDigest).toBe(digest)
  })

  it('supersedes the standing draft and clears its approval, so a superseded grant cannot publish', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    const other = await createRevision(store, OTHER_REVISION, OTHER_MANIFEST)
    await draft(store, REVISION, digest)
    await approve(store, seam())
    expect(releaseState(store)?.approvedBy).toBe(ALICE)

    await draft(store, OTHER_REVISION, other, ENVIRONMENT, 'draft-2')

    // The approval bound r0001's content; r0002 is on the table now, so nothing is approved.
    expect(releaseState(store)).toEqual({ revisionId: OTHER_REVISION, draftDigest: other })
    const refusal = await asyncRefusalOf(() => publish(store, REVISION))
    expect(refusal.code).toBe<RefusalCode>('unapproved-revision')
  })

  it('lets two environments hold the same revision id and release different content', async () => {
    const { store } = await live()
    const here = await createRevision(store, REVISION, MANIFEST, ENVIRONMENT)
    const there = await createRevision(store, REVISION, OTHER_MANIFEST, OTHER_ENVIRONMENT)
    expect(here).not.toBe(there)

    // Each environment drafts and approves its own r0001; neither answers for the other's content.
    for (const [environmentId, digest] of [[ENVIRONMENT, here], [OTHER_ENVIRONMENT, there]] as const) {
      await draft(store, REVISION, digest, environmentId, `draft-${environmentId}`)
      await approve(store, seam(), { environmentId, commandId: `approve-${environmentId}` })
      await publish(store, REVISION, '', environmentId, `publish-${environmentId}`)
      expect(store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, environmentId)?.pointer).toBe(REVISION)
    }
  })

  it('refuses a draft digest that is not a sha256, and a payload that offers an extra member', async () => {
    const log = releaseLog()
    expect((await asyncRefusalOf(() => log.emit(rawFact(RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: 'not-a-digest' })))).code).toBe<RefusalCode>('malformed-payload')
    expect((await asyncRefusalOf(() => log.emit(rawFact(RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST), note: 'ok' })))).code).toBe<RefusalCode>('malformed-payload')
    expect((await asyncRefusalOf(() => log.emit(rawFact(RELEASE_KINDS.drafted, { draftDigest: digestOf(MANIFEST) })))).code).toBe<RefusalCode>('malformed-payload')
  })
})

describe('the approval binds content, and names the draft it answers', () => {
  it('records the human, the audit id and the emitter the log stamped, not the drafting identity', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    await draft(store, REVISION, digest)

    const envelope = await approve(store, seam('allowed-once', 'approval-42'))

    expect(envelope.subject).toBe(ENVIRONMENT)
    expect(envelope.emitter).toBe(APPROVER_ROLE)
    expect(envelope.actor).toBe(APPROVAL_SEAM)
    expect(envelope.actor).not.toBe(SCHEDULER)
    expect(envelope.payload).toEqual(approved(REVISION, digest, ALICE, 'approval-42'))
    expect(releaseState(store)).toEqual(approved(REVISION, digest, ALICE, 'approval-42'))
  })

  it('refuses an approval whose digest is not the draft’s, and leaves the release unapproved', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    await draft(store, REVISION, digest)

    // The human looked at content other than the draft that is on the table.
    const refusal = await asyncRefusalOf(() => approve(store, seam(), { draftDigest: digestOf(OTHER_MANIFEST) }))
    expect(refusal.code).toBe<RefusalCode>('stale-approval')
    expect(refusal.detail).toContain(digestOf(OTHER_MANIFEST).slice(0, 12))
    expect(refusal.detail).toContain(digest.slice(0, 12))
    expect(releaseState(store)?.approvedBy).toBeUndefined()
  })

  it('refuses an approval that names a revision other than the one on the table', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    await draft(store, REVISION, digest)

    // The digest matches, so only the name is wrong: an approval must answer *this* draft.
    const refusal = await asyncRefusalOf(() => approve(store, seam(), { revisionId: OTHER_REVISION, draftDigest: digest }))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain(OTHER_REVISION)
    expect(refusal.detail).toContain(REVISION)
  })

  it('refuses an approval of an environment with no draft, and a second approval of one draft', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    const double = seam()

    const early = await asyncRefusalOf(() => approve(store, double))
    expect(early.code).toBe<RefusalCode>('illegal-transition')
    expect(early.detail).toContain('no draft')

    await draft(store, REVISION, digest)
    await approve(store, double)
    const again = await asyncRefusalOf(() => approve(store, double, { approvedBy: 'human:bob', commandId: 'approve-2' }))
    expect(again.code).toBe<RefusalCode>('illegal-transition')
    expect(again.detail).toContain(ALICE)
    expect(releaseState(store)?.approvedBy).toBe(ALICE)
  })

  it('refuses a nameless human, a missing audit id, and a payload that offers an extra member', async () => {
    const log = releaseLog()
    await log.emit(rawFact(RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST) }))
    for (const payload of [
      approved(REVISION, digestOf(MANIFEST), ''),
      approved(REVISION, digestOf(MANIFEST), ALICE, ''),
      { ...approved(REVISION, digestOf(MANIFEST)), role: 'admin' },
      approved(REVISION, 'nope'),
    ])
      expect((await asyncRefusalOf(() => log.emit(rawFact(RELEASE_KINDS.approved, payload)))).code).toBe<RefusalCode>('malformed-payload')
  })

  it('makes drafting and approving different held identities, in both directions', async () => {
    const draftOnly = releaseLog({ [SCHEDULER_ROLE]: SCHEDULER })
    await draftOnly.emit(rawFact(RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST) }))
    const unapproved = await asyncRefusalOf(() => draftOnly.emit(rawFact(RELEASE_KINDS.approved, approved(REVISION, digestOf(MANIFEST)))))
    expect(unapproved.code).toBe<RefusalCode>('unknown-emitter-role')
    expect(unapproved.detail).toContain(APPROVER_ROLE)

    const approveOnly = releaseLog({ [APPROVER_ROLE]: APPROVAL_SEAM })
    const undrafted = await asyncRefusalOf(() => approveOnly.emit(rawFact(RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST) })))
    expect(undrafted.code).toBe<RefusalCode>('unknown-emitter-role')
    expect(undrafted.detail).toContain(SCHEDULER_ROLE)
  })
})

describe('the fold, not the append path, is where the binding holds', () => {
  it('re-derives the same release state from the recorded facts', async () => {
    const { store } = await live()
    const digest = await createRevision(store, REVISION, MANIFEST)
    await draft(store, REVISION, digest)
    await approve(store, seam())

    expect(folded(store.load().entries())).toEqual(releaseState(store))
  })

  it('refuses a hand-framed approval with no draft, a stale digest, and the wrong revision', () => {
    const approval = sealed(0, RELEASE_KINDS.approved, approved(REVISION, digestOf(MANIFEST)), ENVIRONMENT, null)
    expect(refusalOf(() => folded([approval])).code).toBe<RefusalCode>('illegal-transition')

    const draft = sealed(0, RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST) }, ENVIRONMENT, null)
    const stale = sealed(1, RELEASE_KINDS.approved, approved(REVISION, digestOf(OTHER_MANIFEST)), ENVIRONMENT, draft.digest)
    expect(refusalOf(() => folded([draft, stale])).code).toBe<RefusalCode>('stale-approval')

    const wrongName = sealed(1, RELEASE_KINDS.approved, approved(OTHER_REVISION, digestOf(MANIFEST)), ENVIRONMENT, draft.digest)
    expect(refusalOf(() => folded([draft, wrongName])).code).toBe<RefusalCode>('illegal-transition')
  })

  it('refuses a hand-framed draft that changes nothing, and folds each environment on its own', () => {
    const first = sealed(0, RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST) }, ENVIRONMENT, null)
    const again = sealed(1, RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(MANIFEST) }, ENVIRONMENT, first.digest)
    expect(refusalOf(() => folded([first, again])).code).toBe<RefusalCode>('illegal-transition')

    const elsewhere = sealed(1, RELEASE_KINDS.drafted, { revisionId: REVISION, draftDigest: digestOf(OTHER_MANIFEST) }, OTHER_ENVIRONMENT, first.digest)
    expect([environments(folded([first, elsewhere])), environments(folded([first, elsewhere], OTHER_ENVIRONMENT))]).toEqual([digestOf(MANIFEST), digestOf(OTHER_MANIFEST)])
  })
})

describe('release@1 is exactly these two kinds', () => {
  it('declares two appended kinds at version 1, and does not claim the conditional update', async () => {
    const { registry } = await live()

    expect(registry.versionsOf(RELEASE_PROTOCOL)).toEqual([RELEASE_VERSION])
    expect(registry.kindsOf(RELEASE_PROTOCOL, RELEASE_VERSION)).toEqual([...Object.values(RELEASE_KINDS)].sort())
    for (const kind of Object.values(RELEASE_KINDS)) expect(registry.ruleFor(RELEASE_PROTOCOL, RELEASE_VERSION, kind).guarantees).toEqual({ appended: true })
    // The one conditional update is the environment's pointer switch, not anything here.
    expect(registry.conditionalOwner()).toBe(ENVIRONMENT_PROTOCOL)
  })
})

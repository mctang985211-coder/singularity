/**
 * `release@1`: an approval binds the content a human saw, and nothing else.
 *
 * The defect this file exists to prevent (`review.md` R07) is an approval that is recorded but
 * binds nothing: the previous system set `guards.bound` true, and its recompute check was never
 * wired. So every test here is about the *content* half of the binding: the draft records the digest
 * the log holds for the revision, the approval carries the digest the approver saw, and an approval
 * whose digest is not the draft's is refused by name rather than trimmed to fit.
 *
 * Two layers are exercised, because both exist for different reasons:
 *
 *   - the **command boundary**, where the cross-subject half is decided (does this environment hold
 *     that revision at that content?) inside the store's commit region;
 *   - the **reducer**, reached directly and through a hand-framed log, because a fold is not the
 *     append path: a log written by another build is re-parsed and re-reduced, and a rule that only
 *     the append path applies is not a rule.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import {
  digestOf,
  foldSubjects,
  MemoryLog,
  ProtocolRegistry,
  sealEnvelope,
  type EmitInput,
  type Envelope,
  type RefusalCode,
} from '../src/index.ts'
import { ControlSessionStore } from '../src/control/session-store.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../src/environment/protocol.ts'
import {
  APPROVER_ROLE,
  declareReleaseProtocol,
  RELEASE_KINDS,
  RELEASE_PROTOCOL,
  RELEASE_ROLE,
  RELEASE_VERSION,
  type ReleaseState,
} from '../src/release/protocol.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'

const ENVIRONMENT = 'library-1'
const REVISION = 'r0001'
const OTHER_REVISION = 'r0002'
const MANIFEST = { skills: ['count-words'] } as const
const OTHER_MANIFEST = { skills: ['count-words', 'bounded-size'] } as const

/** The two identities the deployment holds. The pen and the human are not the same one. */
const RELEASE_SERVICE = 'release-service'
const APPROVAL_SEAM = 'approval-seam'
const ALICE = 'human:alice'

const SUBJECTS: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ROLE]: 'environment-service',
  [RELEASE_ROLE]: RELEASE_SERVICE,
  [APPROVER_ROLE]: APPROVAL_SEAM,
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
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence,
    controlId: 'release',
    registry,
    subjects: SUBJECTS,
  })
  return { store, registry }
}

function environmentState(store: ControlSessionStore): EnvironmentState {
  const state = store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)
  if (state === undefined) throw new Error('the environment was not created')
  return state
}

/** The digest the log holds, read back rather than assumed. */
function contentDigest(store: ControlSessionStore, revisionId = REVISION): string {
  const revision = environmentState(store).revisions[revisionId]
  if (revision === undefined) throw new Error(`revision ${revisionId} was not created`)
  return revision.contentDigest
}

async function createRevision(store: ControlSessionStore, revisionId: string, manifest: unknown): Promise<void> {
  await store.emit({
    commandId: `create-${revisionId}`,
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject: ENVIRONMENT,
    payload: { revisionId, manifest },
  })
}

function releaseState(store: ControlSessionStore, revisionId: string): ReleaseState | undefined {
  return store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, revisionId)
}

/** A log with the release protocol alone, for what the reducer decides without any environment. */
function releaseLog(subjects: Readonly<Record<string, string>> = SUBJECTS): MemoryLog {
  const registry = new ProtocolRegistry()
  declareReleaseProtocol(registry)
  return new MemoryLog(registry, { subjects })
}

function releaseFact(kind: string, payload: unknown, subject = REVISION, commandId = `raw-${kind}`): EmitInput {
  return { commandId, protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind, subject, payload }
}

/** A hand-framed fact, as a log written by another build looks to a fold. */
function sealed(seq: number, kind: string, payload: unknown, prevDigest: string | null, subject = REVISION): Envelope {
  return sealEnvelope({
    protocol: RELEASE_PROTOCOL,
    version: RELEASE_VERSION,
    kind,
    subject,
    commandId: `hand-${seq}`,
    emitter: kind === RELEASE_KINDS.drafted ? RELEASE_ROLE : APPROVER_ROLE,
    actor: kind === RELEASE_KINDS.drafted ? RELEASE_SERVICE : APPROVAL_SEAM,
    at: `2026-10-10T00:00:0${seq}.000Z`,
    seq,
    prevDigest,
    payload,
  })
}

function folded(entries: readonly Envelope[], subject = REVISION): ReleaseState | undefined {
  const registry = new ProtocolRegistry()
  declareReleaseProtocol(registry)
  return foldSubjects<ReleaseState>(registry, entries, RELEASE_PROTOCOL, RELEASE_VERSION).get(subject)
}

describe('the draft binds the content the log holds', () => {
  it('records the created revision’s own digest, not a digest of the caller’s choosing', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    const commands = createReleaseCommands({ store })

    const envelope = await commands.draft({
      commandId: 'draft-1',
      revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest: contentDigest(store) },
    })

    expect(envelope.payload).toEqual({ draftDigest: digestOf(MANIFEST) })
    expect(envelope.subject).toBe(REVISION)
    expect(envelope.emitter).toBe(RELEASE_ROLE)
    expect(releaseState(store, REVISION)?.draftDigest).toBe(contentDigest(store))
  })

  it('refuses a draft whose digest is not the content that revision was created with', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    const commands = createReleaseCommands({ store })

    const refusal = await asyncRefusalOf(() =>
      commands.draft({
        commandId: 'draft-wrong',
        // The right id at the digest of *other* content: the mistake a re-pointed id would be.
        revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest: digestOf(OTHER_MANIFEST) },
      }),
    )
    expect(refusal.code).toBe<RefusalCode>('unknown-revision')
    expect(refusal.detail).toContain(REVISION)
    // Nothing was recorded: a refused draft leaves no release behind.
    expect(releaseState(store, REVISION)).toBeUndefined()
  })

  it('refuses a draft of a revision this environment never created', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)

    const refusal = await asyncRefusalOf(() =>
      createReleaseCommands({ store }).draft({
        commandId: 'draft-ghost',
        revision: { environmentId: ENVIRONMENT, revisionId: 'r9999', digest: digestOf(MANIFEST) },
      }),
    )
    expect(refusal.code).toBe<RefusalCode>('unknown-revision')
    expect(refusal.detail).toContain('r9999')
  })

  it('refuses a second draft of the same revision, naming the replacement', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    const commands = createReleaseCommands({ store })
    const revision = { environmentId: ENVIRONMENT, revisionId: REVISION, digest: contentDigest(store) }
    await commands.draft({ commandId: 'draft-1', revision })

    const refusal = await asyncRefusalOf(() => commands.draft({ commandId: 'draft-2', revision }))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('twice')
    expect(releaseState(store, REVISION)?.draftDigest).toBe(digestOf(MANIFEST))
  })

  it('refuses a draft digest that is not a sha256, and a payload that offers an extra member', async () => {
    const log = releaseLog()
    expect((await asyncRefusalOf(() => log.emit(releaseFact(RELEASE_KINDS.drafted, { draftDigest: 'not-a-digest' })))).code).toBe<RefusalCode>('malformed-payload')
    expect((await asyncRefusalOf(() => log.emit(releaseFact(RELEASE_KINDS.drafted, { draftDigest: digestOf(MANIFEST), note: 'looks good' })))).code).toBe<RefusalCode>('malformed-payload')
    expect((await asyncRefusalOf(() => log.emit(releaseFact(RELEASE_KINDS.drafted, {})))).code).toBe<RefusalCode>('malformed-payload')
  })
})

describe('the approval binds the digest the approver saw', () => {
  it('records the human and the emitter the log stamped, not the drafting identity', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    const commands = createReleaseCommands({ store })
    await commands.draft({
      commandId: 'draft-1',
      revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest: contentDigest(store) },
    })

    const envelope = await commands.approve({
      commandId: 'approve-1',
      revisionId: REVISION,
      draftDigest: contentDigest(store),
      approvedBy: ALICE,
    })

    expect(envelope.emitter).toBe(APPROVER_ROLE)
    expect(envelope.actor).toBe(APPROVAL_SEAM)
    expect(envelope.actor).not.toBe(RELEASE_SERVICE)
    expect(releaseState(store, REVISION)).toEqual({ draftDigest: digestOf(MANIFEST), approvedBy: ALICE })
  })

  it('refuses an approval whose digest is not the draft’s, and leaves the release unapproved', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    await createRevision(store, OTHER_REVISION, OTHER_MANIFEST)
    const commands = createReleaseCommands({ store })
    await commands.draft({
      commandId: 'draft-1',
      revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest: digestOf(MANIFEST) },
    })

    // The content moved under the approval: the human looked at r0002's content, the draft of
    // r0001 is what exists. Trimming the approval to the draft would publish what nobody approved.
    const refusal = await asyncRefusalOf(() =>
      commands.approve({
        commandId: 'approve-stale',
        revisionId: REVISION,
        draftDigest: digestOf(OTHER_MANIFEST),
        approvedBy: ALICE,
      }),
    )
    expect(refusal.code).toBe<RefusalCode>('stale-approval')
    expect(refusal.detail).toContain(digestOf(OTHER_MANIFEST).slice(0, 12))
    expect(refusal.detail).toContain(digestOf(MANIFEST).slice(0, 12))
    expect(releaseState(store, REVISION)?.approvedBy).toBeUndefined()
  })

  it('refuses an approval of a revision with no draft, naming the missing draft', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)

    const refusal = await asyncRefusalOf(() =>
      createReleaseCommands({ store }).approve({
        commandId: 'approve-early',
        revisionId: REVISION,
        draftDigest: digestOf(MANIFEST),
        approvedBy: ALICE,
      }),
    )
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('no draft')
    expect(releaseState(store, REVISION)).toBeUndefined()
  })

  it('refuses a second approval, so two names never share one act of authorising', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    const commands = createReleaseCommands({ store })
    await commands.draft({
      commandId: 'draft-1',
      revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest: contentDigest(store) },
    })
    await commands.approve({ commandId: 'approve-1', revisionId: REVISION, draftDigest: digestOf(MANIFEST), approvedBy: ALICE })

    const refusal = await asyncRefusalOf(() =>
      commands.approve({ commandId: 'approve-2', revisionId: REVISION, draftDigest: digestOf(MANIFEST), approvedBy: 'human:bob' }),
    )
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain(ALICE)
    expect(releaseState(store, REVISION)?.approvedBy).toBe(ALICE)
  })

  it('refuses an approval with no human named, and one whose digest is not a sha256', async () => {
    const log = releaseLog()
    await log.emit(releaseFact(RELEASE_KINDS.drafted, { draftDigest: digestOf(MANIFEST) }, REVISION, 'draft-1'))

    expect(
      (await asyncRefusalOf(() => log.emit(releaseFact(RELEASE_KINDS.approved, { draftDigest: digestOf(MANIFEST), approvedBy: '' }, REVISION, 'a1')))).code,
    ).toBe<RefusalCode>('malformed-payload')
    expect(
      (await asyncRefusalOf(() => log.emit(releaseFact(RELEASE_KINDS.approved, { draftDigest: 'nope', approvedBy: ALICE }, REVISION, 'a2')))).code,
    ).toBe<RefusalCode>('malformed-payload')
    expect(
      (await asyncRefusalOf(() => log.emit(releaseFact(RELEASE_KINDS.approved, { draftDigest: digestOf(MANIFEST), approvedBy: ALICE, role: 'admin' }, REVISION, 'a3')))).code,
    ).toBe<RefusalCode>('malformed-payload')
  })

  it('refuses an approval in a deployment that holds no identity for the approver role', async () => {
    // Only the drafting identity exists, so nobody can approve: the human half is a deployment
    // binding, not a member a caller can assert on its own.
    const log = releaseLog({ [RELEASE_ROLE]: RELEASE_SERVICE })
    await log.emit(releaseFact(RELEASE_KINDS.drafted, { draftDigest: digestOf(MANIFEST) }, REVISION, 'draft-1'))

    const refusal = await asyncRefusalOf(() =>
      log.emit(releaseFact(RELEASE_KINDS.approved, { draftDigest: digestOf(MANIFEST), approvedBy: ALICE }, REVISION, 'a1')),
    )
    expect(refusal.code).toBe<RefusalCode>('unknown-emitter-role')
    expect(refusal.detail).toContain(APPROVER_ROLE)
  })
})

describe('the fold, not the append path, is where the binding holds', () => {
  it('re-derives the same release state from the recorded facts', async () => {
    const { store } = await live()
    await createRevision(store, REVISION, MANIFEST)
    const commands = createReleaseCommands({ store })
    await commands.draft({
      commandId: 'draft-1',
      revision: { environmentId: ENVIRONMENT, revisionId: REVISION, digest: contentDigest(store) },
    })
    await commands.approve({ commandId: 'approve-1', revisionId: REVISION, draftDigest: digestOf(MANIFEST), approvedBy: ALICE })

    expect(folded(store.load().entries())).toEqual(releaseState(store, REVISION))
  })

  it('refuses a hand-framed approval that arrives before any draft', () => {
    const approval = sealed(0, RELEASE_KINDS.approved, { draftDigest: digestOf(MANIFEST), approvedBy: ALICE }, null)

    const refusal = refusalOf(() => folded([approval]))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('no draft')
  })

  it('refuses a hand-framed approval whose digest is not the drafted one', () => {
    const draft = sealed(0, RELEASE_KINDS.drafted, { draftDigest: digestOf(MANIFEST) }, null)
    const approval = sealed(1, RELEASE_KINDS.approved, { draftDigest: digestOf(OTHER_MANIFEST), approvedBy: ALICE }, draft.digest)

    const refusal = refusalOf(() => folded([draft, approval]))
    expect(refusal.code).toBe<RefusalCode>('stale-approval')
  })

  it('refuses a hand-framed second draft of one revision', () => {
    const first = sealed(0, RELEASE_KINDS.drafted, { draftDigest: digestOf(MANIFEST) }, null)
    const second = sealed(1, RELEASE_KINDS.drafted, { draftDigest: digestOf(OTHER_MANIFEST) }, first.digest)

    expect(refusalOf(() => folded([first, second])).code).toBe<RefusalCode>('illegal-transition')
  })
})

describe('release@1 is exactly these two kinds', () => {
  it('declares two kinds at version 1, neither of them conditional', async () => {
    const { registry } = await live()

    expect(registry.versionsOf(RELEASE_PROTOCOL)).toEqual([RELEASE_VERSION])
    expect(registry.kindsOf(RELEASE_PROTOCOL, RELEASE_VERSION)).toEqual([...Object.values(RELEASE_KINDS)].sort())
    for (const kind of Object.values(RELEASE_KINDS)) {
      expect(registry.ruleFor(RELEASE_PROTOCOL, RELEASE_VERSION, kind).guarantees).toEqual({ appended: true })
    }
    // The one conditional update is the environment's pointer switch, not anything here.
    expect(registry.conditionalOwner()).toBe(ENVIRONMENT_PROTOCOL)
  })
})

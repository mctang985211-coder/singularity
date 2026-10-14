/**
 * `environment@2`: the one conditional update, and the head that never names a half-finished revision.
 *
 * Three properties the previous system lacked: a switch is a **compare-and-swap** (exactly one of two
 * switches with one expected head is recorded, and the loser is refused rather than re-based); the
 * head is **derived**, living on the folded state and nowhere else; and the ways a switch can be
 * wrong are different refusals — a stale expectation (`illegal-transition`), a target this
 * environment never created (`unknown-revision`), and a target nothing approved
 * (`unapproved-revision`, decided at the command boundary).
 *
 * The command half goes through the real release service, the only surface that may move a head; the
 * reducer half goes through `MemoryLog` and hand-framed folds, because a fold re-parses and re-reduces
 * every fact — and a rule only the append path applies is not a rule.
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
import { declareEnvironmentProtocol, ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_ROLE, ENVIRONMENT_VERSION, PUBLISHER_ROLE, type EnvironmentState } from '../src/environment/protocol.ts'
import { APPROVER_ROLE, declareReleaseProtocol, RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, releaseDraftOf } from '../src/release/protocol.ts'
import { SCHEDULER_ROLE } from '../src/task/protocol.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'

const ENVIRONMENT = 'env-a'
const OTHER_ENVIRONMENT = 'env-b'
const R1 = 'r0001'
const R2 = 'r0002'
const R3 = 'r0003'
const MANIFEST = { skills: ['count-words'] } as const
const OTHER_MANIFEST = { skills: ['count-words', 'bounded-size'] } as const

const ACTOR = 'environment-service'
const PUBLISHER = 'publisher-service'
const APPROVER = 'review-service'
const REVIEWER = 'reviewer-alice'

const SUBJECTS: Readonly<Record<string, string>> = {
  [ENVIRONMENT_ROLE]: ACTOR,
  [PUBLISHER_ROLE]: PUBLISHER,
  [SCHEDULER_ROLE]: 'scheduler-service',
  [APPROVER_ROLE]: APPROVER,
}

let counter = 0
function nextCommand(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

function environmentRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  return registry
}

function emittingLog(subjects: Readonly<Record<string, string>> = SUBJECTS): MemoryLog {
  return new MemoryLog(environmentRegistry(), { subjects })
}

function create(revisionId: string, manifest: unknown, subject = ENVIRONMENT): EmitInput {
  return {
    commandId: nextCommand('create'),
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject,
    payload: { revisionId, manifest },
  }
}

function switched(expected: string, to: string, subject = ENVIRONMENT): EmitInput {
  return {
    commandId: nextCommand('switch'),
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched,
    subject,
    payload: { expected, to },
  }
}

function headOf(log: MemoryLog, subject = ENVIRONMENT): string | undefined {
  return log.stateAt<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, subject, log.count)?.pointer
}

/** A hand-framed environment fact, as a log written by another build looks to a fold. */
function sealed(seq: number, kind: string, payload: unknown, prevDigest: string | null, subject = ENVIRONMENT): Envelope {
  const switchFact = kind === ENVIRONMENT_KINDS.pointerSwitched
  return sealEnvelope({ protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION, kind, subject, commandId: `hand-${seq}`, emitter: switchFact ? PUBLISHER_ROLE : ENVIRONMENT_ROLE, actor: switchFact ? PUBLISHER : ACTOR, at: `2026-10-10T00:00:0${seq}.000Z`, seq, prevDigest, payload })
}

function foldedEnvironment(entries: readonly Envelope[], subject = ENVIRONMENT): EnvironmentState | undefined {
  return foldSubjects<EnvironmentState>(environmentRegistry(), entries, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).get(subject)
}

const deployments: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const entry of deployments.splice(0)) {
    await entry.context.fiber.dispose()
    await rm(entry.root, { recursive: true, force: true })
  }
})

/** One live control store over a real JSONL session, with both protocols the head path needs. */
async function live(): Promise<ControlSessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-pointer-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  deployments.push({ context, root })
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareReleaseProtocol(registry)
  return ControlSessionStore.open({ persistence: context.sessionPersistence, controlId: 'pointer', registry, subjects: SUBJECTS })
}

function environmentStateOf(store: ControlSessionStore, subject = ENVIRONMENT): EnvironmentState | undefined {
  return store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, subject)
}

async function createRevision(store: ControlSessionStore, revisionId: string, manifest: unknown, subject = ENVIRONMENT): Promise<string> {
  await store.emit({ commandId: `create-${subject}-${revisionId}`, protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION, kind: ENVIRONMENT_KINDS.revisionCreated, subject, payload: { revisionId, manifest } })
  const revision = environmentStateOf(store, subject)?.revisions[revisionId]
  if (revision === undefined) throw new Error(`revision ${revisionId} was not created`)
  return revision.contentDigest
}


/** Trusted approval fixture for pointer command and reducer tests. */
async function approve(store: ControlSessionStore, environmentId: string, revisionId: string, digest: string): Promise<void> {
  const draft = await createReleaseCommands({ store }).draft({ commandId: `draft-${environmentId}-${revisionId}`, revision: { environmentId, revisionId, digest } })
  await store.emit({ commandId: `approve-${environmentId}-${revisionId}`, protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION,
    kind: RELEASE_KINDS.approved, subject: environmentId, payload: {
      revisionId, draftDigest: (draft.payload as { draftDigest: string }).draftDigest,
      approvedBy: REVIEWER, approvalId: `review-${environmentId}-${revisionId}`,
    } })
}

function publish(store: ControlSessionStore, to: string, expected = '', environmentId = ENVIRONMENT): Promise<unknown> {
  return createReleaseCommands({ store }).publish({ commandId: `publish-${environmentId}-${to}`, environmentId, expected, to })
}

describe('the pointer is a compare-and-swap, decided by the reducer', () => {
  it('starts empty, and the empty string names the empty head', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    expect(headOf(log)).toBeUndefined()
    await log.emit(switched('', R1))
    expect(headOf(log)).toBe(R1)
  })

  it('refuses a switch whose expected head is no longer the head, and records nothing', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    await log.emit(create(R2, MANIFEST))
    await log.emit(switched('', R1))
    await log.emit(switched(R1, R2))
    // Based on a head that has already moved: the switch is refused, not re-based onto R2.
    const refusal = await asyncRefusalOf(() => log.emit(switched(R1, R2)))
    expect([refusal.code, refusal.detail.includes('"r0001"'), refusal.detail.includes('"r0002"')]).toEqual(['illegal-transition', true, true])
    // Refused, not repaired: the fact is not in the log and the head did not move.
    expect([log.count, headOf(log)]).toEqual([4, R2])
  })

  it('refuses a switch that changes nothing, because a no-op is a mistake rather than a retry', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    await log.emit(switched('', R1))
    const refusal = await asyncRefusalOf(() => log.emit(switched(R1, R1)))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('already the head') })
  })

  it('refuses a head that names a revision this environment never created', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    const refusal = await asyncRefusalOf(() => log.emit(switched('', R3)))
    // The refusal names what does exist, so the missing creation is visible as a missing fact.
    expect([refusal.code, refusal.detail.includes(R3), refusal.detail.includes(R1)]).toEqual(['unknown-revision', true, true])
    expect(headOf(log)).toBeUndefined()
  })

  it('keeps the head when a later revision is created, because creating is not publishing', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    await log.emit(switched('', R1))
    await log.emit(create(R2, MANIFEST))
    expect(headOf(log)).toBe(R1)
  })

  it('moves one environment and never another', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST, ENVIRONMENT))
    await log.emit(create(R1, OTHER_MANIFEST, OTHER_ENVIRONMENT))
    await log.emit(switched('', R1, OTHER_ENVIRONMENT))
    expect([headOf(log, ENVIRONMENT), headOf(log, OTHER_ENVIRONMENT)]).toEqual([undefined, R1])
  })

  it('refuses a payload that is closed or ill-typed rather than guessing a head', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    const bad = (payload: unknown): EmitInput => ({ ...switched('', R1), payload })
    for (const payload of [{ expected: '', to: '' }, { expected: null, to: R1 }, { expected: '', to: R1, generation: 1 }, { expected: '' }])
      expect((await asyncRefusalOf(() => log.emit(bad(payload)))).code).toBe<RefusalCode>('malformed-payload')
  })
})

describe('the fold re-checks the switch, so a log from another build is refused too', () => {
  it('refuses a hand-framed stale switch and keeps the head it did accept', () => {
    const first = sealed(0, ENVIRONMENT_KINDS.revisionCreated, { revisionId: R1, manifest: MANIFEST }, null)
    const second = sealed(1, ENVIRONMENT_KINDS.revisionCreated, { revisionId: R2, manifest: MANIFEST }, first.digest)
    const publish = sealed(2, ENVIRONMENT_KINDS.pointerSwitched, { expected: '', to: R1 }, second.digest)
    const stale = sealed(3, ENVIRONMENT_KINDS.pointerSwitched, { expected: '', to: R2 }, publish.digest)

    const refusal = refusalOf(() => foldedEnvironment([first, second, publish, stale]))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    // The accepted prefix still folds to its own head: nothing was repaired on the way out.
    expect(foldedEnvironment([first, second, publish])?.pointer).toBe(R1)
  })

  it('refuses a hand-framed switch onto an uncreated revision', () => {
    const created = sealed(0, ENVIRONMENT_KINDS.revisionCreated, { revisionId: R1, manifest: MANIFEST }, null)
    const ghost = sealed(1, ENVIRONMENT_KINDS.pointerSwitched, { expected: '', to: R3 }, created.digest)

    expect(refusalOf(() => foldedEnvironment([created, ghost])).code).toBe<RefusalCode>('unknown-revision')
  })

  it('derives the same head from a fresh fold of the recorded facts', async () => {
    const log = emittingLog()
    await log.emit(create(R1, MANIFEST))
    await log.emit(switched('', R1))
    await log.emit(create(R2, MANIFEST))
    await log.emit(switched(R1, R2))
    // A second fold of the same facts, with its own registry: the head is not carried anywhere.
    const refolded = foldedEnvironment(log.entries())
    expect([refolded?.pointer, refolded]).toEqual([R2, log.stateAt<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT, log.count)])
    // And the pointer is not a member of any payload: it is only ever folded from `pointer/switched`.
    const pointerFacts = log.entriesOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).filter(entry => entry.kind === ENVIRONMENT_KINDS.pointerSwitched)
    expect([pointerFacts.length, pointerFacts.every(entry => !Object.hasOwn(entry.payload as object, 'pointer'))]).toEqual([2, true])
  })
})

describe('the command boundary decides the half the reducer cannot see', () => {
  it('refuses a head onto a revision nothing approved, naming which half is missing', async () => {
    const store = await live()
    const digest = await createRevision(store, R1, MANIFEST)
    const commands = createReleaseCommands({ store })
    const publish = (commandId: string) => commands.publish({ commandId, environmentId: ENVIRONMENT, expected: '', to: R1 })

    const undrafted = await asyncRefusalOf(() => publish('publish-undrafted'))
    expect(undrafted).toMatchObject({ code: 'unapproved-revision', detail: expect.stringContaining('no draft is on the table') })
    expect(environmentStateOf(store)?.pointer).toBeUndefined()

    await commands.draft({ commandId: 'draft-1', revision: { environmentId: ENVIRONMENT, revisionId: R1, digest } })
    const unapproved = await asyncRefusalOf(() => publish('publish-unapproved'))
    expect(unapproved).toMatchObject({ code: 'unapproved-revision', detail: expect.stringContaining('carries no approval') })
  })

  it('moves the head onto an approved revision, and the fact is the publisher’s', async () => {
    const store = await live()
    await approve(store, ENVIRONMENT, R1, await createRevision(store, R1, MANIFEST))

    const envelope = await createReleaseCommands({ store }).publish({ commandId: 'publish-1', environmentId: ENVIRONMENT, expected: '', to: R1 })

    expect([envelope.kind, envelope.subject, envelope.emitter, envelope.actor, envelope.payload]).toEqual([ENVIRONMENT_KINDS.pointerSwitched, ENVIRONMENT, PUBLISHER_ROLE, PUBLISHER, { expected: '', to: R1 }])
    expect(environmentStateOf(store)?.pointer).toBe(R1)
    // The head is derived from the log, not stored beside it.
    expect(foldedEnvironment(store.load().entries())?.pointer).toBe(R1)
  })

  it('refuses a head whose approved content this environment does not hold', async () => {
    const store = await live()
    await createRevision(store, R1, MANIFEST)
    // A release this build did not write — an adopted log, or content prepared outside the store and
    // referenced before it existed (U05). The draft names r0001 at content the environment never
    // created, and the reducer cannot see that: only the publish precondition can.
    const forged = releaseDraftOf({ environmentId: ENVIRONMENT, revisionId: R1, digest: digestOf(OTHER_MANIFEST) }, { kind: 'bootstrap' })
    await store.emit({ commandId: 'forged-draft', protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind: RELEASE_KINDS.drafted, subject: ENVIRONMENT, payload: forged })
    await store.emit({ commandId: 'forged-approval', protocol: RELEASE_PROTOCOL, version: RELEASE_VERSION, kind: RELEASE_KINDS.approved, subject: ENVIRONMENT, payload: { revisionId: forged.revisionId, draftDigest: forged.draftDigest, approvedBy: REVIEWER, approvalId: 'audit-forged' } })

    const refusal = await asyncRefusalOf(() => publish(store, R1))
    expect(refusal).toMatchObject({ code: 'unknown-revision', detail: expect.stringContaining(ENVIRONMENT) })
    // Without the content half the reducer's own existence check would pass, and the head would name
    // this environment's r0001 at content nobody approved.
    expect(environmentStateOf(store)?.pointer).toBeUndefined()
  })

  it('refuses a head onto a revision other than the one the approval names, at identical content', async () => {
    const store = await live()
    const digest = await createRevision(store, R1, MANIFEST)
    // Two ids, one content: legal, because `revision/created` refuses only the same id at different
    // content — and the reason the digest alone is not the binding the approval makes.
    await createRevision(store, R2, MANIFEST)
    await approve(store, ENVIRONMENT, R1, digest)

    const refusal = await asyncRefusalOf(() => publish(store, R2))
    expect(refusal).toMatchObject({ code: 'unapproved-revision', detail: expect.stringContaining(R1) })
    expect(environmentStateOf(store)?.pointer).toBeUndefined()
  })

  it('lets exactly one of two concurrent switches with one expected head commit', async () => {
    const store = await live()
    await approve(store, ENVIRONMENT, R1, await createRevision(store, R1, MANIFEST))
    const commands = createReleaseCommands({ store })

    // One environment has one standing approval, so two publishers race on the same head and the
    // same target: the compare-and-swap is the only thing that decides, and it decides once.
    const results = await Promise.allSettled([
      commands.publish({ commandId: 'publish-a', environmentId: ENVIRONMENT, expected: '', to: R1 }),
      commands.publish({ commandId: 'publish-b', environmentId: ENVIRONMENT, expected: '', to: R1 }),
    ])

    const won = results.filter((result): result is PromiseFulfilledResult<Envelope> => result.status === 'fulfilled')
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect([won.length, lost.length]).toEqual([1, 1])
    expect(lost[0]?.reason?.refusal?.code).toBe<RefusalCode>('illegal-transition')
    // One fact, one head, and it is the winner's target: the loser was refused, not re-based.
    const pointerFacts = store.load().entriesOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).filter(entry => entry.kind === ENVIRONMENT_KINDS.pointerSwitched)
    expect([pointerFacts.length, pointerFacts[0]?.commandId]).toEqual([1, won[0]?.value.commandId])
    expect(environmentStateOf(store)?.pointer).toBe((won[0]?.value.payload as { to: string }).to)
  })
})

describe('environment@2 is the one conditional owner, and version 1 is refused by name', () => {
  it('declares the switch as conditional and atomic, both kinds at version 2, nothing at version 1', () => {
    const registry = environmentRegistry()
    expect(registry.ruleFor(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT_KINDS.pointerSwitched).guarantees).toEqual({ appended: true, conditional: true, atomicFact: true })
    expect(registry.conditionalOwner()).toBe(ENVIRONMENT_PROTOCOL)
    expect(registry.versionsOf(ENVIRONMENT_PROTOCOL)).toEqual([2])
    expect(registry.kindsOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION)).toEqual([...Object.values(ENVIRONMENT_KINDS)].sort())
    // Named: the refusal says which version *is* declared, so "upgrade or stay" is actionable.
    const refusal = refusalOf(() => registry.ruleFor(ENVIRONMENT_PROTOCOL, 1, ENVIRONMENT_KINDS.revisionCreated))
    expect([refusal.code, refusal.detail.includes('declared at 2'), refusal.detail.includes('version 1')]).toEqual(['version-mismatch', true, true])
  })
})

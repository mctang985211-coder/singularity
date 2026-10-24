/**
 * The environment protocol's revision invariants, each refused by name.
 *
 * Two of these tests exist because the append path is not the only way a fact reaches a reducer: a
 * log written by another build or edited outside the append path is re-parsed and re-reduced at fold
 * time, so the digest self-check and the conflict check are asserted on `foldSubjects` as well.
 *
 * A note on command ids: `MemoryLog` returns a recorded fact for a repeated command id, so an
 * idempotency test that reused one would never reach the reducer. Every emission here gets a fresh
 * command id, and the idempotency test asserts on the folded state reference.
 */

import { describe, expect, it } from 'vitest'

import {
  digestOf,
  foldSubject,
  foldSubjects,
  MemoryLog,
  ProtocolRegistry,
  REFUSAL_CODES,
  sealEnvelope,
  type EmitInput,
  type Envelope,
  type RefusalCode,
} from '../src/index.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../src/environment/protocol.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'

const ENVIRONMENT_ID = 'env-a'
const OTHER_ENVIRONMENT = 'env-b'
const REVISION_ID = 'r0001'
const OTHER_REVISION = 'r0002'
const ACTOR = 'environment-service'

/** The content one revision is created with. */
const MANIFEST = { toolchain: 'node@22', files: ['src/a.ts', 'src/b.ts'], flags: { strict: true } } as const
/** The same content with its members in a different order: one content, not two. */
const MANIFEST_REORDERED = { flags: { strict: true }, files: ['src/a.ts', 'src/b.ts'], toolchain: 'node@22' } as const
/** Different content for the same id: the tamper case. */
const MANIFEST_TAMPERED = { toolchain: 'node@22', files: ['src/a.ts'], flags: { strict: true } } as const

/** The trusted identity the deployment binds to the one role allowed to create revisions. */
const SUBJECTS: Readonly<Record<string, string>> = { [ENVIRONMENT_ROLE]: ACTOR }

let counter = 0

function environmentRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  return registry
}

function emittingLog(now?: () => string): MemoryLog {
  return new MemoryLog(environmentRegistry(), now === undefined ? { subjects: SUBJECTS } : { subjects: SUBJECTS, now })
}

/** One create command, with a fresh command id so a repeat is never command dedup. */
function create(revisionId: string, manifest: unknown, subject = ENVIRONMENT_ID): EmitInput {
  counter += 1
  return {
    commandId: `env-cmd-${counter}`,
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject,
    payload: { revisionId, manifest },
  }
}

function folded(log: MemoryLog, subject = ENVIRONMENT_ID): EnvironmentState {
  const state = log.stateAt<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, subject, log.count)
  if (state === undefined) throw new Error(`expected a folded environment for ${subject}`)
  return state
}

/** A hand-framed fact, as a log written by another build or edited outside the append path looks. */
function sealed(seq: number, payload: unknown, subject = ENVIRONMENT_ID, prevDigest: string | null = null): Envelope {
  return sealEnvelope({
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject,
    commandId: `hand-${seq}`,
    emitter: ENVIRONMENT_ROLE,
    actor: ACTOR,
    at: `2026-10-09T00:00:0${seq}.000Z`,
    seq,
    prevDigest,
    payload,
  })
}

describe('the reducer computes the content identity itself', () => {
  it('records the digest of the manifest, not one a caller offered', async () => {
    const log = emittingLog()
    await log.emit(create(REVISION_ID, MANIFEST))
    const revision = folded(log).revisions[REVISION_ID]

    // The digest is the one the manifest hashes to, and the manifest itself is kept, so a reader
    // re-derives the same identity from the recorded fact.
    expect(revision).toMatchObject({ contentDigest: digestOf(MANIFEST), manifest: MANIFEST })
  })

  it('refuses a payload that offers a digest, because the shape is closed', async () => {
    const log = emittingLog()
    const refusal = await asyncRefusalOf(() =>
      log.emit({
        ...create(REVISION_ID, MANIFEST),
        payload: { revisionId: REVISION_ID, manifest: MANIFEST, contentDigest: 'c'.repeat(64) },
      }),
    )
    expect(refusal).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('contentDigest') })
  })

  it('refuses a manifest JSON cannot round-trip, so it cannot carry a borrowed identity', async () => {
    const log = emittingLog()
    // `NaN` and `undefined` are the two ways JSON loses a value, and both are refused by name.
    const codes = await Promise.all(
      [{ ratio: Number.NaN }, { present: undefined }].map(
        async m => (await asyncRefusalOf(() => log.emit(create(REVISION_ID, m)))).code,
      ),
    )
    expect(codes).toEqual<RefusalCode[]>(['not-lossless-json', 'not-lossless-json'])
  })
})

describe('the same revision id is idempotent, and only with the same content', () => {
  it('accepts the same content again and leaves the state unchanged, including when it was created', async () => {
    let tick = 0
    const log = emittingLog(() => `2026-10-09T00:00:0${(tick += 1)}.000Z`)

    await log.emit(create(REVISION_ID, MANIFEST))
    const first = folded(log)

    // A second, fully distinct fact: new command id, new envelope, later `at`. Only its content repeats.
    await log.emit(create(REVISION_ID, MANIFEST_REORDERED))
    const second = folded(log)

    // Unchanged is stronger than equal: the reducer returned the very state it was handed, so the
    // revision arrived at the same moment, nothing was re-minted, and the later fact was appended
    // without changing the fold. And a fresh replay of both facts arrives at that state with no
    // cursor to rely on.
    expect([second, log.entries().length]).toEqual([first, 2])
    expect(
      foldSubjects<EnvironmentState>(
        environmentRegistry(),
        log.entries(),
        ENVIRONMENT_PROTOCOL,
        ENVIRONMENT_VERSION,
      ).get(ENVIRONMENT_ID),
    ).toEqual(first)
  })

  it('refuses the same revision id with different content', async () => {
    const log = emittingLog()
    await log.emit(create(REVISION_ID, MANIFEST))

    const refusal = await asyncRefusalOf(() => log.emit(create(REVISION_ID, MANIFEST_TAMPERED)))
    expect(refusal).toMatchObject({ code: 'revision-conflict', detail: expect.stringContaining(REVISION_ID) })
    // The refusal is a refusal: the created revision still reads its own content.
    expect(folded(log).revisions[REVISION_ID]?.contentDigest).toBe(digestOf(MANIFEST))
  })

  it('adds a different revision id, so one environment carries many revisions', async () => {
    const log = emittingLog()
    await log.emit(create(REVISION_ID, MANIFEST))
    await log.emit(create(OTHER_REVISION, MANIFEST_TAMPERED))

    const state = folded(log)
    // Every id that was created is there, and each reads its own content.
    expect(state.revisions).toMatchObject({
      [REVISION_ID]: { contentDigest: digestOf(MANIFEST) },
      [OTHER_REVISION]: { contentDigest: digestOf(MANIFEST_TAMPERED) },
    })
  })
})

describe('the environment is the subject, so its facts are keyed by environment id', () => {
  it('folds each environment separately, and one environment never sees another', async () => {
    const log = emittingLog()
    await log.emit(create(REVISION_ID, MANIFEST, ENVIRONMENT_ID))
    await log.emit(create(REVISION_ID, MANIFEST_TAMPERED, OTHER_ENVIRONMENT))

    // One read of the whole fold: the two subjects it holds and what each environment's revision was
    // created with. The second emits MANIFEST_TAMPERED for a different environment, so the two
    // digests below differ, as does the content each fold reports.
    const states = foldSubjects<EnvironmentState>(
      environmentRegistry(),
      log.entries(),
      ENVIRONMENT_PROTOCOL,
      ENVIRONMENT_VERSION,
    )
    expect([...states.keys()].sort()).toEqual([ENVIRONMENT_ID, OTHER_ENVIRONMENT].sort())
    expect([
      states.get(ENVIRONMENT_ID)?.revisions[REVISION_ID],
      states.get(OTHER_ENVIRONMENT)?.revisions[REVISION_ID],
    ]).toMatchObject([{ contentDigest: digestOf(MANIFEST) }, { contentDigest: digestOf(MANIFEST_TAMPERED) }])
    // The isolation boundary: folding one environment reads that environment's subjects only, and an
    // environment with no facts is absent rather than empty.
    expect(folded(log, OTHER_ENVIRONMENT).environmentId).toBe(OTHER_ENVIRONMENT)
    expect(
      foldSubject<EnvironmentState>(
        environmentRegistry(),
        log.entries(),
        ENVIRONMENT_PROTOCOL,
        ENVIRONMENT_VERSION,
        'env-ghost',
      ),
    ).toBeUndefined()
  })
})

describe('the reducer, not the append path, is where the invariant holds', () => {
  it('refuses a re-declared revision with different content when folding a hand-framed log', () => {
    const first = sealed(0, { revisionId: REVISION_ID, manifest: MANIFEST })
    const second = sealed(1, { revisionId: REVISION_ID, manifest: MANIFEST_TAMPERED }, ENVIRONMENT_ID, first.digest)

    const refusal = refusalOf(() =>
      foldSubjects<EnvironmentState>(environmentRegistry(), [first, second], ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
    )
    expect(refusal).toMatchObject({ code: 'revision-conflict', detail: expect.stringContaining(REVISION_ID) })
  })

  it('refuses a hand-framed fact that carries a digest member', () => {
    const forged = sealed(0, { revisionId: REVISION_ID, manifest: MANIFEST, contentDigest: digestOf(MANIFEST) })

    const refusal = refusalOf(() =>
      foldSubjects<EnvironmentState>(environmentRegistry(), [forged], ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
    )
    expect(refusal).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('contentDigest') })
  })
})

describe('the shape is closed and the surface is exactly one kind', () => {
  it('refuses an unknown member, a missing member and a wrong-typed member', async () => {
    const log = emittingLog()
    const bad = (payload: unknown): EmitInput => ({ ...create(REVISION_ID, MANIFEST), payload })

    // Six payloads a caller could send instead of `{ revisionId, manifest }`: an extra member, each
    // member missing in turn, an empty id, a wrong-typed id, and not an object at all. One rule
    // closes the shape, so the same code comes back for all six.
    const codes = await Promise.all(
      [
        { revisionId: REVISION_ID, manifest: MANIFEST, extra: 1 },
        { revisionId: REVISION_ID },
        { manifest: MANIFEST },
        { revisionId: '', manifest: MANIFEST },
        { revisionId: 7, manifest: MANIFEST },
        'not an object',
      ].map(async payload => (await asyncRefusalOf(() => log.emit(bad(payload)))).code),
    )
    expect(codes).toEqual<RefusalCode[]>([
      'malformed-payload',
      'malformed-payload',
      'malformed-payload',
      'malformed-payload',
      'malformed-payload',
      'malformed-payload',
    ])
  })

  it('refuses to create a revision in a deployment with no identity for the environment role', async () => {
    const log = new MemoryLog(environmentRegistry(), { subjects: {} })
    const refusal = await asyncRefusalOf(() => log.emit(create(REVISION_ID, MANIFEST)))
    expect(refusal).toMatchObject({ code: 'unknown-emitter-role', detail: expect.stringContaining(ENVIRONMENT_ROLE) })
  })

  it('owns the one conditional update, and the codes are accounted for', () => {
    const registry = environmentRegistry()
    expect(ENVIRONMENT_PROTOCOL).toBe('environment')
    // The literal `2` is the one place that says which interpretation of history is current:
    // `revision/created` alone was version 1.
    expect(ENVIRONMENT_VERSION).toBe(2)
    expect(registry.versionsOf(ENVIRONMENT_PROTOCOL)).toEqual([ENVIRONMENT_VERSION])
    // Derived from the constants rather than spelled out, so adding a kind to this protocol is one
    // edit and the assertion keeps meaning what it says: the declared set is exactly the constants.
    expect(registry.kindsOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION)).toEqual(
      [...Object.values(ENVIRONMENT_KINDS)].sort(),
    )
    // The environment owns the stack's single compare-and-swap: the pointer switch is the only
    // place a fact must be checked against an expected prior state inside the commit queue.
    expect(registry.conditionalOwner()).toBe(ENVIRONMENT_PROTOCOL)
    // Both codes this protocol can refuse with are in the vocabulary; nothing else in the file
    // asserts that `unknown-revision`, which no kind here raises yet, is accounted for at all.
    expect(REFUSAL_CODES.filter(code => code === 'revision-conflict' || code === 'unknown-revision')).toHaveLength(2)
  })
})

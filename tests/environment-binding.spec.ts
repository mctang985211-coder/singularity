/**
 * Resolving a run's pin against the revisions the log created.
 *
 * The revision is a fact of the environment's subject and the run is a fact of its task's subject,
 * so no reducer sees both. That seam is a projection, and every way a pin can fail to resolve is
 * the same named refusal: `unknown-revision`. A projection that skipped an unbindable run would
 * return a list that reads as complete, so the first failure refuses the whole call.
 *
 * Every map under test is a fold of facts a `MemoryLog` accepted: no test hand-writes an
 * `EnvironmentState` the reducer would not have produced.
 */

import { describe, expect, it } from 'vitest'

import { digestOf, foldSubjects, MemoryLog, ProtocolRegistry, type EmitInput } from '../src/index.ts'
import { assertPinnedRevision, projectBindings } from '../src/environment/binding.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../src/environment/protocol.ts'
import { refusalOf } from './fixtures.ts'

const ENVIRONMENT_ID = 'env-a'
const OTHER_ENVIRONMENT = 'env-b'
const REVISION_ID = 'r0001'
const OTHER_REVISION = 'r0002'
const WHERE = 'run "run-1"'

const MANIFEST = { toolchain: 'node@22', files: ['src/a.ts'] } as const
const OTHER_MANIFEST = { toolchain: 'node@20', files: ['src/a.ts'] } as const

const SUBJECTS: Readonly<Record<string, string>> = { [ENVIRONMENT_ROLE]: 'environment-service' }

let counter = 0
/** The time stamped on the envelope that created `r0001` of `env-a` — read from the fact, not assumed. */
let createdAt = ''

function create(revisionId: string, manifest: unknown, subject: string): EmitInput {
  counter += 1
  return {
    commandId: `binding-cmd-${counter}`,
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject,
    payload: { revisionId, manifest },
  }
}

/**
 * The state a caller actually holds: two environments, each with its own content under the same
 * revision id `r0001` — so a pin that names the right id in the wrong environment is still wrong.
 */
async function environments(): Promise<ReadonlyMap<string, EnvironmentState>> {
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  const log = new MemoryLog(registry, { subjects: SUBJECTS })
  createdAt = (await log.emit(create(REVISION_ID, MANIFEST, ENVIRONMENT_ID))).at
  await log.emit(create(OTHER_REVISION, OTHER_MANIFEST, ENVIRONMENT_ID))
  await log.emit(create(REVISION_ID, OTHER_MANIFEST, OTHER_ENVIRONMENT))
  return foldSubjects<EnvironmentState>(registry, log.entries(), ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION)
}

const pinned = { environmentId: ENVIRONMENT_ID, revisionId: REVISION_ID, digest: digestOf(MANIFEST) }

describe('resolving one pin', () => {
  it('returns the created revision, whose manifest the caller never supplied', async () => {
    const revision = assertPinnedRevision(pinned, await environments(), WHERE)

    expect([revision.revisionId, revision.contentDigest, revision.manifest]).toEqual([
      REVISION_ID,
      digestOf(MANIFEST),
      MANIFEST,
    ])
  })

  it('returns it at the time its creating fact was stamped with, not merely at some time', async () => {
    const revision = assertPinnedRevision(pinned, await environments(), WHERE)

    expect(revision.at).toBe(createdAt)
  })

  it('refuses a pin on an environment no revision/created fact created', async () => {
    const map = await environments()
    const refusal = refusalOf(() => assertPinnedRevision({ ...pinned, environmentId: 'env-ghost' }, map, WHERE))
    // The refusal says what does exist, so a missing creation is visible as a missing fact.
    expect([refusal.code, refusal.detail.includes('env-ghost'), refusal.detail.includes(ENVIRONMENT_ID)]).toEqual([
      'unknown-revision',
      true,
      true,
    ])
  })

  it('refuses a pin on a revision id the environment never created', async () => {
    const map = await environments()
    const refusal = refusalOf(() => assertPinnedRevision({ ...pinned, revisionId: 'r9999' }, map, WHERE))
    expect([refusal.code, refusal.detail.includes('r9999'), refusal.detail.includes(OTHER_REVISION)]).toEqual([
      'unknown-revision',
      true,
      true,
    ])
  })

  it('refuses a pin whose digest is not the created content, even when the id exists', async () => {
    const map = await environments()
    const refusal = refusalOf(() => assertPinnedRevision({ ...pinned, digest: 'c'.repeat(64) }, map, WHERE))
    expect([
      refusal.code,
      refusal.detail.includes(REVISION_ID),
      refusal.detail.includes(digestOf(MANIFEST).slice(0, 12)),
    ]).toEqual(['unknown-revision', true, true])
  })

  it('refuses a pin that names the right revision id in the wrong environment', async () => {
    const map = await environments()
    // Both environments hold an `r0001`, with different content, so the pinned digest cannot resolve.
    const refusal = refusalOf(() =>
      assertPinnedRevision(
        { environmentId: OTHER_ENVIRONMENT, revisionId: REVISION_ID, digest: digestOf(MANIFEST) },
        map,
        WHERE,
      ),
    )
    expect(refusal).toMatchObject({ code: 'unknown-revision', detail: expect.stringContaining(OTHER_ENVIRONMENT) })
  })

  it('treats inherited member names as unknown revisions rather than as content', async () => {
    const map = await environments()
    const refusal = refusalOf(() => assertPinnedRevision({ ...pinned, revisionId: 'constructor' }, map, WHERE))
    expect(refusal).toMatchObject({ code: 'unknown-revision', detail: expect.stringContaining('constructor') })
  })
})

describe('projecting many runs', () => {
  it('projects each run onto the content digest that was actually created', async () => {
    const map = await environments()
    const runs = [
      { purpose: 'solve', runId: 'run-1', revision: pinned },
      {
        purpose: 'solve',
        runId: 'run-2',
        revision: { environmentId: ENVIRONMENT_ID, revisionId: OTHER_REVISION, digest: digestOf(OTHER_MANIFEST) },
      },
    ]

    expect(projectBindings(runs, map)).toEqual([
      { runId: 'run-1', environmentId: ENVIRONMENT_ID, revisionId: REVISION_ID, contentDigest: digestOf(MANIFEST) },
      {
        runId: 'run-2',
        environmentId: ENVIRONMENT_ID,
        revisionId: OTHER_REVISION,
        contentDigest: digestOf(OTHER_MANIFEST),
      },
    ])
  })

  it('projects nothing from nothing', async () => {
    expect(projectBindings([], await environments())).toEqual([])
  })

  it('refuses the whole projection on the first unbindable run, naming that run', async () => {
    const map = await environments()
    const runs = [
      { purpose: 'solve', runId: 'run-1', revision: pinned },
      {
        purpose: 'solve',
        runId: 'run-2',
        revision: { environmentId: ENVIRONMENT_ID, revisionId: 'r9999', digest: 'c'.repeat(64) },
      },
      {
        purpose: 'solve',
        runId: 'run-3',
        revision: { environmentId: ENVIRONMENT_ID, revisionId: OTHER_REVISION, digest: digestOf(OTHER_MANIFEST) },
      },
    ]

    const refusal = refusalOf(() => projectBindings(runs, map))
    // Named: the unbindable run is refused, not dropped from a list that looks complete.
    expect(refusal).toMatchObject({ code: 'unknown-revision', detail: expect.stringContaining('run-2') })
  })
})

/**
 * The environment revision command: the deployment's one way to mint a revision.
 *
 * The reducer owns both rules — the digest is computed from the content, and one revision id names
 * exactly one content — so what this spec pins is the command's externally visible half: the fact it
 * produces, and that a repeat through the command leaves the fold alone while a tamper is refused.
 */

import { describe, expect, it } from 'vitest'

import {
  createEnvironmentCommands,
  digestOf,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentCommands,
  type EnvironmentState,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { deployment, ENVIRONMENT, REVISION, type Deployment } from './command-fixtures.ts'

const MANIFEST = { skills: ['count'], tools: [] } as const
/** The same content with its members in a different order: one content, not two. */
const SAME_CONTENT = { tools: [], skills: ['count'] } as const
const TAMPERED = { skills: ['count', 'units'], tools: [] } as const

function environmentOf(live: Deployment): EnvironmentState | undefined {
  return live.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)
}

describe('the environment revision command', () => {
  it('creates one revision whose content identity the reducer computes from the manifest', async () => {
    const live = await deployment()

    const created = await createEnvironmentCommands({ store: live.store, registry: live.registry }).createRevision({
      commandId: 'revision',
      environmentId: ENVIRONMENT,
      revisionId: REVISION,
      manifest: MANIFEST,
    })

    expect([created.kind, environmentOf(live)?.revisions[REVISION]?.contentDigest]).toEqual([ENVIRONMENT_KINDS.revisionCreated, digestOf(MANIFEST)])
  })

  it('accepts the same content again under the same revision id, leaving the fold as it was', async () => {
    const live = await deployment()
    const commands: EnvironmentCommands = createEnvironmentCommands({ store: live.store, registry: live.registry })
    await commands.createRevision({ commandId: 'revision', environmentId: ENVIRONMENT, revisionId: REVISION, manifest: MANIFEST })
    const first = environmentOf(live)

    // A second, fully distinct fact that repeats only the content: the command accepts it and the
    // revision still reads what it read, at the moment it was first created.
    await commands.createRevision({ commandId: 'revision-again', environmentId: ENVIRONMENT, revisionId: REVISION, manifest: SAME_CONTENT })

    expect([live.store.load().entries().length, environmentOf(live)]).toEqual([2, first])
  })

  it('refuses different content for a revision id that already exists, and records nothing', async () => {
    const live = await deployment()
    const commands = createEnvironmentCommands({ store: live.store, registry: live.registry })
    await commands.createRevision({ commandId: 'revision', environmentId: ENVIRONMENT, revisionId: REVISION, manifest: MANIFEST })

    const refusal = await asyncRefusalOf(() =>
      commands.createRevision({ commandId: 'revision-tampered', environmentId: ENVIRONMENT, revisionId: REVISION, manifest: TAMPERED }),
    )
    expect([refusal.code, live.store.load().entries().length, environmentOf(live)?.revisions[REVISION]?.manifest]).toEqual([
      'revision-conflict',
      1,
      MANIFEST,
    ])
  })
})

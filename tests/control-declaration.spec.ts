/**
 * The one role table, extended after open.
 *
 * Web agents are minted while a deployment runs, so the roster cannot be complete at `open`. The
 * table is still the store's: a declaration must land in the very table the log stamps from, or a
 * role would resolve for a reader and not for the append path that stamps the actor.
 */

import { describe, expect, it } from 'vitest'

import {
  createEnvironmentCommands,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../src/index.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import { deployment, ENVIRONMENT, MANIFEST, REVISION } from './command-fixtures.ts'
import { SCHEDULER } from './task-fixtures.ts'

const IDENTITY = 'environment-service'

describe('a deployment may declare a role after open, and only one identity per role', () => {
  it('resolves an identity declared after open, and the next fact is stamped with it', async () => {
    const live = await deployment({ scheduler: SCHEDULER })
    const commands = createEnvironmentCommands({ store: live.store, registry: live.registry })
    const request = { commandId: 'revision', environmentId: ENVIRONMENT, revisionId: REVISION, manifest: MANIFEST }

    // The role is not in the table yet, so no fact of its could be stamped — and the refused command
    // reserved nothing, which is why the same command id is usable once the role is declared.
    const before = await asyncRefusalOf(() => commands.createRevision(request))

    live.store.declareSubject(ENVIRONMENT_ROLE, IDENTITY)
    const created = await commands.createRevision(request)

    expect([before.code, created.actor]).toEqual(['unknown-emitter-role', IDENTITY])
    expect(
      live.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)?.revisions[
        REVISION
      ],
    ).toBeDefined()
  })

  it('is a no-op when the same key is declared again with the same identity', async () => {
    const live = await deployment()
    live.store.declareSubject(ENVIRONMENT_ROLE, IDENTITY)

    const created = await createEnvironmentCommands({ store: live.store, registry: live.registry }).createRevision({
      commandId: 'revision',
      environmentId: ENVIRONMENT,
      revisionId: REVISION,
      manifest: MANIFEST,
    })

    // Unchanged, and still the identity the table already held: a re-declaration neither refuses nor
    // re-points the key, and the log stamps the same actor it would have.
    expect([live.store.identityOf(ENVIRONMENT_ROLE), created.actor, created.kind]).toEqual([
      IDENTITY,
      IDENTITY,
      ENVIRONMENT_KINDS.revisionCreated,
    ])
  })

  it('refuses the same key with a different identity, and keeps the identity it had', async () => {
    const live = await deployment()
    live.store.declareSubject(ENVIRONMENT_ROLE, IDENTITY)

    const refusal = refusalOf(() => live.store.declareSubject(ENVIRONMENT_ROLE, 'somebody-else'))

    expect([refusal.code, live.store.identityOf(ENVIRONMENT_ROLE)]).toEqual(['malformed-declaration', IDENTITY])
  })

  it('refuses an empty key or an empty identity', async () => {
    const live = await deployment()

    expect([
      refusalOf(() => live.store.declareSubject('', IDENTITY)).code,
      refusalOf(() => live.store.declareSubject('role-x', '')).code,
    ]).toEqual(['malformed-declaration', 'malformed-declaration'])
  })
})

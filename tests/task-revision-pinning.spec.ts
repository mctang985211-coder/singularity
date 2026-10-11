/**
 * A newer revision does not move a run that is already pinned.
 *
 * The pin is a fact about when a run started, so it must not be a pointer that later revisions
 * drag along - and because a revision is recorded on the environment's own subject, a revision
 * fact cannot even reach a run's pin. This spec observes both halves: the in-flight run keeps its
 * revision, a later run may explicitly choose the newer one, and the newer one cannot be a silent
 * replacement of the older content under the same id.
 */

import { describe, expect, it } from 'vitest'

import {
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
  type RefusalCode,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { createRevision, deployment, ENVIRONMENT, openAgent, PARENT, pin, planned } from './command-fixtures.ts'

describe('a revision is chosen when a run starts, and never moved afterwards', () => {
  it('keeps the in-flight run on its own revision and lets a later run choose the newer one', async () => {
    const live = await deployment()
    await openAgent(live)
    await createRevision(live)
    const commands = await planned(live)

    const firstPin = pin(live)
    await commands.startRun({ commandId: 'r-old', taskId: PARENT, runId: 'run-old', revision: firstPin })

    // A second revision, created through the environment's own protocol.
    await live.store.emit({
      commandId: 'revision-2',
      protocol: ENVIRONMENT_PROTOCOL,
      version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.revisionCreated,
      subject: ENVIRONMENT,
      payload: { revisionId: 'r0002', manifest: { skills: ['count-words', 'bound-size'] } },
    })
    const secondDigest = live.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)?.revisions['r0002']?.contentDigest
    if (secondDigest === undefined) throw new Error('the second revision was not created')
    expect(secondDigest).not.toBe(firstPin.digest)

    // The run that was already pinned is untouched: its pin records when it started.
    expect(live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PARENT)?.runs?.['run-old']?.revision).toEqual(firstPin)

    // A later run may choose the newer revision, explicitly, and is recorded with that choice.
    await commands.failRun({ commandId: 'end-old', taskId: PARENT, runId: 'run-old', reason: 'attempt complete' })
    await commands.startRun({
      commandId: 'r-new',
      taskId: PARENT,
      runId: 'run-new',
      revision: { environmentId: ENVIRONMENT, revisionId: 'r0002', digest: secondDigest },
    })
    expect(live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PARENT)?.runs?.['run-new']?.revision).toEqual({ environmentId: ENVIRONMENT, revisionId: 'r0002', digest: secondDigest })

    // And the same revision id cannot be re-pointed at different content, so "the newer revision"
    // can never be a silent replacement of what an older run was pinned to.
    const conflict = await asyncRefusalOf(() =>
      live.store.emit({
        commandId: 'revision-2-overwrite',
        protocol: ENVIRONMENT_PROTOCOL,
        version: ENVIRONMENT_VERSION,
        kind: ENVIRONMENT_KINDS.revisionCreated,
        subject: ENVIRONMENT,
        payload: { revisionId: 'r0002', manifest: { skills: ['something', 'else'] } },
      }),
    )
    expect(conflict.code).toBe<RefusalCode>('revision-conflict')
  })
})

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Diagnosis } from '../../../task/src/index.ts'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'
import { harness, ROOT_SESSION, STORE } from './orchestrate.fixture.ts'

/**
 * The explicit trial of one candidate through the recovery entry (plan §2:
 * "显式试用通过 trialCandidateRef 绑定候选，记录试用身份；不会推进正式生效版本").
 * A `RootRecoveryRequest` that names a candidate revision opens the next business
 * Run on the candidate's bytes while the pointer stays where it was; a trial that
 * names the effective revision, or one the library does not hold, is refused by
 * name with nothing written.
 *
 * The runtime entries are real end to end — intake, drafts, freeze, recovery —
 * over the fixture whose only stub is the spawned worker; every assertion reads
 * the store's own snapshot or the bytes on disk.
 */

const SKILL = (body: string): string =>
  `---\nname: explore-metrics\ndescription: Explore a useful metric from task evidence.\n---\n${body}\n`

let home: string

beforeEach(() => {
  home = pinSkillHome('task-execution')
})

afterEach(async () => {
  releaseSkillHomes()
  await rm(home, { recursive: true, force: true })
})

function libraryRoot(): string {
  return join(home, 'singularity', 'environments', ROOT_SESSION)
}

function diagnosis(diagnosisId: string, taskId: string): Diagnosis {
  return {
    diagnosisId,
    taskId,
    observedFailure: 'the delivered answer did not hold',
    scope: 'the root goal of this store',
    localizedCause: 'the method the run followed was wrong',
    evidenceRefs: [`${taskId}#no-run`],
    reviewRefs: [],
    confidence: 'high',
    proposals: [],
  }
}

/** One round: v1 published and active, the root run pinned to it and settled failed, the candidate v2 frozen as `c-d0002`. */
async function storeWithCandidate(h: ReturnType<typeof harness>) {
  // v1 is published and becomes the active revision the root Run consumes.
  const stagedV1 = await h.runtime.libraryWrite(ROOT_SESSION, {
    kind: 'skill', name: 'explore-metrics', skillMd: SKILL('Library method v1'), expectedVersion: 0,
  })
  const published = await h.runtime.publishRevision(ROOT_SESSION, {
    direction: 'publish',
    source: { kind: 'draft', draftId: stagedV1.draftId },
    expected: { revisionId: 'r0001', generation: 1 },
    actor: ROOT_SESSION,
  })
  expect(published.pointer.revisionId).toBe('c-d0001')

  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
    objective: 'Deliver a checked result',
    requiredCapabilities: ['execute-task', 'method:explore-metrics'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'The result is delivered', command: 'true' }],
  })
  if (activated.status !== 'activated') throw new Error(activated.detail)
  expect((await h.task.runIn(STORE, activated.runId)).environmentRevisionId).toBe('c-d0001')

  // v2 is frozen as a candidate: nothing publishes it.
  const stagedV2 = await h.runtime.libraryWrite(ROOT_SESSION, {
    kind: 'skill', name: 'explore-metrics', skillMd: SKILL('Candidate method v2'), expectedVersion: 1,
  })
  const frozen = await h.runtime.freezeDraft(ROOT_SESSION, stagedV2.draftId)
  expect(frozen.manifest.revisionId).toBe('c-d0002')

  // The first round failed; the diagnosis the recovery names is on the store.
  await h.task.markRunStatusIn(STORE, activated.taskId, activated.runId, 'failed', 'test', { reason: 'the answer did not hold' })
  await h.task.recordDiagnosisIn(STORE, diagnosis('d-1', activated.taskId), 'test')
  return { taskId: activated.taskId, runId: activated.runId }
}

function trialRequest(taskId: string, runId: string, trialCandidateRef: string, requestKey = 'k-1') {
  return { sourceTaskId: taskId, sourceRunId: runId, sourceDiagnosisId: 'd-1', requestKey, trialCandidateRef }
}

describe('a recovery attempt under an explicit trial', () => {
  test('binds the candidate bytes and records the trial identity, and the pointer does not move', async () => {
    const h = harness()
    const { taskId, runId } = await storeWithCandidate(h)

    const outcome = await h.runtime.recoverRootTask(STORE, trialRequest(taskId, runId, 'c-d0002'), { sessionId: ROOT_SESSION })
    expect(outcome.attempt).toBe('started')

    const trial = await h.task.runIn(STORE, outcome.runId)
    // The Run pins the revision it was admitted against and names the candidate
    // it trials; the binding says the bytes came from the candidate.
    expect(trial.environmentRevisionId).toBe('c-d0001')
    expect(trial.trialCandidateRef).toBe('c-d0002')
    expect(trial.providerBinding?.environmentRevisionId).toBe('c-d0002')
    expect(trial.providerBinding?.trialCandidateRef).toBe('c-d0002')
    expect(await readFile(join(trial.providerBinding!.snapshotRoot!, 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(
      SKILL('Candidate method v2'),
    )
    expect(trial.taskTemplatesRoot).toBe(join(libraryRoot(), 'revisions', 'c-d0002', 'task-templates'))

    // The trial is part of the attempt's identity: the same key with another
    // candidate is a different request, and the same request answers the attempt.
    const again = await h.runtime.recoverRootTask(STORE, trialRequest(taskId, runId, 'c-d0002'), { sessionId: ROOT_SESSION })
    expect(again.attempt).toBe('existing')
    expect(again.runId).toBe(outcome.runId)

    // The pointer never moved: the active revision is still the published one.
    const view = await h.runtime.libraryRead(ROOT_SESSION)
    expect(view).toMatchObject({ revisionId: 'c-d0001', generation: 2 })
    await h.runtime.unload()
  })

  test('a trial that names the effective revision, or one the library does not hold, is refused by name', async () => {
    const h = harness()
    const { taskId, runId } = await storeWithCandidate(h)

    await expect(
      h.runtime.recoverRootTask(STORE, trialRequest(taskId, runId, 'c-d0001'), { sessionId: ROOT_SESSION }),
    ).rejects.toThrow(/effective revision/)
    await expect(
      h.runtime.recoverRootTask(STORE, trialRequest(taskId, runId, 'c-d9999'), { sessionId: ROOT_SESSION }),
    ).rejects.toThrow(/holds no revision "c-d9999"/)
    await expect(
      h.runtime.recoverRootTask(STORE, trialRequest(taskId, runId, '  '), { sessionId: ROOT_SESSION }),
    ).rejects.toThrow(/trialCandidateRef, when given, must be a non-empty candidate revision id/)

    // Nothing opened: the store still holds exactly the one failed run of the round.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs.filter(run => run.taskId === taskId)).toHaveLength(1)
    expect((await h.runtime.libraryRead(ROOT_SESSION)).revisionId).toBe('c-d0001')
    await h.runtime.unload()
  })

  test('a recovery without a trial keeps the source run’s pinned revision, untouched by the frozen candidate', async () => {
    const h = harness()
    const { taskId, runId } = await storeWithCandidate(h)

    const outcome = await h.runtime.recoverRootTask(
      STORE,
      { sourceTaskId: taskId, sourceRunId: runId, sourceDiagnosisId: 'd-1', requestKey: 'k-1' },
      { sessionId: ROOT_SESSION },
    )
    const attempt = await h.task.runIn(STORE, outcome.runId)
    expect(attempt.environmentRevisionId).toBe('c-d0001')
    expect(attempt.trialCandidateRef).toBeUndefined()
    expect(attempt.providerBinding?.trialCandidateRef).toBeUndefined()
    expect(await readFile(join(attempt.providerBinding!.snapshotRoot!, 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(
      SKILL('Library method v1'),
    )
    await h.runtime.unload()
  })
})

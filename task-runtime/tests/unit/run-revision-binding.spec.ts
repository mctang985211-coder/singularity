import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'
import { harness, createRoot, ROOT_SESSION, STORE } from './orchestrate.fixture.ts'

/**
 * Frozen Run binding (plan §2, §5): a Run is admitted against exactly one
 * immutable environment revision, a child inherits its parent's revision, an
 * explicit trial binds a frozen candidate without moving the pointer, and a
 * publish that lands afterwards never changes what an earlier Run loads.
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

function revisionFile(revisionId: string, skill: string): string {
  return join(libraryRoot(), 'revisions', revisionId, 'skills', skill, 'SKILL.md')
}

/** Publish one new skill version and answer the revision id it became. */
async function publishSkill(h: ReturnType<typeof harness>, body: string, expectedGeneration: number): Promise<string> {
  const staged = await h.runtime.libraryWrite(ROOT_SESSION, {
    kind: 'skill', name: 'explore-metrics', skillMd: SKILL(body), expectedVersion: expectedGeneration - 1,
  })
  const outcome = await h.runtime.publishRevision(ROOT_SESSION, {
    direction: 'publish',
    source: { kind: 'draft', draftId: staged.draftId },
    expected: { revisionId: 'r0001', generation: expectedGeneration },
    actor: ROOT_SESSION,
  })
  return outcome.pointer.revisionId
}

describe('a Run is bound to one immutable environment revision', () => {
  test('the root Run pins the active revision and loads that revision’s bytes', async () => {
    const h = harness()
    const root = await createRoot(h)
    const run = await h.task.runIn(STORE, root.runId)

    expect(run.environmentRevisionId).toBe('r0001')
    expect(run.trialCandidateRef).toBeUndefined()
    expect(run.providerBinding?.environmentRevisionId).toBe('r0001')
    expect(run.providerBinding?.trialCandidateRef).toBeUndefined()
    expect(run.providerBinding?.skills.map(skill => skill.name)).toEqual(['task-coordination'])
    expect(run.taskTemplatesRoot).toBe(join(libraryRoot(), 'revisions', 'r0001', 'task-templates'))

    // The bytes the Run loads are exactly the revision's bytes.
    for (const skill of run.providerBinding!.skills) {
      const snapshot = await readFile(join(run.providerBinding!.snapshotRoot!, skill.name, 'SKILL.md'), 'utf8')
      expect(snapshot).toBe(await readFile(revisionFile('r0001', skill.name), 'utf8'))
    }
    const read = await h.runtime.readRunBinding(run.providerBinding!)
    expect(read?.defects).toEqual([])
    await h.runtime.unload()
  })

  test('a publish moves the next Run to the new revision and leaves an earlier Run’s bytes alone', async () => {
    const h = harness()
    const root = await createRoot(h)
    const earlier = await h.task.runIn(STORE, root.runId)
    const before = await readFile(join(earlier.providerBinding!.snapshotRoot!, 'task-coordination', 'SKILL.md'), 'utf8')

    const published = await publishSkill(h, 'Library method v1', 1)
    expect(published).toBe('c-d0001')

    // The earlier Run is untouched: same revision id, same bytes, no defects.
    const unchanged = await h.task.runIn(STORE, root.runId)
    expect(unchanged.environmentRevisionId).toBe('r0001')
    expect(unchanged.providerBinding).toEqual(earlier.providerBinding)
    expect(await readFile(join(earlier.providerBinding!.snapshotRoot!, 'task-coordination', 'SKILL.md'), 'utf8')).toBe(before)
    expect((await h.runtime.readRunBinding(earlier.providerBinding!))?.defects).toEqual([])

    // A Run admitted after the publish consumes the new revision.
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the earlier round is done' })
    const replayed = await h.runtime.replayTask(STORE, root.taskId, { lineage: 'revision-binding' }, ROOT_SESSION)
    const replay = await h.task.runIn(STORE, replayed.runId)
    expect(replay.environmentRevisionId).toBe('c-d0001')
    expect(replay.providerBinding?.environmentRevisionId).toBe('c-d0001')
    expect(replay.providerBinding?.skills.map(skill => skill.name)).toEqual(['task-coordination'])
    await h.runtime.unload()
  })

  test('a child Run inherits its parent Run’s revision even after a publish', async () => {
    const h = harness()
    const root = await createRoot(h)
    await publishSkill(h, 'Library method v1', 1)

    const batch = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'Produce an independently checked child result',
      children: [{
        objective: 'Produce the child result',
        acceptanceCriteria: [{ description: 'The child result passes its check', command: 'true' }],
        requiredCapabilities: ['execute-task'],
      }],
    })
    await h.runtime.awaitBatch(STORE, batch.batchId)
    const child = await h.task.taskIn(STORE, batch.childTaskIds[0]!)
    const childRun = await h.task.runIn(STORE, child.runIds[0]!)
    expect(childRun.parentRunId).toBe(root.runId)
    expect(childRun.environmentRevisionId).toBe('r0001')
    expect(childRun.providerBinding?.environmentRevisionId).toBe('r0001')
    expect(childRun.taskTemplatesRoot).toBe(join(libraryRoot(), 'revisions', 'r0001', 'task-templates'))
    await h.runtime.unload()
  })

  test('an explicit trial binds the frozen candidate and does not move the pointer', async () => {
    const h = harness()
    // v1 is published and becomes the active revision the root Run consumes.
    const first = await publishSkill(h, 'Library method v1', 1)
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'Deliver a checked result',
      requiredCapabilities: ['execute-task', 'method:explore-metrics'],
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'The result is delivered', command: 'true' }],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const champion = await h.task.runIn(STORE, activated.runId)
    expect(champion.environmentRevisionId).toBe(first)

    // v2 is frozen as a candidate: nothing publishes it.
    const staged = await h.runtime.libraryWrite(ROOT_SESSION, {
      kind: 'skill', name: 'explore-metrics', skillMd: SKILL('Candidate method v2'), expectedVersion: 1,
    })
    const frozen = await h.runtime.freezeDraft(ROOT_SESSION, staged.draftId)
    expect(frozen.manifest.revisionId).toBe('c-d0002')
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })

    const trialled = await h.runtime.replayTask(STORE, activated.taskId, {
      lineage: 'trial:c-d0002', trialCandidateRef: 'c-d0002',
    }, ROOT_SESSION)
    const trial = await h.task.runIn(STORE, trialled.runId)
    // The Run pins the active revision and names the candidate it trialled; the
    // binding says the bytes came from the candidate.
    expect(trial.environmentRevisionId).toBe('c-d0001')
    expect(trial.trialCandidateRef).toBe('c-d0002')
    expect(trial.providerBinding?.environmentRevisionId).toBe('c-d0002')
    expect(trial.providerBinding?.trialCandidateRef).toBe('c-d0002')
    expect(trial.providerBinding?.skills.map(skill => skill.name)).toEqual(['explore-metrics', 'task-coordination'])
    expect(await readFile(join(trial.providerBinding!.snapshotRoot!, 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(
      SKILL('Candidate method v2'),
    )

    // The pointer never moved: the active revision is still the published candidate.
    const view = await h.runtime.libraryRead(ROOT_SESSION)
    expect(view).toMatchObject({ revisionId: 'c-d0001', generation: 2 })
    expect(view.skills.find(entry => entry.name === 'explore-metrics')).toMatchObject({ status: 'temporary' })
    expect((await h.runtime.listRevisions(ROOT_SESSION)).map(entry => entry.revisionId)).toEqual(['c-d0001', 'c-d0002', 'r0001'])
    await h.runtime.unload()
  })

  test('a candidate whose bytes moved after the freeze is refused when a Run tries to bind it', async () => {
    const h = harness()
    const first = await publishSkill(h, 'Library method v1', 1)
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'Deliver a checked result',
      requiredCapabilities: ['execute-task', 'method:explore-metrics'],
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'The result is delivered', command: 'true' }],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    expect((await h.task.runIn(STORE, activated.runId)).environmentRevisionId).toBe(first)

    const staged = await h.runtime.libraryWrite(ROOT_SESSION, {
      kind: 'skill', name: 'explore-metrics', skillMd: SKILL('Candidate method v2'), expectedVersion: 1,
    })
    await h.runtime.freezeDraft(ROOT_SESSION, staged.draftId)
    await writeFile(revisionFile('c-d0002', 'explore-metrics'), SKILL('Something else entirely'))
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })

    // The refusal settles that Run failed and names what moved; the tampered
    // revision is never loaded under the name the record cites.
    const outcome = await h.runtime.replayTask(
      STORE,
      activated.taskId,
      { lineage: 'trial:c-d0002', trialCandidateRef: 'c-d0002' },
      ROOT_SESSION,
    )
    expect(outcome.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const review = snapshot.reviews.find(item => item.runId === outcome.runId)
    expect(review?.localizedCause).toMatch(/content binding failed[\s\S]*explore-metrics/)
    expect(review?.localizedCause).toMatch(/SKILL\.md digest \(revision|not the admitted content/)
    expect((await h.runtime.libraryRead(ROOT_SESSION)).revisionId).toBe(first)
    await h.runtime.unload()
  })
})

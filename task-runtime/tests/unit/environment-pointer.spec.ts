import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { libraryRoots, readRevision, revisionRoot, verifyRevisionDirectory } from '../../src/environment/store.ts'
import type { LibraryRoots } from '../../src/environment/store.ts'
import type { EnvironmentCommitStage, EnvironmentPointer } from '../../src/environment/pointer.ts'
import {
  ensureInitialRevision,
  listPointerCompletions,
  openPointerIntent,
  publishEnvironmentRevision,
  readActiveRevision,
  readPointer,
  reconcileEnvironmentPointer,
  rollbackEnvironmentRevision,
} from '../../src/environment/pointer.ts'
import { createEnvironmentDraft, stageEnvironmentEdit } from '../../src/environment/draft.ts'

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Explore a useful metric from task evidence.\n---\n${body}\n`

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'singularity-env-pointer-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function libraryWithDraft(id: string): Promise<{ library: LibraryRoots; draftId: string }> {
  const library = libraryRoots(id, home)
  await ensureInitialRevision(library, { actor: 'test' })
  const draft = await createEnvironmentDraft(library, { actor: 'tester' })
  await stageEnvironmentEdit(library, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' } })
  return { library, draftId: draft.draftId }
}

const publishRequest = (draftId: string) => ({
  direction: 'publish' as const,
  source: { kind: 'draft' as const, draftId },
  expected: { revisionId: 'r0001', generation: 1 },
  actor: 'tester',
})

async function assertSettled(library: LibraryRoots, revisionId: string, intentCount: number): Promise<void> {
  const pointer = await readPointer(library)
  expect(pointer?.revisionId).toBe(revisionId)
  expect(pointer?.generation).toBe(2)
  expect(await openPointerIntent(library)).toBeNull()
  const completions = await listPointerCompletions(library)
  expect(completions).toHaveLength(intentCount)
  const revision = (await readRevision(library, revisionId))!
  expect((await verifyRevisionDirectory(revision.root, revision.manifest)).defects).toEqual([])
  expect((await readActiveRevision(library)).manifest.contentDigest).toBe(pointer!.manifestDigest)
}

describe('environment pointer transaction', () => {
  test('a publish runs the ten steps in order and settles: pointer, completion, no intent', async () => {
    const { library, draftId } = await libraryWithDraft('s-publish')
    const stages: EnvironmentCommitStage[] = []
    const outcome = await publishEnvironmentRevision({ library, probe: stage => { stages.push(stage) } }, publishRequest(draftId))
    expect(stages).toEqual(['intent-recorded', 'revision-frozen', 'revision-verified', 'pointer-switched', 'completion-recorded', 'intent-cleared'])
    expect(outcome.recovered).toBe('fresh')
    expect(outcome.supersededRevisionId).toBe('r0001')
    expect(outcome.pointer.generation).toBe(2)
    expect(outcome.completion.intentId).toBe(`${library.id}/g2/c-${draftId}`)
    await assertSettled(library, `c-${draftId}`, 1)
    expect((await readActiveRevision(library)).manifest.skills.map(entry => entry.name)).toContain('explore-metrics')
  })

  test('a stale expected pointer is refused by name and nothing moves', async () => {
    const { library, draftId } = await libraryWithDraft('s-cas')
    await expect(
      publishEnvironmentRevision({ library }, { ...publishRequest(draftId), expected: { revisionId: 'r0001', generation: 7 } }),
    ).rejects.toThrow(/environment-pointer-changed/)
    await expect(
      publishEnvironmentRevision({ library }, { ...publishRequest(draftId), expected: { revisionId: 'r0000', generation: 1 } }),
    ).rejects.toThrow(/environment-pointer-changed/)
    expect((await readPointer(library))?.generation).toBe(1)
    expect(await openPointerIntent(library)).toBeNull()
    expect(await listPointerCompletions(library)).toEqual([])
  })

  test('a third-party pointer rewrite is refused and not overwritten', async () => {
    const { library, draftId } = await libraryWithDraft('s-drift')
    const pointer = (await readPointer(library))!
    const foreign: EnvironmentPointer = { ...pointer, revisionId: 'r9999', generation: 99, manifestDigest: 'f'.repeat(64) }
    await writeFile(join(library.root, 'pointer.json'), `${JSON.stringify(foreign, null, 2)}\n`)
    await expect(publishEnvironmentRevision({ library }, publishRequest(draftId))).rejects.toThrow(/environment-pointer-changed/)
    const after = JSON.parse(await readFile(join(library.root, 'pointer.json'), 'utf8')) as EnvironmentPointer
    expect(after.revisionId).toBe('r9999')
    expect(after.generation).toBe(99)
    expect(await listPointerCompletions(library)).toEqual([])
    expect(await openPointerIntent(library)).toBeNull()
  })

  test('a failed pointer read-back records no completion and reconcile blocks over the third-party pointer', async () => {
    const { library, draftId } = await libraryWithDraft('s-readback')
    const pointer = (await readPointer(library))!
    await expect(publishEnvironmentRevision({ library, probe: async stage => {
      if (stage === 'pointer-switched') {
        const foreign: EnvironmentPointer = { ...pointer, revisionId: 'r9999', generation: 99, manifestDigest: 'f'.repeat(64) }
        await writeFile(join(library.root, 'pointer.json'), `${JSON.stringify(foreign, null, 2)}\n`)
      }
    } }, publishRequest(draftId))).rejects.toThrow(/did not read back/)
    expect(await listPointerCompletions(library)).toEqual([])
    const intent = await openPointerIntent(library)
    expect(intent).not.toBeNull()
    const report = await reconcileEnvironmentPointer({ library })
    expect(report).toHaveLength(1)
    expect(report[0]!.result).toBe('blocked')
    expect(report[0]!.detail).toMatch(/third party/)
    expect(await openPointerIntent(library)).not.toBeNull()
    const after = JSON.parse(await readFile(join(library.root, 'pointer.json'), 'utf8')) as EnvironmentPointer
    expect(after.revisionId).toBe('r9999')
  })

  test('two concurrent publishes: exactly one wins, the loser is refused by name', async () => {
    const { library, draftId } = await libraryWithDraft('s-concurrent')
    const second = await createEnvironmentDraft(library, { actor: 'tester' })
    await stageEnvironmentEdit(library, second.draftId, { kind: 'skill', edit: { name: 'other-method', skillMd: skill('other-method', 'Other'), expectedVersion: 0, actor: 'tester' } })
    const attempts = await Promise.allSettled([
      publishEnvironmentRevision({ library }, publishRequest(draftId)),
      publishEnvironmentRevision({ library }, publishRequest(second.draftId)),
    ])
    expect(attempts.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = attempts.find(item => item.status === 'rejected') as PromiseRejectedResult
    expect(String(loser.reason)).toMatch(/environment-pointer-changed/)
    const pointer = await readPointer(library)
    expect(pointer?.generation).toBe(2)
    expect(await listPointerCompletions(library)).toHaveLength(1)
  })

  test('a rollback is the same transaction back to a frozen revision', async () => {
    const { library, draftId } = await libraryWithDraft('s-rollback')
    const published = await publishEnvironmentRevision({ library }, publishRequest(draftId))
    expect((await readActiveRevision(library)).manifest.skills.map(entry => entry.name)).toContain('explore-metrics')
    const rolledBack = await rollbackEnvironmentRevision({ library }, {
      direction: 'rollback',
      source: { kind: 'revision', revisionId: 'r0001' },
      expected: { revisionId: published.pointer.revisionId, generation: published.pointer.generation },
      actor: 'tester',
      approvalRef: 'approval-1',
    })
    expect(rolledBack.pointer.revisionId).toBe('r0001')
    expect(rolledBack.pointer.generation).toBe(3)
    expect(rolledBack.supersededRevisionId).toBe(`c-${draftId}`)
    expect(rolledBack.completion.approvalRef).toBe('approval-1')
    const completions = await listPointerCompletions(library)
    expect(completions.map(item => item.direction)).toEqual(['publish', 'rollback'])
    expect((await readActiveRevision(library)).manifest.skills.map(entry => entry.name)).not.toContain('explore-metrics')
  })

  test('an open intent excludes a second publish until reconcile settles it', async () => {
    const { library, draftId } = await libraryWithDraft('s-open-intent')
    await writeFile(join(library.root, 'pointer-intent.json'), `${JSON.stringify({
      formatVersion: 1,
      intentId: `${library.id}/g2/c-${draftId}`,
      libraryId: library.id,
      direction: 'publish',
      expected: { revisionId: 'r0001', generation: 1 },
      next: { revisionId: `c-${draftId}`, manifestDigest: 'e'.repeat(64) },
      draftId,
      actor: 'tester',
      at: new Date().toISOString(),
    }, null, 2)}\n`)
    await expect(publishEnvironmentRevision({ library }, publishRequest(draftId))).rejects.toThrow(/environment-intent-open/)
    expect(await openPointerIntent(library)).not.toBeNull()
  })
})

describe('environment pointer crash recovery', () => {
  const stages: EnvironmentCommitStage[] = ['intent-recorded', 'revision-frozen', 'revision-verified', 'pointer-switched', 'completion-recorded', 'intent-cleared']
  for (const crashAt of stages) {
    test(`a crash after "${crashAt}" reconciles to one settled switch with no mixed versions`, async () => {
      const { library, draftId } = await libraryWithDraft(`s-crash-${crashAt}`)
      let armed: string | undefined = crashAt
      await expect(publishEnvironmentRevision({ library, probe: stage => {
        if (stage === armed) {
          armed = undefined
          throw new Error(`boom at ${stage}`)
        }
      } }, publishRequest(draftId))).rejects.toThrow(/boom/)
      const report = await reconcileEnvironmentPointer({ library })
      if (crashAt === 'intent-cleared') {
        expect(report).toEqual([])
      } else {
        expect(report).toHaveLength(1)
        expect(report[0]!.result).toBe(crashAt === 'intent-recorded' ? 'completed-frozen' : 'completed-switched')
      }
      await assertSettled(library, `c-${draftId}`, 1)
      // A second reconcile is a no-op; a replayed publish request is refused, not repeated.
      expect(await reconcileEnvironmentPointer({ library })).toEqual([])
      await expect(publishEnvironmentRevision({ library }, publishRequest(draftId))).rejects.toThrow(/environment-pointer-changed/)
      expect(await listPointerCompletions(library)).toHaveLength(1)
    })
  }

  test('a pointer moved by a third party mid-window is refused at the switch recheck, never overwritten', async () => {
    const { library, draftId } = await libraryWithDraft('s-mid-drift')
    const pointer = (await readPointer(library))!
    await expect(publishEnvironmentRevision({ library, probe: async stage => {
      if (stage === 'revision-verified') {
        const foreign: EnvironmentPointer = { ...pointer, revisionId: 'r9999', generation: 99, manifestDigest: 'f'.repeat(64) }
        await writeFile(join(library.root, 'pointer.json'), `${JSON.stringify(foreign, null, 2)}\n`)
      }
    } }, publishRequest(draftId))).rejects.toThrow(/environment-pointer-changed/)
    const after = JSON.parse(await readFile(join(library.root, 'pointer.json'), 'utf8')) as EnvironmentPointer
    expect(after.revisionId).toBe('r9999')
    expect(after.generation).toBe(99)
    expect(await listPointerCompletions(library)).toEqual([])
    const report = await reconcileEnvironmentPointer({ library })
    expect(report).toHaveLength(1)
    expect(report[0]!.result).toBe('blocked')
    expect(report[0]!.detail).toMatch(/third party/)
    expect(await openPointerIntent(library)).not.toBeNull()
  })
})

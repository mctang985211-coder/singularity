import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  draftsRoot,
  hasLegacyLayout,
  libraryRoots,
  listRevisions,
  readRevision,
  verifyRevisionDirectory,
} from '../../src/environment/store.ts'
import { ensureInitialRevision, readPointer } from '../../src/environment/pointer.ts'
import { createEnvironmentDraft, freezeEnvironmentDraft, stageEnvironmentEdit } from '../../src/environment/draft.ts'

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Explore a useful metric from task evidence.\n---\n${body}\n`

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'singularity-env-store-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('environment revision store', () => {
  test('the initial revision is seeded once, listed, and verified clean', async () => {
    const library = libraryRoots('s-store', home)
    const revision = await ensureInitialRevision(library, { actor: 'test' })
    expect(revision.manifest.revisionId).toBe('r0001')
    expect(revision.manifest.kind).toBe('official')
    expect(revision.manifest.skills).toHaveLength(1)
    expect(revision.manifest.skills[0]).toMatchObject({ name: 'task-coordination', status: 'retained', version: 1 })
    const again = await ensureInitialRevision(library, { actor: 'test' })
    expect(again.manifest.contentDigest).toBe(revision.manifest.contentDigest)
    expect((await readPointer(library))?.generation).toBe(1)
    expect((await listRevisions(library)).map(item => item.revisionId)).toEqual(['r0001'])
    expect((await verifyRevisionDirectory(revision.root, revision.manifest)).defects).toEqual([])
  })

  test('freezing a draft is a rename: the draft directory is gone, the revision verifies, the pointer does not move', async () => {
    const library = libraryRoots('s-freeze', home)
    await ensureInitialRevision(library, { actor: 'test' })
    const draft = await createEnvironmentDraft(library, { actor: 'tester' })
    await stageEnvironmentEdit(library, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' } })
    const revision = await freezeEnvironmentDraft(library, draft.draftId)
    expect(revision.manifest.revisionId).toBe('c-d0001')
    expect(revision.manifest.kind).toBe('candidate')
    expect(revision.manifest.basedOn).toBe('r0001')
    await expect(readFile(join(draftsRoot(library), draft.draftId, 'draft.json'), 'utf8')).rejects.toThrow(/ENOENT/)
    expect((await readPointer(library))?.revisionId).toBe('r0001')
    expect((await verifyRevisionDirectory(revision.root, revision.manifest)).defects).toEqual([])
    expect((await listRevisions(library)).map(item => item.revisionId)).toEqual(['c-d0001', 'r0001'])
  })

  test('a frozen revision is immutable in effect: tampered bytes are reported by name', async () => {
    const library = libraryRoots('s-tamper', home)
    await ensureInitialRevision(library, { actor: 'test' })
    const draft = await createEnvironmentDraft(library, { actor: 'tester' })
    const staged = await stageEnvironmentEdit(library, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' } })
    const revision = await freezeEnvironmentDraft(library, draft.draftId)
    await writeFile(join(revision.skillRoot, 'explore-metrics', 'SKILL.md'), skill('explore-metrics', 'Tampered method'))
    const { defects } = await verifyRevisionDirectory(revision.root, staged.manifest)
    expect(defects.some(defect => defect.includes('explore-metrics') && defect.includes('SKILL.md'))).toBe(true)
    await expect(freezeEnvironmentDraft(library, draft.draftId)).rejects.toThrow(/absent/)
  })

  test('staging into a draft never touches the active revision', async () => {
    const library = libraryRoots('s-isolation', home)
    const initial = await ensureInitialRevision(library, { actor: 'test' })
    const before = (await readRevision(library, 'r0001'))!.manifest.contentDigest
    const draft = await createEnvironmentDraft(library, { actor: 'tester' })
    await stageEnvironmentEdit(library, draft.draftId, { kind: 'skill', edit: { name: 'task-coordination', skillMd: skill('task-coordination', 'Rewritten guidance'), expectedVersion: 1, actor: 'tester' } })
    const after = await readRevision(library, 'r0001')
    expect(after!.manifest.contentDigest).toBe(before)
    expect((await verifyRevisionDirectory(after!.root, after!.manifest)).defects).toEqual([])
    expect(initial.manifest.contentDigest).toBe(before)
  })

  test('a legacy-layout library is read-only territory: no initial revision, no drafts, no pointer', async () => {
    const library = libraryRoots('s-legacy', home)
    await mkdir(join(library.root, 'skills', 'old-skill'), { recursive: true })
    await writeFile(join(library.root, 'index.json'), '{"version":1,"tasks":[],"skills":[]}\n')
    expect(await hasLegacyLayout(library)).toBe(true)
    await expect(ensureInitialRevision(library, { actor: 'test' })).rejects.toThrow(/legacy mutable layout/)
    await expect(createEnvironmentDraft(library, { actor: 'tester' })).rejects.toThrow(/legacy mutable layout/)
    expect(await readPointer(library)).toBeNull()
    await expect(readFile(join(library.root, 'protocol.json'), 'utf8')).rejects.toThrow(/ENOENT/)
  })
})

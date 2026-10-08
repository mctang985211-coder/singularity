import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { TaskTemplate } from '../../../task/src/index.ts'
import { libraryRoots } from '../../src/environment/store.ts'
import { ensureInitialRevision, publishEnvironmentRevision, readPointer } from '../../src/environment/pointer.ts'
import {
  createEnvironmentDraft,
  discardEnvironmentDraft,
  freezeEnvironmentDraft,
  latestDraftFor,
  listEnvironmentDrafts,
  readEnvironmentDraft,
  stageEnvironmentEdit,
} from '../../src/environment/draft.ts'
import { revisionSkillOf } from '../../src/environment/revision.ts'

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Explore a useful metric from task evidence.\n---\n${body}\n`
const template = (): TaskTemplate => ({
  id: 'explore-next-stage', version: 1, catalogPath: ['general'], appliesTo: ['A task needs to explore a useful next step.'],
  parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  contract: { objective: 'Explore a useful next step with task evidence', acceptanceCriteria: [{ description: 'The task result passes its check', command: 'true' }], requiredCapabilities: ['execute-task'] },
})

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'singularity-env-draft-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function library(id: string) {
  const roots = libraryRoots(id, home)
  await ensureInitialRevision(roots, { actor: 'test' })
  return roots
}

describe('environment drafts', () => {
  test('draft ids allocate monotonically and a draft copies its base without touching it', async () => {
    const roots = await library('s-draft-ids')
    const first = await createEnvironmentDraft(roots, { actor: 'tester', purpose: 'try a method' })
    const second = await createEnvironmentDraft(roots, { actor: 'tester' })
    expect([first.draftId, second.draftId]).toEqual(['d0001', 'd0002'])
    expect(first.manifest.revisionId).toBe('c-d0001')
    expect(first.manifest.kind).toBe('candidate')
    expect(first.basedOn).toBe('r0001')
    expect((await listEnvironmentDrafts(roots)).map(item => item.draftId)).toEqual(['d0001', 'd0002'])
    expect((await latestDraftFor(roots, 'tester'))?.draftId).toBe('d0002')
    expect((await readPointer(roots))?.revisionId).toBe('r0001')
  })

  test('staging a skill edit lands in the draft only; the active revision keeps its bytes', async () => {
    const roots = await library('s-draft-stage')
    const draft = await createEnvironmentDraft(roots, { actor: 'tester' })
    const updated = await stageEnvironmentEdit(roots, draft.draftId, {
      kind: 'skill',
      edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), resources: { 'references/notes.md': 'Notes.' }, expectedVersion: 0, actor: 'tester' },
    })
    expect(revisionSkillOf(updated.manifest, 'explore-metrics')).toMatchObject({ version: 1, status: 'temporary' })
    expect(updated.edits).toHaveLength(1)
    const active = (await readPointer(roots))!
    expect(active.revisionId).toBe('r0001')
    const reloaded = await readEnvironmentDraft(roots, draft.draftId)
    expect(reloaded?.manifest.contentDigest).toBe(updated.manifest.contentDigest)
    expect(reloaded?.edits).toEqual(updated.edits)
  })

  test('concurrent stages of one draft serialize, each demanding the observed version', async () => {
    const roots = await library('s-draft-serial')
    const draft = await createEnvironmentDraft(roots, { actor: 'tester' })
    await stageEnvironmentEdit(roots, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'a' } })
    const attempts = await Promise.allSettled([
      stageEnvironmentEdit(roots, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method two'), expectedVersion: 1, actor: 'b' } }),
      stageEnvironmentEdit(roots, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Competing method'), expectedVersion: 1, actor: 'c' } }),
    ])
    expect(attempts.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = attempts.find(item => item.status === 'rejected') as PromiseRejectedResult
    expect(String(loser.reason)).toMatch(/expectedVersion must be/)
    const final = await readEnvironmentDraft(roots, draft.draftId)
    expect(revisionSkillOf(final!.manifest, 'explore-metrics')?.version).toBe(2)
  })

  test('a discarded draft cannot be staged, frozen or published', async () => {
    const roots = await library('s-draft-discard')
    const draft = await createEnvironmentDraft(roots, { actor: 'tester' })
    await stageEnvironmentEdit(roots, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' } })
    await discardEnvironmentDraft(roots, draft.draftId)
    expect(await readEnvironmentDraft(roots, draft.draftId)).toBeUndefined()
    await expect(stageEnvironmentEdit(roots, draft.draftId, { kind: 'skill', edit: { name: 'other', skillMd: skill('other', 'X'), expectedVersion: 0, actor: 'tester' } })).rejects.toThrow(/absent/)
    await expect(freezeEnvironmentDraft(roots, draft.draftId)).rejects.toThrow(/absent/)
    await expect(
      publishEnvironmentRevision({ library: roots }, {
        direction: 'publish',
        source: { kind: 'draft', draftId: draft.draftId },
        expected: { revisionId: 'r0001', generation: 1 },
        actor: 'tester',
      }),
    ).rejects.toThrow(/absent/)
    expect((await readPointer(roots))?.revisionId).toBe('r0001')
  })

  test('freezing a draft produces an immutable candidate revision and never moves the pointer', async () => {
    const roots = await library('s-draft-freeze')
    const draft = await createEnvironmentDraft(roots, { actor: 'tester' })
    await stageEnvironmentEdit(roots, draft.draftId, { kind: 'skill', edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' } })
    await stageEnvironmentEdit(roots, draft.draftId, { kind: 'task', edit: { template: template(), actor: 'tester' } })
    const revision = await freezeEnvironmentDraft(roots, draft.draftId)
    expect(revision.manifest.kind).toBe('candidate')
    expect(revision.manifest.taskTemplates).toHaveLength(1)
    expect((await readPointer(roots))?.revisionId).toBe('r0001')
    expect(await readEnvironmentDraft(roots, draft.draftId)).toBeUndefined()
  })
})

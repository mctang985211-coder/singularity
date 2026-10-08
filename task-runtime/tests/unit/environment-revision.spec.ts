import { describe, expect, test } from 'vitest'
import type { TaskTemplate } from '../../../task/src/index.ts'
import {
  applyCapabilityRowEdit,
  applyReviewEdit,
  applySkillEdit,
  applyTemplateEdit,
  assertDraftEditAllowed,
  emptyRevisionManifest,
  manifestDigest,
  parseRevisionManifest,
  revisionCapabilityRows,
  revisionSkillOf,
  revisionTemplateOf,
} from '../../src/environment/revision.ts'
import type { EnvironmentRevisionManifest } from '../../src/environment/revision.ts'

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Explore a useful metric from task evidence.\n---\n${body}\n`
const template = (): TaskTemplate => ({
  id: 'explore-next-stage', version: 1, catalogPath: ['general'], appliesTo: ['A task needs to explore a useful next step.'],
  parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  contract: { objective: 'Explore a useful next step with task evidence', acceptanceCriteria: [{ description: 'The task result passes its check', command: 'true' }], requiredCapabilities: ['execute-task', 'method:explore-metrics'] },
})
const base = (): EnvironmentRevisionManifest => emptyRevisionManifest({ libraryId: 's-test', revisionId: 'r0001', kind: 'official', basedOn: null, createdAt: '2026-10-08T00:00:00.000Z' })

describe('environment revision manifest', () => {
  test('the content digest is stable against key order and round-trips through JSON', () => {
    const manifest = applySkillEdit(base(), { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' })
    const roundTripped = parseRevisionManifest(JSON.parse(JSON.stringify(manifest)), 'test')
    expect(roundTripped).toEqual(manifest)
    const shuffled = JSON.parse(JSON.stringify(manifest, (key, value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value)) as unknown
    const reparsed = parseRevisionManifest(shuffled, 'test')
    expect(reparsed.contentDigest).toBe(manifest.contentDigest)
    const { contentDigest, ...rest } = manifest
    expect(manifestDigest(rest)).toBe(contentDigest)
  })

  test('an invalid or tampered manifest is refused by name', () => {
    const manifest = base()
    expect(() => parseRevisionManifest({ ...manifest, formatVersion: 2 }, 'test')).toThrow(/formatVersion/)
    expect(() => parseRevisionManifest({ ...manifest, revisionId: 'BAD ID!' }, 'test')).toThrow(/revisionId/)
    expect(() => parseRevisionManifest({ ...manifest, kind: 'bogus' }, 'test')).toThrow(/kind/)
    expect(() => parseRevisionManifest({ ...manifest, contentDigest: '0'.repeat(64) }, 'test')).toThrow(/contentDigest/)
    const { contentDigest: _, ...rest } = { ...manifest, libraryId: 's-other' }
    expect(() => parseRevisionManifest({ ...rest, contentDigest: manifestDigest(rest) }, 'test')).not.toThrow()
  })

  test('pure edits: skill, template, review and capability row all move only the manifest', () => {
    let manifest = base()
    manifest = applySkillEdit(manifest, { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' })
    expect(revisionSkillOf(manifest, 'explore-metrics')).toMatchObject({ version: 1, status: 'temporary', contractDigest: null })
    manifest = applyTemplateEdit(manifest, template())
    expect(revisionTemplateOf(manifest, 'explore-next-stage')?.skills).toEqual(['explore-metrics', 'task-coordination'])
    expect(applyTemplateEdit(manifest, template())).toBe(manifest)
    expect(() => applyTemplateEdit(manifest, { ...template(), appliesTo: ['conflicting bytes'] })).toThrow(/new version/)
    manifest = applyReviewEdit(manifest, { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'verified on three runs', actor: 'reviewer' }, 'reviewer')
    expect(revisionSkillOf(manifest, 'explore-metrics')).toMatchObject({ status: 'retained', reviewedBy: 'reviewer' })
    manifest = applyCapabilityRowEdit(manifest, { name: 'method:custom', entry: { skills: ['explore-metrics'], tools: ['skill'] }, actor: 'tester' })
    expect(manifest.capabilities.rows['method:custom']).toEqual({ skills: ['explore-metrics'], tools: ['skill'] })
    manifest = applyCapabilityRowEdit(manifest, { name: 'method:custom', entry: null, actor: 'tester' })
    expect(manifest.capabilities.rows['method:custom']).toBeUndefined()
  })

  test('two drafts of the same base both get version+1; the pointer CAS settles the conflict', () => {
    const parent = applySkillEdit(base(), { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' })
    const first = applySkillEdit(parent, { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method two'), expectedVersion: 1, actor: 'a' })
    const second = applySkillEdit(parent, { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Competing method'), expectedVersion: 1, actor: 'b' })
    expect(revisionSkillOf(first, 'explore-metrics')?.version).toBe(2)
    expect(revisionSkillOf(second, 'explore-metrics')?.version).toBe(2)
    expect(first.contentDigest).not.toBe(second.contentDigest)
  })

  test('task-coordination cannot be retired and a review needs a reason', () => {
    const seeded = applySkillEdit(base(), { name: 'task-coordination', skillMd: skill('task-coordination', 'Coordinate.'), expectedVersion: 0, actor: 'tester' })
    expect(() => applyReviewEdit(seeded, { kind: 'skill', name: 'task-coordination', version: 1, status: 'retired', reason: 'obsolete', actor: 'reviewer' }, 'reviewer')).toThrow(/task-coordination supplies execute-task/)
    expect(() => assertDraftEditAllowed(seeded, { kind: 'review', review: { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retired', reason: '  ', actor: 'reviewer' } })).toThrow(/reason/)
  })

  test('expectedVersion must equal the current entry version', () => {
    const parent = applySkillEdit(base(), { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' })
    expect(() => applySkillEdit(parent, { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method two'), expectedVersion: 0, actor: 'tester' })).toThrow(/expectedVersion must be 1/)
    expect(() => applySkillEdit(parent, { name: 'other', skillMd: skill('other', 'New method'), expectedVersion: 3, actor: 'tester' })).toThrow(/expectedVersion must be 0/)
  })

  test('capability rows derive from the manifest: execute-task baseline plus method rows minus retired', () => {
    let manifest = base()
    manifest = applySkillEdit(manifest, { name: 'task-coordination', skillMd: skill('task-coordination', 'Coordinate.'), expectedVersion: 0, actor: 'tester' })
    manifest = applySkillEdit(manifest, { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Method one'), expectedVersion: 0, actor: 'tester' })
    const rows = revisionCapabilityRows(manifest)
    expect(rows['execute-task']).toEqual({ skills: ['task-coordination'], tools: ['filesystem', 'search', 'bash', 'jobs', 'skill'] })
    expect(rows['method:explore-metrics']).toEqual({ skills: ['explore-metrics'], tools: ['skill'] })
    manifest = applyReviewEdit(manifest, { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retired', reason: 'harmful in evidence', actor: 'reviewer' }, 'reviewer')
    expect(revisionCapabilityRows(manifest)['method:explore-metrics']).toBeUndefined()
  })
})

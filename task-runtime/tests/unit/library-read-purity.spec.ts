import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'
import { harness, createRoot, ROOT_SESSION, STORE } from './orchestrate.fixture.ts'

/**
 * The graph library's read/write split (plan §2): every read is pure — no index
 * is rebuilt and no byte is written — and every write lands in a draft, never in
 * the revision a Run is bound to.
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

/** Every path under one directory with its bytes and modification time — what "nothing changed" means. */
async function treeOf(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const walk = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const info = await stat(path)
      found.set(path.slice(root.length), `${info.mtimeMs}:${info.size}:${(await readFile(path)).toString('base64')}`)
    }
  }
  await walk(root)
  return found
}

function libraryRootOf(sessionId: string): string {
  return join(home, 'singularity', 'environments', sessionId)
}

describe('library reads are pure', () => {
  test('reading a library writes nothing, before and after the initial revision exists', async () => {
    const h = harness()
    const library = await h.runtime.libraryForSession(ROOT_SESSION)
    expect(library.protocol).toBe('uninitialized')

    const beforeIntake = await treeOf(libraryRootOf(ROOT_SESSION))
    const pending = await h.runtime.libraryRead(ROOT_SESSION)
    expect(pending).toMatchObject({ protocol: 'uninitialized', skills: [], taskTemplates: [] })
    expect(await treeOf(libraryRootOf(ROOT_SESSION))).toEqual(beforeIntake)

    await createRoot(h)
    const settled = await treeOf(libraryRootOf(ROOT_SESSION))
    const afterIntake = await h.runtime.libraryRead(ROOT_SESSION)
    expect(afterIntake).toMatchObject({ protocol: 'environment-revision', revisionId: 'r0001', generation: 1 })
    expect(afterIntake.skills.map(entry => entry.name)).toEqual(['task-coordination'])
    expect(await treeOf(libraryRootOf(ROOT_SESSION))).toEqual(settled)

    // A repeat read is still a read: the whole tree is byte-identical.
    await h.runtime.libraryRead(ROOT_SESSION)
    expect(await treeOf(libraryRootOf(ROOT_SESSION))).toEqual(settled)
    await h.runtime.unload()
  })

  test('a legacy mutable library is served read-only, byte-identical, and refuses every write', async () => {
    const root = libraryRootOf('s-legacy')
    await mkdir(join(root, 'skills', 'task-coordination'), { recursive: true })
    await mkdir(join(root, 'task-templates'), { recursive: true })
    await writeFile(join(root, 'index.json'), `${JSON.stringify({ version: 1, tasks: [], skills: [] }, null, 2)}\n`)
    await writeFile(
      join(root, 'skills', 'task-coordination', 'SKILL.md'),
      '---\nname: task-coordination\ndescription: Legacy guidance.\n---\nLegacy guidance\n',
    )

    const h = harness()
    h.graphs.graphForSession.mockImplementation(async (id: string) => ({
      id: 'g-legacy', name: 'graph', envId: 'env1', rootSessionId: id, graphStoreId: 'sg-g', layoutStoreId: 'sg-l', createdAt: 0, ready: true,
    }))
    const view = await h.runtime.libraryRead('s-legacy')
    expect(view).toMatchObject({ protocol: 'legacy', revisionId: 'legacy', readOnly: true })
    expect(view.skills.map(entry => entry.name)).toEqual(['task-coordination'])
    expect(await readFile(join(root, 'index.json'), 'utf8')).toContain('"version": 1')

    // The writer's door is closed by name: no draft, no revision, no pointer.
    await expect(h.runtime.createDraft('s-legacy')).rejects.toThrow(/legacy mutable layout/)
    await expect(h.runtime.libraryWrite('s-legacy', { kind: 'skill', name: 'explore-metrics', skillMd: SKILL('no') })).rejects.toThrow(/legacy mutable layout/)
    expect(await readdir(root)).toEqual(['index.json', 'skills', 'task-templates'])
    await h.runtime.unload()
  })
})

describe('library writes land in a draft', () => {
  test('a staged Skill leaves the active revision, the pointer and the Run binding untouched', async () => {
    const h = harness()
    const root = await createRoot(h)
    const before = await h.runtime.libraryRead(ROOT_SESSION)
    const run = await h.task.runIn(STORE, root.runId)

    const staged = await h.runtime.libraryWrite(ROOT_SESSION, {
      kind: 'skill', name: 'explore-metrics', skillMd: SKILL('A path worth reusing'), expectedVersion: 0,
    })
    expect(staged).toMatchObject({ applied: 'draft', draftId: 'd0001', revisionId: 'c-d0001' })
    expect(staged.message).toContain('the active revision is unchanged until it is published')

    const after = await h.runtime.libraryRead(ROOT_SESSION)
    expect(after).toEqual(before)
    expect(after.skills.map(entry => entry.name)).toEqual(['task-coordination'])
    expect((await h.task.runIn(STORE, root.runId)).providerBinding).toEqual(run.providerBinding)

    // The draft itself holds the edit: the candidate revision declares it.
    const draft = await h.runtime.createDraft(ROOT_SESSION)
    expect(draft.draftId).toBe('d0001')
    expect(draft.manifest.skills.map(entry => entry.name)).toEqual(['explore-metrics', 'task-coordination'])
    expect(await readFile(join(draft.root, 'skills', 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(SKILL('A path worth reusing'))
    await h.runtime.unload()
  })

  test('a capability row edit is prechecked against the candidate revision and the active table never moves', async () => {
    const h = harness()
    await createRoot(h)
    const active = await h.runtime.capabilitiesForSession(ROOT_SESSION)
    const draft = await h.runtime.createDraft(ROOT_SESSION)

    // A row naming a skill nobody installed is refused while it is staged.
    await expect(
      h.runtime.stageDraftEdit(ROOT_SESSION, draft.draftId, {
        kind: 'capability', edit: { name: 'research', entry: { skills: ['no-such-provider-skill'] }, actor: ROOT_SESSION },
      }),
    ).rejects.toThrow(/capability "research" was not staged[\s\S]*no-such-provider-skill/)

    // A row whose provider is discoverable lands in the draft alone.
    const staged = await h.runtime.stageDraftEdit(ROOT_SESSION, draft.draftId, {
      kind: 'capability', edit: { name: 'research', entry: { skills: ['task-execution'] }, actor: ROOT_SESSION },
    })
    expect(staged.manifest.capabilities.rows['research']).toEqual({ skills: ['task-execution'] })
    expect(await h.runtime.capabilitiesForSession(ROOT_SESSION)).toEqual(active)
    await h.runtime.unload()
  })
})

describe('retention and comparison authority', () => {
  test('retention decisions require the graph root or a delegated supervisor', async () => {
    const h = harness()
    await createRoot(h)
    const staged = await h.runtime.libraryWrite(ROOT_SESSION, {
      kind: 'skill', name: 'explore-metrics', skillMd: SKILL('A useful path'), expectedVersion: 0,
    })
    // Retention reviews a version a Run could actually be bound to: the draft is published first.
    await h.runtime.publishRevision(ROOT_SESSION, {
      direction: 'publish',
      source: { kind: 'draft', draftId: staged.draftId },
      expected: { revisionId: 'r0001', generation: 1 },
      actor: ROOT_SESSION,
    })
    await expect(
      h.runtime.libraryReview('s-worker', { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'self approval' }),
    ).rejects.toThrow(/supervisor/)
    h.ctx.singularityContext = {
      resolveCaller: async () => ({ kind: 'coordinator', role: 'supervisor' }),
    }
    const reviewed = await h.runtime.libraryReview('s-supervisor', {
      kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'The executed task supports retaining this path',
    })
    expect(reviewed).toMatchObject({ applied: 'draft' })
    await h.runtime.unload()
  })
})

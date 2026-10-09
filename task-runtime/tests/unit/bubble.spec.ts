import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createEnvironmentDraft, freezeEnvironmentDraft, stageEnvironmentEdit } from '../../src/environment/draft.ts'
import { ensureInitialRevision, readPointer } from '../../src/environment/pointer.ts'
import { libraryRoots, readRevision } from '../../src/environment/store.ts'
import type { LibraryRoots } from '../../src/environment/store.ts'
import { bubbleMethodRevisionOf, materializeBubble } from '../../src/service/bubble.ts'

/**
 * The bubble's method volume binds one environment revision (RRSI bubble
 * integration): the named revision's verified bytes are what a round's agents
 * see, the manifest records the revision and its digest, the idempotency key is
 * the (round, revision) pair, a missing or corrupted revision is refused by
 * name, and a legacy flat library keeps its old read-only shape.
 */

const GRAPH = 'g1'
const ROOT = 's-root-bubble'
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: A method the round carries.\n---\n${body}\n`

let home: string
let envPath: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'singularity-bubble-'))
  envPath = join(home, 'env')
  await mkdir(envPath, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function library(id = ROOT): LibraryRoots {
  return libraryRoots(id, home)
}

/** The initial revision plus one frozen candidate holding an extra skill; the pointer stays on r0001. */
async function libraryWithCandidate(id = ROOT): Promise<{ roots: LibraryRoots; candidateId: string }> {
  const roots = library(id)
  await ensureInitialRevision(roots, { actor: 'test' })
  const draft = await createEnvironmentDraft(roots, { actor: 'tester' })
  await stageEnvironmentEdit(roots, draft.draftId, {
    kind: 'skill',
    edit: { name: 'explore-metrics', skillMd: skill('explore-metrics', 'Candidate method v1'), expectedVersion: 0, actor: 'tester' },
  })
  const frozen = await freezeEnvironmentDraft(roots, draft.draftId)
  return { roots, candidateId: frozen.manifest.revisionId }
}

/** One git component in the environment, committed, with a dirty file the genesis round folds in. */
async function componentEnv(): Promise<void> {
  const repo = join(envPath, 'acme', 'widget')
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'committed\n')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-m', 'init')
  await writeFile(join(repo, 'dirty.txt'), 'uncommitted work\n')
}

function bubbleDir(round: number, id = ROOT): string {
  return join(home, 'singularity', 'environments', id, 'bubbles', `round-${round}`)
}

async function manifestOf(round: number, id = ROOT): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(bubbleDir(round, id), 'bubble-manifest.json'), 'utf8'))
}

describe('a bubble materialized from an environment revision', () => {
  test('the method volume is the named revision’s verified bytes and the manifest records it', async () => {
    const { roots, candidateId } = await libraryWithCandidate()
    await componentEnv()

    const workspace = await materializeBubble(envPath, home, ROOT, GRAPH, 1, { methodRevisionId: candidateId })

    const revisionRoot = join(roots.root, 'revisions', candidateId)
    // Every skill of the candidate — the seeded one and the added one — byte for byte.
    expect(await readFile(join(workspace, '.bubble', 'method-volume', 'task-coordination', 'SKILL.md'), 'utf8')).toBe(
      await readFile(join(revisionRoot, 'skills', 'task-coordination', 'SKILL.md'), 'utf8'),
    )
    expect(await readFile(join(workspace, '.bubble', 'method-volume', 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(
      skill('explore-metrics', 'Candidate method v1'),
    )
    const manifest = await manifestOf(1)
    expect(manifest.graphId).toBe(GRAPH)
    expect(manifest.round).toBe(1)
    expect(manifest.methodRevisionId).toBe(candidateId)
    const candidate = await readRevision(roots, candidateId)
    expect(manifest.methodDigest).toBe(candidate!.manifest.contentDigest)
    // The environment's component is cloned at the genesis branch, dirty file included.
    expect(await readFile(join(workspace, 'acme', 'widget', 'dirty.txt'), 'utf8')).toBe('uncommitted work\n')
    expect(bubbleMethodRevisionOf(workspace)).toEqual({ revisionId: candidateId, digest: candidate!.manifest.contentDigest })
    // The pointer never moved: the volume bound a candidate, nothing was published.
    expect((await readPointer(roots))?.revisionId).toBe('r0001')
  })

  test('a revision the library does not hold, or one whose bytes moved, is refused by name', async () => {
    const { roots, candidateId } = await libraryWithCandidate()

    await expect(materializeBubble(envPath, home, ROOT, GRAPH, 1, { methodRevisionId: 'c-d9999' })).rejects.toThrow(
      'holds no revision "c-d9999"',
    )
    await writeFile(join(roots.root, 'revisions', candidateId, 'skills', 'explore-metrics', 'SKILL.md'), skill('explore-metrics', 'tampered'))
    await expect(materializeBubble(envPath, home, ROOT, GRAPH, 2, { methodRevisionId: candidateId })).rejects.toThrow(
      /revision "c-d0001" of library "s-root-bubble" does not verify/,
    )
  })

  test('a new-protocol library with no active revision and no named one is refused, never silently empty', async () => {
    await expect(materializeBubble(envPath, home, ROOT, GRAPH, 1)).rejects.toThrow(/has no active environment revision/)
  })

  test('the idempotency key is the round and the revision: the same round under another revision is materialized again', async () => {
    const { candidateId } = await libraryWithCandidate()

    const first = await materializeBubble(envPath, home, ROOT, GRAPH, 1)
    const sentinel = join(first, '.bubble', 'method-volume', 'sentinel.txt')
    await writeFile(sentinel, 'still here\n')

    const again = await materializeBubble(envPath, home, ROOT, GRAPH, 1)
    expect(again).toBe(first)
    expect(await readFile(sentinel, 'utf8')).toBe('still here\n')
    expect((await manifestOf(1)).methodRevisionId).toBe('r0001')

    const rebound = await materializeBubble(envPath, home, ROOT, GRAPH, 1, { methodRevisionId: candidateId })
    expect(rebound).toBe(first)
    await expect(readFile(sentinel, 'utf8')).rejects.toThrow()
    expect(await readFile(join(first, '.bubble', 'method-volume', 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(
      skill('explore-metrics', 'Candidate method v1'),
    )
    expect((await manifestOf(1)).methodRevisionId).toBe(candidateId)
  })
})

describe('a legacy flat library', () => {
  beforeEach(async () => {
    const flat = join(home, 'singularity', 'environments', ROOT, 'skills', 'flat-method')
    await mkdir(flat, { recursive: true })
    await writeFile(join(flat, 'SKILL.md'), skill('flat-method', 'The old flat method'))
  })

  test('keeps the old volume shape and names no revision in its manifest', async () => {
    const workspace = await materializeBubble(envPath, home, ROOT, GRAPH, 1)
    expect(await readFile(join(workspace, '.bubble', 'method-volume', 'flat-method', 'SKILL.md'), 'utf8')).toBe(
      skill('flat-method', 'The old flat method'),
    )
    const manifest = await manifestOf(1)
    expect('methodRevisionId' in manifest).toBe(false)
    expect(bubbleMethodRevisionOf(workspace)).toBeUndefined()
  })

  test('refuses a named revision by name instead of entering the revision logic', async () => {
    await expect(materializeBubble(envPath, home, ROOT, GRAPH, 1, { methodRevisionId: 'r0001' })).rejects.toThrow(
      /legacy flat layout and holds no revision "r0001"/,
    )
  })
})

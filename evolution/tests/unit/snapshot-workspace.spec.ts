import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWorkspace, directoryDigest, normalizeSnapshot, normalizeSnapshotPaths } from '../../src/evidence/snapshot.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function input() {
  const root = await mkdtemp(join(tmpdir(), 'replay-selected-'))
  roots.push(root)
  const source = join(root, 'input')
  await mkdir(join(source, 'fixture'), { recursive: true })
  await writeFile(join(source, 'fixture', 'input.txt'), 'frozen')
  await writeFile(join(source, 'check.sh'), 'exit 0\n')
  await chmod(join(source, 'check.sh'), 0o751)
  return { root, source }
}

describe('selected replay input', () => {
  it('normalizes an explicit selection and rejects traversal or empty selections', () => {
    expect(normalizeSnapshotPaths(['fixture/input.txt', './check.sh', 'fixture/', 'check.sh'])).toEqual(['check.sh', 'fixture'])
    for (const paths of [[], ['.'], ['../outside'], ['fixture/../check.sh'], ['/absolute'], [42]])
      expect(() => normalizeSnapshotPaths(paths)).toThrow('relative files or directories')
    expect(() => normalizeSnapshot({ sourceDir: '/input', rebaseFrom: '/' })).toThrow('original absolute workspace')
    expect(normalizeSnapshot({ sourceDir: '/input', paths: ['fixture/'], rebaseFrom: '/old/workspace/' }))
      .toEqual({ sourceDir: '/input', paths: ['fixture'], rebaseFrom: '/old/workspace' })
  })

  it('skips unrelated trees and makes independently writable copies with the same frozen input', async () => {
    const { root, source } = await input()
    await mkdir(join(source, 'unrelated'))
    await symlink(root, join(source, 'unrelated', 'escape'))
    const paths = ['fixture', 'check.sh']
    const digest = await directoryDigest(source, paths)
    await expect(directoryDigest(source)).rejects.toThrow('outside the snapshot root')
    const left = await buildWorkspace(source, join(root, 'left'), digest, paths)
    const right = await buildWorkspace(source, join(root, 'right'), digest, paths)
    expect(await directoryDigest(left)).toBe(digest)
    expect(await directoryDigest(right)).toBe(digest)
    expect((await stat(join(left, 'check.sh'))).mode & 0o777).toBe(0o751)
    await expect(stat(join(left, 'unrelated'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(left, 'fixture', 'input.txt'), 'candidate change')
    expect(await readFile(join(right, 'fixture', 'input.txt'), 'utf8')).toBe('frozen')
    expect(await readFile(join(source, 'fixture', 'input.txt'), 'utf8')).toBe('frozen')
    await writeFile(join(source, 'fixture', 'input.txt'), 'source changed')
    await expect(buildWorkspace(source, join(root, 'changed'), digest, paths)).rejects.toThrow('did not reproduce the frozen input')
  })

  it('refuses missing inputs and destructive workspace overlap through aliases before removing anything', async () => {
    const { root, source } = await input()
    await expect(directoryDigest(source, ['missing'])).rejects.toThrow('does not exist')
    const digest = await directoryDigest(source)
    const alias = join(root, 'alias')
    await symlink(source, alias)
    await expect(buildWorkspace(source, join(alias, 'child'), digest)).rejects.toThrow('separate from its frozen input')
    await expect(buildWorkspace(source, root, digest)).rejects.toThrow('separate from its frozen input')
    expect(await readFile(join(source, 'fixture', 'input.txt'), 'utf8')).toBe('frozen')
  })
})

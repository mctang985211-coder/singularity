import { afterEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVerifiedFile, walkVerified } from '../../src/verified-read.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'verified-read-'))
  roots.push(directory)
  return directory
}

describe('walkVerified', () => {
  test('reports a real file by its absolute path, and a missing one without throwing', async () => {
    const base = await root()
    await mkdir(join(base, 'skills', 'a'), { recursive: true })
    await writeFile(join(base, 'skills', 'a', 'SKILL.md'), 'body\n')
    expect(await walkVerified(base, join('skills', 'a', 'SKILL.md'))).toEqual({ missing: false, abs: join(base, 'skills', 'a', 'SKILL.md') })
    expect(await walkVerified(base, join('skills', 'b', 'SKILL.md')))
      .toEqual({ missing: true, reason: 'no such file or directory' })
  })

  test('refuses a symbolic link at the target and at any ancestor', async () => {
    const base = await root()
    const outside = await root()
    await writeFile(join(outside, 'SKILL.md'), 'outside\n')
    await symlink(outside, join(base, 'link'))
    await expect(walkVerified(base, join('link', 'SKILL.md'))).rejects.toThrow('is a symbolic link')
    await mkdir(join(base, 'real'))
    await writeFile(join(base, 'real', 'file.md'), 'x\n')
    await symlink(join(base, 'real', 'file.md'), join(base, 'real', 'again.md'))
    await expect(walkVerified(base, join('real', 'again.md'))).rejects.toThrow('is a symbolic link')
  })

  test('refuses a directory where a file should be and the escape of the root', async () => {
    const base = await root()
    await mkdir(join(base, 'dir'))
    await expect(walkVerified(base, 'dir')).rejects.toThrow('is not a regular file')
    await expect(walkVerified(base, join('..', 'elsewhere'))).rejects.toThrow('escapes')
  })
})

describe('readVerifiedFile', () => {
  test('returns the exact bytes, with no newline rewriting', async () => {
    const base = await root()
    const bytes = Buffer.from('line one\r\nline two')
    await writeFile(join(base, 'file.txt'), bytes)
    expect(await readVerifiedFile(base, 'file.txt')).toEqual(bytes)
  })

  test('refuses a missing file, a directory and a symbolic link', async () => {
    const base = await root()
    await mkdir(join(base, 'dir'))
    await expect(readVerifiedFile(base, 'gone.txt')).rejects.toThrow('is missing under')
    await expect(readVerifiedFile(base, 'dir')).rejects.toThrow('is not a regular file')
    const outside = await root()
    await writeFile(join(outside, 'file.txt'), 'outside\n')
    await symlink(join(outside, 'file.txt'), join(base, 'link.txt'))
    await expect(readVerifiedFile(base, 'link.txt')).rejects.toThrow('is a symbolic link')
  })
})

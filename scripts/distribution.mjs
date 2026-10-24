#!/usr/bin/env node
/** Audits private distribution metadata and optionally the actual offline tarball. Does not publish. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export async function auditDistribution(pack = false) {
  for (const path of ['package.json', 'assembly/package.json']) {
    const meta = JSON.parse(await readFile(join(ROOT, path), 'utf8'))
    assert.equal(meta.private, true, `${path}: publishing requires an explicit licensing decision`)
    assert.equal(meta.license, 'UNLICENSED', `${path}: original code has no public license grant`)
    assert.ok(meta.description && meta.name && meta.version)
  }
  for (const file of ['LICENSE', 'NOTICE', 'third_party/rrsi/LICENSE', 'third_party/dsh/LICENSE'])
    assert.ok((await readFile(join(ROOT, file))).length > 100, `missing notice: ${file}`)
  if (!pack) return { license: 'UNLICENSED', private: true, tarball: 'not inspected' }
  const destination = await mkdtemp(join(tmpdir(), 'singularity-pack-'))
  try {
    const tarball = join(destination, 'assembly.tgz')
    execFileSync('pnpm', ['pack', '--out', tarball], { cwd: join(ROOT, 'assembly'), stdio: 'pipe' })
    const names = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
    for (const file of [
      'package/lib/NOTICE',
      'package/lib/LICENSE',
      'package/lib/licenses/dsh-LICENSE',
      'package/lib/licenses/rrsi-LICENSE',
      'package/lib/build.json',
    ])
      assert.ok(names.includes(file), `tarball missing ${file}`)
    for (const name of names)
      assert.ok(
        !/(^|\/)(\.singularity|node_modules|sessions|credentials|\.env|\.git)(\/|$)/.test(name),
        `private runtime file in tarball: ${name}`,
      )
    const npmNotices = JSON.parse(await readFile(join(ROOT, 'assembly/lib/licenses/npm/index.json'), 'utf8'))
    for (const name of ['react', 'react-dom', '@xyflow/react', 'zustand'])
      assert.ok(
        npmNotices.packages.some(p => p.name === name),
        `missing browser dependency notices: ${name}`,
      )
    for (const entry of npmNotices.packages)
      for (const file of Object.keys(entry.files))
        assert.ok(names.includes('package/lib/licenses/npm/' + file), `missing upstream license: ${entry.name}`)
    const build = JSON.parse(await readFile(join(ROOT, 'assembly/lib/build.json'), 'utf8'))
    for (const [name, digest] of Object.entries(build.outputs)) {
      const { createHash } = await import('node:crypto')
      const packed = execFileSync('tar', ['-xOzf', tarball, 'package/' + name.replace('assembly/', '')])
      assert.equal(createHash('sha256').update(packed).digest('hex'), digest, `packed bytes differ: ${name}`)
    }
    return {
      license: 'UNLICENSED',
      private: true,
      tarball: 'all build outputs and notices verified',
      files: names.length,
    }
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await auditDistribution(process.argv.includes('--pack')), null, 2))

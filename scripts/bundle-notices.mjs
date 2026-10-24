/** Ship original notices for the browser's complete runtime dependency closure, including unused members. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export async function writeBundleNotices(root, destination) {
  const packages = new Map()
  async function visit(name, from) {
    const require = createRequire(join(from, 'package.json'))
    let directory
    try {
      directory = dirname(require.resolve(name + '/package.json'))
    } catch {
      directory = dirname(require.resolve(name))
      while (true) {
        try {
          const meta = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
          if (meta.name === name) break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        const parent = dirname(directory)
        assert.notEqual(parent, directory, `cannot locate license owner for ${name}`)
        directory = parent
      }
    }
    const meta = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    const id = `${meta.name}@${meta.version}`
    if (packages.has(id)) return
    assert.ok(typeof meta.license === 'string', `missing package license metadata: ${id}`)
    const entries = (await readdir(directory)).filter(file => /^(licen[cs]e|notice|copying)(\.|$)/i.test(file)).sort()
    assert.ok(entries.length > 0, `missing upstream license text: ${id}`)
    const record = { name: meta.name, version: meta.version, license: meta.license, files: {} }
    packages.set(id, record)
    for (const file of entries) {
      const content = await readFile(join(directory, file))
      const path = `${meta.name.replaceAll('/', '__')}@${meta.version}/${file}`
      await mkdir(dirname(join(destination, path)), { recursive: true })
      await writeFile(join(destination, path), content)
      record.files[path] = createHash('sha256').update(content).digest('hex')
    }
    for (const dependency of Object.keys(meta.dependencies ?? {}).sort()) await visit(dependency, directory)
  }
  for (const name of ['react', 'react-dom', '@xyflow/react', 'zustand']) await visit(name, root)
  const inventory = {
    scope: 'Complete frontend runtime dependency closure; may include tree-shaken code and type packages',
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
  await writeFile(join(destination, 'index.json'), JSON.stringify(inventory, null, 2) + '\n')
  return inventory
}

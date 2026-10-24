import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
it('preserves historical experiment fixture bytes and their own protocol scope without migrating them into current facts', async () => {
  const root = new URL('./fixtures/legacy/', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
  expect(manifest.kind).toBe('historical-engineering-evidence')
  expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/)
  for (const [name, entry] of Object.entries(manifest.files) as [string, { sha256: string }][]) {
    const bytes = await readFile(new URL(name, root))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
  }
  expect(manifest.scope).toContain('no protocol migration')
})

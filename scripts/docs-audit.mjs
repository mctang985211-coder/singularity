#!/usr/bin/env node
/** Check local document links and require every document to have an explicit identity. */
import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
async function docsAt(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await docsAt(name)))
    else if (entry.name.endsWith('.md')) found.push(name)
  }
  return found
}
const index = await readFile(join(root, 'docs/documentation-index.md'), 'utf8')
for (const file of await docsAt(join(root, 'docs'))) {
  if (file.endsWith('/documentation-index.md')) continue
  assert.ok(
    index.includes('](' + file.slice(join(root, 'docs/').length) + ')'),
    `document has no current/historical identity: ${file}`,
  )
}
// Only canonical entry points promise live links; historical references preserve their original evidence scope.
for (const name of [
  'README.md',
  'CONTRIBUTING.md',
  'research/README.md',
  'docs/architecture.md',
  'docs/context-governance.md',
  'docs/documentation-index.md',
  'docs/rsi-agent-contract.md',
]) {
  const text = await readFile(join(root, name), 'utf8')
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    await access(join(dirname(join(root, name)), decodeURI(target)))
  }
}
console.log('docs: all identities cataloged; canonical local links resolve')

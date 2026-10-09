#!/usr/bin/env node
/**
 * The mechanical gates.
 *
 * These are the first asset of this codebase, not an afterthought. The previous system had a
 * good design and still grew twelve persisted formats and 197 unreferenced exports, because
 * only two gates existed and neither constrained *shape proliferation*: adding a format cost
 * nothing, removing one cost a hand audit.
 *
 * A gate here is mechanical, cheap, and refuses rather than warns. Adding an exemption is a
 * design decision that belongs in the protocol spec, not in this file.
 *
 * Usage: node scripts/gates.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SOURCE_DIRS = ['src', 'tests']
const MAX_SOURCE_LINES = 400
/** Read-only filesystem surface. Any other `node:fs` name is a durable write. */
const READ_ONLY_FS = new Set([
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'realpath',
  'realpathSync',
  'access',
  'accessSync',
  'readlink',
  'readlinkSync',
  'existsSync',
  'constants',
  'type Stats',
  'type Dirent',
])
const FS_MODULES = new Set(['node:fs', 'node:fs/promises'])

/** Every file under the source directories, as repo-relative posix paths. */
function sourceFiles() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|mts|tsx)$/.test(entry.name)) found.push(relative(ROOT, path))
    }
  }
  for (const directory of SOURCE_DIRS) {
    try {
      if (statSync(join(ROOT, directory)).isDirectory()) walk(join(ROOT, directory))
    } catch {
      // A directory that does not exist yet contributes nothing.
    }
  }
  return found.sort()
}

const files = sourceFiles()
const text = new Map(files.map(file => [file, readFileSync(join(ROOT, file), 'utf8')]))

/** Every name a file exports, from `export <decl>` and from `export { … }` blocks. */
function exportedNames(source) {
  const names = new Set()
  const declarative = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/gm
  for (const match of source.matchAll(declarative)) names.add(match[1])
  const lists = /^export\s*(?:type\s*)?\{([^}]*)\}/gm
  for (const match of source.matchAll(lists)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z0-9_$]+$/.test(name)) names.add(name)
    }
  }
  return names
}

const gates = []
const gate = (name, run) => gates.push({ name, run })

// 1 ── One public surface, stated by name. A barrel hides what a module actually promises.
gate('no-export-star', () => {
  const findings = []
  for (const file of files) {
    const lines = text.get(file).split('\n')
    lines.forEach((line, index) => {
      if (/^\s*export\s+\*/.test(line)) findings.push(`${file}:${index + 1} re-exports a whole module; state the names instead`)
    })
  }
  return findings
})

// 2 ── One append path. A second writer is how a stack grows a second format.
gate('single-durable-writer', () => {
  const findings = []
  const allowed = 'src/protocol/log.ts'
  for (const file of files) {
    if (!file.startsWith('src/') || file === allowed) continue
    const imports = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
    for (const match of text.get(file).matchAll(imports)) {
      if (!FS_MODULES.has(match[2])) continue
      for (const entry of match[1].split(',')) {
        const name = entry.trim().replace(/^type\s+/, '')
        if (name === '' || READ_ONLY_FS.has(name) || READ_ONLY_FS.has(`type ${name}`)) continue
        findings.push(`${file} imports ${name} from ${match[2]}; only ${allowed} may write durably`)
      }
    }
  }
  return findings
})

// 3 ── A module's public surface is what other modules import, plus what the stack exports.
gate('no-unreferenced-export', () => {
  const findings = []
  const entry = 'src/index.ts'
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    const own = file === entry
    for (const name of exportedNames(text.get(file))) {
      const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`)
      // A re-export behind `src/index.ts` counts, because the entry file's own text names it.
      // No shortcut here: assuming "the entry exists" made this gate unable to fail.
      let referenced = false
      for (const other of files) {
        if (other === file) continue
        if (word.test(text.get(other))) {
          referenced = true
          break
        }
      }
      if (!referenced)
        findings.push(
          own
            ? `${file} exports ${name}, which nothing imports; the stack's surface is exactly what is used`
            : `${file} exports ${name}, which no other module imports; drop the keyword or the export`,
        )
    }
  }
  return findings
})

// 4 ── One declaration site per type. Two identical bodies are two things to keep in step.
gate('no-duplicate-type-body', () => {
  const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
  const bodies = new Map()
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    const source = text.get(file)
    const declaration = /export\s+(?:interface|type)\s+([A-Za-z0-9_$]+)(?:\s*<[^>]*>)?\s*=?\s*\{/g
    for (const match of source.matchAll(declaration)) {
      const start = match.index + match[0].length - 1
      let depth = 0
      let end = start
      for (; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1
        else if (source[end] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      const body = strip(source.slice(start, end + 1))
      if (body.length < 40) continue
      const key = `${body.length}:${body}`
      const sites = bodies.get(key) ?? []
      sites.push(`${match[1]} in ${file}`)
      bodies.set(key, sites)
    }
  }
  const findings = []
  for (const sites of bodies.values()) {
    if (sites.length > 1) findings.push(`identical type body declared twice: ${sites.join(' and ')}`)
  }
  return findings
})

// 5 ── Small files are the point of starting over. 400 is a starting bound, not a target.
gate('source-size', () => {
  const findings = []
  for (const file of files) {
    const lines = text.get(file).split('\n').length
    if (lines > MAX_SOURCE_LINES) findings.push(`${file} is ${lines} lines; the bound is ${MAX_SOURCE_LINES}`)
  }
  return findings
})

// 6 ── The ladder allows exactly one compare-and-swap instance.
gate('single-g3-claim', () => {
  const claims = []
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    text
      .get(file)
      .split('\n')
      .forEach((line, index) => {
        if (/guarantee:\s*['"]G3['"]/.test(line)) claims.push(`${file}:${index + 1}`)
      })
  }
  return claims.length > 1 ? [`${claims.length} kinds claim G3 (${claims.join(', ')}); the ladder allows exactly one instance`] : []
})

let failed = 0
console.log(`gates: ${gates.length} gates over ${files.length} files\n`)
for (const { name, run } of gates) {
  const findings = run()
  if (findings.length === 0) {
    console.log(`  ok    ${name}`)
    continue
  }
  failed += 1
  console.log(`  FAIL  ${name}`)
  for (const finding of findings) console.log(`          ${finding}`)
}
console.log('')
if (failed > 0) {
  console.log(`gates: ${failed} of ${gates.length} failed`)
  process.exitCode = 1
} else {
  console.log(`gates: OK — ${gates.length} gates passed`)
}

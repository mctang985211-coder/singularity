#!/usr/bin/env node
/**
 * Persistence-type discipline for singularity's custom SessionEventMap merges.
 *
 * Scans `<workspace>/<pkg>/src/**` for `declare module '@deepseek-ai/dsh-session/types'`
 * blocks, extracts every SessionEventMap member (string-literal event name,
 * explicit payload type, required JSDoc description), and maintains the
 * fingerprint inventory at docs/persistence-schema.json.
 *
 * Usage:
 *   node scripts/verify-persistence.mjs --check   compare source against the inventory (default)
 *   node scripts/verify-persistence.mjs --write   regenerate the inventory after an intended change
 *
 * An intended declaration change also needs a record under docs/persistence-changes/.
 * Zero dependencies; paths derive from this script's location.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const workspace = resolve(import.meta.dirname, '..')
const schemaPath = join(workspace, 'docs', 'persistence-schema.json')
const SESSION_TYPES_MODULE = '@deepseek-ai/dsh-session/types'

const violations = []

/** Recursively list .ts sources under <workspace>/<pkg>/src, skipping build/dependency residue. */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield path
  }
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line += 1
  return line
}

/** Index of the `}` closing the `{` at openIndex, or -1. Declarations here hold no braces in strings. */
function matchBrace(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Description prose of a JSDoc body: comment stars stripped, tags excluded. */
function docProse(raw) {
  return raw
    .split('\n')
    .map(line => line.replace(/^\s*\* ?/, '').trim())
    .filter(line => line.length > 0 && !line.startsWith('@'))
    .join(' ')
    .trim()
}

const memberRe = /\s*(?:\/\*\*(?<doc>[\s\S]*?)\*\/\s*)?'(?<name>[^']+)'\s*:\s*(?<payload>[^\n;]+)/g

/** Collect { name, payload, source } entries from one file, recording violations. */
function collectFile(abs, rel) {
  const text = readFileSync(abs, 'utf8')
  if (!text.includes('SessionEventMap')) return []
  const entries = []
  const moduleRanges = []
  const moduleRe = new RegExp(`declare\\s+module\\s+'${SESSION_TYPES_MODULE.replace(/\//g, '\\/')}'\\s*\\{`, 'g')
  for (const m of text.matchAll(moduleRe)) {
    const open = text.indexOf('{', m.index)
    const close = matchBrace(text, open)
    if (close === -1) {
      violations.push(`${rel}: unterminated declare module '${SESSION_TYPES_MODULE}' block.`)
      continue
    }
    moduleRanges.push([m.index, close])
  }
  for (const m of text.matchAll(/interface\s+SessionEventMap(?<header>[^{]*)\{/g)) {
    const inside = moduleRanges.some(([start, end]) => m.index > start && m.index < end)
    const src = `${rel}:${lineOf(text, m.index)}`
    if (!inside) {
      violations.push(`interface SessionEventMap (${src}) is outside declare module '${SESSION_TYPES_MODULE}'; contribute events only through that merge.`)
      continue
    }
    if (/\bextends\b/.test(m.groups.header)) {
      violations.push(`SessionEventMap declaration (${src}) uses extends; inherited keys would join keyof SessionEventMap without a fingerprint row — declare event members directly.`)
    }
    const open = text.indexOf('{', m.index)
    const close = matchBrace(text, open)
    if (close === -1) {
      violations.push(`${src}: unterminated interface SessionEventMap.`)
      continue
    }
    const body = text.slice(open + 1, close)
    memberRe.lastIndex = 0
    for (const member of body.matchAll(memberRe)) {
      const { doc, name, payload } = member.groups
      const memberSrc = `${rel}:${lineOf(text, open + 1 + member.index)}`
      const prose = doc === undefined ? '' : docProse(doc)
      if (prose.length === 0) {
        violations.push(`log event '${name}' (${memberSrc}) has no JSDoc description; say what the event records and what its payload means.`)
      }
      entries.push({ name, payload: payload.replace(/\s+/g, ' ').trim(), source: rel, src: memberSrc })
    }
    const leftover = body.replace(memberRe, '').replace(/\/\/[^\n]*/g, '').trim()
    if (leftover.length > 0) {
      violations.push(`SessionEventMap declaration (${src}) has an unsupported member form near "${leftover.split('\n')[0].trim()}"; declare every log event as 'scope/name': <payload> on one line.`)
    }
  }
  return entries
}

function collectEvents() {
  const entries = []
  for (const pkg of readdirSync(workspace, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name === 'node_modules' || pkg.name.startsWith('.')) continue
    const srcDir = join(workspace, pkg.name, 'src')
    if (!existsSync(srcDir)) continue
    for (const abs of sourceFiles(srcDir)) {
      entries.push(...collectFile(abs, join(pkg.name, 'src', abs.slice(srcDir.length + 1))))
    }
  }
  const seen = new Map()
  for (const entry of entries) {
    const prior = seen.get(entry.name)
    if (prior !== undefined) {
      violations.push(`log event '${entry.name}' (${entry.src}) is already declared at ${prior}; an event type has exactly one declaration.`)
    } else {
      seen.set(entry.name, entry.src)
    }
  }
  return entries
}

function digestOf(event, payload) {
  return createHash('sha256').update(JSON.stringify({ event, payload })).digest('hex')
}

function schemaText(entries) {
  const roots = entries
    .map(entry => ({
      key: `event:${entry.name}`,
      kind: 'event',
      event: entry.name,
      payload: entry.payload,
      digest: digestOf(entry.name, entry.payload),
      source: entry.source,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
  return JSON.stringify({ formatVersion: 1, roots }, null, 2) + '\n'
}

function reportViolations() {
  if (violations.length === 0) return
  for (const violation of violations) console.error(`verify-persistence: ${violation}`)
  process.exit(1)
}

const mode = process.argv[2] ?? '--check'
if (!['--check', '--write'].includes(mode) || process.argv.length > 3) {
  console.error('usage: node scripts/verify-persistence.mjs [--check|--write]')
  process.exit(2)
}

const entries = collectEvents()
reportViolations()
if (entries.length === 0) {
  console.error('verify-persistence: no SessionEventMap events found under <workspace>/<pkg>/src; the scan corpus is empty or broken.')
  process.exit(1)
}
const next = schemaText(entries)

if (mode === '--write') {
  writeFileSync(schemaPath, next)
  console.log(`verify-persistence: wrote ${schemaPath} (${entries.length} event roots).`)
  process.exit(0)
}

if (!existsSync(schemaPath)) {
  console.error(`verify-persistence: ${schemaPath} is missing; run \`node scripts/verify-persistence.mjs --write\` and record a docs/persistence-changes/ entry.`)
  process.exit(1)
}
let current
try {
  current = JSON.parse(readFileSync(schemaPath, 'utf8'))
} catch {
  console.error(`verify-persistence: ${schemaPath} is not valid JSON; regenerate it with --write.`)
  process.exit(1)
}
const currentRoots = new Map((current.roots ?? []).map(root => [root.key, root]))
const nextRoots = new Map(JSON.parse(next).roots.map(root => [root.key, root]))
const drift = []
for (const [key, root] of nextRoots) {
  const prior = currentRoots.get(key)
  if (prior === undefined) drift.push(`added root ${key} (${root.digest})`)
  else if (prior.digest !== root.digest) drift.push(`changed root ${key}: ${prior.digest} -> ${root.digest}`)
}
for (const key of currentRoots.keys()) {
  if (!nextRoots.has(key)) drift.push(`removed root ${key}`)
}
if (drift.length > 0) {
  console.error('verify-persistence: source drifted from docs/persistence-schema.json:')
  for (const line of drift) console.error(`  ${line}`)
  console.error('Run `node scripts/verify-persistence.mjs --write` and record a docs/persistence-changes/ entry.')
  process.exit(1)
}
console.log(`verify-persistence: OK — ${entries.length} event roots match docs/persistence-schema.json.`)

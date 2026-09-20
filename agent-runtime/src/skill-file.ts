/**
 * Skill files for capability grants: locate the `SKILL.md` a granted skill name
 * refers to and read it into a runtime registration.
 *
 * A capability grant must hold even when the worker's own composition mounts no
 * skill discovery: `skill-filesystem` registers into the preset's layer, so an
 * agent joined to a preset that does not mount it sees no filesystem skills at
 * all — while the SKILL.md sits on disk exactly where the deployment keeps it.
 * This module is that fallback path, and it deliberately covers only the roots
 * the deployment's own discovery covers.
 * @module @dangosys/dsh-singularity-agent-runtime/skill-file
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** How far up from a worker's cwd project skill roots are looked for. */
const PROJECT_LOOKUP_DEPTH = 8

/**
 * A runtime registration, structurally typed: this package consumes the skill
 * service through `ctx.get('skills')` and must not depend on its package.
 */
export interface RuntimeSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly path?: string
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** One parsed `SKILL.md`: the frontmatter the registry needs plus the body. */
export interface ParsedSkillFile {
  readonly path: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly content: string
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseBoolean(value: string | undefined, field: string, path: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = stripQuotes(value).toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`skill file ${path} has a non-boolean "${field}": ${value}`)
}

/**
 * Split `SKILL.md` text into its frontmatter fields and body. The frontmatter
 * grammar accepted here is the flat `key: value` one every skill in this
 * deployment uses; a nested structure fails loudly rather than being guessed at.
 */
export function parseSkillFile(text: string, path: string): ParsedSkillFile {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new Error(`skill file ${path} has no YAML frontmatter (expected a leading "---" line)`)
  }
  const closing = lines.indexOf('---', 1)
  if (closing === -1) throw new Error(`skill file ${path} has an unterminated frontmatter block`)
  const fields = new Map<string, string>()
  for (const line of lines.slice(1, closing)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) throw new Error(`skill file ${path} has a nested frontmatter line this reader does not support: ${line}`)
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error(`skill file ${path} has a frontmatter line without a key: ${line}`)
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined || stripQuotes(name).length === 0) throw new Error(`skill file ${path} frontmatter requires "name"`)
  if (description === undefined || stripQuotes(description).length === 0) {
    throw new Error(`skill file ${path} frontmatter requires "description"`)
  }
  const whenToUse = fields.get('when-to-use') ?? fields.get('whenToUse')
  const modelInvocable = parseBoolean(fields.get('disable-model-invocation'), 'disable-model-invocation', path)
  const userInvocable = parseBoolean(fields.get('user-invocable'), 'user-invocable', path)
  return {
    path,
    name: stripQuotes(name),
    description: stripQuotes(description),
    ...(whenToUse === undefined || whenToUse.length === 0 ? {} : { whenToUse: stripQuotes(whenToUse) }),
    invocation: {
      modelInvocable: modelInvocable !== true,
      userInvocable: userInvocable !== false,
    },
    content: lines.slice(closing + 1).join('\n').replace(/^\n+/, ''),
  }
}

/** The `SKILL.md` for one skill name under one skill root, when both exist. */
async function skillFileIn(root: string, name: string): Promise<string | undefined> {
  const file = join(root, name, 'SKILL.md')
  const info = await stat(file).catch(() => undefined)
  return info?.isFile() === true ? file : undefined
}

/** Skill roots for a worker working in `cwd`: its own project first, then the deployment's user roots. */
async function skillRoots(cwd: string | undefined): Promise<string[]> {
  const roots: string[] = []
  if (cwd !== undefined) {
    let dir = cwd
    for (let level = 0; level <= PROJECT_LOOKUP_DEPTH; level += 1) {
      roots.push(join(dir, '.agents', 'skills'), join(dir, '.dsh', 'skills'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.length > 0) roots.push(join(dshHome, 'skills'))
  roots.push(join(homedir(), '.agents', 'skills'))
  return roots
}

/**
 * Locate the `SKILL.md` a granted skill name refers to.
 * @param name - the skill name a capability declares.
 * @param cwd - the worker's working directory; project roots are searched upward from it.
 * @returns the absolute path, or undefined when no root holds that skill.
 */
export async function findSkillFile(name: string, cwd: string | undefined): Promise<string | undefined> {
  for (const root of await skillRoots(cwd)) {
    const file = await skillFileIn(root, name)
    if (file !== undefined) return file
  }
  return undefined
}

/**
 * Every root {@link findSkillFile} searches, for an error message that tells the
 * operator where a granted skill should have been.
 */
export async function skillRootsFor(cwd: string | undefined): Promise<string[]> {
  return skillRoots(cwd)
}

/**
 * Every `<root>/<name>/SKILL.md` under one extra skill root (the replay
 * overlay), in directory order. Only the directory-bundle form is scanned —
 * the sandbox materializes skills that way — and a root that cannot be read
 * throws, so a broken overlay path fails the spawn loudly with the cause
 * named instead of silently degrading to production skills.
 */
export async function listSkillFiles(root: string): Promise<{ name: string; file: string }[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const found: { name: string; file: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = await skillFileIn(root, entry.name)
    if (file !== undefined) found.push({ name: entry.name, file })
  }
  return found
}

/**
 * Read one granted skill's `SKILL.md` into a runtime registration. A file whose
 * frontmatter names a different skill than the grant asked for is rejected: the
 * registry would otherwise publish a body under the wrong name.
 * @param file - absolute path from {@link findSkillFile}.
 * @param name - the granted skill name, which the file must declare.
 * @returns the registration to hand to `ctx.skills.register`.
 */
export async function readSkillFile(file: string, name: string): Promise<RuntimeSkill> {
  const parsed = parseSkillFile(await readFile(file, 'utf8'), file)
  if (parsed.name !== name) {
    throw new Error(`skill file ${file} declares name "${parsed.name}" but the capability grants "${name}"`)
  }
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    invocation: parsed.invocation,
    source: 'runtime',
    path: parsed.path,
    resourceBase: { kind: 'directory', path: dirname(parsed.path) },
    content: parsed.content,
  }
}

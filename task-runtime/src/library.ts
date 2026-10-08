/** A graph's reusable contracts and methods, kept independently of its execution checkout. */
import { mkdir, readFile, readdir, writeFile, rename, cp, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import type { TaskTemplate, TaskTemplateRef } from '@dangosys/dsh-singularity-task'
import { parseSkillFile } from '@dangosys/dsh-singularity-agent-runtime'
import { findTaskTemplates, registerTaskTemplate } from './task-template.ts'
import type { CapabilityConfig } from './capability.ts'

export interface TaskLibrary {
  id: string
  root: string
  taskTemplatesRoot: string
  skillRoot: string
}
export type LibraryStatus = 'temporary' | 'retained' | 'retired'
export interface LibrarySkill {
  name: string
  version: number
  digest: string
  status: LibraryStatus
  reason?: string
  reviewedBy?: string
}
export interface LibraryTask {
  templateRef: TaskTemplateRef
  status: LibraryStatus
  skills: string[]
  reason?: string
  reviewedBy?: string
}
export interface TaskLibraryIndex {
  version: 1
  tasks: LibraryTask[]
  skills: LibrarySkill[]
}
export type LibraryWrite = { kind: 'task'; template: TaskTemplate } | {
  kind: 'skill'; name: string; skillMd: string; expectedVersion?: number
}
export interface LibraryReview {
  kind: 'task' | 'skill'
  name: string
  version: number
  status: 'retained' | 'retired'
  reason: string
}

/** Derived from the graph's immutable root identity; no second persistent binding. */
export function graphLibrary(rootSessionId: string, home = process.env.DSH_HOME || join(homedir(), '.dsh')): TaskLibrary {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(rootSessionId)) throw new Error('task-library: invalid graph root session id')
  const root = join(home, 'singularity', 'environments', rootSessionId)
  return { id: rootSessionId, root, taskTemplatesRoot: join(root, 'task-templates'), skillRoot: join(root, 'skills') }
}

const tails = new Map<string, Promise<unknown>>()
async function serial<T>(library: TaskLibrary, work: () => Promise<T>): Promise<T> {
  const pending = (tails.get(library.root) ?? Promise.resolve()).catch(() => {}).then(work)
  tails.set(library.root, pending)
  try { return await pending } finally { if (tails.get(library.root) === pending) tails.delete(library.root) }
}
async function readIndex(library: TaskLibrary): Promise<TaskLibraryIndex> {
  try {
    const index = JSON.parse(await readFile(join(library.root, 'index.json'), 'utf8')) as TaskLibraryIndex
    if (index.version !== 1 || !Array.isArray(index.tasks) || !Array.isArray(index.skills)) throw new Error('task-library: unsupported index')
    return index
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, tasks: [], skills: [] }
  }
}
async function saveIndex(library: TaskLibrary, index: TaskLibraryIndex): Promise<void> {
  const temporary = join(library.root, `.index-${randomUUID()}.json`)
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, join(library.root, 'index.json'))
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function skillsOf(template: TaskTemplate, table: Readonly<Record<string, CapabilityConfig>> = {}): string[] {
  return [...new Set((template.contract.requiredCapabilities ?? []).flatMap(name =>
    name.startsWith('method:') ? [name.slice(7)] : name === 'execute-task' ? ['task-coordination'] : table[name]?.skills ?? []))]
}

/** Generic platform guidance is seeded once; domain libraries are authored by the graph's agents. */
export async function ensureTaskLibrary(library: TaskLibrary): Promise<TaskLibrary> {
  return serial(library, async () => {
    await mkdir(library.taskTemplatesRoot, { recursive: true })
    await mkdir(library.skillRoot, { recursive: true })
    const installed = join(library.root, '.initialized')
    try { await stat(installed); return library } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const source = join(dirname(fileURLToPath(import.meta.resolve('@dangosys/dsh-singularity-agent-runtime/package.json'))), 'skills/task-coordination/SKILL.md')
    const text = await readFile(source, 'utf8')
    const target = join(library.skillRoot, 'task-coordination')
    await mkdir(target, { recursive: true })
    try { await writeFile(join(target, 'SKILL.md'), text, { flag: 'wx' }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const index = await scanIndex(library, await readIndex(library))
    const builtIn = index.skills.find(item => item.name === 'task-coordination')
    if (builtIn !== undefined && builtIn.reason === undefined) { builtIn.status = 'retained'; builtIn.reason = 'Generic platform task coordination guidance' }
    await saveIndex(library, index)
    await writeFile(installed, '1\n', { flag: 'wx' })
    return library
  })
}

/** Include methods published through Evolution in the same small table as temporary agent drafts. */
async function scanIndex(library: TaskLibrary, index: TaskLibraryIndex): Promise<TaskLibraryIndex> {
  for (const { templateRef, template } of await findTaskTemplates(library.taskTemplatesRoot, undefined, undefined, true)) {
    if (!index.tasks.some(item => item.templateRef.id === templateRef.id && item.templateRef.version === templateRef.version))
      index.tasks.push({ templateRef, status: 'temporary', skills: skillsOf(template) })
  }
  for (const entry of await readdir(library.skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    let text: string
    try { text = await readFile(join(library.skillRoot, entry.name, 'SKILL.md'), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const parsed = parseSkillFile(text, join(library.skillRoot, entry.name, 'SKILL.md'))
    if (parsed.name !== entry.name) throw new Error(`task-library: ${entry.name} declares ${parsed.name}`)
    const latest = index.skills.filter(item => item.name === entry.name).at(-1)
    if (latest?.digest !== digest(text)) index.skills.push({ name: entry.name, version: (latest?.version ?? 0) + 1, digest: digest(text), status: 'temporary' })
  }
  return index
}
export async function readTaskLibrary(library: TaskLibrary): Promise<TaskLibrary & TaskLibraryIndex> {
  await ensureTaskLibrary(library)
  return serial(library, async () => {
    const index = await scanIndex(library, await readIndex(library))
    await saveIndex(library, index)
    return { ...library, ...index }
  })
}
export async function writeTaskLibrary(library: TaskLibrary, input: LibraryWrite, table?: Readonly<Record<string, CapabilityConfig>>): Promise<LibraryTask | LibrarySkill> {
  await ensureTaskLibrary(library)
  return serial(library, async () => {
    const index = await scanIndex(library, await readIndex(library))
    if (input.kind === 'task') {
      const templateRef = await registerTaskTemplate(library.taskTemplatesRoot, input.template)
      let row = index.tasks.find(item => item.templateRef.id === templateRef.id && item.templateRef.version === templateRef.version)
      if (row === undefined) { row = { templateRef, status: 'temporary', skills: skillsOf(input.template, table) }; index.tasks.push(row) }
      await saveIndex(library, index)
      return row
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.name)) throw new Error('task-library: invalid Skill name')
    const file = join(library.skillRoot, input.name, 'SKILL.md')
    if (parseSkillFile(input.skillMd, file).name !== input.name) throw new Error('task-library: Skill frontmatter name must match')
    const previous = index.skills.filter(item => item.name === input.name).at(-1)
    if (previous?.digest === digest(input.skillMd)) return previous
    if (input.expectedVersion !== (previous?.version ?? 0)) throw new Error(`task-library: expectedVersion must be ${previous?.version ?? 0}; read the current version before changing a Skill`)
    if (previous !== undefined) {
      const archive = join(library.root, 'skill-versions', input.name, String(previous.version))
      await mkdir(dirname(archive), { recursive: true })
      await cp(dirname(file), archive, { recursive: true, errorOnExist: true, force: false }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
    }
    await mkdir(dirname(file), { recursive: true })
    const temporary = join(dirname(file), `.SKILL-${randomUUID()}.md`)
    await writeFile(temporary, input.skillMd, { flag: 'wx' })
    await rename(temporary, file)
    const row: LibrarySkill = { name: input.name, version: (previous?.version ?? 0) + 1, digest: digest(input.skillMd), status: 'temporary' }
    index.skills.push(row)
    await saveIndex(library, index)
    return row
  })
}
export async function reviewTaskLibrary(library: TaskLibrary, review: LibraryReview, reviewedBy: string): Promise<LibraryTask | LibrarySkill> {
  await ensureTaskLibrary(library)
  return serial(library, async () => {
    if (review.kind === 'skill' && review.name === 'task-coordination' && review.status === 'retired')
      throw new Error('task-coordination supplies execute-task; retain or revise it to keep generic tasks executable')
    if (!review.reason.trim()) throw new Error('task-library: review requires a reason from execution evidence')
    const index = await scanIndex(library, await readIndex(library))
    const row = review.kind === 'task'
      ? index.tasks.find(item => item.templateRef.id === review.name && item.templateRef.version === review.version)
      : index.skills.find(item => item.name === review.name && item.version === review.version)
    if (row === undefined) throw new Error('task-library: reviewed version is absent')
    row.status = review.status; row.reason = review.reason; row.reviewedBy = reviewedBy
    await saveIndex(library, index)
    return row
  })
}
export async function libraryCapabilities(library: TaskLibrary): Promise<Record<string, CapabilityConfig>> {
  const index = await readTaskLibrary(library)
  const latest = new Map(index.skills.map(item => [item.name, item]))
  return {
    'execute-task': { skills: ['task-coordination'], tools: ['filesystem', 'search', 'bash', 'jobs', 'skill'] },
    ...Object.fromEntries([...latest.values()].filter(item => item.status !== 'retired').map(item => [`method:${item.name}`, { skills: [item.name], tools: ['skill'] }])),
  }
}

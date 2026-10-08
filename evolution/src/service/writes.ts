/** Verify that a production Skill directory holds only the complete file set an intent names. */
import { readdir } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { SUPPORTED_SKILL_RESOURCE_DIRS } from '@dangosys/dsh-singularity-task-runtime'
import type { CommitIntentView } from '../types.ts'

export async function objectWriteRefusal(intent: CommitIntentView): Promise<string | null> {
  if (intent.files.length === 0) return null
  const directory = dirname(intent.files[0]!.target)
  const own = new Set(intent.files.map(file => relative(directory, file.target)))
  const directories = new Set(SUPPORTED_SKILL_RESOURCE_DIRS)
  const walk = async (at: string, prefix = ''): Promise<string | null> => {
    let entries
    try { entries = await readdir(at, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return `${at} cannot be read to check what it holds`
    }
    for (const entry of entries) {
      const path = prefix + entry.name
      if (entry.isDirectory() && prefix === '' && directories.has(entry.name)) {
        const refusal = await walk(`${at}/${entry.name}`, `${entry.name}/`)
        if (refusal !== null) return refusal
        continue
      }
      if (entry.isFile() && (own.has(path) || [...own].some(file => {
        const parts = file.split('/')
        const name = parts.pop()!
        return path.startsWith(`${parts.length ? parts.join('/') + '/' : ''}.${name}.tmp-`)
      }))) continue
      return `Skill directory "${directory}" carries ${path} outside the frozen commit file set`
    }
    return null
  }
  return walk(directory)
}

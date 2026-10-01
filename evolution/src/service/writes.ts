/** The production-write refusals: what an open commit intent must have left in production before a write may land.
 * @module dsh-singularity-evolution/service/writes */

import { readdir } from 'node:fs/promises'
import { type Dirent } from 'node:fs'
import { basename, dirname } from 'node:path'
import { loadSkillSidecar, SKILL_SIDECAR_FILE } from '@dangosys/dsh-singularity-task-runtime'

import type { CommitIntentView } from '../types.ts'

/** The named reason a commit intent must not write the directory its file set names, or `null` when the write may proceed. */
export async function objectWriteRefusal(intent: CommitIntentView): Promise<string | null> {
  if (intent.files.length === 0) return null
  const skillMd = intent.files[0]!
  const directory = dirname(skillMd.target)
  const own = new Set(intent.files.map(file => basename(file.target)))
  const staging = [...own].map(name => `.${name}.tmp-`)
  const creates = intent.files.every(file => file.baselineSha256 === null)
  const removes = intent.files.every(file => file.contentSha256 === null)
  if (!creates && !removes && intent.files.some(file => file.baselineSha256 === null || file.contentSha256 === null)) {
    return (
      'the fixed file set of one skill object is created or removed whole, and this intent mixes a file with a production state and ' +
      'a file without one'
    )
  }
  const listDirectory = async (): Promise<Dirent[] | string> => {
    try {
      return await readdir(directory, { withFileTypes: true })
    } catch (error) {
      // The directory is not there: nothing to inspect, which is exactly the
      // state a create needs and the state a removal has already reached.
      return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? []
        : `the production directory "${directory}" cannot be read to check what it holds ` +
            `(${error instanceof Error ? error.message : String(error)}) — the entries this commit would leave beside its own are unknown`
    }
  }
  if (creates || removes) {
    const entries = await listDirectory()
    if (typeof entries === 'string') return entries
    const foreign = entries
      .filter(
        entry =>
          !own.has(entry.name) && !(staging.some(prefix => entry.name.startsWith(prefix)) && !entry.isDirectory()),
      )
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
    if (foreign.length === 0) return null
    // The intent's own named files are allowed on both sides of a create or a removal.
    return creates
      ? `this commit creates the skill object "${directory}" where nothing was, and the directory already holds ` +
          `${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} ` +
          `(${foreign.map(name => JSON.stringify(name)).join(', ')}) — a new object is written where production holds nothing, so a ` +
          'directory carrying anything else is not the state this intent describes'
      : `this commit removes the files of skill object "${directory}" ` +
          `(${[...own]
            .sort()
            .map(name => JSON.stringify(name))
            .join(', ')}), and the directory holds ` +
          `${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} the intent does not name ` +
          `(${foreign.map(name => JSON.stringify(name)).join(', ')}) — a removal takes back what this candidate created and leaves ` +
          'everything else exactly where it is, so a directory holding more is not one this intent may empty'
  }
  if (intent.files.length === 1) {
    const loaded = await loadSkillSidecar(directory)
    if (loaded.sidecar !== undefined) {
      return (
        `the guidance object this intent commits is the single file "${basename(skillMd.target)}", and the directory now carries a ` +
        `${SKILL_SIDECAR_FILE} the intent does not name — it is an execution object the committed file set does not describe`
      )
    }
    const resources = loaded.content?.resources.map(resource => resource.path) ?? []
    if (resources.length > 0) {
      return (
        `the guidance object this intent commits is the single file "${basename(skillMd.target)}", and the directory now holds ` +
        `${resources.length} file(s) at a supported resource position the intent does not name ` +
        `(${resources.map(path => JSON.stringify(path)).join(', ')}) — nothing declares them and no commit of this build writes them`
      )
    }
    if (loaded.defects.length > 0) {
      return (
        'the directory is not the loadable object its files claim — ' +
        loaded.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
      )
    }
    return null
  }
  // A directory that cannot even be listed is a *reason*, not an exception: the caller reports it by name.
  const entries = await listDirectory()
  if (typeof entries === 'string') return entries
  const foreign = entries
    .filter(
      entry => !own.has(entry.name) && !(staging.some(prefix => entry.name.startsWith(prefix)) && !entry.isDirectory()),
    )
    .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
  if (foreign.length === 0) return null
  return (
    `an execution object's fixed file set names every file in its directory ` +
    `(${[...own]
      .sort()
      .map(name => JSON.stringify(name))
      .join(', ')}), and the directory holds ` +
    `${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} the intent does not name ` +
    `(${foreign.map(name => JSON.stringify(name)).join(', ')})`
  )
}

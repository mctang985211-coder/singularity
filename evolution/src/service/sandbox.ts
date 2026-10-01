/** Sandbox materialization: the candidate's files written under the proposal's sandbox directory.
 * @module dsh-singularity-evolution/service/sandbox */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { SKILL_SIDECAR_FILE } from '@dangosys/dsh-singularity-task-runtime'
import type { SkillContentIdentity } from '../replay.ts'

import { candidateSidecar, contractIdentityOf, loadedSidecar } from './skill-files.ts'
import { resolveWithin } from '../shared.ts'
import type { SkillMutation } from '../types.ts'

/** Write the candidate object into the sandbox dir `dir`, then the champion snapshot of the production object. */
export async function materialize(
  dir: string,
  mutation: Record<string, unknown>,
  production: { skillMd: Buffer; sidecar?: Buffer },
): Promise<{ files: string[]; skillBaseline: SkillContentIdentity }> {
  const files: string[] = []
  const write = async (rel: string, content: string | Buffer): Promise<void> => {
    const abs = resolveWithin(dir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    files.push(rel)
  }
  // This build materializes a skill candidate and nothing else: `candidate`
  const { name, content } = mutation as unknown as SkillMutation
  const candidateMd = Buffer.from(content, 'utf8')
  await write(`skills/${name}/SKILL.md`, candidateMd)
  if (production.sidecar !== undefined) {
    await write(
      `skills/${name}/${SKILL_SIDECAR_FILE}`,
      candidateSidecar(loadedSidecar(production.sidecar), sha256Hex(candidateMd)),
    )
  }
  await write(`champion/skills/${name}/SKILL.md`, production.skillMd)
  if (production.sidecar !== undefined) {
    await write(`champion/skills/${name}/${SKILL_SIDECAR_FILE}`, production.sidecar)
    return {
      files,
      skillBaseline: {
        name,
        sha256: sha256Hex(production.skillMd),
        contract: contractIdentityOf(production.sidecar),
      },
    }
  }
  return { files, skillBaseline: { name, sha256: sha256Hex(production.skillMd) } }
}

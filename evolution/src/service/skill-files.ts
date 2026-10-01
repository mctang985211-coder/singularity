/** The production skill files this plane reads and writes: the verified read of an object, its sidecar and its contract identity.
 * @module dsh-singularity-evolution/service/skill-files */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import {
  readVerifiedFile,
  serializeSkillSidecar,
  sidecarWithSkillMd,
  SKILL_SIDECAR_FILE,
  skillContractDigest,
  walkVerified,
} from '@dangosys/dsh-singularity-task-runtime'
import type { SkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import { readPreparedCapability } from '../capability-candidate.ts'

import type { CommitDirection, EvolutionProposal } from '../types.ts'

/** The production skill target as it stands right now (P3): `null` when nothing stands there. */
export async function readProductionSkill(
  skillRoot: string,
  relative: string,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const walked = await walkVerified(skillRoot, relative)
  if (walked.missing) return null
  const bytes = await readFile(walked.abs)
  return { bytes, sha256: sha256Hex(bytes) }
}

/** The production path of one skill object's `SKILL.md`, as the executor writes and reads it. */
export function productionSkillRelative(name: string): string {
  return join(name, 'SKILL.md')
}

/** The production path of one skill object's sidecar file, beside the `SKILL.md`. */
export function productionSidecarRelative(name: string): string {
  return join(name, SKILL_SIDECAR_FILE)
}

/** One skill object's declared sidecar, parsed from the exact bytes that were read. */
export function loadedSidecar(bytes: Buffer): SkillSidecar {
  return JSON.parse(bytes.toString('utf8')) as SkillSidecar
}

/** The candidate sidecar of one execution object: the production declaration with the candidate's own SKILL.md digest. */
export function candidateSidecar(production: SkillSidecar, skillMdSha256: string): string {
  return serializeSkillSidecar(sidecarWithSkillMd(production, skillMdSha256))
}

/** Fold a sidecar's declared data into a {@link SkillContractIdentity}: the file's digest and the declaration's contract digest. */
export function contractIdentityOf(bytes: Buffer): { sha256: string; contractDigest: string } {
  return { sha256: sha256Hex(bytes), contractDigest: skillContractDigest(loadedSidecar(bytes)) }
}

export async function readVerifiedSkillCandidate(
  root: string,
  skillRoot: string,
  proposal: EvolutionProposal,
): Promise<{ skillMd: Buffer; sidecar?: Buffer }> {
  if (proposal.targetType !== 'skill') {
    throw new Error(`evolution: candidate content identity binds skill proposals only, not "${proposal.targetType}"`)
  }
  const sandbox = proposal.prepared?.sandbox
  const identity = proposal.prepared?.skillContent
  if (sandbox == null || identity === undefined) {
    // The fold requires both on every prepared record, so this branch is a
    // belt for the view's optional fields rather than a reachable state.
    throw new Error(
      `evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — ` +
        'propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized files)',
    )
  }
  const rel = `${sandbox}/skills/${identity.name}/SKILL.md`
  const skillMd = await readVerifiedFile(root, rel)
  const digest = sha256Hex(skillMd)
  if (digest !== identity.sha256) {
    throw new Error(
      `evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare ` +
        `(sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
    )
  }
  const sidecarRel = `${sandbox}/skills/${identity.name}/${SKILL_SIDECAR_FILE}`
  let sidecar: Buffer | undefined
  try {
    sidecar = await readVerifiedFile(root, sidecarRel)
  } catch (error) {
    const reason = (error as Error).message.replace(/^verified-read: /, '')
    if (identity.contract === undefined) {
      // The identity records guidance: the read itself is the probe for the sidecar's presence.
      if (/is missing under/.test((error as Error).message)) return { skillMd }
      throw new Error(
        `evolution: skill candidate "${sidecarRel}" is present but cannot be read as a real file (${reason}), while the content ` +
          'identity recorded at prepare is guidance (no sidecar) — propose a new candidate and re-evaluate it',
      )
    }
    throw new Error(
      `evolution: skill candidate "${sidecarRel}" recorded at prepare (sha256 ${identity.contract.sha256}) cannot be read as a real ` +
        `file (${reason}) — propose a new candidate and re-evaluate it`,
    )
  }
  if (identity.contract === undefined) {
    throw new Error(
      `evolution: skill candidate "${sidecarRel}" exists in the sandbox, but the content identity recorded at prepare is guidance ` +
        '(no sidecar) — the candidate is no longer the object the experiment evaluated: propose a new candidate and re-evaluate it',
    )
  }
  const sidecarDigest = sha256Hex(sidecar)
  if (sidecarDigest !== identity.contract.sha256) {
    throw new Error(
      `evolution: skill candidate "${sidecarRel}" no longer matches the content identity recorded at prepare ` +
        `(sha256 ${sidecarDigest} != ${identity.contract.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
    )
  }
  return { skillMd, sidecar }
}

/** The verified bytes one capability commit writes, in the request's file order, one entry per file. */
export async function capabilityBytes(
  root: string,
  proposal: EvolutionProposal,
  direction: CommitDirection,
): Promise<(Buffer | undefined)[]> {
  const content = proposal.prepared?.skillContent
  if (content === undefined) return []
  if (direction === 'rollback') return content.contract === undefined ? [undefined] : [undefined, undefined]
  const prepared = await readPreparedCapability(root, proposal)
  if (prepared.skill === undefined) {
    throw new Error(
      `evolution: capability proposal "${proposal.proposalId}" commits a file set but its prepared identity records no readable new ` +
        'skill — the two cannot both be true, so nothing was written',
    )
  }
  return [prepared.skill.skillMd, prepared.skill.sidecarBytes]
}

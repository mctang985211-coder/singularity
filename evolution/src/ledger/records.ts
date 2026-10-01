/** Record payload validation for the ledger's own lines, shared by the write doors and the fold.
 * @module dsh-singularity-evolution/ledger/records */

import { basename, dirname, resolve } from 'node:path'
import type { ProposalTargetType, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { SKILL_SIDECAR_FILE } from '@dangosys/dsh-singularity-task-runtime'
import type { RootRecoveryOutcome } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityRowIdentity } from '../capability-candidate.ts'
import { assertCapabilityRow, capabilityRowDigest, validateCapabilityMutation } from '../capability-candidate.ts'
import type { SkillContentIdentity } from '../replay.ts'
import type { CapabilityTableIdentity, CapabilityTableStates } from '../capability-config.ts'

import { assertOnlyKeys, assertSegment, isRecord, nonEmpty } from '../shared.ts'
import type { CommitDirection, CommitIntentRecord } from '../types.ts'

/** Validate a candidate's mutation. This build has exactly two candidate lifecycles: a same-name SKILL.md replacement and one capability row. */
export function validateMutation(
  targetType: ProposalTargetType,
  mutation: unknown,
): asserts mutation is Record<string, unknown> {
  if (!isRecord(mutation)) throw new Error('evolution: mutation must be an object')
  if (targetType === 'capability') {
    validateCapabilityMutation(mutation)
    return
  }
  if (targetType !== 'skill') {
    throw new Error(
      `evolution: a "${targetType}" mutation has no schema in this build — the candidate lifecycles here are a SKILL.md replacement of an ` +
        'existing skill object and one whole capability row with an optional new execution skill, and every other target type is a recorded proposal',
    )
  }
  assertOnlyKeys(mutation, ['name', 'content'], 'skill mutation')
  assertSegment(mutation.name, 'mutation.name')
  nonEmpty(mutation.content, 'mutation.content')
}

/** Candidate versionSet payload validation, shared by the write path (`candidate`) and the fold. */
export function validateVersionSet(versionSet: unknown): void {
  if (!isRecord(versionSet)) throw new Error('evolution: versionSet must be an object')
  const entries = Object.entries(versionSet)
  if (entries.length === 0) throw new Error('evolution: versionSet must record at least one version')
  for (const [key, value] of entries) {
    nonEmpty(key, 'versionSet key')
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`evolution: versionSet["${key}"] must be a non-empty string`)
    }
  }
}

/** Gate-answers payload validation, shared by the write path (`gate`) and the fold. */
export function validateGateAnswers(answers: unknown): void {
  if (!isRecord(answers)) throw new Error('evolution: gate answers must be an object')
  nonEmpty(answers.targetFailureFixed, 'gate answer "1. Target failure fixed?"')
  nonEmpty(answers.originalAcceptanceMaintained, 'gate answer "2. Original acceptance maintained?"')
  nonEmpty(answers.existingRegressionMaintained, 'gate answer "3. Existing regression maintained?"')
  nonEmpty(answers.noUnacceptableSideEffects, 'gate answer "4. No unacceptable side effects?"')
  nonEmpty(answers.holdoutPerformanceAcceptable, 'gate answer "5. Holdout performance acceptable?"')
  nonEmpty(answers.resourceCostAcceptable, 'gate answer "6. Resource cost acceptable?"')
  if (!Array.isArray(answers.regressionEvidenceRefs) || answers.regressionEvidenceRefs.length === 0) {
    throw new Error('evolution: the regression/replay answer must cite at least one evidence ref')
  }
  for (const ref of answers.regressionEvidenceRefs) nonEmpty(ref, 'regression evidence ref')
}

/** One format, one check (K3): every line this ledger reads, folds or writes declares formatVersion 4, and nothing else. */
export function assertLedgerFormatVersion(record: { formatVersion?: unknown }, position: string): void {
  if (record.formatVersion === 4) return
  throw new Error(
    `evolution: ${position} declares formatVersion ${JSON.stringify(record.formatVersion ?? null)} — ` +
      'this build reads and writes formatVersion 4 only, so a v1, a v2, a v3, an unversioned or a mixed ledger is refused before any ' +
      'new record is appended (archive the old ledger and start a new one; no migration, no dual-format read and no older-record reader ' +
      'is offered, because a ledger written before v4 records one file per commit intent and no sidecar half in a prepare identity, so ' +
      'a two-file commit against it could not be reconciled)',
  )
}

/** Commit-intent payload validation, shared by the write path ({@link CommitIntentRecord}) and the fold. */
export function validateCommitIntent(record: CommitIntentRecord): void {
  const nonEmptyFields = [
    ['proposalId', record.proposalId],
    ['intentId', record.intentId],
    ['approvalRef', record.approvalRef],
    ['actor', record.actor],
    ['at', record.at],
  ] as const
  for (const [field, value] of nonEmptyFields) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `evolution: commit_intent record for proposal "${String(record.proposalId)}" has no ${field} — an intent names the proposal, ` +
          'the direction, the human approval, the fixed file set it commits, the bytes to write again for every file and its actor, ' +
          'so a line missing any of them cannot be reconciled',
      )
    }
  }
  if (record.direction !== 'apply' && record.direction !== 'rollback') {
    throw new Error(
      `evolution: commit_intent record for proposal "${record.proposalId}" declares direction ${JSON.stringify(record.direction ?? null)} ` +
        '— a commit intent is "apply" or "rollback"',
    )
  }
  const files = record.files
  if (!Array.isArray(files) || files.length > 2 || (files.length === 0 && record.capability === undefined)) {
    throw new Error(
      `evolution: commit_intent record for proposal "${record.proposalId}" names ${Array.isArray(files) ? `${files.length} file(s)` : 'no file list'} ` +
        `and ${record.capability === undefined ? 'no capability row' : `capability row "${record.capability.name}"`} — a commit carries a fixed file ` +
        'set of one or two files (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar) and/or exactly one capability row',
    )
  }
  files.forEach((file, index) => {
    const at = `commit_intent record for proposal "${record.proposalId}" file ${index}`
    if (!isRecord(file)) {
      throw new Error(`evolution: ${at} is not an object carrying target, baselineSha256, contentSha256, source`)
    }
    if (typeof file.target !== 'string' || file.target.trim().length === 0) {
      throw new Error(`evolution: ${at} has no target — every file names the absolute production path it writes`)
    }
    for (const [field, value] of [
      ['baselineSha256', file.baselineSha256],
      ['contentSha256', file.contentSha256],
    ] as const) {
      if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
        throw new Error(
          `evolution: ${at} has no valid ${field} (${JSON.stringify(value ?? null)}) — an intent binds, for every file, the exact ` +
            'bytes production must hold before the write and the exact bytes it must hold after, or `null` for the state "no file here"',
        )
      }
    }
    if (file.baselineSha256 === null && file.contentSha256 === null) {
      throw new Error(
        `evolution: ${at} records no file before the commit and no file after it — an intent that neither creates, replaces nor removes ` +
          'anything names nothing',
      )
    }
    if (file.contentSha256 !== null) {
      if (typeof file.source !== 'string' || file.source.trim().length === 0) {
        throw new Error(
          `evolution: ${at} has no source — a file this commit writes must name the recoverable bytes a recovery would write again`,
        )
      }
    } else if (file.source !== undefined) {
      throw new Error(
        `evolution: ${at} names the source ${JSON.stringify(file.source)} while it removes the file — a removal has no bytes to write again`,
      )
    }
    if (file.target !== resolve(file.target)) {
      throw new Error(
        `evolution: ${at} names target "${file.target}" — an intent names the absolute production paths it commits`,
      )
    }
    if (basename(file.target) !== (index === 0 ? 'SKILL.md' : SKILL_SIDECAR_FILE)) {
      throw new Error(
        `evolution: ${at} names target "${file.target}" — the file set of one skill object is ordered and fixed: SKILL.md first, ` +
          `and, when the object carries an execution sidecar, ${SKILL_SIDECAR_FILE} second`,
      )
    }
    if (index > 0 && dirname(file.target) !== dirname(files[0]!.target)) {
      throw new Error(
        `evolution: ${at} names target "${file.target}" beside "${files[0]!.target}" — the files of one skill object live in one ` +
          'directory, the one a loader reads whole',
      )
    }
  })
  const capability = record.capability
  if (capability === undefined) return
  const at = `commit_intent record for proposal "${record.proposalId}" capability row`
  if (!isRecord(capability) || typeof capability.name !== 'string' || capability.name.trim().length === 0) {
    throw new Error(`evolution: ${at} names no row — a capability commit carries the one row it moves, by name`)
  }
  for (const [field, value] of [
    ['baselineSha256', capability.baselineSha256],
    ['contentSha256', capability.contentSha256],
  ] as const) {
    if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error(
        `evolution: ${at} "${capability.name}" has no valid ${field} (${JSON.stringify(value ?? null)}) — the row's two states are the ` +
          'canonical digests the registry must hold before and after the write, or `null` for "no row of this name"',
      )
    }
  }
  if (capability.baselineSha256 === null && capability.contentSha256 === null) {
    throw new Error(
      `evolution: ${at} "${capability.name}" moves nothing — an intent that neither installs nor removes a row names a row it does not move`,
    )
  }
  if (capability.contentSha256 !== null) {
    if (typeof capability.source !== 'string' || capability.source.trim().length === 0) {
      throw new Error(
        `evolution: ${at} "${capability.name}" has no source — the row this commit installs must name the recoverable bytes a recovery ` +
          'would write again',
      )
    }
  } else if (capability.source !== undefined) {
    throw new Error(
      `evolution: ${at} "${capability.name}" names the source ${JSON.stringify(capability.source)} while it removes the row — a removal ` +
        'has no bytes to write again',
    )
  }
}

/** The prepared record's frozen row identity, validated: the row's name, the row's data and the digest of its canonical bytes. */
export function preparedRowIdentity(value: unknown, field: string, proposalId: string): CapabilityRowIdentity {
  const at = `prepared record for "${proposalId}"`
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  ) {
    throw new Error(
      `evolution: ${at} has no valid ${field} identity — every capability prepare records the row it fixes (or the row the registry ` +
        'held) by name, by its data and by the SHA-256 of its canonical bytes',
    )
  }
  const entry = assertCapabilityRow(`${at} ${field}`, value.entry)
  if (capabilityRowDigest(entry) !== value.digest) {
    throw new Error(
      `evolution: ${at} ${field} "${value.name}" carries data hashing to ${capabilityRowDigest(entry)}, not the ${value.digest} it ` +
        'records — a row whose data and identity disagree is not one this plane froze',
    )
  }
  return { name: value.name, entry, digest: value.digest }
}

/** A prepared record's frozen table identity (A6), validated: the three whole-file digests a capability prepare freezes. */
export function preparedCapabilityTable(
  value: unknown,
  field: string,
  proposalId: string,
): CapabilityTableIdentity | undefined {
  if (value === undefined) return undefined
  const at = `prepared record for "${proposalId}"`
  if (!isRecord(value)) {
    throw new Error(
      `evolution: ${at} has a ${field} that is not an object — a capability prepare freezes the composed identity of the table file ` +
        'its row is written into as three whole-file digests and nothing else',
    )
  }
  const digestOf = (half: 'baselineSha256' | 'applySha256' | 'rollbackSha256'): string => {
    const digest = value[half]
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        `evolution: ${at} has no valid ${field}.${half} (${JSON.stringify(digest ?? null)}) — a capability prepare freezes the whole-file ` +
          'SHA-256 of the table as it read it (`baselineSha256`) and of the table its own apply and rollback leave (`applySha256` / ' +
          "`rollbackSha256`), so a file a third party moved is a named stop and the commit's own result is still recognized",
      )
    }
    return digest
  }
  return {
    baselineSha256: digestOf('baselineSha256'),
    applySha256: digestOf('applySha256'),
    rollbackSha256: digestOf('rollbackSha256'),
  }
}

/** The two whole-file states one capability direction may find in the deployment's table file. */
export function capabilityTableStates(
  direction: CommitDirection,
  table: CapabilityTableIdentity,
): CapabilityTableStates {
  return direction === 'apply'
    ? { beforeSha256: table.baselineSha256, afterSha256: table.applySha256 }
    : { beforeSha256: table.applySha256, afterSha256: table.rollbackSha256 }
}

/** One half of a prepared record's frozen identity, validated and normalized: the object's name, its SKILL.md digest and, when it carries one, its sidecar contract. */
export function preparedIdentity(value: unknown, field: string, proposalId: string): SkillContentIdentity {
  const at = `prepared record for "${proposalId}"`
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error(
      `evolution: ${at} has no valid ${field} identity — every prepare records the content identity of the object's files ` +
        `(${
          field === 'skillContent'
            ? 'the materialized candidate SKILL.md'
            : 'the production SKILL.md it read before materializing the candidate'
        })`,
    )
  }
  const contract = value.contract
  if (contract === undefined) return { name: value.name, sha256: value.sha256 }
  if (
    !isRecord(contract) ||
    typeof contract.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(contract.sha256) ||
    typeof contract.contractDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(contract.contractDigest)
  ) {
    throw new Error(
      `evolution: ${at} ${field}.contract must be { sha256, contractDigest } with both lowercase 64-character hex digests — an ` +
        'object with an execution sidecar records that file by its exact bytes and by the declaration identity a registry revision absorbs',
    )
  }
  return {
    name: value.name,
    sha256: value.sha256,
    contract: { sha256: contract.sha256, contractDigest: contract.contractDigest },
  }
}

/** The fields a recovery-coordination request may carry: anything else is refused by name rather than ignored. */
export const RECOVERY_COORDINATION_FIELDS: readonly string[] = ['sourceDiagnosisId', 'requestKey']

/** Every reason a coordination request cannot be a recovery request at all: an unknown field or an empty value, named. */
export function recoveryCoordinationDefects(request: unknown): string[] {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return ['the request must be an object carrying sourceDiagnosisId and requestKey']
  }
  const defects: string[] = []
  for (const key of Object.keys(request)) {
    if (!RECOVERY_COORDINATION_FIELDS.includes(key)) {
      defects.push(
        `unknown field "${key}": a recovery request carries ${RECOVERY_COORDINATION_FIELDS.join(', ')} and nothing else — an approval, ` +
          'a decision or a permission is never part of what a caller passes',
      )
    }
  }
  const fields = request as Record<string, unknown>
  for (const name of RECOVERY_COORDINATION_FIELDS) {
    const value = fields[name]
    if (typeof value !== 'string' || value.trim().length === 0) defects.push(`${name} must be a non-empty string`)
  }
  return defects
}

/** The failed run one diagnosis is about, as the store holds it: the run its own review ref names, else the source task's newest failed run. */
export function recoverySourceRunId(
  diagnosis: { readonly reviewRefs: readonly string[]; readonly taskId: string },
  source: { readonly taskId: string; readonly runIds: readonly string[] },
  snapshot: TaskSnapshot,
): string | null {
  for (const ref of diagnosis.reviewRefs) {
    const separator = ref.lastIndexOf('#')
    if (separator < 0 || ref.slice(0, separator) !== diagnosis.taskId) continue
    const runId = ref.slice(separator + 1)
    if (runId === 'no-run') return null
    const run = snapshot.runs.find(item => item.runId === runId && item.taskId === diagnosis.taskId)
    if (run?.status === 'failed') return runId
  }
  const failed = [...snapshot.runs].reverse().find(run => run.taskId === source.taskId && run.status === 'failed')
  return failed?.runId ?? null
}

/** One recorded supervisor delegation, as the ledger that owns it answers this plane's lookup. */
export interface SupervisorDelegation {
  readonly rootStoreId: string
  readonly taskId: string
  readonly diagnosisId: string
  readonly sessionId: string
  readonly actor: string
  readonly at: string
}

/** One recovery-coordination request, as the tool adapter hands it over (plan §F.4's `task_recover` payload). */
export interface RecoveryCoordinationRequest {
  /** The diagnosis the recovery is asked for; it must be a record of the caller's own store. */
  sourceDiagnosisId: string
  /** The caller's key: one key names one attempt of one diagnosis. */
  requestKey: string
}

/** Who asks for a recovery: the **supervisor** session of that hand-off, as a live session with an abort signal. */
export interface RecoveryCoordinationCaller {
  readonly sessionId: string
  readonly signal?: AbortSignal
}

/** What one coordination answered (A6): the runtime's own recovery outcome, the hand-off it was authorized by and what this plane checked. */
export interface RecoveryCoordinationOutcome extends RootRecoveryOutcome {
  /** The supervisor delegation this call was authorized by. */
  readonly handoff: { readonly sessionId: string; readonly actor: string; readonly diagnosisId: string }
  /** What this plane checked and found, in the caller's own words. */
  readonly coordination: readonly string[]
}

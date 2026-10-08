/**
 * The read model's pure reduction, and the one guard that keeps a legacy text
 * completion from being read as a completion at all.
 * @module @dangosys/dsh-singularity-context/view-facts
 */

import type { GraphProgressWire } from '@dangosys/dsh-singularity-graphs/wire'
import type { CoordinationAssignmentFacts, CoordinationCompletionFacts } from './types.ts'

/** What one legacy answer looks like: a note prefix, or a fenced JSON outcome block. */
const LEGACY_NOTE_PREFIXES: readonly string[] = ['blocked:', 'no_change:']
const LEGACY_OUTCOMES: readonly string[] = ['closed', 'blocked', 'no_change']
const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/g

/** How much of a completion's reason a progress note carries. */
export const PROGRESS_NOTE_LIMIT = 200

/** A completion in the legacy text formats (note prefix / fenced JSON) is not a completion any more. */
export class LegacyCompletionError extends Error {
  readonly code = 'legacy-completion-format'

  constructor(detail: string) {
    super(detail)
    this.name = 'LegacyCompletionError'
  }
}

/** Which legacy format one text carries, if any. */
function legacyFormatOf(text: string): string | undefined {
  const trimmed = text.trim()
  for (const prefix of LEGACY_NOTE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return `the legacy "${prefix}" note prefix`
  }
  for (const match of text.matchAll(FENCED_BLOCK)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const outcome = (parsed as { outcome?: unknown }).outcome
    if (typeof outcome === 'string' && LEGACY_OUTCOMES.includes(outcome)) return 'a fenced JSON outcome block'
  }
  return undefined
}

/** One field's member of a fixed vocabulary, or a refusal naming the field. */
function choiceOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new LegacyCompletionError(
      `a completion names ${field} as one of ${allowed.join(' | ')}; "${String(value)}" is not one of them`,
    )
  }
  return value as T
}

function textOf(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LegacyCompletionError(`a completion carries a non-empty ${field}, and this row does not`)
  }
  return value
}

/** One approval source as it is recorded, or a refusal. */
function approvalOf(value: unknown): CoordinationCompletionFacts['approval'] {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacyCompletionError('a completion approval is an object naming its source, or absent')
  }
  const source = value as { kind?: unknown; actor?: unknown; policy?: unknown }
  if (source.kind !== 'human' && source.kind !== 'platform_policy') {
    throw new LegacyCompletionError(`a completion approval names its source as human | platform_policy; "${String(source.kind)}" is not one of them`)
  }
  return {
    kind: source.kind,
    ...(typeof source.actor === 'string' ? { actor: source.actor } : {}),
    ...(typeof source.policy === 'string' ? { policy: source.policy } : {}),
  }
}

/**
 * Read one recorded completion. A row in the legacy text formats — a
 * `blocked:`/`no_change:` note or a fenced JSON outcome block — and a row whose
 * structured fields are missing or malformed both refuse: no read ever derives
 * "completed" from prose.
 */
export function readCompletion(row: unknown): CoordinationCompletionFacts {
  if (typeof row === 'string') {
    throw new LegacyCompletionError(
      `a completion is a structured record, and this row is text carrying ${legacyFormatOf(row) ?? 'no structured fields'}`,
    )
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new LegacyCompletionError(`a completion is a structured record; this row is ${row === null ? 'null' : typeof row}`)
  }
  const record = row as Record<string, unknown>
  for (const field of ['note', 'text', 'reply']) {
    const text = record[field]
    if (typeof text !== 'string') continue
    const legacy = legacyFormatOf(text)
    throw new LegacyCompletionError(
      legacy === undefined
        ? `a completion carries structured fields, not the ${field} prose this row carries`
        : `this ${field} is ${legacy}, which the current runtime does not read as a completion`,
    )
  }
  const evidenceRefs = record.evidenceRefs
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some(ref => typeof ref !== 'string')) {
    throw new LegacyCompletionError('a completion carries its evidenceRefs as an array of strings')
  }
  const trialCandidateRef = record.trialCandidateRef
  if (trialCandidateRef !== undefined && typeof trialCandidateRef !== 'string') {
    throw new LegacyCompletionError('a completion trialCandidateRef is a string, or absent')
  }
  const approval = approvalOf(record.approval)
  return {
    businessAction: choiceOf('businessAction', record.businessAction, ['continue', 'recover', 'finish'] as const),
    searchNext: choiceOf('searchNext', record.searchNext, ['explore', 'stop'] as const),
    methodDecision: choiceOf('methodDecision', record.methodDecision, [
      'retain',
      'trial',
      'promote',
      'discard',
      'rollback',
    ] as const),
    reason: textOf('reason', record.reason),
    evidenceRefs: [...evidenceRefs],
    ...(trialCandidateRef === undefined ? {} : { trialCandidateRef }),
    ...(approval === undefined ? {} : { approval }),
    at: textOf('at', record.at),
  }
}

/** A completion's reason as a progress note, or nothing when it has no text. */
function noteOf(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const trimmed = reason.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length <= PROGRESS_NOTE_LIMIT ? trimmed : `${trimmed.slice(0, PROGRESS_NOTE_LIMIT - 1)}…`
}

/** The completion an assignment list ends with: the latest one recorded, by its own `at`. */
function latestCompletion(assignments: readonly CoordinationAssignmentFacts[]): CoordinationCompletionFacts | undefined {
  let latest: CoordinationCompletionFacts | undefined
  for (const assignment of assignments) {
    const completion = assignment.completion
    if (completion === undefined) continue
    if (latest === undefined || completion.at >= latest.at) latest = completion
  }
  return latest
}

/** The assignment a list is currently in: the highest round one still open. */
function currentOpen(assignments: readonly CoordinationAssignmentFacts[]): CoordinationAssignmentFacts | undefined {
  let current: CoordinationAssignmentFacts | undefined
  for (const assignment of assignments) {
    if (assignment.state !== 'open') continue
    if (current === undefined || assignment.round >= current.round) current = assignment
  }
  return current
}

/**
 * The one derivation of a graph's progress, from the configured round count and
 * the recorded assignments alone. Every reader reports this and nothing else
 * computes it: a phase is never written down, only reduced again.
 */
export function deriveProgress(
  rounds: number | undefined,
  assignments: readonly CoordinationAssignmentFacts[],
): GraphProgressWire {
  const total = rounds === undefined || !Number.isFinite(rounds) ? 0 : Math.max(0, Math.trunc(rounds))
  if (assignments.length === 0) return { round: 0, rounds: total, phase: 'idle' }

  const settled = assignments.filter(assignment => assignment.state === 'settled')
  const open = currentOpen(assignments)
  if (open !== undefined) {
    const awaiting = assignments.some(
      assignment =>
        assignment.state === 'open' &&
        assignment.completion?.methodDecision === 'promote' &&
        assignment.completion.approval === undefined,
    )
    const note = noteOf(open.completion?.reason)
    return {
      round: open.round,
      rounds: total,
      phase: awaiting ? 'awaiting_approval' : 'running',
      ...(note === undefined ? {} : { note }),
    }
  }

  const latest = latestCompletion(assignments)
  const note = noteOf(latest?.reason)
  if (latest !== undefined && latest.searchNext === 'stop') {
    return { round: settled.length, rounds: total, phase: 'stopped', ...(note === undefined ? {} : { note }) }
  }
  if (rounds !== undefined && settled.length >= total) {
    return { round: settled.length, rounds: total, phase: 'finished', ...(note === undefined ? {} : { note }) }
  }
  return { round: settled.length, rounds: total, phase: 'idle', ...(note === undefined ? {} : { note }) }
}

/**
 * The one place a method decision is rendered as text. The publication approval
 * shows the complete asset difference, the evaluation the decision rests on and
 * the exact pointer switch it would make — rendered here and nowhere else, so
 * the approval card, the tool answer and the Web read the same words.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-render
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Admission,
  DraftView,
  EvaluationReport,
  MethodDraft,
  NoiseCalibration,
  TrialComparison,
} from '@dangosys/dsh-singularity-evolution'
import type {
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  PublishOutcome,
} from '@dangosys/dsh-singularity-task-runtime'
import type { MethodDecider, MethodMode } from './method-shared.ts'

/** One file as the difference between two revisions sees it. */
export interface RevisionDiffFile {
  readonly path: string
  readonly change: 'added' | 'updated' | 'removed'
  readonly unified: readonly string[]
  readonly sha256: string
}

/** One revision's complete asset difference against another. */
export interface RevisionDiff {
  readonly from: string | null
  readonly to: string
  readonly files: readonly RevisionDiffFile[]
  /** The digest a reader can quote for this whole difference. */
  readonly digest: string
}

/** A digest short enough to match two readings by eye. */
function short(digest: string): string {
  return digest.slice(0, 12)
}

function lines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
}

/**
 * The changed region of two line arrays, as unified-diff lines with three lines
 * of context. The longest common subsequence keeps unchanged inner lines out of
 * the hunk, so a reader sees what moved rather than the whole file.
 */
function unifiedLines(before: readonly string[], after: readonly string[]): string[] {
  const n = before.length
  const m = after.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const marks: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      marks.push(` ${before[i]}`)
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      marks.push(`-${before[i]}`)
      i += 1
    } else {
      marks.push(`+${after[j]}`)
      j += 1
    }
  }
  for (; i < n; i += 1) marks.push(`-${before[i]}`)
  for (; j < m; j += 1) marks.push(`+${after[j]}`)
  const changed = marks.map(mark => mark[0] !== ' ')
  return marks.filter((_mark, index) => changed.slice(Math.max(0, index - 3), index + 4).some(Boolean))
}

/** Every file one revision directory holds, relative to it. */
async function filesOf(root: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await filesOf(root, path)))
    else if (entry.isFile()) files.push(path)
  }
  return files.filter(path => path !== 'manifest.json' && path !== 'draft.json').sort()
}

/** The content digest of one file's bytes, as the ledger records it. */
async function digestOfFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * The complete asset difference between two frozen revisions: every file either
 * side holds, with a unified view and the digest of the bytes this difference
 * reports.
 */
export async function diffOfRevisions(from: EnvironmentRevision | null, to: EnvironmentRevision): Promise<RevisionDiff> {
  const before = from === null ? [] : await filesOf(from.root)
  const after = await filesOf(to.root)
  const paths = [...new Set([...before, ...after])].sort()
  const files: RevisionDiffFile[] = []
  for (const path of paths) {
    const inBefore = before.includes(path)
    const inAfter = after.includes(path)
    const beforeText = inBefore ? await readFile(join(from!.root, path), 'utf8') : ''
    const afterText = inAfter ? await readFile(join(to.root, path), 'utf8') : ''
    const change: RevisionDiffFile['change'] = !inBefore ? 'added' : !inAfter ? 'removed' : 'updated'
    if (change === 'updated' && beforeText === afterText) continue
    files.push({
      path,
      change,
      unified: unifiedLines(lines(beforeText), lines(afterText)),
      sha256: inAfter ? await digestOfFile(join(to.root, path)) : await digestOfFile(join(from!.root, path)),
    })
  }
  const digest = createHash('sha256')
    .update(files.map(file => `${file.change} ${file.path} ${file.sha256}`).join('\n'))
    .digest('hex')
  return { from: from?.manifest.revisionId ?? null, to: to.manifest.revisionId, files, digest }
}

/** One revision difference as the approval's own lines, truncated by the caller's ceiling. */
export function renderDiff(
  diff: RevisionDiff,
  options: { readonly maxFiles?: number; readonly maxLinesPerFile?: number } = {},
): string[] {
  const maxFiles = options.maxFiles ?? 12
  const maxLines = options.maxLinesPerFile ?? 120
  const shown = diff.files.slice(0, maxFiles)
  const out = [`asset diff (${diff.files.length} file${diff.files.length === 1 ? '' : 's'}, diff ${diff.digest}):`]
  out.push(`  from ${diff.from ?? '(nothing)'} → ${diff.to}`)
  for (const file of shown) {
    const counted = file.unified.reduce(
      (counts, line) => (line.startsWith('-') ? { added: counts.added, removed: counts.removed + 1 } : line.startsWith('+') ? { added: counts.added + 1, removed: counts.removed } : counts),
      { added: 0, removed: 0 },
    )
    out.push(`  --- ${file.path} (${file.change}, +${counted.added}/-${counted.removed}, sha256:${short(file.sha256)})`)
    for (const line of file.unified.slice(0, maxLines)) out.push(`  ${line}`)
    if (file.unified.length > maxLines) out.push(`  … ${file.unified.length - maxLines} more lines (diff ${diff.digest})`)
  }
  if (diff.files.length > maxFiles) out.push(`  … ${diff.files.length - maxFiles} more files (diff ${diff.digest})`)
  return out
}

/** One sample's two sides and their verdict, in the words the report uses. */
function sampleLine(comparison: TrialComparison): string {
  const tokens = (trial: TrialComparison['baseline']): string =>
    trial.receipt.cost.status === 'reported'
      ? `${trial.receipt.cost.tokens.uncachedInputTokens + trial.receipt.cost.tokens.outputTokens + trial.receipt.cost.tokens.cacheReadTokens + trial.receipt.cost.tokens.cacheWriteTokens} tokens`
      : `cost unknown (${trial.receipt.cost.reason})`
  return (
    `  ${comparison.sampleTaskId} [${comparison.role}] baseline ${comparison.baseline.outcome} (${tokens(comparison.baseline)}) → ` +
    `candidate ${comparison.candidate.outcome} (${tokens(comparison.candidate)}) — ${comparison.verdict}`
  )
}

/** The evaluation one publication rests on: the frozen identity, the samples and the score. */
export function renderEvaluation(report: EvaluationReport): string[] {
  const score = report.score
  const cost =
    score.cost.status === 'reported'
      ? `status reported, baseline ${score.cost.baselineTokens} → candidate ${score.cost.candidateTokens} tokens (relative delta ${score.cost.relativeDelta.toFixed(3)})`
      : `status unknown (${score.cost.reason}) — an unknown cost is inconclusive, never a zero`
  return [
    `evaluation ${report.evaluationId} (report ${report.planDigest.slice(0, 12)}, verdict ${report.verdict}, repetition ${report.plan.repetition + 1}):`,
    `  plan ${report.planId} (plan digest ${report.planDigest.slice(0, 12)}, scope ${report.plan.strategy?.cohortDigest.slice(0, 12) ?? '(unfrozen)'})`,
    `  model ${report.plan.sides.candidate.model.label}; baseline revision ${report.plan.sides.baseline.revision.revisionId} (${short(report.plan.sides.baseline.revision.digest)}), candidate ${report.plan.sides.candidate.revision.revisionId} (${short(report.plan.sides.candidate.revision.digest)})`,
    ...report.trials.map(sampleLine),
    `  quality: baseline ${score.quality.baseline.toFixed(4)} → candidate ${score.quality.candidate.toFixed(4)} (delta ${score.quality.delta >= 0 ? '+' : ''}${score.quality.delta.toFixed(4)} ${score.quality.unit})`,
    `  cost: ${cost}`,
    `  uncertainty: basis ${score.uncertainty.basis}, repeats ${score.uncertainty.repeats}, noise band ${score.uncertainty.noiseBand === null ? 'none observed' : score.uncertainty.noiseBand.toFixed(4)}${score.uncertainty.reason === undefined ? '' : ` (${score.uncertainty.reason})`}`,
    `  guards (non-compensatory): ${
      report.guards.length === 0 ? 'none declared' : report.guards.map(guard => `${guard.id} ${guard.ok ? 'held' : 'FAILED'} — ${guard.detail}`).join('; ')
    }`,
    `  inconclusive: ${score.inconclusive ? 'yes' : 'no'}`,
  ]
}

/** The frozen strategy's admission of one candidate, with the calibration it was read under. */
export function renderAdmission(admission: Admission, calibration: NoiseCalibration): string[] {
  return [
    `admission: ${admission.reasonCode} — ${admission.reason}`,
    `  deltaQuality ${admission.deltaQuality === undefined ? 'unknown' : admission.deltaQuality.toFixed(4)}; deltaCost ${
      admission.deltaCost === undefined ? 'unknown' : admission.deltaCost.toFixed(4)
    }; novelty ${admission.novelty}; bundleLevel ${admission.bundleLevel ? 'yes' : 'no'}; guards [${admission.guards.join(', ')}]`,
    `  calibration: ${calibration.method}, ${calibration.evaluations} evaluation(s), quality band ${calibration.qualityBand.toFixed(4)}, relative cost band ${calibration.relativeCostBand.toFixed(3)}${calibration.degenerate ? ' (degenerate — no noise observed, the declared floor stands)' : ''}`,
  ]
}

/** The exact pointer switch one publication would make. */
export function renderVersionSwitch(input: {
  readonly pointer: { readonly revisionId: string; readonly generation: number; readonly manifestDigest: string } | null
  readonly candidate: { readonly revisionId: string; readonly manifestDigest: string }
  readonly mode: MethodMode
}): string {
  const active =
    input.pointer === null
      ? 'active (none)'
      : `active ${input.pointer.revisionId} g${input.pointer.generation} (${short(input.pointer.manifestDigest)})`
  return `version switch: ${active} → candidate ${input.candidate.revisionId} (${short(input.candidate.manifestDigest)}); mode ${input.mode}`
}

/**
 * The one publication approval text: the candidate's identity, the exact version
 * switch, the complete asset difference, the evaluation, the admission and what
 * a rollback would restore. Every refusal above has already landed, and nothing
 * has been written when this is rendered.
 */
export function renderPublishReason(input: {
  readonly draft: MethodDraft
  readonly report: EvaluationReport
  readonly admission: Admission
  readonly calibration: NoiseCalibration
  readonly diff: readonly string[]
  readonly pointer: { readonly revisionId: string; readonly generation: number; readonly manifestDigest: string } | null
  readonly candidate: { readonly revisionId: string; readonly manifestDigest: string }
  readonly mode: MethodMode
  readonly rollbackToRevisionId: string | null
  readonly decider: MethodDecider
  readonly extra?: readonly string[]
}): string {
  return [
    `Method publish for ${input.draft.kind} ${input.draft.identity} (draft ${input.draft.draftId}, base ${input.draft.baseRevision.revisionId}, bundle ${input.admission.bundleLevel ? 'yes' : 'no'})`,
    renderVersionSwitch({ pointer: input.pointer, candidate: input.candidate, mode: input.mode }),
    ...input.diff,
    ...renderEvaluation(input.report),
    ...renderAdmission(input.admission, input.calibration),
    `mode: ${input.mode === 'auto' ? `auto (the platform policy decides and records; the decider is ${input.decider})` : `manual (a human decides; the decider is ${input.decider})`}`,
    `rollback: method_rollback toRevision=${input.rollbackToRevisionId ?? 'none (this is the library\'s first publication)'}`,
    ...(input.extra ?? []),
    'nothing has been written yet; the pointer moves only if this approval is granted and the post-approval re-check still passes',
  ].join('\n')
}

/** What one settled pointer switch reports. */
export function renderPublishOutcome(outcome: PublishOutcome, mode: MethodMode, decider: MethodDecider): string[] {
  return [
    `published: active revision ${outcome.pointer.revisionId} g${outcome.pointer.generation} (${short(outcome.pointer.manifestDigest)})`,
    `superseded: ${outcome.supersededRevisionId ?? '(nothing — the library held no revision)'}`,
    `completion: ${outcome.completion.intentId} (${outcome.recovered}); approval ${outcome.completion.approvalRef ?? '(none recorded)'}`,
    `mode ${mode}; decided by ${decider}`,
    'new Runs admit against this revision; Runs already bound keep the revision they were admitted against',
  ]
}

/** What one discard reports; nothing was measured and nothing moved. */
export function renderDiscard(view: DraftView, outcome: string, reason: string): string[] {
  return [
    `discarded ${view.draft.kind} ${view.draft.identity} (draft ${view.draft.draftId}) as ${outcome}`,
    `reason: ${reason}`,
    view.evaluation === undefined
      ? 'this candidate was never measured: the refusal is recorded, the denominator does not shrink and the method search keeps its slots'
      : `the evaluation ${view.evaluation.evaluationId} stays on the ledger as the evidence this candidate was refused on`,
    'no approval was required and the active revision is unchanged',
  ]
}

/** What a resumed pointer intent reports: the switch was continued, not restarted. */
export function renderRecoveredIntent(intent: EnvironmentPointerIntent, settled: EnvironmentPointerReconcile): string[] {
  return [
    `recovered pointer intent ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}): ${settled.result}`,
    `no second approval was requested — the intent already binds ${intent.approvalRef ?? '(no approval recorded)'}`,
    settled.result === 'blocked'
      ? `the switch could not be settled: ${settled.detail ?? 'no reason reported'}`
      : `the effective revision is now ${settled.revisionId}; the run the approval was for continues without being asked again`,
  ]
}

/** One draft line, as the list tool and the Web both render it. */
export function renderDraftLine(view: DraftView): string {
  const handled = view.published !== undefined ? ` → published ${view.published.revisionId}` : view.rolledback !== undefined ? ` → rolled back to ${view.rolledback.revisionId}` : ''
  const verdict = view.evaluation === undefined ? '' : ` verdict ${view.evaluation.verdict}`
  return `- ${view.draft.draftId} [${view.status}] ${view.draft.kind} ${view.draft.identity} candidate ${short(view.draft.candidateRevision.digest)}${verdict}${handled}`
}

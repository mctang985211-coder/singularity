/** `task_status`: the caller's own project state, related or whole-graph (A2 §D/A2-5). @module @dangosys/dsh-singularity-context/reads-task-status */

import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from '@dangosys/dsh-singularity-task-runtime'
import type { TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, budgetList, utf8Bytes } from '../limits.ts'
import { refused, read, type ProjectedRead } from '../refusals.ts'
import { taskSummaryLine } from '../render/fields.ts'
import type { EnvPathSource, ReadDeps, StatusQuery, StatusScope } from '../types.ts'
import { relatedEntries } from './dynamic.ts'
import {
  byString,
  RECOVERY_NOTE,
  recoveryMarker,
  readableTaskIds,
  resolveProjectionTarget,
  STATUS_LIMIT_DEFAULT,
  STATUS_LIMIT_MAX,
  storeSource,
  tooLarge,
} from './guards.ts'

/** Best-effort obligation coverage (KISS §5.1): an absent source omits the line, never reports zero. */
async function obligationLines(
  envBuilder: EnvPathSource | undefined,
  envId: string,
  snapshot: TaskSnapshot,
): Promise<string[]> {
  const header = snapshot.obligations.length === 0 ? [] : [`- obligations: ${snapshot.obligations.length} recorded`]
  try {
    const envPath = envBuilder?.store.get(envId).path
    if (envPath === undefined) return header
    const repoRoot = await findRepoRoot(envPath)
    if (repoRoot === undefined) return header
    const templates = (await loadObligationTemplates(repoRoot)).flatMap(file => file.templates)
    if (templates.length === 0) return header
    const coverage = checkObligationCoverage(templates, snapshot)
    const uncovered = coverage.uncovered.map(
      template => `${template.id} ("${template.question}") — no passing evidence bound to this criterion id`,
    )
    return [
      ...header,
      `- obligation evidence: ${coverage.covered.length}/${templates.length} satisfied${uncovered.length === 0 ? '' : `; unresolved: ${uncovered.join('; ')}`}`,
    ]
  } catch {
    return header
  }
}

/** `task_status` (A2 §D/A2-5): the caller's related tasks, or the whole domain, paged by offset. */
export async function taskStatus(deps: ReadDeps, loaded: LoadedCaller, query: StatusQuery): Promise<ProjectedRead> {
  const target = resolveProjectionTarget(loaded, {})
  if (target.kind === 'refused') return target.read
  const { resolution } = target
  const snapshot = target.snapshot
  const scope: StatusScope = query.scope ?? 'related'
  const requestedOffset = query.offset ?? 0
  const requestedLimit = query.limit ?? STATUS_LIMIT_DEFAULT
  const offset = Math.max(0, Math.trunc(requestedOffset))
  const limit = Math.min(STATUS_LIMIT_MAX, Math.max(1, Math.trunc(requestedLimit)))
  const clamped = requestedOffset !== offset || requestedLimit !== limit

  if (snapshot === undefined) {
    return refused(
      'not-activated',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so there is no task tree to read.`,
    )
  }
  const self = target.task
  if (scope === 'related' && self === undefined) {
    return refused(
      'unbound',
      `session "${resolution.sessionId}" has no task of its own in store "${resolution.storeId}", so there is no related ` +
        'scope for it; ask for scope:"graph" to read the whole domain.',
    )
  }
  const allowed = readableTaskIds(loaded)
  const entries = (
    scope === 'graph'
      ? [...snapshot.tasks]
          .sort((left, right) => byString(left.taskId, right.taskId))
          .map(task => ({ task, roles: [] as string[] }))
      : relatedEntries(snapshot, self as TaskInstance)
  ).filter(entry => allowed === undefined || allowed.has(entry.task.taskId))
  const page = entries.slice(offset, offset + limit)
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const marker = recoveryMarker(resolution.recovery)
  const header = [
    '# Task status',
    `graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
    `scope: ${scope} · offset ${offset} · limit ${limit}` +
      (clamped
        ? ` (requested offset ${requestedOffset}, limit ${requestedLimit}: both are clamped into their ranges)`
        : ''),
    ...(resolution.kind === 'coordinator' && allowed === undefined
      ? ['read boundary: delegated graph, read-only; task and session references cannot cross graphs']
      : allowed === undefined ? [] : ['read boundary: own branch, ancestor context and dependency neighbours']),
    `entries in scope: ${entries.length}`,
    ...(marker === undefined ? [] : [marker, RECOVERY_NOTE]),
  ]
  if (budget.addAll(header) > 0)
    return tooLarge('the status header', 'Ask for a smaller page (a lower `limit`) or the `related` scope.')

  const obligations = allowed === undefined ? await obligationLines(deps.envBuilder, resolution.graph.envId, snapshot) : []
  const obligationsReserve = obligations.reduce((total, line) => total + utf8Bytes(line) + 1, 0)
  const entryLines = (entry: { readonly task: TaskInstance; readonly roles: readonly string[] }): string[] => {
    const lines = [taskSummaryLine(snapshot, entry.task, entry.roles)]
    if (scope !== 'graph') return lines
    const taskId = entry.task.taskId
    const incoming = snapshot.edges.filter(edge => edge.to === taskId && (allowed === undefined || allowed.has(edge.from))).map(edge => edge.from)
    const outgoing = snapshot.edges.filter(edge => edge.from === taskId && (allowed === undefined || allowed.has(edge.to))).map(edge => edge.to)
    const runs = snapshot.runs.filter(run => run.taskId === taskId).map(run => `${run.runId}=session ${run.sessionId}`)
    const reviews = snapshot.reviews.filter(review => review.taskId === taskId).map(review => `${taskId}#${review.runId ?? 'no-run'}`)
    const diagnoses = snapshot.diagnoses.filter(diagnosis => diagnosis.taskId === taskId).map(diagnosis => diagnosis.diagnosisId)
    lines.push(`  parent ${entry.task.parentTaskId ?? 'none'}; dependencies [${incoming.join(', ')}]; blocks [${outgoing.join(', ')}]; runs [${runs.join(', ')}]; reviewRefs [${reviews.join(', ')}]; diagnosisRefs [${diagnoses.join(', ')}]`)
    return lines
  }
  const shown = budgetList(budget, {
    units: page,
    lines: entryLines,
    reserve: obligationsReserve,
    tail: count => {
      const nextOffset = offset + count
      const hasMore = nextOffset < entries.length
      return [
        `- more: ${hasMore ? `yes — continue with offset ${nextOffset}` : 'no — this is the end of the scope'}`,
        ...(scope === 'graph' ? ['- exact records: context_read kind:"task"/"run"/"diagnosis" ref:<id>; kind:"review" ref:{taskId,runId}; kind:"session" ref:<sessionId> (all page in the same read domain)'] : []),
        `- source: one read of store ${resolution.storeId}; pages are observations, not a consistent snapshot across calls` +
          (count < page.length ? '; this page stopped at the output bound' : ''),
      ]
    },
  })
  if (page.length > 0 && (shown === undefined || shown.length === 0)) {
    // The page's own first entry has no room, and a page of zero entries at this
    // offset would report the same offset again — the same page forever.
    const first = page[0] as { readonly task: TaskInstance; readonly roles: readonly string[] }
    const summaryBytes = utf8Bytes(taskSummaryLine(snapshot, first.task, first.roles))
    const entryBytes = utf8Bytes(entryLines(first).join('\n'))
    const summaryTooLarge = summaryBytes > CONTEXT_OUTPUT_LIMIT_BYTES
    return tooLarge(
      `the ${summaryTooLarge ? 'summary line' : 'status entry'} of task "${first.task.taskId}" (${summaryTooLarge ? summaryBytes : entryBytes} UTF-8 bytes)`,
      `Nothing of that entry is shown, and a page of zero entries at offset ${offset} would report the same offset again, so the ` +
        `listing could never move past it. Read that task whole instead with \`context_read\` kind:"task" ` +
        `ref:"${first.task.taskId}" (its record pages in UTF-8 bytes), or ask for the entries *after* it with offset ` +
        `${offset + 1} — the rest of the scope stays reachable that way.`,
    )
  }
  if (shown === undefined) return tooLarge('the status page footer', 'Ask for a smaller page (a lower `limit`).')
  const nextOffset = offset + shown.length
  const hasMore = nextOffset < entries.length
  budget.addAll(obligations)

  return read(budget.text(), storeSource(resolution.graph, resolution.storeId, `listed ${scope} tasks`), {
    hasMore,
    nextOffset,
  })
}

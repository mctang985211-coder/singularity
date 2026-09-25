/**
 * The reads (A2 §D): the caller's own contract, the related/graph status view,
 * reference reads, and the two projections the prompt assembly consumes.
 *
 * Every function here takes an already-resolved caller — resolution is the
 * authorization step, and a projection never re-derives a domain from a
 * reference. What each read may not do is as load-bearing as what it does:
 * nothing writes, nothing adopts, nothing reconciles, and no read waits for a
 * recovery barrier. A store the runtime is still recovering from answers with
 * its contract *and* the `recovery` marker; the read is not the recovery.
 * @module @dangosys/dsh-singularity-context/projections
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SESSION_QUERY_READ_WINDOW_MAX, extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import { questionsAwaitingAnswerOf } from '@dangosys/dsh-singularity-task'
import type {
  Diagnosis,
  EvidenceBundle,
  QuestionAnswerRecord,
  QuestionRecord,
  ReviewRecord,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from '@dangosys/dsh-singularity-task-runtime'
import type { StoreRecoveryStatus } from '@dangosys/dsh-singularity-task-runtime'
import { isGraphMember, type BindingDeps, type CallerGraph, type LoadedCaller, type ReadOnlyTaskRuntime } from './bindings.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, omissionLine, sliceUtf8, utf8Bytes, type Utf8Slice } from './limits.ts'
import { notActivatedLines } from './not-activated.ts'
import { refused, type NamedRefusal, type ProjectedRead, read } from './refusals.ts'
import {
  bindingLines,
  constraintItems,
  contractLines,
  criteriaLines,
  diagnosisRecordText,
  evidenceRecordText,
  handoffFor,
  handoffLines,
  handoffReferences,
  latestRun,
  reviewRecordText,
  rootAncestor,
  runPhaseSuffix,
  runRecordText,
  taskRecordText,
  taskSummaryLine,
} from './render.ts'

/** The status scopes a caller may ask for (A2 §D). */
export type StatusScope = 'related' | 'graph'

/** What one status read asks for: how much of which scope. */
export interface StatusQuery {
  readonly scope?: StatusScope
  /** Entry offset, from 0. */
  readonly offset?: number
  /** Entries per page; default 20, range 1–100. */
  readonly limit?: number
}

/** A review's identity: the pair a `ReviewRecord` carries, since a review has no id of its own. */
export interface ReviewReference {
  readonly taskId: string
  /** `null` for a task that blocked before any run started. */
  readonly runId: string | null
}

/**
 * One session event's identity (A2 §D, Q3 closure): the session it belongs to and
 * the event's own DSH seq. This is the reference a session *listing* hands back
 * for an event too large to render inline, and it is the only door that pages the
 * event's visible text by bytes — the session-id form keeps paging by event
 * seq/count.
 */
export interface SessionEventReference {
  readonly sessionId: string
  readonly seq: number
}

/** What one reference read asks for, by kind. */
export interface ContextReadQuery {
  readonly kind: 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session'
  /** The record's own identity, in the shape its kind uses. */
  readonly ref: string | ReviewReference | SessionEventReference
  /**
   * Task-class kinds: UTF-8 byte offset into the record text. Session listing
   * (`ref` a session id): event seq. Session event (`ref` `{sessionId, seq}`):
   * UTF-8 byte offset into that event's visible text — `extractSessionEventText`,
   * never the raw session JSON.
   */
  readonly offset?: number
  /**
   * Task-class kinds: how many UTF-8 bytes of the record this page may carry
   * (the whole answer still never exceeds the output bound). Session listing:
   * events per page. Session event: the page size in UTF-8 bytes of that event's
   * visible text (default the output bound, clamped into 4..the bound).
   */
  readonly limit?: number
}

/** The session plane's read-only half, as this package uses it. */
export interface SessionQueryReads {
  readSurface(sessionId: string): Promise<{ readonly capturedThroughSeq: number | null }>
  readEvent(
    request: { readonly sessionId: string; readonly seq: number; readonly before?: number; readonly after?: number },
    signal?: AbortSignal,
  ): Promise<{
    readonly target: SessionEvent
    readonly events: readonly SessionEvent[]
    readonly startSeq: number
    readonly endSeq: number
  }>
  /**
   * One Session's whole log, live-preferred, with the number of fork-inherited
   * events at its head: the fold a *consumption proof* is read off (A4 §7.3) —
   * the prefix belongs to the Session this one descends from, so a message in it
   * was never put in front of this Session's model.
   */
  readSession(
    sessionId: string,
  ): Promise<{ readonly inheritedEventCount: number; readonly events: readonly SessionEvent[] }>
}

/** Soft view of the env-builder store: the graph env's path is where template discovery walks up from. */
export interface EnvPathSource {
  readonly store: { get(envId: string): { readonly path: string } }
}

/** Everything a projection reads from. */
export interface ReadDeps extends BindingDeps {
  readonly sessionQuery: SessionQueryReads
  /** Absent in a deployment without an env builder: the obligation-coverage line is then omitted. */
  readonly envBuilder?: EnvPathSource
}

/** The status page's default entry count, and the range a caller's limit is clamped into. */
const STATUS_LIMIT_DEFAULT = 20
const STATUS_LIMIT_MAX = 100
/** The session page's default event count, and its ceiling (the same range as a status page). */
const SESSION_LIMIT_DEFAULT = 20
const SESSION_LIMIT_MAX = 100
/**
 * The floor of one session-event page, in UTF-8 bytes: a page takes the largest
 * fragment that fits, but at least this much room is always given to it, so a
 * caller's `limit` can never make a page that cannot carry one character.
 */
const SESSION_EVENT_PAGE_MIN_BYTES = 4
/** A task-class page never goes below this many bytes; below it a page could not advance usefully. */
const TASK_PAGE_MIN_BYTES = 64

/** How a caller asks for a record's identity, spelled out in every malformed-ref refusal. */
const REF_SHAPES: Record<ContextReadQuery['kind'], string> = {
  task: 'the task id',
  run: 'the run id',
  evidence: 'the evidence id',
  diagnosis: 'the diagnosis id',
  review: '`{taskId, runId}` (with `runId: null` for a task that blocked before any run)',
  session: 'the session id, or `{sessionId, seq}` for one event',
}

function storeSource(graph: CallerGraph, storeId: string, what: string): string {
  return `${what} — store ${storeId} of graph ${graph.id}, one Task snapshot read`
}

/** The recovery marker a result shows, or `undefined` while the store is simply ready. */
function recoveryMarker(recovery: StoreRecoveryStatus): string | undefined {
  if (recovery.status === 'ready') return undefined
  const reason = 'reason' in recovery ? ` — ${recovery.reason}` : ''
  return `recovery: ${recovery.status}${reason}`
}

/** The static sentence every result that shows a marker carries, so a marker is never read as a trigger. */
const RECOVERY_NOTE = 'a recovery marker is an observation: this read neither triggers nor waits for recovery'

function unboundRead(resolution: Extract<LoadedCaller['resolution'], { kind: 'unbound' }>): ProjectedRead {
  return refused(resolution.refusal, resolution.detail)
}

function tooLarge(what: string, where: string): ProjectedRead {
  return refused(
    'context-too-large',
    `${what} does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a core contract is never cut to fit; ` +
      `nothing is reported in place of it. ${where}`,
  )
}

/** The one action that reaches a task-class record in pages. */
function taskPageHint(taskId: string): string {
  return `Read the record in pages with \`context_read\` kind:"task" ref:"${taskId}" (offset in UTF-8 bytes, limit up to ${CONTEXT_OUTPUT_LIMIT_BYTES}).`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/* --- pieces both projections share --------------------------------------- */

function contractHeading(role: 'worker' | 'root' | 'reviewer' | 'replay'): string {
  switch (role) {
    case 'reviewer':
      return '## Delegated contract (review-only)'
    case 'root':
      return '## Your contract (graph root)'
    default:
      return '## Your contract'
  }
}

function contractBody(task: TaskInstance): string[] {
  return [
    `task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth}`,
    `objective: ${task.objective}`,
    'acceptance criteria:',
    ...(task.acceptanceCriteria.length === 0 ? ['(none)'] : criteriaLines(task.acceptanceCriteria)),
    ...contractLines(task),
  ]
}

/**
 * The caller's own run, as one line: status, phase, and the old-record marker
 * such a run earns. The snapshot is the store the run was read from, and is
 * where the run line's one derived word comes from (`waiting_answer`).
 */
function ownRunLine(run: TaskRun, snapshot?: TaskSnapshot): string {
  return `run ${run.runId} [${run.status}]${runPhaseSuffix(run, snapshot)} started ${run.startedAt}`
}

/**
 * One reference list inside the byte bound: entries are shown in store order
 * until the budget (which also has to hold the omission clause) runs out, and
 * what did not fit is named with its count. Returns `'too-large'` when not even
 * the clause fits — a list that cannot say how much it hid is not shown at all.
 *
 * `follow` is the room the caller still owes to everything it renders *after*
 * this list (the next list whole, a fixed guidance block, the run binding
 * summary): the list stops early enough to leave it, so one long list names what
 * it hid instead of starving what follows into a refusal. The clause's room is
 * reserved *before* each entry is measured, never spent on an entry
 * (`@deepseek-ai/dsh-spill-policy` reserves its own notice the same way).
 */
function referenceList(
  budget: OutputBudget,
  title: string,
  entries: readonly string[],
  noun: string,
  how: string,
  follow = 0,
): string | undefined {
  if (entries.length === 0) return budget.add(`- ${title}: (none)`) ? undefined : 'too-large'
  const omitted = (count: number): string =>
    omissionLine({ scope: noun, unit: 'items', kept: entries.length - count, limit: entries.length, omitted: count, recovery: how })
  // The widest clause of the list (the longest count) plus its line separator:
  // every clause actually emitted is no wider, so this is the room to keep.
  const reserve = utf8Bytes(omitted(entries.length)) + 1 + follow
  if (!budget.add(`- ${title}:`)) return 'too-large'
  let shown = 0
  for (const entry of entries) {
    const line = `  ${entry}`
    if (budget.remaining < reserve + utf8Bytes(line) + 1) break
    budget.add(line)
    shown += 1
  }
  if (shown === entries.length) return undefined
  return budget.add(omitted(entries.length - shown)) ? undefined : 'too-large'
}

/**
 * The least a bounded list occupies whole: its heading, and the omission clause
 * it would emit for `count` entries. A caller that renders two lists in a row
 * hands the first this floor for the second, so the second is never starved.
 */
function referenceFloor(title: string, noun: string, count: number, how: string): number {
  const clause = omissionLine({ scope: noun, unit: 'items', kept: 0, limit: count, omitted: count, recovery: how })
  return utf8Bytes(`- ${title}:`) + 1 + utf8Bytes(clause) + 1
}

/* --- contract projection (the assembly's immutable half) ----------------- */

/**
 * The decomposition guidance a worker's projection carries — the
 * task/deployment-conditional part of the old spawn prompt's rules (A2: the
 * unconditional rules are the agent runtime's worker policy section, and the
 * two never repeat each other). Every condition is fixed for the whole run — a
 * task's `decompositionStatus` is immutable after admission and the deployment
 * switch is configuration — so the block is as byte-stable as the contract it
 * rides with. A replay never sees it: a replay re-runs the one task as
 * contracted, whatever the switch says.
 */
function workerDecompositionLines(taskRuntime: ReadOnlyTaskRuntime, task: TaskInstance): string[] {
  const decomposable = task.decompositionStatus === 'decomposable'
  const runtimeSplit = taskRuntime.allowsRuntimeDecomposition()
  if (!decomposable && !runtimeSplit) return []
  const lines: string[] = []
  if (decomposable) {
    lines.push(
      '## This task is decomposable',
      '',
      '- Do not carry the work to completion yourself: this task was admitted as decomposable.',
      '- Call `task_decompose` instead, with a `reason` and the child task list; every child needs an acceptance criterion a verifier can judge on its own.',
      '- Decompose only when RFC §36 atomicity holds — independently verifiable acceptance dimensions, clear artifact boundaries, capabilities that match or gaps you can handle; otherwise do the work here.',
      '- Once you decompose, the nested verification settles this task; you still never declare completion yourself.',
    )
  }
  if (runtimeSplit) {
    lines.push(
      ...(lines.length === 0 ? [] : ['']),
      '## If the work turns out not to be atomic',
      '',
      '- Call `task_decompose` yourself: this deployment admits a task\'s own decomposition, so your parent did not have to predict it. ' +
        'The call still has to clear admission — structure, acyclic dependencies, a command on every executable criterion, capability ' +
        'coverage, depth and batch-size limits — and a task may split only once; a refusal names the rule that blocked it, and that reason ' +
        'is what you act on. Split only into pieces a verifier can judge on its own; otherwise do the work here.',
    )
  }
  lines.push(
    '',
    '- A decomposition can come back waiting for a human review: it answers with a proposal id and admits nothing, so no child exists ' +
      'and nothing is spawned until the review decides. Read the batch as it was recorded with `task_proposal_read`; do not re-submit the ' +
      'same batch while it waits, because the same request is answered with the same proposal. If the review refuses it, revise the batch ' +
      'from the reason on the record and decompose again — a revision is a new proposal, never a re-run of the refused one.',
  )
  return lines
}

/**
 * The immutable half of the context one role is assembled with (A2 §D/§9): the
 * root objective and its hard constraints, the caller's own complete contract,
 * the persisted handoff envelope, and — for replay or a reviewer — the honest
 * label that says which lineage this contract belongs to.
 *
 * Two projections of unchanged content are byte-identical: no read counters, no
 * "as of" timestamp, and every list in its store order.
 */
export async function contractProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution)
  if (resolution.kind === 'member') {
    return refused(
      'unbound',
      `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own ` +
        'and no recorded delegation, so it has no contract to project. A member reads the graph\'s records by reference ' +
        '(`context_read`) or asks for the status view; it never inherits the root\'s contract.',
    )
  }
  if (resolution.kind === 'root' && resolution.task === undefined) {
    return refused('not-activated', notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join('\n'))
  }
  if (resolution.kind === 'reviewer' && resolution.task === undefined) {
    return refused(
      'not-found',
      `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store ` +
        `"${resolution.storeId}" does not hold; the delegated contract cannot be read.`,
    )
  }
  if (loaded.snapshot === undefined) {
    return refused(
      'unreadable',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" could not be read, so the contract it holds cannot be projected.`,
    )
  }
  const snapshot = loaded.snapshot
  const task = resolution.task as TaskInstance
  const run = resolution.kind === 'worker' || resolution.kind === 'root' ? resolution.run : undefined
  const role: 'worker' | 'root' | 'reviewer' | 'replay' =
    resolution.kind === 'reviewer'
      ? 'reviewer'
      : resolution.kind === 'root'
        ? 'root'
        : task.parentTaskId === undefined && run?.parentRunId !== undefined
          ? 'replay'
          : 'worker'

  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    '# Immutable context (contract)',
    `role: ${role}`,
    `graph: ${resolution.graph.id} "${resolution.graph.name}" (env ${resolution.graph.envId}) — root session "${resolution.graph.rootSessionId}"`,
    `session: ${resolution.sessionId} — store ${resolution.storeId}`,
  ]
  if (budget.addAll(header) > 0) return tooLarge('the contract projection header', taskPageHint(task.taskId))

  if (role === 'replay') {
    const lines = [
      '',
      '## Own objective (replay lineage)',
      'this task is a replay: it is parentless in a store that also holds the root task, and its run carries lineage ' +
        `parent run ${run?.parentRunId ?? '(unrecorded)'}. The objective below is this task's own accepted contract — no other ` +
        "task's root objective is adopted here, and the graph's root briefing is not this task's briefing.",
      `objective: ${task.objective}`,
      ...constraintItems(task).map(constraint => `- replay constraint: ${constraint}`),
    ]
    if (budget.addAll(lines) > 0) return tooLarge('the replay lineage briefing', taskPageHint(task.taskId))
  }

  if (role === 'worker') {
    const ancestor = rootAncestor(snapshot, task)
    const constraints = constraintItems(ancestor.task)
    const lines = [
      '',
      '## Root objective and hard constraints',
      `${ancestor.task.taskId} [${ancestor.task.status}]: ${ancestor.task.objective}`,
      ...(constraints.length === 0
        ? ['- root constraints: (none recorded on the root contract)']
        : ['- root constraints:', ...constraints.map(constraint => `  - ${constraint}`)]),
      ...(ancestor.brokenAt === undefined
        ? []
        : [`- the parent chain stops at "${ancestor.brokenAt}", which this store does not hold; nothing is invented for it`]),
    ]
    if (budget.addAll(lines) > 0) return tooLarge('the root briefing', taskPageHint(task.taskId))
  }

  if (budget.addAll(['', contractHeading(role), ...contractBody(task)]) > 0) {
    return tooLarge('your contract', taskPageHint(task.taskId))
  }

  if (resolution.kind === 'reviewer') {
    const label = [
      '',
      `- this session has no business Run: the contract above belongs to the task it was delegated to review ` +
        `(delegated by session ${resolution.delegation.actor}, recorded ${resolution.delegation.at}), and reading it is not executing it.`,
    ]
    if (budget.addAll(label) > 0) return tooLarge('the review-only label', taskPageHint(task.taskId))
  }

  // Everything still owed after the bounded lists is measured *before* them: the
  // lists hand it forward as their follow reserve, so a handoff with unbounded
  // references is cut and named instead of starving the blocks behind it.
  const summaryLines =
    run?.providerBinding === undefined
      ? []
      : ['', '## Implementation chosen for this run', ...(await bindingLines(deps.taskRuntime, run.providerBinding)).filter(line => line.length > 0)]
  const summaryFloor = summaryLines.length === 0 ? 0 : utf8Bytes(summaryLines.join('\n')) + 2
  const decomposition = role === 'worker' ? workerDecompositionLines(deps.taskRuntime, task) : []
  const decompositionFloor = decomposition.length === 0 ? 0 : utf8Bytes(['', ...decomposition].join('\n')) + 2

  if (role === 'worker') {
    const handoff = handoffFor(snapshot, task.taskId)
    if (handoff === undefined) {
      const missing = ['', '## Handoff', '- handoff: none recorded — this store holds no TaskHandoff naming this task as its child']
      if (budget.addAll(missing) > 0) return tooLarge('the handoff', taskPageHint(task.taskId))
    } else {
      if (budget.addAll(['', '## Handoff', ...handoffLines(handoff)]) > 0) return tooLarge('the handoff', taskPageHint(task.taskId))
      const references = handoffReferences(handoff)
      const evidenceFloor = referenceFloor('relevant evidence', 'handoff evidence references', references.evidence.length, 'read them by id')
      const tail = decompositionFloor + summaryFloor
      if (
        referenceList(budget, 'relevant artifacts', references.artifacts, 'handoff artifact references', 'read them by id', evidenceFloor + tail) !==
        undefined
      ) {
        return tooLarge('the handoff references', taskPageHint(task.taskId))
      }
      if (
        referenceList(budget, 'relevant evidence', references.evidence, 'handoff evidence references', 'read them by id', tail) !== undefined
      ) {
        return tooLarge('the handoff references', taskPageHint(task.taskId))
      }
    }
    if (decomposition.length > 0 && budget.addAll(['', ...decomposition]) > 0) {
      return tooLarge('the decomposition guidance', taskPageHint(task.taskId))
    }
  }

  if (summaryLines.length > 0 && budget.addAll(summaryLines) > 0) {
    return tooLarge('the run binding summary', taskPageHint(task.taskId))
  }

  return read(budget.text(), storeSource(resolution.graph, resolution.storeId, 'projected the caller\'s immutable contract'))
}

/* --- dynamic projection (the assembly's state half) ---------------------- */

/** One related task with the direction labels it earns in the caller's view. */
export interface RelatedEntry {
  readonly task: TaskInstance
  readonly roles: string[]
}

/**
 * The tasks one caller's status view covers: the caller's own task, its direct
 * children, and the tasks adjacent to it through a dependency edge — both
 * directions, each labelled with what the edge means (`from` must verify before
 * `to`). Sorted by task id, so the list is stable across reads.
 */
export function relatedEntries(snapshot: TaskSnapshot, self: TaskInstance): RelatedEntry[] {
  const roles = new Map<string, string[]>()
  const add = (taskId: string, role: string): void => {
    const current = roles.get(taskId)
    if (current === undefined) roles.set(taskId, [role])
    else if (!current.includes(role)) current.push(role)
  }
  add(self.taskId, 'you')
  for (const childTaskId of self.childTaskIds) add(childTaskId, 'direct child')
  for (const edge of snapshot.edges) {
    if (edge.to === self.taskId) add(edge.from, 'dependency (blocks you)')
    if (edge.from === self.taskId) add(edge.to, 'dependent (you block it)')
  }
  return [...roles.entries()]
    .flatMap(([taskId, labels]) => {
      const task = snapshot.tasks.find(item => item.taskId === taskId)
      return task === undefined ? [] : [{ task, roles: labels }]
    })
    .sort((left, right) => (left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0))
}

/**
 * The dynamic half (A2 §D/§9): the run's status and phase, the effective gate
 * phase, the recovery marker, and the related tasks. For a reviewer, whose
 * domain is real but whose run is not, the delegated task's state is shown under
 * its review-only label instead of a "your run" line that would be a fiction.
 *
 * Nothing accumulates and nothing varies with the act of reading: two
 * projections of unchanged content are byte-identical, which is what lets the
 * session log deduplicate them.
 */
export async function dynamicProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution)
  if (resolution.kind === 'member') {
    return refused(
      'unbound',
      `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and ` +
        'no recorded delegation, so there is no dynamic state to project for it; the graph\'s tasks are readable with the ' +
        'status view or by reference.',
    )
  }
  if (resolution.kind === 'root' && resolution.task === undefined) {
    return refused('not-activated', notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join('\n'))
  }
  if (resolution.kind === 'reviewer' && resolution.task === undefined) {
    return refused(
      'not-found',
      `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store ` +
        `"${resolution.storeId}" does not hold; there is no delegated state to project.`,
    )
  }

  const task = resolution.task as TaskInstance
  const snapshot = loaded.snapshot
  const marker = recoveryMarker(resolution.recovery)
  const gate = deps.taskRuntime.gate.phaseOf(resolution.sessionId)
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    '# Dynamic context (state)',
    `role: ${resolution.kind}`,
    `graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
    ...(marker === undefined ? [] : [marker, RECOVERY_NOTE]),
    `gate phase: ${gate ?? 'not tracked for this session'}`,
  ]
  if (budget.addAll(header) > 0) return tooLarge('the dynamic projection header', taskPageHint(task.taskId))

  if (resolution.kind === 'reviewer') {
    const run = snapshot === undefined ? undefined : latestRun(snapshot, task)
    const label = `delegated task state (review-only, no business Run): ${run === undefined ? 'no run was ever started' : ownRunLine(run, snapshot)}`
    if (!budget.add(label)) return tooLarge('the delegated task state', taskPageHint(task.taskId))
  } else {
    if (!budget.add(`your run: ${resolution.run === undefined ? 'none' : ownRunLine(resolution.run, snapshot)}`)) {
      return tooLarge('the run line', taskPageHint(task.taskId))
    }
  }

  if (snapshot !== undefined) {
    const entries = relatedEntries(snapshot, task)
    const lines = entries.map(entry => taskSummaryLine(snapshot, entry.task, entry.roles))
    const marker = (count: number): string =>
      omissionLine({
        scope: 'related tasks',
        unit: 'items',
        kept: lines.length - count,
        limit: lines.length,
        omitted: count,
        recovery: 'page through them with the status view',
      })
    const markerText = marker(lines.length)
    const reserve = utf8Bytes(markerText) + 1
    if (budget.addAll(['', 'related tasks (you, your direct children, and the tasks directly adjacent through a dependency edge):']) > 0) {
      return tooLarge('the related tasks heading', taskPageHint(task.taskId))
    }
    let shown = 0
    for (const line of lines) {
      // The marker's room is checked *before* each entry is measured, so an
      // entry never eats it and the list always says what it did not show.
      if (budget.remaining < reserve + utf8Bytes(line) + 1) break
      budget.add(line)
      shown += 1
    }
    if (shown < lines.length) {
      if (!budget.add(marker(lines.length - shown))) {
        return tooLarge('the related tasks list', taskPageHint(task.taskId))
      }
    }
  }

  return read(
    budget.text(),
    storeSource(resolution.graph, resolution.storeId, 'projected the caller\'s dynamic state'),
  )
}

/* --- question projection (the assembly's coordination half) -------------- */

/**
 * The message identities one Session's own history proves its model has seen
 * (A4 §7.3): the `user/message` events of its own event suffix, by message id.
 * That is the only durable proof — a pending inbox entry is not one (the loop
 * claims and removes it before the step that would carry it), and a claim whose
 * write never reached history is not one either.
 *
 * The fold is the delivery path's (`agent-runtime`'s `ownSuffix`): the
 * fork-inherited prefix belongs to the Session this one descends from, so a
 * message there was never put in front of *this* Session's model. Nothing is
 * written back: this function is a read, and the proof is re-derived at every
 * assembly, so no consumed flag and no second ledger can disagree with the log.
 */
async function consumedMessageIds(deps: ReadDeps, sessionId: string): Promise<ReadonlySet<string>> {
  const log = await deps.sessionQuery.readSession(sessionId)
  const ids = new Set<string>()
  for (const event of log.events.slice(log.inheritedEventCount)) {
    if (event.type === 'user/message') ids.add(String(event.data.id))
  }
  return ids
}

/** What nothing was proven about. */
const NOTHING_CONSUMED: ReadonlySet<string> = new Set()

/**
 * The order both lists print in: `askedAt` ascending, which is the order the
 * store applied the asks in. Sorting explicitly keeps the claim true even if two
 * asks commit out of stamp order, and `Array#sort` being stable keeps questions
 * the store stamped in the same millisecond in the order it holds them.
 */
function byAskedAt(left: QuestionRecord, right: QuestionRecord): number {
  return left.askedAt < right.askedAt ? -1 : left.askedAt > right.askedAt ? 1 : 0
}

/** One question line: the identity, the asking run, the blocking flag, and where the body is. */
function questionEntry(snapshot: TaskSnapshot, question: QuestionRecord): string {
  const task = snapshot.runs.find(run => run.runId === question.childRunId)?.taskId
  const from = `from child run ${question.childRunId}${task === undefined ? '' : ` (task ${task})`}`
  return (
    `- ${question.questionId} — ${from}, blocking: ${question.blocking ? 'yes' : 'no'}, asked ${question.askedAt}` +
    `\n  body: \`context_read\` kind:"session" ref:${eventReference(question.questionRef.sessionId, question.questionRef.seq)}`
  )
}

/** One answer line: the identity, the question it answers, the resolution, and where the body is. */
function answerEntry(question: QuestionRecord, answer: QuestionAnswerRecord): string {
  return (
    `- ${answer.answerId} — the answer to question ${question.questionId}, resolves: ${answer.resolves ? 'yes' : 'no'}, ` +
    `answered ${answer.answeredAt}` +
    `\n  body: \`context_read\` kind:"session" ref:${eventReference(answer.answerRef.sessionId, answer.answerRef.seq)}`
  )
}

/**
 * One bounded list of question or answer lines: the entries in the store's ask
 * order, then the list's guidance. What the output bound could not carry is
 * named with its count (`@deepseek-ai/dsh-output-retention`'s clause) instead of
 * silently dropped, and the guidance's room is reserved before each entry is
 * measured, so an unusually long list never starves it. Returns `'too-large'`
 * when not even the heading fits: a list that cannot say what it holds is not
 * shown at all.
 */
function questionList(
  budget: OutputBudget,
  heading: string,
  entries: readonly string[],
  guidance: string,
  scope: string,
  recovery: string,
): 'ok' | 'too-large' {
  if (!budget.add('') || !budget.add(heading)) return 'too-large'
  const omitted = (count: number): string =>
    omissionLine({ scope, unit: 'items', kept: entries.length - count, limit: entries.length, omitted: count, recovery })
  const reserve = utf8Bytes(omitted(entries.length)) + 1 + utf8Bytes(guidance) + 1
  let shown = 0
  for (const entry of entries) {
    if (budget.remaining < reserve + utf8Bytes(entry) + 1) break
    budget.add(entry)
    shown += 1
  }
  if (shown < entries.length && !budget.add(omitted(entries.length - shown))) return 'too-large'
  return budget.add(guidance) ? 'ok' : 'too-large'
}

/**
 * The question plane (A4 §F.1, architecture §7.3): what this run owes or waits
 * for in the direct parent/child conversation, for the prompt assembly's own
 * named runtime context. Two lists, both derived from the store's question
 * facts and neither a phase:
 *
 * - **as a parent**: every question of a child's that is still open and
 *   unanswered (`questionsAwaitingAnswerOf`) — the question's identity, the
 *   asking run, the blocking flag, and the `{sessionId, seq}` reference that
 *   reads the body out of the asking Session. A question is shown until an
 *   answer resolves it, whatever happened to its delivery: the store's own fact
 *   is what makes the parent owe an answer.
 * - **as a child**: every answer to this run's own questions that its Session
 *   does not yet prove was put in front of the model. An answer is never dropped
 *   because the question was answered — it is dropped only when the caller's own
 *   Session holds that answer's `messageId` as a `user/message` event
 *   ({@link consumedMessageIds}); a fold that cannot be read proves nothing, so
 *   every recorded answer stays listed. No consumed flag is stored anywhere.
 *
 * The body itself is never copied here: the reference into the sending Session
 * is the one source of the text, and it is what the model reads with
 * `context_read`. Both lists are bounded, questions print by `askedAt` ascending
 * (their answers in the order the store applied them), and a caller with nothing
 * pending gets an empty text — no header, and no runtime context at all for the
 * assembly to add.
 */
export async function questionProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution)
  if (resolution.kind === 'member') {
    return refused(
      'unbound',
      `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and no ` +
        'recorded delegation, so it asks no parent and answers no child; questions belong to the runs that hold them.',
    )
  }
  if (resolution.kind === 'root' && resolution.task === undefined) {
    return refused('not-activated', notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join('\n'))
  }
  if (resolution.kind === 'reviewer' && resolution.task === undefined) {
    return refused(
      'not-found',
      `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store ` +
        `"${resolution.storeId}" does not hold; there is no delegated run whose questions could be projected.`,
    )
  }
  const snapshot = loaded.snapshot
  const source = storeSource(resolution.graph, resolution.storeId, 'projected the caller\'s pending questions')
  // A reviewer has no business Run, and no other role reaches here without one:
  // the question plane is a run's own list, so there is nothing to project.
  const run = resolution.kind === 'worker' || resolution.kind === 'root' ? resolution.run : undefined
  if (snapshot === undefined || run === undefined) return read('', source)
  if (snapshot.questions === undefined) {
    return refused(
      'unreadable',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" answered with a snapshot that carries no question index, so ` +
        'the questions it holds cannot be read; a view built without them would report "no questions" for a store that has some.',
    )
  }

  const asked = [...questionsAwaitingAnswerOf(snapshot, run.runId)].sort(byAskedAt)
  const answers: { readonly question: QuestionRecord; readonly answer: QuestionAnswerRecord }[] = []
  for (const question of [...snapshot.questions.all].sort(byAskedAt)) {
    if (question.childRunId !== run.runId) continue
    for (const answer of question.answers ?? []) answers.push({ question, answer })
  }
  let consumed: ReadonlySet<string> = NOTHING_CONSUMED
  if (answers.length > 0) {
    try {
      consumed = await consumedMessageIds(deps, resolution.sessionId)
    } catch {
      // A log this read cannot open proves nothing was read, which is the
      // direction §7.3 fixes: no proof, keep the reference. Every recorded
      // answer stays in the view and a later assembly re-derives the fold.
      consumed = NOTHING_CONSUMED
    }
  }
  const unread = answers.filter(item => !consumed.has(item.answer.messageId))
  if (asked.length === 0 && unread.length === 0) return read('', source)

  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    '# Pending questions (coordination)',
    `role: ${resolution.kind}`,
    `graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
    'unanswered questions and answers not yet shown to have been read — derived from the store\'s question facts, never a phase change',
  ]
  if (budget.addAll(header) > 0) {
    return refused(
      'context-too-large',
      `the pending-questions header of store "${resolution.storeId}" does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, ` +
        'and a coordination view is never returned as a fragment of itself; nothing is reported in place of it.',
    )
  }

  if (asked.length > 0) {
    const guidance =
      'Answer a question with `task_answer` {questionId, requestKey, answer, resolves}; `resolves:false` keeps it open, and the ' +
      'body is at the reference on the question\'s line.'
    const outcome = questionList(
      budget,
      `## Questions waiting for your answer (${asked.length})`,
      asked.map(question => questionEntry(snapshot, question)),
      guidance,
      'pending questions',
      'the questions this view could not carry stay open in the store',
    )
    if (outcome === 'too-large') return questionViewTooLarge(resolution.storeId, 'questions waiting for an answer')
  }

  if (unread.length > 0) {
    const guidance =
      'Read an answer at the reference on its line: it stays here until your own Session shows it was put in front of you.'
    const outcome = questionList(
      budget,
      `## Answers waiting to be read (${unread.length})`,
      unread.map(item => answerEntry(item.question, item.answer)),
      guidance,
      'unread answers',
      'the answers this view could not carry stay unread in the store',
    )
    if (outcome === 'too-large') return questionViewTooLarge(resolution.storeId, 'answers waiting to be read')
  }

  return read(budget.text(), source)
}

/** The refusal of a question list the output bound could not lay out at all. */
function questionViewTooLarge(storeId: string, what: string): ProjectedRead {
  return refused(
    'context-too-large',
    `the ${what} of store "${storeId}" do not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a coordination view is ` +
      'never returned as a fragment of itself; nothing is reported in place of it.',
  )
}

/* --- task_read (the caller's own contract, tool-facing) ------------------ */

/**
 * `task_read` (A2 §D/A2-5), the tool-facing read of the caller's own contract:
 *
 * - a root with an accepted contract reads that contract and its children; a
 *   root whose graph has none reads the named `not-activated` state (whatever
 *   proposal is open, and how a goal is accepted);
 * - a worker reads its own task, criteria, run and re-checked bound content;
 * - a reviewer reads the delegated task's contract, marked review-only, and is
 *   never presented as the executor of a business run;
 * - a member with no run of its own gets `unbound`, never the root's contract.
 */
export async function taskRead(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution)
  if (resolution.kind === 'member') {
    return refused(
      'unbound',
      `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and ` +
        'no recorded delegation: no contract is bound to it, and the root\'s contract is not a substitute.',
    )
  }
  const snapshot = loaded.snapshot
  if (resolution.kind === 'root' && resolution.task === undefined) {
    return refused('not-activated', notActivatedLines(resolution.graph, resolution.storeId, snapshot).join('\n'))
  }
  if (resolution.kind === 'reviewer' && resolution.task === undefined) {
    return refused(
      'not-found',
      `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store ` +
        `"${resolution.storeId}" does not hold; the delegated contract cannot be read.`,
    )
  }
  const task = resolution.task as TaskInstance
  const marker = recoveryMarker(resolution.recovery)
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    `store ${resolution.storeId} of graph "${resolution.graph.id}"`,
    ...(marker === undefined ? [] : [marker, RECOVERY_NOTE]),
  ]
  if (budget.addAll(header) > 0) return tooLarge('the task_read header', taskPageHint(task.taskId))

  if (resolution.kind === 'reviewer') {
    const lines = [
      '',
      'delegated task (review-only): this session has no business Run. The contract below is the task it was delegated to review.',
      ...contractBody(task),
    ]
    if (budget.addAll(lines) > 0) return tooLarge('the delegated contract', taskPageHint(task.taskId))
    return read(budget.text(), storeSource(resolution.graph, resolution.storeId, 'read the delegated task contract'))
  }

  const run = resolution.kind === 'worker' || resolution.kind === 'root' ? resolution.run : undefined
  const lines = ['', ...contractBody(task), ...(run === undefined ? [] : ['', ownRunLine(run, snapshot)])]
  if (budget.addAll(lines) > 0) return tooLarge('your contract', taskPageHint(task.taskId))

  // The run binding summary is owed after the children list; measuring it first
  // lets the list stop early enough to leave it, so an unusually long list of
  // children is cut and named instead of starving the summary into a refusal.
  const summary =
    run?.providerBinding === undefined
      ? []
      : (await bindingLines(deps.taskRuntime, run.providerBinding)).filter(line => line.length > 0)

  if (snapshot !== undefined && resolution.kind === 'root') {
    const children = task.childTaskIds.flatMap(taskId => snapshot.tasks.filter(item => item.taskId === taskId))
    const childLines = ['', `children: ${children.length}`, ...children.map(child => taskSummaryLine(snapshot, child))]
    const clause = (omitted: number): string =>
      omissionLine({
        scope: 'child tasks',
        unit: 'items',
        kept: children.length - omitted,
        limit: children.length,
        omitted,
        recovery: 'read them with the status view or by reference',
      })
    const reserve = utf8Bytes(clause(children.length)) + 1 + (summary.length === 0 ? 0 : utf8Bytes(summary.join('\n')) + 2)
    let shown = 0
    for (const line of childLines) {
      if (budget.remaining < reserve + utf8Bytes(line) + 1) break
      budget.add(line)
      shown += 1
    }
    // `childLines` starts with the heading and the count, which are not entries:
    // when even those did not fit, this list cannot say anything.
    if (shown < 2) return tooLarge('the root\'s children', taskPageHint(task.taskId))
    const omitted = children.length - (shown - 2)
    if (omitted > 0 && !budget.add(clause(omitted))) {
      return tooLarge('the root\'s children', taskPageHint(task.taskId))
    }
  }

  if (summary.length > 0 && budget.addAll(summary) > 0) return tooLarge('the run binding summary', taskPageHint(task.taskId))

  return read(budget.text(), storeSource(resolution.graph, resolution.storeId, 'read the caller\'s own contract and run'))
}

/* --- task_status (the caller's project state) ---------------------------- */

/**
 * `task_status` (A2 §D/A2-5): the caller's own task, its direct children and the
 * tasks directly adjacent to it through a dependency edge (`related`, the
 * default), or every task in the same domain (`graph`). Entries are sorted by
 * task id and paged with an explicit offset; the result states its source and
 * says outright that its pages are not a consistent snapshot of the store.
 *
 * The limit is clamped into 1–100 and a clamp is stated in the result, so a
 * caller that asked for 1000 gets 100 entries *and* knows it asked for more.
 *
 * Every page in this read advances: an entry line is shown whole or the page
 * ends before it. When the page's *first* entry cannot be shown, the page would
 * repeat the same offset forever, so the entry is refused by name
 * (`context-too-large`) with both ways forward — its own record read and the
 * offset that continues the listing past it.
 */
export async function taskStatus(deps: ReadDeps, loaded: LoadedCaller, query: StatusQuery): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution)
  const snapshot = loaded.snapshot
  const scope: StatusScope = query.scope ?? 'related'
  const requestedOffset = query.offset ?? 0
  const requestedLimit = query.limit ?? STATUS_LIMIT_DEFAULT
  // A number that is not finite cannot be paged with: it would make the page
  // empty while `hasMore` stayed true, which is the one shape a page may never
  // have. The tool schema rejects it before this door; the service door answers
  // it like the out-of-range values below, with the clamp stated in the result.
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.trunc(requestedOffset)) : 0
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(STATUS_LIMIT_MAX, Math.max(1, Math.trunc(requestedLimit)))
    : STATUS_LIMIT_DEFAULT
  const clamped = !Number.isFinite(requestedLimit) || !Number.isFinite(requestedOffset)
    || Math.trunc(requestedLimit) !== limit
    || truncate(requestedOffset) !== offset

  if (resolution.kind === 'root' && resolution.task === undefined) {
    return refused('not-activated', notActivatedLines(resolution.graph, resolution.storeId, snapshot).join('\n'))
  }
  if (snapshot === undefined) {
    return refused(
      'not-activated',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so there is no task tree to read.`,
    )
  }
  const self = resolution.kind === 'member' ? undefined : resolution.task
  if (scope === 'related' && self === undefined) {
    return refused(
      'unbound',
      `session "${resolution.sessionId}" has no task of its own in store "${resolution.storeId}", so there is no related ` +
        'scope for it; ask for scope:"graph" to read the whole domain.',
    )
  }
  const entries = scope === 'graph'
    ? [...snapshot.tasks]
        .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0))
        .map(task => ({ task, roles: [] as string[] }))
    : relatedEntries(snapshot, self as TaskInstance)
  const page = entries.slice(offset, offset + limit)
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const marker = recoveryMarker(resolution.recovery)
  const header = [
    '# Task status',
    `graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
    `scope: ${scope} · offset ${offset} · limit ${limit}` +
      (clamped ? ` (requested offset ${requestedOffset}, limit ${requestedLimit}: both are clamped into their ranges)` : ''),
    `entries in scope: ${entries.length}`,
    ...(marker === undefined ? [] : [marker, RECOVERY_NOTE]),
  ]
  if (budget.addAll(header) > 0) return tooLarge('the status header', 'Ask for a smaller page (a lower `limit`) or the `related` scope.')

  const obligations = await obligationLines(deps.envBuilder, resolution.graph.envId, snapshot)
  const obligationsClause = (omitted: number): string =>
    omissionLine({
      scope: 'obligation lines',
      unit: 'lines',
      kept: obligations.length - omitted,
      limit: obligations.length,
      omitted,
      recovery: 'the status page reached its output bound',
    })
  // The widest clause the obligation block can need, measured before the entries
  // so the page can never end without naming what it left out.
  const footerReserve =
    utf8Bytes('- more: yes — continue with offset 999999') + 1 +
    utf8Bytes('- source: ') + 200 + 1 +
    obligations.reduce((total, line) => total + utf8Bytes(line) + 1, 0) +
    utf8Bytes(obligationsClause(obligations.length)) + 1
  let shown = 0
  for (const entry of page) {
    const line = taskSummaryLine(snapshot, entry.task, entry.roles)
    // The footer and the obligation lines are owed after the entries; an entry
    // that would eat their room ends the page instead, so the page still says
    // where it stopped and where to continue.
    if (budget.remaining < footerReserve + utf8Bytes(line) + 1) break
    budget.add(line)
    shown += 1
  }
  if (shown === 0 && page.length > 0) {
    // The page's own first entry has no room, and a page of zero entries at this
    // offset would report the same offset again — the same page forever. The
    // entry is refused by name instead, with both ways forward: the task's own
    // record read, and the offset that continues the listing past it.
    const first = page[0] as { readonly task: TaskInstance; readonly roles: readonly string[] }
    const lineBytes = utf8Bytes(taskSummaryLine(snapshot, first.task, first.roles))
    return tooLarge(
      `the summary line of task "${first.task.taskId}" (${lineBytes} UTF-8 bytes)`,
      `Nothing of that entry is shown, and a page of zero entries at offset ${offset} would report the same offset again, so the ` +
        `listing could never move past it. Read that task whole instead with \`context_read\` kind:"task" ` +
        `ref:"${first.task.taskId}" (its record pages in UTF-8 bytes), or ask for the entries *after* it with offset ` +
        `${offset + 1} — the rest of the scope stays reachable that way.`,
    )
  }
  const nextOffset = offset + shown
  const hasMore = nextOffset < entries.length
  const footer = [
    `- more: ${hasMore ? `yes — continue with offset ${nextOffset}` : 'no — this is the end of the scope'}`,
    `- source: one read of store ${resolution.storeId}; pages are observations, not a consistent snapshot across calls` +
      (shown < page.length ? '; this page stopped at the output bound' : ''),
  ]
  if (budget.addAll(footer) > 0) return tooLarge('the status page footer', 'Ask for a smaller page (a lower `limit`).')
  const omittedObligations = budget.addAll(obligations)
  // The reservation above is an upper bound for this clause, so a page that had
  // to leave obligation lines out always says how many it left out.
  if (omittedObligations > 0) budget.add(obligationsClause(omittedObligations))

  return read(budget.text(), storeSource(resolution.graph, resolution.storeId, `listed ${scope} tasks`), { hasMore, nextOffset })
}

function truncate(value: number): number {
  return Math.trunc(value)
}

/**
 * Best-effort obligation coverage (KISS §5.1, guide §4.2 #21): templates from
 * `<repoRoot>/.agents/skills/<name>/obligations.yml` against the graph's
 * obligations and requested capabilities. Every step may be absent — no env
 * builder, no repo root within reach, no template files — and an absent source
 * omits the coverage line rather than reporting zero coverage. Uncovered entries
 * are a hint ("satisfied, or forgotten?"), never a block.
 */
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
    const uncovered = coverage.uncovered.map(template => `${template.id} ("${template.question}") — satisfied, or forgotten?`)
    return [
      ...header,
      `- obligation coverage: ${coverage.covered.length}/${templates.length} covered${uncovered.length === 0 ? '' : `; uncovered: ${uncovered.join('; ')}`}`,
    ]
  } catch {
    return header
  }
}

/* --- context_read (reads by reference) ---------------------------------- */

/** One located record: the store object plus the identity the result prints. */
interface LocatedRecord {
  readonly identity: string
  readonly record: TaskInstance | TaskRun | EvidenceBundle | ReviewRecord | Diagnosis
}

/**
 * `context_read` (A2 §D/A2-5): one record of the caller's own domain, by
 * reference. The reference never authorizes — the caller was resolved first, and
 * the record is looked up inside the caller's graph store. A session reference
 * is checked against the graph's published members before DSH is asked anything,
 * so a session of another graph is refused as `cross-graph` without its history
 * being touched.
 *
 * Task-class records are read whole and paged in UTF-8 bytes when they exceed
 * the output bound. A session reference has two forms: a session id pages that
 * session's log by DSH event seq (its own read unit), while `{sessionId, seq}`
 * reads one event's visible text, paged in UTF-8 bytes — the door a listing
 * hands an event too large to render inline to.
 */
export async function contextRead(
  deps: ReadDeps,
  loaded: LoadedCaller,
  query: ContextReadQuery,
  signal?: AbortSignal,
): Promise<ProjectedRead> {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return unboundRead(resolution)
  signal?.throwIfAborted()
  const snapshot = loaded.snapshot
  const kind = query.kind

  if (kind === 'session') {
    if (typeof query.ref === 'string') {
      return await sessionRead(deps, loaded, query.ref, query.offset, query.limit, signal)
    }
    if (isSessionEventReference(query.ref)) {
      return await sessionEventRead(deps, loaded, query.ref, query.offset, query.limit, signal)
    }
    return malformedRef(kind, query.ref)
  }
  if (snapshot === undefined) {
    return refused(
      'not-activated',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so it holds no ${kind} record to read.`,
    )
  }

  const found = locateRecord(snapshot, kind, query.ref)
  if ('refusal' in found) return refused(found.refusal, found.detail)
  const recordText = await recordTextOf(deps, snapshot, found.record)
  const offset = Math.max(0, Math.trunc(query.offset ?? 0))
  const limit = Math.min(CONTEXT_OUTPUT_LIMIT_BYTES, Math.max(TASK_PAGE_MIN_BYTES, Math.trunc(query.limit ?? CONTEXT_OUTPUT_LIMIT_BYTES)))
  const total = utf8Bytes(recordText)
  const banner = [
    `# context_read ${kind} ${found.identity}`,
    `store ${resolution.storeId} of graph "${resolution.graph.id}" — record ${total} UTF-8 bytes; this page starts at byte ${offset}`,
    ...(offset > total ? ['the offset is past the end of the record: this page is empty'] : []),
  ].join('\n')
  // The page carries `limit` bytes of the record; the banner and the continuation
  // footer ride inside the one output bound, never on top of it.
  const pageBudget = Math.max(1, Math.min(limit, CONTEXT_OUTPUT_LIMIT_BYTES - utf8Bytes(banner) - 96))
  const slice = sliceUtf8(recordText, offset, pageBudget)
  const footer = slice.done
    ? `(end of record at byte ${slice.nextOffset})`
    : `(more of this record follows: ask again with offset ${slice.nextOffset})`
  const text = [banner, '', slice.text, '', footer].join('\n')
  return read(text, storeSource(resolution.graph, resolution.storeId, `read the ${kind} record`), {
    hasMore: !slice.done,
    nextOffset: slice.nextOffset,
  })
}

function malformedRef(kind: ContextReadQuery['kind'], ref: unknown): ProjectedRead {
  const shape = REF_SHAPES[kind]
  return refused(
    'not-found',
    `\`context_read\` kind:"${kind}" reads one record by ${shape}; the reference given (${ref === null ? 'null' : JSON.stringify(ref)}) ` +
      'is not that shape, so it names no record.',
  )
}

/**
 * Whether `ref` is the `{sessionId, seq}` event reference. The shape only: a
 * `seq` that is a number but not a usable event seq (negative, fractional,
 * non-finite) is the event read's own refusal, so the value is judged there with
 * the requirement it failed, never here as a wrong shape.
 */
function isSessionEventReference(ref: unknown): ref is SessionEventReference {
  if (ref === null || typeof ref !== 'object') return false
  const candidate = ref as { readonly sessionId?: unknown; readonly seq?: unknown }
  return typeof candidate.sessionId === 'string' && typeof candidate.seq === 'number'
}

function unknownDetail(noun: string, ref: string, snapshot: TaskSnapshot): string {
  return (
    `no ${noun} "${ref}" in your graph's task store (it holds ${snapshot.tasks.length} tasks); ` +
    'ids from another graph are not readable here, and a reference never widens the read domain.'
  )
}

/** Resolve one reference inside the caller's own store; never outside it. */
function locateRecord(
  snapshot: TaskSnapshot,
  kind: Exclude<ContextReadQuery['kind'], 'session'>,
  ref: string | ReviewReference | SessionEventReference,
): LocatedRecord | { readonly refusal: NamedRefusal; readonly detail: string } {
  if (kind === 'review') {
    if (typeof ref === 'string' || ref === null || typeof ref !== 'object') return { refusal: 'not-found', detail: reviewRefDetail(ref) }
    // A review's reference is the pair a review record carries; a session's
    // `{sessionId, seq}` (or any other object) is not that shape and is refused
    // as such rather than searched for with an undefined task id.
    const taskId = (ref as { taskId?: unknown }).taskId
    if (typeof taskId !== 'string') return { refusal: 'not-found', detail: reviewRefDetail(ref) }
    const task = snapshot.tasks.find(item => item.taskId === taskId)
    if (task === undefined) {
      return {
        refusal: 'not-found',
        detail: `task "${taskId}" is not in your graph's task store, so the review reference does not resolve inside the caller's domain.`,
      }
    }
    const runId = (ref as ReviewReference).runId ?? null
    const review = [...snapshot.reviews].reverse().find(item => item.taskId === taskId && (item.runId ?? null) === runId)
    if (review !== undefined) return { identity: `${taskId}#${runId ?? 'no-run'}`, record: review }
    const others = snapshot.reviews.filter(item => item.taskId === taskId)
    if (others.length === 0) {
      return { refusal: 'not-found', detail: `task "${taskId}" has no review record in this store, so the reference names nothing.` }
    }
    return {
      refusal: 'stale-reference',
      detail:
        `task "${taskId}" has review records, but none for run "${runId ?? '(none)'}": this store holds ` +
        `${others.map(item => `${item.taskId}#${item.runId ?? 'no-run'} (${item.outcome})`).join(', ')}. ` +
        'The reference names a review that does not exist for that run.',
    }
  }
  if (typeof ref !== 'string') {
    const shape = REF_SHAPES[kind]
    return { refusal: 'not-found', detail: `\`context_read\` kind:"${kind}" reads one record by ${shape}; the reference given is not that shape.` }
  }
  switch (kind) {
    case 'task': {
      const task = snapshot.tasks.find(item => item.taskId === ref)
      return task === undefined ? { refusal: 'not-found', detail: unknownDetail('task', ref, snapshot) } : { identity: ref, record: task }
    }
    case 'run': {
      const run = snapshot.runs.find(item => item.runId === ref)
      return run === undefined ? { refusal: 'not-found', detail: unknownDetail('run', ref, snapshot) } : { identity: ref, record: run }
    }
    case 'evidence': {
      const evidence = snapshot.evidence.find(item => item.evidenceId === ref)
      if (evidence === undefined) return { refusal: 'not-found', detail: unknownDetail('evidence', ref, snapshot) }
      if (!snapshot.tasks.some(item => item.taskId === evidence.taskId)) {
        return {
          refusal: 'stale-reference',
          detail: `evidence "${ref}" names task "${evidence.taskId}", which this store does not hold: the reference is stale.`,
        }
      }
      return { identity: ref, record: evidence }
    }
    case 'diagnosis': {
      const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === ref)
      if (diagnosis === undefined) return { refusal: 'not-found', detail: unknownDetail('diagnosis', ref, snapshot) }
      if (!snapshot.tasks.some(item => item.taskId === diagnosis.taskId)) {
        return {
          refusal: 'stale-reference',
          detail: `diagnosis "${ref}" names task "${diagnosis.taskId}", which this store does not hold: the reference is stale.`,
        }
      }
      return { identity: ref, record: diagnosis }
    }
  }
}

function reviewRefDetail(ref: unknown): string {
  return `\`context_read\` kind:"review" reads one record by ${REF_SHAPES.review}; the reference given (${JSON.stringify(ref)}) is not that shape.`
}

async function recordTextOf(
  deps: ReadDeps,
  snapshot: TaskSnapshot,
  record: TaskInstance | TaskRun | EvidenceBundle | ReviewRecord | Diagnosis,
): Promise<string> {
  if ('objective' in record) return taskRecordText(record)
  if ('capabilitySnapshot' in record) return await runRecordText(deps.taskRuntime, record, snapshot)
  if ('evidenceId' in record) return evidenceRecordText(snapshot, record)
  if ('diagnosisId' in record) return diagnosisRecordText(record)
  return reviewRecordText(record as ReviewRecord)
}

/**
 * The membership gate both session forms pass before DSH is asked anything: a
 * session that is not a published member of the caller's graph reads nothing,
 * and a membership that cannot be read is a named failure, never a pass — a
 * session reference whose ownership is unknown is not this graph's session.
 * `undefined` means the session is a member and the read may proceed.
 */
async function sessionMembershipRefusal(
  deps: ReadDeps,
  resolution: Exclude<LoadedCaller['resolution'], { kind: 'unbound' }>,
  sessionId: string,
): Promise<ProjectedRead | undefined> {
  let member: boolean
  try {
    member = await isGraphMember(deps.graphs, resolution.graph.id, sessionId)
  } catch (error) {
    return refused(
      'unreadable',
      `the membership of session "${sessionId}" in graph "${resolution.graph.id}" could not be read: ${message(error)}. ` +
        'A session reference is checked against the graph\'s published members before its log is read.',
    )
  }
  if (member) return undefined
  return refused(
    'cross-graph',
    `session "${sessionId}" is not a published member of graph "${resolution.graph.id}"; a session reference reads the ` +
      'caller\'s own domain, and a session id is not a key to another graph.',
  )
}

/**
 * One session page: events from `offset` (a DSH event seq) onward, bounded by the
 * event count and by the output bound. A session that is not a published member
 * of the caller's graph is refused as `cross-graph` before its log is touched;
 * membership is the graph store's own record, so a guessed session id never
 * reaches DSH.
 *
 * A page is a whole number of events, never a piece of one. An event's rendered
 * lines are measured as a block before any of them is added; an event too large
 * for the page is refused by name (`context-too-large`) when it is the page's
 * first — a session offset addresses whole events, so there is no cursor inside
 * one — and merely ends the page before it when it comes later, still reachable
 * at its own seq. A window that fails after an earlier one succeeded is never
 * turned into a partial page: the refusal says where the read stopped and that
 * nothing partial is returned in its place.
 */
async function sessionRead(
  deps: ReadDeps,
  loaded: LoadedCaller,
  sessionId: string,
  requestedOffset: number | undefined,
  requestedLimit: number | undefined,
  signal?: AbortSignal,
): Promise<ProjectedRead> {
  const resolution = loaded.resolution as Exclude<LoadedCaller['resolution'], { kind: 'unbound' }>
  signal?.throwIfAborted()
  const gate = await sessionMembershipRefusal(deps, resolution, sessionId)
  if (gate !== undefined) return gate
  const offset = Number.isFinite(requestedOffset ?? 0) ? Math.max(0, Math.trunc(requestedOffset ?? 0)) : 0
  const requestedEvents = Number.isFinite(requestedLimit ?? SESSION_LIMIT_DEFAULT)
    ? Math.trunc(requestedLimit ?? SESSION_LIMIT_DEFAULT)
    : SESSION_LIMIT_DEFAULT
  const limit = Math.min(SESSION_LIMIT_MAX, Math.max(1, requestedEvents))
  const clamped = requestedEvents !== limit
  let capturedThroughSeq: number | null
  try {
    capturedThroughSeq = (await deps.sessionQuery.readSurface(sessionId)).capturedThroughSeq
  } catch (error) {
    signal?.throwIfAborted()
    const code = errorCode(error)
    if (code === 'SESSION_QUERY_ABORTED') throw error
    return code === 'SESSION_QUERY_SESSION_NOT_FOUND'
      ? refused('not-found', `session "${sessionId}" has no log in this deployment: ${message(error)}`)
      : refused('unreadable', `session "${sessionId}" could not be read: ${message(error)}`)
  }
  const banner = [
    `# context_read session ${sessionId}`,
    `graph "${resolution.graph.id}" — raw log through seq ${capturedThroughSeq ?? '(empty)'}; events from seq ${offset}, at most ${limit}` +
      (clamped ? ` (requested ${requestedEvents})` : ''),
  ]
  const source = `session ${sessionId} via the session query, one log observation through seq ${capturedThroughSeq ?? '(empty)'}`
  if (capturedThroughSeq === null || offset > capturedThroughSeq) {
    const note = capturedThroughSeq === null ? '(this session\'s log holds no events)' : '(the offset is at or past the end of the log)'
    return read([...banner, '', note].join('\n'), source, {
      hasMore: false,
      nextOffset: capturedThroughSeq === null ? 0 : capturedThroughSeq + 1,
    })
  }

  const events: SessionEvent[] = []
  let cursor = offset
  let asked = offset
  while (events.length < limit && cursor <= capturedThroughSeq) {
    asked = cursor
    let window: Awaited<ReturnType<SessionQueryReads['readEvent']>>
    try {
      window = await deps.sessionQuery.readEvent(
        { sessionId, seq: cursor, before: 0, after: Math.min(SESSION_QUERY_READ_WINDOW_MAX - 1, limit - events.length - 1) },
        signal,
      )
    } catch (error) {
      signal?.throwIfAborted()
      const code = errorCode(error)
      if (code === 'SESSION_QUERY_ABORTED') throw error
      // A window that fails once an earlier one has answered leaves the log half
      // read, and half a log is not a page: the caller is told the read failed,
      // never handed the events the read could not finish collecting. Only the
      // first window keeps the code-to-refusal mapping, since it is the answer.
      return events.length === 0
        ? refused(
            code === 'SESSION_QUERY_EVENT_NOT_FOUND' ? 'stale-reference' : 'unreadable',
            `session "${sessionId}" could not be read at seq ${cursor}: ${message(error)}`,
          )
        : refused(
            'unreadable',
            `session "${sessionId}" could not be read at seq ${cursor}, after the window at seq ${offset} answered: ${message(error)}. ` +
              `Nothing partial is returned: the ${events.length} event(s) the read had already collected are not reported as a page of this log.`,
          )
    }
    for (const event of window.events) {
      if (events.length >= limit) break
      events.push(event)
    }
    if (window.endSeq <= cursor) break
    cursor = window.endSeq + 1
  }
  if (events.length === 0) {
    // Nothing was read: a window that answers without an event (or without
    // moving its endSeq) gives the page nothing to carry, and an empty page here
    // would claim `hasMore` at the same offset and be read again forever.
    return refused(
      'unreadable',
      `session "${sessionId}" could not be read at seq ${asked}: the session query answered without advancing to an event, ` +
        'so nothing was read and an empty page would only repeat this offset. Nothing is returned in place of the events.',
    )
  }

  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  budget.addAll(banner)
  budget.addAll(['', `events: seq ${offset}..${cursor - 1} of a log through seq ${capturedThroughSeq}`])
  // The room the page's closing lines need, decided before any event is added:
  // a page the model receives always says where it ended and where to continue,
  // and never spends that room on an event body.
  const reserve = sessionClosingReserve(limit, capturedThroughSeq, sessionId)
  let shown = 0
  let stopped: SessionEvent | undefined
  for (const event of events) {
    const lines = eventLines(event)
    // The whole event is measured before any of its lines is added: a page
    // carries whole events, never a partial body.
    if (!blockFits(budget, lines, reserve)) {
      // A session offset addresses whole events (DSH's read unit), so an event
      // that does not fit has no second page inside the page: the first one is
      // refused by name, a later one ends the page before it.
      if (shown === 0) return refused('context-too-large', oversizedEventDetail(sessionId, event))
      stopped = event
      break
    }
    budget.addAll(lines)
    shown += 1
  }
  if (stopped !== undefined) budget.add(notShownEventLine(sessionId, stopped))
  const lastShownSeq = Number((events[shown - 1] as SessionEvent).seq)
  // A page that stopped before an event continues at that event's own seq, never
  // at seq+1: skipping it is the caller's decision, not this read's.
  const nextOffset = stopped === undefined ? lastShownSeq + 1 : Number(stopped.seq)
  const hasMore = nextOffset <= capturedThroughSeq
  budget.add(
    `- events shown: ${shown} of at most ${limit}` +
      (hasMore ? ` · more follows from seq ${nextOffset}` : ' · end of the log'),
  )
  return read(
    budget.text(),
    `session ${sessionId} via the session query, seq ${offset}..${lastShownSeq} of a log through seq ${capturedThroughSeq}`,
    { hasMore, nextOffset },
  )
}

/** The exact object reference one event is read with, as the listing hands it back and the tool spells it. */
function eventReference(sessionId: string, seq: number): string {
  return `{"sessionId":${JSON.stringify(sessionId)},"seq":${seq}}`
}

/**
 * Whether `offsetBytes` falls between two characters of `text` — the offset
 * itself or one past a character. A UTF-8 continuation byte (`10xxxxxx`) says
 * the byte belongs to a character that started earlier, so a page starting there
 * would carry a fragment of one; an offset outside the text is not a boundary
 * either.
 */
function onCharacterBoundary(text: string, offsetBytes: number): boolean {
  if (offsetBytes === 0) return true
  const byte = Buffer.from(text, 'utf8').at(offsetBytes)
  return byte !== undefined && (byte & 0b1100_0000) !== 0b1000_0000
}

/**
 * The line the final page of an event carries. The two reads page by different
 * units — the listing by event seq, this one by byte — so the note names the
 * listing's own cursor as such: the event after this one, never this page's
 * `nextOffset`.
 */
function eventEndNote(sessionId: string, seq: number): string {
  return (
    `the visible text of event seq ${seq} of session "${sessionId}" ends here; the listing of that session continues with ` +
    `\`context_read\` kind:"session" ref:"${sessionId}" offset = ${seq + 1} (the event seq after this one).`
  )
}

/**
 * One event page as JSON — exactly the model-visible value. `offset` and
 * `nextOffset` are byte positions in the event's visible text, `body` this
 * page's raw fragment of it, and the note rides the final page only.
 */
function sessionEventPage(ref: SessionEventReference, offset: number, slice: Utf8Slice): string {
  return JSON.stringify({
    sessionId: ref.sessionId,
    seq: ref.seq,
    offset,
    nextOffset: slice.nextOffset,
    hasMore: !slice.done,
    body: slice.text,
    ...(slice.done ? { note: eventEndNote(ref.sessionId, ref.seq) } : {}),
  })
}

/**
 * One session *event*: the visible text of a single event, paged in UTF-8 bytes
 * (A2 §D, Q3 closure) — the door a session listing opens for an event too large
 * to render inline. The listing's own unit is the whole event, so an event that
 * does not fit a listing page has no listing cursor inside it; this read carries
 * that event's `extractSessionEventText` output as bytes, and the raw session
 * JSON it was extracted from is never part of a page.
 *
 * The order is the contract: the seq, the offset and the limit are judged before
 * anything is read, membership is the graph store's own record (so a guessed
 * session id never reaches DSH), and only then is the one event read. Every page
 * advances — an offset inside a character or at or past the end of the text is
 * `stale-reference`, never a silently re-aligned page — and the page is sized
 * against the JSON the model receives, so escapes cannot push it over the bound.
 */
async function sessionEventRead(
  deps: ReadDeps,
  loaded: LoadedCaller,
  ref: SessionEventReference,
  requestedOffset: number | undefined,
  requestedLimit: number | undefined,
  signal?: AbortSignal,
): Promise<ProjectedRead> {
  const resolution = loaded.resolution as Exclude<LoadedCaller['resolution'], { kind: 'unbound' }>
  signal?.throwIfAborted()
  const sessionId = ref.sessionId
  const seq = ref.seq
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return refused(
      'not-found',
      `\`context_read\` kind:"session" reads one event by a \`{sessionId, seq}\` whose seq is a non-negative safe integer ` +
        `(a DSH event seq); the seq given (${String(seq)}) is not one, so it names no event.`,
    )
  }
  const offset = requestedOffset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return refused(
      'stale-reference',
      `the offset given (${String(offset)}) is not a non-negative safe integer; a session event's offset is a UTF-8 byte ` +
        "position in that event's visible text.",
    )
  }
  const requestedBytes = requestedLimit ?? CONTEXT_OUTPUT_LIMIT_BYTES
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1) {
    return refused(
      'not-found',
      `the limit given (${String(requestedBytes)}) is not a positive safe integer; a session event's limit is a page size in ` +
        `UTF-8 bytes, clamped into ${SESSION_EVENT_PAGE_MIN_BYTES}..${CONTEXT_OUTPUT_LIMIT_BYTES}.`,
    )
  }
  const limit = Math.min(CONTEXT_OUTPUT_LIMIT_BYTES, Math.max(SESSION_EVENT_PAGE_MIN_BYTES, requestedBytes))
  const gate = await sessionMembershipRefusal(deps, resolution, sessionId)
  if (gate !== undefined) return gate

  let window: Awaited<ReturnType<SessionQueryReads['readEvent']>>
  try {
    window = await deps.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const code = errorCode(error)
    if (code === 'SESSION_QUERY_ABORTED') throw error
    if (code === 'SESSION_QUERY_EVENT_NOT_FOUND') {
      return refused(
        'stale-reference',
        `session "${sessionId}" has no event at seq ${seq}: ${message(error)}. The reference names an event this log does not hold.`,
      )
    }
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return refused('not-found', `session "${sessionId}" has no log in this deployment: ${message(error)}`)
    }
    return refused('unreadable', `session "${sessionId}" could not be read at seq ${seq}: ${message(error)}`)
  }
  const answered = window?.target as SessionEvent | undefined
  // A source that answers another event must not have that event's text rendered
  // as this one's: the seq the page states is the seq that was read.
  if (answered === undefined || Number(answered.seq) !== seq) {
    return refused(
      'stale-reference',
      `session "${sessionId}" answered ${answered === undefined ? 'no event' : `seq ${String(answered.seq)}`} for the ` +
        `reference to seq ${seq}: a page of another event is not this event's text.`,
    )
  }
  const text = extractSessionEventText(answered)
  const total = utf8Bytes(text)
  const source = `session ${sessionId} via the session query, event seq ${seq} observed with ${total} UTF-8 bytes of visible text`
  if (total === 0) {
    // An event with no visible text has exactly one page, and it is offset 0's:
    // nothing is at any later byte.
    if (offset !== 0) {
      return refused(
        'stale-reference',
        `event seq ${seq} of session "${sessionId}" has no visible text, so offset ${offset} is past the end of it; ` +
          'offset 0 is the only page of that event.',
      )
    }
    const empty: Utf8Slice = { text: '', nextOffset: 0, done: true }
    return read(sessionEventPage(ref, 0, empty), source, { hasMore: false, nextOffset: 0 })
  }
  if (offset >= total) {
    return refused(
      'stale-reference',
      `offset ${offset} is at or past the end of the visible text of event seq ${seq} of session "${sessionId}", which is ` +
        `${total} UTF-8 bytes: this page would carry nothing.`,
    )
  }
  if (!onCharacterBoundary(text, offset)) {
    return refused(
      'stale-reference',
      `offset ${offset} falls inside a UTF-8 character of the visible text of event seq ${seq} of session "${sessionId}"; ` +
        'an offset is a character boundary, and a page never starts with a fragment of a character.',
    )
  }
  // The page is sized against the JSON the model receives, not the raw fragment:
  // escapes (quotes, backslashes, control characters) widen a fragment, so the
  // raw budget is shrunk by the ratio the bound was overshot by until the page
  // fits, keeping at least one character. `sliceUtf8` never returns an empty
  // page for an offset inside the text, so every page this loop settles on still
  // advances.
  let pageBytes = limit
  let slice = sliceUtf8(text, offset, pageBytes)
  let page = sessionEventPage(ref, offset, slice)
  while (utf8Bytes(page) > CONTEXT_OUTPUT_LIMIT_BYTES && pageBytes > 1) {
    const fitted = Math.floor((utf8Bytes(slice.text) * CONTEXT_OUTPUT_LIMIT_BYTES) / utf8Bytes(page))
    pageBytes = Math.max(1, Math.min(pageBytes - 1, fitted))
    slice = sliceUtf8(text, offset, pageBytes)
    page = sessionEventPage(ref, offset, slice)
  }
  if (utf8Bytes(page) > CONTEXT_OUTPUT_LIMIT_BYTES) {
    // One character and the wrapper around it do not fit the bound: no page of
    // this event's text exists that the bound can carry. Impossible in practice
    // (the wrapper is a few hundred bytes at most), stated rather than looped.
    return refused(
      'context-too-large',
      `a single character of event seq ${seq} of session "${sessionId}" plus the page stating where it sits does not fit the ` +
        `${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, so no page of that event's text can be returned.`,
    )
  }
  return read(page, source, { hasMore: !slice.done, nextOffset: slice.nextOffset })
}

/** The widest rendering of one number of `value`'s magnitude, so a reserve can bound a line that carries it. */
function widestNumber(value: number): string {
  return '9'.repeat(String(Math.max(0, Math.trunc(value))).length)
}

/**
 * The bytes a session page must keep for its closing lines — the `events shown`
 * footer, and the line naming the event the page stopped before when there is
 * one. Every number those lines can carry is bounded here by the range the page
 * itself knows (the caller's limit, the log's last seq, and the widest text
 * size), and the session id is the same string the page carries, so the reserve
 * is an upper bound whatever event follows: a page the model receives always
 * ends with its continuation cue.
 */
function sessionClosingReserve(limit: number, capturedThroughSeq: number, sessionId: string): number {
  const seq = widestNumber(Number(capturedThroughSeq) + 1)
  const count = widestNumber(limit)
  const footer = `- events shown: ${count} of at most ${count} · more follows from seq ${seq}`
  const stopped =
    `- the next event (seq ${seq}, ${widestNumber(Number.MAX_SAFE_INTEGER)} UTF-8 bytes of text) was not shown on this ` +
    `page: it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it. Read that event with ` +
    `ref:${eventReference(sessionId, Number(seq))} — its text pages in UTF-8 bytes.`
  return utf8Bytes(footer) + utf8Bytes(stopped) + 2
}

/** Whether every one of `lines` fits the page's remaining space as one block (each separator counted), keeping `reserve` for what follows. */
function blockFits(budget: OutputBudget, lines: readonly string[], reserve = 0): boolean {
  if (lines.length === 0) return true
  const width = utf8Bytes(lines.join('\n')) + (budget.bytes === 0 ? 0 : 1)
  return width + reserve <= budget.remaining
}

/** The UTF-8 size of the text one event carries. */
function eventTextBytes(event: SessionEvent): number {
  return utf8Bytes(extractSessionEventText(event))
}

/**
 * The refusal of an event no listing page can carry: a session offset addresses
 * whole events (DSH's read unit), so an event larger than the bound has no
 * second listing page. The detail names the event and the size of its visible
 * text, says the listing cannot render it whole, and hands back the one
 * reference that reads the event's text itself — pages of its visible text in
 * UTF-8 bytes. Moving past the event with `offset` is mentioned as the caller's
 * explicit choice, never as a way to reach the body.
 */
function oversizedEventDetail(sessionId: string, event: SessionEvent): string {
  const seq = Number(event.seq)
  return (
    `event seq ${seq} of session "${sessionId}" does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page (its visible text alone ` +
    `is ${eventTextBytes(event)} UTF-8 bytes); a session listing carries whole events — DSH's read unit — so this listing cannot ` +
    `render it whole, and none of its text is shown here. Read that event with \`context_read\` kind:"session" ` +
    `ref:${eventReference(sessionId, seq)}, whose pages are the UTF-8 bytes of its visible text. Asking this listing again with ` +
    `offset ${seq + 1} moves past the event and shows none of its text: that is the caller's explicit choice, not a way to read ` +
    'the body.'
  )
}

/**
 * The line a page carries when it stops before an event that does not fit: the
 * event is named with the size of its visible text and the exact reference that
 * reads it, so the body the listing cannot carry is one call away, and moving
 * past the event stays the caller's explicit choice.
 */
function notShownEventLine(sessionId: string, event: SessionEvent): string {
  const seq = Number(event.seq)
  return (
    `- the next event (seq ${seq}, ${eventTextBytes(event)} UTF-8 bytes of text) was not shown on this page: ` +
    `it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it. Read that event with ` +
    `ref:${eventReference(sessionId, seq)} — its text pages in UTF-8 bytes.`
  )
}

function eventLines(event: SessionEvent): string[] {
  const text = extractSessionEventText(event)
  const head = `- seq ${event.seq} | ${event.type} | ${new Date(event.time).toISOString()}`
  return text.length === 0 ? [head] : [head, ...text.split('\n').map(line => `  ${line}`)]
}

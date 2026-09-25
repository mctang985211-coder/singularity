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
import type {
  Diagnosis,
  EvidenceBundle,
  ReviewRecord,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from '@dangosys/dsh-singularity-task-runtime'
import type { StoreRecoveryStatus } from '@dangosys/dsh-singularity-task-runtime'
import { isGraphMember, type BindingDeps, type CallerGraph, type LoadedCaller, type ReadOnlyTaskRuntime } from './bindings.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, omittedLine, sliceUtf8, utf8Bytes } from './limits.ts'
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

/** What one reference read asks for, by kind. */
export interface ContextReadQuery {
  readonly kind: 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session'
  /** The record's own identity, in the shape its kind uses. */
  readonly ref: string | ReviewReference
  /** Task-class kinds: UTF-8 byte offset into the record text. Session: event seq. */
  readonly offset?: number
  /**
   * Task-class kinds: how many UTF-8 bytes of the record this page may carry
   * (the whole answer still never exceeds the output bound). Session: events per
   * page.
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
/** A task-class page never goes below this many bytes; below it a page could not advance usefully. */
const TASK_PAGE_MIN_BYTES = 64

/** How a caller asks for a record's identity, spelled out in every malformed-ref refusal. */
const REF_SHAPES: Record<ContextReadQuery['kind'], string> = {
  task: 'the task id',
  run: 'the run id',
  evidence: 'the evidence id',
  diagnosis: 'the diagnosis id',
  review: '`{taskId, runId}` (with `runId: null` for a task that blocked before any run)',
  session: 'the session id',
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

/** The caller's own run, as one line: status, phase, and the old-record marker such a run earns. */
function ownRunLine(run: TaskRun): string {
  return `run ${run.runId} [${run.status}]${runPhaseSuffix(run)} started ${run.startedAt}`
}

/**
 * One reference list inside the byte bound: entries are shown in store order
 * until the budget (which also has to hold the omission marker) runs out, and
 * what did not fit is named with its count. Returns `'too-large'` when not even
 * the marker fits — a list that cannot say how much it hid is not shown at all.
 */
function referenceList(
  budget: OutputBudget,
  title: string,
  entries: readonly string[],
  noun: string,
  how: string,
): string | undefined {
  if (entries.length === 0) return budget.add(`- ${title}: (none)`) ? undefined : 'too-large'
  const reserve = utf8Bytes(omittedLine(noun, entries.length, how)) + 1
  if (!budget.add(`- ${title}:`)) return 'too-large'
  let shown = 0
  for (const entry of entries) {
    if (budget.remaining <= reserve) break
    if (!budget.add(`  ${entry}`)) break
    shown += 1
  }
  if (shown === entries.length) return undefined
  return budget.add(omittedLine(noun, entries.length - shown, how)) ? undefined : 'too-large'
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

  if (run?.providerBinding !== undefined) {
    const summary = (await bindingLines(deps.taskRuntime, run.providerBinding)).filter(line => line.length > 0)
    if (budget.addAll(['', '## Implementation chosen for this run', ...summary]) > 0) {
      return tooLarge('the run binding summary', taskPageHint(task.taskId))
    }
  }

  if (role === 'worker') {
    const handoff = handoffFor(snapshot, task.taskId)
    if (handoff === undefined) {
      const missing = ['', '## Handoff', '- handoff: none recorded — this store holds no TaskHandoff naming this task as its child']
      if (budget.addAll(missing) > 0) return tooLarge('the handoff', taskPageHint(task.taskId))
    } else {
      if (budget.addAll(['', '## Handoff', ...handoffLines(handoff)]) > 0) return tooLarge('the handoff', taskPageHint(task.taskId))
      const references = handoffReferences(handoff)
      if (referenceList(budget, 'relevant artifacts', references.artifacts, 'handoff artifact references', 'read them by id') !== undefined) {
        return tooLarge('the handoff references', taskPageHint(task.taskId))
      }
      if (referenceList(budget, 'relevant evidence', references.evidence, 'handoff evidence references', 'read them by id') !== undefined) {
        return tooLarge('the handoff references', taskPageHint(task.taskId))
      }
    }
    const decomposition = workerDecompositionLines(deps.taskRuntime, task)
    if (decomposition.length > 0 && budget.addAll(['', ...decomposition]) > 0) {
      return tooLarge('the decomposition guidance', taskPageHint(task.taskId))
    }
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
    const label = `delegated task state (review-only, no business Run): ${run === undefined ? 'no run was ever started' : ownRunLine(run)}`
    if (!budget.add(label)) return tooLarge('the delegated task state', taskPageHint(task.taskId))
  } else {
    if (!budget.add(`your run: ${resolution.run === undefined ? 'none' : ownRunLine(resolution.run)}`)) {
      return tooLarge('the run line', taskPageHint(task.taskId))
    }
  }

  if (snapshot !== undefined) {
    const entries = relatedEntries(snapshot, task)
    const lines = entries.map(entry => taskSummaryLine(snapshot, entry.task, entry.roles))
    const markerText = omittedLine('related tasks', lines.length, 'page through them with the status view')
    const reserve = utf8Bytes(markerText) + 1
    if (budget.addAll(['', 'related tasks (you, your direct children, and the tasks directly adjacent through a dependency edge):']) > 0) {
      return tooLarge('the related tasks heading', taskPageHint(task.taskId))
    }
    let shown = 0
    for (const line of lines) {
      if (budget.remaining <= reserve) break
      if (!budget.add(line)) break
      shown += 1
    }
    if (shown < lines.length) {
      if (!budget.add(omittedLine('related tasks', lines.length - shown, 'page through them with the status view'))) {
        return tooLarge('the related tasks list', taskPageHint(task.taskId))
      }
    }
  }

  return read(
    budget.text(),
    storeSource(resolution.graph, resolution.storeId, 'projected the caller\'s dynamic state'),
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
  const lines = ['', ...contractBody(task), ...(run === undefined ? [] : ['', ownRunLine(run)])]
  if (budget.addAll(lines) > 0) return tooLarge('your contract', taskPageHint(task.taskId))

  if (snapshot !== undefined && resolution.kind === 'root') {
    const children = task.childTaskIds.flatMap(taskId => snapshot.tasks.filter(item => item.taskId === taskId))
    const childLines = ['', `children: ${children.length}`, ...children.map(child => taskSummaryLine(snapshot, child))]
    const omitted = budget.addAll(childLines)
    if (omitted > 0 && !budget.add(omittedLine('child tasks', omitted, 'read them with the status view or by reference'))) {
      return tooLarge('the root\'s children', taskPageHint(task.taskId))
    }
  }

  if (run?.providerBinding !== undefined) {
    const summary = (await bindingLines(deps.taskRuntime, run.providerBinding)).filter(line => line.length > 0)
    if (budget.addAll(summary) > 0) return tooLarge('the run binding summary', taskPageHint(task.taskId))
  }

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
  const footerReserve =
    utf8Bytes('- more: yes — continue with offset 999999') + 1 +
    utf8Bytes('- source: ') + 200 + 1 +
    obligations.reduce((total, line) => total + utf8Bytes(line) + 1, 0)
  let shown = 0
  for (const entry of page) {
    if (budget.remaining <= footerReserve) break
    if (!budget.add(taskSummaryLine(snapshot, entry.task, entry.roles))) break
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
  if (omittedObligations > 0) budget.add(omittedLine('obligation lines', omittedObligations, 'the status page reached its output bound'))

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
 * the output bound; a session read pages by DSH event seq, its own read unit.
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
    if (typeof query.ref !== 'string') return malformedRef(kind, query.ref)
    return await sessionRead(deps, loaded, query.ref, query.offset, query.limit, signal)
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
  ref: string | ReviewReference,
): LocatedRecord | { readonly refusal: NamedRefusal; readonly detail: string } {
  if (kind === 'review') {
    if (typeof ref === 'string' || ref === null || typeof ref !== 'object') return { refusal: 'not-found', detail: reviewRefDetail(ref) }
    const task = snapshot.tasks.find(item => item.taskId === ref.taskId)
    if (task === undefined) {
      return {
        refusal: 'not-found',
        detail: `task "${ref.taskId}" is not in your graph's task store, so the review reference does not resolve inside the caller's domain.`,
      }
    }
    const runId = ref.runId ?? null
    const review = [...snapshot.reviews].reverse().find(item => item.taskId === ref.taskId && (item.runId ?? null) === runId)
    if (review !== undefined) return { identity: `${ref.taskId}#${runId ?? 'no-run'}`, record: review }
    const others = snapshot.reviews.filter(item => item.taskId === ref.taskId)
    if (others.length === 0) {
      return { refusal: 'not-found', detail: `task "${ref.taskId}" has no review record in this store, so the reference names nothing.` }
    }
    return {
      refusal: 'stale-reference',
      detail:
        `task "${ref.taskId}" has review records, but none for run "${runId ?? '(none)'}": this store holds ` +
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
  if ('capabilitySnapshot' in record) return await runRecordText(deps.taskRuntime, record)
  if ('evidenceId' in record) return evidenceRecordText(snapshot, record)
  if ('diagnosisId' in record) return diagnosisRecordText(record)
  return reviewRecordText(record as ReviewRecord)
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
  let member: boolean
  try {
    member = await isGraphMember(deps.graphs, resolution.graph.id, sessionId)
  } catch (error) {
    // A membership that cannot be read is a named failure, never a pass: a
    // session reference whose ownership is unknown is not this graph's session.
    return refused(
      'unreadable',
      `the membership of session "${sessionId}" in graph "${resolution.graph.id}" could not be read: ${message(error)}. ` +
        'A session reference is checked against the graph\'s published members before its log is read.',
    )
  }
  if (!member) {
    return refused(
      'cross-graph',
      `session "${sessionId}" is not a published member of graph "${resolution.graph.id}"; a session reference reads the ` +
        'caller\'s own domain, and a session id is not a key to another graph.',
    )
  }
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
  const reserve = sessionClosingReserve(limit, capturedThroughSeq)
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
  if (stopped !== undefined) budget.add(notShownEventLine(stopped))
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

/** A byte count is written in at most sixteen digits (`Number.MAX_SAFE_INTEGER`), the widest any text size can be. */
const EVENT_SIZE_DIGITS = 16

/** The widest rendering of one number of `value`'s magnitude, so a reserve can bound a line that carries it. */
function widestNumber(value: number): string {
  return '9'.repeat(String(Math.max(0, Math.trunc(value))).length)
}

/**
 * The bytes a session page must keep for its closing lines — the `events shown`
 * footer, and the line naming the event the page stopped before when there is
 * one. Every number those lines can carry is bounded here by the range the page
 * itself knows (the caller's limit, the log's last seq, and the widest text
 * size), so the reserve is an upper bound whatever events follow: a page the
 * model receives always ends with its continuation cue.
 */
function sessionClosingReserve(limit: number, capturedThroughSeq: number): number {
  const seq = widestNumber(Number(capturedThroughSeq) + 1)
  const count = widestNumber(limit)
  const footer = `- events shown: ${count} of at most ${count} · more follows from seq ${seq}`
  const stopped =
    `- the next event (seq ${seq}, ${widestNumber(Number.MAX_SAFE_INTEGER)} UTF-8 bytes of text) was not shown on this ` +
    `page: it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it.`
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
 * The refusal of an event no page can carry: a session offset addresses whole
 * events (DSH's read unit), so an event larger than the bound has no second
 * page. The detail names the event and its size, says none of it is shown, and
 * hands the caller the one deliberate way past it.
 */
function oversizedEventDetail(sessionId: string, event: SessionEvent): string {
  return (
    `event seq ${event.seq} of session "${sessionId}" does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page (its text alone is ` +
    `${eventTextBytes(event)} UTF-8 bytes); a session offset addresses whole events — DSH's read unit — so this read cannot page ` +
    `inside one event, and none of that event's text is shown here. To continue past it, ask again with offset ` +
    `${Number(event.seq) + 1}: the read never skips an event on its own, so that choice is the caller's.`
  )
}

/** The line a page carries when it stops before an event that does not fit; the caller must choose to move past it. */
function notShownEventLine(event: SessionEvent): string {
  return (
    `- the next event (seq ${event.seq}, ${eventTextBytes(event)} UTF-8 bytes of text) was not shown on this page: ` +
    `it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it.`
  )
}

function eventLines(event: SessionEvent): string[] {
  const text = extractSessionEventText(event)
  const head = `- seq ${event.seq} | ${event.type} | ${new Date(event.time).toISOString()}`
  return text.length === 0 ? [head] : [head, ...text.split('\n').map(line => `  ${line}`)]
}

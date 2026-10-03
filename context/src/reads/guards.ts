/** The helpers every read shares: page limits, refusal texts, the projection preamble, the not-activated view. @module @dangosys/dsh-singularity-context/reads-guards */

import type {
  TaskInstance,
  TaskProposalRoot,
  TaskProposalStatus,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { StoreRecoveryStatus } from '@dangosys/dsh-singularity-task-runtime'
import { isGraphMember, type CallerGraph, type CallerResolution, type LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES } from '../limits.ts'
import { message, refused, type ProjectedRead } from '../refusals.ts'
import type { ReadDeps } from '../types.ts'

/** The status page's default entry count, and the range a caller's limit is clamped into. */
export const STATUS_LIMIT_DEFAULT = 20
export const STATUS_LIMIT_MAX = 100
/** The session page's default event count, and its ceiling (the same range as a status page). */
export const SESSION_LIMIT_DEFAULT = 20
export const SESSION_LIMIT_MAX = 100
/** The floor of one session-event page, in UTF-8 bytes: a page always carries one character. */
export const SESSION_EVENT_PAGE_MIN_BYTES = 4
/** A task-class page never goes below this many bytes; below it a page could not advance usefully. */
export const TASK_PAGE_MIN_BYTES = 64

/** The source line every result carries, naming what was read and how much one observation covers. */
export function storeSource(graph: { readonly id: string }, storeId: string, what: string): string {
  return `${what} — store ${storeId} of graph ${graph.id}, one Task snapshot read`
}

/** The recovery marker a result shows, or `undefined` while the store is simply ready. */
export function recoveryMarker(recovery: StoreRecoveryStatus): string | undefined {
  if (recovery.status === 'ready') return undefined
  const reason = 'reason' in recovery ? ` — ${recovery.reason}` : ''
  return `recovery: ${recovery.status}${reason}`
}

/** The sentence every result that shows a marker carries, so a marker is never read as a trigger. */
export const RECOVERY_NOTE = 'a recovery marker is an observation: this read neither triggers nor waits for recovery'

/** The refusal of an unbound caller, named by the resolution that produced it. */
export function unboundRead(resolution: Extract<CallerResolution, { kind: 'unbound' }>): ProjectedRead {
  return refused(resolution.refusal, resolution.detail)
}

/** The refusal of a read the output bound cannot lay out whole; a core contract is never cut to fit. */
export function tooLarge(what: string, where: string): ProjectedRead {
  return refused(
    'context-too-large',
    `${what} does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a core contract is never cut to fit; ` +
      `nothing is reported in place of it. ${where}`,
  )
}

/** The one action that reaches a task-class record in pages. */
export function taskPageHint(taskId: string): string {
  return `Read the record in pages with \`context_read\` kind:"task" ref:"${taskId}" (offset in UTF-8 bytes, limit up to ${CONTEXT_OUTPUT_LIMIT_BYTES}).`
}

/** Ascending comparison of the two strings a store sorts by (ids, timestamps). */
export function byString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The common refusals of the projection preamble, per read, in the read's own words. */
interface ProjectionTargetSpec {
  /** The clause a published member without a run is refused with; omitted means a member may read. */
  readonly member?: string
  /** The clause a delegation naming a task this store does not hold is refused with; omitted means it passes. */
  readonly delegation?: string
}

/** A resolved caller plus the task, run and snapshot its read runs against. */
type ProjectionTarget =
  | {
      readonly kind: 'bound'
      readonly resolution: Exclude<CallerResolution, { kind: 'unbound' }>
      readonly task?: TaskInstance
      readonly run?: TaskRun
      readonly snapshot?: TaskSnapshot
    }
  | { readonly kind: 'refused'; readonly read: ProjectedRead }

/** The reads' shared preamble, with the per-read differences in {@link ProjectionTargetSpec}. */
export function resolveProjectionTarget(loaded: LoadedCaller, spec: ProjectionTargetSpec): ProjectionTarget {
  const resolution = loaded.resolution
  if (resolution.kind === 'unbound') return { kind: 'refused', read: unboundRead(resolution) }
  if (resolution.kind === 'member' && spec.member !== undefined) {
    return {
      kind: 'refused',
      read: refused(
        'unbound',
        `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own ` +
          `and no recorded delegation, so ${spec.member}`,
      ),
    }
  }
  if (resolution.kind === 'root' && resolution.task === undefined) {
    return {
      kind: 'refused',
      read: refused(
        'not-activated',
        notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join('\n'),
      ),
    }
  }
  if (resolution.kind === 'reviewer' && resolution.task === undefined && spec.delegation !== undefined) {
    return {
      kind: 'refused',
      read: refused(
        'not-found',
        `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store ` +
          `"${resolution.storeId}" does not hold; ${spec.delegation}`,
      ),
    }
  }
  const task = 'task' in resolution ? resolution.task : undefined
  const run = resolution.kind === 'worker' || resolution.kind === 'root' ? resolution.run : undefined
  return {
    kind: 'bound',
    resolution,
    ...(task === undefined ? {} : { task }),
    ...(run === undefined ? {} : { run }),
    ...(loaded.snapshot === undefined ? {} : { snapshot: loaded.snapshot }),
  }
}

/** Task ownership bounds worker/reviewer reads; dependencies and ancestor context remain reachable. */
export function readableTaskIds(loaded: LoadedCaller): ReadonlySet<string> | undefined {
  const { resolution, snapshot } = loaded
  if (resolution.kind !== 'worker' && resolution.kind !== 'reviewer') return undefined
  const own = resolution.task
  if (own === undefined || snapshot === undefined) return new Set()
  const branch = new Set<string>()
  const pending = [own.taskId]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (branch.has(id)) continue
    branch.add(id)
    pending.push(...snapshot.tasks.filter(task => task.parentTaskId === id).map(task => task.taskId))
  }
  const visible = new Set(branch)
  for (const edge of snapshot.edges) {
    if (branch.has(edge.to)) visible.add(edge.from)
    if (branch.has(edge.from)) visible.add(edge.to)
  }
  let parent = own.parentTaskId
  const ancestors = new Set<string>()
  while (parent !== undefined && !ancestors.has(parent)) {
    ancestors.add(parent)
    visible.add(parent)
    parent = snapshot.tasks.find(task => task.taskId === parent)?.parentTaskId
  }
  return visible
}

/** The membership gate both session reads pass before DSH is asked anything. */
export async function sessionMembershipRefusal(
  deps: ReadDeps,
  loaded: LoadedCaller,
  sessionId: string,
): Promise<ProjectedRead | undefined> {
  const resolution = loaded.resolution as Exclude<CallerResolution, { kind: 'unbound' }>
  let member: boolean
  try {
    member = await isGraphMember(deps.graphs, resolution.graph.id, sessionId)
  } catch (error) {
    return refused(
      'unreadable',
      `the membership of session "${sessionId}" in graph "${resolution.graph.id}" could not be read: ${message(error)}. ` +
        "A session reference is checked against the graph's published members before its log is read.",
    )
  }
  if (member) {
    const allowed = readableTaskIds(loaded)
    if (allowed !== undefined && sessionId !== resolution.sessionId &&
        !loaded.snapshot?.runs.some(run => run.sessionId === sessionId && allowed.has(run.taskId))) {
      return refused('not-found', `session "${sessionId}" is outside the caller's task branch and dependency context; nothing was read`)
    }
    return undefined
  }
  return refused(
    'cross-graph',
    `session "${sessionId}" is not a published member of graph "${resolution.graph.id}"; a session reference reads the ` +
      "caller's own domain, and a session id is not a key to another graph.",
  )
}

/** What an open root proposal means; none of the three is terminal, and two still await activation. */
const OPEN_ROOT_PROPOSAL_MEANING = new Map<TaskProposalStatus, string>([
  ['pending_review', 'waiting for a review decision; the contract is not a task yet'],
  ['ready', 'recorded and past its re-check, waiting for the runtime to activate it'],
  ['approved', "approved on the record, waiting for the runtime's post-approval re-check and activation"],
])

/** Every root proposal still going to move: one waiting for a decision, or one waiting to be activated. */
function openRootProposals(snapshot: TaskSnapshot | undefined): TaskProposalRoot[] {
  return (snapshot?.proposals?.all ?? []).filter(
    (proposal): proposal is TaskProposalRoot =>
      proposal.kind === 'root' && OPEN_ROOT_PROPOSAL_MEANING.has(proposal.status),
  )
}

/** How a store with no root task stands, in the store's own terms. */
function storeStateText(snapshot: TaskSnapshot | undefined): string {
  return snapshot === undefined
    ? 'does not exist yet — a graph opens it when it is created and fills it when a contract is accepted, and neither state is a failure'
    : 'opened, with no root task in it'
}

/** The not-activated view: the state named, whatever proposal is open, and the one action that changes it. */
export function notActivatedLines(graph: CallerGraph, storeId: string, snapshot: TaskSnapshot | undefined): string[] {
  const open = openRootProposals(snapshot)
  return [
    `graph ${graph.id} root session "${graph.rootSessionId}": not activated — no root contract has been accepted for this session, so there is no root task.`,
    `- store ${storeId}: ${storeStateText(snapshot)}`,
    ...(open.length === 0
      ? ['- open proposals: none — no root contract is waiting for a decision or for its activation.']
      : [
          '- open proposals:',
          ...open.map(
            proposal =>
              `  - ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy} — ${OPEN_ROOT_PROPOSAL_MEANING.get(proposal.status)}`,
          ),
        ]),
    "- accept the user's objective here with `task_intake`: it writes the normalized root contract (objective, acceptance criteria,",
    "  assumptions, constraints and declared capabilities) and activates it as this graph's root task — or, where the deployment",
    '  reviews root contracts, it answers with a proposal id and activates nothing until a recorded decision.',
    '- `task_decompose` cannot run before that: it works on the root task, which does not exist until a contract is accepted.',
    "- no objective is reported here: this graph's name and its setup work are not a goal, and no contract has named one yet.",
  ]
}

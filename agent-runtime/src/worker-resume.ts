/**
 * The narrow recovery entry for a spawned worker's Session (A4 §F.1).
 *
 * §F.1 fixes one thing the old recovery branch got wrong: a worker whose Run is
 * still in flight — known question waiting, waiting_children parent, a delegated
 * parent whose execution was handed back (active again with the batches it ended
 * on the run's record), an interrupted turn — is not an abandoned Run to cancel.
 * It must come back as **the same Session and the same Run**, so this module
 * exists to make exactly that possible and nothing wider:
 *
 * - **The Session is resumed, never recreated.** The identity is persisted, the
 *   log is the artifact, and `ctx.agents.resume` is the only door taken; a
 *   missing Session, a Session another owner holds, or a Session whose durable
 *   record contradicts the Run the caller claims is a named refusal with no
 *   session, node, message or handle behind it.
 * - **The composition is the spawn's, reused verbatim.** The caller hands in
 *   `setup` — the same function `AgentRuntime.spawn` hands the agent factory
 *   (mounted preset, the run's permission posture, the stable worker policy
 *   section, the capability grant, the raw-session seal) — so there is one
 *   worker composition in this package, not a second one for recovery
 *   (`index.ts: workerSetup`). What is *not* reused is the spawn's kickoff: the
 *   durable log already holds this worker's first message, and a resume that
 *   re-sent it would ask the same task twice.
 * - **The resume sends no message and wakes nothing.** DSH's resume publishes a
 *   live agent and restores the inbox from the log, and its driver stays idle
 *   until something is addressed to it. That is the wake contract of this entry:
 *   it produces no model input at all, and the caller decides when the Session
 *   is woken — the A4 recovery path wakes it by delivering the question or
 *   answer it owed (`agent-runtime/messages.ts`, one `steer` per identity).
 *   "Resumed" therefore means "reachable", never "already working".
 *
 * What the caller must state, and why each stated fact is checked rather than
 * trusted: the Run (`TaskRun`'s own fields), the grant it resolved, and the
 * permission preset it admitted the Run under. The Session's own durable record
 * — its header and its own event suffix, read through the deployment's session
 * query — is the authority: the preset is the header's, the lineage is the
 * header's `parentSession` against the graph's own `spawn` edge, and a
 * `permission/preset` the log recorded is the permission the Session actually
 * ran under. A claim that disagrees with any of them is refused by name before
 * anything is written, because resuming under a claim the Session contradicts
 * would silently change the tool face or the permission posture of a worker
 * that is still working on somebody's task.
 *
 * The one write this entry makes before the resume is the graph node's own
 * status: a process that died leaves it `running`, the agent comes back idle,
 * and the node is corrected the same way `resumeRoot` corrects a root's. It is
 * presentation state, not a source fact, and it happens after every check — so
 * a refusal never reaches it.
 * @module @dangosys/dsh-singularity-agent-runtime/worker-resume
 */

import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
// The `permission/preset` event type is declared into the session's event map by
// the permission-presets package; the type-only import is what makes this
// module's read of that event the same type the deployment's own service writes.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { AgentStatus } from '@dangosys/dsh-singularity-graph'
import type { WorkerGrant, WorkerResumeRequest } from './types.ts'

/**
 * The permission posture a worker runs under when nobody decided one for it —
 * the spawn's own default (`index.ts`, the shared worker setup), named here
 * because the resume must state the same posture it is checking against.
 */
export const WORKER_DEFAULT_PERMISSION_PRESET = 'danger-full-access'

/**
 * The composition one worker's scoped world is built from. Internal seam: the
 * runtime computes it (from a spawn request, or from a resume's checked facts)
 * and hands the same function to the agent factory either way, which is what
 * makes a resumed worker's preset, prompt, tool face, permission and seal the
 * ones its spawn had.
 */
export interface WorkerRole {
  /** The agent preset mounted for this worker. */
  readonly agentPreset: string
  /** The permission preset applied to this worker's session. */
  readonly permissionPreset: string
  /** Declare this worker a task worker: its stable policy section is installed. */
  readonly taskWorker: boolean
  /** The resolved capability grant, when the run was admitted with one. */
  readonly grant?: WorkerGrant
}

/**
 * Why one resume refused, named for the caller's next move. Everything except
 * `takeover-refused` is a source check decided by reading: a refusal leaves the
 * store, the Session log, the graph and the handle map exactly as they were.
 * `takeover-refused` is DSH's own refusal to take the Session over (crash
 * repair or replay validation, and the write lease under `ownership-conflict`),
 * which this module reports and never works around by creating another Session.
 */
export type WorkerResumeRefusalCode =
  /** No such persisted Session. */
  | 'session-missing'
  /** The Session exists but its log could not be read, so it cannot be taken over safely. */
  | 'session-unreadable'
  /**
   * A live agent — this runtime's handle or another owner's registration —
   * already owns the Session. Retryable once that owner settles; never resolved
   * by resuming under a second owner.
   */
  | 'ownership-conflict'
  /** The declared Run, grant or permission contradicts the Session's own durable record. */
  | 'binding-mismatch'
  /** The graph store does not publish this Session as a member. */
  | 'not-in-graph'
  /** The Session is a member, but the delegation facts a worker resume needs are absent. */
  | 'member-facts-missing'
  /** The resume itself refused the Session (interrupted-turn repair, replay validation, write lease). */
  | 'takeover-refused'

/** One refused resume, with the stable name of what could not be established. */
export class WorkerResumeRefusal extends Error {
  readonly code: WorkerResumeRefusalCode

  constructor(code: WorkerResumeRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkerResumeRefusal'
    this.code = code
  }
}

/**
 * What one resume reads and what it resumes through, narrowed to the four
 * capabilities it actually uses. No service resolves another one through this
 * module, and a caller can replace any of them for a test.
 */
export interface WorkerResumeDeps {
  /** Live agents by Session id — the ownership check, and the resume door. */
  readonly agents: {
    get(id: SessionId): Agent | undefined
    resume(options: {
      resumeSessionId: SessionId
      agentOptions?: AgentOptions
      setup?: AgentSetup
    }): Promise<AgentHandle>
  }
  /**
   * The persisted Session's own record: the header (preset, lineage) and the
   * log's own events (the permission the Session actually ran under). The
   * deployment's read path is used, not a second reader over the artifact.
   */
  readonly sessionQuery: {
    readSession(sessionId: SessionId): Promise<SessionLogSnapshot>
  }
  /** The graph store: membership, the delegation edge, and the node status a resume repairs. */
  readonly graph: {
    snapshotIn(storeId: string): Promise<{
      readonly roots: readonly SessionId[]
      readonly agents: readonly { readonly id: SessionId; readonly status: AgentStatus }[]
      readonly edges: readonly { readonly kind: string; readonly from: SessionId; readonly to: SessionId }[]
    }>
    setStatusIn(storeId: string, sessionId: SessionId, status: AgentStatus): Promise<void>
  }
  /** Compose one worker's scoped world — the caller's own spawn composition, reused verbatim. */
  readonly setup: (role: WorkerRole) => AgentSetup
  /** The per-agent options the resumed agent runs under (the runtime's default selection plus the request's own). */
  readonly agentOptions?: AgentOptions
}

/** The one marker `TaskRun.capabilitySnapshot` uses for a granted MCP server's plane (`task-runtime/src/capability.ts`). */
const MCP_PLANE_MARKER = 'mcp:'

/**
 * Bring one spawned worker's persisted Session back live, or refuse by name.
 *
 * Order: ownership, then the Session's own durable record, then the declared
 * Run facts against it, then the graph's membership and delegation facts, then
 * the resume. Every check before `deps.agents.resume` is a read: a refusal
 * leaves the store, the Session log, the graph and the handle map exactly as
 * they were, and no Session is ever created to stand in for the one that could
 * not be taken over.
 * @param deps - the live registry, the session read path, the graph store and the composition.
 * @param request - the identity, its graph scope, the Run facts and the authorization claimed.
 * @returns the live handle of the same Session, idle and reachable, owning no new identity.
 * @throws WorkerResumeRefusal with the stable code of what could not be established.
 * @throws Error (unnamed) when the graph store cannot take the node's status
 *   repair: nothing was resumed, and that write is not a source decision a
 *   refusal code could name.
 */
export async function resumeWorkerAgent(deps: WorkerResumeDeps, request: WorkerResumeRequest): Promise<AgentHandle> {
  const sessionId = toSessionId(request.sessionId)
  // A live agent is the durable write owner's in-process shadow: resuming under
  // a second owner would give one Session two drivers. Named and retryable —
  // the owner may be on its way out — and never resolved by force.
  if (deps.agents.get(sessionId) !== undefined) {
    throw new WorkerResumeRefusal(
      'ownership-conflict',
      `agent-runtime: session "${String(sessionId)}" is already live; a resume must wait until its owner settles`,
    )
  }
  const persisted = await readPersistedSession(deps, sessionId)
  const header = persisted.session
  const own = persisted.events.slice(persisted.inheritedEventCount)
  const agentPreset = assertRunBinding(request, header, own)
  const member = await assertGraphMember(deps, request, header, sessionId)
  const role = workerRole(request, agentPreset)
  // The node's own status is presentation, not a fact either side of the
  // recovery owns: the process that died left it where it was, and the resumed
  // agent is idle until the caller wakes it. Repaired before the resume, like
  // `resumeRoot` repairs a root's — and on this side of the checks, so a refusal
  // above never reaches a write at all.
  if (member.status === 'running') await deps.graph.setStatusIn(request.scope.graphStoreId, sessionId, 'idle')
  return await resume(deps, request, sessionId, role)
}

/** One Session's persisted header and events, read through the deployment's own query path. */
async function readPersistedSession(deps: WorkerResumeDeps, sessionId: SessionId): Promise<SessionLogSnapshot> {
  try {
    return await deps.sessionQuery.readSession(sessionId)
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new WorkerResumeRefusal(
        'session-missing',
        `agent-runtime: session "${String(sessionId)}" does not exist; a worker recovery resumes a Session, it never creates one`,
        { cause: error },
      )
    }
    throw new WorkerResumeRefusal(
      'session-unreadable',
      `agent-runtime: session "${String(sessionId)}" could not be read, so it cannot be taken over safely: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/**
 * Refuse a declared Run, grant or permission the Session's own durable record
 * contradicts (A4 §F.1: "声明的 Run/绑定与 Session 持久事实不一致").
 *
 * What is checkable and why each one matters:
 * - the Run's `sessionId` — the store's binding is to one Session, and a resume
 *   under a Run that names another one would put a run's work on the wrong log;
 * - the Run's `agentPreset` against the header's — the header is what the
 *   resumed composition is built from, so a store that recorded a different
 *   preset means the two records disagree about what this Session is;
 * - the declared grant against the Run's recorded capability snapshot — the
 *   tool face is authorization, and the snapshot is the store's record of what
 *   the Run was admitted with;
 * - a `permission/preset` the log recorded against the declared permission —
 *   the log is the permission the Session actually ran under, and re-applying a
 *   different one would silently widen or narrow a session mid-task.
 * @returns the agent preset the Session's own header names — verified present,
 *   and the one the resumed composition is built from.
 */
function assertRunBinding(request: WorkerResumeRequest, header: SessionHeader, own: readonly SessionEvent[]): string {
  const run = request.run
  if (run.storeId === '' || run.taskId === '' || run.runId === '') {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: the declared run identity is empty (store "${run.storeId}", task "${run.taskId}", run "${run.runId}")`,
    )
  }
  if (String(run.sessionId) !== String(header.id)) {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: run "${run.runId}" binds session "${String(run.sessionId)}", not the session "${String(header.id)}" being resumed`,
    )
  }
  if (header.agentPreset === undefined) {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: session "${String(header.id)}" names no agent preset, so the composition run "${run.runId}" was spawned in cannot be rebuilt`,
    )
  }
  if (run.agentPreset !== undefined && run.agentPreset !== header.agentPreset) {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: run "${run.runId}" recorded agent preset "${run.agentPreset}" but session "${String(header.id)}" ran under "${header.agentPreset}"`,
    )
  }
  const recorded = [...new Set(run.capabilitySnapshot)].sort()
  const declared = declaredPlane(request.grant)
  if (recorded.join('\n') !== declared.join('\n')) {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: run "${run.runId}" was admitted with capability plane [${recorded.join(', ')}] but the resume declares [${declared.join(', ')}]`,
    )
  }
  const applied = request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET
  const recordedPermission = lastPermissionPreset(own)
  if (recordedPermission !== undefined && recordedPermission !== applied) {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: session "${String(header.id)}" recorded permission preset "${recordedPermission}" but the resume would apply "${applied}"`,
    )
  }
  return header.agentPreset
}

/**
 * Refuse a Session the graph does not publish, or one whose delegation facts a
 * worker resume needs and cannot find (A4 §F.1: a resume must not invent the
 * member or its edge). Membership alone is not enough: the worker's lineage is
 * the parent the spawn published, and the Session's own header must agree with
 * the graph's edge — the two durable records are checked against each other.
 */
async function assertGraphMember(
  deps: WorkerResumeDeps,
  request: WorkerResumeRequest,
  header: SessionHeader,
  sessionId: SessionId,
): Promise<{ readonly status: AgentStatus }> {
  let snapshot: Awaited<ReturnType<WorkerResumeDeps['graph']['snapshotIn']>>
  try {
    snapshot = await deps.graph.snapshotIn(request.scope.graphStoreId)
  } catch (error: unknown) {
    throw new WorkerResumeRefusal(
      'member-facts-missing',
      `agent-runtime: graph store "${request.scope.graphStoreId}" could not be read, so session "${String(sessionId)}" cannot be shown to be a member: ${messageOf(error)}`,
      { cause: error },
    )
  }
  const node = snapshot.agents.find(agent => String(agent.id) === String(sessionId))
  if (node === undefined) {
    throw new WorkerResumeRefusal(
      'not-in-graph',
      `agent-runtime: session "${String(sessionId)}" is not published by graph store "${request.scope.graphStoreId}"; a worker recovery resumes a member, it never adds one`,
    )
  }
  const delegation = snapshot.edges.find(edge => edge.kind === 'spawn' && String(edge.to) === String(sessionId))
  if (delegation === undefined) {
    const root = snapshot.roots.some(candidate => String(candidate) === String(sessionId))
    throw new WorkerResumeRefusal(
      'member-facts-missing',
      root
        ? `agent-runtime: session "${String(sessionId)}" is a root of graph store "${request.scope.graphStoreId}"; a root's recovery entry is ensureRoot, not a worker resume`
        : `agent-runtime: graph store "${request.scope.graphStoreId}" records no spawn edge into session "${String(sessionId)}", so its delegation cannot be verified`,
    )
  }
  if (header.parentSession === undefined) {
    throw new WorkerResumeRefusal(
      'member-facts-missing',
      `agent-runtime: session "${String(sessionId)}" records no parent session, but graph store "${request.scope.graphStoreId}" holds a spawn edge from "${String(delegation.from)}"`,
    )
  }
  if (String(header.parentSession) !== String(delegation.from)) {
    throw new WorkerResumeRefusal(
      'binding-mismatch',
      `agent-runtime: session "${String(sessionId)}" records parent "${String(header.parentSession)}" but graph store "${request.scope.graphStoreId}" holds its spawn edge from "${String(delegation.from)}"`,
    )
  }
  return { status: node.status }
}

/** The composition a resume rebuilds: the request states it, the binding check verified the preset. */
function workerRole(request: WorkerResumeRequest, agentPreset: string): WorkerRole {
  return {
    agentPreset,
    permissionPreset: request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET,
    taskWorker: request.taskWorker,
    ...(request.grant === undefined ? {} : { grant: request.grant }),
  }
}

/** Take the Session over through DSH's own resume, naming every refusal it raises. */
async function resume(
  deps: WorkerResumeDeps,
  request: WorkerResumeRequest,
  sessionId: SessionId,
  role: WorkerRole,
): Promise<AgentHandle> {
  try {
    return await deps.agents.resume({
      resumeSessionId: sessionId,
      ...(deps.agentOptions === undefined ? {} : { agentOptions: deps.agentOptions }),
      setup: deps.setup(role),
    })
  } catch (error: unknown) {
    if (error instanceof SessionAlreadyOwnedError) {
      throw new WorkerResumeRefusal(
        'ownership-conflict',
        `agent-runtime: session "${String(sessionId)}" is already owned by a write handle; retry the resume once that owner settles`,
        { cause: error },
      )
    }
    throw new WorkerResumeRefusal(
      'takeover-refused',
      `agent-runtime: session "${String(sessionId)}" could not be taken over safely: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/** The granted plane one grant declares: every capability's tools and skills, plus each MCP server's plane marker. */
function declaredPlane(grant: WorkerGrant | undefined): string[] {
  const plane = new Set<string>()
  for (const capability of grant?.capabilities ?? []) {
    for (const tool of capability.tools) plane.add(tool)
    for (const skill of capability.skills) plane.add(skill)
  }
  for (const server of grant?.mcpServers ?? []) plane.add(`${MCP_PLANE_MARKER}${server.serverName}`)
  return [...plane].sort()
}

/** The permission preset the Session's own log last recorded, or `undefined` when it recorded none. */
function lastPermissionPreset(own: readonly SessionEvent[]): string | undefined {
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const event = own[index] as SessionEvent
    if (event.type === 'permission/preset') return event.data.preset
  }
  return undefined
}

/** One line of an unknown failure, for refusals that carry a cause. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

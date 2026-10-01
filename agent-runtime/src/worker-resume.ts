/** The narrow recovery entry for a spawned worker's Session (A4 §F.1): same Session, composition, grant, idle.
 * @module @dangosys/dsh-singularity-agent-runtime/worker-resume */

import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
// The `permission/preset` event type is declared into the session's event map by the permission-presets package.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { AgentStatus } from '@dangosys/dsh-singularity-graph'
import { messageOf, ownSuffix } from './messages.ts'
import type { WorkerGrant, WorkerResumeRequest } from './types.ts'

/** The permission posture a worker runs under when nobody decided one for it — the spawn's own default. */
export const WORKER_DEFAULT_PERMISSION_PRESET = 'danger-full-access'

/** The composition one worker's scoped world is built from, computed by the runtime and reused verbatim. */
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

/** Why one resume refused, named for the caller's next move; a refusal leaves every store as it was. */
export type WorkerResumeRefusalCode =
  /** No such persisted Session. */
  | 'session-missing'
  /** The Session exists but its log could not be read, so it cannot be taken over safely. */
  | 'session-unreadable'
  /** A live agent already owns the Session; retryable once that owner settles. */
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

/** What one resume reads and what it resumes through, narrowed to the capabilities it actually uses. */
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
  /** The persisted Session's own record: the header (preset, lineage) and the log's own events. */
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

/** Bring the persisted Session back live and idle, or refuse by name; every check before the resume is a read. */
export async function resumeWorkerAgent(deps: WorkerResumeDeps, request: WorkerResumeRequest): Promise<AgentHandle> {
  const sessionId = toSessionId(request.sessionId)
  if (deps.agents.get(sessionId) !== undefined) {
    throw new WorkerResumeRefusal(
      'ownership-conflict',
      `agent-runtime: session "${String(sessionId)}" is already live; a resume must wait until its owner settles`,
    )
  }
  const persisted = await readPersistedSession(deps, sessionId)
  const header = persisted.session
  const own = ownSuffix(persisted)
  const agentPreset = assertRunBinding(request, header, own)
  const member = await assertGraphMember(deps, request, header, sessionId)
  const role = workerRole(request, agentPreset)
  // The node's status is presentation, repaired after every check, so a refusal never reaches a write.
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

/** Refuse a declared Run, grant or permission the Session's own durable record contradicts. */
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

/** Refuse a Session the graph does not publish, or one whose delegation facts cannot be verified. */
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

/** The granted plane one grant declares: every capability's tools and skills, plus each MCP server's marker. */
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

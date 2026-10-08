/**
 * The one way a coordination session comes back after a restart: the same
 * session id, the same composition, the same role — because a resume that
 * rebuilt a different world would answer a question the session was never asked.
 *
 * @module @dangosys/dsh-singularity-agent-runtime/coordination-resume
 */

import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import { messageOf } from './messages.ts'
import type { CoordinatorResumeRequest, GraphScope, WorkerGrant } from './types.ts'
import { readPersistedSession } from './worker-resume.ts'

/** Why one coordination resume refused, named for the caller's next move. */
export type CoordinationResumeRefusalCode =
  /** No such persisted Session. */
  | 'session-missing'
  /** A live agent already owns the Session. */
  | 'session-live'
  /** The graph store does not publish this Session as a member. */
  | 'not-in-graph'
  /** The declared preset, role or grant contradicts the Session's own durable record. */
  | 'binding-mismatch'
  /** The resume itself refused the Session. */
  | 'takeover-refused'

/** One refused coordination resume, with the stable name of what could not be established. */
export class CoordinationResumeRefusal extends Error {
  readonly code: CoordinationResumeRefusalCode

  constructor(code: CoordinationResumeRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CoordinationResumeRefusal'
    this.code = code
  }
}

/** What one resume reads and resumes through. */
export interface CoordinationResumeDeps {
  readonly agents: {
    get(id: SessionId): Agent | undefined
    resume(options: { resumeSessionId: SessionId; agentOptions?: AgentOptions; setup?: AgentSetup }): Promise<AgentHandle>
  }
  readonly sessionQuery: { readSession(sessionId: SessionId): Promise<unknown> }
  readonly graph: {
    snapshotIn(storeId: string): Promise<{
      readonly agents: readonly { readonly id: SessionId }[]
      readonly edges: readonly { readonly kind: string; readonly from: SessionId; readonly to: SessionId }[]
    }>
  }
  /** Compose one coordination session's world — the caller's own spawn composition, reused verbatim. */
  readonly setup: (role: { agentPreset: string; permissionPreset: string; taskWorker: boolean; coordinationRole: 'reviewer' | 'supervisor'; grant?: WorkerGrant }) => AgentSetup
  readonly agentOptions?: AgentOptions
}

/** Bring one persisted coordination Session back live and idle under its own role, or refuse by name. */
export async function resumeCoordinationAgent(
  deps: CoordinationResumeDeps,
  request: CoordinatorResumeRequest,
): Promise<AgentHandle> {
  const sessionId = request.sessionId
  if (deps.agents.get(sessionId) !== undefined)
    throw new CoordinationResumeRefusal(
      'session-live',
      `agent-runtime: session "${String(sessionId)}" is already live; the coordination driver resumes a session nothing owns`,
    )
  const persisted = await readPersistedSession(deps as never, sessionId)
  const header = persisted.session as SessionHeader
  if (header.agentPreset !== undefined && header.agentPreset !== request.agentPreset)
    throw new CoordinationResumeRefusal(
      'binding-mismatch',
      `agent-runtime: session "${String(sessionId)}" ran under agent preset "${header.agentPreset}" but the resume declares "${request.agentPreset}"`,
    )
  const snapshot = await deps.graph.snapshotIn(request.scope.graphStoreId).catch(error => {
    throw new CoordinationResumeRefusal(
      'not-in-graph',
      `agent-runtime: graph store "${request.scope.graphStoreId}" could not be read: ${messageOf(error)}`,
      { cause: error },
    )
  })
  if (snapshot.agents.every(item => String(item.id) !== String(sessionId)))
    throw new CoordinationResumeRefusal(
      'not-in-graph',
      `agent-runtime: session "${String(sessionId)}" is not published by graph store "${request.scope.graphStoreId}"`,
    )
  const delegation = snapshot.edges.find(edge => edge.kind === 'spawn' && String(edge.to) === String(sessionId))
  if (delegation === undefined)
    throw new CoordinationResumeRefusal(
      'not-in-graph',
      `agent-runtime: graph store "${request.scope.graphStoreId}" records no spawn edge into session "${String(sessionId)}", so its delegation cannot be verified`,
    )
  try {
    return await deps.agents.resume({
      resumeSessionId: sessionId,
      ...(deps.agentOptions === undefined ? {} : { agentOptions: deps.agentOptions }),
      setup: deps.setup({
        agentPreset: request.agentPreset,
        permissionPreset: request.permissionPreset ?? 'workspace-isolated',
        taskWorker: false,
        coordinationRole: request.coordinationRole,
        ...(request.grant === undefined ? {} : { grant: request.grant }),
      }),
    })
  } catch (error) {
    if (error instanceof SessionAlreadyOwnedError)
      throw new CoordinationResumeRefusal(
        'session-live',
        `agent-runtime: session "${String(sessionId)}" is already owned by a write handle; retry once that owner settles`,
        { cause: error },
      )
    throw new CoordinationResumeRefusal(
      'takeover-refused',
      `agent-runtime: session "${String(sessionId)}" could not be taken over safely: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/** The scope one coordination session runs in, as its spawn recorded it. */
export type { GraphScope }

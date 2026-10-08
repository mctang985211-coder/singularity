/** Singularity agent runtime over the graph.
 * @module dsh-singularity-agent-runtime */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { DEFAULT_ROOT, type GraphEvent } from '@dangosys/dsh-singularity-graph'
import { installGraphSkillCatalog, applyWorkerGrant, type GraphSkillCatalogOptions } from './grants.ts'
import { sealMethodAuthority } from './method-authority.ts'
import { fileURLToPath } from 'node:url'
import { ensureAgentMessageDelivered, readToolCallBody, reconcileAgentMessageDeliveries } from './messages.ts'
import type {
  AgentMessageIntent,
  MessageDelivery,
  MessageDeliveryDeps,
  MessageDeliveryReport,
  ToolCallBody,
  ToolCallRef,
} from './messages.ts'
import { rootPromptText } from './prompts/root.prompts.ts'
import { REVIEWER_POLICY_TEXT, SUPERVISOR_POLICY_TEXT } from './prompts/coordination.prompts.ts'
import { WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT } from './prompts/worker.prompts.ts'
import { sealRawSessionReads } from './raw-session-guard.ts'
import { sealNativeDelegation } from './delegation-guard.ts'
import { COORDINATION_SEALED_ALLOW, guardCoordinationWrites, sealCoordinationSession } from './coordination-seal.ts'
import { resumeCoordinationAgent } from './coordination-resume.ts'
import type { GraphScope, RootRequest, RuntimePromptSource, SpawnRequest, WorkerResumeRequest, CoordinatorResumeRequest } from './types.ts'
import { WORKER_DEFAULT_PERMISSION_PRESET, resumeWorkerAgent as resumeWorker } from './worker-resume.ts'
import type { WorkerResumeDeps, WorkerRole } from './worker-resume.ts'

export type {
  AgentOptions,
  CoordinatorResumeRequest,
  GraphScope,
  McpServerSpec,
  RootRequest,
  RuntimePromptSource,
  SpawnRequest,
  WorkerCapabilityGrant,
  WorkerGrant,
  WorkerResumeRequest,
  WorkerRunFacts,
} from './types.ts'
export { applyWorkerGrant } from './grants.ts'
export type { ResolvedGrant } from './grants.ts'
export {
  COORDINATION_SEALED_ALLOW,
  COORDINATION_WRITE_DENIAL,
  guardCoordinationWrites,
  isCoordinationSealed,
  sealCoordinationSession,
} from './coordination-seal.ts'
export { CoordinationResumeRefusal, resumeCoordinationAgent } from './coordination-resume.ts'
export type { CoordinationResumeDeps, CoordinationResumeRefusalCode } from './coordination-resume.ts'
export { findSkillFileIn, parseSkillFile, skillRootsFor } from './skill-file.ts'
export {
  assertNoMethodAuthorityGrant,
  grantCarriesMethodAuthority,
  isMethodAuthorityTool,
  METHOD_AUTHORITY_DENIAL,
  METHOD_AUTHORITY_TOOLS,
  sealMethodAuthority,
} from './method-authority.ts'
export { WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT } from './prompts/worker.prompts.ts'
export { RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS } from './raw-session-guard.ts'
export { WorkerResumeRefusal } from './worker-resume.ts'
export type { WorkerResumeDeps, WorkerResumeRefusalCode, WorkerRole } from './worker-resume.ts'
export { answerMessageText, questionMessageText, toolCallRefIn } from './messages.ts'
export type {
  AgentMessageIntent,
  MessageDelivery,
  MessageDeliveryDeps,
  MessageDeliveryReport,
  MessageDeliveryStatus,
  MessageRefusalCode,
  SessionOwnLog,
  ToolCallBody,
  ToolCallRef,
} from './messages.ts'

/** Descriptor provider name for workers: this runtime establishes them, not a registered `ctx.subagents` provider. */
const WORKER_DESCRIPTOR_PROVIDER = 'singularity-runtime'

export class AgentRuntime extends Service {
  static inject = [
    'agentDefaultModel',
    'agentPresets',
    'agents',
    'graph',
    'layout',
    'permissionPresets',
    'sessions',
    'sessionPersistence',
    'sessionQuery',
  ]
  private readonly owned = new Set<SessionId>()
  private readonly roots = new Set<SessionId>()
  private readonly handles = new Map<SessionId, AgentHandle>()
  private readonly scopes = new Map<SessionId, GraphScope>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly stopping = new Set<string>()
  private closing = false
  private readonly resuming = new Map<SessionId, { scope: GraphScope; handle: Promise<AgentHandle> }>()

  constructor(ctx: Context) {
    super(ctx, 'agentRuntime')
    ctx.on('agent/status', ({ agent, status }) => {
      const scope = this.scopes.get(agent.id)
      if (scope !== undefined) void ctx.graph.setStatusIn(scope.graphStoreId, agent.id, status)
    })
    ctx.effect(
      () => async () => {
        this.closing = true
        await Promise.all(this.operations.values())
        await this.stopAgents([...this.handles.keys()])
        this.operations.clear()
        this.handles.clear()
        this.owned.clear()
        this.roots.clear()
        this.scopes.clear()
      },
      'agentRuntime: dispose',
    )
  }

  /** Recover a persisted root; `agentOptions` overrides the deployment default selection for its resumed turns. */
  async ensureRoot(sessionId: SessionId, scope: GraphScope, agentOptions?: AgentOptions): Promise<AgentHandle> {
    if (this.closing) throw new Error('agent-runtime: closing')
    const pending = this.resuming.get(sessionId)
    if (pending !== undefined) {
      if (pending.scope.graphStoreId !== scope.graphStoreId || pending.scope.layoutStoreId !== scope.layoutStoreId) {
        throw new Error('agent-runtime: concurrent root scope mismatch')
      }
      return pending.handle
    }
    const handle = this.inGraph(scope, () => this.resumeRoot(sessionId, scope, agentOptions)).finally(() =>
      this.resuming.delete(sessionId),
    )
    this.resuming.set(sessionId, { scope, handle })
    return handle
  }

  private async resumeRoot(sessionId: SessionId, scope: GraphScope, agentOptions?: AgentOptions): Promise<AgentHandle> {
    const existing = this.handles.get(sessionId)
    if (existing !== undefined) {
      const known = this.scope(sessionId)
      if (known.graphStoreId !== scope.graphStoreId || known.layoutStoreId !== scope.layoutStoreId) {
        throw new Error('agent-runtime: root scope changed while live')
      }
      return existing
    }
    const snapshot = await this.ctx.graph.snapshotIn(scope.graphStoreId)
    const persisted = snapshot.agents.find(agent => agent.id === sessionId)
    if (persisted === undefined) throw new Error(`agent-runtime: root "${sessionId}" is not in graph`)
    if (!snapshot.roots.includes(sessionId)) throw new Error(`agent-runtime: "${sessionId}" is not a root`)
    const headers = new Map((await this.ctx.sessionPersistence.list()).map(item => [item.header.id, item.header]))
    const agentPreset = headers.get(sessionId)?.agentPreset
    if (agentPreset === undefined) throw new Error(`agent-runtime: root session "${sessionId}" has no agent preset`)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      throw new Error(`agent-runtime: root "${sessionId}" is owned by another runtime`)
    }
    if (persisted.status === 'running') await this.ctx.graph.setStatusIn(scope.graphStoreId, sessionId, 'idle')
    this.owned.add(sessionId)
    this.roots.add(sessionId)
    this.scopes.set(sessionId, scope)
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions === undefined
          ? this.ctx.agentDefaultModel.currentSelection()
          : { ...this.ctx.agentDefaultModel.currentSelection(), ...agentOptions },
        setup: rootSetup(this.ctx, agentPreset),
      })
      this.handles.set(sessionId, handle)
      return handle
    } catch (error) {
      await this.releaseSession(sessionId)
      throw error
    }
  }

  async createRoot(request: RootRequest): Promise<AgentHandle> {
    return this.inGraph(request.scope, async () => {
      this.owned.add(request.sessionId)
      this.scopes.set(request.sessionId, request.scope)
      const agentPreset = request.agentPreset ?? this.ctx.agentPresets.defaultId
      let handle: AgentHandle
      try {
        handle = await this.ctx.agents.create({
          sessionId: request.sessionId,
          meta: { cwd: request.cwd, agentPreset },
          agentOptions: { ...this.ctx.agentDefaultModel.currentSelection(), ...request.agentOptions },
          setup: rootSetup(this.ctx, agentPreset),
        })
      } catch (error) {
        await this.releaseSession(request.sessionId)
        throw error
      }
      try {
        await this.ctx.layout.setIn(request.scope.layoutStoreId, handle.agent.id, DEFAULT_ROOT)
        await this.ctx.graph.addAgentIn(
          request.scope.graphStoreId,
          { id: handle.agent.id, name: 'Singularity', status: 'idle' },
          true,
        )
        this.roots.add(handle.agent.id)
        this.handles.set(handle.agent.id, handle)
        return handle
      } catch (error) {
        await this.releaseSession(handle.agent.id, handle)
        throw error
      }
    })
  }

  async spawn(parent: Agent, request: SpawnRequest): Promise<AgentHandle> {
    if (this.closing) throw new Error('agent-runtime: closing')
    if (request.prompt === undefined && request.taskWorker !== true) {
      throw new Error('agent-runtime: a spawn request needs a prompt (a taskWorker spawn gets the default kickoff)')
    }
    this.live(parent)
    const scope = this.scope(parent.id)
    return this.inGraph(scope, async () => {
      this.live(parent)
      this.owned.add(request.sessionId)
      this.scopes.set(request.sessionId, scope)
      let handle: AgentHandle
      try {
        const agentPreset = request.agentPreset ?? parent.session.header.agentPreset!
        const parentHeader = parent.session.header
        handle = await this.ctx.agents.create({
          sessionId: request.sessionId,
          meta: {
            cwd: request.cwd ?? parentHeader.cwd,
            agentPreset,
            parentSession: parentHeader.id,
            isSeeded: false,
            origin: 'subagent',
            delegationDepth: (parentHeader.delegationDepth ?? 0) + 1,
          },
          agentOptions: { ...this.ctx.agentDefaultModel.currentSelection(), ...request.agentOptions },
          signal: request.signal,
          setup: workerSetup(this.ctx, {
            agentPreset,
            permissionPreset: request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET,
            taskWorker: request.taskWorker === true,
            ...(request.coordinationRole === undefined ? {} : { coordinationRole: request.coordinationRole }),
            ...(request.grant === undefined ? {} : { grant: request.grant }),
          }),
        })
      } catch (error) {
        await this.releaseSession(request.sessionId)
        throw error
      }
      // A subagent-origin Session is readable only under its durable parent address, and only while its own
      // descriptor exists; Singularity resumes workers itself, so DSH records this child as non-continuable.
      handle.agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot',
        provider: WORKER_DESCRIPTOR_PROVIDER,
        label: request.name,
      }))
      let published = false
      try {
        const events: GraphEvent[] = [
          { kind: 'agent/add', agent: { id: handle.agent.id, name: request.name, status: 'idle' } },
          {
            kind: 'edge/add',
            edge: { id: `${parent.id}->${handle.agent.id}`, kind: 'spawn', from: parent.id, to: handle.agent.id },
          },
        ]
        const snapshot = await this.ctx.graph.snapshotIn(scope.graphStoreId)
        await this.ctx.layout.setIn(scope.layoutStoreId, handle.agent.id, {
          ...DEFAULT_ROOT,
          x: DEFAULT_ROOT.x + 240,
          y: DEFAULT_ROOT.y + snapshot.agents.length * 116,
        })
        await this.ctx.graph.commitIn(scope.graphStoreId, events)
        published = true
        this.owned.add(handle.agent.id)
        this.scopes.set(handle.agent.id, scope)
        this.handles.set(handle.agent.id, handle)
        await this.ctx.parallel('agentRuntime/spawned', { parentId: parent.id, sessionId: handle.agent.id })
        // The caller's awaited door, after publication and before any model input; a rejection fails the spawn.
        await request.beforePrompt?.()
        const kickoff = request.prompt ?? [{ type: 'text' as const, text: WORKER_KICKOFF_TEXT }]
        handle.agent.followup(createUserMessage({ content: [...kickoff], source: runtimePrompt('spawn') }))
        return handle
      } catch (error) {
        await this.releaseSession(handle.agent.id, handle)
        if (published) await this.ctx.graph.setStatusIn(scope.graphStoreId, handle.agent.id, 'failed')
        throw error
      }
    })
  }

  /** Bring one spawned worker's persisted Session back live and idle; refusals are named (A4 §F.1). */
  async resumeWorkerAgent(request: WorkerResumeRequest): Promise<AgentHandle> {
    if (this.closing) throw new Error('agent-runtime: closing')
    const sessionId = SessionId(request.sessionId)
    return await this.inGraph(request.scope, async () => {
      this.owned.add(sessionId)
      this.scopes.set(sessionId, request.scope)
      try {
        const handle = await resumeWorker(this.workerResumeDeps(request), request)
        this.handles.set(sessionId, handle)
        return handle
      } catch (error) {
        await this.releaseSession(sessionId)
        throw error
      }
    })
  }

  /**
   * Close one concluded coordination session's write access. The seal is an
   * execution-time guard on the session's own scope, so no later preset, MCP
   * server or resume can raise the surface back.
   */
  sealCoordinationSession(sessionId: SessionId): void {
    sealCoordinationSession(String(sessionId))
  }

  /**
   * Bring one persisted coordination Session back live, under its own role and
   * composition. The driver resumes the same session id it assigned; a session
   * something else owns is refused by name.
   */
  async resumeCoordinationSession(request: CoordinatorResumeRequest): Promise<AgentHandle> {
    if (this.closing) throw new Error('agent-runtime: closing')
    const sessionId = SessionId(request.sessionId)
    return await this.inGraph(request.scope, async () => {
      this.owned.add(sessionId)
      this.scopes.set(sessionId, request.scope)
      try {
        const handle = await resumeCoordinationAgent(
          {
            agents: this.ctx.agents,
            sessionQuery: this.ctx.sessionQuery,
            graph: this.ctx.graph,
            setup: role => workerSetup(this.ctx, role),
            agentOptions: { ...this.ctx.agentDefaultModel.currentSelection(), ...request.agentOptions },
          },
          request,
        )
        this.handles.set(sessionId, handle)
        return handle
      } catch (error) {
        await this.releaseSession(sessionId)
        throw error
      }
    })
  }

  async stopGraph(scope: GraphScope): Promise<void> {
    if (this.closing) throw new Error('agent-runtime: closing')
    if (this.stopping.has(scope.graphStoreId)) throw new Error('agent-runtime: graph already stopping')
    this.stopping.add(scope.graphStoreId)
    const run = (this.operations.get(scope.graphStoreId) ?? Promise.resolve())
      .then(async () => {
        const graph = await this.ctx.graph.snapshotIn(scope.graphStoreId)
        await this.stopAgents(graph.agents.map(agent => agent.id))
      })
      .finally(() => {
        this.stopping.delete(scope.graphStoreId)
      })
    this.operations.set(
      scope.graphStoreId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  async stopAgents(sessionIds: readonly SessionId[]): Promise<void> {
    for (const id of sessionIds) {
      const pending = this.resuming.get(id)
      if (pending !== undefined) await pending.handle
      const handle = this.handles.get(id)
      if (handle === undefined) {
        if (this.ctx.agents.get(id) !== undefined) throw new Error(`agent-runtime: cannot stop unowned agent "${id}"`)
        this.owned.delete(id)
        this.roots.delete(id)
        this.scopes.delete(id)
        continue
      }
      await this.releaseSession(id, handle)
    }
  }

  async prompt(agent: Agent, prompt: readonly ContentBlock[]): Promise<void> {
    await this.deliverPrompt(agent, prompt, false)
  }

  /** Deliver a goal submitted through the host's graph creation API as user input. */
  async promptUser(agent: Agent, prompt: readonly ContentBlock[], context?: readonly ContentBlock[]): Promise<void> {
    await this.deliverPrompt(agent, prompt, true, context)
  }

  private async deliverPrompt(agent: Agent, prompt: readonly ContentBlock[], user: boolean, context?: readonly ContentBlock[]): Promise<void> {
    if (this.closing) throw new Error('agent-runtime: closing')
    this.live(agent)
    const scope = this.scope(agent.id)
    if (this.stopping.has(scope.graphStoreId)) throw new Error('agent-runtime: graph stopping')
    const snapshot = await this.ctx.graph.snapshotIn(scope.graphStoreId)
    if (snapshot.agents.every(item => item.id !== agent.id)) {
      throw new Error(`agent-runtime: agent "${agent.id}" is not in graph`)
    }
    this.live(agent)
    if (context !== undefined) agent.inject(createUserMessage({ content: [...context], source: runtimePrompt('prompt') }))
    agent.followup(createUserMessage({ content: [...prompt], source: user ? { kind: 'user' } : runtimePrompt('prompt') }))
  }

  /** Read back the body of a `tool/call` a question or answer cites, flushing the sender first (A4 §F.1). */
  async readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody> {
    if (this.closing) throw new Error('agent-runtime: closing')
    return await readToolCallBody(this.deliveryDeps(), ref)
  }

  /** Deliver one already-committed message identity at most once and report what the target log witnesses. */
  async ensureAgentMessageDelivered(intent: AgentMessageIntent): Promise<MessageDelivery> {
    if (this.closing) throw new Error('agent-runtime: closing')
    return await ensureAgentMessageDelivered(this.deliveryDeps(), intent)
  }

  /** Reconcile a set of committed intents against their target Sessions, one at a time (A4 §F.1). */
  async reconcileAgentMessageDeliveries(intents: readonly AgentMessageIntent[]): Promise<MessageDeliveryReport[]> {
    if (this.closing) throw new Error('agent-runtime: closing')
    return await reconcileAgentMessageDeliveries(this.deliveryDeps(), intents)
  }

  private deliveryDeps(): MessageDeliveryDeps {
    return {
      agents: this.ctx.agents,
      sessions: this.ctx.sessions,
      sessionQuery: this.ctx.sessionQuery,
    }
  }

  /** What one worker resume reaches: the live registry, the session read path, the graph store, composition and options. */
  private workerResumeDeps(request: WorkerResumeRequest): WorkerResumeDeps {
    return {
      agents: this.ctx.agents,
      sessionQuery: this.ctx.sessionQuery,
      graph: this.ctx.graph,
      setup: role => workerSetup(this.ctx, role),
      agentOptions: { ...this.ctx.agentDefaultModel.currentSelection(), ...request.agentOptions },
    }
  }

  private inGraph<T>(scope: GraphScope, work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('agent-runtime: closing')
    if (this.stopping.has(scope.graphStoreId)) throw new Error('agent-runtime: graph stopping')
    const run = (this.operations.get(scope.graphStoreId) ?? Promise.resolve()).then(work)
    this.operations.set(
      scope.graphStoreId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /** Forget one session this runtime was composing; only a handle this attempt owns is unregistered and disposed. */
  private async releaseSession(sessionId: SessionId, handle?: AgentHandle): Promise<void> {
    this.owned.delete(sessionId)
    this.roots.delete(sessionId)
    this.scopes.delete(sessionId)
    if (handle !== undefined) {
      this.handles.delete(sessionId)
      await handle.dispose()
    }
  }

  private live(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`agent-runtime: agent "${agent.id}" is not live`)
  }

  private scope(sessionId: SessionId): GraphScope {
    const scope = this.scopes.get(sessionId)
    if (scope === undefined) throw new Error('agent-runtime: agent has no graph scope')
    return scope
  }
}

/** One message source of this runtime's own, as {@link RuntimePromptSource} declares it. */
function runtimePrompt(channel: RuntimePromptSource['channel']): RuntimePromptSource {
  return { kind: 'runtime-prompt', channel }
}

/** The tools every root may call whatever the deployment's method-tool switch says (README Design notes). */
const ROOT_CORE_TOOLS = [
  'read', 'glob', 'grep', 'write', 'edit', 'bash', 'job_list', 'job_output', 'job_kill',
  'task_library',
  'graph_spawn',
  'graph_mark_ready',
  'hitl_ask',
  'hitl_approve',
  'task_read',
  'capability_list',
  'task_template_list',
  'context_read',
  'skill',
  'task_intake',
  'task_decompose',
  'task_submit_result',
  'task_answer',
  'task_cancel',
  'task_proposal_read',
  'task_proposal_continue',
  'task_proposal_cancel',
  'task_status',
  'task_verify',
  'task_review_pack',
  'task_review_agent',
  'task_diagnose',
  'task_budget_extend',
]

/** The root's method surface: observation and candidacy. It never names a pointer-moving tool. */
const ROOT_METHOD_TOOLS = ['method_list', 'method_draft']

/** Structural view of `ctx.singularityMethods`, read softly so this package needs no dependency on it. */
interface MethodToolsExposureLike {
  readonly enabled: boolean
}

/** Whether this composition registered the six `method_*` tools; a context without the service reads as off. */
function methodToolsEnabled(ctx: Context): boolean {
  return (ctx.get('singularityMethods') as MethodToolsExposureLike | undefined)?.enabled ?? false
}

/** The root's tool allow-list: the core tools plus `escalate`, plus the two method tools the switch registered. */
function rootTools(methods: boolean): readonly string[] {
  return [...ROOT_CORE_TOOLS, ...(methods ? ROOT_METHOD_TOOLS : []), 'escalate']
}

/** Root-local registrations also obey the coordination allow-list. */
function sealRootTools(agentCtx: Context, allow: readonly string[]): void {
  agentCtx.tools.presentAs('native')
  const allowed = new Set(allow)
  agentCtx.tools.guard(execution =>
    allowed.has(execution.name)
      ? undefined
      : 'singularity: use the root execution tools, task_decompose for delegated task work, and method_draft/method_list to propose or inspect a method candidate',
  )
}

interface TaskLibrariesLike {
  libraryForRoot(id: string): Promise<{ skillRoot: string }>
  libraryForSession?(id: string): Promise<{ skillRoot: string }>
  libraryRead?(id: string): ReturnType<NonNullable<GraphSkillCatalogOptions['readLibrary']>>
}

async function graphCatalogFor(ctx: Context, agent: Agent, root: boolean): Promise<GraphSkillCatalogOptions> {
  const libraries = ctx.get('taskRuntime') as TaskLibrariesLike | undefined
  // Setup precedes publication of the child graph node. Its durable parent
  // already belongs to this graph; later catalog reads use the published child.
  const ownerSessionId = root ? agent.id : agent.session.header?.parentSession ?? agent.id
  const library = libraries === undefined ? undefined : root
    ? await libraries.libraryForRoot(agent.id)
    : await libraries.libraryForSession?.(ownerSessionId)
  return {
    skillRoots: [library?.skillRoot ?? fileURLToPath(new URL('../skills/', import.meta.url))],
    ...(libraries?.libraryRead === undefined || library === undefined ? {}
      : { readLibrary: () => libraries.libraryRead!(agent.id) }),
  }
}

/** Compose one root's scoped world; `createRoot` and `resumeRoot` both hand this to the agent factory. */
function rootSetup(ctx: Context, agentPreset: string): AgentSetup {
  return async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, agentPreset)
    ctx.permissionPresets.set(agent.session, 'workspace-isolated')
    // The bubble's own approval policy is not the root's business: hitl_approve must reach the answerer, so pin the root to 'ask'.
    setApprovalPolicy(agent.session, 'ask')
    const methods = methodToolsEnabled(ctx)
    agentCtx.systemPrompt.section({ name: 'singularity:root', order: 70, text: rootPromptText(methods) })
    agentCtx.tools.restrict({ allow: rootTools(methods) })
    await installGraphSkillCatalog(agentCtx, await graphCatalogFor(ctx, agent, true))
    sealRawSessionReads(agentCtx)
    sealRootTools(agentCtx, rootTools(methods))
    // The root holds observation and candidacy, never publication: the seal makes
    // a call to method_publish/method_rollback fail closed here too, not merely
    // absent from the allow-list.
    sealMethodAuthority(agentCtx, false)
  }
}

/** The one composition a worker's scoped world is built from; `spawn` and a resume both hand this to the factory. */
function workerSetup(ctx: Context, role: WorkerRole): AgentSetup {
  return async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, role.agentPreset)
    ctx.permissionPresets.set(agent.session, role.permissionPreset)
    if (role.coordinationRole !== undefined) {
      if (role.coordinationRole === 'supervisor') setApprovalPolicy(agent.session, 'ask')
      agentCtx.systemPrompt.section({
        name: `singularity:${role.coordinationRole}`,
        order: 75,
        text: role.coordinationRole === 'reviewer' ? REVIEWER_POLICY_TEXT : SUPERVISOR_POLICY_TEXT,
        interpolate: false,
      })
      // The seal is installed on both composition paths (spawn and resume), so a
      // concluded session cannot be resumed into a writable surface.
      guardCoordinationWrites(agentCtx, agent, COORDINATION_SEALED_ALLOW)
    }
    if (role.taskWorker) {
      agentCtx.systemPrompt.section({
        name: 'singularity:worker',
        order: 75,
        text: WORKER_POLICY_TEXT,
        interpolate: false,
      })
    }
    if (role.grant !== undefined)
      await applyWorkerGrant(agentCtx, agent, role.grant, role.coordinationRole === 'supervisor'
        ? await graphCatalogFor(ctx, agent, false) : undefined)
    else if (role.coordinationRole === 'supervisor')
      await installGraphSkillCatalog(agentCtx, await graphCatalogFor(ctx, agent, false))
    sealRawSessionReads(agentCtx)
    sealNativeDelegation(agentCtx)
  }
}

export default AgentRuntime

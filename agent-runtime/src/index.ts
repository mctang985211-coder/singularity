/**
 * Singularity agent runtime over the graph.
 * @module dsh-singularity-agent-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {} from '@dangosys/dsh-singularity-layout'
import { DEFAULT_ROOT } from '@dangosys/dsh-singularity-layout'
import type { Agent, AgentHandle, ContentBlock, GraphEvent, GraphScope, RootRequest, RuntimePromptSource, SpawnRequest } from './types.ts'
import { applyWorkerGrant } from './grants.ts'
import {
  ensureAgentMessageDelivered,
  readToolCallBody,
  reconcileAgentMessageDeliveries,
} from './messages.ts'
import type {
  AgentMessageIntent,
  MessageDelivery,
  MessageDeliveryDeps,
  MessageDeliveryReport,
  ToolCallBody,
  ToolCallRef,
} from './messages.ts'
import { rootPromptText } from './prompts/root.prompts.ts'
import { WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT } from './prompts/worker.prompts.ts'
import { sealRawSessionReads } from './raw-session-guard.ts'

/** The nine tools the evolution chain is reached through; a deployment's switch is what registers them. */
const EVOLUTION_TOOLS = [
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_rollback',
  'evolution_list',
]

/** The tools every root may call whatever the deployment's evolution switch says. */
const ROOT_CORE_TOOLS = [
  'graph_spawn',
  'graph_mark_ready',
  'hitl_ask',
  'hitl_approve',
  'task_read',
  'capability_list',
  // The one reference reader a root shares with every other role (A2): the
  // records its own reads name — evidence, reviews, sessions — are read by id
  // through this tool, which authorizes by the caller's graph domain. The raw
  // cross-session readers were never on this surface and are sealed below.
  'context_read',
  // The skill loader rides the mounted preset's plane (`tool-skill`), not the
  // global layer: allowing it here is what lets the root load domain reference
  // skills (e.g. bb-pipeline) discovered from the deployment's skill roots.
  'skill',
  // Accepting the user's own goal is the root's core path (A0): the tool is
  // unconditional, because a graph whose root contract cannot be accepted has
  // no goal to delegate at all.
  'task_intake',
  'task_decompose',
  'task_submit_result',
  // The root is a legal addressee (A4 §F.1): its children ask it their
  // questions, so answering one is a coordination action of the root's own
  // surface. `task_ask_parent` is deliberately absent — the root has no parent
  // to ask, and a tool that cannot be answered is one not worth offering.
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
]

/** Structural view of the deployment's switch position (`ctx.singularityEvolution`), read softly so this package needs no dependency on the assembly that provides it. */
interface EvolutionExposureLike {
  readonly enabled: boolean
}

/**
 * Whether this composition registered the nine `evolution_*` tools. Soft read:
 * a context that mounts no singularity agent plugin provides no such service,
 * and that absence is the closed state — never "assume the chain is there". The
 * answer decides both the root's allow-list and its prompt, because a prompt
 * that names a tool the surface does not carry asks for a call that cannot
 * happen (prompt contracts §1/§7).
 */
function evolutionEnabled(ctx: Context): boolean {
  return (ctx.get('singularityEvolution') as EvolutionExposureLike | undefined)?.enabled ?? false
}

/**
 * The root's tool allow-list for one composition, single point: `createRoot` and
 * `resumeRoot` both restrict with this, so a root cannot be assembled on one
 * fact and prompted on another. Off, the nine names are absent — `restrict` is a
 * mask over what exists, and with the chain off nothing registered them. On, the
 * list is exactly the deployment's previous one, name for name.
 */
function rootToolsFor(enabled: boolean): readonly string[] {
  // `escalate` trails the chain because it always has: the on-composition is the
  // list this deployment ran before the switch existed.
  return enabled ? [...ROOT_CORE_TOOLS, ...EVOLUTION_TOOLS, 'escalate'] : [...ROOT_CORE_TOOLS, 'escalate']
}

/**
 * `hitl_approve` asks through `ctx.approval`, whose 'never' policy (bundled into
 * danger-full-access) auto-rejects before any answerer sees the request. Root
 * agents expose no policy-gated tools, so pinning their session to 'ask'
 * re-enables only the explicit human decision.
 */
function pinRootApprovalPolicy(session: Session): void {
  setApprovalPolicy(session, 'ask')
}

/** One message source of this runtime's own, as {@link RuntimePromptSource} declares it. */
function runtimePrompt(channel: RuntimePromptSource['channel']): RuntimePromptSource {
  return { kind: 'runtime-prompt', channel }
}
export type {
  AgentOptions,
  CanvasNode,
  ContentBlock,
  GraphScope,
  McpServerSpec,
  RootRequest,
  RuntimePromptSource,
  SessionVisibility,
  SpawnRequest,
  WorkerCapabilityGrant,
  WorkerGrant,
} from './types.ts'
export { applyWorkerGrant, resolveGrant } from './grants.ts'
export type { ResolvedGrant } from './grants.ts'
export { findSkillFileIn, parseSkillFile, skillRootsFor } from './skill-file.ts'
export type { ParsedSkillFile } from './skill-file.ts'
export { WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT } from './prompts/worker.prompts.ts'
export { RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, sealRawSessionReads } from './raw-session-guard.ts'
export {
  MessageDeliveryRefusal,
  answerMessageText,
  ensureAgentMessageDelivered,
  messageAccepted,
  questionMessageText,
  readToolCallBody,
  reconcileAgentMessageDeliveries,
  relayMessage,
  toolCallRefIn,
} from './messages.ts'
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
    ctx.provide('sessionVisibility', {
      isVisible: sessionId => !this.owned.has(sessionId) || this.roots.has(sessionId),
    })
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

  async ensureRoot(sessionId: SessionId, scope: GraphScope): Promise<AgentHandle> {
    if (this.closing) throw new Error('agent-runtime: closing')
    const pending = this.resuming.get(sessionId)
    if (pending !== undefined) {
      if (pending.scope.graphStoreId !== scope.graphStoreId || pending.scope.layoutStoreId !== scope.layoutStoreId) {
        throw new Error('agent-runtime: concurrent root scope mismatch')
      }
      return pending.handle
    }
    const handle = this.inGraph(scope, () => this.resumeRoot(sessionId, scope)).finally(() =>
      this.resuming.delete(sessionId),
    )
    this.resuming.set(sessionId, { scope, handle })
    return handle
  }

  private async resumeRoot(sessionId: SessionId, scope: GraphScope): Promise<AgentHandle> {
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
        agentOptions: this.ctx.agentDefaultModel.currentSelection(),
        setup: async (agentCtx, agent) => {
          await this.ctx.agentPresets.mount(agentCtx, agentPreset)
          this.ctx.permissionPresets.set(agent.session, 'danger-full-access')
          pinRootApprovalPolicy(agent.session)
          const evolution = evolutionEnabled(this.ctx)
          agentCtx.systemPrompt.section({ name: 'singularity:root', order: 70, text: rootPromptText(evolution) })
          agentCtx.tools.restrict({ allow: rootToolsFor(evolution) })
          // The raw cross-session readers are sealed at execution for every
          // agent this runtime owns (raw-session-guard.ts): the root's
          // allow-list already leaves them off the surface; this is the backstop
          // a preset or MCP merge cannot lift.
          sealRawSessionReads(agentCtx)
        },
      })
      this.handles.set(sessionId, handle)
      return handle
    } catch (error) {
      this.owned.delete(sessionId)
      this.roots.delete(sessionId)
      this.scopes.delete(sessionId)
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
          setup: async (agentCtx, agent) => {
            await this.ctx.agentPresets.mount(agentCtx, agentPreset)
            this.ctx.permissionPresets.set(agent.session, 'danger-full-access')
            pinRootApprovalPolicy(agent.session)
            const evolution = evolutionEnabled(this.ctx)
            agentCtx.systemPrompt.section({ name: 'singularity:root', order: 70, text: rootPromptText(evolution) })
            agentCtx.tools.restrict({ allow: rootToolsFor(evolution) })
            sealRawSessionReads(agentCtx)
          },
        })
      } catch (error) {
        this.owned.delete(request.sessionId)
        this.scopes.delete(request.sessionId)
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
        this.owned.delete(request.sessionId)
        this.owned.delete(handle.agent.id)
        this.roots.delete(handle.agent.id)
        this.scopes.delete(request.sessionId)
        this.scopes.delete(handle.agent.id)
        await handle.dispose()
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
            cwd: parentHeader.cwd,
            agentPreset,
            parentSession: parentHeader.id,
            isSeeded: false,
            origin: 'subagent',
            delegationDepth: (parentHeader.delegationDepth ?? 0) + 1,
          },
          agentOptions: { ...this.ctx.agentDefaultModel.currentSelection(), ...request.agentOptions },
          signal: request.signal,
          setup: async (agentCtx, agent) => {
            await this.ctx.agentPresets.mount(agentCtx, agentPreset)
            // Unknown preset names throw out of permissionPresets.set itself
            // (its resolve names the preset), failing the spawn loudly.
            this.ctx.permissionPresets.set(agent.session, request.permissionPreset ?? 'danger-full-access')
            // A task worker carries the role's stable policy as a prompt section
            // (order 75, between the root's 70 and the contract's 80): the rules
            // every worker runs under, reprojected into surface node 0 on every
            // step. The contract itself is NOT registered here — it is the
            // context assembly's section, projected from the store at each model
            // request, so this scope holds no second copy of it.
            if (request.taskWorker === true) {
              agentCtx.systemPrompt.section({ name: 'singularity:worker', order: 75, text: WORKER_POLICY_TEXT, interpolate: false })
            }
            // A capability grant restricts the surface the preset just joined
            // (its tools are inherited, so restrictable) and registers the
            // granted skills into this worker's own layer. A spawn nobody
            // authorized with capabilities keeps its composition's surface.
            if (request.grant !== undefined) await applyWorkerGrant(agentCtx, agent, request.grant)
            sealRawSessionReads(agentCtx)
          },
        })
      } catch (error) {
        this.owned.delete(request.sessionId)
        this.scopes.delete(request.sessionId)
        throw error
      }
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
        // The caller's awaited door, after publication and the spawn
        // announcement and before any model input: what must be durable for the
        // child's first request to be admissible (the reviewer ledger, A2 §D) is
        // written and read back here. A rejection fails the spawn below — the
        // handle is disposed, the node is marked failed, and no followup was
        // ever queued.
        await request.beforePrompt?.()
        // The delegated task, under this runtime's own attribution: `kind: 'user'`
        // is DSH's host-attested human input marker, and the worker's first turn is
        // nobody's request but this deployment's (A0 §1.10, {@link RuntimePromptSource}).
        const kickoff = request.prompt ?? [{ type: 'text' as const, text: WORKER_KICKOFF_TEXT }]
        handle.agent.followup(createUserMessage({ content: [...kickoff], source: runtimePrompt('spawn') }))
        return handle
      } catch (error) {
        this.handles.delete(handle.agent.id)
        this.owned.delete(request.sessionId)
        this.owned.delete(handle.agent.id)
        this.scopes.delete(request.sessionId)
        this.scopes.delete(handle.agent.id)
        await handle.dispose()
        if (published) await this.ctx.graph.setStatusIn(scope.graphStoreId, handle.agent.id, 'failed')
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
      this.handles.delete(id)
      this.owned.delete(id)
      this.roots.delete(id)
      this.scopes.delete(id)
      await handle.dispose()
    }
  }

  async prompt(agent: Agent, prompt: readonly ContentBlock[]): Promise<void> {
    if (this.closing) throw new Error('agent-runtime: closing')
    this.live(agent)
    const scope = this.scope(agent.id)
    if (this.stopping.has(scope.graphStoreId)) throw new Error('agent-runtime: graph stopping')
    const snapshot = await this.ctx.graph.snapshotIn(scope.graphStoreId)
    if (snapshot.agents.every(item => item.id !== agent.id)) {
      throw new Error(`agent-runtime: agent "${agent.id}" is not in graph`)
    }
    this.live(agent)
    // The graph's setup text is written by this runtime for its own root session
    // (`graphs.create`), never by a person: it carries this runtime's own message
    // source for the same reason a spawn does (A0 §1.10).
    agent.followup(createUserMessage({ content: [...prompt], source: runtimePrompt('prompt') }))
  }

  /**
   * Read back the body of a `tool/call` one question or answer cites (A4 §F.1),
   * flushing the sending Session first so the citation names a durable event.
   * Thin adapter over {@link readToolCallBody}: this class owns the handle and the
   * context, the delivery rules own themselves (`./messages.ts`).
   * @param ref - the sending Session and the seq of its `tool/call`.
   * @returns the tool name and the raw arguments text the model produced.
   * @throws MessageDeliveryRefusal with the named reason the citation is unusable.
   */
  async readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody> {
    if (this.closing) throw new Error('agent-runtime: closing')
    return await readToolCallBody(this.deliveryDeps(), ref)
  }

  /**
   * Deliver one already-committed message identity into its target Session's
   * inbox, at most once, and report what that Session's log can witness. Called
   * by the question protocol after the Task store committed the intent (A4's
   * third sub-goal); re-calling it after a crash delivers only what is missing.
   * @param intent - the recorded identity, the two Sessions, and the body.
   * @returns the settled status: `delivered`, `already-present`, or `unavailable`.
   * @throws MessageDeliveryRefusal when the attempt cannot be decided or confirmed.
   */
  async ensureAgentMessageDelivered(intent: AgentMessageIntent): Promise<MessageDelivery> {
    if (this.closing) throw new Error('agent-runtime: closing')
    return await ensureAgentMessageDelivered(this.deliveryDeps(), intent)
  }

  /**
   * Reconcile a set of committed intents against their target Sessions, one at a
   * time, and report each record's outcome — the recovery path's entry point
   * (§F.1). No ledger of its own: the delivered fact is each target's own fold.
   * @param intents - the records the Task store holds, in delivery order.
   * @returns one report per record; a refused record names why.
   */
  async reconcileAgentMessageDeliveries(
    intents: readonly AgentMessageIntent[],
  ): Promise<MessageDeliveryReport[]> {
    if (this.closing) throw new Error('agent-runtime: closing')
    return await reconcileAgentMessageDeliveries(this.deliveryDeps(), intents)
  }

  /**
   * The services one delivery reaches, resolved to the three capabilities
   * `./messages.ts` declares and no more: this class's own fields stay private,
   * and a service the module never calls is never handed to it.
   */
  private deliveryDeps(): MessageDeliveryDeps {
    return {
      agents: this.ctx.agents,
      sessions: this.ctx.sessions,
      sessionQuery: this.ctx.sessionQuery,
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

  private live(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`agent-runtime: agent "${agent.id}" is not live`)
  }

  private scope(sessionId: SessionId): GraphScope {
    const scope = this.scopes.get(sessionId)
    if (scope === undefined) throw new Error('agent-runtime: agent has no graph scope')
    return scope
  }
}

export default AgentRuntime

import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GraphEvent } from '@dangosys/dsh-singularity-graph'
import type { CanvasNode } from '@dangosys/dsh-singularity-layout'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntime: import('./index.ts').AgentRuntime
    sessionVisibility: SessionVisibility
  }
  interface Events {
    'agentRuntime/spawned'(event: { parentId: SessionId; sessionId: SessionId }): void
  }
}

export interface SessionVisibility {
  readonly isVisible: (sessionId: SessionId) => boolean
}

/**
 * Durable attribution for one prompt this runtime wrote to a session of its own:
 * the delegated task a `spawn` hands its worker, and the setup text a graph entry
 * hands its root (`prompt`).
 *
 * It is its own kind rather than `kind: 'user'` because that kind is DSH's
 * *host-attested human input* marker (`tool-goal/src/authority.ts`:
 * `hasDirectHumanInput`; and the omitted-source rule that turns an
 * `Agent.followup()` with no source into `user`), and the difference is a rule
 * this deployment rests on: a root contract is attributed to the person whose
 * request stands on the session's own log (A0 §1.10), and a session that only
 * ever heard from the deployment has no such request. Writing our own prompts
 * under `user` would have put the deployment's voice on the same record as a
 * person's — an invented goal reported as the user's own.
 *
 * What changes is the attribution and nothing else: the loop appends a queued
 * message verbatim whatever its source, so the model-visible content, the order
 * of the turn and the durability of the event are exactly what they were.
 *
 * No `form` is declared: a form is a producer's declaration of how an injected
 * *context* row presents itself (`notice`, `snapshot`, `relay`, …), and these are
 * this deployment's own prompts, not context a subsystem contributed. The closest
 * of the existing forms is `notice`, and a prompt is not an account of something
 * that happened, so the undeclared default is the honest answer.
 */
export interface RuntimePromptSource {
  readonly kind: 'runtime-prompt'
  /** Which of this runtime's own doors wrote the message. */
  readonly channel: 'prompt' | 'spawn'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-prompt': RuntimePromptSource
  }
}

export interface RootRequest {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly scope: GraphScope
  readonly agentOptions?: AgentOptions
  readonly agentPreset?: string
}

export interface GraphScope {
  readonly graphStoreId: string
  readonly layoutStoreId: string
}

/**
 * One capability's grant, already resolved by the task runtime: tool LABELS are
 * expanded to real DSH tool names at admission (`task-runtime/src/capability.ts`),
 * so this seam carries names the tools registry can actually see.
 */
export interface WorkerCapabilityGrant {
  /** Capability name the grant came from; every rejection this grant causes names it. */
  readonly capability: string
  /** Real DSH tool names the capability declares. Each one must be visible to the worker or the spawn fails. */
  readonly tools: readonly string[]
  /** Skill names the capability declares. Each one must resolve to a SKILL.md or the spawn fails. */
  readonly skills: readonly string[]
}

/**
 * One MCP server to mount on the worker's own scope, fully resolved by the
 * task runtime (`task-runtime/src/mcp-servers.ts` materializes the registry
 * templates against the run's env binding). Plain data matching mcp-client's
 * stdio config; the mount fixes `transport: 'stdio'` and
 * `failOnStartupError: true` — a worker whose declared server cannot start
 * fails the spawn, never degrades silently. Mounted tools publish as
 * `mcp__<serverName>__<tool>` on the worker's OWN tool layer, which
 * `tools.restrict` never filters (restrictions name only the inherited
 * surface), so the grant needs no allow-list entry for them.
 */
export interface McpServerSpec {
  /** Namespace the server's tools publish under; unique per worker (mcp-client reserves it per agent scope). */
  readonly serverName: string
  readonly command: string
  readonly args: readonly string[]
  /** Extra env merged onto the scrubbed ambient env; `{}` when the template declares none. */
  readonly env: Readonly<Record<string, string>>
  /** Child process working directory; `''` inherits the harness process cwd. */
  readonly cwd: string
  /** Per-tool-call deadline; absent hands mcp-client its own default (60 s). */
  readonly toolCallTimeoutMs?: number
}

/**
 * What one spawned worker is authorized with. A spawn with no grant keeps the
 * surface its composition gives it: only a capability decision restricts a
 * worker, because only then is there a declaration to enforce.
 */
export interface WorkerGrant {
  /** Capability plane: the tools/skills the worker's capabilities declare. */
  readonly capabilities: readonly WorkerCapabilityGrant[]
  /**
   * Baseline plane: the tools the worker's prompt needs whatever its
   * capabilities are (`task-runtime/src/capability.ts` owns the list and cites
   * the prompt lines). Intersected with what the worker's composition offers —
   * a composition that never mounted `bash` has nothing for the filter to take
   * away, and demanding it would make composition-specific capabilities (the
   * `bb-verify` node, which mounts no shell) unspawnable.
   */
  readonly baseline: readonly string[]
  /**
   * Whether the mounted agent preset's own tool plane stays. True when a
   * matched capability names its own `preset`: selecting a composition is
   * already an authorization, and a foreign composition's tool names are not
   * ours to enumerate. Capabilities that ride the deployment
   * default preset get their declared tools and the baseline only.
   */
  readonly keepPresetTools: boolean
  /**
   * Extra skill roots searched before production discovery, for this worker
   * only (the replay overlay, `task-runtime` ReplayOverlay.extraSkillRoots):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   * skill layer, which shadows the same-name production skill for this worker
   * alone (the nearest scope layer wins a duplicate outright). Earlier roots
   * win a duplicate between roots. Absent = production discovery only.
   */
  readonly skillRoots?: readonly string[]
  /**
   * MCP servers the worker's capabilities grant, mounted one mcp-client
   * instance each inside the worker's setup (`grants.ts: applyWorkerGrant`),
   * after the tool restriction is computed so their own-layer names never
   * enter the allow-list machinery. Absent = no MCP plane.
   */
  readonly mcpServers?: readonly McpServerSpec[]
}

export interface SpawnRequest {
  readonly sessionId: SessionId
  readonly name: string
  /**
   * The first user message the child is prompted with. Optional because a
   * `taskWorker` spawn needs none: the agent runtime fills the default kickoff
   * ({@link WORKER_KICKOFF_TEXT}), and the worker's contract and state are the
   * context assembly's, not this message's. A spawn that is neither given a
   * prompt nor marked `taskWorker` is refused.
   */
  readonly prompt?: readonly ContentBlock[]
  readonly agentOptions?: AgentOptions
  /** Capability-derived authorization applied to the child before publication. Absent = no capability decided it. */
  readonly grant?: WorkerGrant
  /**
   * Preset id mounted for the child, overriding the inherit-the-parent
   * default. Same semantics as {@link RootRequest.agentPreset}; a missing
   * value keeps the parent's preset.
   */
  readonly agentPreset?: string
  /**
   * Permission preset applied to the child's session, overriding the
   * `danger-full-access` default posture. Task-runtime resolves it from the
   * capability manifest (strictest declared wins).
   */
  readonly permissionPreset?: string
  /**
   * Declare the child a task worker (A2): the spawn setup installs the stable
   * worker policy section (`singularity:worker`, order 75 — the worker's
   * contract itself is the context assembly's `singularity:worker-contract`
   * section, injected from the store at every model request), and an absent
   * prompt becomes the default kickoff. Declared at spawn, not persisted: it
   * describes who this child is, and the store's records stay the authority on
   * what it works on.
   */
  readonly taskWorker?: boolean
  /**
   * The one awaited door a caller gets between "the child is a published graph
   * member and its spawn was announced" and "the first model input is sent"
   * (A2 §D: the reviewer ledger is written and read back here, so a delegation
   * the context assembly can verify exists before any model request). The
   * callback receives nothing a model could have influenced. When it rejects,
   * the spawn fails the same way a publish failure does: the handle is
   * disposed, the graph node is marked failed, and no model input was sent.
   */
  readonly beforePrompt?: () => Promise<void>
  readonly signal?: AbortSignal
}

/**
 * The Run facts a caller read from its own store for the Session it is bringing
 * back (A4 §F.1's recovery entry). Structural on purpose: this package holds no
 * task dependency — the store is the runtime's — so these are the fields
 * `TaskRun` records, named the way it names them, and nothing here is guessed
 * by the resume. Every one of them is checked against the Session's own durable
 * record before anything is written.
 */
export interface WorkerRunFacts {
  /** The store the Run belongs to. */
  readonly storeId: string
  readonly taskId: string
  readonly runId: string
  /** The Session the store's own Run record binds — must be the Session being resumed. */
  readonly sessionId: SessionId
  /** The preset the Run was admitted with, when the store recorded one. */
  readonly agentPreset?: string
  /**
   * What the Run was admitted with (`TaskRun.capabilitySnapshot`: the granted
   * tools, skills and `mcp:<serverName>` markers, flattened). Required because
   * the store records it for every Run: a resume that cannot show the plane the
   * Run was admitted under would be reinstalling a tool face nobody authorized.
   */
  readonly capabilitySnapshot: readonly string[]
}

/**
 * One controlled resume of a spawned worker's persisted Session (A4 §F.1), the
 * entry `task-runtime`'s recovery pass calls once it has reconciled the store:
 * the same Session comes back live as the same worker — same identity, same
 * composition, same tool face, same grant, same raw-session seal — and **idle**.
 *
 * Nothing here is a new session, a substitute node, a roster or a mailbox: the
 * handle this returns is registered in the runtime's one handle map and is
 * disposed by the same `stopAgents`/`stopGraph` rules a spawn's handle is.
 */
export interface WorkerResumeRequest {
  /** The persisted Session to bring back live; the identity the spawn created. */
  readonly sessionId: SessionId
  /** The graph the Session was published in — the scope its spawn ran under. */
  readonly scope: GraphScope
  /** The Run the caller holds for this Session, as the store records it. */
  readonly run: WorkerRunFacts
  /** The grant the Run was spawned with, resolved by the caller as the spawn resolved it. */
  readonly grant?: WorkerGrant
  /**
   * The permission preset the Run was admitted under. Absent = the spawn's own
   * default ({@link WORKER_DEFAULT_PERMISSION_PRESET}).
   */
  readonly permissionPreset?: string
  /**
   * Whether the Session was spawned as a task worker. Required, not defaulted:
   * the durable record does not carry the flag, and a resume that guessed would
   * either drop the worker policy the prompt ran under or add one it never had.
   */
  readonly taskWorker: boolean
  /** Per-agent options for the resumed agent, overriding the runtime's default selection. */
  readonly agentOptions?: AgentOptions
}

export type { Agent, AgentHandle, AgentOptions, CanvasNode, ContentBlock, GraphEvent, SessionId }

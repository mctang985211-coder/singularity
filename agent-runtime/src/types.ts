import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntime: import('./index.ts').AgentRuntime
  }
  interface Events {
    'agentRuntime/spawned'(event: { parentId: SessionId; sessionId: SessionId }): void
  }
}

/** Durable attribution for one prompt this runtime wrote to a session of its own (A0 §1.10, README Design notes). */
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

/** One capability's grant, already resolved by the task runtime: tool LABELS are expanded to real DSH names. */
export interface WorkerCapabilityGrant {
  /** Capability name the grant came from; every rejection this grant causes names it. */
  readonly capability: string
  /** Real DSH tool names the capability declares; each must be visible to the worker or the spawn fails. */
  readonly tools: readonly string[]
  /** Skill names the capability declares; each must resolve to a SKILL.md or the spawn fails. */
  readonly skills: readonly string[]
}

/** One MCP server to mount on the worker's own scope, fully resolved by the task runtime. */
export interface McpServerSpec {
  /** Namespace the server's tools publish under; unique per worker. */
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

/** What one spawned worker is authorized with; a spawn with no grant keeps its composition's surface. */
export interface WorkerGrant {
  /** Capability plane: the tools/skills the worker's capabilities declare. */
  readonly capabilities: readonly WorkerCapabilityGrant[]
  /** Baseline plane: tools the worker's prompt needs whatever its capabilities are, intersected with the surface. */
  readonly baseline: readonly string[]
  /** Keep the preset's local tools, excluding native delegation: all agent work uses Task/Run contracts. */
  readonly keepPresetTools: boolean
  /** Extra skill roots searched before production discovery, for this worker only (the replay overlay). */
  readonly skillRoots?: readonly string[]
  /** MCP servers the worker's capabilities grant, mounted after the tool restriction is computed. */
  readonly mcpServers?: readonly McpServerSpec[]
}

export interface SpawnRequest {
  readonly sessionId: SessionId
  readonly name: string
  /** First user message; optional for a `taskWorker`, which gets the default kickoff. */
  readonly prompt?: readonly ContentBlock[]
  readonly agentOptions?: AgentOptions
  /** Capability-derived authorization applied to the child before publication. Absent = none decided it. */
  readonly grant?: WorkerGrant
  /** Preset id mounted for the child, overriding the inherit-the-parent default. */
  readonly agentPreset?: string
  /** Permission preset applied to the child's session, overriding the `danger-full-access` default posture. */
  readonly permissionPreset?: string
  /** Working directory the child starts in, replacing the inherit-the-parent default; absent keeps the parent's. */
  readonly cwd?: string
  /** Declare the child a task worker: install the stable policy section and default the kickoff. */
  readonly taskWorker?: boolean
  /** Coordination roles install their own stable policy instead of a preset persona. */
  readonly coordinationRole?: 'reviewer' | 'supervisor'
  /** One awaited door between publication + announcement and the first model input. */
  readonly beforePrompt?: () => Promise<void>
  readonly signal?: AbortSignal
}

/** The Run facts a caller read from its own store for the Session it is bringing back (A4 §F.1). */
export interface WorkerRunFacts {
  /** The store the Run belongs to. */
  readonly storeId: string
  readonly taskId: string
  readonly runId: string
  /** The Session the store's own Run record binds — must be the Session being resumed. */
  readonly sessionId: SessionId
  /** The preset the Run was admitted with, when the store recorded one. */
  readonly agentPreset?: string
  /** `TaskRun.capabilitySnapshot`: the granted tools, skills and `mcp:<serverName>` markers, flattened. */
  readonly capabilitySnapshot: readonly string[]
}

/** One controlled resume of a spawned worker's persisted Session (A4 §F.1); it comes back identical and idle. */
export interface WorkerResumeRequest {
  /** The persisted Session to bring back live; the identity the spawn created. */
  readonly sessionId: SessionId
  /** The graph the Session was published in — the scope its spawn ran under. */
  readonly scope: GraphScope
  /** The Run the caller holds for this Session, as the store records it. */
  readonly run: WorkerRunFacts
  /** The grant the Run was spawned with, resolved by the caller as the spawn resolved it. */
  readonly grant?: WorkerGrant
  /** The permission preset the Run was admitted under; absent = the spawn's default. */
  readonly permissionPreset?: string
  /** Whether the Session was spawned as a task worker; required, because the durable record carries no flag. */
  readonly taskWorker: boolean
  /** Per-agent options for the resumed agent, overriding the runtime's default selection. */
  readonly agentOptions?: AgentOptions
}

export type { AgentOptions } from '@deepseek-ai/dsh-agent'

import { Context, Service } from "@deepseek-ai/cordis";
import { ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionId as SessionId$1 } from "@deepseek-ai/dsh-session";
import { CanvasNode } from "@dangosys/dsh-singularity-layout";
import { Agent, Agent as Agent$1, AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";

//#region src/types.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntime: AgentRuntime;
    sessionVisibility: SessionVisibility;
  }
  interface Events {
    'agentRuntime/spawned'(event: {
      parentId: SessionId$1;
      sessionId: SessionId$1;
    }): void;
  }
}
interface SessionVisibility {
  readonly isVisible: (sessionId: SessionId$1) => boolean;
}
interface RootRequest {
  readonly sessionId: SessionId$1;
  readonly cwd: string;
  readonly scope: GraphScope;
  readonly agentOptions?: AgentOptions;
  readonly agentPreset?: string;
}
interface GraphScope {
  readonly graphStoreId: string;
  readonly layoutStoreId: string;
}
/**
 * One capability's grant, already resolved by the task runtime: tool LABELS are
 * expanded to real DSH tool names at admission (`task-runtime/src/capability.ts`),
 * so this seam carries names the tools registry can actually see.
 */
interface WorkerCapabilityGrant {
  /** Capability name the grant came from; every rejection this grant causes names it. */
  readonly capability: string;
  /** Real DSH tool names the capability declares. Each one must be visible to the worker or the spawn fails. */
  readonly tools: readonly string[];
  /** Skill names the capability declares. Each one must resolve to a SKILL.md or the spawn fails. */
  readonly skills: readonly string[];
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
interface McpServerSpec {
  /** Namespace the server's tools publish under; unique per worker (mcp-client reserves it per agent scope). */
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Extra env merged onto the scrubbed ambient env; `{}` when the template declares none. */
  readonly env: Readonly<Record<string, string>>;
  /** Child process working directory; `''` inherits the harness process cwd. */
  readonly cwd: string;
  /** Per-tool-call deadline; absent hands mcp-client its own default (60 s). */
  readonly toolCallTimeoutMs?: number;
}
/**
 * What one spawned worker is authorized with. A spawn with no grant keeps the
 * surface its composition gives it: only a capability decision restricts a
 * worker, because only then is there a declaration to enforce.
 */
interface WorkerGrant {
  /** Capability plane: the tools/skills the worker's capabilities declare. */
  readonly capabilities: readonly WorkerCapabilityGrant[];
  /**
   * Baseline plane: the tools the worker's prompt needs whatever its
   * capabilities are (`task-runtime/src/capability.ts` owns the list and cites
   * the prompt lines). Intersected with what the worker's composition offers —
   * a composition that never mounted `bash` has nothing for the filter to take
   * away, and demanding it would make composition-specific capabilities (the
   * `bb-verify` node, which mounts no shell) unspawnable.
   */
  readonly baseline: readonly string[];
  /**
   * Whether the mounted agent preset's own tool plane stays. True when a
   * matched capability names its own `preset`: selecting a composition is
   * already an authorization, and a foreign composition's tool names are not
   * ours to enumerate. Capabilities that ride the deployment
   * default preset get their declared tools and the baseline only.
   */
  readonly keepPresetTools: boolean;
  /**
   * Extra skill roots searched before production discovery, for this worker
   * only (the replay overlay, `task-runtime` ReplayOverlay.extraSkillRoots):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   * skill layer, which shadows the same-name production skill for this worker
   * alone (the nearest scope layer wins a duplicate outright). Earlier roots
   * win a duplicate between roots. Absent = production discovery only.
   */
  readonly skillRoots?: readonly string[];
  /**
   * MCP servers the worker's capabilities grant, mounted one mcp-client
   * instance each inside the worker's setup (`grants.ts: applyWorkerGrant`),
   * after the tool restriction is computed so their own-layer names never
   * enter the allow-list machinery. Absent = no MCP plane.
   */
  readonly mcpServers?: readonly McpServerSpec[];
}
interface SpawnRequest {
  readonly sessionId: SessionId$1;
  readonly name: string;
  readonly prompt: readonly ContentBlock[];
  readonly agentOptions?: AgentOptions;
  /** Capability-derived authorization applied to the child before publication. Absent = no capability decided it. */
  readonly grant?: WorkerGrant;
  /**
   * Preset id mounted for the child, overriding the inherit-the-parent
   * default. Same semantics as {@link RootRequest.agentPreset}; a missing
   * value keeps the parent's preset.
   */
  readonly agentPreset?: string;
  /**
   * Permission preset applied to the child's session, overriding the
   * `danger-full-access` default posture. Task-runtime resolves it from the
   * capability manifest (strictest declared wins).
   */
  readonly permissionPreset?: string;
  /**
   * The child's contract, registered as a system-prompt section on the child's
   * own scope. The loop reprojects that section into surface node 0 on every
   * step, so the contract survives compaction instead of living only in the
   * spawn prompt. Task-runtime renders the text from the store; absent or blank
   * registers nothing. See `./contract-reinjection.ts`.
   */
  readonly contract?: string;
  readonly signal?: AbortSignal;
}
//#endregion
//#region src/grants.d.ts
/** The tool surface one worker's grant resolves to, plus what its composition could not offer. */
interface ResolvedGrant {
  /** Sorted allow-list handed to `tools.restrict`: capability plane ∪ baseline plane ∪ preset plane. */
  readonly allow: readonly string[];
  /**
   * Baseline names this composition does not offer. Never fatal — the
   * composition never mounted them, so the filter has nothing to take away, and
   * demanding them would make composition-specific capabilities (the `bb-verify`
   * node, which mounts no shell) unspawnable.
   */
  readonly baselineUnavailable: readonly string[];
}
/**
 * Compute the allow-list one worker's grant resolves to against the surface its
 * composition offers.
 * @param agentCtx - the unpublished worker's scoped context (the only context `restrict()` accepts).
 * @param agent - the worker the scoped context belongs to.
 * @param grant - the resolved capability grant.
 * @throws when a capability-declared tool is not visible to this worker.
 */
declare function resolveGrant(agentCtx: Context, agent: Agent, grant: WorkerGrant): ResolvedGrant;
/**
 * Apply one worker's capability grant to its unpublished scoped world.
 * @param agentCtx - the worker's scoped context, minted by the agent factory.
 * @param agent - the worker, identified for error messages.
 * @param grant - the resolved grant from the task runtime.
 * @throws when a capability-declared tool is not visible to the worker, a
 *   declared skill resolves nowhere, an MCP server fails to start, or the
 *   tools registry rejects the filter.
 */
declare function applyWorkerGrant(agentCtx: Context, agent: Agent, grant: WorkerGrant): Promise<void>;
//#endregion
//#region src/skill-file.d.ts
/** One parsed `SKILL.md`: the frontmatter the registry needs plus the body. */
interface ParsedSkillFile {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
  };
  readonly content: string;
}
/**
 * Split `SKILL.md` text into its frontmatter fields and body. The frontmatter
 * grammar accepted here is the flat `key: value` one every skill in this
 * deployment uses; a nested structure fails loudly rather than being guessed at.
 */
declare function parseSkillFile(text: string, path: string): ParsedSkillFile;
/**
 * Locate the `SKILL.md` a granted skill name refers to under an explicit root
 * list, in the order given. The one search loop every discovery path shares:
 * {@link findSkillFile} runs it over a worker's own roots, and the task
 * runtime's provider pre-check runs it over the same roots with the replay
 * overlay's extra roots in front, so admission asks the question the spawn
 * will answer instead of restating the search.
 * @param roots - skill roots, searched in order.
 * @param name - the skill name a capability declares.
 * @returns the absolute path, or undefined when no root holds that skill.
 */
declare function findSkillFileIn(roots: readonly string[], name: string): Promise<string | undefined>;
/**
 * Every root {@link findSkillFile} searches, for an error message that tells the
 * operator where a granted skill should have been.
 */
declare function skillRootsFor(cwd: string | undefined): Promise<string[]>;
//#endregion
//#region src/index.d.ts
declare class AgentRuntime extends Service {
  static inject: string[];
  private readonly owned;
  private readonly roots;
  private readonly handles;
  private readonly scopes;
  private readonly operations;
  private readonly stopping;
  private closing;
  private readonly resuming;
  constructor(ctx: Context);
  ensureRoot(sessionId: SessionId, scope: GraphScope): Promise<AgentHandle>;
  private resumeRoot;
  createRoot(request: RootRequest): Promise<AgentHandle>;
  spawn(parent: Agent$1, request: SpawnRequest): Promise<AgentHandle>;
  stopGraph(scope: GraphScope): Promise<void>;
  stopAgents(sessionIds: readonly SessionId[]): Promise<void>;
  prompt(agent: Agent$1, prompt: readonly ContentBlock[]): Promise<void>;
  private inGraph;
  private live;
  private scope;
}
//#endregion
export { type AgentOptions, AgentRuntime, AgentRuntime as default, type CanvasNode, type ContentBlock, type GraphScope, type McpServerSpec, type ParsedSkillFile, type ResolvedGrant, type RootRequest, type SessionVisibility, type SpawnRequest, type WorkerCapabilityGrant, type WorkerGrant, applyWorkerGrant, findSkillFileIn, parseSkillFile, resolveGrant, skillRootsFor };
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
interface RuntimePromptSource {
  readonly kind: 'runtime-prompt';
  /** Which of this runtime's own doors wrote the message. */
  readonly channel: 'prompt' | 'spawn';
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-prompt': RuntimePromptSource;
  }
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
  /**
   * The first user message the child is prompted with. Optional because a
   * `taskWorker` spawn needs none: the agent runtime fills the default kickoff
   * ({@link WORKER_KICKOFF_TEXT}), and the worker's contract and state are the
   * context assembly's, not this message's. A spawn that is neither given a
   * prompt nor marked `taskWorker` is refused.
   */
  readonly prompt?: readonly ContentBlock[];
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
   * Declare the child a task worker (A2): the spawn setup installs the stable
   * worker policy section (`singularity:worker`, order 75 — the worker's
   * contract itself is the context assembly's `singularity:worker-contract`
   * section, injected from the store at every model request), and an absent
   * prompt becomes the default kickoff. Declared at spawn, not persisted: it
   * describes who this child is, and the store's records stay the authority on
   * what it works on.
   */
  readonly taskWorker?: boolean;
  /**
   * The one awaited door a caller gets between "the child is a published graph
   * member and its spawn was announced" and "the first model input is sent"
   * (A2 §D: the reviewer ledger is written and read back here, so a delegation
   * the context assembly can verify exists before any model request). The
   * callback receives nothing a model could have influenced. When it rejects,
   * the spawn fails the same way a publish failure does: the handle is
   * disposed, the graph node is marked failed, and no model input was sent.
   */
  readonly beforePrompt?: () => Promise<void>;
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
//#region src/prompts/worker.prompts.d.ts
/**
 * The worker role's stable policy (A2): the rules every task worker runs under,
 * whatever its task, its handoff, or this deployment's decomposition switch.
 *
 * What belongs here and nowhere else: unconditional behaviour. The contract,
 * the root briefing and the handoff are the context package's assembly
 * projection (`singularity:worker-contract`, order 80 — this section sits just
 * ahead of it), and the rules that depend on the task or the deployment (the
 * decomposable hint, the runtime-split rule, the review wait) are the same
 * projection's conditional part — one rule lives in exactly one of the two.
 *
 * Migrated from the old spawn prompt (`task-runtime`'s retired
 * `renderWorkerPrompt`), minus the session-tool guidance: history is read with
 * `context_read` now, and the raw cross-session readers that prompt pointed at
 * are sealed (`./raw-session-guard.ts`). As a system-prompt section this text is
 * what the loop reprojects into surface node 0, so the rules survive the folds
 * the old spawn prompt did not.
 */
/**
 * The worker policy, registered as the `singularity:worker` section (order 75)
 * of every spawn that declares `taskWorker`. Unconditional on purpose: anything
 * that could change with the task or the deployment is not written here.
 */
declare const WORKER_POLICY_TEXT: string;
/**
 * The first user message a task worker receives when its spawn carried no
 * prompt of its own. The kickoff points at the context, it does not replace it:
 * the contract and state are the store's, and this only says where to look.
 */
declare const WORKER_KICKOFF_TEXT: string;
//#endregion
//#region src/raw-session-guard.d.ts
/** The four raw cross-session readers no Singularity role may execute. */
declare const RAW_SESSION_READ_TOOLS: readonly string[];
/** The one denial reason every sealed call reports, by name. */
declare const RAW_SESSION_READ_DENIAL = "singularity: raw cross-session reads are sealed; use context_read";
/**
 * Deny the four readers on one agent's own scope, for the agent's whole life.
 * Registered through the agent's scoped context, so it travels with the agent
 * and touches no sibling; a scope chain re-evaluation cannot lift it, because
 * a guard has no allow answer.
 */
declare function sealRawSessionReads(agentCtx: Context): void;
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
export { type AgentOptions, AgentRuntime, AgentRuntime as default, type CanvasNode, type ContentBlock, type GraphScope, type McpServerSpec, type ParsedSkillFile, RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, type ResolvedGrant, type RootRequest, type RuntimePromptSource, type SessionVisibility, type SpawnRequest, WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT, type WorkerCapabilityGrant, type WorkerGrant, applyWorkerGrant, findSkillFileIn, parseSkillFile, resolveGrant, sealRawSessionReads, skillRootsFor };
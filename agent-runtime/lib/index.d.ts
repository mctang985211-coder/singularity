import { Context, Service } from "@deepseek-ai/cordis";
import { ContentBlock } from "@deepseek-ai/dsh-llm";
import { Session, SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import { AgentStatus } from "@dangosys/dsh-singularity-graph";
import { Agent, AgentHandle, AgentOptions, AgentOptions as AgentOptions$1, AgentSetup } from "@deepseek-ai/dsh-agent";
import { SessionEventReadRequest, SessionEventWindow, SessionLogSnapshot } from "@deepseek-ai/dsh-session-query";

//#region src/messages.d.ts
/** Why one delivery or source read was refused; every refusal is named for the caller's next move. */
type MessageRefusalCode = /** The cited Session holds no event at the cited seq. */
'source-event-missing'
/** The cited Session does not exist. */ | 'source-session-missing'
/** The cited Session exists but could not be read. */ | 'source-unreadable'
/** The cited Session's log has no durability barrier, so its body cannot be witnessed. */ | 'source-not-durable'
/** The cited event is not the `tool/call` it is cited as. */ | 'source-not-tool-call'
/** The target Session's log could not be read, so whether the message was accepted cannot be decided. */ | 'target-unreadable'
/** The target Session has no durability barrier (or is no longer live in this process). */ | 'target-not-durable'
/** Delivery was attempted but the identity is not in the target's log afterwards. */ | 'delivery-unconfirmed';
/** Where a message body was written: the sending Session and the seq of its `tool/call`. */
interface ToolCallRef {
  /** The sending Session — the Session the cited `tool/call` event lives in. */
  readonly sessionId: SessionId;
  /** The seq of that event in the sending Session's log. */
  readonly seq: number;
}
/** The body at a cited `tool/call`: the tool name and the raw arguments text. */
interface ToolCallBody {
  /** The tool the model called. */
  readonly name: string;
  /** The `arguments` JSON text exactly as the model produced it, unparsed here. */
  readonly arguments: string;
}
/** One message the Task store has already decided to deliver: identity, the two Sessions, and the text. */
interface AgentMessageIntent {
  /** The Session that must receive the message. */
  readonly targetSessionId: SessionId;
  /** The Session whose agent authored the body. */
  readonly senderSessionId: SessionId;
  /** The durable message identity the Task store recorded. */
  readonly messageId: string;
  /** The model-facing body, identity included (see {@link questionMessageText}). */
  readonly text: string;
}
/** What one delivery attempt settled as: `delivered`, `already-present`, or `unavailable` (nothing attempted). */
type MessageDeliveryStatus = 'delivered' | 'already-present' | 'unavailable';
/** The settled outcome of one delivery attempt. */
interface MessageDelivery {
  /** The identity this attempt addressed. */
  readonly messageId: string;
  readonly status: MessageDeliveryStatus;
}
/** One record of a reconciliation pass: what each intent of the set settled as. */
interface MessageDeliveryReport {
  /** The identity this record addressed. */
  readonly messageId: string;
  /** The settled status, or `refused` when the attempt could not be decided at all. */
  readonly status: MessageDeliveryStatus | 'refused';
  /** Why the attempt was refused; present only with `refused`. */
  readonly reason?: string;
}
/** The services one delivery reaches, narrowed to the three capabilities `./messages.ts` declares and no more. */
interface MessageDeliveryDeps {
  /** Live agents by Session id — the only registry a delivery reaches a target through. */
  readonly agents: {
    get(id: SessionId): Agent | undefined;
  };
  /** Live sessions: `get` decides whether there is anything to flush, `flush` is the barrier. */
  readonly sessions: {
    get(id: SessionId): Session | undefined;
    flush(session: Session): Promise<boolean>;
  };
  /** The session read path: exact event reads and live-preferred whole-log folds. */
  readonly sessionQuery: {
    readEvent(request: SessionEventReadRequest): Promise<SessionEventWindow>;
    readSession(sessionId: SessionId): Promise<SessionLogSnapshot>;
  };
}
/** The message body a question carries into its parent's Session: the stable question identity, then what was asked. */
declare function questionMessageText(questionId: string, question: string): string;
/** The message body an answer carries into the asking Session: both identities, then what the parent answered. */
declare function answerMessageText(answerId: string, questionId: string, answer: string): string;
/** The part of one Session's log the citation lookup needs, written structurally. */
interface SessionOwnLog {
  /** The Session the events belong to; its id is the citation's `sessionId`. */
  readonly session: {
    readonly id: SessionId;
  };
  /** How many leading events came from the fork's ancestor and are not this Session's own. */
  readonly inheritedEventCount: number;
  /** The log's events, in seq order. */
  readonly events: readonly SessionEvent[];
}
/** The citation of one `tool/call` inside a Session's own suffix, found by the call id (last event wins). */
declare function toolCallRefIn(log: SessionOwnLog, callId: string): ToolCallRef | undefined;
//#endregion
//#region src/types.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntime: AgentRuntime;
  }
  interface Events {
    'agentRuntime/spawned'(event: {
      parentId: SessionId;
      sessionId: SessionId;
    }): void;
  }
}
/** Durable attribution for one prompt this runtime wrote to a session of its own (A0 §1.10, README Design notes). */
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
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly scope: GraphScope;
  readonly agentOptions?: AgentOptions$1;
  readonly agentPreset?: string;
}
interface GraphScope {
  readonly graphStoreId: string;
  readonly layoutStoreId: string;
}
/** One capability's grant, already resolved by the task runtime: tool LABELS are expanded to real DSH names. */
interface WorkerCapabilityGrant {
  /** Capability name the grant came from; every rejection this grant causes names it. */
  readonly capability: string;
  /** Real DSH tool names the capability declares; each must be visible to the worker or the spawn fails. */
  readonly tools: readonly string[];
  /** Skill names the capability declares; each must resolve to a SKILL.md or the spawn fails. */
  readonly skills: readonly string[];
}
/** One MCP server to mount on the worker's own scope, fully resolved by the task runtime. */
interface McpServerSpec {
  /** Namespace the server's tools publish under; unique per worker. */
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
/** What one spawned worker is authorized with; a spawn with no grant keeps its composition's surface. */
interface WorkerGrant {
  /** Capability plane: the tools/skills the worker's capabilities declare. */
  readonly capabilities: readonly WorkerCapabilityGrant[];
  /** Baseline plane: tools the worker's prompt needs whatever its capabilities are, intersected with the surface. */
  readonly baseline: readonly string[];
  /** Whether the mounted agent preset's own tool plane stays (a capability named its own preset). */
  readonly keepPresetTools: boolean;
  /** Extra skill roots searched before production discovery, for this worker only (the replay overlay). */
  readonly skillRoots?: readonly string[];
  /** MCP servers the worker's capabilities grant, mounted after the tool restriction is computed. */
  readonly mcpServers?: readonly McpServerSpec[];
}
interface SpawnRequest {
  readonly sessionId: SessionId;
  readonly name: string;
  /** First user message; optional for a `taskWorker`, which gets the default kickoff. */
  readonly prompt?: readonly ContentBlock[];
  readonly agentOptions?: AgentOptions$1;
  /** Capability-derived authorization applied to the child before publication. Absent = none decided it. */
  readonly grant?: WorkerGrant;
  /** Preset id mounted for the child, overriding the inherit-the-parent default. */
  readonly agentPreset?: string;
  /** Permission preset applied to the child's session, overriding the `danger-full-access` default posture. */
  readonly permissionPreset?: string;
  /** Working directory the child starts in, replacing the inherit-the-parent default; absent keeps the parent's. */
  readonly cwd?: string;
  /** Declare the child a task worker: install the stable policy section and default the kickoff. */
  readonly taskWorker?: boolean;
  /** Coordination roles install their own stable policy instead of a preset persona. */
  readonly coordinationRole?: 'reviewer' | 'supervisor';
  /** One awaited door between publication + announcement and the first model input. */
  readonly beforePrompt?: () => Promise<void>;
  readonly signal?: AbortSignal;
}
/** The Run facts a caller read from its own store for the Session it is bringing back (A4 §F.1). */
interface WorkerRunFacts {
  /** The store the Run belongs to. */
  readonly storeId: string;
  readonly taskId: string;
  readonly runId: string;
  /** The Session the store's own Run record binds — must be the Session being resumed. */
  readonly sessionId: SessionId;
  /** The preset the Run was admitted with, when the store recorded one. */
  readonly agentPreset?: string;
  /** `TaskRun.capabilitySnapshot`: the granted tools, skills and `mcp:<serverName>` markers, flattened. */
  readonly capabilitySnapshot: readonly string[];
}
/** One controlled resume of a spawned worker's persisted Session (A4 §F.1); it comes back identical and idle. */
interface WorkerResumeRequest {
  /** The persisted Session to bring back live; the identity the spawn created. */
  readonly sessionId: SessionId;
  /** The graph the Session was published in — the scope its spawn ran under. */
  readonly scope: GraphScope;
  /** The Run the caller holds for this Session, as the store records it. */
  readonly run: WorkerRunFacts;
  /** The grant the Run was spawned with, resolved by the caller as the spawn resolved it. */
  readonly grant?: WorkerGrant;
  /** The permission preset the Run was admitted under; absent = the spawn's default. */
  readonly permissionPreset?: string;
  /** Whether the Session was spawned as a task worker; required, because the durable record carries no flag. */
  readonly taskWorker: boolean;
  /** Per-agent options for the resumed agent, overriding the runtime's default selection. */
  readonly agentOptions?: AgentOptions$1;
}
//#endregion
//#region src/grants.d.ts
/** The tool surface one worker's grant resolves to, plus what its composition could not offer. */
interface ResolvedGrant {
  /** Sorted allow-list handed to `tools.restrict`: capability plane ∪ baseline plane ∪ preset plane. */
  readonly allow: readonly string[];
  /** Baseline names this composition does not offer; never fatal, the composition mounted nothing to take away. */
  readonly baselineUnavailable: readonly string[];
}
/** Apply one worker's grant: restrict tools, register skills, mount MCP servers — all fail-closed. */
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
/** Split `SKILL.md` text into its flat `key: value` frontmatter fields and body; nested lines fail loudly. */
declare function parseSkillFile(text: string, path: string): ParsedSkillFile;
/** Skill roots for a worker working in `cwd`: its own project first, then the deployment's user roots. */
declare function skillRootsFor(cwd: string | undefined): Promise<string[]>;
/** Locate the `SKILL.md` a granted skill name refers to under an explicit root list, in the given order. */
declare function findSkillFileIn(roots: readonly string[], name: string): Promise<string | undefined>;
//#endregion
//#region src/prompts/worker.prompts.d.ts
/** The worker role's stable policy (A2), registered as the `singularity:worker` section (order 75). */
declare const WORKER_POLICY_TEXT: string;
/** The first user message a task worker receives when its spawn carried no prompt of its own. */
declare const WORKER_KICKOFF_TEXT: string;
//#endregion
//#region src/raw-session-guard.d.ts
/** The four raw cross-session readers no Singularity role may execute. */
declare const RAW_SESSION_READ_TOOLS: readonly string[];
/** The one denial reason every sealed call reports, by name. */
declare const RAW_SESSION_READ_DENIAL = "singularity: raw cross-session reads are sealed; use context_read";
//#endregion
//#region src/worker-resume.d.ts
/** The composition one worker's scoped world is built from, computed by the runtime and reused verbatim. */
interface WorkerRole {
  /** The agent preset mounted for this worker. */
  readonly agentPreset: string;
  /** The permission preset applied to this worker's session. */
  readonly permissionPreset: string;
  /** Declare this worker a task worker: its stable policy section is installed. */
  readonly taskWorker: boolean;
  readonly coordinationRole?: 'reviewer' | 'supervisor';
  /** The resolved capability grant, when the run was admitted with one. */
  readonly grant?: WorkerGrant;
}
/** Why one resume refused, named for the caller's next move; a refusal leaves every store as it was. */
type WorkerResumeRefusalCode = /** No such persisted Session. */
'session-missing'
/** The Session exists but its log could not be read, so it cannot be taken over safely. */ | 'session-unreadable'
/** A live agent already owns the Session; retryable once that owner settles. */ | 'ownership-conflict'
/** The declared Run, grant or permission contradicts the Session's own durable record. */ | 'binding-mismatch'
/** The graph store does not publish this Session as a member. */ | 'not-in-graph'
/** The Session is a member, but the delegation facts a worker resume needs are absent. */ | 'member-facts-missing'
/** The resume itself refused the Session (interrupted-turn repair, replay validation, write lease). */ | 'takeover-refused';
/** One refused resume, with the stable name of what could not be established. */
declare class WorkerResumeRefusal extends Error {
  readonly code: WorkerResumeRefusalCode;
  constructor(code: WorkerResumeRefusalCode, message: string, options?: ErrorOptions);
}
/** What one resume reads and what it resumes through, narrowed to the capabilities it actually uses. */
interface WorkerResumeDeps {
  /** Live agents by Session id — the ownership check, and the resume door. */
  readonly agents: {
    get(id: SessionId): Agent | undefined;
    resume(options: {
      resumeSessionId: SessionId;
      agentOptions?: AgentOptions$1;
      setup?: AgentSetup;
    }): Promise<AgentHandle>;
  };
  /** The persisted Session's own record: the header (preset, lineage) and the log's own events. */
  readonly sessionQuery: {
    readSession(sessionId: SessionId): Promise<SessionLogSnapshot>;
  };
  /** The graph store: membership, the delegation edge, and the node status a resume repairs. */
  readonly graph: {
    snapshotIn(storeId: string): Promise<{
      readonly roots: readonly SessionId[];
      readonly agents: readonly {
        readonly id: SessionId;
        readonly status: AgentStatus;
      }[];
      readonly edges: readonly {
        readonly kind: string;
        readonly from: SessionId;
        readonly to: SessionId;
      }[];
    }>;
    setStatusIn(storeId: string, sessionId: SessionId, status: AgentStatus): Promise<void>;
  };
  /** Compose one worker's scoped world — the caller's own spawn composition, reused verbatim. */
  readonly setup: (role: WorkerRole) => AgentSetup;
  /** The per-agent options the resumed agent runs under (the runtime's default selection plus the request's own). */
  readonly agentOptions?: AgentOptions$1;
}
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
  spawn(parent: Agent, request: SpawnRequest): Promise<AgentHandle>;
  /** Bring one spawned worker's persisted Session back live and idle; refusals are named (A4 §F.1). */
  resumeWorkerAgent(request: WorkerResumeRequest): Promise<AgentHandle>;
  stopGraph(scope: GraphScope): Promise<void>;
  stopAgents(sessionIds: readonly SessionId[]): Promise<void>;
  prompt(agent: Agent, prompt: readonly ContentBlock[]): Promise<void>;
  /** Read back the body of a `tool/call` a question or answer cites, flushing the sender first (A4 §F.1). */
  readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody>;
  /** Deliver one already-committed message identity at most once and report what the target log witnesses. */
  ensureAgentMessageDelivered(intent: AgentMessageIntent): Promise<MessageDelivery>;
  /** Reconcile a set of committed intents against their target Sessions, one at a time (A4 §F.1). */
  reconcileAgentMessageDeliveries(intents: readonly AgentMessageIntent[]): Promise<MessageDeliveryReport[]>;
  private deliveryDeps;
  /** What one worker resume reaches: the live registry, the session read path, the graph store, composition and options. */
  private workerResumeDeps;
  private inGraph;
  /** Forget one session this runtime was composing; only a handle this attempt owns is unregistered and disposed. */
  private releaseSession;
  private live;
  private scope;
}
//#endregion
export { type AgentMessageIntent, type AgentOptions, AgentRuntime, AgentRuntime as default, type GraphScope, type McpServerSpec, type MessageDelivery, type MessageDeliveryDeps, type MessageDeliveryReport, type MessageDeliveryStatus, type MessageRefusalCode, RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, type ResolvedGrant, type RootRequest, type RuntimePromptSource, type SessionOwnLog, type SpawnRequest, type ToolCallBody, type ToolCallRef, WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT, type WorkerCapabilityGrant, type WorkerGrant, type WorkerResumeDeps, WorkerResumeRefusal, type WorkerResumeRefusalCode, type WorkerResumeRequest, type WorkerRole, type WorkerRunFacts, answerMessageText, applyWorkerGrant, findSkillFileIn, parseSkillFile, questionMessageText, skillRootsFor, toolCallRefIn };
import { Context, Service } from "@deepseek-ai/cordis";
import { ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionEvent, SessionId, SessionId as SessionId$1 } from "@deepseek-ai/dsh-session";
import { CanvasNode } from "@dangosys/dsh-singularity-layout";
import { Agent, Agent as Agent$1, AgentHandle, AgentHandle as AgentHandle$1, AgentOptions, AgentOptions as AgentOptions$1, AgentSetup } from "@deepseek-ai/dsh-agent";
import { AgentStatus } from "@dangosys/dsh-singularity-graph";
import { SessionEventReadRequest, SessionEventWindow, SessionLogSnapshot } from "@deepseek-ai/dsh-session-query";

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
/**
 * The Run facts a caller read from its own store for the Session it is bringing
 * back (A4 §F.1's recovery entry). Structural on purpose: this package holds no
 * task dependency — the store is the runtime's — so these are the fields
 * `TaskRun` records, named the way it names them, and nothing here is guessed
 * by the resume. Every one of them is checked against the Session's own durable
 * record before anything is written.
 */
interface WorkerRunFacts {
  /** The store the Run belongs to. */
  readonly storeId: string;
  readonly taskId: string;
  readonly runId: string;
  /** The Session the store's own Run record binds — must be the Session being resumed. */
  readonly sessionId: SessionId$1;
  /** The preset the Run was admitted with, when the store recorded one. */
  readonly agentPreset?: string;
  /**
   * What the Run was admitted with (`TaskRun.capabilitySnapshot`: the granted
   * tools, skills and `mcp:<serverName>` markers, flattened). Required because
   * the store records it for every Run: a resume that cannot show the plane the
   * Run was admitted under would be reinstalling a tool face nobody authorized.
   */
  readonly capabilitySnapshot: readonly string[];
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
interface WorkerResumeRequest {
  /** The persisted Session to bring back live; the identity the spawn created. */
  readonly sessionId: SessionId$1;
  /** The graph the Session was published in — the scope its spawn ran under. */
  readonly scope: GraphScope;
  /** The Run the caller holds for this Session, as the store records it. */
  readonly run: WorkerRunFacts;
  /** The grant the Run was spawned with, resolved by the caller as the spawn resolved it. */
  readonly grant?: WorkerGrant;
  /**
   * The permission preset the Run was admitted under. Absent = the spawn's own
   * default ({@link WORKER_DEFAULT_PERMISSION_PRESET}).
   */
  readonly permissionPreset?: string;
  /**
   * Whether the Session was spawned as a task worker. Required, not defaulted:
   * the durable record does not carry the flag, and a resume that guessed would
   * either drop the worker policy the prompt ran under or add one it never had.
   */
  readonly taskWorker: boolean;
  /** Per-agent options for the resumed agent, overriding the runtime's default selection. */
  readonly agentOptions?: AgentOptions;
}
//#endregion
//#region src/messages.d.ts
/**
 * Why one delivery or source read was refused. Every refusal is named: a caller
 * that cannot act on the difference between "not there yet" and "cannot be
 * decided" would retry the wrong thing.
 */
type MessageRefusalCode = /** The cited Session holds no event at the cited seq. */
'source-event-missing'
/** The cited Session does not exist. */ | 'source-session-missing'
/** The cited Session exists but could not be read. */ | 'source-unreadable'
/** The cited Session's log has no durability barrier, so its body cannot be witnessed. */ | 'source-not-durable'
/** The cited event is not the `tool/call` it is cited as. */ | 'source-not-tool-call'
/** The target Session's log could not be read, so whether the message was accepted cannot be decided. */ | 'target-unreadable'
/** The target Session has no durability barrier (or is no longer live in this process). */ | 'target-not-durable'
/** Delivery was attempted but the identity is not in the target's log afterwards. */ | 'delivery-unconfirmed';
/** One refused source read or delivery, with the stable name of what went wrong. */
declare class MessageDeliveryRefusal extends Error {
  readonly code: MessageRefusalCode;
  constructor(code: MessageRefusalCode, message: string, options?: ErrorOptions);
}
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
/**
 * One message the Task store has already decided to deliver: the durable
 * identity, the two Sessions, and the text. Everything about it is a record the
 * store holds, so a retry after a restart states the same delivery.
 */
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
/**
 * What one delivery attempt settled as.
 *
 * `delivered` — this call put the identity into the target's log and the target
 * was flushed; `already-present` — the target's log already held the identity,
 * so this call wrote nothing (a retry, or a concurrent attempt that won the
 * race); `unavailable` — no live agent owns the target, nothing was attempted.
 */
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
/**
 * The services a delivery needs, narrowed to what it actually calls: the live
 * agent registry it can wake, the session store whose `flush` is the durability
 * barrier, and the session read path it folds. No service resolves another one
 * through this module, and a caller can hand a test double for any of them.
 */
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
/**
 * The message body an answer carries into the asking Session: both identities,
 * so the receiving model can tell which answer resolves which question without
 * a second lookup, then what the parent answered.
 */
declare function answerMessageText(answerId: string, questionId: string, answer: string): string;
/**
 * Build the identified, frozen relay message one intent delivers. Pure and
 * exported so a caller can inspect the exact representation it is about to
 * write; nothing here reaches the Task store or the Session.
 */
declare function relayMessage(intent: AgentMessageIntent): UserMessage;
/**
 * Whether a Session's own event suffix already holds one message identity, in
 * history or still pending in the inbox. `events` must be the Session's own
 * suffix (its fork-inherited prefix belongs to the Session it descends from and
 * is not a delivery to this one).
 *
 * This is the *retry* rule: an identity a claim already removed and history
 * never took is not accepted, because the model never saw it and the recovery
 * path must deliver it again (§F.1: "claim 在 pre-step 前可能已移除").
 */
declare function messageAccepted(events: readonly SessionEvent[], messageId: string): boolean;
/**
 * Read back the body of a cited `tool/call`: the evidence behind a question or an
 * answer, straight from the Session that sent it.
 *
 * A live Session is flushed first — the cited event must be durable before the
 * Task store commits an intent that cites it, because recovery reads the body
 * from the log and a body that only ever existed in a write buffer is not a
 * source. Refusals are named: an absent Session, an absent seq, an unreadable
 * Session, a Session with no durability barrier, and an event that is not the
 * `tool/call` it is cited as are five different things, and a caller that
 * cannot tell them apart would record the wrong fact.
 */
declare function readToolCallBody(deps: MessageDeliveryDeps, ref: ToolCallRef): Promise<ToolCallBody>;
/**
 * The part of one Session's log a citation lookup needs: the Session it belongs
 * to, how many of its leading events are fork-inherited, and the events. Written
 * structurally so a caller that holds a Session log — this package's own
 * `SessionLogSnapshot`, or a reader that only kept these three fields — can be
 * searched without this module importing the query engine's types.
 */
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
/**
 * The citation of one `tool/call` inside a Session's *own* event suffix, found
 * by the call id the tool layer holds (A4 §F.1).
 *
 * Why the caller needs this at all: the body of a question or an answer is the
 * sender's own tool call, and the durable citation into it is a `(session, seq)`
 * pair, while what a tool call has in hand is its registration id
 * ({@link ToolCallRef} is what {@link readToolCallBody} takes). This is that
 * translation, as a pure read of a Session log the caller already has, so the
 * lookup rule — own suffix only, the *last* event for an id — lives beside the
 * citation type instead of in each caller.
 *
 * The suffix rule is the delivery fold's ({@link ownSuffix}): a fork-inherited
 * prefix belongs to the Session this one descends from, and a call made there is
 * not a call this Session made. The last event wins because a log is append-only
 * and an id — were it ever re-dispatched — would be answered by its latest
 * durable record.
 */
declare function toolCallRefIn(log: SessionOwnLog, callId: string): ToolCallRef | undefined;
/**
 * Put one already-decided message into the target Session's inbox, at most once.
 *
 * Order: reconcile, then relay, then flush, then confirm. Reconcile-first is
 * what makes a retry harmless — a message already pending or already in history
 * is reported `already-present` without touching the inbox. The relay is
 * `agent.steer`, not `followup`: an answer must reach the target's next model
 * request, including one that is mid-turn (a followup would queue it behind the
 * current turn), and an idle target still opens a turn, which is what a question
 * addressed to a settled parent needs to be answered at all.
 *
 * The confirmation after the flush is deliberately wider than the retry fold
 * ({@link messageRecorded}): a target whose turn is already consuming the
 * message claims it out of the inbox before history takes it, and that window
 * must not be reported as a failed delivery. What `delivered` claims is exactly
 * what the log shows — the Session durably recorded this identity — never that
 * the model read it.
 *
 * A target with no live agent is `unavailable` before anything else happens: no
 * offline write, no resume, no substitute parent — the intent survives in the
 * Task store, and the recovery path is what brings the target back and calls
 * this again.
 */
declare function ensureAgentMessageDelivered(deps: MessageDeliveryDeps, intent: AgentMessageIntent): Promise<MessageDelivery>;
/**
 * Reconcile a set of committed intents against the Sessions that hold them,
 * delivering exactly the ones that are missing (§F.1: "恢复只补缺失投递").
 *
 * This is the entry point A4's recovery path calls with the records the Task
 * store holds: it owns no ledger of its own (the delivered fact *is* the
 * target's fold, and a second record could disagree with it), it never rewrites
 * an intent, and it reports each record separately so one unreachable parent
 * cannot hide the others. Intents are delivered in the order given, so the
 * target's inbox keeps the order the caller recorded.
 */
declare function reconcileAgentMessageDeliveries(deps: MessageDeliveryDeps, intents: readonly AgentMessageIntent[]): Promise<MessageDeliveryReport[]>;
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
//#region src/worker-resume.d.ts
/**
 * The permission posture a worker runs under when nobody decided one for it —
 * the spawn's own default (`index.ts`, the shared worker setup), named here
 * because the resume must state the same posture it is checking against.
 */
declare const WORKER_DEFAULT_PERMISSION_PRESET = "danger-full-access";
/**
 * The composition one worker's scoped world is built from. Internal seam: the
 * runtime computes it (from a spawn request, or from a resume's checked facts)
 * and hands the same function to the agent factory either way, which is what
 * makes a resumed worker's preset, prompt, tool face, permission and seal the
 * ones its spawn had.
 */
interface WorkerRole {
  /** The agent preset mounted for this worker. */
  readonly agentPreset: string;
  /** The permission preset applied to this worker's session. */
  readonly permissionPreset: string;
  /** Declare this worker a task worker: its stable policy section is installed. */
  readonly taskWorker: boolean;
  /** The resolved capability grant, when the run was admitted with one. */
  readonly grant?: WorkerGrant;
}
/**
 * Why one resume refused, named for the caller's next move. Everything except
 * `takeover-refused` is a source check decided by reading: a refusal leaves the
 * store, the Session log, the graph and the handle map exactly as they were.
 * `takeover-refused` is DSH's own refusal to take the Session over (crash
 * repair or replay validation, and the write lease under `ownership-conflict`),
 * which this module reports and never works around by creating another Session.
 */
type WorkerResumeRefusalCode = /** No such persisted Session. */
'session-missing'
/** The Session exists but its log could not be read, so it cannot be taken over safely. */ | 'session-unreadable'
/**
 * A live agent — this runtime's handle or another owner's registration —
 * already owns the Session. Retryable once that owner settles; never resolved
 * by resuming under a second owner.
 */ | 'ownership-conflict'
/** The declared Run, grant or permission contradicts the Session's own durable record. */ | 'binding-mismatch'
/** The graph store does not publish this Session as a member. */ | 'not-in-graph'
/** The Session is a member, but the delegation facts a worker resume needs are absent. */ | 'member-facts-missing'
/** The resume itself refused the Session (interrupted-turn repair, replay validation, write lease). */ | 'takeover-refused';
/** One refused resume, with the stable name of what could not be established. */
declare class WorkerResumeRefusal extends Error {
  readonly code: WorkerResumeRefusalCode;
  constructor(code: WorkerResumeRefusalCode, message: string, options?: ErrorOptions);
}
/**
 * What one resume reads and what it resumes through, narrowed to the four
 * capabilities it actually uses. No service resolves another one through this
 * module, and a caller can replace any of them for a test.
 */
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
  /**
   * The persisted Session's own record: the header (preset, lineage) and the
   * log's own events (the permission the Session actually ran under). The
   * deployment's read path is used, not a second reader over the artifact.
   */
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
declare function resumeWorkerAgent(deps: WorkerResumeDeps, request: WorkerResumeRequest): Promise<AgentHandle>;
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
  ensureRoot(sessionId: SessionId, scope: GraphScope): Promise<AgentHandle$1>;
  private resumeRoot;
  createRoot(request: RootRequest): Promise<AgentHandle$1>;
  spawn(parent: Agent$1, request: SpawnRequest): Promise<AgentHandle$1>;
  /**
   * Bring one spawned worker's persisted Session back live (A4 §F.1), through
   * the recovery entry `./worker-resume.ts` documents: the same Session, the
   * same composition (the shared `workerSetup` below, which `spawn` also hands
   * the agent factory), the same grant, seal and permission — and **idle**.
   * Nothing is sent to the model here; the caller wakes the Session when it has
   * something to deliver (§F.1: "恢复后由调用方决定何时 steer").
   *
   * The handle lands in the same `handles` map a spawn's product does, so
   * `stopAgents`/`stopGraph` and the session-visibility rule treat a resumed
   * worker exactly as they treat a spawned one. There is no second roster, no
   * second mailbox and no second handle table: this entry owns nothing the
   * spawn path does not already own.
   * @param request - the Session, its graph scope, the Run facts the caller read
   *   from its store, and the authorization the Run was admitted with.
   * @returns the live handle of the same Session, idle.
   * @throws WorkerResumeRefusal with the stable code of what could not be established.
   */
  resumeWorkerAgent(request: WorkerResumeRequest): Promise<AgentHandle$1>;
  stopGraph(scope: GraphScope): Promise<void>;
  stopAgents(sessionIds: readonly SessionId[]): Promise<void>;
  prompt(agent: Agent$1, prompt: readonly ContentBlock[]): Promise<void>;
  /**
   * Read back the body of a `tool/call` one question or answer cites (A4 §F.1),
   * flushing the sending Session first so the citation names a durable event.
   * Thin adapter over {@link readToolCallBody}: this class owns the handle and the
   * context, the delivery rules own themselves (`./messages.ts`).
   * @param ref - the sending Session and the seq of its `tool/call`.
   * @returns the tool name and the raw arguments text the model produced.
   * @throws MessageDeliveryRefusal with the named reason the citation is unusable.
   */
  readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody>;
  /**
   * Deliver one already-committed message identity into its target Session's
   * inbox, at most once, and report what that Session's log can witness. Called
   * by the question protocol after the Task store committed the intent (A4's
   * third sub-goal); re-calling it after a crash delivers only what is missing.
   * @param intent - the recorded identity, the two Sessions, and the body.
   * @returns the settled status: `delivered`, `already-present`, or `unavailable`.
   * @throws MessageDeliveryRefusal when the attempt cannot be decided or confirmed.
   */
  ensureAgentMessageDelivered(intent: AgentMessageIntent): Promise<MessageDelivery>;
  /**
   * Reconcile a set of committed intents against their target Sessions, one at a
   * time, and report each record's outcome — the recovery path's entry point
   * (§F.1). No ledger of its own: the delivered fact is each target's own fold.
   * @param intents - the records the Task store holds, in delivery order.
   * @returns one report per record; a refused record names why.
   */
  reconcileAgentMessageDeliveries(intents: readonly AgentMessageIntent[]): Promise<MessageDeliveryReport[]>;
  /**
   * The services one delivery reaches, resolved to the three capabilities
   * `./messages.ts` declares and no more: this class's own fields stay private,
   * and a service the module never calls is never handed to it.
   */
  private deliveryDeps;
  /**
   * The one composition a worker's scoped world is built from. `spawn` and
   * {@link resumeWorkerAgent} both hand this to the agent factory, so a resumed
   * worker is composed exactly as its spawn composed it (A4 §F.1: same preset,
   * same permission posture, same policy prompt, same grant, same seal) — and
   * this package holds one worker composition, not a spawn flavor and a
   * recovery flavor that could drift apart.
   */
  private workerSetup;
  /**
   * What one worker resume reaches: the live registry, the deployment's own
   * session read path, the graph store, this runtime's worker composition, and
   * the model selection a spawn would run under.
   */
  private workerResumeDeps;
  private inGraph;
  private live;
  private scope;
}
//#endregion
export { type AgentMessageIntent, type AgentOptions, AgentRuntime, AgentRuntime as default, type CanvasNode, type ContentBlock, type GraphScope, type McpServerSpec, type MessageDelivery, type MessageDeliveryDeps, MessageDeliveryRefusal, type MessageDeliveryReport, type MessageDeliveryStatus, type MessageRefusalCode, type ParsedSkillFile, RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, type ResolvedGrant, type RootRequest, type RuntimePromptSource, type SessionOwnLog, type SessionVisibility, type SpawnRequest, type ToolCallBody, type ToolCallRef, WORKER_DEFAULT_PERMISSION_PRESET, WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT, type WorkerCapabilityGrant, type WorkerGrant, type WorkerResumeDeps, WorkerResumeRefusal, type WorkerResumeRefusalCode, type WorkerResumeRequest, type WorkerRole, type WorkerRunFacts, answerMessageText, applyWorkerGrant, ensureAgentMessageDelivered, findSkillFileIn, messageAccepted, parseSkillFile, questionMessageText, readToolCallBody, reconcileAgentMessageDeliveries, relayMessage, resolveGrant, resumeWorkerAgent, sealRawSessionReads, skillRootsFor, toolCallRefIn };
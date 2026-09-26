import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, AdmissionContext, ArtifactRef, CapabilityManifest, ChildEvidenceRef, DecompositionAdmission, DecompositionIdentity, DependencyEdge, EvidenceBundle, ExecutionPhase, Obligation, ProtectedInputRef, QuestionAnswer, QuestionAnswerRecord, QuestionAsk, QuestionMessageRef, QuestionRecord, ReviewCriterion, ReviewTokenUsage, ReviewToolCall, RunId, RunProviderBinding, RunSkillBinding, RunStatus, TaskContract, TaskContractVersion, TaskHandoff, TaskId, TaskInstance, TaskProposal, TaskProposalDecisionOutcome, TaskProposalPolicy, TaskProposalReviewContext, TaskProposalStatus, TaskProposalVerifierIdentity, TaskRun, TaskService, TaskSnapshot, VerificationMode } from "@dangosys/dsh-singularity-task";
import { AgentMessageIntent, AgentOptions, McpServerSpec, MessageDeliveryReport, MessageDeliveryStatus, SessionOwnLog, ToolCallBody, ToolCallRef, WorkerGrant } from "@dangosys/dsh-singularity-agent-runtime";
import { AgentHandle } from "@deepseek-ai/dsh-agent";

//#region src/capability.d.ts
/** One capability entry as held in plugin Config (arrays optional pre-validation). */
interface CapabilityConfig {
  skills?: string[];
  tools?: string[];
  preset?: string;
  /** Permission preset (`permissionPresets` table key) granted when a task requires this capability. */
  permission?: string;
  /**
   * MCP server names (keys of `MCP_SERVER_REGISTRY` in `./mcp-servers.ts`)
   * granted when a task requires this capability; each mounts as one
   * mcp-client instance on the worker's own scope at spawn, bound to that
   * run's env checkout. Unknown names reject the resolution, exactly like
   * unknown tool labels.
   */
  mcpServers?: string[];
}
/**
 * Capability tool labels → the real DSH tool names each label grants.
 *
 * A capability table is authored against what the WORK needs, not against
 * whichever names a given harness release registers: `filesystem` stays
 * `filesystem` while DSH's file tools are `read`/`write`/`edit`. This table is
 * the whole vocabulary — a label outside it is rejected at admission — and its
 * values are the names that reach the worker's tool filter. Each value is the
 * `name` the registering tool plugin declares:
 *
 * | label             | registers in                                                        |
 * | ----------------- | ------------------------------------------------------------------- |
 * | filesystem        | `fs/tool-fs` (`read.ts:78`, `write.ts:73`, `edit.ts:85`)             |
 * | search            | `fs/tool-fs-search` (`glob.ts:313`, `grep.ts:285`)                  |
 * | bash              | `shell/tool-bash` (`index.ts:242`)                                  |
 * | jobs              | `jobs/tool-jobs` (`index.ts:302,342,362`)                           |
 * | skill             | `skill/tool-skill` (`index.ts:82`)                                  |
 * | ask-user          | `interaction/tool-ask-user` (`index.ts:21`)                         |
 * | web               | `web/tool-web` (`fetch.ts:459`, `search.ts:326`)                    |
 * | todo              | `todo/tool-todo` (`index.ts:147`)                                   |
 * | goal              | `goal/tool-goal` (`index.ts:195,207,234`)                           |
 * | subagent          | `subagent/tool-subagent` (`index.ts:380`), `.../tool-subagent-control` (`index.ts:29,77`, `list-agents.ts:93`) |
 *
 * Paths are relative to `thirdparty/deepseek-harness/packages/`. The raw
 * cross-session readers (`session_event_read` and its siblings) are deliberately
 * NOT a label: A2 sealed them off every Singularity role's surface — history is
 * read through `context_read`, whose caller-side authorization is the graph
 * domain, not a cwd.
 *
 * A label only carries names a composition can be expected to mount; a
 * capability-declared name the worker's own composition does not offer fails
 * that spawn loudly (`agent-runtime/src/grants.ts`), which is the point — the
 * capability asked for a tool the composition cannot give. `read_image` is
 * deliberately NOT in `filesystem`: `tool-fs` registers it only while
 * `attachments` is mounted (`fs/tool-fs/src/index.ts:70-73`), so granting it
 * would make every filesystem capability depend on a plane it never names.
 * `bash` is likewise absent on a Windows deployment, where the standard preset
 * disables `tool-bash`.
 */
declare const TOOL_LABELS: Readonly<Record<string, readonly string[]>>;
/**
 * Expand one capability's tool labels into real DSH tool names.
 * @param capability - capability name, named in the rejection.
 * @param labels - the labels the capability declares.
 * @returns every real tool name the labels grant, in declaration order.
 * @throws when a label is not in {@link TOOL_LABELS}; the error lists the vocabulary.
 */
declare function resolveToolLabels(capability: string, labels: readonly string[]): string[];
/**
 * The capability-worker baseline: what every worker needs whatever its
 * capabilities are, because its own prompt tells it to use these. Every entry
 * cites the prompt line that needs it (the worker policy section,
 * `agent-runtime/src/prompts/worker.prompts.ts`, plus the shell tool's own
 * guidance for `jobs`):
 *
 * - `filesystem` — "Do the work" / "Keep changes scoped to this task".
 * - `bash` — "Where a criterion lists a command, make that command exit 0 in the checkout".
 * - `jobs` — that same command is often long-running, and `bash`'s own description
 *   tells the model to collect background output with `job_output`/`job_kill`.
 * - `search` — locate the code the work touches.
 * - `skill` — without the loader the granted skills are unreachable, and
 *   `tool-skill` only injects the catalog when its tool is visible.
 * - `ask-user` — "Need a human decision? Ask with `ask_user_question`".
 *
 * A composition that offers none of them (the `bb-verify` node mounts no shell)
 * simply keeps what it has: see `agent-runtime/src/grants.ts`.
 */
declare const WORKER_BASELINE_LABELS: readonly string[];
/**
 * Baseline tool names that are not a capability label: the task machinery the
 * worker prompt calls. They are exactly the Layer-0 universal control tools the
 * frozen material fixes for every agent (`细化想法4.md:724-738`: `task_read`,
 * `task_decompose`, `task_status`, and the verifier tool this deployment names
 * `task_verify`) — L0 is the "every node, whatever it works on" layer, so a
 * worker keeps it whatever its capabilities declare — plus the two A3
 * coordination tools (`task_submit_result`, `task_cancel`) and
 * `capability_list`, which have no label that could expand to them either.
 *
 * They are listed here individually, unlike the labels above, because these tools
 * are registered on the GLOBAL layer rather than a capability or preset plane
 * (`agent-singularity/src/index.ts`): the grant filter only keeps an inherited
 * tool the allow-list names (`agent-runtime/src/grants.ts:99`), and there is no
 * label that could expand to them.
 *
 * Every entry cites the prompt or tool contract that needs it:
 * - `capability_list`: `task_decompose` asks callers to discover valid capability
 *   names before proposing children, including recursively spawned workers.
 * - `task_decompose` — a worker admitted as decomposable is told to call it with
 *   a `reason` and the child task list, and for a `leaf` worker whose deployment
 *   runs with `Config.allowRuntimeDecomposition` on, the runtime-split rule the
 *   context projection carries opens the same tool to it.
 * - `task_submit_result` — "When the work is done, hand it in with `task_submit_result`"
 *   (the worker policy section): the submission is the only completion a worker
 *   can claim, so a worker without the tool could never finish a run.
 * - `task_read` — the caller's own contract and run (A2 §D).
 * - `task_status` — the same policy line: the project state with `task_status`.
 * - `context_read` — the one reference reader (A2 §D): the worker's handoff and
 *   its task records point at artifacts, evidence, reviews, diagnoses and
 *   sessions by id, and this is the only door that reads them inside the
 *   caller's own graph domain — the raw cross-session readers it replaced are
 *   sealed off every runtime-owned agent (`agent-runtime`'s execution guard).
 * - `task_verify` — "`task_verify` is only a self-check" (the worker policy section).
 * - `task_cancel` — no prompt line asks for it: a run that decomposed holds a
 *   batch of its own, and the protocol's only way to end that batch early is
 *   this call (A3 §3.6). It is also the one write the execution gate keeps for
 *   a run in `waiting_children` or `submitted` (`gate.ts:COORDINATION_ALLOWED`),
 *   so the tool has to be on the surface of every run that can hold a batch.
 * - `task_proposal_read`, `task_proposal_continue`, `task_proposal_cancel`
 *   (T2/T3) — a decomposition proposal is not always admitted on the spot: a
 *   reviewed deployment answers `task_decompose` with a proposal id and nothing
 *   admitted, and the tool's own answer points the caller at
 *   `task_proposal_read` for the batch as it was recorded. The other two are
 *   the coordination actions on that record — continuing it after a decision
 *   (which can admit the batch, so the gate classifies it with
 *   `task_decompose`) and withdrawing it before admission (classified with
 *   `task_cancel`). They are task-domain actions of a node that proposed work,
 *   not platform management: the human decision itself never happens in a
 *   worker's tool plane — the review channel is wired at the service assembly
 *   and a worker has no tool that could decide a proposal.
 * - `task_ask_parent`, `task_answer` (A4 §F.1) — the two halves of the direct
 *   parent/child question protocol, and the only effects a run keeps while it is
 *   blocked on an unanswered question (`gate.ts:COORDINATION_ALLOWED`). **A4
 *   sub-goal ③a note**: the names are listed here so a worker's own surface can
 *   reach the runtime entries the write gate and the blocking tests drive; the
 *   shipped tool definitions, their schemas and the root's own policy line are
 *   ③c's, and nothing here decides what a call is allowed to say — the gate and
 *   the Task store do.
 *
 * `graph_spawn` is deliberately NOT here, even though the deployment registers
 * it for the root: it reaches the graph without Task Admission and returns the
 * child's last assistant text as its result, which breaks frozen invariants #2
 * ("Task 可以自由生成，但必须通过 Task Admission") and #6 ("Parent 必须消费
 * evidence，而不是直接相信 child natural-language result")
 * (`细化想法4.md:2075`, `:2079`); such a node has no task record, so no evidence,
 * no review, and nothing `task_status` or the parent's composite criterion can
 * see. Nodes grow by their worker calling `task_decompose`, which admits the
 * batch and has the orchestrator spawn each child. Every worker holds that tool
 * whatever its `decompositionStatus`; whether a `leaf` task's own call is
 * admitted is the runtime's decision, not the tool plane's
 * (`Config.allowRuntimeDecomposition`, `index.ts:DEFAULT_ALLOW_RUNTIME_DECOMPOSITION`).
 */
declare const WORKER_BASELINE_TOOLS: readonly string[];
/**
 * Every real tool name a capability worker keeps on top of what its
 * capabilities declare.
 * @returns the expanded baseline, de-duplicated.
 */
declare function workerBaseline(): string[];
/**
 * Resolve required capability names against the configured registry.
 * A required name that has an entry contributes its skills/tools/preset to the
 * manifest; a name without an entry lands in `missing`. Closure is `closed`
 * when nothing is missing, otherwise `gap`.
 *
 * Tool labels are expanded here, so the manifest carries the real DSH tool names
 * a worker is granted — and an unknown label rejects the whole resolution with
 * the vocabulary named, before anything is persisted or spawned. MCP server
 * names are validated against `MCP_SERVER_REGISTRY` the same way and copied
 * onto the manifest entry; the spawn seam binds them to the run's env.
 * @param required - capability names the caller requires.
 * @param registry - the configured capability table.
 * @returns the resolved manifest.
 * @throws when a matched capability declares a tool label outside {@link TOOL_LABELS}
 *   or an MCP server outside `MCP_SERVER_REGISTRY`.
 */
declare function resolveCapabilities(required: readonly string[], registry: Readonly<Record<string, CapabilityConfig>>): CapabilityManifest;
/** One permission preset's knob bundle, as `permissionPresets.resolve` reports it. */
interface PermissionSpec {
  sandbox: string;
  approval: string;
}
/**
 * The permission preset a spawned worker runs under: the strictest preset any
 * matched capability declares, or `undefined` when none declares one (the
 * caller then keeps the default posture). `resolveSpec` (the permissionPresets
 * registry's `resolve`) doubles as existence validation — an unknown preset
 * name fails loudly here, before the spawn.
 */
declare function resolvePermission(manifest: CapabilityManifest, resolveSpec: (name: string) => PermissionSpec): string | undefined;
//#endregion
//#region src/gate.d.ts

/**
 * What a session bound to a run may still call once its run is no longer
 * `active`. Read-only inspection, diagnosis, the human-question tools, and the
 * controlled cancellation of this batch: the work of *looking at* a run or
 * ending it, never of making it produce more. `context_read` is the one
 * history/reference reader here: the raw cross-session tools it replaced
 * (`session_event_read` and its siblings) are sealed off every runtime-owned
 * agent by the execution guard, so they have no phase to be allowed in.
 *
 * `task_cancel` is in the list because cancelling is the one write a waiting or
 * submitted run is allowed: the run has stopped deciding, and the owner may
 * still stop the tree.
 *
 * The proposal tools follow the same categories (T2/T3). `task_proposal_read`
 * reads a saved proposal and `task_proposal_cancel` withdraws the batch its own
 * session proposed: they are the looking-at and the ending of what this run
 * already asked for, exactly the work `task_read` and `task_cancel` do.
 * `task_proposal_continue` is deliberately **not** here: it can admit a batch,
 * which is the same effect `task_decompose` has, so it is a write in every
 * non-active phase — a run that has stopped deciding its own work does not get
 * to turn a proposal into tasks.
 *
 * The two question tools (A4 §F.1) are coordination in the plainest sense: a
 * child asking its direct parent is the one effect still admitted while its own
 * run is blocked on a question, and a parent answering a child is the one effect
 * a `waiting_children` parent may still produce. Neither makes anything else
 * writable — answering is not a phase change, and a blocked run keeps its block
 * until the answer that resolves it.
 */
declare const COORDINATION_ALLOWED: ReadonlySet<string>;
/** A tool call that was let through and has not reported its result yet. */
interface InFlightCall {
  readonly callId: string;
  readonly name: string;
}
/**
 * The jobs service as the drain uses it, structurally. Written as a soft
 * interface so the runtime can hand in `ctx.jobs` without this module importing
 * a cordis service (or any harness package): `id` is the job this module kills
 * and waits on (DSH's own `JobSnapshot.id`), `status` is DSH's
 * `running | stopping | completed | killed | failed`, and the three terminal
 * ones are what "confirmed stopped" means.
 */
interface JobsViewEntry {
  readonly id: string;
  readonly status: string;
  readonly detail?: string;
}
interface JobsView {
  list(agent?: unknown): readonly JobsViewEntry[];
  kill(id: string, agent?: unknown, reason?: string): unknown;
  wait(id: string, timeoutMs: number, agent?: unknown): Promise<{
    status: string;
    detail?: string;
  }>;
}
/** What the gate decided about one call. `allow: true` means `next()`; a refusal names the phase and why the tool is not in it. */
type GateDecision = {
  allow: true;
} | {
  allow: false;
  reason: string;
};
interface DrainOptions {
  /** How long the whole drain may take, in milliseconds; the caller's policy, never a default here. */
  timeoutMs: number;
  /**
   * The call that is asking for the drain. It is in flight by definition (it is
   * the submission or admission call itself), so counting it would wait for the
   * drain to finish waiting — the deadlock §3.3 records.
   */
  excludeCallId?: string;
  /** The jobs service; absent (with `agent`) means this deployment has no managed jobs to reconcile. */
  jobs?: JobsView;
  /** The owner agent a jobs call is authorized as. */
  agent?: unknown;
}
type DrainResult = {
  confirmed: true;
} | {
  confirmed: false;
  pending: string[];
};
/**
 * The phase each session is in, what it has in flight, and whether it is waiting
 * on an answer. One instance per runtime; nothing here touches the store or a
 * service, so the rules can be tested as the pure state machine they are.
 */
declare class ExecutionGate {
  private readonly phases;
  /** Registering by call id (not by session) because `tools/result` carries only the call id. */
  private readonly calls;
  /**
   * How many times this process wrote one session's phase by its own authority
   * ({@link setPhase}, {@link setTerminal}): the applicability token a
   * store-derived phase is checked against.
   */
  private readonly decisions;
  /**
   * The sessions whose runs are waiting on an unresolved blocking question
   * (A4 §F.1). A set rather than a map of booleans: "no entry" and "not blocked"
   * are the same fact, and a cleared session must not leave a stale value to be
   * read back. Nothing here is persisted or projected — the store's question
   * facts are the durable state, and this is the live process's handle on them.
   */
  private readonly questionBlocked;
  /**
   * Move a session's phase: the runtime calls this when **it** is the authority
   * for the transition — a committed admission or submission, a settled run, an
   * unload, the binding of a session to its own run. This is one of the two
   * writers that count as a decision ({@link decisionToken}); a phase that only
   * the *store* implies goes through {@link applyStorePhase} instead, and does
   * not count as one.
   */
  setPhase(sessionId: string, phase: ExecutionPhase): void;
  /**
   * Mark a session's run terminal: only the allow-list runs from here, and its
   * reason says the call is late. A decision, like {@link setPhase} — it moves
   * the phase because this process knows the run is over, not because a read of
   * the store implied it.
   *
   * The question block goes with it: an open question requires *both* runs to be
   * running, so a run this process just made terminal is blocked by nothing —
   * leaving the flag set would make the refusal name a wait that no longer
   * exists.
   */
  setTerminal(sessionId: string): void;
  /**
   * How many times this process has written this session's phase by its own
   * authority; `0` for a session it has never written one for. This is the
   * applicability token for a phase read out of the store: take it *before* the
   * read, hand it back with the value ({@link applyStorePhase}).
   *
   * What it answers is not "is this value current" — a second read would race
   * the first exactly as it did — but "did anything of ours decide this session
   * while the read was in flight". That is the only thing that can make a value
   * the store returned older than the gate: the read happened, the store
   * recorded a decision of ours, and the value the read handed back predates it.
   */
  decisionToken(sessionId: string): number;
  /**
   * Apply a phase the store implies — never one this process decided — and only
   * when it is newer than everything decided here: `token` is the
   * {@link decisionToken} taken before the read that produced `phase`, and a
   * count that no longer matches means a decision landed while that read was in
   * flight. The value is then older than the gate's, and it is dropped; the
   * return says which of the two happened.
   *
   * Two trajectories reach a store-derived phase that is too old, and only one
   * of them is this token's:
   *
   * - a read that **straddled** a decision — the store returned the old record,
   *   and the decision landed before the value could be applied — is what this
   *   token refuses: the decision is on the record by then, so the count moved
   *   and the value is dropped. Applying it would re-open a gate a settled run
   *   had closed, and no other guard can see it, because the wait was inside the
   *   read and the store is already up to date when the value arrives.
   * - a read taken **inside a window whose decision is in effect but not yet
   *   persisted** (a cancellation raising its barrier before the store records
   *   it) cannot be refused by this token: the read starts *after* the decision,
   *   so the count it took is current, and the value is old only because the
   *   store's write has not happened yet. That window belongs to the caller,
   *   which refuses it before calling this — the token covers a read that
   *   straddled a decision, never one that raced a write.
   */
  applyStorePhase(sessionId: string, phase: ExecutionPhase | 'terminal', token: number): boolean;
  /**
   * Record that a session's run is — or is no longer — waiting on an unresolved
   * blocking question (A4 §F.1). A decision of this process about a fact this
   * process just wrote (the ask it committed, the answer that released one, the
   * addressee's own settlement that ended every question addressed to it), so it
   * counts as one exactly as {@link setPhase} does; a value the *store* implies
   * goes through {@link applyStoreQuestionsBlocked}.
   *
   * `false` is not "probably unblocked": the caller is stating the derivation it
   * just took from the store's question facts (`blockingQuestionsOf`), which is
   * what makes a second blocking question keep the session blocked after the
   * first is answered.
   */
  setQuestionsBlocked(sessionId: string, blocked: boolean): void;
  /**
   * Apply a blocking state the store implies — never one this process decided —
   * under the same token rule as {@link applyStorePhase}: `token` is the
   * {@link decisionToken} taken before the read that produced it, and a value
   * the gate has moved past is dropped rather than applied. The return says
   * which of the two happened.
   */
  applyStoreQuestionsBlocked(sessionId: string, blocked: boolean, token: number): boolean;
  /** Whether the run bound to this session is waiting on an unresolved blocking question (A4 §7.2's derived wait). */
  questionsBlocked(sessionId: string): boolean;
  /** The phase a session is under, or `undefined` when no run is bound to it (nothing is gated). */
  phaseOf(sessionId: string): ExecutionPhase | 'terminal' | undefined;
  /**
   * Register a call that was let through. Called for every allowed call whatever
   * its phase, because the phase can change while it runs — that in-flight write
   * is what `drainSession` waits for.
   */
  trackAllowed(sessionId: string, callId: string, toolName: string): void;
  /** The result event for a call arrived: it is no longer in flight. Unknown ids are the denied calls, and are ignored. */
  settled(callId: string): void;
  /**
   * The session's in-flight calls that count as writes: everything whose name is
   * not in {@link COORDINATION_ALLOWED}. The definition is the allow-list, not a
   * second list of write tools — a tool this deployment adds is a write until the
   * coordination protocol says otherwise, and the two answers cannot drift.
   */
  inFlightWrites(sessionId: string): InFlightCall[];
  /**
   * Decide one call. A session with no phase is not bound to a run and is not
   * gated; an `active` run with no blocking question is still deciding its own
   * work. Every other state allows the coordination list and denies everything
   * else, naming what holds the session — the phase, or the question it waits on
   * — the refused tool, and what is still allowed.
   *
   * The two refusals are one decision with two names because a caller has to be
   * able to tell them apart: `active` plus a blocking question is *not* "the
   * phase closed writes", it is "this run is waiting for an answer", and an
   * answer (not a phase change) is what ends it. Both are computed after the
   * allow-list, so the question tools and the reads answer in either state.
   */
  decide(sessionId: string, toolName: string): GateDecision;
  /**
   * Wait — bounded — until this session has no in-flight write and no live
   * managed job, and say exactly what is left when the window closes. Never
   * assumes a stop: `confirmed: false` with named `pending` entries is the
   * honest answer for a call that did not settle or a job that is still not
   * terminal, and the caller must refuse verification on it (§3.3).
   *
   * Order matters: the in-flight calls first (they are the writes this process
   * can see finish), then the jobs this session started (kill, then wait for a
   * terminal status within whatever window is left). The jobs step is skipped
   * entirely when the deployment gave no service or no agent — there is nothing
   * to reconcile, which is not the same as "nothing running".
   */
  drainSession(sessionId: string, opts: DrainOptions): Promise<DrainResult>;
}
//#endregion
//#region src/skill-contract.d.ts
/**
 * The sidecar contract version this build writes and reads. Like the task
 * contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
 * skill: a sidecar declaring a version this build does not know is refused
 * rather than read with the wrong field semantics.
 */
declare const SKILL_CONTRACT_VERSION: 1;
/** Every version of {@link SkillSidecar} this build can write or read. */
type SkillContractVersion = typeof SKILL_CONTRACT_VERSION;
/**
 * One supporting file's identity: where it is inside the skill directory and the
 * SHA-256 of its exact bytes.
 */
interface SkillResourceIdentity {
  /** Path relative to the skill directory, POSIX separators, `<dir>/<file>` per {@link isSupportedSkillResourcePath}. */
  path: string;
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string;
}
/**
 * What a sidecar claims about the bytes a worker will read: the `SKILL.md`
 * itself plus every supported resource, in one sorted list. A skill directory
 * holding a file this identity does not name is refused by the loader — the
 * point of the identity is that it covers the content, not most of it.
 */
interface SkillContentIdentity {
  /** SHA-256 of the exact `SKILL.md` bytes. */
  skillMdSha256: string;
  /** Every supported resource the identity covers, sorted by `path`, each path once. */
  resources: readonly SkillResourceIdentity[];
}
/**
 * One declared input or output of an execution skill. Ports are named in the
 * skill's own vocabulary; the runtime does not resolve them against artifacts
 * or inputs in v1, so they are a readable contract, not a wiring.
 */
interface SkillPort {
  /** Port name. */
  name: string;
  /** What the port carries, in the author's words, stored verbatim. */
  description: string;
  /** Whether the port must be satisfied for the skill to apply. */
  required: boolean;
}
/**
 * The registered judge an execution skill's result is verified by. Only the ref
 * is bound in v1: the registry exposes its ids (`VerifierRegistry.verifierIds()`)
 * and no per-ref version, so a version declared here could not be checked and
 * would be a field nobody consumes.
 */
interface SkillVerifierRef {
  /** Verifier id the registry is queried under; an unknown ref makes the skill an invalid provider. */
  ref: string;
}
/** An execution skill: it provides capabilities and is judged by a verifier. */
interface ExecutionSkillSidecar {
  contractVersion: SkillContractVersion;
  type: 'execution';
  /** Capability names this skill serves; at least one, each unique. */
  capabilities: readonly string[];
  /** What must hold before the skill applies, verbatim. */
  precondition: string;
  /** Declared inputs; `[]` when the skill declares none. */
  inputs: readonly SkillPort[];
  /** Declared outputs; `[]` when the skill declares none. */
  outputs: readonly SkillPort[];
  /** Real DSH tool names the skill needs, in the same vocabulary a capability expands to. */
  requiredTools: readonly string[];
  verifier: SkillVerifierRef;
  content: SkillContentIdentity;
}
/**
 * How a knowledge skill's content is checked. v1 knows one kind, `command`: a
 * check the deciding gate runs in the skill directory and reads the exit code
 * of. Nothing in this module — or in the loader — executes it; the reference is
 * validated as a declaration and carried, never run as a side effect of
 * validation.
 */
interface KnowledgeContentCheck {
  /** The one check kind this build recognizes. */
  kind: 'command';
  /** The command line, verbatim, to be executed by the gate that owns the decision. */
  command: string;
}
/**
 * A knowledge skill: guidance a worker may read, with no execution verifier and
 * no place in the execution closure. It declares its source and scope so a
 * reader can judge where the content came from and what it applies to.
 */
interface KnowledgeSkillSidecar {
  contractVersion: SkillContractVersion;
  type: 'knowledge';
  /** Where the content comes from, verbatim. */
  source: string;
  /** What the content applies to, verbatim. */
  scope: string;
  content: SkillContentIdentity;
  contentCheck: KnowledgeContentCheck;
}
/** The discriminated sidecar: `type` decides which field set is the closed one. */
type SkillSidecar = ExecutionSkillSidecar | KnowledgeSkillSidecar;
/**
 * The named kind of one declaration refusal. `unknown-version` and
 * `unknown-field` are their own codes because a caller acts differently on
 * them (one build-versions the reader, the other says which fields a type
 * carries); everything else is a shape defect inside the declared field set.
 */
type SkillContractDefectCode = 'sidecar-unknown-version' | 'sidecar-unknown-field' | 'sidecar-shape';
//#endregion
//#region src/sidecar.d.ts
/** Every reason a provider is refused, named so a caller can act on the kind of problem. */
type SkillDefectCode = SkillContractDefectCode | 'skill-missing' | 'skill-file-invalid' | 'skill-name-mismatch' | 'sidecar-unreadable' | 'sidecar-mismatch' | 'content-mismatch' | 'content-unsupported' | 'verifier-unknown' | 'capability-unknown' | 'tool-not-covered';
/** One named reason a provider is not acceptable, with the detail a caller reports. */
interface SkillDefect {
  code: SkillDefectCode;
  detail: string;
}
/** What the real DSH tool plane a capability grants looks like: expanded names plus the servers it mounts. */
interface CapabilityGrants {
  /** Real DSH tool names the capability's tool labels expand to. */
  readonly tools: readonly string[];
  /** MCP server names the capability mounts; their tools reach a worker as `mcp__<server>__<tool>`. */
  readonly mcpServers: readonly string[];
}
/**
 * What the context knows about one capability. `known: false` covers both "no
 * such row" and "the row does not resolve" (an unknown tool label, an unknown
 * MCP server): both mean the grant cannot be read off the table, and the
 * refusal carries the reason the table itself gave.
 */
type CapabilityToolAnswer = ({
  readonly known: true;
} & CapabilityGrants) | {
  readonly known: false;
  readonly reason: string;
};
/** How a caller lends its capability table to the pre-check. */
type CapabilityToolQuery = (capability: string) => CapabilityToolAnswer;
/** Everything the pre-check needs that is not the candidate itself. */
interface SkillValidationContext {
  /** Verifier ids the registry can dispatch to (`VerifierRegistry.verifierIds()`): the whole vocabulary `verifier.ref` may name. */
  readonly verifierRefs: readonly string[];
  /** The expanded tool plane of a capability, in the same vocabulary a sidecar's `requiredTools` is written in. */
  readonly capabilityTools: CapabilityToolQuery;
}
/**
 * A capability table as a query, going through `resolveCapabilities` — the same
 * resolution admission performs — so the pre-check sees exactly the grant a
 * spawn would build and a broken row is refused with the resolution's own
 * reason instead of being silently treated as granting nothing.
 */
declare function capabilityToolQuery(capabilities: Readonly<Record<string, CapabilityConfig>>): CapabilityToolQuery;
/** Build the pre-check context from a capability table and the registered verifier ids. */
declare function skillValidationContext(capabilities: Readonly<Record<string, CapabilityConfig>>, verifierRefs: readonly string[]): SkillValidationContext;
/** What a skill directory honestly held when it was read. */
interface LoadedSkillSidecar {
  /** The skill directory that was read, as given. */
  readonly directory: string;
  /** The declared sidecar, when the directory holds a readable one that passed the shape rules. */
  readonly sidecar?: SkillSidecar;
  /** The identity of the bytes actually read; absent when there is no readable regular `SKILL.md`. */
  readonly content?: SkillContentIdentity;
  /**
   * What the `SKILL.md` frontmatter declares — the name the file loads under
   * and the purpose a reader sees. Absent exactly when the file could not be
   * read or parsed, which is then a defect in {@link defects}: a skill file
   * that cannot be parsed is not a skill file a worker can load.
   */
  readonly frontmatter?: LoadedSkillFrontmatter;
  /** Direct entries the supported vocabulary does not cover (a directory reads as `name/`), sorted. */
  readonly uncovered: readonly string[];
  /** Every reason the directory or its sidecar is not acceptable; empty means a clean load. */
  readonly defects: readonly SkillDefect[];
}
/**
 * The frontmatter two consumers need: the spawn's `readSkillFile` (which
 * publishes the body under `name`) and every renderer that shows what a
 * provider is for (`description`). Read once, by the same parser.
 */
interface LoadedSkillFrontmatter {
  /** The name the file declares it is; a directory reached under another name is refused. */
  readonly name: string;
  /** The purpose the file declares, in the author's words. */
  readonly description: string;
}
/** One provider under pre-check: the granted skill name and where discovery found it. */
interface SkillProviderCandidate {
  /** The skill name a capability grants; the directory under a skill root is named after it. */
  readonly name: string;
  /** Absolute path of the skill directory discovery resolved, or absent when nothing was found. */
  readonly directory?: string;
  /**
   * A sidecar the caller already holds (a prepare-time declaration, a ledger
   * copy). It is never trusted as a substitute for the directory: it must be
   * the same declaration the directory carries, so a validated declaration
   * cannot be paired with different bytes at apply time.
   */
  readonly sidecar?: SkillSidecar;
}
/** The only verdict kind that may close an execution gap: an execution sidecar that passed every rule. */
interface ExecutionProviderVerdict {
  readonly valid: true;
  readonly role: 'execution-provider';
  readonly name: string;
  readonly directory: string;
  readonly capabilities: readonly string[];
  /** The declared precondition, carried verbatim for the caller that renders a worker summary. */
  readonly precondition: string;
  /**
   * The purpose this skill declares for itself (`SKILL.md` frontmatter), carried
   * so a run summary or a record can say what the provider is for without
   * re-reading the file it was judged from.
   */
  readonly description: string;
  readonly inputs: readonly SkillPort[];
  readonly outputs: readonly SkillPort[];
  readonly requiredTools: readonly string[];
  readonly verifierRef: string;
  /** {@link skillContractDigest} of the sidecar the verdict was taken from. */
  readonly contractDigest: string;
  readonly content: SkillContentIdentity;
  /** {@link skillContentDigest} of {@link content}: the bytes this verdict is about, in one string. */
  readonly contentDigest: string;
}
/** A knowledge skill: loadable, content-verified, and deliberately without any execution claim. */
interface KnowledgeProviderVerdict {
  readonly valid: true;
  readonly role: 'knowledge';
  readonly name: string;
  readonly directory: string;
  readonly source: string;
  readonly scope: string;
  /** The declared content check, carried — this pre-check never runs it. */
  readonly contentCheck: KnowledgeContentCheck;
  /** The purpose this skill declares for itself; see {@link ExecutionProviderVerdict.description}. */
  readonly description: string;
  readonly contractDigest: string;
  readonly content: SkillContentIdentity;
  readonly contentDigest: string;
}
/** A skill with no sidecar: guidance a worker may read, with no execution claim and no defect. */
interface GuidanceProviderVerdict {
  readonly valid: true;
  readonly role: 'guidance';
  readonly name: string;
  readonly directory: string;
  /** The purpose this skill declares for itself; see {@link ExecutionProviderVerdict.description}. */
  readonly description: string;
  readonly content: SkillContentIdentity;
  readonly contentDigest: string;
  readonly uncovered: readonly string[];
}
type AcceptedSkillProviderVerdict = ExecutionProviderVerdict | KnowledgeProviderVerdict | GuidanceProviderVerdict;
/** A refused provider: every reason named, nothing written, nothing claimed. */
interface RejectedProviderVerdict {
  readonly valid: false;
  readonly name: string;
  readonly directory?: string;
  readonly defects: readonly SkillDefect[];
}
type SkillProviderVerdict = AcceptedSkillProviderVerdict | RejectedProviderVerdict;
/**
 * The verdicts that may close an execution gap — and the only place a caller
 * needs to ask. A knowledge or guidance verdict is not in the result, so the
 * closure semantics cannot be relaxed by accident at a call site.
 */
declare function executionProviders(verdicts: readonly SkillProviderVerdict[]): ExecutionProviderVerdict[];
/** One provider's declared content identity inside the registry revision. */
interface SkillProviderIdentity {
  /** The skill name a capability grants. */
  readonly name: string;
  /** {@link skillContractDigest} of the provider's sidecar, or `null` when the skill carries none. */
  readonly contractDigest: string | null;
}
/**
 * Load and check one skill directory: the directory itself, `SKILL.md`, the
 * sidecar when there is one, the identity of the bytes on disk, and the shape
 * of everything else in it.
 *
 * The returned `content` is the identity computed from the bytes just read —
 * the same value a clean sidecar declares, and the honest answer for a skill
 * that declares nothing. `defects` empty means the directory is fully described
 * by its identity: every file is `SKILL.md`, the sidecar itself, or a supported
 * resource the declaration names. Absence of a sidecar is not a defect: the
 * skill is then guidance, not a provider.
 */
declare function loadSkillSidecar(directory: string): Promise<LoadedSkillSidecar>;
/**
 * The unified pre-check: one candidate provider against the deployment's
 * verifier vocabulary and capability table (guide §2.3, S1-C item 3). Every
 * entry — config load, provider replacement, candidate promotion — calls this,
 * so `evolution_apply` is not the only defence and no entry can be the one that
 * skipped it.
 *
 * Rules, in the order they are checked:
 *
 * 1. The directory exists, is a real directory, and is named after the skill.
 * 2. The loader reads it: `SKILL.md`, the sidecar when present, the supported
 *    resources, and every entry whose shape the contract does not support. The
 *    declared content identity must equal the bytes read, and the `SKILL.md`
 *    frontmatter must parse and declare the granted name — the same rule, and
 *    the same words, the spawn's `readSkillFile` applies when it registers the
 *    body.
 * 3. A sidecar the caller supplied must be the one the directory carries.
 * 4. An execution sidecar's `verifier.ref` must be a registered verifier, and
 *    its `requiredTools` must be granted by the capabilities it declares it
 *    serves (`mcp__<server>__<tool>` counts when the capability mounts that
 *    server; the worker baseline is deliberately not counted — a capability
 *    must grant what the provider it carries needs).
 * 5. A knowledge sidecar is checked for content and carried as knowledge: it
 *    never becomes an execution provider.
 *
 * The verdict is a value: all defects are collected, nothing is written, and a
 * caller that only wants execution providers filters with
 * {@link executionProviders}.
 */
declare function validateSkillProvider(candidate: SkillProviderCandidate, context: SkillValidationContext): Promise<SkillProviderVerdict>;
/**
 * The registry revision: SHA-256 over {@link canonicalize} of the capability
 * table (each row sorted by name, carrying its skills, the tool labels it
 * declares, the DSH tool names those labels expand to, its preset, permission
 * and MCP servers — defaults and declaration order normalized away) plus every
 * provider's sidecar identity.
 *
 * What it covers, and what it deliberately does not: a run can cite this
 * revision to say which table and which declared provider content it resolved
 * against. Two runs with the same revision resolved the same rows over the same
 * declared sidecar content. It does **not** cover the bytes of a skill that
 * declares nothing (its identity is `null` here), the verifier registry's own
 * revisions, or the deployment's environment — a caller that needs those records
 * them separately rather than reading them into this digest.
 */
declare function registryRevision(capabilities: Readonly<Record<string, CapabilityConfig>>, providers: readonly SkillProviderIdentity[]): string;
//#endregion
//#region src/provider-precheck.d.ts
/**
 * The verifier service as a provider check uses it: an optional plugin this
 * package never imports, resolved softly from whichever context is asking.
 */
interface VerifierVocabulary {
  /** Idempotent registration gate; awaited before the registry is read. */
  ready?(): Promise<void>;
  /** The registered verifier ids, the vocabulary a sidecar's `verifier.ref` may name. */
  verifierIds?(): string[];
  /**
   * The declared version of each registered verifier, by id — the registry
   * metadata a verdict is stamped with. Optional: a registry that reports ids
   * only (an older implementation, a minimal test double) leaves every version
   * undeclared, which a reader reports as "none" rather than inventing one.
   */
  verifierVersions?(): Record<string, string>;
}
/**
 * Resolve an optional sibling plugin's service by property or `ctx.get(name)`,
 * the soft pattern this repo uses for services a deployment may or may not
 * mount (`verifier`, `sessionQuery`, `agents`): absent in test contexts and in
 * smaller bundles, not an error.
 *
 * Both lookups are inside the `try` because cordis refuses a property read of a
 * service the asking context does not have (`cannot get property "verifier"
 * without inject`, `reflect.ts` — it throws instead of returning `undefined`).
 * An optional service that is absent is exactly the case this function exists
 * for, so the refusal is the answer: `undefined`.
 */
declare function optionalService<T>(host: unknown, name: string): T | undefined;
/**
 * The registered verifier vocabulary a provider check judges execution sidecars
 * against, or `undefined` when the deployment cannot list it — no verifier
 * service, a service that never became ready, or a registry whose own read
 * throws.
 *
 * `ready()` first, and only here: a verifier service that has been constructed
 * but not readied reports an empty `verifierIds()`, and reading that as "no
 * verifier is registered" would refuse every execution provider on a deployment
 * whose registry is merely still loading. The distinction between "the registry
 * could not answer" and "the registry answered: empty" is exactly what the
 * returned `undefined` preserves: a caller refuses an execution sidecar in the
 * first case (fail-closed, {@link unlistableVerifierRefusal}) and names the
 * registry's own answer in the second.
 *
 * One implementation for every consumer — the admission pre-check, the
 * load-time scan and the promotion checks all ask it (guide §2.4, S1-C item 3).
 */
declare function registeredVerifierIds(host: unknown): Promise<readonly string[] | undefined>;
/**
 * The registered verifier vocabulary *and the version each instance declares*,
 * or `undefined` under exactly the conditions {@link registeredVerifierIds}
 * answers `undefined`. The two are read together by a caller that has to recall
 * a verdict against the instance that produced it (the evolution promotion
 * gate): an id list cannot tell a re-registered judge from the one that judged,
 * and a version list read without the ids could name a judge that is gone.
 *
 * Registration is awaited once, then both halves are read from the same
 * instance. A registry that implements `verifierIds()` but no
 * `verifierVersions()` answers an empty map — "no version was declared", which
 * is the truth for it, not a refusal.
 */
declare function registeredVerifierVocabulary(host: unknown): Promise<{
  ids: readonly string[];
  versions: Readonly<Record<string, string>>;
} | undefined>;
/**
 * The refusal of an execution sidecar the deployment cannot judge because its
 * verifier vocabulary could not be listed: the declared ref is refused rather
 * than assumed registered (fail-closed). The admission pre-check and the
 * evolution promotion checks share this function, so one situation reads the
 * same way in every entry instead of each inventing its own explanation.
 */
declare function unlistableVerifierRefusal(name: string, directory: string | undefined, ref: string): RejectedProviderVerdict;
/**
 * Where a pre-check looks for a skill: the viewpoint of the worker that would
 * load it. `cwd` is the session's checkout — the directory the worker's own
 * discovery walks upward from — and `extraRoots` are the roots that precede the
 * standard ones (the replay overlay's, exactly as `applyWorkerGrant` orders
 * them).
 */
interface SkillDiscoveryView {
  /** The worker's working directory (the session's checkout); absent when the deployment cannot name one. */
  readonly cwd?: string;
  /** Roots searched before the standard ones: the replay overlay's skill roots, in the order the grant registers them. */
  readonly extraRoots?: readonly string[];
}
/**
 * Every root one discovery view covers, in search order — the single root list
 * the pre-check searches and the one a refusal names, so "searched the roots"
 * in an error message is never a hand-written approximation of the search.
 */
declare function skillSearchRoots(view?: SkillDiscoveryView): Promise<string[]>;
/** What one capability row's declared skills resolved to. */
interface CapabilityProviderPrecheck {
  /** The capability row the skills were read from. */
  readonly capability: string;
  /** One verdict per distinct skill the row declares, in declaration order. */
  readonly skills: readonly SkillProviderVerdict[];
}
/**
 * The result of one pre-check, shaped to be carried: per capability, the
 * verdict for every skill it declares; the roots that were searched; the
 * verifier vocabulary the execution sidecars were judged against; and the
 * registry revision the accepted providers produce.
 *
 * The verdicts carry their own facts (`role`, `directory`, `contentDigest`,
 * `contractDigest`, `verifierRef`, the declared ports), so a caller that has to
 * *record* what a run resolved against — the Run binding (S1-C item 4) — reads
 * them off this value instead of re-reading the skill directories.
 */
interface ProviderPrecheck {
  /** Every capability row that was checked, in the order given. */
  readonly capabilities: readonly CapabilityProviderPrecheck[];
  /** The discovery roots the search covered, in order. */
  readonly roots: readonly string[];
  /**
   * The registered verifier ids the execution sidecars were checked against.
   * **Absent** means the registry could not be listed at all, which is not the
   * same as "no verifier is registered": an execution sidecar is refused in
   * that case rather than assumed valid (fail-closed).
   */
  readonly verifierRefs?: readonly string[];
  /**
   * {@link registryRevision} over the table the rows came from and the provider
   * identity of every **accepted** skill in play (a skill without a sidecar
   * contributes `null`; a refused one contributes nothing, because a refused
   * provider is never something a run resolved against).
   */
  readonly revision: string;
}
/**
 * One accepted provider's content identity, as the pre-check resolved it: the
 * skill's name and the digest of the sidecar contract it declares.
 * `contractDigest: null` is a skill that declares no sidecar — a knowledge or
 * guidance skill whose *contract* this deployment cannot pin. What a caller
 * records against this value (the run binding, the review context) is exactly
 * what it says and no more.
 */
interface ResolvedProviderIdentity {
  readonly name: string;
  readonly contractDigest: string | null;
}
/** What one pre-check needs beyond the view: the rows in play and their table. */
interface ProviderPrecheckRequest {
  /**
   * The capability rows in play, in the order they should be reported — the
   * matched rows of the batch's manifests (ordinary decomposition, replay) or
   * every row of the table (`capability_list`). A name the table does not hold
   * contributes nothing: resolution already refused it as a gap, which is a
   * different question from this one.
   */
  readonly capabilities: readonly string[];
  /** The capability table the rows were resolved from; its identity is part of {@link ProviderPrecheck.revision}. */
  readonly table: Readonly<Record<string, CapabilityConfig>>;
  /** Where discovery looks. */
  readonly view: SkillDiscoveryView;
  /**
   * The registered verifier ids (`VerifierRegistry.verifierIds()`, after
   * `ready()`), or absent when the registry cannot be listed.
   */
  readonly verifierRefs?: readonly string[];
}
/**
 * Every provider content identity one pre-check resolved, deduplicated by name
 * and sorted by it: the list a caller folds into whatever it records about the
 * resolution (the registry revision here, the review context in
 * `./proposal.ts`). One function so those two cannot disagree about what
 * "resolved" means: refused verdicts contribute nothing (a refused provider is
 * never something a run resolved against), and a name that appears in two rows
 * is one identity.
 */
declare function providerContentIdentities(capabilities: readonly CapabilityProviderPrecheck[]): ResolvedProviderIdentity[];
/**
 * Check every skill every listed capability declares, from one discovery
 * viewpoint.
 *
 * The rules, in the order they are applied per skill: it must be discoverable
 * from the view's roots; the directory it resolves to must pass
 * {@link validateSkillProvider} against the table and the verifier vocabulary.
 * An execution sidecar is refused when the vocabulary is unknown
 * (`verifierRefs` absent) — the one case the phase-1 validator cannot judge,
 * because it would read an empty list as "nothing is registered".
 *
 * Nothing is written and nothing is thrown: every refusal is a verdict, and
 * {@link providerRefusals} turns the refusals into the lines a caller reports
 * before it refuses the whole batch.
 */
declare function precheckProviders(request: ProviderPrecheckRequest): Promise<ProviderPrecheck>;
/**
 * One capability row as it would read after a replacement, checked by the same
 * pre-check a batch is admitted under: `entry` is folded into `table` — the row
 * as `config.yml` will hold it once written — and every skill the new row grants
 * is discovered from `view` and judged by {@link validateSkillProvider}, with
 * the row's own tool labels expanding through `resolveCapabilities` as the
 * covering set for a skill that declares this row.
 *
 * The two entries that write a row share this function, so the run-time registry
 * mirror (`TaskRuntime.applyCapabilityRow`) asks exactly the question the
 * promotion gate (`EvolutionService.checkPromotion`) asked before the row
 * reached `config.yml`: one composition, one vocabulary of refusals, no entry
 * that can be replaced without being judged. `refusals` is empty for a row that
 * grants no skill or only loadable providers.
 */
declare function precheckReplacedCapabilityRow(request: {
  /** The capability row being written. */
  readonly name: string;
  /** The row's entry as it will read after the replacement. */
  readonly entry: CapabilityConfig;
  /** The table the row is folded into — the replacement table, then. */
  readonly table: Readonly<Record<string, CapabilityConfig>>;
  /** Where discovery looks; a deployment's own process viewpoint or a worker's checkout. */
  readonly view: SkillDiscoveryView;
  /** The registered verifier ids (`VerifierRegistry.verifierIds()`), or absent when the registry cannot be listed. */
  readonly verifierRefs?: readonly string[];
}): Promise<{
  readonly precheck: ProviderPrecheck;
  readonly refusals: readonly string[];
}>;
/**
 * Every refused provider of one pre-check, one line each, naming the capability
 * that declares it, the skill, the directory when one was found, and every
 * defect with its code. Empty means the batch may proceed — which is a
 * statement about *loadable* providers only: this pre-check never adds a
 * capability to the closure, and knowledge/guidance verdicts are loadable
 * without being execution providers.
 */
declare function providerRefusals(precheck: ProviderPrecheck): string[];
/**
 * The same refusals, one line per defect: the shape a loud report wants, since
 * a caller reading a log needs the capability, the skill, the defect code and
 * the detail of each problem rather than a summary line per provider. The
 * load-time scan (`TaskRuntime.providerLoadReport`) prints these; admission
 * refuses a batch on {@link providerRefusals}.
 */
declare function providerDefectLines(precheck: ProviderPrecheck): string[];
//#endregion
//#region src/root-budget.d.ts
/**
 * The root budget as configured (`Config.rootBudget`). Every member is optional:
 * absent means the deployment sets no such limit, which is a statement about
 * what is enforced and must be read as one.
 */
interface RootBudgetConfig {
  /** Wall-clock the whole tree may take, measured from the root run's own `startedAt`. */
  wallTimeMs?: number;
  /** How many runs the tree may start, counted over the store's whole run list. */
  maxRuns?: number;
  /**
   * Writes that may hold one workspace at a time. This deployment enforces
   * exactly one, so any other value is a limit it cannot honor — see
   * {@link assertRootBudgetConfig}.
   */
  maxConcurrentWrites?: number;
}
/** A resolved root budget: the tree it belongs to, the instant it started, and the limits in force. */
interface ResolvedRootBudget {
  /** The store's root task (`parentTaskId === undefined`) — the tree the budget belongs to. */
  readonly rootTaskId: TaskId;
  /** The root run's persisted start, read from the store: the instant the budget was accepted. */
  readonly acceptedAt: string;
  /** `acceptedAt + wallTimeMs`, when a wall time is configured. */
  readonly deadlineAt?: string;
  /** The run count the tree may reach, when one is configured. */
  readonly maxRuns?: number;
}
type RootBudgetResolution = ({
  readonly ok: true;
} & ResolvedRootBudget) | {
  readonly ok: false;
  readonly reason: string;
};
/**
 * Whether a root budget enforces anything at all. The configuration's schema
 * materializes an absent `rootBudget` as an empty object, so the presence of an
 * object is not the question a refusal may ask: a budget with no member in force
 * is no budget, and an entry that refuses work over an unmeasurable tree would
 * otherwise refuse it for a limit this deployment never set. Every refusal that
 * is "a configured limit cannot be measured" asks this first.
 */
declare function hasRootLimits(config: RootBudgetConfig | undefined): boolean;
/** The verdict a start or a batch admission gets. A refusal always names the limit it hit. */
type BudgetVerdict = {
  readonly allowed: true;
} | {
  readonly allowed: false;
  readonly reason: string;
};
/**
 * The root budget a snapshot is under, or the reason none can be measured.
 *
 * The owner is the store's own root: among the parentless tasks, the one whose
 * run is bound to the root session the store id derives from
 * (`rootTaskStoreId`) — the same durable rule the recovery path uses to tell a
 * store's own root run apart from a replay's. A replay's task is parentless by
 * design and carries no such binding (its session is minted for the replay), so
 * it shares the root's total instead of claiming a budget of its own (§3.5, the
 * funding-root reference); inventing one for it would hand every experiment a
 * fresh allowance. No run naming a root session of this store means no owner,
 * and the store keeps the honest recovery diagnostic rather than a guess.
 *
 * `reason` texts are recovery diagnostics: they say what is missing (no root,
 * no run bound to this store as its root, several such tasks, a root run with
 * no readable start) so an operator reading `task_status` knows why the tree
 * cannot be started under a budget instead of being handed a fabricated one.
 */
declare function resolveRootBudget(snapshot: TaskSnapshot, config: RootBudgetConfig): RootBudgetResolution;
/**
 * Whether a run may start under the budget. Two refusals, in this order: the run
 * count has reached `maxRuns` (the limit is a count of what the store already
 * holds, so a restart cannot refund it), or the root deadline has arrived.
 */
declare function checkRunStart(snapshot: TaskSnapshot, budget: ResolvedRootBudget, nowMs?: number): BudgetVerdict;
/**
 * Whether a decomposition batch of `childCount` children may be admitted. The
 * check is a reservation, not a forecast: the children will each start a run, so
 * a batch that would push the tree past `maxRuns` is refused whole — before a
 * task, a child or an event exists — rather than admitted and then started until
 * the budget runs out mid-batch.
 */
declare function checkBatchAdmission(snapshot: TaskSnapshot, budget: ResolvedRootBudget, childCount: number): BudgetVerdict;
/**
 * What is left of the tightest deadline that applies to a run, in milliseconds.
 *
 * `min` semantics over the bounds that can be in force: the run's own wall time
 * measured from its persisted `startedAt` (so a resumed run keeps the clock it
 * started with) and what is left of the root's deadline. A bound that has passed
 * returns 0 rather than a negative number, and `Infinity` means no bound at all
 * is configured.
 *
 * A bound whose instant cannot be read is treated as *reached* (`0`): a start
 * time nobody can parse is not a licence to run without a deadline, which is the
 * same discipline `resolveRootBudget` applies to a missing root start.
 */
declare function runDeadlineMs(runStartedAt: string, perRunWallTimeMs: number | undefined, rootDeadlineAt: string | undefined, nowMs: number): number;
/**
 * How many entries one task's subtree holds — the progress measure the
 * no-progress rule counts. The subtree is the task itself plus everything
 * reachable through `childTaskIds` (a cycle is walked once), and each collection
 * is filtered by the side of the relation that names a task in it: runs by their
 * `taskId`, edges by either end, evidence/reviews/diagnoses by `taskId`,
 * handoffs by either `parentTaskId` or `childTaskId`, obligations by
 * `sourceTaskId`. The count is of *entries*: an id in the subtree with no task
 * record contributes no task entry, while its runs, edges and evidence still
 * count, because those entries exist and name it.
 *
 * Pure: the same snapshot always yields the same count, so a reviewer can
 * recompute it without replaying anything.
 */
declare function countSubtreeFacts(snapshot: TaskSnapshot, taskId: TaskId): number;
/**
 * Refuse a root budget this deployment cannot execute. The one such limit is
 * `maxConcurrentWrites`: the workspace registry enforces exactly one writer, so
 * a configuration asking for any other number is a hard limit nobody can honor —
 * and §3.5's rule is that asking for an unenforceable hard limit refuses to
 * start rather than starting under a limit that is not real. Everything else
 * about the shape (unknown members, negative values) is the Config schema's
 * business, checked where the configuration is loaded.
 */
declare function assertRootBudgetConfig(config: RootBudgetConfig): void;
//#endregion
//#region src/mcp-servers.d.ts
/**
 * The env binding one spawn resolves server templates against. Produced by
 * `OrchestrateEnv.resolveMcpEnv` from the graph's env record; absent when the
 * caller's session has no graph env (root-side contexts, test harnesses).
 */
interface McpEnvBinding {
  /** The environment root (`environment/projectN`). */
  envRoot: string;
  /** The checkout path of one planned repository (`<envRoot>/<owner>/<repo>`), or undefined when the env has no such component. */
  checkout(repo: string): string | undefined;
}
/**
 * One registered MCP server, before env binding. Any string field may carry
 * `{envRoot}` or `{repoRoot:<repo>}` placeholders; a server whose template is
 * placeholder-free binds no env and mounts the same everywhere.
 */
interface McpServerTemplate {
  /**
   * The namespace the server's tools publish under (`mcp__<serverName>__<tool>`).
   * Must satisfy mcp-client's `[A-Za-z0-9_-]{1,32}` and stay unique per worker.
   */
  serverName: string;
  /** What the server covers, for `capability_list` and table reviewers. */
  description: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  /** Per-tool-call deadline handed to mcp-client; defaults to the client default (60 s). */
  toolCallTimeoutMs?: number;
}
/**
 * The servers a capability may name. `bbdev` is the buckyball checkout's own
 * FastMCP server (45 tools, submit/poll-shaped to stay under the per-call
 * timeout). It binds `{repoRoot:buckyball}`: the worker's env must contain a
 * buckyball checkout, and a capability that names it on an env without one
 * fails the spawn loudly.
 */
declare const MCP_SERVER_REGISTRY: Readonly<Record<string, McpServerTemplate>>;
/** Every MCP server name one resolved manifest grants, first-declaration order, duplicates dropped. */
declare function manifestMcpServers(manifest: {
  capabilities: Record<string, {
    mcpServers?: string[];
  }>;
}): string[];
/**
 * Materialize one manifest's MCP grants into mount-ready specs.
 * @param manifest - the resolved capability manifest (server names already validated at admission).
 * @param binding - the run's env binding, or undefined when the session has none.
 * @param registry - the template table; a parameter so tests can exercise bad
 *   templates (unknown placeholders) that the shipped registry must never hold.
 * @returns one spec per distinct granted server, in first-declaration order.
 * @throws when a granted name is outside the registry, when an
 *   env-needing server has no binding, or when its repo is absent from the env.
 */
declare function resolveMcpServerSpecs(manifest: {
  capabilities: Record<string, {
    mcpServers?: string[];
  }>;
}, binding: McpEnvBinding | undefined, registry?: Readonly<Record<string, McpServerTemplate>>): McpServerSpec[];
//#endregion
//#region src/run-binding.d.ts
/** The directory under one run's own directory that holds its `<name>/SKILL.md` entries — a skill root as `WorkerGrant.skillRoots` expects. */
declare const RUN_BINDING_SKILLS_DIR = "skills";
/**
 * Where run bindings are materialized unless the deployment says otherwise:
 * `<DSH_HOME or ~/.dsh>/singularity/run-bindings`, resolved per call so a test
 * (or a deployment) that moves `DSH_HOME` moves the snapshots with it.
 *
 * Outside the worker's checkout on purpose: the run's cwd is where a worker
 * writes, and content it can rewrite under itself would make "the worker loaded
 * the bound bytes" unverifiable. A snapshot is re-checked against its digest on
 * every read, so even a writer that reaches it cannot make it pass for
 * something else — but the ordinary case should not depend on that.
 */
declare function defaultRunBindingRoot(): string;
/** Everything one run needs to bind its content: the verdicts, the rows, and where the snapshot goes. */
interface RunBindingRequest {
  /** The store the run belongs to; scopes the snapshot directory. */
  storeId: string;
  /** The run the snapshot is scoped to. */
  runId: RunId;
  /** The run's resolved manifest: its rows are the run's capability rows and its granted servers. */
  manifest: CapabilityManifest;
  /**
   * The admission-time pre-check this run's verdicts come from. Absent when the
   * caller assembled the plan itself (a hand-built cascade): then no binding is
   * recorded and the grant keeps its discovery-time behaviour, because there is
   * no judged identity to bind.
   */
  providers?: ProviderPrecheck;
  /** The capability table the run resolved against; its revision is recorded when no pre-check carries one. */
  table?: Readonly<Record<string, CapabilityConfig>>;
  /** Where the run snapshot is materialized; absent means this deployment cannot materialize content, which fails a run that selected any. */
  root?: string;
  /** The MCP template registry the granted server names resolve against (tests pass their own). */
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>;
}
/**
 * Bind one run's content: identify the providers its admission judged,
 * materialize their admitted bytes, and verify the snapshot against the record
 * before it is handed back to be stored.
 *
 * Returns `undefined` for a run that has capability rows but no pre-check — a
 * caller that assembled its plan itself. Such a run's grant resolves its skills
 * at spawn through the deployment's own discovery, which is exactly the mutable
 * path this module exists to close, so **nothing is claimed**: the run records no
 * binding at all rather than a record that looks authoritative and describes
 * bytes nobody judged. Every production entry runs the pre-check, so this is the
 * hand-built-caller case only.
 *
 * Throws — with the skill or the path named — when the admitted bytes are no
 * longer there, when the deployment cannot materialize at all, or when the
 * snapshot does not read back as the record describes it. A throw means the run
 * records no binding and loads no content: there is no state in which a run
 * claims content it did not load.
 */
declare function bindRunProviders(request: RunBindingRequest): Promise<RunProviderBinding | undefined>;
/** One skill's re-read result: whether the snapshot still holds the bytes the record names, and why not. */
interface RunBindingSkillRead {
  /** The skill name the record names. */
  readonly name: string;
  /** The role the run was bound to it as. */
  readonly role: RunSkillBinding['role'];
  /** True when the snapshot directory holds exactly the recorded content and declaration. */
  readonly readable: boolean;
  /** Every reason this skill's content is not readable as recorded, each naming its code. */
  readonly defects: readonly string[];
}
/** What re-reading one run's binding found. */
interface RunBindingRead {
  /** The snapshot root the record names. */
  readonly snapshotRoot: string;
  /** One entry per skill in record order. */
  readonly skills: readonly RunBindingSkillRead[];
  /** Every reason any skill's content is not readable as recorded; empty means the whole snapshot verified. */
  readonly defects: readonly string[];
}
/**
 * Re-check one run's binding against the bytes its snapshot holds now — the read
 * a later reader (an old run's summary, a re-entry, a recovery path) performs
 * before trusting the record.
 *
 * The check is the loader the pre-check uses, so "the snapshot is the admitted
 * content" is judged by the same rules that admitted it: the `SKILL.md` and the
 * declared resources must hash to the recorded content identity, the sidecar to
 * the recorded contract identity, the frontmatter must declare the skill's own
 * name, and the snapshot root must hold exactly the recorded skills — an extra
 * directory would be registered into a worker's layer, so it is reported rather
 * than ignored.
 *
 * One more thing is re-read for a guidance skill: the loader names the entries
 * of its directory that the content identity does not cover (the same list
 * admission recorded as `uncovered`), and a snapshot must hold its bound content
 * only. An entry that appeared there since admission is therefore reported with
 * its name — the record described a directory that does not match these bytes —
 * while an entry the record lists as uncovered and absent from the snapshot is
 * simply a correct snapshot: materialization copies the identity's files, so a
 * source directory's uncovered entries never reach a run.
 *
 * Returns `undefined` for a record that names no snapshot: a run that loaded no
 * content (a deterministic criteria replay, a run with no provider) has nothing
 * to re-read, which is not the same as content that failed to re-read.
 */
declare function readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined>;
//#endregion
//#region src/normalize.d.ts
/** Where one batch came from: the store, the parent, its run, and the caller that submitted it. */
interface DecompositionIdentityContext {
  storeId: string;
  parentTaskId: string;
  parentRunId: string;
  callerSessionId: string;
}
interface NormalizationContext extends DecompositionIdentityContext {
  /** The limits in force, resolved by the caller from its configuration and recorded verbatim with the batch. */
  admissionContext: AdmissionContext;
}
/** One normalized child: its contract plus the batch facts the identity covers. */
interface NormalizedChild {
  contract: TaskContract;
  dependsOn: number[];
  decomposable: boolean;
  requiresIndependentAcceptance: boolean;
}
interface NormalizedBatch {
  contractVersion: TaskContractVersion;
  /** The caller's reason, verbatim — part of {@link decompositionIdentity}, so a writer that records the batch's identity records this text. */
  reason: string;
  children: NormalizedChild[];
  /** The batch identity and the limits it was admitted under, ready to be recorded with the decomposition. */
  admission: DecompositionAdmission;
}
/**
 * The identity one batch is digested over (§4): where it came from, which
 * contract language it is written in, the caller's reason, and the complete
 * ordered children — each child reduced to its contract digest and the batch
 * facts the identity covers.
 *
 * One construction, shared by {@link normalizeDecomposition} (which digs the
 * batch) and by any writer that has to *name* the batch rather than digest it
 * (the runtime's proposal record, whose `proposalDigest` has to be the same
 * number the admission recorded). Two constructions of one identity would
 * eventually disagree, and a proposal whose digest is not the batch's would
 * make every approval binding meaningless.
 */
declare function decompositionIdentity(context: DecompositionIdentityContext, reason: string, children: readonly NormalizedChild[]): DecompositionIdentity;
type NormalizationResult = {
  ok: true;
  batch: NormalizedBatch;
} | {
  ok: false;
  reasons: string[];
};
/**
 * Normalize one decomposition proposal.
 *
 * Returns every defect it found, never the first: a caller revising a proposal
 * needs the whole list, and a batch that returns at all is one the digest could
 * describe. A refusal is a value, never a throw.
 */
declare function normalizeDecomposition(spec: unknown, context: NormalizationContext): NormalizationResult;
type RootNormalizationResult = {
  ok: true;
  contract: TaskContract;
} | {
  ok: false;
  reasons: string[];
};
/**
 * Normalize one root contract (A0 §2–§3): the caller's single contract —
 * objective, criteria, assumptions, constraints, declared capabilities — in,
 * its canonical {@link TaskContract} out, or every reason it was refused.
 *
 * It shares the contract-level rules with {@link normalizeDecomposition} rather
 * than restating them: the same closed field set per criterion (an undeclared
 * key is refused by name, never dropped), the same verbatim text rule (blankness
 * is refused, bytes are not rewritten), the same defaults (an omitted list is
 * `[]`, an omitted `mandatory` is `true`, an absent mode follows the command),
 * and the same criterion-id fixing — with the root's own id scheme
 * ({@link rootCriterionId}).
 *
 * What it does *not* do: structural admission. `contractDefects`, the root's
 * own independent-criterion rule (`admission.ts:rootIndependenceDefects`), the
 * protected-input shape rule and every capability/provider/verifier question are
 * asked by the intake entry over the value this returns, exactly as the
 * decomposition path asks them over a normalized batch. And it writes nothing:
 * the caller has the whole contract or a list of reasons, and a refused root
 * contract leaves no id, no event and no file read behind it.
 *
 * The `contractVersion` gate is the batch's: absent is this build's version (the
 * caller that does not version its input means the current language), and a
 * declared version whose field semantics this build does not know is refused
 * rather than read with today's reader.
 */
declare function normalizeRootContract(spec: unknown): RootNormalizationResult;
//#endregion
//#region src/workspace.d.ts
/** The directory under a deployment's run-binding root that holds ownership markers (§3.4). */
declare const WORKSPACE_OWNERS_DIR = "workspace-owners";
/**
 * Who holds a workspace. One shape for the three roles the protocol gives it:
 * the run that is writing, the verifier that owns the checkout exclusively
 * while it judges, and the runtime itself in the gap between children.
 */
interface WorkspaceOwner {
  kind: 'run' | 'verifier' | 'batch';
  /** The store this owner belongs to; a second store claiming the same checkout is a conflict, not a merge. */
  storeId: string;
  taskId?: TaskId;
  runId?: RunId;
  batchId?: string;
  /** When this owner took the workspace (the marker's own instant). */
  since: string;
}
/**
 * A workspace that cannot be claimed because something already holds it — or
 * because a marker exists that cannot be read as a holder. Carries the three
 * things a caller needs to report it: which workspace, who holds it, and since
 * when. `owner`/`since` are absent only in the unreadable-marker case, where
 * nothing on disk names a holder; the message says so instead of inventing one.
 */
declare class WorkspaceBusyError extends Error {
  readonly workspace: string;
  readonly owner?: WorkspaceOwner;
  readonly since?: string;
  constructor(workspace: string, owner: WorkspaceOwner | undefined, since: string | undefined, detail: string);
}
/**
 * What `reconcileAdopt` found. `adopted` true means the caller may start owning
 * the workspace (nothing held it, or a stale marker was cleared); `adopted` false
 * leaves every byte as it was and names why.
 */
type WorkspaceAdoption = {
  readonly adopted: true;
} | {
  readonly adopted: false;
  readonly reason: string;
};
interface WorkspaceRegistryOptions {
  /** Where markers live (a deployment passes `<runBindingRoot>/workspace-owners`). Created on demand. */
  markerRoot: string;
  /**
   * The pid this registry runs as; defaults to `process.pid`. Injected so a test
   * can stand in for another process's registry, and so a marker can be written
   * that names a pid this process is not.
   */
  pid?: number;
}
/**
 * Resolve a checkout path the way ownership keys it: absolute, with symbolic
 * links resolved, so the two spellings of one directory cannot become two
 * markers. Throws when the path cannot be resolved (absent, a broken link, no
 * permission) — a workspace whose identity is unknown is not a workspace this
 * module will record an owner for.
 */
declare function normalizeWorkspacePath(path: string): Promise<string>;
/**
 * The kernel's start-time token for `pid`, or `undefined` when it cannot be read
 * (a non-Linux platform, a pid that is gone, a process this user may not stat).
 * Exported because it is the one honest pid-reuse check available here: compare
 * it with the value a marker recorded.
 */
declare function readProcessStartTime(pid: number): Promise<string | undefined>;
declare class WorkspaceRegistry {
  private readonly markerRoot;
  private readonly pid;
  private readonly stacks;
  /**
   * One marker-mutation chain per workspace: every write and delete joins the
   * tail of its workspace's chain, so overlapping mutations of one marker land
   * in the order they were called — the same order the stack was mutated in.
   * A rejected mutation is carried past, never stored: a write that failed
   * (a permission, a full disk) must not wedge the mutations behind it, and its
   * caller still sees the rejection it has to report.
   */
  private readonly markerWrites;
  constructor(options: WorkspaceRegistryOptions);
  /** Queue one marker mutation after the ones this workspace already has in flight, in call order. */
  private queueMarkerMutation;
  /** Where one workspace's marker lives — derived from the path as given, so it is the same key the stack uses. */
  markerPath(workspace: string): string;
  /** The owner on top of the stack, or `undefined` when this process holds nothing for the workspace. */
  ownerOf(workspace: string): WorkspaceOwner | undefined;
  /**
   * Take a workspace for `owner`. Refuses — before anything is written, so a
   * refused claim leaves the marker exactly as it was — when this process
   * already holds it, or when any marker is already there.
   */
  claim(workspace: string, owner: WorkspaceOwner): Promise<void>;
  /**
   * Hand the workspace from `from` (which must be the current holder) to `to`,
   * pushing `to` on the stack and rewriting the marker to name it. The stack is
   * the ownership history: the run at the bottom keeps its claim while its batch
   * and current child are on top of it.
   */
  push(workspace: string, from: WorkspaceOwner, to: WorkspaceOwner): Promise<void>;
  /**
   * Release `owner`, which must be the current holder. A mismatch throws with
   * both owners named — popping a lower holder would hand the checkout to
   * someone while a writer still believes it holds the workspace. The last
   * release deletes the marker; an earlier one rewrites it to the new top.
   */
  release(workspace: string, owner: WorkspaceOwner): Promise<void>;
  /**
   * Take over a marker whose owning process is gone — the recovery path only,
   * and the only way a stale marker is ever cleared. An absent marker is a
   * success that changes nothing; a marker whose pid is alive, or whose bytes
   * cannot be read as a marker, is a refusal that leaves
   * everything in place, because adopting it would hand the checkout to a caller
   * while a writer that may still be running has no idea.
   */
  reconcileAdopt(workspace: string): Promise<WorkspaceAdoption>;
  /**
   * Release everything this process still holds, as an unload path does. Only
   * markers that name this process's pid are deleted: a marker written by
   * another process describes a writer this unload knows nothing about, and
   * removing it could hand a checkout to the next caller while that writer runs.
   */
  close(): Promise<void>;
  /** The busy error a marker earns: whose, why, and — when the recorded start time disagrees — that the pid was reused. */
  private busyFromMarker;
  private readMarker;
  private writeMarker;
  private removeMarker;
}
//#endregion
//#region src/orchestrate.d.ts
/** Raised when the verifier service (ticket C2) is not loaded in the context. */
declare class VerifierUnavailableError extends Error {
  name: string;
}
interface ChildOutcome {
  taskId: TaskId;
  runId?: RunId;
  status: 'verified' | 'failed' | 'blocked' | 'cancelled';
  /**
   * The evidence bundle the run left, named whatever its verdict — the store has
   * one settlement path since A3, so a failed run whose criteria were judged
   * carries the bundle that judged them exactly as a verified one does. Absent
   * when the run produced none (a spawn refusal, a run that never started).
   */
  evidenceId?: string;
}
/**
 * One ended batch's result, handed to the Session that was waiting for it (K1
 * §2): the batch's identity, the run whose wait it ends, the Session it goes to,
 * and the body the store's own facts render to.
 *
 * Both halves are *derived*, never minted: the identity is
 * `m-batchend-<batchId>` ({@link batchEndMessageId}) and the body is rendered
 * from the members' terminal states and evidence
 * ({@link batchEndMessageText}), so the delivery this process performs, a
 * re-delivery after a restart and a recovery pass all state one message — and
 * the target Session's own fold, never a ledger here, decides whether it is
 * already present.
 */
interface BatchResultMessage {
  readonly storeId: string;
  readonly runId: RunId;
  readonly batchId: string;
  /** The parent's own Session: the target of the message and the Session it is sent from. */
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
}
/**
 * What one end-of-batch delivery settled as. `unavailable` and `refused` are
 * reported, never fatal; `skipped` is a delivery that was deliberately not
 * attempted — the run the message addressed is no longer running, and a terminal
 * run is not woken (K1 §2: 绝不唤活终态). A skipped delivery has zero side
 * effects, and unlike `unavailable` it is not retried: the fact it would point
 * at is moot for a run that already settled.
 */
type BatchResultDeliveryStatus = 'delivered' | 'already-present' | 'unavailable' | 'refused' | 'skipped';
interface SpawnChildRequest {
  sessionId: string;
  name: string;
  agentPreset?: string;
  /** Permission preset the child session is switched to (capability-granted; absent keeps the default posture). */
  permissionPreset?: string;
  /** Capability-derived authorization the agent runtime applies before the worker is published. */
  grant?: WorkerGrant;
  /**
   * Marks the child as a task worker of this runtime (A2): the agent runtime
   * installs the stable worker policy section and the default kickoff, and the
   * context assembly injects the child's contract and state from the store —
   * this request carries no prompt and no contract text of its own, because a
   * spawn prompt is a surface a fold can shadow and the store is the authority.
   */
  taskWorker?: boolean;
  /**
   * The working directory the child's session starts in. Absent inherits the
   * caller's own cwd, which is what every ordinary run does; the orchestration
   * names one when its sessions work somewhere else ({@link
   * OrchestrateEnv.workerCwd}).
   */
  cwd?: string;
  /**
   * The model selection the child's agent is created under, replacing the
   * deployment's own default for this worker alone (`AgentRuntime.spawn` merges
   * it over `agentDefaultModel.currentSelection()`). A replay carries the
   * experiment's frozen selection here (S4-E §Q3) and the sub-execution it
   * spawns inherits it ({@link OrchestrateEnv.agentOptions}).
   */
  agentOptions?: AgentOptions;
  signal?: AbortSignal;
}
/**
 * One task run's resource budget (KISS §5 "预算即法律": any exhaustion forces
 * the exit, never a silent degradation). Every member is optional; the runtime
 * resolves its shipped defaults per key.
 *
 * What the orchestrator can honestly enforce is bounded by what it can observe
 * of an in-flight run — and that is only the wall clock (it awaits the
 * worker's idle) plus, at terminal time, one best-effort read of the run's
 * session log and token projection ({@link OrchestrateEnv.observeSession}):
 *
 * - `wallTimeMs` — **enforced in flight**: the worker wait races the deadline;
 *   on exhaustion the agent is cancelled and the run settles failed with
 *   `budget exhausted: wallTimeMs (...)`, named as a budget exhaustion, not a
 *   criteria failure. The same clock bounds the run a batch settles on its worker's
 *   behalf: a parent whose deadline has already passed is cancelled instead of
 *   ended (`finishBatch`), so no run is reported `verified` after the
 *   clock that was supposed to stop it.
 * - `maxToolCalls` — **post-hoc check only**: the session log is readable only
 *   once the run has settled, so a breach lands as an anomaly on the terminal
 *   review record (the verdict stands — the evidence is real). It is never
 *   presented as in-flight enforcement.
 * - `tokens` — **post-hoc check only**: same terminal seam, and the runtime
 *   ships no default for it — the only observation is the whole-session
 *   cumulative projection, systematically high for a long-lived root session,
 *   so no honest constant exists. Configured, a breach is annotated the same
 *   way.
 * - `attempts` — **declared, not enforced**: the orchestrator has no retry
 *   branch (guide §3.1 Non-Goals), so a run-count cap has nothing to gate; the
 *   field ships with the rest so the retry branch has its knob when it lands.
 */
interface BudgetConfig {
  maxToolCalls?: number;
  tokens?: number;
  wallTimeMs?: number;
  attempts?: number;
}
/** Per-call overrides the cascade forwards on every verifier call (ticket C2's `VerifyRunOptions`). */
interface VerifyRunOptions {
  /** Working directory for criterion commands — the env checkout the workers ran in. */
  cwd?: string;
  /** The verifier's own deadline for this call; the verifier kills whatever it started. */
  timeoutMs?: number;
}
/**
 * Raw, session-scoped facts the deployment's session services report for one
 * run's session. Deliberately plain data: the cascade never touches cordis, so
 * whoever implements {@link OrchestrateEnv.observeSession} does the reading and
 * name classification, and this module only assembles the record from it.
 *
 * Every member is optional because every read is best-effort: a deployment with
 * no session-query, no projections, or a session the reader cannot load reports
 * `undefined` rather than an empty object, and the corresponding record field is
 * then omitted instead of being written as 0.
 */
interface SessionObservation {
  /** Whole-session token buckets from the session's `tokenUsage` projection. */
  tokens?: ReviewTokenUsage;
  /** Tool traffic the session log shows; absent when no log was readable. */
  tools?: {
    /** One entry per distinct tool name, with its call count. */
    calls: ReviewToolCall[];
    /** How many `tool/result` events reported a failure. */
    failures: number;
  };
  /** Skill names the session's `skill` calls loaded, in call order, duplicates preserved. */
  skillCalls?: string[];
  /** Human-intervention events in the session log (`approval/asked` plus the human-facing tools). */
  humanInterventions?: number;
  /** `compaction/start` events observed in the session log. */
  compactions?: number;
}
/** The service-supplied seam the cascade runs against (keeps this module free of cordis types). */
interface OrchestrateEnv {
  task: TaskService;
  actor: string;
  defaultPreset?: string;
  /** Optional preflight: throw when the deployment cannot mount this preset id (unknown or broken). */
  assertPreset?(preset: string): Promise<void>;
  /**
   * Optional resolver for permission preset names to their knob bundle (the
   * `permissionPresets` registry's `resolve`). Required to rank and validate
   * capability-declared permissions; absent, the first declared name passes
   * through and the spawn's own `permissionPresets.set` validates it.
   */
  resolvePermissionSpec?(name: string): PermissionSpec;
  /**
   * Optional env binding for capability-declared MCP servers
   * (`mcp-servers.ts`): the caller session's graph env, or `undefined` when
   * the session binds none. Consulted only when a manifest declares servers;
   * a declared server with no binding fails the spawn loudly.
   */
  resolveMcpEnv?(): Promise<McpEnvBinding | undefined>;
  verifyTimeoutMs: number;
  /** The resolved per-run budget; which member is enforced in flight, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  budget?: BudgetConfig;
  /**
   * `Config.allowRuntimeDecomposition`, carried to the worker prompt: a `leaf`
   * worker has to be told the door is open before it can walk through it, and a
   * switch-off deployment must not be told otherwise.
   */
  allowRuntimeDecomposition: boolean;
  spawn(request: SpawnChildRequest): Promise<AgentHandle>;
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  /** Optional tail reader for verifier logs (logRef relative to the verifier's evidence root); absent keeps logTail off failed records. */
  readLogTail?(logRef: string): Promise<string | undefined>;
  /**
   * Where a run's bound content is materialized (S1-C, `Config.runBindingRoot`).
   * Absent means this deployment cannot materialize content: a run that selects
   * any skill then fails by name rather than loading a path nothing judged.
   */
  runBindingRoot?: string;
  /**
   * Optional session reader for the review record's dimensions and metrics
   * (§2.7.3): one read of a run's session log and token projection. Absent — or
   * a rejection — keeps only the store-derived facts; it can never fail a review.
   */
  observeSession?(sessionId: string): Promise<SessionObservation | undefined>;
  onRunBound(sessionId: string, binding: {
    storeId: string;
    taskId: TaskId;
    runId: RunId;
  }): void;
  /**
   * The runtime's tool-execution gate (A3 §3.3). The orchestration owns the
   * phase of every session it spawns — a worker that has submitted, a parent
   * waiting on its children — and this is where those phases are recorded and
   * where the write drain is run. Required: a deployment that cannot gate its
   * own sessions cannot honestly promise "nothing writes after admission
   * closed", and every caller here has one (the runtime constructs it).
   */
  gate: ExecutionGate;
  /**
   * The one-writer-per-workspace registry (A3 §3.4), with the checkout this
   * orchestration's sessions run in ({@link OrchestrateEnv.workspacePath},
   * already normalized by the caller — the registry resolves nothing itself).
   * Both absent means this deployment cannot name a checkout, and ownership is
   * skipped rather than guessed; one without the other is a wiring defect the
   * orchestration reports instead of silently skipping the hold.
   */
  workspaces?: WorkspaceRegistry;
  workspacePath?: string;
  /**
   * The directory every worker this orchestration spawns starts in, when the
   * checkout it works in is not the one its caller's session inherits. A replay
   * the caller placed in a workspace of its own names it, and its children inherit
   * it the same way an ordinary child inherits its parent's cwd. Absent — the
   * ordinary case — keeps every spawn on the parent session's own cwd.
   */
  workerCwd?: string;
  /**
   * The model selection every worker this orchestration spawns is created under,
   * when the run it serves is bound to one. A replay carries the experiment's
   * frozen selection (S4-E §Q3) and its sub-execution inherits it — the same
   * session-level propagation {@link OrchestrateEnv.workerCwd} has, because a
   * comparison whose candidate subtree quietly ran the default model describes
   * something neither side measured. Absent — the ordinary case — keeps every
   * spawn on the deployment's own default selection.
   */
  agentOptions?: AgentOptions;
  /**
   * The provider pre-check, for the one case that has no verdict to carry: a
   * batch whose admission happened in an earlier process. A freshly admitted
   * batch carries its verdicts ({@link BatchContext.providers}) and never
   * calls this.
   */
  precheck?(capabilities: readonly string[], cwd: string | undefined): Promise<ProviderPrecheck>;
  /**
   * Best-effort owner notification (`agent.followup` on a live session, DSH's
   * tool-jobs notice precedent). A session with no live agent is skipped, and
   * a failing notification never fails the settlement it reports on.
   */
  notify?(sessionId: string, text: string): void;
  /**
   * Deliver one ended batch's result to its parent's Session (K1 §2) — the wake
   * that tells the parent it is `active` again, that the workspace is back, and
   * that only its own submission starts its acceptance.
   *
   * The delivery is addressed by the identity the batch derives, so a second
   * call delivers nothing when the target already holds that message: a caller
   * may call this again after a crash, and the runtime's recovery pass calls it
   * for the batches a store still owes. Absent means this deployment has no
   * relay: the batch still ends, and the caller falls back to a plain notice.
   */
  deliverBatchResult?(message: BatchResultMessage): Promise<BatchResultDeliveryStatus>;
  /**
   * Observe one run's terminal transition: subscribe, then read the current
   * state, so a run that settled between the caller's last read and the
   * subscription is not missed. Returns the unsubscribe function. The runtime
   * implements this over the task service's `task/change` event.
   */
  watchRun?(storeId: string, runId: RunId, cb: (status: RunStatus) => void): () => void;
  /** The root budget in force (`Config.rootBudget`); absent means this deployment sets no root limits. */
  rootBudget?: RootBudgetConfig;
  /**
   * No-progress rounds before a worker that went idle without submitting is
   * stopped (`Config.noProgressRounds`). The count is consecutive and derived
   * from the store's own last marking, so it survives a resume.
   */
  noProgressRounds: number;
  /** How long a write drain may take before it is reported as unconfirmed (`Config.writeDrainTimeoutMs`). */
  writeDrainTimeoutMs: number;
  /** The jobs service the drain kills and waits on; absent means this deployment has no managed jobs. */
  jobs?: JobsView;
  /** The agent a run's session currently resolves to, if any — the authorization a jobs call carries. */
  agentFor?(sessionId: string): unknown;
  /**
   * Runtime bookkeeping at a run's terminal transition: the gate closes for
   * that session (only coordination tools remain) and the workspace the run
   * held is released. Called once per run this orchestration settles, adopted
   * terminal states included.
   */
  onRunSettled?(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void;
  /**
   * The runtime's batch-failure seam: every child of the batch that has not
   * reached a terminal state is blocked and the batch's parent run is failed
   * with `reason`. Used for a failure the driver cannot settle from where it
   * stands — verification being unavailable in a *nested* submission is the
   * case it exists for (A3 §3.1, the `VerifierUnavailableError` rule).
   */
  failBatch?(storeId: string, batchId: string, reason: string): Promise<void>;
  /**
   * Bring one adopted worker's Session back live under its own identity (A4
   * §F.1) — the runtime's own door into `AgentRuntime.resumeWorkerAgent`, with
   * the run binding, the store-derived gate and the managed-work reconciliation
   * the resume owes. The *authorization* is not passed by the driver: this
   * module rebuilds it from the store with the same helpers the spawn used
   * ({@link resumeAdoptedWorker}), because a driver has nothing to add to it.
   *
   * Absent means this deployment cannot bring a worker back, and a
   * question-waiting run nobody can reach fails by name rather than waiting
   * forever (see {@link resumeAdoptedWorker}).
   */
  resumeWorkerSession?(request: AdoptedWorkerResumeRequest): Promise<AdoptedWorkerResume>;
}
/**
 * What one request to bring an adopted worker's Session back states: the run
 * the store holds and the authorization rebuilt for it — never a second
 * composition, grant or preset invented by the caller.
 */
interface AdoptedWorkerResumeRequest {
  readonly storeId: string;
  /** The run as the store records it: the identity the resume must reproduce, not a copy the caller may edit. */
  readonly run: TaskRun;
  /** The grant rebuilt from the run's manifest and its own binding, exactly as the spawn resolved it. */
  readonly grant: WorkerGrant;
  /** The permission preset the spawn admitted the run under; absent = the spawn's own default. */
  readonly permissionPreset?: string;
  /** Whether the run's Session was spawned as a task worker. */
  readonly taskWorker: boolean;
}
/**
 * What one attempt to bring an adopted worker back settled as (A4 §F.1):
 *
 * - `live` — the same Session is live in this process now (or already was), so
 *   what is owed it can be delivered and its wait can be observed;
 * - `retry` — another owner holds the Session (`ownership-conflict`). Nothing is
 *   taken over, the run keeps its identity, and the wait stays bounded by the
 *   deadline; the next activation retries;
 * - `refused` — the resume could not be established under this identity
 *   (`session-missing`, `session-unreadable`, `binding-mismatch`,
 *   `not-in-graph`, `member-facts-missing`, `takeover-refused`, or a refusal of
 *   the managed-work reconciliation). The caller must walk the run to a terminal
 *   state: an in-flight run nobody can bring back is a dead wait, not a wait.
 */
type AdoptedWorkerResume = {
  readonly status: 'live';
} | {
  readonly status: 'retry';
  readonly reason: string;
} | {
  readonly status: 'refused';
  readonly reason: string;
};
/**
 * Rebuild the authorization a recovery pass has to state for one run, from the
 * store's own records, and hand it to the deployment's resume door.
 *
 * **Why it is rebuilt here and not remembered:** the spawn's grant is a
 * function of durable facts — the task's manifest in the store, and the run's
 * own provider binding — so the same helpers that resolved it at spawn
 * (`authorizedGrant`, `permissionFor`, `skillRootsForRun`) resolve it again.
 * A grant recorded somewhere and handed back would be a second source of
 * authorization that could drift from the manifest it came from; and a resume
 * states the plane it *would* install so the Session's own durable record can
 * refuse a grant it never ran under.
 *
 * The one thing this cannot rebuild is an overlay the spawn took from the
 * caller rather than from the store — a replay's candidate skill roots
 * (`ReplayOverlay.extraSkillRoots`, A6/S2-R's own subject). What is rebuilt is
 * the run's own binding snapshot, which is what a resumed worker loads its
 * content from; the candidate overlay of an interrupted experiment is not part
 * of the run's record and is not invented here.
 * @param env - the deployment's seam, for the store, the permission registry and the resume door.
 * @param storeId - the store the run belongs to.
 * @param run - the run as the store records it.
 * @returns what the attempt settled as, never a throw for a named refusal.
 */
declare function resumeAdoptedWorker(env: OrchestrateEnv, storeId: string, run: TaskRun): Promise<AdoptedWorkerResume>;
/**
 * What a *runtime-level* settlement holds — the slice of {@link OrchestrateEnv}
 * that a terminal record, a notification and a workspace release actually read.
 *
 * Why it exists as its own type (A4-5): the paths that settle a batch without a
 * driver (`failBatch`, and the runtime's own fallback for a driver that rejected
 * before it could settle anything) are the very paths whose environment could
 * not be built, and building one only to write a terminal state would leave the
 * settlement as unreachable as the thing that failed. `OrchestrateEnv` satisfies
 * this structurally, so the driver paths are unchanged: there is one
 * {@link settleRunFromRuntime}, one {@link blockUnstartedChildren} and one
 * terminal-record writer, and only the amount of environment handed to them
 * differs.
 */
interface RuntimeSettlementEnv {
  /** The store's own service — the one writer of the events a settlement records. */
  task: TaskService;
  /** The actor those events are attributed to. */
  actor: string;
  /** How the run's owner is told, when the deployment has a channel; absent means nothing is sent. */
  notify?(sessionId: string, text: string): void;
  /** The session observation the review's dimensions and metrics read; absent keeps the store-derived facts only. */
  observeSession?(sessionId: string): Promise<SessionObservation | undefined>;
  /** The resolved per-run budget a terminal review records post-hoc breaches against. */
  budget?: BudgetConfig;
  /** The one-writer-per-workspace registry, with the checkout to release from ({@link OrchestrateEnv.workspaces}). */
  workspaces?: WorkspaceRegistry;
  /** The checkout path the registry is keyed by; both absent means ownership is skipped rather than guessed. */
  workspacePath?: string;
  /** Called once per terminal transition: the runtime closes the gate here and releases the run's layer. */
  onRunSettled?(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void;
  /**
   * The live process's execution gate, when this settlement has one (A4 §F.1).
   * A settled run ends the *questions addressed to it* — an open question needs
   * both runs running — so the settlement recomputes the asking sessions' blocks
   * from the store ({@link releaseAskingSessions}) and needs the one thing that
   * holds them. Absent means there is no live gate to push onto: a settlement
   * whose caller holds no sessions (a store-level one) has none to release, and
   * the store's own derivation is what the next recovery reads back.
   */
  gate?: ExecutionGate;
}
/** Raised when the deployment cannot observe a run's terminal state, so no honest settlement is possible. */
declare class RunWatcherUnavailableError extends Error {
  name: string;
}
/**
 * The L4 exit pointer (KISS §7, VRTC plan phase 3.1), appended to the feedback
 * a root agent reads at each of the three trigger sites. The escalation ledger
 * and its tool live on the root plane (agent-singularity): a card carries a
 * human-approval gate that belongs on the root's tool surface, so the
 * orchestrator only points at the exit — it never calls across planes and never
 * blocks a cascade on a human answer.
 */
declare function escalationHint(what: string, tried: string, suggested: string): string;
/**
 * The one batch the runtime drives: the parent whose children it admitted, the
 * batch id the store recorded, and the signal that now owns the progress.
 *
 * `signal` is *not* the tool call's own signal. Admission is governed by the
 * caller's signal; from the atomic commit on, the batch belongs to the
 * runtime's per-batch controller (§3.7), so a tool call that returns — or a
 * caller that aborts its own call after the batch was admitted — cannot stop
 * work that is already persisted. Only a cancellation (batch, graph, deadline,
 * unload) reaches this signal.
 */
interface BatchContext {
  storeId: string;
  parentTaskId: TaskId;
  parentRunId: RunId;
  batchId: string;
  callerSessionId: string;
  reason: string;
  signal: AbortSignal;
  /**
   * The coordination call that admitted this batch. The parent's own drain
   * excludes it for the same reason the submission drain does: the call is
   * still in flight while the drain runs, and waiting for it would wait for
   * the drain itself (A3 §3.3).
   */
  excludeCallId?: string;
  /**
   * The provider pre-check the batch was admitted under (S1-C). Carried so a
   * fresh admission's verdicts reach each child's run binding instead of being
   * recomputed; a batch re-created by the recovery path has nothing to carry
   * and rebuilds its verdicts through {@link OrchestrateEnv.precheck}.
   */
  providers?: ProviderPrecheck;
}
/**
 * One child's outcome as the store records it. A child that never reached a
 * terminal state in a settled batch has no outcome to report and is named
 * `failed` — the batch is over, so a still-running child is a defect of the
 * settlement, never evidence of work in progress.
 *
 * `memberTaskIds` names the batch whose outcomes are asked for, when the caller
 * knows it. A run admits more than one batch (K1), and the task's children are
 * *every* batch's members, so a driver that read them would report a second
 * batch as its first batch's children. Absent, the task's own children are the
 * answer — the single-batch reading this entry always had.
 */
declare function deriveChildOutcomes(task: TaskService, storeId: string, parentTaskId: TaskId, memberTaskIds?: readonly TaskId[]): Promise<ChildOutcome[]>;
/**
 * Block every child of one parent task that never started, naming one reason —
 * the runtime-level entry for the paths that settle a batch without a driver
 * (`failBatch`, and the fallback for a driver that rejected before it settled
 * anything).
 *
 * It is {@link blockUnstarted} over the batch the store itself implies
 * (`batchItems`) rather than over a `BatchContext` the caller no longer holds,
 * so the *rule* — a child with no run and no terminal state is blocked, one that
 * already ran is left to its own settlement — stays in one place and the
 * runtime's failure seams share it with the driver.
 */
declare function blockUnstartedChildren(env: RuntimeSettlementEnv, storeId: string, parentTaskId: TaskId, reason: string): Promise<ChildOutcome[]>;
/**
 * The `m-` identity one ended batch's result message carries: derived from the
 * batch id, never minted — the same derivation `questionMessageIdOf` makes for a
 * question, and for the same reason. A retry in this process or after a restart
 * states the same identity, so the target's own fold answers "this one is
 * already here" instead of the runtime keeping a ledger of what it sent.
 */
declare function batchEndMessageId(batchId: string): string;
/**
 * The body one batch-end message carries, rendered from the store's own account
 * of the batch: every member's terminal state and the evidence it left, and what
 * the parent may do now. It is reprojected from the facts on every call (never
 * remembered, never edited between attempts), so the live delivery and a
 * recovery re-delivery carry the same words about the same batch.
 *
 * What it deliberately does not say is that anything was submitted: the runtime
 * submits nothing on the parent's behalf (K1 §2), and only the parent's own
 * `task_submit_result` starts its acceptance.
 */
declare function batchEndMessageText(batchId: string, outcomes: readonly ChildOutcome[]): string;
/**
 * One batch a run has ended and been told about — or still has to be told about
 * ({@link owedBatchResults}): the batch, the run whose wait it ends, the Session
 * the message goes to, and the members whose terminal states the body renders.
 */
interface OwedBatchResult {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly batchId: string;
  /** The parent's own Session: the target of the message and the Session it is sent from. */
  readonly sessionId: string;
  readonly memberTaskIds: readonly TaskId[];
}
/**
 * The end-of-batch results one store's own facts still owe (K1 §2, §5).
 *
 * A run that is `active` has no unfinished batch — `waiting_children → active`
 * clears `batchId` — so every entry of its accumulated `batches` names a batch
 * that ended, and each ended batch owes its Session the one message under
 * `m-batchend-<batchId>` ({@link batchEndMessageId}), whether the process that
 * ended it delivered it or died before it could. The store's own accumulation is
 * the whole derivation: nothing is guessed from a task's children, a batch no run
 * records is not a candidate, and a run that is still `waiting_children`,
 * `submitted` or terminal owes nothing here (its batch end is not durable yet, its
 * acceptance is what is in flight, or it is past being told).
 *
 * Being owed is a candidate, not a verdict: the target's own fold decides whether
 * the message is still missing when the delivery is attempted, so a second pass
 * over the same store re-derives the same list and delivers nothing twice.
 */
declare function owedBatchResults(snapshot: TaskSnapshot): OwedBatchResult[];
/**
 * Drive one admitted batch to settlement (A3 §3.1): reentrant, store-driven,
 * and owned by the runtime rather than by the tool call that admitted it.
 *
 * The first step is the parent's own drain — admission closed at the atomic
 * commit, so whatever the parent still had in flight has to stop before the
 * first child starts writing (§3.3); an unconfirmable drain blocks the children
 * that never started and fails the parent by name instead of assuming a stop.
 *
 * Then every round re-reads the store: children already terminal are adopted,
 * exactly one ready child is started (the batch is serial by dependency order,
 * not parallel — §5's declared boundary), and the round waits for that child's
 * terminal state. A nested decomposition is not a recursive call: the child's
 * own `task_decompose` registers its own driver, and this loop only waits for
 * the child's run to settle.
 *
 * Nothing here throws at its caller: a driver failure is a parent failed with
 * the cause named, recorded and notified (§3.1's "no fire-and-forget"), and the
 * promise the runtime registered always resolves.
 */
declare function driveBatch(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]>;
/**
 * The one verification entry: a run whose phase change into `submitted` is
 * already committed is drained, judged, and settled.
 *
 * Everything that verifies a run goes through here — the worker's own
 * `task_submit_result` (a parent's included: a batch ending hands the run back
 * `active` and only the parent's own submission starts its acceptance), and the
 * recovery path's continuation of a run that submitted before a restart. That is
 * what makes the paths share the budget, the drain, the verifier deadline and
 * the review discipline instead of separate implementations that drift (§3.1
 * "验证权唯一").
 *
 * A drain that cannot be confirmed fails the run with the pending work named:
 * judging a run whose writers may still be running would produce a verdict
 * about bytes nothing can vouch for (§3.3).
 */
declare function settleSubmittedRun(env: OrchestrateEnv, storeId: string, taskId: TaskId, runId: RunId, opts?: {
  excludeCallId?: string;
  relatedTaskIds?: readonly TaskId[];
  anomalies?: readonly string[];
}): Promise<RunStatus>;
/**
 * Per-run overlay (guide §2.7.6, W15): candidate-side patches applied to ONE
 * replay run, never to the runtime's configuration. The evolution replay is
 * the only consumer; a normal run never carries one.
 */
interface ReplayOverlay {
  /**
   * Whole-row capability replacements: an entry overrides the same-named row of
   * the configured table for this run's capability resolution (the same
   * whole-row semantics the sandbox's capability-table.patch.yml records).
   */
  capabilityOverrides?: Record<string, CapabilityConfig>;
  /**
   * Extra skill roots forwarded to the worker grant (`WorkerGrant.skillRoots`):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   * skill layer, shadowing the same-name production skill for that worker alone.
   */
  extraSkillRoots?: string[];
  /**
   * Preset id mounted instead of the capability/default resolution. Must exist
   * in the deployment's preset roster — the roster scans constructor-fixed
   * roots only, so a sandbox-materialized preset is NOT mountable through this
   * seam (agent_preset replay stays manual in v1).
   */
  presetOverride?: string;
}
/** Everything one replay run needs, pre-shaped by the caller (`TaskRuntime.replayTask`). */
interface ReplayRunInit {
  /** The replayed task to create: parentless (depth 0), status `created`, objective already carrying the lineage tag. */
  task: TaskInstance;
  /** The manifest resolved under the overlay. */
  manifest: CapabilityManifest;
  /**
   * The provider pre-check this replay passed (S1-C item 1): the verdicts and
   * registry revision the replay resolved against, so the Run binding can record
   * them without repeating discovery.
   */
  providers?: ProviderPrecheck;
  /** Lineage marker (`evolution-replay:<proposalId>`), recorded on the review record's anomalies. */
  lineage: string;
  /** The preset to mount; already overlay-resolved by the caller. */
  agentPreset?: string;
  /** Extra skill roots for the worker grant (overlay). */
  skillRoots?: readonly string[];
  /**
   * The model selection this replay's worker is created under (S4-E §Q3), already
   * resolved by the caller from the deployment's real configuration and registry:
   * the experiment's frozen identity, carried through the spawn and inherited by
   * the sub-execution the worker may decompose into. Absent replays on the
   * deployment's own default selection, exactly as before.
   */
  agentOptions?: AgentOptions;
  /** false: deterministic criteria replay — no worker is spawned, the verifier alone settles the run. */
  spawn: boolean;
  /** The champion run this replay stands in for, recorded as the run's parentRunId (execution lineage). */
  championRunId?: RunId;
}
/**
 * The two signals a replay runs under — the same split the batch has (§3.7).
 * `admission` is the caller's own tool signal and governs only the run's
 * creation: once the run and its task are persisted the replay belongs to the
 * runtime, whose `advance` signal (a controller the runtime registered) is what
 * stops it. A tool call that returns, or a caller that aborts, therefore cannot
 * strand a run that already exists in the store.
 */
interface ReplayRunSignals {
  admission?: AbortSignal;
  advance?: AbortSignal;
}
/** What one settled replay run reports back to the comparison report. */
interface ReplayRunOutcome {
  taskId: TaskId;
  runId: RunId;
  status: 'verified' | 'failed' | 'cancelled';
  evidenceId?: string;
  durationMs?: number;
  criteria?: ReviewCriterion[];
  /**
   * The workspace this replay ran in, when its caller named one
   * (`ReplayTaskOptions.workspace`, normalized): the directory its worker wrote
   * in and its verifier judged in. Absent for a replay that ran in the caller's
   * own checkout, which is where an unnamed replay always runs.
   */
  workspace?: string;
}
/**
 * Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
 * the store, run it once through the real spawn + verify chain — or straight
 * through the verifier alone for a deterministic criteria replay — and settle
 * it with the same terminal-record discipline every other run gets
 * ({@link recordTerminalReview}), the lineage tag on the record's anomalies.
 * The replayed task is parentless and the historical task it mirrors is never
 * touched: a replay is a comparison experiment, not a tree edit. Nothing asks a
 * replay to decompose — its projection carries no decomposition guidance and no
 * spawn prompt invites one — but nothing refuses it either: `task_decompose` is
 * on every worker's surface, and a replayed worker that splits is settled by its
 * batch through the ordinary parent acceptance.
 *
 * A spawning replay is a worker like any other and follows the same rules: it
 * is born `active` and it *submits* — an idle worker is not a completion, the
 * no-progress counter runs, and the verification comes from the one entry every
 * run shares ({@link settleSubmittedRun}). A workerless replay is born
 * `submitted` (origin `runtime`) because there is nobody to submit: its
 * criteria are judged by the verifier and the run settles on the verdict.
 *
 * What the run is *placed under* travels with the init (S4-E §Q3): the caller's
 * frozen model selection ({@link ReplayRunInit.agentOptions}). It is carried on
 * the spawn request, so the deployment remembers it for the session and the
 * sub-execution a replayed worker decomposes into inherits exactly the same
 * binding; it is absent for an ordinary replay, whose run and spawn are what they
 * always were. The run's clock is not this entry's: its time is bounded by the
 * runtime's own per-run budget and the root tree's deadline alone.
 */
declare function runReplayTask(env: OrchestrateEnv, storeId: string, init: ReplayRunInit, signals?: ReplayRunSignals): Promise<ReplayRunOutcome>;
/**
 * Settle one run terminal from outside the orchestration — a graph removal, or
 * a recovery pass that refuses to continue a run — with the same terminal-record
 * discipline every other settlement uses: the status event, its one review
 * record (idempotent: a run whose review already exists is not given a second),
 * the gate closed for its session, and the workspace layer it held released.
 *
 * A run that is already terminal is left exactly as it is: this is a settlement
 * entry, not an overwrite.
 */
declare function settleRunFromRuntime(env: RuntimeSettlementEnv, storeId: string, run: TaskRun, status: 'cancelled' | 'failed', reason: string): Promise<void>;
//#endregion
//#region src/question.d.ts
/** What one `task_ask_parent` call claims about itself (A4 §F.1): the call it is, and the key it asks under. */
interface ParentAskCall {
  /**
   * The registration id of the calling tool call. It names the `tool/call` event
   * the body must come from, in the caller's own Session — an id the caller
   * cannot forge into somebody else's Session, because the Session is resolved
   * from the caller's run binding and never from this field.
   */
  readonly callId: string;
  /** The caller's stable request key for this question; a retry repeats it. */
  readonly requestKey: string;
  /** Whether the answer blocks the asking run. Absent means the contract's default (`true`), taken from the call's own arguments. */
  readonly blocking?: boolean;
}
/** What one `task_answer` call claims about itself. */
interface ParentAnswerCall {
  /** The registration id of the calling tool call — the answering Session's own `tool/call`. */
  readonly callId: string;
  /** The question being answered; must be the one the cited call names. */
  readonly questionId: string;
  /** The caller's stable request key for this answer. */
  readonly requestKey: string;
  /** The parent's declaration: `true` answers the question, `false` keeps it open. Never a classification. */
  readonly resolves: boolean;
}
/** Who is calling: the live session, the run binding that identifies it, and the actor its writes are attributed to. */
interface QuestionCaller {
  /** The caller's own Session — where the cited body must live, and (for an ask) the session the question is asked from. */
  readonly sessionId: string;
  /** The store the caller's run belongs to. */
  readonly storeId: string;
  /** The run the caller is bound to: the asking run for an ask, the answering run for an answer. */
  readonly runId: RunId;
  /** The attribution every event of this call carries (the caller's session id, as elsewhere in the runtime). */
  readonly actor: string;
}
/**
 * One delivery attempt as the entry point reports it: the identity the store
 * recorded, and what the target Session could witness. `refused` is this
 * module's own name for "the attempt could not be decided at all" — the body
 * could not be read back from the *recorded* citation, or the delivery layer
 * raised a refusal — and it is reported rather than thrown because the intent is
 * durable by then: the caller keeps the record, and recovery retries.
 */
interface QuestionDelivery {
  readonly messageId: string;
  readonly status: MessageDeliveryStatus | 'refused';
  /** Present only with `refused`: why no delivery could be settled. */
  readonly reason?: string;
}
/** What one ask settled as: the stored record, whether this call wrote it, and what the delivery attempt settled as. */
interface AskedQuestionOutcome {
  readonly question: QuestionRecord;
  readonly created: boolean;
  readonly delivery: QuestionDelivery;
}
/** What one answer settled as: the stored record, whether this call wrote it, and what the delivery attempt settled as. */
interface AnsweredQuestionOutcome {
  readonly answer: QuestionAnswerRecord;
  readonly created: boolean;
  readonly delivery: QuestionDelivery;
}
/** One record a reconciliation pass addressed: which fact it belongs to, and what the attempt settled as. */
interface QuestionReconcileReport {
  /** Which question or answer the record is about, in the store's own ids (`question "q-…"`, `answer "a-…" for question "q-…"`). */
  readonly subject: string;
  readonly messageId: string;
  readonly status: MessageDeliveryStatus | 'refused';
  readonly reason?: string;
}
/** Where one owed message comes from and where it goes, before its body is read back from the citation. */
interface PendingMessageBase {
  /** Which fact the message belongs to, in the store's own ids. */
  readonly subject: string;
  readonly questionId: string;
  readonly messageId: string;
  /** The sender's own citation into its Session: where the body is. */
  readonly ref: QuestionMessageRef;
  readonly senderSessionId: string;
  readonly targetSessionId: string;
}
/** One message a store's question facts still owe: an open question's ask, or an answer to a run that may not have read it. */
type PendingQuestionMessage = (PendingMessageBase & {
  readonly kind: 'question';
}) | (PendingMessageBase & {
  readonly kind: 'answer';
  readonly answerId: string;
});
/** What one store's pending question messages are, and which facts cannot be addressed from the snapshot at all. */
interface PendingQuestionMessages {
  readonly messages: readonly PendingQuestionMessage[];
  readonly refused: readonly QuestionReconcileReport[];
}
/**
 * The services one question coordination reaches, narrowed to what it calls: the
 * store's own entries (never the whole service), the caller's Session log, and
 * agent-runtime's delivery handle. Nothing here resolves another service through
 * this module, and a caller can hand a test double for any of them.
 */
interface QuestionCoordinationDeps {
  /** The Task store: the facts, their one writer, and the snapshot every derivation reads. */
  readonly task: {
    snapshotIn(storeId: string): Promise<TaskSnapshot>;
    askParentQuestionIn(storeId: string, ask: QuestionAsk, actor: string): Promise<{
      question: QuestionRecord;
      created: boolean;
    }>;
    answerParentQuestionIn(storeId: string, answer: QuestionAnswer, actor: string): Promise<{
      answer: QuestionAnswerRecord;
      created: boolean;
    }>;
  };
  /** The caller's own Session, to locate the `tool/call` this call cites (and to read it back before deciding anything). */
  readonly sessionQuery: {
    readSession(sessionId: SessionId): Promise<SessionOwnLog>;
  };
  /** agent-runtime's handle: the flushed body read-back, the relay, and the recovery reconcile. */
  readonly messages: {
    readToolCallBody(ref: ToolCallRef): Promise<ToolCallBody>;
    ensureAgentMessageDelivered(intent: AgentMessageIntent): Promise<{
      messageId: string;
      status: MessageDeliveryStatus;
    }>;
    reconcileAgentMessageDeliveries(intents: readonly AgentMessageIntent[]): Promise<MessageDeliveryReport[]>;
  };
  /** The execution gate whose *blocking* state these facts decide (A4 §7.2). */
  readonly gate: ExecutionGate;
}
/**
 * The `m-` identity one question's message carries: derived from the question id,
 * never minted. A retry — in this process or after a restart — states the same
 * identity, which is what lets a target's own fold answer "this one is already
 * here" instead of the framework keeping a ledger of what it sent.
 */
declare function questionMessageIdOf(questionId: string): string;
/** The `m-` identity one answer's message carries, derived from the answer id for the same reason ({@link questionMessageIdOf}). */
declare function answerMessageIdOf(answerId: string): string;
/**
 * The arguments object one cited `tool/call` must hold: a JSON object, refused by
 * name when it is not. Exported for the same reason this module's other pure
 * steps are: the refusal rules are part of the contract, and a unit test should
 * be able to drive them without a store.
 */
declare function parseCallArguments(body: ToolCallBody): Record<string, unknown>;
/**
 * Ask one's direct parent (A4 §F.1): the `task_ask_parent` entry's whole effect.
 *
 * Read the body → commit the intent → recompute the block → deliver under the
 * recorded identity. The parent is never named by the caller: the store resolves
 * the asking task's direct parent and *its* current run, and the delivery goes to
 * that run's Session. A repeated request (same run, same key, same arguments
 * text) returns the record the store already holds, changes no gate state and
 * delivers the same `messageId` — which is `already-present` when the target
 * still holds it.
 */
declare function askParentQuestion(deps: QuestionCoordinationDeps, caller: QuestionCaller, request: ParentAskCall): Promise<AskedQuestionOutcome>;
/**
 * Answer one child's question (A4 §F.1): the `task_answer` entry's whole effect.
 *
 * The answering run is the caller's own — the store refuses an answer from any
 * other run, including the new run of a restarted task — and the body citation
 * must sit in the answering Session. The message goes to the *asking* run's
 * Session, so `resolves: true` both releases that run's write gate (recomputed
 * from the facts, so a second open question keeps it blocked) and puts the
 * parent's words in front of the model that asked.
 */
declare function answerParentQuestion(deps: QuestionCoordinationDeps, caller: QuestionCaller, request: ParentAnswerCall): Promise<AnsweredQuestionOutcome>;
/**
 * What one store's question facts still owe a message, derived from its own
 * snapshot and nothing else.
 *
 * Two rules, and both are about what the *facts* can prove rather than about
 * what a process remembers:
 *
 * - every **open** question owes its ask: both runs are running and no answer
 *   has resolved it, so the parent still has to be able to answer it;
 * - every **answer** whose asking run is still running owes its delivery: the
 *   framework has no consumption proof (§F.1 keeps the reference until a real
 *   model step shows it), so even a resolved question's answer is owed to a run
 *   that may never have read it.
 *
 * Nothing else is owed. A question whose asking run settled is audit — its ask
 * and its answers are moot, and re-delivering them would be a message to a run
 * that cannot act on it.
 */
declare function pendingQuestionMessages(snapshot: TaskSnapshot): PendingQuestionMessages;
/**
 * Reconcile the deliveries one store's question facts still owe (§F.1's crash
 * recovery): read each pending body from its *recorded* citation, then hand the
 * composed intents to agent-runtime's reconcile — which delivers only what the
 * target Session's own fold says is missing, so a second pass over the same
 * record adds nothing.
 *
 * A recorded body that can no longer be read is reported per record rather than
 * failing the pass: the facts are still the facts, the next activation is the
 * retry, and one unreadable Session must not hide the deliveries that could be
 * made. A target that is not live comes back `unavailable` — zero side effects,
 * no substitute parent, and the same retry rule.
 */
declare function reconcileQuestionDeliveries(deps: QuestionCoordinationDeps, storeId: string): Promise<QuestionReconcileReport[]>;
/**
 * Push the question block every run in one snapshot implies onto the gate, under
 * the gate's own token rule — the recovery pass's half of §F.1's "restart from
 * the durable facts". The token is the one taken before the snapshot read, so a
 * value that straddled a decision of this process is dropped exactly as a
 * store-derived phase is.
 */
declare function applyStoreQuestionBlocking(gate: ExecutionGate, snapshot: TaskSnapshot, tokenOf: (sessionId: string) => number): void;
/**
 * Whether one run still owes or waits for coordination: no unresolved blocking
 * question of its own, and no question of a child's it has not answered. The
 * runtime reads this where a run's own next step would otherwise be automatic —
 * the parent's submission once its children are terminal — and the answer is
 * deliberately *derived* from the facts rather than stored: an answered question
 * and an unanswered one are the same list, one answer apart.
 */
declare function pendingCoordinationOf(snapshot: TaskSnapshot, runId: RunId): readonly QuestionRecord[];
//#endregion
//#region src/admission.d.ts
/** Parent task plus the decomposition policy its caller grants it. */
interface AdmissionParent extends TaskInstance {
  decompositionPolicy: {
    /** Whether this batch may proceed at all. */
    allowed: boolean;
    /**
     * The parent is admitted `leaf`. With the runtime-decomposition switch off
     * that alone closes the policy, so the refusal below names the leaf rule
     * instead of leaving the model to guess whether a limit refused it — the
     * two causes need different follow-ups (do the work here vs. stay shallow).
     */
    leaf?: boolean;
    maxDepth?: number;
    maxChildren?: number;
  };
}
/** One planned child at admission time; `dependsOn` indexes into the children array. */
interface AdmissionChild {
  /**
   * The child's task id, when it has one. It is **absent** for a batch that is
   * being judged before any id was minted — the pre-check stage of admission
   * (`TaskRuntime.precheckDecomposition`) deliberately mints nothing — and the
   * refusal then names the child by its position instead. Two callers judging
   * the same batch therefore get the same verdict either way; only the wording
   * of the messages a refusal carries differs, and an id that was about to be
   * thrown away was never information a caller could use.
   */
  taskId?: string;
  objective: string;
  acceptanceCriteria: readonly AcceptanceCriterion[];
  dependsOn?: readonly number[];
  /** Contract-level marker (P4): this child demands independent parent acceptance, so at least one of its criteria must carry a `childEvidence` map. */
  requiresIndependentAcceptance?: boolean;
}
type AdmissionVerdict = {
  ok: true;
} | {
  ok: false;
  reasons: string[];
};
/**
 * Structural reasons one task's parent-acceptance declarations are malformed
 * (P4, KISS §6 C2). Shape only: whether a mapping target exists is judged at
 * acceptance time, never here. The ordinary decomposition path and the replay
 * path share this function so both judge the same declarations the same way.
 *
 * `label` names the task under validation (`task "t-1"`, `child 0 ("c1")`,
 * `replay of "t-1"`); every reason is prefixed with it.
 */
declare function independentAcceptanceDefects(criteria: readonly AcceptanceCriterion[], requiresIndependentAcceptance: boolean | undefined, label: string): string[];
/**
 * The one structural rule a **root contract** owes on top of
 * {@link contractDefects} (A0 §1.2): at least one mandatory criterion whose
 * judge is something other than the composite conjunction.
 *
 * Why it is a rule of its own and not folded into {@link contractDefects}: a
 * decomposition child may legitimately be judged by "my children verified" —
 * its parent owns the goal it was delegated — while a *root* has nobody above
 * it, so a root whose only mandatory criterion is the composite conjunction is
 * satisfied by its own decomposition and by nothing else. That is the shape the
 * graph entry used to mint from its fixed spec, and it is exactly the shape
 * this rule refuses to call a root goal. Applying it to every contract would
 * break the delegated-children case; applying it to nothing would let a root
 * re-enter through the old shape.
 *
 * Structural, and only structural: it says which *kind* of judge the contract
 * names, never whether that judge is any good. A `command` that is a constant
 * truth, a model's self-report, or a `heuristic` criterion are all outside what
 * a shape rule can decide — §1.2 says so in as many words ("不能用恒真命令、
 * 模型自述或 heuristic 冒充确定性根通过"), and P4 already labels a heuristic
 * verdict as never a deterministic pass. What this rule does buy is that the
 * root's acceptance cannot be *only* the conjunction of what it delegated.
 *
 * `label` names the contract under validation (`root contract`, `root
 * contract of session "s-…"`); the reason is prefixed with it, like every other
 * contract rule's.
 */
declare function rootIndependenceDefects(criteria: readonly AcceptanceCriterion[], label: string): string[];
/**
 * Structural defects of one task's acceptance contract (T1, construction guide
 * §4): what has to hold before a contract can be admitted at all, whichever
 * entry wrote it — an ordinary decomposition child, a replay candidate, or
 * (later) a template instance. Texts, ids, modes, and the fixed form of a
 * criterion's protected acceptance inputs only; nothing here judges whether a
 * criterion is any good, and nothing here needs the store.
 *
 * The ordinary decomposition path and the replay path share this function so
 * that a rule can never hold on one and not on the other. The *parent* task's
 * own criteria are deliberately not put through it: a parent that already
 * exists was admitted when it was created, and T1 does not re-open contracts
 * that predate the normalized one — `checkDecomposition` still applies
 * {@link independentAcceptanceDefects} to the parent, which is its own P4
 * promise about a declaration the parent itself carries.
 *
 * `label` names the task under validation (`child 0 ("t-1")`, `replay of
 * "t-1"`); every reason is prefixed with it.
 */
declare function contractDefects(criteria: readonly AcceptanceCriterion[], label: string): string[];
/**
 * Structural admission checks for one decomposition batch (RFC §36). Pure:
 * every rule is validated up front and the caller persists only when the
 * verdict is `ok`, so admission is atomic for the whole batch.
 */
declare function checkDecomposition(parent: AdmissionParent, children: readonly AdmissionChild[], existingEdges: readonly DependencyEdge[]): AdmissionVerdict;
//#endregion
//#region src/protected-inputs.d.ts
/**
 * The smallest shape this module fixes: a criterion that may carry a declared
 * id (the label it is reported under) and a `protectedInputs` value of unknown
 * shape. Both the tool-facing authoring form (`CriterionSpec`, paths as
 * strings) and a stored criterion (the fixed refs) satisfy it.
 */
interface DeclaredProtectedInputs {
  criterionId?: string;
  protectedInputs?: unknown;
}
/**
 * Fix the byte identity of every declared protected input, against the
 * checkout directory the criterion's judge will run in.
 *
 * `paths` are the paths **as declared** (the caller's spellings, verbatim):
 * each is resolved against `cwd` for the read — an absolute path stays
 * absolute — while the returned ref keeps the declared spelling, so the
 * identity names what the caller wrote and not a tidied version of it. An
 * identical declaration repeated is read once and produces one entry, in
 * first-declaration order; two spellings of the same file stay two
 * declarations.
 *
 * Refusals are values, never throws: a path that cannot be read (missing,
 * unreadable, a directory) yields a reason naming the label and the path, and a
 * session whose checkout directory cannot be resolved (`cwd === undefined`)
 * yields one reason instead of fixing the declaration against the wrong base.
 * That refusal is whole-batch and absolute paths are not exempt: the checkout
 * names the directory the criterion's judge runs in, so a batch that cannot
 * name it cannot promise that what it fixed is what the re-check will compare —
 * and the refs of a batch refused for one path are never trustworthy either.
 * Nothing is ever written: the files are read and left byte-identical.
 */
declare function fixProtectedInputs(paths: readonly string[], cwd: string | undefined, label: string): Promise<{
  refs: ProtectedInputRef[];
  reasons: string[];
}>;
/**
 * Fix the declarations of one criterion list, rebuilding only the criteria that
 * declared one: every untouched criterion is carried by reference, and the
 * caller's input is never mutated — which is also why the returned list is
 * typed read-only.
 *
 * `label` is the position prefix a criterion is reported under (`child 0` on a
 * decomposition, `replay of "t-1"` on a replay); {@link criterionLabel} appends
 * the criterion's own id or position. A criterion whose fixing was refused is
 * carried unchanged — it never reaches the store, because the caller refuses
 * the whole batch on any reason — so no half-fixed identity can be read as a
 * fixed one.
 */
declare function fixCriteriaProtectedInputs<T extends DeclaredProtectedInputs>(criteria: readonly T[], cwd: string | undefined, label: string): Promise<{
  criteria: readonly T[];
  reasons: string[];
}>;
/**
 * Fix the declared protected inputs of a whole decomposition proposal before
 * anything else reads it: the runtime calls this ahead of the single
 * normalization entry, so the contract the store receives — and both content
 * identities computed over it — describe the fixed byte identity rather than
 * the caller's paths.
 *
 * Absent declarations and every malformed shape are carried exactly as
 * declared, and a child nothing was fixed in is returned by reference: this
 * function converts the authoring form, it does not validate, so the reasons it
 * returns are only the ones fixing itself could produce.
 */
declare function fixSpecProtectedInputs(spec: DecomposeSpec, cwd: string | undefined): Promise<{
  spec: DecomposeSpec;
  reasons: string[];
}>;
/**
 * Structural defects of the **fixed** form of every criterion's protected
 * inputs: each declaration must be an array of plain objects carrying exactly
 * `path` (non-blank string) and `sha256` (lowercase 64-character hex). Shape
 * only — whether the file still hashes to that digest is the pre-judgement
 * re-check's question, and it needs the checkout, not this function.
 *
 * The ordinary decomposition path and the replay path share this function (via
 * `admission.contractDefects`) so one rule can never hold on one and not on the
 * other, and the declared string form is refused here as well: reaching
 * admission with paths instead of digests means the runtime's fixing step was
 * bypassed, which is exactly the state that must not be persisted. Every reason
 * is prefixed with `<label> criterion "<id>"`, the label the other contract
 * rules use.
 */
declare function protectedInputDefects(criteria: readonly AcceptanceCriterion[], label: string): string[];
//#endregion
//#region src/proposal.d.ts
/** The prefix every derived request key carries, so a key is recognizable as one wherever it is printed. */
declare const PROPOSAL_REQUEST_KEY_PREFIX = "rk-";
/**
 * The calling context a derived request key is made of: where the batch goes
 * (parent task and run), who asked (the caller's session), and what was asked
 * for (the batch's own digest).
 */
interface ProposalRequestKeyContext {
  parentTaskId: string;
  parentRunId: string;
  callerSessionId: string;
  /** {@link decompositionDigest} of the batch identity the submission built. */
  proposalDigest: string;
}
/**
 * The request key one call derives when its caller named none: `rk-` plus the
 * SHA-256 of {@link canonicalize} over
 * {@link ProposalRequestKeyContext} (key order is irrelevant; the same request
 * addresses the same key however it was written).
 *
 * A caller with its own stable identifier (a message id, a task row) may pass
 * it instead — the store refuses one key bound to two proposals either way,
 * so an explicit key is a promise the caller keeps, not a way around the rule.
 * The derived form is what makes a retry of the *same* batch idempotent
 * without any caller bookkeeping: a revision has different content, hence a
 * different digest, hence a new key.
 */
declare function proposalRequestKey(context: ProposalRequestKeyContext): string;
/**
 * The calling context a *root* contract's request key is made of (A0 §2): which
 * store and which root session the contract is the goal of, and the digest of
 * the normalized contract itself.
 *
 * The parent task and parent run a batch's key names have no counterpart here —
 * a root contract has no parent, and the task it becomes does not exist until it
 * is activated — so the two fields that identify the subject are the store and
 * the root session, and the content is the contract's own digest.
 */
interface RootRequestKeyContext {
  storeId: string;
  rootSessionId: string;
  /** {@link contractDigest} of the normalized root contract the request carries. */
  contractDigest: string;
}
/**
 * The request key one root intake derives when its caller named none: `rk-` plus
 * the SHA-256 of {@link canonicalize} over {@link RootRequestKeyContext}.
 *
 * What the derivation buys, in the order it matters: the same contract asked for
 * again — in this process or after a restart — addresses the same proposal and is
 * answered from the record instead of being written twice; a revision is
 * different content, hence a different digest, hence a different key, which is
 * exactly what §6 wants a revision to be; and no caller has to keep a key of its
 * own to get that. A caller that *has* a stable identifier may pass it instead,
 * and the store then holds it to the same rule — one key names one proposal, and
 * a key already bound to other content is refused by name.
 */
declare function rootProposalRequestKey(context: RootRequestKeyContext): string;
/**
 * Whether one proposal is still in flight for the task that made it —
 * submitted and not yet admitted, not yet decided, or decided and not yet
 * re-checked (§6). `admitted` and the four terminal statuses are not open: a
 * task with one of those has either a batch (the run is coordinated by A3 from
 * there) or nothing waiting.
 */
declare function isOpenProposal(proposal: TaskProposal): boolean;
/**
 * The open proposal of one run, or `undefined` — §7.4's "已知等待": a run whose
 * own batch is waiting for a review (or for the admission its approval
 * authorizes) is idle on purpose, and an idle that is a known wait must not
 * count as stagnation.
 *
 * Both the task and the run are matched, not just the task: a proposal names
 * the run it was submitted from, and a *later* run of the same task is not
 * waiting on a batch its predecessor proposed.
 *
 * A snapshot with no proposal index (a hand-built one, or a store written
 * before proposals existed) answers `undefined` — the honest reading of "this
 * reader cannot see proposals", which is a run to be judged by the rules that
 * were in force when it was created rather than one this build's proposals
 * hold up.
 */
declare function openProposalOf(snapshot: TaskSnapshot, taskId: string, runId: string): TaskProposal | undefined;
/** What {@link reviewContextOf} is built from. */
interface ReviewContextInput {
  /**
   * The manifests the batch resolved, in batch order — one per child, the same
   * list admitted with the batch. Order is part of the identity
   * ({@link capabilityManifestDigest}): two resolutions that assigned the
   * manifests to different children are two identities.
   */
  readonly manifests: readonly CapabilityManifest[];
  /** Every criterion of the batch, in batch order and child order. */
  readonly criteria: readonly AcceptanceCriterion[];
  /**
   * The content identity the admission-time provider pre-check resolved for
   * *these* rows' skills (`providerContentIdentities`), sorted by name. The
   * empty list is the honest answer for a batch whose capabilities grant no
   * skill at all: nothing was resolved, so nothing is claimed.
   */
  readonly providers: readonly ResolvedProviderIdentity[];
}
/**
 * What a batch was reviewed against (§6), as this runtime can compute it.
 *
 * Two parts, and each has a stated boundary:
 *
 * - **The manifests**, through {@link capabilityManifestDigest}, folded with
 *   the provider content identity the admission-time pre-check resolved for
 *   the same rows. The manifest itself names skills, tools, presets,
 *   permissions and MCP servers — *names*, not bytes — so the fold adds what
 *   only discovery can answer: the `contractDigest` of every accepted
 *   provider (`null` for a skill that declares no sidecar, which is a skill
 *   whose content this deployment cannot pin). The fold covers the rows *this*
 *   batch matched and nothing else, which is what keeps §6's "an unrelated
 *   registry edit does not invalidate a reviewed proposal" true: a changed row
 *   the batch never resolved is not in this digest.
 * - **The judging verifiers**, as the ids the batch's criteria pin by
 *   `verifierRef`. Those are the only instances this runtime can name: the
 *   registered registry exposes its id vocabulary (`verifierIds()`), not the
 *   version or the configuration each id currently stands for, so
 *   `version`/`configurationDigest` are left off rather than invented (§6:
 *   "没有可信内容版本的资源必须标明身份保障有限"). A criterion with no
 *   `verifierRef` is dispatched by mode inside the verifier service and this
 *   runtime cannot see which instance that is; its mode is part of the batch
 *   content (the proposal digest covers the whole contract), so a *mode*
 *   change is a different proposal, while a re-registration that keeps an id
 *   and changes the behaviour behind it is **not** visible here and does not
 *   invalidate a reviewed proposal.
 */
declare function reviewContextOf(input: ReviewContextInput): TaskProposalReviewContext;
/**
 * The judging instances a batch's criteria pin by id, in first-appearance
 * order. See {@link reviewContextOf} for why this is an id list and not a
 * version binding; the digest over it is order-insensitive
 * (`task/src/proposal.ts:reviewContextDigest` sorts), the stored list keeps
 * the writer's order so a reader can see which criterion came first.
 */
declare function verifierIdentitiesOf(criteria: readonly AcceptanceCriterion[]): TaskProposalVerifierIdentity[];
/**
 * Why two review contexts differ, as one line a refusal can carry: which part
 * of the resolution moved (the manifests and provider content, or the judging
 * verifiers). §6 requires the stale marking to name what changed — an
 * invalidation a reader cannot explain is a record that cannot be trusted —
 * and "the context changed" alone would be exactly that. The limits in force
 * are the other half of the re-check and have their own fingerprint
 * (`admissionContextDigest`), so a caller that has two of those reports the
 * difference itself.
 */
declare function reviewContextDelta(before: TaskProposalReviewContext, after: TaskProposalReviewContext): string;
//#endregion
//#region src/obligation.d.ts
/** One known obligation of a domain pack: a question plus what would answer it. */
interface ObligationTemplate {
  id: string;
  /** The question the domain must answer ("where is your differential reference?"). */
  question: string;
  /** The evidence form that counts as an answer. */
  evidenceForm: string;
  /** Capability names that usually answer it; empty means no deployed capability covers it. */
  typicalCapabilities: string[];
}
/** One loaded template file and where it came from. */
interface ObligationTemplateFile {
  file: string;
  templates: ObligationTemplate[];
}
/** The coverage verdict for one template set against one task snapshot. */
interface ObligationCoverage {
  covered: {
    template: ObligationTemplate;
    via: string;
  }[];
  uncovered: ObligationTemplate[];
}
/**
 * Parse one obligations.yml text (JSON-compatible YAML) into templates,
 * refusing malformed entries loudly — a template that cannot be read is a
 * defect in the domain pack, not an empty template set.
 */
declare function parseObligationTemplates(text: string, source: string): ObligationTemplate[];
/**
 * Walk up from `start` to the directory holding `.git` (the same semantics as
 * skill-filesystem's findProjectRoot, here with an 8-level cap so a detached
 * env root cannot walk to the filesystem root and pick up an unrelated repo).
 * `undefined` when no repo root is found within the cap.
 */
declare function findRepoRoot(start: string, maxLevels?: number): Promise<string | undefined>;
/**
 * Load every `<repoRoot>/.agents/skills/<name>/obligations.yml`, in directory
 * order. A pack without the file contributes nothing; an absent skills root
 * yields an empty list. A malformed file throws — see parseObligationTemplates.
 */
declare function loadObligationTemplates(repoRoot: string): Promise<ObligationTemplateFile[]>;
/**
 * Compare one template set against the current task graph. An entry is covered
 * when a task requested one of its typical capabilities (`via capability
 * <name>`) or a recorded obligation mentions its id or question (`via
 * obligation <id>`). Everything else is uncovered — reported, never blocked.
 */
declare function checkObligationCoverage(templates: readonly ObligationTemplate[], snapshot: TaskSnapshot): ObligationCoverage;
//#endregion
//#region src/handoff.d.ts
interface HandoffInit {
  parentTask: TaskInstance;
  parentRun: TaskRun;
  childTask: TaskInstance;
  reason: string;
  callerSessionId: string;
  constraints?: readonly string[];
  decisions?: readonly string[];
  assumptions?: readonly string[];
  openQuestions?: readonly string[];
  relevantArtifacts?: readonly ArtifactRef[];
  relevantEvidence?: readonly string[];
}
/**
 * The envelope passed from a parent run to the child it delegates to (RFC §18).
 *
 * This module builds and persists the DATA of a handoff and nothing else: what
 * a worker is shown from it is the context package's projection
 * (`context/src/projections.ts`, `render.ts:handoffLines`), and the stable
 * behaviour rules that used to ride the same spawn prompt are the agent
 * runtime's worker policy section — neither is rendered here, because the
 * runtime must not grow a second rendering of what it owns as facts.
 */
declare function buildHandoff(init: HandoffInit): TaskHandoff;
//#endregion
//#region src/verified-read.d.ts
/**
 * Reading files without following a link: the one implementation of "a path
 * under a root, walked one component at a time through `lstat`".
 *
 * Why it is a module of its own: both the Evolution ledger (skill candidates in
 * a proposal sandbox, the production skill baseline) and the skill sidecar
 * loader read files whose identity they then vouch for. A read that followed a
 * symbolic link would let the digest describe one file while the path a worker
 * opens is another — so every component from the root to the file must be a
 * real entry, and a link, a directory in a file's place, or a fifo anywhere on
 * the way is a refusal, never a silent follow. The check lives here once, so
 * the two callers cannot drift into two rules.
 *
 * Only Node standard fs: the walk is about `lstat` semantics, not about any
 * harness service.
 * @module @dangosys/dsh-singularity-task-runtime/verified-read
 */
/**
 * Where a component walk under a root stopped. The walk is split from the read
 * so a caller that records "absent" can tell it apart from a path that changed
 * type: `missing` is a value, a link or a wrong type is a throw.
 */
type VerifiedWalk = {
  missing: false;
  abs: string;
} | {
  missing: true;
  reason: 'no such file or directory' | 'a path component is not a directory';
};
/**
 * Walk `rel` under `root` one component at a time, refusing anything but real
 * entries: a symbolic link anywhere on the path, a non-regular entry where the
 * target should be, or a non-directory where a directory should be all fail
 * loudly, so a read can never land outside the root through a redirected path
 * even though the lexical path stays inside. A component that is simply absent
 * (ENOENT / ENOTDIR anywhere along the walk) is reported as `missing`, never
 * thrown — the caller decides whether absence is an error or an answer.
 */
declare function walkVerified(root: string, rel: string): Promise<VerifiedWalk>;
/**
 * Read the file at `rel` under `root` as raw bytes, refusing anything but a
 * real regular file: the entry itself and every ancestor between `root` and it
 * must not be a symbolic link. A missing file, a directory in the file's place,
 * or any other non-regular entry fails loudly. The bytes are returned exactly
 * as stored — no decoding, no newline conversion.
 */
declare function readVerifiedFile(root: string, rel: string): Promise<Buffer>;
//#endregion
//#region src/index.d.ts
/** Local view of the verifier service (ticket C2 develops it in parallel): the
 * runtime resolves it softly from the context and never imports the package. */
interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  /** Tail excerpt of one criterion log (logRef relative to the verifier's evidence root); optional on the service. */
  logTail?(logRef: string): Promise<string | undefined>;
  /** The registered verifier ids; optional on the service, required to validate a criterion's `verifierRef`. */
  verifierIds?(): string[];
  /**
   * The cordis service lifecycle hook. Optional because a test double is already
   * readied when it is built; the provider pre-check awaits it before reading
   * `verifierIds()`, so a registry that is merely still loading is not read as
   * an empty vocabulary (S1-C).
   */
  ready?(): Promise<void>;
}
interface CriterionSpec {
  /**
   * Stable criterion id (T1). Omitted, the runtime generates one from the batch
   * position (`ac1-1`, `ac2-1`, …) — the scheme every criterion was numbered
   * with. Declared, it is stored verbatim, and it is the only id a
   * parent-level `childEvidence.criterionId` can name: a parent that defines a
   * child's criteria *and* points at one of them must declare the id here,
   * because a generated id is only known after admission.
   */
  criterionId?: string;
  description: string;
  command?: string;
  mode?: VerificationMode;
  mandatory?: boolean;
  requiredEvidence?: string[];
  /**
   * Evidence dependencies (KISS §5.1): artifact/evidence kinds or ids that must
   * exist in the store before this criterion can be judged. Since P4 this
   * declaration names a **verified reference product** — the producing run must
   * be verified and carry a passing verdict. Admission checks the shape only;
   * the orchestrator judges existence at spawn time and a missing reference
   * settles the child blocked, with the gap registered as an obligation.
   */
  requiresArtifact?: string[];
  /**
   * Raw-input counterpart of `requiresArtifact` (P4): artifact/evidence kinds
   * or ids this criterion consumes, where mere existence in the store is the
   * whole requirement — any run state. Judged at spawn time exactly like
   * `requiresArtifact`.
   */
  acceptsArtifact?: string[];
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent dispatches by mode (the current behavior);
   * present, the id must exist in the verifier registry — an unknown id
   * rejects the whole batch at admission time, with the error naming every
   * registered id.
   */
  verifierRef?: string;
  /**
   * The parent-level evidence map (KISS §6 C2, P4): which child of the
   * decomposing task this criterion rests on, by batch position, optionally
   * narrowed to a child criterion and an evidence reference. Requires mode
   * `composite`; judged at parent-acceptance time against the store. Absent
   * keeps the composite conjunction as the whole verdict.
   */
  childEvidence?: ChildEvidenceRef[];
  /**
   * Labels this criterion's judgement heuristic (KISS §5.1, P4): the verdict is
   * marked as such and never counted as a deterministic pass. Mutually
   * exclusive with `childEvidence`.
   */
  heuristic?: boolean;
  /**
   * Acceptance inputs this criterion's verdict rests on that the executing side
   * must not modify (S1-V slice 2): acceptance scripts, threshold files,
   * fixtures — declared as paths, resolved against the session's checkout.
   *
   * **Only the paths declared here are protected.** A criterion that declares
   * none carries no protection, and nothing is read or claimed for it.
   *
   * Who fixes the identity: the runtime, at admission, before the contract is
   * written. Each declared path is resolved against the session's checkout and
   * read once; the SHA-256 of its bytes is fixed beside the declared path in
   * the child's contract, which is what the contract and proposal identities
   * describe. A declared path that cannot be read — or a session whose checkout
   * cannot be resolved — refuses the whole batch: no id minted, nothing
   * persisted, because an identity fixed against the wrong bytes (or against a
   * guessed base) is worse than no task at all.
   *
   * Who re-checks: the verifier registry, before judging the criterion, against
   * the same checkout. A missing or modified input fails the criterion naming
   * the path, so a rewritten acceptance script can never turn a wrong product
   * into a pass.
   */
  protectedInputs?: readonly string[];
}
interface DecomposeChildSpec {
  objective: string;
  acceptanceCriteria: readonly CriterionSpec[];
  requiredCapabilities?: readonly string[];
  dependsOn?: readonly number[];
  /**
   * Assumptions the child task's contract rests on, in the caller's words.
   * Merged with the dependency-evidence references the orchestrator derives at
   * spawn time into the handoff's `assumptions` — a field both the spawn
   * prompt and the reprojected worker contract render.
   */
  assumptions?: readonly string[];
  /**
   * Execution scope and limits this child runs under, in the caller's words
   * (T1). Persisted in the child's contract — so a reader of the store sees the
   * scope the worker was given, not only the spawn prompt's copy of it — and
   * rendered into the handoff's constraints. Text is a declaration, not a
   * grant: the runtime still enforces every permission on its own plane.
   */
  constraints?: readonly string[];
  /**
   * The caller declares this child may decompose itself (RFC §36: the agent
   * admits it so its own worker keeps the option to split further). A missing
   * required capability forces `decomposable` on its own; the declaration is
   * what makes a child with no gap decomposable.
   */
  decomposable?: boolean;
  /**
   * Contract-level marker (P4, KISS §6 C2): this child demands independent
   * parent acceptance — its own criteria must carry a `childEvidence` map, or
   * admission refuses the batch. Deleting the map can never silently degrade
   * the task back to the composite conjunction.
   */
  requiresIndependentAcceptance?: boolean;
}
interface DecomposeSpec {
  children: readonly DecomposeChildSpec[];
  reason: string;
  /**
   * The contract language this batch is written in (T1). Omitted is the legacy
   * adapter — the runtime writes its current version, which is what an entry
   * that does not version its input means. A declared version this build does
   * not know is refused for the whole batch, never read with the wrong field
   * semantics.
   */
  contractVersion?: number;
}
/**
 * One root contract as its caller presents it (A0 §1.2, §2): the goal of a root
 * session — objective, acceptance criteria, assumptions, constraints, declared
 * capabilities — in the authoring form the tools and the direct service entry
 * share.
 *
 * The field set is the contract's own (`task/src/contract.ts:TaskContract`) and
 * nothing else: a key this shape does not declare is refused by name rather than
 * dropped, so a caller cannot smuggle a budget, a skill pin or a permission
 * through a field the runtime never reads. Text is stored verbatim — blankness is
 * refused, bytes are not rewritten — and criterion ids are fixed by the single
 * normalization entry.
 *
 * What this shape deliberately does *not* carry: a mode that replaces the
 * acceptance rule, a flag that skips the review, or a parent to hang the goal
 * under. A root contract is the goal; how it is *reviewed* is the deployment's
 * policy, and how it is *checked* is its criteria.
 */
interface RootContractSpec {
  objective: string;
  acceptanceCriteria: readonly CriterionSpec[];
  assumptions?: readonly string[];
  constraints?: readonly string[];
  requiredCapabilities?: readonly string[];
  /** The contract language, as {@link DecomposeSpec.contractVersion}: omitted means this build's version. */
  contractVersion?: number;
}
/**
 * What a caller may say about one root intake beyond the contract itself. The
 * fields mirror {@link DecomposeProposalOptions} because a root contract is a
 * proposal too — same lifecycle, same key rules, same decision binding.
 */
interface RootIntakeOptions {
  /**
   * The idempotency key this request is addressed by (§2). Absent, the runtime
   * derives it from the store, the root session and the contract's own digest
   * ({@link rootProposalRequestKey}) — so the same contract asked for again is
   * answered from the record, and a revision (different content) is a different
   * key. Given explicitly, the same rule applies: one key names one proposal,
   * and a key already bound to other content is refused by name.
   */
  requestKey?: string;
  /** The proposal this one revises (§6): a rejected or stale root contract, whose record is kept. */
  supersedes?: string;
  /**
   * The call's own control: an already-aborted `signal` persists nothing. There is
   * no `callId` here and no write drain behind it — nothing about an activation
   * hands this checkout to another writer or closes this session's own ability to
   * write (A3 §3.3's drain is the convergence *before* a batch or a verification
   * takes the checkout, and a root run keeps its own), so the exclusion such a
   * field exists for has no step to apply to.
   */
  exec?: {
    signal?: AbortSignal;
  };
}
/**
 * What one root intake settled (A0 §1.3–§1.4). `status` is the field to switch
 * on.
 *
 * `pending_review` declares no ids rather than optional ones: a root contract
 * waiting for a decision has no task and no run — that is the whole point of
 * `all` — and a caller reading an id off this member would be reading a field
 * that does not exist. `activated` carries the ids the activation commit minted,
 * so the caller knows which root task and run its contract became without
 * re-reading the store.
 */
type RootIntakeResult = {
  status: 'activated';
  proposalId: string;
  taskId: TaskId;
  runId: RunId;
  detail: string;
} | {
  status: 'pending_review';
  proposalId: string;
  detail: string;
};
/**
 * What {@link TaskRuntime.adoptRoot} found for one root session.
 *
 * Two outcomes, both normal: the store holds a root task bound to this session
 * (`adopted`, with the task and run ids and the phase the session's gate was set
 * to), or it does not (`adopted: false`) — a store can exist with no task at all
 * (A0 §1.1: `graphs.create` opens it, the intake fills it), and that is not an
 * error, it is the state before a contract was accepted. The negative answer is
 * given *after* the adoption's own recovery pass has run (§3 stage B,
 * {@link TaskRuntime.adoptRoot}), so its `detail` names the proposals that pass
 * left open and states that nothing was created.
 */
type RootAdoption = {
  adopted: true;
  taskId: TaskId;
  runId: RunId;
  /**
   * The phase this session's execution gate now holds, derived from the
   * store's own run record. A root run that reached a terminal state leaves
   * `terminal`: a late intake or write on a finished root is refused by the
   * gate as well as by the state, and a restart must re-derive that from the
   * store rather than trust what a dead process remembered (§1.8).
   */
  phase: ExecutionPhase | 'terminal';
  detail: string;
} | {
  adopted: false;
  detail: string;
};
/**
 * Options for {@link TaskRuntime.replayTask} (guide §2.7.6, W15). The set is
 * closed: a key this build does not read — the experiment clock
 * (`wallTimeMs`/`durationMs`) it deleted above all — refuses the replay by name
 * before anything runs.
 */
interface ReplayTaskOptions {
  /** Lineage tag, e.g. `evolution-replay:<proposalId>` — written into the replayed task's objective and the review record's anomalies. */
  lineage: string;
  /** Candidate-side per-run patches; absent replays under the production configuration. */
  overlay?: ReplayOverlay;
  /** Candidate contract replacing the champion's (the task_definition deterministic criteria replay). */
  contract?: {
    objective: string;
    acceptanceCriteria: AcceptanceCriterion[];
    requiredCapabilities: string[];
  };
  /** false: no worker spawn — the verifier alone settles the run (deterministic criteria replay). Default true. */
  spawn?: boolean;
  /**
   * The workspace this replay runs in, when the caller has prepared one of its
   * own (S4-E) instead of replaying into its own checkout. The directory is
   * claimed under the same one-writer-per-workspace rule as any other, and it is
   * what the whole run resolves against: the provider pre-check, the protected
   * acceptance inputs' bytes, the worker's own cwd, its children's, the
   * verifier's cwd and the verifier's exclusive hold. The caller owns the
   * directory's lifecycle — creating it, snapshotting it, and cleaning it up
   * afterwards are not this entry's business — and a path that cannot be
   * resolved refuses the replay before anything persists.
   */
  workspace?: {
    path: string;
  };
  /**
   * The model selection this replay runs under (S4-E §Q3), replacing the
   * deployment's default for this run's worker and for every worker its
   * decomposition spawns — the experiment's frozen identity. Merged over the
   * default exactly as `SpawnRequest.agentOptions` always is (`{@link AgentOptions}`
   * is DSH's own: provider, model, reasoning effort, max output tokens), so an
   * option this deployment's default fixes can still be frozen here, and one
   * neither names keeps the loop's own fallback. Absent replays on the
   * deployment's current selection, exactly as before. The options are forwarded
   * verbatim: the runtime does not resolve, default or validate them — the
   * caller freezes what the deployment's real configuration and registry say, and
   * an unregistered route fails the worker's first request loudly rather than
   * silently falling back.
   */
  agentOptions?: AgentOptions;
  signal?: AbortSignal;
}
interface Config {
  /** Capability registry: name → skills/tool labels/agent preset/permission preset granted when a task requires it. */
  capabilities: Record<string, CapabilityConfig>;
  /** Agent preset used when no matched capability names one. */
  defaultPreset?: string;
  /** Wall-clock budget for one `verifier.verifyRun` call. */
  verifyTimeoutMs: number;
  /** Absolute tree depth a decomposition may reach: a child at `maxDepth + 1` is rejected (root is depth 0). */
  maxDepth: number;
  /** Most children one `task_decompose` batch may create. */
  maxChildren: number;
  /** Per-run resource budget; see {@link BudgetConfig} for which member is enforced, checked post-hoc, or declared only. */
  budget: BudgetConfig;
  /**
   * No-progress rounds before a worker that went idle without submitting is
   * stopped (KISS §5: `no_progress(3轮)`). **Enforced** since A3: the batch
   * driver observes every idle of a run whose phase is still `active`, marks one
   * round per unsubmitted idle (the store's own last marking supplies the
   * consecutive count), reminds the worker once per streak, and stops the run
   * with the no-progress reason at this limit. A run waiting on its children or
   * on verification is expected to be idle and is never marked.
   */
  noProgressRounds: number;
  /**
   * Whether a task admitted `leaf` may still decompose at runtime: the node
   * itself decides it is not atomic, instead of its parent having predicted it
   * ({@link DEFAULT_ALLOW_RUNTIME_DECOMPOSITION} carries the shipped value and
   * the argument for it). Off, a `leaf` parent's batch is refused by admission
   * unless the child was declared `decomposable`.
   */
  allowRuntimeDecomposition: boolean;
  /**
   * Whether a new child batch must be reviewed by a person before it may run
   * (T2/T3 §5): `off` (the shipped default) admits on the machine rules alone
   * and records `policy-off`; `all` holds every new batch in `pending_review`
   * until a persisted decision approves it. The policy belongs to the
   * deployment — it is read from this configuration on every submission and
   * every continuation, it is never taken from a batch's own fields
   * (`normalizeDecomposition` refuses a batch-level key by name), and a
   * proposal carries the policy it was born under, so tightening the
   * deployment never rewrites what already happened and never releases a batch
   * that is already waiting (§5: only tightening is allowed).
   */
  generatedTaskReview: 'off' | 'all';
  /**
   * Where a run's bound provider content is materialized (S1-C): one directory
   * per run holding the skills the run loads, outside the worker's checkout so a
   * worker cannot rewrite what it is verified against. Defaults to
   * {@link defaultRunBindingRoot} (`<DSH_HOME or ~/.dsh>/singularity/run-bindings`);
   * a deployment that cannot materialize content fails a run that selects any,
   * rather than letting it load an unbound production path.
   */
  runBindingRoot?: string;
  /**
   * What the whole tree may spend (A3 §3.5): a wall-clock limit measured from
   * the root run's own persisted `startedAt`, a cap on the runs the tree may
   * start, and the concurrent-writer count — which this deployment can only
   * honor as `1`. A limit that cannot be executed is refused at construction
   * ({@link assertRootBudgetConfig}) instead of accepted and quietly ignored.
   *
   * The object is closed: a member this module does not know is a hard limit
   * nobody would enforce, so naming one refuses to start.
   */
  rootBudget?: RootBudgetConfig;
  /**
   * How long one write drain may take (A3 §3.3) before it is reported as
   * unconfirmed — and an unconfirmed drain fails the run rather than assuming
   * the writers stopped. Applied to the parent's drain before a batch starts,
   * to a submission's drain, and to a batch's settlement drain.
   */
  writeDrainTimeoutMs: number;
}
/**
 * What the load-time provider scan found (S1-C item 3) — the deployment's own
 * capability table read from the harness process's own discovery roots, at the
 * moment that table went into effect.
 *
 * Two readings, both honest: {@link precheck} carries every verdict, so the
 * effective provider set is `executionProviders` of its rows (the only role that
 * may close an execution gap) with knowledge/guidance beside it; {@link defects}
 * carries the same refusals the load report printed, one line per defect.
 *
 * `defects` empty and `failed` absent means every skill the table names is a
 * loadable provider *from this viewpoint* — which is not the same as "every
 * worker's viewpoint", see {@link TaskRuntime.providerLoadReport}.
 */
interface ProviderLoadReport {
  /** The scan's verdicts, per capability and per skill; absent when the scan could not run at all. */
  readonly precheck?: ProviderPrecheck;
  /** Every refused provider, one line per defect; empty when the table names only loadable providers. */
  readonly defects: readonly string[];
  /**
   * Why the scan could not run at all — a failure of the scan itself, not of a
   * provider. Reported instead of a verdict, never swallowed: a load report that
   * could not be taken is not a quiet success.
   */
  readonly failed?: string;
}
declare const DEFAULT_VERIFY_TIMEOUT_MS: number;
/**
 * The shipped per-run budget (KISS §8.6: granularity knobs live in config, not
 * in definitions). `wallTimeMs` is a backstop far above the longest legitimate
 * worker run this deployment has measured (a workload build takes 18–20 min,
 * so two hours kills only a genuinely stuck worker); `maxToolCalls` sits an
 * order above KISS's max_tool_calls 15 reference because this deployment's
 * submit/poll workers legitimately make dozens of calls — and it is a
 * post-hoc annotation, so a tight value would be noise, not a guardrail.
 * `attempts` matches the current reality: one run per task, no retry branch.
 * `tokens` carries no default on purpose — see {@link BudgetConfig}.
 */
declare const DEFAULT_BUDGET: Readonly<BudgetConfig>;
/** The shipped no-progress round count (KISS §5's `no_progress(3轮)`); enforced since A3 — see {@link Config.noProgressRounds}. */
declare const DEFAULT_NO_PROGRESS_ROUNDS = 3;
/**
 * The shipped review policy (T2/T3 §5): `off`. Every decomposition this
 * deployment has ever run was admitted on the machine rules alone, and the
 * guide's decision is that a human review is something a deployment *turns on*
 * (§5: no risk-based classifier, no "only when no template matched") rather
 * than something it turns off. `off` is not a silent state: the proposal
 * record carries the policy it was born under, which is what lets a reader
 * tell "this batch ran without a human review" from "a person approved it".
 */
declare const DEFAULT_GENERATED_TASK_REVIEW: 'off';
/**
 * The shipped write-drain window (A3 §3.3). Thirty seconds is far above the
 * settle time of a tool call this process can see finish — the drain waits on
 * in-flight registrations and the session's managed jobs, both of which either
 * stop promptly or are the thing the caller must be told about — and far below
 * a verifier call's own deadline, so a drain that cannot be confirmed fails the
 * run long before the verification budget it would otherwise waste.
 */
declare const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 30000;
/**
 * Growth guardrails handed to admission as `decompositionPolicy`
 * ({@link Config.maxDepth}, {@link Config.maxChildren}, checked at
 * `admission.ts:47-58`).
 *
 * `4` is one level of headroom above the deepest tree actually exercised: the
 * §4.1 run recorded "根 → 子 → 孙" three levels (`docs/singularity-harness-guide.md:258`),
 * so a shallower cap would forbid a shape known to work while a deeper one would
 * let a runaway self-decomposer spend its whole budget before admission ever
 * refuses. `8` is several times the batches real runs send (2–4 children):
 * a single batch above it is a parent enumerating work it should
 * have delegated a level down, not a decomposition the orchestrator should run.
 */
declare const DEFAULT_MAX_DEPTH = 4;
declare const DEFAULT_MAX_CHILDREN = 8;
/**
 * Whether a task admitted `leaf` may still decompose itself
 * ({@link Config.allowRuntimeDecomposition}) — the door this deployment leaves
 * open on every node's own judgement, and the reason `leaf` is a hint rather
 * than a lock.
 *
 * A parent that admits a child `leaf` predicted the work fits one worker. That
 * prediction is one guess made before the work started, while `细化想法4.md:415-427`
 * puts `DECOMPOSE` at the Task Worker's own discretion and §36 (`:1459-1483`)
 * asks for criteria the node can apply, not for a verdict frozen at delegation
 * time: with the switch off, a node that discovers it is not atomic has no legal
 * path, which is the only thing that made the recursion unreachable. Nothing
 * else moves: `task_decompose` is already in every worker's grant whatever its
 * `decompositionStatus` (`capability.ts:145`), so a switch-off deployment hands a
 * worker a tool the same runtime then refuses.
 *
 * The switch relaxes no guardrail, so `true` is the shipped default. A batch
 * still clears every admission rule — structure, acyclic dependencies,
 * executable criteria carrying a command, the capability-gap rule,
 * {@link Config.maxDepth}, {@link Config.maxChildren} — and a run still holds at
 * most one unfinished batch and one proposal in flight (K1 §1; an *active* run
 * is the whole of that rule, and a batch that ended hands the run back active).
 * A deployment that wants every split pre-declared by the parent sets `false`
 * and keeps the pre-switch refusal, named message included.
 */
declare const DEFAULT_ALLOW_RUNTIME_DECOMPOSITION = true;
/**
 * The shipped capability table, kept verbatim in step with `config.yml`
 * (document 1, the `task-runtime` row). `tools` holds LABELS from
 * {@link TOOL_LABELS}, expanded to real DSH tool names when a manifest is
 * resolved, and every worker also keeps {@link workerBaseline} whatever its
 * capabilities declare. `mcpServers` holds names from {@link MCP_SERVER_REGISTRY},
 * mounted per worker at spawn with the run's env binding (`./mcp-servers.ts`).
 *
 * No entry declares `permission`: flipping a worker to an approval-gated preset
 * (`workspace-write` asks) is blocked until approvals reliably reach the canvas
 * on a real deployment — the known issue recorded as #17 in
 * `docs/singularity-harness-guide.md:365` (fix landed 2026-09-17, real-topology
 * re-run still outstanding). An unattended worker on `ask` simply hangs.
 *
 * The four BB execution families read: the three `verify`/`run-*-regression`
 * entries ride the `bb-verify` composition (persona + fs + skill + a compaction
 * ratio tuned for long poll loops) plus the env's own bbdev MCP server;
 * `run-verilator-regression` adds the `waveform` skill because RTL failures are
 * settled cycle-level. `build-*` entries need no preset — one submit/poll MCP
 * round fits the default composition; `build-chip-config`'s install step itself
 * is bash-driven (the bbdev API's `/config/install` has no MCP wrapper), the
 * server covers the follow-up `validate`. Verification never rides the CI
 * dispatch channel: per the 2026-09-18 human ruling, dispatch/CI scripts are
 * reference material for writing MCP servers only — verification runs locally
 * (verify node + bbdev MCP + the local toolchain).
 */
declare const DEFAULT_CAPABILITIES: Readonly<Record<string, CapabilityConfig>>;
declare module '@deepseek-ai/cordis' {
  interface Context {
    taskRuntime: TaskRuntime;
  }
}
/**
 * What a caller may say about one submission beyond the batch itself.
 */
interface DecomposeProposalOptions {
  /**
   * The idempotency key this request is addressed by (§6). Absent, the runtime
   * derives it from the calling context
   * ({@link ./proposal.ts:proposalRequestKey}); given, it is the caller's own
   * stable identifier and the same rules apply either way — one key names one
   * proposal, and a key already bound to a *different* content is refused
   * rather than silently aliased.
   */
  requestKey?: string;
  /**
   * The proposal this one revises (§6): a rejected or stale one, whose record
   * is kept. A revision is new content (and a new key); naming the predecessor
   * is what lets a reader follow the history.
   */
  supersedes?: string;
  /**
   * The admission call's own control: `signal` governs the pre-check (an
   * already-aborted call persists nothing), `callId` is the call's own
   * registration id, so the batch's first drain does not wait for the call
   * that is asking (A3 §3.3).
   */
  exec?: {
    signal?: AbortSignal;
    callId?: string;
  };
}
/**
 * What one submission settled. `status` is the status the store holds after
 * the call — `ready` for a batch born under policy `off`, `pending_review` for
 * one waiting for a person — and, when the request hit a proposal the store
 * already had, whatever that proposal's status is: a retry learns the state
 * instead of creating a second batch.
 */
interface ProposalSubmission {
  proposalId: string;
  status: TaskProposalStatus;
  /** The policy the proposal was born under (the audit field, never a fake approval). */
  policy: TaskProposalPolicy;
  /** True when this request was answered from a stored proposal (`requestKey` + content) instead of a new submission. */
  existing: boolean;
  /** What the caller owes next, or what happened to the review request, in one sentence. */
  detail: string;
  /** How the review request went, when the proposal is waiting for one. */
  review?: {
    requested: boolean;
    detail: string;
  };
}
/**
 * What one `decomposeAndRun` settled (T2/T3 §6). `status` is the field to
 * switch on.
 *
 * The `pending_review` member declares `batchId` and `childTaskIds` as `never`
 * rather than optional: there is no batch and no child id when a batch is
 * waiting for a review, and a caller that reads the batch off this member would
 * be reading a field that does not exist. `never` is also the one shape that
 * keeps a caller written before T2 — `agent-singularity/src/tools/task-decompose.ts`
 * reads `{ batchId, childTaskIds }` off the result — compiling: that caller
 * must switch on `status`, and this entry's admission path is otherwise
 * unchanged (`off` still returns `{ batchId, childTaskIds }` synchronously).
 */
type DecomposeAdmissionResult = {
  status: 'admitted';
  proposalId: string;
  batchId: string;
  childTaskIds: TaskId[];
} | {
  status: 'pending_review';
  proposalId: string;
  /** Where the proposal stands and what a decision would have to be. */
  detail: string;
  batchId: never;
  childTaskIds: never;
};
/**
 * What one continuation settled (T2/T3 §6, root arms A0 §1.4). The members are
 * the whole answer to "did this proposal become what it asked for": `admitted`
 * carries the batch and its children, `activated` carries the root task and run
 * a root contract became, and every other member is a proposal that did **not**
 * run — waiting for a decision, invalidated (`stale`, `expired`), or already
 * refused. A continuation that cannot even be judged (the batch content is not
 * in this process, the deployment cannot list its verifiers, the root budget
 * refuses the batch, the workspace is somebody else's) is a *throw* instead:
 * nothing was decided about the proposal, and it is left exactly as it was.
 *
 * The two "it became something" arms are kept apart by `status` rather than
 * sharing one member with optional ids: a root intake is not a batch, and a
 * reader that had to test whether `batchId` happens to be there would be reading
 * a claim the record does not make (§2: the batch vocabulary does not apply to a
 * root).
 */
type ProposalContinuation = {
  proposalId: string;
  status: 'admitted';
  batchId: string;
  childTaskIds: TaskId[];
  detail: string;
} | {
  proposalId: string;
  status: 'activated';
  /** The root task the activation commit created, carrying the approved contract. */
  taskId: TaskId;
  /** The root run the activation commit created, in the proposal's root session and born `active`. */
  runId: RunId;
  detail: string;
} | {
  proposalId: string;
  status: Exclude<TaskProposalStatus, 'admitted'>;
  detail: string;
  /** The machine reason recorded with the status, when the status is one the runtime wrote (`stale`, `expired`). */
  reason?: string;
};
/** What one decision settled: the outcome on record, where the proposal stands, and — for an approval — how far the continuation got. */
interface ProposalDecisionResult {
  proposalId: string;
  /** The outcome that was **recorded**, not the one that was asked for: a late approval becomes `expired` (§6). */
  outcome: TaskProposalDecisionOutcome;
  /** Where the proposal stands: its stored status, or `activated` once a root contract's approval has created it. */
  status: TaskProposalStatus | 'activated';
  /** The continuation an approval triggered, when one was attempted. */
  continuation?: ProposalContinuation;
  detail: string;
  /** The reason recorded with the outcome, when there was one. */
  reason?: string;
}
/** One child's unsatisfied capability requirement, as the pre-check found it. */
interface CapabilityGap {
  /** The child's batch position (its index in the proposal's children). */
  childIndex: number;
  /** That child's objective, so the obligation raised for the gap names the work it blocks. */
  objective: string;
  /** The capability names the registry could not grant. */
  missing: readonly string[];
}
/**
 * One refusal the pre-check earned: the error the caller raises (the same
 * message and error class the admission chain produced before T2), every
 * field-level reason behind it, and the capability gaps it rests on.
 *
 * The gaps are separate because the *fact* of a gap is recorded before the
 * batch is refused: one obligation per missing capability, raised on the
 * parent (KISS §7 — a gap is a normal state with a record, not a silence). The
 * pre-check itself writes nothing; the submission path is what raises them.
 */
interface DecompositionRefusal {
  readonly error: Error;
  readonly reasons: readonly string[];
  readonly gaps: readonly CapabilityGap[];
}
/** Why a review is being requested of a person. */
type ProposalReviewTrigger = 'submitted' | 'tightened' | 'recovered';
/**
 * One request for a person to review a proposal (§5). It carries the proposal
 * (what a decision binds) and — when this process holds them — the facts §5
 * requires the review to show: the children's objectives, criteria, assumptions,
 * dependencies and declared capabilities for a batch, or the single root
 * contract for a root intake, rather than a digest.
 *
 * The subject is discriminated by kind because the two are different things to
 * show. A decomposition batch belongs to a parent task and is displayed under
 * its goal; a root contract has no parent — the task it becomes does not exist
 * while it waits — so the request names the root session instead and carries the
 * contract itself. Neither arm invents the other's fields: a reviewer sees a
 * root goal as a root goal, never as a one-child decomposition of nobody.
 */
interface ProposalReviewRequestBase {
  readonly storeId: string;
  readonly trigger: ProposalReviewTrigger;
  readonly proposal: TaskProposal;
  /** The manifests this proposal resolves to right now; aligned with the batch's children, or the root contract's declared capabilities. */
  readonly manifests: readonly CapabilityManifest[];
  /** The registered verifier ids at the moment of the request, when the deployment can list them. */
  readonly registeredVerifiers?: readonly string[];
  /** Every obligation raised on the subject so far — §5's "未满足义务说明", read from the store rather than summarized. */
  readonly obligations: readonly Obligation[];
}
/** A batch to review: its parent's own record, and the children rebuilt from the store. */
interface DecompositionReviewRequest extends ProposalReviewRequestBase {
  /** The kind, when the writer stated it. Absent means this arm — the shape every request had before root intake existed. */
  readonly kind?: 'decomposition';
  /** The parent task the batch belongs to, as the store holds it. */
  readonly parentTask: TaskInstance;
  /**
   * The batch the proposal holds, rebuilt from the store (`storedBatchOf`) — the
   * contracts a reviewer has to read, not a digest, and not whatever a live
   * process happens to remember.
   */
  readonly batch: NormalizedBatch;
}
/** A root contract to review: the goal of one root session, and nothing above it. */
interface RootContractReviewRequest extends ProposalReviewRequestBase {
  readonly kind: 'root';
  /** The root session whose goal this contract is. There is no parent task to name, and none is invented. */
  readonly rootSessionId: string;
  /** The normalized root contract the proposal asks to run, as stored — what a reviewer reads is what an approval binds. */
  readonly contract: TaskContract;
}
type ProposalReviewRequest = DecompositionReviewRequest | RootContractReviewRequest;
/** What a review channel did with one request. Never a decision, never an approval. */
interface ProposalReviewNotice {
  /** Whether a person was actually asked. */
  readonly requested: boolean;
  /** What the channel reported, for the caller to render. */
  readonly detail?: string;
}
/**
 * The seam one deployment mounts to reach a human (T2/T3 stage C wires the
 * existing approval channel here): the runtime resolves it softly from the
 * context as `proposalReviewChannel`, calls it when a proposal needs a person,
 * and reads nothing back but a notice. A channel that is absent, that answers
 * `requested: false`, or that throws leaves the proposal exactly where it is —
 * `pending_review` — because requesting a review is not a decision and this
 * runtime has no way to turn a notification into one.
 *
 * The method's return type is deliberately not a decision: the only thing that
 * advances a waiting proposal is a persisted `TaskProposalDecided`, written by
 * {@link TaskRuntime.decideProposal} from a trusted channel or a test.
 */
interface ProposalReviewChannel {
  requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice>;
}
/**
 * One worker recovery attempt a pass made, as the pass reports it (A4 §F.1):
 * which run and Session it was about, and what the attempt settled as —
 * `live` (the same Session is back, the pass's own success), `retry` (another
 * owner holds it; nothing was taken over) or `refused` (the identity could not
 * be established, and the caller must walk the run to a terminal state).
 *
 * The runs this covers are the ones the question protocol parked: a worker whose
 * blocking question is unresolved, one whose Session is owed a delivery it has
 * not been given, and a `waiting_children` parent that participates in questions
 * at all. Every other unsubmitted run is still recovery's own cancellation.
 */
interface QuestionResumeReport {
  /** The run the attempt was about, as the store names it (`run "r-…" (session "s-…")`). */
  readonly subject: string;
  readonly status: AdoptedWorkerResume['status'];
  /** Present for `retry` and `refused`: why the Session was not brought back. */
  readonly reason?: string;
}
/**
 * What one recovery pass could not finish, reported rather than guessed: the
 * proposals it could not continue and why. Empty means every open proposal was
 * either continued or already in a state recovery must not touch.
 */
interface ReconcileReport {
  readonly unresolvedProposals: readonly {
    proposalId: string;
    status: TaskProposalStatus;
    reason: string;
  }[];
  /**
   * What the pass's own question deliveries settled as (A4 §F.1), one record per
   * fact the store still owed a message for — `delivered`, `already-present`, or
   * `unavailable` for a target nobody has brought back yet. Empty means the store
   * owed nothing; a `refused` record names why that one could not be decided.
   */
  readonly questionDeliveries: readonly QuestionReconcileReport[];
  /**
   * What the pass's own recovery of workers settled as (A4 §F.1, widened by K1
   * §5), one record per run it tried to bring back — `live` for a Session that is
   * now reachable, `retry` for one another owner still holds, `refused` for an
   * identity that could not be established (and whose run the pass then settled
   * terminal). A run comes back for one of two reasons and the record says which:
   * it waits on coordination of its own, or it is a delegated parent whose batches
   * ended and which has to be told so. Empty means the pass found neither.
   */
  readonly questionResumes: readonly QuestionResumeReport[];
}
/**
 * What a read sees about one store's recovery (A2 §E) — facts and markers,
 * never a trigger: {@link TaskRuntime.recoveryStatus} recovers nothing, starts
 * no driver and writes no gate, so a context query or a diagnostic can show
 * exactly where a store stands without becoming the thing that recovers it.
 *
 * - `ready` — nothing needs recovering, or the explicit barrier completed;
 * - `not-activated` — the store cannot be read yet: the legal root entry (an
 *   intake) creates it, and every other caller is refused by the store's own
 *   unknown-store error rather than by a recovery verdict;
 * - `recovering` — an explicit activation's barrier is still running;
 * - `recovery-required` — the store holds in-flight work this process is not
 *   driving (a worker, a replay, a waiting parent); only an explicit
 *   activation (`adoptRoot`, through `graphs`' activate) may recover it;
 * - `needs-recovery` — the store holds a run that predates coordination
 *   phases: reading and cancelling are its only continuations, and it is never
 *   treated as active by default;
 * - `recovery-failed` — the last explicit recovery failed; `reason` is the
 *   original one, and the next explicit activation is the retry.
 */
type StoreRecoveryStatus = {
  status: 'ready';
} | {
  status: 'not-activated';
  reason: string;
} | {
  status: 'recovering';
} | {
  status: 'recovery-required';
  reason: string;
} | {
  status: 'needs-recovery';
  reason: string;
} | {
  status: 'recovery-failed';
  reason: string;
};
declare class TaskRuntime extends Service {
  static inject: string[];
  static Config: z<Config>;
  private readonly config;
  /** sessionId → run binding, rebuilt whenever a store is (re)opened. */
  private readonly sessions;
  /**
   * The sessions this process actually started (a spawned worker, a root run
   * created here, a replay). Deliberately *not* populated by {@link reindex}:
   * the recovery path needs to tell "this process is running that run right
   * now" from "the store holds a run from a process that is gone", and a
   * binding rebuilt from a snapshot cannot answer that.
   */
  private readonly startedSessions;
  /**
   * The batches and replays this process owns, keyed `<storeId>/<batchId>`
   * (`replay/<runId>` for a replay). The map is the registration the recovery
   * path consults, and the controller in each entry is what a cancellation,
   * the root deadline or the unload path aborts.
   */
  private readonly drivers;
  /**
   * The lineage tag of each replay task this process started, keyed by task id.
   * A spawning replay's worker submits like any other worker, so its terminal
   * review is written by the shared settlement entry — which is where the tag has
   * to be known. In-process only, and honest about it: a replay resumed in a new
   * process records no lineage on the run it continues.
   */
  private readonly replayLineage;
  /**
   * The directory each session this process spawned into a *named* workspace
   * works in, keyed by session: a replay may be placed in a directory of its own
   * (S4-E), and that directory — not the session's graph env — is then the
   * checkout every one of its runs resolves against, its own decomposition and its
   * children's spawns included.
   *
   * In-process only, like the ownership registry it feeds and the session index
   * beside it: a session the process never spawned has no entry, and a restart
   * resolves the store's own sessions from the graph again. An entry lives while
   * the run bound to its session is non-terminal ({@link runSettledFromRuntime}
   * forgets it), which is exactly as long as anything can resolve through it.
   */
  private readonly sessionWorkspaces;
  /**
   * What each session this process spawned *runs under*, keyed by session: the
   * model selection its agent was created with (`agentOptions`). A replay carries
   * an experiment's frozen binding (S4-E §Q3), and the sub-execution its worker
   * decomposes into is the same run of the same experiment — so the orchestration
   * that session's own decomposition builds resolves the binding from here, exactly
   * as it resolves the workspace it works in from {@link sessionWorkspaces} beside
   * it.
   *
   * In-process only, for the same reason and with the same honesty: a session this
   * process never spawned has no entry, and the binding is not part of any record
   * (a replay resumed in a new process continues under the deployment's own
   * selection, as it always continued without a lineage tag). An entry lives while
   * the run bound to its session is non-terminal ({@link runSettledFromRuntime}
   * forgets it), which is exactly as long as anything resolves through it.
   */
  private readonly sessionExecutionBindings;
  /** The tool-execution gate and the write drain (A3 §3.3); this runtime owns every phase it writes. */
  private readonly executionGate;
  /**
   * The stores a cancellation is closing right now ({@link cancelGraph}), from
   * the instant its gate was closed to the instant the operation is done with
   * the store.
   *
   * A cancellation is the one transition that puts a barrier in effect *before*
   * the store records it, so during that window the record still says `running`
   * and phase `active` — older than the barrier already in effect here. A read
   * path that rebinds a session in the window would re-apply that older phase
   * and lift the barrier, so {@link gatePhaseFromStore} refuses to move a phase
   * a session already holds while its store is in this set. The store is the
   * truth again the moment the entry goes.
   */
  private readonly closingStores;
  /**
   * One recovery barrier per store (A2 §E): what an explicit activation
   * awaits, what every business execution entry checks before its first side
   * effect, and what a cancellation or the unload invalidates. The persistent
   * record stays the source of truth; this map only says what this process has
   * recovered — it is never persisted and never a second state machine.
   */
  private readonly storeRecovery;
  /** The one-writer-per-workspace ownership registry (A3 §3.4). */
  private readonly workspaces;
  /** The load-time provider scan, taken once ({@link providerLoadReport}). */
  private providerLoad?;
  /**
   * One tail per store and parent task: the serialization §6 asks for, so two
   * approved proposals competing for the same parent cannot interleave their
   * re-checks and their commits. See {@link serializeParent}.
   */
  private readonly parentChains;
  constructor(ctx: Context, config?: Config);
  /**
   * Refuse a root budget carrying a member this build does not execute. The
   * schema keeps unknown keys, so this is where a caller's typo or a limit from
   * a newer version is caught: a `maxTokens` or `maxWallClock` nobody enforces
   * would read as a promise the deployment breaks silently.
   */
  private assertClosedRootBudget;
  /**
   * Refuse a review policy this build does not implement. The configuration
   * schema types the member, but a deployment that constructs the runtime
   * directly (a test, an embedding process) bypasses the schema, and a policy
   * nobody implements is worse than a refusal to start: a value like `"risk"`
   * would read as "somebody decides which batches are reviewed" while this
   * build quietly admits everything. `off` and `all` are the two modes §5
   * defines; nothing is inferred from a near miss.
   */
  private assertGeneratedTaskReview;
  /**
   * The unload path: abort every driver, await their settlements, close the gate
   * for every session this runtime tracks, and release the workspace markers
   * this process wrote. Warnings, never throws — an unload that raised would
   * leave the rest of the process's disposal half-done.
   */
  private unload;
  /**
   * Cordis runs this after construction, once the injected services are there:
   * the load-time provider scan (S1-C item 3) is taken here, so the first thing
   * a deployment learns about its own capability table is what its own discovery
   * roots make of it.
   *
   * This hook never throws: see {@link providerLoadReport} for why the scan
   * reports instead of refusing to start.
   */
  [Service.init](): Promise<void>;
  /**
   * The load-time provider scan over the capability table this process is
   * running (guide §2.4, S1-C item 3): every skill the effective table names,
   * discovered from the harness process's own skill roots (`process.cwd()`'s
   * project roots, `$DSH_HOME/skills`, the user root) and judged by
   * {@link validateSkillProvider} — the same validator admission, capability
   * replacement and candidate promotion use.
   *
   * Why this reports instead of refusing the deployment: the harness process's
   * own viewpoint is **not** the worker's. A deployment-level process loads
   * `config.yml` long before any graph env exists, so it cannot see the checkout
   * a worker will run in (`/…/env/<name>`, whose own `.agents/skills` a worker's
   * discovery walks first) — a skill that resolves fine at admission is
   * therefore legitimately *missing* from the load-time viewpoint. Failing the
   * load on that would refuse configurations that work, and it would fail for a
   * reason the operator cannot fix by editing the table. So every defect is
   * printed, nothing is enforced here, and the hard gate stays where the
   * viewpoint is the worker's own: the admission pre-check, which refuses the
   * whole batch before it persists anything.
   *
   * The result is kept as a value ({@link ProviderLoadReport}): the effective
   * provider set and the defect summary stay queryable after the log line has
   * scrolled away, without re-running the validation. It is the *load-time* fact
   * — a row replaced later in this process (an evolution apply, a rollback) was
   * judged by its own entry before it landed, and is not folded back into this
   * report.
   */
  providerLoadReport(): Promise<ProviderLoadReport>;
  /**
   * One load-time scan, never thrown: a scan that cannot run (a discovery or a
   * read that fails outright) is reported as {@link ProviderLoadReport.failed}
   * and printed just as loudly as a refused provider.
   */
  private scanConfiguredProviders;
  /**
   * The load report, printed through the cordis logger when one is mounted: one
   * line per defect (capability, skill, defect code, detail) plus a header that
   * says what was scanned and that the deployment is starting anyway.
   */
  private reportProviderLoad;
  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn;
  /**
   * The wall-clock deadline one `verifier.verifyRun` call runs under
   * ({@link Config.verifyTimeoutMs}). Exposed because the same deadline has to
   * reach the model-facing `task_verify` self-check: its tool call would
   * otherwise run the verifier with no timer at all.
   */
  get verifyTimeoutMs(): number;
  /** The resolved per-run budget ({@link Config.budget}); which member is enforced, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  get budget(): Readonly<BudgetConfig>;
  /** The resolved no-progress round count ({@link Config.noProgressRounds}); the batch driver's stop limit. */
  get noProgressRounds(): number;
  /**
   * The review policy in force for batches that have not been admitted yet
   * ({@link Config.generatedTaskReview}), exposed read-only: a deployment's own
   * policy is not a secret, and a caller that has to say what happens next
   * (`decomposeAndRun`'s pending answer, a tool's status line) should read it
   * from the runtime rather than infer it from a proposal's birth policy — the
   * two differ exactly when the deployment tightened it after that batch was
   * proposed.
   */
  get generatedTaskReview(): 'off' | 'all';
  /**
   * The tool-execution gate this runtime maintains (A3 §3.3), exposed read-only:
   * what a phase admits and refuses is part of what this service promises, and
   * the runtime is its only writer. Diagnostics and tests read it; nothing
   * outside moves a phase through it.
   */
  get gate(): ExecutionGate;
  /** Resolve required capability names against the configured registry. */
  resolveCapabilities(required: readonly string[]): CapabilityManifest;
  /** The effective capability registry, cloned so callers cannot mutate runtime state. */
  listCapabilities(): Readonly<Record<string, CapabilityConfig>>;
  /**
   * Evolution apply/rollback seam (guide §2.7.7, W16): replace one capability
   * row in the effective registry at runtime — whole-row semantics, the same
   * row the evolution_apply tool edited in `config.yml` just before calling
   * this, so a restart reloads the identical table. `null` removes the row
   * (rollback of a newly-added capability). Later admissions resolve against
   * the replaced row; in-flight runs are untouched.
   *
   * **A replacement is validated before it lands; a removal is not.** This is
   * the entry that makes a row effective in this process, so it runs the same
   * check the promotion gate ran before the row was written to `config.yml`:
   * every skill the new row grants is discovered from the harness process's own
   * roots and judged by `validateSkillProvider`
   * ({@link precheckReplacedCapabilityRow}), against the live registry's verifier
   * vocabulary — fail-closed when that vocabulary cannot be listed. An unusable
   * provider rejects with its named defects and the table is left exactly as it
   * was, so no path into the effective registry skips the one validator
   * (guide §2.4, S1-C item 3). A removal needs no such check: it grants
   * nothing, and refusing a rollback would strand a deployment on a row it is
   * trying to undo.
   */
  applyCapabilityRow(name: string, entry: CapabilityConfig | null): Promise<void>;
  /**
   * The replacement check behind {@link applyCapabilityRow}: the row as it will
   * read after this write, judged by the admission pre-check itself. Throws with
   * every refusal named (capability, skill, defect code, detail) — and writes
   * nothing, which is what makes the caller's table unchanged.
   */
  private assertReplacementRow;
  /**
   * Open one root session's store and adopt the root it already holds, or say
   * that it holds none (A0 §3, the recovery half of the old `createRootTask`).
   *
   * **It creates nothing.** A root task comes into existence exactly one way —
   * a root contract that passed the review gate and was activated
   * ({@link intakeRootContract}) — and this entry refuses to be a second door:
   * there is no parameter, flag or entry that mints a root without a proposal,
   * which is what keeps §1.3's "批准前零根任务" a property of the system rather
   * than of one call path.
   *
   * What it does, in order: create-or-open the store (`rootTaskStoreId`), index
   * every run the store holds, and then —
   *
   * - **no root task**: run the store's own recovery pass (`reconcileStore`:
   *   settle or restart what a dead process left in flight, then the proposals)
   *   and answer from what that pass left. Adoption is the entry graphs and
   *   recovery use (§3 stage B), so the pass runs *here*: a contract whose
   *   approval is on the record and whose process died is carried into the root
   *   it was about by exactly this pass, and a waiting contract's review is
   *   re-asked from the stored facts by it — answering "nothing to adopt" before
   *   that pass would leave a recorded decision uncontinued. A root the pass
   *   activates is then bound the way the bullet below binds one; a store the
   *   pass leaves without a root still answers `{ adopted: false }`, with the
   *   proposals still open on it named by id and status and the fact that
   *   nothing was created stated. A store with no task is a normal state since
   *   §1.1 (a graph's store is opened by its creation and filled when a contract
   *   is accepted), not a failure to report;
   * - **a root task, with a run bound to this root session**: re-check the run's
   *   content binding (S1-C: a snapshot that is no longer readable refuses the
   *   re-entry by name rather than resuming against whatever stands at that path
   *   now), bind the session in this process, derive the session's gate phase
   *   from the store's own run record, settle or restart whatever the store left
   *   in flight (`reconcileStore`) and rebuild this process's workspace
   *   ownership — the same recovery a reopen performs;
   * - **a root task without a run for this session**: refuse by name. That state
   *   is a store whose root was created for a different session or whose run
   *   record is gone, and neither is something to guess a binding for.
   *
   * The gate phase is *derived*, never remembered: a root run that is no longer
   * running — terminal, cancelled, failed, verified — leaves the session
   * `terminal`, so a late intake or a late write on a finished root is refused by
   * the gate as well as by the state (§1.8). Reading it back from the store is
   * what makes that true after a restart, when no process holds the phase the
   * dead one set.
   *
   * **The recovery barrier (A2 §E).** This entry is what an explicit graph
   * activation awaits, and the whole pass above is one barrier: reconciliation
   * of the facts, the gate initialization for *every* session the store knows,
   * and the registration of the drivers the pass restarts. The barrier waits
   * for exactly those — never for a batch's execution or a model's output —
   * because a driver it registers is parked (registered, so a cancellation
   * finds it, but not started) until the barrier completes. A store-read
   * failure, a workspace conflict or an exception in the pass fails the barrier
   * rather than surfacing as a warning over an unrecovered store, and a
   * cancellation or the unload invalidates the handle it leaves. Nothing here
   * is a second persisted state machine: the store remains the only source of
   * truth, the next explicit activation is the retry, and business execution
   * checks the handle through {@link recoveryStatus} instead of re-running the
   * pass.
   */
  adoptRoot(storeId: string, rootSessionId: string): Promise<RootAdoption>;
  /** {@link adoptRoot}'s own pass, as one barrier body: the adoption in the order it always ran. */
  private adoptRootThroughBarrier;
  /**
   * The gate initialization the recovery barrier owes every session the store
   * knows (A2 §E): one snapshot read taken *after* the pass, each run's phase
   * derived and applied under the gate's own token rule — the token is taken
   * before the read, so a decision that lands while it is in flight drops the
   * value it was about to apply. A run that predates phases leaves its session
   * ungated (A3's boundary: reading and cancelling are its only continuations),
   * and {@link gatePhaseFromStore}'s closing-store guard keeps a cancellation's
   * barrier ahead of this pass.
   *
   * This is the one place a restart's sessions get their phases back: the read
   * door (`lookupRun`) no longer writes the gate, so a query cannot be the
   * thing that recovers a store or re-gates a session. A store that cannot be
   * read here fails the barrier — half-gated is not recovered.
   */
  private initializeStoreGates;
  /**
   * What {@link adoptRoot} answers when the store still holds no root *after* its
   * recovery pass ran (A0 §3 stage B): the proposals that pass left open, by id and
   * status, and the fact that nothing was created.
   *
   * `adopted: false` is a normal answer (§1.1), and this detail is what keeps it an
   * honest one. Recovery never advances a waiting contract and never mints a root
   * without an accepted contract, so what a caller gets back is the state of the
   * intake rather than a verdict: the pass ran, a named proposal is still waiting
   * for a decision or a continuation, and adopting created no task, no run and no
   * proposal of its own.
   */
  private nothingAdoptedDetail;
  /**
   * The gate phase one stored run implies: its coordination phase while it is
   * running, `terminal` once it is not, and `undefined` for a record that
   * predates coordination phases (A3's own boundary — such a run is not gated,
   * and its only legal continuation is cancellation).
   *
   * The derivation every rebinding door performs ({@link adoptRoot} for a root
   * session, {@link gatePhaseFromStore} for any other): the gate is a handle on
   * the run's phase, and the phase is the store's fact, so a session this
   * process never held — or one whose phase moved under an in-flight call — is
   * gated as what its run is, never as what this process happens to remember.
   */
  private runGatePhase;
  /** Create the store, or open the one that already exists — the two ways a store can be there (A0 §1.1). */
  private openOrCreateStore;
  /**
   * One root contract intake, all the way through (A0 §1.3–§1.4): the proposal
   * is submitted, and — when it may run — activated in the same call. This is
   * the entry the root agent's `task_intake` tool and a direct service call
   * share, and there is no third one: an intake that stops at "the proposal was
   * recorded" is {@link submitRootContractProposal}, and the only thing that
   * turns a proposal into a root task is {@link continueProposal}.
   *
   * Under `off` the submission is born `ready` and the continuation runs
   * immediately, so the *same* call both records `policy-off` and activates — the
   * caller never has to ask twice for a contract that needs no review. Under
   * `all` the proposal is born `pending_review` and this call returns with no
   * task, no run, no spawn and no notification: nothing exists until a recorded
   * decision approves it. A contract that fails the machine rules is refused
   * with field-level reasons before a proposal exists at all.
   */
  intakeRootContract(storeId: string, rootSessionId: string, spec: RootContractSpec, options?: RootIntakeOptions): Promise<RootIntakeResult>;
  /**
   * One root contract proposal is submitted (A0 §1.2–§1.3): the pure pre-check,
   * the immutable record with the policy it was born under, and — under `all` —
   * the review request. Nothing is activated here, whatever the policy: no root
   * task, no run, no spawn, and no id minted except the proposal's own
   * content-derived one.
   *
   * The order is the same contract the batch path follows (§5: 坏提案不弹审批):
   * the presented contract is fixed and normalized, then judged — structural
   * rules, the root's independent-criterion rule, capability resolution and the
   * gap rule, the provider pre-check, the verifier ids — and a contract that
   * fails any of them is refused with field-level reasons *before* a proposal
   * exists, so nothing is shown to a person about a contract that could never
   * run. A contract that passes is recorded once behind its content-derived id,
   * carrying the contract itself, and a retry of the same request (same key,
   * same content) is answered from the record (`existing: true`) instead of
   * building a second proposal.
   */
  submitRootContractProposal(storeId: string, rootSessionId: string, spec: RootContractSpec, options?: RootIntakeOptions): Promise<ProposalSubmission>;
  /**
   * Admission and progress are two phases with two owners (A3 §3.1), and this
   * entry is the boundary between them — now with the review gate of §5–§6 in
   * front of it.
   *
   * **Submission**: the batch is pre-checked (protected-input fixing,
   * normalization, structural admission, capability admission, the provider
   * pre-check, verifierRef validation — all before any write) and recorded as
   * an immutable proposal carrying the policy it was born under, the limits in
   * force and the resolution it was reviewed against
   * ({@link submitDecompositionProposal}).
   *
   * **Continuation** (governed by `exec.signal` and the stored decision): the
   * batch is re-checked against what it was proposed under — the parent's state,
   * the limits, the capability resolution, the judging verifiers — and only then
   * admitted ({@link continueProposal}). Under policy `all` that re-check has an
   * approval behind it, or the batch waits; under `off` it runs immediately,
   * exactly as it did before T2.
   *
   * **Admission and the atomic commit**: one `admitBatchIn` records the
   * children, their admission, the dependency edges, the batch identity, the
   * parent's `active → waiting_children` phase change (§1.3) *and* the proposal
   * it consumed, in one commit — so "this proposal became these tasks" is one
   * durable fact a crash can be recovered from. The root budget must be able to
   * reserve one run per child (§3.5), and the caller's checkout must already be
   * held by this run or an ancestor of it (§3.4). Every refusal here is a
   * refusal whole: no id minted, no event written, no worker started.
   *
   * **Progress** (governed by the runtime): the batch is handed to a driver
   * registered under the runtime's own controller, and this call returns
   * `{ batchId, childTaskIds }` immediately. The caller's signal dies with the
   * commit; a tool call that returns, or a caller that aborts its own call,
   * cannot stop a batch the store already admitted (§3.7). {@link awaitBatch}
   * and the owner notification are how a caller learns how it went.
   *
   * This entry keeps its pre-T2 signature and its `off`-path behaviour (it
   * returns the batch), and it is the gate, not the tool layer, that answers a
   * batch under `all`: a direct call gets `{ status: 'pending_review' }` and no
   * batch, exactly as the `task_decompose` tool does. A batch that was decided
   * against between the two calls (rejected, cancelled, stale, expired) is
   * refused by name — the caller has to revise and propose again, which is what
   * the diagnostic says.
   */
  decomposeAndRun(storeId: string, parentTaskId: TaskId, parentRunId: RunId, callerSessionId: string, spec: DecomposeSpec, exec?: {
    signal?: AbortSignal;
    callId?: string;
  }): Promise<DecomposeAdmissionResult>;
  /**
   * One decomposition proposal is submitted (T2/T3 §5–§6): the pure pre-check,
   * the immutable record with the policy it was born under, and — under `all` —
   * the review request. Nothing is admitted here and no child id is minted,
   * whatever the policy: submission is the record of what was asked for, and
   * {@link continueProposal} is the only path that turns it into tasks.
   *
   * The order is the contract (§5: 坏提案不弹审批): an illegal batch is refused
   * — with field-level reasons, and with the capability gaps the existing
   * mechanism records as obligations — before a proposal exists and therefore
   * before anything can be shown to a person. A batch that passes is recorded
   * once: the id is derived from its content and the request key from its
   * calling context, so a retry of the same request answers with the stored
   * proposal (`existing: true`) instead of building a second one, a different
   * content under the same explicit key is refused by name, and a revision is
   * new content and a new key.
   *
   * The proposal carries the batch's content, not only its digest (§6), so what
   * a reviewer reads, what a decision binds and what a continuation admits are
   * one record — and an approval taken in one process is continuable in another
   * with nothing but the store.
   */
  submitDecompositionProposal(storeId: string, parentTaskId: TaskId, parentRunId: RunId, callerSessionId: string, spec: DecomposeSpec, options?: DecomposeProposalOptions): Promise<ProposalSubmission>;
  /**
   * One continuation (§6): the post-approval (and post-restart) re-check, and
   * the only place a proposal becomes what it asked for — a batch of tasks, or
   * (A0 §1.4) a root task with its run.
   *
   * The re-check is the whole point of an approval being a *record* rather than
   * a switch. Before anything is admitted, the subject's own state, the limits in
   * force, the capability resolution, the judging verifiers and the content are
   * recomputed and compared with the fingerprints the approval bound — content
   * whose context moved is marked `stale` with the difference named (§6: 不把旧批准
   * 转移给新上下文), and a parent run that ended — or a store that already holds a
   * root, for a root contract — takes the approval down with it (`expired`, never
   * a dispatch). Only a proposal that still is what was reviewed is admitted,
   * from `ready`, with its consumption in the same commit.
   *
   * Idempotent from the outside: an already-admitted proposal answers with what
   * its consumption recorded (no second batch, no second root, no second commit),
   * a waiting one answers `pending_review` without writing anything, and a
   * terminal one answers with the status the store holds.
   *
   * `options.spec` re-presents the batch a caller believes this proposal means.
   * It is only ever a *confirmation*: the re-presented batch is derived and
   * compared with the stored identity, and a different batch — or one whose
   * protected acceptance inputs no longer reproduce the fixed identity — is
   * refused by name. The batch that is admitted is always the stored one, which
   * is what the approval was made against. A root contract needs no such
   * re-presentation: its subject is the store and the session, not a parent whose
   * batch a caller could have confused.
   */
  continueProposal(storeId: string, proposalId: string, caller: string, options?: {
    spec?: DecomposeSpec;
    exec?: {
      callId?: string;
    };
  }): Promise<ProposalContinuation>;
  /**
   * One review decision is recorded (T2/T3 §6) — the trusted entry the approval
   * channel (stage C) and tests call, never a model tool with a decision
   * argument. Everything it writes is read from the stored proposal: the
   * dossier digest and both context fingerprints come from the record, so a
   * decision cannot name a different batch than the one it is about, and the
   * reducer refuses a claim that disagrees with what is stored.
   *
   * An approval whose parent run has ended is **not** recorded as an approval:
   * §6's rule is that a late approval may only invalidate the proposal, so the
   * entry records `expired` with the reason that made it late and dispatches
   * nothing. An approval that lands is continued immediately
   * ({@link continueProposal}) — and a continuation that could not be performed
   * is reported in the result rather than thrown away: the approval is on the
   * record either way, and the caller learns why the batch did not run.
   */
  decideProposal(storeId: string, proposalId: string, decision: {
    outcome: TaskProposalDecisionOutcome;
    reason?: string;
    decidedAt?: string;
  }, decidedBy: string, exec?: {
    callId?: string;
  }): Promise<ProposalDecisionResult>;
  /**
   * Why an approval arriving now is too late to be honoured, or `undefined` when
   * it is not. Two subjects, two questions: a decomposition batch is late when
   * its parent run has left the deciding phase ({@link parentRunEndedReason}),
   * and a root contract is late when the store already holds a root task — the
   * intake could no longer become that store's root, whatever the contract says.
   */
  private approvalLatenessReason;
  /**
   * One explicit withdrawal of a proposal (T2/T3 §6; root contracts A0 §1.3): a
   * `cancelled` decision, by the session the proposal belongs to — the run that
   * proposed a batch, or the root session a contract is the goal of. A withdrawal
   * from anywhere else — a deployment retiring a proposal, a reviewer refusing
   * one — goes through {@link decideProposal} with `cancelled` or `rejected`,
   * which records *who* decided instead of hiding it behind the caller's
   * identity.
   */
  cancelProposal(storeId: string, proposalId: string, caller: string): Promise<ProposalDecisionResult>;
  /**
   * The session a proposal belongs to: the caller whose run proposed a batch, or
   * the root session a root contract is the goal of. One reader for the two
   * owners, so "who may continue, decide or withdraw this" is answered once
   * rather than re-derived — with the wrong field — at each entry.
   */
  private proposalCallerOf;
  /**
   * The proposal one id names, as the store holds it (§6) — the read side a
   * tool renders. A proposal is addressed by `proposalId` and by nothing else:
   * there is no "is it approved?" question a caller can assert, and no approval
   * credential this entry would accept, because the answer is the stored record
   * or a refusal naming the id.
   */
  proposalIn(storeId: string, proposalId: string): Promise<TaskProposal>;
  /** Every proposal one parent task holds, in submission order — what a task's own view of its batches reads. */
  proposalsForParent(storeId: string, parentTaskId: TaskId): Promise<TaskProposal[]>;
  /**
   * The first half of the pure pre-check (T2/T3 §2): the caller's declared
   * batch becomes a normalized one — protected acceptance inputs fixed against
   * the caller's own checkout (S1-V slice 2), the one normalization entry over
   * them, and the content identity out.
   *
   * It writes nothing: no event, no obligation, no child id, no proposal. The
   * derivation is separate from {@link checkDerivedBatch} because the *request*
   * a caller presents is decided by this value alone — the digest is what a
   * request key is derived from and what the store is searched by — while the
   * batch's admission rules are asked only once it is clear that this is not
   * simply a request the store already answers (T3 §6 idempotency).
   *
   * Protected inputs are fixed here, not in normalization: by the time the
   * single entry reads the batch there is one form and one form only, and a
   * refused fixing joins the normalization refusal — same error, same no-op.
   */
  private deriveBatch;
  /** The manifests one normalized batch resolves to, in batch order — the same list the admission records per child. */
  private manifestsOf;
  /**
   * The batch one stored proposal holds, in the shape admission consumes (§6):
   * the contracts and declarations a reviewer read, the caller's reason from the
   * identity, and the limits and digest the proposal recorded. The store is the
   * source of truth — a proposal carries its content, not only its digest — so a
   * continuation, a review request and a recovery in a process that never
   * submitted the batch all render and re-check the same batch from the saved
   * facts.
   *
   * Rebuilding cannot smuggle other content in: the record's own reducer refused
   * a submission whose {@link TaskProposalChild} entries disagree with the
   * identity (same order, same contract digests, same declarations), and the
   * continuation re-derives the identity from this batch and compares the digest
   * with the stored one before anything is admitted.
   */
  private storedBatchOf;
  /**
   * The run protocol one decomposition has to satisfy before anything is
   * proposed: the run belongs to this task, it is bound to this caller, it is
   * `active`, it is not waiting on an unresolved blocking question, and the call
   * was not already cancelled. Unknown and non-`active` phases are refusals
   * rather than guesses, and a phase-less run is an old record whose only legal
   * continuation is cancellation.
   *
   * **`active` is the batch gate (K1 §1).** A run holds at most one unfinished
   * batch, and an admitted batch moves it `active → waiting_children` in the same
   * commit that creates the children, so "this run is `active`" is the whole of
   * "this run has no unfinished batch" — no second count of batches is kept, and
   * a second batch may be proposed exactly when the first one has ended and the
   * run is active again.
   *
   * **A blocking question is the run's own wait (K1 §1).** A run that asked its
   * parent something unresolved is parked where the protocol put it, and
   * delegating from there would start writers beside a wait that has not ended.
   * The fact is read from the store's question records rather than from the
   * gate's in-memory flag, because admission has to answer the same way in a
   * process that never delivered the question.
   *
   * These checks are asked *after* a request the store already answers has been
   * answered from the record: a retry of a request the run has already proposed
   * is that proposal, whatever state the run is in now (T3 §6 — the same request
   * never builds a second batch), while a genuinely new batch may only be
   * proposed by a run that is still deciding its own work.
   */
  private assertDecomposableRun;
  /**
   * The tasks this run has already asked a person about — its `pending_review`
   * and `approved`/`ready` decomposition proposals that are neither consumed nor
   * terminal (K1 §1: at most one proposal in flight per run).
   *
   * The question is asked of the run, not the task: a parent that ended one batch
   * and proposed another is a different run state from the run that proposed the
   * first, and the store's proposal records are where "in flight" is defined —
   * `admitted` is a consumption, and rejected/cancelled/stale/expired are
   * terminal, so neither holds the run.
   */
  private inFlightProposalsOf;
  /**
   * The second half of the pure pre-check (§2): the batch's own admission rules
   * over a derived batch — structural admission (`contractDefects`,
   * `independentAcceptanceDefects`, the growth guardrails, dependency
   * acyclicity), capability resolution and the gap rule, the provider
   * pre-check, and verifierRef validation.
   *
   * Pure and reusable: this is exactly what the post-approval re-check asks
   * again (§6), and it answers with a value ({@link DecompositionRefusal}) so
   * the caller decides whether a refusal is a refusal or an invalidation.
   */
  private checkDerivedBatch;
  /**
   * The admission half of one batch that passed the pre-check (T2/T3 §6): the
   * protocol's own commitments, made only now — the root budget reserves one run
   * per child (§3.5), the caller's checkout must be this run's or an ancestor's
   * (§3.4), the child ids are minted, and one `admitBatchIn` commit records the
   * children, their admission, the dependency edges, the batch identity, the
   * parent's `active → waiting_children` phase change and the proposal
   * consumption together (§1.3). The driver is started last, so progress belongs
   * to the runtime before the caller hears anything.
   *
   * The proposal is what makes this half addressable: its consumption names the
   * very children this commit creates, so "the proposal was consumed and these
   * are its tasks" is one durable fact — the record a recovery reads instead of
   * admitting a second batch.
   *
   * A refusal here is a refusal whole (nothing is minted or committed), and it
   * leaves the proposal where it was: `ready` under policy `off`, or `approved`
   * for a batch that was approved and could not be started yet. Nothing is spent
   * by a budget that says no, and a later continuation retries the same batch.
   */
  private admitPrecheckedBatch;
  /**
   * The request key one root intake is addressed by: the caller's own when it has
   * one, otherwise derived from the store, the root session and the contract's
   * digest (`proposal.ts:rootProposalRequestKey`). The same derivation in both
   * the submission and the re-check, so "the request the store already answers"
   * is one question with one answer.
   */
  private rootRequestKey;
  /** The root proposal one request key already names, or `undefined` when the key is free; other content under the key is refused by name (§6). */
  private rootProposalForRequest;
  /**
   * One root contract's origin, established before anything is read or written on
   * its behalf (A0 §1.10): the store must be the root session's own
   * (`rootTaskStoreId`), that session must be a top-level one — a delegated child
   * is a worker, and its task was admitted by its parent — and its own durable log
   * must hold the person's request: a `user/message` event whose
   * `source.kind === 'user'`, the kind DSH reserves for host-attested human input
   * (`tool-goal/src/authority.ts:hasDirectHumanInput`).
   *
   * **Why the check is fail-closed.** The rules are mechanical and each is
   * answered by a refusal rather than by a default: the store↔session mapping is
   * arithmetic, the delegation facts are the header the spawn stamped, and the
   * request half is *existence* — at least one message whose source is the person.
   * Everything else that reaches a session's log is attributed to its **producer**:
   * this deployment writes its own prompts under `runtime-prompt` (the graph setup
   * text and a spawn's delegated task, `agent-runtime`'s own source) and its notices
   * under `plugin` (`notify`), and neither counts — a session that only ever heard
   * from the deployment has no request to attribute a contract to, and treating the
   * model's summary of a conversation as the request is exactly the "model
   * self-reported confirmation" §1.10 forbids. A log this deployment cannot read is
   * refused for the same reason — "the source could not be checked" is not "the
   * source is the person". Deliberately absent: any natural-language entailment.
   * Whether the contract *states* the request well is the model's reasoning and the
   * §1.2 rules judge the contract itself; this rule only tests that a request of
   * the person's own is there.
   *
   * **Where each half belongs.** Which session may call `task_intake` — graph and
   * root-session membership — is the tool's own rule, because the `graphs` record
   * is the thing that knows it. What this check owns is the quadruple a caller can
   * hand in wrongly: the store, the session, the session's kind and its origin
   * (store ↔ session ↔ top-level ↔ origin), so both doors into a root — the tool's
   * call and a direct service call — meet the same rule wherever a caller reaches
   * the service from. A *top-level* session that no graph owns is deliberately not
   * distinguished here: that is membership, the model-facing door and its tool rule
   * own it, and a direct service caller is this deployment's own trusted code.
   *
   * **Zero side effects.** This is two reads (an id derivation and a log opened
   * `read` and closed), so a refusal here leaves no store opened, no proposal, no
   * task, no run, no worker and no notice — which is why both entries that could
   * create a root call it before their first write.
   */
  private assertRootContractOrigin;
  /**
   * One root session's own durable log and header, read through
   * `sessionPersistence` in one open/read/close — the surface a session's requests
   * are recorded on, and the record of what kind of session it is — or a named
   * refusal when this deployment cannot read it: no persistence service is
   * mounted, the session is missing, or the open/read throws. The refusal is the
   * answer rather than an empty log, because the rule it feeds is fail-closed
   * ({@link assertRootContractOrigin}): an unreadable log is "the origin is not
   * established", never "assume there is one". The header is handed back as the
   * handle exposes it — a backend that models only the log answers `undefined`,
   * which is read as "no delegation facts recorded" rather than as delegation.
   */
  private rootSessionLog;
  /**
   * The one refusal text a root contract whose origin could not be established is
   * refused with, whichever rule (or which unreadable log) said so. It is a
   * family of its own rather than {@link rootRefusal}'s: "the contract was judged
   * and found wanting" and "the request behind it is not established" are
   * different facts about a call, and a caller that revises a contract must not
   * confuse the second for the first.
   */
  private originRefusal;
  /**
   * One root submission, inside the store's root-intake serialization: the
   * contract is fixed and normalized, a request the store already answers is
   * answered from the record, everything else is judged, and the record is
   * written once.
   *
   * The order is the batch path's, for the same reasons: §5's 坏提案不弹审批
   * needs the judgement *before* the record, and T3 §6's idempotency needs the
   * record lookup *before* the judgement — a retry of a request the store
   * already answers is that proposal whatever state the store has moved to since.
   *
   * Ahead of all of it is one rule that is not about the contract at all: the
   * origin of the request it states (§1.10), checked before the store is even
   * opened ({@link assertRootContractOrigin}).
   */
  private submitRootProposalOnce;
  /**
   * The first half of the root pre-check: the declared contract's protected
   * acceptance inputs are fixed against the root session's checkout (S1-V slice
   * 2 — a path that cannot be read, or a session whose checkout cannot be
   * resolved, refuses the whole contract), and the single root normalization
   * entry reads the result. Writes nothing.
   */
  private deriveRootContract;
  /** The one refusal text a root contract is rejected at the contract stage with, whichever step produced the reasons. */
  private rootRefusal;
  /** The manifests one root contract resolves to, from its declared capabilities — the list the activation records. */
  private rootManifests;
  /** The store's root task, if it has one, read from the store rather than remembered. */
  private existingRootTask;
  /**
   * The second half of the root pre-check (A0 §3): every rule a root contract
   * has to clear before it can be proposed — structural (`contractDefects`), the
   * independent-criterion rule that makes it a *goal* rather than a restatement
   * of its own decomposition ({@link rootIndependenceDefects}), the capability
   * resolution with the gap rule, the provider pre-check from the root session's
   * own viewpoint, and the verifier ids its criteria pin.
   *
   * The gap rule differs from a batch child's by design: a child that is missing
   * a capability and may decompose is admitted with the gap recorded as an
   * obligation (its parent delegated the gap down), while a root intake has
   * nobody above it to delegate to and nothing to record the gap *on* — the task
   * does not exist yet — so a declared capability this deployment cannot grant is
   * a named refusal. Zero side effects: no obligation, no task, no run, and no
   * file written (the protected inputs were read, never rewritten).
   *
   * Pure and reusable: this is what the post-approval re-check asks again, so a
   * contract whose resolution moved is judged by the same rules that judged it at
   * submission.
   */
  private checkRootContract;
  /**
   * One root continuation: the re-check ladder, and — if it passes — the
   * activation. §1.4's rule is that a root contract becomes a task *only* here
   * and only after the approval's own context is re-confirmed.
   *
   * The ladder, in the order the facts become decisive:
   *
   * 1. the origin of the request the contract states (§1.10,
   *    {@link assertRootContractOrigin}) — a store that is not the session's own, a
   *    session that is a delegated child, or a session whose own log holds no
   *    request of the person's, cannot carry a root at all, and this is decided
   *    before the ladder's first write;
   * 2. the store's root task — a store that already holds one refuses every
   *    further root intake. If the root on record is the one *this* proposal
   *    consumed, the proposal is already admitted and the status ladder above has
   *    answered; anything else is another root (a goal change is a new graph),
   *    and this proposal can never become one, so it is `expired` by name;
   * 3. the limits in force, against the fingerprint the approval bound — a
   *    deployment that moved them after the review invalidates it (§6);
   * 4. the resolution this contract was reviewed against — its declared
   *    capabilities, the providers behind them and the verifiers its criteria
   *    pin — recomputed and compared, with the difference named.
   *
   * Only then does it activate, and the activation is one atomic commit
   * ({@link activateRootContract}) followed by this process's own binding, so a
   * crash between the two is recovered by re-running this ladder: the consumption
   * on record is what makes the second run an answer rather than a second root.
   */
  private continueRootProposalIn;
  /**
   * The activation (A0 §1.4): one atomic commit creates the root task (parentless,
   * depth 0, carrying the approved contract), its run (born `active`, in the
   * proposal's root session) and the proposal's consumption — and then this
   * process binds what only a process can hold.
   *
   * The order, and why each step is where it is:
   *
   * 1. **the checkout is claimed before anything is written.** A workspace another
   *    live owner holds fails the activation with nothing persisted
   *    ({@link WorkspaceBusyError}, §3.4), which is the same claim-before-write
   *    order every run creation follows; a claim this call made and then lost the
   *    commit for is released, so a refused activation leaves no ownership of a
   *    root that does not exist;
   * 2. **the run's content binding is materialized** (S1-C) — the same builder
   *    every run uses, so a root that grants nothing still gets the honest empty
   *    record rather than no record at all;
   * 3. **the commit** (`admitRootProposalIn`) writes the task, the admission, the
   *    capability manifest, the run and the consumption together. The reducer
   *    refuses a store that already has a root, a consumption naming other
   *    content, and a run that is not born active in this session — so a racing
   *    second activation writes nothing;
   * 4. **the in-process binding**: the session map, the started-session set and
   *    the gate, which is what makes the root session's own tools — decompose,
   *    submit, cancel — legal from here on;
   * 5. **the notification** (best-effort, through the existing owner notice): a
   *    root session that was waiting for its intake hears that its contract is
   *    live. It is a notice, never a wake-up obligation: a session with no live
   *    agent is skipped, and nothing about the activation depends on it.
   *
   * Idempotent from the outside by construction: the ladder in
   * {@link continueRootProposalIn} answers an admitted proposal from its own
   * consumption, and the reducer refuses a second activation even if two callers
   * raced past that read. One accepted fact, one root.
   */
  private activateRootContract;
  /** One root submission's answer, in one sentence: the policy it was born under, the status it holds, and what the caller owes next. */
  private rootSubmissionDetail;
  /**
   * One store's root intakes, one at a time. The batch path serializes per
   * parent (§6's "单进程同一父分解…应串行"); a root contract has no parent, so the
   * subject that has to be serialized is the store itself — two intakes racing
   * into one store must not both read "no root task yet" and both commit. The
   * store's own reducer is the second line of defence (a store that already
   * holds a root refuses the second activation), and a second *process* is
   * covered by it alone, never by this map.
   */
  private serializeRootIntake;
  /**
   * One submission, inside the parent's serialization: derivation, idempotency,
   * the run protocol, the batch's admission rules, the record, and — under
   * `all` — the review request. The order is the contract:
   *
   * 1. the presented batch is derived (protected inputs fixed, one
   *    normalization), and an illegal batch is refused here, field by field,
   *    *before* a proposal exists — §5's 坏提案不弹审批, and the capability gaps
   *    of such a refusal are recorded as obligations by the same mechanism the
   *    admission chain always used, because the derivation and the batch
   *    judgement write nothing;
   * 2. a request the store already answers (the same key and the same content)
   *    is answered from the record — `existing: true`, the stored status, and,
   *    for a proposal that is still waiting, the review requested again, because
   *    a caller asking again is evidence that somebody is still waiting. This
   *    comes *before* the run protocol, so a retry of a request the run has
   *    already proposed is that proposal whatever state the run is in now;
   * 3. a genuinely new batch takes the run protocol (only a run that may still
   *    decide its own work may propose one) and every admission rule, then the
   *    record is written once behind a content-derived id — carrying the batch
   *    content itself, so the review, the decision and a later continuation all
   *    rest on the same stored facts.
   */
  private submitProposalOnce;
  /**
   * One continuation, inside the subject's serialization (§6's "单进程串行"): the
   * state ladder first, then the re-check, then — only if the proposal still is
   * what was reviewed — admission (a batch) or activation (a root contract).
   *
   * The ladder answers without writing wherever the answer is already on the
   * record: a consumed proposal answers with its own consumption (so a duplicate
   * continuation cannot build a second batch or a second root), a waiting one
   * answers `pending_review`, and a terminal one answers with the status the
   * store holds. The re-check then resolves the four ways §6 describes — the
   * subject already has what this proposal wanted (`stale` for a decomposed
   * parent, `expired` for a store that holds another root), the parent run ended
   * or the store's root appeared (`expired`), the context moved (`stale`, with
   * the difference named), or the proposal still is what was reviewed
   * (`approved → ready` and admit/activate).
   */
  private continueProposalIn;
  /**
   * Invalidate one proposal whose context moved (§6), and remember that on the
   * record: `stale` is terminal, it needs its reason, and it is a statement
   * about the proposal rather than a deletion of it — the record and its approval
   * stay readable, and a revision is new content under a new key.
   */
  private staleProposal;
  /**
   * Invalidate one proposal the subject can no longer dispatch (§6: a late
   * approval may only invalidate) — a batch whose parent run ended, a root
   * contract whose store already holds a root. The write is a *decision* —
   * `expired` is one of the four outcomes the store records with a decider and a
   * reason — and the decider is named `task-runtime`, because this invalidation
   * is the runtime's own reading of the store's state rather than a person's
   * decision.
   */
  private expireProposal;
  /**
   * Why the parent run can no longer host a batch, or `undefined` when it can —
   * the question {@link approvalLatenessReason} asks (a late approval
   * may only invalidate, §6). Three states, each named by what it means rather
   * than by the field: the run is no longer running (cancelled, failed,
   * verified), it predates the coordination phases (an old record whose only
   * legal continuation is cancellation), or it has left the deciding phase by
   * submitting its own result. A run that *is* waiting on an unfinished batch is
   * not answered here either: that is a run which may hold another batch later
   * (K1 §1), and {@link continueProposalIn}'s own re-check is where the batch a
   * proposal competes with is judged.
   */
  private parentRunEndedReason;
  /** The proposal a request key already names, or `undefined` when the key is free; a key bound to other content is a refusal by name (§6). */
  private proposalForRequest;
  /** The proposal one id names, or a refusal naming the id — the read every public entry starts from. */
  private requireProposal;
  /**
   * The proposal one id names, or `undefined`. The index is optional at the type
   * level (snapshots built by hand predate proposals), and an index this reader
   * cannot see is answered as "not this store's proposal" rather than guessed
   * at.
   */
  private readProposal;
  /**
   * One submission's answer, in one sentence: the policy it was born under, the
   * status it holds, and what the caller owes next. A re-answer says so, because
   * "the proposal you sent before is still the one this request means" is a
   * different fact from "a new proposal was written".
   */
  private submissionDetail;
  /**
   * Ask the deployment's review channel about one waiting proposal (§5–§6).
   * A channel is optional and its answer is only ever a notice: absent, it
   * answers "nobody was asked" and the proposal stays `pending_review`; present,
   * it may ask a person and report what it did; a channel that throws is warned
   * about and reported, never swallowed — and none of those outcomes can turn
   * into an approval, because the only thing that advances a waiting proposal is
   * a persisted decision.
   *
   * What the request carries is the subject as the store holds it: for a batch the
   * parent task, the children and the obligations raised on that parent; for a
   * root contract the contract itself and no parent — the task it would become
   * does not exist while it waits, so there is nothing to read obligations off
   * and nothing to pretend. Every arm is built here from stored facts, so a
   * review requested after a restart shows what the record holds.
   */
  private requestProposalReview;
  /**
   * Raise the obligations a capability-gap refusal owes, then raise the refusal
   * itself: one obligation per missing capability, on the parent, with the
   * wording the admission chain has always used (KISS §7 — a gap is a normal
   * state with a record, not a silence). The pre-check wrote nothing, so this is
   * the only place the *fact* of the gap is recorded, and it happens before the
   * batch is refused — never twice, because a refused batch has no proposal to
   * re-refuse.
   */
  private refusePrecheck;
  /**
   * One parent's proposal operations, one at a time (§6: "单进程同一父分解的
   * 重检、提案消费及子任务绑定应串行"). What this buys: two approved proposals
   * competing for the same parent can only ever admit one batch — the loser's
   * continuation reads the parent's state *after* the winner's commit, sees it
   * decomposed, and is marked stale by name. The chain is this process's own, per
   * store and parent; a second process is covered by the store's own refusals
   * (a decomposed parent, a duplicate proposal id, a consumed proposal), never
   * by this map.
   */
  private serializeParent;
  /**
   * The proposal pass of recovery (T3 §5), run at the end of
   * {@link reconcileStore} — after the runs, so a batch this pass admits is
   * either picked up by the run pass or driven by the driver this pass starts,
   * and after the workspace adoption, so an admission is not attempted into a
   * checkout somebody else holds.
   *
   * Per proposal, and in one sentence each: a proposal waiting for a review is
   * *never* advanced by recovery — only a persisted decision moves it (§6) —
   * and its review is requested again when this process can show the batch; a
   * proposal that is `ready` or `approved` is continued (which is where §5's
   * tightening reaches a batch that was born under `off` and the post-approval
   * re-check decides whether the approval still covers the batch); everything
   * terminal is left alone, including `admitted`, whose batch the run pass has
   * already dealt with.
   *
   * Anything this pass could not finish is returned and warned about — never
   * guessed at. An approval that survives a restart is continued from the store
   * alone, because a proposal carries the batch it is about; a review request is
   * re-sent with the same saved facts (the parent, the children's contracts, the
   * resolution), so what a person is asked to review after a crash is what the
   * record holds rather than whatever a live process happened to remember.
   */
  private reconcileProposals;
  /**
   * One root contract's turn in the proposal pass (A0 §5): the same discipline as
   * a batch's, with the subjects a root contract has instead of a parent task.
   *
   * A `pending_review` root contract is never advanced by recovery — only a
   * persisted decision moves it — and its review is requested again from the
   * stored contract when this process can still show it; a contract whose
   * resolution no longer passes admission is reported and left waiting, exactly
   * as a batch is. A `ready`/`approved` one is continued, which is where §5's
   * tightening reaches a contract born under `off` and where the post-approval
   * re-check decides whether an approval still covers it.
   *
   * The crash points this covers, both of them one call away from a root that
   * exists:
   *
   * - **the decision is on the record and the activation never ran** — the
   *   continuation re-checks and activates, and the store's own reducer is what
   *   keeps it to one root;
   * - **the activation commit landed and this process died before it bound the
   *   session** — the status ladder answers `activated` from the consumption
   *   itself, so recovery re-binds rather than minting a second task and run
   *   ({@link adoptRoot} is that re-binding's other door, for a process that
   *   starts from a graph entry instead).
   *
   * Ahead of both arms is the origin rule (§1.10,
   * {@link assertRootContractOrigin}): a record whose request cannot be
   * established is not something to ask a person about — a decision on it could
   * never activate anything, because the ladder refuses the same fact at
   * activation — and it is not something to continue either. The refusal travels
   * out of this call so the proposal pass reports it unresolved by name.
   *
   * **The boundary this check does not cross.** {@link decideProposal} is left
   * exactly as it was: a person's decision on a record that exists is a
   * record-level fact, and it is written whether or not the contract could ever
   * activate — the activation it would cause is the thing that is refused, here
   * and at every other door into a root. Recovery's pass is not a decision, so it
   * is the one place where "do not ask" can be honoured.
   */
  private reconcileRootProposal;
  /**
   * Bind a root this process just learned is activated — the crash case where the
   * commit is durable and the session of the process that wrote it is gone. The
   * store is the source of truth for the ids *and* for the phase: a root run that
   * already reached a terminal state leaves the session `terminal` rather than
   * open, so a late intake is refused by the gate as well as by the one-root rule
   * (§1.8), and only a still-running root is bound `active`.
   */
  private rebindActivatedRoot;
  /**
   * Replay one historical terminal task under a candidate overlay (guide
   * §2.7.6, W15; the only consumer is `evolution_replay`). The replayed task is
   * created parentless — the historical tree is never edited by a comparison
   * experiment — with the lineage tag on its objective, and settles through the
   * real spawn + verify chain (or the verifier alone when `spawn: false`).
   *
   * The champion's contract (objective / criteria / capabilities) is mirrored
   * unless `options.contract` replaces it (the task_definition deterministic
   * criteria replay). Capability resolution runs against the configured table
   * with `overlay.capabilityOverrides` applied as whole-row replacements; a gap
   * under the overlay refuses the replay before anything is persisted.
   *
   * The replayed task carries a normalized contract like every other creation
   * (T1), and its criteria are judged by the same structural rules an ordinary
   * decomposition child faces (`contractDefects` plus the P4 declarations).
   * Protected acceptance inputs are fixed here too (S1-V slice 2), against the
   * checkout the replay runs in — the caller's own, or the workspace the caller
   * named (`options.workspace`, S4-E): a candidate contract declaring paths has
   * their identity fixed before anything else reads it, while a champion's stored
   * `{ path, sha256 }` refs are carried verbatim — the historical identity is
   * what the pre-judgement re-check compares against, so it is never re-read
   * from disk and never invented. A replay has no batch, so it records no
   * admission context: nothing was proposed to a parent, there is no sibling
   * set to bound, and the limits that do apply to its run are the run's own
   * budget, not a batch's.
   *
   * A caller that names a workspace gets one isolated replay in a directory of
   * its own: the path is resolved and claimed before anything persists, so an
   * unusable or already-held directory refuses the replay with nothing written,
   * and every directory the run resolves against — the pre-check, the protected
   * inputs, the worker and its children, the verifier — is that one.
   *
   * The execution the comparison rests on is the caller's to freeze (S4-E §Q3):
   * `options.agentOptions` is the model selection this run's worker and its
   * sub-execution are created under, forwarded verbatim to the orchestration —
   * this entry does not resolve the model, because what a run really ran under is
   * the caller's frozen fact, and the runtime's job is to make it true. The run's
   * clock is this runtime's own (the per-run `Config.budget.wallTimeMs` and the
   * root tree's deadline); a replay places no separate one. The options are a
   * closed set: a key this build does not read — the deleted experiment clock
   * above all — refuses the replay by name here, before anything else runs.
   */
  replayTask(storeId: string, championTaskId: TaskId, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>;
  /**
   * Register one runtime-owned driver (a batch, or a replay) and return at
   * once: the caller's tool call is over, and the work is the runtime's (§3.7).
   *
   * The registered promise is meant never to reject — a driver settles its own
   * failures by failing the run it reports on — so a rejection here is the one
   * failure it could not settle from where it stood: the view of the deployment
   * it was about to build (`orchestrateEnv`). That is still not fire-and-forget
   * (§3.1): the batch's parent run is failed with the cause, the children that
   * never started are blocked, and the owner is told. The belt below stays for a
   * rejection for a key that names no batch (a replay, whose own caller already
   * receives the error), so nothing surfaces as an unhandled rejection.
   */
  private registerDriver;
  /**
   * Abort and remove the drivers a barrier registered but never released to
   * start (A2 §E). Not-started is not executed: no body runs, nothing is
   * written on the batch's behalf, and the persistent record — which still
   * says the parent waits on its children — is what the next explicit
   * activation re-registers from.
   */
  private standDownPendingDrivers;
  /**
   * A cancellation or the unload invalidates a store's recovery handle (A2
   * §E): a barrier still in flight finishes its own pass but leaves no ready
   * handle and stands its not-yet-started drivers down; a settled handle is
   * dropped. The store's persistent record is untouched — the next explicit
   * activation (`adoptRoot`, through `graphs`' activate) is the retry.
   */
  private invalidateStoreRecovery;
  /**
   * Fail one batch's parent run without an `OrchestrateEnv`: the children that
   * never started are blocked, the parent run is failed with the cause, and the
   * owner is told. Store-level on purpose — the caller is here because the env
   * could not be built, so this path holds the settlement's own narrow
   * capabilities ({@link TaskRuntime.settlementParts}) instead of building one —
   * and it never throws, so a driver's failure cannot become an unhandled
   * rejection of its own. `outcome` is `'cancelled'` only for a batch whose
   * driver never started (a recovery barrier stood it down when the cancellation
   * aborted it): the same writes a started driver's abort branch makes, from the
   * one place that can still make them.
   *
   * The two writes are the orchestration's own (A4-5): `blockUnstartedChildren`
   * and `settleRunFromRuntime`, the same pair every other batch failure uses —
   * there is no second terminal-record writer here.
   */
  private failBatchFromRuntime;
  /**
   * The batch one id names, as the store itself records it: the run whose
   * **accumulated batches** hold it, together with the parent task that run works
   * on. `undefined` when no run of the store records the id that way.
   *
   * The accumulation is the record, not the run's current `batchId`: a batch a
   * build before K1 admitted wrote only `b-<parentTaskId>` onto the run, with no
   * proposal and no members, so a run that *waits* on an id its accumulation does
   * not hold is exactly the stopped old state the persistence decision names. This
   * read answers `undefined` for it rather than handing a caller the task's
   * children — the members of a batch nobody can name are not the batch's members —
   * and a settlement path that cannot name a batch reports instead of guessing.
   */
  private batchRecordIn;
  /**
   * Whether one run's own accumulation holds the batch it waits on — the binding a
   * restart needs before it drives a batch (K1 §5).
   *
   * A batch is identified by the pair (parent run, proposal), and the run that
   * admitted it is the only record that can say which members belong to it. A
   * `waiting_children` run whose `batches` holds no such entry carries a batch from
   * before batches were identified that way: nothing in the store says which run,
   * which proposal, or which members a second batch of that parent would have.
   */
  private batchHeldByRun;
  /**
   * Stop a `waiting_children` run whose batch this build cannot name (K1 §5, and
   * the persistence decision that fixes it: an in-flight batch admitted before
   * `(parentRunId, proposalId)` identified one is a **stopped old state**).
   *
   * The stop is by name and by nothing else: the run is settled `cancelled` with
   * the fact recorded — no driver is registered, no child is started, and no batch
   * is attributed to a run or a proposal the store does not name. The children the
   * old admission created are left exactly as they are: which of them belonged to
   * that batch is the very thing this build cannot read, so blocking them would be
   * the guess this stop exists to avoid. The run's Session is reconciled like any
   * other settlement's, and the warn is the operator's half of the refusal.
   */
  private stopUnidentifiedBatch;
  /**
   * The narrow capabilities one runtime-level settlement holds — the store, the
   * actor, the notification seam and the gate/workspace bookkeeping — for the one
   * path that writes a terminal state without an orchestration env
   * ({@link failBatchFromRuntime}): the caller is there precisely because this
   * deployment's own view could not be built, so this holds the services that
   * cannot fail for that reason and nothing else. The checkout registry is
   * deliberately not among them: resolving a workspace path here would guess at
   * the very environment whose construction failed, and a marker left for the
   * explicit activation to reconcile is honest where a guessed release is not.
   * Every other batch failure goes through the driver's own env, which carries
   * the registry and releases the layer.
   */
  private settlementParts;
  /**
   * What the runtime does when *any* run reaches a terminal state (A3 §3.3): the
   * gate closes for the session that held it, the questions addressed to it stop
   * blocking the runs that asked ({@link recomputeAskingSessions}), and the
   * workspace layer the run claimed comes off the stack. One implementation for
   * the orchestration's settlements and the runtime's own, so a run settled from
   * either side leaves the process in the same state.
   *
   * A run whose session this process never bound is settled like any other: its
   * own gate has nothing to close here, but the runs that asked it are recomputed
   * all the same, because the wait that ended is theirs.
   */
  private runSettledFromRuntime;
  /**
   * Recompute the question block of every run that asked the run just settled
   * (A4 §F.1), from the store, here.
   *
   * This is the orchestration side of the same step `settleRunFromRuntime` takes
   * where its caller awaits it: the two settlements — the driver's own
   * (`settleChildRun`, `finishBatch`, `settleSubmittedRun`) and the
   * runtime-level entry — must not differ in what the gate shows afterwards, and
   * both derive the value the same way. The read is reported rather than
   * propagated: the run is settled and its record written by now, and a store
   * this process cannot read back is a failure of the *release*, not of the
   * settlement — the next recovery recomputes the same blocks.
   */
  private recomputeAskingSessions;
  /**
   * Report the question deliveries one recovery pass could not settle (A4 §F.1)
   * — `refused` (the body could not be read back from its own citation, or the
   * relay refused) and `unavailable` (the target Session is not live in this
   * process) — as one warning, because the pass's own report is not enough: the
   * explicit adoption drops it, and an undelivered question nobody is told about
   * is a wait whose only remaining ends are a restart and a wall time.
   *
   * Nothing here changes the control flow: the intents stay on the Task record,
   * the next activation retries them, and a delivery that settled is not reported
   * at all. The line names the store, how many of how many intents are still
   * owed, the count per status, and each affected fact with its own refusal.
   */
  private reportUnsettledQuestionDeliveries;
  /**
   * Start the driver for one admitted batch. The controller is registered
   * before the driver runs, so a cancellation arriving immediately after
   * admission finds something to abort.
   *
   * When the registration happens *inside* a recovery barrier (A2 §E) the
   * driver is parked after registering: the barrier waits for the
   * registration — reconciliation, gates and drivers are what an activation
   * owes — never for the body, so a `waiting_children` parent recovered inside
   * a graph activation cannot lock that activation on its own batch. The
   * barrier's completion releases the body; its failure or a cancellation
   * stands it down unstarted, and an abort that lands while it is parked
   * resolves it without a spawn.
   */
  private startBatchDriver;
  /**
   * The explicit submission (A3 §3.2, `task_submit_result`): the worker's own
   * account of what it delivered, recorded as the phase change that closes
   * admission, and then the one settlement path every verified run takes.
   *
   * A submission that arrives twice is answered from the record rather than
   * applied again — the phase event is unique by construction, so the second
   * caller reads the first one's result. A run waiting on its children may not
   * submit at all: its batch has to end first (K1 §2), and the batch end hands
   * the run back `active` — only then, with the workspace back and the children's
   * outcomes in the store, may the parent hand in the result that starts its own
   * acceptance.
   */
  submitResult(callerSessionId: string, spec: {
    summary: string;
    evidenceRefs?: string[];
    notes?: string;
  }, exec?: {
    callId?: string;
  }): Promise<{
    status: string;
    detail: string;
  }>;
  /**
   * Ask one's direct parent (A4 §F.1, `task_ask_parent`): the runtime entry the
   * tool layer adapts.
   *
   * The identity is the caller's own — a live session, its run binding, and the
   * parent the store derives from that run's task — and the body is read back
   * from the caller's own Session before the store records anything, so a forged
   * call id, another session's citation or a claim the message does not support
   * is refused by name with no task event and no delivery. Everything after the
   * commit (the write-gate block, the message under the *recorded* id) is owned
   * by `./question.ts`; `unavailable` there is not a failure — the intent is
   * durable, the record is returned, and recovery re-delivers.
   */
  askParentQuestion(callerSessionId: string, request: ParentAskCall): Promise<AskedQuestionOutcome>;
  /**
   * Answer one child's still-open question (A4 §F.1, `task_answer`): the same
   * shape as {@link askParentQuestion}, with the answering run taken from the
   * caller's binding and the delivery addressed to the run that asked. A
   * resolving answer recomputes the *asking* run's block from the store, so a
   * second open question keeps it blocked.
   */
  answerParentQuestion(callerSessionId: string, request: ParentAnswerCall): Promise<AnsweredQuestionOutcome>;
  /**
   * The identity every question call starts from: the live caller session, its
   * run binding, and the store that binding names. A session with no run (a root
   * before activation, a reviewer, a helper) has nobody to ask and nothing to
   * answer, and is refused here before any other step.
   */
  private questionCaller;
  /** The services question coordination reaches: the store's entries, the session read path, agent-runtime's handle, and the gate. */
  private questionCoordination;
  /**
   * Cancel one batch (`task_cancel`, §3.6): abort its driver, which settles the
   * children — the one in flight is cancelled, the ones that never started are
   * blocked before start, and the parent run is cancelled — and return that
   * settlement.
   *
   * The batch is located by the **caller's own run**, never by parsing the id: a
   * batch id names a pair (`b-<parentRunId>-<proposalId>`, {@link batchIdFor}),
   * and a parent that admitted more than one batch has one id per batch. The
   * caller's run is the fact this entry is authorized by, and its *current*
   * unfinished batch (`run.batchId`) is the only batch that can be cancelled —
   * a batch this run already ended is not in flight any more.
   *
   * Only the batch's own parent session may cancel it, and only while the batch
   * is in flight. A batch this process is not driving (already settled, or
   * waiting for recovery after a restart) is refused by name: silently
   * synthesising a settlement would write terminal states the store's own
   * records do not support, and the graph-level cancellation is the entry that
   * covers that case.
   */
  cancelBatch(storeId: string, batchId: string, callerSessionId: string): Promise<ChildOutcome[]>;
  /**
   * Settle every run below `taskId` that is still in flight as cancelled — the
   * runs this cancellation owns. The batch's own parent run is not settled here:
   * its driver's abort branch does that, with the batch's terminal review and the
   * owner notification.
   */
  private settleCancelledDescendants;
  /**
   * Abort every batch driver of `storeId` whose parent task is a strict
   * descendant of `taskId`, and wait for their settlements. Each registration
   * names the parent task it drives, so the subtree is read from the store's own
   * task list plus the registrations — never from the batch id, which names the
   * pair (parent run, proposal) and cannot be parsed back into a task.
   */
  private abortDescendantBatches;
  /**
   * Cancel everything one store has in flight (§3.6), called by
   * `graphs.remove` before the graph is stopped and exposed as a service API.
   *
   * The order is the promise: the gate closes for every session of the store
   * first (so no further tool call writes anything), then every driver is
   * aborted and awaited (so the children and parents settle through the same
   * rules as a batch cancellation), then the runs that are still non-terminal —
   * a root run with no batch in flight, a replay — are cancelled with the
   * reason recorded, and finally the workspace claim this store held is released
   * and its sessions' managed jobs are reconciled.
   *
   * Idempotent: every step tolerates having already happened, so a second call
   * is a no-op rather than an error.
   */
  cancelGraph(storeId: string, reason: string): Promise<void>;
  /**
   * The settlement of one batch, from the outside: the registered driver's own
   * promise when this process is driving it, or the outcomes the store already
   * records when the batch settled earlier (or in another process). §3.8's
   * `awaitBatch` — the entry a test or a service uses to wait for a batch a tool
   * call no longer waits for.
   *
   * The batch is resolved through the store's own accumulation — the run whose
   * record holds this batch id, and that batch's members — never by parsing the
   * id: an id names a pair, and a parent that admitted several batches holds one
   * entry per batch. A batch no run records is refused by name rather than
   * answered with another batch's children.
   */
  awaitBatch(storeId: string, batchId: string): Promise<ChildOutcome[]>;
  /**
   * The recovery entry (A3 §3.6): settle or restart what a store left in flight.
   * Idempotent, and safe to call on a store this process is already driving —
   * the registered batches are skipped, and runs this process started are left
   * to their own drivers.
   *
   * The order is depth-descending (a child before its parent), so a restarted
   * parent batch reads its children already settled:
   *
   * - a run with no phase is an old record: it is left exactly as it is, and the
   *   read side derives `needs-recovery` from the missing phase — inventing a
   *   phase here would admit a run nobody knows the state of;
   * - a run whose content binding no longer re-reads is failed by name (S1-C's
   *   refusal, never a silent fallback);
   * - `submitted` runs are verified (the phase is the whole recovery evidence);
   * - `active` runs that are not a root are in-flight workers: nothing can
   *   confirm the writes they may have made, so they are cancelled with the
   *   diagnostic — a root run is left alone, because a root legitimately sits
   *   `active` between its own decisions;
   * - `waiting_children` runs are restarted, unless the workspace is held by
   *   another live process, in which case they fail by name rather than writing
   *   into a checkout somebody else owns.
   *
   * The run pass is followed by the proposal pass (T2/T3 §5–§6,
   * {@link reconcileProposals}): a proposal that is `ready` or `approved` is
   * continued — the re-check decides whether its approval still covers the batch,
   * and §5's tightening catches a batch that was born under `off` — while a
   * proposal waiting for a review is only re-offered to the review channel, never
   * advanced, because only a persisted decision moves it. The order is the
   * point: the run pass settles and restarts what a previous process left in
   * flight, the workspace question ("is this checkout ours?") is answered before
   * anything is admitted into it, and a batch the proposal pass admits is driven
   * by the driver *it* starts — there is nothing left for the run pass to see.
   * The report says what could not be finished and why, so a caller (the boot
   * path, an adoption) can see the proposals recovery left for a person instead
   * of reading a silent void.
   */
  reconcileStore(storeId: string): Promise<ReconcileReport>;
  /**
   * The refusal code one resume failure names — read structurally (the stable
   * class name and its `code`) rather than by `instanceof`, because the runtime
   * that raises it and this package can be two modules of one contract in a
   * source-built deployment, and a duplicate class object must not turn a named
   * refusal into an unnamed failure.
   */
  private static resumeRefusalCodeOf;
  /**
   * Record one worker-recovery attempt in the pass's report *and* on the
   * deployment's log (A4 §F.1): a `live` resume is the pass's own success and
   * needs no warn, while a `retry` and a `refused` are exactly what an operator
   * has to see — the first because the run keeps waiting on an owner that is not
   * this process, the second because the run is about to be settled terminal for
   * it. The report is the machine-readable half; this is the one adoption drops.
   *
   * `fact` names what makes the Session one the pass has to reach — an unresolved
   * blocking question (A4 §F.1), or a batch that ended and whose result the run has
   * not been told about (K1 §2, §5) — so a warn says which wait it is about.
   */
  private recordWorkerResume;
  /**
   * Wake a Session that was brought back with coordination input its own inbox
   * still holds unread (A4 §F.1's wake contract).
   *
   * Why this exists: a delivery is a `steer`, and a retry whose target's fold
   * already holds the identity is answered `already-present` **without steering**
   * — right, because a second copy would be a duplicate, but it also means a
   * message that was durable *before* the crash (spliced and flushed, never
   * claimed) wakes nothing after the restart. The resumed driver stays idle with
   * the question or the answer sitting in its restored inbox, and the wait would
   * only end at the deadline. So the pass looks at the deliveries that came back
   * `already-present`, checks the *live* inbox of the session each one addressed
   * (the public `inbox.nextTurn`/`nextStep` read), and — only when that identity
   * is still pending there — wakes the session with the runtime's own voice: a
   * `plugin`-sourced `notice` (the shape {@link notify} always sends), never a
   * person's message and never the question's or the answer's words.
   *
   * Nothing else is sent: a delivery that was steered in this pass needs no
   * second wake, a session with no pending identity is left alone, and a session
   * that is not live here cannot be woken (that is the `unavailable` case the
   * report already names). A failure inside this step is reported, never
   * propagated: the deliveries themselves were decided.
   */
  private wakeUnclaimedQuestionMessages;
  /**
   * Wake a Session that was brought back with an end-of-batch result its own inbox
   * still holds unread — {@link wakeUnclaimedQuestionMessages}' rule applied to the
   * batch messages (K1 §2, §5), and for the same reason.
   *
   * A batch end delivered before a crash is durable in the target's log but may
   * never have been claimed (spliced and flushed, then the process died), so the
   * pass's re-delivery answers `already-present` **without steering** — right,
   * because a second copy would be a duplicate — and a resumed parent with the
   * message sitting in its restored inbox would otherwise stay idle until its
   * deadline. The check is the same live-inbox read, and the wake is the same
   * runtime-voice notice: never a second copy of the message.
   */
  private wakeUnclaimedBatchResults;
  /**
   * Whether one live session's own inbox still holds a message identity — the
   * public pending read of a DSH Agent (`inbox.nextTurn` / `inbox.nextStep`),
   * used only to decide whether a session needs waking (A4 §F.1's wake
   * contract). A session this process does not hold is not "pending": it is a
   * target the delivery report already names `unavailable`.
   */
  private sessionHoldsPendingMessage;
  /**
   * The deployment half of the recovery pass's worker resume (A4 §F.1): resolve
   * the Session's graph scope, take the Session over through
   * `AgentRuntime.resumeWorkerAgent` under the run's own identity, and put the
   * live result where every other live session of this process lives.
   *
   * The order after the resume is the promise the contract makes:
   *
   * 1. **The binding.** The Session is bound to its run in this process's one
   *    binding table (`sessions`) and marked as work this process drives
   *    (`startedSessions`), exactly as a spawn's product is — so the run's own
   *    tools (`task_submit_result`, `task_answer`) resolve, and the next recovery
   *    pass reads it as live work rather than as a stranger's.
   * 2. **The gate, before anything can be delivered.** The run's phase and its
   *    question block are applied from the store under the gate's own token rule
   *    ({@link applyResumedSessionGate}) — the same derivation
   *    `initializeStoreGates` performs for every session, moved ahead of the
   *    delivery pass so the first request an answer wakes is already decided
   *    under the facts the store holds.
   * 3. **The managed work the dead process left.** The drain (the same
   *    `drainSession` the settlement paths use, with the now-live agent and the
   *    deployment's jobs service) kills and waits for this session's managed work
   *    within the configured window. An unconfirmed drain refuses the takeover by
   *    name: a resumed worker whose predecessor's jobs nobody could confirm
   *    stopped must not be allowed to run as if nothing of the sort happened.
   *
   * A refusal of the resume itself is named and never worked around: an
   * `ownership-conflict` is the retryable one (another owner holds the Session;
   * this process must not take it over) and everything else means the identity
   * cannot be established, which the caller settles as a terminal state.
   */
  private resumeAdoptedWorkerSession;
  /**
   * Apply the phase and the question block one resumed session's run implies,
   * from the store, under the gate's own token rule — the token taken *before*
   * the read, so a decision this process made while the read was in flight drops
   * the value instead of being overwritten by it. Same derivation as
   * `initializeStoreGates`, applied per session because a delivered answer can
   * wake this session before that pass runs.
   */
  private applyResumedSessionGate;
  /** The drain a resumed Session owes: the session's managed work, with the agent that now owns it. */
  private drainAdoptedSession;
  /** Let one resumed Session go again — the runtime's own stop path, never a private dispose. */
  private stopAdoptedSession;
  /**
   * Rebuild this process's workspace ownership for one store from the store's
   * own state: the root run's own hold, and — when that run is waiting on
   * children — the batch layer its driver hands to each child in turn. A tree
   * whose runs all reached terminal states releases the claim instead, which is
   * what makes a finished tree leave no marker behind.
   */
  private rebuildWorkspaceOwnership;
  /** Release every layer this process holds for one store's workspace, naming any layer that is not the store's. */
  private releaseStoreWorkspace;
  /**
   * The fallback batch-failure seam the orchestration calls when a run's own
   * settlement cannot finish the batch (verification unavailable in a nested
   * submission): every child that never started is blocked, the parent run is
   * failed with the reason, and the batch's driver is aborted so its own loop
   * stops seeing work that no longer exists.
   *
   * Both writes are the orchestration's own (A4-5): {@link blockUnstartedChildren}
   * and {@link settleRunFromRuntime} — the same pair `failBatchFromRuntime` uses —
   * so this file holds no second copy of either record shape. The batch is
   * resolved through the store's accumulation ({@link batchRecordIn}): the id
   * names a pair, not a task.
   */
  private failBatch;
  /** The session whose viewpoint a store-wide operation (recovery, cancellation) resolves its checkout from. */
  private recoverySessionFor;
  /** Any session bound to this store, for the seams that only need a viewpoint (never `storeId` if one exists). */
  private sessionForStore;
  /** Reverse lookup: the task run a (worker) session is bound to. */
  runForSession(sessionId: string): Promise<{
    storeId: string;
    task: TaskInstance;
    run: TaskRun;
  }>;
  /**
   * Whether this deployment admits a run's own `task_decompose`
   * (`Config.allowRuntimeDecomposition`), read-only. The context package's
   * worker projection carries the rule that follows from it; nothing here
   * grants or denies a call — admission still decides every one.
   */
  allowsRuntimeDecomposition(): boolean;
  /**
   * The gate phase one bound session's run implies, applied on every rebinding.
   * The gate is a handle on the run's phase and the phase is the store's fact,
   * so a session this process rebound — from its index, from a reopened store,
   * or with a phase that moved under an in-flight call — is gated as what its
   * run is. `undefined` (a record that predates phases) leaves the session
   * ungated, which is the gate's own contract for an unbindable phase, and a
   * session with no run is never gated at all.
   *
   * Two ways a read of that record can be too old to apply, and each has its own
   * guard: the closing set checked below (a decision of this process that the
   * store's write has not caught up with yet), and the `token` its caller took
   * before the read ({@link ExecutionGate.applyStorePhase}, for a read that
   * straddled a decision).
   *
   * - **A read taken inside a window whose decision is in effect but not yet
   *   persisted** — a store this process is closing ({@link cancelGraph}, whose
   *   barrier is raised before it is written): there the record read back is
   *   older than a phase this process already closed, so a rebinding may not
   *   move a phase that session holds. Whether it holds one is the whole
   *   distinction — a session the cancellation never reached has none, and the
   *   store decides for it exactly as it does everywhere else, which is what
   *   keeps the restore path (`waiting_children`, terminal records) working.
   * - **A read that straddled a decision** — the query read the record, a
   *   decision landed, and the value is applied afterwards: `token` is the
   *   gate's decision count taken before that read ({@link initializeStoreGates}
   *   is the caller now — the read door no longer writes the gate), and
   *   {@link ExecutionGate.applyStorePhase} drops the value when it has moved
   *   since. The closing set above cannot see this one — by then the store is
   *   up to date and the store is not being closed any more.
   */
  private gatePhaseFromStore;
  /**
   * The read door a session's first lookup takes (A2 §E): a read, and only a
   * read. A binding this process holds is resolved against the store; a
   * session this process never held resolves its store from its graph, opens
   * it, and indexes the snapshot so the binding the record implies answers.
   * Nothing else happens here — no recovery pass, no gate write, no spawn —
   * because a query cannot be the thing that recovers a store: recovery runs
   * behind the explicit activation barrier ({@link adoptRoot}), which is also
   * where every session the store knows gets its gate phase
   * ({@link initializeStoreGates}).
   */
  private lookupRun;
  /**
   * The recovery state of one store, as a read sees it (A2 §E): the barrier
   * handle first, and — when no barrier has run for this store in this process
   * — the store's own record, read-only. Work this process drives (a root it
   * activated here, a worker it spawned, a batch whose driver is registered)
   * is live, not recovery's; a still-running run nobody here drives is what
   * `recovery-required` names, unless it predates coordination phases, which
   * is the `needs-recovery` that allows only reading and cancelling. The
   * store's own root run is its session's, not recovery's — the same rule the
   * recovery pass applies — so a root legitimately sitting `active` between
   * its own decisions is not a recovery verdict, and the gate plus the state
   * rules are what refuse a write on it.
   *
   * Never a trigger: this opens no gate, starts no driver and settles no run,
   * so a context query, a diagnostic or the DSH first-request check can show
   * where a store stands without executing anything.
   */
  recoveryStatus(storeId: string): Promise<StoreRecoveryStatus>;
  /**
   * The recovery door every business execution entry passes before its first
   * side effect (A2 §E): the same condition the barrier establishes, refused
   * by name — `recovering` while the barrier runs, `recovery-failed` with the
   * original reason after one failed, `recovery-required` for work a dead
   * process left, `needs-recovery` for a record that predates phases. The
   * store-nothing refusals never trigger recovery themselves; cancellation,
   * close and the read-only doors are not gated here.
   *
   * The `not-activated` answer proceeds: the legal root entry (an intake)
   * creates the store, and every other caller is refused by the store's own
   * unknown-store error rather than by a recovery verdict.
   */
  private assertRecoveryReady;
  private resolveBinding;
  private reindex;
  /**
   * The checkout one session's runs work in, in the form ownership keys it:
   * the graph env's path, resolved to its real path so two spellings of one
   * directory cannot become two markers ({@link normalizeWorkspacePath}).
   *
   * `undefined` means this deployment cannot name a checkout — no env-builder,
   * no graph, or a path that does not resolve — and ownership is skipped rather
   * than guessed, which is the honest reading of §3.4's `unbound`.
   */
  private workspacePathForSession;
  /**
   * The directory one session's runs work in, for a caller that has to *name* it
   * — the one evaluation that freezes a workspace as its input snapshot has to
   * know which directory to freeze (S4-E §F.2). The answer is
   * {@link envPathForSession}'s: the workspace this process placed the session
   * in, else the session's graph env checkout, and `undefined` when the
   * deployment cannot name either.
   *
   * Read-only on purpose. This door resolves a path; it does not claim the
   * workspace, does not take its ownership, and grants no write — a caller that
   * runs something in the directory still goes through the ordinary entries,
   * which check ownership themselves.
   */
  workspacePathFor(sessionId: string): Promise<string | undefined>;
  /**
   * Refuse a decomposition whose caller does not hold its own checkout. The
   * holder may be the parent run itself (the ordinary case: a run works in its
   * checkout and hands it down), a batch the runtime holds between children, or
   * an ancestor run of this one — the chain a nested child sits on. Anything
   * else is another writer, and the batch is refused *before* anything is
   * written ({@link WorkspaceBusyError} carries the holder and since when).
   */
  private assertWorkspaceHeldBy;
  /** The parent task id of one task, read from the store; `undefined` when the store cannot answer. */
  private ancestorTaskIdFor;
  /**
   * Take the checkout for one replay run: an unheld workspace is claimed, and a
   * workspace the *caller's own* tree already holds is handed over (a replay
   * without a named workspace writes where its caller writes). Any other holder
   * is a conflict, and the replay refuses before its task is created — which is
   * also how a workspace another side of a comparison still holds refuses the
   * second side (`options.workspace`), by the same rule and the same error.
   *
   * The layer names the replayed task ({@link WorkspaceOwner.taskId}), because
   * the hold is the replay run's own: the §3.4 admission compares a holder by
   * task (`assertWorkspaceHeldBy`), so without it the replay's worker would be
   * refused the decomposition it is entitled to — its own checkout would read as
   * a stranger's. The `runId` stays the lineage label
   * (`replay-of-<championTaskId>`): experiment lineage is not a store run id, and
   * nothing addresses this layer by it.
   */
  private claimReplayWorkspace;
  /** Release the replay's own layer, leaving whatever the caller held in place. */
  private releaseReplayWorkspace;
  /**
   * Best-effort owner notification through the live agent (A3 §3.1, DSH's
   * tool-jobs precedent: a `plugin`-sourced `notice`). A session with no live
   * agent — a worker that already left, a headless test context — is skipped,
   * and a failing follow-up never fails the settlement that reports it.
   */
  private notify;
  /**
   * Send one owner notice through the live Session when its store is ready, and
   * park it on the recovery barrier when one is in flight (A4 §F.1's wake order).
   *
   * A notice is a wake: `followup` opens a turn in an idle Session, and a turn
   * whose first request meets a store that is still `recovering` is refused by
   * the recovery door with nothing to wake the Session again. The notices the
   * barrier's own pass raises are therefore raised here rather than sent: the
   * ready handle sends them in the order they were raised, and a failed or
   * invalidated barrier drops them — a notice is best-effort by contract, and
   * the next explicit activation raises the same one from the record again. With
   * no barrier in flight this is {@link notify}, unchanged.
   */
  private notifyWhenReady;
  /**
   * Deliver one ended batch's result to the Session that waited for it (K1 §2),
   * through the same relay A4's question messages use
   * ({@link AgentRuntimeHandle.ensureAgentMessageDelivered}) and under the order
   * {@link notifyWhenReady} established for every wake.
   *
   * The message is *identified* (`m-batchend-<batchId>`), which is what makes
   * this call idempotent and re-entrant: a second call — a retry in this process,
   * or the recovery pass re-deriving the same message from the run's accumulated
   * batches — states the same identity, and the target's own fold decides that it
   * is already present instead of the runtime keeping a ledger. The body is the
   * one the driver handed over, rendered from the store's own facts.
   *
   * The barrier rule is the wake rule: while a store is `recovering`, a turn in
   * one of its Sessions is refused by the recovery door with nothing left to wake
   * it, so the delivery is registered on the barrier and the ready handle makes
   * it once the gates are in place. A failed or invalidated barrier drops the
   * registration, which loses nothing: the facts are the store's, and the next
   * activation (or the recovery slice's pass) derives the same message again.
   */
  private deliverBatchResult;
  /**
   * One delivery attempt, reporting rather than throwing: the batch's facts are
   * the store's and the message is the wake that points at them, so a relay that
   * is absent, refuses or has no live Session changes nothing about the batch —
   * it is named once for the operator, and the next activation retries.
   *
   * The run the message addresses is re-read here, and it is the one guard every
   * path shares — the live batch end, a delivery a barrier deferred, the recovery
   * pass and a re-delivery a caller asked for. The message's whole content is "you
   * are active again"; a run that settled while the delivery was on its way (a
   * cancellation or a deadline that arrived first, a verdict somebody else made)
   * must not be woken by it, so a run that is no longer `running` is answered
   * `skipped` with zero side effects (K1 §2: 绝不唤活终态).
   */
  private deliverBatchResultNow;
  /**
   * Re-deliver one ended batch's result from the store's own facts (K1 §2's
   * message, re-derived): the entry a recovery pass uses for a batch whose end is
   * durable and whose Session was never told — or was told and never recorded it
   * (§F.1's "恢复只补缺失投递", applied to batches). It is also what a recovery
   * pass reconciles with, one owed batch at a time.
   *
   * Idempotent and re-entrant by construction, not by a ledger: the identity is
   * derived from the batch (`batchEndMessageId`), the body from its members'
   * terminal states and evidence, and the target's own fold decides whether the
   * message is already there (`already-present`, nothing delivered twice). A
   * batch no run of the store records is refused by name — a batch id names a
   * pair, and one nothing records cannot be guessed at. A batch whose parent run
   * already settled is `skipped`: the message's content is moot for a run that
   * cannot act on it, and a terminal run is not woken.
   */
  redeliverBatchResult(storeId: string, batchId: string): Promise<BatchResultDeliveryStatus>;
  /**
   * Kill and confirm one session's managed jobs — the half of the write
   * convergence a cancellation owes its checkout. A deployment with no jobs
   * service, or a session whose agent is gone, has nothing to reconcile, and
   * the drain's own report is what a caller reads as "not confirmed".
   */
  private reconcileSessionJobs;
  /**
   * The limits one batch is admitted under (T1, construction guide §4),
   * recorded with the decomposition and never derived from the contract: the
   * contract's own text has no field that can raise a limit, and every value
   * here is resolved from this runtime's configuration at admission time.
   *
   * Only the keys the deployment actually defined are included. `wallTimeMs`
   * and the `auditOnly` trio are one record apart on purpose — a reader has to
   * be able to tell which ceiling would have stopped the run — and an absent
   * `tokens` (this deployment ships no default for it, see {@link BudgetConfig})
   * means there is no token ceiling to record at all.
   */
  private admissionContext;
  /**
   * The env binding the session's graph runs in, or `undefined` when the
   * deployment mounts no env-builder or the graph cannot be read. Best-effort
   * by contract: every caller decides what an unresolved env means — a
   * verification command without `cwd`, a refused composition of MCP servers, a
   * refused batch when a protected input has to be fixed — and none of them may
   * guess one.
   */
  private sessionEnv;
  /**
   * The session's checkout directory: the one directory a run's commands, a
   * verifier's `cwd`, and a protected acceptance input's bytes are all resolved
   * against. `undefined` means the deployment cannot name it — the caller
   * refuses rather than fixing an identity against a base it does not know
   * ({@link fixProtectedInputs}).
   *
   * A session this process spawned into a named workspace (S4-E) answers with
   * that workspace: the graph env names where the caller's own tree works, which
   * is not where a replay the caller placed elsewhere works. This is the one
   * resolution point, so every path that asks for a session's checkout — the
   * protected inputs of a nested batch, the pre-check a review re-runs, the
   * capability report a worker reads — follows the same directory.
   */
  private envPathForSession;
  /**
   * The single refusal text a decomposition batch is rejected at the contract
   * stage with, whichever step produced the reasons (the protected-input fixing
   * or the normalization entry): a caller reads one message shape and one
   * reason-per-bullet list, and the label names the parent the batch was
   * refused for.
   */
  private contractRefusal;
  /**
   * The service-supplied seam the orchestration runs against (A3 §3.1). Every
   * piece of the protocol that needs the process — the gate, the workspace
   * registry, the notifications, the run watcher, the jobs service, the root
   * budget — enters through here, which is what keeps `orchestrate.ts` free of
   * cordis types and testable as the state machine it is.
   *
   * The checkout is resolved once per construction ({@link workspacePathForSession}):
   * the caller's session is the viewpoint every path in this env shares — the
   * verifier's `cwd`, the protected inputs' base, the skills' discovery root and
   * the workspace ownership key are one directory.
   *
   * @param workspace - the already-normalized workspace this orchestration runs
   * in, when it is not the caller session's own checkout: a replay placed in a
   * directory the caller supplied (§S4-E). It replaces the checkout for the
   * verifier's `cwd`, the MCP env the grant binds against, and the cwd every
   * worker this env spawns starts in; absent, the session's own checkout is used
   * exactly as before.
   */
  private orchestrateEnv;
  /**
   * Observe one run's terminal transition (A3 §3.1) over the task service's own
   * `task/change` event: subscribe first, then read the current status, so a run
   * that settled between the caller's read and this subscription is reported
   * rather than missed. The returned function unsubscribes.
   *
   * A deployment with no event bus (a minimal context) cannot promise the
   * observer anything, and the returned no-op says so by leaving the caller's
   * own timeout in charge.
   */
  private watchRun;
  /** The session this process binds to one run, or `undefined` when the run was never bound here. */
  private sessionBoundInProcess;
  /** Release the workspace layer one settled run held, never popping a stranger's layer. */
  private releaseRunWorkspaceLayer;
  /**
   * One best-effort read of a run's session for the review record's dimensions
   * and effort metrics (§2.7.3): the session's token projection plus one scan of
   * its log. Every source is optional — a deployment that mounts no
   * `sessionProjections`/`sessionQuery`, or a session that is no longer live,
   * yields `undefined` and the record omits those fields rather than filling
   * them with zeros.
   *
   * The log comes from `sessionQuery.readSession`, not `listEvents`: the
   * lightweight records carry only the event type, while tool names, failure
   * flags, `approval/asked` call ids and skill arguments all live in the event
   * data. One read feeds every counter below.
   *
   * Human interventions count once per interaction: `approval/asked` events,
   * plus human-tool calls whose call id no approval event already covers —
   * `hitl_approve` asks through `ctx.approval`, so counting its tool call too
   * would double that interaction. `hitl_ask` and `ask_user_question` ask
   * through `ctx.userQuestions`, which writes no session event, so their tool
   * call is the only trace.
   */
  private observeSession;
  /** The session's folded `tokenUsage` buckets, when both the session and the projection registry are reachable. */
  private sessionTokens;
  /** One replay-validated raw log read; an absent reader or a load failure yields `undefined`. */
  private sessionEvents;
  /**
   * Resolve an optional service by name, the same soft pattern this module
   * already uses for the verifier and the agent registry: the service may be
   * absent in test contexts and in deployments that mount a smaller bundle.
   */
  private softService;
  /** The verifier service is an optional plugin; resolve it softly, never import the package. */
  private runVerifier;
  /**
   * The registered verifier vocabulary one provider pre-check judges execution
   * sidecars against — `registeredVerifierIds` in `./provider-precheck.ts`, the
   * one implementation every provider check shares, with the reasoning for
   * `ready()`-first and for the fail-closed `undefined` documented there.
   */
  private registeredVerifierIds;
  /**
   * The provider pre-check (S1-C item 1) over the given capability rows, run
   * against the effective table unless `table` replaces it (the replay overlay).
   * Read-only: it discovers skill directories and reads them, writes nothing,
   * and returns every refusal as a verdict rather than throwing.
   */
  private providerPrecheck;
  /**
   * The provider verdicts for the capability rows in play, discovered from one
   * session's own viewpoint — the read-only entry `capability_list` renders
   * (guide §2.3 item 1: the model sees the pre-check's conclusion before it
   * dispatches, not only after admission refused its batch). Nothing is thrown
   * for an unusable provider: the verdict says what is wrong with it, and the
   * caller renders that.
   *
   * `capabilities` names the rows to check; omitting it checks every row of the
   * effective table. A caller that wants the verdicts a *batch* resolved
   * against should pass its matched rows — the revision then describes exactly
   * what admission judged. Two things this recompute cannot reproduce, which is
   * why admission carries its own result with the batch (S1-C item 4): the
   * replay overlay's replaced table, and the bytes as they were at admission.
   */
  capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheck>;
  /**
   * Re-check the content a run's binding recorded against the bytes its snapshot
   * holds now (S1-C item 4) — the read a historical view (`task_read`) and a
   * re-entry (`adoptRoot` adopting an existing root run) both perform before
   * trusting the record.
   *
   * `undefined` means the record names no snapshot: a run that loaded no content
   * has nothing to re-read, which is not the same as content that failed to
   * re-read. A caller that gets a report must look at its `defects`: content
   * that is not readable as bound is reported by name and is never substituted
   * with whatever the production path holds now.
   */
  readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined>;
  /**
   * verifierRef validation at creation/decomposition time, never spawn time
   * (KISS §4.1 `verifier_ref`): every declared ref must name a registered
   * verifier, or the whole batch is rejected before anything is persisted and
   * the error lists the registered ids. The listing is read through the one
   * helper every provider check shares (`registeredVerifierIds`), which readies
   * the registry first — a service that has been constructed but not readied
   * reports an empty list, and reading that as "nothing is registered" would
   * refuse a healthy deployment's batches. A deployment whose verifier service is
   * absent or cannot list its registry cannot make that promise either, so a
   * declared ref fails loudly there instead of passing through unchecked.
   */
  private assertKnownVerifierRefs;
  /** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
  private liveAgent;
  /**
   * The live agent behind one session, or `undefined` — the non-throwing half of
   * {@link liveAgent}, for the seams where an absent agent is a legitimate state
   * (a notification nobody can receive, a jobs call with no owner) rather than a
   * refusal.
   */
  private agentOrUndefined;
}
//#endregion
export { type AcceptedSkillProviderVerdict, type AdmissionChild, type AdmissionParent, type AdmissionVerdict, type AdoptedWorkerResume, type AdoptedWorkerResumeRequest, type AnsweredQuestionOutcome, type AskedQuestionOutcome, type BatchContext, type BatchResultDeliveryStatus, type BatchResultMessage, type BudgetConfig, type BudgetVerdict, COORDINATION_ALLOWED, type CapabilityConfig, CapabilityGap, type CapabilityGrants, type CapabilityProviderPrecheck, type CapabilityToolAnswer, type CapabilityToolQuery, type ChildOutcome, Config, CriterionSpec, DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_CAPABILITIES, DEFAULT_GENERATED_TASK_REVIEW, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_NO_PROGRESS_ROUNDS, DEFAULT_VERIFY_TIMEOUT_MS, DEFAULT_WRITE_DRAIN_TIMEOUT_MS, DecomposeAdmissionResult, DecomposeChildSpec, DecomposeProposalOptions, DecomposeSpec, type DecompositionIdentityContext, DecompositionRefusal, DecompositionReviewRequest, type DrainOptions, type DrainResult, ExecutionGate, type ExecutionProviderVerdict, type GateDecision, type GuidanceProviderVerdict, type HandoffInit, type InFlightCall, type JobsView, type JobsViewEntry, type KnowledgeProviderVerdict, type LoadedSkillSidecar, MCP_SERVER_REGISTRY, type McpEnvBinding, type McpServerTemplate, type NormalizationContext, type NormalizationResult, type NormalizedBatch, type NormalizedChild, type ObligationCoverage, type ObligationTemplate, type ObligationTemplateFile, type OrchestrateEnv, type OwedBatchResult, PROPOSAL_REQUEST_KEY_PREFIX, type ParentAnswerCall, type ParentAskCall, type PendingQuestionMessage, type PendingQuestionMessages, type PermissionSpec, ProposalContinuation, ProposalDecisionResult, type ProposalRequestKeyContext, ProposalReviewChannel, ProposalReviewNotice, ProposalReviewRequest, ProposalReviewRequestBase, ProposalReviewTrigger, ProposalSubmission, ProviderLoadReport, type ProviderPrecheck, type ProviderPrecheckRequest, type QuestionCaller, type QuestionCoordinationDeps, type QuestionDelivery, type QuestionReconcileReport, QuestionResumeReport, RUN_BINDING_SKILLS_DIR, ReconcileReport, type RejectedProviderVerdict, type ReplayOverlay, type ReplayRunInit, type ReplayRunOutcome, type ReplayRunSignals, ReplayTaskOptions, type ResolvedProviderIdentity, type ResolvedRootBudget, type ReviewContextInput, RootAdoption, type RootBudgetConfig, type RootBudgetResolution, RootContractReviewRequest, RootContractSpec, RootIntakeOptions, RootIntakeResult, type RootNormalizationResult, type RootRequestKeyContext, type RunBindingRead, type RunBindingRequest, type RunBindingSkillRead, RunVerifier, RunWatcherUnavailableError, type SessionObservation, type SkillDefect, type SkillDefectCode, type SkillDiscoveryView, type SkillProviderCandidate, type SkillProviderIdentity, type SkillProviderVerdict, type SkillValidationContext, type SpawnChildRequest, StoreRecoveryStatus, TOOL_LABELS, TaskRuntime, TaskRuntime as default, type VerifiedWalk, VerifierUnavailableError, type VerifierVocabulary, type VerifyRunOptions, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WORKSPACE_OWNERS_DIR, type WorkspaceAdoption, WorkspaceBusyError, type WorkspaceOwner, WorkspaceRegistry, type WorkspaceRegistryOptions, answerMessageIdOf, answerParentQuestion, applyStoreQuestionBlocking, askParentQuestion, assertRootBudgetConfig, batchEndMessageId, batchEndMessageText, bindRunProviders, blockUnstartedChildren, buildHandoff, capabilityToolQuery, checkBatchAdmission, checkDecomposition, checkObligationCoverage, checkRunStart, contractDefects, countSubtreeFacts, decompositionIdentity, defaultRunBindingRoot, deriveChildOutcomes, driveBatch, escalationHint, executionProviders, findRepoRoot, fixCriteriaProtectedInputs, fixProtectedInputs, fixSpecProtectedInputs, hasRootLimits, independentAcceptanceDefects, isOpenProposal, loadObligationTemplates, loadSkillSidecar, manifestMcpServers, normalizeDecomposition, normalizeRootContract, normalizeWorkspacePath, openProposalOf, optionalService, owedBatchResults, parseCallArguments, parseObligationTemplates, pendingCoordinationOf, pendingQuestionMessages, precheckProviders, precheckReplacedCapabilityRow, proposalRequestKey, protectedInputDefects, providerContentIdentities, providerDefectLines, providerRefusals, questionMessageIdOf, readProcessStartTime, readRunBinding, readVerifiedFile, reconcileQuestionDeliveries, registeredVerifierIds, registeredVerifierVocabulary, registryRevision, resolveCapabilities, resolveMcpServerSpecs, resolvePermission, resolveRootBudget, resolveToolLabels, resumeAdoptedWorker, reviewContextDelta, reviewContextOf, rootIndependenceDefects, rootProposalRequestKey, runDeadlineMs, runReplayTask, settleRunFromRuntime, settleSubmittedRun, skillSearchRoots, skillValidationContext, unlistableVerifierRefusal, validateSkillProvider, verifierIdentitiesOf, walkVerified, workerBaseline };
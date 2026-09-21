import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, AdmissionContext, ArtifactRef, CapabilityManifest, ChildEvidenceRef, DecompositionAdmission, DependencyEdge, EvidenceBundle, ProtectedInputRef, ReviewCriterion, ReviewTokenUsage, ReviewToolCall, RunId, TaskContract, TaskContractVersion, TaskHandoff, TaskId, TaskInstance, TaskRun, TaskService, TaskSnapshot, VerificationMode } from "@dangosys/dsh-singularity-task";
import { AgentHandle } from "@deepseek-ai/dsh-agent";
import { McpServerSpec, WorkerGrant } from "@dangosys/dsh-singularity-agent-runtime";

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
 * | session-history   | `session-query/tool-session-query` (`index.ts:109,96,86`)           |
 * | ask-user          | `interaction/tool-ask-user` (`index.ts:21`)                         |
 * | web               | `web/tool-web` (`fetch.ts:459`, `search.ts:326`)                    |
 * | todo              | `todo/tool-todo` (`index.ts:147`)                                   |
 * | goal              | `goal/tool-goal` (`index.ts:195,207,234`)                           |
 * | subagent          | `subagent/tool-subagent` (`index.ts:380`), `.../tool-subagent-control` (`index.ts:29,77`, `list-agents.ts:93`) |
 *
 * Paths are relative to `thirdparty/deepseek-harness/packages/`.
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
 * cites the prompt line that needs it (`handoff.ts:renderWorkerPrompt`, plus
 * the shell tool's own guidance for `jobs`):
 *
 * - `filesystem` — "Do the work" / "Keep changes scoped to this task" (`:135-137`).
 * - `bash` — "Where a criterion lists a command, make that command exit 0 in the checkout" (`:136`).
 * - `jobs` — that same command is often long-running, and `bash`'s own description
 *   tells the model to collect background output with `job_output`/`job_kill`.
 * - `search` — locate the code the work touches.
 * - `skill` — without the loader the granted skills are unreachable, and
 *   `tool-skill` only injects the catalog when its tool is visible.
 * - `session-history` — "Read it exactly with `session_event_read` … or `session_trace`" (`:119`).
 * - `ask-user` — "Need a human decision? Ask with `ask_user_question`" (`:137`).
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
 * worker keeps it whatever its capabilities declare.
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
 * - `task_decompose` — "Call `task_decompose` instead, with a `reason` and the child task list" (`handoff.ts:87`),
 *   and for a `leaf` worker whose deployment runs with `Config.allowRuntimeDecomposition` on,
 *   the runtime-split rule (`handoff.ts:127`) that opens the same tool to it.
 * - `task_read` — "re-read your own contract and run with `task_read`" (`handoff.ts:140`).
 * - `task_status` — the same line: the whole tree with `task_status` (`handoff.ts:140`).
 * - `task_verify` — "Before you finish, `task_verify` re-runs the verifier as a self-check" (`handoff.ts:141`).
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
//#region src/orchestrate.d.ts
/** Raised when the verifier service (ticket C2) is not loaded in the context. */
declare class VerifierUnavailableError extends Error {
  name: string;
}
/** One admitted child plus the manifest it was admitted with. */
interface ChildPlan {
  task: TaskInstance;
  manifest: CapabilityManifest;
  dependsOn: readonly number[];
  /** Caller-declared assumptions (`DecomposeChildSpec.assumptions`), merged into the handoff at spawn time. */
  assumptions?: readonly string[];
  /**
   * The child's contract constraints (`DecomposeChildSpec.constraints`, T1):
   * recorded in the contract and rendered into the handoff, so the worker reads
   * the same execution scope the store holds.
   */
  constraints?: readonly string[];
}
interface ChildOutcome {
  taskId: TaskId;
  runId?: RunId;
  status: 'verified' | 'failed' | 'blocked' | 'cancelled';
  evidenceId?: string;
}
interface SpawnChildRequest {
  sessionId: string;
  name: string;
  prompt: string;
  agentPreset?: string;
  /** Permission preset the child session is switched to (capability-granted; absent keeps the default posture). */
  permissionPreset?: string;
  /** Capability-derived authorization the agent runtime applies before the worker is published. */
  grant?: WorkerGrant;
  /**
   * The child's contract as a marked block, registered as a system-prompt
   * section so the loop reprojects it into surface node 0 on every step instead
   * of leaving it only in the spawn prompt, which a fold can shadow.
   */
  contract?: string;
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
 *   criteria failure.
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
 * Sequential run cascade over one admitted batch of children (RFC §47 MVP):
 * the first child whose dependencies are all `verified` is handed off and
 * spawned; its run is verified, then readiness is re-evaluated. A child whose
 * dependency failed, was cancelled, or never ran becomes `blocked`; an abort
 * cancels the in-flight child agent and marks its run `cancelled`. Once the
 * batch settles the parent run takes the verifier's verdict on its own
 * criteria — the composite acceptance that closes the loop.
 */
declare function runChildrenCascade(env: OrchestrateEnv, storeId: string, parentTask: TaskInstance, parentRun: TaskRun, plans: readonly ChildPlan[], reason: string, callerSessionId: string, signal?: AbortSignal): Promise<ChildOutcome[]>;
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
  /** Lineage marker (`evolution-replay:<proposalId>`), recorded on the review record's anomalies. */
  lineage: string;
  /** The preset to mount; already overlay-resolved by the caller. */
  agentPreset?: string;
  /** Worker prompt and its contract block, pre-rendered. Unused when `spawn` is false. */
  prompt?: string;
  contract?: string;
  /** Extra skill roots for the worker grant (overlay). */
  skillRoots?: readonly string[];
  /** false: deterministic criteria replay — no worker is spawned, the verifier alone settles the run. */
  spawn: boolean;
  /** The champion run this replay stands in for, recorded as the run's parentRunId (execution lineage). */
  championRunId?: RunId;
}
/** What one settled replay run reports back to the comparison report. */
interface ReplayRunOutcome {
  taskId: TaskId;
  runId: RunId;
  status: 'verified' | 'failed' | 'cancelled';
  evidenceId?: string;
  durationMs?: number;
  criteria?: ReviewCriterion[];
}
/**
 * Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
 * the store, run it once through the real spawn + verify chain — or straight
 * through the verifier alone for a deterministic criteria replay — and settle
 * it with the cascade's own terminal-record discipline ({@link recordTerminalReview}),
 * the lineage tag on the record's anomalies. The replayed task is parentless
 * and the historical task it mirrors is never touched: a replay is a
 * comparison experiment, not a tree edit. A replay never decomposes (its
 * prompt says the door is closed), so there is no parent acceptance to settle.
 */
declare function runReplayTask(env: OrchestrateEnv, storeId: string, init: ReplayRunInit, signal?: AbortSignal): Promise<ReplayRunOutcome>;
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
  taskId: string;
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
  children: NormalizedChild[];
  /** The batch identity and the limits it was admitted under, ready to be recorded with the decomposition. */
  admission: DecompositionAdmission;
}
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
 * Deployment knobs the rendered prompt has to reflect. Required, not optional:
 * the prompt is the only place a worker learns whether the runtime will admit
 * its own decomposition, and a default here could silently disagree with
 * `Config.allowRuntimeDecomposition` (#16 in the guide is exactly this failure
 * mode — prompt wording decides the route, and no test asserts the real model's
 * choice).
 */
interface WorkerPromptOptions {
  /**
   * `Config.allowRuntimeDecomposition`. On, the rules tell every worker it may
   * call `task_decompose` when the work turns out not to be atomic, and what a
   * refusal means; off, the rules stay silent about the tool — a `decomposable`
   * child's own block already names it, and for a `leaf` worker naming it would
   * only invite a call admission refuses.
   */
  allowRuntimeDecomposition: boolean;
}
/** Envelope passed from a parent run to the child it delegates to (RFC §18). */
declare function buildHandoff(init: HandoffInit): TaskHandoff;
/**
 * Render the worker prompt for a delegated child task. Compact on purpose:
 * objective, the acceptance criteria table (with verifier commands and the
 * protected input paths the worker must not modify), the handoff envelope, the
 * pointer to the delegating session, the decomposable reminder when the parent
 * asked for a further split, the runtime-split rule when the deployment admits
 * one ({@link WorkerPromptOptions}), and the rules — a few thousand tokens at
 * most.
 */
declare function renderWorkerPrompt(handoff: TaskHandoff, childTask: TaskInstance, options: WorkerPromptOptions): string;
//#endregion
//#region src/contract.d.ts
/**
 * Opening marker of the block. Stable on purpose: it is what tells a reader —
 * human or test — that this text is the contract, and it lets a future
 * re-render find the copy already on the surface.
 */
declare const WORKER_CONTRACT_OPEN = "<worker-contract";
/** Closing marker, and the URL-safe suffix a search for the block's end uses. */
declare const WORKER_CONTRACT_CLOSE = "</worker-contract>";
/**
 * Render one task's contract block.
 * @param task - the child task as the store holds it at delegation.
 * @param handoff - the envelope the parent passed to this child.
 * @returns the marked block, ending in the one line that says where the
 *   authority lives, so a model reading it never has to guess whether a
 *   compacted spawn prompt or this block is the current contract.
 */
declare function renderWorkerContract(task: TaskInstance, handoff: TaskHandoff): string;
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
 * Options for {@link TaskRuntime.replayTask} (guide §2.7.6, W15).
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
   * No-progress rounds before the loop must escalate (KISS §5: `no_progress(3轮)`).
   * **Declared, not enforced**: the orchestrator awaits a worker's terminal
   * idle and has no per-round observation seam on an in-flight run, so there
   * is nothing honest to count rounds against yet.
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
/** The shipped no-progress round count (KISS §5's `no_progress(3轮)`); declared, not enforced — see {@link Config.noProgressRounds}. */
declare const DEFAULT_NO_PROGRESS_ROUNDS = 3;
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
 * {@link Config.maxDepth}, {@link Config.maxChildren} — and a task chain still
 * splits at most once (`already decomposed`, `task/src/service/state.ts`).
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
declare class TaskRuntime extends Service {
  static inject: string[];
  static Config: z<Config>;
  private readonly config;
  /** sessionId → run binding, rebuilt whenever a store is (re)opened. */
  private readonly sessions;
  constructor(ctx: Context, config?: Config);
  /**
   * The wall-clock deadline one `verifier.verifyRun` call runs under
   * ({@link Config.verifyTimeoutMs}). Exposed because the same deadline has to
   * reach the model-facing `task_verify` self-check: its tool call would
   * otherwise run the verifier with no timer at all.
   */
  get verifyTimeoutMs(): number;
  /** The resolved per-run budget ({@link Config.budget}); which member is enforced, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  get budget(): Readonly<BudgetConfig>;
  /** The resolved no-progress round count ({@link Config.noProgressRounds}); declared, not enforced. */
  get noProgressRounds(): number;
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
   */
  applyCapabilityRow(name: string, entry: CapabilityConfig | null): void;
  /** Create (or reopen) the store, expand RootTaskSpec into the root task, and bind a run to the root session. */
  createRootTask(storeId: string, options: {
    objective: string;
    rootSessionId: string;
  }, actor: string): Promise<{
    taskId: TaskId;
    runId: RunId;
  }>;
  /**
   * Atomic decomposition plus the sequential run cascade: protected-input
   * identity fixing, normalization, structural admission and capability
   * admission must all pass for the whole batch before anything is persisted;
   * children then run one at a time in dependency order.
   *
   * Protected acceptance inputs are fixed first (`protected-inputs.ts`): every
   * criterion's declared paths are read against the session's checkout and
   * recorded as the SHA-256 of their bytes, so the contract — and both content
   * identities computed over it — describe the fixed identity, never a path
   * that could be re-pointed or re-read later.
   *
   * The batch is then normalized ({@link normalizeDecomposition}): raw caller
   * input becomes the contract of every child with its defaults filled and its
   * criterion ids fixed, and the batch identity plus the limits in force become
   * ready to be recorded with the decomposition. A refused batch — by the
   * fixing or by normalization, in one message — is refused whole: no id is
   * minted into the store, no capability is resolved into an event, and no
   * obligation is recorded.
   *
   * The structural policy is `allowed` — a `leaf` task may decompose only while
   * {@link Config.allowRuntimeDecomposition} is on — plus the configured growth
   * guardrails ({@link DEFAULT_MAX_DEPTH}, {@link DEFAULT_MAX_CHILDREN}); a
   * rejected batch names the rule it hit and persists and spawns nothing.
   */
  decomposeAndRun(storeId: string, parentTaskId: TaskId, parentRunId: RunId, callerSessionId: string, spec: DecomposeSpec, exec?: {
    signal?: AbortSignal;
  }): Promise<ChildOutcome[]>;
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
   * replay caller's checkout: a candidate contract declaring paths has their
   * identity fixed before anything else reads it, while a champion's stored
   * `{ path, sha256 }` refs are carried verbatim — the historical identity is
   * what the pre-judgement re-check compares against, so it is never re-read
   * from disk and never invented. A replay has no batch, so it records no
   * admission context: nothing was proposed to a parent, there is no sibling
   * set to bound, and the limits that do apply to its run are the run's own
   * budget, not a batch's.
   */
  replayTask(storeId: string, championTaskId: TaskId, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>;
  /** Reverse lookup: the task run a (worker) session is bound to. */
  runForSession(sessionId: string): Promise<{
    storeId: string;
    task: TaskInstance;
    run: TaskRun;
  }>;
  private lookupRun;
  private resolveBinding;
  private reindex;
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
  private orchestrateEnv;
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
   * verifierRef validation at creation/decomposition time, never spawn time
   * (KISS §4.1 `verifier_ref`): every declared ref must name a registered
   * verifier, or the whole batch is rejected before anything is persisted and
   * the error lists the registered ids. A deployment whose verifier service is
   * absent or cannot list its registry cannot make that promise, so a declared
   * ref fails loudly there instead of passing through unchecked.
   */
  private assertKnownVerifierRefs;
  /** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
  private liveAgent;
}
//#endregion
export { type AdmissionChild, type AdmissionParent, type AdmissionVerdict, type BudgetConfig, type CapabilityConfig, type ChildOutcome, type ChildPlan, Config, CriterionSpec, DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_CAPABILITIES, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_NO_PROGRESS_ROUNDS, DEFAULT_VERIFY_TIMEOUT_MS, DecomposeChildSpec, DecomposeSpec, type DecompositionIdentityContext, type HandoffInit, MCP_SERVER_REGISTRY, type McpEnvBinding, type McpServerTemplate, type NormalizationContext, type NormalizationResult, type NormalizedBatch, type NormalizedChild, type ObligationCoverage, type ObligationTemplate, type ObligationTemplateFile, type OrchestrateEnv, type PermissionSpec, type ReplayOverlay, type ReplayRunInit, type ReplayRunOutcome, ReplayTaskOptions, RunVerifier, type SessionObservation, type SpawnChildRequest, TOOL_LABELS, TaskRuntime, TaskRuntime as default, VerifierUnavailableError, type VerifyRunOptions, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN, type WorkerPromptOptions, buildHandoff, checkDecomposition, checkObligationCoverage, contractDefects, escalationHint, findRepoRoot, fixCriteriaProtectedInputs, fixProtectedInputs, fixSpecProtectedInputs, independentAcceptanceDefects, loadObligationTemplates, manifestMcpServers, normalizeDecomposition, parseObligationTemplates, protectedInputDefects, renderWorkerContract, renderWorkerPrompt, resolveCapabilities, resolveMcpServerSpecs, resolvePermission, resolveToolLabels, runChildrenCascade, runReplayTask, workerBaseline };
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, AdmissionContext, ArtifactRef, CapabilityManifest, ChildEvidenceRef, DecompositionAdmission, DependencyEdge, EvidenceBundle, KnowledgeContentCheck, ProtectedInputRef, ReviewCriterion, ReviewTokenUsage, ReviewToolCall, RunId, RunProviderBinding, RunSkillBinding, SkillContentIdentity, SkillContractDefectCode, SkillPort, SkillSidecar, TaskContract, TaskContractVersion, TaskHandoff, TaskId, TaskInstance, TaskRun, TaskService, TaskSnapshot, VerificationMode } from "@dangosys/dsh-singularity-task";
import { McpServerSpec, WorkerGrant } from "@dangosys/dsh-singularity-agent-runtime";
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
/**
 * The "chosen implementation" summary of one run — the section a worker's
 * contract block, its spawn prompt and `task_read` all render, from this one
 * function and one record, so the three views cannot describe different runs.
 *
 * What it carries: every capability the run matched, the skill selected for it
 * (name, role, purpose, short content digest and — where the skill declares one
 * — the contract digest), the granted MCP servers, the snapshot the run is bound
 * to, and what the binding does *not* cover. What it deliberately leaves out: the
 * skill text. A worker reads the body on demand with the `skill` tool; a summary
 * is identity and purpose.
 *
 * `read` is the re-check result when the caller re-read the snapshot. A caller
 * that has not read it (the spawn's own render, before the worker exists) omits
 * it, and then no readability claim is made in either direction. When it is
 * given and reports defects, they are rendered under a named refusal so a reader
 * is never told to trust content that is not there.
 */
declare function renderRunBinding(binding: RunProviderBinding | undefined, read?: RunBindingRead): string;
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
  /**
   * The provider pre-check the batch passed (S1-C item 1), carried per plan so
   * the run's own record can be bound to the providers admission actually
   * judged — one verdict set for the whole batch, not one recomputation per
   * child. Absent when a caller assembles plans without it.
   */
  providers?: ProviderPrecheck;
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
  /**
   * What this run was bound to and loaded (S1-C item 4). Rendered as the
   * "chosen implementation" section — the run's capability names, the provider
   * selected for each, and how to read a body on demand — from the same function
   * the contract block and `task_read` use. Absent on a run that recorded no
   * binding, and then the prompt says nothing about one.
   */
  binding?: RunProviderBinding;
}
/** Envelope passed from a parent run to the child it delegates to (RFC §18). */
declare function buildHandoff(init: HandoffInit): TaskHandoff;
/**
 * Render the worker prompt for a delegated child task. Compact on purpose:
 * objective, the acceptance criteria table (with verifier commands and the
 * protected input paths the worker must not modify), the implementation chosen
 * for this run ({@link WorkerPromptOptions.binding}), the handoff envelope, the
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
 * @param binding - what this run was bound to and loaded (S1-C item 4): the
 *   providers chosen for it, rendered as the "chosen implementation" section
 *   from the same function and record `task_read` renders, so the two views
 *   cannot describe different runs. Absent on a run that recorded no binding,
 *   and then nothing is added to the block.
 * @returns the marked block, ending in the one line that says where the
 *   authority lives, so a model reading it never has to guess whether a
 *   compacted spawn prompt or this block is the current contract.
 */
declare function renderWorkerContract(task: TaskInstance, handoff: TaskHandoff, binding?: RunProviderBinding): string;
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
  /**
   * Where a run's bound provider content is materialized (S1-C): one directory
   * per run holding the skills the run loads, outside the worker's checkout so a
   * worker cannot rewrite what it is verified against. Defaults to
   * {@link defaultRunBindingRoot} (`<DSH_HOME or ~/.dsh>/singularity/run-bindings`);
   * a deployment that cannot materialize content fails a run that selects any,
   * rather than letting it load an unbound production path.
   */
  runBindingRoot?: string;
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
  /** The load-time provider scan, taken once ({@link providerLoadReport}). */
  private providerLoad?;
  constructor(ctx: Context, config?: Config);
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
   * re-entry (`createRootTask` adopting an existing run) both perform before
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
   * the error lists the registered ids. A deployment whose verifier service is
   * absent or cannot list its registry cannot make that promise, so a declared
   * ref fails loudly there instead of passing through unchecked.
   */
  private assertKnownVerifierRefs;
  /** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
  private liveAgent;
}
//#endregion
export { type AcceptedSkillProviderVerdict, type AdmissionChild, type AdmissionParent, type AdmissionVerdict, type BudgetConfig, type CapabilityConfig, type CapabilityGrants, type CapabilityProviderPrecheck, type CapabilityToolAnswer, type CapabilityToolQuery, type ChildOutcome, type ChildPlan, Config, CriterionSpec, DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_CAPABILITIES, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_NO_PROGRESS_ROUNDS, DEFAULT_VERIFY_TIMEOUT_MS, DecomposeChildSpec, DecomposeSpec, type DecompositionIdentityContext, type ExecutionProviderVerdict, type GuidanceProviderVerdict, type HandoffInit, type KnowledgeProviderVerdict, type LoadedSkillSidecar, MCP_SERVER_REGISTRY, type McpEnvBinding, type McpServerTemplate, type NormalizationContext, type NormalizationResult, type NormalizedBatch, type NormalizedChild, type ObligationCoverage, type ObligationTemplate, type ObligationTemplateFile, type OrchestrateEnv, type PermissionSpec, ProviderLoadReport, type ProviderPrecheck, type ProviderPrecheckRequest, RUN_BINDING_SKILLS_DIR, type RejectedProviderVerdict, type ReplayOverlay, type ReplayRunInit, type ReplayRunOutcome, ReplayTaskOptions, type RunBindingRead, type RunBindingRequest, type RunBindingSkillRead, RunVerifier, type SessionObservation, type SkillDefect, type SkillDefectCode, type SkillDiscoveryView, type SkillProviderCandidate, type SkillProviderIdentity, type SkillProviderVerdict, type SkillValidationContext, type SpawnChildRequest, TOOL_LABELS, TaskRuntime, TaskRuntime as default, type VerifiedWalk, VerifierUnavailableError, type VerifierVocabulary, type VerifyRunOptions, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN, type WorkerPromptOptions, bindRunProviders, buildHandoff, capabilityToolQuery, checkDecomposition, checkObligationCoverage, contractDefects, defaultRunBindingRoot, escalationHint, executionProviders, findRepoRoot, fixCriteriaProtectedInputs, fixProtectedInputs, fixSpecProtectedInputs, independentAcceptanceDefects, loadObligationTemplates, loadSkillSidecar, manifestMcpServers, normalizeDecomposition, optionalService, parseObligationTemplates, precheckProviders, precheckReplacedCapabilityRow, protectedInputDefects, providerDefectLines, providerRefusals, readRunBinding, readVerifiedFile, registeredVerifierIds, registryRevision, renderRunBinding, renderWorkerContract, renderWorkerPrompt, resolveCapabilities, resolveMcpServerSpecs, resolvePermission, resolveToolLabels, runChildrenCascade, runReplayTask, skillSearchRoots, skillValidationContext, unlistableVerifierRefusal, validateSkillProvider, walkVerified, workerBaseline };
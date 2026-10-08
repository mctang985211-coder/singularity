import * as _dangosys_dsh_singularity_task0 from "@dangosys/dsh-singularity-task";
import { AcceptanceCriterion, AdmissionContext, BudgetExtensionProposal, CapabilityManifest, CatalogPath, CriterionSpec, DecompositionAdmission, DecompositionIdentity, EvidenceBundle, ExecutionPhase, ExecutionReceipt, Obligation, ProtectedInputRef, QuestionAnswer, QuestionAnswerRecord, QuestionAsk, QuestionRecord, ReceiptMissingFact, ReceiptRequestIdentity, ReviewCriterion, ReviewOutcome, ReviewTokenUsage, ReviewToolCall, RevisionPin, RunId, RunMcpServerBinding, RunMemberReuse, RunMemberReuseRefusal, RunPlacement, RunProviderBinding, RunSkillBinding, RunStatus, TaskBudgetExtension, TaskContract, TaskContractInput, TaskContractVersion, TaskId, TaskInstance, TaskProposal, TaskProposalDecisionOutcome, TaskProposalDecomposition, TaskProposalPolicy, TaskProposalRoot, TaskProposalStatus, TaskRun, TaskService, TaskSnapshot, TaskTemplate, TaskTemplateRef, TemplateParameters, TemplateScope } from "@dangosys/dsh-singularity-task";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { AgentMessageIntent, AgentOptions, McpServerSpec, MessageDeliveryReport, MessageDeliveryStatus, SessionOwnLog, ToolCallBody, ToolCallRef, WorkerGrant, parseSkillFile } from "@dangosys/dsh-singularity-agent-runtime";
import { ContextFormed } from "@deepseek-ai/dsh-llm";
import { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";

//#region src/mcp-servers.d.ts
/**
 * The env binding one spawn resolves server templates against. Produced by
 * `OrchestrateEnv.resolveMcpEnv` from the graph's env record; absent when the
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
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-tool-call deadline handed to mcp-client; defaults to the client default (60 s). */
  toolCallTimeoutMs?: number;
}
/** Parse deployment and candidate definitions through one schema and namespace policy. */
declare function parseMcpServerRegistry(value: unknown): Record<string, McpServerTemplate>;
/**
 * Materialize one manifest's MCP grants into mount-ready specs.
 * @param manifest - the resolved capability manifest (server names already validated at admission).
 */
declare function resolveMcpServerSpecs(manifest: {
  capabilities: Record<string, {
    mcpServers?: string[];
  }>;
}, binding: McpEnvBinding | undefined, registry: Readonly<Record<string, McpServerTemplate>>): McpServerSpec[];
//#endregion
//#region src/capability.d.ts
/** One capability entry as held in plugin Config (arrays optional pre-validation). */
interface CapabilityConfig {
  skills?: string[];
  tools?: string[];
  preset?: string;
  /** Permission preset (`permissionPresets` table key) granted when a task requires this capability. */
  permission?: string;
  /**
   * MCP server names from the deployment registry
   * granted when a task requires this capability; each mounts as one
   */
  mcpServers?: string[];
}
/**
 * Capability tool labels → the real DSH tool names each label grants.
 * A capability table is authored against what the WORK needs, not against
 */
declare const TOOL_LABELS: Readonly<Record<string, readonly string[]>>;
/**
 * The capability-worker baseline: what every worker needs whatever its
 * capabilities are, because its own prompt tells it to use these. Every entry
 */
declare const WORKER_BASELINE_LABELS: readonly string[];
/**
 * Baseline tool names that are not a capability label: the task machinery the
 * worker prompt calls. They are exactly the Layer-0 universal control tools the
 */
declare const WORKER_BASELINE_TOOLS: readonly string[];
/**
 * Every real tool name a capability worker keeps on top of what its
 * capabilities declare.
 */
declare function workerBaseline(): string[];
/**
 * Resolve required capability names against the configured registry.
 * A required name that has an entry contributes its skills/tools/preset to the
 */
declare function resolveCapabilities(required: readonly string[], registry: Readonly<Record<string, CapabilityConfig>>, mcpServers?: Readonly<Record<string, McpServerTemplate>>): CapabilityManifest;
/** One permission preset's knob bundle, as `permissionPresets.resolve` reports it. */
interface PermissionSpec {
  sandbox: string;
  approval: string;
}
//#endregion
//#region src/skill-contract.d.ts
/**
 * The typed skill sidecar contract: the declaration that sits beside a skill's
 * `SKILL.md` (`SKILL.contract.json`) and says what kind of skill it is, what it
 */
/**
 * The sidecar file, read as JSON, named exactly here so every producer and
 * reader of a skill directory agrees on one spelling.
 */
declare const SKILL_SIDECAR_FILE = "SKILL.contract.json";
/**
 * The sidecar contract version this build writes and reads. Like the task
 * contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
 */
declare const SKILL_CONTRACT_VERSION: 1;
/** Every version of {@link SkillSidecar} this build can write or read. */
type SkillContractVersion = typeof SKILL_CONTRACT_VERSION;
/**
 * The directories a skill may hold supporting files in. The supported shape is
 * deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
 */
declare const SUPPORTED_SKILL_RESOURCE_DIRS: readonly string[];
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
 */
type SkillContractDefectCode = 'sidecar-unknown-version' | 'sidecar-unknown-field' | 'sidecar-shape';
/** One reason a declared sidecar is not acceptable, with the kind of problem named. */
interface SkillContractDefect {
  code: SkillContractDefectCode;
  /** The readable reason, naming the field and the vocabulary it was checked against. */
  reason: string;
}
/**
 * Every reason one declared sidecar is not acceptable, in field order — never
 * just the first, so one refusal names everything wrong with the declaration.
 */
declare function skillContractDefects(value: unknown): SkillContractDefect[];
/**
 * The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
 * declared data, so key order and `undefined`-valued keys do not move it while
 */
declare function skillContractDigest(sidecar: SkillSidecar): string;
/**
 * The identity of one content identity: SHA-256 over {@link canonicalize} of the
 * `SKILL.md` digest and the resource list. Separate from
 */
declare function skillContentDigest(content: SkillContentIdentity): string;
/**
 * The same declaration with one field replaced: `content.skillMdSha256`.
 * A same-name improvement of an execution skill changes the `SKILL.md` and
 */
declare function sidecarWithSkillMd(sidecar: SkillSidecar, skillMdSha256: string): SkillSidecar;
/**
 * The deterministic byte sequence of one declaration — what a file holds when
 * this build writes a sidecar.
 */
declare function serializeSkillSidecar(sidecar: SkillSidecar): string;
//#endregion
//#region src/sidecar.d.ts
/** Every reason a provider is refused, named so a caller can act on the kind of problem. */
type SkillDefectCode = SkillContractDefectCode | 'skill-missing' | 'skill-file-invalid' | 'skill-name-mismatch' | 'sidecar-unreadable' | 'sidecar-mismatch' | 'content-mismatch' | 'content-unsupported' | 'verifier-unknown' | 'capability-unknown' | 'tool-not-covered' | 'commit-intent-open' | 'commit-ledger-unreadable';
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
 */
declare function capabilityToolQuery(capabilities: Readonly<Record<string, CapabilityConfig>>, mcpRegistry?: Readonly<Record<string, McpServerTemplate>>): CapabilityToolQuery;
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
   */
  readonly frontmatter?: LoadedSkillFrontmatter;
  /** Instruction body parsed from the same bytes whose digest was checked. */
  readonly instructions?: string;
  /** Direct entries the supported vocabulary does not cover (a directory reads as `name/`), sorted. */
  readonly uncovered: readonly string[];
  /** Every reason the directory or its sidecar is not acceptable; empty means a clean load. */
  readonly defects: readonly SkillDefect[];
}
/**
 * The frontmatter two consumers need: the spawn's `readSkillFile` (which
 * publishes the body under `name`) and every renderer that shows what a
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
 */
declare function loadSkillSidecar(directory: string): Promise<LoadedSkillSidecar>;
/**
 * The unified pre-check: one candidate provider against the deployment's
 * verifier vocabulary and capability table (guide §2.3, S1-C item 3). Every
 */
declare function validateSkillProvider(candidate: SkillProviderCandidate, context: SkillValidationContext): Promise<SkillProviderVerdict>;
/**
 * The registry revision: SHA-256 over {@link canonicalize} of the capability
 * table (each row sorted by name, carrying its skills, the tool labels it
 */
declare function registryRevision(capabilities: Readonly<Record<string, CapabilityConfig>>, providers: readonly SkillProviderIdentity[], mcpRegistry?: Readonly<Record<string, McpServerTemplate>>): string;
//#endregion
//#region src/provider-precheck.d.ts
/**
 * Resolve an optional sibling plugin's service by property or `ctx.get(name)`,
 * the soft pattern this repo uses for services a deployment may or may not
 */
declare function optionalService<T>(host: unknown, name: string): T | undefined;
/**
 * The registered verifier vocabulary a provider check judges execution sidecars
 * against, or `undefined` when the deployment cannot list it — no verifier
 */
declare function registeredVerifierIds(host: unknown): Promise<readonly string[] | undefined>;
/**
 * The registered verifier vocabulary *and the version each instance declares*,
 * or `undefined` under exactly the conditions {@link registeredVerifierIds}
 */
declare function registeredVerifierVocabulary(host: unknown): Promise<{
  ids: readonly string[];
  versions: Readonly<Record<string, string>>;
} | undefined>;
/**
 * The refusal of an execution sidecar the deployment cannot judge because its
 * verifier vocabulary could not be listed: the declared ref is refused rather
 */
declare function unlistableVerifierRefusal(name: string, directory: string | undefined, ref: string): RejectedProviderVerdict;
/**
 * The evolution commit ledger as a provider check reads it (K2): the production
 * targets a commit left open. Task-runtime never imports the evolution package —
 */
interface EvolutionCommitLedger {
  /**
   * The absolute production file paths of every open commit intent, in ledger
   * order (`EvolutionService.openIntentTargets`): for one K3 commit, the files
   */
  openIntentTargets?(): Promise<readonly string[]>;
  /**
   * The capability rows every open commit intent moves, in ledger order
   * (`EvolutionService.openIntentCapabilities`) — the half of a capability
   */
  openIntentCapabilities?(): Promise<readonly string[]>;
}
/**
 * Where a pre-check looks for a skill: the viewpoint of the worker that would
 * load it. `cwd` is the session's checkout — the directory the worker's own
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
 */
declare function skillSearchRoots(view?: SkillDiscoveryView): Promise<string[]>;
/** What one capability row's declared skills resolved to. */
interface CapabilityProviderPrecheck {
  /** The capability row the skills were read from. */
  readonly capability: string;
  /** One verdict per distinct skill the row declares, in declaration order; empty for a row that was refused before it was resolved. */
  readonly skills: readonly SkillProviderVerdict[];
  /**
   * The named reasons this **row** — not a skill of it — may not be admitted,
   * empty or absent when it may. Row-keyed refusals exist because a capability
   */
  readonly refusals?: readonly SkillDefect[];
}
/**
 * The result of one pre-check, shaped to be carried: per capability, the
 * verdict for every skill it declares; the roots that were searched; the
 */
interface ProviderPrecheck {
  /** Every capability row that was checked, in the order given. */
  readonly capabilities: readonly CapabilityProviderPrecheck[];
  /** The discovery roots the search covered, in order. */
  readonly roots: readonly string[];
  /**
   * The registered verifier ids the execution sidecars were checked against.
   * **Absent** means the registry could not be listed at all, which is not the
   */
  readonly verifierRefs?: readonly string[];
  /**
   * {@link registryRevision} over the table the rows came from and the provider
   * identity of every **accepted** skill in play (a skill without a sidecar
   */
  readonly revision: string;
}
/** What one pre-check needs beyond the view: the rows in play and their table. */
interface ProviderPrecheckRequest {
  /**
   * The capability rows in play, in the order they should be reported — the
   * matched rows of the batch's manifests (ordinary decomposition, replay) or
   */
  readonly capabilities: readonly string[];
  /** The capability table the rows were resolved from; its identity is part of {@link ProviderPrecheck.revision}. */
  readonly mcpRegistry?: Readonly<Record<string, McpServerTemplate>>;
  readonly table: Readonly<Record<string, CapabilityConfig>>;
  /** Where discovery looks. */
  readonly view: SkillDiscoveryView;
  /**
   * The registered verifier ids (`VerifierRegistry.verifierIds()`, after
   * `ready()`), or absent when the registry cannot be listed.
   */
  readonly verifierRefs?: readonly string[];
  /**
   * The deployment's evolution ledger, resolved softly by the caller
   * (`optionalService(ctx, 'evolution')`) or absent when the deployment mounts
   */
  readonly commitLedger?: EvolutionCommitLedger;
}
/**
 * Every provider content identity one pre-check resolved, deduplicated by name
 * and sorted by it: the list a caller folds into whatever it records about the
 */

/**
 * Check every skill every listed capability declares, from one discovery
 * viewpoint.
 */
declare function precheckProviders(request: ProviderPrecheckRequest): Promise<ProviderPrecheck>;
/**
 * One capability row as it would read after a replacement, checked by the same
 * pre-check a batch is admitted under: `entry` is folded into `table` — the row
 */
declare function precheckReplacedCapabilityRow(request: {
  /** The capability row being written. */
  readonly name: string;
  /** The row's entry as it will read after the replacement. */
  readonly entry: CapabilityConfig;
  /** The table the row is folded into — the replacement table, then. */
  readonly mcpRegistry?: Readonly<Record<string, McpServerTemplate>>;
  readonly table: Readonly<Record<string, CapabilityConfig>>;
  /** Where discovery looks; a deployment's own process viewpoint or a worker's checkout. */
  readonly view: SkillDiscoveryView;
  /** The registered verifier ids (`VerifierRegistry.verifierIds()`), or absent when the registry cannot be listed. */
  readonly verifierRefs?: readonly string[];
  /** The deployment's evolution ledger (`optionalService(ctx, 'evolution')`), or absent when the deployment mounts none. */
  readonly commitLedger?: EvolutionCommitLedger;
}): Promise<{
  readonly precheck: ProviderPrecheck;
  readonly refusals: readonly string[];
}>;
/**
 * Every refused provider of one pre-check, one line each, naming the capability
 * that declares it, the skill, the directory when one was found, and every
 */
declare function providerRefusals(precheck: ProviderPrecheck, taskCapabilities?: readonly string[]): string[];
//#endregion
//#region src/root-budget.d.ts
/**
 * The root budget as configured (`Config.rootBudget`). Every member is optional:
 * absent means the deployment sets no such limit, which is a statement about
 */
interface RootBudgetConfig {
  /** How many runs the tree may start, counted over the store's whole run list. */
  maxRuns?: number;
  /**
   * Writes that may hold one workspace at a time. This deployment enforces
   * exactly one, so any other value is a limit it cannot honor — see
   */
  maxConcurrentWrites?: number;
}
/**
 * The run ceiling a root budget is measured in. Every member is optional, and
 * absent means the deployment sets no such limit — which is a statement about
 */
interface RootBudgetCeilings {
  /** The run count the tree may reach. */
  readonly maxRuns?: number;
}
/** Persisted budget owner, observed start time, and run ceilings. */
interface ResolvedRootBudget {
  /** The store's root task (`parentTaskId === undefined`) — the tree the budget belongs to. */
  readonly rootTaskId: TaskId;
  /** The root run's persisted start, read from the store: the instant the budget was accepted. */
  readonly acceptedAt: string;
  /** The run ceiling in force: the approved absolute count when the store holds one, else the configured count. */
  readonly maxRuns?: number;
  /** What the deployment itself configures, resolved against the same root start: the values before any approved raise. */
  readonly configured: RootBudgetCeilings;
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
 */

/** The verdict a start or a batch admission gets. A refusal always names the limit it hit. */
type BudgetVerdict = {
  readonly allowed: true;
} | {
  readonly allowed: false;
  readonly reason: string;
};
/**
 * The root budget a snapshot is under, or the reason none can be measured.
 * The owner is the store's own root: among the parentless tasks, the one whose
 */
declare function resolveRootBudget(snapshot: TaskSnapshot, config: RootBudgetConfig): RootBudgetResolution;
/**
 * Whether the persisted run count leaves room for another run.
 */
declare function checkRunStart(snapshot: TaskSnapshot, budget: ResolvedRootBudget): BudgetVerdict;
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
  templateRef?: TaskTemplateRef;
  templateParameters?: TemplateParameters;
  /** The caller's reason, verbatim — part of {@link decompositionIdentity}, so a writer that records the batch's identity records this text. */
  reason: string;
  children: NormalizedChild[];
  /** The batch identity and the limits it was admitted under, ready to be recorded with the decomposition. */
  admission: DecompositionAdmission;
}
/**
 * The identity one batch is digested over (§4): where it came from, which
 * contract language it is written in, the caller's reason, and the complete
 */
declare function decompositionIdentity(context: DecompositionIdentityContext, reason: string, children: readonly NormalizedChild[], binding?: Pick<NormalizedBatch, 'templateRef' | 'templateParameters'>): DecompositionIdentity;
type NormalizationResult = {
  ok: true;
  batch: NormalizedBatch;
} | {
  ok: false;
  reasons: string[];
};
/**
 * Normalize one decomposition proposal.
 * Returns every defect it found, never the first: a caller revising a proposal
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
 */
declare function normalizeRootContract(spec: unknown): RootNormalizationResult;
//#endregion
//#region src/recovery.d.ts
/**
 * One already verified sibling the new attempt reads at one of its leading
 * positions (plan §F.4, "已通过兄弟证据复用"): a citation of the task, the run
 */
interface RootRecoveryReuse {
  /** The absolute position in the attempt's member sequence this citation claims; unique within one request. */
  childIndex: number;
  /** The verified sibling task, a child of the source root task. */
  taskId: TaskId;
  /** The sibling's own verified run — the one whose evidence is cited. */
  sourceRunId: RunId;
  /** The evidence bundle under that run. */
  evidenceId: string;
  /** The criterion the citation narrows to, when the original acceptance map names one for this position. */
  criterionId?: string;
  /** Artifacts the citation names (artifact id or kind), all present in the cited bundle. */
  artifactRefs?: readonly string[];
  /** Input references the citation names, from the sibling's own declared input vocabulary. */
  inputRefs?: readonly string[];
}
/** Which round a request asks for: `recovery` (the default) re-runs a failed source, `improve` re-runs a verified one. */
type RecoveryMode = 'recovery' | 'improve';
/** The stored kind one mode writes into {@link RunRecovery.kind}. */
declare function recoveryKindOf(mode: RecoveryMode | undefined): 'recovery' | 'improvement';
/** The mode one stored kind was asked under; a record written before the field existed reads as a recovery. */
declare function recoveryModeOf(kind: 'recovery' | 'improvement' | undefined): RecoveryMode;
/**
 * One recovery request, as the host composition layer hands it to the runtime
 * (plan §F.4: the tool and evolution's coordinator call this entry, and each
 */
interface RootRecoveryRequest {
  sourceTaskId: TaskId;
  /** The source run of the attempt, or `null` when the source had none; a failed run for `recovery`, a verified one for `improve`. */
  sourceRunId: RunId | null;
  /** The diagnosis this recovery is asked for; it must be a record of this store naming this task. */
  sourceDiagnosisId: string;
  /** The caller's request key: one key names one attempt of one diagnosis. */
  requestKey: string;
  /**
   * Which round this is. Absent or `recovery` is the failed-source path; `improve` asks for an improvement round of a
   * verified source, judged by the same original criteria. The two spend separate per-source caps.
   */
  mode?: RecoveryMode;
  /** Applied evolution proposals consumed by this new attempt, verified by recovery coordination. */
  proposalIds?: readonly string[];
  /** The verified siblings the new attempt reads at its leading positions, in position order. */
  reuses?: readonly RootRecoveryReuse[];
  /** The bubble workspace this round's worker works in, when the caller materialized one; absent falls back to the session's own checkout. */
  workspacePath?: string;
}
/** The attempt one request key names on a source task, or `undefined`. */
declare function recoveryAttemptWithKey(snapshot: TaskSnapshot, sourceTaskId: TaskId, requestKey: string): TaskRun | undefined;
/**
 * The attempt one diagnosis already has whose run has not settled, or
 * `undefined` — the mutual exclusion one diagnosis's recovery has (plan §F.4:
 */
declare function inFlightRecoveryAttempt(snapshot: TaskSnapshot, sourceTaskId: TaskId, sourceDiagnosisId: string): TaskRun | undefined;
/**
 * The source run one attempt reads, or `undefined` when the failure had none: a
 * `recovery` names a run that settled `failed`, an `improve` a verified one — and
 * an `improve` that names none reads the task's newest verified run.
 */
declare function recoverySourceRun(source: TaskInstance, request: RootRecoveryRequest, snapshot: TaskSnapshot, kind: 'recovery' | 'improvement'): TaskRun | undefined;
/** The rounds one source task has spent, counted from the runs its own `runIds` hold: the two kinds spend separate caps. */
interface RecoveryRounds {
  /** Runs of the task that are recovery attempts of a failed source. */
  readonly recovery: number;
  /** Runs of the task that are improvement attempts of a verified one. */
  readonly improvement: number;
}
/** Count one source task's attempt runs by kind; a row written before `kind` existed is a recovery. */
declare function recoveryRoundsOf(snapshot: TaskSnapshot, sourceTaskId: TaskId): RecoveryRounds;
/** The coded refusal one exhausted per-source cap answers with (A7 §3): the caller's next move is to stop, not to retry. */
declare class IterationCapRefusal extends Error {
  readonly code = "iteration-cap";
  constructor(message: string);
}
//#endregion
//#region src/environment/revision.d.ts
/** The one id shape a revision directory, a pointer and a run record all agree on. */
declare const ENVIRONMENT_REVISION_ID: RegExp;
/** The id shape of a draft directory; allocated monotonically per library. */
declare const ENVIRONMENT_DRAFT_ID: RegExp;
/** The id a draft's prospective revision carries: deterministic, so a killed publish replays onto the same name. */
declare function candidateRevisionId(draftId: string): string;
/** One skill as one revision holds it: the current entry of its name, with the lineage-local version and both digests. */
interface EnvironmentSkillEntry {
  readonly name: string;
  /** Monotonic within the graph library's lineage; two drafts of the same base both get version+1 and the pointer CAS settles the conflict. */
  readonly version: number;
  /** sha256 of the exact `SKILL.md` bytes. */
  readonly digest: string;
  /** `skillContentDigest` of `SKILL.md` plus the declared resources. */
  readonly contentDigest: string;
  /** `skillContractDigest` of the declared sidecar, or `null` for a skill that declares none. */
  readonly contractDigest: string | null;
  readonly status: 'temporary' | 'retained' | 'retired';
  readonly reason?: string;
  readonly reviewedBy?: string;
}
/** One task template as one revision holds it. */
interface EnvironmentTaskTemplateEntry {
  readonly templateRef: TaskTemplateRef;
  readonly status: 'temporary' | 'retained' | 'retired';
  readonly skills: string[];
  readonly reason?: string;
  readonly reviewedBy?: string;
}
/** The graph-internal capability table of one revision: explicit rows (including candidate `method:*` rows) and the MCP templates they resolve against. */
interface EnvironmentCapabilityEntry {
  readonly rows: Readonly<Record<string, CapabilityConfig>>;
  readonly mcpServers: Readonly<Record<string, McpServerTemplate>>;
}
/** The self-describing identity of one immutable revision directory; `contentDigest` covers every other field. */
interface EnvironmentRevisionManifest {
  readonly formatVersion: 1;
  readonly revisionId: string;
  readonly libraryId: string;
  readonly kind: 'official' | 'candidate';
  readonly basedOn: string | null;
  readonly createdAt: string;
  readonly skills: readonly EnvironmentSkillEntry[];
  readonly taskTemplates: readonly EnvironmentTaskTemplateEntry[];
  readonly capabilities: EnvironmentCapabilityEntry;
  /** sha256 over `canonicalize` of this manifest without this field. */
  readonly contentDigest: string;
}
/** A revision directory resolved to its roots. */
interface EnvironmentRevision {
  readonly manifest: EnvironmentRevisionManifest;
  readonly root: string;
  readonly skillRoot: string;
  readonly taskTemplatesRoot: string;
}
/** The listing projection of one revision: identity plus sizes, never the full manifest. */
interface EnvironmentRevisionRef {
  readonly revisionId: string;
  readonly kind: 'official' | 'candidate';
  readonly basedOn: string | null;
  readonly contentDigest: string;
  readonly createdAt: string;
  readonly skills: number;
  readonly taskTemplates: number;
}
/** One skill edit staged into a draft: the complete new `SKILL.md` and the complete declared resource set. */
interface SkillEdit {
  readonly name: string;
  readonly skillMd: string;
  /** The complete resource set of the new version: `<dir>/<file>` per `isSupportedSkillResourcePath`, plus optionally `SKILL.contract.json`. */
  readonly resources?: Record<string, string>;
  /** Must equal the current entry's version (0 when the name is new); the same discipline as the old library's `expectedVersion`. */
  readonly expectedVersion?: number;
  readonly actor: string;
}
/** One task template edit staged into a draft. */
interface TemplateEdit {
  readonly template: TaskTemplate;
  readonly actor: string;
}
/** One capability-row edit staged into a draft: `entry` null removes the row; an `mcpServers` value of null removes that template. */
interface CapabilityRowEdit {
  readonly name: string;
  readonly entry: CapabilityConfig | null;
  readonly mcpServers?: Readonly<Record<string, McpServerTemplate | null>>;
  readonly actor: string;
}
/** One retention review staged into a draft (the shape the old library's `reviewTaskLibrary` accepted, plus the reviewer). */
interface EnvironmentReview {
  readonly kind: 'task' | 'skill';
  readonly name: string;
  readonly version: number;
  readonly status: 'retained' | 'retired';
  readonly reason: string;
  readonly actor: string;
}
/** Every edit a draft accepts. */
type EnvironmentEdit = {
  readonly kind: 'skill';
  readonly edit: SkillEdit;
} | {
  readonly kind: 'task';
  readonly edit: TemplateEdit;
} | {
  readonly kind: 'review';
  readonly review: EnvironmentReview;
} | {
  readonly kind: 'capability';
  readonly edit: CapabilityRowEdit;
};
/**
 * The content digest of a manifest: what the revision **holds** — its skill
 * entries, its task templates and its capability table — plus the generation it
 * belongs to, and nothing else. The identity it is filed under (`revisionId`,
 * which for a candidate is derived from the draft id, the revision it was based
 * on, and when it was staged) is identity, not content: two drafts carrying the
 * same bytes therefore read the same content digest, and a client that keys a
 * candidate by its content (the strategy's same-bytes refutation) matches on it.
 * The identity members are pinned elsewhere — the revision id by the directory
 * name it must equal, and the base and timestamp by the draft record.
 */
declare function manifestDigest(manifest: Omit<EnvironmentRevisionManifest, 'contentDigest'>): string;
/** The manifest of a revision that holds nothing yet; `ensureInitialRevision` fills it, a draft copies and edits it. */
declare function emptyRevisionManifest(input: {
  libraryId: string;
  revisionId: string;
  kind: 'official' | 'candidate';
  basedOn: string | null;
  createdAt: string;
}): EnvironmentRevisionManifest;
/** Parse and fully validate one manifest, including its self-digest: a manifest whose bytes were edited is refused by name. */
declare function parseRevisionManifest(raw: unknown, where: string): EnvironmentRevisionManifest;
/** The current entry of one skill name in a revision. */
declare function revisionSkillOf(manifest: EnvironmentRevisionManifest, name: string): EnvironmentSkillEntry | undefined;
/** The newest entry of one template id in a revision. */
declare function revisionTemplateOf(manifest: EnvironmentRevisionManifest, id: string): EnvironmentTaskTemplateEntry | undefined;
/** The listing projection of one manifest. */
declare function revisionRefOf(manifest: EnvironmentRevisionManifest): EnvironmentRevisionRef;
/** The graph-internal capability rows of one revision; replaces the old index-derived `libraryCapabilities`. */
declare function revisionCapabilityRows(manifest: EnvironmentRevisionManifest): Record<string, CapabilityConfig>;
/** The hard rules any draft edit must pass, checked before any byte moves; the apply functions re-check them. */
declare function assertDraftEditAllowed(manifest: EnvironmentRevisionManifest, edit: EnvironmentEdit): void;
/** Apply one skill edit to a manifest, purely: the entry's digests come from the edit's declared bytes. */
declare function applySkillEdit(manifest: EnvironmentRevisionManifest, edit: SkillEdit): EnvironmentRevisionManifest;
/** Apply one task template edit to a manifest, purely: an identical repeat is a no-op, a conflicting version is refused. */
declare function applyTemplateEdit(manifest: EnvironmentRevisionManifest, template: TaskTemplate, table?: Readonly<Record<string, CapabilityConfig>>): EnvironmentRevisionManifest;
/** Apply one retention review to a manifest, purely: status is a field of the revision, never an in-place edit of a shared index. */
declare function applyReviewEdit(manifest: EnvironmentRevisionManifest, review: EnvironmentReview, reviewedBy: string): EnvironmentRevisionManifest;
/** Apply one capability-row edit to a manifest, purely: a null entry removes the row, a null MCP template removes it. */
declare function applyCapabilityRowEdit(manifest: EnvironmentRevisionManifest, edit: CapabilityRowEdit): EnvironmentRevisionManifest;
//#endregion
//#region src/gate.d.ts
/** A tool call that was let through and has not reported its result yet. */
interface InFlightCall {
  readonly callId: string;
  readonly name: string;
}
/**
 * The jobs service as the drain uses it, structurally. Written as a soft
 * interface so the runtime can hand in `ctx.jobs` without this module importing
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
 */
declare class ExecutionGate {
  private readonly phases;
  /** Registering by call id (not by session) because `tools/result` carries only the call id. */
  private readonly calls;
  /**
   * How many times this process wrote one session's phase by its own authority
   * ({@link setPhase}, {@link setTerminal}): the applicability token a
   */
  private readonly decisions;
  /**
   * The sessions whose runs are waiting on an unresolved blocking question
   * (A4 §F.1). A set rather than a map of booleans: "no entry" and "not blocked"
   */
  private readonly questionBlocked;
  /**
   * Move a session's phase: the runtime calls this when **it** is the authority
   * for the transition — a committed admission or submission, a settled run, an
   */
  setPhase(sessionId: string, phase: ExecutionPhase): void;
  /**
   * Mark a session's run terminal: only the allow-list runs from here, and its
   * reason says the call is late. A decision, like {@link setPhase} — it moves
   */
  setTerminal(sessionId: string): void;
  /**
   * How many times this process has written this session's phase by its own
   * authority; `0` for a session it has never written one for. This is the
   */
  decisionToken(sessionId: string): number;
  /**
   * Apply a phase the store implies — never one this process decided — and only
   * when it is newer than everything decided here: `token` is the
   */
  applyStorePhase(sessionId: string, phase: ExecutionPhase | 'terminal', token: number): boolean;
  /**
   * Record that a session's run is — or is no longer — waiting on an unresolved
   * blocking question (A4 §F.1). A decision of this process about a fact this
   */
  setQuestionsBlocked(sessionId: string, blocked: boolean): void;
  /**
   * Apply a blocking state the store implies — never one this process decided —
   * under the same token rule as {@link applyStorePhase}: `token` is the
   */
  applyStoreQuestionsBlocked(sessionId: string, blocked: boolean, token: number): boolean;
  /** Whether the run bound to this session is waiting on an unresolved blocking question (A4 §7.2's derived wait). */
  questionsBlocked(sessionId: string): boolean;
  /** The phase a session is under, or `undefined` when no run is bound to it (nothing is gated). */
  phaseOf(sessionId: string): ExecutionPhase | 'terminal' | undefined;
  /**
   * Register a call that was let through. Called for every allowed call whatever
   * its phase, because the phase can change while it runs — that in-flight write
   */
  trackAllowed(sessionId: string, callId: string, toolName: string): void;
  /** The result event for a call arrived: it is no longer in flight. Unknown ids are the denied calls, and are ignored. */
  settled(callId: string): void;
  /**
   * The session's in-flight calls that count as writes: everything whose name is
   * not in {@link COORDINATION_ALLOWED}. The definition is the allow-list, not a
   */
  inFlightWrites(sessionId: string): InFlightCall[];
  /**
   * Decide one call. A session with no phase is not bound to a run and is not
   * gated; an `active` run with no blocking question is still deciding its own
   */
  decide(sessionId: string, toolName: string): GateDecision;
  /**
   * Wait — bounded — until this session has no in-flight write and no live
   * managed job, and say exactly what is left when the window closes. Never
   */
  drainSession(sessionId: string, opts: DrainOptions): Promise<DrainResult>;
}
//#endregion
//#region src/workspace.d.ts
/**
 * Who holds a workspace. One shape for the three roles the protocol gives it:
 * the run that is writing, the verifier that owns the checkout exclusively
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
   */
  pid?: number;
}
/** One line naming an owner the way every diagnostic in this module names it. */

declare class WorkspaceRegistry {
  private readonly markerRoot;
  private readonly pid;
  private readonly stacks;
  /**
   * One marker-mutation chain per workspace: every write and delete joins the
   * tail of its workspace's chain, so overlapping mutations of one marker land
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
   */
  claim(workspace: string, owner: WorkspaceOwner): Promise<void>;
  /**
   * Hand the workspace from `from` (which must be the current holder) to `to`,
   * pushing `to` on the stack and rewriting the marker to name it. The stack is
   */
  push(workspace: string, from: WorkspaceOwner, to: WorkspaceOwner): Promise<void>;
  /**
   * Release `owner`, which must be the current holder. A mismatch throws with
   * both owners named — popping a lower holder would hand the checkout to
   */
  release(workspace: string, owner: WorkspaceOwner): Promise<void>;
  /**
   * Take over a marker whose owning process is gone — the recovery path only,
   * and the only way a stale marker is ever cleared. An absent marker is a
   */
  reconcileAdopt(workspace: string): Promise<WorkspaceAdoption>;
  /**
   * Release everything this process still holds, as an unload path does. Only
   * markers that name this process's pid are deleted: a marker written by
   */
  close(): Promise<void>;
  /** The busy error a marker earns: whose, why, and — when the recorded start time disagrees — that the pid was reused. */
  private busyFromMarker;
  private readMarker;
  private writeMarker;
  private removeMarker;
}
//#endregion
//#region src/orchestration/types.d.ts
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
   */
  evidenceId?: string;
}
/**
 * One ended batch's result, handed to the Session that was waiting for it (K1
 * §2): the batch's identity, the run whose wait it ends, the Session it goes to,
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
   */
  taskWorker?: boolean;
  /**
   * The working directory the child's session starts in. Absent inherits the
   * caller's own cwd, which is what every ordinary run does; the orchestration
   */
  cwd?: string;
  /**
   * The model selection the child's agent is created under, replacing the
   * deployment's own default for this worker alone (`AgentRuntime.spawn` merges
   */
  taskTemplatesRoot?: string;
  agentOptions?: AgentOptions;
  signal?: AbortSignal;
}
/** Per-run usage annotations, measured from the persisted Session. */
interface BudgetConfig {
  maxToolCalls?: number;
  tokens?: number;
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
   */
  resolvePermissionSpec?(name: string): PermissionSpec;
  /**
   * Optional env binding for capability-declared MCP servers
   * (`mcp-servers.ts`): the caller session's graph env, or `undefined` when
   */
  resolveMcpEnv?(): Promise<McpEnvBinding | undefined>;
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>;
  verifyTimeoutMs: number;
  /** The resolved per-run budget; which member is enforced in flight, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  budget?: BudgetConfig;
  /**
   * `Config.allowRuntimeDecomposition`, carried to the worker prompt: a `leaf`
   * worker has to be told the door is open before it can walk through it, and a
   */
  allowRuntimeDecomposition: boolean;
  isolatedChildren?: boolean;
  maxActiveWorkers?: number;
  childEnv?(run: TaskRun): Promise<OrchestrateEnv>;
  prepareChildPlacement?(batch: BatchContext, runId: RunId, dependencyEvidenceRefs: string[]): Promise<RunPlacement>;
  withChildAdmission?<T>(start: () => Promise<T>): Promise<T | undefined>;
  waitForCapacity?(signal: AbortSignal): Promise<void>;
  activateParent?(sessionId: string, signal: AbortSignal, activate: () => Promise<void>): Promise<void>;
  spawn(request: SpawnChildRequest): Promise<AgentHandle>;
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  /** Optional tail reader for verifier logs (logRef relative to the verifier's evidence root); absent keeps logTail off failed records. */
  readLogTail?(logRef: string): Promise<string | undefined>;
  /**
   * Where a run's bound content is materialized (S1-C, `Config.runBindingRoot`).
   * Absent means this deployment cannot materialize content: a run that selects
   */
  runBindingRoot?: string;
  /**
   * Optional session reader for the review record's dimensions and metrics
   * (§2.7.3): one read of a run's session log and token projection. Absent — or
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
   */
  gate: ExecutionGate;
  /**
   * The one-writer-per-workspace registry (A3 §3.4), with the checkout this
   * orchestration's sessions run in ({@link OrchestrateEnv.workspacePath},
   */
  workspaces?: WorkspaceRegistry;
  workspacePath?: string;
  /**
   * The directory every worker this orchestration spawns starts in, when the
   * checkout it works in is not the one its caller's session inherits. A replay
   */
  workerCwd?: string;
  /**
   * The model selection every worker this orchestration spawns is created under,
   * when the run it serves is bound to one. A replay carries the experiment's
   */
  taskTemplatesRoot?: string;
  /**
   * The immutable environment revision the caller's Run is bound to, resolved
   * once by the runtime when it builds this env: every run this orchestration
   * admits (a batch child, a nested child) binds the same revision, so a publish
   * landing mid-batch never moves a child admitted before it.
   */
  environmentRevision?: EnvironmentRevision;
  /** The unpublished candidate revision a trial run binds; inherited by its children exactly like the revision. */
  trialCandidateRef?: string;
  agentOptions?: AgentOptions;
  /**
   * The provider pre-check, for the one case that has no verdict to carry: a
   * batch whose admission happened in an earlier process. A freshly admitted
   */
  precheck?(capabilities: readonly string[], cwd: string | undefined, manifest?: CapabilityManifest): Promise<ProviderPrecheck>;
  /**
   * Best-effort owner notification (`agent.followup` on a live session, DSH's
   * tool-jobs notice precedent). A session with no live agent is skipped, and
   */
  notify?(sessionId: string, text: string): void;
  /**
   * Deliver one ended batch's result to its parent's Session (K1 §2) — the wake
   * that tells the parent it is `active` again, that the workspace is back, and
   */
  deliverBatchResult?(message: BatchResultMessage): Promise<BatchResultDeliveryStatus>;
  /**
   * Observe one run's terminal transition: subscribe, then read the current
   * state, so a run that settled between the caller's last read and the
   */
  watchRun?(storeId: string, runId: RunId, cb: (status: RunStatus) => void): () => void;
  /** The root budget in force (`Config.rootBudget`); absent means this deployment sets no root limits. */
  rootBudget?: RootBudgetConfig;
  /** How long a write drain may take before it is reported as unconfirmed (`Config.writeDrainTimeoutMs`). */
  writeDrainTimeoutMs: number;
  /** The jobs service the drain kills and waits on; absent means this deployment has no managed jobs. */
  jobs?: JobsView;
  /** The agent a run's session currently resolves to, if any — the authorization a jobs call carries. */
  agentFor?(sessionId: string): unknown;
  /**
   * Runtime bookkeeping at a run's terminal transition: the gate closes for
   * that session (only coordination tools remain) and the workspace the run
   */
  onRunSettled?(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void;
  /** Called once per recorded terminal review, after the record is durable and never awaited. */
  onTerminalReview?(fact: TerminalReviewFact): void;
  /**
   * Seal one Run's execution receipt, awaited *before* the terminal review is
   * handed over. Absent means this deployment seals nothing; a receipt that
   * cannot be sealed is warned and queued, and never fails the settlement.
   */
  sealReceipt?(storeId: string, taskId: TaskId, runId: RunId): Promise<void>;
  /**
   * The runtime's batch-failure seam: every child of the batch that has not
   * reached a terminal state is blocked and the batch's parent run is failed
   */
  failBatch?(storeId: string, batchId: string, reason: string): Promise<void>;
  /**
   * Bring one adopted worker's Session back live under its own identity (A4
   * §F.1) — the runtime's own door into `AgentRuntime.resumeWorkerAgent`, with
   */
  resumeWorkerSession?(request: AdoptedWorkerResumeRequest): Promise<AdoptedWorkerResume>;
}
/**
 * What one request to bring an adopted worker's Session back states: the run
 * the store holds and the authorization rebuilt for it — never a second
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
 * - `live` — the same Session is live in this process now (or already was), so
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
 * One terminal review that just became durable, as {@link
 * RuntimeSettlementEnv.onTerminalReview} hands it to the deployment.
 */
interface TerminalReviewFact {
  readonly storeId: string;
  readonly taskId: TaskId;
  readonly runId: string | null;
  readonly outcome: ReviewOutcome;
}
/**
 * What a *runtime-level* settlement holds — the slice of {@link OrchestrateEnv}
 * that a terminal record, a notification and a workspace release actually read.
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
   * Called once per recorded terminal review (A5), *after* the record is durable
   * and never awaited: a settlement hands the fact over and carries on, because
   */
  onTerminalReview?(fact: TerminalReviewFact): void;
  /** The receipt sealer, awaited before the terminal review is handed over ({@link OrchestrateEnv.sealReceipt}). */
  sealReceipt?(storeId: string, taskId: TaskId, runId: RunId): Promise<void>;
  /**
   * The live process's execution gate, when this settlement has one (A4 §F.1).
   * A settled run ends the *questions addressed to it* — an open question needs
   */
  gate?: ExecutionGate;
}
/**
 * The one batch the runtime drives: the parent whose children it admitted, the
 * batch id the store recorded, and the signal that now owns the progress.
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
   */
  excludeCallId?: string;
  /**
   * The provider pre-check the batch was admitted under (S1-C). Carried so a
   * fresh admission's verdicts reach each child's run binding instead of being
   */
  providers?: ProviderPrecheck;
}
/**
 * One batch a run has ended and been told about — or still has to be told about
 * ({@link owedBatchResults}): the batch, the run whose wait it ends, the Session
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
 * ------------------------------------------------------------------------- *
 * Replay (A3 §3.2/§3.8 applied to the W15 runner)
 */
/**
 * Per-run overlay (guide §2.7.6, W15): candidate-side patches applied to ONE
 * replay run, never to the runtime's configuration. The evolution replay is
 */
interface ReplayOverlay {
  /** Frozen library for this replay and descendants; production config is unchanged. */
  taskTemplatesRoot?: string;
  /**
   * Whole-row capability replacements: an entry overrides the same-named row of
   * the configured table for this run's capability resolution (the same
   */
  capabilityOverrides?: Record<string, CapabilityConfig>;
  /** Candidate definitions resolved for this replay only. */
  mcpServers?: Record<string, McpServerTemplate>;
  /**
   * Extra skill roots forwarded to the worker grant (`WorkerGrant.skillRoots`):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   */
  extraSkillRoots?: string[];
  /**
   * Preset id mounted instead of the capability/default resolution. Must exist
   * in the deployment's preset roster — the roster scans constructor-fixed
   */
  presetOverride?: string;
}
/**
 * What one replay's receipt settled as: `sealed` names the receipt a consumer
 * may read immediately, and `absent` names why there is none — the two are
 * different refusals for a consumer, so they are different answers.
 */
type ReplayReceiptReport = {
  readonly status: 'sealed';
  readonly digest: string;
  readonly completeness: 'complete' | 'incomplete';
  readonly missing: readonly string[];
} | {
  readonly status: 'absent';
  readonly reason: string;
};
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
   */
  workspace?: string;
  /** The execution receipt this run sealed, or why there is none. */
  receipt?: ReplayReceiptReport;
}
//#endregion
//#region src/question.d.ts
/** What one `task_ask_parent` call claims about itself (A4 §F.1): the call it is, and the key it asks under. */
interface ParentAskCall {
  /**
   * The registration id of the calling tool call. It names the `tool/call` event
   * the body must come from, in the caller's own Session — an id the caller
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
/**
 * One delivery attempt as the entry point reports it: the identity the store
 * recorded, and what the target Session could witness. `refused` is this
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
/**
 * The services one question coordination reaches, narrowed to what it calls: the
 * store's own entries (never the whole service), the caller's Session log, and
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
//#endregion
//#region src/types.d.ts
interface DecomposeChildSpec extends TaskContractInput {
  dependsOn?: readonly number[];
  decomposable?: boolean;
  requiresIndependentAcceptance?: boolean;
}
interface DecomposeSpec {
  templateRef?: TaskContractInput['templateRef'];
  templateParameters?: TaskContractInput['templateParameters'];
  /** Omitted only for a template recipe; normal admission requires the expanded direct children and reason. */
  children?: readonly DecomposeChildSpec[];
  reason?: string;
  /**
   * The contract language this batch is written in (T1). Omitted is the legacy
   * adapter — the runtime writes its current version, which is what an entry
   */
  contractVersion?: number;
}
interface RootContractSpec extends TaskContractInput {
  contractVersion?: number;
}
interface RootIntakeOptions {
  /**
   * The idempotency key this request is addressed by (§2). Absent, the runtime
   * derives it from the store, the root session and the contract's own digest
   */
  requestKey?: string;
  /** The proposal this one revises (§6): a rejected or stale root contract, whose record is kept. */
  supersedes?: string;
  /**
   * The call's own control: an already-aborted `signal` persists nothing. There is
   * no `callId` here and no write drain behind it — nothing about an activation
   */
  exec?: {
    signal?: AbortSignal;
  };
}
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
type RootAdoption = {
  adopted: true;
  taskId: TaskId;
  runId: RunId;
  /**
   * The phase this session's execution gate now holds, derived from the
   * store's own run record. A root run that reached a terminal state leaves
   */
  phase: ExecutionPhase | 'terminal';
  detail: string;
} | {
  adopted: false;
  detail: string;
};
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
   */
  workspace?: {
    path: string;
    rebaseFrom?: string;
  };
  /**
   * The model selection this replay runs under (S4-E §Q3), replacing the
   * deployment's default for this run's worker and for every worker its
   */
  agentOptions?: AgentOptions;
  /**
   * The unpublished candidate revision this replay explicitly trials. The run
   * binds the candidate's frozen content while the active revision stays where
   * it is; absent replays under the active revision.
   */
  trialCandidateRef?: string;
  signal?: AbortSignal;
}
interface DecomposeProposalOptions {
  /**
   * The idempotency key this request is addressed by (§6). Absent, the runtime
   * derives it from the calling context
   */
  requestKey?: string;
  /**
   * The proposal this one revises (§6): a rejected or stale one, whose record
   * is kept. A revision is new content (and a new key); naming the predecessor
   */
  supersedes?: string;
  /**
   * The admission call's own control: `signal` governs the pre-check (an
   * already-aborted call persists nothing), `callId` is the call's own
   */
  exec?: {
    signal?: AbortSignal;
    callId?: string;
  };
}
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
interface CapabilityGap {
  /** The child's batch position (its index in the proposal's children). */
  childIndex: number;
  /** That child's objective, so the obligation raised for the gap names the work it blocks. */
  objective: string;
  /** The capability names the registry could not grant. */
  missing: readonly string[];
}
interface DecompositionRefusal {
  readonly error: Error;
  readonly reasons: readonly string[];
  readonly gaps: readonly CapabilityGap[];
}
type ProposalReviewTrigger = 'submitted' | 'tightened' | 'recovered';
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
interface DecompositionReviewRequest extends ProposalReviewRequestBase {
  /** The kind, when the writer stated it. Absent means this arm — the shape every request had before root intake existed. */
  readonly kind?: 'decomposition';
  /** The parent task the batch belongs to, as the store holds it. */
  readonly parentTask: TaskInstance;
  /**
   * The batch the proposal holds, rebuilt from the store (`storedBatchOf`) — the
   * contracts a reviewer has to read, not a digest, and not whatever a live
   */
  readonly batch: NormalizedBatch;
}
interface RootContractReviewRequest extends ProposalReviewRequestBase {
  readonly kind: 'root';
  /** The root session whose goal this contract is. There is no parent task to name, and none is invented. */
  readonly rootSessionId: string;
  /** The normalized root contract the proposal asks to run, as stored — what a reviewer reads is what an approval binds. */
  readonly contract: TaskContract;
}
type ProposalReviewRequest = DecompositionReviewRequest | RootContractReviewRequest;
interface ProposalReviewNotice {
  /** Whether a person was actually asked. */
  readonly requested: boolean;
  /** What the channel reported, for the caller to render. */
  readonly detail?: string;
}
interface ProposalReviewChannel {
  requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice>;
}
interface QuestionResumeReport {
  /** The run the attempt was about, as the store names it (`run "r-…" (session "s-…")`). */
  readonly subject: string;
  readonly status: AdoptedWorkerResume['status'];
  /** Present for `retry` and `refused`: why the Session was not brought back. */
  readonly reason?: string;
}
interface ReconcileReport {
  readonly unresolvedProposals: readonly {
    proposalId: string;
    status: TaskProposalStatus;
    reason: string;
  }[];
  /**
   * What the pass's own question deliveries settled as (A4 §F.1), one record per
   * fact the store still owed a message for — `delivered`, `already-present`, or
   */
  readonly questionDeliveries: readonly QuestionReconcileReport[];
  /**
   * What the pass's own recovery of workers settled as (A4 §F.1, widened by K1
   * §5), one record per run it tried to bring back — `live` for a Session that is
   */
  readonly questionResumes: readonly QuestionResumeReport[];
}
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
type DecompositionPrecheck = {
  ok: true;
  batch: NormalizedBatch;
  manifests: CapabilityManifest[];
  providers: ProviderPrecheck;
} | {
  ok: false;
  refusal: DecompositionRefusal;
};
type ReviewSubject = {
  kind?: 'decomposition';
  storeId: string;
  trigger: ProposalReviewTrigger;
  proposal: TaskProposal;
  parentTask: TaskInstance;
  batch: NormalizedBatch;
  manifests: readonly CapabilityManifest[];
} | {
  kind: 'root';
  storeId: string;
  trigger: ProposalReviewTrigger;
  proposal: TaskProposal;
  rootSessionId: string;
  contract: TaskContract;
  manifests: readonly CapabilityManifest[];
};
interface RootBudgetExtensionRequest {
  readonly requestKey: string;
  readonly maxRuns: number;
}
interface RootBudgetExtensionHost {
  /** The host's own identity for the call the question is asked under (the DSH tool call id). */
  readonly callId: string;
  /** The host execution handle; the runtime carries it and never reads it. */
  readonly execution: unknown;
}
type RootBudgetApprovalDecision = {
  readonly kind: 'allowed';
  readonly reference: string;
} | {
  readonly kind: 'refused';
  readonly reason: string;
};
interface RootBudgetApprovalAsk {
  readonly storeId: string;
  readonly rootTaskId: TaskId;
  readonly rootSessionId: string;
  /** What this deployment's configuration alone allows, resolved against the root's own start. */
  readonly configured: RootBudgetCeilings;
  /** The complete reading in force, frozen by the runtime right now and re-checked inside the store's write queue. */
  readonly effective: RootBudgetCeilings;
  readonly runsUsed: number;
  readonly proposal: Omit<BudgetExtensionProposal, 'deadlineAt'>;
  readonly host: RootBudgetExtensionHost;
}
type RootBudgetApproval = (ask: RootBudgetApprovalAsk) => Promise<RootBudgetApprovalDecision>;
interface RootBudgetExtensionResult {
  readonly storeId: string;
  readonly rootTaskId: TaskId;
  /** True when the answer is a record the store already held rather than one this call committed: nothing was written and no grant was taken. */
  readonly answeredFromRecord: boolean;
  readonly record: TaskBudgetExtension;
}
interface AdmitBatchRequest {
  proposal: TaskProposalDecomposition;
  parentTask: TaskInstance;
  parentRun: TaskRun;
  batch: NormalizedBatch;
  manifests: readonly CapabilityManifest[];
  providers: ProviderPrecheck;
  exec?: {
    signal?: AbortSignal;
    callId?: string;
  };
}
/** The stored batch one continuation re-checks before admission (§6): the content the proposal carries and the limits in force now. */
interface CheckDerivedBatchRequest {
  readonly identity: DecompositionIdentityContext;
  readonly parentTask: TaskInstance;
  readonly batch: NormalizedBatch;
  readonly envPath?: string;
}
/** The batch a runtime start hands to the driver it spawns. */
interface StartBatchDriverOptions {
  readonly storeId: string;
  readonly parentTaskId: TaskId;
  readonly parentRunId: RunId;
  readonly batchId: string;
  readonly callerSessionId: string;
  readonly reason: string;
  readonly providers?: ProviderPrecheck;
  readonly excludeCallId?: string;
}
interface RootRecoveryCaller {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}
interface RootRecoveryOutcome {
  /** `started` — this call opened the attempt; `existing` — the key already named it and nothing was written. */
  readonly attempt: 'started' | 'existing';
  readonly storeId: string;
  readonly sourceTaskId: TaskId;
  readonly sourceDiagnosisId: string;
  readonly requestKey: string;
  readonly runId: RunId;
  readonly sessionId: string;
  readonly status: RunStatus;
  /** The verified siblings the attempt reads, by the positions they claim. */
  readonly reusedMembers: readonly RunMemberReuse[];
  /**
   * The positions of the failed run that read a passed sibling the attempt could
   * not bind, with every reason — the "affected items" a reader can act on. The
   */
  readonly unboundMembers: readonly RunMemberReuseRefusal[];
  readonly detail: string;
}
//#endregion
//#region src/task-template.d.ts
/** The sole default for production and Evolution: the runtime resolves this once at construction. */
declare function defaultTaskTemplatesRoot(): string;
interface TaskTemplateMatch {
  templateRef: TaskTemplateRef;
  template: TaskTemplate;
}
/** Reject unsupported schema vocabulary rather than claiming to validate it. */
declare function parseTaskTemplate(raw: unknown): TaskTemplate;
/** Append one immutable version. An identical repeat returns the same reference. */
declare function registerTaskTemplate(root: string, input: TaskTemplate): Promise<TaskTemplateRef>;
/** Return the newest version of each id. Conditions are read by the caller; keyword search is only discovery.
 *
 * `retired` names the `id@version` keys the owning environment revision holds
 * retired; the caller passes them in, because a template's status is a field of
 * the immutable revision, never of an index a read may rewrite.
 */
declare function findTaskTemplates(root: string | undefined, query?: string, scope?: TemplateScope, retired?: ReadonlySet<string>): Promise<TaskTemplateMatch[]>;
/** Expand into the same authoring fields as a free contract; no template-specific execution path follows. */
declare function bindTaskTemplate<T extends TaskContractInput>(root: string | undefined, spec: T, scope?: TemplateScope, retired?: ReadonlySet<string>): Promise<T & TaskContractInput>;
declare function bindTaskDecomposition(root: string | undefined, spec: DecomposeSpec, scope?: TemplateScope, retired?: ReadonlySet<string>): Promise<DecomposeSpec>;
interface TaskTemplateQuery {
  query?: string;
  catalogPath?: CatalogPath;
  templateRef?: TaskTemplateRef;
  offset?: number;
  limit?: number;
}
interface TaskTemplateCatalogPage {
  templateScope: TemplateScope | null;
  entries: ({
    kind: 'catalog';
    catalogPath: CatalogPath;
    templates: number;
  } | {
    kind: 'template';
    templateRef: TaskTemplateRef;
    catalogPath: CatalogPath;
    appliesTo: string[];
    objective: string;
    parameters: string[];
    decomposition: boolean;
  })[];
  total: number;
  offset: number;
  nextOffset: number | null;
  message?: string;
}
declare function taskTemplatePage(root: string | undefined, request: TaskTemplateQuery & {
  templateRef: TaskTemplateRef;
}, scope?: TemplateScope): Promise<TaskTemplateMatch>;
declare function taskTemplatePage(root: string | undefined, request?: Omit<TaskTemplateQuery, 'templateRef'> & {
  templateRef?: undefined;
}, scope?: TemplateScope): Promise<TaskTemplateCatalogPage>;
declare function taskTemplatePage(root: string | undefined, request: TaskTemplateQuery, scope?: TemplateScope): Promise<TaskTemplateMatch | TaskTemplateCatalogPage>;
//#endregion
//#region src/run-binding.d.ts
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
   * caller must supply a fresh pre-check before this run can execute.
   */
  providers?: ProviderPrecheck;
  /** The capability table the run resolved against; its revision is recorded when no pre-check carries one. */
  table?: Readonly<Record<string, CapabilityConfig>>;
  /** Where the run snapshot is materialized; absent means this deployment cannot materialize content, which fails a run that selected any. */
  root?: string;
  /** The MCP template registry the granted server names resolve against (tests pass their own). */
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>;
  /**
   * The immutable environment revision this run is admitted against. Present on
   * every new-protocol run: the bytes are read from the revision's own skill
   * root and the binding records the revision id. Absent on an old-protocol run
   * (or a caller with no revision), where the admitted verdicts' directories
   * remain the source and no revision id is recorded.
   */
  revision?: EnvironmentRevision;
  /** The unpublished candidate revision an explicit trial binds; recorded on the binding beside the revision. */
  trialCandidateRef?: string;
}
/** The granted MCP servers' identity: the registry key and the template it resolved to, or `null` when the registry holds no such key. */
declare function mcpServerBindings(manifest: CapabilityManifest, registry: Readonly<Record<string, McpServerTemplate>>): RunMcpServerBinding[];
/**
 * Bind one run's content: identify the providers its admission judged,
 * materialize their admitted bytes, and verify the snapshot against the record
 */
declare function bindRunProviders(request: RunBindingRequest): Promise<RunProviderBinding>;
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
  /** Present only when the bound instruction bytes read back without defects. */
  readonly instructions?: string;
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
//#endregion
//#region src/config.d.ts
/**
 * The review/supervision policy of this deployment, as `singularity-agent` declares it: the two round caps here are what
 * the recovery entry enforces per source task, counted separately for failed and verified sources.
 */
interface SupervisionConfig {
  /** Recovery attempts one failed source accepts; the next request is refused with the coded `iteration-cap`. */
  maxRecoveryRounds: number;
  /** Improvement attempts one verified source accepts; the next request is refused with the coded `iteration-cap`. */
  maxImprovementRounds: number;
  /** Review-agent runs one root store may start — read by the coordination ledger, not here. */
  coordinationBudget: number;
}
interface Config {
  /** MCP server definitions supplied by this deployment. */
  mcpServers?: Record<string, McpServerTemplate>;
  /**
   * The supervision policy in force: declared by `singularity-agent`, read here for the two per-source round caps. A
   * deployment may state it on this plugin's config, or expose it as the `singularitySupervision` service.
   */
  supervision?: SupervisionConfig;
  /**
   * Capability registry: name → skills/tool labels/agent preset/permission
   * preset granted when a task requires it. The core ships no table of its
   */
  capabilities: Record<string, CapabilityConfig>;
  /** Agent preset used when no matched capability names one. */
  defaultPreset?: string;
  /** Directory of immutable <id>@<version>.json task templates. */
  taskTemplatesRoot?: string;
  /** Wall-clock budget for one `verifier.verifyRun` call. */
  verifyTimeoutMs: number;
  /** Absolute tree depth a decomposition may reach: a child at `maxDepth + 1` is rejected (root is depth 0). */
  maxDepth: number;
  /** Most children one `task_decompose` batch may create. */
  maxChildren: number;
  /** Optionally copy ordinary children into independent local workspaces. */
  isolatedChildren: boolean;
  /** Maximum active child workers across this runtime; waiting parents release capacity. */
  maxActiveWorkers: number;
  /** Per-run resource budget; see {@link BudgetConfig} for which member is enforced, checked post-hoc, or declared only. */
  budget: BudgetConfig;
  /**
   * Whether a task admitted `leaf` may still decompose at runtime: the node
   * itself decides it is not atomic, instead of its parent having predicted it
   */
  allowRuntimeDecomposition: boolean;
  /**
   * Whether a new child batch must be reviewed by a person before it may run
   * (T2/T3 §5): `off` (the shipped default) admits on the machine rules alone
   */
  generatedTaskReview: 'off' | 'all';
  /**
   * Where a run's bound provider content is materialized (S1-C): one directory
   * per run holding the skills the run loads, outside the worker's checkout so a
   */
  runBindingRoot?: string;
  /**
   * The DSH home holding `singularity/environments/<libraryId>`, the immutable
   * environment revisions and drafts of every graph library. Absent means the
   * segment `runBindingRoot` already sits under (or `DSH_HOME`).
   */
  environmentRevisionRoot?: string;
  /**
   * What the whole tree may spend (A3 §3.5): a cap on the runs the tree may
   * start, and the concurrent-writer count — which this deployment can only
   */
  rootBudget?: RootBudgetConfig;
  /**
   * How long one write drain may take (A3 §3.3) before it is reported as
   * unconfirmed — and an unconfirmed drain fails the run rather than assuming
   */
  writeDrainTimeoutMs: number;
}
interface ProviderLoadReport {
  /** The scan's verdicts, per capability and per skill; absent when the scan could not run at all. */
  readonly precheck?: ProviderPrecheck;
  /** Every refused provider, one line per defect; empty when the table names only loadable providers. */
  readonly defects: readonly string[];
  /**
   * Why the scan could not run at all — a failure of the scan itself, not of a
   * provider. Reported instead of a verdict, never swallowed: a load report that
   */
  readonly failed?: string;
}
declare const DEFAULT_VERIFY_TIMEOUT_MS: number;
declare const DEFAULT_BUDGET: Readonly<BudgetConfig>;
declare const DEFAULT_MAX_DEPTH = 4;
declare const DEFAULT_MAX_CHILDREN = 8;
declare const DEFAULT_ALLOW_RUNTIME_DECOMPOSITION = true;
/** The shipped supervision backstop: three recovery rounds, two improvement rounds, eight coordination runs. A graph that runs an RSI loop declares its own round count over these (`maxImprovementRoundsFor`). */
declare const DEFAULT_SUPERVISION: Readonly<SupervisionConfig>;
interface RunBinding {
  storeId: string;
  taskId: TaskId;
  runId: RunId;
}
interface DriverEntry {
  readonly controller: AbortController;
  readonly promise: Promise<ChildOutcome[]>;
  /** The store this driver works in — how a graph-level cancellation finds it. */
  readonly storeId: string;
  /**
   * The parent task whose batch this driver works on, when it drives a batch.
   * Named here because a batch id is a pair
   */
  readonly parentTaskId?: TaskId;
}
interface StoreRecoveryState {
  /** `recovering` while the barrier runs, `ready` once it completed, `failed` when it threw. */
  status: 'recovering' | 'ready' | 'failed';
  /**
   * The barrier's own completion, never rejecting: a joining `adoptRoot` awaits
   * this and then re-reads {@link status} (and {@link failure}), so a failed
   */
  readonly promise: Promise<void>;
  /** Resolves the drivers this barrier registered: `true` starts them, `false` stands them down unstarted. */
  readonly release: (start: boolean) => void;
  readonly released: Promise<boolean>;
  /** The drivers this barrier registered but has not yet released to start. */
  readonly pendingDrivers: {
    key: string;
    controller: AbortController;
  }[];
  /**
   * The delivery-and-wake pass this barrier's {@link TaskRuntime.reconcileStore}
   * deferred (A4 §F.1's wake order): a `steer` or a notice reaches an idle
   */
  adoption?: RootAdoption;
  pendingQuestionDelivery?: () => Promise<void>;
  /**
   * The owner notices a pass deferred because the store was not ready yet
   * ({@link TaskRuntime.notifyWhenReady}): a notice is a `followup`, so it wakes
   */
  pendingNotices: {
    sessionId: string;
    text: string;
  }[];
  /**
   * Sessions this barrier's delivery pass already woke: the deferred owner
   * notices skip them, so no generic "continue" wake preempts the recovered input.
   */
  wokenSessions: Set<string>;
  /**
   * The end-of-batch results a driver raised while the store was `recovering`
   * ({@link TaskRuntime.deliverBatchResult}): the same wake-order rule as the
   */
  pendingBatchResults: BatchResultMessage[];
  /** Why a failed barrier failed, verbatim. */
  reason?: string;
  /** The original error a failed barrier threw. */
  failure?: unknown;
  /** A cancellation or the unload invalidated this barrier: it finishes its pass but leaves no ready handle. */
  cancelled?: boolean;
}
/** The live barrier's deferred work ({@link StoreRecoveryState} without its handles): what a read-only projection may serve. */
interface StoreRecoveryStateView {
  readonly wokenSessions: readonly string[];
  readonly pendingNotices: readonly {
    readonly sessionId: string;
    readonly text: string;
  }[];
  readonly pendingBatchResults: readonly BatchResultMessage[];
  readonly cancelled?: boolean;
}
//#endregion
//#region src/service/receipts.d.ts
/** The actor every receipt is written under; no caller may write one. */
declare const RECEIPT_ACTOR = "task-runtime:receipt";
/** How long the sealer waits for a session log to pass a run's terminal boundary. */
declare const RECEIPT_PERSIST_WAIT_MS = 2000;
/** What one sealing attempt settled as. */
type ReceiptSealStatus = {
  readonly status: 'sealed';
  readonly receipt: ExecutionReceipt;
} | {
  readonly status: 'already-sealed';
  readonly receipt: ExecutionReceipt;
} | {
  readonly status: 'not-terminal';
  readonly reason: string;
} | {
  readonly status: 'deferred';
  readonly reason: string;
} | {
  readonly status: 'unsupported';
  readonly reason: string;
};
/** What one flush or reconcile pass settled as. */
interface ReceiptReconcileReport {
  readonly sealed: readonly RunId[];
  readonly alreadySealed: number;
  readonly deferred: readonly {
    readonly runId: RunId;
    readonly reason: string;
  }[];
  readonly unsupported: readonly {
    readonly runId: RunId;
    readonly reason: string;
  }[];
}
//#endregion
//#region src/environment/store.d.ts
/** One library's identity and root: `$DSH_HOME/singularity/environments/<id>`. */
interface LibraryRoots {
  readonly id: string;
  readonly root: string;
}
/** A library root is derived from the graph's immutable root session identity; no second persistent binding. */
declare function libraryRoots(rootSessionId: string, home?: string): LibraryRoots;
declare function environmentProtocolMarker(library: LibraryRoots): string;
declare function revisionsRoot(library: LibraryRoots): string;
declare function draftsRoot(library: LibraryRoots): string;
/** The directory of one revision; the id is validated before it ever becomes a path component. */
declare function revisionRoot(library: LibraryRoots, revisionId: string): string;
/** fsync one directory so an entry created, renamed or removed inside it is durable. */
declare function syncDirectory(directory: string): Promise<void>;
/** Replace `target` with exactly `bytes`, durably: staging sibling, file fsync, rename, directory fsync. */
declare function writeFileAtomic(target: string, bytes: Buffer | string): Promise<void>;
/** Append one line to a JSONL log, durably: append, file fsync, directory fsync. */
declare function appendLineDurable(target: string, line: string): Promise<void>;
/** Create the two directories every library of the new protocol holds. */
declare function ensureEnvironmentLayout(library: LibraryRoots): Promise<void>;
/** The new-protocol marker, written once when a library's initial revision is created; a legacy layout never gets one. */
declare function ensureProtocolMarker(library: LibraryRoots): Promise<void>;
/** Whether this library root predates the revision protocol: no marker, but the old mutable layout's tell-tale entries. */
declare function hasLegacyLayout(library: LibraryRoots): Promise<boolean>;
declare function serialEnvironment<T>(library: LibraryRoots, work: () => Promise<T>): Promise<T>;
/** Read and fully validate one revision's manifest, including its self-digest. */
declare function readRevisionManifest(library: LibraryRoots, revisionId: string): Promise<EnvironmentRevisionManifest>;
/** Resolve one revision directory, or `undefined` when it does not exist. */
declare function readRevision(library: LibraryRoots, revisionId: string): Promise<EnvironmentRevision | undefined>;
/** List every revision of one library as listing projections, sorted by id. */
declare function listRevisions(library: LibraryRoots): Promise<EnvironmentRevisionRef[]>;
/** Write one manifest into its directory, durably; the manifest's self-digest is re-checked before a byte moves. */
declare function writeRevisionManifest(directory: string, manifest: EnvironmentRevisionManifest): Promise<void>;
/**
 * Freeze one draft into an immutable revision: an atomic same-filesystem rename,
 * then fsync of both the revisions directory and the library root, in that order —
 * a pointer may only ever be written after this returns.
 */
declare function freezeDraftDirectory(library: LibraryRoots, draftId: string, revisionId: string): Promise<void>;
/** Copy one revision directory as the starting content of a draft; a draft never edits its base in place. */
declare function copyRevisionDirectory(from: string, to: string): Promise<void>;
/** The defects one revision directory has against its manifest; empty means the directory is exactly what the manifest declares. */
interface RevisionDefects {
  readonly defects: readonly string[];
}
/**
 * Verify one whole revision directory against its manifest: every skill's bytes
 * and sidecar, every template file, and the capability table — the single check
 * that replaces the old commit path's per-file and per-row read-backs.
 */
declare function verifyRevisionDirectory(directory: string, manifest: EnvironmentRevisionManifest): Promise<RevisionDefects>;
/** Read one file of one skill inside one revision, through the verified walk: no links, no escapes, real entries only. */
declare function readRevisionSkillFile(revision: EnvironmentRevision, name: string, rel: string): Promise<Buffer>;
//#endregion
//#region src/environment/pointer.d.ts
/** The one active pointer of a library; `generation` increments on every switch and is the CAS dimension. */
interface EnvironmentPointer {
  readonly formatVersion: 1;
  readonly libraryId: string;
  readonly revisionId: string;
  readonly manifestDigest: string;
  readonly generation: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly approvalRef?: string;
}
/** The persistent record of an in-flight switch; exists only inside the switch window. */
interface EnvironmentPointerIntent {
  readonly formatVersion: 1;
  /** `${libraryId}/g<expected.generation+1>/<nextRevisionId>` — deterministic, so a replayed request names the same intent. */
  readonly intentId: string;
  readonly libraryId: string;
  readonly direction: 'publish' | 'rollback';
  /** The pointer this switch expects to replace; `null` only for a library's first revision. */
  readonly expected: {
    revisionId: string;
    generation: number;
  } | null;
  readonly next: {
    revisionId: string;
    manifestDigest: string;
  };
  readonly draftId?: string;
  readonly approvalRef?: string;
  readonly actor: string;
  readonly at: string;
}
/** One settled switch, appended to `completions.jsonl`. */
interface EnvironmentPointerCompletion {
  readonly formatVersion: 1;
  readonly intentId: string;
  readonly libraryId: string;
  readonly direction: 'publish' | 'rollback';
  readonly revisionId: string;
  readonly manifestDigest: string;
  readonly generation: number;
  readonly supersededRevisionId: string | null;
  readonly approvalRef?: string;
  readonly actor: string;
  readonly at: string;
}
/** The stages the transaction reports to a test probe, in order. */
type EnvironmentCommitStage = 'intent-recorded' | 'revision-frozen' | 'revision-verified' | 'pointer-switched' | 'completion-recorded' | 'intent-cleared';
/** The host a commit runs against; `probe` is a typed test seam a production deployment never sets. */
interface EnvironmentCommitHost {
  readonly library: LibraryRoots;
  probe?(stage: EnvironmentCommitStage, detail?: string): void | Promise<void>;
}
/** Where a published revision comes from: a draft (frozen by the transaction) or an already frozen revision. */
type EnvironmentPublishSource = {
  readonly kind: 'draft';
  readonly draftId: string;
} | {
  readonly kind: 'revision';
  readonly revisionId: string;
};
/** One requested switch. `expected` is the two-dimensional CAS: the caller must have read exactly this pointer. */
interface PublishRequest {
  readonly direction: 'publish' | 'rollback';
  readonly source: EnvironmentPublishSource;
  readonly expected: {
    revisionId: string;
    generation: number;
  };
  readonly approvalRef?: string;
  readonly actor: string;
}
/** The result of one settled switch. */
interface PublishOutcome {
  readonly pointer: EnvironmentPointer;
  readonly supersededRevisionId: string | null;
  readonly completion: EnvironmentPointerCompletion;
  /** `fresh` when this call ran the transaction; the other two name which step a reconcile had to redo. */
  readonly recovered: 'fresh' | 'completed-frozen' | 'completed-switched';
}
/** What `reconcileEnvironmentPointer` concluded about one open intent. */
interface EnvironmentPointerReconcile {
  readonly intentId: string;
  readonly direction: 'publish' | 'rollback';
  readonly result: 'completed-switched' | 'completed-frozen' | 'blocked';
  readonly revisionId: string;
  readonly detail?: string;
}
/** What the initial revision of a new-protocol library is seeded with. */
interface InitialSeed {
  readonly actor: string;
  readonly at?: string;
}
/** Read the current pointer, or `null` when the library has none yet (a fresh or a legacy root). */
declare function readPointer(library: LibraryRoots): Promise<EnvironmentPointer | null>;
/** The in-flight switch's intent, or `null` outside a switch window; the single concurrency exclusion point. */
declare function openPointerIntent(library: LibraryRoots): Promise<EnvironmentPointerIntent | null>;
/** Every settled switch of one library, in append order. */
declare function listPointerCompletions(library: LibraryRoots): Promise<EnvironmentPointerCompletion[]>;
/** The revision the pointer currently names; both must exist and agree, or the library is broken by name. */
declare function readActiveRevision(library: LibraryRoots): Promise<EnvironmentRevision>;
/**
 * Create the initial revision `r0001` of a new-protocol library, seeded with the
 * generic task-coordination guidance, and point at it (generation 1). A library
 * with the old mutable layout is refused by name: it enters the legacy read-only
 * view instead, and no `pointer.json` is ever created for it.
 */
declare function ensureInitialRevision(library: LibraryRoots, seed: InitialSeed): Promise<EnvironmentRevision>;
/** Publish a draft or a frozen candidate revision: one CAS-checked pointer switch. */
declare function publishEnvironmentRevision(host: EnvironmentCommitHost, request: PublishRequest): Promise<PublishOutcome>;
/** Roll back to a frozen revision: the same transaction, freezing skipped, target verified. */
declare function rollbackEnvironmentRevision(host: EnvironmentCommitHost, request: PublishRequest): Promise<PublishOutcome>;
/**
 * Settle every open intent of one library after a crash or at startup. The
 * classification reads only disk facts: a switched pointer is completed and
 * cleared, a frozen-but-unswitched intent is finished from step 7, an unfrozen
 * publish intent is redone from step 5, and a pointer moved by a third party
 * blocks the intent without touching anything.
 */
declare function reconcileEnvironmentPointer(host: EnvironmentCommitHost): Promise<EnvironmentPointerReconcile[]>;
//#endregion
//#region src/environment/draft.d.ts
/** A draft: the prospective candidate revision it holds, with its lineage and a human-readable edit log. */
interface EnvironmentDraft {
  readonly libraryId: string;
  readonly draftId: string;
  /** The revision this draft was copied from. */
  readonly basedOn: string;
  readonly root: string;
  /** The prospective revision this draft freezes into (`kind: 'candidate'`). */
  readonly manifest: EnvironmentRevisionManifest;
  readonly actor: string;
  readonly createdAt: string;
  readonly edits: readonly string[];
}
/** The listing projection of one draft. */
interface EnvironmentDraftRef {
  readonly draftId: string;
  readonly basedOn: string;
  readonly edits: number;
  readonly createdAt: string;
}
/**
 * Open a draft on top of a revision (the active one by default): a full copy of
 * the base's directory under `drafts/<draftId>` with a candidate manifest. A
 * legacy-layout library is refused by name — drafts belong to the new protocol.
 */
declare function createEnvironmentDraft(library: LibraryRoots, request: {
  basedOn?: string;
  actor: string;
  purpose?: string;
}): Promise<EnvironmentDraft>;
/** Read one draft, or `undefined` when it does not exist. */
declare function readEnvironmentDraft(library: LibraryRoots, draftId: string): Promise<EnvironmentDraft | undefined>;
/** List every draft of one library, sorted by id. */
declare function listEnvironmentDrafts(library: LibraryRoots): Promise<EnvironmentDraftRef[]>;
/** The newest draft one actor opened, when one exists. */
declare function latestDraftFor(library: LibraryRoots, actor: string): Promise<EnvironmentDraft | undefined>;
/**
 * Stage one edit into one draft: payload bytes first, then the manifest, then the
 * draft record — all under the library's single write tail, so concurrent stages
 * of one library serialize.
 */
declare function stageEnvironmentEdit(library: LibraryRoots, draftId: string, edit: EnvironmentEdit, table?: Readonly<Record<string, CapabilityConfig>>): Promise<EnvironmentDraft>;
/** Delete one draft's directory; a discarded draft cannot be published, because publishing reads the draft record first. */
declare function discardEnvironmentDraft(library: LibraryRoots, draftId: string): Promise<void>;
/**
 * Freeze one draft into an immutable candidate revision (`revisions/c-<draftId>`
 * unless the caller names another id). The pointer does not move: only a publish
 * switches it. This is the standalone entry an explicit trial uses; a publish
 * runs the same freeze inside its transaction.
 */
declare function freezeEnvironmentDraft(library: LibraryRoots, draftId: string, revisionId?: string): Promise<EnvironmentRevision>;
//#endregion
//#region src/service/environment.d.ts
/** Which protocol one library root is served under; `uninitialized` means neither layout exists yet. */
type EnvironmentProtocol = 'environment-revision' | 'legacy' | 'uninitialized';
/** One library resolved to the immutable roots a reader works in; no reader ever binds a mutable directory. */
interface EnvironmentLibrary {
  readonly id: string;
  readonly root: string;
  readonly protocol: EnvironmentProtocol;
  readonly taskTemplatesRoot: string;
  readonly skillRoot: string;
  readonly revision?: EnvironmentRevision;
}
/** What one reader sees of a library: the effective revision's identity plus its entries, never a mutable index. */
interface EnvironmentView {
  readonly libraryId: string;
  readonly revisionId: string;
  readonly generation: number;
  readonly manifestDigest: string;
  readonly trialCandidateRef?: string;
  readonly readOnly: boolean;
  readonly protocol: EnvironmentProtocol;
  readonly skills: readonly EnvironmentSkillEntry[];
  readonly taskTemplates: readonly EnvironmentTaskTemplateEntry[];
}
/** What one staged library edit answers: a draft holds the change, and nothing is in effect until a publish switches the pointer. */interface LibraryEditResult {
  readonly libraryId: string;
  readonly draftId: string;
  /** The candidate revision this draft freezes into. */
  readonly revisionId: string;
  readonly applied: 'draft';
  readonly message: string;
}
/** One library write a caller asks for: a task template, or the complete new bytes of a Skill. */
type LibraryWrite = {
  kind: 'task';
  template: TaskTemplate;
} | {
  kind: 'skill';
  name: string;
  skillMd: string;
  expectedVersion?: number;
};
/** One retention review a caller asks for: the status is a field of the revision the draft freezes into. */
interface LibraryReview {
  kind: 'task' | 'skill';
  name: string;
  version: number;
  status: 'retained' | 'retired';
  reason: string;
}
//#endregion
//#region src/service/runtime.d.ts
declare class TaskRuntime extends Service {
  static inject: string[];
  static Config: z<Config>;
  readonly config: Config;
  readonly sessions: Map<string, RunBinding>;
  readonly startedSessions: Set<string>;
  readonly drivers: Map<string, DriverEntry>;
  readonly replayLineage: Map<string, string>;
  readonly activeWorkerSessions: Set<string>;
  childAdmissionTail: Promise<void>;
  readonly capacityWaiters: Set<() => void>;
  readonly workspaceReleases: Set<Promise<void>>;
  readonly sessionWorkspaces: Map<string, string>;
  readonly sessionExecutionBindings: Map<string, {
    agentOptions?: AgentOptions;
    taskTemplatesRoot?: string;
    overlay?: ReplayOverlay;
  }>;
  readonly executionGate: ExecutionGate;
  readonly closingStores: Set<string>;
  readonly storeRecovery: Map<string, StoreRecoveryState>;
  readonly workspaces: WorkspaceRegistry;
  providerLoad?: Promise<ProviderLoadReport>;
  readonly parentChains: Map<string, Promise<void>>;
  /** Runs whose receipt is sealed but not yet written, per store: the queue a reconciliation pass drains. */
  readonly receiptSeals: Map<string, Set<string>>;
  /** One write tail per store for receipt sealing, so two settlements never seal the same store concurrently. */
  readonly receiptSealTails: Map<string, Promise<void>>;
  rootBudgetApproval?: RootBudgetApproval;
  readonly terminalReviewListeners: Set<(fact: TerminalReviewFact) => void | Promise<void>>;
  constructor(ctx: Context, config?: Partial<Config>);
  /** The immutable revision roots a session's graph library is served from; reading creates nothing. */
  libraryForRoot(rootSessionId: string): Promise<EnvironmentLibrary>;
  libraryForSession(sessionId: string): Promise<EnvironmentLibrary>;
  /** The active revision view of this session's graph library — a pure read, and the one version read every method tool shares. */
  activeEnvironmentView(sessionId: string, options?: {
    readonly trialCandidateRef?: string;
  }): Promise<EnvironmentView>;
  /** The active revision of this session's graph library; a legacy or uninitialized library is refused by name. */
  activeRevisionFor(sessionId: string): Promise<EnvironmentRevision>;
  /** The revision one run is bound to, or `undefined` on an old-protocol run. */
  environmentRevisionForRun(run: TaskRun): Promise<EnvironmentRevision | undefined>;
  /** Fix the initial revision of a brand-new graph before anything binds to it. */
  ensureInitialEnvironment(rootSessionId: string, actor: string): Promise<EnvironmentLibrary>;
  /** The retired task templates of a session's active revision, as `id@version` keys. */
  retiredTaskTemplates(sessionId: string): Promise<ReadonlySet<string>>;
  comparisonRunForSession(sessionId: string): Promise<TaskRun | undefined>;
  /** The library as a reader sees it: the effective revision's entries and identity, with no write of any kind. */
  libraryRead(sessionId: string): Promise<EnvironmentView & {
    taskTemplatesRoot: string;
    skillRoot: string;
  }>;
  /** Stage one library write into the caller's draft; the active revision does not move. */
  libraryWrite(sessionId: string, input: LibraryWrite): Promise<LibraryEditResult>;
  /** Stage one retention review into the caller's draft; retention decisions belong to the root or its supervisor. */
  libraryReview(sessionId: string, review: LibraryReview): Promise<LibraryEditResult>;
  /** The authority a temporary library write needs: the graph root, an active Run, or delegated method supervision. */
  private assertLibraryWriteAuthority;
  capabilitiesForSession(sessionId: string): Promise<Record<string, CapabilityConfig>>;
  skillViewForSession(sessionId: string, extraRoots?: readonly string[]): Promise<SkillDiscoveryView>;
  taskTemplatesRootFor(sessionId?: string): Promise<string | undefined>;
  findTaskTemplates(query?: string, callerSessionId?: string): Promise<TaskTemplateMatch[]>;
  /** Pure store reads: catalog queries never adopt a Run or alter its gate. */
  templateCaller(sessionId: string): Promise<{
    root: string | undefined;
    scope?: TemplateScope;
  }>;
  listTaskTemplates(request: TaskTemplateQuery, callerSessionId: string): Promise<TaskTemplateMatch | TaskTemplateCatalogPage>;
  registerTaskTemplate(template: TaskTemplate, callerSessionId?: string): Promise<_dangosys_dsh_singularity_task0.TaskTemplateRef>;
  unload(): Promise<void>;
  [Service.init](): Promise<void>;
  providerLoadReport(): Promise<ProviderLoadReport>;
  warn(message: string): void;
  get verifyTimeoutMs(): number;
  get budget(): Readonly<BudgetConfig>;
  get generatedTaskReview(): 'off' | 'all';
  get gate(): ExecutionGate;
  resolveCapabilities(required: readonly string[]): CapabilityManifest;
  listMcpServers(): Readonly<Record<string, McpServerTemplate>>;
  listCapabilities(): Readonly<Record<string, CapabilityConfig>>;
  /** Open a draft on the session's active revision; the only mutable region of a library. */
  createDraft(sessionId: string, request?: {
    basedOn?: string;
    purpose?: string;
  }): Promise<EnvironmentDraft>;
  /** Stage one environment edit into one draft. */
  stageDraftEdit(sessionId: string, draftId: string, edit: EnvironmentEdit): Promise<EnvironmentDraft>;
  /** Remove one draft; a removed draft can no longer be published. */
  removeEnvironmentDraft(sessionId: string, draftId: string): Promise<void>;
  /** Freeze one draft into a candidate revision without moving the pointer — the entry an explicit trial binds. */
  freezeDraft(sessionId: string, draftId: string): Promise<EnvironmentRevision>;
  /** Switch the effective pointer to one draft or frozen revision, under an expected-pointer CAS. */
  publishRevision(sessionId: string, request: PublishRequest): Promise<PublishOutcome>;
  /** Switch the effective pointer back to a frozen revision. */
  rollbackRevision(sessionId: string, request: PublishRequest): Promise<PublishOutcome>;
  /** Settle any pointer intent a killed process left open. */
  reconcilePointer(sessionId: string): Promise<EnvironmentPointerReconcile[]>;
  /** The in-flight pointer switch of the session's library, or `null`; the single admission exclusion point. */
  openPointerIntent(sessionId: string): Promise<EnvironmentPointerIntent | null>;
  listRevisions(sessionId: string): Promise<EnvironmentRevisionRef[]>;
  /** The legacy mutable layout read as a read-only view: no index rebuilt, no byte written. */
  legacyLibraryView(sessionId: string): Promise<EnvironmentView>;
  /** The one write tail of a library, for a caller that stages several edits as one unit. */
  serializeEnvironment<T>(rootSessionId: string, work: () => Promise<T>): Promise<T>;
  adoptRoot(storeId: string, rootSessionId: string): Promise<RootAdoption>;
  initializeStoreGates(storeId: string): Promise<void>;
  runGatePhase(run: TaskRun): ExecutionPhase | 'terminal' | undefined;
  intakeRootContract(storeId: string, rootSessionId: string, spec: RootContractSpec, options?: RootIntakeOptions): Promise<RootIntakeResult>;
  submitRootContractProposal(storeId: string, rootSessionId: string, spec: RootContractSpec, options?: RootIntakeOptions): Promise<ProposalSubmission>;
  decomposeAndRun(storeId: string, parentTaskId: TaskId, parentRunId: RunId, callerSessionId: string, spec: DecomposeSpec, exec?: {
    signal?: AbortSignal;
    callId?: string;
  }): Promise<DecomposeAdmissionResult>;
  submitDecompositionProposal(storeId: string, parentTaskId: TaskId, parentRunId: RunId, callerSessionId: string, spec: DecomposeSpec, options?: DecomposeProposalOptions): Promise<ProposalSubmission>;
  continueProposal(storeId: string, proposalId: string, caller: string, options?: {
    spec?: DecomposeSpec;
    exec?: {
      callId?: string;
    };
  }): Promise<ProposalContinuation>;
  decideProposal(storeId: string, proposalId: string, decision: {
    outcome: TaskProposalDecisionOutcome;
    reason?: string;
    decidedAt?: string;
  }, decidedBy: string, exec?: {
    callId?: string;
  }): Promise<ProposalDecisionResult>;
  cancelProposal(storeId: string, proposalId: string, caller: string): Promise<ProposalDecisionResult>;
  proposalIn(storeId: string, proposalId: string): Promise<TaskProposal>;
  proposalsForParent(storeId: string, parentTaskId: TaskId): Promise<TaskProposal[]>;
  registerRootBudgetApproval(approval: RootBudgetApproval): () => void;
  registerTerminalReviewListener(listener: (fact: TerminalReviewFact) => void | Promise<void>): () => void;
  notifyTerminalReview(fact: TerminalReviewFact): void;
  /** Seal one Run's execution receipt. The store's own check decides; a repeat is `already-sealed`. */
  sealRunReceipt(storeId: string, taskId: TaskId, runId: RunId): Promise<ReceiptSealStatus>;
  /**
   * Seal one receipt as part of a settlement: awaited, bounded by the sealer's
   * own limits, and never throwing — an unsealed receipt is queued for the next
   * recovery pass rather than turning a settlement into a failure.
   */
  sealReceiptBounded(storeId: string, taskId: TaskId, runId: RunId): Promise<void>;
  /** Advance every queued seal of one store. */
  flushReceiptSeals(storeId: string): Promise<ReceiptReconcileReport>;
  /** Seal every terminal new-protocol Run of one store that has no receipt yet. */
  reconcileRunReceipts(storeId: string): Promise<ReceiptReconcileReport>;
  receiptFor(storeId: string, runId: RunId): Promise<ExecutionReceipt | undefined>;
  receiptsOfStore(storeId: string): Promise<readonly ExecutionReceipt[]>;
  extendRootBudget(sessionId: string, host: RootBudgetExtensionHost, request: RootBudgetExtensionRequest): Promise<RootBudgetExtensionResult>;
  recoverRootTask(storeId: string, request: RootRecoveryRequest, caller: RootRecoveryCaller): Promise<RootRecoveryOutcome>;
  deriveBatch(identity: DecompositionIdentityContext, spec: DecomposeSpec): Promise<{
    ok: true;
    batch: NormalizedBatch;
    envPath?: string;
  } | {
    ok: false;
    refusal: DecompositionRefusal;
  }>;
  manifestsOf(batch: NormalizedBatch, callerSessionId?: string): Promise<CapabilityManifest[]>;
  storedBatchOf(proposal: TaskProposal): NormalizedBatch;
  decompositionState(sessionId: string): Promise<{
    reasons: string[];
    remainingRuns?: number | undefined;
    canDecompose: boolean;
    depth: number;
    maxDepth: number;
    phase: string;
  }>;
  assertDecomposableRun(storeId: string, parentTask: TaskInstance, parentRun: TaskRun, callerSessionId: string, signal?: AbortSignal): Promise<void>;
  inFlightProposalsOf(storeId: string, parentRunId: RunId): Promise<TaskProposalDecomposition[]>;
  checkDerivedBatch(request: CheckDerivedBatchRequest): Promise<DecompositionPrecheck>;
  admitPrecheckedBatch(request: AdmitBatchRequest): Promise<{
    batchId: string;
    childTaskIds: TaskId[];
  }>;
  existingRootTask(storeId: string): Promise<TaskInstance | undefined>;
  continueRootProposalIn(storeId: string, proposal: TaskProposalRoot): Promise<ProposalContinuation>;
  serializeRootIntake<T>(storeId: string, work: () => Promise<T>): Promise<T>;
  continueProposalIn(storeId: string, proposalId: string, caller: string, options: {
    spec?: DecomposeSpec;
    exec?: {
      callId?: string;
    };
  }): Promise<ProposalContinuation>;
  staleProposal(storeId: string, proposal: TaskProposal, reason: string): Promise<ProposalContinuation>;
  expireProposal(storeId: string, proposal: TaskProposal, reason: string): Promise<ProposalContinuation>;
  requireProposal(storeId: string, proposalId: string): Promise<TaskProposal>;
  readProposal(storeId: string, proposalId: string): Promise<TaskProposal | undefined>;
  requestProposalReview(request: ReviewSubject): Promise<{
    requested: boolean;
    detail: string;
  }>;
  serializeParent<T>(storeId: string, parentTaskId: TaskId, work: () => Promise<T>): Promise<T>;
  reconcileProposals(storeId: string): Promise<ReconcileReport['unresolvedProposals']>;
  reconcileRootProposal(storeId: string, proposal: TaskProposalRoot, report: (proposal: TaskProposal, status: TaskProposalStatus, reason: string) => Promise<void>): Promise<void>;
  replayTask(storeId: string, championTaskId: TaskId, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>;
  registerDriver(key: string, storeId: string, controller: AbortController, promise: Promise<ChildOutcome[]>, parentTaskId?: TaskId): void;
  standDownPendingDrivers(state: StoreRecoveryState): void;
  invalidateStoreRecovery(storeId: string): void;
  batchRecordIn(storeId: string, batchId: string): Promise<{
    taskId: TaskId;
    run: TaskRun;
    memberTaskIds: readonly TaskId[];
  } | undefined>;
  runSettledFromRuntime(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void;
  startBatchDriver(options: StartBatchDriverOptions): void;
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
  askParentQuestion(callerSessionId: string, request: ParentAskCall): Promise<AskedQuestionOutcome>;
  answerParentQuestion(callerSessionId: string, request: ParentAnswerCall): Promise<AnsweredQuestionOutcome>;
  questionCoordination(): QuestionCoordinationDeps;
  cancelBatch(storeId: string, batchId: string, callerSessionId: string): Promise<ChildOutcome[]>;
  cancelGraph(storeId: string, reason: string): Promise<void>;
  awaitBatch(storeId: string, batchId: string): Promise<ChildOutcome[]>;
  reconcileStore(storeId: string, rootSessionId?: string): Promise<ReconcileReport>;
  wakeUnclaimedQuestionMessages(storeId: string, deliveries: readonly QuestionReconcileReport[]): Promise<void>;
  wakeUnclaimedBatchResults(unread: readonly {
    sessionId: string;
    messageId: string;
  }[]): void;
  sessionHoldsPendingMessage(sessionId: string, messageId: string): boolean;
  resumeAdoptedWorkerSession(request: AdoptedWorkerResumeRequest): Promise<AdoptedWorkerResume>;
  rebuildWorkspaceOwnership(storeId: string): Promise<void>;
  releaseStoreWorkspace(storeId: string): Promise<void>;
  failBatch(storeId: string, batchId: string, reason: string): Promise<void>;
  recoverySessionFor(snapshot: TaskSnapshot | undefined, storeId: string): string;
  sessionForStore(storeId: string): Promise<string>;
  runForSession(sessionId: string): Promise<{
    storeId: string;
    task: TaskInstance;
    run: TaskRun;
  }>;
  allowsRuntimeDecomposition(): boolean;
  gatePhaseFromStore(sessionId: string, run: TaskRun, storeId: string, token: number): void;
  recoveryStatus(storeId: string): Promise<StoreRecoveryStatus>;
  /** The live barrier's deferred work; a store this process holds no barrier for has none to show. */
  recoveryState(storeId: string): StoreRecoveryStateView | undefined;
  assertRecoveryReady(storeId: string, entry: string): Promise<void>;
  reindex(storeId: string, snapshot: TaskSnapshot): void;
  workspacePathForSession(sessionId: string): Promise<string | undefined>;
  workspacePathFor(sessionId: string): Promise<string | undefined>;
  assertWorkspaceHeldBy(workspace: string, storeId: string, parentTask: TaskInstance, parentRunId: RunId): Promise<void>;
  notify(sessionId: string, text: string): void;
  notifyWhenReady(sessionId: string, text: string): void;
  deliverBatchResult(message: BatchResultMessage): Promise<BatchResultDeliveryStatus>;
  deliverBatchResultNow(message: BatchResultMessage): Promise<BatchResultDeliveryStatus>;
  redeliverBatchResult(storeId: string, batchId: string): Promise<BatchResultDeliveryStatus>;
  reconcileSessionJobs(sessionId: string): Promise<void>;
  admissionContext(): AdmissionContext;
  envPathForSession(sessionId: string): Promise<string | undefined>;
  contractRefusal(parentTaskId: TaskId, reasons: readonly string[]): Error;
  orchestrateEnv(callerSessionId: string, actor: string, workspace?: string, overlay?: ReplayOverlay): Promise<OrchestrateEnv>;
  watchRun(storeId: string, runId: RunId, callback: (status: RunStatus) => void): () => void;
  sessionBoundInProcess(storeId: string, runId: RunId): string | undefined;
  releaseRunWorkspaceLayer(storeId: string, runId: RunId, sessionId: string): Promise<void>;
  observeSession(sessionId: string): Promise<SessionObservation | undefined>;
  softService<T>(name: string): T | undefined;
  registeredVerifierIds(): Promise<readonly string[] | undefined>;
  providerPrecheck(capabilities: readonly string[], view: SkillDiscoveryView, table?: Readonly<Record<string, CapabilityConfig>>, mcpRegistry?: Readonly<Record<string, McpServerTemplate>>, callerSessionId?: string): Promise<ProviderPrecheck>;
  capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheck>;
  readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined>;
  assertKnownVerifierRefs(declared: readonly {
    childIndex: number;
    criterion: AcceptanceCriterion;
  }[], what: string): Promise<void>;
  liveAgent(sessionId: string): Agent;
  agentOrUndefined(sessionId: string): Agent | undefined;
  /** Public alias of the protected `Service.ctx` for the extracted modules. */
  get context(): Context;
}
//#endregion
//#region src/admission.d.ts
/**
 * Structural defects of one task's acceptance contract (T1, construction guide
 * §4): what has to hold before a contract can be admitted at all, whichever
 */
declare function contractDefects(criteria: readonly AcceptanceCriterion[], label: string): string[];
//#endregion
//#region src/proposal.d.ts
/**
 * Whether one proposal is still in flight for the task that made it —
 * submitted and not yet admitted, not yet decided, or decided and not yet
 */
declare function isOpenProposal(proposal: TaskProposal): boolean;
/**
 * The open proposal of one run, or `undefined` — §7.4's "已知等待": a run whose
 * own batch is waiting for a review (or for the admission its approval
 */
declare function openProposalOf(snapshot: TaskSnapshot, taskId: string, runId: string): TaskProposal | undefined;
//#endregion
//#region src/protected-inputs.d.ts
/**
 * Fix the byte identity of every declared protected input, against the
 * checkout directory the criterion's judge will run in.
 */
declare function fixProtectedInputs(paths: readonly string[], cwd: string | undefined, label: string): Promise<{
  refs: ProtectedInputRef[];
  reasons: string[];
}>;
/**
 * Fix the declared protected inputs of a whole decomposition proposal before
 * anything else reads it: the runtime calls this ahead of the single
 */
declare function fixSpecProtectedInputs(spec: DecomposeSpec, cwd: string | undefined): Promise<{
  spec: DecomposeSpec;
  reasons: string[];
}>;
/**
 * Structural defects of the **fixed** form of every criterion's protected
 * inputs: each declaration must be an array of plain objects carrying exactly
 */
declare function protectedInputDefects(criteria: readonly AcceptanceCriterion[], label: string): string[];
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
 */
declare function parseObligationTemplates(text: string, source: string): ObligationTemplate[];
/**
 * Walk up from `start` to the directory holding `.git` (the same semantics as
 * skill-filesystem's findProjectRoot, here with an 8-level cap so a detached
 */
declare function findRepoRoot(start: string, maxLevels?: number): Promise<string | undefined>;
/**
 * Load every `<repoRoot>/.agents/skills/<name>/references/obligations.yml`, in directory
 * order. A pack without the file contributes nothing; an absent skills root
 */
declare function loadObligationTemplates(repoRoot: string): Promise<ObligationTemplateFile[]>;
/** A domain obligation is satisfied only by a matching criterion in the latest verified run's evidence. */
declare function checkObligationCoverage(templates: readonly ObligationTemplate[], snapshot: TaskSnapshot): ObligationCoverage;
//#endregion
//#region src/service/root-recovery.d.ts
/** The round before one attempt as a notice for the new attempt's own session: criterion verdicts and effort facts, read from the store. */
declare function priorRoundNotice(snapshot: TaskSnapshot, source: TaskInstance, sourceRun: TaskRun): string | undefined;
/** The same notice for a run the store resumed: the attempt's own recovery record names the round before it. */
declare function priorRoundNoticeForRun(snapshot: TaskSnapshot, run: TaskRun): string | undefined;
//#endregion
//#region src/service/bubble.d.ts
/**
 * Bubble materialization and settlement: one RSI round's isolated workspace.
 *
 * A bubble is a fresh clone of every environment component at one round's
 * branch, plus the round's method volume. It hides the environment checkout and
 * `$DSH_HOME` from the round's agents: what a bubble was materialized with is
 * all a round can see, so a round cannot read the mother port's dirty tree or a
 * previous round's state.
 *
 * @module @dangosys/dsh-singularity-task-runtime/bubble
 */
/** The absolute path of one round's bubble workspace, whether or not it has been materialized. */
declare function bubbleWorkspacePath(dshHome: string, rootSessionId: string, round: number): string;
/**
 * The workspace of the graph's latest materialized round, or `undefined` when
 * this graph has no bubble at all. A restarted deployment re-pins an adopted
 * root here: the round's bubble is where its Runs work, and without the mapping
 * the runtime falls back to the environment checkout the bubble was cloned from.
 */
declare function latestBubbleWorkspacePath(dshHome: string, rootSessionId: string): string | undefined;
/**
 * Materialize one round's bubble workspace: every environment component cloned
 * at `rsi/<graphId>/round-<N-1>` (round 1 folds the environment into `round-0`
 * first), plus the method volume and the round's manifest. Idempotent: a
 * manifest already naming this round returns its workspace untouched.
 */
declare function materializeBubble(envPath: string, dshHome: string, rootSessionId: string, graphId: string, round: number): Promise<string>;
/**
 * Settle one round's bubble: commit each component's work on the bubble and
 * push it to `rsi/<graphId>/round-<N>` on the environment's own repo, so the
 * next round's materialization can read it. A component with nothing to commit
 * still has its branch published. Returns each component's new SHA.
 */
declare function settleBubble(envPath: string, workspacePath: string, graphId: string, round: number): Promise<Record<string, string>>;
//#endregion
//#region src/verified-read.d.ts
/**
 * Reading files without following a link: the one implementation of "a path
 * under a root, walked one component at a time through `lstat`".
 */
/**
 * Where a component walk under a root stopped. The walk is split from the read
 * so a caller that records "absent" can tell it apart from a path that changed
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
 */
declare function walkVerified(root: string, rel: string): Promise<VerifiedWalk>;
/**
 * Read the file at `rel` under `root` as raw bytes, refusing anything but a
 * real regular file: the entry itself and every ancestor between `root` and it
 */
declare function readVerifiedFile(root: string, rel: string): Promise<Buffer>;
//#endregion
//#region src/orchestration/batch.d.ts
/**
 * Drive one admitted batch to settlement (A3 §3.1): reentrant, store-driven,
 * and owned by the runtime rather than by the tool call that admitted it.
 */
declare function driveBatch(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]>;
//#endregion
//#region src/orchestration/verify.d.ts
/**
 * The L4 exit pointer (KISS §7, VRTC plan phase 3.1), appended to the feedback
 * a root agent reads at each of the three trigger sites. The escalation ledger
 */
declare function escalationHint(what: string, tried: string, suggested: string): string;
//#endregion
//#region src/orchestration/observe.d.ts
/**
 * The end-of-batch results one store's own facts still owe (K1 §2, §5).
 * A run that is `active` has no unfinished batch — `waiting_children → active`
 */
declare function owedBatchResults(snapshot: TaskSnapshot): OwedBatchResult[];
//#endregion
//#region src/orchestration/settlement.d.ts
/**
 * ------------------------------------------------------------------------- *
 * Settlements the runtime drives from the outside (§3.6)
 */
/**
 * Settle one run terminal from outside the orchestration — a graph removal, or
 * a recovery pass that refuses to continue a run — with the same terminal-record
 */
declare function settleRunFromRuntime(env: RuntimeSettlementEnv, storeId: string, run: TaskRun, status: 'cancelled' | 'failed', reason: string): Promise<void>;
//#endregion
//#region src/session-facts.d.ts
/** The human-facing tools: calling one is a person's intervention, not the worker's own work. */
declare const HUMAN_TOOLS: ReadonlySet<string>;
/** One calling configuration and how many requests the session made under it. */
interface ModelRequestFact {
  readonly identity: ReceiptRequestIdentity;
  readonly count: number;
}
/** One `task_decompose` call a session made, with the text its successful result carried. */
interface DecompositionCallFact {
  readonly callId: string;
  readonly arguments: string;
  /** The matching `tool/result`'s text, when the call succeeded and the result carried text. */
  readonly resultText?: string;
}
/** Everything one persisted session log says, in the one shape every reader consumes. */
interface SessionFacts {
  /** Whole-session token buckets from the session's `tokenUsage` projection, when the caller could read one. */
  readonly tokens?: ReviewTokenUsage;
  /** Tool traffic the log shows; absent when no log was readable. */
  readonly toolCalls?: {
    readonly calls: readonly ReviewToolCall[];
    readonly failures: number;
  };
  /** Skill names the session really loaded (a successful `skill` call, or a `task-skills` injection), in order, duplicates preserved. */
  readonly skillCalls?: readonly string[];
  readonly humanInterventions?: number;
  readonly compactions?: number;
  /** Distinct request identities in first-appearance order. */
  readonly modelRequests?: readonly ModelRequestFact[];
  /** The session's `task_decompose` calls. */
  readonly decompositions?: readonly DecompositionCallFact[];
  /** Events the persisted log held; `undefined` means no log could be read at all (which is not the same as an empty log). */
  readonly logEvents?: number;
  /** The last event's time as an ISO timestamp (the log's own `time` is epoch milliseconds), for judging whether it has already passed a run's terminal boundary. */
  readonly lastEventAt?: string;
}
/** Whether one tool result reported a failure. */
declare function toolResultFailed(data: {
  error?: unknown;
  message?: {
    isError?: boolean;
  };
}): boolean;
/** The `name` a `skill` tool call asked to load, when its arguments name one. */
declare function skillNameFrom(rawArguments: string): string | undefined;
/** Parse one session's events and token reading into the facts every reader consumes. One parse, one meaning. */
declare function sessionFactsOf(events: readonly SessionEvent[], tokens?: ReviewTokenUsage): SessionFacts;
//#endregion
//#region src/receipt.d.ts
/** What the sealer hands the builder: the store's own records plus the session facts it gathered. */
interface ReceiptBuildInput {
  readonly storeId: string;
  readonly snapshot: TaskSnapshot;
  readonly run: TaskRun;
  readonly drain: 'in-process' | 'reconciled' | 'unconfirmed';
  /** Session facts per run of the sealed subtree; a missing entry means no log could be read for that run. */
  readonly sessionFacts: ReadonlyMap<RunId, SessionFacts>;
  /** The environment revision this run is bound to, with its manifest digest. */
  readonly revision: RevisionPin;
  readonly sealedAt: string;
}
/** What one build attempt settled as; `refused` names a missing precondition and the sealer retries later. */
type ReceiptBuildResult = {
  readonly status: 'built';
  readonly receipt: ExecutionReceipt;
} | {
  readonly status: 'refused';
  readonly reason: string;
};
/** The execution subtree one run froze: itself first, then every descendant, in store order. */
declare function executionSubtree(snapshot: TaskSnapshot, runId: RunId): readonly RunId[];
/** Build one Run's receipt from the store's records and the session facts handed in. */
declare function buildExecutionReceipt(input: ReceiptBuildInput): ReceiptBuildResult;
/** The execution usage one receipt covers: the口径 of a run subtree's tokens and tool calls. */
interface ExecutionUsage {
  readonly status: 'reported' | 'unknown';
  readonly reason?: string;
  readonly runIds: readonly string[];
  readonly tokens?: ReviewTokenUsage;
  readonly toolCalls?: {
    readonly calls: number;
    readonly failures: number;
  };
  /** Runs whose counters are not terminal or not whole numbers, for diagnosis. */
  readonly incompleteRuns: readonly string[];
}
/**
 * Aggregate a sealed subtree's usage from the store's review metrics — never by
 * walking `parentRunId` now: the members are the ones the receipt froze, so a
 * later replay cannot be counted into a run that had already settled.
 */
declare function executionUsage(snapshot: TaskSnapshot, receipt: ExecutionReceipt): ExecutionUsage;
/** Refuse a receipt that cannot establish the facts a consumer needs, naming them. */
declare function requireReceiptFacts(receipt: ExecutionReceipt, facts: readonly ReceiptMissingFact[], where: string): void;
//#endregion
//#region src/replay-paths.d.ts
/** Relocate declared workspace paths, retaining every other contract value. */
declare function rebaseWorkspacePaths<T>(value: T, from: string, to: string): T;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    taskRuntime: TaskRuntime;
  }
}
/** This package's producer kind: every notice `notify()` / `appendNotice()` sends carries it. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'task-runtime': {
      kind: 'task-runtime';
    } & ContextFormed;
  }
}
//#endregion
export { type AnsweredQuestionOutcome, type AskedQuestionOutcome, type BatchContext, type CapabilityConfig, type CapabilityProviderPrecheck, type CapabilityRowEdit, type CapabilityToolQuery, type ChildOutcome, type Config, type CriterionSpec, DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_SUPERVISION, DEFAULT_VERIFY_TIMEOUT_MS, type DecomposeAdmissionResult, type DecomposeChildSpec, type DecomposeSpec, type DecompositionCallFact, type DecompositionReviewRequest, ENVIRONMENT_DRAFT_ID, ENVIRONMENT_REVISION_ID, type EnvironmentCapabilityEntry, type EnvironmentCommitHost, type EnvironmentCommitStage, type EnvironmentDraft, type EnvironmentDraftRef, type EnvironmentEdit, type EnvironmentLibrary, type EnvironmentPointer, type EnvironmentPointerCompletion, type EnvironmentPointerIntent, type EnvironmentPointerReconcile, type EnvironmentProtocol, type EnvironmentPublishSource, type EnvironmentReview, type EnvironmentRevision, type EnvironmentRevisionManifest, type EnvironmentRevisionRef, type EnvironmentSkillEntry, type EnvironmentTaskTemplateEntry, type EnvironmentView, ExecutionGate, type ExecutionUsage, HUMAN_TOOLS, type InitialSeed, IterationCapRefusal, type LibraryEditResult, type LibraryReview, type LibraryRoots, type LibraryWrite, type McpServerTemplate, type ModelRequestFact, type NormalizedBatch, type OrchestrateEnv, type ProposalContinuation, type ProposalReviewChannel, type ProposalReviewNotice, type ProposalReviewRequest, type ProposalSubmission, type ProviderPrecheck, type PublishOutcome, type PublishRequest, RECEIPT_ACTOR, RECEIPT_PERSIST_WAIT_MS, type ReceiptBuildInput, type ReceiptBuildResult, type ReceiptReconcileReport, type ReceiptSealStatus, type RecoveryMode, type RecoveryRounds, type ReplayReceiptReport, type ReplayRunOutcome, type ReplayTaskOptions, type RevisionDefects, type RootBudgetApproval, type RootBudgetApprovalAsk, type RootBudgetApprovalDecision, type RootBudgetExtensionHost, type RootBudgetExtensionRequest, type RootBudgetExtensionResult, type RootContractReviewRequest, type RootContractSpec, type RootIntakeResult, type RootRecoveryCaller, type RootRecoveryOutcome, type RootRecoveryRequest, type RunBindingRead, SKILL_SIDECAR_FILE, SUPPORTED_SKILL_RESOURCE_DIRS, type SessionFacts, type SkillEdit, type SkillProviderCandidate, type SkillProviderVerdict, type SkillSidecar, type StoreRecoveryStateView, type StoreRecoveryStatus, type SupervisionConfig, TOOL_LABELS, TaskRuntime, type TaskRuntime as TaskRuntimeService, TaskRuntime as default, TaskTemplateCatalogPage, TaskTemplateMatch, TaskTemplateQuery, type TemplateEdit, type TerminalReviewFact, VerifierUnavailableError, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WorkspaceBusyError, type WorkspaceOwner, WorkspaceRegistry, appendLineDurable, applyCapabilityRowEdit, applyReviewEdit, applySkillEdit, applyTemplateEdit, assertDraftEditAllowed, bindRunProviders, bindTaskDecomposition, bindTaskTemplate, bubbleWorkspacePath, buildExecutionReceipt, candidateRevisionId, capabilityToolQuery, checkObligationCoverage, checkRunStart, contractDefects, copyRevisionDirectory, createEnvironmentDraft, decompositionIdentity, defaultTaskTemplatesRoot, discardEnvironmentDraft, draftsRoot, driveBatch, emptyRevisionManifest, ensureEnvironmentLayout, ensureInitialRevision, ensureProtocolMarker, environmentProtocolMarker, escalationHint, executionProviders, executionSubtree, executionUsage, findRepoRoot, findTaskTemplates, fixProtectedInputs, fixSpecProtectedInputs, freezeDraftDirectory, freezeEnvironmentDraft, hasLegacyLayout, inFlightRecoveryAttempt, isOpenProposal, latestBubbleWorkspacePath, latestDraftFor, libraryRoots, listEnvironmentDrafts, listPointerCompletions, listRevisions, loadObligationTemplates, loadSkillSidecar, manifestDigest, materializeBubble, mcpServerBindings, normalizeDecomposition, normalizeRootContract, openPointerIntent, openProposalOf, optionalService, owedBatchResults, parseMcpServerRegistry, parseObligationTemplates, parseRevisionManifest, parseSkillFile, parseTaskTemplate, precheckProviders, precheckReplacedCapabilityRow, priorRoundNotice, priorRoundNoticeForRun, protectedInputDefects, providerRefusals, publishEnvironmentRevision, readActiveRevision, readEnvironmentDraft, readPointer, readRevision, readRevisionManifest, readRevisionSkillFile, readVerifiedFile, rebaseWorkspacePaths, reconcileEnvironmentPointer, recoveryAttemptWithKey, recoveryKindOf, recoveryModeOf, recoveryRoundsOf, recoverySourceRun, registerTaskTemplate, registeredVerifierIds, registeredVerifierVocabulary, registryRevision, requireReceiptFacts, resolveCapabilities, resolveMcpServerSpecs, resolveRootBudget, revisionCapabilityRows, revisionRefOf, revisionRoot, revisionSkillOf, revisionTemplateOf, revisionsRoot, rollbackEnvironmentRevision, serialEnvironment, serializeSkillSidecar, sessionFactsOf, settleBubble, settleRunFromRuntime, sidecarWithSkillMd, skillContentDigest, skillContractDefects, skillContractDigest, skillNameFrom, skillSearchRoots, stageEnvironmentEdit, syncDirectory, taskTemplatePage, toolResultFailed, unlistableVerifierRefusal, validateSkillProvider, verifyRevisionDirectory, walkVerified, workerBaseline, writeFileAtomic, writeRevisionManifest };
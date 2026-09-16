import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, ArtifactRef, CapabilityManifest, DependencyEdge, EvidenceBundle, RunId, TaskHandoff, TaskId, TaskInstance, TaskRun, TaskService, VerificationMode } from "@dangosys/dsh-singularity-task";
import { AgentHandle } from "@deepseek-ai/dsh-agent";

//#region src/capability.d.ts
/** One capability entry as held in plugin Config (arrays optional pre-validation). */
interface CapabilityConfig {
  skills?: string[];
  tools?: string[];
  preset?: string;
}
/**
 * Resolve required capability names against the configured registry.
 * A required name that has an entry contributes its skills/tools/preset to the
 * manifest; a name without an entry lands in `missing`. Closure is `closed`
 * when nothing is missing, otherwise `gap`.
 */
declare function resolveCapabilities(required: readonly string[], registry: Readonly<Record<string, CapabilityConfig>>): CapabilityManifest;
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
  signal?: AbortSignal;
}
/** Per-call overrides the cascade forwards on every verifier call (ticket C2's `VerifyRunOptions`). */
interface VerifyRunOptions {
  /** Working directory for criterion commands — the env checkout the workers ran in. */
  cwd?: string;
  /** The verifier's own deadline for this call; the verifier kills whatever it started. */
  timeoutMs?: number;
}
/** The service-supplied seam the cascade runs against (keeps this module free of cordis types). */
interface OrchestrateEnv {
  task: TaskService;
  actor: string;
  defaultPreset?: string;
  verifyTimeoutMs: number;
  spawn(request: SpawnChildRequest): Promise<AgentHandle>;
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  onRunBound(sessionId: string, binding: {
    storeId: string;
    taskId: TaskId;
    runId: RunId;
  }): void;
}
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
//#endregion
//#region src/admission.d.ts
/** Parent task plus the decomposition policy its definition grants. */
interface AdmissionParent extends TaskInstance {
  decompositionPolicy: {
    allowed: boolean;
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
}
type AdmissionVerdict = {
  ok: true;
} | {
  ok: false;
  reasons: string[];
};
/**
 * Structural admission checks for one decomposition batch (RFC §36). Pure:
 * every rule is validated up front and the caller persists only when the
 * verdict is `ok`, so admission is atomic for the whole batch.
 */
declare function checkDecomposition(parent: AdmissionParent, children: readonly AdmissionChild[], existingEdges: readonly DependencyEdge[]): AdmissionVerdict;
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
/** Envelope passed from a parent run to the child it delegates to (RFC §18). */
declare function buildHandoff(init: HandoffInit): TaskHandoff;
/**
 * Render the worker prompt for a delegated child task. Compact on purpose:
 * objective, the acceptance criteria table (with verifier commands), the
 * handoff envelope, the pointer to the delegating session, the decomposable
 * reminder when the child may split further, and the rules — a few thousand
 * tokens at most.
 */
declare function renderWorkerPrompt(handoff: TaskHandoff, childTask: TaskInstance): string;
//#endregion
//#region src/index.d.ts
/** Local view of the verifier service (ticket C2 develops it in parallel): the
 * runtime resolves it softly from the context and never imports the package. */
interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
}
interface CriterionSpec {
  description: string;
  command?: string;
  mode?: VerificationMode;
  mandatory?: boolean;
  requiredEvidence?: string[];
}
interface DecomposeChildSpec {
  objective: string;
  acceptanceCriteria: readonly CriterionSpec[];
  requiredCapabilities?: readonly string[];
  dependsOn?: readonly number[];
  /**
   * The caller declares this child may decompose itself (RFC §36: the agent
   * admits it so its own worker keeps the option to split further). A missing
   * required capability forces `decomposable` on its own; the declaration is
   * what makes a child with no gap decomposable.
   */
  decomposable?: boolean;
}
interface DecomposeSpec {
  children: readonly DecomposeChildSpec[];
  reason: string;
}
interface Config {
  /** Capability registry: name → skills/tools/preset granted when a task requires it. */
  capabilities: Record<string, CapabilityConfig>;
  /** Agent preset used when no matched capability names one. */
  defaultPreset?: string;
  /** Wall-clock budget for one `verifier.verifyRun` call. */
  verifyTimeoutMs: number;
}
declare const DEFAULT_VERIFY_TIMEOUT_MS: number;
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
  /** Resolve required capability names against the configured registry. */
  resolveCapabilities(required: readonly string[]): CapabilityManifest;
  /** Create (or reopen) the store, expand RootTaskSpec into the root task, and bind a run to the root session. */
  createRootTask(storeId: string, options: {
    objective: string;
    rootSessionId: string;
  }, actor: string): Promise<{
    taskId: TaskId;
    runId: RunId;
  }>;
  /**
   * Atomic decomposition plus the sequential run cascade: structural admission
   * and capability admission must pass for the whole batch before anything is
   * persisted; children then run one at a time in dependency order.
   */
  decomposeAndRun(storeId: string, parentTaskId: TaskId, parentRunId: RunId, callerSessionId: string, spec: DecomposeSpec, exec?: {
    signal?: AbortSignal;
  }): Promise<ChildOutcome[]>;
  /** Reverse lookup: the task run a (worker) session is bound to. */
  runForSession(sessionId: string): Promise<{
    storeId: string;
    task: TaskInstance;
    run: TaskRun;
  }>;
  private lookupRun;
  private resolveBinding;
  private reindex;
  private orchestrateEnv;
  /** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
  private liveAgent;
}
//#endregion
export { type AdmissionChild, type AdmissionParent, type AdmissionVerdict, type CapabilityConfig, type ChildOutcome, type ChildPlan, Config, CriterionSpec, DEFAULT_CAPABILITIES, DEFAULT_VERIFY_TIMEOUT_MS, DecomposeChildSpec, DecomposeSpec, type HandoffInit, type OrchestrateEnv, RunVerifier, type SpawnChildRequest, TaskRuntime, TaskRuntime as default, VerifierUnavailableError, type VerifyRunOptions, buildHandoff, checkDecomposition, renderWorkerPrompt, resolveCapabilities, runChildrenCascade };
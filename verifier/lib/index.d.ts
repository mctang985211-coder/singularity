import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { EvidenceBundle, RunId, TaskId, TaskInstance, VerificationMode, VerificationMode as VerificationMode$1, VerificationResult, VerificationResult as VerificationResult$1, Verifier, Verifier as Verifier$1, VerifyRequest, VerifyRequest as VerifyRequest$1 } from "@dangosys/dsh-singularity-task";

//#region src/command-verifier.d.ts

/**
 * Runs each criterion's `command` through a shell in the request cwd and
 * judges by exit code. Combined stdout+stderr goes to
 * `<logDir>/<criterionId>.log`; results reference it relative to evidenceRoot.
 */
declare class CommandVerifier implements Verifier$1 {
  private readonly evidenceRoot;
  readonly id = "command";
  constructor(evidenceRoot: string);
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
  private runCriterion;
}
//#endregion
//#region src/composite-verifier.d.ts
/** The slice of the task service the composite verifier reads. */
interface CompositeTaskSource {
  childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]>;
}
/**
 * Judges a composite criterion by child task status: pass iff the task has at
 * least one child and every child is verified. Reading children needs the
 * store id, which VerifyRequest does not carry, so the registry dispatches
 * through {@link verifyIn}; the plain `verify` stays inconclusive.
 */
declare class CompositeVerifier implements Verifier$1 {
  private readonly task;
  readonly id = "composite";
  constructor(task: CompositeTaskSource);
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
  verifyIn(storeId: string, req: VerifyRequest$1): Promise<VerificationResult$1[]>;
}
//#endregion
//#region src/review-verifier.d.ts
/** Placeholder for human judgment: never auto-passes. */
declare class ReviewVerifier implements Verifier$1 {
  readonly id = "review";
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierRegistry;
  }
}
/** Plugin config; every field optional — the constructor resolves defaults. */
interface Config {
  /**
   * Root directory for verifier evidence logs. Omitted resolves to
   * `$DSH_HOME/task-evidence`, falling back to `<repo root>/.dsh/task-evidence`
   * when `DSH_HOME` is unset. Run logs land in `<evidenceRoot>/<storeId>/<runId>/`.
   */
  evidenceRoot?: string;
}
/** Per-call overrides for {@link VerifierRegistry.verifyRun}. */
interface VerifyRunOptions {
  /** Absolute working directory for criterion commands; defaults to the process cwd. */
  cwd?: string;
  /** Per-command timeout in milliseconds, forwarded to the verifier. */
  timeoutMs?: number;
}
declare class VerifierRegistry extends Service {
  static inject: string[];
  static Config: z<Config>;
  /** Absolute evidence root resolved at construction. */
  readonly evidenceRoot: string;
  private readonly verifiers;
  constructor(ctx: Context, config?: Config);
  /** Add a verifier; later registrations win mode dispatch. Returns the disposer. */
  register(verifier: Verifier$1): () => void;
  /**
   * Verify one run: dispatch each acceptance criterion of the run's task to a
   * verifier supporting its mode, assemble an EvidenceBundle (one claim per
   * result), record it through the task service, and return it. Marking the
   * run verified or failed is the caller's job and must come after this call.
   */
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  private verifyCriterion;
  private findVerifier;
  private normalizeLogRef;
  private claim;
}
//#endregion
export { CommandVerifier, type CompositeTaskSource, CompositeVerifier, Config, ReviewVerifier, type VerificationMode, type VerificationResult, type Verifier, VerifierRegistry, VerifierRegistry as default, type VerifyRequest, VerifyRunOptions };
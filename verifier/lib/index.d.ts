import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { EvidenceBundle, RunId, TaskId, TaskInstance, TaskSnapshot, VerificationMode, VerificationMode as VerificationMode$1, VerificationResult, VerificationResult as VerificationResult$1, Verifier, Verifier as Verifier$1, VerifierSelftest, VerifyRequest, VerifyRequest as VerifyRequest$1 } from "@dangosys/dsh-singularity-task";

//#region src/command-verifier.d.ts

/**
 * Runs each criterion's `command` through a shell in the request cwd and
 * judges by exit code. Combined stdout+stderr goes to
 * `<logDir>/<criterionId>.log`; results reference it relative to evidenceRoot.
 */
declare class CommandVerifier implements Verifier$1 {
  private readonly evidenceRoot;
  readonly id = "command";
  readonly version = "1";
  readonly owner = "singularity";
  /** Known samples the package tests execute for real: `true` must pass, `false` must fail (KISS §12 step 2). */
  readonly selftest: {
    positiveCases: string[];
    negativeCases: string[];
  };
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
  /**
   * The full store snapshot. The plain conjunction needs only children, but a
   * parent's {@link AcceptanceCriterion.childEvidence} map is judged against
   * child evidence and run states, so the source exposes the snapshot too.
   */
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
}
/**
 * Judges a composite criterion. The default is the child-status conjunction
 * (pass iff the task has at least one child and every child is verified),
 * unchanged for criteria that declare nothing.
 *
 * A criterion carrying a {@link AcceptanceCriterion.childEvidence} map is
 * judged by the map as well: every entry must resolve against the store, and an
 * incomplete mapping fails the criterion with the missing items named — the
 * conjunction alone can never pass a parent whose root goal rests on evidence
 * the children did not produce (KISS §6 C2). A criterion labeled
 * {@link AcceptanceCriterion.heuristic} keeps the conjunction verdict but
 * carries the explicit heuristic label in its details, so a natural-language
 * coverage signal is never mistaken for a mechanical proof (KISS §5.1).
 *
 * Reading children and evidence needs the store id, which VerifyRequest does
 * not carry, so the registry dispatches through {@link verifyIn}; the plain
 * `verify` stays inconclusive.
 */
declare class CompositeVerifier implements Verifier$1 {
  private readonly task;
  readonly id = "composite";
  readonly version = "1";
  readonly owner = "singularity";
  /**
   * The distinguishing samples need a task store (the verdict reads child
   * status), so they live in this package's tests:
   * `tests/unit/composite-verifier.spec.ts` runs both.
   */
  readonly selftest: {
    positiveCases: string[];
    negativeCases: string[];
  };
  constructor(task: CompositeTaskSource);
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
  verifyIn(storeId: string, req: VerifyRequest$1): Promise<VerificationResult$1[]>;
  private judge;
}
//#endregion
//#region src/review-verifier.d.ts
/** Placeholder for human judgment: never auto-passes. */
declare class ReviewVerifier implements Verifier$1 {
  readonly id = "review";
  readonly version = "1";
  readonly owner = "singularity";
  /**
   * This verifier judges nothing by design — a human does — so the one
   * distinction its selftest can prove is the negative one: a known-good
   * sample still comes back inconclusive, never an auto-pass. The package
   * tests execute exactly that sample.
   */
  readonly selftest: {
    positiveCases: string[];
    negativeCases: never[];
  };
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
}
//#endregion
//#region src/index.d.ts
/** Caps for the log-tail excerpt a review record carries: enough to read the failure, small enough to keep a record lean. */
declare const LOG_TAIL_MAX_LINES = 40;
declare const LOG_TAIL_MAX_CHARS = 2048;
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
  /**
   * Add a verifier; later registrations win mode dispatch. Returns the
   * disposer. A registration without a `selftest` (KISS §4.3) is logged as a
   * warning, not refused — soft until every built-in verifier carries one,
   * so existing test doubles keep registering; flipping to a hard refusal is
   * a deliberate later step.
   */
  register(verifier: Verifier$1): () => void;
  /** The registered verifier ids, sorted — the vocabulary a criterion's `verifierRef` may name. */
  verifierIds(): string[];
  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn;
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
  /**
   * Tail excerpt of one criterion log (logRef relative to evidenceRoot),
   * bounded by LOG_TAIL_MAX_LINES and LOG_TAIL_MAX_CHARS, for a failed review
   * record to carry. `undefined` when the log is missing or unreadable — a
   * record must never fail to write because a log is gone.
   */
  logTail(logRef: string): Promise<string | undefined>;
  private claim;
}
//#endregion
export { CommandVerifier, type CompositeTaskSource, CompositeVerifier, Config, LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, ReviewVerifier, type VerificationMode, type VerificationResult, type Verifier, VerifierRegistry, VerifierRegistry as default, type VerifierSelftest, type VerifyRequest, VerifyRunOptions };
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, EvidenceBundle, ProtectedInputRef, RunId, TaskId, TaskInstance, TaskSnapshot, VerificationMode, VerificationMode as VerificationMode$1, VerificationResult, VerificationResult as VerificationResult$1, Verifier, Verifier as Verifier$1, VerifierSelftest, VerifierSelftest as VerifierSelftest$1, VerifyRequest, VerifyRequest as VerifyRequest$1 } from "@dangosys/dsh-singularity-task";

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
  /**
   * Known samples the registry executes before it will register this judge
   * (KISS §4.3, V2-1): a command that exits zero must come back `pass`, one
   * that exits non-zero must come back `fail`. Both go through the same shell
   * path production uses, so the proof is this verifier's own exit-code
   * reading, executed — not a description of it.
   */
  readonly selftest: VerifierSelftest$1;
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
 * Pure by construction — the criterion, the batch's children, and a snapshot
 * getter are the whole input. The getter is called only when a map needs it,
 * so a map-less criterion never reads a snapshot; that also lets the registry
 * judge a selftest sample's declared store view without a store behind it.
 * Reading children needs the store id, which VerifyRequest does not carry, so
 * production dispatches through {@link CompositeVerifier.verifyIn}; the plain
 * `verify` stays inconclusive.
 */
declare function judgeCompositeCriterion(criterion: AcceptanceCriterion, children: readonly TaskInstance[], snapshot: () => Promise<TaskSnapshot>): Promise<VerificationResult$1>;
declare class CompositeVerifier implements Verifier$1 {
  private readonly task;
  readonly id = "composite";
  readonly version = "1";
  readonly owner = "singularity";
  /**
   * Known samples the registry executes before it will register this judge
   * (KISS §4.3, V2-1): one map the fixture store satisfies, one whose named
   * criterion has no passing verdict in that evidence. Same child, same run,
   * same bundle shape — the two samples differ only in a verdict, so a judge
   * that returns one status for both is caught. Neither the samples nor the
   * fixtures are read from a real store; the store *view* each sample declares
   * is the whole input (`VerifierSelftestSample.store`).
   */
  readonly selftest: VerifierSelftest$1;
  constructor(task: CompositeTaskSource);
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
  verifyIn(storeId: string, req: VerifyRequest$1): Promise<VerificationResult$1[]>;
}
//#endregion
//#region src/review-verifier.d.ts
/**
 * Placeholder for human judgment: never auto-passes.
 *
 * Its selftest takes the equivalent form KISS §4.3 allows a judge that judges
 * nothing: a known-good sample must be demonstrably *not* auto-passed, and a
 * known-bad sample must not be judged `pass` either. Both are executed by the
 * registry before it will register this verifier.
 *
 * What that proves: the judge returns a not-pass verdict instead of silently
 * accepting, on both a criterion that ought to be verifiable by a human and one
 * that ought not to pass. What it does not prove: anything about products —
 * this verifier does not judge products at all, and no sample can make its
 * verdict meaningful. What closes a review criterion is the human review it
 * defers to, outside this verifier.
 */
declare class ReviewVerifier implements Verifier$1 {
  readonly id = "review";
  readonly version = "1";
  readonly owner = "singularity";
  readonly selftest: VerifierSelftest$1;
  supports(mode: VerificationMode$1): boolean;
  verify(req: VerifyRequest$1): Promise<VerificationResult$1[]>;
}
//#endregion
//#region src/protected-inputs.d.ts
/**
 * Every defect among `inputs`, read against `cwd`: the entry position and what
 * is wrong with it — malformed, missing, unreadable, or changed since
 * admission. Empty when every declared input is well formed, present, and
 * unchanged. Each message names the declared path (or the entry position, when
 * there is no path to name), so the caller never has to guess which input is at
 * fault.
 *
 * Entries are guarded before use. A criterion's `protectedInputs` reaches the
 * registry from the store, and admission is not the only writer: a direct store
 * write can hand over an entry admission would have refused, and the registry
 * still has to answer that criterion with a verdict. A malformed entry is a
 * defect of the verdict's inputs like any other — named in the refusal, never
 * thrown out of the judgement that was supposed to report it. The parameter
 * type stays the declared one; the runtime is what is not guaranteed.
 */
declare function protectedInputDefects(cwd: string, inputs: readonly ProtectedInputRef[]): Promise<string[]>;
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
/** Options for {@link VerifierRegistry.register}. */
interface RegisterOptions {
  /**
   * Explicit test-double declaration: the only channel that skips the
   * executable selftest gate. A test double stands in for a judge without being
   * one — a fixture whose verdicts the test dictates — and cannot prove a
   * discrimination it does not have. Passing this is the caller's stated
   * intent, logged as one warning; nothing infers it. A missing or descriptive
   * selftest is refused like any other, so no production registration can slip
   * through this gate by omission.
   */
  testDouble?: true;
}
declare class VerifierRegistry extends Service {
  static inject: string[];
  static Config: z<Config>;
  /** Absolute evidence root resolved at construction. */
  readonly evidenceRoot: string;
  private readonly verifiers;
  private readonly composite;
  private readyPromise?;
  constructor(ctx: Context, config?: Config);
  /**
   * Register the three built-ins through the same executable selftest gate
   * every other judge passes. Cordis calls this after construction
   * (`Service.init`); {@link verifyRun} and {@link evidenceByVerifier} await it
   * too, so a caller that never awaited it still gets a readied registry.
   *
   * Idempotent — the first call does the work, every later call awaits the same
   * promise (a rejection stays a rejection: a built-in that fails its own
   * selftest must not become registrable on a retry). Fail closed until it
   * resolves: the registry holds no verifiers yet, so a dispatch that somehow
   * got ahead of it would find no judge and refuse rather than judge with a
   * half-built vocabulary.
   */
  ready(): Promise<void>;
  private registerBuiltins;
  /**
   * Add a verifier; later registrations win mode dispatch. Returns the
   * disposer. Every registration goes through the executable selftest gate
   * (KISS §4.3, V2-1): the verifier must declare positive and negative samples
   * and then prove, by returning the declared verdict for each, that it can
   * tell the sides apart. A registration that misses a sample — or declares a
   * set the gate cannot execute — is refused with a readable reason naming the
   * verifier and every missed or malformed sample, and is not added. The
   * conclusion is the gate's, taken from executing the samples; a verifier's
   * own description of itself is never consulted.
   *
   * The one exception is the caller's explicit `{ testDouble: true }` — the
   * only skip-the-gate channel, for tests and fixtures that stand in for a
   * judge without being one. It is declared, never inferred, and logged as one
   * warning so the skip is visible in the run that took it.
   */
  register(verifier: Verifier$1, options?: RegisterOptions): Promise<() => void>;
  /**
   * The executable selftest gate. Two refusals reach the caller, both naming
   * the verifier: `cannot be registered` for a declaration the gate could not
   * execute (missing, empty, one-sided, or malformed samples, or a store view
   * only the registry's own composite judge can be run against), and
   * `selftest failed` for samples that executed and were missed.
   */
  private selftestGate;
  /**
   * Execute the declared samples in order and collect every miss. Each sample
   * is judged the way production judges it — through `verify` for a
   * criterion-only judge, through the shared composite judgement over the
   * sample's declared store view for the registry's own composite instance —
   * and validated by the same rules production applies. Samples run against a
   * scratch cwd and log dir under the evidence root, so a command sample
   * really spawns and everything it writes stays inside evidenceRoot.
   */
  private executeSamples;
  /** The registered verifier ids, sorted — the vocabulary a criterion's `verifierRef` may name. */
  verifierIds(): string[];
  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn;
  /** Cordis runs this after construction: the built-ins are gated before the service is usable. */
  [Service.init](): Promise<void>;
  /**
   * Verify one run: dispatch each acceptance criterion of the run's task to a
   * verifier supporting its mode, assemble an EvidenceBundle (one claim per
   * result), record it through the task service, and return it. Marking the
   * run verified or failed is the caller's job and must come after this call.
   */
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  /**
   * The `(verifierRef, version)` index of KISS §8.2: every bundle in the store
   * whose claims were signed by `verifierRef`, optionally narrowed to one
   * registered `version`. Omitted, the version filter is off — evidence written
   * before the field existed stays readable, and a version change never
   * rewrites what was already recorded. Given, only that exact version's claims
   * match. Sorted by `evidenceId`, so a caller's iteration is deterministic.
   *
   * The index only: nothing here downgrades a historical pass to suspect or
   * re-runs a verification. Verdict recall itself is not built.
   */
  evidenceByVerifier(storeId: string, verifierRef: string, version?: string): Promise<EvidenceBundle[]>;
  private verifyCriterion;
  /**
   * Stamp the registered instance's version onto one verdict (KISS §8.2): a
   * verdict can only be recalled against the instance that actually judged, so
   * the version recorded is this instance's — a plugin-supplied
   * `verifierVersion` is always discarded, and an instance that declares none
   * acquires none.
   */
  private stampVersion;
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
export { CommandVerifier, type CompositeTaskSource, CompositeVerifier, Config, LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, RegisterOptions, ReviewVerifier, type VerificationMode, type VerificationResult, type Verifier, VerifierRegistry, VerifierRegistry as default, type VerifierSelftest, type VerifyRequest, VerifyRunOptions, judgeCompositeCriterion, protectedInputDefects };
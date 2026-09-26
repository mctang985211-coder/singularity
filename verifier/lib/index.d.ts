import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, EvidenceBundle, ProtectedInputRef, RunId, TaskId, TaskInstance, TaskRun, TaskSnapshot, VerificationMode, VerificationResult } from "@dangosys/dsh-singularity-task";

//#region src/types.d.ts

/**
 * One executable selftest sample (KISS §4.3): the criterion a verifier is
 * handed, the store view a store-reading judge is judged against, and the
 * verdict a healthy verifier must return for the sample to count as proof that
 * the verifier can tell the sample's side apart.
 *
 * Samples are data, and the registry executes them — a verifier cannot prove
 * its selftest by describing it. A sample the registry cannot execute (a store
 * view for a judge the registry cannot run against one) refuses registration
 * rather than being skipped.
 */
interface VerifierSelftestSample {
  /** Which side of the discrimination this sample proves. */
  role: 'positive' | 'negative';
  /** Human-readable sample name; the refusal text names the missed sample by it. */
  name: string;
  /** The sample criterion handed to the verifier. */
  criterion: AcceptanceCriterion;
  /**
   * The verdict a healthy verifier returns for this sample: `pass` for a
   * known-good sample; `fail` for a known-bad sample; `not-pass` for a sample
   * that must merely never be auto-passed (a never-auto-pass judge such as the
   * review verifier, where "known-good is not auto-passed" plus "known-bad is
   * not judged pass" is the equivalent form the sample pair takes).
   */
  expect: 'pass' | 'fail' | 'not-pass';
  /** The store view a store-reading judge is judged against; absent for a judge that judges the criterion alone. */
  store?: VerifierSelftestStore;
}
/**
 * The task-store view one store-reading selftest sample is judged against
 * ({@link VerifierSelftestSample.store}): the members the judged run has
 * admitted, plus the runs and evidence bundles a judge reads for their verified
 * states and verdicts. Everything else a full snapshot carries is empty in a
 * sample.
 */
interface VerifierSelftestStore {
  /**
   * The run's accumulated members, in admission order — exactly the sequence
   * `TaskService.runMembersIn` returns for a run, and therefore exactly what a
   * store-reading judge's member lookup hands it. A criterion's `childIndex`
   * resolves against this list.
   */
  children: TaskInstance[];
  /** Runs the sample judge reads (a child's verified run); `[]` when the sample needs none. */
  runs?: TaskRun[];
  /** Evidence bundles the sample judge reads; `[]` when the sample needs none. */
  evidence?: EvidenceBundle[];
}
/**
 * A verifier's executable known-sample proof (KISS §4.3 `selftest`): the
 * samples the verifier must mechanically distinguish before the registry will
 * register it — at least one known-good sample and at least one known-bad one,
 * each executed through the verifier and compared against the verdict the
 * verifier declared. A missed negative sample (the known-bad case judged
 * `pass`) or a positive sample that is not accepted makes the verifier
 * unavailable, and the refusal names the sample.
 *
 * What this proves and what it does not: that the verifier, as registered,
 * returns the declared verdicts for its own declared samples — a regression
 * gate against a judge that cannot tell its known cases apart. It does not
 * prove the samples are meaningful, that the verifier is independent from any
 * executor, or that its verdicts are right on real products.
 */
interface VerifierSelftest {
  /** Executable samples; a healthy verifier returns `expect` for every one of them. */
  samples: VerifierSelftestSample[];
}
/** The judge interface this package implements and the registry dispatches to. */
interface Verifier {
  id: string;
  /**
   * Registry metadata (KISS §4.3): a version so a later verdict recall can
   * index evidence by `(verifierRef, version)` (KISS §8.2) — the registry
   * stamps it onto every verdict and claim it dispatches, so the recorded
   * version is the registered instance's, never a self-report — and an owner
   * so the execution/judgement separation (I3) has something to compare
   * against the executing skill's owner.
   */
  version?: string;
  owner?: string;
  /**
   * The verifier's executable known-sample proof ({@link VerifierSelftest}).
   * Required to register: {@link VerifierRegistry.register} executes every
   * sample and refuses the verifier when one is missed, and refuses a
   * registration without samples — a descriptive selftest is not a selftest.
   * Only an explicit, documented test-double registration skips the gate.
   */
  selftest?: VerifierSelftest;
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
}
interface VerifyRequest {
  taskId: TaskId;
  runId: RunId;
  criteria: AcceptanceCriterion[];
  cwd: string;
  logDir: string;
  timeoutMs?: number;
}
//#endregion
//#region src/command-verifier.d.ts
/**
 * Runs each criterion's `command` through a shell in the request cwd and
 * judges by exit code. Combined stdout+stderr goes to
 * `<logDir>/<criterionId>.log`; results reference it relative to evidenceRoot.
 */
declare class CommandVerifier implements Verifier {
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
  readonly selftest: VerifierSelftest;
  constructor(evidenceRoot: string);
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
  private runCriterion;
}
//#endregion
//#region src/composite-verifier.d.ts
/**
 * The slice of the task service the composite verifier reads: the members the
 * judged run has admitted, and the store snapshot they are judged against.
 *
 * Membership is read per *run*, not per task: a parent decomposes more than
 * once (one batch per delegation round), so "the children of this task" is not
 * the sequence a criterion's `childIndex` names — the run's accumulative
 * membership is, and a run that admitted no batch has no members rather than
 * its task's children.
 */
interface CompositeTaskSource {
  runMembersIn(storeId: string, runId: RunId): Promise<TaskInstance[]>;
  /**
   * The full store snapshot. The plain conjunction needs only members, but a
   * parent's {@link AcceptanceCriterion.childEvidence} map is judged against
   * child evidence and run states, so the source exposes the snapshot too.
   */
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
}
/**
 * Judges a composite criterion. The default is the child-status conjunction
 * (pass iff the run has at least one accumulated member and every member is
 * verified), unchanged for criteria that declare nothing.
 *
 * A criterion carrying a {@link AcceptanceCriterion.childEvidence} map is
 * judged by the map as well: every entry must resolve against the store, and an
 * incomplete mapping fails the criterion with the missing items named — the
 * conjunction alone can never pass a parent whose root goal rests on evidence
 * the members did not produce (KISS §6 C2). A criterion labeled
 * {@link AcceptanceCriterion.heuristic} keeps the conjunction verdict but
 * carries the explicit heuristic label in its details, so a natural-language
 * coverage signal is never mistaken for a mechanical proof (KISS §5.1).
 *
 * `members` is the judged run's accumulative membership, in admission order
 * (`TaskService.runMembersIn`) — the sequence `childIndex` names. It is not the
 * judged task's children: a parent's later batch appends and never renumbers an
 * earlier one's members, and a run that admitted no batch has none.
 *
 * Pure by construction — the criterion, the members, and a snapshot getter are
 * the whole input. The getter is called only when a map needs it, so a map-less
 * criterion never reads a snapshot; that also lets the registry judge a selftest
 * sample's declared store view without a store behind it. Reading the members
 * needs the store id and the run id, which the registry's own request carries,
 * so production dispatches through {@link CompositeVerifier.verifyIn}; the
 * plain `verify` stays inconclusive.
 */
declare function judgeCompositeCriterion(criterion: AcceptanceCriterion, members: readonly TaskInstance[], snapshot: () => Promise<TaskSnapshot>): Promise<VerificationResult>;
declare class CompositeVerifier implements Verifier {
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
  readonly selftest: VerifierSelftest;
  constructor(task: CompositeTaskSource);
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
  verifyIn(storeId: string, req: VerifyRequest): Promise<VerificationResult[]>;
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
declare class ReviewVerifier implements Verifier {
  readonly id = "review";
  readonly version = "1";
  readonly owner = "singularity";
  readonly selftest: VerifierSelftest;
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
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
   * (`Service.init`); {@link verifyRun} awaits it too, so a caller that never
   * awaited it still gets a readied registry.
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
  register(verifier: Verifier, options?: RegisterOptions): Promise<() => void>;
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
  /**
   * The version each registered verifier declares, by id — the registry metadata
   * {@link stampVersion} puts on the verdicts that instance produces. A verifier
   * that declares no version is absent from the map, so a reader distinguishes
   * "declares none" from "is not registered" by the two reads together
   * (`verifierIds()` for registration, this for the version). Read as a pair
   * wherever a verdict has to be recalled against the instance that judged it.
   */
  verifierVersions(): Record<string, string>;
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
export { CommandVerifier, type CompositeTaskSource, CompositeVerifier, Config, LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, RegisterOptions, ReviewVerifier, type Verifier, VerifierRegistry, VerifierRegistry as default, type VerifierSelftest, type VerifierSelftestSample, type VerifierSelftestStore, type VerifyRequest, VerifyRunOptions, judgeCompositeCriterion, protectedInputDefects };
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AcceptanceCriterion, EvidenceBundle, ProtectedInputRef, RunId, TaskId, TaskInstance, TaskRun, TaskSnapshot, VerificationMode, VerificationResult } from "@dangosys/dsh-singularity-task";

//#region src/types.d.ts
/** One executable selftest sample (KISS §4.3): the criterion, optional store view, and the verdict it must draw. */
interface VerifierSelftestSample {
  /** Which side of the discrimination this sample proves. */
  role: 'positive' | 'negative';
  /** Human-readable name; the refusal text names a missed sample by it. */
  name: string;
  /** The sample criterion handed to the verifier. */
  criterion: AcceptanceCriterion;
  /** The verdict a healthy verifier returns: `pass`, `fail`, or `not-pass` for a never-auto-pass judge. */
  expect: 'pass' | 'fail' | 'not-pass';
  /** The store view a store-reading judge is judged against; absent for a criterion-only judge. */
  store?: VerifierSelftestStore;
}
/** The task-store view one store-reading sample is judged against: the run's members, runs, and evidence. */
interface VerifierSelftestStore {
  /** The run's members in admission order, every position filled; a criterion's `childIndex` resolves against it. */
  children: TaskInstance[];
  /** Runs the sample judge reads (a child's verified run); `[]` when the sample needs none. */
  runs?: TaskRun[];
  /** Evidence bundles the sample judge reads; `[]` when the sample needs none. */
  evidence?: EvidenceBundle[];
}
/** A verifier's executable known-sample proof (KISS §4.3): the samples the registry executes before it registers. */
interface VerifierSelftest {
  /** Executable samples; a healthy verifier returns `expect` for every one of them. */
  samples: VerifierSelftestSample[];
}
/** The judge interface this package implements and the registry dispatches to. */
interface Verifier {
  id: string;
  /** Registry metadata (KISS §4.3, §8.2): the version the registry stamps onto every verdict it dispatches. */
  version?: string;
  /** The verifier's executable known-sample proof; required to register. */
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
/** Runs each criterion's `command` through a shell and judges by exit code; output goes to the criterion log. */
declare class CommandVerifier implements Verifier {
  private readonly evidenceRoot;
  readonly id = "command";
  readonly version = "1";
  /** Known samples: an exit-zero command must come back `pass`, an exit-non-zero one must come back `fail`. */
  readonly selftest: VerifierSelftest;
  constructor(evidenceRoot: string);
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
  private runCriterion;
}
//#endregion
//#region src/composite-verifier.d.ts
/** The slice of the task service the composite verifier reads: the run's members and the store snapshot. */
interface CompositeTaskSource {
  /** The judged run's members **by position** (`TaskService.runMemberSlotsIn`); `undefined` is an unfilled slot. */
  runMemberSlotsIn(storeId: string, runId: RunId): Promise<(TaskInstance | undefined)[]>;
  /** The full store snapshot, for the child-evidence map's reads of run states and verdicts. */
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
}
/** Judged by child-status conjunction, plus the child-evidence map when the criterion declares one. */
declare function judgeCompositeCriterion(criterion: AcceptanceCriterion, members: readonly (TaskInstance | undefined)[], snapshot: () => Promise<TaskSnapshot>): Promise<VerificationResult>;
declare class CompositeVerifier implements Verifier {
  private readonly task;
  readonly id = "composite";
  readonly version = "1";
  /** Known samples: one map the fixture store satisfies, one whose named criterion has no passing verdict. */
  readonly selftest: VerifierSelftest;
  constructor(task: CompositeTaskSource);
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
  verifyIn(storeId: string, req: VerifyRequest): Promise<VerificationResult[]>;
}
//#endregion
//#region src/review-verifier.d.ts
/** Placeholder for human judgment: never auto-passes, and its samples prove exactly that on both sides (KISS §4.3). */
declare class ReviewVerifier implements Verifier {
  readonly id = "review";
  readonly version = "1";
  readonly selftest: VerifierSelftest;
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
}
//#endregion
//#region src/protected-inputs.d.ts
/** Every defect among `inputs` read against `cwd`: a declared path that is missing, unreadable, or changed. */
declare function protectedInputDefects(cwd: string, inputs: readonly ProtectedInputRef[]): Promise<string[]>;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierRegistry;
  }
}
/** Plugin config; every field optional — the constructor resolves defaults. */
interface Config {
  /** Root for verifier evidence logs; omitted resolves to `$DSH_HOME/task-evidence`, else `<repo>/.dsh/task-evidence`. */
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
  /** The explicit test-double declaration: the only channel that skips the executable selftest gate. */
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
  /** Register the three built-ins through the executable selftest gate; idempotent, and fail-closed until it resolves. */
  ready(): Promise<void>;
  private registerBuiltins;
  /** Add a verifier (later registrations win mode dispatch) and return its disposer; the selftest gate runs first. */
  register(verifier: Verifier, options?: RegisterOptions): Promise<() => void>;
  /** The executable selftest gate: an unexecutable declaration is refused by name, a missed sample fails registration. */
  private selftestGate;
  /** Execute the declared samples in order and collect every miss, judged the way production judges them. */
  private executeSamples;
  /** The registered verifier ids, sorted — the vocabulary a criterion's `verifierRef` may name. */
  verifierIds(): string[];
  verifierSupports(id: string, mode: VerificationMode): boolean;
  /** The version each registered verifier declares, by id; an instance declaring none is absent from the map. */
  verifierVersions(): Record<string, string>;
  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn;
  /** Cordis runs this after construction: the built-ins are gated before the service is usable. */
  [Service.init](): Promise<void>;
  /** Verify one run: dispatch each criterion, assemble an EvidenceBundle, record it, and return it. */
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>;
  private verifyCriterion;
  /** Stamp the registered instance's version onto one verdict (KISS §8.2); a plugin-supplied version is discarded. */
  private stampVersion;
  private findVerifier;
  private normalizeLogRef;
  /** Tail excerpt of one criterion log, capped by the two LOG_TAIL limits; `undefined` when the log is missing. */
  logTail(logRef: string): Promise<string | undefined>;
  private claim;
}
//#endregion
export { CommandVerifier, type CompositeTaskSource, CompositeVerifier, Config, ReviewVerifier, type Verifier, VerifierRegistry, VerifierRegistry as default, type VerifierSelftest, type VerifierSelftestSample, type VerifierSelftestStore, type VerifyRequest, VerifyRunOptions, judgeCompositeCriterion, protectedInputDefects };
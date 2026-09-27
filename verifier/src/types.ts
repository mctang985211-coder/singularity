/**
 * The verifier execution contract (R3-2): the judge interface, the executable
 * selftest proof a judge must declare before the registry will register it, and
 * the request a criterion is judged through. These live here — with the
 * registry that executes them and the plugins that implement them — while the
 * facts a verdict becomes (`VerificationResult`, `EvidenceBundle`) and the
 * criteria a task carries stay owned by `task`, which never imports this
 * package back.
 *
 * The types below name task facts in their fields (a criterion, a run id, the
 * members a store-reading judge sees), so this module imports them from
 * `@dangosys/dsh-singularity-task` — the one direction of the dependency, the
 * same one the registry service itself declares (`static inject = ['task']`).
 * @module @dangosys/dsh-singularity-verifier/types
 */

import type {
  AcceptanceCriterion,
  EvidenceBundle,
  RunId,
  TaskId,
  TaskInstance,
  TaskRun,
  VerificationMode,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'

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
export interface VerifierSelftestSample {
  /** Which side of the discrimination this sample proves. */
  role: 'positive' | 'negative'
  /** Human-readable sample name; the refusal text names the missed sample by it. */
  name: string
  /** The sample criterion handed to the verifier. */
  criterion: AcceptanceCriterion
  /**
   * The verdict a healthy verifier returns for this sample: `pass` for a
   * known-good sample; `fail` for a known-bad sample; `not-pass` for a sample
   * that must merely never be auto-passed (a never-auto-pass judge such as the
   * review verifier, where "known-good is not auto-passed" plus "known-bad is
   * not judged pass" is the equivalent form the sample pair takes).
   */
  expect: 'pass' | 'fail' | 'not-pass'
  /** The store view a store-reading judge is judged against; absent for a judge that judges the criterion alone. */
  store?: VerifierSelftestStore
}

/**
 * The task-store view one store-reading selftest sample is judged against
 * ({@link VerifierSelftestSample.store}): the members the judged run has
 * admitted, plus the runs and evidence bundles a judge reads for their verified
 * states and verdicts. Everything else a full snapshot carries is empty in a
 * sample.
 */
export interface VerifierSelftestStore {
  /**
   * The run's members, in admission order — exactly the sequence
   * `TaskService.runMemberSlotsIn` hands a store-reading judge, every position
   * filled. A criterion's `childIndex` resolves against this list. A real run can
   * hold a position its attempt has not filled yet; a sample lists members, so it
   * has none.
   */
  children: TaskInstance[]
  /** Runs the sample judge reads (a child's verified run); `[]` when the sample needs none. */
  runs?: TaskRun[]
  /** Evidence bundles the sample judge reads; `[]` when the sample needs none. */
  evidence?: EvidenceBundle[]
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
export interface VerifierSelftest {
  /** Executable samples; a healthy verifier returns `expect` for every one of them. */
  samples: VerifierSelftestSample[]
}

/** The judge interface this package implements and the registry dispatches to. */
export interface Verifier {
  id: string
  /**
   * Registry metadata (KISS §4.3): a version so a later verdict recall can
   * index evidence by `(verifierRef, version)` (KISS §8.2) — the registry
   * stamps it onto every verdict and claim it dispatches, so the recorded
   * version is the registered instance's, never a self-report — and an owner
   * so the execution/judgement separation (I3) has something to compare
   * against the executing skill's owner.
   */
  version?: string
  owner?: string
  /**
   * The verifier's executable known-sample proof ({@link VerifierSelftest}).
   * Required to register: {@link VerifierRegistry.register} executes every
   * sample and refuses the verifier when one is missed, and refuses a
   * registration without samples — a descriptive selftest is not a selftest.
   * Only an explicit, documented test-double registration skips the gate.
   */
  selftest?: VerifierSelftest
  supports(mode: VerificationMode): boolean
  verify(req: VerifyRequest): Promise<VerificationResult[]>
}

export interface VerifyRequest {
  taskId: TaskId
  runId: RunId
  criteria: AcceptanceCriterion[]
  cwd: string          // absolute dir to run commands in (the graph env checkout)
  logDir: string       // absolute dir for this run's logs; results store paths relative to evidenceRoot
  timeoutMs?: number
}

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

/** One executable selftest sample (KISS §4.3): the criterion, optional store view, and the verdict it must draw. */
export interface VerifierSelftestSample {
  /** Which side of the discrimination this sample proves. */
  role: 'positive' | 'negative'
  /** Human-readable name; the refusal text names a missed sample by it. */
  name: string
  /** The sample criterion handed to the verifier. */
  criterion: AcceptanceCriterion
  /** The verdict a healthy verifier returns: `pass`, `fail`, or `not-pass` for a never-auto-pass judge. */
  expect: 'pass' | 'fail' | 'not-pass'
  /** The store view a store-reading judge is judged against; absent for a criterion-only judge. */
  store?: VerifierSelftestStore
}

/** The task-store view one store-reading sample is judged against: the run's members, runs, and evidence. */
export interface VerifierSelftestStore {
  /** The run's members in admission order, every position filled; a criterion's `childIndex` resolves against it. */
  children: TaskInstance[]
  /** Runs the sample judge reads (a child's verified run); `[]` when the sample needs none. */
  runs?: TaskRun[]
  /** Evidence bundles the sample judge reads; `[]` when the sample needs none. */
  evidence?: EvidenceBundle[]
}

/** A verifier's executable known-sample proof (KISS §4.3): the samples the registry executes before it registers. */
export interface VerifierSelftest {
  /** Executable samples; a healthy verifier returns `expect` for every one of them. */
  samples: VerifierSelftestSample[]
}

/** The judge interface this package implements and the registry dispatches to. */
export interface Verifier {
  id: string
  /** Registry metadata (KISS §4.3, §8.2): the version the registry stamps onto every verdict it dispatches. */
  version?: string
  /** The verifier's executable known-sample proof; required to register. */
  selftest?: VerifierSelftest
  supports(mode: VerificationMode): boolean
  verify(req: VerifyRequest): Promise<VerificationResult[]>
}

export interface VerifyRequest {
  taskId: TaskId
  runId: RunId
  criteria: AcceptanceCriterion[]
  cwd: string // absolute dir to run commands in (the graph env checkout)
  logDir: string // absolute dir for this run's logs; results store paths relative to evidenceRoot
  timeoutMs?: number
}

/** The criterion a selftest sample hands a verifier: the shared skeleton, with the sample's own fields layered on. */
export function sampleCriterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    criterionId: 'selftest-sample',
    description: 'a selftest sample',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    ...overrides,
  }
}

/** Caps for the log-tail excerpt a review record carries: enough to read the failure, small enough to keep a record lean. */
export const LOG_TAIL_MAX_LINES = 40
export const LOG_TAIL_MAX_CHARS = 2048

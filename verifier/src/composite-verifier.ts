import type {
  AcceptanceCriterion,
  ChildEvidenceRef,
  EvidenceBundle,
  RunId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  VerificationMode,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'
import { sampleCriterion, type Verifier, type VerifierSelftest, type VerifyRequest } from './types.ts'

/** The slice of the task service the composite verifier reads: the run's members and the store snapshot. */
export interface CompositeTaskSource {
  /** The judged run's members **by position** (`TaskService.runMemberSlotsIn`); `undefined` is an unfilled slot. */
  runMemberSlotsIn(storeId: string, runId: RunId): Promise<(TaskInstance | undefined)[]>
  /** The full store snapshot, for the child-evidence map's reads of run states and verdicts. */
  snapshotIn(storeId: string): Promise<TaskSnapshot>
}

/** The registered id of the composite judge: the class and the pure judgement must sign their verdicts with one id. */
const COMPOSITE_VERIFIER_ID = 'composite'

/** How one map entry reads when it is satisfied. */
function describeSatisfied(entry: ChildEvidenceRef, child: TaskInstance): string {
  const who = `child #${entry.childIndex} (${child.taskId})`
  if (entry.criterionId !== undefined) return `${who} criterion "${entry.criterionId}" passed`
  if (entry.evidenceRef !== undefined) return `${who} evidence "${entry.evidenceRef}" present`
  return `${who} verified`
}

/** How one map entry reads when it is missing — the reason names the item verbatim. */
function describeEntry(entry: ChildEvidenceRef): string {
  const parts = [`child #${entry.childIndex}`]
  if (entry.criterionId !== undefined) parts.push(`criterion "${entry.criterionId}"`)
  if (entry.evidenceRef !== undefined) parts.push(`evidence "${entry.evidenceRef}"`)
  return parts.join(' ')
}

/** The defect one map entry carries against the store, or `undefined` when the entry is satisfied. */
function entryDefect(
  entry: ChildEvidenceRef,
  children: readonly (TaskInstance | undefined)[],
  snapshot: TaskSnapshot,
): string | undefined {
  const child = children[entry.childIndex]
  if (child === undefined) {
    return `child #${entry.childIndex} does not exist (the run's member sequence holds ${children.filter(item => item !== undefined).length} filled position(s))`
  }
  if (child.status !== 'verified') {
    return `child #${entry.childIndex} (${child.taskId}) is ${child.status}, not verified`
  }
  const verifiedRun = snapshot.runs.find(run => run.taskId === child.taskId && run.status === 'verified')
  const bundles = snapshot.evidence.filter(item => item.taskRunId === verifiedRun?.runId)
  if (entry.criterionId !== undefined) {
    const criterion = child.acceptanceCriteria.find(item => item.criterionId === entry.criterionId)
    if (criterion === undefined) {
      return `child #${entry.childIndex} (${child.taskId}) has no criterion "${entry.criterionId}"`
    }
    if (criterion.heuristic === true) {
      return `child #${entry.childIndex} (${child.taskId}) criterion "${entry.criterionId}" is heuristic, not deterministic evidence`
    }
    const verdict = bundles.flatMap(item => item.verifierResults).find(item => item.criterionId === entry.criterionId)
    if (verdict?.status !== 'pass') {
      return (
        `child #${entry.childIndex} (${child.taskId}) criterion "${entry.criterionId}" has no passing verdict in its verified run's evidence` +
        (verdict === undefined ? '' : ` (verdict ${verdict.status})`)
      )
    }
  }
  if (entry.evidenceRef !== undefined) {
    // The three spellings a contract can name a product by, taken from the verified run's own evidence.
    const refs = new Set(
      bundles.flatMap(item => [
        item.evidenceId,
        ...item.artifacts.flatMap(artifact => [artifact.kind, artifact.artifactId]),
      ]),
    )
    if (!refs.has(entry.evidenceRef)) {
      return `child #${entry.childIndex} (${child.taskId}) evidence does not contain "${entry.evidenceRef}" (evidence id, artifact kind, or artifact id)`
    }
  }
  return undefined
}

/** Judged by child-status conjunction, plus the child-evidence map when the criterion declares one. */
export async function judgeCompositeCriterion(
  criterion: AcceptanceCriterion,
  members: readonly (TaskInstance | undefined)[],
  snapshot: () => Promise<TaskSnapshot>,
): Promise<VerificationResult> {
  const map = criterion.childEvidence ?? []
  const base = { criterionId: criterion.criterionId, verifierId: COMPOSITE_VERIFIER_ID }

  if (members.length === 0) {
    if (map.length === 0) {
      return { ...base, status: 'inconclusive', details: 'no child tasks' }
    }
    // A declared map with no members to satisfy it is incomplete, not absent: refusing keeps it from degrading silently.
    return {
      ...base,
      status: 'fail',
      details: `incomplete childEvidence map: the run has admitted no members to satisfy ${map.map(describeEntry).join('; ')}`,
    }
  }

  // An unfilled position is not verified either: the criterion is judged over the run's whole member sequence.
  const unverified = members.flatMap((child, index) =>
    child?.status === 'verified'
      ? []
      : [child === undefined ? `#${index} (unfilled)` : `${child.taskId}(${child.status})`],
  )
  if (unverified.length > 0) {
    return {
      ...base,
      status: 'fail',
      details: `unverified children: ${unverified.join(', ')}`,
    }
  }

  if (map.length === 0) {
    // The conjunction verdict; a heuristic label rides along as a coverage signal, not a deterministic pass (KISS §5.1).
    return {
      ...base,
      status: 'pass',
      ...(criterion.heuristic === true
        ? {
            details:
              'heuristic conjunction: every child verified — explicitly labeled heuristic (KISS §5.1); a conjunction is a coverage signal, not a deterministic proof of the parent goal, and is not counted as one',
          }
        : {}),
    }
  }

  const store = await snapshot()
  const defects = map
    .map(entry => entryDefect(entry, members, store))
    .filter((defect): defect is string => defect !== undefined)
  if (defects.length > 0) {
    return { ...base, status: 'fail', details: `incomplete childEvidence map: ${defects.join('; ')}` }
  }
  return {
    ...base,
    status: 'pass',
    details: `childEvidence satisfied: ${map.map(entry => describeSatisfied(entry, members[entry.childIndex]!)).join('; ')}`,
  }
}

/** The criterion a composite selftest sample hands the judge. */
function compositeSample(childEvidence: ChildEvidenceRef[]): AcceptanceCriterion {
  return sampleCriterion({
    criterionId: 'selftest-child-evidence',
    description: 'the parent goal rests on the child evidence the map names',
    verificationMode: 'composite',
    childEvidence,
  })
}

/** The verified child the samples judge over, carrying the criterion a sample names. */
function selftestChild(criterionId: string): TaskInstance {
  return {
    taskId: 'selftest-child',
    definitionRef: { taskType: 'selftest', version: 1 },
    parentTaskId: 'selftest-parent',
    objective: 'the child work the parent rests on',
    depth: 1,
    acceptanceCriteria: [
      {
        criterionId,
        description: 'the child criterion the map names',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      },
    ],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'verified',
    runIds: ['selftest-run'],
    childTaskIds: [],
  }
}

/** The verified run the samples' child carries. */
function selftestRun(): TaskRun {
  return {
    runId: 'selftest-run',
    taskId: 'selftest-child',
    sessionId: 'selftest-session',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'verified',
    startedAt: '2026-09-21T00:00:00.000Z',
    finishedAt: '2026-09-21T00:01:00.000Z',
  }
}

/** The bundle that verified run left behind, carrying the verdicts given. */
function selftestBundle(verdicts: VerificationResult[]): EvidenceBundle {
  return {
    evidenceId: 'selftest-evidence',
    taskRunId: 'selftest-run',
    taskId: 'selftest-child',
    artifacts: [],
    verifierResults: verdicts,
    claims: verdicts.map(verdict => ({
      claimId: `selftest-evidence#${verdict.criterionId}`,
      criterionId: verdict.criterionId,
      status: verdict.status,
      verifierId: verdict.verifierId,
      artifactRefs: [],
    })),
    generatedAt: '2026-09-21T00:01:00.000Z',
  }
}

export class CompositeVerifier implements Verifier {
  readonly id = COMPOSITE_VERIFIER_ID
  readonly version = '1'
  /** Known samples: one map the fixture store satisfies, one whose named criterion has no passing verdict. */
  readonly selftest: VerifierSelftest = {
    samples: [
      {
        role: 'positive',
        name: 'a childEvidence map the verified child evidence satisfies',
        criterion: compositeSample([{ childIndex: 0, criterionId: 'selftest-child-criterion' }]),
        expect: 'pass',
        store: {
          children: [selftestChild('selftest-child-criterion')],
          runs: [selftestRun()],
          evidence: [
            selftestBundle([{ criterionId: 'selftest-child-criterion', status: 'pass', verifierId: 'command' }]),
          ],
        },
      },
      {
        role: 'negative',
        name: 'a childEvidence map whose named criterion has no passing verdict',
        criterion: compositeSample([{ childIndex: 0, criterionId: 'selftest-child-criterion' }]),
        expect: 'fail',
        store: {
          children: [selftestChild('selftest-child-criterion')],
          runs: [selftestRun()],
          evidence: [
            selftestBundle([{ criterionId: 'selftest-child-criterion', status: 'inconclusive', verifierId: 'review' }]),
          ],
        },
      },
    ],
  }

  constructor(private readonly task: CompositeTaskSource) {}

  supports(mode: VerificationMode): boolean {
    return mode === 'composite'
  }

  async verify(req: VerifyRequest): Promise<VerificationResult[]> {
    return req.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: 'inconclusive' as const,
      verifierId: this.id,
      details: 'composite verification requires store context',
    }))
  }

  async verifyIn(storeId: string, req: VerifyRequest): Promise<VerificationResult[]> {
    const members = await this.task.runMemberSlotsIn(storeId, req.runId)
    const results: VerificationResult[] = []
    for (const criterion of req.criteria) {
      results.push(await judgeCompositeCriterion(criterion, members, () => this.task.snapshotIn(storeId)))
    }
    return results
  }
}

/**
 * The new-protocol fixtures: one frozen plan, one report and one ledger, shaped
 * exactly as `types.ts` declares them so a spec cannot pass against a shape the
 * pipeline would refuse.
 */

import { digestOf } from '../../src/shared.ts'
import { scoreEvaluation } from '../../src/pipeline/score.ts'
import type {
  DraftStatus,
  EvaluationPlan,
  EvaluationReport,
  ExecutionReceiptRef,
  MethodDraft,
  SidePlan,
  TrialComparison,
  TrialResult,
} from '../../src/types.ts'
import type { CandidateRevision, CostReading, FrozenCriterion, RevisionRef } from '../../src/types.ts'

export const LIBRARY = 'lib-1'

export function revisionRef(revisionId: string, digest = digestOf({ revisionId })): RevisionRef {
  return { revisionId, digest, libraryId: LIBRARY }
}

export function criterion(criterionId: string): FrozenCriterion {
  return {
    criterionId,
    verificationMode: 'command',
    command: `run ${criterionId}`,
    protectedInputsDigest: digestOf({ criterionId }),
    verifierRef: 'command-verifier',
    verifierVersion: '3',
    verifierAnchor: 'registered verifier "command-verifier" declares version "3"',
  }
}

export function sidePlan(side: 'baseline' | 'candidate', revisionId: string): SidePlan {
  return {
    side,
    revision: revisionRef(revisionId),
    capabilities: ['execute-task'],
    registryRevision: digestOf({ side, revisionId }),
    mcpServers: [],
    preset: null,
    skills: [
      { name: 'task-coordination', role: 'guidance', contractDigest: null, contentDigest: digestOf({ skill: side }) },
    ],
    model: { provider: 'test-provider', model: 'test-model', label: 'test-provider/test-model' },
    acceptance: [criterion('c1'), criterion('c2')],
  }
}

export function samplePlan(overrides: { draftId?: string; rules?: EvaluationPlan['rules'] } = {}): EvaluationPlan {
  const draftId = overrides.draftId ?? 'd0001'
  const samples = [
    { taskId: 'case-a', role: 'observed-failure' as const },
    { taskId: 'case-b', role: 'holdout' as const },
  ].map(sample => ({
    ...sample,
    contractDigest: digestOf({ sample: sample.taskId }),
    criteria: [criterion('c1'), criterion('c2')],
    observed: { outcome: 'failed' as const, runId: `run-${sample.taskId}` },
  }))
  return {
    planId: digestOf({ draftId, plan: 1 }).slice(0, 16),
    draftId,
    kind: 'skill',
    libraryId: LIBRARY,
    sides: { baseline: sidePlan('baseline', 'r0001'), candidate: sidePlan('candidate', 'c-d0001') },
    samples,
    input: { sourceDir: '/tmp/input', digest: digestOf({ input: 1 }) },
    rules: overrides.rules ?? {
      quality: { metricId: 'acceptance', direction: 'higher-is-better', extractor: 'original-acceptance' },
      guards: [],
    },
    budget: { maxTokens: 100_000, note: 'fixture' },
    repetition: 0,
    overlay: { baseline: 'none', candidate: 'the candidate revision' },
    schemaVersion: 'evaluation-plan@1',
  }
}

export function receipt(input: {
  runId: string
  revisionId: string
  cost?: CostReading
  verdicts?: readonly ('pass' | 'fail' | 'inconclusive')[]
}): ExecutionReceiptRef {
  const verdicts = input.verdicts ?? ['pass', 'pass']
  return {
    receiptId: input.runId,
    digest: digestOf({ receipt: input.runId }),
    taskId: `task-${input.runId}`,
    runId: input.runId,
    reviewRef: `task-${input.runId}#${input.runId}`,
    criteria: verdicts.map((verdict, index) => ({ criterionId: `c${index + 1}`, verdict, verifierId: 'command-verifier', verifierVersion: '3' })),
    evidenceRefs: [`evidence:${input.runId}`],
    cost: input.cost ?? { status: 'reported', tokens: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    boundRevision: input.revisionId,
    boundModel: 'test-provider/test-model',
    workspace: `/tmp/ws/${input.runId}`,
    workspaceDigest: digestOf({ input: 1 }),
    complete: true,
  }
}

export function trial(input: {
  sampleTaskId: string
  side: 'baseline' | 'candidate'
  role?: TrialResult['role']
  outcome?: TrialResult['outcome']
  revisionId?: string
  cost?: CostReading
  verdicts?: readonly ('pass' | 'fail' | 'inconclusive')[]
}): TrialResult {
  const outcome = input.outcome ?? 'verified'
  const revisionId = input.revisionId ?? (input.side === 'baseline' ? 'r0001' : 'c-d0001')
  return {
    sampleTaskId: input.sampleTaskId,
    side: input.side,
    role: input.role ?? 'observed-failure',
    outcome,
    receipt: receipt({ runId: `${input.side}-${input.sampleTaskId}`, revisionId, ...(input.cost === undefined ? {} : { cost: input.cost }), ...(input.verdicts === undefined ? {} : { verdicts: input.verdicts }) }),
    actor: 'fixture',
    at: '2026-10-08T00:00:00.000Z',
  }
}

export function sampleReport(input: {
  plan?: EvaluationPlan
  trials?: readonly TrialComparison[]
  verdict?: EvaluationReport['verdict']
} = {}): EvaluationReport {
  const plan = input.plan ?? samplePlan()
  const trials: readonly TrialComparison[] =
    input.trials ??
    plan.samples.map(sample => ({
      sampleTaskId: sample.taskId,
      role: sample.role,
      baseline: trial({ sampleTaskId: sample.taskId, side: 'baseline', role: sample.role }),
      candidate: trial({ sampleTaskId: sample.taskId, side: 'candidate', role: sample.role }),
      verdict: 'fixed' as const,
    }))
  return {
    formatVersion: 5,
    draftId: plan.draftId,
    evaluationId: digestOf({ plan: plan.planId }).slice(0, 16),
    planId: plan.planId,
    libraryId: plan.libraryId,
    kind: plan.kind,
    at: '2026-10-08T00:00:00.000Z',
    plan,
    planDigest: digestOf(plan),
    trials,
    score: scoreEvaluation({ plan, trials, repeats: 3, noiseBand: 0.02 }),
    guards: [],
    verdict: input.verdict ?? 'fixed',
  }
}

export function draft(overrides: { draftId?: string; kind?: MethodDraft['kind']; status?: DraftStatus } = {}): MethodDraft {
  const draftId = overrides.draftId ?? 'd0001'
  const candidateRevision: CandidateRevision = {
    revisionId: `c-${draftId}`,
    digest: digestOf({ candidate: draftId }),
    files: [{ path: 'skills/task-coordination/SKILL.md', sha256: digestOf({ file: draftId }) }],
  }
  return {
    draftId,
    kind: overrides.kind ?? 'skill',
    identity: 'task-coordination',
    baseRevision: revisionRef('r0001'),
    candidateRevision,
    rationale: 'fixture candidate',
    sourceRefs: ['diagnosis:d1'],
    actor: 'supervisor',
    at: '2026-10-08T00:00:00.000Z',
  }
}

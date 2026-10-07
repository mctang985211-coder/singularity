/** The promotion gate's shared vocabulary and refusal texts, used by the skill and capability gates.
 * @module dsh-singularity-evolution/promotion/shared */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { EvolutionProposal } from '../evolution.ts'
import type { ExperimentView } from '../experiment/freeze.ts'
import type {
  ExperimentReport,
  ExperimentSampleComparison,
  ExperimentVerdict,
  ModelSelection,
  SkillContentIdentity,
} from '../replay.ts'

/** Whether two object identities are the same identity, member by member (K3): name, SKILL.md digest and sidecar identity. */
export function sameIdentity(left: SkillContentIdentity, right: SkillContentIdentity): boolean {
  if (left.name !== right.name || left.sha256 !== right.sha256) return false
  if (JSON.stringify(left.resources ?? []) !== JSON.stringify(right.resources ?? [])) return false
  if ((left.contract === undefined) !== (right.contract === undefined)) return false
  if (left.contract === undefined || right.contract === undefined) return true
  return (
    left.contract.sha256 === right.contract.sha256 && left.contract.contractDigest === right.contract.contractDigest
  )
}

/** One identity as a refusal names it, sidecar half included. */
export function identityLabel(identity: SkillContentIdentity): string {
  const base = `${identity.name}@${identity.sha256}`
  return identity.contract === undefined
    ? base
    : `${base} + ${identity.contract.sha256} (declaration ${identity.contract.contractDigest})`
}

/** The task store as the gate reads it back: the runs, reviews and evidence an experiment's sides cite. */
export interface PromotionStoreReads {
  openStore(storeId: string): Promise<TaskSnapshot>
}

/** The registered verifier vocabulary a report's criteria are judged against, as the registry lists it now. */
export interface VerifierVocabulary {
  readonly ids: readonly string[]
  /** Declared versions by verifier id; a verifier that declares none is absent. */
  readonly versions: Readonly<Record<string, string>>
}

/** The services and facts the gate reads. Every one of them is resolved by the caller from its own context. */
export interface SkillPromotionSources {
  /** Absolute ledger root: the report path is resolved inside it. */
  readonly root: string
  /** Every experiment folded under one proposal, newest first. */
  experiments(proposalId: string): Promise<ExperimentView[]>
  readonly task: PromotionStoreReads
  /** The registered judges, or `undefined` when the deployment cannot list them (fail-closed). */
  verifierVocabulary(): Promise<VerifierVocabulary | undefined>
  /** The deployment's own selection now. It is the second half of the model binding re-check. */
  modelSelection(): ModelSelection
  /** One session's own durable log (`sessionQuery.readSession`), or `undefined` */
  sessionLog(sessionId: string): Promise<readonly SessionEvent[] | undefined>
}

/** What a passing gate proves, for the caller to report: the experiment, its report and where it sits. */
export interface SkillPromotionEvidence {
  readonly experimentId: string
  readonly report: ExperimentReport
  /** Report path relative to the ledger root. */
  readonly reportPath: string
}

/** The refusal every other target type gets: no evaluator, no promotion — this build evaluates skills and capability candidates only. */
export function noEvaluatorRefusal(proposal: EvolutionProposal): Error {
  return new Error(
    `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — ` +
      'the two-sided experiment (§F.2) evaluates a replacement of an existing skill object, and a capability candidate (A6) is measured by ' +
      'the same experiment against its own overlay, so no other target type has evidence a promotion may read and an older record is ' +
      'never upgraded into new evidence.',
  )
}

/** The refusal of a skill proposal nothing has evaluated yet. */
export function noExperimentRefusal(proposal: EvolutionProposal): Error {
  return new Error(
    `evolution: skill proposal "${proposal.proposalId}" carries no two-sided experiment — a PROMOTE needs both sides of every ` +
      "frozen sample run as this experiment's own new runs; evaluate the candidate with evolution_replay before promoting it",
  )
}

/** Refusal text for each categorical experiment verdict. */
export const VERDICT_REFUSALS: Readonly<Record<ExperimentVerdict, string>> = {
  fixed: '',
  improved: '',
  'not-improved': 'the candidate did not reduce measured tool calls on every observed-success sample',
  'fixed-with-regression':
    'the target failure is fixed, but a regression or holdout sample degraded under the candidate',
  regressed: 'a regression or holdout sample degraded and the target failure is not fixed',
  'not-fixed': 'the candidate did not fix the target failure',
  'both-failed':
    'the target failure was reproduced on the baseline and still fails on the candidate (both sides failed)',
  inconclusive: 'the experiment could not settle, so it says nothing about the candidate',
}

/** `sample <taskId> [<role>]: <verdict>` per sample — the detail a verdict refusal carries. */
export function sampleVerdictLines(samples: readonly ExperimentSampleComparison[]): string[] {
  return samples.map(sample => `sample ${sample.taskId} [${sample.role}]: ${sample.verdict}`)
}

/** The report's byte serialization, exactly as the orchestrator writes it. */
export function reportBytes(report: ExperimentReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

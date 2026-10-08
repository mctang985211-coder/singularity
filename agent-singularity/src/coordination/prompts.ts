/**
 * The one supervisor prompt this platform writes: where the round stands, what
 * the platform concluded about it, and how the session ends. There is no second
 * builder for a verified and a failed round, and no fence-format or re-prompt
 * instruction — the completion tool is the protocol.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/prompts
 */

import type { ReviewRecord, TaskRun } from '@dangosys/dsh-singularity-task'
import { renderSupervisorReviewFacts } from './render.ts'

/** Everything one round's supervisor request is built from. */
export interface SupervisionFacts {
  readonly graphId: string
  readonly graphName: string
  readonly epoch: number
  readonly businessRound: number
  readonly searchRound: number
  readonly rounds: number
  readonly objective: string
  readonly metrics: readonly string[]
  readonly outcome: 'verified' | 'failed'
  readonly run: TaskRun
  readonly review?: ReviewRecord
  readonly diagnosisId: string
  /** The rendered cost lines of this round's execution subtree and the graph so far. */
  readonly cost: readonly string[]
  /** The active method revision and the last one this graph published, when the environment plane can answer. */
  readonly method: { readonly activeRevision?: string; readonly lastPublishedRevision?: string }
  /** The search-strategy view, when the deployment has one. */
  readonly strategy?: {
    readonly editBudget: number
    readonly steering: 'explore' | 'stop-search'
    readonly untestedMechanisms: readonly string[]
    readonly lines: readonly string[]
  }
  readonly finalRound: boolean
}

/** The lines describing where this round stands and what its evidence is. */
function locationLines(facts: SupervisionFacts): string[] {
  const { run, review } = facts
  const artifacts = run.artifacts ?? []
  return [
    `Store: the root store of graph "${facts.graphName}"; root task run: ${run.runId} (session ${run.sessionId ?? 'unrecorded'}).`,
    `Round objective as recorded on the graph: ${facts.objective}`,
    `Metrics to explore and improve: ${facts.metrics.join('; ') || 'derive useful measurements from the task and state the assumptions'}.`,
    'Use the current task criteria to judge this execution, and its findings to improve reusable paths and experience.',
    review === undefined
      ? 'The store holds no review record for this run.'
      : `The round's review settled ${review.outcome}. ${renderSupervisorReviewFacts(review)}`,
    "Where this round's delivery and evidence live:",
    run.placement?.workspacePath === undefined
      ? "- the run recorded no separate working tree; read the store's evidence bundles"
      : `- the run's working tree: ${run.placement.workspacePath} (read/glob/grep it directly)`,
    ...(artifacts.length === 0
      ? ['- the run recorded no artifacts of its own']
      : artifacts.map(
          artifact =>
            `- artifact ${artifact.artifactId} (${artifact.kind}) at ${artifact.uri}${artifact.digest === undefined ? '' : ` sha256:${artifact.digest}`}`,
        )),
    review === undefined || review.evidenceRefs.length === 0
      ? '- the review recorded no evidence ids'
      : `- store evidence ids: ${review.evidenceRefs.join(', ')} (context_read kind:"evidence")`,
  ]
}

/** The lines describing the method this graph is running now. */
function methodLines(facts: SupervisionFacts): string[] {
  return [
    `Active method revision: ${facts.method.activeRevision ?? 'unknown'}`,
    `Last revision published by this graph: ${facts.method.lastPublishedRevision ?? 'none recorded'}`,
  ]
}

/** The lines of the search-strategy view, when this deployment has one. */
function strategyLines(facts: SupervisionFacts): string[] {
  const strategy = facts.strategy
  if (strategy === undefined) return []
  return [
    `Search strategy: edit budget ${strategy.editBudget}; steering ${strategy.steering}.`,
    ...(strategy.untestedMechanisms.length === 0
      ? []
      : [`Untested mechanisms worth a round: ${strategy.untestedMechanisms.join(', ')}.`]),
    ...strategy.lines,
  ]
}

/** The one supervision request one round's supervisor receives. */
export function supervisionPrompt(facts: SupervisionFacts): string {
  const verified = facts.outcome === 'verified'
  return [
    `You are the platform RSI loop's supervisor for graph "${facts.graphName}" (${facts.graphId}), ` +
      `epoch ${facts.epoch}, round ${facts.businessRound} of ${facts.rounds} (search round ${facts.searchRound}).`,
    ...locationLines(facts),
    ...facts.cost,
    ...methodLines(facts),
    ...strategyLines(facts),
    `Cite diagnosis:${facts.diagnosisId} when you record evidence for this round.`,
    '',
    ...(verified
      ? [
          "The round settled verified against the store's own acceptance criteria. Review its delivery and its reusable method, then choose one improvement or retain the current method.",
        ]
      : [
          `The round settled ${facts.run.status}. Debug that failure from its evidence, review and delivery, and choose the reusable method change that helps the next attempt. A one-off environmental or input repair is a repair, not a method change.`,
        ]),
    ...(facts.finalRound
      ? [
          'Final round: review this execution’s paths and experience for retention or revision. Settle your findings; this graph completes after your completion, and later Tasks can test any publication.',
        ]
      : []),
    'Compare candidates with the method tools you have and publish within your authority.',
    '',
    "End this session by calling supervisor_complete with exactly these parameters: businessAction ('continue' when the business work should run another round, 'recover' when the next round must repair this failure, 'finish' when it should not), reason (non-empty free text), evidenceRefs (at least one recorded review/evidence/criterion reference), and trialCandidateRef (only when this round should explicitly try one candidate).",
    'The platform derives the method decision and the approval source from what your round actually recorded; they are not parameters and cannot be asserted.',
    'Calling it closes this session’s write access; reads, evidence and findings stay available. The platform opens the next execution only after this session’s log has been flushed. A session that ends its turn without calling the tool is a protocol failure, and the platform will not ask again — raising the graph’s epoch is the way to try a round once more.',
  ].join('\n')
}

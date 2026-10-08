/** The read model's fact inputs: one graph key, the coordination facts and the method facts. @module @dangosys/dsh-singularity-context/view-types */

import type {
  ApprovalSourceWire,
  GraphEvaluationWire,
  GraphRevisionWire,
} from '@dangosys/dsh-singularity-graphs/wire'

/** The read model's fact key: the graph's root task store id, never the id the UI selects a graph by. */
export type GraphKey = string

/** One coordination assignment a graph holds, as its store records it. */
export interface CoordinationAssignmentFacts {
  readonly assignmentId: string
  readonly role: 'reviewer' | 'supervisor' | 'coordinator'
  readonly round: number
  readonly sessionId: string
  readonly sourceTaskId: string
  readonly sourceRunId: string | null
  readonly state: 'open' | 'settled' | 'interrupted'
  /** The structured completion the assignment settled with; absent means the round produced no completion. */
  readonly completion?: CoordinationCompletionFacts
}

/** One structured completion; without it there is no completion, and the legacy text formats are not one. */
export interface CoordinationCompletionFacts {
  readonly businessAction: 'continue' | 'recover' | 'finish'
  readonly searchNext: 'explore' | 'stop'
  readonly methodDecision: 'retain' | 'trial' | 'promote' | 'discard' | 'rollback'
  readonly reason: string
  readonly evidenceRefs: readonly string[]
  readonly trialCandidateRef?: string
  readonly approval?: ApprovalSourceWire
  readonly at: string
}

/** Where a graph's coordination facts are read: produced by the coordination plane, consumed here. */
export interface CoordinationFactsReader {
  assignments(graphKey: GraphKey): Promise<readonly CoordinationAssignmentFacts[]>
}

/** Where a graph's method facts are read: the active revision and the latest evaluation. */
export interface MethodFactsReader {
  activeRevision(graphKey: GraphKey): Promise<GraphRevisionWire | null>
  latestEvaluation(graphKey: GraphKey): Promise<GraphEvaluationWire | null>
}

/** The fact producers one deployment registers; a missing producer is refused by name, never defaulted. */
export interface ViewFactSources {
  readonly coordination?: CoordinationFactsReader
  readonly method?: MethodFactsReader
}

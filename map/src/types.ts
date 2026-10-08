import type {
  GraphAccessWire,
  GraphEvaluationWire,
  GraphProgressWire,
  GraphRevisionWire,
} from '@dangosys/dsh-singularity-graphs/wire'

export type GraphAccess = GraphAccessWire
export type GraphProgress = GraphProgressWire
export type GraphEvaluation = GraphEvaluationWire

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed'
export type EdgeKind = 'spawn' | 'handoff'
export type NodeShape = 'card' | 'circle' | 'diamond'

export interface AgentNode {
  readonly id: string
  readonly name: string
  readonly status: AgentStatus
  readonly routerFor?: string
}

export interface GraphEdge {
  readonly id: string
  readonly kind: EdgeKind
  readonly from: string
  readonly to: string
  readonly brief?: string
}

export interface GraphSnapshot {
  readonly version: 1
  readonly id: string
  readonly roots: readonly string[]
  readonly agents: readonly AgentNode[]
  readonly edges: readonly GraphEdge[]
}

export interface CanvasNode {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly shape: NodeShape
}

export interface LayoutSnapshot {
  readonly version: 1
  readonly id: string
  readonly nodes: Readonly<Record<string, CanvasNode>>
}

export interface AgentData extends AgentNode {
  readonly width: number
  readonly height: number
  readonly shape: NodeShape
  readonly root: boolean
}

// Wire forks for the operator console (graphs list, task snapshot, recovery, review): browser-local
// copies with the same rule as above, optional where the projection may omit or later extend a field.
// The graph read model is not forked: `GraphEntry.access`, `progress` and `evaluation` are the
// server's own `GraphViewWire` members, so the console shows what the tools read.

/** A pinned model choice; omitted on a graph or create body means follow the deployment default. */
export interface ModelRef {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelOption {
  readonly id: string
  readonly name: string
}

export interface ModelProvider {
  readonly id: string
  readonly displayName: string
  readonly models: readonly ModelOption[]
  readonly error?: string
}

export interface ModelsResponse {
  readonly providers: readonly ModelProvider[]
  readonly default: ModelRef
}

/** A graph-level RSI run: the round objective, how many rounds to iterate, and whether a human gates each round. */
export interface RsiConfig {
  readonly task: string
  readonly metrics?: readonly string[]
  readonly iterationRounds: number
  readonly humanReview: boolean
}

export interface GraphEntry {
  readonly id: string
  readonly name: string
  readonly ready: boolean
  readonly envId?: string
  readonly rootSessionId?: string
  readonly graphStoreId?: string
  readonly layoutStoreId?: string
  readonly createdAt?: number
  readonly repos?: readonly string[]
  readonly model?: ModelRef
  readonly rsi?: RsiConfig
  /** The protocol marker's absence is what makes a graph sealed history; every write control reads this. */
  readonly access?: GraphAccessWire
  /** The derived progress the server reduced from the round count and the recorded assignments. */
  readonly progress?: GraphProgressWire
  readonly evaluation?: GraphEvaluationWire
}

export interface GraphsResponse {
  readonly graphs?: readonly GraphEntry[]
  readonly selectedId?: string | null
  /** The named refusal when this deployment mounts no fact producer for the read model; the list still serves. */
  readonly viewError?: { readonly error?: string; readonly source?: string }
}

/** One graph's read model, as `GET /singularity/view` serves it. */
export interface GraphViewResponse {
  readonly formatVersion: 2
  readonly graph: { readonly id: string; readonly name: string; readonly createdAt: number }
  readonly access: GraphAccessWire
  readonly revision: GraphRevisionWire | null
  readonly evaluation: GraphEvaluationWire | null
  readonly progress: GraphProgressWire
  readonly generation: number
}

/** One legacy completion row, shown verbatim: the old text formats are never read as completions again. */
export interface LegacyCompletionWire {
  readonly format: 'legacy-v1'
  readonly sessionId: string
  readonly taskId: string
  readonly note: string
  readonly recordedAt: string
}

/**
 * One sealed graph's history, as `GET /singularity/graphs/<id>/history` serves
 * it: the old records verbatim, forever `writable: false`.
 */
export interface LegacyHistoryResponse {
  readonly formatVersion: 'legacy-v1'
  readonly writable: false
  readonly graph: GraphEntry
  readonly access: GraphAccessWire
  readonly topology: GraphSnapshot | null
  readonly layout: LayoutSnapshot | null
  readonly tasks: TaskSnapshotWire | null
  readonly proposals: readonly unknown[]
  readonly experiments: readonly unknown[]
  readonly completions: readonly LegacyCompletionWire[]
  readonly sources: readonly { readonly id: string; readonly kind: 'topology' | 'layout' | 'tasks'; readonly exists: boolean }[]
}

export interface GraphEnv {
  readonly id: string
  readonly label?: string
  readonly path?: string
  readonly componentCount?: number
  readonly sessionCount?: number
  readonly available: boolean
  readonly bound?: boolean
  readonly assets?: {
    readonly skills: { readonly exists: boolean; readonly count: number; readonly error?: string }
    readonly taskTemplates: { readonly exists: boolean; readonly count: number; readonly error?: string }
  }
}

export interface CreateGraphBody {
  readonly name?: string
  readonly envId?: string
  readonly createEnv?: true
  /** Always allocate a new environment rather than reuse one with matching repositories. */
  readonly fresh?: boolean
  readonly repos?: readonly string[]
  readonly model?: ModelRef
  readonly rsi?: RsiConfig
}

export type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled'
export type ExecutionPhase = 'active' | 'waiting_children' | 'submitted'
export type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked'
export type TaskStatus =
  'created' | 'admitted' | 'ready' | 'running' | 'blocked' | 'verifying' | 'verified' | 'failed' | 'cancelled'
/** A projection collection: the snapshot may index records by id or list them; readers normalize. */
export type SnapshotCollection<T> = readonly T[] | Readonly<Record<string, T>>

export interface AcceptanceCriterionWire {
  readonly criterionId?: string
  readonly description?: string
  readonly verificationMode?: string
  readonly mandatory?: boolean
  readonly command?: string
  readonly requiredEvidence?: readonly string[]
}

export interface TaskContractWire {
  readonly contractVersion?: number
  readonly objective?: string
  readonly acceptanceCriteria?: readonly AcceptanceCriterionWire[]
  readonly assumptions?: readonly string[]
  readonly constraints?: readonly string[]
  readonly requiredCapabilities?: readonly string[]
}

export interface TaskInstanceWire {
  readonly taskId: string
  readonly objective?: string
  readonly status?: string
  readonly depth?: number
  readonly parentTaskId?: string
  readonly decompositionStatus?: string
  readonly runIds?: readonly string[]
  readonly childTaskIds?: readonly string[]
  readonly requestedCapabilities?: readonly string[]
  readonly acceptanceCriteria?: readonly AcceptanceCriterionWire[]
  readonly requiresIndependentAcceptance?: boolean
}

export interface SubmissionWire {
  readonly summary: string
  readonly evidenceRefs?: readonly string[]
  readonly notes?: string
  readonly submittedAt?: string
  readonly origin?: string
}

export interface ArtifactRefWire {
  readonly artifactId?: string
  readonly kind?: string
  readonly uri?: string
  readonly digest?: string
}

export interface RunBatchWire {
  readonly batchId: string
  readonly proposalId?: string
  readonly memberTaskIds?: readonly string[]
}

export interface TaskRunWire {
  readonly runId: string
  readonly taskId: string
  readonly sessionId?: string
  readonly parentRunId?: string
  readonly status: string
  readonly executionPhase?: string
  readonly batchId?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly submission?: SubmissionWire
  readonly artifacts?: readonly ArtifactRefWire[]
  readonly batches?: readonly RunBatchWire[]
  readonly providerBinding?: { readonly capabilities?: readonly string[] }
  readonly recovery?: {
    readonly sourceRunId?: string
    readonly requestKey?: string
    /** Iteration round kind: a retry opened from a failed source (`recovery`) or a follow-up opened from a verified one (`improvement`). */
    readonly kind?: 'recovery' | 'improvement'
  }
}

export interface ReviewCriterionWire {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail' | 'inconclusive'
  readonly verifierId?: string
  readonly verifierVersion?: string
  readonly command?: string
  readonly exitCode?: number
  readonly logRef?: string
  /** Which side an inconclusive verdict belongs to: the check never ran (`task`) or the judge is broken (`verifier`). */
  readonly unknownKind?: 'task' | 'verifier'
}

export interface ReviewWire {
  readonly taskId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly outcome: ReviewOutcome
  readonly evidenceRefs?: readonly string[]
  readonly anomalies?: readonly string[]
  readonly localizedCause?: string
  readonly relatedTaskIds?: readonly string[]
  readonly durationMs?: number
  readonly criteria?: readonly ReviewCriterionWire[]
  readonly logTail?: string
  readonly blockedBy?: readonly { readonly taskId: string; readonly outcome?: string }[]
  readonly metrics?: {
    readonly humanInterventions?: number
    readonly retries?: number
    readonly evidenceLogs?: number
  }
}

export interface EvidenceWire {
  readonly evidenceId: string
  readonly taskRunId?: string
  readonly taskId?: string
  readonly artifacts?: readonly ArtifactRefWire[]
  readonly claims?: readonly {
    readonly criterionId?: string
    readonly status?: string
    readonly verifierId?: string
  }[]
  readonly generatedAt?: string
}

export interface DiagnosisWire {
  readonly diagnosisId: string
  readonly taskId?: string
  readonly observedFailure?: string
  readonly localizedCause?: string
  readonly confidence?: string
}

export interface ObligationWire {
  readonly obligationId: string
  readonly goal?: string
  readonly criterion?: string
  readonly sourceTaskId?: string
}

export interface TaskSnapshotWire {
  readonly version?: number
  readonly id: string
  readonly tasks?: SnapshotCollection<TaskInstanceWire>
  readonly runs?: SnapshotCollection<TaskRunWire>
  readonly edges?: SnapshotCollection<{ readonly from: string; readonly to: string }>
  readonly evidence?: SnapshotCollection<EvidenceWire>
  readonly reviews?: SnapshotCollection<ReviewWire>
  /** The store's proposal records: no console surface reads them any more, so the member stays opaque. */
  readonly proposals?: SnapshotCollection<unknown>
  readonly diagnoses?: SnapshotCollection<DiagnosisWire>
  readonly obligations?: SnapshotCollection<ObligationWire>
}

/** The store barrier's status plus the deferred work it still holds (`StoreRecoveryState` counts). */
export type StoreRecoveryPhase =
  'ready' | 'not-activated' | 'recovering' | 'recovery-required' | 'needs-recovery' | 'recovery-failed'

export interface RecoveryNoticeWire {
  readonly sessionId?: string
  readonly text?: string
}

export interface RecoveryBatchResultWire {
  readonly runId?: string
  readonly batchId?: string
  readonly sessionId?: string
  readonly messageId?: string
}

export interface RecoveryStateWire {
  readonly status?: StoreRecoveryPhase
  readonly reason?: string
  readonly wokenSessions?: readonly string[]
  readonly pendingNotices?: readonly RecoveryNoticeWire[]
  readonly pendingBatchResults?: readonly RecoveryBatchResultWire[]
  readonly cancelled?: boolean
}

export interface UnresolvedProposalWire {
  readonly proposalId?: string
  readonly status?: string
  readonly reason?: string
}

export interface QuestionDeliveryWire {
  readonly subject?: string
  readonly messageId?: string
  readonly status?: string
  readonly reason?: string
}

export interface QuestionResumeWire {
  readonly subject?: string
  readonly status?: string
  readonly reason?: string
}

export interface ReconcileReportWire {
  readonly unresolvedProposals?: readonly UnresolvedProposalWire[]
  readonly questionDeliveries?: readonly QuestionDeliveryWire[]
  readonly questionResumes?: readonly QuestionResumeWire[]
}

export interface RecoveryResponse {
  readonly recovery: RecoveryStateWire | null
  readonly reconcile: ReconcileReportWire | null
}

export interface ReviewResponse {
  readonly review: ReviewWire | null
  readonly logTail?: string
}

export interface TaskInvalidation {
  readonly storeId?: string
}


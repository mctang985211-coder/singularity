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

// Wire forks for the operator console (graphs list, task snapshot, evolution): browser-local copies
// with the same rule as above, optional where the projection may omit or later extend a field.

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
}

export interface GraphsResponse {
  readonly graphs?: readonly GraphEntry[]
  readonly selectedId?: string | null
}

export interface GraphEnv {
  readonly id: string
  readonly label?: string
  readonly path?: string
  readonly componentCount?: number
  readonly sessionCount?: number
  readonly available: boolean
  readonly bound?: boolean
}

export interface CreateGraphBody {
  readonly name?: string
  readonly envId?: string
  readonly createEnv?: true
  readonly repos?: readonly string[]
  readonly model?: ModelRef
}

export type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled'
export type ExecutionPhase = 'active' | 'waiting_children' | 'submitted'
export type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked'
export type TaskStatus =
  'created' | 'admitted' | 'ready' | 'running' | 'blocked' | 'verifying' | 'verified' | 'failed' | 'cancelled'
export type ProposalStatus =
  'ready' | 'pending_review' | 'approved' | 'rejected' | 'cancelled' | 'stale' | 'admitted' | 'expired'
export type ProposalDecision = 'approve' | 'reject' | 'continue' | 'cancel'

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

export interface TaskProposalChildWire {
  readonly contract?: TaskContractWire
  readonly dependsOn?: readonly number[]
  readonly decomposable?: boolean
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

export interface AdmissionContextWire {
  readonly maxDepth?: number
  readonly maxChildren?: number
  readonly auditOnly?: {
    readonly maxToolCalls?: number
    readonly tokens?: number
    readonly attempts?: number
  }
}

export interface ReviewContextWire {
  readonly capabilityManifestDigest?: string
  readonly verifiers?: readonly {
    readonly verifierId: string
    readonly version?: string
    readonly configurationDigest?: string
  }[]
}

export interface ProposalDecisionWire {
  readonly outcome?: string
  readonly decidedBy?: string
  readonly decidedAt?: string
  readonly reason?: string
}

export interface TaskProposalWire {
  readonly proposalId: string
  readonly requestKey?: string
  readonly supersedes?: string
  readonly kind?: string
  readonly status: string
  readonly policy?: string
  readonly proposalDigest?: string
  readonly admissionContext?: AdmissionContextWire
  readonly admissionContextDigest?: string
  readonly reviewContext?: ReviewContextWire
  readonly reviewContextDigest?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly identity?: {
    readonly storeId?: string
    readonly parentTaskId?: string
    readonly parentRunId?: string
    readonly callerSessionId?: string
    readonly rootSessionId?: string
    readonly reason?: string
  }
  readonly batch?: readonly TaskProposalChildWire[]
  readonly contract?: TaskContractWire
  readonly decision?: ProposalDecisionWire
  readonly consumption?: {
    readonly kind?: string
    readonly childTaskIds?: readonly string[]
    readonly rootTaskId?: string
    readonly rootRunId?: string
    readonly admittedAt?: string
  }
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

export interface TaskProposalIndexWire {
  readonly all?: readonly TaskProposalWire[]
  readonly byId?: Readonly<Record<string, TaskProposalWire>>
}

export interface TaskSnapshotWire {
  readonly version?: number
  readonly id: string
  readonly tasks?: SnapshotCollection<TaskInstanceWire>
  readonly runs?: SnapshotCollection<TaskRunWire>
  readonly edges?: SnapshotCollection<{ readonly from: string; readonly to: string }>
  readonly evidence?: SnapshotCollection<EvidenceWire>
  readonly reviews?: SnapshotCollection<ReviewWire>
  readonly proposals?: SnapshotCollection<TaskProposalWire> | TaskProposalIndexWire
  readonly diagnoses?: SnapshotCollection<DiagnosisWire>
  readonly obligations?: SnapshotCollection<ObligationWire>
}

// Evolution, recovery and review wire forks (canonical types live in evolution, task-runtime and
// task); optional where a projection may omit a member the record itself requires.

export type EvolutionLevel = 'L1' | 'L2' | 'L3' | 'L4'
export type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'gated' | 'decided' | 'applied' | 'rolledback'
export type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH'

/** The six verbatim Validation Gate questions a human answers, plus the evidence the regression answers cite. */
export interface GateAnswersWire {
  readonly targetFailureFixed?: string
  readonly originalAcceptanceMaintained?: string
  readonly existingRegressionMaintained?: string
  readonly noUnacceptableSideEffects?: string
  readonly holdoutPerformanceAcceptable?: string
  readonly resourceCostAcceptable?: string
  readonly regressionEvidenceRefs?: readonly string[]
}

export interface CommitFileWire {
  readonly target?: string
  readonly baselineSha256?: string | null
  readonly contentSha256?: string | null
  readonly source?: string
}

export interface CommitCapabilityWire {
  readonly name?: string
  readonly baselineSha256?: string | null
  readonly contentSha256?: string | null
  readonly source?: string
}

/** One open commit intent: production is only settled once its intent is closed. */
export interface CommitIntentWire {
  readonly intentId?: string
  readonly proposalId?: string
  readonly direction?: 'apply' | 'rollback'
  readonly approvalRef?: string
  readonly files?: readonly CommitFileWire[]
  readonly capability?: CommitCapabilityWire
  readonly actor?: string
  readonly at?: string
}

/** The folded decision record, for projections that emit the whole record instead of the bare value. */
export interface EvolutionDecisionWire {
  readonly decision?: EvolutionDecision
  readonly note?: string
  readonly approvalRef?: string
  readonly actor?: string
  readonly at?: string
}

export interface EvolutionHistoryEntryWire {
  readonly status?: EvolutionStatus
  readonly actor?: string
  readonly at?: string
}

export interface EvolutionProposalWire {
  readonly proposalId: string
  readonly targetType?: string
  readonly targetId?: string
  readonly baseVersion?: string
  readonly level?: EvolutionLevel
  readonly rationale?: string
  readonly sourceRefs?: readonly string[]
  readonly status?: EvolutionStatus
  /** The ledger folds `GateAnswers`; the detail projection may name the same block `gateAnswers`. */
  readonly gate?: GateAnswersWire
  readonly gateAnswers?: GateAnswersWire
  readonly decision?: EvolutionDecision | EvolutionDecisionWire
  readonly decisionNote?: string
  readonly decisionApprovalRef?: string
  readonly openIntent?: CommitIntentWire
  readonly history?: readonly EvolutionHistoryEntryWire[]
}

export type SideRelation = 'not-worse' | 'worse' | 'inconclusive'
export type ExperimentOutcome = 'verified' | 'failed' | 'cancelled' | 'interrupted' | 'not-admitted'
export type ExperimentSampleRole = 'observed-failure' | 'observed-regression' | 'holdout'
export type ExperimentSampleVerdict =
  'fixed' | 'both-failed' | 'not-fixed' | 'maintained' | 'regressed' | 'inconclusive'
export type ExperimentVerdict =
  'fixed' | 'fixed-with-regression' | 'not-fixed' | 'both-failed' | 'regressed' | 'inconclusive'

export interface ExperimentCriterionWire {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail' | 'inconclusive'
  readonly verifierId?: string
  readonly verifierVersion?: string
  readonly command?: string
  readonly exitCode?: number
}

/** One side of one sample's comparison: this experiment's own replay of that side. */
export interface ExperimentSideWire {
  readonly taskId?: string
  readonly role?: ExperimentSampleRole
  readonly side?: 'baseline' | 'candidate'
  readonly outcome?: ExperimentOutcome
  readonly runId?: string
  readonly reviewRef?: string
  readonly evidenceRefs?: readonly string[]
  readonly workspace?: string
  readonly criteria?: readonly ExperimentCriterionWire[]
  readonly reason?: string
}

export interface ExperimentSampleWire {
  readonly taskId: string
  readonly role?: ExperimentSampleRole
  readonly baseline?: ExperimentSideWire
  readonly candidate?: ExperimentSideWire
  readonly verdict?: ExperimentSampleVerdict
  /** Present when the comparer's side relation is projected; the panel derives it from both sides otherwise. */
  readonly relation?: SideRelation
}

export interface ExperimentReportWire {
  readonly formatVersion?: number
  readonly proposalId?: string
  readonly experimentId?: string
  readonly at?: string
  readonly frozen?: {
    readonly repetition?: number
    readonly model?: { readonly provider?: string; readonly model?: string; readonly label?: string }
    readonly budget?: { readonly maxTokens?: number; readonly note?: string }
  }
  readonly samples?: readonly ExperimentSampleWire[]
  readonly verdict?: ExperimentVerdict
}

export interface EvolutionResponse {
  readonly proposals?: readonly EvolutionProposalWire[]
  readonly experiments?: readonly ExperimentReportWire[]
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

export interface EvolutionInvalidation {
  readonly id?: string
}

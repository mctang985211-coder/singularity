export type TaskId = string
export type RunId = string

export interface ArtifactRef { artifactId: string; kind: string; uri: string; digest?: string }

export type VerificationMode =
  | 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite'

export interface AcceptanceCriterion {              // (§9.2)
  criterionId: string
  description: string
  verificationMode: VerificationMode
  requiredEvidence: string[]
  mandatory: boolean
  command?: string        // required for deterministic|simulation|measurement
}

export interface TaskDefinition {                   // (§5.1)
  taskType: string
  version: number
  objective: string
  acceptanceCriteria: AcceptanceCriterion[]
  requiredCapabilities: string[]
  decompositionPolicy: { allowed: boolean; maxDepth?: number; maxChildren?: number }
  budgetPolicy?: { tokens?: number; wallTimeMs?: number; attempts?: number }
}

export type TaskStatus =
  | 'created' | 'admitted' | 'ready' | 'running' | 'blocked'
  | 'verifying' | 'verified' | 'failed' | 'cancelled'
export type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed'

export interface TaskInstance {                     // (§5.2)
  taskId: TaskId
  definitionRef: { taskType: string; version: number }
  parentTaskId?: TaskId
  objective: string
  depth: number
  acceptanceCriteria: AcceptanceCriterion[]
  requestedCapabilities: string[]
  decompositionStatus: DecompositionStatus
  status: TaskStatus
  runIds: RunId[]
  childTaskIds: TaskId[]
}

export interface DependencyEdge { from: TaskId; to: TaskId }  // `from` must verify before `to` starts

export type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled'

export interface TaskRun {                          // (§5.3)
  runId: RunId
  taskId: TaskId
  sessionId: string
  parentRunId?: RunId
  capabilitySnapshot: string[]
  agentPreset?: string
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  status: RunStatus
  startedAt: string
  finishedAt?: string
}

export interface VerificationResult {
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  command?: string
  exitCode?: number
  logRef?: string       // path relative to verifier evidenceRoot, never absolute
  details?: string
}

export interface EvidenceClaim {                    // (§10)
  claimId: string
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  artifactRefs: string[]
  details?: string
}

export interface EvidenceBundle {
  evidenceId: string
  taskRunId: RunId
  taskId: TaskId
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  claims: EvidenceClaim[]
  generatedAt: string
}

export interface TaskHandoff {                      // (§18)
  handoffId: string
  parentTaskId: TaskId
  parentRunId: RunId
  childTaskId: TaskId
  parentObjective: string
  reasonForDelegation: string
  constraints: string[]
  decisions: string[]
  relevantArtifacts: ArtifactRef[]
  relevantEvidence: string[]
  assumptions: string[]
  openQuestions: string[]
  parentSessionRef?: string
  createdAt: string
}

export interface CapabilityManifest {               // (§11–12)
  capabilities: Record<string, { skills: string[]; tools: string[]; preset?: string }>
  missing: string[]
  closure: 'closed' | 'partial' | 'gap'
}

export interface Verifier {                         // implemented by verifier package
  id: string
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

/** Fixed definition fields of a graph's root task (see task-runtime createRootTask). */
export const RootTaskSpec: Pick<TaskDefinition, 'taskType' | 'version' | 'acceptanceCriteria' | 'requiredCapabilities' | 'decompositionPolicy'> = {
  taskType: 'root',
  version: 1,
  acceptanceCriteria: [
    {
      criterionId: 'root-children-verified',
      description: 'all mandatory children verified',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
    },
  ],
  requiredCapabilities: [],
  decompositionPolicy: { allowed: true },
}

/** Store id convention: one task store per root session. */
export function rootTaskStoreId(rootSessionId: string): string {
  return `sg-t-${rootSessionId}`
}

export interface TaskSnapshot {
  readonly version: 1
  readonly id: string
  readonly tasks: readonly TaskInstance[]
  readonly runs: readonly TaskRun[]
  readonly edges: readonly DependencyEdge[]
  readonly evidence: readonly EvidenceBundle[]
  readonly handoffs: readonly TaskHandoff[]
  readonly capabilities: Readonly<Record<string, CapabilityManifest>>
}

export interface TaskEventPayloads {
  TaskCreated: { task: TaskInstance }
  TaskAdmitted: { decompositionStatus: 'leaf' | 'decomposable' }
  TaskRejected: { reason: string }
  TaskDecomposed: { childTaskIds: TaskId[] }
  DependencyAdded: { edge: DependencyEdge }
  TaskStarted: { run: TaskRun }
  TaskBlocked: { reason?: string }
  TaskVerifying: Record<string, never>
  TaskVerified: { finishedAt?: string }
  TaskFailed: { reason?: string; finishedAt?: string }
  TaskCancelled: { reason?: string; finishedAt?: string }
  TaskRetried: Record<string, never>
  CapabilityResolved: { manifest: CapabilityManifest }
  CapabilityGapDetected: { missing: string[] }
  EvidenceProduced: { evidence: EvidenceBundle }
  HandoffCreated: { handoff: TaskHandoff }
}

export type TaskEventKind = keyof TaskEventPayloads

export interface TaskEventEnvelope<K extends TaskEventKind, P> {
  readonly kind: K
  readonly taskId: TaskId
  readonly runId?: RunId
  readonly sessionId?: string
  readonly parentTaskId?: TaskId
  readonly timestamp: string
  readonly actor: string
  readonly payload: P
  readonly schemaVersion: 1
}

export type TaskEvent = {
  [K in TaskEventKind]: TaskEventEnvelope<K, TaskEventPayloads[K]>
}[TaskEventKind]

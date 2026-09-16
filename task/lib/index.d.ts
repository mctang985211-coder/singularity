import { Context, Service } from "@deepseek-ai/cordis";

//#region src/types.d.ts
type TaskId = string;
type RunId = string;
interface ArtifactRef {
  artifactId: string;
  kind: string;
  uri: string;
  digest?: string;
}
type VerificationMode = 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite';
interface AcceptanceCriterion {
  criterionId: string;
  description: string;
  verificationMode: VerificationMode;
  requiredEvidence: string[];
  mandatory: boolean;
  command?: string;
}
interface TaskDefinition {
  taskType: string;
  version: number;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredCapabilities: string[];
  decompositionPolicy: {
    allowed: boolean;
    maxDepth?: number;
    maxChildren?: number;
  };
  budgetPolicy?: {
    tokens?: number;
    wallTimeMs?: number;
    attempts?: number;
  };
}
type TaskStatus = 'created' | 'admitted' | 'ready' | 'running' | 'blocked' | 'verifying' | 'verified' | 'failed' | 'cancelled';
type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed';
interface TaskInstance {
  taskId: TaskId;
  definitionRef: {
    taskType: string;
    version: number;
  };
  parentTaskId?: TaskId;
  objective: string;
  depth: number;
  acceptanceCriteria: AcceptanceCriterion[];
  requestedCapabilities: string[];
  decompositionStatus: DecompositionStatus;
  status: TaskStatus;
  runIds: RunId[];
  childTaskIds: TaskId[];
}
interface DependencyEdge {
  from: TaskId;
  to: TaskId;
}
type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled';
interface TaskRun {
  runId: RunId;
  taskId: TaskId;
  sessionId: string;
  parentRunId?: RunId;
  capabilitySnapshot: string[];
  agentPreset?: string;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}
interface VerificationResult {
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  command?: string;
  exitCode?: number;
  logRef?: string;
  details?: string;
}
interface EvidenceClaim {
  claimId: string;
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  artifactRefs: string[];
  details?: string;
}
interface EvidenceBundle {
  evidenceId: string;
  taskRunId: RunId;
  taskId: TaskId;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  claims: EvidenceClaim[];
  generatedAt: string;
}
interface TaskHandoff {
  handoffId: string;
  parentTaskId: TaskId;
  parentRunId: RunId;
  childTaskId: TaskId;
  parentObjective: string;
  reasonForDelegation: string;
  constraints: string[];
  decisions: string[];
  relevantArtifacts: ArtifactRef[];
  relevantEvidence: string[];
  assumptions: string[];
  openQuestions: string[];
  parentSessionRef?: string;
  createdAt: string;
}
interface CapabilityManifest {
  capabilities: Record<string, {
    skills: string[];
    tools: string[];
    preset?: string;
  }>;
  missing: string[];
  closure: 'closed' | 'partial' | 'gap';
}
interface Verifier {
  id: string;
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
}
interface VerifyRequest {
  taskId: TaskId;
  runId: RunId;
  criteria: AcceptanceCriterion[];
  cwd: string;
  logDir: string;
  timeoutMs?: number;
}
/** Fixed definition fields of a graph's root task (see task-runtime createRootTask). */
declare const RootTaskSpec: Pick<TaskDefinition, 'taskType' | 'version' | 'acceptanceCriteria' | 'requiredCapabilities' | 'decompositionPolicy'>;
/** Store id convention: one task store per root session. */
declare function rootTaskStoreId(rootSessionId: string): string;
interface TaskSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly tasks: readonly TaskInstance[];
  readonly runs: readonly TaskRun[];
  readonly edges: readonly DependencyEdge[];
  readonly evidence: readonly EvidenceBundle[];
  readonly handoffs: readonly TaskHandoff[];
  readonly capabilities: Readonly<Record<string, CapabilityManifest>>;
}
interface TaskEventPayloads {
  TaskCreated: {
    task: TaskInstance;
  };
  TaskAdmitted: {
    decompositionStatus: 'leaf' | 'decomposable';
  };
  TaskRejected: {
    reason: string;
  };
  TaskDecomposed: {
    childTaskIds: TaskId[];
  };
  DependencyAdded: {
    edge: DependencyEdge;
  };
  TaskStarted: {
    run: TaskRun;
  };
  TaskBlocked: {
    reason?: string;
  };
  TaskVerifying: Record<string, never>;
  TaskVerified: {
    finishedAt?: string;
  };
  TaskFailed: {
    reason?: string;
    finishedAt?: string;
  };
  TaskCancelled: {
    reason?: string;
    finishedAt?: string;
  };
  TaskRetried: Record<string, never>;
  CapabilityResolved: {
    manifest: CapabilityManifest;
  };
  CapabilityGapDetected: {
    missing: string[];
  };
  EvidenceProduced: {
    evidence: EvidenceBundle;
  };
  HandoffCreated: {
    handoff: TaskHandoff;
  };
}
type TaskEventKind = keyof TaskEventPayloads;
interface TaskEventEnvelope<K$1 extends TaskEventKind, P> {
  readonly kind: K$1;
  readonly taskId: TaskId;
  readonly runId?: RunId;
  readonly sessionId?: string;
  readonly parentTaskId?: TaskId;
  readonly timestamp: string;
  readonly actor: string;
  readonly payload: P;
  readonly schemaVersion: 1;
}
type TaskEvent = { [K in TaskEventKind]: TaskEventEnvelope<K, TaskEventPayloads[K]> }[TaskEventKind];
//#endregion
//#region src/service/state.d.ts
declare class TaskState {
  private value;
  constructor(id: string, snapshot?: TaskSnapshot);
  clone(): TaskState;
  snapshot(): TaskSnapshot;
  apply(event: TaskEvent): void;
  private addTask;
  private admit;
  private decompose;
  private addDependency;
  private start;
  private block;
  private verify;
  private fail;
  private cancel;
  private resolveCapabilities;
  private produceEvidence;
  private addHandoff;
  private reaches;
  private transit;
  private assertTransition;
  private assertRunTransition;
  private setRun;
  private updateTask;
  private task;
  private run;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'task/event': TaskEvent;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    task: TaskService;
  }
  interface Events {
    'task/change'(snapshot: TaskSnapshot): void;
  }
}
declare class TaskService extends Service {
  static inject: string[];
  private readonly stores;
  private closing;
  constructor(ctx: Context);
  createStore(storeId: string): Promise<TaskSnapshot>;
  openStore(storeId: string): Promise<TaskSnapshot>;
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
  taskIn(storeId: string, taskId: TaskId): Promise<TaskInstance>;
  runIn(storeId: string, runId: RunId): Promise<TaskRun>;
  childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]>;
  createTaskIn(storeId: string, task: TaskInstance, actor: string): Promise<void>;
  admitTaskIn(storeId: string, taskId: TaskId, actor: string, options?: {
    decompositionStatus?: 'leaf' | 'decomposable';
    manifest?: CapabilityManifest;
  }): Promise<void>;
  rejectTaskIn(storeId: string, taskId: TaskId, actor: string, reason: string, manifest?: CapabilityManifest): Promise<void>;
  decomposeIn(storeId: string, parentTaskId: TaskId, children: readonly TaskInstance[], actor: string, edges?: readonly DependencyEdge[]): Promise<void>;
  addDependencyIn(storeId: string, edge: DependencyEdge, actor: string): Promise<void>;
  startRunIn(storeId: string, run: TaskRun, actor: string): Promise<void>;
  markRunStatusIn(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus | 'verifying', actor: string, options?: {
    reason?: string;
    finishedAt?: string;
  }): Promise<void>;
  recordEvidenceIn(storeId: string, evidence: EvidenceBundle, actor: string): Promise<void>;
  recordHandoffIn(storeId: string, handoff: TaskHandoff, actor: string): Promise<void>;
  commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void>;
  private requireStore;
  private allocate;
  private open;
  private close;
  private header;
}
//#endregion
export { AcceptanceCriterion, ArtifactRef, CapabilityManifest, DecompositionStatus, DependencyEdge, EvidenceBundle, EvidenceClaim, RootTaskSpec, RunId, RunStatus, TaskDefinition, TaskEvent, TaskEventEnvelope, TaskEventKind, TaskEventPayloads, TaskHandoff, TaskId, TaskInstance, TaskRun, TaskService, TaskService as default, TaskSnapshot, TaskState, TaskStatus, VerificationMode, VerificationResult, Verifier, VerifyRequest, rootTaskStoreId };
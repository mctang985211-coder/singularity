/**
 * The public surface of the protocol stack.
 *
 * Every export here is named: there are no `export *` barrels in this codebase, and the gate
 * script refuses one. A module's public surface is exactly what other modules import, plus
 * exactly these names for the stack itself.
 *
 * @module singularity-core
 */

export { ProtocolRefusal, refuse, REFUSAL_CODES, type Refusal, type RefusalCode } from './protocol/refusal.ts'
export {
  assertClosedKeys,
  assertEnvelope,
  assertLosslessJson,
  canonicalJson,
  digestOf,
  digestOfBody,
  sealEnvelope,
  ENVELOPE_MEMBERS,
  type Envelope,
  type EnvelopeBody,
} from './protocol/envelope.ts'
export {
  defineKind,
  ProtocolRegistry,
  type Guarantees,
  type KindRule,
  type ProtocolSpec,
} from './protocol/registry.ts'
export { MemoryLog, type Decision, type EmitInput, type LogOptions } from './protocol/memory-log.ts'
export { foldSubject, foldSubjects } from './protocol/fold.ts'

export {
  assertContract,
  assertContractShape,
  assertCriterionShape,
  contractDigest,
  verifierRegistryOf,
  CONTRACT_MEMBERS,
  CRITERION_MEMBERS,
  type AcceptanceCriterion,
  type TaskContract,
  type TaskTemplateRef,
  type TaskInputSource,
  type VerifierRegistry,
} from './task/contract.ts'
export { digest, maybeText, record, requireContractOf, requireRun, settled, text } from './task/shape.ts'
export {
  assertDecomposition,
  decomposedKind,
  DECOMPOSITION_CHILD_MEMBERS,
  DECOMPOSITION_MEMBERS,
  type Decomposition,
  type DecompositionChild,
} from './task/decomposition.ts'
export {
  projectTree,
  type ChildOutcome,
  type ChildStatus,
  type TreeChildView,
  type TreeCriterionView,
  type TreeView,
} from './task/tree.ts'
export {
  createTaskCommands,
  type AgentCommands,
  type HeldAgent,
  type TaskCommandOptions,
  type TaskCommands,
  type VerdictInput,
} from './task/commands.ts'
export {
  assertInputsBound,
  bubbleOpenedKind,
  inputList,
  BUBBLE_INPUT_MEMBERS,
  BUBBLE_MEMBERS,
  WORKSPACE_MEMBERS,
  type Bubble,
  type BubbleInput,
} from './task/bubble.ts'
export {
  assignedKind,
  reassignedKind,
  requireResponsible,
  REASSIGNMENT_MEMBERS,
  RESPONSIBILITY_MEMBERS,
  type Responsibility,
} from './task/responsibility.ts'
export {
  declareAgentProtocol,
  AGENT_KINDS,
  AGENT_OPENED_MEMBERS,
  AGENT_PROTOCOL,
  AGENT_ROLE,
  AGENT_VERSION,
  type AgentState,
} from './agent/protocol.ts'
export { createAgentNodeCommands, type AgentNodeCommands } from './agent/commands.ts'
export {
  declareTaskProtocol,
  verifierRoleOf,
  SCHEDULER_ROLE,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  recordedVerdictDigest,
  type EvidenceRecord,
  type RevisionRef,
  type RunState,
  type RunSubmission,
  type RunStatus,
  type TaskState,
} from './task/protocol.ts'
export {
  projectReceipt,
  projectTask,
  receiptDigest,
  renderTaskForAgent,
  type CriterionVerdictView,
  type ReceiptView,
  type RunView,
  type TaskView,
} from './task/view.ts'

export {
  assertPinnedRevision,
  projectBindings,
} from './environment/binding.ts'
export {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  PUBLISHER_ROLE,
  type EnvironmentState,
  type RevisionState,
} from './environment/protocol.ts'
export { createEnvironmentCommands, type EnvironmentCommands } from './environment/commands.ts'

export {
  declareMeasureProtocol,
  MEASURE_KINDS,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type ConstraintCheck,
  type EvaluationMetric,
  type EvaluationRun,
  type EvaluationState,
  type EvaluationWeights,
  type MissedTrial,
  type TrialRecord,
} from './measure/protocol.ts'
export {
  caliberDigestOf,
  caliberOf,
  projectEvaluation,
  type Caliber,
  type ConstraintView,
  type EvaluationView,
  type MissingSlot,
} from './measure/view.ts'
export {
  createMeasureCommands,
  type EvaluationPlanInput,
  type MeasureCommandOptions,
  type MeasureCommands,
  type TrialInput,
} from './measure/commands.ts'
export {
  runMeasurement,
  type MeasuredTrial,
  type MeasurementOutcome,
  type MeasurementRequest,
  type MissedMeasurement,
  type RealMeasurement,
} from './measure/execution.ts'

export {
  editBudgetFor,
  noveltyOf,
  select,
  type Calibration,
  type Candidate,
  type History,
  type Measurement,
  type Outcome,
  type Selection,
} from './strategy/decision.ts'
export {
  declareStrategyProtocol,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_ROLE,
  STRATEGY_VERSION,
  type CandidateSubmission,
  type EditAsset,
  type RoundDecisionRecord,
  type RoundPlan,
  type RoundState,
  type StructuralEdit,
} from './strategy/protocol.ts'
export { projectRound, type RoundDecision, type SlotView } from './strategy/view.ts'
export {
  createStrategyCommands,
  type DecideRoundInput,
  type OpenRoundInput,
  type StrategyCommandOptions,
  type StrategyCommands,
  type SubmitCandidateInput,
} from './strategy/commands.ts'

export {
  declareReleaseProtocol,
  APPROVER_ROLE,
  RELEASE_KINDS,
  RELEASE_PROTOCOL,
  RELEASE_VERSION,
  type ReleaseState,
} from './release/protocol.ts'
export {
  createReleaseCommands,
  type ReleaseCommandOptions,
  type ReleaseCommands,
} from './release/commands.ts'

export {
  assertVerifierRunnable,
  runVerifierSelftest,
  verifierIdentityOf,
  type SelftestReport,
  type VerifierImplementation,
  type VerifierInput,
  type VerifierSelftest,
  type VerifierSelftestSample,
  type VerifierVerdict,
} from './verifier/implementation.ts'
export {
  runVerifierCommand,
  type VerifierCommandInput,
  type VerifierCommandRequest,
  type VerifierCommandResult,
  type VerifierInvocation,
  type VerifierProcess,
} from './verifier/command.ts'

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
export { MemoryLog, type EmitInput, type LogOptions } from './protocol/memory-log.ts'
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
  type VerifierRegistry,
} from './task/contract.ts'
export { digest, maybeText, record, requireContractOf, requireRun, settled, text } from './task/shape.ts'
export {
  assertDecompositionAgainst,
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
export {
  declareTaskProtocol,
  verifierRoleOf,
  SCHEDULER_ROLE,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type EvidenceRecord,
  type RevisionRef,
  type RunState,
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
  type EnvironmentState,
  type RevisionState,
} from './environment/protocol.ts'

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

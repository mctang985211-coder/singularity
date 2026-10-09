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
  assertEnvelope,
  canonicalJson,
  digestOf,
  digestOfBody,
  sealEnvelope,
  ENVELOPE_MEMBERS,
  type Envelope,
  type EnvelopeBody,
} from './protocol/envelope.ts'
export {
  ProtocolRegistry,
  GUARANTEES,
  type Guarantee,
  type KindRule,
  type ProtocolSpec,
} from './protocol/registry.ts'
export { ProtocolLog, type EmitInput, type LogOptions } from './protocol/log.ts'
export { foldSubject, foldSubjects } from './protocol/fold.ts'

export {
  assertContract,
  contractDigest,
  verifierRegistryOf,
  type AcceptanceCriterion,
  type TaskContract,
  type VerifierRegistry,
} from './task/contract.ts'
export {
  declareTaskProtocol,
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

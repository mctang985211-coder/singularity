/**
 * Task runtime: capability resolution, decomposition admission, sequential run orchestration and handoff.
 * @module dsh-singularity-task-runtime
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-graphs'
import { TaskRuntime } from './service/runtime.ts'

export type { McpServerTemplate } from './mcp-servers.ts'
export { resolveMcpServerSpecs, parseMcpServerRegistry } from './mcp-servers.ts'
export type { CapabilityConfig } from './capability.ts'
export {
  resolveCapabilities,
  workerBaseline,
  TOOL_LABELS,
  WORKER_BASELINE_LABELS,
  WORKER_BASELINE_TOOLS,
} from './capability.ts'
export { contractDefects } from './admission.ts'
export { isOpenProposal, openProposalOf } from './proposal.ts'
export { ExecutionGate } from './gate.ts'
export { WorkspaceBusyError, WorkspaceRegistry } from './workspace.ts'
export type { WorkspaceOwner } from './workspace.ts'
export { resolveRootBudget, checkRunStart } from './root-budget.ts'
export { fixProtectedInputs, fixSpecProtectedInputs, protectedInputDefects } from './protected-inputs.ts'
export { decompositionIdentity, normalizeDecomposition, normalizeRootContract } from './normalize.ts'
export type { NormalizedBatch } from './normalize.ts'
export {
  checkObligationCoverage,
  findRepoRoot,
  loadObligationTemplates,
  parseObligationTemplates,
} from './obligation.ts'
export type { CapabilityToolQuery, SkillProviderCandidate, SkillProviderVerdict } from './sidecar.ts'
export {
  capabilityToolQuery,
  executionProviders,
  loadSkillSidecar,
  registryRevision,
  validateSkillProvider,
} from './sidecar.ts'
export type { SkillSidecar } from './skill-contract.ts'
export {
  SKILL_SIDECAR_FILE,
  SUPPORTED_SKILL_RESOURCE_DIRS,
  serializeSkillSidecar,
  sidecarWithSkillMd,
  skillContractDefects,
  skillContractDigest,
  skillContentDigest,
} from './skill-contract.ts'
export type { RecoveryMode, RecoveryRounds, RootRecoveryRequest } from './recovery.ts'
export {
  IterationCapRefusal,
  inFlightRecoveryAttempt,
  recoveryAttemptWithKey,
  recoveryKindOf,
  recoveryModeOf,
  recoveryRoundsOf,
  recoverySourceRun,
} from './recovery.ts'
export { priorRoundNotice, priorRoundNoticeForRun } from './service/root-recovery.ts'
export { bubbleMethodRevisionOf, bubbleWorkspacePath, latestBubbleWorkspacePath, materializeBubble, settleBubble } from './service/bubble.ts'
export { readVerifiedFile, walkVerified } from './verified-read.ts'
export type { RunBindingRead } from './run-binding.ts'
export { bindRunProviders, mcpServerBindings } from './run-binding.ts'
export type { CapabilityProviderPrecheck, ProviderPrecheck } from './provider-precheck.ts'
export {
  optionalService,
  precheckProviders,
  precheckReplacedCapabilityRow,
  providerRefusals,
  registeredVerifierIds,
  registeredVerifierVocabulary,
  skillSearchRoots,
  unlistableVerifierRefusal,
} from './provider-precheck.ts'
export type {
  BatchContext,
  ChildOutcome,
  OrchestrateEnv,
  ReplayReceiptReport,
  ReplayRunOutcome,
  TerminalReviewFact,
} from './orchestration/types.ts'
export { VerifierUnavailableError } from './orchestration/types.ts'
export { driveBatch } from './orchestration/batch.ts'
export { escalationHint } from './orchestration/verify.ts'
export { owedBatchResults } from './orchestration/observe.ts'
export { settleRunFromRuntime } from './orchestration/settlement.ts'
export type { AnsweredQuestionOutcome, AskedQuestionOutcome } from './question.ts'
export type { Config, SupervisionConfig } from './config.ts'
export {
  DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
  DEFAULT_BUDGET,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SUPERVISION,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from './config.ts'
export type {
  CriterionSpec,
  DecomposeAdmissionResult,
  DecomposeChildSpec,
  DecomposeSpec,
  DecompositionReviewRequest,
  ProposalContinuation,
  ProposalReviewChannel,
  ProposalReviewNotice,
  ProposalReviewRequest,
  ProposalSubmission,
  ReplayTaskOptions,
  RootBudgetApproval,
  RootBudgetApprovalAsk,
  RootBudgetApprovalDecision,
  RootBudgetExtensionHost,
  RootBudgetExtensionRequest,
  RootBudgetExtensionResult,
  RootContractReviewRequest,
  RootContractSpec,
  RootIntakeResult,
  RootRecoveryCaller,
  RootRecoveryOutcome,
  StoreRecoveryStatus,
} from './types.ts'
export type { StoreRecoveryStateView } from './config.ts'
export type {
  SessionFacts,
  ModelRequestFact,
  DecompositionCallFact,
} from './session-facts.ts'
export { HUMAN_TOOLS, sessionFactsOf, skillNameFrom, toolResultFailed } from './session-facts.ts'
export type { ExecutionUsage, ReceiptBuildInput, ReceiptBuildResult } from './receipt.ts'
export {
  buildExecutionReceipt,
  executionSubtree,
  executionUsage,
  requireReceiptFacts,
} from './receipt.ts'
export type { ReceiptReconcileReport, ReceiptSealStatus } from './service/receipts.ts'
export { RECEIPT_ACTOR, RECEIPT_PERSIST_WAIT_MS } from './service/receipts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskRuntime: TaskRuntime
  }
}

/** This package's producer kind: every notice `notify()` / `appendNotice()` sends carries it. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'task-runtime': { kind: 'task-runtime' } & ContextFormed
  }
}

export { TaskRuntime }

export default TaskRuntime

export * from './task-template.ts'
export { parseSkillFile } from '@dangosys/dsh-singularity-agent-runtime'

export * from './environment/index.ts'
export type {
  EnvironmentLibrary,
  EnvironmentProtocol,
  EnvironmentView,
  LibraryEditResult,
  LibraryReview,
  LibraryWrite,
} from './service/environment.ts'
export type { TaskRuntime as TaskRuntimeService } from './service/runtime.ts'
export { rebaseWorkspacePaths } from './replay-paths.ts'

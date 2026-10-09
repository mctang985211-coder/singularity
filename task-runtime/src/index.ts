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

export type { CapabilityConfig } from './capability.ts'
export {
  resolveCapabilities,
  workerBaseline,
  TOOL_LABELS,
  WORKER_BASELINE_LABELS,
  WORKER_BASELINE_TOOLS,
} from './capability.ts'

export { WorkspaceBusyError, WorkspaceRegistry } from './workspace.ts'

export { resolveRootBudget } from './root-budget.ts'

export {
  checkObligationCoverage,
  findRepoRoot,
  loadObligationTemplates,
  parseObligationTemplates,
} from './obligation.ts'
export type { SkillProviderVerdict } from './sidecar.ts'
export { loadSkillSidecar } from './sidecar.ts'

export { SKILL_SIDECAR_FILE } from './skill-contract.ts'
export type { RecoveryMode, RootRecoveryRequest } from './recovery.ts'
export { recoveryAttemptWithKey } from './recovery.ts'

export {
  bubbleWorkspacePath,
  latestBubbleWorkspacePath,
  materializeBubble,
  settleBubble,
} from './service/bubble.ts'

export type { RunBindingRead } from './run-binding.ts'
export { bindRunProviders } from './run-binding.ts'
export type { CapabilityProviderPrecheck, ProviderPrecheck } from './provider-precheck.ts'
export {
  optionalService,
  precheckProviders,
  registeredVerifierIds,
  registeredVerifierVocabulary,
  skillSearchRoots,
} from './provider-precheck.ts'
export type { ChildOutcome, ReplayRunOutcome } from './orchestration/types.ts'

export { settleRunFromRuntime } from './orchestration/settlement.ts'
export type { AnsweredQuestionOutcome, AskedQuestionOutcome } from './question.ts'
export type { Config } from './config.ts'

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
  RootBudgetExtensionResult,
  RootContractReviewRequest,
  RootContractSpec,
  RootIntakeResult,
  StoreRecoveryStatus,
} from './types.ts'

export type { SessionFacts } from './session-facts.ts'

export type { ExecutionUsage } from './receipt.ts'
export {
  buildExecutionReceipt,
  executionUsage,
  requireReceiptFacts,
} from './receipt.ts'

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

export { parseTaskTemplate } from './task-template.ts'
export { parseSkillFile } from '@dangosys/dsh-singularity-agent-runtime'

export {
  createEnvironmentDraft,
  emptyRevisionManifest,
  ensureInitialRevision,
  hasLegacyLayout,
  libraryRoots,
  listPointerCompletions,
  readEnvironmentDraft,
  readPointer,
  readRevision,
  revisionCapabilityRows,
  stageEnvironmentEdit,
} from './environment/index.ts'
export type {
  EnvironmentDraft,
  EnvironmentEdit,
  EnvironmentPointer,
  EnvironmentPointerCompletion,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentPublishSource,
  EnvironmentRevision,
  EnvironmentRevisionManifest,
  LibraryRoots,
  PublishOutcome,
  PublishRequest,
} from './environment/index.ts'
export type { EnvironmentLibrary, EnvironmentView } from './service/environment.ts'


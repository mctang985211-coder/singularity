/**
 * Singularity root agent extras.
 * @module dsh-singularity-agent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { HitlService } from './hitl.ts'
import { EscalationService } from './escalation.ts'
import { EvolutionService } from './evolution.ts'
import { defineApproveTool } from './tools/approve.ts'
import { defineAskTool } from './tools/ask.ts'
import { defineCapabilityListTool } from './tools/capability-list.ts'
import { defineEscalateTool } from './tools/escalate.ts'
import { defineEvolutionApplyTool } from './tools/evolution-apply.ts'
import { defineEvolutionCandidateTool } from './tools/evolution-candidate.ts'
import { defineEvolutionDecideTool } from './tools/evolution-decide.ts'
import { defineEvolutionGateTool } from './tools/evolution-gate.ts'
import { defineEvolutionListTool } from './tools/evolution-list.ts'
import { defineEvolutionPrepareTool } from './tools/evolution-prepare.ts'
import { defineEvolutionProposeTool } from './tools/evolution-propose.ts'
import { defineEvolutionReplayTool } from './tools/evolution-replay.ts'
import { defineEvolutionRollbackTool } from './tools/evolution-rollback.ts'
import { defineMarkReadyTool } from './tools/mark-ready.ts'
import { defineSpawnTool } from './tools/spawn.ts'
import { defineTaskCancelTool } from './tools/task-cancel.ts'
import { defineTaskDecomposeTool } from './tools/task-decompose.ts'
import { defineTaskDiagnoseTool } from './tools/task-diagnose.ts'
import { defineTaskReadTool } from './tools/task-read.ts'
import { defineTaskReviewAgentTool } from './tools/review-agent.ts'
import { defineTaskReviewPackTool } from './tools/task-review-pack.ts'
import { defineTaskStatusTool } from './tools/task-status.ts'
import { defineTaskSubmitResultTool } from './tools/task-submit-result.ts'
import { defineTaskVerifyTool } from './tools/task-verify.ts'

export { HitlService } from './hitl.ts'
export type { HitlAnswer, HitlKind, HitlPending } from './hitl.ts'
export { EscalationService } from './escalation.ts'
export type { Escalation, EscalationInput, EscalationRecord, EscalationTrigger } from './escalation.ts'
export { ESCALATION_TRIGGERS } from './escalation.ts'
export { EvolutionService } from './evolution.ts'
export type {
  AgentPresetMutation,
  ApplyOutcome,
  ApplyView,
  CapabilityMutation,
  ChampionSource,
  ChampionState,
  EvolutionDecision,
  EvolutionLevel,
  EvolutionProposal,
  EvolutionRecord,
  EvolutionStatus,
  GateAnswers,
  ListFilter,
  MechanicalMutation,
  PrepareChampion,
  PreparedView,
  ProposeInput,
  SkillMutation,
  TaskDefinitionMutation,
} from './evolution.ts'
export { APPLYABLE_TARGET_TYPES, applyTargets, CHAMPION_SOURCES, CHAMPION_STATES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, MECHANICAL_TARGET_TYPES, mutationMechanical } from './evolution.ts'
export type {
  ReplayCriterionDiff,
  ReplayCriterionSummary,
  ReplayRelation,
  ReplayReport,
  ReplaySideSummary,
  ReplayTaskComparison,
  ReplayVerdict,
  SkillContentIdentity,
} from './replay.ts'
export { compareReplaySides, overallReplayVerdict, REPLAY_RELATIONS, REPLAY_VERDICTS } from './replay.ts'
export type { ReplayedView } from './evolution.ts'

export class SingularityAgent extends Service {
  static inject = ['tools', 'graphs', 'agentRuntime', 'task', 'taskRuntime', 'userQuestions', 'approval']

  constructor(ctx: Context) {
    super(ctx, 'singularityAgent')
    ctx.plugin(HitlService)
    // The evolution tools read `ctx.evolution`, and a service a child fiber
    // provides is invisible to the parent that mounted it — so the ledger's
    // service is provided on this fiber rather than through `ctx.plugin`.
    new EvolutionService(ctx)
    // Same discipline for the escalation ledger: the `escalate` tool reads
    // `ctx.escalation` from this fiber, and the parent never injects it.
    new EscalationService(ctx)
    ctx.tools.register(defineMarkReadyTool(ctx))
    ctx.tools.register(defineSpawnTool(ctx))
    ctx.tools.register(defineAskTool(ctx))
    ctx.tools.register(defineApproveTool(ctx))
    ctx.tools.register(defineTaskReadTool(ctx))
    ctx.tools.register(defineCapabilityListTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskStatusTool(ctx))
    ctx.tools.register(defineTaskSubmitResultTool(ctx))
    ctx.tools.register(defineTaskCancelTool(ctx))
    ctx.tools.register(defineTaskVerifyTool(ctx))
    ctx.tools.register(defineTaskReviewPackTool(ctx))
    ctx.tools.register(defineTaskReviewAgentTool(ctx))
    ctx.tools.register(defineTaskDiagnoseTool(ctx))
    ctx.tools.register(defineEvolutionProposeTool(ctx))
    ctx.tools.register(defineEvolutionCandidateTool(ctx))
    ctx.tools.register(defineEvolutionPrepareTool(ctx))
    ctx.tools.register(defineEvolutionReplayTool(ctx))
    ctx.tools.register(defineEvolutionGateTool(ctx))
    ctx.tools.register(defineEvolutionDecideTool(ctx))
    ctx.tools.register(defineEvolutionApplyTool(ctx))
    ctx.tools.register(defineEvolutionRollbackTool(ctx))
    ctx.tools.register(defineEvolutionListTool(ctx))
    ctx.tools.register(defineEscalateTool(ctx))
  }
}

export default SingularityAgent

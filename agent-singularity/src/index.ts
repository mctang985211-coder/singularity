/**
 * Singularity root agent extras.
 * @module dsh-singularity-agent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-context'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { HitlService } from './hitl.ts'
import { EscalationService } from './escalation.ts'
import { EvolutionService } from './evolution.ts'
import { ProposalReviewService } from './proposal-review.ts'
import { reviewerBindingSource } from './review-agent-ledger.ts'
import { defineApproveTool } from './tools/approve.ts'
import { defineAskTool } from './tools/ask.ts'
import { defineCapabilityListTool } from './tools/capability-list.ts'
import { defineContextReadTool } from './tools/context-read.ts'
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
import { defineTaskAnswerTool } from './tools/task-answer.ts'
import { defineTaskAskParentTool } from './tools/task-ask-parent.ts'
import { defineTaskCancelTool } from './tools/task-cancel.ts'
import { defineTaskDecomposeTool } from './tools/task-decompose.ts'
import { defineTaskDiagnoseTool } from './tools/task-diagnose.ts'
import { defineTaskIntakeTool } from './tools/task-intake.ts'
import { defineTaskProposalCancelTool } from './tools/task-proposal-cancel.ts'
import { defineTaskProposalContinueTool } from './tools/task-proposal-continue.ts'
import { defineTaskProposalReadTool } from './tools/task-proposal-read.ts'
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
export { ProposalReviewService, ownerSessionOfStore, renderProposalReview, reviewDecider } from './proposal-review.ts'
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

/**
 * Plugin configuration — the deployment's composition, not a model's choice.
 *
 * R0's contract (§1.3 of the guide, defect G15) is that the default run
 * exposes only what the current role needs, so the evolution chain is something
 * a deployment turns *on*: the tools it is reached through are registered by
 * this plugin, and with the chain off none of them exists on any surface. The
 * switch cannot be a permission check inside a tool for the same reason: a
 * spawned worker keeps the global layer when its grant does not override it, so
 * "who may call this" is not a question this deployment gets to ask at call
 * time — "does this tool exist here" is.
 */
export interface Config {
  /**
   * Whether this composition registers the nine `evolution_*` tools on the
   * global layer. `off` — the shipped default, see {@link DEFAULT_EVOLUTION} —
   * registers none of them: no model surface (root, granted worker, or the
   * un-granted spawn worker that inherits the global layer) can call one, and
   * the ledger, its history, its validation and its approvals are left exactly
   * as they are rather than deleted. `on` registers all nine and changes
   * nothing else about them: the previous assembly, byte for byte.
   */
  evolution: 'off' | 'on'
}

/**
 * The shipped switch position: `off`.
 *
 * The default run is the one nobody configured, and R0 asks that this run not
 * carry the evolution chain (guide §1.3: "默认运行只提供当前角色需要的能力").
 * `on` is therefore an explicit act by a deployment, and what it resolved to is
 * readable back from the context ({@link EvolutionExposure}) — a switch whose
 * position cannot be read is one nobody can tell from an unwired exposure.
 */
export const DEFAULT_EVOLUTION: 'off' = 'off'

const ConfigSchema: z<Config> = z.object({
  evolution: z.union([z.const('off'), z.const('on')]).default(DEFAULT_EVOLUTION),
})

/**
 * The evolution exposure this composition resolved, provided on the agent's own
 * fiber as `ctx.singularityEvolution`.
 *
 * The registration gate in {@link SingularityAgent} is the enforcement; this
 * service is the fact a sibling assembly reads to keep its own surface in step
 * — the root agent's tool allow-list names these nine names and has to leave
 * them out when they were never registered. Read it softly:
 *
 * ```ts
 * const evolution = ctx.get('singularityEvolution')?.enabled ?? false
 * ```
 *
 * A composition that does not mount this plugin provides no such service, and
 * that absence reads as the closed state: a deployment that never turned the
 * chain on must not be assembled as if it had.
 */
export class EvolutionExposure extends Service {
  /** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
  readonly enabled: boolean

  constructor(ctx: Context, enabled: boolean) {
    super(ctx, 'singularityEvolution')
    this.enabled = enabled
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityEvolution: EvolutionExposure
  }
}

export class SingularityAgent extends Service {
  static inject = ['tools', 'graphs', 'agentRuntime', 'task', 'taskRuntime', 'singularityContext', 'userQuestions', 'approval']
  static Config: z<Config> = ConfigSchema

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'singularityAgent')
    this.assertClosedConfig(config)
    const evolution = this.resolveEvolution(config)
    ctx.plugin(HitlService)
    // The evolution tools read `ctx.evolution`, and a service a child fiber
    // provides is invisible to the parent that mounted it — so the ledger's
    // service is provided on this fiber rather than through `ctx.plugin`.
    new EvolutionService(ctx)
    // Same discipline for the escalation ledger: the `escalate` tool reads
    // `ctx.escalation` from this fiber, and the parent never injects it.
    new EscalationService(ctx)
    // And for the T2/T3 review channel: the task runtime resolves
    // `ctx.proposalReviewChannel` softly and asks it when a batch waits for a
    // human, so the channel has to be visible from the runtime's context. It is
    // provided on this fiber for the same reason the two ledgers are.
    new ProposalReviewService(ctx)
    // What this assembly did, said where a sibling can read it (the root agent's
    // tool allow-list is the consumer) — see {@link EvolutionExposure}.
    new EvolutionExposure(ctx, evolution === 'on')
    // The reviewer ledger is the one delegation source this deployment has (A2
    // §D): the context read core resolves a reviewer's read domain from it, and
    // this plugin owns the file — so the narrow read door is registered here,
    // and it leaves with the plugin.
    ctx.effect(
      () => ctx.singularityContext.registerReviewerBindingSource(reviewerBindingSource()),
      'singularityAgent: reviewer binding source',
    )
    ctx.tools.register(defineMarkReadyTool(ctx))
    ctx.tools.register(defineSpawnTool(ctx))
    ctx.tools.register(defineAskTool(ctx))
    ctx.tools.register(defineApproveTool(ctx))
    ctx.tools.register(defineTaskReadTool(ctx))
    ctx.tools.register(defineCapabilityListTool(ctx))
    ctx.tools.register(defineContextReadTool(ctx))
    // The root's own goal is accepted here (A0): it is in ROOT_TOOLS only, and
    // the deployment's evolution switch has nothing to do with it — a graph
    // whose contract cannot be accepted has no goal to work on at all.
    ctx.tools.register(defineTaskIntakeTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskProposalReadTool(ctx))
    ctx.tools.register(defineTaskProposalContinueTool(ctx))
    ctx.tools.register(defineTaskProposalCancelTool(ctx))
    ctx.tools.register(defineTaskStatusTool(ctx))
    ctx.tools.register(defineTaskSubmitResultTool(ctx))
    // The two halves of the direct parent/child question protocol (A4 §F.1): a
    // worker asks its own direct parent, and a parent answers the child that
    // asked it. Registered unconditionally, like the rest of the task surface —
    // who may ask whom, and what a call may say, is decided by the caller's run
    // binding, the store's parent relation and the write gate, never by a
    // registration switch; the reviewer's own surface leaves both names out.
    ctx.tools.register(defineTaskAskParentTool(ctx))
    ctx.tools.register(defineTaskAnswerTool(ctx))
    ctx.tools.register(defineTaskCancelTool(ctx))
    ctx.tools.register(defineTaskVerifyTool(ctx))
    ctx.tools.register(defineTaskReviewPackTool(ctx))
    ctx.tools.register(defineTaskReviewAgentTool(ctx))
    ctx.tools.register(defineTaskDiagnoseTool(ctx))
    // The evolution chain is the one part of this surface a deployment may
    // withhold (R0). Off, none of the nine is registered, so no agent surface
    // can call one: the root's allow-list is a restriction over what exists, a
    // worker's grant is applied to its own layer, and a worker spawned without
    // one keeps the global layer — the door that only the absence of the tool
    // closes. The ledger service above stays constructed either way: nothing
    // here reads it, and its history is not this switch's to delete.
    if (evolution === 'on') {
      ctx.tools.register(defineEvolutionProposeTool(ctx))
      ctx.tools.register(defineEvolutionCandidateTool(ctx))
      ctx.tools.register(defineEvolutionPrepareTool(ctx))
      ctx.tools.register(defineEvolutionReplayTool(ctx))
      ctx.tools.register(defineEvolutionGateTool(ctx))
      ctx.tools.register(defineEvolutionDecideTool(ctx))
      ctx.tools.register(defineEvolutionApplyTool(ctx))
      ctx.tools.register(defineEvolutionRollbackTool(ctx))
      ctx.tools.register(defineEvolutionListTool(ctx))
    }
    ctx.tools.register(defineEscalateTool(ctx))
  }

  /**
   * Refuse a configuration member this plugin does not read. The schema keeps
   * unknown keys on the object it validates, so this is where a caller's typo
   * is caught: a misspelled member would otherwise read as a configuration that
   * took effect while the switch stayed at its default.
   */
  private assertClosedConfig(config: Config | undefined): void {
    if (config === undefined) return
    const known = new Set(['evolution'])
    const unknown = Object.keys(config).filter(key => !known.has(key))
    if (unknown.length === 0) return
    throw new Error(
      `singularity-agent: the configuration names [${unknown.join(', ')}], which this plugin does not read; ` +
      'a member nobody reads refuses to start rather than being silently ignored',
    )
  }

  /**
   * The switch position this assembly acts on. The schema types the member, but
   * a deployment that constructs this plugin directly (a test, an embedding
   * process) bypasses the schema, and a near miss must not be read as "not on,
   * therefore off": a caller who asked for something this build does not
   * implement would get the closed composition while believing otherwise.
   */
  private resolveEvolution(config: Config | undefined): 'off' | 'on' {
    const value: unknown = config?.evolution
    if (value === undefined) return DEFAULT_EVOLUTION
    if (value === 'off' || value === 'on') return value
    throw new Error(
      `singularity-agent: evolution is ${JSON.stringify(value)}; it is "off" or "on" ` +
      '(a switch this build cannot execute refuses to start rather than assembling an exposure nobody chose)',
    )
  }
}

export default SingularityAgent

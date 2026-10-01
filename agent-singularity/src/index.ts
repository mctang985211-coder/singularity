/** Singularity root agent extras. @module dsh-singularity-agent */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-context'
import type {} from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService, modelSelectionOf } from '@dangosys/dsh-singularity-evolution'
import type { ModelSelection } from '@dangosys/dsh-singularity-evolution'
import { HitlService } from './services/hitl.ts'
import { EscalationService } from './services/escalation.ts'
import { ProposalReviewService } from './services/proposal-review.ts'
import { reviewerBindingSource, supervisorDelegationSource } from './coordination/ledger.ts'
import { installReviewAgentAutoTrigger } from './coordination/review-scan.ts'
import { installSupervisorHandoffTrigger } from './coordination/evolution-handoff.ts'
import { configureSupervision, DEFAULT_SUPERVISION, type SupervisionConfig } from './coordination/supervision.ts'
import { logOf } from './log.ts'
import { defineApproveTool } from './tools/approve.ts'
import { defineAskTool } from './tools/ask.ts'
import { defineRootBudgetApproval, defineTaskBudgetExtendTool } from './tools/budget-extend.ts'
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
import { defineTaskRecoverTool } from './tools/task-recover.ts'
import { defineTaskReviewAgentTool } from './tools/review-agent.ts'
import { defineTaskReviewPackTool } from './tools/task-review-pack.ts'
import { defineTaskStatusTool } from './tools/task-status.ts'
import { defineTaskSubmitResultTool } from './tools/task-submit-result.ts'
import { defineTaskVerifyTool } from './tools/task-verify.ts'

export { HitlService } from './services/hitl.ts'
export type { HitlAnswer } from './services/hitl.ts'
export { EscalationService } from './services/escalation.ts'
export { ProposalReviewService } from './services/proposal-review.ts'
export { DEFAULT_SUPERVISION } from './coordination/supervision.ts'
export type { AutoReviewMode, SupervisionConfig } from './coordination/supervision.ts'

/** Plugin configuration — the deployment's composition, not a model's choice. */
export interface Config {
  /** Whether this composition registers the nine `evolution_*` tools on the global layer. `off` — the shipped default, see {@link DEFAULT_EVOLUTION} — registers none of them: no model surface (root, granted worker, or the */
  evolution: 'off' | 'on'
  /** The review/supervision policy: which terminal reviews are diagnosed on their own, the per-source round caps, and the coordination allowance (see {@link SupervisionConfig}). */
  supervision?: SupervisionConfig
}

/** The shipped switch position: `off`. */
export const DEFAULT_EVOLUTION: 'off' = 'off'

const Supervision: z<SupervisionConfig> = z.object({
  autoReview: z.union([z.const('all'), z.const('failed'), z.const('off')]).default(DEFAULT_SUPERVISION.autoReview),
  maxRecoveryRounds: z.number().default(DEFAULT_SUPERVISION.maxRecoveryRounds),
  maxImprovementRounds: z.number().default(DEFAULT_SUPERVISION.maxImprovementRounds),
  coordinationBudget: z.number().default(DEFAULT_SUPERVISION.coordinationBudget),
})

const ConfigSchema: z<Config> = z.object({
  evolution: z.union([z.const('off'), z.const('on')]).default(DEFAULT_EVOLUTION),
  supervision: Supervision.default({ ...DEFAULT_SUPERVISION }),
})

/** The evolution exposure this composition resolved, provided on the agent's own fiber as `ctx.singularityEvolution`. */
class EvolutionExposure extends Service {
  /** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
  readonly enabled: boolean

  constructor(ctx: Context, enabled: boolean) {
    super(ctx, 'singularityEvolution')
    this.enabled = enabled
  }
}

/** The supervision policy this composition resolved, provided on the agent's own fiber as `ctx.singularitySupervision` — what the task runtime's per-source round caps read. */
class SupervisionExposure extends Service {
  readonly autoReview: SupervisionConfig['autoReview']
  readonly maxRecoveryRounds: number
  readonly maxImprovementRounds: number
  readonly coordinationBudget: number

  constructor(ctx: Context, policy: SupervisionConfig) {
    super(ctx, 'singularitySupervision')
    this.autoReview = policy.autoReview
    this.maxRecoveryRounds = policy.maxRecoveryRounds
    this.maxImprovementRounds = policy.maxImprovementRounds
    this.coordinationBudget = policy.coordinationBudget
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityEvolution: EvolutionExposure
    singularitySupervision: SupervisionExposure
  }
}

/** The harness repo root this composition passes to the evolution ledger: the base of its `$DSH_HOME` fallback (`<repoRoot>/.dsh`), of the production `config.yml` default, and of relative evidence refs. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The one selection shape this resolver reads: whatever the deployment's default-model service answers with. */
interface ModelSelectionLike {
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
  maxTokens?: unknown
}

/** The model selection the evolution plane freezes with an experiment and re-reads before a promotion (see `Config.modelSelection` of the evolution service). */
export function deploymentModelSelection(ctx: Context): ModelSelection | undefined {
  const defaults = optionalService<{ currentSelection(): ModelSelectionLike }>(ctx, 'agentDefaultModel')
  return modelSelectionOf(defaults?.currentSelection())
}

export class SingularityAgent extends Service {
  static inject = ['tools', 'graphs', 'agentRuntime', 'task', 'taskRuntime', 'singularityContext', 'userQuestions', 'approval']
  static Config: z<Config> = ConfigSchema

  /** The evolution ledger this assembly owns — kept as a field because the startup reconciliation (`[Service.init]`, below) settles its open commit intents before this plugin becomes ready, whether or not. */
  private readonly evolution: EvolutionService

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'singularityAgent')
    this.assertClosedConfig(config)
    const supervision = configureSupervision(config?.supervision)
    const evolution = config?.evolution ?? DEFAULT_EVOLUTION
    ctx.plugin(HitlService)
    // The evolution tools read `ctx.evolution`, and a service a child fiber
    // provides is invisible to the parent that mounted it — so the ledger's
    this.evolution = new EvolutionService(ctx, {
      repoRoot: REPO_ROOT,
      modelSelection: () => deploymentModelSelection(ctx),
      // The A6 seams, both owned elsewhere: the supervisor delegation is a row of
      // the coordination ledger this plugin owns (the evolution plane must not
      supervisorDelegation: supervisorDelegationSource().read,
      capabilityConfig: join(REPO_ROOT, 'config.yml'),
    })
    // Same discipline for the escalation ledger: the `escalate` tool reads
    // `ctx.escalation` from this fiber, and the parent never injects it.
    new EscalationService(ctx)
    // And for the T2/T3 review channel: the task runtime resolves
    // `ctx.proposalReviewChannel` softly and asks it when a batch waits for a
    new ProposalReviewService(ctx)
    // What this assembly did, said where a sibling can read it (the root agent's
    // tool allow-list is the consumer) — see {@link EvolutionExposure}.
    new EvolutionExposure(ctx, evolution === 'on')
    // The supervision policy, said where the task runtime reads it: the round
    // caps and the coordination allowance are one policy, declared once here.
    new SupervisionExposure(ctx, supervision)
    // The reviewer ledger is the one delegation source this deployment has (A2
    // §D): the context read core resolves a reviewer's read domain from it, and
    ctx.effect(
      () => ctx.singularityContext.registerReviewerBindingSource(reviewerBindingSource()),
      'singularityAgent: reviewer binding source',
    )
    // The automatic trigger of the review chain (A5): a review that settled
    // `failed` is accepted for diagnosis on its own — when the record becomes
    ctx.effect(
      () => installReviewAgentAutoTrigger(ctx),
      'singularityAgent: review agent auto trigger',
    )
    // The hand-off trigger (A6): a graph that becomes active scans its store for
    // pending hand-offs — the moment a process that booted over a store with a
    ctx.effect(
      () => installSupervisorHandoffTrigger(ctx),
      'singularityAgent: supervisor hand-off trigger',
    )
    // The one approval a budget extension can be granted through (K4): the
    // runtime asks it alone — for the one request that is not already recorded —
    ctx.effect(
      () => ctx.taskRuntime.registerRootBudgetApproval(defineRootBudgetApproval(ctx)),
      'singularityAgent: root budget approval',
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
    ctx.tools.register(defineTaskIntakeTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskProposalReadTool(ctx))
    ctx.tools.register(defineTaskProposalContinueTool(ctx))
    ctx.tools.register(defineTaskProposalCancelTool(ctx))
    ctx.tools.register(defineTaskStatusTool(ctx))
    ctx.tools.register(defineTaskSubmitResultTool(ctx))
    // The two halves of the direct parent/child question protocol (A4 §F.1): a
    // worker asks its own direct parent, and a parent answers the child that
    ctx.tools.register(defineTaskAskParentTool(ctx))
    ctx.tools.register(defineTaskAnswerTool(ctx))
    ctx.tools.register(defineTaskCancelTool(ctx))
    ctx.tools.register(defineTaskVerifyTool(ctx))
    ctx.tools.register(defineTaskReviewPackTool(ctx))
    ctx.tools.register(defineTaskReviewAgentTool(ctx))
    // The recovery entry (A6): registered like the rest of the task surface —
    // who may reach it is decided by the caller's own live session and the
    ctx.tools.register(defineTaskRecoverTool(ctx))
    // Asking a person to raise this tree's ceilings (K4): registered like the
    // rest of the task surface — who may reach it (a graph's root coordination
    ctx.tools.register(defineTaskBudgetExtendTool(ctx))
    ctx.tools.register(defineTaskDiagnoseTool(ctx))
    // The evolution chain is the one part of this surface a deployment may
    // withhold (R0). Off, none of the nine is registered, so no agent surface
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

  /** The startup reconciliation (K2): before this plugin is ready — and whatever the tool switch says — every commit intent the ledger left open is settled against what production actually holds. */
  protected async [Service.init](): Promise<void> {
    let outcomes: Awaited<ReturnType<EvolutionService['reconcile']>>
    try {
      outcomes = await this.evolution.reconcile()
    } catch (error) {
      throw new Error(
        `singularity-agent: the evolution ledger could not be reconciled at startup (${error instanceof Error ? error.message : String(error)}); ` +
        'refusing to become ready with an unreconciled production commit rather than serving a deployment whose production may not ' +
        'match its ledger',
      )
    }
    for (const outcome of outcomes) {
      if (outcome.result !== 'blocked') continue
      this.warn(
        `evolution: the commit intent "${outcome.intentId}" (${outcome.direction} of proposal "${outcome.proposalId}") targeting ` +
        `${outcome.targets.join(', ')} could not be settled — ${outcome.detail ?? 'no reason reported'}`,
      )
    }
  }

  /** Refuse a configuration member this plugin does not read. The schema keeps unknown keys on the object it validates, so this is where a caller's typo is caught: */
  private assertClosedConfig(config: Config | undefined): void {
    if (config === undefined) return
    const known = new Set(['evolution', 'supervision'])
    const unknown = Object.keys(config).filter(key => !known.has(key))
    if (unknown.length > 0) {
      throw new Error(
        `singularity-agent: the configuration names [${unknown.join(', ')}], which this plugin does not read; ` +
        'a member nobody reads refuses to start rather than being silently ignored',
      )
    }
    const supervision = config.supervision
    if (supervision === undefined) return
    const knownSupervision = new Set(['autoReview', 'maxRecoveryRounds', 'maxImprovementRounds', 'coordinationBudget'])
    const unknownSupervision = Object.keys(supervision).filter(key => !knownSupervision.has(key))
    if (unknownSupervision.length === 0) return
    throw new Error(
      `singularity-agent: the supervision configuration names [${unknownSupervision.join(', ')}], which this plugin does not read; ` +
      'a member nobody reads refuses to start rather than being silently ignored',
    )
  }

  /** Report a fact nobody should read as a startup failure — the same soft logger the task runtime uses, so a deployment that mounts no logger still gets the line rather than an exception about it. */
  private warn(message: string): void {
    logOf(this.ctx, 'singularity-agent')?.warn(message)
  }
}

export default SingularityAgent

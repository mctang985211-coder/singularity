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
import { coordinationBindingSource } from './coordination/store.ts'
import { coordinationFactsReader } from './coordination/facts-reader.ts'
import { configureSupervision, graphImprovementCap, DEFAULT_SUPERVISION, type SupervisionConfig } from './coordination/supervision.ts'
import { installCoordinationDriver } from './coordination/driver.ts'
import { defineReviewerCompleteTool, defineSupervisorCompleteTool } from './tools/completion-tools.ts'
import { logOf } from './log.ts'
import { defineApproveTool } from './tools/approve.ts'
import { defineAskTool } from './tools/ask.ts'
import { defineRootBudgetApproval, defineTaskBudgetExtendTool } from './tools/budget-extend.ts'
import { defineTaskLibraryTool } from './tools/task-library.ts'
import { defineCapabilityListTool } from './tools/capability-list.ts'
import { defineContextReadTool } from './tools/context-read.ts'
import { defineEscalateTool } from './tools/escalate.ts'
import { defineMethodDiscardTool } from './tools/method-discard.ts'
import { defineMethodDraftTool } from './tools/method-draft.ts'
import { defineMethodEvaluateTool } from './tools/method-evaluate.ts'
import { defineMethodListTool } from './tools/method-list.ts'
import { defineMethodPublishTool } from './tools/method-publish.ts'
import { defineMethodRollbackTool } from './tools/method-rollback.ts'
import { defineMarkReadyTool } from './tools/mark-ready.ts'
import { defineSpawnTool } from './tools/spawn.ts'
import { defineTaskAnswerTool } from './tools/task-answer.ts'
import { defineTaskAskParentTool } from './tools/task-ask-parent.ts'
import { defineTaskCancelTool } from './tools/task-cancel.ts'
import { defineTaskDecomposeTool } from './tools/task-decompose.ts'
import { defineTaskDiagnoseTool } from './tools/task-diagnose.ts'
import { defineTaskIntakeTool } from './tools/task-intake.ts'
import { defineTaskTemplateListTool } from './tools/task-template-list.ts'
import { defineTaskProposalCancelTool } from './tools/task-proposal-cancel.ts'
import { defineTaskProposalContinueTool } from './tools/task-proposal-continue.ts'
import { defineTaskProposalReadTool } from './tools/task-proposal-read.ts'
import { defineTaskReadTool } from './tools/task-read.ts'
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
export type { SupervisionConfig } from './coordination/supervision.ts'

/** Plugin configuration — the deployment's composition, not a model's choice. */
export interface Config {
  /** Whether this composition registers the six `method_*` tools on the global layer. `on` — the shipped default, see {@link DEFAULT_METHOD_TOOLS} — registers all six; `off` registers none, so no model surface (root, granted worker) can read, draft or publish a method. */
  methodTools: 'off' | 'on'
  /** The review/supervision policy: the coordination allowance a store's coordination agents spend (see {@link SupervisionConfig}). */
  supervision?: SupervisionConfig
}

/** The shipped switch position: `on` — the method tools are the one way a method changes. */
export const DEFAULT_METHOD_TOOLS: 'on' = 'on'

const Supervision: z<SupervisionConfig> = z.object({
  coordinationBudget: z.number().default(DEFAULT_SUPERVISION.coordinationBudget),
})

const ConfigSchema: z<Config> = z.object({
  methodTools: z.union([z.const('off'), z.const('on')]).default(DEFAULT_METHOD_TOOLS),
  supervision: Supervision.default({ ...DEFAULT_SUPERVISION }),
})

/** The method-tool exposure this composition resolved, provided on the agent's own fiber as `ctx.singularityMethods`. */
class MethodToolsExposure extends Service {
  /** `true` when `Config.methodTools` is `on`, i.e. the six `method_*` tools are registered. */
  readonly enabled: boolean

  constructor(ctx: Context, enabled: boolean) {
    super(ctx, 'singularityMethods')
    this.enabled = enabled
  }
}

/** The supervision policy this composition resolved, provided on the agent's own fiber as `ctx.singularitySupervision` — the coordination allowance the ledger reads, and the per-store round cap the task runtime's recovery entry reads. */
class SupervisionExposure extends Service {
  readonly coordinationBudget: number

  constructor(ctx: Context, policy: SupervisionConfig) {
    super(ctx, 'singularitySupervision')
    this.coordinationBudget = policy.coordinationBudget
  }

  /**
   * The round cap in force for one store: the round count its graph's RSI
   * settings declare when that graph runs a platform loop (the driver registers
   * it — see `coordination/driver.ts`), `undefined` otherwise, so the
   * runtime's own constant stands for every store without one. The runtime's
   * `iteration-cap` check reads this per store, so a graph-scheduled loop may
   * open exactly the rounds its graph names — and since the driver is the only
   * caller that opens a round any more, the same answer governs its recoveries.
   */
  maxImprovementRoundsFor(storeId: string): number | undefined {
    return graphImprovementCap(storeId)
  }

  /** The recovery-round cap in force for one store: the graph's own round count for a driver-scheduled store, `undefined` otherwise (the runtime's constant then stands). */
  maxRecoveryRoundsFor(storeId: string): number | undefined {
    return graphImprovementCap(storeId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityMethods: MethodToolsExposure
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
    const methodTools = config?.methodTools ?? DEFAULT_METHOD_TOOLS
    ctx.plugin(HitlService)
    // The v4 evolution ledger stays mounted while old graphs are still readable:
    // a deployment with a legacy library keeps its own startup reconciliation, and
    // no model tool writes it any more.
    this.evolution = new EvolutionService(ctx, {
      repoRoot: REPO_ROOT,
      modelSelection: () => deploymentModelSelection(ctx),
      capabilityConfig: join(REPO_ROOT, 'config.yml'),
    })
    // Same discipline for the escalation ledger: the `escalate` tool reads
    // `ctx.escalation` from this fiber, and the parent never injects it.
    new EscalationService(ctx)
    // And for the T2/T3 review channel: the task runtime resolves
    // `ctx.proposalReviewChannel` softly and asks it when a batch waits for a
    new ProposalReviewService(ctx)
    // What this assembly did, said where a sibling can read it (the root agent's
    // tool allow-list is the consumer) — see {@link MethodToolsExposure}.
    new MethodToolsExposure(ctx, methodTools === 'on')
    // The supervision policy, said where the task runtime reads it: the round
    // caps and the coordination allowance are one policy, declared once here.
    new SupervisionExposure(ctx, supervision)
    // The coordination store is the one delegation source this deployment has:
    // the context read core resolves a coordination session's read domain from
    // it, with the role required and never assumed.
    ctx.effect(
      () => ctx.singularityContext.registerCoordinationBindingSource(coordinationBindingSource()),
      'singularityAgent: coordination binding source',
    )
    // The platform-side coordination driver: a current graph that carries `rsi`
    // settings has its rounds scheduled here — one terminal root Run per round,
    // one supervisor per round, one next round opened by this driver. It is the
    // only place a coordination supervisor exists, and the only writer of
    // assignments and completions.
    ctx.effect(() => installCoordinationDriver(ctx).dispose, 'singularityAgent: coordination driver')
    // The one coordination fact producer the read model reduces progress from.
    // A deployment without the view service is named at startup rather than
    // silently reading a progress nobody can derive.
    ctx.effect(() => {
      const view = ctx.get('singularityGraphView') as { registerCoordinationFacts(reader: ReturnType<typeof coordinationFactsReader>): () => void } | undefined
      if (view === undefined) {
        this.warn(
          'singularity-agent: no singularityGraphView service is mounted, so this deployment reads no derived ' +
            'coordination progress; the driver still assigns and completes work',
        )
        return () => undefined
      }
      return view.registerCoordinationFacts(coordinationFactsReader())
    }, 'singularityAgent: coordination facts')
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
    ctx.tools.register(defineTaskLibraryTool(ctx))
    ctx.tools.register(defineTaskTemplateListTool(ctx))
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
    // The completion protocol is part of this deployment, not of the evolution
    // switch: a reviewer exists without any method tool, and both completion
    // tools are visible only to the coordination role its assignment names.
    ctx.tools.register(defineSupervisorCompleteTool(ctx))
    ctx.tools.register(defineReviewerCompleteTool(ctx))
    // Asking a person to raise this tree's ceilings (K4): registered like the
    // rest of the task surface — who may reach it (a graph's root coordination
    ctx.tools.register(defineTaskBudgetExtendTool(ctx))
    ctx.tools.register(defineTaskDiagnoseTool(ctx))
    // The six method tools are the one surface a deployment may withhold (R0).
    // Registered together: a supervisor that cannot publish or a root that cannot
    // read the method's state would each be a different, half-wired protocol.
    if (methodTools === 'on') {
      ctx.tools.register(defineMethodListTool(ctx))
      ctx.tools.register(defineMethodDraftTool(ctx))
      ctx.tools.register(defineMethodEvaluateTool(ctx))
      ctx.tools.register(defineMethodPublishTool(ctx))
      ctx.tools.register(defineMethodDiscardTool(ctx))
      ctx.tools.register(defineMethodRollbackTool(ctx))
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
    const known = new Set(['methodTools', 'supervision'])
    const unknown = Object.keys(config).filter(key => !known.has(key))
    if (unknown.length > 0) {
      throw new Error(
        `singularity-agent: the configuration names [${unknown.join(', ')}], which this plugin does not read; ` +
        'a member nobody reads refuses to start rather than being silently ignored',
      )
    }
    const supervision = config.supervision
    if (supervision === undefined) return
    const knownSupervision = new Set(['coordinationBudget'])
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

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type { Diagnosis } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

const TARGET_TYPES = [
  'skill', 'tool', 'capability', 'task_definition', 'decomposition_policy',
  'agent_preset', 'workflow_policy', 'verifier', 'runtime_policy',
]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_diagnose: missing agent id')
  return id
}

export function defineTaskDiagnoseTool(ctx: Context) {
  return defineTool({
    name: 'task_diagnose',
    description:
      'Record a diagnosis for a task: an explanation of what its reviews show (observed failure, scope, localized cause, confidence), ' +
      'not a score. Call task_review_pack first and ground every diagnosis in its output — evidenceRefs and reviewRefs must name ' +
      'real evidence ids and the review refs the pack prints; at least one ref is required. proposals are structured suggestions ' +
      'only: they are stored as data and never execute automatically. Written once per diagnosisId and immutable afterwards.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task the diagnosis explains' },
      diagnosisId: { type: 'string', required: true, description: 'Unique id for this diagnosis; a duplicate id is rejected' },
      observedFailure: { type: 'string', required: true, description: 'The failure or anomaly under explanation, as observed' },
      scope: { type: 'string', required: true, description: 'How far the cause reaches (this task, its subtree, a shared assumption, …)' },
      localizedCause: { type: 'string', required: true, description: 'The most specific explanation the evidence supports' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Evidence ids the diagnosis rests on' },
      reviewRefs: { type: 'array', items: { type: 'string' }, description: 'Review refs from task_review_pack (<taskId>#<runId> or <taskId>#no-run)' },
      confidence: { type: 'string', required: true, enum: ['high', 'medium', 'low'], description: 'How sure the diagnoser is; coarse on purpose' },
      proposals: {
        type: 'array',
        description: 'Structured suggestions for later Evolution steps; stored as data, never auto-executed',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetType: { type: 'string', required: true, enum: TARGET_TYPES, description: 'The mutation surface the proposal points at' },
            targetId: { type: 'string', required: true, description: 'Name of the concrete target' },
            rationale: { type: 'string', required: true, description: 'Why this change would address the localized cause' },
          },
        },
      },
      relatedTaskIds: { type: 'array', items: { type: 'string' }, description: 'Other tasks this diagnosis implicates (cross-task lineage)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const graph = await ctx.graphs.graphForSession(caller)
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const diagnosis: Diagnosis = {
        diagnosisId: args.diagnosisId,
        taskId: args.taskId,
        observedFailure: args.observedFailure,
        scope: args.scope,
        localizedCause: args.localizedCause,
        evidenceRefs: args.evidenceRefs ?? [],
        reviewRefs: args.reviewRefs ?? [],
        confidence: args.confidence,
        proposals: args.proposals ?? [],
        ...(args.relatedTaskIds === undefined ? {} : { relatedTaskIds: args.relatedTaskIds }),
      }
      try {
        await ctx.task.recordDiagnosisIn(storeId, diagnosis, caller)
      } catch (error) {
        return `task_diagnose rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      const proposals = diagnosis.proposals.map(item => `- ${item.targetType} ${item.targetId}: ${item.rationale}`)
      return [
        `diagnosis ${diagnosis.diagnosisId} recorded for task ${diagnosis.taskId} [${diagnosis.confidence}]`,
        `cause: ${diagnosis.localizedCause}`,
        ...(proposals.length === 0 ? ['proposals: none'] : [`proposals (${proposals.length}, suggestions only — none auto-executes):`, ...proposals]),
      ].join('\n')
    },
  })
}

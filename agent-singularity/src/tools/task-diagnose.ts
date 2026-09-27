import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type { Diagnosis, DiagnosisProposal } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty name: what a target type has to be, with no vocabulary to be in. */
function isTargetTypeName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Validate the model-supplied proposals into the recorded shape. The target
 * type is an **open, non-empty name** (A5): the diagnosis does not own a
 * vocabulary, so a suggestion that names a surface no executor exists for is
 * recorded like any other — the entry that would convert it into an
 * executable proposal is where that name is checked
 * (`evolution_propose`'s fromDiagnosis, which refuses what it cannot execute
 * with zero ledger writes).
 */
function toProposals(value: unknown): DiagnosisProposal[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('task_diagnose: proposals must be an array')
  return value.map((item: unknown, index: number) => {
    if (!isRecord(item)) throw new Error(`task_diagnose: proposals[${index}] must be an object`)
    if (!isTargetTypeName(item.targetType)) {
      throw new Error(`task_diagnose: proposals[${index}].targetType must be a non-empty string, got "${String(item.targetType)}"`)
    }
    if (typeof item.targetId !== 'string') throw new Error(`task_diagnose: proposals[${index}].targetId must be a string`)
    if (typeof item.rationale !== 'string') throw new Error(`task_diagnose: proposals[${index}].rationale must be a string`)
    return { targetType: item.targetType, targetId: item.targetId, rationale: item.rationale }
  })
}

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_diagnose: missing agent id')
  return id
}

export function defineTaskDiagnoseTool(ctx: Context) {
  return defineTool({
    name: 'task_diagnose',
    description:
      'Record a diagnosis for a task: an explanation of what its reviews show (the postmortem observation, scope, localized cause, ' +
      'confidence), not a score. A diagnosis may conclude that something should improve, that nothing should, or that the evidence ' +
      'does not settle it — the conclusion is recorded as written. Call task_review_pack first and ground every diagnosis in its ' +
      'output — evidenceRefs and reviewRefs must name real evidence ids and the review refs the pack prints; at least one ref is ' +
      'required. proposals are structured suggestions only: they are stored as data and never execute automatically, and their ' +
      'targetType is an open name — nothing here executes a suggestion, and the entry that converts one refuses what it cannot run. ' +
      'Written once per diagnosisId and immutable afterwards.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task the diagnosis explains' },
      diagnosisId: { type: 'string', required: true, description: 'Unique id for this diagnosis; a duplicate id is rejected' },
      observedFailure: { type: 'string', required: true, description: 'The postmortem observation (复盘观察): what was actually observed, whether the review failed or succeeded' },
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
            targetType: { type: 'string', required: true, description: 'The mutation surface the proposal points at, as a name; only the entry that would execute it judges that name' },
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
        proposals: toProposals(args.proposals),
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

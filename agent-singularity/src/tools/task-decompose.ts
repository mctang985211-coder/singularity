import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { ChildOutcome } from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_decompose: missing agent id')
  return id
}

function renderOutcome(outcome: ChildOutcome): string {
  const run = outcome.runId === undefined ? '' : ` run ${outcome.runId}`
  const evidence = outcome.evidenceId === undefined ? '' : ` evidence ${outcome.evidenceId}`
  return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`
}

export function defineTaskDecomposeTool(ctx: Context) {
  return defineTool({
    name: 'task_decompose',
    description:
      'Decompose the caller\'s current task into child tasks, then run them one at a time in dependency order. ' +
      'Each child is verified independently; only verified children count as done.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why this delegation is needed; recorded in each child handoff' },
      children: {
        type: 'array',
        required: true,
        description: 'Child tasks to admit and run',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            objective: { type: 'string', required: true, description: 'Complete, self-contained goal of the child task' },
            acceptanceCriteria: {
              type: 'array',
              required: true,
              description: 'How a verifier decides the child is done',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  description: { type: 'string', required: true, description: 'What must hold true' },
                  command: { type: 'string', description: 'Shell command; exit code 0 proves the criterion (deterministic modes)' },
                  mode: {
                    type: 'string',
                    enum: ['deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite'],
                    description: 'Verifier kind; defaults to deterministic when a command is given, review otherwise',
                  },
                  mandatory: { type: 'boolean', description: 'Whether the criterion must pass; default true' },
                  requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence kinds the verifier must attach' },
                  requiresArtifact: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Artifact/evidence kinds or ids that must already exist in the task store for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation',
                  },
                  verifierRef: {
                    type: 'string',
                    description: 'Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode.',
                  },
                },
              },
            },
            requiredCapabilities: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Capability names the child needs; call capability_list first to see the names the runtime can grant — ' +
                'an unlisted name is a capability gap that rejects the whole batch unless the child is declared decomposable',
            },
            dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Indices of sibling children that must verify before this one starts' },
            assumptions: {
              type: 'array',
              items: { type: 'string' },
              description: 'External conditions this child\'s contract rests on; merged with dependency-evidence references into the worker handoff',
            },
            decomposable: {
              type: 'boolean',
              description: 'Declare that this child should split further instead of doing the work: its worker is told to call task_decompose. Together with a capability gap this decides whether the child is admitted as decomposable.',
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller)
      let outcomes: ChildOutcome[]
      try {
        outcomes = await ctx.taskRuntime.decomposeAndRun(
          storeId,
          task.taskId,
          run.runId,
          caller,
          { reason: args.reason, children: args.children },
          { signal: exec.signal },
        )
      } catch (error) {
        return `task_decompose rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      return [`decomposed ${task.taskId} into ${outcomes.length} children:`, ...outcomes.map(renderOutcome)].join('\n')
    },
  })
}

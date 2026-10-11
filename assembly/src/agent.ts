import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { ProtocolRefusal } from '../../src/protocol/refusal.ts'

export const name = 'singularity-agent'

export const inject = ['singularity', 'tools', 'systemPrompt']

type Answer<T> = T | { readonly refused: string; readonly detail: string }

async function attempt<T>(step: () => Promise<T>): Promise<Answer<T>> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return { refused: error.refusal.code, detail: error.refusal.detail }
    throw error
  }
}
const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const GUIDANCE = `Use singularity_propose_task to start a complete solve Run. Its response declares
this Run's workspace, input, artifact, submission kind and the supported templates.
For a program submission, provide a Node ES module; process.argv[2] is the input path and stdout is
the artifact. A source submission is judged as written.
Root agents use singularity_decompose_task to select host templates, dependencies, supports and Run budgets.
Assigned children execute their existing Task/Run using submit/status; they cannot propose or decompose.
Only a verified producer's sealed artifact can become a dependent Run's input. supports describes
work toward a parent criterion; children never supply the parent's verdict. After all children verify,
submit the parent's own result through singularity_submit_program for its independent verifier.
Read sealed results with singularity_task_status. Execution failures cannot pass verification.`

export function apply(ctx: Context): void {
  const disposers = [
    ctx.tools.register(
      defineTool({
        name: 'singularity_propose_task',
        description:
          'Propose one task to the Singularity pipeline. It is admitted with the criterion this deployment holds and you become responsible for it. Returns the task id, the workspace prepared with the material the task is judged on, and the criterion the answer is judged against.',
        parameters: {
          goal: { type: 'string', description: 'What the task is for, in one sentence.', required: true },
        },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).propose({ goal: args.goal }))),
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'singularity_decompose_task',
        description:
          'Declare one complete plan using the supported templates returned by propose. Each child has its own criterion. Artifact inputs require exactly one direct dependency with the producer template. All children must verify before the parent submits its own independently judged result.',
        parameters: {
          taskId: { type: 'string', description: 'The task id the proposal returned. You must be the agent responsible for it.', required: true },
          children: {
            type: 'array',
            description: 'The whole plan, in one call. At least one sub-task.',
            required: true,
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'A name for this sub-task, unique inside the plan. The sub-task id is derived from it, so the same key addresses the same sub-task on a retry.', required: true },
                template: { type: 'string', description: 'A supported template id from the proposal. The host fixes its goal, input source and criterion.', required: true },
                dependsOn: { type: 'array', description: 'Keys of sub-tasks that must verify before this one may start.', required: true, items: { type: 'string' } },
                supports: { type: 'array', description: 'Parent criterion ids this work supports. This does not produce a parent verdict.', required: true, items: { type: 'string' } },
                maxRuns: { type: 'integer', description: 'How many attempts this sub-task may have. Fixed here, and nothing can raise it later.', required: true },
              },
              additionalProperties: false,
            },
          },
        },
        output,
        execute: async (args, exec) =>
          JSON.stringify(
            await attempt(() =>
              ctx.singularity.forCall(exec).decompose({
                taskId: args.taskId,
                children: args.children.map(child => ({ key: child.key, template: child.template, dependsOn: child.dependsOn, supports: child.supports, maxRuns: child.maxRuns })),
              }),
            ),
          ),
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'singularity_submit_program',
        description:
          "Submit what answers a proposed task: the domain's own submission, written into the task workspace and handed to the criterion's own verifier — an independent program whose verdict is recorded as a fact. Anything on standard error is not part of the submission, and work that crashes or produces nothing is a recorded fail, not a missing result.",
        parameters: {
          taskId: { type: 'string', description: 'The task id the proposal returned.', required: true },
          program: { type: 'string', description: 'The submission as text: for a program domain, the whole program source, which must print the answer to standard output.', required: true },
        },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).submit({ taskId: args.taskId, program: args.program }))),
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'singularity_task_status',
        description:
          'Read one task as the pipeline projects it: its phase, how many attempts it has, and the receipt of its latest settled run, derived from the committed facts.',
        parameters: { taskId: { type: 'string', description: 'The task id the proposal returned.', required: true } },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).status({ taskId: args.taskId }))),
      }),
    ),
    ctx.systemPrompt.section({ name: 'singularity:policy', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: GUIDANCE }),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}

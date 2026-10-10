/**
 * The agent face: the model's whole interface, registered into the scope it is mounted in.
 *
 * Three tools — propose, submit, read — and none for admitting a contract, assigning a task, recording
 * a verdict or settling a run: a model that cannot call those cannot forge them. No schema carries a
 * caller identity, and a refusal comes back as `{ refused, detail }`.
 *
 * @module @dangosys/dsh-singularity-next/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { ProtocolRefusal } from '../../src/protocol/refusal.ts'

export const name = 'singularity-agent'

/** The host's service, the tool registry, and the prompt this face contributes to. */
export const inject = ['singularity', 'tools', 'systemPrompt']

type Answer<T> = T | { readonly refused: string; readonly detail: string }

/** Run one call, turning a domain refusal into a value the model can read and act on. */
async function attempt<T>(step: () => Promise<T>): Promise<Answer<T>> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return { refused: error.refusal.code, detail: error.refusal.detail }
    throw error
  }
}
// The canonical value is the answer's JSON text: one shape for all three tools, and a refusal and an
// answer reach the model the same way — as the JSON of the object this package produced.
const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const GUIDANCE = `Singularity is assembled in this session, for any task whose answer must be judged by an
implementation rather than by you. \`singularity_propose_task\` admits a task with this deployment's
criterion and returns its id and the workspace that holds the material it is judged on;
\`singularity_decompose_task\` splits a task you are responsible for into sub-tasks that run in their own
sessions, where only a verified sub-task satisfies a criterion and only an unblocked one starts;
\`singularity_submit_program\` writes what you produced into that workspace and hands it to the
criterion's own verifier — an independent program whose verdict is recorded as a fact.
\`singularity_task_status\` reads the task back. The verifier's word is the only word that counts: work
that crashes, produces nothing, or produces something plausible that is not the answer is a recorded fail.`

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
          'Split a task you are responsible for into sub-tasks, each worked by its own agent in its own session. Declare the whole plan in one call: every sub-task, what it depends on, which of the task\'s own criteria it supports, and how many attempts it may have. A sub-task runs the moment nothing it depends on is still pending, and only a sub-task that verifies satisfies the criterion it supports — so the plan is what decides the order of work.',
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
                goal: { type: 'string', description: 'What this sub-task is for, in one sentence.', required: true },
                dependsOn: { type: 'array', description: 'Keys of sub-tasks that must verify before this one may start.', required: true, items: { type: 'string' } },
                supports: { type: 'array', description: 'Criterion ids of your own contract that this sub-task\'s verification supports.', required: true, items: { type: 'string' } },
                maxRuns: { type: 'integer', description: 'How many attempts this sub-task may have. Fixed here, and nothing can raise it later.', required: true },
              },
              // Closed on purpose: the protocol refuses a plan carrying a member it does not declare, so
              // the schema says so here rather than letting a plausible extra key be silently dropped.
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
                children: args.children.map(child => ({ taskId: child.key, dependsOn: child.dependsOn, supports: child.supports, maxRuns: child.maxRuns })),
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
    // The guidance goes where the host puts tool policy, through the host's own order table.
    ctx.systemPrompt.section({ name: 'singularity:policy', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: GUIDANCE }),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}

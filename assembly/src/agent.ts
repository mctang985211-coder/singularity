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
criterion and returns its id and the workspace holding its input; \`singularity_submit_program\` writes a
program you wrote into that workspace and runs it as an ES module of node with the input path as its only
argument, and only what it prints to standard output reaches the criterion's own verifier.
\`singularity_task_status\` reads the task back. The verifier's word is the only word that counts: a
program that crashes, prints nothing, or prints a plausible number that is not the answer is a recorded fail.`

export function apply(ctx: Context): void {
  const disposers = [
    ctx.tools.register(
      defineTool({
        name: 'singularity_propose_task',
        description:
          'Propose one task to the Singularity pipeline. It is admitted with the criterion this deployment holds and you become responsible for it. Returns the task id, the workspace that holds its input, and the criterion the answer is judged against.',
        parameters: {
          goal: { type: 'string', description: 'What the task is for, in one sentence.', required: true },
          input: { type: 'string', description: 'The input text the task is about. It is written into the workspace this call returns.', required: true },
        },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).propose({ goal: args.goal, input: args.input }))),
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'singularity_submit_program',
        description:
          "Submit the program that answers a proposed task. It is written into the task workspace and run as an ES module of node with the input path as its only argument; only what it prints to standard output is judged by the criterion's own verifier — an independent program whose verdict is recorded as a fact. Anything on standard error is not part of the submission, and a program that crashes or prints nothing is a recorded fail, not a missing result.",
        parameters: {
          taskId: { type: 'string', description: 'The task id the proposal returned.', required: true },
          program: { type: 'string', description: 'The whole program as JavaScript source. It must print the answer to standard output.', required: true },
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

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
Use singularity_create_method to admit one complete Method JSON with rootTemplate, templates, skill
and tool (an auxiliary Node ES module). The tool receives the actual input path in process.argv[2]
and an optional model-created candidate path in process.argv[3]. It may analyze, test or generate
source; its Node program is not a Verilog submission. A proposal may pin its returned method reference;
otherwise it uses the published head. singularity_run_method executes the pinned helper, and you
produce the final answer using the Method Skill and its output.
Use singularity_evolve_method with a complete round JSON to compare at least two admitted candidates
against one incumbent through real independent solves. Domain quality, independent functional
constraints, token cost, repetitions and noise band are fixed by the deployment. Freeze Method assets,
not the solver's answer. Read singularity_method_history before creating candidates: it contains actual
Task/Run results, sealed source, Method contents and frozen decisions. Propose changes from that history.
singularity_release_method accepts a bootstrap reference for an empty library or a committed roundId;
it presents the actual contents, changes and measurement to the human through native approval.
Assigned children execute their existing Task/Run using submit/status; they cannot propose or decompose.
Only a verified producer's sealed artifact can become a dependent Run's input. supports describes
work toward a parent criterion; children never supply the parent's verdict. After all children verify,
submit the parent's own result through singularity_submit_program for its independent verifier.
Read sealed results with singularity_task_status. Execution failures cannot pass verification.`

export function apply(ctx: Context): void {
  const disposers = [
    ctx.tools.register(defineTool({
        name: 'singularity_propose_task',
        description: 'Propose one task to the Singularity pipeline. It is admitted with the criterion this deployment holds and you become responsible for it. Returns the task id, the workspace prepared with the material the task is judged on, and the criterion the answer is judged against.',
        parameters: {
          goal: { type: 'string', description: 'What the task is for, in one sentence.', required: true },
          method: {
            type: 'object', description: 'Exact admitted Method reference for an experiment; omit to use the published head.',
            properties: { environmentId: { type: 'string', required: true }, revisionId: { type: 'string', required: true }, digest: { type: 'string', required: true } },
            additionalProperties: false,
          },
        },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).propose({ goal: args.goal, ...(args.method === undefined ? {} : { method: args.method }) }))),
    })),
    ctx.tools.register(defineTool({
        name: 'singularity_decompose_task',
        description: 'Declare one complete plan using the supported templates returned by propose. Each child has its own criterion. Artifact inputs require exactly one direct dependency with the producer template. All children must verify before the parent submits its own independently judged result.',
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
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).decompose(args))),
    })),
    ctx.tools.register(defineTool({
        name: 'singularity_submit_program',
        description: "Submit what answers a proposed task: the domain's own submission, written into the task workspace and handed to the criterion's own verifier — an independent program whose verdict is recorded as a fact. Anything on standard error is not part of the submission, and work that crashes or produces nothing is a recorded fail, not a missing result.",
        parameters: {
          taskId: { type: 'string', description: 'The task id the proposal returned.', required: true },
          program: { type: 'string', description: 'The submission as text: for a program domain, the whole program source, which must print the answer to standard output.', required: true },
        },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).submit({ taskId: args.taskId, program: args.program }))),
    })),
    ctx.tools.register(defineTool({
        name: 'singularity_task_status',
        description: 'Read one task as the pipeline projects it: its phase, how many attempts it has, and the receipt of its latest settled run, derived from the committed facts.',
        parameters: { taskId: { type: 'string', description: 'The task id the proposal returned.', required: true } },
        output,
        execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).status({ taskId: args.taskId }))),
    })),
    ctx.tools.register(defineTool({
      name: 'singularity_create_method',
      description: 'Admit an immutable Method with rootTemplate, templates, skill and tool. Templates use the deployment schema and independent verifiers; protected inputs and acceptance cannot be changed.',
      parameters: { content: { type: 'string', description: 'Complete Method JSON.', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).createMethod(JSON.parse(args.content)))),
    })),
    ctx.tools.register(defineTool({
      name: 'singularity_run_method',
      description: 'Execute the pinned auxiliary Method tool on the actual input and an optional model-created candidate. Returns helper program and its stdout. Produce your own final domain answer for independent acceptance.',
      parameters: { taskId: { type: 'string', description: 'Your working Task.', required: true },
        candidate: { type: 'string', description: 'Optional source to test or analyze, available to the helper in process.argv[3].' } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).runMethod(args))),
    })),
    ctx.tools.register(defineTool({
      name: 'singularity_evolve_method',
      description: 'Compare frozen Method assets under the deployment metric and functional constraints. Baseline and candidates solve independently in real DSH sessions, including optional decomposition, and record actual quality and token cost. Returns the committed RRSI decision, possibly no winner.',
      parameters: { round: { type: 'string', description: 'JSON {roundId,round,incumbent,candidates,explorationSlots}; at least two candidates, round 1 or 2.', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).evolve(JSON.parse(args.round)))),
    })),
    ctx.tools.register(defineTool({
      name: 'singularity_method_history',
      description: 'Read actual Task/Run execution history, sealed submissions, exact Method contents and frozen round decisions. Use these facts to propose new tasks and method candidates.',
      parameters: {}, output,
      execute: async (_args, exec) => JSON.stringify(await ctx.singularity.forCall(exec).history()),
    })),
    ctx.tools.register(defineTool({
      name: 'singularity_release_method',
      description: 'Request native human approval for {bootstrap:MethodRef} in an empty library or {roundId} with a committed winner. Publishes only the approved exact contents and decision; refusal leaves the head unchanged.',
      parameters: { release: { type: 'string', description: 'JSON {bootstrap:{environmentId,revisionId,digest}} or {roundId}.', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).release(JSON.parse(args.release)))),
    })),
    ctx.systemPrompt.section({ name: 'singularity:policy', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: GUIDANCE }),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}

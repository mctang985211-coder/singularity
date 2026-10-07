import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text } from '../shared.ts'

/** The same creation input is accepted by root intake and each direct child. */
export const templateBindingParameters = {
  templateScope: {
    type: 'array' as const,
    items: { type: 'array' as const, items: { type: 'string' as const } },
    description: 'Catalog prefixes for this task. The root selects relevant branches from the user goal; a child may inherit by omitting this field or narrow its parent scope. [] permits only explicit general templates. This grants no tools or capabilities.',
  },
  templateRef: {
    type: 'object' as const,
    additionalProperties: false,
    description: 'Exact reference from task_template_list. Use with templateParameters instead of objective/acceptanceCriteria or other contract fields; the runtime binds the full immutable template contract.',
    properties: {
      id: { type: 'string' as const, required: true },
      version: { type: 'integer' as const, required: true },
      digest: { type: 'string' as const, required: true },
    },
  },
  templateParameters: {
    type: 'object' as const,
    additionalProperties: true,
    description: 'Named primitive parameter values satisfying the selected template parametersSchema. {{name}} binds contract strings verbatim; inspect the resulting command and use values appropriate to its syntax.',
  },
} satisfies ParameterSchemaSpec

export function defineTaskTemplateListTool(ctx: Context) {
  return defineTool({
    name: 'task_template_list',
    description: 'Browse the caller-visible reusable TaskTemplate catalog and finite summary pages before authoring a Task. A TaskTemplate defines a parameterized goal, inputs, result acceptance, capabilities and optional direct-child recipe; a Skill teaches the execution method. Select catalogPath from the user goal before root intake; worker queries stay within their task branches plus general. Delegated reviewers and supervisors use their associated task scope without needing a business Run. Read an exact templateRef for the complete contract and parameter schema, and check appliesTo before binding. If none fits, write a complete one-off contract and proceed; no template publication is required or performed by discovery or admission. After execution, reusable findings can support a supervisor-evaluated task_definition candidate.',
    parameters: {
      query: { type: 'string', description: 'Optional discovery keywords within the visible scope; appliesTo decides applicability.' },
      catalogPath: { type: 'array', items: { type: 'string' }, description: 'Catalog branch to browse; cannot widen the caller-visible scope.' },
      templateRef: templateBindingParameters.templateRef,
      offset: { type: 'integer', description: 'Page offset; use nextOffset from the previous response.' },
      limit: { type: 'integer', description: 'Page size from 1 to 20; default 10.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: async (args, exec) => {
      try {
        return JSON.stringify(await ctx.taskRuntime.listTaskTemplates(args, sessionId(exec, 'task_template_list')), null, 2)
      } catch (error) {
        return `task_template_list failed: ${message(error)}`
      }
    },
  })
}

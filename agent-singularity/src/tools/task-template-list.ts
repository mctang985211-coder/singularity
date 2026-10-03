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
    description: 'Browse the caller-visible Task catalog and finite summary pages. Select catalogPath from the user goal before root intake; child queries stay within inherited branches plus general. Read an exact templateRef for the complete contract, parameter schema and optional direct-child decomposition. Choose a fitting reference and parameters or write a complete standard contract.',
    parameters: {
      query: { type: 'string', description: 'Optional discovery keywords within the visible scope; appliesTo decides applicability.' },
      catalogPath: { type: 'array', items: { type: 'string' }, description: 'Catalog branch to browse; cannot widen an admitted task scope.' },
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

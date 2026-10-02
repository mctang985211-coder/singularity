import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text } from '../shared.ts'

/** The same creation input is accepted by root intake and each direct child. */
export const templateBindingParameters = {
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
    description: 'Find reusable Task contracts before intake or decomposition. Returns each matching id\'s latest immutable version, exact digest, applicability conditions, parameter schema and complete contract. Read appliesTo to decide whether it fits; bind a suitable template in task_intake/task_decompose. With no suitable template, write a full standard contract.',
    parameters: {
      query: { type: 'string', description: 'Optional whitespace-separated discovery keywords; omit to inspect the full current library. Applicability is decided from appliesTo, not keyword matches.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: async (args, exec) => {
      try {
        const matches = await ctx.taskRuntime.findTaskTemplates(args.query, sessionId(exec, 'task_template_list'))
        return matches.length === 0
          ? 'No matching Task template. You may still submit a complete standard contract, preserving the requested objective and acceptance.'
          : JSON.stringify(matches, null, 2)
      } catch (error) {
        return `task_template_list failed: ${message(error)}`
      }
    },
  })
}

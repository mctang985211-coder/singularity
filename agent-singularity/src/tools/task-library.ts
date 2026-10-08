import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text } from '../shared.ts'

/**
 * One graph-owned table for reusable Task contracts and methods, read through the
 * one version view. Writing is not an action any role holds here: a change to the
 * executable library is a method candidate (`method_draft`) that an evaluation and
 * a publish switch into effect, and no model edits the library's bytes directly.
 */
export function defineTaskLibraryTool(ctx: Context) {
  return defineTool({
    name: 'task_library',
    description:
      'Read this graph\'s TaskTemplate and Skill library — the table binding a Task contract to a method. Use task_template_list for ' +
      'complete contracts and bind method:<name> through requiredCapabilities. This tool is read-only for every role: to change a ' +
      'method, propose a candidate with method_draft and let it be evaluated and published.',
    parameters: {
      action: { type: 'string', enum: ['read'], required: true, description: 'Only read: the library is never edited in place' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: async (args, exec) => {
      try {
        const caller = sessionId(exec, 'task_library')
        if (args.action !== 'read') {
          return (
            `task_library rejected: "${String(args.action)}" is not an action this tool offers — it reads only. ` +
            'A method change is a candidate: propose it with method_draft, measure it with method_evaluate and publish it with method_publish.'
          )
        }
        return JSON.stringify(await ctx.taskRuntime.libraryRead(caller), null, 2)
      } catch (error) {
        return `task_library failed: ${message(error)}`
      }
    },
  })
}

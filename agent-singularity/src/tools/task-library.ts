import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskTemplate } from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text } from '../shared.ts'

/** One graph-owned table for reusable Task contracts and methods, including temporary discoveries. */
export function defineTaskLibraryTool(ctx: Context) {
  return defineTool({
    name: 'task_library',
    description: 'Manage this graph\'s TaskTemplate and Skill library. Read its task table and bound Skill table; use task_template_list for complete contracts and bind method:<name> through requiredCapabilities. Write useful exploration/decomposition goals as TaskTemplates and experience as concise Skills. New and changed entries are temporary and available to later tasks. The supervisor reviews execution evidence and model cost during iteration, retains useful experience, revises it by writing a new version, or retires an entry. Each Task keeps its own acceptance and frozen method binding.',
    parameters: {
      action: { type: 'string', enum: ['read', 'write_task', 'write_skill', 'review'], required: true },
      template: { type: 'object', additionalProperties: true, description: 'Existing TaskTemplate format: id, version, catalogPath, appliesTo, parametersSchema, contract, optional direct-child decomposition.' },
      name: { type: 'string', description: 'Skill name or TaskTemplate id.' },
      skillMd: { type: 'string', description: 'Complete SKILL.md with name/description YAML frontmatter and concise method advice.' },
      expectedVersion: { type: 'integer', description: 'For write_skill: 0 creates a new Skill; a change names its current version from read.' },
      kind: { type: 'string', enum: ['task', 'skill'], description: 'For review: the table containing the entry.' },
      version: { type: 'integer', description: 'For review: the exact version from the table.' },
      status: { type: 'string', enum: ['retained', 'retired'], description: 'For review: retain or retire this reusable experience.' },
      reason: { type: 'string', description: 'Review finding grounded in task results, cost and experience.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: async (args, exec) => {
      try {
        const caller = sessionId(exec, 'task_library')
        if (args.action === 'read') return JSON.stringify(await ctx.taskRuntime.libraryRead(caller), null, 2)
        if (args.action === 'write_task') {
          if (args.template === undefined) throw new Error('write_task requires template')
          return JSON.stringify(await ctx.taskRuntime.libraryWrite(caller, { kind: 'task', template: args.template as unknown as TaskTemplate }), null, 2)
        }
        if (args.action === 'write_skill') {
          if (args.name === undefined || args.skillMd === undefined || args.expectedVersion === undefined) throw new Error('write_skill requires name, skillMd and expectedVersion')
          return JSON.stringify(await ctx.taskRuntime.libraryWrite(caller, { kind: 'skill', name: args.name, skillMd: args.skillMd, expectedVersion: args.expectedVersion }), null, 2)
        }
        if (args.kind === undefined || args.name === undefined || args.version === undefined || args.status === undefined || args.reason === undefined)
          throw new Error('review requires kind, name, version, status and reason')
        return JSON.stringify(await ctx.taskRuntime.libraryReview(caller, { kind: args.kind as 'task' | 'skill', name: args.name, version: args.version, status: args.status as 'retained' | 'retired', reason: args.reason }), null, 2)
      } catch (error) { return `task_library failed: ${message(error)}` }
    },
  })
}

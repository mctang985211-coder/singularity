/**
 * Singularity root agent extras.
 * @module dsh-singularity-agent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { HitlService } from './hitl.ts'
import { defineApproveTool } from './tools/approve.ts'
import { defineAskTool } from './tools/ask.ts'
import { defineMarkReadyTool } from './tools/mark-ready.ts'
import { defineSpawnTool } from './tools/spawn.ts'
import { defineTaskDecomposeTool } from './tools/task-decompose.ts'
import { defineTaskReadTool } from './tools/task-read.ts'
import { defineTaskStatusTool } from './tools/task-status.ts'
import { defineTaskVerifyTool } from './tools/task-verify.ts'

export { HitlService } from './hitl.ts'
export type { HitlAnswer, HitlKind, HitlPending } from './hitl.ts'

export class SingularityAgent extends Service {
  static inject = ['tools', 'graphs', 'agentRuntime', 'task', 'taskRuntime']

  constructor(ctx: Context) {
    super(ctx, 'singularityAgent')
    ctx.plugin(HitlService)
    ctx.tools.register(defineMarkReadyTool(ctx))
    ctx.tools.register(defineSpawnTool(ctx))
    ctx.tools.register(defineAskTool(ctx))
    ctx.tools.register(defineApproveTool(ctx))
    ctx.tools.register(defineTaskReadTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskStatusTool(ctx))
    ctx.tools.register(defineTaskVerifyTool(ctx))
  }
}

export default SingularityAgent

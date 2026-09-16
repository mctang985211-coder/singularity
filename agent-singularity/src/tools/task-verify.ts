import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { EvidenceBundle, RunId } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_verify: missing agent id')
  return id
}

/** Local view of the verifier service; resolved softly so this package never imports the verifier plugin. */
interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: { cwd?: string }): Promise<EvidenceBundle>
}

/** Local view of the env-builder service; resolved softly like the verifier. */
interface EnvSource {
  store: { get(id: string): { path: string } }
}

function softService<T>(ctx: Context, name: string): T | undefined {
  return (ctx.get?.(name) ?? (ctx as unknown as Record<string, T | undefined>)[name]) as T | undefined
}

export function defineTaskVerifyTool(ctx: Context) {
  return defineTool({
    name: 'task_verify',
    description:
      'Self-check: re-run the verifier against the caller\'s current task run and report per-criterion results. ' +
      'Records no task status; use it to see what the verifier would say before reporting back.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const caller = sessionId(exec)
      const verifier = softService<RunVerifier>(ctx, 'verifier')
      if (verifier === undefined || typeof verifier.verifyRun !== 'function') {
        throw new Error('task_verify: verifier service is not loaded')
      }
      const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller)
      let cwd: string | undefined
      try {
        const graph = await ctx.graphs.graphForSession(caller)
        cwd = softService<EnvSource>(ctx, 'envBuilder')?.store.get(graph.envId).path
      } catch {
        cwd = undefined
      }
      const bundle = await verifier.verifyRun(storeId, run.runId, cwd === undefined ? {} : { cwd })
      const lines = [
        `run ${run.runId} of task ${task.taskId}: evidence ${bundle.evidenceId} (self-check, status unchanged)`,
        ...bundle.verifierResults.map(result => {
          const command = result.command === undefined ? '' : ` — $ ${result.command}`
          const exit = result.exitCode === undefined ? '' : ` exit ${result.exitCode}`
          const details = result.details === undefined ? '' : ` (${result.details})`
          return `- ${result.criterionId}: ${result.status} by ${result.verifierId}${command}${exit}${details}`
        }),
      ]
      return lines.join('\n')
    },
  })
}

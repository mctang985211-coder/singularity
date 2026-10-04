import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { EvidenceBundle, RunId } from '@dangosys/dsh-singularity-task'
import { sessionId, text } from '../shared.ts'

/** Local view of the verifier service; resolved softly so this package never imports the verifier plugin. */
interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: { cwd?: string; timeoutMs?: number }): Promise<EvidenceBundle>
}

export function defineTaskVerifyTool(ctx: Context) {
  return defineTool({
    name: 'task_verify',
    description:
      'Self-check: re-run the verifier against the caller\'s current task run, record the resulting evidence bundle in the task store, and report per-criterion results. ' +
      'Records evidence but no task status; only valid while the run is running — calling it on a finished run returns an error.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const caller = sessionId(exec, 'task_verify')
      const verifier = ctx.get('verifier') as RunVerifier | undefined
      if (verifier === undefined || typeof verifier.verifyRun !== 'function') {
        throw new Error('task_verify: verifier service is not loaded')
      }
      const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller)
      if (run.status !== 'running') {
        return `task_verify: run ${run.runId} of task ${task.taskId} is ${run.status}; evidence can only be recorded while the run is running`
      }
      const cwd = await ctx.taskRuntime.envPathForSession(caller)
      // The verifier sets no timer when `timeoutMs` is undefined
      // (`verifier/src/command-verifier.ts:47`), so a criterion with a long
      const timeoutMs = ctx.taskRuntime.verifyTimeoutMs
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(
          `task_verify: task runtime exposes no positive verifyTimeoutMs (got ${String(timeoutMs)}); refusing to run the verifier without a deadline`,
        )
      }
      const bundle = await verifier.verifyRun(storeId, run.runId, { ...(cwd === undefined ? {} : { cwd }), timeoutMs })
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

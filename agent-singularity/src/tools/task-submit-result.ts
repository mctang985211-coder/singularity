import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_submit_result: missing agent id')
  return id
}

export function defineTaskSubmitResultTool(ctx: Context) {
  return defineTool({
    name: 'task_submit_result',
    description:
      'Hand in this run\'s result for acceptance. This is the explicit submission the coordination protocol is built on: it records ' +
      'what was delivered (summary, plus the evidence/artifact references you produced), closes admission for this run — no further ' +
      'write, command or decomposition is admitted — drains the calls still in flight, and hands the run to the verifier. The call ' +
      'returns the verdict. An idle session is not a completion: a worker that goes idle without submitting gets one reminder and is ' +
      'stopped by the no-progress budget if it still has not submitted. A run waiting on its own child batch cannot submit — the ' +
      'batch submits for it when the children are terminal.',
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'What was delivered, in your own words; a blank summary is refused',
      },
      evidenceRefs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence ids, artifact refs or review refs you name as proof of the summary',
      },
      notes: { type: 'string', description: 'Anything further a reader of the submission should know' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      let result: { status: string; detail: string }
      try {
        result = await ctx.taskRuntime.submitResult(caller, args, {
          // The registration id of this call, so the drain that follows the
          // phase change does not wait for the call that made it (A3 §3.3). A
          // caller without one — a test double — drains without the exclusion.
          ...(typeof exec.callId === 'string' && exec.callId.length > 0 ? { callId: String(exec.callId) } : {}),
        })
      } catch (error) {
        // A refusal is the protocol speaking, not a failure of the call: an
        // unknown identity, a run waiting on its children, a blank summary or a
        // record that predates phases. The caller reads why and nothing was
        // changed — the same answer shape `task_decompose` gives.
        return `task_submit_result rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      // A late or repeated submission is answered from the record and is not an
      // error: the run already settled, or an earlier submission stands, and
      // this call changes nothing. The runtime's own conclusion is the text.
      return `task_submit_result ${result.status}: ${result.detail}`
    },
  })
}

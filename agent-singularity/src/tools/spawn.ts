import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { graphAgentOptions } from '@dangosys/dsh-singularity-graphs'
import { sessionId, text } from '../shared.ts'

export function defineSpawnTool(ctx: Context) {
  return defineTool({
    name: 'graph_spawn',
    description:
      'Delegate environment setup only, before the graph is ready, to a new Singularity worker and wait for its final response. ' +
      'Use task_decompose for objective work after setup.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short worker name shown on the graph' },
      task: { type: 'string', required: true, description: 'Complete task for the worker' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'graph_spawn')
      const graph = await ctx.graphs.graphForSession(caller)
      if (graph.ready)
        throw new Error(`graph_spawn: graph ${graph.id} is ready; delegate objective work with task_decompose`)
      const pinned = graphAgentOptions(graph)
      const handle = await ctx.agentRuntime.spawn(exec.agent!, {
        sessionId: SessionId(randomUUID()),
        name: args.name,
        prompt: [{ type: 'text', text: args.task }],
        signal: exec.signal,
        ...(pinned === undefined ? {} : { agentOptions: pinned }),
      })
      const cancel = () => handle.agent.cancel({ kind: 'parent' })
      exec.signal.addEventListener('abort', cancel, { once: true })
      try {
        await handle.agent.whenIdle()
        exec.signal.throwIfAborted()
      } finally {
        exec.signal.removeEventListener('abort', cancel)
      }
      const event = [...handle.agent.session.snapshotEvents()].reverse().find(item => item.type === 'assistant/message')
      if (event === undefined) {
        throw new Error(`graph_spawn: worker ${handle.agent.id} produced no response`)
      }
      const result = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (result.length === 0) throw new Error(`graph_spawn: worker ${handle.agent.id} produced no text response`)
      return `Worker ${handle.agent.id} completed:\n${result}`
    },
  })
}

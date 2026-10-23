import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { ProtocolRefusal } from '../../src/protocol/refusal.ts'
import { guidanceFor, type NodeRole } from './prompts.ts'
export const name = 'singularity-agent'
export const inject = ['singularity', 'tools', 'systemPrompt']
export interface Config { role: NodeRole
}
export const Config = Schema.object({ role: Schema.union([Schema.const('root'), Schema.const('task'), Schema.const('review'), Schema.const('improve')]).default('task'),
})
declare module '@deepseek-ai/cordis' {
  interface Context { singularityAgentRole: Config['role'] }
}
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
async function attempt<T>(step: () => Promise<T>) {
  try { return await step() } catch (error) {
    if (error instanceof ProtocolRefusal) return { refused: error.refusal.code, detail: error.refusal.detail }
    throw error
  }
}
const contract = {
  type: 'object',
  required: true,
  additionalProperties: false,
  properties: {
    goal: { type: 'string', required: true },
    artifact: { type: 'string', required: true },
    template: {
      type: 'object',
      additionalProperties: false,
      description: 'Optional pinned declaration provenance; its digest and bound assets are checked by the host.',
      properties: {
        id: { type: 'string', required: true },
        digest: { type: 'string', required: true },
      },
    },
    skills: { type: 'array', items: { type: 'string' }, description: 'Explicit pinned Skill names for this child; parent bindings are not inherited. Use a template contract or select relevant method.skills.' },
    capabilities: { type: 'array', items: { type: 'string' }, description: 'Explicit capabilities or pinned method Tool names to bind to this child. Selected Skills also bind their requiredTools.' },
    inputs: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true, description: 'Materialized path in the child workspace.' },
          source: {
            required: true,
            description: 'Copy protected {kind,ref,digest} unchanged from the contract/template or dispatch.evidenceInputs. Artifact taskId may be a child ID or batch key; the host materializes verified sealed bytes.',
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', const: 'protected', required: true },
                  ref: { type: 'string', required: true },
                  digest: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', const: 'artifact', required: true },
                  taskId: { type: 'string', required: true },
                },
              },
            ],
          },
        },
      },
    },
    criteria: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { criterionId: { type: 'string', required: true }, statement: { type: 'string', required: true } },
      },
    },
  },
} as const
export function apply(ctx: Context, config: Config = { role: 'task' }): void {
  ctx.provide('singularityAgentRole', config.role)
  const common = [
    defineTool({
      name: 'singularity_read',
      description: 'Read authorized Task state, pinned assets or sealed evidence. Follow next until complete=true for text pages; trajectory indexes are metadata, not event evidence.',
      parameters: {
        kind: { type: 'string', required: true,
          description: 'summary: responsibility/budget; task: contract/state; template: declarations/bindings or prefilled contract; method: pinned assets; artifact: sealed text; trajectory: native events.' +
            (config.role === 'improve' ? ' search: phase/next/budget/authoring; round: measurements; roots/sessions/usage/steps: history.' : config.role === 'review' ? ' subject: frozen judgment assignment; round: sealed measurements.' : ' workflow: root relationships.'),
          enum: config.role === 'task' || config.role === 'root'
          ? ['summary', 'workflow', 'task', 'artifact', 'template', 'method', 'trajectory'] as const : config.role === 'improve'
            ? ['search', 'summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory', 'roots', 'sessions', 'usage', 'steps'] as const
            : ['summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory'] as const },
        ...(config.role === 'improve' || config.role === 'review' ? { rootId: { type: 'string' as const, description: config.role === 'improve' ? 'Required for historical reads/citations.' : 'Only a root in subject.rsiEvidence; no arbitrary history.' } } : {}),
        ref: { type: 'string', description: 'task/artifact: taskId; template: templateId; trajectory: sessionId; round: roundId; search: authoring or feedback for detailed rules/outcomes.' },
        runId: { type: 'string', description: 'Select an authorized artifact Run.' },
        eventSeq: { type: 'integer', description: 'Copy seq from a trajectory index to read/cite the actual event.' },
        from: { type: 'integer', description: 'Zero-based offset: UTF-8 bytes for text pages; entries for lists.' },
        count: { type: 'integer', description: 'Lists: default 20/max 100. subject, search details, method and trajectory events: bytes, default 4096/max 8192. artifact: bytes, default 16384/max 32768.' },
        producers: {
          type: 'object', additionalProperties: true,
          description: 'For template reads, map each input source templateId to a producer taskId or decomposition batch key.',
        },
      },
      output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).history(args))),
    }),
    defineTool({
      name: 'singularity_memory',
      description: 'Discover optional working notes in your readable scope. Without ref, prepare inherited background once on demand; with ref, read existing notes without a model call.',
      parameters: { ref: { type: 'string', description: 'Checkpoint ID; mutually exclusive with pagination.' }, from: { type: 'integer', description: 'Directory offset; default 0.' }, count: { type: 'integer', description: 'Directory entries; default 20, max 100.' } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).memory(args))),
    }),
    defineTool({
      name: 'singularity_submit',
      description: config.role === 'improve'
        ? 'Seal report.json using search.authoring.report; requires phase=ready. A negative result may finish the search. Private validation follows sealing.'
        : config.role === 'review'
          ? 'Seal review.json filled from dispatch.output.template.'
          : 'Seal the declared workspace artifact for independent acceptance and delivery to authorized consumers.',
      parameters: { path: { type: 'string', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => {
            const surface = ctx.singularity.forCall(exec)
            return surface.submit({ taskId: surface.current(), path: args.path })
          }),
        ),
    }),
  ]
  const delegation = defineTool({
    name: 'singularity_decompose_task',
    description: 'Delegate complete frozen child contracts. Correct named refusals before resubmission; after admission end the turn while children work.',
    parameters: {
      children: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true },
            contract,
            dependsOn: { type: 'array', items: { type: 'string' }, required: true, description: 'Real prerequisites: child IDs or batch keys.' },
            supports: { type: 'array', items: { type: 'string' }, required: true, description: 'Parent criterionIds supported by this responsibility.' },
            maxRuns: { type: 'integer', required: true },
            requirement: { type: 'string', required: true, enum: config.role === 'review' ? ['required'] as const : ['required', 'exploration'] as const,
              description: 'required: indispensable dependency which must verify; exploration: optional alternative which the parent may stop.' },
            handoff: { type: 'object', additionalProperties: false, properties: {
              decisions: { type: 'array', items: { type: 'string' }, required: true, description: 'Relevant decisions; all task requirements belong in the contract.' },
              hypotheses: { type: 'array', items: { type: 'string' }, required: true, description: 'Unverified claims for this child to investigate.' },
              exclusions: { type: 'array', items: { type: 'string' }, required: true, description: 'Relevant rejected paths and scope exclusions.' },
              evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Verified visible Task IDs to reuse.' },
            } },
          },
        },
      },
    },
    output,
    execute: async (args, exec) =>
      JSON.stringify(
        await attempt(() => {
          const surface = ctx.singularity.forCall(exec)
          return surface.decompose({
            taskId: surface.current(),
            children: args.children,
          })
        }),
      ),
  })
  const answer = defineTool({
    name: 'singularity_answer', description: 'Answer a direct child question. resolves:true releases that question only; it changes no frozen contract. Repeat the same requestKey and words after an uncertain delivery.',
    parameters: { questionId: { type: 'string', required: true }, requestKey: { type: 'string', required: true },
      answer: { type: 'string', required: true }, resolves: { type: 'boolean', required: true },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Verified Task references the child may now read and reuse.' } }, output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).answer(args))),
  })
  const retry = defineTool({
    name: 'singularity_retry_task',
    description: 'Retry your failed Run under the same contract, method and attempt budget.',
    parameters: {}, output,
    execute: async (_args, exec) => JSON.stringify(await attempt(() => {
      const surface = ctx.singularity.forCall(exec)
      return surface.retry({ taskId: surface.current() })
    })),
  })
  const stopExplorations = defineTool({
    name: 'singularity_stop_explorations',
    description: 'Stop direct exploration branches and their descendants when evidence is sufficient or an alternative is no longer useful. Cannot stop required responsibilities or dependencies still needed by active branches. Cancellation preserves history and does not certify results. Available while children are pending.',
    parameters: { taskIds: { type: 'array', items: { type: 'string' }, required: true }, reason: { type: 'string', required: true },
      requestKey: { type: 'string', required: true, description: 'Stable key; repeat the same key and content after uncertain delivery.' } }, output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).stopExplorations(args))),
  })
  const task = [
    stopExplorations,
    delegation,
    defineTool({
      name: 'singularity_ask_parent', description: 'Ask the direct parent about missing inputs or impossible obligations. blocking defaults to true: end the turn until answered. Reuse requestKey and words after uncertain delivery.',
      parameters: { requestKey: { type: 'string', required: true }, question: { type: 'string', required: true }, blocking: { type: 'boolean' } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).askParent(args))),
    }),
    answer,
    retry,
    defineTool({
      name: 'singularity_run_method',
      description: 'Run a Tool bound to this Task from its pinned method, optionally passing an existing workspace file by candidatePath.',
      parameters: { tool: { type: 'string', required: true }, candidatePath: { type: 'string' } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => {
            const surface = ctx.singularity.forCall(exec)
            return surface.runMethod({ ...args, taskId: surface.current() })
          }),
        ),
    }),
  ]
  const improve = [defineTool({
    name: 'singularity_propose_method',
    description: 'Admit 1–3 proposal JSON files from search.authoring.proposal when canPropose=true. Static refusal consumes no slots; admission freezes bytes and consumes slots even on failure. Returns screening immediately; end the turn.',
    parameters: { paths: { type: 'array', required: true, items: { type: 'string' } } }, output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).proposeMethod(args))),
  })]
  const rootSubmit = defineTool({
    name: 'singularity_submit',
    description: 'Submit a verified direct child Run’s sealed artifact for independent root acceptance.',
    parameters: { sourceTaskId: { type: 'string', required: true }, sourceRunId: { type: 'string', required: true } }, output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => {
      const surface = ctx.singularity.forCall(exec)
      return surface.submit({ taskId: surface.current(), ...args })
    })),
  })
  const tools = config.role === 'root' ? [common[0]!, common[1]!, rootSubmit, delegation, stopExplorations, answer, retry]
    : [...common, ...(config.role === 'review' ? [delegation, answer] : config.role === 'improve' ? improve : task)]
  const disposers = tools.map((tool) => ctx.tools.register(tool))
  if (config.role === 'root') {
    const allowed = new Set([...tools.map(tool => tool.name), 'read', 'read_image', 'glob', 'grep'])
    disposers.push(ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ allow: tools.map(tool => tool.name) })
      // Bubble tools are agent-owned, so native restrict() does not mask them.
      agent.ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Root delegates execution and file mutations to children')
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const prompt = await next()
        return { ...prompt, tools: prompt.tools.filter(tool => allowed.has(tool.name)),
          sections: prompt.sections.filter(section => !['tool:bash', 'tool:pwsh', 'tool:write', 'tool:edit'].includes(section.name)) }
      })
      return undefined
    }))
  }
  disposers.push(ctx.systemPrompt.section({ name: 'singularity:protocol', order: 60,
    text: guidanceFor(config.role),
    }),
  )
  ctx.effect(() => () => { for (const dispose of disposers) dispose() })
}

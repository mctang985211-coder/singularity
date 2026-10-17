import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { ProtocolRefusal } from '../../src/protocol/refusal.ts'
export const name = 'singularity-agent'
export const inject = ['singularity', 'tools', 'systemPrompt']
export interface Config { role: 'root' | 'task' | 'review' | 'improve'
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
export const taskGuidance = `Complete your frozen Task contract. Guidance, handoffs and memory cannot add requirements. Read contracts and state with singularity_read; methods and template examples are optional reads.
Use bounded investigation, then execute atomic work or delegate smaller responsibilities. Give children complete contracts, supports links and real dependencies. Mark indispensable acceptance dependencies required, alternatives and optional investigations exploration. Children may choose their own descendants. Do not strengthen acceptance or require exhaustive search.
Use the runtime responsibility snapshot to coordinate. Do not redo work a child owns. While waiting, answer questions, inspect evidence, stop unnecessary exploration and end the turn; branch outcomes resume this Run.
When the frozen criteria have enough evidence, stop further exploration and integrate accepted results. Required children must verify; cancellation is not verification. Write your declared artifact, then singularity_submit(path) for independent acceptance.`
export const rootGuidance = `You coordinate the frozen Task contract; guidance, handoffs and memory cannot add requirements. You must decompose into smaller responsibilities and delegate implementation, experiments and artifact integration to children.
Read contracts and state with singularity_read; methods and template examples are optional. Give each child a complete contract, supports links and real dependencies. Mark indispensable acceptance dependencies required, alternatives and optional investigations exploration. Children may choose their own descendants. Do not strengthen acceptance or require exhaustive search.
Use the runtime responsibility snapshot; do not redo delegated work. While waiting, inspect evidence, answer questions and end the turn; branch outcomes resume this Run. Once evidence meets the frozen criteria, stop unnecessary exploration. Required children must verify.
Submit a verified direct child's sealed artifact with singularity_submit(sourceTaskId, sourceRunId). Delegate integration if results need combining; the host copies the selected bytes and runs independent root acceptance.`
export const reviewGuidance = `Read your frozen assignment with singularity_read(kind=subject), following next byte pages until complete. Proposal and publication assignments judge methods and frozen measurements: there is no submitted-artifact and no execution or delegation. Use the subject and singularity_read evidence references, write review.json, then submit. Judge the frozen subject against every assigned criterion independently. Protected failed checks cannot become a pass. Optional guidance, handoffs and summaries cannot add acceptance requirements.
Use bounded evidence Tasks when useful; judge the subject yourself without repairing the subject. A disproved hypothesis may complete an investigation successfully. For decomposed work, inspect contribution references and their use in the final artifact, then check integration without repeating delegated investigations.
Write review.json with the supplied subjectDigest and one supported finding per criterion, then singularity_submit. An honest fail judgment completes the review; stop when the assigned questions are answered.`
const improvementGuidance = `Run evidence-driven RRSI method evolution. This is a fresh RSI session, isolated from every business solve and independent acceptance. Only RSI may query cross-round history and previous-RSI memory; those are working notes, never business evidence or a task answer.
Read singularity_read(kind=subject) with next byte pages until complete and singularity_read(kind=method) for the native proposal contract and TS analysis/proposal contract adapted from RRSI. Read history directories, usage, steps, event indexes and selected eventSeq pages on demand; singularity_memory exposes standardized previous-RSI notes. Do not search host files or ingest entire histories.
Analyze failure_modes, capability_gaps and success_habits; ground each in native events. Choose one independent mechanism, explain when it triggers, which observed tasks it should help, what success it preserves and why it transfers to an unfamiliar task. Neither deleting steps nor reducing tokens alone demonstrates learning. Improve reasoning, tool use, planning, delegation or verification when the evidence supports it.
Write a proposal JSON with analysis, edit and method, then call singularity_propose_method({path}). The runtime validates the declared diff and evidence, screens the declared mechanism and leakage risks, runs a cold isolated business solve, selects and independently reviews publication. Rejection returns objections for repair. Pending means end the turn; the same RSI session resumes with the committed outcome. Do not poll or execute business work.
Read the round outcome when resumed. No winner or rejected publication means revise and propose again; it cannot complete this RSI. After an approved winner is published, submit report.json citing measured results, preserved behavior, attribution limits and untested transfer. Do not claim domain generalization from repeated runs of one task.
Compare only one business root, delegated work and independent acceptance through submission. All RSI analysis, memory, proposals, screening, orchestration, reporting and publication usage NEVER enters any comparison.`

export function guidanceFor(purpose: string | undefined): string {
  return (purpose === 'root' ? rootGuidance : purpose === 'review' ? reviewGuidance : purpose === 'improve' ? improvementGuidance : taskGuidance) + '\nUse singularity_memory on demand for prepared background; summaries are working notes, not acceptance evidence.'
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
    skills: { type: 'array', items: { type: 'string' } },
    capabilities: { type: 'array', items: { type: 'string' } },
    inputs: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          source: {
            required: true,
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
      description:
        'summary lists related Tasks and sessions. task reads the contract and state. method reads pinned assets and evaluation rules. template lists declarations or, with ref=id, a prefilled contract. artifact ref=taskId reads sealed text (from/count bytes, default 16384, max 32768). trajectory ref=sessionId lists event metadata (from/count events, default 20, max 100). Add eventSeq to read that exact event as JSON text (from/count UTF-8 bytes, default 4096, max 8192); follow next until complete. Large event bodies are never in the index. subject reads your frozen review/RSI assignment as UTF-8 byte pages (default 4096, max 8192); follow next until complete. Other pages use from/count entries (default 20, max 100).' +
        (config.role === 'improve' ? ' History: roots lists closed rounds; sessions/usage/steps with rootId query those separately. Add rootId to trajectory for a historical session.' : ''),
      parameters: {
        kind: { type: 'string', enum: config.role === 'task' || config.role === 'root'
          ? ['summary', 'task', 'artifact', 'template', 'method', 'trajectory'] as const : config.role === 'improve'
            ? ['summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory', 'roots', 'sessions', 'usage', 'steps'] as const
            : ['summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory'] as const },
        ...(config.role === 'improve' ? { rootId: { type: 'string' as const } } : {}),
        ref: { type: 'string' },
        runId: { type: 'string' },
        eventSeq: { type: 'integer' },
        from: { type: 'integer' },
        count: { type: 'integer' },
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
      description: 'Without ref, list prepared background in your readable scope (from/count, default 20, max 100); inherited points to parent background or the previous RSI checkpoint. With ref, read structured decisions, evidence references, hypotheses, open questions and exclusions. Only RSI can inherit across explicitly linked campaign rounds. Reviews see only their own evidence branch. Reads never generate summaries; notes add no requirements or acceptance proof.',
      parameters: { ref: { type: 'string' }, from: { type: 'integer' }, count: { type: 'integer' } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).memory(args))),
    }),
    defineTool({
      name: 'singularity_submit',
      description:
        'Seal the final artifact already written in this workspace and submit it for independent acceptance. Reviewers submit review.json.',
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
    description:
      'Delegate smaller responsibilities with complete frozen contracts supporting parent criteria. template examples and authored Tasks use the same contract shape. Optional contract.template pins declaration provenance. dependsOn and artifact inputs may name batch keys or child IDs; verified bytes are materialized at inputs[].name. Returns at admission: end the turn while children work, then use their reviewed evidence when resumed.',
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
            dependsOn: { type: 'array', items: { type: 'string' }, required: true },
            supports: { type: 'array', items: { type: 'string' }, required: true },
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
      name: 'singularity_ask_parent', description: 'Ask the direct parent about undecidable scope or missing context. Recipient is host bound. blocking defaults to true: end the turn until an answer resolves it. Reuse requestKey and words on retry.',
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
    description: 'Submit a proposal JSON with analysis, edit and method (format from kind=method). The runtime validates evidence and declared changes, then applies the upstream critic before evaluation. Rejected returns reasons to repair. Pending returns a roundId: end the turn and read that round when resumed. Evaluation, selection and approved publication are automatic; RSI usage never enters cost.',
    parameters: { path: { type: 'string', required: true } }, output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).proposeMethod(args))),
  })]
  const rootSubmit = defineTool({
    name: 'singularity_submit',
    description: 'Submit the exact sealed artifact of a verified direct child Run for independent root acceptance. Delegate integration to a child when the results need combining.',
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

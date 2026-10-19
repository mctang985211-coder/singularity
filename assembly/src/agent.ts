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
export const taskGuidance = `Complete your frozen Task contract. Guidance, handoffs and memory cannot add requirements. Read relevant state, pinned methods and skills on demand.
Use bounded investigation to distinguish plausible causes, then execute atomic work or delegate a smaller responsibility. Refutation may satisfy an investigation; implementation still requires working behavior.
Give children complete contracts, supports links and real dependencies. Mark indispensable results required and alternatives exploration; leave their approach open. Use the responsibility snapshot. Do not redo work a child owns. While waiting, inspect evidence, answer questions or stop unnecessary exploration, then end the turn; outcomes resume this Run.
When evidence meets the criteria, stop exploring and integrate accepted results. Required children must verify; cancellation is not verification. Write the declared artifact, then singularity_submit(path) for independent acceptance. Report missing evidence honestly.`
export const rootGuidance = `Coordinate the frozen Task; guidance, handoffs and memory cannot add requirements. You must decompose and delegate implementation, experiments and integration. Use the fewest responsibilities covering the criteria; leave each child's approach open.
Read state and relevant method guidance on demand. Give children complete contracts, supports links and real dependencies. Mark indispensable results required and alternatives exploration. Delegate unresolved questions, not prescribed tool sequences.
Use the responsibility snapshot; do not redo delegated work. While waiting, inspect evidence, answer questions or append independent responsibilities when canPlan permits, then end the turn; outcomes resume this Run. Stop unnecessary exploration when evidence is sufficient. Required children must verify; child success does not establish parent acceptance.
Delegate integration only when needed. Submit a verified direct child's sealed artifact with singularity_submit(sourceTaskId, sourceRunId); the host copies its bytes for independent root acceptance.`
export const reviewGuidance = `Read the complete frozen subject with singularity_read(kind=subject), following next pages. Judge every criterion; guidance, handoffs and summaries cannot add acceptance requirements. Protected non-pass checks cannot become pass.
For acceptance, inspect the artifact, exact input producers and integration. Use bounded evidence Tasks to resolve judgment gaps, without repairing the subject or repeating established work. Refutation can satisfy an investigation, not a required implementation.
For proposal review, inspect the changed method, cited evidence and mechanism; plausibility is not measured transfer. For publication, judge frozen measurements and release criteria. These assignments have no submitted-artifact, execution or delegation: use the subject and readable evidence.
Fill the dispatch output.template: keep subjectDigest and every criterionId, choose pass/fail/partial/unknown, and support each finding. Write review.json, then singularity_submit. An honest fail or unknown judgment completes the review. Stop when the assigned questions are answered.`
const improvementGuidance = `Improve reusable workflow organization, skills and tools from frozen evidence. Do not solve or benchmark business tasks.
At start/resume/compaction, read singularity_read({kind:"method"}) without ref. Follow proposal.pending first: resume frozen batch paths or end the turn for evaluation. Otherwise use the current search head, nextRound, feedback, proposal.drafts and reportTemplate. Read kind=subject through complete=true; inspect selected trajectory events on demand. Summaries are hypotheses; use singularity_read for evidence, not host-file searches.
Analyze observed failures, gaps and success habits; unobserved lists stay empty. Choose one evidenced mechanism per candidate: trigger, affected Tasks/evolve IDs, correction, preservation, transfer and a refuting observation. Public domain knowledge with sources is allowed; keep task answers, identity branches, replayed patches and held-out data out of methods and business memory.
Use native edit on the host-written proposal.drafts paths; do not rewrite the complete Method. Fill real evidence, change only necessary method fields and declare the exact diff; retain unchanged assets. initial is forbidden in Method: frozen Task/Case source is supplied by the host. Root inputs/artifact/criteria/checks are read-only. Follow nextRound's remainingSlots/reservedSlot/pruneSlot; submit 1–3 paths with singularity_propose_method({paths}). Static refusal: correct the named field and resubmit, no slots consumed; identical retries or deleting unrelated fields cannot fix it. Admitted failures consume slots. Evaluation pending: end the turn, do not poll; resume from host feedback.
With no pending batch/evaluation, fill reportTemplate with known facts, missing measurements as null and attribution limits. Count calls, paths, admitted slots and rounds separately from actual records. Static refusal is not an exhausted experiment. Submit only report.json via singularity_submit({path:"report.json"}). This closes search; with a suite the host then runs private validation/publication after sealing. Do not wait for or predict results caused by submission. No improvement/insufficient evidence is valid; fewer nodes/tokens alone do not prove improvement.`

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
        'summary lists related Tasks and sessions; task reads contract/state. method reads method guidance and evaluation rules. template lists declarations or, with ref=id, a prefilled contract. artifact ref=taskId reads sealed text (from/count bytes, default 16384, max 32768). trajectory ref=sessionId lists event metadata (from/count events, default 20, max 100); copy its seq into eventSeq to read/cite that event (from/count UTF-8 bytes, default 4096, max 8192). subject pages the frozen review/RSI assignment (UTF-8 bytes, default 4096, max 8192). Follow next offsets until complete=true for text pages; an event index is not event evidence. Other pages use from/count entries (default 20, max 100).' +
        (config.role === 'root' || config.role === 'task' ? ' workflow pages relationship metadata in your root.' : '') +
        (config.role === 'improve' ? ' method without ref returns the current search head and proposal.pending: follow its frozen-batch resume or evaluation-wait instruction first. With nothing pending it prepares up to 3 editable JSON files in proposal.drafts (path,created); existing files are never overwritten. Use native edit on those paths, not a full rewrite. proposal.template is the canonical reference; Method has no initial source. Also returns reportTemplate, nextRound, feedback and evolve cases; re-read after each round. round ref=roundId reads committed measurements. roots lists closed roots; sessions/usage/steps with rootId query historical evidence. Add rootId to historical trajectory reads and citations.' : ''),
      parameters: {
        kind: { type: 'string', required: true, enum: config.role === 'task' || config.role === 'root'
          ? ['summary', 'workflow', 'task', 'artifact', 'template', 'method', 'trajectory'] as const : config.role === 'improve'
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
      description: config.role === 'improve'
        ? 'Submit only the final report.json already written in your workspace using kind=method reportTemplate. No batch/evaluation may be pending. This closes search; suite private validation/publication follows sealing. Report only facts known before submission. Proposal files go to singularity_propose_method.'
        : 'Seal the final artifact already written in this workspace for independent acceptance. Reviewers fill dispatch output.template and submit review.json.',
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
    description: 'First read kind=method without ref. If proposal.pending names a frozen batch, resume its exact paths without editing; if evaluation is pending, end the turn. Otherwise native edit 1–3 host-written proposal.drafts within nextRound.remainingSlots: fill real analysis/edit evidence and change only necessary method fields. Retain unchanged assets; never retype the full Method or include initial source. Root inputs/artifact/criteria/checks are frozen. Static refusal names file/field, admits no batch and consumes no slots: correct that draft and resubmit; do not delete unrelated fields or retry identical bytes. Admitted failures consume slots. status=pending means end the turn until host feedback. Only report.json uses singularity_submit.',
    parameters: { paths: { type: 'array', required: true, items: { type: 'string' } } }, output,
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

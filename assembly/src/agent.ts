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
export const taskGuidance = `Complete your frozen Task contract. Guidance, handoffs and memory cannot add requirements. Read the assigned inputs and relevant pinned method/skills.
Use bounded investigation, then execute atomic work or delegate a smaller responsibility with complete contracts, supports and dependencies. Required children must verify; alternatives are exploration. Do not redo work a child owns. While waiting, answer questions or stop unnecessary exploration, then end the turn; outcomes resume this Run.
Only your current workspace is writable; protected inputs and reference trees are read-only. Keep source copies, generated files and the declared artifact here. A patch target is not permission to write that host path. Exchange Task results through sealed artifacts and declared artifact inputs, which the host materializes in the consumer workspace; never rely on another Task's live files.
Build in /tmp within one shell invocation; each invocation discards that temporary filesystem. Preserve source, results and useful logs in your workspace, and remove compiler caches before submission.
If the contract needs unavailable inputs, private host checks or forbidden writes, use singularity_ask_parent and end the turn. Do not request escalation or bypass isolation. An answer cannot change the frozen contract.
When evidence meets the criteria, write the declared artifact and singularity_submit(path). The host seals its bytes and performs independent acceptance; do not duplicate host-only checks. Report missing evidence honestly.`
export const rootGuidance = `Coordinate the frozen Task; guidance, handoffs and memory cannot add requirements. Read its contract, inputs and relevant pinned method. You must decompose and delegate implementation, experiments and integration using the fewest responsibilities covering the criteria.
Give children complete contracts, supports and dependencies, leaving their approach open. Expose known independent responsibilities together; dependsOn expresses a real prerequisite, not a preferred order. Delegate only obligations they can discharge with their declared inputs and tools; host-owned template checks run after artifact sealing, not as child commands or extra child criteria. Each child writes only its own workspace; protected inputs and reference trees are read-only. A patch target is not a writable host path. Pass results through sealed artifacts and declared artifact inputs materialized by the host, never shared live files. Do not require children to mutate reference trees or run private host checks.
Use the responsibility snapshot; do not redo delegated work. Required children must verify; alternatives are exploration. While waiting, resolve child questions or plan independent work when canPlan permits, then end the turn; outcomes resume this Run. Answers cannot alter frozen contracts or grant extra permissions.
Select accepted results; delegate integration only when needed. Submit a verified direct child's sealed artifact with singularity_submit(sourceTaskId, sourceRunId). The host copies its bytes for independent root acceptance; child success alone is not parent acceptance.`
export const reviewGuidance = `Read the complete frozen subject with singularity_read(kind=subject), following next pages. Judge every criterion; guidance, handoffs and summaries cannot add acceptance requirements. Protected non-pass checks cannot become pass.
For acceptance, inspect sealed artifacts, exact input producers and integration. Resolve judgment gaps with bounded evidence Tasks, without repairing the subject or repeating established work. Copy protected input sources unchanged from dispatch.evidenceInputs; input.name selects the child's workspace path. Exchange results through sealed artifacts and declared inputs, never another Task's live files. Only your workspace is writable; protected inputs and reference trees are read-only. Do not request escalation or private host-check access; mark missing evidence honestly.
Proposal/publication reviews use only the frozen subject and readable evidence, with no execution or delegation. Judge the mechanism or frozen measurements; plausibility is not measured transfer.
Fill dispatch output.template: keep subjectDigest and every criterionId, choose pass/fail/partial/unknown with evidence. Write review.json, then singularity_submit(path). Honest fail/unknown completes the review; the host owns acceptance and publication.`
const improvementGuidance = `Improve the reusable method for future domain Tasks. The host owns screening, fresh business experiments and publication; you own evidence analysis and proposed edits.
Business roots only read, delegate and submit verified child artifacts. Keep commands, implementation and integration in delegated Tasks; reusable guidance must respect these roles.
Read singularity_read({kind:"search"}) at start and after host feedback. Its phase and next action are authoritative. During screening/evaluating/reporting, end the turn; never poll, repeat a pending proposal or run experiments yourself.
When ready, read the frozen subject through complete=true and selected native trajectory events. Read only relevant method assets with kind=method, from/count byte pages. Diagnose one observed mechanism and preserve evidenced successes. Propose a testable correction with an observable trigger, counterexample and transfer hypothesis. Keep task answers, task-keyed branches and held-out data out of reusable assets.
Read kind=search,ref=authoring pages for rules, then use search.authoring.proposal. Write analysis plus edit.changes with values; omitted assets/fields and frozen source stay unchanged. Cite real sessionId/eventSeq pages. predicted_affected names real affected Tasks in the cited workflow; predictions may include a downstream Task that never started. Bind new Skills/Tools to reachable Tasks. Follow nextRound constraints. Save 1–3 JSON files and call singularity_propose_method({paths}); admission returns immediately, then end the turn. Rejected drafts consume no slots; admitted outcomes do. Read kind=search,ref=feedback pages for exact objections before another proposal.
When no work is pending, you may finish honestly, including no improvement. Fill search.authoring.report with actual facts, null for missing measurements and untested transfer. Write report.json and singularity_submit({path:"report.json"}). Submission triggers any private validation; do not wait for or predict it. An accepted report is distinct from a measured improvement.`

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
        (config.role === 'review' ? ' Acceptance report evidence is frozen in subject.rsiEvidence: current-root/evolve trajectories and cited proposal pages. rootId may only select a root in that sealed evidence; arbitrary history is refused.' : '') +
        (config.role === 'improve' ? ' search returns current phase, next action, budget, evolve IDs and authoring templates. search ref=authoring pages proposal/report rules; ref=feedback pages detailed outcomes (UTF-8 bytes). method with from/count pages current assets (UTF-8 bytes). After proposing, end the turn; the host resumes screening/evaluation automatically. round ref=roundId reads committed measurements. roots lists closed roots; sessions/usage/steps with rootId query history. Add rootId to historical trajectory reads and citations.' : ''),
      parameters: {
        kind: { type: 'string', required: true, enum: config.role === 'task' || config.role === 'root'
          ? ['summary', 'workflow', 'task', 'artifact', 'template', 'method', 'trajectory'] as const : config.role === 'improve'
            ? ['search', 'summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory', 'roots', 'sessions', 'usage', 'steps'] as const
            : ['summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory'] as const },
        ...(config.role === 'improve' || config.role === 'review' ? { rootId: { type: 'string' as const } } : {}),
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
        ? 'Finish this search with report.json using kind=search authoring.report. Only phase=ready permits submission, including a negative result. Private validation/publication follows sealing. Report facts known before submission. Proposal files go to singularity_propose_method.'
        : config.role === 'review'
          ? 'Seal review.json from this workspace. Fill dispatch output.template with the exact subjectDigest and one supported finding for every criterion; missing evidence remains unknown.'
          : 'Seal the declared artifact already written in your current workspace for host independent acceptance. The host copies sealed bytes to authorized consumers; do not install outputs into reference trees or another Task workspace.',
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
      'Delegate complete frozen contracts supporting parent criteria. Copy protected source {kind,ref,digest} unchanged from the current contract/template or dispatch.evidenceInputs; never invent refs/digests or substitute file paths/attachment IDs. inputs[].name selects the child workspace path. Each child writes only its own workspace; reference trees and protected inputs stay read-only. Do not require writes to shared paths or private host checks. dependsOn and artifact inputs may name batch keys or child IDs; the host materializes verified sealed bytes. Optional contract.template pins provenance. On refusal, correct the named field and resubmit. On admission, end the turn while children work; outcomes resume you.',
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
      name: 'singularity_ask_parent', description: 'Ask the direct parent about missing inputs, undecidable scope or a contract requiring forbidden writes/private host checks. Do not request escalation or bypass isolation. Recipient is host bound; an answer cannot alter the frozen contract or grant permissions. blocking defaults to true: end the turn until resolved. Reuse requestKey and words on retry.',
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
    description: 'Admit 1–3 distinct workspace proposal JSON files when search.canPropose=true. Use search.authoring.proposal: analysis plus edit.changes with values. Omitted fields stay unchanged; null deletes. Static refusal consumes no slots. Admission freezes bytes and returns status=screening immediately; end the turn. The host screens, evaluates and resumes you automatically, including after restart. Admitted failures consume slots. Only report.json uses singularity_submit.',
    parameters: { paths: { type: 'array', required: true, items: { type: 'string' } } }, output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).proposeMethod(args))),
  })]
  const rootSubmit = defineTool({
    name: 'singularity_submit',
    description: 'Submit the exact sealed artifact of a verified direct child Run; the host copies its bytes for independent root acceptance. No shared path or root-written file is needed. Delegate integration only when results need combining.',
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

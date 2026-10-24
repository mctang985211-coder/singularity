import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { ProtocolRefusal } from '../../src/protocol/refusal.ts'
import { guidanceFor, type NodeRole } from './prompts.ts'
import { roleTools, sectionAllowed } from './tool-policy.ts'
export const name = 'singularity-agent'
export const inject = ['singularity', 'tools', 'systemPrompt']
export interface Config {
  role: NodeRole
}
export const Config = Schema.object({
  role: Schema.union([
    Schema.const('root'),
    Schema.const('task'),
    Schema.const('review'),
    Schema.const('improve'),
  ]).default('task'),
})
declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityAgentRole: Config['role']
  }
}
const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
async function attemptForRole<T>(role: NodeRole, step: () => Promise<T>) {
  try {
    return await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal)
      return {
        ok: false,
        refused: error.refusal.code,
        detail: error.refusal.detail,
        next:
          'Correct the named refusal before retrying; do not assume the action succeeded. ' +
          {
            root: 'Read summary/task to correct delegation within the frozen contract; no answer can grant new permissions.',
            task: 'For immutable-contract or permission conflicts, ask the direct parent instead of bypassing the boundary.',
            review:
              'Read the frozen subject and authorized evidence; report fail/partial or honest unknown when the criteria cannot be established.',
            improve:
              'Read search/feedback and correct the named proposal or report field within the remaining budget; pending work belongs to the host.',
          }[role],
      }
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
    skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional pinned Skill names; parent bindings are not inherited.',
    },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional pinned Skill capabilities or method Tool names; omit for native tools/public CLIs. Skills bind requiredTools.',
    },
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
            description:
              'Copy protected {kind,ref,digest} unchanged from the contract/template or dispatch.evidenceInputs. Artifact taskId may be a child ID or batch key; the host materializes verified sealed bytes.',
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
  const attempt = <T>(step: () => Promise<T>) => attemptForRole(config.role, step)
  const common = [
    defineTool({
      name: 'singularity_read',
      description:
        'Read authorized Task state, pinned assets or sealed evidence. Follow next until complete=true for text pages; trajectory indexes are metadata, not event evidence.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          description:
            'summary: responsibility/budget; task: contract/state; template: declarations/bindings or prefilled contract; method: pinned assets; artifact: sealed text; trajectory: native events.' +
            (config.role === 'improve'
              ? ' search: executionPhase/next/budget/authoring; round: measurements; roots/sessions/usage/steps: history.'
              : config.role === 'review'
                ? ' subject: frozen judgment assignment; round: sealed measurements.'
                : ' workflow: root relationships.'),
          enum:
            config.role === 'task' || config.role === 'root'
              ? (['summary', 'workflow', 'task', 'artifact', 'template', 'method', 'trajectory'] as const)
              : config.role === 'improve'
                ? ([
                    'search',
                    'summary',
                    'task',
                    'artifact',
                    'template',
                    'method',
                    'round',
                    'subject',
                    'trajectory',
                    'roots',
                    'sessions',
                    'usage',
                    'steps',
                  ] as const)
                : (['summary', 'task', 'artifact', 'template', 'method', 'round', 'subject', 'trajectory'] as const),
        },
        ...(config.role === 'improve' || config.role === 'review'
          ? {
              rootId: {
                type: 'string' as const,
                description:
                  config.role === 'improve'
                    ? 'Required for historical reads/citations.'
                    : 'Only a root named in the frozen evidence directory.',
              },
            }
          : {}),
        ref: {
          type: 'string',
          description:
            'task/artifact: taskId; template: templateId (omit to list); method: omit for the pinned method, or use its revisionId/digest; trajectory: sessionId (reviewers omit to list readable sessions/pages); round: roundId; search: authoring or feedback.',
        },
        runId: {
          type: 'string',
          description:
            'Select the exact authorized artifact Run. If omitted, artifact prefers verified, then latest sealed; sealed is not verified. Check returned status before reuse.',
        },
        eventSeq: { type: 'integer', description: 'Copy seq from a trajectory index to read/cite the actual event.' },
        from: { type: 'integer', description: 'Zero-based offset: UTF-8 bytes for text pages; entries for lists.' },
        count: {
          type: 'integer',
          description:
            'Lists: default 20/max 100. subject, search details, method and trajectory events: bytes, default 4096/max 8192. artifact: bytes, default 16384/max 32768.',
        },
        producers: {
          type: 'object',
          additionalProperties: true,
          description:
            'For template reads, map each input source templateId to a producer taskId or decomposition batch key.',
        },
      },
      output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).history(args))),
    }),
    defineTool({
      name: 'singularity_memory',
      description:
        config.role === 'root' || config.role === 'review'
          ? 'Read existing optional notes in your own scope; {} lists and {ref} reads without a model call. No parent background is prepared for root or reviewers; subject working narratives are outside reviewer scope.'
          : 'Read optional parent or linked previous-RSI notes when the contract and handoff omit useful rejected paths or open questions. {} only lists; {prepare:true} prepares at most once and returns the notes directly; {ref} reads. Notes are not requirements or proof: follow evidenceRefs to sealed evidence.',
      parameters: {
        ...(config.role === 'task' || config.role === 'improve'
          ? {
              prepare: {
                type: 'boolean' as const,
                description:
                  'Explicitly prepare and return inherited notes once; exclusive with ref/from/count. Failure is retained: continue without notes.',
              },
            }
          : {}),
        ref: { type: 'string', description: 'Checkpoint ID; mutually exclusive with pagination.' },
        from: { type: 'integer', description: 'Directory offset; default 0.' },
        count: { type: 'integer', description: 'Directory entries; default 20, max 100.' },
      },
      output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).memory(args))),
    }),
    defineTool({
      name: 'singularity_submit',
      description:
        config.role === 'improve'
          ? 'Seal report.json using search.authoring.report; requires executionPhase=ready. A negative result may finish the search. Private validation follows sealing.'
          : 'Submit either the declared workspace path or an exact verified direct-child Run (sourceTaskId/sourceRunId). Seals bytes and waits for independent parent acceptance; child verification alone never accepts the parent. Delegate an integration child with declared artifact inputs when combining results.',
      parameters:
        config.role === 'task'
          ? {
              path: {
                type: 'string',
                description:
                  'Copy assigned.contract.artifact exactly. Submit that declared file for independent acceptance; do not substitute another output path. Exclusive with sourceTaskId/sourceRunId.',
              },
              sourceTaskId: {
                type: 'string',
                description:
                  'Verified direct child ID from summary.coordination.responsibility.delegated. Supply sourceRunId and omit path; the host copies sealed bytes.',
              },
              sourceRunId: {
                type: 'string',
                description: 'Exact verified Run of sourceTaskId. Parent acceptance remains independent.',
              },
            }
          : { path: { type: 'string', required: true } },
      output,
      execute: async (args, exec) =>
        JSON.stringify(
          await attempt(() => {
            const surface = ctx.singularity.forCall(exec)
            return surface.submit({ taskId: surface.current(), ...args } as import('./submission.ts').SubmissionInput)
          }),
        ),
    }),
  ]
  const delegation = defineTool({
    name: 'singularity_decompose_task',
    description:
      'Delegate smaller complete responsibilities with a real coordination benefit, before major implementation. Each child adds execution, independent acceptance and coordination cost to the shared budget. All unsettled children, including exploration, pause parent execution. Collect or cancel background jobs first. Parent bindings are not inherited. After opened, end the turn; the host resumes you. Correct named refusals before resubmission.',
    parameters: {
      children: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: {
              type: 'string',
              required: true,
              description:
                'Stable child identity; after uncertain delivery retry only the same key and immutable declaration.',
            },
            contract,
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description:
                'Real prerequisites among direct children: IDs or batch keys. Reuse external verified artifacts through contract.inputs.',
            },
            supports: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description:
                'Parent criterionIds this responsibility contributes to; contribution is not automatic parent acceptance.',
            },
            maxRuns: {
              type: 'integer',
              required: true,
              description: 'Fixed maximum attempts for this child contract; not an experiment quota to exhaust.',
            },
            requirement: {
              type: 'string',
              required: true,
              enum: config.role === 'review' ? (['required'] as const) : (['required', 'exploration'] as const),
              description:
                'required: indispensable dependency which must verify; exploration: optional alternative which the parent may stop.',
            },
            handoff: {
              type: 'object',
              additionalProperties: false,
              properties: {
                decisions: {
                  type: 'array',
                  items: { type: 'string' },
                  required: true,
                  description: 'Relevant decisions; all task requirements belong in the contract.',
                },
                hypotheses: {
                  type: 'array',
                  items: { type: 'string' },
                  required: true,
                  description: 'Unverified claims for this child to investigate.',
                },
                exclusions: {
                  type: 'array',
                  items: { type: 'string' },
                  required: true,
                  description: 'Relevant rejected paths and scope exclusions.',
                },
                evidence: {
                  type: 'array',
                  items: { type: 'string' },
                  required: true,
                  description: 'Verified visible Task IDs to reuse.',
                },
              },
            },
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
    name: 'singularity_answer',
    description:
      'Answer a direct child question. resolves:true is the final answer and releases that question; false supplements it and leaves it open. Change requestKey for each new answer version; reuse the same key/content only after uncertain delivery. Answers cannot change contracts or permissions.',
    parameters: {
      questionId: { type: 'string', required: true },
      requestKey: { type: 'string', required: true },
      answer: { type: 'string', required: true },
      resolves: { type: 'boolean', required: true },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Verified Task references the child may now read and reuse.',
      },
    },
    output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).answer(args))),
  })
  const retry = defineTool({
    name: 'singularity_retry_task',
    description:
      'Retry your own failed Run under the same contract, Method and fixed attempt budget. Read task findings first, correct the cause, then continue with the returned Run; no new Task ID is needed.',
    parameters: {},
    output,
    execute: async (_args, exec) =>
      JSON.stringify(
        await attempt(() => {
          const surface = ctx.singularity.forCall(exec)
          return surface.retry({ taskId: surface.current() })
        }),
      ),
  })
  const stopExplorations = defineTool({
    name: 'singularity_stop_explorations',
    description:
      'Stop direct exploration branches and their descendants when evidence is sufficient or an alternative is no longer useful. Cannot stop required responsibilities or dependencies still needed by active branches. Cancellation preserves history and does not certify results. Available while children are pending.',
    parameters: {
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          'Direct exploration IDs from summary.coordination.responsibility.activeExploration. Read summary after stopping to select verified evidence or submit.',
      },
      reason: { type: 'string', required: true },
      requestKey: {
        type: 'string',
        required: true,
        description: 'Stable key; repeat the same key and content after uncertain delivery.',
      },
    },
    output,
    execute: async (args, exec) =>
      JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).stopExplorations(args))),
  })
  const task = [
    stopExplorations,
    delegation,
    defineTool({
      name: 'singularity_ask_parent',
      description:
        'Ask the direct parent when required inputs are missing/inconsistent, obligations conflict with read-only paths, or a required capability is still unavailable after one corrected refusal. Do not ask for routine debugging, technical choices or new permissions. blocking defaults to true: end the turn; the host resumes you with the answer. Reuse key/content only after uncertain delivery.',
      parameters: {
        requestKey: { type: 'string', required: true },
        question: { type: 'string', required: true },
        blocking: { type: 'boolean' },
      },
      output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).askParent(args))),
    }),
    answer,
    retry,
    defineTool({
      name: 'singularity_run_method',
      description:
        'Run a bound Tool using method.tools description/call/candidatePath. The returned artifact is stdout text, not a sealed file or acceptance proof. Native tools and public CLIs need no Method binding.',
      parameters: { tool: { type: 'string', required: true }, candidatePath: { type: 'string' } },
      output,
      execute: async (args, exec) =>
        JSON.stringify(
          await attempt(() => {
            const surface = ctx.singularity.forCall(exec)
            return surface.runMethod({ ...args, taskId: surface.current() })
          }),
        ),
    }),
  ]
  const improve = [
    defineTool({
      name: 'singularity_propose_method',
      description:
        'Admit 1–3 proposal JSON files using search ref=authoring templates when canPropose=true. Static refusal consumes no slots; admission freezes bytes and consumes slots even on failure. Returns screening immediately; end the turn.',
      parameters: { paths: { type: 'array', required: true, items: { type: 'string' } } },
      output,
      execute: async (args, exec) =>
        JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).proposeMethod(args))),
    }),
  ]
  const rootSubmit = defineTool({
    name: 'singularity_submit',
    description: 'Submit a verified direct child Run’s sealed artifact for independent root acceptance.',
    parameters: { sourceTaskId: { type: 'string', required: true }, sourceRunId: { type: 'string', required: true } },
    output,
    execute: async (args, exec) =>
      JSON.stringify(
        await attempt(() => {
          const surface = ctx.singularity.forCall(exec)
          return surface.submit({ taskId: surface.current(), ...args })
        }),
      ),
  })
  const reviewSubmit = defineTool({
    name: 'singularity_submit',
    description:
      'Submit one judgment per frozen criterion. The host supplies the subject binding, identities and digests; only findings are accepted.',
    parameters: {
      findings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterionId: { type: 'string', required: true },
            verdict: { type: 'string', required: true, enum: ['pass', 'fail', 'partial', 'unknown'] as const },
            detail: { type: 'string', required: true },
            evidence: {
              type: 'array',
              required: true,
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      sessionId: { type: 'string', required: true },
                      eventSeq: { type: 'integer', required: true },
                      rootId: { type: 'string' },
                      from: { type: 'integer' },
                      count: { type: 'integer' },
                    },
                  },
                ],
              },
              description:
                'Subject/file references, or native event pages {sessionId,eventSeq,rootId?,from?,count?}; structured pages are checked against the frozen readable scope. A pass needs evidence or a passing protected check; empty evidence supports no semantic success claim.',
            },
          },
        },
      },
    },
    output,
    execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).submit(args))),
  })
  // DSH's per-property helper uses an open root; review bindings are host-only.
  reviewSubmit.parameters.additionalProperties = false
  rootSubmit.parameters.additionalProperties = false
  common[2]!.parameters.additionalProperties = false
  common[1]!.parameters.additionalProperties = false
  const tools =
    config.role === 'root'
      ? [common[0]!, common[1]!, rootSubmit, delegation, stopExplorations, answer, retry]
      : config.role === 'review'
        ? [common[0]!, common[1]!, reviewSubmit, delegation, answer]
        : [...common, ...(config.role === 'improve' ? improve : task)]
  const disposers = tools.map(tool => ctx.tools.register(tool))
  {
    const allowed = roleTools[config.role]
    disposers.push(
      ctx.on('agent/created', ({ agent }) => {
        if (config.role === 'root') agent.ctx.tools.restrict({ allow: tools.map(tool => tool.name) })
        // Bubble tools are agent-owned, so native restrict() does not mask them.
        agent.ctx.tools.guard(exec =>
          allowed.has(exec.name)
            ? undefined
            : config.role === 'root'
              ? 'Root delegates execution and file mutations to children'
              : 'Tool is outside the frozen Singularity role policy',
        )
        agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const prompt = await next()
          return {
            ...prompt,
            tools: prompt.tools.filter(tool => allowed.has(tool.name)),
            sections: prompt.sections.filter(section => sectionAllowed(section.name, allowed)),
          }
        })
        return undefined
      }),
    )
  }
  disposers.push(ctx.systemPrompt.section({ name: 'singularity:protocol', order: 60, text: guidanceFor(config.role) }))
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}

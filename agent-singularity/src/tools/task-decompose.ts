import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { ChildOutcome, DecomposeSpec } from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_decompose: missing agent id')
  return id
}

function renderOutcome(outcome: ChildOutcome): string {
  const run = outcome.runId === undefined ? '' : ` run ${outcome.runId}`
  const evidence = outcome.evidenceId === undefined ? '' : ` evidence ${outcome.evidenceId}`
  return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`
}

export function defineTaskDecomposeTool(ctx: Context) {
  return defineTool({
    name: 'task_decompose',
    description:
      'Decompose the caller\'s current task into child tasks, then run them one at a time in dependency order. ' +
      'Each child is verified independently; only verified children count as done.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why this delegation is needed; recorded in each child handoff' },
      contractVersion: {
        type: 'integer',
        description:
          'Contract version this batch is written under. The runtime stores version 1 and refuses a declared version it does not know, ' +
          'so callers normally omit this field and let the runtime write the current version',
      },
      children: {
        type: 'array',
        required: true,
        description: 'Child tasks to admit and run',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            objective: { type: 'string', required: true, description: 'Complete, self-contained goal of the child task' },
            acceptanceCriteria: {
              type: 'array',
              required: true,
              description: 'How a verifier decides the child is done',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  description: { type: 'string', required: true, description: 'What must hold true' },
                  criterionId: {
                    type: 'string',
                    description:
                      'Stable id for this criterion: fixed at admission, and the only id a parent-level childEvidence.criterionId can rely on. ' +
                      'Omitted, the runtime generates one from the batch position; declared ids must be unique inside a child. ' +
                      'A parent-level childEvidence.criterionId must name an id the child it points to actually declared, ' +
                      'which only holds when that child declares the id explicitly here',
                  },
                  command: { type: 'string', description: 'Shell command; exit code 0 proves the criterion (deterministic modes)' },
                  mode: {
                    type: 'string',
                    enum: ['deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite'],
                    description: 'Verifier kind; defaults to deterministic when a command is given, review otherwise',
                  },
                  mandatory: { type: 'boolean', description: 'Whether the criterion must pass; default true' },
                  requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence kinds the verifier must attach' },
                  requiresArtifact: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product (a verified run carrying a passing verdict) for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation',
                  },
                  acceptsArtifact: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state. Missing blocks the child before spawn and registers an obligation',
                  },
                  verifierRef: {
                    type: 'string',
                    description: 'Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode.',
                  },
                  childEvidence: {
                    type: 'array',
                    description: 'Parent-level evidence map (composite mode only): which child of this decomposition batch — by 0-based position — this criterion rests on, optionally narrowed to a child criterion and an evidence reference. Judged at parent-acceptance time; an incomplete mapping fails the parent naming the missing items',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        childIndex: { type: 'integer', required: true, description: '0-based position of the child in this decomposition batch' },
                        criterionId: { type: 'string', description: 'The child criterion whose passing verdict is required' },
                        evidenceRef: { type: 'string', description: 'The evidence id, artifact kind, or artifact id that must exist in the child\'s verified run evidence' },
                      },
                    },
                  },
                  heuristic: {
                    type: 'boolean',
                    description: 'Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass. Mutually exclusive with childEvidence',
                  },
                  protectedInputs: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. ' +
                      'Declare them as paths relative to the task\'s checkout (an absolute path stays absolute). Admission resolves each one against the session\'s checkout and fixes the SHA-256 of its bytes ' +
                      'before the contract is written — a path that cannot be read refuses the whole batch, and no protected input is ever stored as a bare path. ' +
                      'The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed. ' +
                      'Only declared paths are protected: a criterion that lists none is not protected and nothing is checked or claimed for it.',
                  },
                },
              },
            },
            requiredCapabilities: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Capability names the child needs; call capability_list first to see the names the runtime can grant — ' +
                'an unlisted name is a capability gap that rejects the whole batch unless the child is declared decomposable',
            },
            dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Indices of sibling children that must verify before this one starts' },
            assumptions: {
              type: 'array',
              items: { type: 'string' },
              description: 'External conditions this child\'s contract rests on; merged with dependency-evidence references into the worker handoff',
            },
            constraints: {
              type: 'array',
              items: { type: 'string' },
              description: 'Execution scope and limits this child runs under; persisted in the child\'s contract and handed to its worker',
            },
            decomposable: {
              type: 'boolean',
              description: 'Declare that this child should split further instead of doing the work: its worker is told to call task_decompose. Together with a capability gap this decides whether the child is admitted as decomposable.',
            },
            requiresIndependentAcceptance: {
              type: 'boolean',
              description: 'Contract-level marker: this child demands independent parent acceptance — at least one of its acceptance criteria must carry a childEvidence map, or admission refuses the batch. Deleting the map never silently degrades acceptance back to the all-children-verified conjunction',
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller)
      let outcomes: ChildOutcome[]
      try {
        outcomes = await ctx.taskRuntime.decomposeAndRun(
          storeId,
          task.taskId,
          run.runId,
          caller,
          // The caller's whole spec goes to the runtime, which is the contract
          // entry for it (T1 §4). The schema above validates the *declared
          // surface* only: the types, the mode enum, and the closed child and
          // criterion objects. Its parameter root is an implicitly open object,
          // so a batch-level key this tool does not declare passes the schema
          // and is refused by the runtime, by name — never dropped here, never
          // accepted in silence. The cast is the seam where model arguments
          // become the runtime's input; what makes it harmless is that nothing
          // here reads the object first.
          args as unknown as DecomposeSpec,
          { signal: exec.signal },
        )
      } catch (error) {
        return `task_decompose rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      return [`decomposed ${task.taskId} into ${outcomes.length} children:`, ...outcomes.map(renderOutcome)].join('\n')
    },
  })
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { DecomposeSpec, ProposalContinuation, ProposalSubmission } from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_decompose: missing agent id')
  return id
}

export function defineTaskDecomposeTool(ctx: Context) {
  return defineTool({
    name: 'task_decompose',
    description:
      'Decompose the caller\'s current task into child tasks. The batch is admitted atomically and the runtime then runs them ' +
      'one at a time in dependency order; this call returns at admission and does not wait. Each child is verified ' +
      'independently; only verified children count as done. Where this deployment reviews generated tasks, the batch may instead ' +
      'come back waiting for a human review — nothing is admitted or spawned then, and the answer names the proposal that holds it.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why this delegation is needed; recorded in each child handoff' },
      contractVersion: {
        type: 'integer',
        description:
          'Contract version this batch is written under. The runtime stores version 1 and refuses a declared version it does not know, ' +
          'so callers normally omit this field and let the runtime write the current version',
      },
      requestKey: {
        type: 'string',
        description:
          'The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime ' +
          'derives one from the calling context and the batch content when this is omitted). One key names at most one proposal: repeating a ' +
          'request with the same key is answered with the proposal already stored, while the same key with different content is refused. A ' +
          'revision is different content, so it needs a new key',
      },
      supersedes: {
        type: 'string',
        description:
          'The proposal id this batch revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the ' +
          'history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the ' +
          'new request key this submission needs',
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
      // The two service entries the compat entry `decomposeAndRun` composes, in
      // the same order and with the same meanings (T2/T3 §6: 内部先提出提案，再按
      // 策略推进). This tool composes them itself because the caller's own
      // requestKey/supersedes have to reach the *submission*, and the service
      // entry that does both takes no options. Every check stays in the runtime:
      // nothing is normalized, judged or admitted here.
      //
      // The caller's whole spec goes to the runtime, which is the contract entry
      // for it (T1 §4). The schema above validates the *declared surface* only:
      // the types, the mode enum, and the closed child and criterion objects.
      // Its parameter root is an implicitly open object, so a batch-level key
      // this tool does not declare passes the schema and is refused by the
      // runtime, by name — never dropped here, never accepted in silence. The
      // cast is the seam where model arguments become the runtime's input; what
      // makes it harmless is that nothing here reads the object first.
      //
      // The two keys this tool *does* declare are lifted out of the batch: they
      // are options of the submission, not batch fields, and passing them along
      // inside the spec would make the runtime refuse them by name.
      const { requestKey, supersedes, ...spec } = args
      const callId = typeof exec.callId === 'string' && exec.callId.length > 0 ? String(exec.callId) : undefined
      let submission: ProposalSubmission
      let continued: ProposalContinuation
      try {
        submission = await ctx.taskRuntime.submitDecompositionProposal(
          storeId,
          task.taskId,
          run.runId,
          caller,
          spec as unknown as DecomposeSpec,
          {
            ...(requestKey === undefined ? {} : { requestKey: String(requestKey) }),
            ...(supersedes === undefined ? {} : { supersedes: String(supersedes) }),
            exec: {
              signal: exec.signal,
              // The registration id of this call, so the batch's first drain
              // does not wait for the call that is asking (A3 §3.3). A caller
              // without one — a test double — drains without the exclusion.
              ...(callId === undefined ? {} : { callId }),
            },
          },
        )
        // The submission's own signal dies with it: a call that returns, or a
        // caller that aborts after the record exists, cannot stop a batch the
        // store already holds (§3.7) — so only the call id rides along.
        continued = await ctx.taskRuntime.continueProposal(storeId, submission.proposalId, caller, {
          ...(callId === undefined ? {} : { exec: { callId } }),
        })
      } catch (error) {
        return `task_decompose rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      if (continued.status === 'admitted') {
        return admittedText(task.taskId, continued.batchId, continued.childTaskIds)
      }
      if (continued.status === 'pending_review') {
        return await pendingText(ctx, storeId, task.taskId, continued.proposalId, continued.detail)
      }
      if (continued.status === 'activated') {
        // A root contract continued through this tool's service entry: no batch
        // was proposed, nothing was decomposed and no child exists, so the two
        // arms above do not apply and neither does the refusal text below. The
        // ids are reported as the runtime gave them — a caller that reads
        // "activated" as "decomposed" would go looking for children.
        return [
          `task_decompose: proposal ${continued.proposalId} activated root task ${continued.taskId} with run ${continued.runId} instead of admitting a batch.`,
          `- ${continued.detail}`,
          '- This is a root contract, not a decomposition: no child task exists and this task is not decomposed. Read the root',
          '  contract with `task_read` and decompose it with `task_decompose` once it is the root task you are working on.',
        ].join('\n')
      }
      // Decided against between the submission and the continuation, or
      // invalidated by the re-check: the status the store holds, named, with the
      // one way forward (a revision) — the same conclusion the compat entry
      // raises, reported instead of thrown so the caller keeps the diagnosis.
      return [
        `task_decompose rejected: decomposition of "${task.taskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}${continued.reason === undefined ? '' : ` — ${continued.reason}`}`,
        'A rejected, cancelled, stale or expired batch never runs: revise it (a revision is new content, a new request key and a',
        'new proposal) or do the work in this task instead. Nothing was admitted and nothing was spawned.',
      ].join('\n')
    },
  })
}

/**
 * The batch is admitted, not finished (A3 §3.1): the call returns as soon as the
 * atomic commit landed, and the runtime drives the children from there. What the
 * caller may do next is not a matter of taste — the phase it is in decides it —
 * so the tool states the contract it is now under rather than leaving the model
 * to infer it from a status line.
 */
function admittedText(taskId: string, batchId: string, childTaskIds: readonly string[]): string {
  return [
    `decomposed ${taskId} into ${childTaskIds.length} children (batch ${batchId}):`,
    ...childTaskIds.map((childTaskId, index) => `- child ${index + 1}: ${childTaskId}`),
    '',
    `The runtime owns batch ${batchId} now: it starts the children one at a time in dependency order and settles this ` +
    'task when they are all terminal. This call returns at admission and does not wait for the batch.',
    `You are in phase waiting_children: read and query with \`task_read\`/\`task_status\` (and diagnose or inspect), or end the ` +
    'batch with `task_cancel`. Writes, shell commands, another decomposition and a submission of your own are refused while the ' +
    'children run — do not start work that would collide with theirs in the shared checkout.',
    'You are notified when the batch settles; the runtime then submits this task for verification on your behalf, so an idle ' +
    'session is not a completion and needs no submission from you.',
  ].join('\n')
}

/**
 * A batch waiting for a human review (T2/T3 §5–§6): the proposal holds the
 * whole batch, nothing was admitted, and the caller's next move is not another
 * submission — the same request answers with this same proposal. The policy is
 * read back from the proposal rather than assumed, because a proposal born under
 * `off` and sent to review by a tightened deployment keeps its birth policy on
 * the record; when the record cannot be read the text says so instead of
 * inventing one.
 */
async function pendingText(
  ctx: Context,
  storeId: string,
  taskId: string,
  proposalId: string,
  detail: string,
): Promise<string> {
  let policy = 'unknown — the proposal record could not be read back'
  try {
    policy = `${(await ctx.taskRuntime.proposalIn(storeId, proposalId)).policy}`
  } catch {
    // The batch is recorded and waiting either way; only this rendering is thin.
  }
  return [
    `task_decompose is waiting for a review: proposal ${proposalId} (policy ${policy}) holds this batch, and ${taskId} has not been decomposed.`,
    `- ${detail}`,
    '- No child task exists, no worker was spawned, and this task is not decomposed: the batch is admitted only after the review',
    '  decides and the runtime re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.',
    `- Read the batch as it was recorded with \`task_proposal_read\` (${proposalId}).`,
    '- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime continues the batch',
    '  immediately, so you are notified when it settles.',
    '- A refusal is a fact on the record: revise the batch against its reason (fix the cause, never weaken a criterion or drop a',
    '  mandatory one) and call `task_decompose` again — a revision is new content, hence a new proposal, and you may name the',
    '  refused one with `supersedes`.',
    '- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.',
  ].join('\n')
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { DecomposeSpec, ProposalContinuation, ProposalSubmission } from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text } from '../shared.ts'
import { templateBindingParameters } from './task-template-list.ts'
import { criterionSchema } from './criteria-schema.ts'
import { pendingReviewText, proposalSubmissionParameters } from './proposal-shared.ts'

export function defineTaskDecomposeTool(ctx: Context) {
  return defineTool({
    name: 'task_decompose',
    description:
      'Delegate the caller\'s current task\'s independently checkable results or distinct responsibilities to child tasks. ' +
      'Call task_template_list first; use a suitable pinned template and parameters, or write a full standard contract when none applies. ' +
      'Each caller owns its full result and may coordinate children that decompose again; define only this level and let each child decide its descendants. ' +
      'The batch is admitted atomically and the runtime then runs them ' +
      'one at a time in dependency order; this call returns at admission and does not wait. Each child is verified ' +
      'against its own delivered result; this does not require a new checker or duplicate criteria. Only verified children count as done. Where this deployment reviews generated tasks, the batch may instead ' +
      'come back waiting for a human review — nothing is admitted or spawned then, and the answer names the proposal that holds it.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why this delegation is needed; recorded in each child handoff' },
      ...proposalSubmissionParameters({
        versionSubject: 'batch',
        revisionSubject: 'batch',
        derivation: 'the calling context and the batch content',
      }),
      children: {
        type: 'array',
        required: true,
        description: 'Child tasks to admit and run',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...templateBindingParameters,
            objective: { type: 'string', description: 'Complete, self-contained goal of the child task' },
            acceptanceCriteria: {
              type: 'array',
              description: 'Required for a free contract; omit when using templateRef. How a verifier decides the child is done',
              items: criterionSchema({
                description: 'What must hold true',
                criterionId:
                  'Stable id for this criterion: fixed at admission, and the only id a parent-level childEvidence.criterionId can rely on. ' +
                  'Omitted, the runtime generates one from the batch position; declared ids must be unique inside a child. ' +
                  'A parent-level childEvidence.criterionId must name an id the child it points to actually declared, ' +
                  'which only holds when that child declares the id explicitly here',
                command: 'Shell command; exit code 0 proves the criterion (deterministic modes). Reuse an authoritative checker that already covers this result; do not duplicate its assertions',
                mode: 'Verifier kind; defaults to deterministic with a command. Mandatory review/formal criteria require an explicit registered verifier that can settle them; the built-in review placeholder is refused.',
                requiresArtifact: 'Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product (a verified run carrying a passing verdict) for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation',
                acceptsArtifact: 'Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state. Missing blocks the child before spawn and registers an obligation',
                verifierRef: 'Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode.',
                childEvidence: 'Parent-level evidence map (composite mode only): which member of this run — by 0-based position in the run\'s accumulated members, every batch it admits in admission order — this criterion rests on, optionally narrowed to a child criterion and an evidence reference. Judged at parent-acceptance time; an incomplete mapping fails the parent naming the missing items',
                heuristic: 'Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass. Mutually exclusive with childEvidence',
                protectedInputs:
                  'Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. ' +
                  'Declare them as paths relative to the task\'s checkout (an absolute path stays absolute). Admission resolves each one against the session\'s checkout and fixes the SHA-256 of its bytes ' +
                  'before the contract is written — a path that cannot be read refuses the whole batch, and no protected input is ever stored as a bare path. ' +
                  'The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed. ' +
                  'Only declared paths are protected: a criterion that lists none is not protected and nothing is checked or claimed for it.',
              }),
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
              description: 'Mark true when the child owns multiple independently checkable results or distinct responsibilities. Its worker coordinates those results and decides its own decomposition before implementation; do not prewrite descendants or reduce its full acceptance. A genuinely local result can be completed directly. A capability gap also uses this marker for admission, but it grants no missing capability.',
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
      const caller = sessionId(exec, 'task_decompose')
      const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller)
      // The two service entries the compat entry `decomposeAndRun` composes, in
      // the same order and with the same meanings (T2/T3 §6: 内部先提出提案，再按
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
              ...(callId === undefined ? {} : { callId }),
            },
          },
        )
        // The submission's own signal dies with it: a call that returns, or a
        // caller that aborts after the record exists, cannot stop a batch the
        continued = await ctx.taskRuntime.continueProposal(storeId, submission.proposalId, caller, {
          ...(callId === undefined ? {} : { exec: { callId } }),
        })
      } catch (error) {
        return `task_decompose rejected: ${message(error)}`
      }
      if (continued.status === 'admitted') {
        return admittedText(task.taskId, continued.batchId, continued.childTaskIds)
      }
      if (continued.status === 'pending_review') {
        return await pendingReviewText({
          ctx,
          storeId,
          proposalId: continued.proposalId,
          detail: continued.detail,
          tool: 'task_decompose',
          holding: `this batch, and ${task.taskId} has not been decomposed`,
          lines: [
            '- No child task exists, no worker was spawned, and this task is not decomposed: the batch is admitted only after the review',
            '  decides and the runtime re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.',
            `- Read the batch as it was recorded with \`task_proposal_read\` (${continued.proposalId}).`,
            '- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime continues the batch',
            '  immediately, so you are notified when it settles.',
            '- A refusal is a fact on the record: revise the batch against its reason (fix the cause, never weaken a criterion or drop a',
            '  mandatory one) and call `task_decompose` again — a revision is new content, hence a new proposal, and you may name the',
            '  refused one with `supersedes`.',
            '- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.',
          ],
        })
      }
      if (continued.status === 'activated') {
        // A root contract continued through this tool's service entry: no batch
        // was proposed, nothing was decomposed and no child exists, so the two
        return [
          `task_decompose: proposal ${continued.proposalId} activated root task ${continued.taskId} with run ${continued.runId} instead of admitting a batch.`,
          `- ${continued.detail}`,
          '- This is a root contract, not a decomposition: no child task exists and this task is not decomposed. Read the root',
          '  contract with `task_read` and decompose it with `task_decompose` once it is the root task you are working on.',
        ].join('\n')
      }
      // Decided against between the submission and the continuation, or
      // invalidated by the re-check: the status the store holds, named, with the
      return [
        `task_decompose rejected: decomposition of "${task.taskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}${continued.reason === undefined ? '' : ` — ${continued.reason}`}`,
        'A rejected, cancelled, stale or expired batch never runs: revise it (a revision is new content, a new request key and a',
        'new proposal) or do the work in this task instead. Nothing was admitted and nothing was spawned.',
      ].join('\n')
    },
  })
}

/** The batch is admitted, not finished (A3 §3.1): the call returns as soon as the atomic commit landed, and the runtime drives the children from there. */
function admittedText(taskId: string, batchId: string, childTaskIds: readonly string[]): string {
  return [
    `decomposed ${taskId} into ${childTaskIds.length} children (batch ${batchId}):`,
    ...childTaskIds.map((childTaskId, index) => `- child ${index + 1}: ${childTaskId}`),
    '',
    `The runtime owns batch ${batchId} now: it starts the children one at a time in dependency order and drives the batch to ` +
    'its end. This call returns at admission and does not wait for the batch.',
    `You are in phase waiting_children: read and query with \`task_read\`/\`task_status\` (and diagnose or inspect), or end the ` +
    'run together with its batch with `task_cancel` if abandoning this run. ' +
    'Writes, shell commands, another decomposition and a submission of your own are refused while the ' +
    'children run — do not start work that would collide with theirs in the shared checkout.',
    'The batch end reaches you as a message naming each child\'s terminal state and evidence, and it hands your execution back: ' +
    'nothing is submitted on your behalf. Back in phase active you continue your own work, admit another batch with ' +
    '`task_decompose`, or hand this task in yourself with `task_submit_result` — only that submission starts its acceptance.',
  ].join('\n')
}


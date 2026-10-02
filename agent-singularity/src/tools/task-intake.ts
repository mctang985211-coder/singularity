import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-context'
import type { RootContractSpec, RootIntakeResult } from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text } from '../shared.ts'
import { templateBindingParameters } from './task-template-list.ts'
import { criterionSchema } from './criteria-schema.ts'
import { pendingReviewText, proposalSubmissionParameters } from './proposal-shared.ts'

/** The root contract intake (A0 §3 stage C): the one tool that turns a user's objective into the graph's root task, and the root session's own action — a worker has a task already and cannot intake one (`task_intake` is in */
export function defineTaskIntakeTool(ctx: Context) {
  return defineTool({
    name: 'task_intake',
    description:
      'Call task_template_list first; bind a suitable pinned template, or write a full standard contract when none applies. ' +
      'Accept this root session\'s contract: the objective the graph works toward, the acceptance criteria a verifier will judge it by, ' +
      'the assumptions and constraints it rests on and the capabilities the work needs. Only the root session of a graph may call this — ' +
      'the contract becomes that session\'s root task, and a worker\'s task was admitted by its parent already. The runtime also checks ' +
      'where the contract came from: only a message DSH attests as human input counts, so a session whose own log holds none of the ' +
      'user\'s is refused — the prompts this deployment writes (the graph setup text, a spawn\'s delegated task) and the notices it sends ' +
      'are attributed to their producers, not to a person. A delegated child session is refused too, and a contract is never intaken for ' +
      'another session\'s store. The runtime normalizes ' +
      'and judges the contract first, and one rule is the root\'s own: at least one mandatory criterion must be judged by something ' +
      'other than the composite conjunction, so "all children verified" cannot be the only thing standing behind the goal. Where this ' +
      'deployment reviews contracts, the call then answers with a proposal id and nothing activated; the decision is recorded by the ' +
      'review channel and the runtime activates the contract itself — no parameter of this call approves anything, and a contract ' +
      'waiting for a review has no root task, no run and no worker.',
    parameters: {
      ...templateBindingParameters,
      objective: {
        type: 'string',
        description:
          'The goal of this graph, in the user\'s terms: what has to exist when the work is done. It stays fixed once the contract is ' +
          'accepted, and it is what every later decomposition is judged against. The objective is the user\'s request, not this graph\'s ' +
          'name and not the environment setup work',
      },
      acceptanceCriteria: {
        type: 'array',
        description:
          'How the goal is judged, at least one criterion mandatory and aimed at the delivered artifact: a root whose only mandatory ' +
          'criterion is the conjunction of its children has no independent check of the goal it was given',
        items: criterionSchema({
          description: 'What must hold true of the delivered artifact',
          criterionId:
            'Stable id for this criterion; omitted, the runtime generates one from its position (`ac-1`, `ac-2`, …). Declared ids ' +
            'must be unique inside the contract',
          command: 'Shell command the verifier runs; exit code 0 proves the criterion (deterministic modes)',
          mode:
            'Verifier kind; defaults to deterministic with a command. Mandatory review/formal requires an explicit registered settling verifier. `composite` is the conjunction of ' +
            'the children this goal later decomposes into: it may be one of the mandatory criteria, never the only one',
          requiresArtifact: 'Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product for this criterion to be judgeable; a missing one blocks the run and registers an obligation',
          acceptsArtifact: 'Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state',
          verifierRef: 'Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole contract at intake and the error lists the registered ids. Omit to dispatch by mode.',
          heuristic: 'Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass',
          protectedInputs:
            'Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. ' +
            'Declare them as paths relative to the graph\'s checkout (an absolute path stays absolute). Intake resolves each one against that checkout and fixes the SHA-256 of its bytes ' +
            'before the contract is written — a path that cannot be read refuses the whole contract, and no protected input is ever stored as a bare path. ' +
            'The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed.',
        }),
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'External conditions this contract rests on, in your words, each marked as an assumption rather than as something the user ' +
          'asked for. They are persisted with the contract and shown to whoever reviews it. An assumption is not a confirmation: it may ' +
          'never settle a value the user did not give when that value would change the objective, the scope or the acceptance — ask the ' +
          'user for it before accepting the contract, or, if the user cannot be asked, keep it explicitly unknown and out of what the ' +
          'delivery must decide. The contract carries only what the user\'s own words and answers support — an answer that narrows or ' +
          'replaces the work bounds the objective and the criteria to it — and every criterion must be one the deployment\'s verifiers ' +
          'can settle: give a deterministic criterion its exact command.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Execution scope and limits the work runs under, in your words; persisted in the contract and handed to the workers that run under it',
      },
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Capability names the goal needs; call capability_list to inspect available grants. Missing root capabilities remain in the original contract and become persistent obligations owned by this root session. Plan available work or propose the required capability change before executing work that needs it.',
      },
      ...proposalSubmissionParameters({
        versionSubject: 'intake',
        revisionSubject: 'contract',
        derivation: 'the store, this root session and the contract content',
      }),
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'task_intake')
      // The caller's identity is the first rule, and the tool's own: a contract
      // is the goal of one root session, and a worker that could intake one
      const resolution = await ctx.singularityContext.resolveCaller(caller)
      if (resolution.kind === 'unbound') {
        return [`task_intake rejected: ${resolution.detail}`, 'Nothing was read and nothing was written.'].join('\n')
      }
      if (resolution.kind !== 'root') {
        return [
          `task_intake rejected: session "${caller}" is not the root session of graph "${resolution.graph.id}" (its root session is "${resolution.graph.rootSessionId}") —`,
          'a root contract is the goal of one root session, and a worker\'s task was admitted by its parent\'s decomposition.',
          'Nothing was read and nothing was written.',
        ].join('\n')
      }
      const storeId = resolution.storeId
      // The two keys this tool declares are options of the intake, not contract
      // fields: passing them inside the spec would make the runtime refuse them
      const { requestKey, supersedes, ...spec } = args
      let result: RootIntakeResult
      try {
        result = await ctx.taskRuntime.intakeRootContract(storeId, caller, spec as unknown as RootContractSpec, {
          ...(requestKey === undefined ? {} : { requestKey: String(requestKey) }),
          ...(supersedes === undefined ? {} : { supersedes: String(supersedes) }),
          exec: { signal: exec.signal },
        })
      } catch (error) {
        return `task_intake rejected: ${message(error)}`
      }
      if (result.status === 'activated') return activatedText(caller, result)
      return await pendingReviewText({
        ctx,
        storeId,
        proposalId: result.proposalId,
        detail: result.detail,
        tool: 'task_intake',
        holding: 'this root contract, and no root task exists',
        lines: [
          '- Nothing was activated and no worker was spawned: the contract is admitted only after the review decides, and the runtime',
          '  then re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.',
          `- Read the contract as it was recorded with \`task_proposal_read\` (${result.proposalId}).`,
          '- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime activates the root',
          '  contract immediately, so `task_read` shows the root task once it is live.',
          '- A refusal is a fact on the record: revise the contract against its reason (fix the cause, never weaken a criterion or drop',
          '  the mandatory independent one) and call `task_intake` again — a revision is new content, hence a new request key and a new',
          '  proposal, and you may name the refused one with `supersedes`.',
          '- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.',
          '- Do not call `task_decompose` before the contract is activated: there is no root task yet, and `task_read` says so.',
        ],
      })
    },
  })
}

/** The contract is live: the ids the activation commit minted, and what the session does with them. */
function activatedText(rootSessionId: string, result: Extract<RootIntakeResult, { status: 'activated' }>): string {
  return [
    `task_intake activated the root contract of session "${rootSessionId}": root task ${result.taskId}, root run ${result.runId} (proposal ${result.proposalId}).`,
    `- ${result.detail}`,
    '- The root task carries exactly this contract: `task_read` shows its objective, criteria, assumptions and constraints, and the',
    '  graph\'s tree grows from it.',
    '- `task_decompose` works on the root task from here on: that call was refused before this intake because no root task existed.',
    '- Nothing here claims the goal is met: the runtime submits nothing on your behalf. Delegate as many batches as the work needs,',
    '  and when the goal is delivered hand the root task in yourself with `task_submit_result` — only that submission starts its acceptance.',
  ].join('\n')
}


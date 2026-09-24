import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-context'
import { openRootProposals } from '@dangosys/dsh-singularity-context'
import type { TaskProposalRoot, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { RootContractSpec, RootIntakeResult } from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_intake: missing agent id')
  return id
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The root store's snapshot, or `undefined` when no such store exists yet — the
 * pre-intake state §1.1 allows, answered as a state rather than thrown at a
 * reader. The store's own word for it is "does not exist"; every other failure
 * (a log this process cannot read, a store it cannot open) is the reader's to
 * surface and is re-raised unchanged. Read-only: `ctx.task.openStore` is the
 * store's own read open.
 */
async function rootSnapshotOrUndefined(ctx: Context, storeId: string): Promise<TaskSnapshot | undefined> {
  try {
    return await ctx.task.openStore(storeId)
  } catch (error) {
    if (error instanceof Error && /does not exist/.test(error.message)) return undefined
    throw error
  }
}

/**
 * Why a root contract is refused, when the store holds no record of it
 * (A0 §1.2–§1.6): the three things a caller does not learn from a single
 * message, because the message is about one rule and the caller is about to
 * decide what to do next. Nothing here restates a rule — the reason is the
 * runtime's, printed verbatim — and nothing here claims a record was written.
 */
const NOTHING_WRITTEN_NOTES = [
  '- Nothing was written: no proposal, no root task, no run and no worker. A contract that fails a rule is refused before a record',
  '  exists, so the reason above is the whole diagnosis.',
  '- A store that already holds a root task is never re-intaken, and a root run that reached a terminal state is not revived: an',
  '  existing root is history, and a new goal is a new graph.',
  '- The rule a root contract has that a child contract does not: at least one mandatory criterion judged by something other than the',
  '  composite conjunction. "All children verified" restates the decomposition and cannot be the root\'s only mandatory criterion.',
]

/**
 * What one refused intake left behind, read back from the store rather than
 * guessed from the error's prose (stage-D defect 2).
 *
 * The intake writes the proposal first and activates it second, and the
 * activation claims the checkout before it commits — so a refusal can leave the
 * `TaskProposalSubmitted` on the record (a checkout another live run holds is
 * that path, and it is why a retry is answered by that same proposal) or leave
 * nothing at all (every rule the contract itself fails is judged before a record
 * exists). A text that said "nothing was written" in both would be wrong in the
 * first, which is where a caller most needs to know its contract was accepted.
 */
type RefusedIntakeRecord =
  | { readonly kind: 'recorded'; readonly proposal: TaskProposalRoot }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly reason: string }

/**
 * Which of the three this refusal was, from the store's own facts. The record is
 * matched exactly: by the caller's request key when it gave one (one key names
 * one proposal, and a key bound to other content is refused rather than stored),
 * else by the objective *and* the acceptance-criteria descriptions this call
 * sent — both stored verbatim. Comparing the whole contract would mean
 * normalizing it here, which is the runtime's work and not this tool's.
 */
async function probeRefusedRecord(
  ctx: Context,
  storeId: string,
  call: { readonly objective: string; readonly acceptanceCriteria: readonly { readonly description: string }[] },
  requestKey: string | undefined,
): Promise<RefusedIntakeRecord> {
  let snapshot: TaskSnapshot | undefined
  try {
    snapshot = await rootSnapshotOrUndefined(ctx, storeId)
  } catch (error) {
    return { kind: 'unreadable', reason: message(error) }
  }
  if (snapshot === undefined) return { kind: 'none' }
  const open = openRootProposals(snapshot)
  const criteria = Array.isArray(call.acceptanceCriteria) ? call.acceptanceCriteria : []
  const matches = (proposal: TaskProposalRoot): boolean => requestKey !== undefined
    ? proposal.requestKey === requestKey
    : proposal.contract.objective === call.objective &&
      proposal.contract.acceptanceCriteria.length === criteria.length &&
      proposal.contract.acceptanceCriteria.every((criterion, index) => criterion.description === criteria[index]?.description)
  const proposal = [...open].reverse().find(matches)
  return proposal === undefined ? { kind: 'none' } : { kind: 'recorded', proposal }
}

/**
 * The notes one refusal is rendered with, by the path it took. The recorded path
 * says what is on the record and how the retry is addressed — the same contract
 * is answered by that same proposal, and the continuation that activates a
 * recorded root contract is `task_proposal_continue`; the unreadable path claims
 * neither, because this call could not tell which of the two it was.
 */
function refusalNotes(record: RefusedIntakeRecord, storeId: string): string[] {
  if (record.kind === 'recorded') {
    const proposal = record.proposal
    return [
      `- The contract itself was recorded: proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}) is on the record, so the`,
      '  contract was accepted — a proposal is written only after every contract rule has passed — and what failed is the activation:',
      '  the intake records the proposal first and activates it second, and the activation claims the checkout before it commits.',
      '- The record is where a retry continues from: asking again with the same content is answered by that same proposal rather than',
      `  by a second one, and \`task_proposal_continue\` (${proposal.proposalId}) re-checks it and activates the root when the cause is gone.`,
      `- Read the contract as it was recorded with \`task_proposal_read\` (${proposal.proposalId}).`,
    ]
  }
  if (record.kind === 'unreadable') {
    return [
      `- Whether this contract was recorded could not be read back from store ${storeId} (${record.reason}), so this call cannot say which of`,
      '  the two it was: the reason above is what the runtime refused with, and a retry with the same content is answered by the same',
      '  proposal if one is on the record.',
    ]
  }
  return NOTHING_WRITTEN_NOTES
}

/**
 * The root contract intake (A0 §3 stage C): the one tool that turns a user's
 * objective into the graph's root task, and the root session's own action — a
 * worker has a task already and cannot intake one (`task_intake` is in
 * ROOT_TOOLS only).
 *
 * The tool normalizes nothing, judges nothing and activates nothing: the whole
 * contract is handed to `intakeRootContract`, which is the entry a direct
 * service call uses too, and every rule — the closed field set, the
 * independent-criterion rule, the capability resolution, the review policy, the
 * atomic activation — stays in the runtime. What this file owes the model is
 * therefore a *surface*: a schema whose criterion objects are closed, and three
 * answers rendered as they are.
 *
 * What the schema must not do is suggest that a review can be shortcut: the
 * deployment's policy decides whether a contract waits, the channel is the only
 * writer of a decision, and no parameter here — or anywhere in this tool's
 * description — may read as a way to approve one (§7's reverse discipline; the
 * same rule `proposal-parameters.ts` enforces for the proposal tools).
 *
 * The criterion face is the one `task_decompose.ts` declares, with one
 * exception: **no `childEvidence`**. A map names positions in a batch, and a
 * root contract is submitted before any batch exists — the root's own
 * decomposition happens later, so a position declared here could not name
 * anything the runtime would ever judge. The schema refuses the key rather than
 * letting a model declare a map nothing can check.
 */
export function defineTaskIntakeTool(ctx: Context) {
  return defineTool({
    name: 'task_intake',
    description:
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
      objective: {
        type: 'string',
        required: true,
        description:
          'The goal of this graph, in the user\'s terms: what has to exist when the work is done. It stays fixed once the contract is ' +
          'accepted, and it is what every later decomposition is judged against. The objective is the user\'s request, not this graph\'s ' +
          'name and not the environment setup work',
      },
      acceptanceCriteria: {
        type: 'array',
        required: true,
        description:
          'How the goal is judged, at least one criterion mandatory and aimed at the delivered artifact: a root whose only mandatory ' +
          'criterion is the conjunction of its children has no independent check of the goal it was given',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', required: true, description: 'What must hold true of the delivered artifact' },
            criterionId: {
              type: 'string',
              description:
                'Stable id for this criterion; omitted, the runtime generates one from its position (`ac-1`, `ac-2`, …). Declared ids ' +
                'must be unique inside the contract',
            },
            command: { type: 'string', description: 'Shell command the verifier runs; exit code 0 proves the criterion (deterministic modes)' },
            mode: {
              type: 'string',
              enum: ['deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite'],
              description:
                'Verifier kind; defaults to deterministic when a command is given, review otherwise. `composite` is the conjunction of ' +
                'the children this goal later decomposes into: it may be one of the mandatory criteria, never the only one',
            },
            mandatory: { type: 'boolean', description: 'Whether the criterion must pass; default true' },
            requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence kinds the verifier must attach' },
            requiresArtifact: {
              type: 'array',
              items: { type: 'string' },
              description: 'Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product for this criterion to be judgeable; a missing one blocks the run and registers an obligation',
            },
            acceptsArtifact: {
              type: 'array',
              items: { type: 'string' },
              description: 'Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state',
            },
            verifierRef: {
              type: 'string',
              description: 'Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole contract at intake and the error lists the registered ids. Omit to dispatch by mode.',
            },
            heuristic: {
              type: 'boolean',
              description: 'Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass',
            },
            protectedInputs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. ' +
                'Declare them as paths relative to the graph\'s checkout (an absolute path stays absolute). Intake resolves each one against that checkout and fixes the SHA-256 of its bytes ' +
                'before the contract is written — a path that cannot be read refuses the whole contract, and no protected input is ever stored as a bare path. ' +
                'The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed.',
            },
          },
        },
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
          'Capability names the goal needs; call capability_list first to see the names this deployment can grant. A root contract has ' +
          'nobody above it to delegate a gap to, so a name the registry cannot grant refuses the contract by name rather than being ' +
          'recorded as an obligation',
      },
      contractVersion: {
        type: 'integer',
        description:
          'Contract version this intake is written under. The runtime stores version 1 and refuses a declared version it does not know, ' +
          'so callers normally omit this field and let the runtime write the current version',
      },
      requestKey: {
        type: 'string',
        description:
          'The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime ' +
          'derives one from the store, this root session and the contract content when this is omitted). One key names at most one proposal: ' +
          'repeating a request with the same key is answered with the proposal already stored, while the same key with different content is ' +
          'refused. A revision is different content, so it needs a new key',
      },
      supersedes: {
        type: 'string',
        description:
          'The proposal id this contract revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the ' +
          'history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the ' +
          'new request key this submission needs',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      // The caller's identity is the first rule, and the tool's own: a contract
      // is the goal of one root session, and a worker that could intake one
      // would be creating a second root under somebody else's graph. The
      // resolution is the context read core's trusted session→graph binding —
      // checked before any service call, so a refusal here has no side effect
      // at all.
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
      // by name. Everything else the caller sent goes to the runtime as it
      // arrived — including a key this schema does not declare, which the
      // runtime refuses by name rather than dropping in silence.
      const { requestKey, supersedes, ...spec } = args
      let result: RootIntakeResult
      try {
        result = await ctx.taskRuntime.intakeRootContract(storeId, caller, spec as unknown as RootContractSpec, {
          ...(requestKey === undefined ? {} : { requestKey: String(requestKey) }),
          ...(supersedes === undefined ? {} : { supersedes: String(supersedes) }),
          exec: { signal: exec.signal },
        })
      } catch (error) {
        // The refusal is the runtime's; what this tool adds is the state the
        // store is in after it, which is the one thing the error cannot say.
        const recorded = await probeRefusedRecord(
          ctx,
          storeId,
          { objective: args.objective, acceptanceCriteria: args.acceptanceCriteria },
          requestKey === undefined ? undefined : String(requestKey),
        )
        return [`task_intake rejected: ${message(error)}`, ...refusalNotes(recorded, storeId)].join('\n')
      }
      if (result.status === 'activated') return activatedText(caller, result)
      return await pendingText(ctx, storeId, result.proposalId, result.detail)
    },
  })
}

/**
 * The contract is live: the ids the activation commit minted, and what the
 * session does with them. The last line is the one fact a root can misread —
 * having a root task is not having a finished graph — so it is stated rather
 * than left to the verifier's later verdict.
 */
function activatedText(rootSessionId: string, result: Extract<RootIntakeResult, { status: 'activated' }>): string {
  return [
    `task_intake activated the root contract of session "${rootSessionId}": root task ${result.taskId}, root run ${result.runId} (proposal ${result.proposalId}).`,
    `- ${result.detail}`,
    '- The root task carries exactly this contract: `task_read` shows its objective, criteria, assumptions and constraints, and the',
    '  graph\'s tree grows from it.',
    '- `task_decompose` works on the root task from here on: that call was refused before this intake because no root task existed.',
    '- The runtime submits the root task for verification when its batch settles; nothing here claims the goal is met.',
  ].join('\n')
}

/**
 * The contract waits for a review (A0 §1.3): the proposal holds it, nothing was
 * activated, and the caller's next move is not another submission — the same
 * request answers with this same proposal. The policy is read back from the
 * record rather than assumed, because a proposal born under `off` and sent to
 * review by a tightened deployment keeps its birth policy; when the record
 * cannot be read the text says so instead of inventing one.
 */
async function pendingText(ctx: Context, storeId: string, proposalId: string, detail: string): Promise<string> {
  let policy = 'unknown — the proposal record could not be read back'
  try {
    policy = `${(await ctx.taskRuntime.proposalIn(storeId, proposalId)).policy}`
  } catch {
    // The contract is recorded and waiting either way; only this rendering is thin.
  }
  return [
    `task_intake is waiting for a review: proposal ${proposalId} (policy ${policy}) holds this root contract, and no root task exists.`,
    `- ${detail}`,
    '- Nothing was activated and no worker was spawned: the contract is admitted only after the review decides, and the runtime',
    '  then re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.',
    `- Read the contract as it was recorded with \`task_proposal_read\` (${proposalId}).`,
    '- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime activates the root',
    '  contract immediately, so `task_read` shows the root task once it is live.',
    '- A refusal is a fact on the record: revise the contract against its reason (fix the cause, never weaken a criterion or drop',
    '  the mandatory independent one) and call `task_intake` again — a revision is new content, hence a new request key and a new',
    '  proposal, and you may name the refused one with `supersedes`.',
    '- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.',
    '- Do not call `task_decompose` before the contract is activated: there is no root task yet, and `task_read` says so.',
  ].join('\n')
}

import { createHash } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type {
  EvidenceBundle,
  TaskEvent,
  TaskInstance,
  TaskProposalRoot,
  TaskProposalRootConsumption,
  VerificationResult,
} from '../../task/src/index.ts'
import type { CriterionSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptedLoop,
  type ScriptedReviewAsk,
  type ScriptEntry,
  type ToolCallRecord,
} from '../support/scripted-loop.ts'

/**
 * A0 acceptance on the real loop: the root contract intake, from the user's own
 * request to the root task the graph is then held to.
 *
 * What is real: the DSH agent loop (the model is scripted, one script per
 * session), the real `task_intake` tool and the root's own composition
 * (`ROOT_TOOLS`, applied by the real `AgentRuntime`), the real `TaskService` and
 * its reducer, the real `TaskRuntime` (intake, review gate, activation,
 * `adoptRoot`, the execution gate), the real `ProposalReviewService` mounted at
 * the service assembly over the approval seam, the real `VerifierRegistry` with
 * its built-in `CommandVerifier`, and the real checkout on disk. What a case
 * asserts is read back from the store's snapshot, its own event log, the
 * evidence the verifier wrote, or the bytes in the checkout — never from a
 * tool's prose alone.
 *
 * The matrix rows this file carries (design §4), one case each:
 *
 * | row | case |
 * |---|---|
 * | setup creates no root task; `task_read` before an intake | 1 |
 * | graph name never stands in for the goal; the objective is the user's | 1 |
 * | the request's origin is the session the root proposal names | 1 |
 * | a root with no independent top-level criterion is refused, zero side effects | 2 |
 * | children all verified but the root's own criterion fails — refused, named | 3 |
 * | the criterion judges the real artifact, and a fixed artifact is a pass | 3, 4 |
 * | a rewritten protected acceptance input fails by name, command never dispatched | 5 |
 * | `off` records `policy-off` and activates in the same call | 6 |
 * | `all` holds the contract: no task, no dispatch, the reader shows it, the decision activates | 7 |
 * | a direct service call is held by the same gate | 8 |
 * | a refused draft dispatches nothing; a revision is new content with `supersedes` | 9 |
 * | a terminal root is not revived by a late intake | 10 |
 * | worker surface does not expand, and holds no deciding tool | 11 |
 *
 * The batch-side half of the same gate (what a batch's review does under
 * `off`/`all`, its staleness and expiry rules) is `proposal-review.spec.ts`; the
 * crash points are `root-intake-recovery.spec.ts`. Both use the same fixture.
 */

/** The root session these cases run in, when one root session is enough. */
const ROOT = 's-root' as SessionId
/** Two root sessions, so "which session carried the request" is a real question. */
const ALPHA = 's-alpha' as SessionId
const BETA = 's-beta' as SessionId

/**
 * The graph name this fixture's own graph record carries
 * (`scripted-loop.ts`'s `graphForSession`). Every case states a goal unlike it:
 * the §4 row is about a session whose graph name and user objective are
 * different text, which is where a stale objective would be visible.
 */
const GRAPH_NAME = 'graph'

/** What the user asks for, in the user's words: the root's objective, never the graph's name. */
const USER_GOAL = 'publish the quarterly alignment report'

/** The protected acceptance script the root's own criterion runs — S1-V slice 2's mechanism, at the root. */
const ACCEPTANCE = 'acceptance.sh'

/** The acceptance check: it reads the delivered product and fails while the product is wrong. */
const ACCEPTANCE_SCRIPT = `#!/bin/sh
echo "checked $(cat product.txt)"
grep -q "^ok$" product.txt
`

/** What a worker rewriting the acceptance input would leave behind, so "the command never ran" is checked as an absence. */
const REWRITTEN_SCRIPT = `#!/bin/sh
echo rewritten > dispatch-marker.txt
exit 0
`

/** SHA-256 of bytes, computed here so the implementation is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

afterEach(async () => {
  await disposeScriptedLoops()
})

/* --- reading the deployment's own facts ---------------------------------- */

/** Every task event one store appended, read back off the loop's own session log. */
function taskEvents(h: ScriptedLoop, storeId: string): TaskEvent[] {
  return h.eventsOf(storeId).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** The payload of one task's event of one kind, or undefined when it never landed. */
function payloadOf<K extends TaskEvent['kind']>(
  h: ScriptedLoop,
  storeId: string,
  kind: K,
  taskId: string,
): Extract<TaskEvent, { kind: K }>['payload'] | undefined {
  const event = taskEvents(h, storeId).find(item => item.kind === kind && item.taskId === taskId) as
    | Extract<TaskEvent, { kind: K }>
    | undefined
  return event?.payload
}

/** Every evidence bundle the store persisted under one run. */
function evidenceFor(h: ScriptedLoop, storeId: string, runId: string): EvidenceBundle[] {
  return taskEvents(h, storeId).flatMap(item => (item.kind === 'EvidenceProduced' && item.runId === runId ? [item.payload.evidence] : []))
}

/** The store's root task, refused by name when the store holds none. */
async function rootTaskOf(h: ScriptedLoop, storeId: string): Promise<TaskInstance> {
  const task = (await h.snapshot(storeId)).tasks.find(candidate => candidate.parentTaskId === undefined)
  if (task === undefined) throw new Error(`store "${storeId}" holds no root task`)
  return task
}

/** What one root proposal was consumed as, refused by name while it was not. */
function consumptionOf(proposal: TaskProposalRoot): TaskProposalRootConsumption {
  const consumption = proposal.consumption
  if (consumption === undefined) throw new Error(`proposal "${proposal.proposalId}" was never consumed`)
  if (consumption.kind !== 'root') throw new Error(`proposal "${proposal.proposalId}" was consumed as a batch`)
  return consumption
}

/** One proposal as the store holds it, by id. */
async function proposalById(h: ScriptedLoop, storeId: string, proposalId: string): Promise<TaskProposalRoot> {
  const proposal = (await h.snapshot(storeId)).proposals?.byId[proposalId]
  if (proposal === undefined) throw new Error(`store "${storeId}" holds no proposal "${proposalId}"`)
  if (proposal.kind !== 'root') throw new Error(`proposal "${proposalId}" is not a root contract`)
  return proposal
}

/** The one root contract proposal a store holds. */
async function onlyRootProposal(h: ScriptedLoop, storeId: string): Promise<TaskProposalRoot> {
  const proposals = ((await h.snapshot(storeId)).proposals?.all ?? []).filter((item): item is TaskProposalRoot => item.kind === 'root')
  if (proposals.length !== 1) throw new Error(`store "${storeId}" holds ${proposals.length} root contract proposals, expected one`)
  return proposals[0]!
}

/** The proposal status the store holds, waited for. */
async function statusOf(h: ScriptedLoop, storeId: string, proposalId: string, expected: string): Promise<TaskProposalRoot> {
  await vi.waitFor(async () => expect((await proposalById(h, storeId, proposalId)).status).toBe(expected))
  return await proposalById(h, storeId, proposalId)
}

/* --- driving the loop and reading its answers ---------------------------- */

/** The `ordinal`-th dispatch of one tool, once it reported a result. */
async function answered(h: ScriptedLoop, name: string, ordinal = 0, sessionId: string | SessionId = ROOT): Promise<ToolCallRecord> {
  await vi.waitFor(() => {
    expect(h.calls.filter(call => call.name === name && call.sessionId === String(sessionId) && call.result !== undefined).length).toBeGreaterThan(ordinal)
  })
  return h.calls.filter(call => call.name === name && call.sessionId === String(sessionId))[ordinal]!
}

/** The answer text of the `ordinal`-th dispatch of one tool. */
function resultTextOf(calls: readonly ToolCallRecord[], name: string, ordinal = 0): string {
  return calls.filter(call => call.name === name)[ordinal]!.result!.text
}

/** The proposal id a tool answer names — the record the call is addressed by. */
function proposalIdOf(text: string): string {
  const match = /(p-[0-9a-f]{64})/.exec(text)
  if (match === null) throw new Error(`the answer named no proposal id: ${text}`)
  return match[1]!
}

/** The `index`-th **root contract** review ask the channel made, waited for. */
async function askAt(h: ScriptedLoop, index: number): Promise<ScriptedReviewAsk> {
  await vi.waitFor(() => expect(h.review.rootAsks.length).toBeGreaterThan(index))
  return h.review.rootAsks[index]!
}

/**
 * Wait for `count` workers to have been spawned. The window is generous on
 * purpose: a spawn is asynchronous by protocol — the admission commit, the
 * driver's drain of the parent session and the worker's own minting all happen
 * after the call that admitted the batch returns — and the suite runs many spec
 * files in parallel forks. What a case asserts is that the worker is there; the
 * verdicts that follow are read from the store, so the timeout bounds a wait
 * instead of standing in for evidence.
 */
async function spawned(h: ScriptedLoop, storeId: string, count: number): Promise<void> {
  try {
    await vi.waitFor(() => expect(h.spawns).toHaveLength(count), { timeout: 20_000, interval: 25 })
  } catch (error) {
    const snapshot = await h.snapshot(storeId)
    const causes = snapshot.reviews.map(item => item.localizedCause ?? item.outcome).join('; ')
    throw new Error(
      `no worker was spawned: the store holds ${snapshot.tasks.length} task(s), ${snapshot.runs.length} run(s) and its reviews say ` +
      `${causes === '' ? 'nothing yet' : causes} (${String(error)})`,
    )
  }
}

/**
 * Wait for the root task a recorded decision activates, read from the store. The
 * channel settles an ask off the asking tick (so the runtime's per-store lock is
 * not held while a person thinks), which is why the activation that follows an
 * approval is observed here rather than returned by the call that asked.
 */
async function activatedRoot(h: ScriptedLoop, storeId: string): Promise<{ taskId: string; runId: string }> {
  let found: { taskId: string; runId: string } | undefined
  await vi.waitFor(async () => {
    const snapshot = await h.snapshot(storeId)
    const task = snapshot.tasks.find(candidate => candidate.parentTaskId === undefined)
    const run = task === undefined ? undefined : snapshot.runs.find(candidate => candidate.taskId === task.taskId)
    if (task === undefined || run === undefined) {
      throw new Error(`store "${storeId}" holds ${snapshot.tasks.length} task(s) and no root run for task "${task?.taskId ?? '(none)'}"`)
    }
    found = { taskId: task.taskId, runId: run.runId }
  }, { timeout: 20_000, interval: 25 })
  return found!
}

/** The batch id the store recorded on a session's run — the admission's own fact, waited for. */
async function batchIdOf(h: ScriptedLoop, sessionId: string | SessionId): Promise<string> {
  await vi.waitFor(async () => expect((await h.runForSession(sessionId)).run.batchId).toBeDefined())
  return (await h.runForSession(sessionId)).run.batchId!
}

/**
 * The notices the runtime pushed into one session, read off that session's own
 * log: a notice is a plugin-sourced user message (`task-runtime`'s `notify`), and
 * pushing one wakes the session's turn. A refusal path that woke somebody would
 * show up here — what "zero side effects" owes beyond "zero tasks" (A0 §4:
 * 零落库/零 spawn/零唤醒). A person's own message is never a plugin notice, so
 * nothing a spec typed into the session appears in this list.
 */
function wakeNotices(h: ScriptedLoop, sessionId: string | SessionId): string[] {
  return h.eventsOf(sessionId)
    .filter(event => event.type === 'user/message')
    .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'plugin')
    .flatMap(event => (event.data as { content?: readonly { type: string; text?: string }[] }).content ?? [])
    .flatMap(block => (block.text === undefined ? [] : [block.text]))
}

/* --- the contracts and scripts these cases run under ---------------------- */

/** One criterion a command settles; the root's independent check (A0 §1.2 needs at least one). */
const commandCriterion = (criterionId: string, command: string): CriterionSpec => ({
  criterionId,
  description: `${criterionId} holds`,
  command,
})

/** A root contract that satisfies the root's own structural rule, with the goal and the criteria a case is about. */
function contractFor(objective: string, criteria: readonly CriterionSpec[] = [commandCriterion('root-goal', 'true')]): RootContractSpec {
  return { objective, acceptanceCriteria: [...criteria] }
}

/**
 * The root contract whose independent criterion is a real acceptance script run
 * against the delivered artifact (A0 §4: the criterion judges the product, not a
 * constant truth), plus the conjunction, so a case can read both halves.
 */
function artifactContract(): RootContractSpec {
  return contractFor('deliver a product the acceptance script accepts', [
    {
      criterionId: 'root-artifact',
      description: 'the delivered product passes the acceptance script',
      command: `sh ${ACCEPTANCE}`,
      mode: 'deterministic',
      protectedInputs: [ACCEPTANCE],
    },
    { criterionId: 'root-children', description: 'every mandatory child verified', mode: 'composite', mandatory: true },
  ])
}

/** The `task_intake` arguments one contract is submitted with. */
const intakeArgs = (contract: RootContractSpec, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...contract, ...extra })

/** The scripted root that hands one child the work and stops. */
const decomposeScript = (objective: string): readonly ScriptEntry[] => [
  {
    tool: 'task_decompose',
    args: { reason: 'split the work', children: [{ objective, acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }] }] },
  },
  { text: 'root: the batch is the runtime\'s now' },
]

/** The scripted worker that hands its work in and stops. */
const workerScript = (summary: string): readonly ScriptEntry[] => [
  { tool: 'task_submit_result', args: { summary } },
  { text: 'worker: handed in' },
]

describe('the root contract intake on the real loop (A0 §1–§4)', () => {
  it('keeps the graph name out of the goal: the not-activated view, then the user\'s own objective as the root', async () => {
    // Two root sessions, so "the root proposal names the session that carried the
    // request" is a question with a wrong answer available (A0 §1.10's mechanical
    // half: the origin is a persisted fact, not the model's word).
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      roots: [ALPHA, BETA],
      script: sessionId => sessionId === String(BETA)
        ? [
          // (1) Before any contract: the reader answers the named state, and names
          // no objective at all — the graph's name least of all.
          { tool: 'task_read', args: {} },
          // (2) The real tool, driven by the root's own turn, accepting the goal
          // the person typed.
          { tool: 'task_intake', args: intakeArgs(contractFor(USER_GOAL)) },
          { text: 'root: the goal is accepted' },
        ]
        : [],
    })
    const storeId = rootTaskStoreId(String(BETA))

    // The graph's creation: the session is live and its store is opened by the
    // graph's own entry — with no task in it (`graphs.create` calls exactly this;
    // A0 §4's "setup creates no root task"). What the old entry minted here was a
    // root whose objective was the graph's own name.
    const adopted = await h.runtime.adoptRoot(storeId, String(BETA))
    expect(adopted.adopted).toBe(false)
    expect((await h.snapshot(storeId)).tasks).toHaveLength(0)

    h.userSays(USER_GOAL, BETA)
    const read = await answered(h, 'task_read', 0, BETA)
    expect(read.result?.isError).toBe(false)
    expect(read.result?.text).toContain('not activated — no root contract has been accepted for this session')
    expect(read.result?.text).toContain('opened, with no root task in it')
    // No objective is reported: not the graph's name, and not even the user's own
    // words — nothing has been accepted yet.
    expect(read.result?.text).not.toContain('objective:')
    expect(read.result?.text).not.toContain(`objective: ${GRAPH_NAME}`)

    const intake = await answered(h, 'task_intake', 0, BETA)
    expect(intake.result?.isError).toBe(false)
    expect(intake.result?.text).toContain(`task_intake activated the root contract of session "${String(BETA)}"`)

    // The root is the user's goal, not the graph's name; the run that will do the
    // work is in the session whose turn read the request; and the proposal that
    // became it names that session and that store.
    const root = await rootTaskOf(h, storeId)
    expect(root.objective).toBe(USER_GOAL)
    expect(root.objective).not.toBe(GRAPH_NAME)
    expect(root.contract?.objective).toBe(USER_GOAL)
    expect(root.depth).toBe(0)
    const bound = await h.runForSession(BETA)
    expect(bound.run.sessionId).toBe(String(BETA))
    expect(bound.task.taskId).toBe(root.taskId)

    const proposal = await onlyRootProposal(h, storeId)
    expect(proposal.identity.rootSessionId).toBe(String(BETA))
    expect(proposal.identity.storeId).toBe(storeId)
    expect(proposal.identity.contractDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(consumptionOf(proposal)).toMatchObject({ rootTaskId: root.taskId, rootRunId: bound.run.runId })
    // The activation announced itself to the session it belongs to (the other
    // half of "zero wake-ups" — the refusals below wake nobody).
    expect(wakeNotices(h, BETA).join('\n')).toContain('the root contract of this session was activated')

    // The session the proposal names is the one whose own log carries the request
    // (`user/message` is the loop's own record of what it read) — and the other
    // root session, which was told nothing, holds no such message.
    const saidIn = (sessionId: SessionId): string[] => h.eventsOf(sessionId)
      .filter(event => event.type === 'user/message')
      .flatMap(event => (event.data as { content?: readonly { type: string; text?: string }[] }).content ?? [])
      .flatMap(block => (block.text === undefined ? [] : [block.text]))
    expect(saidIn(BETA)).toContain(USER_GOAL)
    expect(saidIn(ALPHA)).toEqual([])
    // One root, one run, one intake — and no second graph tree anywhere.
    const snapshot = await h.snapshot(storeId)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect((snapshot.proposals?.all ?? []).filter(item => item.kind === 'root')).toHaveLength(1)
  })

  it('refuses a root contract with no independent top-level criterion, by name and with nothing written', async () => {
    // The composite conjunction alone: a goal satisfied by its own decomposition
    // (A0 §1.2). Both doors are exercised — the tool the root holds, and the
    // service entry a direct caller reaches — and both must refuse before a
    // record exists.
    const compositeOnly = contractFor(USER_GOAL, [
      { criterionId: 'root-children', description: 'all mandatory children verified', mode: 'composite', mandatory: true },
    ])
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_intake', args: intakeArgs(compositeOnly) },
          { text: 'root: the contract was refused' },
        ]
        : [],
    })
    const storeId = rootTaskStoreId(String(ROOT))
    h.userSays(USER_GOAL)

    const refused = await answered(h, 'task_intake')
    // A refusal is an answer, not a crash: the model learns why and what would
    // change it.
    expect(refused.result?.isError).toBe(false)
    expect(refused.result?.text).toContain('task_intake rejected')
    expect(refused.result?.text).toContain('requires at least one mandatory acceptance criterion judged by something other than the composite conjunction')

    // The same rule, from the entry the tool calls: the gate is not the tool's.
    await expect(h.runtime.intakeRootContract(storeId, String(ROOT), compositeOnly))
      .rejects.toThrow(/requires at least one mandatory acceptance criterion/)

    // Zero side effects: no root task, no run, no proposal and no proposal event,
    // no worker, nobody was asked (§5's 坏提案不弹审批 reaches the root intake), and
    // nobody was woken — a refusal that pushed a notice into the session would show
    // up as a plugin message on its own log.
    const snapshot = await h.snapshot(storeId)
    expect(snapshot.tasks).toHaveLength(0)
    expect(snapshot.runs).toHaveLength(0)
    expect(snapshot.proposals?.all ?? []).toHaveLength(0)
    expect(taskEvents(h, storeId).filter(event => event.kind.startsWith('TaskProposal'))).toHaveLength(0)
    expect(taskEvents(h, storeId).filter(event => event.kind === 'TaskCreated')).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    expect(h.review.asks).toHaveLength(0)
    expect(wakeNotices(h, ROOT)).toEqual([])
  })

  it('refuses the root when its own command criterion fails on the delivered artifact, naming the criterion', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0 ? decomposeScript('produce the product') : workerScript('produced the product'),
    })
    // The acceptance script is the root's own criterion's input, and the product
    // is what the tree is supposed to deliver. The scripted worker holds no
    // filesystem tool, so the spec puts the delivered bytes where a worker's own
    // `write` would: the criterion reads the checkout, not a fixture answer.
    await writeFile(join(h.checkout, ACCEPTANCE), ACCEPTANCE_SCRIPT, 'utf8')
    await writeFile(join(h.checkout, 'product.txt'), 'broken\n', 'utf8')
    const root = await h.begin(artifactContract())

    // The intake fixed the identity of the bytes it read, on the root's own
    // contract — the same mechanism a child's contract gets (S1-V slice 2).
    const contract = (await rootTaskOf(h, root.storeId)).contract!
    const artifact = contract.acceptanceCriteria.find(criterion => criterion.criterionId === 'root-artifact')!
    expect(artifact.protectedInputs).toEqual([{ path: ACCEPTANCE, sha256: sha256Of(ACCEPTANCE_SCRIPT) }])

    await spawned(h, root.storeId, 1)
    const outcomes = await h.runtime.awaitBatch(root.storeId, await batchIdOf(h, ROOT))
    // Every child verified — and the goal is still refused, by the root's own
    // check of what was actually delivered.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('failed')
    expect(payloadOf(h, root.storeId, 'TaskFailed', root.taskId)?.reason).toContain('root-artifact')

    const failed = evidenceFor(h, root.storeId, root.runId).flatMap(bundle => bundle.verifierResults)
      .find((result: VerificationResult) => result.criterionId === 'root-artifact')!
    expect(failed).toMatchObject({ status: 'fail', verifierId: 'command' })
    // The real command ran in the checkout and said what it checked.
    expect(await h.verifier.logTail(failed.logRef!)).toContain('checked broken')

    // Repairing the artifact is the next case: a settled run is not re-judged in
    // place — the store's verdict is history — so "the same contract against the
    // repaired bytes" is a new attempt, which for a graph is a new root session
    // (§1.6). What this case establishes is the refusal and the name; what the
    // next one adds is that the same contract, script and criterion pass on the
    // repaired artifact, i.e. the failure above was the artifact's doing.
  })

  it('verifies the same root contract once the delivered artifact is right, end to end', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0 ? decomposeScript('produce the product') : workerScript('produced the product'),
    })
    await writeFile(join(h.checkout, ACCEPTANCE), ACCEPTANCE_SCRIPT, 'utf8')
    await writeFile(join(h.checkout, 'product.txt'), 'ok\n', 'utf8')
    const root = await h.begin(artifactContract())

    await spawned(h, root.storeId, 1)
    const outcomes = await h.runtime.awaitBatch(root.storeId, await batchIdOf(h, ROOT))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // Both halves of the root's own acceptance: the artifact the command judged,
    // and the conjunction of the children that ran.
    expect((await h.task.taskIn(root.storeId, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
    const verdicts = evidenceFor(h, root.storeId, root.runId).flatMap(bundle => bundle.verifierResults)
    const artifact = verdicts.find(result => result.criterionId === 'root-artifact')!
    expect(artifact).toMatchObject({ status: 'pass', verifierId: 'command', exitCode: 0 })
    // The same script ran here as in the refusing case, and this time its own
    // output says what it accepted.
    expect(await h.verifier.logTail(artifact.logRef!)).toContain('checked ok')
    expect(verdicts.find(result => result.criterionId === 'root-children')).toMatchObject({ status: 'pass' })
  })

  it('names the changed protected input when a worker rewrites the acceptance script, and never dispatches it', async () => {
    const release = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0
        ? decomposeScript('produce the product')
        : [
          // The worker parks until the spec has rewritten the script, so the
          // rewrite lands in the window the protection exists for: after the
          // intake that fixed the bytes, before the judgement that re-reads them.
          { waitFor: () => release.promise },
          { tool: 'task_submit_result', args: { summary: 'produced the product' } },
          { text: 'worker: handed in' },
        ],
    })
    await writeFile(join(h.checkout, ACCEPTANCE), ACCEPTANCE_SCRIPT, 'utf8')
    await writeFile(join(h.checkout, 'product.txt'), 'ok\n', 'utf8')
    const root = await h.begin(artifactContract())

    await spawned(h, root.storeId, 1)
    await writeFile(join(h.checkout, ACCEPTANCE), REWRITTEN_SCRIPT, 'utf8')
    release.resolve()

    const outcomes = await h.runtime.awaitBatch(root.storeId, await batchIdOf(h, ROOT))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The child verified and the goal is still refused: the criterion that
    // protects it fails by name, with the bytes it was admitted against and the
    // bytes that stand there now.
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('failed')
    expect(payloadOf(h, root.storeId, 'TaskFailed', root.taskId)?.reason).toContain('root-artifact')
    const verdict = evidenceFor(h, root.storeId, root.runId).flatMap(bundle => bundle.verifierResults)
      .find(result => result.criterionId === 'root-artifact')!
    expect(verdict).toMatchObject({ status: 'fail', verifierId: 'command' })
    expect(verdict.details).toContain(`protected input "${ACCEPTANCE}" changed since admission`)
    expect(verdict.details).toContain(sha256Of(ACCEPTANCE_SCRIPT))
    expect(verdict.details).toContain(sha256Of(REWRITTEN_SCRIPT))
    // The rewritten script never ran: it left no marker of its own, and the
    // criterion recorded no command output at all.
    expect(verdict.exitCode).toBeUndefined()
    expect(verdict.logRef).toBeUndefined()
    await expect(stat(join(h.checkout, 'dispatch-marker.txt'))).rejects.toThrow()
  })

  it('activates in the same call under policy off, and records the policy on the proposal', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_intake', args: intakeArgs(contractFor(USER_GOAL)) },
          { text: 'root: the goal is accepted' },
        ]
        : [],
    })
    const storeId = rootTaskStoreId(String(ROOT))
    h.userSays(USER_GOAL)

    const answer = await answered(h, 'task_intake')
    expect(answer.result?.isError).toBe(false)
    expect(answer.result?.text).toContain('activated the root contract')

    // The audit record is the policy itself: no decision, no ask, and the root is
    // live in the same call (A0 §1.3).
    expect(h.review.asks).toHaveLength(0)
    const proposal = await onlyRootProposal(h, storeId)
    expect(proposal.policy).toBe('off')
    expect(proposal.status).toBe('admitted')
    expect(proposal.decision).toBeUndefined()
    const snapshot = await h.snapshot(storeId)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(consumptionOf(proposal)).toMatchObject({ rootTaskId: snapshot.tasks[0]!.taskId, rootRunId: snapshot.runs[0]!.runId })
    expect((await rootTaskOf(h, storeId)).objective).toBe(USER_GOAL)
    expect(h.spawns).toHaveLength(0)
  })

  it('holds a root contract under policy all: nothing exists until a decision, the reader shows it, and the answer activates it', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_intake', args: intakeArgs(contractFor(USER_GOAL)) },
          // The same turn reads the state back: before the decision, the root has
          // no task and the reader says so, naming the proposal that waits.
          { tool: 'task_read', args: {} },
          { text: 'root: the contract is with the reviewer' },
        ]
        : [],
    })
    const storeId = rootTaskStoreId(String(ROOT))
    h.userSays(USER_GOAL)

    const waiting = await answered(h, 'task_intake')
    expect(waiting.result?.isError).toBe(false)
    expect(waiting.result?.text).toContain('task_intake is waiting for a review')
    expect(waiting.result?.text).toContain('no root task exists')
    const proposalId = proposalIdOf(waiting.result!.text)

    // The person is asked about the contract itself, through the deployment's
    // channel, in the owner session of the store (stage C's rendering).
    const ask = await askAt(h, 0)
    expect(ask.sessionId).toBe(String(ROOT))
    expect(ask.toolName).toBe('task_intake')
    expect(ask.reason).toContain(`Root contract review — proposal ${proposalId} [pending_review] (policy all, trigger: submitted)`)
    expect(ask.reason).toContain(`- objective: ${USER_GOAL}`)
    expect(ask.reason).toContain('- proposal digest (sha256):')

    // Nothing exists: no root task, no run, no worker, and the record says which
    // policy it was born under.
    const before = await h.snapshot(storeId)
    expect(before.tasks).toHaveLength(0)
    expect(before.runs).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    const proposal = await onlyRootProposal(h, storeId)
    expect(proposal.policy).toBe('all')
    expect(proposal.status).toBe('pending_review')
    expect(proposal.decision).toBeUndefined()
    expect(proposal.consumption).toBeUndefined()

    const read = await answered(h, 'task_read')
    expect(read.result?.isError).toBe(false)
    expect(read.result?.text).toContain('not activated')
    expect(read.result?.text).toContain('open proposals:')
    expect(read.result?.text).toContain(`${proposalId} [pending_review] policy all`)
    expect(read.result?.text).toContain('waiting for a review decision; the contract is not a task yet')
    expect(read.result?.text).not.toContain('objective:')

    // The recorded decision is what activates it, and the runtime does the rest
    // by itself — nothing further is asked of the model.
    h.review.answerRoot(0, 'allowed-once')
    const activated = await activatedRoot(h, storeId)
    const admitted = await statusOf(h, storeId, proposalId, 'admitted')
    expect(admitted.decision?.outcome).toBe('approved')
    expect(admitted.decision?.decidedBy).toBe(`approval:${String(ROOT)}`)
    expect(admitted.decision?.proposalDigest).toBe(admitted.proposalDigest)
    expect(admitted.decision?.admissionContextDigest).toBe(admitted.admissionContextDigest)
    expect(admitted.decision?.reviewContextDigest).toBe(admitted.reviewContextDigest)
    expect(consumptionOf(admitted)).toMatchObject({ rootTaskId: activated.taskId, rootRunId: activated.runId })
    const after = await h.snapshot(storeId)
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(after.tasks[0]!.objective).toBe(USER_GOAL)
    expect(h.spawns).toHaveLength(0)
  })

  it('holds a direct service call exactly as the tool does, under policy all', async () => {
    const h = await startScriptedLoop({ generatedTaskReview: 'all', script: () => [] })
    const storeId = rootTaskStoreId(String(ROOT))

    // No tool call anywhere: the service entry a caller reaches directly is the
    // same gate, and it answers the same wait.
    const direct = await h.runtime.intakeRootContract(storeId, String(ROOT), contractFor(USER_GOAL))
    expect(direct.status).toBe('pending_review')
    if (direct.status !== 'pending_review') throw new Error('unreachable')
    const ask = await askAt(h, 0)
    expect(ask.reason).toContain(`proposal ${direct.proposalId}`)
    expect(ask.reason).toContain(`- objective: ${USER_GOAL}`)

    // The continuation is not a way around it: while the decision is outstanding
    // it reports the wait and activates nothing.
    const waiting = await h.runtime.continueProposal(storeId, direct.proposalId, String(ROOT))
    expect(waiting.status).toBe('pending_review')
    const held = await h.snapshot(storeId)
    expect(held.tasks).toHaveLength(0)
    expect(held.runs).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    expect(h.calls.filter(call => call.name === 'task_intake')).toHaveLength(0)

    h.review.answerRoot(0, 'allowed-once')
    const activated = await activatedRoot(h, storeId)
    expect((await statusOf(h, storeId, direct.proposalId, 'admitted')).decision?.outcome).toBe('approved')
    expect(activated.runId).toBeDefined()
    expect((await h.snapshot(storeId)).tasks).toHaveLength(1)
  })

  it('dispatches nothing for a refused draft, and accepts a revision as new content under a supersedes link', async () => {
    // The model-protocol fixture (T3's shape, at the root): the caller's first
    // contract is refused by the review, and it revises — new content, a new
    // request key, `supersedes` naming the refused one — which is then approved
    // and activated.
    //
    // The refusal is read from the store's record here rather than through
    // `task_proposal_read`: that reader resolves the caller's store through its
    // *run*, and a root session has no run until its contract is activated, so the
    // pre-activation read is a boundary this case does not stand on (recorded with
    // the A0 contract notes; the id the caller needs is on its own intake answer).
    const refused = Promise.withResolvers<void>()
    const revisedGoal = 'publish the quarterly alignment report, with the audit appendix'
    const h = await startScriptedLoop({
      generatedTaskReview: 'all',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_intake', args: intakeArgs(contractFor(USER_GOAL)) },
          // The caller waits until the refusal is on the record before it revises.
          { waitFor: () => refused.promise },
          {
            tool: 'task_intake',
            args: calls => intakeArgs(contractFor(revisedGoal), {
              requestKey: 'rk-root-revision-1',
              supersedes: proposalIdOf(resultTextOf(calls, 'task_intake')),
            }),
          },
          { text: 'root: the revision is with the reviewer' },
        ]
        : [],
    })
    const storeId = rootTaskStoreId(String(ROOT))
    h.userSays(USER_GOAL)

    const draftAnswer = await answered(h, 'task_intake', 0)
    const draftId = proposalIdOf(draftAnswer.result!.text)
    const draftAsk = await askAt(h, 0)
    expect(draftAsk.reason).toContain(`- objective: ${USER_GOAL}`)

    // The refusal is a fact on the record, under the channel's own decider.
    h.review.answerRoot(0, 'rejected')
    const rejected = await statusOf(h, storeId, draftId, 'rejected')
    expect(rejected.decision?.outcome).toBe('rejected')
    expect(rejected.decision?.decidedBy).toBe(`approval:${String(ROOT)}`)
    expect(rejected.decision?.reason).toContain('through the approval channel')
    refused.resolve()

    // Zero dispatch for the refused draft: no root task, no run, no worker — and
    // nobody was woken by the refusal.
    const afterRefusal = await h.snapshot(storeId)
    expect(afterRefusal.tasks ?? []).toHaveLength(0)
    expect(afterRefusal.runs ?? []).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
    expect(wakeNotices(h, ROOT)).toEqual([])

    // The refusal the caller revises against is on the record: the channel's own
    // decision, bound to the draft's digest — read here from the store rather than
    // through a reader (see the note above the script).
    expect(rejected.decision?.proposalDigest).toBe(rejected.proposalDigest)
    expect(taskEvents(h, storeId).filter(event => event.kind === 'TaskProposalDecided')).toHaveLength(1)

    const revisionAnswer = await answered(h, 'task_intake', 1)
    expect(revisionAnswer.result?.isError).toBe(false)
    expect(revisionAnswer.result?.text).toContain('waiting for a review')
    const revisionId = proposalIdOf(revisionAnswer.result!.text)
    expect(revisionId).not.toBe(draftId)
    const revision = await proposalById(h, storeId, revisionId)
    expect(revision.status).toBe('pending_review')
    expect(revision.supersedes).toBe(draftId)
    expect(revision.requestKey).toBe('rk-root-revision-1')
    expect(revision.proposalDigest).not.toBe(rejected.proposalDigest)

    await askAt(h, 1)
    h.review.answerRoot(1, 'allowed-once')
    const activated = await activatedRoot(h, storeId)

    // The revision became the root; the refused record is exactly as it was — an
    // approval never travels, and a revision never rewrites what it replaces.
    const finished = await h.snapshot(storeId)
    expect(finished.tasks).toHaveLength(1)
    expect(finished.runs).toHaveLength(1)
    expect(finished.tasks[0]!.taskId).toBe(activated.taskId)
    expect(finished.tasks[0]!.objective).toBe(revisedGoal)
    expect(finished.proposals!.byId[draftId]!.status).toBe('rejected')
    expect(finished.proposals!.byId[draftId]!.consumption).toBeUndefined()
    expect(consumptionOf(await proposalById(h, storeId, revisionId))).toMatchObject({ rootTaskId: activated.taskId })
    expect(h.review.rootAsks).toHaveLength(2)
  })

  it('refuses a late intake on a terminal root, from the execution gate and from the store', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0
        ? [
          { text: 'root: the goal is accepted' },
          // The late attempt, on a session whose root run has ended.
          { tool: 'task_intake', args: intakeArgs(contractFor('publish something else entirely')) },
          { text: 'root: the late intake was refused' },
        ]
        : [],
    })
    const root = await h.begin(contractFor(USER_GOAL))
    await h.runtime.cancelGraph(root.storeId, 'the caller ended the graph')
    expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('cancelled')

    // The session's own door: the execution gate refuses the write before the
    // tool runs, naming the phase (A0 §1.8 — `task_intake` is a write action and
    // is not on the coordination list).
    h.userSays('actually, publish something else entirely')
    const late = await answered(h, 'task_intake')
    expect(late.result?.isError).toBe(true)
    expect(late.result?.text).toContain('phase "terminal"')
    expect(late.result?.text).toContain('"task_intake" is denied')

    // And a caller that does not pass the gate is refused by the state: one root
    // per store, and an old root is history.
    await expect(h.runtime.intakeRootContract(root.storeId, String(ROOT), contractFor('publish something else entirely')))
      .rejects.toThrow(/already holds root task/)

    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect((snapshot.proposals?.all ?? []).filter(item => item.kind === 'root')).toHaveLength(1)
    expect((snapshot.proposals?.all ?? [])[0]!.status).toBe('admitted')
    expect(h.spawns).toHaveLength(0)
  })

  it('gives a worker no task_intake and no tool that could decide anything', async () => {
    const h = await startScriptedLoop({
      generatedTaskReview: 'off',
      script: (_sessionId, index) => index === 0 ? decomposeScript('align the ball') : workerScript('aligned the ball'),
    })
    const root = await h.begin(contractFor(USER_GOAL))
    await spawned(h, root.storeId, 1)
    await h.runtime.awaitBatch(root.storeId, await batchIdOf(h, ROOT))
    const worker = h.agent(h.spawns[0]!.sessionId)

    // The intake is the root's own path (A0 §1.9): a worker has a task already
    // and cannot accept one, and nothing on its plane could decide a contract or
    // a proposal — the decision is the review channel's, at the service assembly.
    const names = h.visible(worker)
    expect(names).toContain('task_read')
    expect(names).toContain('task_decompose')
    for (const stripped of [
      'task_intake', 'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve',
      'task_review_pack', 'task_review_agent', 'task_diagnose', 'evolution_propose', 'evolution_decide',
      'evolution_apply', 'escalate',
    ]) {
      expect(names, stripped).not.toContain(stripped)
    }
    expect(names.filter(name => /(decide|approve|admit|grant)/.test(name))).toEqual([])

    // The root's own composition holds it, which is what makes the absence above
    // a property of the worker's grant rather than of the deployment's plane.
    const rootNames = h.visible(h.agent(ROOT))
    expect(rootNames).toContain('task_intake')
    expect(rootNames).toContain('task_decompose')
  })
})

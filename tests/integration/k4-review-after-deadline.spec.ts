import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { REVIEWER_BASELINE } from '../../agent-singularity/src/tools/review-agent.ts'
import { countReviewAgentRuns, admitReviewAgent, readReviewAgentAttempts, readReviewerDelegation } from '../../agent-singularity/src/review-agent-ledger.ts'
import { installReviewAgentAutoTrigger } from '../../agent-singularity/src/review-agent-scan.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

/**
 * K4: a tree that has stopped does not stop a read-only postmortem, and the
 * reviewer's own allowance is the only bound on it.
 *
 * The execution gate is the subject. A root whose tree ran out of budget is
 * terminal in every sense — its run is cancelled, its child settled, no further
 * run may start under the same ceiling — and the gate closes writes for exactly
 * that reason. What it must not close is *looking at* the tree: the review chain
 * (`task_review_pack` → `task_review_agent`) reads the record and publishes one
 * read-only node, which is coordination by the gate's own classification
 * (`task-runtime/src/gate.ts:COORDINATION_ALLOWED`).
 *
 * What each case pins:
 *
 * 1. **The real tools, in the terminal phase, on a tree stopped by its own
 *    deadline.** The root's turn is still in flight when the tree's wall time
 *    runs out: the child's run is stopped by the deadline, the batch ends, and
 *    the parent's own run is cancelled with it (`orchestrate.ts:finishBatch`) —
 *    the state K4 names, with the run allowance spent. The root's next calls are
 *    the review, and they must run: a reviewer session is spawned with the
 *    read-only baseline, its own request carries the delegated pack, and its
 *    judgement lands in the store as a Diagnosis. The same phase still denies a
 *    write — the entry is narrow, not an open gate.
 * 2. **No business Run follows the review.** The store's tasks and runs are
 *    where they were before the call: a review agent is a published graph node
 *    (`agent/add` + `edge/add`) and nothing else — never a task, never a run.
 * 3. **The reviewer's own allowance is what stops a reviewer.** With the
 *    per-store ledger already spent, the same call in the same phase spawns
 *    nothing and says why.
 * 4. **The chain is the root's, not any run's.** A worker's own surface never
 *    carries it, whatever the phase the execution gate would judge.
 * 5. **The deadline-stopped tree is accepted automatically (REV-1).** With the
 *    deployment's own triggers armed, the failed review the stopped child leaves
 *    is accepted by the scan with no model call and no tool call at all: one
 *    reviewer, one default attempt, one Diagnosis — and the tree stays as stopped
 *    as it was.
 *
 * Everything but the model's answers is the deployment's own: the real
 * `TaskRuntime` (`ctx.plugin` is what registers its gate on the tool waterfall),
 * the real tool definitions, the real ledger, the real `AgentRuntime.spawn`.
 * The scripts are the model.
 */

const ROOT = 's-root' as SessionId

/** One child spec, in the shape `task_decompose` takes. */
interface ChildSpec {
  objective: string
  acceptanceCriteria: { description: string; command: string }[]
}

/** One child spec: a goal a command settles, so the child is an ordinary admitted task. */
const children = (objective: string): ChildSpec[] => [
  {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
  },
]

/** The root contract every case runs under (A0 §1.2). */
const ROOT_CONTRACT = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/**
 * The tree's whole wall clock and run allowance. The clock is the case's: the
 * child's run starts well inside it and is stopped by it, and the batch that
 * ends afterwards finds the parent's own clock out too. The allowance is exactly
 * the two runs that exist by then — so the tree is *spent* when the review is
 * asked for, which is the state K4 says must not silence the postmortem.
 */
const TREE_WALL_TIME_MS = 1_500
const TREE_RUNS = 2

/** The reviewer's answer: the observation and conclusion it reached, plus the one dimension it judged. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the child run was stopped by the tree wall clock",'
  + '"conclusion":"the objective did not name the environment the work had to run in",'
  + '"confidence":"medium",'
  + '"judgements":[{"dimension":"task_specification","verdict":"inadequate","evidenceRefs":["e-1"],'
  + '"rationale":"the objective did not name the environment the work had to run in"}]}'
  + '\n```'

/** One stopped tree, with the ids the cases assert on. */
interface StoppedTree {
  readonly h: ScriptedLoop
  readonly storeId: string
  readonly rootTaskId: string
  readonly rootRunId: string
  readonly childTaskId: string
  readonly childRunId: string
  readonly childSession: string
  /** Let the root's parked turn continue: its next model answer is the call this spec is about. */
  resumeRoot(): void
}

type Mutable = { -readonly [K in keyof StoppedTree]: StoppedTree[K] }

/** The reviewer spawns of one loop, in order — the automatic postmortem's own nodes. */
function reviewerSpawns(h: ScriptedLoop): readonly { sessionId: string; name: string }[] {
  return h.spawns.filter(spawn => spawn.name.startsWith('review '))
}

beforeEach(() => {
  // The deployment's own ledger (`$DSH_HOME/review-agents`) and its default cap:
  // a developer's environment must not decide what these cases read. An empty
  // value is the ledger's own "not overridden" (`review-agent-ledger.ts`).
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '')
})

afterEach(async () => {
  await disposeScriptedLoops()
})

/**
 * Drive a tree into the state K4 is about: the root decomposes into one child,
 * that child's run hangs until the tree's wall time stops it, and the batch end
 * cancels the parent run at the same instant — both runs terminal, the run
 * allowance spent, and the root session still live with its own turn parked.
 *
 * `tail` names what the root's model does once the tree has stopped. It is asked
 * for those entries *before* the child exists, so anything it reads off `state`
 * has to be read lazily — inside an `args` function, which the adapter calls
 * when the request is really streamed.
 */
async function stopTreeAtItsDeadline(
  tail: (state: StoppedTree) => readonly ScriptEntry[],
  options: {
    readonly probes?: readonly string[]
    readonly reviewer?: readonly ScriptEntry[]
    /**
     * Run once the loop exists and before the tree starts — where a case arms the
     * deployment's own triggers, so what they see is the tree as it settles.
     */
    readonly arm?: (h: ScriptedLoop) => void
  } = {},
): Promise<StoppedTree> {
  const parked = Promise.withResolvers<void>()
  const state = {
    storeId: '', rootTaskId: '', rootRunId: '', childTaskId: '', childRunId: '', childSession: '',
    resumeRoot: () => { parked.resolve() },
  } as Mutable
  const h = await startScriptedLoop({
    rootBudget: { wallTimeMs: TREE_WALL_TIME_MS, maxRuns: TREE_RUNS },
    ...(options.probes === undefined ? {} : { probes: [...options.probes] }),
    script: (_sessionId, index): readonly ScriptEntry[] => index === 0
      ? [
        {
          tool: 'task_decompose',
          args: { reason: 'split the work', children: children('child: the work the clock stops') },
        },
        // The root keeps its turn while its batch runs — a live root mid-task,
        // which is the caller the deadline is about to leave terminal.
        { waitFor: () => parked.promise },
        ...tail(state),
      ]
      // The child never finishes on its own: the tree's own deadline is what
      // stops its run, exactly as a real worker that outlives the budget.
      : index === 1 ? [{ hang: true }] : [...(options.reviewer ?? [{ text: REVIEW_REPLY }])],
  })
  options.arm?.(h)
  const root = await h.begin(ROOT_CONTRACT)
  state.h = h
  state.storeId = root.storeId
  state.rootTaskId = root.taskId
  state.rootRunId = root.runId
  // The child's run really started — the allowance is spent — and it is running
  // when the clock stops it.
  await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
  state.childSession = h.spawns[0]!.sessionId
  await vi.waitFor(async () => expect((await h.runForSession(state.childSession)).run.status).toBe('running'))

  const stopped = await vi.waitFor(async () => {
    const snapshot = await h.snapshot(state.storeId)
    const child = snapshot.tasks.find(task => task.parentTaskId === root.taskId)
    const rootRun = snapshot.runs.find(run => run.runId === root.runId)
    const childRun = child === undefined ? undefined : snapshot.runs.find(run => run.taskId === child.taskId)
    expect(rootRun?.status).toBe('cancelled')
    expect(childRun?.status).toBe('failed')
    return snapshot
  }, { timeout: 30_000, interval: 25 })
  const childTask = stopped.tasks.find(task => task.parentTaskId === root.taskId)!
  state.childTaskId = childTask.taskId
  state.childRunId = stopped.runs.find(run => run.taskId === childTask.taskId)!.runId

  // The state the cases rest on, pinned once: the tree really is spent and
  // stopped, the root session really is terminal to the gate, and the child
  // carries the failed review that is the escalation signal a reviewer is
  // spawned for.
  expect(stopped.runs).toHaveLength(TREE_RUNS)
  expect(stopped.reviews.find(review => review.runId === state.childRunId)?.outcome).toBe('failed')
  expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
  return state as StoppedTree
}

describe('a tree stopped at its budget still takes a read-only postmortem (K4)', () => {
  it('runs the real review chain from the terminal root, and spawns no business Run for it', async () => {
    const stop = await stopTreeAtItsDeadline(state => [
      { tool: 'task_review_pack', args: () => ({ taskId: state.childTaskId, runId: state.childRunId }) },
      { tool: 'task_review_agent', args: () => ({ taskId: state.childTaskId, runId: state.childRunId }) },
      // A write the root's own composition offers, in the same phase: the entry
      // the review travels through is narrow, not an open gate.
      { tool: 'graph_spawn', args: { reason: 'spin up another node' } },
      { text: 'root: the review is on the record' },
    ], { probes: ['graph_spawn'] })
    const { h, storeId } = stop
    const before = await h.snapshot(storeId)
    const graphBefore = h.graphCommits.length
    const spawnsBefore = h.spawns.length

    stop.resumeRoot()
    await vi.waitFor(
      () => expect(h.calls.find(call => call.name === 'task_review_agent')?.result).toBeDefined(),
      { timeout: 30_000, interval: 25 },
    )

    // The pack answered from the stopped store with the facts the review agent
    // exists for — the chain is the deployment's, not a fixture's. (A5 deleted
    // the escalation decision from the pack: what a review agent runs for is a
    // failed review and an explicit call, never a threshold.)
    const pack = h.calls.find(call => call.name === 'task_review_pack')!
    expect(pack.result?.isError).toBe(false)
    expect(pack.result?.text).toContain(`source: review ${stop.childTaskId}#${stop.childRunId} [failed]`)
    expect(pack.result?.text).toContain(stop.childTaskId)
    expect(pack.result?.text).not.toContain('escalation')

    // The review agent itself ran: allowed (not the late call a closed phase
    // gives a write), one reviewer spawned, judgement on the record.
    const review = h.calls.find(call => call.name === 'task_review_agent')!
    expect(review.sessionId).toBe(String(ROOT))
    expect(review.result?.isError).toBe(false)
    expect(review.result?.text).not.toContain('late call')
    expect(review.result?.text).toContain('judged task')
    expect(h.spawns).toHaveLength(spawnsBefore + 1)
    const reviewer = h.spawns.at(-1)!
    const reviewerSession = String(reviewer.sessionId)
    expect(reviewer.name).toBe(`review ${stop.childTaskId}`)
    expect(reviewer.taskWorker).toBeUndefined()
    expect(reviewer.prompt).toContain('--- review pack ---')
    expect(reviewer.prompt).toContain(stop.childTaskId)
    // The reviewer's whole surface is the read-only baseline: nothing it could
    // write, spawn, or evolve with.
    expect(h.visible(h.agent(reviewerSession))).toEqual([...REVIEWER_BASELINE].sort())
    // The delegation the assembly reads is durable in the ledger, written before
    // the reviewer's first request. What that delegation is *rendered* as — the
    // review-only contract injected into the reviewer's own request — is A2's
    // subject and is pinned in `context-assembly.spec.ts`, whose fixture mounts
    // the plugin that publishes this deployment's reviewer binding source; this
    // fixture mounts the review chain itself, so the durable row is the record
    // asserted here.
    expect(await readReviewerDelegation(reviewerSession)).toMatchObject({ rootStoreId: storeId, taskId: stop.childTaskId })

    // The judgement is the store's own record, attributed to that session.
    const after = await h.snapshot(storeId)
    const diagnosis = after.diagnoses.find(item => String(item.producedBy.sessionId) === reviewerSession)!
    expect(diagnosis.taskId).toBe(stop.childTaskId)
    expect(diagnosis.judgements.find(judgement => judgement.dimension === 'task_specification')!.verdict).toBe('inadequate')

    // Publishing the node is the spawn's whole graph effect…
    expect(h.graphCommits.slice(graphBefore).map(commit => commit.kind)).toEqual(['agent/add', 'edge/add'])
    // …and no business Run follows the review: the store holds the same tree it
    // held before the call, with the stopped root and its failed child.
    expect(after.runs).toHaveLength(before.runs.length)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs.find(run => run.runId === stop.rootRunId)!.status).toBe('cancelled')
    expect(after.runs.find(run => run.runId === stop.childRunId)!.status).toBe('failed')

    // The narrow half: the same terminal phase still refuses a write, before its
    // body ever runs.
    const write = h.calls.find(call => call.name === 'graph_spawn')!
    expect(write.sessionId).toBe(String(ROOT))
    expect(write.result?.isError).toBe(true)
    expect(write.result?.text).toContain('phase "terminal"')
    expect(write.result?.text).toContain('late call')
    expect(h.executed.some(name => name.startsWith('graph_spawn'))).toBe(false)
  }, 60_000)

  /**
   * A5 §3, on the real store: the reviewer is the only writer of a Diagnosis,
   * and a reviewer that never answers writes none. Silence is never turned into
   * six `unknown` judgements — the attempt is settled `interrupted` with the
   * reason named, and the source does not read as reviewed.
   */
  it('records an interrupted attempt and no Diagnosis when the reviewer never answers', async () => {
    const stop = await stopTreeAtItsDeadline(state => [
      { tool: 'task_review_agent', args: () => ({ taskId: state.childTaskId, runId: state.childRunId, timeoutMs: 5 }) },
      { text: 'root: the review was asked for' },
    ], { reviewer: [{ hang: true }] })
    const before = await stop.h.snapshot(stop.storeId)

    stop.resumeRoot()
    await vi.waitFor(
      () => expect(stop.h.calls.find(call => call.name === 'task_review_agent')?.result).toBeDefined(),
      { timeout: 30_000, interval: 25 },
    )

    const review = stop.h.calls.find(call => call.name === 'task_review_agent')!
    expect(review.result?.isError).toBe(false)
    expect(review.result?.text).toContain('timed out')
    expect(review.result?.text).toContain('no diagnosis')

    // The store holds exactly the diagnoses it held before: the reviewer never
    // reached one, so none is invented for it.
    expect((await stop.h.snapshot(stop.storeId)).diagnoses).toEqual(before.diagnoses)
    // The attempt is terminal, with the reason on the fact.
    const attempts = await readReviewAgentAttempts(stop.storeId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.settlement?.status).toBe('interrupted')
    expect(String(attempts[0]!.settlement?.note)).toContain('timed out')
  }, 60_000)

  it('accepts the failed source on its own after the deadline stopped the tree: no tool call, one reviewer, one attempt (REV-1)', async () => {
    const lines: string[] = []
    const stop = await stopTreeAtItsDeadline(() => [{ text: 'root: nothing to add' }], {
      reviewer: [{ text: REVIEW_REPLY }],
      // The deployment's own two triggers, armed before the tree runs: the
      // terminal review of the stopped child is what wakes the scan.
      arm: h => installReviewAgentAutoTrigger(h.ctx, { log: line => lines.push(line) }),
    })
    const { h, storeId } = stop
    const runsBefore = (await h.snapshot(storeId)).runs.length

    // No model call and no tool call asked for this: the failed review was
    // accepted under the store's own allowance the moment it was recorded.
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    expect(reviewerSpawns(h)[0]!.name).toBe(`review ${stop.childTaskId}`)

    // The source's one default attempt: claimed, started, and attributed to the
    // graph's own root — the parent a reviewer is spawned from.
    const attempt = await vi.waitFor(async () => {
      const found = await readReviewAgentAttempts(storeId)
      expect(found).toHaveLength(1)
      return found[0]!
    }, { timeout: 30_000, interval: 25 })
    expect(attempt).toMatchObject({
      source: { taskId: stop.childTaskId, runId: stop.childRunId },
      requestKey: null,
      reason: null,
      actor: String(ROOT),
      sessionId: reviewer,
      started: true,
    })
    expect(await countReviewAgentRuns(storeId)).toBe(1)
    // The delegation the assembly would read is durable before the reviewer's
    // first request, exactly as an explicit call's is.
    expect(await readReviewerDelegation(reviewer)).toMatchObject({ rootStoreId: storeId, taskId: stop.childTaskId })

    // The judgement landed in the store, attributed to that reviewer.
    await vi.waitFor(async () => {
      const after = await h.snapshot(storeId)
      expect(after.diagnoses.some(item => String(item.producedBy.sessionId) === reviewer)).toBe(true)
    }, { timeout: 30_000, interval: 25 })
    const diagnosis = (await h.snapshot(storeId)).diagnoses.find(item => String(item.producedBy.sessionId) === reviewer)!
    expect(diagnosis.taskId).toBe(stop.childTaskId)

    // The stopped tree is exactly as stopped as it was: the automatic postmortem
    // took no second business Run and left the root's phase terminal.
    const after = await h.snapshot(storeId)
    expect(after.runs).toHaveLength(runsBefore)
    expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
    expect(lines.join('\n')).toContain(stop.childTaskId)

    stop.resumeRoot()
  }, 60_000)

  it('spawns no reviewer once the store\'s review allowance is spent, and says so in the same phase', async () => {
    const stop = await stopTreeAtItsDeadline(state => [
      { tool: 'task_review_agent', args: () => ({ taskId: state.childTaskId, runId: state.childRunId }) },
      { text: 'root: the review was refused' },
    ])
    // The ledger the deployment reads, spent: one review agent already started
    // for this root store (the row an earlier call — this process's or another's
    // — wrote, through the admission that owns the write). The allowance's
    // default is one per store.
    await admitReviewAgent(stop.storeId, admission =>
      admission.start({ taskId: 'an-earlier-task', sessionId: 's-earlier-review', actor: String(ROOT) }))
    const spawnsBefore = stop.h.spawns.length
    const graphBefore = stop.h.graphCommits.length

    stop.resumeRoot()
    await vi.waitFor(
      () => expect(stop.h.calls.find(call => call.name === 'task_review_agent')?.result).toBeDefined(),
      { timeout: 30_000, interval: 25 },
    )

    const review = stop.h.calls.find(call => call.name === 'task_review_agent')!
    // The call is admitted — the phase is not what stops it — and the reviewer's
    // own budget is what refuses it, by name.
    expect(review.result?.isError).toBe(false)
    expect(review.result?.text).toContain('budget exhausted')
    expect(review.result?.text).toContain('no review agent started')
    expect(stop.h.spawns).toHaveLength(spawnsBefore)
    expect(stop.h.graphCommits).toHaveLength(graphBefore)
    expect((await stop.h.snapshot(stop.storeId)).diagnoses).toEqual([])
  }, 60_000)

  it('leaves the review chain off a worker\'s surface, whatever the phase would judge', async () => {
    const stop = await stopTreeAtItsDeadline(() => [{ text: 'root: nothing to add' }])
    for (const name of ['task_review_pack', 'task_review_agent', 'task_diagnose']) {
      expect(stop.h.visible(stop.h.agent(stop.childSession)), name).not.toContain(name)
      expect(stop.h.visible(stop.h.agent(ROOT)), name).toContain(name)
    }
    // The terminal root may read (it holds the chain); the worker beside it
    // cannot, and that is a property of the grant, not of the phase — the two
    // sessions were judged under the same stopped tree.
    expect(stop.h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
    stop.resumeRoot()
  }, 60_000)
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { resolveRootBudget } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop, type ScriptedReviewAsk } from '../support/scripted-loop.ts'

/**
 * K4: the terminal root session is the one that may ask a person to raise the
 * tree's own ceilings — and the person is the only thing that can raise them.
 *
 * What each case pins:
 *
 * 1. **The entry survives the phase.** A stopped tree with its run allowance spent and
 *    run allowance is terminal in every sense, and the gate closes writes for
 *    exactly that reason. `task_budget_extend` has to run anyway: the root
 *    session that spent its budget is the caller K4 exists for. The call is not
 *    a late call, it records one durable fact — under the *call's own* identity,
 *    `approval:<callId>`, which is an audit reference and never the channel's
 *    fresh uuid or a credential — and the ceiling every admission reads moves
 *    with it.
 * 2. **The person is asked, and nothing happens before they answer.** The call
 *    is in flight while the ask waits on the desk: the store holds no extension,
 *    no run starts, no node appears. The card names the store, both ceilings,
 *    the runs used and the totals, and carries no approval binding — nothing on
 *    it stands in for the person's answer. Only the approval moves anything.
 * 3. **A rejection or a cancellation writes nothing.** Same store, same runs,
 *    same ceilings — the call ends with a refusal and an unchanged tree.
 * 4. **A repeated request is answered from the record.** The same key with the
 *    same totals asks nobody a second time and appends nothing.
 * 5. **The entry is narrow.** The same terminal phase still refuses a business
 *    write (`graph_spawn`, probed), and a worker's own surface never carries the
 *    tool.
 *
 * Everything but the model's answers is the deployment's own: the real
 * `TaskRuntime` (its gate is registered through `ctx.plugin`), the real
 * `task_budget_extend` definition, the deployment's own root-budget approval
 * (installed on the runtime at mount from `defineRootBudgetApproval`), the real
 * store, and the review desk as the person — the fixture holds an ask until the
 * spec answers it.
 */

const ROOT = 's-root' as SessionId

/** One child spec, in the shape `task_decompose` takes. */
interface ChildSpec {
  objective: string
  acceptanceCriteria: { description: string; command: string }[]
}

const children = (objective: string): ChildSpec[] => [
  {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
  },
]

/** The root contract every case runs under (A0 §1.2). */
const ROOT_CONTRACT = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** The root and one child spend the entire run allowance. */
const TREE_RUNS = 2
const ROOT_BUDGET = { maxRuns: TREE_RUNS }

/** One stopped tree, with the ids the cases assert on. */
interface StoppedTree {
  readonly h: ScriptedLoop
  readonly storeId: string
  readonly rootTaskId: string
  readonly rootRunId: string
  readonly childTaskId: string
  readonly childRunId: string
  readonly childSession: string
  readonly childTools: readonly string[]
  /** Let the root's parked turn continue: its next model answer is the call this spec is about. */
  resumeRoot(): void
}

type Mutable = { -readonly [K in keyof StoppedTree]: StoppedTree[K] }

beforeEach(() => {
  // The deployment's own ledger (`$DSH_HOME/review-agents`) and its default cap:
  // a developer's environment must not decide what these cases read.
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '')
})

afterEach(async () => {
  await disposeScriptedLoops()
})

/**
 * Drive root and child Runs into explicit cancellation with the run allowance
 * spent. The root Session keeps its parked turn so the approval tool can be used.
 *
 * `tail` names what the root's model does once the tree has stopped. It is asked
 * for those entries *before* the child exists, so anything it reads off `state`
 * has to be read lazily — inside an `args` function, which the adapter calls
 * when the request is really streamed.
 */
async function stopSpentTree(
  tail: (state: StoppedTree) => readonly ScriptEntry[],
  options: { readonly probes?: readonly string[] } = {},
): Promise<StoppedTree> {
  const parked = Promise.withResolvers<void>()
  const state = {
    storeId: '', rootTaskId: '', rootRunId: '', childTaskId: '', childRunId: '', childSession: '', childTools: [],
    resumeRoot: () => { parked.resolve() },
  } as Mutable
  const h = await startScriptedLoop({
    rootBudget: { ...ROOT_BUDGET },
    // The real approval service: what makes this an extension is the record its
    // ask and decision leave on the root session's log, so these cases ask the
    // person through the deployment's own channel, not a stand-in.
    approvalService: 'native',
    ...(options.probes === undefined ? {} : { probes: [...options.probes] }),
    script: (_sessionId, index): readonly ScriptEntry[] => index === 0
      ? [
        {
          tool: 'task_decompose',
          args: { reason: 'split the work', children: children('child: explicitly stopped work') },
        },
        { waitFor: () => parked.promise },
        ...tail(state),
      ]
      : index === 1 ? [{ hang: true }] : [{ text: 'unused' }],
  })
  const root = await h.begin(ROOT_CONTRACT)
  state.h = h
  state.storeId = root.storeId
  state.rootTaskId = root.taskId
  state.rootRunId = root.runId
  await vi.waitFor(() => expect(h.spawns).toHaveLength(1))
  state.childSession = h.spawns[0]!.sessionId
  await vi.waitFor(async () => expect((await h.runForSession(state.childSession)).run.status).toBe('running'))
  await vi.waitFor(() => { state.childTools = h.visible(h.agent(state.childSession)) })

  await h.runtime.cancelGraph(state.storeId, 'explicit stop with the run allowance spent')
  const stopped = await vi.waitFor(async () => {
    const snapshot = await h.snapshot(state.storeId)
    const child = snapshot.tasks.find(task => task.parentTaskId === root.taskId)
    const rootRun = snapshot.runs.find(run => run.runId === root.runId)
    const childRun = child === undefined ? undefined : snapshot.runs.find(run => run.taskId === child.taskId)
    expect(rootRun?.status).toBe('cancelled')
    expect(childRun?.status).toBe('cancelled')
    return snapshot
  }, { timeout: 30_000, interval: 25 })
  const childTask = stopped.tasks.find(task => task.parentTaskId === root.taskId)!
  state.childTaskId = childTask.taskId
  state.childRunId = stopped.runs.find(run => run.taskId === childTask.taskId)!.runId

  // The state the cases rest on, pinned once: the tree really is spent and
  // stopped, and the root session really is terminal to the gate.
  expect(stopped.runs).toHaveLength(TREE_RUNS)
  expect(h.runtime.gate.phaseOf(ROOT)).toBe('terminal')
  return state as StoppedTree
}

/** The budget-extension asks this deployment made, in ask order — the desk's own index of them. */
function extensionAsks(h: ScriptedLoop): readonly ScriptedReviewAsk[] {
  return h.review.budgetAsks
}

/**
 * Wait for the `ordinal`-th budget-extension ask to reach the desk and return
 * it. The tool is in flight until {@link decide} answers the ask, which is what
 * lets a case assert what the tree looks like while the person is thinking.
 *
 * A call that never reaches the desk is reported with what the deployment said
 * about it: a refused or denied call is the subject of a counterexample, and its
 * own text is the evidence.
 */
async function extensionAsk(h: ScriptedLoop, ordinal: number): Promise<ScriptedReviewAsk> {
  try {
    await vi.waitFor(
      () => expect(extensionAsks(h)).toHaveLength(ordinal + 1),
      { timeout: 15_000, interval: 25 },
    )
  } catch (error) {
    const call = h.calls.find(item => item.name === 'task_budget_extend')
    throw new Error(
      `no budget-extension ask ${ordinal} reached the desk (${extensionAsks(h).length} ask(s)); the call reported: ` +
      `${call === undefined ? 'no task_budget_extend call was dispatched' : call.result?.text ?? 'no result yet'} ` +
      `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return extensionAsks(h)[ordinal]!
}

/** Answer the `ordinal`-th ask — the person deciding, through the desk's own budget-ask index. */
function decide(h: ScriptedLoop, ordinal: number, outcome: ApprovalOutcome): void {
  h.review.answerBudget(ordinal, outcome)
}

/** Wait for the `ordinal`-th `task_budget_extend` call of this run to report its result. */
async function extensionCall(h: ScriptedLoop, ordinal: number) {
  await vi.waitFor(() => {
    expect(h.calls.filter(call => call.name === 'task_budget_extend' && call.result !== undefined).length)
      .toBeGreaterThanOrEqual(ordinal + 1)
  }, { timeout: 15_000, interval: 25 })
  return h.calls.filter(call => call.name === 'task_budget_extend')[ordinal]!
}

describe('a stopped tree with a spent run allowance can still be extended by a person (K4)', () => {
  it('extends the ceiling from the terminal root, records the approved fact, and answers a retry from the record', async () => {
    const stop = await stopSpentTree(state => [
      { tool: 'task_budget_extend', args: { requestKey: 'k-more-runs', maxRuns: 4 } },
      { tool: 'task_budget_extend', args: { requestKey: 'k-more-runs', maxRuns: 4 } },
      // A write the root's own composition offers, in the same phase: the entry
      // the extension travels through is narrow, not an open gate.
      { tool: 'graph_spawn', args: { reason: 'spin up another node' } },
      { text: 'root: the ceiling was raised by a person' },
    ], { probes: ['graph_spawn'] })
    const { h, storeId } = stop
    const before = await h.snapshot(storeId)
    const spawnsBefore = h.spawns.length
    const graphBefore = h.graphCommits.length

    stop.resumeRoot()
    // Nothing moves while the person is deciding: the ask is held on the desk,
    // the store holds no extension, and no run has started.
    const ask = await extensionAsk(h, 0)
    expect(ask.sessionId).toBe(String(ROOT))
    expect((await h.snapshot(storeId)).budgetExtensions?.all).toEqual([])
    expect((await h.snapshot(storeId)).runs).toHaveLength(before.runs.length)

    // The card a person decides from: which store and tree, the whole ceiling in
    // force (both dimensions, the one this request names *and* the one it leaves
    // alone) beside the ceiling the deployment configured, the runs already used,
    // the total this approval would put in place, and what an approval does not
    // do. The one thing it does not carry is a binding: the decision is the
    // channel's own answer, and nothing on the card stands in for it.
    expect(ask.reason).toContain(`store "${storeId}"`)
    expect(ask.reason).toContain(`root task ${stop.rootTaskId}`)
    expect(ask.reason).toContain(`root coordination session ${String(ROOT)}`)
    expect(ask.reason).toContain('request key "k-more-runs"')
    expect(ask.reason).toContain(`runs the store already holds: ${TREE_RUNS}`)
    expect(ask.reason).toContain(`maxRuns: ${TREE_RUNS} in force (deployment configures ${TREE_RUNS}) → approves a total of 4`)
    expect(ask.reason).not.toContain('deadlineAt: ')
    expect(ask.reason).not.toContain('approval binding')
    expect(ask.reason).toContain('approving records ONE budget-extension event')
    expect(ask.reason).toContain('no run starts or resumes')

    decide(h, 0, 'allowed-once')

    const first = await extensionCall(h, 0)
    expect(first.sessionId).toBe(String(ROOT))
    expect(first.result?.isError).toBe(false)
    expect(first.result?.text).not.toContain('late call')
    expect(first.result?.text).toContain(`approved and recorded on store "${storeId}"`)
    expect(first.result?.text).toContain('- maxRuns: 2 → 4')

    // The approval the record stands on is the channel's own audit: the ask and
    // its decision on the root session's log, the same `ApprovalRequestId`. The
    // call the question was asked under is the host's own — the tool call this
    // ran as — and the record's reference is that identity, never the channel's
    // fresh uuid: `approval:<callId>` is an audit reference of the call, and the
    // channel's own id is not something anything here reads back.
    const audit = h.eventsOf(ROOT).filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
      .map(event => event.data as { id: string; toolName?: string; callId?: string; reason?: string; outcome?: string })
    const asked = audit.find(entry => entry.toolName === 'task_budget_extend')
    const decided = audit.find(entry => entry.outcome !== undefined)
    expect(asked?.callId).toBe(first.callId)
    expect(asked?.reason).not.toContain('approval binding')
    expect(decided).toEqual({ id: asked?.id, outcome: 'allowed-once' })
    expect(first.result?.text).toContain(`approval on the record: approval:${String(first.callId)}`)
    expect(first.result?.text).not.toContain(`approval:${String(asked?.id)}`)

    // The durable fact is the store's: one extension, one event, the call's own
    // reference, the root session that asked, and the raises as approved.
    const granted = await h.snapshot(storeId)
    expect(granted.budgetExtensions?.all).toHaveLength(1)
    // And the store's own log holds exactly one such fact: the approval appended
    // one event and nothing else.
    const budgetEvents = h.eventsOf(storeId).flatMap(event =>
      event.type === 'task/event' ? [(event.data as unknown as { kind: string }).kind] : [])
    expect(budgetEvents.filter(kind => kind === 'TaskBudgetExtended')).toHaveLength(1)
    expect(granted.budgetExtensions?.byRequestKey['k-more-runs']).toMatchObject({
      requestKey: 'k-more-runs',
      maxRuns: { previous: TREE_RUNS, next: 4 },
      requestedBy: String(ROOT),
    })
    expect(granted.budgetExtensions?.byRequestKey['k-more-runs']?.approvalRef).toBe(`approval:${String(first.callId)}`)
    // The ceiling every admission, driver and watchdog path resolves is now the
    // approved total — read through the deployment's own resolver.
    const resolution = resolveRootBudget(granted, ROOT_BUDGET)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('unreachable')
    expect(resolution.maxRuns).toBe(4)
    expect(resolution.configured.maxRuns).toBe(TREE_RUNS)

    // The retry under the same key is answered from the record: no second ask,
    // no second event, the same single extension.
    const second = await extensionCall(h, 1)
    expect(second.result?.isError).toBe(false)
    expect(second.result?.text).toContain('already recorded')
    expect(second.result?.text).toContain('no human was asked and nothing was appended')
    expect(extensionAsks(h)).toHaveLength(1)
    expect((await h.snapshot(storeId)).budgetExtensions?.all).toHaveLength(1)

    // And the extension is not work: no run, no task, no node, no spawn.
    const after = await h.snapshot(storeId)
    expect(after.runs).toHaveLength(before.runs.length)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs.find(run => run.runId === stop.rootRunId)!.status).toBe('cancelled')
    expect(after.runs.find(run => run.runId === stop.childRunId)!.status).toBe('cancelled')
    expect(h.spawns).toHaveLength(spawnsBefore)
    expect(h.graphCommits).toHaveLength(graphBefore)
    // Field by field, on a tree the gate has already closed: every run, task,
    // edge, evidence and review record is what it was before the call — the one
    // thing the approval added is the extension record itself, and nothing was
    // woken, re-opened or cleared.
    expect({ ...after, budgetExtensions: before.budgetExtensions }).toEqual(before)

    // The narrow half: the same terminal phase still refuses a business write,
    // before its body ever runs. The root's tail reaches that call last, so the
    // assertion waits for it to be dispatched before reading what it answered.
    await vi.waitFor(() => expect(h.calls.some(call => call.name === 'graph_spawn')).toBe(true), { timeout: 15_000, interval: 25 })
    const write = h.calls.find(call => call.name === 'graph_spawn')!
    expect(write.sessionId).toBe(String(ROOT))
    expect(write.result?.isError).toBe(true)
    expect(write.result?.text).toContain('phase "terminal"')
    expect(write.result?.text).toContain('late call')
    expect(h.executed.some(name => name.startsWith('graph_spawn'))).toBe(false)

    // The tool is the root's surface, never a worker's.
    expect(h.visible(h.agent(ROOT))).toContain('task_budget_extend')
    expect(stop.childTools).not.toContain('task_budget_extend')
  }, 60_000)

  it.each(['rejected', 'cancelled'] as const)(
    'writes nothing when the person answers %s, and keeps the tree where it was',
    async outcome => {
      const stop = await stopSpentTree(() => [
        { tool: 'task_budget_extend', args: { requestKey: 'k-more-runs', maxRuns: 4 } },
        { text: 'root: the raise was not approved' },
      ])
      const { h, storeId } = stop
      const before = await h.snapshot(storeId)
      const spawnsBefore = h.spawns.length
      const graphBefore = h.graphCommits.length

      stop.resumeRoot()
      await extensionAsk(h, 0)
      decide(h, 0, outcome)
      const call = await extensionCall(h, 0)

      expect(call.result?.isError).toBe(false)
      expect(call.result?.text).toContain('task_budget_extend rejected')
      expect(call.result?.text).toContain('the ceilings are unchanged')
      expect(call.result?.text).toContain(outcome === 'rejected' ? 'the human rejected it' : 'the question was cancelled before the human answered it')

      // Zero budget facts, zero runs, zero nodes: the tree is exactly what it
      // was before the call, with the allowance still spent.
      const after = await h.snapshot(storeId)
      expect(after.budgetExtensions?.all).toEqual([])
      expect(after.runs).toHaveLength(before.runs.length)
      expect(after.tasks).toHaveLength(before.tasks.length)
      expect(h.spawns).toHaveLength(spawnsBefore)
      expect(h.graphCommits).toHaveLength(graphBefore)
      const resolution = resolveRootBudget(after, ROOT_BUDGET)
      expect(resolution.ok).toBe(true)
      if (!resolution.ok) throw new Error('unreachable')
      expect(resolution.maxRuns).toBe(TREE_RUNS)
    }, 60_000)
})

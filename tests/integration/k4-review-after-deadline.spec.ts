import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { REVIEWER_BASELINE } from '../../agent-singularity/src/tools/review-agent.ts'
import {
  countReviewAgentRuns,
  admitReviewAgent,
  readReviewAgentAttempts,
  readReviewerDelegation,
} from '../../agent-singularity/src/coordination/ledger.ts'
import { installReviewAgentAutoTrigger } from '../../agent-singularity/src/coordination/review-scan.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

/**
 * A terminal tree still admits its read-only review chain. Explicit graph
 * cancellation closes the business runs; the review allowance counts reviewer
 * starts, while the reviewer waits for its own completion or cancellation.
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
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: `${objective} works`, command: 'false' }],
  },
]

/** The root contract every case runs under (A0 §1.2). */
const ROOT_CONTRACT = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

const TREE_RUNS = 2

/** The reviewer's answer: the observation and conclusion it reached, plus the one dimension it judged. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the child run failed its required command",'
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
  vi.useRealTimers()
  await disposeScriptedLoops()
})

/** Fail a child through the real submission path, then explicitly cancel its root. */
async function stopTreeWithFailedChild(
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
  let h!: ScriptedLoop
  const reviewSourceReply = () => {
    const prompt = h.spawns.find(spawn => spawn.name.startsWith('review '))!.prompt
    const source = /source: review ([^ \n]+)/.exec(prompt)![1]!
    return REVIEW_REPLY.replace('"e-1"', JSON.stringify(source))
  }
  h = await startScriptedLoop({
    rootBudget: { maxRuns: TREE_RUNS },
    ...(options.probes === undefined ? {} : { probes: [...options.probes] }),
    script: (_sessionId, index): readonly ScriptEntry[] => index === 0
      ? [
        {
          tool: 'task_decompose',
          args: { reason: 'split the work', children: children('child: the result whose check fails') },
        },
        // Keep the root turn parked while its child fails and its run is cancelled.
        { waitFor: () => parked.promise },
        ...tail(state),
      ]
      : index === 1
        ? [{ tool: 'task_submit_result', args: { summary: 'the requested result failed its required check' } }, { text: 'child: check failed' }]
        : [
          ...(options.reviewer ?? [{ text: REVIEW_REPLY }]).map(entry =>
            'text' in entry && entry.text === REVIEW_REPLY ? { text: reviewSourceReply() } : entry),
        ],
  })
  options.arm?.(h)
  const root = await h.begin(ROOT_CONTRACT)
  state.h = h
  state.storeId = root.storeId
  state.rootTaskId = root.taskId
  state.rootRunId = root.runId
  await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThanOrEqual(1))
  state.childSession = h.spawns[0]!.sessionId
  await vi.waitFor(async () => expect((await h.runForSession(state.childSession)).run.status).toBe('failed'))
  await vi.waitFor(() => expect(h.runtime.gate.phaseOf(ROOT)).toBe('active'))
  await h.runtime.cancelGraph(root.storeId, 'the user stopped the tree after the failed child')

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
    const stop = await stopTreeWithFailedChild(state => [
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
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = reviewerSpawns(h)[0]!
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
    // Ordinary child diagnoses stay with the responsible parent; no supervisor is spent.
    expect(h.spawns.filter(spawn => String(spawn.name ?? '').startsWith('supervisor for '))).toEqual([])

    // Publishing the node is each spawn's whole graph effect…
    expect(h.graphCommits.slice(graphBefore).map(commit => commit.kind)).toEqual(['agent/add', 'edge/add'])
    // …and no business Run follows the review: the store holds the same tree it
    // held before the call, with the stopped root and its failed child.
    expect(after.runs).toHaveLength(before.runs.length)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs.find(run => run.runId === stop.rootRunId)!.status).toBe('cancelled')
    expect(after.runs.find(run => run.runId === stop.childRunId)!.status).toBe('failed')

    // The narrow half: the same terminal phase still refuses a write, before its
    // body ever runs.
    await vi.waitFor(() => expect(h.calls.find(call => call.name === 'graph_spawn')?.result).toBeDefined())
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
  it('waits past the former reviewer deadline without a Diagnosis, then cleans up an explicit cancellation', async () => {
    const stop = await stopTreeWithFailedChild(state => [
      { tool: 'task_review_agent', args: () => ({ taskId: state.childTaskId, runId: state.childRunId }) },
      { text: 'root: the review was asked for' },
    ], { reviewer: [{ hang: true }] })
    const before = await stop.h.snapshot(stop.storeId)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stop.resumeRoot()
    await vi.waitFor(() => expect(reviewerSpawns(stop.h)).toHaveLength(1))
    const reviewerId = String(reviewerSpawns(stop.h)[0]!.sessionId)
    await vi.waitFor(() => expect(stop.h.agent(reviewerId).status).toBe('running'))
    await vi.advanceTimersByTimeAsync(600_001)
    expect(stop.h.calls.find(call => call.name === 'task_review_agent')?.result).toBeUndefined()
    expect(stop.h.agent(reviewerId).status).toBe('running')
    expect((await readReviewAgentAttempts(stop.storeId))[0]!.settlement).toBeUndefined()
    expect((await stop.h.snapshot(stop.storeId)).diagnoses).toEqual(before.diagnoses)
    vi.useRealTimers()

    stop.h.agent(reviewerId).cancel({ kind: 'parent' })
    await vi.waitFor(
      () => expect(stop.h.calls.find(call => call.name === 'task_review_agent')?.result).toBeDefined(),
      { timeout: 30_000, interval: 25 },
    )

    const review = stop.h.calls.find(call => call.name === 'task_review_agent')!
    expect(review.result?.isError).toBe(false)
    expect(review.result?.text).toContain('no parseable json object')
    expect(review.result?.text).toContain('no diagnosis')

    // The store holds exactly the diagnoses it held before: the reviewer never
    // reached one, so none is invented for it.
    expect((await stop.h.snapshot(stop.storeId)).diagnoses).toEqual(before.diagnoses)
    // The attempt is terminal, with the reason on the fact.
    const attempts = await readReviewAgentAttempts(stop.storeId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.settlement?.status).toBe('interrupted')
    expect(String(attempts[0]!.settlement?.note)).toContain('no parseable json object')
    expect(await countReviewAgentRuns(stop.storeId)).toBe(1)
    expect(stop.h.agent(reviewerId).status).toBe('idle')
  }, 60_000)

  it('accepts the failed source on its own on the explicitly stopped tree: no tool call, one reviewer, one attempt (REV-1)', async () => {
    const lines: string[] = []
    const stop = await stopTreeWithFailedChild(() => [{ text: 'root: nothing to add' }], {
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
    // graph's own root — the parent a reviewer is spawned from. The child diagnosis
    // is delivered to its real parent without a supervisor attempt.
    const attempt = await vi.waitFor(async () => {
      const found = (await readReviewAgentAttempts(storeId)).filter(item => item.role === 'reviewer')
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
    expect(h.spawns.filter(spawn => String(spawn.name ?? '').startsWith('supervisor for '))).toEqual([])
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
    // The shipped allowance is eight attempts per store; this case names one, so
    // the tree's own failed review (accepted on its own) leaves the ceiling
    // spent before the explicit call arrives.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '1')
    const stop = await stopTreeWithFailedChild(state => [
      { tool: 'task_review_agent', args: () => ({ taskId: state.childTaskId, runId: state.childRunId }) },
      { text: 'root: the review was refused' },
    ])
    // The ledger the deployment reads, spent: one review agent already started
    // for this root store (the row an earlier call — this process's or another's
    // — wrote, through the admission that owns the write).
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
    const stop = await stopTreeWithFailedChild(() => [{ text: 'root: nothing to add' }])
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

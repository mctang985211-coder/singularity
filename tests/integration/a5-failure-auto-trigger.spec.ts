import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  countReviewAgentRuns,
  readReviewAgentAttempts,
  reviewAgentLedgerFile,
} from '../../agent-singularity/src/coordination/ledger.ts'
import {
  installReviewAgentAutoTrigger,
  scanFailedReviewSources,
} from '../../agent-singularity/src/coordination/review-scan.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptEntry,
  type ScriptedLoop,
  type SupervisionOptions,
} from '../support/scripted-loop.ts'

/**
 * A5: the two triggers and the first request.
 *
 * The contract these cases are the evidence for:
 *
 * 1. Failed reviews are accepted automatically. Successes require explicit
 *    `autoReview: 'all'` or a review call. Ordinary child diagnoses go to their
 *    recorded delegating parent; only shared changes consume a supervisor.
 * 2. **The settlement does not wait for the reviewer.** The review record is
 *    written inside the terminal transition; the acceptance happens after it, on
 *    the reviewer's own time — so the batch settles and the store is final while
 *    the reviewer is still out there. A reviewer that cannot even claim (an
 *    unwritable ledger) changes nothing about the settlement.
 * 3. **The first request is inspectable.** What the reviewer's own first model
 *    request carries is asserted here from the scripted adapter's record of the
 *    request: the source, its real outcome, and the pack it judges from.
 * 4. **One source, one attempt.** An explicit call after the automatic one shares
 *    that attempt — one claim, one session, no second spawn.
 * 5. **A graph activation rescans.** A source the automatic trigger had to skip
 *    is started by the activation scan, and a source that already has an attempt
 *    is only read.
 *
 * The scripted loop is the deployment minus its plugin: the real tools, the real
 * store, runtime, verifier and model loop, with the model scripted — so the
 * assertions rest on the deployment's own writes. The assembly stack below
 * mounts the plugin itself, which is what proves the two triggers are installed
 * by the deployment's own composition rather than by a spec.
 */

const ROOT = 's-root' as SessionId

/** The root contract every case runs under. */
const ROOT_CONTRACT = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** One child whose own criterion a command settles — the shape the failing/verified cases differ in. */
function child(objective: string, command: string): Record<string, unknown> {
  return { objective, acceptanceCriteria: [{ description: `${objective} works`, command }] }
}

/** The reviewer's answer: the observation and conclusion it reached, plus the one dimension it judged. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the child failed its mandatory criterion",'
  + '"conclusion":"ev-1: the objective omitted the environment; use task_decompose after the batch settles for one child with a pinned environment",'
  + '"confidence":"medium",'
  + '"judgements":[{"dimension":"task_specification","verdict":"inadequate","evidenceRefs":["ev-1"],'
  + '"rationale":"the objective did not name the environment the work had to run in"}]}'
  + '\n```'

/** The facts a case reads back out of the tree it drove. */
interface Tree {
  childTaskId: string
  childRunId: string
  /** The batch the root run opened — read while it is still the run's current batch. */
  batchId: string
}

/** The reviewer spawns of one loop, in order. */
function reviewerSpawns(h: ScriptedLoop): readonly { sessionId: string; name: string }[] {
  return h.spawns.filter(spawn => spawn.name.startsWith('review '))
}

/** Supervisor spawns for shared changes. */
function supervisorSpawns(h: ScriptedLoop): readonly { sessionId: string; name: string }[] {
  return h.spawns.filter(spawn => spawn.name.startsWith('supervisor for '))
}

/** Review attempts alone; shared-change supervisors have separate ledger rows. */
async function reviewerAttempts(storeId: string) {
  return (await readReviewAgentAttempts(storeId)).filter(attempt => attempt.role === 'reviewer')
}

/** One store's failed review of one task, once the terminal transition has written it. */
async function failedReviewOf(h: ScriptedLoop, storeId: string, taskId: string): Promise<void> {
  await vi.waitFor(async () => {
    const snapshot = await h.snapshot(storeId)
    expect(snapshot.reviews.find(review => review.taskId === taskId)?.outcome).toBe('failed')
  }, { timeout: 30_000, interval: 25 })
}

/**
 * Dispatch one tool call as the root agent with **no model request at all**:
 * the deployment's own registry and the runtime's own gate are what the call
 * travels, and only the model turn is missing. It is the door "a person asked
 * the root agent to look" reaches the record through, and the door a case uses
 * when the claim under test is that the record is readable without one.
 */
async function rootCall(h: ScriptedLoop, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const answer = await h.ctx.tools.execute({
    callId: `read-${name}-${h.calls.length + 1}`,
    name,
    arguments: args,
    agent: h.agent(ROOT),
    signal: new AbortController().signal,
  })
  return {
    isError: answer.isError === true,
    text: (answer.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
  }
}

/** The ledger file's own rows, as the deployment wrote them. */
function ledgerRows(): Record<string, unknown>[] {
  return readFileSync(reviewAgentLedgerFile(), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Drop one kind of row from the ledger — the terminal write a process killed in
 * between never landed. What is left is exactly the state a crash leaves: the
 * rows written before it, and nothing the dying process did not get to append.
 */
function dropRows(kind: string): void {
  writeFileSync(
    reviewAgentLedgerFile(),
    `${ledgerRows().filter(row => row.kind !== kind).map(row => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  )
}

/**
 * Drive one root through a single child whose criterion is `command`, and stop
 * at the point the review is on the record. `tail` is what the root's model does
 * once the batch has ended and its execution has been handed back.
 *
 * The child's ids and the batch id are captured as soon as they exist: the
 * root's own tail reads them lazily, and the batch id is only a run's *current*
 * batch until the batch ends.
 */
async function oneChild(
  command: string,
  options: {
    readonly tail?: (tree: Tree) => readonly ScriptEntry[]
    readonly reviewer?: readonly ScriptEntry[]
    /** Keep the root's own turn parked until this resolves — the tail then runs in the same turn. */
    readonly park?: () => Promise<void>
    /**
     * Entries the root's model answers *before* it decomposes — what a case needs
     * when the store's state (a refusal's own record, say) is part of the subject
     * rather than a precondition it can state from outside the loop.
     */
    readonly lead?: readonly ScriptEntry[]
    /**
     * Run before the tree starts — the point where a case fixes the deployment's
     * state (a ledger home that cannot take a claim) *ahead* of the batch, so
     * what the automatic trigger meets is the state the case meant.
     */
    readonly beforeBegin?: (h: ScriptedLoop) => void
    /** Collect the trigger's own lines. */
    readonly log?: string[]
    /** Install the automatic trigger at all; a deployment that mounts none has no scan (default `true`). */
    readonly trigger?: boolean
    /**
     * The deployment's supervision policy: a case that needs the old selective
     * behavior (`autoReview: 'failed'`) or a small cap names it here; absent runs
     * the shipped defaults.
     */
    readonly supervision?: SupervisionOptions
    /**
     * The script of the **supervisor** session a recorded diagnosis is delegated
     * to (the third and later spawns), when a case needs it open (`hang`) or
     * closing rather than answering like the reviewer.
     */
    readonly supervisor?: readonly ScriptEntry[]
  } = {},
): Promise<{ h: ScriptedLoop; tree: Tree; root: { storeId: string; taskId: string; runId: string } }> {
  const tree: Tree = { childTaskId: '', childRunId: '', batchId: '' }
  const h = await startScriptedLoop({
    ...(options.supervision === undefined ? {} : { supervision: options.supervision }),
    script: (_sessionId, index): readonly ScriptEntry[] => index === 0
      ? [
        ...(options.lead ?? []),
        { tool: 'task_decompose', args: { reason: 'split the work', children: [child('child: the work', command)] } },
        { text: 'root: the batch is running' },
        ...(options.park === undefined ? [] : [{ waitFor: options.park } satisfies ScriptEntry]),
        ...(options.tail?.(tree) ?? []),
      ]
      : index === 1
        ? [{ tool: 'task_submit_result', args: { summary: 'child: handed in' } }]
        : index === 2
          ? [...(options.reviewer ?? [{ text: REVIEW_REPLY }])]
          : [...(options.supervisor ?? options.reviewer ?? [{ text: REVIEW_REPLY }])],
  })
  if (options.trigger !== false) {
    installReviewAgentAutoTrigger(h.ctx, options.log === undefined ? {} : { log: line => options.log!.push(line) })
  }
  options.beforeBegin?.(h)
  const root = await h.begin(ROOT_CONTRACT)
  const started = await vi.waitFor(async () => {
    const snapshot = await h.snapshot(root.storeId)
    const found = snapshot.tasks.find(task => task.parentTaskId === root.taskId)
    const childRun = found === undefined ? undefined : snapshot.runs.find(run => run.taskId === found.taskId)
    const batchId = snapshot.runs.find(run => run.runId === root.runId)?.batchId
    expect(childRun).toBeDefined()
    expect(batchId).toBeDefined()
    return { childTaskId: found!.taskId, childRunId: childRun!.runId, batchId: batchId! }
  }, { timeout: 30_000, interval: 25 })
  Object.assign(tree, started)
  return { h, tree, root }
}

const stacks: AssemblyStack[] = []

beforeEach(() => {
  // The deployment's own ledger (`$DSH_HOME/review-agents`) and its default cap:
  // a developer's environment must not decide what these cases read.
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '')
})

afterEach(async () => {
  await disposeScriptedLoops()
  for (const stack of stacks.splice(0)) {
    await Promise.race([
      stack.dispose({ remove: stack.dir.includes('singularity-assembly-') }),
      new Promise(resolve => { setTimeout(resolve, 2_000).unref() }),
    ])
  }
  vi.unstubAllEnvs()
})

describe('a failed review is accepted on its own (A5)', () => {
  it('claims the source, spawns one reviewer, and records its judgement', async () => {
    const { h, tree, root } = await oneChild('false')
    await failedReviewOf(h, root.storeId, tree.childTaskId)

    // The automatic trigger accepted the source: one reviewer, whose name is the
    // source it reviews.
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    expect(reviewerSpawns(h)[0]!.name).toBe(`review ${tree.childTaskId}`)

    // The ledger holds the one default attempt of that source: no key, no focus,
    // the root session as the caller, and a started row — one spent run. The
    // started row is the spawn's own `beforePrompt`, so it is waited for.
    const attempts = await vi.waitFor(async () => {
      const found = await reviewerAttempts(root.storeId)
      expect(found[0]?.started).toBe(true)
      return found
    }, { timeout: 30_000, interval: 25 })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      source: { taskId: tree.childTaskId, runId: tree.childRunId },
      requestKey: null,
      reason: null,
      actor: String(ROOT),
      sessionId: reviewer,
      started: true,
    })
    expect(supervisorSpawns(h)).toEqual([])
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)

    // The reviewer's own first request: the source, its real outcome, and the
    // pack the judgement rests on — read off the adapter, not off the prompt the
    // spawn carried.
    const request = await vi.waitFor(() => {
      const requests = h.requestsOf(reviewer)
      expect(requests).toHaveLength(1)
      return requests[0]!
    }, { timeout: 30_000, interval: 25 })
    const input = request.texts.join('\n')
    expect(input).toContain(`review ${tree.childTaskId}#${tree.childRunId} [failed]`)
    expect(input).toContain('--- review pack ---')
    expect(input).toContain(`source: review ${tree.childTaskId}#${tree.childRunId} [failed]`)
    expect(input).toContain('mandatory criteria not satisfied')
    // The pack carries facts, not a trigger decision (A5).
    expect(input).not.toContain('escalation:')
    // A5 §3, on the request the reviewer really received: the pack is where it
    // starts, not what it is confined to, and the dimensions it may judge are
    // not a form it has to fill in.
    expect(input).not.toContain('and nothing else')
    expect(input).not.toContain('Include all six dimensions')
    expect(input).toContain('context_read')

    // The judgement landed in the store, attributed to that reviewer, and the
    // attempt is settled.
    await vi.waitFor(async () => {
      const after = await h.snapshot(root.storeId)
      expect(after.diagnoses.some(item => String(item.producedBy.sessionId) === reviewer)).toBe(true)
    }, { timeout: 30_000, interval: 25 })
    await vi.waitFor(async () => {
      const settled = (await reviewerAttempts(root.storeId))[0]!
      expect(settled.settlement?.status).toBe('recorded')
    })
    await vi.waitFor(() => {
      expect(h.requestsOf(String(ROOT)).flatMap(request => request.texts).join('\n')).toContain(`Review diagnosis review-agent-${reviewer} for review source`)
    })
    const insertions = () => h.agent(ROOT).session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => (event.data as { inserted: { id: string }[] }).inserted)
      .filter(message => message.id === `m-diagnosis-review-agent-${reviewer}`)
    expect(insertions()).toHaveLength(1)
    await scanFailedReviewSources(h.ctx, root.storeId)
    expect(insertions()).toHaveLength(1)
    expect(h.visible(h.agent(ROOT))).not.toContain('task_recover')
    expect(input).toContain('Never tell the business coordinator to call task_recover')
    expect(input).toContain('most failures need no evolution proposal')
  }, 60_000)

  it('delivers a nested failure diagnosis to its delegating parent run', async () => {
    const h = await startScriptedLoop({
      script: (_session, index) => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'delegate subsystem', children: [child('parent subsystem', 'true')] } }]
        : index === 1
          ? [{ tool: 'task_decompose', args: { reason: 'isolate result', children: [child('leaf result', 'false')] } }]
          : index === 2
            ? [{ tool: 'task_submit_result', args: { summary: 'leaf handed in' } }]
            : [{ text: REVIEW_REPLY }],
    })
    installReviewAgentAutoTrigger(h.ctx)
    const root = await h.begin(ROOT_CONTRACT)
    const { parent, leaf } = await vi.waitFor(async () => {
      const snapshot = await h.snapshot(root.storeId)
      const parent = snapshot.runs.find(run => run.parentRunId === root.runId)
      const leaf = snapshot.runs.find(run => run.parentRunId === parent?.runId)
      expect(leaf?.status).toBe('failed')
      return { parent: parent!, leaf: leaf! }
    })
    await vi.waitFor(() => {
      expect(h.requestsOf(parent.sessionId).flatMap(request => request.texts).join('\n'))
        .toContain(`for review source ${leaf.taskId}#${leaf.runId}`)
    })
    expect(h.requestsOf(String(ROOT)).flatMap(request => request.texts).join('\n')).not.toContain('Review diagnosis review-agent-')
    expect((await h.snapshot(root.storeId)).diagnoses).toHaveLength(1)
  }, 60_000)

  it('accepts a verified review when autoReview: all is explicitly configured', async () => {
    // This deployment requests successful postmortems explicitly.
    const { h, tree, root } = await oneChild('true', { supervision: { autoReview: 'all' } })
    const snapshot = await vi.waitFor(async () => {
      const current = await h.snapshot(root.storeId)
      expect(current.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('verified')
      return current
    }, { timeout: 30_000, interval: 25 })
    expect((await h.runtime.awaitBatch(root.storeId, tree.batchId)).map(outcome => outcome.status)).toEqual(['verified'])

    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    expect(reviewerSpawns(h)[0]!.name).toBe(`review ${tree.childTaskId}`)
    const attempts = await vi.waitFor(async () => {
      const found = await reviewerAttempts(root.storeId)
      expect(found[0]?.started).toBe(true)
      return found
    }, { timeout: 30_000, interval: 25 })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      source: { taskId: tree.childTaskId, runId: tree.childRunId },
      requestKey: null,
      actor: String(ROOT),
      sessionId: reviewer,
      started: true,
    })
    expect(supervisorSpawns(h)).toEqual([])
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)

    // The reviewer's own first request carries the real outcome: it is a
    // postmortem of a success, judged from the same pack shape a failure's is.
    const input = await vi.waitFor(() => {
      const requests = h.requestsOf(reviewer)
      expect(requests).toHaveLength(1)
      return requests[0]!.texts.join('\n')
    }, { timeout: 30_000, interval: 25 })
    expect(input).toContain(`review ${tree.childTaskId}#${tree.childRunId} [verified]`)
    expect(input).toContain('--- review pack ---')
    // The judgement landed in the store, attributed to that reviewer.
    await vi.waitFor(async () => {
      const after = await h.snapshot(root.storeId)
      expect(after.diagnoses.some(item => String(item.producedBy.sessionId) === reviewer)).toBe(true)
    }, { timeout: 30_000, interval: 25 })
    void snapshot
  }, 60_000)

  it('spawns nothing at all for a review that settled verified when the policy names failed only', async () => {
    // The deployment's own selective switch (A5 §1): `supervision.autoReview:
    // 'failed'` keeps a success out of the automatic chain. The whole batch is
    // over by now — the review was recorded before it ended — and nothing was
    // accepted: one worker, no reviewer, no ledger row.
    const { h, tree, root } = await oneChild('true')
    const snapshot = await vi.waitFor(async () => {
      const current = await h.snapshot(root.storeId)
      expect(current.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('verified')
      return current
    }, { timeout: 30_000, interval: 25 })
    expect((await h.runtime.awaitBatch(root.storeId, tree.batchId)).map(outcome => outcome.status)).toEqual(['verified'])

    expect(h.spawns).toHaveLength(1)
    expect(reviewerSpawns(h)).toEqual([])
    expect(await readReviewAgentAttempts(root.storeId)).toEqual([])
    expect(await countReviewAgentRuns(root.storeId)).toBe(0)
    void snapshot
  }, 60_000)

  it('marks a recorded suggestion as a hand-off taken up by its supervisor', async () => {
    // The reviewer grounds a suggestion in what it saw — a target type outside
    // the two this build executes, which is a recorded suggestion like any
    // other. The diagnosis itself is the hand-off, so the deployment consumes it
    // and the pack reports the delegation; nothing executes the suggestion.
    const suggestionReply = '```json\n'
      + '{"observation":"the child failed its mandatory criterion",'
      + '"conclusion":"the acceptance command never feeds empty input",'
      + '"confidence":"medium",'
      + '"proposals":[{"targetType":"prompt_template","targetId":"reviewer",'
      + '"rationale":"name the empty-input case in the request"}]}'
      + '\n```'
    const parked = Promise.withResolvers<void>()
    const { h, tree, root } = await oneChild('false', {
      reviewer: [{ text: suggestionReply }],
      // The supervisor stays open, so the pack reads the delegation while it is
      // still the hand-off's owner.
      supervisor: [{ hang: true }],
      // The root keeps its turn while the batch runs, so the pack it asks for
      // reads the store after the automatic attempt has settled.
      park: () => parked.promise,
      tail: () => [
        { tool: 'task_review_pack', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId }) },
        { text: 'root: the suggestion is on the record' },
      ],
    })
    await failedReviewOf(h, root.storeId, tree.childTaskId)

    // The automatic attempt recorded the suggestion, and nothing was opened for
    // it: no EvolutionProposal, no candidate, no run.
    const recorded = await vi.waitFor(async () => {
      const snapshot = await h.snapshot(root.storeId)
      expect(snapshot.diagnoses).toHaveLength(1)
      return snapshot.diagnoses[0]!
    }, { timeout: 30_000, interval: 25 })
    expect(recorded.proposals).toEqual([
      { targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case in the request' },
    ])
    expect(recorded.judgements).toBeUndefined()
    // The hand-off is really taken up before the pack reads it back: the
    // supervisor is live and the ledger shows its started row.
    await vi.waitFor(() => expect(supervisorSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    await vi.waitFor(async () => {
      const row = (await readReviewAgentAttempts(root.storeId)).find(attempt => attempt.role === 'supervisor')
      expect(row?.started).toBe(true)
    }, { timeout: 30_000, interval: 25 })

    parked.resolve()
    const pack = await vi.waitFor(() => {
      const call = h.calls.find(item => item.name === 'task_review_pack' && item.result !== undefined)
      expect(call).toBeDefined()
      return call!.result!.text
    }, { timeout: 30_000, interval: 25 })
    expect(pack).toContain('proposal prompt_template reviewer: name the empty-input case in the request')
    // The recorded suggestion is a hand-off like any other now: its supervisor
    // is started, and the pack reports the delegation rather than a suggestion
    // nothing touches.
    expect(pack).toContain('handoff: taken up — this hand-off is delegated to supervisor session')
  }, 60_000)

  it('reviews a verified source on an explicit call, and only on an explicit call under autoReview: failed', async () => {
    const parked = Promise.withResolvers<void>()
    const focus = 'the user asked what went well in the release work'
    // The success postmortem, answered in the A5 shape: a real observation of a
    // source that did not fail, a conclusion of "no improvement needed", and no
    // judgement and no proposal at all — nothing is padded in.
    const successReply = '```json\n'
      + '{"observation":"the child passed its mandatory criterion on the first attempt",'
      + '"conclusion":"no improvement needed","confidence":"high"}'
      + '\n```'
    const { h, tree, root } = await oneChild('true', {
      supervision: { autoReview: 'failed' },
      park: () => parked.promise,
      reviewer: [{ text: successReply }],
      tail: () => [
        { tool: 'task_review_agent', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId, reason: focus }) },
        { tool: 'task_review_pack', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId }) },
        { text: 'root: the postmortem is on the record' },
      ],
    })
    // The verified review is on the record with nothing accepted for it.
    await vi.waitFor(async () => {
      const current = await h.snapshot(root.storeId)
      expect(current.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('verified')
    }, { timeout: 30_000, interval: 25 })
    expect(reviewerSpawns(h)).toEqual([])
    // The batch is over before the postmortem is asked for: the run handback that
    // moves the parent run's phase is the batch's own act, and comparing it as if
    // the review had done it would make this case a race against that handback.
    expect((await h.runtime.awaitBatch(root.storeId, tree.batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    const before = await h.snapshot(root.storeId)

    parked.resolve()
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    await vi.waitFor(async () => expect((await reviewerAttempts(root.storeId))[0]?.settlement?.status).toBe('recorded'))
    expect(supervisorSpawns(h)).toEqual([])

    // The explicit call is admitted on its own: the reason it named is durable in
    // the attempt, and the reviewer's own first request carries it beside the
    // source and its real outcome.
    const attempt = (await reviewerAttempts(root.storeId))[0]!
    expect(attempt).toMatchObject({
      source: { taskId: tree.childTaskId, runId: tree.childRunId },
      requestKey: null,
      reason: focus,
      actor: String(ROOT),
    })
    const input = await vi.waitFor(() => {
      const requests = h.requestsOf(reviewer)
      expect(requests).toHaveLength(1)
      return requests[0]!.texts.join('\n')
    }, { timeout: 30_000, interval: 25 })
    expect(input).toContain(`review ${tree.childTaskId}#${tree.childRunId} [verified] — focus: ${focus}`)
    expect(input).toContain('--- review pack ---')

    // The successful source is not touched by its own postmortem (REV-4): the
    // same task, the same run, the same review — the diagnosis is the only fact
    // the review added.
    await vi.waitFor(async () => {
      const after = await h.snapshot(root.storeId)
      expect(after.diagnoses).toHaveLength(1)
    }, { timeout: 30_000, interval: 25 })
    const after = await h.snapshot(root.storeId)
    const diagnosis = after.diagnoses.find(item => String(item.producedBy?.sessionId) === reviewer)!
    // The persisted slot holds the reviewer's real observation and its
    // conclusion — no failure is invented, and nothing is padded in.
    expect(diagnosis.observedFailure).toBe('the child passed its mandatory criterion on the first attempt')
    expect(diagnosis.localizedCause).toBe('no improvement needed')
    expect(diagnosis.judgements).toBeUndefined()
    expect(diagnosis.proposals).toEqual([])
    expect(after.tasks).toEqual(before.tasks)
    expect(after.runs).toEqual(before.runs)
    expect(after.reviews).toEqual(before.reviews)
    expect(after.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('verified')

    // A successful child conclusion remains parent-owned and spends no supervisor.
    const pack = await vi.waitFor(() => {
      const call = h.calls.find(item => item.name === 'task_review_pack' && item.result !== undefined)
      expect(call).toBeDefined()
      return call!.result!.text
    }, { timeout: 30_000, interval: 25 })
    expect(pack).toContain('no improvement needed')
    expect(pack).toContain('review attempts (1):')
    expect(pack).toContain('handoff: parent-owned')
  }, 60_000)

  it('settles exactly as before in a deployment that mounts no trigger at all', async () => {
    // The reviewer chain is a deployment's composition (A5): with nothing
    // installed, the terminal transition writes the review and moves on — no
    // claim, no reviewer, and no read this settlement waits for.
    const { h, tree, root } = await oneChild('false', { trigger: false })
    await failedReviewOf(h, root.storeId, tree.childTaskId)
    expect((await h.runtime.awaitBatch(root.storeId, tree.batchId)).map(outcome => outcome.status)).toEqual(['failed'])

    const after = await h.snapshot(root.storeId)
    expect(after.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('failed')
    expect(after.runs.find(run => run.taskId === tree.childTaskId)!.status).toBe('failed')
    expect(h.spawns).toHaveLength(1)
    expect(reviewerSpawns(h)).toEqual([])
    expect(await readReviewAgentAttempts(root.storeId)).toEqual([])
  }, 60_000)

  it('does not wait for the reviewer: the batch settles while the reviewer is still out there', async () => {
    const { h, tree, root } = await oneChild('false', { reviewer: [{ hang: true }] })
    // The reviewer is started — the source's attempt is in flight — and the run
    // it reviews still settles to its own end.
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)

    expect((await h.runtime.awaitBatch(root.storeId, tree.batchId)).map(outcome => outcome.status)).toEqual(['failed'])
    const settled = await h.snapshot(root.storeId)
    expect(settled.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('failed')
    // The reviewer never answered — and that is the state the settled store is
    // in: one claim, one started row, no settlement.
    await vi.waitFor(() => expect(h.requestsOf(reviewer)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const attempt = (await reviewerAttempts(root.storeId))[0]!
    expect(attempt.sessionId).toBe(reviewer)
    expect(attempt.started).toBe(true)
    expect(attempt.settlement).toBeUndefined()
    expect(settled.diagnoses).toEqual([])
  }, 60_000)

  it('lets a reviewer that cannot even claim change nothing about the settlement', async () => {
    // The ledger's home is a file, so the claim the attempt owes cannot be
    // written: no attempt exists, and the settlement must not care. It is fixed
    // before the tree runs, so the trigger meets exactly that ledger.
    let blocked = ''
    const { h, tree, root } = await oneChild('false', {
      tail: () => [{ text: 'root: the batch ended' }],
      beforeBegin: instance => {
        blocked = join(instance.workspace, 'ledger-as-a-file')
        writeFileSync(blocked, 'not a directory', 'utf8')
        vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', blocked)
      },
    })

    await failedReviewOf(h, root.storeId, tree.childTaskId)
    expect((await h.runtime.awaitBatch(root.storeId, tree.batchId)).map(outcome => outcome.status)).toEqual(['failed'])

    // The tree is settled, the review is on the record — and no reviewer was
    // published, because no attempt could be claimed.
    const after = await h.snapshot(root.storeId)
    expect(after.runs.find(run => run.taskId === tree.childTaskId)!.status).toBe('failed')
    expect(after.reviews.find(review => review.taskId === tree.childTaskId)?.outcome).toBe('failed')
    expect(after.diagnoses).toEqual([])
    expect(h.spawns).toHaveLength(1)
    expect(reviewerSpawns(h)).toEqual([])
    expect(blocked).not.toBe('')
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  }, 60_000)

  it('shares the automatic attempt with an explicit call for the same source: one claim, one session, one spawn', async () => {
    const parked = Promise.withResolvers<void>()
    const { h, tree, root } = await oneChild('false', {
      park: () => parked.promise,
      tail: () => [
        { tool: 'task_review_agent', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId }) },
        { text: 'root: the review is on the record' },
      ],
    })
    await failedReviewOf(h, root.storeId, tree.childTaskId)
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    // The automatic attempt is settled before the explicit call is made: what
    // that call meets is the state the ledger holds, not a race.
    await vi.waitFor(async () => {
      expect((await reviewerAttempts(root.storeId))[0]?.settlement?.status).toBe('recorded')
    })

    // The root's own turn continues (it was parked while the batch ran) and asks
    // for the same source — the attempt the automatic trigger started.
    parked.resolve()
    const answer = await vi.waitFor(() => {
      const call = h.calls.find(item => item.name === 'task_review_agent' && item.result !== undefined)
      expect(call).toBeDefined()
      return call!.result!
    }, { timeout: 30_000, interval: 25 })
    expect(answer.isError).toBe(false)
    expect(answer.text).toContain('already has')
    expect(answer.text).toContain('no review agent started')

    // One source, one attempt: the automatic claim is the attempt both entries
    // share, and the reviewer the automatic trigger started is the only one. The
    // ordinary child diagnosis is handled by its parent, spending one coordination run.
    const attempts = await reviewerAttempts(root.storeId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.sessionId).toBe(String(reviewerSpawns(h)[0]!.sessionId))
    expect(reviewerSpawns(h)).toHaveLength(1)
    expect(supervisorSpawns(h)).toEqual([])
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)
  }, 60_000)

  it('retries a source the automatic trigger had to skip on a graph activation, and only reads what it started', async () => {
    // The automatic trigger runs with no ledger home at all (the path is a file):
    // the source is not accepted. Both are fixed before the tree runs.
    const lines: string[] = []
    const { h, tree, root } = await oneChild('false', {
      log: lines,
      beforeBegin: instance => {
        const blocked = join(instance.workspace, 'ledger-as-a-file')
        writeFileSync(blocked, 'not a directory', 'utf8')
        vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', blocked)
      },
    })

    await failedReviewOf(h, root.storeId, tree.childTaskId)
    expect(reviewerSpawns(h)).toEqual([])
    await vi.waitFor(() => expect(lines.some(line => line.includes('could not'))).toBe(true))

    // The graph is activated with a ledger that now works: the same store is
    // scanned, and the source the terminal-commit trigger had to skip starts.
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
    const graph = {
      id: 'g1', name: 'graph', envId: 'env1', rootSessionId: String(ROOT), graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root',
    }
    h.ctx.emit('graphs/selected', graph as never)
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const attempts = await reviewerAttempts(root.storeId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ source: { taskId: tree.childTaskId, runId: tree.childRunId }, started: true })
    await vi.waitFor(async () => expect((await reviewerAttempts(root.storeId))[0]?.settlement?.status).toBe('recorded'))
    expect(supervisorSpawns(h)).toEqual([])

    // A second activation only reads: the attempt already exists, and nothing is
    // claimed or spawned again.
    h.ctx.emit('graphs/selected', graph as never)
    await vi.waitFor(() => expect(lines.filter(line => line.includes(tree.childTaskId))).not.toEqual([]))
    expect(reviewerSpawns(h)).toHaveLength(1)
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)
    expect(await reviewerAttempts(root.storeId)).toHaveLength(1)
    expect(lines.some(line => line.includes('already has an attempt'))).toBe(true)
  }, 60_000)

  it('keeps the gap and the failed review readable — and accepts the source — with no model response (REV-1)', async () => {
    // The real refusal site first: a child naming a capability nothing grants is
    // rejected before its batch exists, and the gap is persisted as the store's
    // own obligation — a fact of the refusal, not a note in a return value.
    const gap = {
      tool: 'task_decompose',
      args: {
        reason: 'split the work',
        children: [{
          objective: 'child: needs what nothing grants',
          acceptanceCriteria: [{ description: 'the child works', command: 'true' }],
          requiredCapabilities: ['fly-to-moon'],
        }],
      },
    } satisfies ScriptEntry
    // The reviewer never answers: the acceptance and the reading below happen
    // with no model response at all.
    const { h, tree, root } = await oneChild('false', { lead: [gap], reviewer: [{ hang: true }] })
    await failedReviewOf(h, root.storeId, tree.childTaskId)

    // Both facts are on the record: the refusal (its own obligation) and the real
    // failure (its review).
    const refusal = h.calls.find(call => call.name === 'task_decompose')!
    expect(refusal.result?.text).toContain('capability gap: child 0 is missing [fly-to-moon]')
    expect(refusal.result?.text).toContain('capability gap: child 0 is missing [fly-to-moon]')
    const record = await h.snapshot(root.storeId)
    expect(record.obligations).toHaveLength(1)
    expect(record.obligations[0]!.goal).toContain('capability "fly-to-moon"')
    expect(record.obligations[0]!.criterion).toContain('capability_list shows it')

    // The source was accepted on its own — one default attempt, claimed and
    // started, publishing one reviewer — and the silence at the other end
    // invented nothing: the attempt is still open and no Diagnosis exists.
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    const attempt = (await readReviewAgentAttempts(root.storeId))[0]!
    expect(attempt).toMatchObject({
      source: { taskId: tree.childTaskId, runId: tree.childRunId },
      requestKey: null,
      actor: String(ROOT),
      sessionId: reviewer,
      started: true,
    })
    expect(attempt.settlement).toBeUndefined()
    expect((await h.snapshot(root.storeId)).diagnoses).toEqual([])

    // Readable through the deployment's own doors, dispatched as the root with no
    // model request in between: the gap is the store's own line, the review is
    // the pack's own source, and `context_read` reads the review back by its pair.
    const status = await rootCall(h, 'task_status', { scope: 'graph' })
    expect(status.isError).toBe(false)
    expect(status.text).toContain('- obligations: 1 recorded')

    const pack = await rootCall(h, 'task_review_pack', { taskId: tree.childTaskId, runId: tree.childRunId })
    expect(pack.isError).toBe(false)
    expect(pack.text).toContain(`source: review ${tree.childTaskId}#${tree.childRunId} [failed]`)
    expect(pack.text).toContain('review attempts (1):')
    expect(pack.text).toContain(`default attempt ${reviewer} [in-flight]`)

    const review = await rootCall(h, 'context_read', {
      kind: 'review',
      ref: { taskId: tree.childTaskId, runId: tree.childRunId },
    })
    expect(review.isError).toBe(false)
    expect(review.text).toContain(`review of task ${tree.childTaskId}`)
    expect(review.text).toContain('failed')
  }, 60_000)

  it('shares the in-flight automatic attempt with a manual call: one claim, one session, no second spawn (REV-3)', async () => {
    // The reviewer is held open, so the state both calls meet is the attempt *in
    // flight* — the window the automatic claim and an explicit call compete in.
    const parked = Promise.withResolvers<void>()
    const { h, tree, root } = await oneChild('false', {
      park: () => parked.promise,
      reviewer: [{ hang: true }],
      tail: () => [
        // The source's default attempt: the automatic claim is the attempt this
        // call asks for, so it is answered with that identity and nothing else.
        { tool: 'task_review_agent', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId }) },
        // A new key while that attempt is open: not accepted, and not started.
        {
          tool: 'task_review_agent',
          args: () => ({
            taskId: tree.childTaskId,
            runId: tree.childRunId,
            requestKey: 'k1',
            reason: 'a second look while the first is still out',
          }),
        },
        { text: 'root: the source is mid-review' },
      ],
    })
    await failedReviewOf(h, root.storeId, tree.childTaskId)
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    await vi.waitFor(async () => expect((await readReviewAgentAttempts(root.storeId))[0]?.started).toBe(true))

    parked.resolve()
    await vi.waitFor(() => {
      expect(h.calls.filter(call => call.name === 'task_review_agent' && call.result !== undefined)).toHaveLength(2)
    }, { timeout: 30_000, interval: 25 })
    const [same, other] = h.calls.filter(call => call.name === 'task_review_agent' && call.result !== undefined)

    // The default-key call is the attempt itself: same session, nothing started.
    expect(same!.result?.isError).toBe(false)
    expect(same!.result?.text).toContain('already has this attempt')
    expect(same!.result?.text).toContain(reviewer)
    expect(same!.result?.text).toContain('no review agent started')
    // The new key is not accepted while the source has one attempt open: it sees
    // the same identity and starts nothing either.
    expect(other!.result?.isError).toBe(false)
    expect(other!.result?.text).toContain('in flight')
    expect(other!.result?.text).toContain(reviewer)
    expect(other!.result?.text).toContain('the new request was not accepted')
    expect(other!.result?.text).toContain('no review agent started')

    // One attempt, one claim, one started run, one reviewer — however many doors
    // asked for that source while it was open.
    const attempts = await readReviewAgentAttempts(root.storeId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.sessionId).toBe(reviewer)
    expect(attempts[0]!.requestKey).toBeNull()
    expect(ledgerRows().filter(row => row.kind === 'claim')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started')).toHaveLength(1)
    expect(reviewerSpawns(h)).toHaveLength(1)
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)
  }, 60_000)

  it('repairs a lost terminal write for a recorded diagnosis without a second side effect (REV-3)', async () => {
    const parked = Promise.withResolvers<void>()
    const { h, tree, root } = await oneChild('false', {
      park: () => parked.promise,
      tail: () => [
        { tool: 'task_review_agent', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId }) },
        { tool: 'task_review_agent', args: () => ({ taskId: tree.childTaskId, runId: tree.childRunId }) },
        { text: 'root: the review is on the record' },
      ],
    })
    await failedReviewOf(h, root.storeId, tree.childTaskId)
    await vi.waitFor(() => expect(reviewerSpawns(h)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewerSpawns(h)[0]!.sessionId)
    // The attempt really reached its diagnosis and its terminal fact…
    await vi.waitFor(async () => expect((await reviewerAttempts(root.storeId))[0]?.settlement?.status).toBe('recorded'))
    expect((await h.snapshot(root.storeId)).diagnoses).toHaveLength(1)
    expect(supervisorSpawns(h)).toEqual([])
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)

    // …and then the process died in the window between the two writes: the store
    // holds the diagnosis, the ledger holds no terminal row for the attempt. The
    // next call for that source meets exactly that state.
    dropRows('settled')
    expect(ledgerRows().filter(row => row.kind === 'settled')).toEqual([])

    parked.resolve()
    await vi.waitFor(() => {
      expect(h.calls.filter(call => call.name === 'task_review_agent' && call.result !== undefined)).toHaveLength(2)
    }, { timeout: 30_000, interval: 25 })
    const answers = h.calls.filter(call => call.name === 'task_review_agent' && call.result !== undefined)
    for (const answer of answers) {
      // Neither call starts a reviewer, and both answer with the diagnosis the
      // store already holds — the lost terminal write is not read as "in flight
      // forever", and the reviewer is not run twice.
      expect(answer.result?.isError).toBe(false)
      expect(answer.result?.text).toContain('already has this attempt')
      expect(answer.result?.text).toContain('no review agent started')
      expect(answer.result?.text).toContain(reviewer)
      expect(answer.result?.text).toContain(`diagnosis review-agent-${reviewer}`)
    }

    // The recovery is one terminal row for the reviewer — not one per call — and
    // nothing else moved: one claim, one started row, one reviewer and one diagnosis.
    const settled = ledgerRows().filter(row => row.kind === 'settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'recorded', sessionId: reviewer })
    expect(ledgerRows().filter(row => row.kind === 'claim')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started')).toHaveLength(1)
    expect(reviewerSpawns(h)).toHaveLength(1)
    expect((await h.snapshot(root.storeId)).diagnoses).toHaveLength(1)
    expect(await countReviewAgentRuns(root.storeId)).toBe(1)
  }, 60_000)
})

describe('the two triggers are the deployment\'s own composition (A5)', () => {
  /** One criterion a command settles. */
  const criterion = (command: string) => ({ description: `the command ${command} exits 0`, command })

  /** The reviewers the assembly published, in order. */
  const reviewers = (stack: AssemblyStack): readonly { sessionId: string }[] =>
    stack.spawns.filter(spawn => String(spawn.name ?? '').startsWith('review '))

  /** One task whose run settled `failed`, through the deployment's own entries. */
  async function failedTask(stack: AssemblyStack): Promise<{ storeId: string; taskId: string; runId: string }> {
    const storeId = stack.storeIdOf(String(ROOT))
    await stack.seedLog(String(ROOT), ['ship the release'])
    const root = await stack.runtime.intakeRootContract(storeId, String(ROOT), {
      objective: 'ship the release',
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is delivered', command: 'true' }],
    })
    const batch = await stack.runtime.decomposeAndRun(storeId, root.taskId, root.runId, String(ROOT), {
      reason: 'split the work',
      children: [{ objective: 'child that fails', acceptanceCriteria: [criterion('false')] }],
    } as never)
    const outcomes = await stack.runtime.awaitBatch(storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    return { storeId, taskId: outcomes[0]!.taskId, runId: String(outcomes[0]!.runId) }
  }

  /** The graph activation event the registry emits, as a case emits it by hand. */
  const activated = (stack: AssemblyStack): void => {
    stack.ctx.emit('graphs/selected', {
      id: 'g1', name: 'g1', envId: 'env1', rootSessionId: String(ROOT),
      graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root',
    } as never)
  }

  it('accepts a failed review with the plugin alone: no spec in the loop triggers it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a5-ledger-'))
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', dir)
    const stack = await startAssemblyStack({ worker: async () => {} })
    stacks.push(stack)

    const failed = await failedTask(stack)
    // Nobody asked for a review: the composition's own installation accepted the
    // source when its failed review was recorded, and the diagnosis it recorded
    // goes to its parent without starting a supervisor.
    await vi.waitFor(() => expect(reviewers(stack)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewers(stack)[0]!.sessionId)
    const attempts = (await readReviewAgentAttempts(failed.storeId)).filter(attempt => attempt.role === 'reviewer')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      source: { taskId: failed.taskId, runId: failed.runId },
      requestKey: null,
      reason: null,
      actor: String(ROOT),
      sessionId: reviewer,
      started: true,
    })
    // This deployment has no model loop, so the reviewer records no diagnosis
    // here: the acceptance is the reviewer's attempt, and the store spends one
    // coordination run on it.
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)
    expect(reviewAgentLedgerFile()).toBe(join(dir, 'agents.jsonl'))
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('rescans the store on the explicit activation the composition listens for, and only reads what it started', async () => {
    // The ledger home is a file while the tree runs: the automatic trigger fires,
    // cannot claim, and changes nothing about the settlement.
    const dir = mkdtempSync(join(tmpdir(), 'a5-ledger-'))
    const blocked = join(dir, 'ledger-as-a-file')
    writeFileSync(blocked, 'not a directory', 'utf8')
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', blocked)

    const stack = await startAssemblyStack({ worker: async () => {} })
    stacks.push(stack)
    const failed = await failedTask(stack)
    expect(reviewers(stack), 'no reviewer was ever published').toEqual([])
    expect((await stack.snapshot(failed.storeId)).reviews.find(review => review.taskId === failed.taskId)?.outcome).toBe('failed')

    // The ledger works now, and the graph is explicitly activated: the same store
    // is scanned and the source the automatic trigger had to skip is started.
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', dir)
    activated(stack)
    await vi.waitFor(() => expect(reviewers(stack)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    const reviewer = String(reviewers(stack)[0]!.sessionId)
    const attempts = (await readReviewAgentAttempts(failed.storeId)).filter(attempt => attempt.role === 'reviewer')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      source: { taskId: failed.taskId, runId: failed.runId },
      requestKey: null,
      reason: null,
      sessionId: reviewer,
      started: true,
    })

    // A second activation only reads the attempt: no new claim, no new spawn.
    activated(stack)
    await vi.waitFor(async () => {
      const found = (await readReviewAgentAttempts(failed.storeId)).filter(attempt => attempt.role === 'reviewer')
      expect(found[0]!.settlement).toBeDefined()
    })
    expect(reviewers(stack)).toHaveLength(1)
    expect((await readReviewAgentAttempts(failed.storeId)).filter(attempt => attempt.role === 'reviewer')).toHaveLength(1)
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('lets the reviewer it starts read the tree\'s siblings, evidence and history through its own context_read (REV-2)', async () => {
    // The reviewer's own turn reads what it is authorized to read: the source it
    // was delegated, the review that settled it, the evidence the failing run
    // produced, and the tree's own session history. The reads travel the
    // deployment's real `context_read` — the reviewer's delegation is the ledger
    // row the spawn wrote — so what is asserted is the reader, not a fixture copy
    // of it. The worker body *is* the reviewer's model here: it makes the calls a
    // live reviewer would make.
    const dir = mkdtempSync(join(tmpdir(), 'a5-ledger-'))
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', dir)
    const reads: Record<string, { isError: boolean; text: string }> = {}
    let evidenceId = ''
    const stack = await startAssemblyStack({
      worker: async sessionId => {
        const spawn = stack.spawns.find(record => String(record.sessionId) === String(sessionId))
        if (spawn === undefined || !String(spawn.name).startsWith('review ')) return
        const state = await stack.snapshot()
        const source = state.tasks.find(task => task.parentTaskId !== undefined)!
        const root = state.tasks.find(task => task.parentTaskId === undefined)!
        const review = state.reviews.find(item => item.taskId === source.taskId)!
        const evidence = state.evidence.find(item => item.taskId === source.taskId)
        const reader = String(sessionId)
        reads.task = await stack.call(reader, 'context_read', { kind: 'task', ref: source.taskId })
        // Beyond its own source: the related task that delegated the work, read
        // by reference the same way.
        reads.related = await stack.call(reader, 'context_read', { kind: 'task', ref: root.taskId })
        reads.review = await stack.call(reader, 'context_read', {
          kind: 'review',
          ref: { taskId: source.taskId, runId: review.runId ?? null },
        })
        if (evidence !== undefined) {
          evidenceId = evidence.evidenceId
          reads.evidence = await stack.call(reader, 'context_read', { kind: 'evidence', ref: evidence.evidenceId })
        }
        reads.history = await stack.call(reader, 'context_read', { kind: 'session', ref: String(ROOT) })
      },
    })
    stacks.push(stack)

    const failed = await failedTask(stack)
    await vi.waitFor(() => expect(reviewers(stack)).toHaveLength(1), { timeout: 30_000, interval: 25 })
    await vi.waitFor(() => expect(Object.keys(reads)).toHaveLength(5), { timeout: 30_000, interval: 25 })

    // The delegated task itself, and the review that settled it — in the
    // reviewer's own words, not the pack's.
    const source = (await stack.snapshot(failed.storeId)).tasks.find(task => task.taskId === failed.taskId)!
    expect(reads.task!.isError).toBe(false)
    expect(reads.task!.text).toContain(source.objective)
    // A related task of the same tree, reached across the sibling boundary the
    // source alone would not carry.
    expect(reads.related!.isError).toBe(false)
    expect(reads.related!.text).toContain('ship the release')
    expect(reads.review!.isError).toBe(false)
    expect(reads.review!.text).toContain(`review of task ${failed.taskId}`)
    expect(reads.review!.text).toContain('failed')
    // The evidence the failing run left behind, by its own id.
    expect(evidenceId).not.toBe('')
    expect(reads.evidence!.isError).toBe(false)
    expect(reads.evidence!.text).toContain(evidenceId)
    // The history: the graph's own session log, read through DSH, with the
    // person's own request in it.
    expect(reads.history!.isError).toBe(false)
    expect(reads.history!.text).toContain('ship the release')
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)
})

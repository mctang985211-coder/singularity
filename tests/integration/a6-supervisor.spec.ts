/**
 * A6 interface ④ end to end, on the real deployment: the hand-off a recorded
 * Diagnosis becomes, the supervisor it is delegated to, and the recovery the
 * supervisor opens through `task_recover`.
 *
 * The whole chain runs here the way a deployment runs it — the real DSH loop with
 * a scripted model, the real store, the real runtime, the real evolution plane,
 * the real tools — and the one tool call that matters is dispatched by the model
 * itself (`task_recover`), not by the spec:
 *
 * 1. the root's own goal fails its map over the member that failed, and its
 *    review settles `failed`;
 * 2. the root asks `task_review_agent` for that exact source, and the reviewer
 *    records a diagnosis — the A6 hand-off;
 * 3. the consumption takes the hand-off up: one supervisor session, delegated
 *    through the coordination ledger, idempotently;
 * 4. the supervisor's scripted request calls `task_recover`, and the runtime
 *    opens the failed goal's new attempt — judged by the original acceptance
 *    criteria, with the old failure left readable;
 * 5. a repeat returns that attempt (and that supervisor), never a second one.
 *
 * The refusals are here too, each with the side effect it must not have: no root
 * surface carries `task_recover`, a suggestion with no executor is still handed
 * to a coordinator (the diagnosis is the hand-off, not the suggestion), and a
 * source that succeeded accepts improvement rounds up to the configured cap.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  readReviewAgentAttempts,
  readSupervisorHandoff,
  reviewAgentLedgerFile,
} from '../../agent-singularity/src/coordination/ledger.ts'
import { SUPERVISOR_BASELINE } from '../../agent-singularity/src/coordination/handoff-rules.ts'
import {
  consumePendingHandoffs,
  installSupervisorHandoffTrigger,
  startSupervisorHandoff,
} from '../../agent-singularity/src/coordination/evolution-handoff.ts'
import { buildReviewPack } from '../../agent-singularity/src/tools/task-review-pack.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskRun } from '../../task/src/index.ts'
import { startScriptedLoop, disposeScriptedLoops, type ScriptEntry, type ScriptedLoop, type SupervisionOptions } from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))

/** The root contract every case runs under: the goal's own check and the map over the member that fails. */
const ROOT_CONTRACT = {
  objective: 'ship the release',
  acceptanceCriteria: [
    { criterionId: 'root-goal', description: 'the release is shipped', command: 'true' },
    {
      criterionId: 'root-map',
      description: 'the member the map names passed',
      mode: 'composite',
      mandatory: true,
      childEvidence: [{ childIndex: 0, criterionId: 'member-0' }],
    },
  ],
}

/** The reviewer's answer: a diagnosis about the failed source, carrying one capability suggestion. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the root goal failed its own map",'
  + '"conclusion":"the member needs a capability the deployment does not grant",'
  + '"confidence":"high",'
  + '"proposals":[{"targetType":"capability","targetId":"new-row","rationale":"granting the member this row is what closes the gap"}]}'
  + '\n```'

/**
 * The facts a case's script reads that only exist once the run is under way: the
 * root task and run the review is asked about, the diagnosis the reviewer wrote
 * (which the *supervisor* has to name), and the latch the root's own turn waits
 * on so it hands its result in after the batch, not before.
 */
interface Cells {
  rootTaskId?: string
  rootRunId?: string
  diagnosisId?: string
  readonly batchDone: Promise<void>
  readonly resolveBatch: () => void
}

const ledgerDirs: string[] = []

beforeEach(() => {
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  // Two coordination runs of one store: the reviewer that writes the diagnosis
  // and the supervisor that takes it up are two attempts of the same allowance.
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '3')
})

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
  for (const dir of ledgerDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ledgerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'a6-supervisor-'))
  ledgerDirs.push(dir)
  return dir
}

async function runOf(h: ScriptedLoop, runId: string): Promise<TaskRun> {
  return (await h.snapshot(STORE)).runs.find(run => run.runId === runId)!
}

/** Wait for the supervisor spawn (its name is the hand-off it was delegated for) and answer with its session. */
async function supervisorSession(h: ScriptedLoop, diagnosisId: string): Promise<string> {
  await vi.waitFor(
    () => expect(h.spawns.filter(spawn => spawn.name === `supervisor for ${diagnosisId}`)).toHaveLength(1),
    { timeout: 30_000, interval: 25 },
  )
  return String(h.spawns.find(spawn => spawn.name === `supervisor for ${diagnosisId}`)!.sessionId)
}

/**
 * Wait until the batch this session admitted has ended and handed the run back
 * (`waiting_children → active`) — the wake a live attempt's submission waits for.
 */
async function waitForHandback(loop: ScriptedLoop, sessionId: string): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const run = (await loop.snapshot(STORE)).runs.find(candidate => candidate.sessionId === sessionId)
    if (run !== undefined && (run.batches?.length ?? 0) > 0 && run.executionPhase === 'active') return
    if (Date.now() > deadline) throw new Error(`the run of session ${sessionId} never came back from its batch`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/**
 * The script every case in this file runs: one failed member, one review of the
 * root's own failed run, one supervisor, one recovery attempt. The root's own
 * turn waits for its batch before it hands its result in, so the review the case
 * is about is of a run that really failed.
 */
function script(
  h: () => ScriptedLoop,
  cells: Cells,
  options: { recover?: boolean; review?: boolean; reviewReply?: string; supervisorReply?: string; supervisor?: readonly ScriptEntry[] } = {},
): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index) => {
    const loop = h()
    const name = loop.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? ''
    if (name.startsWith('supervisor for')) {
      if (options.supervisor !== undefined) return [...options.supervisor]
      if (options.recover === false) return [{ text: options.supervisorReply ?? 'supervisor: nothing to do' }]
      // The diagnosis the hand-off is about: the reviewer's own record id, which
      // is `<its session>` (review-agent-run.ts). A live model reads it from its
      // first request; the scripted one derives it from the spawn the same way.
      const reviewer = loop.spawns.find(spawn => spawn.name.startsWith('review '))
      const diagnosisId = cells.diagnosisId ?? (reviewer === undefined ? '' : `review-agent-${String(reviewer.sessionId)}`)
      return [
        { tool: 'task_recover', args: () => ({ sourceDiagnosisId: diagnosisId, requestKey: 'k-1' }) },
        { text: 'supervisor: the attempt is open' },
      ]
    }
    if (name.startsWith('review ')) return [{ text: options.reviewReply ?? REVIEW_REPLY }]
    if (name.startsWith('recovery of')) {
      // A second `recovery of` session is an improvement round of an
      // already-verified source: every position is bound, so the attempt has no
      // position of its own to run and hands its result in directly.
      const ordinal = loop.spawns.filter(spawn => spawn.name.startsWith('recovery of')).length
      if (ordinal >= 2) {
        return [
          { tool: 'task_submit_result', args: { summary: 'the improvement is handed in' } },
          { text: 'improvement: handed in' },
        ]
      }
      // The attempt re-runs the position the map names: it delegates a member of
      // its own and hands its result in once that batch has ended (the runtime's
      // own message starts that second half of the turn). The wait is explicit:
      // the attempt's prior-round notice may open that turn before the batch
      // settles, and a submission while children run is denied.
      return [
        {
          tool: 'task_decompose',
          args: {
            reason: 're-run the failed position',
            children: [{ objective: 'the member, again', acceptanceCriteria: [{ criterionId: 'member-0', description: 'it holds', command: 'true' }] }],
          },
        },
        { text: 'attempt: the replacement is running' },
        { waitFor: () => waitForHandback(loop, sessionId) },
        { tool: 'task_submit_result', args: { summary: 'the attempt is handed in' } },
        { text: 'attempt: handed in' },
      ]
    }
    if (index === 0) {
      // The root asks for a review of its own failed run — the exact source the
      // tool validates before anything is claimed.
      const review: ScriptEntry[] = options.review === false
        ? []
        : [
          { tool: 'task_review_agent', args: { taskId: cells.rootTaskId!, runId: cells.rootRunId!, reason: 'the goal failed its own map' } },
          { text: 'root: asked for the postmortem' },
        ]
      return [
        {
          tool: 'task_decompose',
          args: {
            reason: 'split the work',
            children: [{ objective: 'the member that fails', acceptanceCriteria: [{ criterionId: 'member-0', description: 'it holds', command: 'false' }] }],
          },
        },
        { text: 'root: the batch is running' },
        { waitFor: () => cells.batchDone },
        { tool: 'task_submit_result', args: { summary: 'root: handed in' } },
        { text: 'root: handed in' },
        ...review,
      ]
    }
    return [
      { tool: 'task_submit_result', args: { summary: 'member: handed in' } },
      { text: 'member: handed in' },
    ]
  }
}

/** Start one case's deployment, with the cells its script reads. */
async function startCase(
  options: {
    recover?: boolean
    review?: boolean
    reviewReply?: string
    supervisorReply?: string
    /** The supervisor's script when the case needs a different shape (a hang that keeps the hand-off owned, a close). */
    supervisor?: readonly ScriptEntry[]
    supervision?: SupervisionOptions
    evolution?: boolean
  } = {},
): Promise<{ h: ScriptedLoop; cells: Cells }> {
  let resolve = (): void => {}
  const batchDone = new Promise<void>(done => { resolve = done })
  const cells: Cells = { batchDone, resolveBatch: resolve }
  let h!: ScriptedLoop
  h = await startScriptedLoop({
    roots: [ROOT],
    script: script(() => h, cells, options),
    ...(options.evolution === false ? {} : { evolution: { ledgerRoot: ledgerDir() } }),
    ...(options.supervision === undefined ? {} : { supervision: options.supervision }),
  })
  return { h, cells }
}

/**
 * Drive the root's own failure, its review, and — unless the case says otherwise
 * — the hand-off the review leaves behind. The consumption is explicit here
 * (`consumePendingHandoffs`), which is the same entry the deployment's triggers
 * call: what this spec proves is the chain, not the trigger wiring (the trigger's
 * own case installs it and scans a store).
 */
async function failRootAndReview(h: ScriptedLoop, cells: Cells, options: { recover?: boolean; review?: boolean } = {}): Promise<{ taskId: string; runId: string; childTaskId: string; diagnosisId?: string }> {
  const root = await h.begin(ROOT_CONTRACT)
  cells.rootTaskId = root.taskId
  cells.rootRunId = root.runId
  const child = await vi.waitFor(async () => {
    const found = (await h.snapshot(STORE)).tasks.find(task => task.parentTaskId === root.taskId)
    expect(found).toBeDefined()
    return found!
  }, { timeout: 30_000, interval: 25 })
  const batchId = (await runOf(h, root.runId)).batchId!
  await h.runtime.awaitBatch(STORE, batchId)
  cells.resolveBatch()
  await vi.waitFor(async () => {
    expect((await h.snapshot(STORE)).reviews.some(review => review.taskId === root.taskId && review.outcome === 'failed')).toBe(true)
  }, { timeout: 30_000, interval: 25 })
  if (options.review === false) return { taskId: root.taskId, runId: root.runId, childTaskId: child.taskId }
  // The tree has stopped and its owner asks for the postmortem: a message on the
  // terminal root's own session is what starts that turn (`task_review_agent` is
  // in the coordination list, so a terminal run may still be looked at).
  h.userSays('what happened in that run?', ROOT)
  await vi.waitFor(() => expect(h.calls.some(call => call.name === 'task_review_agent')).toBe(true), { timeout: 30_000, interval: 25 })
  const diagnosisId = await vi.waitFor(async () => {
    const found = (await h.snapshot(STORE)).diagnoses.find(diagnosis => diagnosis.taskId === root.taskId)
    expect(found).toBeDefined()
    return found!.diagnosisId
  }, { timeout: 30_000, interval: 25 })
  cells.diagnosisId = diagnosisId
  if (options.recover !== false) await consumePendingHandoffs(h.ctx, STORE)
  return { taskId: root.taskId, runId: root.runId, childTaskId: child.taskId, diagnosisId }
}

describe('A6: the hand-off a diagnosis becomes, and the supervisor it is delegated to', () => {
  it('delegates the hand-off once, and the supervisor opens the failed goal\'s new attempt through task_recover', async () => {
    const { h, cells } = await startCase()
    const root = await failRootAndReview(h, cells)
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    expect(diagnosis.proposals).toHaveLength(1)

    // ── the hand-off: one supervisor row, one session, the delegation readable ──
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)
    const delegation = await readSupervisorHandoff(STORE, diagnosis.diagnosisId)
    expect(delegation).toMatchObject({ sessionId: supervisor, actor: String(ROOT), started: true, source: { taskId: root.taskId, runId: root.runId } })
    expect(await readSupervisorHandoff(STORE, 'd-other')).toBeUndefined()

    // The coordinator's own surface: the candidate chain and the recovery entry,
    // and none of the tools a promotion or a business write would need.
    const visible = h.visible(h.agent(supervisor))
    for (const name of ['task_recover', 'evolution_candidate', 'evolution_replay', 'task_review_pack']) expect(visible, name).toContain(name)
    for (const name of ['evolution_rollback', 'bash', 'write', 'edit', 'graph_spawn']) expect(visible, name).not.toContain(name)
    expect(SUPERVISOR_BASELINE).toContain('task_recover')

    // Its first request carries the real source, its outcome and the hand-off.
    const prompt = await vi.waitFor(() => {
      const requests = h.requestsOf(supervisor)
      expect(requests.length).toBeGreaterThan(0)
      return requests[0]!.texts.join('\n')
    }, { timeout: 30_000, interval: 25 })
    expect(prompt).toContain(`diagnosis ${diagnosis.diagnosisId} about task ${root.taskId}`)
    expect(prompt).toContain(`source ${root.taskId}#${root.runId}, whose review settled failed`)
    expect(prompt).toContain('task_recover')

    // ── the recovery the supervisor opened, with the tool the model called ─────
    const attempt = await vi.waitFor(async () => {
      const found = (await h.snapshot(STORE)).runs.find(run => run.taskId === root.taskId && run.recovery !== undefined)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 30_000, interval: 25 })
    expect(attempt.recovery).toMatchObject({ sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-1', sourceRunId: root.runId })
    expect(attempt.recovery!.reusedMembers).toEqual([])
    // The old attempt is untouched: its failed run, its review.
    expect((await runOf(h, root.runId)).status).toBe('failed')
    expect((await h.snapshot(STORE)).reviews.some(review => review.runId === root.runId && review.outcome === 'failed')).toBe(true)
    expect(h.spawns.some(spawn => spawn.name.startsWith('recovery of'))).toBe(true)

    // What the tool answered: the new attempt, the key, the coordinator it was
    // authorized by.
    const answer = h.calls.find(call => call.name === 'task_recover')!.result
    expect(answer?.isError).toBe(false)
    expect(answer?.text).toContain('a new attempt was opened')
    expect(answer?.text).toContain(`run ${attempt.runId}`)
    expect(answer?.text).toContain(`supervisor ${supervisor}`)

    // ── the attempt is judged by the original acceptance criteria ────────────
    await vi.waitFor(async () => expect((await runOf(h, attempt.runId)).status).toBe('verified'), { timeout: 30_000, interval: 25 })
    expect((await h.snapshot(STORE)).runs.filter(run => run.taskId === root.taskId)).toHaveLength(2)
    expect((await runOf(h, root.runId)).status).toBe('failed')

    // ── a repeat is answered, never duplicated ───────────────────────────────
    const spawnsBefore = h.spawns.length
    const again = await startSupervisorHandoff(h.ctx, {
      storeId: STORE,
      diagnosis,
      delegator: { sessionId: String(ROOT), agent: h.agent(ROOT) },
      sourceRef: `${root.taskId}#${root.runId}`,
      sourceOutcome: 'failed',
    })
    expect(again).toEqual({ diagnosisId: diagnosis.diagnosisId, result: 'existing', sessionId: supervisor })
    expect(h.spawns.length).toBe(spawnsBefore)
    expect((await h.snapshot(STORE)).runs.filter(run => run.taskId === root.taskId)).toHaveLength(2)
  })

  it('never puts task_recover on a root\'s surface, and refuses a recovery asked for by a session that is not the supervisor', async () => {
    // The supervisor takes nothing up and holds its turn open, so the only
    // attempt that could exist is the one the root itself tries to open.
    const { h, cells } = await startCase({ recover: false, supervisor: [{ hang: true }] })
    const root = await failRootAndReview(h, cells)
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    await supervisorSession(h, diagnosis.diagnosisId)

    // The root's own composition: the recovery entry is not on it, so no root
    // prompt can name it and no root request carries it.
    expect(h.visible(h.agent(String(ROOT)))).not.toContain('task_recover')
    const rootRequests = h.requestsOf(String(ROOT)).map(request => request.texts.join('\n')).join('\n')
    expect(rootRequests).not.toContain('task_recover')

    // A live session that is not the hand-off's supervisor is refused by name —
    // the identity check is the ledger's own record, not the caller's word.
    const refusal = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-root' },
      { sessionId: String(ROOT) },
    ).then(() => '', error => String(error))
    expect(refusal).toContain('is not the supervisor of diagnosis')
    expect((await h.snapshot(STORE)).runs.some(run => run.taskId === root.taskId && run.recovery !== undefined)).toBe(false)
  })

  it('answers an activation scan with the same supervisor, spawning nothing', async () => {
    // The supervisor is still working here (it holds its turn open), so the only
    // spawns this case can see are the member's, the reviewer's and the
    // supervisor's own, and the scan answers with the supervisor the hand-off
    // already has.
    const { h, cells } = await startCase({ recover: false, supervisor: [{ hang: true }] })
    const root = await failRootAndReview(h, cells)
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)
    const before = (await readReviewAgentAttempts(STORE)).filter(attempt => attempt.role === 'supervisor')

    // The activation trigger is the deployment's own rebuild path: a process that
    // booted over this store scans it, reads the ledger and answers with the
    // supervisor the hand-off already has.
    const stop = installSupervisorHandoffTrigger(h.ctx)
    try {
      const spawnsBefore = h.spawns.length
      h.ctx.emit('graphs/selected' as never, { rootSessionId: String(ROOT), id: 'g1' } as never)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(h.spawns.length).toBe(spawnsBefore)
    } finally {
      stop()
    }
    const after = (await readReviewAgentAttempts(STORE)).filter(attempt => attempt.role === 'supervisor')
    expect(after).toEqual(before)
    expect(after[0]!.sessionId).toBe(supervisor)
    expect(await readSupervisorHandoff(STORE, diagnosis.diagnosisId)).toMatchObject({ sessionId: supervisor })
  })

  it('settles a hand-off closed when its supervisor explicitly declines further iteration', async () => {
    // The supervisor's own outcome: a reply that ends with the structured close
    // settles the hand-off — no further round, and no second supervisor for it.
    const closeReply = 'The evidence justifies no further round.\n'
      + '```json\n{"outcome":"closed","reason":"the member was already re-run and nothing else is worth changing"}\n```'
    const { h, cells } = await startCase({ recover: false, supervisorReply: closeReply })
    const root = await failRootAndReview(h, cells, { recover: false })
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    // The recorded diagnosis is consumed on the record's own tick: the
    // deployment starts its supervisor without the spec asking.
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)

    // The attempt's terminal fact is the close it declared, with the reason on it.
    const attempt = await vi.waitFor(async () => {
      const found = (await readReviewAgentAttempts(STORE)).find(
        item => item.role === 'supervisor' && item.diagnosisId === diagnosis.diagnosisId,
      )
      expect(found?.settlement?.status).toBe('closed')
      return found!
    }, { timeout: 30_000, interval: 25 })
    expect(String(attempt.settlement?.note)).toContain('nothing else is worth changing')
    expect(attempt.sessionId).toBe(supervisor)
    // Nothing was opened: no recovery/improvement run exists.
    expect((await h.snapshot(STORE)).runs.filter(run => run.recovery !== undefined)).toEqual([])

    // A further consumption answers with the concluded supervisor: a closed
    // hand-off is settled, not re-delegated.
    const again = await consumePendingHandoffs(h.ctx, STORE)
    expect(again.consumptions).toMatchObject([{ diagnosisId: diagnosis.diagnosisId, result: 'existing', sessionId: supervisor }])
    expect(h.spawns.filter(spawn => spawn.name === `supervisor for ${diagnosis.diagnosisId}`)).toHaveLength(1)
  })
})

describe('A6: what the pack and the consumption say about a hand-off', () => {
  it('reports the hand-off as taken up, with the supervisor that owns it, and keeps the review list to reviews', async () => {
    // The supervisor holds its turn open, so the hand-off is still owned by a
    // live attempt when the pack is built.
    const { h, cells } = await startCase({ supervisor: [{ hang: true }] })
    const root = await failRootAndReview(h, cells)
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)

    const snapshot = await h.snapshot(STORE)
    const attempts = await readReviewAgentAttempts(STORE)
    const pack = buildReviewPack({
      snapshot,
      source: { taskId: root.taskId, runId: root.runId },
      attempts,
      handoff: { attempts, budget: { used: attempts.filter(attempt => attempt.started).length, max: 3 } },
    })
    expect(pack).toContain(`handoff: taken up — this hand-off is delegated to supervisor session ${supervisor}`)
    expect(pack).toContain('the member needs a capability the deployment does not grant')
    // A supervisor row is not a review attempt of the source: the reviewer-facing
    // list stays the reviews.
    expect(pack).toContain('review attempts (1):')
    expect(pack).not.toContain(`review attempts (2):`)
  })

  it('takes up a suggestion this build has no executor for, and keeps the suggestion a record', async () => {
    const { h, cells } = await startCase({ recover: false, supervisor: [{ hang: true }] })
    const root = await failRootAndReview(h, cells, { recover: false })
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!

    // A verifier implementation is a target type this build records but has no
    // candidate surface for: the hand-off is the diagnosis, so it proceeds to
    // its supervisor exactly as any other does, and the suggestion stays what
    // it was — the coordinator studies it and can execute nothing for it.
    const unsupported = {
      ...diagnosis,
      diagnosisId: 'd-verifier',
      proposals: [{ targetType: 'verifier', targetId: 'a-new-judge', rationale: 'write one' }],
    }
    const consumption = await startSupervisorHandoff(h.ctx, {
      storeId: STORE,
      diagnosis: unsupported,
      delegator: { sessionId: String(ROOT), agent: h.agent(ROOT) },
      sourceRef: `${root.taskId}#${root.runId}`,
      sourceOutcome: 'failed',
    })
    expect(consumption).toMatchObject({ result: 'started' })
    expect(h.spawns.some(spawn => spawn.name === 'supervisor for d-verifier')).toBe(true)
    expect(await readSupervisorHandoff(STORE, 'd-verifier')).toBeDefined()
    // Recorded, so the pack has the hand-off to report (a diagnosis the store does
    // not hold is not one a reader could see).
    await h.task.recordDiagnosisIn(STORE, unsupported, 'test')

    const snapshot = await h.snapshot(STORE)
    const attempts = await readReviewAgentAttempts(STORE)
    const pack = buildReviewPack({
      snapshot,
      source: { taskId: root.taskId, runId: root.runId },
      attempts,
      handoff: { attempts, budget: { used: attempts.filter(attempt => attempt.started).length, max: 3 } },
    })
    expect(pack).toContain('proposal verifier a-new-judge: write one')
    expect(pack).toContain('handoff: taken up — this hand-off is delegated to supervisor session')
  })

  it('takes up a diagnosis that carries no proposals: any diagnosis proceeds to its supervisor', async () => {
    // The hand-off is the diagnosis itself: the preflight no longer asks for a
    // skill or capability suggestion, so a conclusion-only postmortem still
    // reaches a coordinator — the deployment's own consumption starts it.
    const conclusionOnly = '```json\n'
      + '{"observation":"the root goal failed its own map","conclusion":"the member never held its criterion","confidence":"high"}'
      + '\n```'
    const { h, cells } = await startCase({ recover: false, reviewReply: conclusionOnly, supervisor: [{ hang: true }] })
    const root = await failRootAndReview(h, cells, { recover: false })
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    expect(diagnosis.proposals).toEqual([])

    const sessionId = await supervisorSession(h, diagnosis.diagnosisId)
    expect(await readSupervisorHandoff(STORE, diagnosis.diagnosisId)).toMatchObject({
      sessionId,
      source: { taskId: root.taskId, runId: root.runId },
    })
    // A further consumption answers with the supervisor already delegated.
    const consumption = await consumePendingHandoffs(h.ctx, STORE)
    expect(consumption.consumptions).toEqual([
      expect.objectContaining({ diagnosisId: diagnosis.diagnosisId, result: 'existing', sessionId }),
    ])
  })

  it('starts the supervisor in a deployment that never mounted the evolution plane', async () => {
    // The evolution chain is not a precondition of the hand-off: a deployment
    // that never mounted it still delegates a recorded diagnosis to a
    // coordinator, which is where the chain would be opened if it existed.
    const { h, cells } = await startCase({ recover: false, evolution: false, supervisor: [{ hang: true }] })
    const root = await failRootAndReview(h, cells, { recover: false })
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!

    const sessionId = await supervisorSession(h, diagnosis.diagnosisId)
    expect(await readSupervisorHandoff(STORE, diagnosis.diagnosisId)).toMatchObject({ sessionId })
  })

  it('accepts an improvement round for a source that succeeded, up to the configured cap', async () => {
    // One improvement round is the allowance this deployment names, so the cap's
    // own refusal is the second attempt's answer — no third or fourth run and no
    // second attempt record.
    const { h, cells } = await startCase({ supervision: { maxImprovementRounds: 1 } })
    const root = await failRootAndReview(h, cells)
    const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === root.taskId)!
    const supervisor = await supervisorSession(h, diagnosis.diagnosisId)
    const attempt = await vi.waitFor(async () => {
      const found = (await h.snapshot(STORE)).runs.find(run => run.taskId === root.taskId && run.recovery !== undefined)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 30_000, interval: 25 })
    await vi.waitFor(async () => expect((await runOf(h, attempt.runId)).status).toBe('verified'), { timeout: 30_000, interval: 25 })

    // The source's review settled `verified` now, so the default mode is not the
    // door: an attempt that names no mode is refused by name.
    const runsBefore = (await h.snapshot(STORE)).runs.length
    const plain = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-plain-after-success' },
      { sessionId: supervisor },
    ).then(() => '', error => String(error))
    expect(plain).toContain('improve')
    expect((await h.snapshot(STORE)).runs).toHaveLength(runsBefore)

    // An improvement round of the verified source is accepted, and the attempt's
    // own record says which kind of round it is.
    const improvement = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-improve', mode: 'improve' },
      { sessionId: supervisor },
    )
    expect(improvement.attempt).toBe('started')
    const improvementRun = await vi.waitFor(async () => {
      const found = (await h.snapshot(STORE)).runs.find(run => run.runId === improvement.runId)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 30_000, interval: 25 })
    expect(improvementRun.recovery).toMatchObject({
      kind: 'improvement',
      sourceDiagnosisId: diagnosis.diagnosisId,
      sourceRunId: attempt.runId,
    })
    // The improvement is judged by the original criteria and the source's old
    // facts stay readable beside it.
    await vi.waitFor(async () => expect((await runOf(h, improvement.runId)).status).toBe('verified'), { timeout: 30_000, interval: 25 })
    expect((await runOf(h, attempt.runId)).status).toBe('verified')
    expect((await h.snapshot(STORE)).runs.filter(run => run.taskId === root.taskId)).toHaveLength(3)

    // The second improvement is the cap's business: refused by name, with no run.
    const middle = (await h.snapshot(STORE)).runs.length
    const capped = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnosis.diagnosisId, requestKey: 'k-improve-2', mode: 'improve' },
      { sessionId: supervisor },
    ).then(() => '', error => String(error))
    expect(capped).toContain('iteration-cap')
    expect((await h.snapshot(STORE)).runs).toHaveLength(middle)
  })
})

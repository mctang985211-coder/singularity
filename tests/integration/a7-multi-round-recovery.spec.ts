/**
 * A7: the multi-round supervisor-iteration loop, carried to its end.
 *
 * The question this case answers is whether the harness really *iterates*: a
 * root goal fails, its failed review is diagnosed, the diagnosis is handed to a
 * supervisor, the supervisor opens a new attempt — and when that attempt fails
 * too, does its own failure start the next round, all the way to the round that
 * finally verifies? Three attempts run here, and the loop stops on the verified
 * one; a fourth round is asserted never to start.
 *
 * One deployment, one root contract with three file-marker criteria, and the
 * chain runs the way a deployment runs it: the real DSH loop with a scripted
 * model, the real store, the real runtime, the real evolution plane, the real
 * tools — and the A5 automatic trigger installed (the scripted harness mounts no
 * trigger by default). The iterations are *not* driven by the spec: each
 * terminal failure is accepted on its own, the reviewer's diagnosis is consumed
 * by the hand-off, the supervisor calls `task_recover` from its own script, and
 * the runtime opens the next attempt.
 *
 * A round's score is not a field: `ReviewRecord` carries no score by design, so
 * the reader derives one from the criteria verdicts the record copied. The
 * helper below is that derivation, and the table it prints is this case's
 * deliverable — attempt → outcome → passed/total → unmet criteria → retries:
 *
 *   round 1: the member produces deliverable 1 → the goal fails 1 of 3 criteria
 *   round 2: a new member produces deliverable 2 → the goal fails 1 of 3
 *   round 3: a new member produces deliverable 3 → the goal verifies, and the loop stops
 *
 * The end of the loop is asserted with it: after the goal verified, no reviewer
 * and no supervisor is started for that run, and a recovery of the successful
 * source is refused by name. The recovery's own binding is asserted too: an
 * already-verified position is *read*, not re-run — attempt N only runs the
 * member that produces deliverable N.
 *
 * The second case pins the ceiling a live deployment meets before any of this:
 * the coordination allowance defaults to **one** attempt per store, the first
 * failed round's reviewer spends it, and the hand-off that reviewer leaves is
 * refused as `budget-exhausted` — so a deployment that wants iteration has to
 * raise the allowance (a store needs two attempts per recovering round).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  countReviewAgentRuns,
  readReviewAgentAttempts,
  readSupervisorHandoff,
  REVIEW_AGENT_BUDGET_DEFAULT,
} from '../../agent-singularity/src/coordination/ledger.ts'
import { consumePendingHandoffs } from '../../agent-singularity/src/coordination/evolution-handoff.ts'
import { installReviewAgentAutoTrigger } from '../../agent-singularity/src/coordination/review-scan.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { ReviewOutcome, TaskId, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))

/** The round the iteration is allowed to reach: three attempts, the third one verified. */
const ROUNDS = 3

/**
 * The root contract every case runs under: three independently checkable
 * deliverables, each a marker file in the shared checkout. Who produces the
 * markers is the attempt's own member (below), so the goal's own criteria count
 * 1/3 → 2/3 → 3/3 as the rounds go on.
 */
const ROOT_CONTRACT = {
  objective: 'ship the release',
  acceptanceCriteria: [
    { criterionId: 'mark-1', description: 'deliverable 1 is in place', command: 'test -f marker-1' },
    { criterionId: 'mark-2', description: 'deliverable 2 is in place', command: 'test -f marker-2' },
    { criterionId: 'mark-3', description: 'deliverable 3 is in place', command: 'test -f marker-3' },
  ],
}

/**
 * The reviewer's answer: the postmortem of the failed source, carrying the one
 * skill suggestion the hand-off preflight accepts (`skill` is a supported
 * target). Every round's reviewer answers with this same shape, so every failed
 * round has a hand-off for the consumption to take up.
 */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the root goal failed its own acceptance criteria",'
  + '"conclusion":"the next attempt must produce the deliverables the failing markers name",'
  + '"confidence":"high",'
  + '"proposals":[{"targetType":"skill","targetId":"release-delivery",'
  + '"rationale":"a same-name update of the delivery skill is the change the evidence establishes"}]}'
  + '\n```'

/** One round's derived score, read off the store — the record has no score field, so this is the derivation. */
interface RoundScore {
  /** 1-based attempt number, in the root task's own run order. */
  attempt: number
  runId: string
  outcome: ReviewOutcome
  /** Criteria on this run's review whose verdict is `pass`. */
  passed: number
  /** Criteria the review carries a verdict for. */
  total: number
  /** The derived score, `passed/total`. */
  score: string
  /** The criteria that did not pass, in the review's own order. */
  unmetCriterionIds: string[]
  /** `ReviewMetrics.retries`: the run count beyond the first (`runIds.length - 1`). */
  retries: number | undefined
  durationMs: number | undefined
  /** Session tool calls the review observed; `ReviewMetrics.toolCalls.calls`. */
  toolCalls: number | undefined
}

/**
 * The round → derived-score table of one root task: for every run the task has,
 * in `runIds` order, the terminal review's outcome and the score derived from
 * its criteria verdicts. A run without a review is a broken store, not a zero.
 */
function derivedRoundScores(snapshot: TaskSnapshot, taskId: TaskId): RoundScore[] {
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`the store holds no task "${taskId}"`)
  return task.runIds.map((runId, index) => {
    const review = snapshot.reviews.find(item => item.taskId === taskId && item.runId === runId)
    if (review === undefined) throw new Error(`the store holds no terminal review for run "${runId}"`)
    const criteria = review.criteria ?? []
    const passed = criteria.filter(item => item.verdict === 'pass').length
    return {
      attempt: index + 1,
      runId,
      outcome: review.outcome,
      passed,
      total: criteria.length,
      score: `${passed}/${criteria.length}`,
      unmetCriterionIds: criteria.filter(item => item.verdict !== 'pass').map(item => item.criterionId),
      retries: review.metrics?.retries,
      durationMs: review.durationMs,
      toolCalls: review.metrics?.toolCalls?.calls,
    }
  })
}

/**
 * The member criteria one attempt's own new member produces: attempt N produces
 * deliverable N, and the criterion's command is what writes its marker (the
 * fixture's tool plane has no real shell, so the acceptance command is the
 * writing hand here). The earlier deliverables are read, not re-run: the
 * recovery binds every verified position of the failed run (below).
 */
function deliverableCriterion(round: number): readonly { criterionId: string; description: string; command: string }[] {
  return [{
    criterionId: `deliverable-${round}`,
    description: `deliverable ${round} is produced`,
    command: `touch marker-${round}`,
  }]
}

/** The objective the round's member spawn carries — the name a case counts member spawns by. */
function memberObjective(round: number): string {
  return `the member that produces deliverable ${round}`
}

/**
 * Wait until the batch this session admitted has ended and handed the run back
 * (`waiting_children → active`). The model's own turn ends after its text; the
 * batch-end message is what starts the next one, and this latch is consumed
 * there — the same shape `a6-supervisor.spec.ts` parks its root on.
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
 * The script every case in this file runs. A session's role is read from its
 * spawn name, exactly as the deployment's own composition decides it:
 *
 * - a **supervisor** takes up its own hand-off (its spawn name carries the
 *   diagnosis) and opens the next attempt with a distinct key per round;
 * - a **reviewer** answers the postmortem every round;
 * - a **recovery** worker re-runs the goal with only the round's new member: the
 *   earlier deliverables are bound from the failed run's verified positions, so
 *   the recovered run's own failure — or its success — starts the next round or
 *   ends the loop;
 * - the **root** runs only round 1 and hands its own result in.
 */
function script(h: () => ScriptedLoop): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index) => {
    const loop = h()
    const name = loop.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? ''
    if (name.startsWith('supervisor for')) {
      const diagnosisId = name.slice('supervisor for '.length)
      const round = loop.spawns.filter(spawn => spawn.name.startsWith('supervisor for')).length
      return [
        { tool: 'task_recover', args: { sourceDiagnosisId: diagnosisId, requestKey: `k-${round}` } },
        { text: `supervisor: attempt ${round + 1} is open` },
      ]
    }
    if (name.startsWith('review ')) return [{ text: REVIEW_REPLY }]
    if (name.startsWith('recovery of')) {
      const round = loop.spawns.filter(spawn => spawn.name.startsWith('recovery of')).length + 1
      return [
        {
          tool: 'task_decompose',
          args: {
            reason: `re-run the goal for attempt ${round}`,
            children: [{ objective: memberObjective(round), acceptanceCriteria: deliverableCriterion(round) }],
          },
        },
        { text: `attempt ${round}: the replacement is running` },
        { waitFor: () => waitForHandback(loop, sessionId) },
        { tool: 'task_submit_result', args: { summary: `attempt ${round} is handed in` } },
        { text: `attempt ${round}: handed in` },
      ]
    }
    if (index === 0) {
      return [
        {
          tool: 'task_decompose',
          args: {
            reason: 'split the work',
            children: [{ objective: memberObjective(1), acceptanceCriteria: deliverableCriterion(1) }],
          },
        },
        { text: 'root: the batch is running' },
        { waitFor: () => waitForHandback(loop, sessionId) },
        { tool: 'task_submit_result', args: { summary: 'root: handed in' } },
        { text: 'root: handed in' },
      ]
    }
    return [
      { tool: 'task_submit_result', args: { summary: 'member: handed in' } },
      { text: 'member: handed in' },
    ]
  }
}

/** One store's runs of one task, in the task's own run order. */
function runsOf(snapshot: TaskSnapshot, taskId: TaskId): TaskRun[] {
  const task = snapshot.tasks.find(item => item.taskId === taskId)!
  return task.runIds.map(runId => snapshot.runs.find(run => run.runId === runId)!)
}

const ledgerDirs: string[] = []

beforeEach(() => {
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  // Two coordination attempts per recovering round (reviewer + supervisor), and
  // one round that needs none: six is headroom, and the case asserts the spend.
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '6')
})

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
  for (const dir of ledgerDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('A7: the multi-round supervisor-iteration loop', () => {
  it('carries three rounds — 1/3, 2/3, 3/3 — and stops when the goal verifies', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'a7-multi-round-'))
    ledgerDirs.push(ledgerRoot)
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      roots: [ROOT],
      script: script(() => h),
      evolution: { ledgerRoot },
    })
    // The A5 automatic trigger is the deployment's own composition, and the
    // scripted harness mounts none: without this install, a failed review is
    // only a record and no round of the iteration starts.
    installReviewAgentAutoTrigger(h.ctx)
    const root = await h.begin(ROOT_CONTRACT)

    // ── the loop really iterates: three attempts, the last one verified ───────
    await vi.waitFor(async () => {
      const snapshot = await h.snapshot(STORE)
      const runs = runsOf(snapshot, root.taskId)
      expect(runs.map(run => run.status)).toEqual(['failed', 'failed', 'verified'])
    }, { timeout: 60_000, interval: 25 })

    // A verified goal is where the loop stops: give any late trigger a window to
    // move, then assert nothing did — no fourth run, no new review attempt, no
    // new supervisor, and the goal still verified.
    await new Promise(resolve => setTimeout(resolve, 300))
    const snapshot = await h.snapshot(STORE)
    const task = snapshot.tasks.find(item => item.taskId === root.taskId)!
    const runs = runsOf(snapshot, task.taskId)
    expect(runs.map(run => run.status)).toEqual(['failed', 'failed', 'verified'])

    // ── one review per run, in run order, judged by the original criteria ─────
    const reviews = snapshot.reviews.filter(review => review.taskId === task.taskId)
    expect(reviews.map(review => review.runId)).toEqual(task.runIds)
    expect(reviews).toHaveLength(ROUNDS)
    for (const review of reviews) {
      expect(review.criteria?.map(criterion => criterion.criterionId).sort()).toEqual(['mark-1', 'mark-2', 'mark-3'])
    }

    // ── the round → derived-score table (the data this case exists to produce) ─
    const scores = derivedRoundScores(snapshot, task.taskId)
    // The helper's output shape is asserted before it is printed: a reader of the
    // table below is reading exactly these fields.
    expect(Object.keys(scores[0]!).sort()).toEqual(
      ['attempt', 'durationMs', 'outcome', 'passed', 'retries', 'runId', 'score', 'toolCalls', 'total', 'unmetCriterionIds'],
    )
    console.log('A7 multi-round supervisor iteration — round → derived score (root task)')
    console.table(scores.map(row => ({
      attempt: row.attempt,
      outcome: row.outcome,
      score: row.score,
      passed: row.passed,
      total: row.total,
      unmetCriterionIds: row.unmetCriterionIds.join(', ') || '—',
      retries: row.retries ?? '—',
      durationMs: row.durationMs ?? '—',
      toolCalls: row.toolCalls ?? '—',
    })))
    console.log(`A7 round → derived score, as data: ${JSON.stringify(scores)}`)

    // The measured improvement: every round passes one more original criterion.
    expect(scores.map(row => row.score)).toEqual(['1/3', '2/3', '3/3'])
    expect(scores.map(row => row.outcome)).toEqual(['failed', 'failed', 'verified'])
    expect(scores.map(row => row.unmetCriterionIds)).toEqual([['mark-2', 'mark-3'], ['mark-3'], []])
    // `ReviewMetrics.retries` counts the task's runs beyond the first, so the
    // derived score rises while the run count is what this counter reports.
    expect(scores.map(row => row.retries)).toEqual([0, 1, 2])

    // ── the recovery lineage: each attempt names the run it recovers, and
    //    reads the verified positions instead of re-running them ──────────────
    const members = task.childTaskIds.map(taskId => snapshot.tasks.find(item => item.taskId === taskId)!)
    expect(members.map(member => member.objective)).toEqual([
      memberObjective(1), memberObjective(2), memberObjective(3),
    ])
    const memberRuns = members.map(member => snapshot.runs.find(run => run.taskId === member.taskId)!)
    expect(runs[0]!.recovery).toBeUndefined()
    expect(runs[1]!.recovery).toMatchObject({ requestKey: 'k-1', sourceRunId: runs[0]!.runId })
    expect(runs[1]!.recovery!.reusedMembers).toEqual([
      expect.objectContaining({ childIndex: 0, taskId: members[0]!.taskId, sourceRunId: memberRuns[0]!.runId }),
    ])
    expect(runs[2]!.recovery).toMatchObject({ requestKey: 'k-2', sourceRunId: runs[1]!.runId })
    expect(runs[2]!.recovery!.reusedMembers).toEqual([
      expect.objectContaining({ childIndex: 0, taskId: members[0]!.taskId, sourceRunId: memberRuns[0]!.runId }),
      expect.objectContaining({ childIndex: 1, taskId: members[1]!.taskId, sourceRunId: memberRuns[1]!.runId }),
    ])
    // Only the missing position was run again: one member spawn per round, three
    // in all — the verified positions the attempt bound were never re-run.
    for (const round of [1, 2, 3]) {
      expect(h.spawns.filter(spawn => spawn.name === memberObjective(round))).toHaveLength(1)
    }
    expect(memberRuns.map(run => run.status)).toEqual(['verified', 'verified', 'verified'])
    // The old failure stays readable exactly as it settled.
    expect(runs[0]!.status).toBe('failed')
    expect(runs[1]!.status).toBe('failed')

    // ── one hand-off per failed round, each with its own supervisor ───────────
    const diagnoses = snapshot.diagnoses.filter(diagnosis => diagnosis.taskId === task.taskId)
    expect(diagnoses).toHaveLength(2)
    expect(diagnoses.every(diagnosis => diagnosis.proposals.length === 1)).toBe(true)
    const reviewerSpawns = h.spawns.filter(spawn => spawn.name === `review ${task.taskId}`)
    const supervisorSpawns = h.spawns.filter(spawn => spawn.name.startsWith('supervisor for'))
    expect(reviewerSpawns).toHaveLength(2)
    expect(supervisorSpawns).toHaveLength(2)
    expect(h.spawns.filter(spawn => spawn.name.startsWith('recovery of'))).toHaveLength(2)
    for (const [index, diagnosis] of diagnoses.entries()) {
      const supervisor = String(supervisorSpawns[index]!.sessionId)
      expect(supervisorSpawns[index]!.name).toBe(`supervisor for ${diagnosis.diagnosisId}`)
      expect(await readSupervisorHandoff(STORE, diagnosis.diagnosisId)).toMatchObject({
        sessionId: supervisor,
        source: { taskId: task.taskId, runId: runs[index]!.runId },
      })
    }

    // ── the coordination ledger: exactly two rounds were spent ────────────────
    const attempts = await readReviewAgentAttempts(STORE)
    expect(attempts.map(attempt => attempt.role)).toEqual(['reviewer', 'supervisor', 'reviewer', 'supervisor'])
    expect(attempts.filter(attempt => attempt.role === 'reviewer').map(attempt => ({
      source: attempt.source,
      actor: attempt.actor,
      status: attempt.settlement?.status,
    }))).toEqual([
      { source: { taskId: task.taskId, runId: runs[0]!.runId }, actor: String(ROOT), status: 'recorded' },
      { source: { taskId: task.taskId, runId: runs[1]!.runId }, actor: String(ROOT), status: 'recorded' },
    ])
    // 2 reviewers + 2 supervisors: the rounds that needed coordination spent two
    // attempts each, and the verified third round spent none (4 of the 6).
    expect(await countReviewAgentRuns(STORE)).toBe(4)
    expect(attempts).toHaveLength(4)
    // The verified run was never accepted for a review: no attempt names it.
    expect(attempts.some(attempt => attempt.source.runId === runs[2]!.runId)).toBe(false)

    // ── after verified, the loop is closed on both doors ──────────────────────
    const supervisorOfLastRound = String(supervisorSpawns[1]!.sessionId)
    const refusal = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnoses[1]!.diagnosisId, requestKey: 'k-after-success' },
      { sessionId: supervisorOfLastRound },
    ).then(() => '', error => String(error))
    expect(refusal).toContain('a successful source is not recovered')
    expect((await h.snapshot(STORE)).runs.filter(run => run.taskId === task.taskId)).toHaveLength(ROUNDS)
    expect(await countReviewAgentRuns(STORE)).toBe(4)
  }, 90_000)

  it('is stopped by the deployment\'s default allowance after the first round: the reviewer spends the store\'s only attempt', async () => {
    // The deployment default is one coordination attempt per store
    // (`REVIEW_AGENT_BUDGET_DEFAULT`). The failed review is accepted on its own
    // — and that reviewer is the attempt; the hand-off its diagnosis leaves has
    // none left, so the first recovery never opens.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '')
    expect(REVIEW_AGENT_BUDGET_DEFAULT).toBe(1)
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'a7-default-budget-'))
    ledgerDirs.push(ledgerRoot)
    let h!: ScriptedLoop
    h = await startScriptedLoop({ roots: [ROOT], script: script(() => h), evolution: { ledgerRoot } })
    installReviewAgentAutoTrigger(h.ctx)
    const root = await h.begin(ROOT_CONTRACT)

    // Round 1's failure is diagnosed: the reviewer is the one spent attempt.
    const diagnosis = await vi.waitFor(async () => {
      const snapshot = await h.snapshot(STORE)
      const found = snapshot.diagnoses.find(item => item.taskId === root.taskId)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 60_000, interval: 25 })
    expect(await countReviewAgentRuns(STORE)).toBe(1)
    expect(h.spawns.filter(spawn => spawn.name.startsWith('supervisor for'))).toEqual([])

    // The hand-off is refused by name at the consumption entry — the same entry
    // the deployment's triggers call — and nothing is started for it.
    const consumption = await consumePendingHandoffs(h.ctx, STORE)
    expect(consumption.consumptions).toEqual([
      expect.objectContaining({ diagnosisId: diagnosis.diagnosisId, result: 'stopped', code: 'budget-exhausted' }),
    ])
    expect(consumption.consumptions[0]!.reason).toContain('1/1')
    // One failed attempt, one reviewer, no supervisor, no recovery run.
    expect(h.spawns.filter(spawn => spawn.name.startsWith('review '))).toHaveLength(1)
    const snapshot = await h.snapshot(STORE)
    expect(runsOf(snapshot, root.taskId).map(run => run.status)).toEqual(['failed'])
    expect(await countReviewAgentRuns(STORE)).toBe(1)
  }, 90_000)
})

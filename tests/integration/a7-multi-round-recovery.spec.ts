/**
 * A7: the multi-round supervisor-iteration loop, carried to its end.
 *
 * The question this case answers is whether the harness really *iterates*: a
 * root goal fails, its failed review is diagnosed, the diagnosis is handed to a
 * supervisor, the supervisor opens a new attempt — and when that attempt fails
 * too, does its own failure start the next round, all the way to the round that
 * finally verifies? Three attempts run here, and the loop stops on the verified
 * one. Then the second half of the new contract runs: the verified round's own
 * review is accepted by default too, its supervisor opens an **improvement**
 * round (`mode: 'improve'`, `RunRecovery.kind: 'improvement'`), and the
 * improvement chain is capped by `maxImprovementRounds` — the next improvement
 * is refused with the coded `iteration-cap` before any supervisor is delegated.
 *
 * One deployment, one root contract with three file-marker criteria, and the
 * chain runs the way a deployment runs it: the real DSH loop with a scripted
 * model, the real store, the real runtime, the real evolution plane, the real
 * tools — and the A5 automatic trigger installed (the scripted harness mounts no
 * trigger by default). The iterations are *not* driven by the spec: each
 * terminal review is accepted on its own, the reviewer's diagnosis is consumed
 * by the hand-off, the supervisor calls `task_recover` from its own script, and
 * the runtime opens the next attempt.
 *
 * A round's score is not a field: `ReviewRecord` carries no score by design, so
 * the reader derives one from the criteria verdicts the record copied. The
 * helper below is that derivation, and the table it prints is this case's
 * deliverable — attempt → kind → outcome → passed/total → unmet criteria →
 * retries:
 *
 *   round 1: the member produces deliverable 1 → the goal fails 1 of 3 criteria
 *   round 2: a new member produces deliverable 2 → the goal fails 1 of 3
 *   round 3: a new member produces deliverable 3 → the goal verifies
 *   round 4: an improvement round of the verified goal → 3/3 again
 *
 * This deployment names one improvement round (`maxImprovementRounds: 1`), so
 * the cap's refusal is the next thing the loop meets: the verified fourth
 * round's diagnosis is refused as `iteration-cap`. The end of the iteration is
 * asserted with it, and the recovery's own binding is asserted round by round —
 * an already-verified position is *read*, not re-run, so rounds 1–3 only run the
 * member that produces their own deliverable and the improvement round runs no
 * member at all.
 *
 * The second case pins the coordination allowance and the shipped caps: the
 * allowance defaults to eight attempts per store (`REVIEW_AGENT_BUDGET_DEFAULT`)
 * with three recovery and two improvement rounds, and with an explicitly small
 * allowance the first failed round's reviewer spends it, so the hand-off that
 * reviewer leaves is refused as `budget-exhausted`.
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
import { DEFAULT_SUPERVISION } from '../../agent-singularity/src/coordination/supervision.ts'
import { startSupervisorHandoff } from '../../agent-singularity/src/coordination/evolution-handoff.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { ReviewOutcome, TaskId, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))

/** The three recovery rounds of the chain: two failed attempts, the third verified. */
const RECOVERY_ROUNDS = 3
/** The improvement rounds this case names (`maxImprovementRounds: 1`): one round, then the cap. */
const IMPROVEMENT_ROUNDS = 1
/** Every round the loop reaches: three recoveries plus the one improvement round. */
const ROUNDS = RECOVERY_ROUNDS + IMPROVEMENT_ROUNDS

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
  /**
   * What kind of round this run is: `initial` (the goal's first own run),
   * `recovery` (a failed source's new attempt) or `improvement` (a verified
   * source's new attempt), read from the run's own `RunRecovery`.
   */
  kind: 'initial' | 'recovery' | 'improvement'
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
 * in `runIds` order, the terminal review's outcome, the round's own kind and the
 * score derived from its criteria verdicts. A run without a review is a broken
 * store, not a zero.
 */
function derivedRoundScores(snapshot: TaskSnapshot, taskId: TaskId): RoundScore[] {
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`the store holds no task "${taskId}"`)
  return task.runIds.map((runId, index) => {
    const run = snapshot.runs.find(item => item.runId === runId)
    const review = snapshot.reviews.find(item => item.taskId === taskId && item.runId === runId)
    if (review === undefined) throw new Error(`the store holds no terminal review for run "${runId}"`)
    const criteria = review.criteria ?? []
    const passed = criteria.filter(item => item.verdict === 'pass').length
    return {
      attempt: index + 1,
      runId,
      kind: run?.recovery?.kind ?? 'initial',
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

/** The store's root task, once the root contract activated it. The script reads it to tell a root run's review from a member's. */
interface Cells {
  rootTaskId?: string
}

/**
 * The source task a supervisor spawn's hand-off was delegated for: the diagnosis
 * id is the reviewer's own record id (`review-agent-<session>`, review-agent-run.ts),
 * and the reviewer's spawn name carries its source task.
 */
function sourceTaskOf(loop: ScriptedLoop, supervisorSpawnName: string): string {
  const diagnosisId = supervisorSpawnName.slice('supervisor for '.length)
  if (!diagnosisId.startsWith('review-agent-')) return ''
  const reviewer = loop.spawns.find(spawn => String(spawn.sessionId) === diagnosisId.slice('review-agent-'.length))
  return reviewer?.name.startsWith('review ') === true ? reviewer.name.slice('review '.length) : ''
}

/**
 * The script every case in this file runs. A session's role is read from its
 * spawn name, exactly as the deployment's own composition decides it:
 *
 * - a **supervisor** takes up its own hand-off (its spawn name carries the
 *   diagnosis) and opens the next attempt with a distinct key per round — a
 *   recovery (`mode: 'recovery'`) for a failed source, an improvement
 *   (`mode: 'improve'`) once the source's review has settled `verified`. A
 *   member's hand-off asks the same way and is refused by the runtime (a child
 *   is re-run by its parent's batch), which is the member rounds' own exit;
 * - a **reviewer** answers the postmortem every round;
 * - a **recovery** worker re-runs the goal with only the round's new member: the
 *   earlier deliverables are bound from the failed run's verified positions, so
 *   the recovered run's own failure — or its success — starts the next round;
 *   an **improvement** worker's source has every position verified, so it hands
 *   its result in without running anything (the improvement round is judged by
 *   the original criteria against the same deliverables);
 * - the **root** runs only round 1 and hands its own result in.
 */
function script(h: () => ScriptedLoop, cells: Cells): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index) => {
    const loop = h()
    const name = loop.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? ''
    if (name.startsWith('supervisor for')) {
      const diagnosisId = name.slice('supervisor for '.length)
      // The root-task hand-offs, in order: rounds 1–2 recover a failed source,
      // the rounds after the goal verified improve it. A member's hand-off never
      // opens a run (the runtime refuses a child's recovery), so its mode is the
      // default.
      const rootTaskId = cells.rootTaskId
      const rootRound = loop.spawns
        .filter(spawn => spawn.name.startsWith('supervisor for'))
        .filter(spawn => sourceTaskOf(loop, spawn.name) === rootTaskId)
        .length
      const isRootSource = rootTaskId !== undefined && sourceTaskOf(loop, name) === rootTaskId
      const mode = isRootSource && rootRound >= 3 ? 'improve' : 'recovery'
      return [
        {
          tool: 'task_recover',
          args: { sourceDiagnosisId: diagnosisId, requestKey: isRootSource ? `k-${rootRound}` : `k-member-${String(sessionId)}`, mode },
        },
        { text: `supervisor: attempt for ${diagnosisId} is answered` },
      ]
    }
    if (name.startsWith('review ')) return [{ text: REVIEW_REPLY }]
    if (name.startsWith('recovery of')) {
      const round = loop.spawns.filter(spawn => spawn.name.startsWith('recovery of')).length + 1
      if (round >= 4) {
        // An improvement round of an already-verified goal: every position is
        // verified and bound, so the run has nothing of its own to run and hands
        // its result in for the original criteria to judge.
        return [
          { tool: 'task_submit_result', args: { summary: `improvement ${round} is handed in` } },
          { text: `improvement ${round}: handed in` },
        ]
      }
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
  // Every terminal review of the store's tree is accepted under the shipped
  // policy — the root's five rounds and each member's verified run — and each
  // accepted diagnosis is delegated to its own supervisor: one reviewer and one
  // supervisor per review. Twelve would cover the root's chain alone; twenty-four
  // leaves the member rounds' own reviewers and supervisors their room, and the
  // case asserts the spend against the reviews the store holds.
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '24')
})

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
  for (const dir of ledgerDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('A7: the multi-round supervisor-iteration loop', () => {
  it('carries three recovery rounds — 1/3, 2/3, 3/3 — then one improvement round, then the cap', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'a7-multi-round-'))
    ledgerDirs.push(ledgerRoot)
    const cells: Cells = {}
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      roots: [ROOT],
      script: script(() => h, cells),
      evolution: { ledgerRoot },
      // One improvement round, so the round after it is where the cap's own
      // refusal is read; the shipped caps are pinned in the second case.
      supervision: { maxImprovementRounds: IMPROVEMENT_ROUNDS },
    })
    // The A5 automatic trigger is the deployment's own composition, and the
    // scripted harness mounts none: without this install, a terminal review is
    // only a record and no round of the iteration starts. The shipped policy
    // (`autoReview: 'all'`) accepts the verified rounds too, which is what opens
    // the improvement rounds after round 3.
    installReviewAgentAutoTrigger(h.ctx)
    const root = await h.begin(ROOT_CONTRACT)
    cells.rootTaskId = root.taskId

    // ── the loop really iterates: three recovery rounds and one improvement
    //    round, every one of them judged by the original criteria ──────────────
    await vi.waitFor(async () => {
      const snapshot = await h.snapshot(STORE)
      const runs = runsOf(snapshot, root.taskId)
      expect(runs.map(run => run.status)).toEqual(['failed', 'failed', 'verified', 'verified'])
    }, { timeout: 60_000, interval: 25 })

    // The cap is read on the verified fourth round's OWN diagnosis: wait for it
    // to be recorded too — run 4's status settles before its review diagnosis
    // exists, and the round before it answers 'existing' quite legitimately.
    await vi.waitFor(async () => {
      const snapshot = await h.snapshot(STORE)
      expect(snapshot.diagnoses.filter(diagnosis => diagnosis.taskId === root.taskId)).toHaveLength(ROUNDS)
    }, { timeout: 60_000, interval: 25 })

    // The improvement chain ends at the cap: the verified fourth round's own
    // hand-off is refused with the coded `iteration-cap` *before* any supervisor
    // is delegated, and nothing moves after that refusal.
    const beforeCap = await h.snapshot(STORE)
    const fourth = beforeCap.diagnoses.filter(diagnosis => diagnosis.taskId === root.taskId).at(-1)!
    const capped = await startSupervisorHandoff(h.ctx, {
      storeId: STORE,
      diagnosis: fourth,
      delegator: { sessionId: String(ROOT), agent: h.agent(ROOT) },
      sourceRef: `${root.taskId}#${runsOf(beforeCap, root.taskId)[3]!.runId}`,
      sourceOutcome: 'verified',
    })
    expect(capped).toMatchObject({ result: 'stopped', code: 'iteration-cap' })
    expect((capped as { reason: string }).reason).toContain('1/1')
    // The already-consumed form of the same refusal: the deployment's own
    // consumption answered exactly this way, so no supervisor exists for it.
    expect(await readSupervisorHandoff(STORE, fourth.diagnosisId)).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 300))
    const snapshot = await h.snapshot(STORE)
    const task = snapshot.tasks.find(item => item.taskId === root.taskId)!
    const runs = runsOf(snapshot, task.taskId)
    expect(runs.map(run => run.status)).toEqual(['failed', 'failed', 'verified', 'verified'])

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
      ['attempt', 'durationMs', 'kind', 'outcome', 'passed', 'retries', 'runId', 'score', 'toolCalls', 'total', 'unmetCriterionIds'],
    )
    console.log('A7 multi-round supervisor iteration — round → derived score (root task)')
    console.table(scores.map(row => ({
      attempt: row.attempt,
      kind: row.kind,
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

    // The measured improvement: the recovery rounds pass one more original
    // criterion each, and the improvement round holds the goal at 3/3.
    expect(scores.map(row => row.kind)).toEqual(['initial', 'recovery', 'recovery', 'improvement'])
    expect(scores.map(row => row.score)).toEqual(['1/3', '2/3', '3/3', '3/3'])
    expect(scores.map(row => row.outcome)).toEqual(['failed', 'failed', 'verified', 'verified'])
    expect(scores.map(row => row.unmetCriterionIds)).toEqual([['mark-2', 'mark-3'], ['mark-3'], [], []])
    // `ReviewMetrics.retries` counts the task's runs beyond the first, so the
    // derived score rises while the run count is what this counter reports.
    expect(scores.map(row => row.retries)).toEqual([0, 1, 2, 3])

    // ── the recovery lineage: each attempt names the run it recovers or
    //    improves, and reads the verified positions instead of re-running them ─
    const members = task.childTaskIds.map(taskId => snapshot.tasks.find(item => item.taskId === taskId)!)
    expect(members.map(member => member.objective)).toEqual([
      memberObjective(1), memberObjective(2), memberObjective(3),
    ])
    const memberRuns = members.map(member => snapshot.runs.find(run => run.taskId === member.taskId)!)
    expect(runs[0]!.recovery).toBeUndefined()
    expect(runs[1]!.recovery).toMatchObject({ kind: 'recovery', requestKey: 'k-1', sourceRunId: runs[0]!.runId })
    expect(runs[1]!.recovery!.reusedMembers).toEqual([
      expect.objectContaining({ childIndex: 0, taskId: members[0]!.taskId, sourceRunId: memberRuns[0]!.runId }),
    ])
    expect(runs[2]!.recovery).toMatchObject({ kind: 'recovery', requestKey: 'k-2', sourceRunId: runs[1]!.runId })
    expect(runs[2]!.recovery!.reusedMembers).toEqual([
      expect.objectContaining({ childIndex: 0, taskId: members[0]!.taskId, sourceRunId: memberRuns[0]!.runId }),
      expect.objectContaining({ childIndex: 1, taskId: members[1]!.taskId, sourceRunId: memberRuns[1]!.runId }),
    ])
    // The improvement round names the run it improves, and every position of
    // that verified run is bound: the attempt runs no member of its own.
    expect(runs[3]!.recovery).toMatchObject({ kind: 'improvement', requestKey: 'k-3', sourceRunId: runs[2]!.runId })
    expect(runs[3]!.recovery!.reusedMembers).toEqual([
      expect.objectContaining({ childIndex: 0, taskId: members[0]!.taskId }),
      expect.objectContaining({ childIndex: 1, taskId: members[1]!.taskId }),
      expect.objectContaining({ childIndex: 2, taskId: members[2]!.taskId }),
    ])
    // Only the missing position was run again: one member spawn per recovery
    // round, three in all — the verified positions the attempts bound were never
    // re-run, and the improvement round ran no member at all.
    for (const round of [1, 2, 3]) {
      expect(h.spawns.filter(spawn => spawn.name === memberObjective(round))).toHaveLength(1)
    }
    expect(h.spawns.filter(spawn => spawn.name === memberObjective(4))).toEqual([])
    expect(h.spawns.filter(spawn => spawn.name.startsWith('recovery of'))).toHaveLength(3)
    expect(memberRuns.map(run => run.status)).toEqual(['verified', 'verified', 'verified'])
    // The old failure stays readable exactly as it settled.
    expect(runs[0]!.status).toBe('failed')
    expect(runs[1]!.status).toBe('failed')

    // ── one hand-off per terminal review: each round has its own reviewer and
    //    each diagnosis its own supervisor ────────────────────────────────────
    const diagnoses = snapshot.diagnoses.filter(diagnosis => diagnosis.taskId === task.taskId)
    expect(diagnoses).toHaveLength(ROUNDS)
    expect(diagnoses.every(diagnosis => diagnosis.proposals.length === 1)).toBe(true)
    const reviewerSpawns = h.spawns.filter(spawn => spawn.name === `review ${task.taskId}`)
    // The supervisors whose hand-off is this root task's — a member's diagnosis
    // has its own supervisor, and those never open a run. The last root
    // diagnosis is the capped one: it has none at all.
    const rootDiagnosisIds = new Set(diagnoses.map(diagnosis => diagnosis.diagnosisId))
    const supervisorSpawns = h.spawns.filter(spawn =>
      spawn.name.startsWith('supervisor for') && rootDiagnosisIds.has(spawn.name.slice('supervisor for '.length)))
    expect(reviewerSpawns).toHaveLength(ROUNDS)
    expect(supervisorSpawns).toHaveLength(RECOVERY_ROUNDS)
    for (const [index, diagnosis] of diagnoses.slice(0, RECOVERY_ROUNDS).entries()) {
      const supervisor = String(supervisorSpawns[index]!.sessionId)
      expect(supervisorSpawns[index]!.name).toBe(`supervisor for ${diagnosis.diagnosisId}`)
      expect(await readSupervisorHandoff(STORE, diagnosis.diagnosisId)).toMatchObject({
        sessionId: supervisor,
        source: { taskId: task.taskId, runId: runs[index]!.runId },
      })
    }
    expect(await readSupervisorHandoff(STORE, diagnoses[ROUNDS - 1]!.diagnosisId)).toBeUndefined()

    // ── the coordination ledger: every terminal review of the whole tree was
    //    accepted — the verified runs included — and every uncapped diagnosis
    //    delegated ────────────────────────────────────────────────────────────
    const attempts = await readReviewAgentAttempts(STORE)
    const reviewerSources = attempts.filter(attempt => attempt.role === 'reviewer').map(attempt => `${attempt.source.taskId}#${attempt.source.runId}`)
    const treeReviews = snapshot.reviews.filter(review => review.taskId === task.taskId || task.childTaskIds.includes(review.taskId))
    expect(new Set(reviewerSources)).toEqual(new Set(treeReviews.map(review => `${review.taskId}#${review.runId}`)))
    // The four root rounds are all among them, the verified ones included.
    expect(attempts.filter(attempt => attempt.role === 'reviewer' && attempt.source.taskId === task.taskId).map(attempt => attempt.source.runId))
      .toEqual(task.runIds)
    // One reviewer per review, and one supervisor per uncapped diagnosis: the
    // root's first three rounds and each member's verified run. The fourth root
    // round's diagnosis is the cap's own refusal — it never got a supervisor.
    expect(attempts.filter(attempt => attempt.role === 'supervisor')).toHaveLength(RECOVERY_ROUNDS + 3)
    expect(await countReviewAgentRuns(STORE)).toBe(treeReviews.length + RECOVERY_ROUNDS + 3)

    // ── the cap's own gate, asked directly: one more improvement is refused ───
    const supervisorOfLastRound = String(supervisorSpawns[RECOVERY_ROUNDS - 1]!.sessionId)
    const refusal = await h.ctx.evolution.coordinateRecovery(
      { sourceDiagnosisId: diagnoses[RECOVERY_ROUNDS - 1]!.diagnosisId, requestKey: 'k-after-cap', mode: 'improve' },
      { sessionId: supervisorOfLastRound },
    ).then(() => '', error => String(error))
    expect(refusal).toContain('iteration-cap')
    expect((await h.snapshot(STORE)).runs.filter(run => run.taskId === task.taskId)).toHaveLength(ROUNDS)
    expect(await countReviewAgentRuns(STORE)).toBe(treeReviews.length + RECOVERY_ROUNDS + 3)
  }, 90_000)

  it('is stopped by a spent coordination allowance: the failed review\'s reviewer spends the store\'s only attempt', async () => {
    // The shipped allowance is eight attempts per store, with three recovery and
    // two improvement rounds per source; this deployment names one attempt, so
    // the first failed review's reviewer spends it — the hand-off its diagnosis
    // leaves has none left, and the first recovery never opens.
    expect(REVIEW_AGENT_BUDGET_DEFAULT).toBe(8)
    expect(DEFAULT_SUPERVISION.maxRecoveryRounds).toBe(3)
    expect(DEFAULT_SUPERVISION.maxImprovementRounds).toBe(2)
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '1')
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'a7-default-budget-'))
    ledgerDirs.push(ledgerRoot)
    // A root whose own criterion fails on its first submission: one terminal
    // review, one reviewer — the attempt the allowance has room for.
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      roots: [ROOT],
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          { tool: 'task_submit_result', args: { summary: 'root: the release is not shipped' } },
          { text: 'root: handed in' },
        ]
        : [{ text: REVIEW_REPLY }],
      evolution: { ledgerRoot },
    })
    installReviewAgentAutoTrigger(h.ctx)
    const root = await h.begin({
      objective: 'ship the release',
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'false' }],
    })

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

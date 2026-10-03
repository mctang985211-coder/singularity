import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countReviewAgentRuns, readReviewerDelegation, readSupervisorHandoff } from '../../agent-singularity/src/coordination/ledger.ts'
import { consumePendingHandoffs } from '../../agent-singularity/src/coordination/evolution-handoff.ts'
import { supervisorHandoffDigest } from '../../agent-singularity/src/coordination/handoff-rules.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/**
 * K4 + A5: the reviewer's allowance and its attempts are facts of the ledger,
 * not of the process.
 *
 * `review-agent-ledger.ts` (`$DSH_HOME/review-agents/agents.jsonl`) holds one
 * attempt per review source — the claim, the started row that spends one run of
 * the per-root-store allowance, the settled fact — and that file is the reason a
 * *restart* neither hands the tree a fresh allowance nor starts a second
 * reviewer for a source it already reviewed: both the attempts and the count are
 * read from the log on every call, so what a process started before it died is
 * still there afterwards.
 *
 * The fixture is the deployment's own durable plane — the real
 * `JsonlSessionPersistence` and the real `TaskService`/`TaskRuntime`/`AgentRuntime`
 * — and the restart is real: the first process's descriptors are released (its
 * log flushed), the second boots over the same workspace and home, and it reads
 * the store and the ledger the first one left behind. Only the model loop is
 * missing, which is the reviewer's business and not this case's.
 */

const ROOT_SESSION = 's-root'
/** Every stack a case booted, so a failing case cannot leak a workspace. */
const stacks: AssemblyStack[] = []

async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

beforeEach(() => {
  // The deployment's own ledger (`$DSH_HOME/review-agents`) and its default cap:
  // a developer's environment must not decide what this case reads. An empty
  // value is the ledger's own "not overridden" (`review-agent-ledger.ts`).
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '')
})

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([
      stack.dispose({ remove: stack.dir.includes('singularity-assembly-') }),
      new Promise(resolve => { setTimeout(resolve, 2_000).unref() }),
    ])
  }
  vi.unstubAllEnvs()
})

/** One criterion a command settles. */
const criterion = (command: string) => ({ description: `the command ${command} exits 0`, command })

/**
 * One task whose run settled `failed` — the escalation signal a review agent is
 * spawned for — through the deployment's own entries: the root contract is
 * accepted, one child is admitted and run, and its criterion fails.
 */
async function failedTask(stack: AssemblyStack): Promise<{ storeId: string; taskId: string; runId: string }> {
  const storeId = stack.storeIdOf(ROOT_SESSION)
  await stack.seedLog(ROOT_SESSION, ['ship the release'])
  const root = await stack.runtime.intakeRootContract(storeId, ROOT_SESSION, {
    objective: 'ship the release', requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is delivered', command: 'true' }],
  })
  const batch = await stack.runtime.decomposeAndRun(storeId, root.taskId, root.runId, ROOT_SESSION, {
    reason: 'split the work',
    children: [{ objective: 'child that fails', requiredCapabilities: ['execute-task'], acceptanceCriteria: [criterion('false')] }],
  } as never)
  const outcomes = await stack.runtime.awaitBatch(storeId, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
  return { storeId, taskId: outcomes[0]!.taskId, runId: String(outcomes[0]!.runId) }
}

describe('the review allowance survives a restart (K4)', () => {
  it('answers the repeated source from the ledger the first process wrote, and still refuses a new source', async () => {
    // The deployment's shipped allowance is eight attempts per store; this case
    // names one so the second key meets a spent ceiling deterministically.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '1')
    const first = await boot({ worker: async () => {} })
    const failed = await failedTask(first)
    const answer = await first.call(ROOT_SESSION, 'task_review_agent', { taskId: failed.taskId, runId: failed.runId })
    expect(answer.text).not.toContain('spawn failed')
    const reviewer = String(first.spawns.at(-1)!.sessionId)
    // The row the allowance is counted from, read back off the file the
    // deployment keeps it in — the reviewer's delegation, written before its
    // first request.
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)
    expect(await readReviewerDelegation(reviewer)).toMatchObject({ rootStoreId: failed.storeId, taskId: failed.taskId })

    // A restart: this process's descriptors go back, its workspace and home stay.
    await first.crash()
    await first.dispose({ remove: false })
    const second = await boot({ dir: first.dir, worker: async () => {} })
    expect(second.spawns).toEqual([])

    // The same source: the attempt the previous process's ledger holds is the
    // attempt this process returns — one claim, one started row, no new spawn.
    const again = await second.call(ROOT_SESSION, 'task_review_agent', { taskId: failed.taskId, runId: failed.runId })
    expect(again.isError).toBe(false)
    expect(again.text).toContain('already has this attempt')
    expect(again.text).toContain(reviewer)
    expect(again.text).toContain('no review agent started')
    expect(second.spawns).toEqual([])
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)

    // A further review of the same source is a *new* attempt, and the store's
    // allowance — read from the ledger the previous process wrote — has no room
    // for it: the fresh process does not start counting at zero.
    const other = await second.call(ROOT_SESSION, 'task_review_agent', {
      taskId: failed.taskId, runId: failed.runId, requestKey: 'k1', reason: 'a second look after the restart',
    })
    expect(other.isError).toBe(false)
    expect(other.text).toContain('budget exhausted')
    expect(other.text).toContain('1/1')
    expect(other.text).toContain(failed.storeId)
    expect(other.text).toContain('no review agent started')
    expect(second.spawns).toEqual([])
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)
  }, 60_000)

  it('recovers a started attempt the previous process left, and accepts a new key within the allowance', async () => {
    const first = await boot({ worker: async () => {} })
    const failed = await failedTask(first)
    const ledger = join(first.home, 'review-agents', 'agents.jsonl')
    mkdirSync(dirname(ledger), { recursive: true })
    // The process died with its reviewer still out: the claim and the started row
    // it had already written are on the file, the terminal fact is not, and no
    // process is running that session any more.
    writeFileSync(ledger, [
      JSON.stringify({
        formatVersion: 2, kind: 'claim', rootStoreId: failed.storeId, taskId: failed.taskId, runId: failed.runId,
        requestKey: null, reason: null, sessionId: 's-orphaned', actor: ROOT_SESSION, at: '2026-09-27T00:00:00.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', rootStoreId: failed.storeId, taskId: failed.taskId,
        sessionId: 's-orphaned', actor: ROOT_SESSION, at: '2026-09-27T00:00:01.000Z',
      }),
      '',
    ].join('\n'), 'utf8')
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)

    await first.crash()
    await first.dispose({ remove: false })
    // One more run of the allowance, so the new process's explicit request is not
    // refused for a reason of its own: this case is about the dead attempt.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '2')
    const second = await boot({ dir: first.dir, worker: async () => {} })

    // The new key is accepted: the attempt nobody is running is recovered, and
    // the attempt this call names is the one that starts.
    const fresh = await second.call(ROOT_SESSION, 'task_review_agent', {
      taskId: failed.taskId, runId: failed.runId, requestKey: 'k1', reason: 'a fresh look after the crash',
    })
    expect(fresh.text).not.toContain('in flight')
    expect(fresh.text).not.toContain('the new request was not accepted')
    const reviewers = second.spawns.filter(spawn => String(spawn.name ?? '').startsWith('review '))
    expect(reviewers).toHaveLength(1)

    // The dead attempt is one terminal fact, and its spent run is not refunded:
    // two started rows, two spent runs, one of them the crash's own — and the new
    // key's attempt is a claim of its own, not a reuse of the dead one.
    const rows = readFileSync(ledger, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    const settled = rows.filter(row => row.kind === 'settled' && row.sessionId === 's-orphaned')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'interrupted' })
    expect(String(settled[0]!.note)).toContain('is gone')
    const claims = rows.filter(row => row.kind === 'claim')
    expect(claims).toHaveLength(2)
    expect(claims[1]).toMatchObject({ requestKey: 'k1', reason: 'a fresh look after the crash', taskId: failed.taskId, runId: failed.runId })
    expect(rows.filter(row => row.kind === 'started')).toHaveLength(2)
    expect(await countReviewAgentRuns(failed.storeId)).toBe(2)

    // The source's default attempt reads back as the interrupted attempt it is —
    // not as something in flight, and not as a second reviewer either.
    const readback = await second.call(ROOT_SESSION, 'task_review_agent', { taskId: failed.taskId, runId: failed.runId })
    expect(readback.isError).toBe(false)
    expect(readback.text).toContain('s-orphaned')
    expect(readback.text).toContain('interrupted')
    expect(readback.text).not.toContain('in flight')
    expect(readback.text).toContain('no review agent started')
    expect(second.spawns.filter(spawn => String(spawn.name ?? '').startsWith('review '))).toHaveLength(1)
    expect(await countReviewAgentRuns(failed.storeId)).toBe(2)
  }, 60_000)
})

describe('the hand-off survives a restart (A6 + K4)', () => {
  it('re-delegates a hand-off whose supervisor died with its attempt still open', async () => {
    // The ledger a dead process left: a started supervisor attempt with no
    // terminal fact — the rows written before it was killed while its worker was
    // still running. Nothing in this process ever held that session, which is
    // exactly what the new process reads.
    const first = await boot({ supervision: { autoReview: 'off' }, worker: async () => {} })
    const failed = await failedTask(first)
    const snapshot = await first.snapshot(failed.storeId)
    const rootTask = snapshot.tasks.find(task => task.parentTaskId === undefined)!
    const rootRun = snapshot.runs.find(run => run.taskId === rootTask.taskId)!
    const diagnosis = {
      diagnosisId: 'd-dead',
      taskId: rootTask.taskId,
      observedFailure: 'the member failed its own criterion',
      scope: 'the root goal of this store',
      localizedCause: 'the deployment grants no capability for the member',
      evidenceRefs: [],
      reviewRefs: [`${rootTask.taskId}#${rootRun.runId}`],
      confidence: 'high' as const,
      proposals: [],
    }
    await first.task.recordDiagnosisIn(failed.storeId, diagnosis, ROOT_SESSION)

    await first.crash()
    await first.dispose({ remove: false })
    const second = await boot({ dir: first.dir, supervision: { autoReview: 'off' }, worker: async () => {} })
    await second.task.openStore(failed.storeId)
    const ledger = join(second.home, 'review-agents', 'agents.jsonl')
    mkdirSync(dirname(ledger), { recursive: true })
    writeFileSync(ledger, [
      JSON.stringify({
        formatVersion: 2, kind: 'claim', role: 'supervisor', rootStoreId: failed.storeId,
        taskId: rootTask.taskId, runId: rootRun.runId, requestKey: null, reason: null,
        diagnosisId: 'd-dead', handoffDigest: supervisorHandoffDigest(failed.storeId, diagnosis),
        sessionId: 's-dead-supervisor', actor: ROOT_SESSION, at: '2026-09-27T00:00:00.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', role: 'supervisor', rootStoreId: failed.storeId,
        taskId: rootTask.taskId, diagnosisId: 'd-dead', sessionId: 's-dead-supervisor', actor: ROOT_SESSION,
        at: '2026-09-27T00:00:01.000Z',
      }),
      '',
    ].join('\n'), 'utf8')

    // The new process finds the started supervisor dead (no process holds it and
    // no terminal fact exists) and re-delegates the same hand-off to a new
    // session — a dead supervisor is a failure, not the hand-off's owner.
    const again = await consumePendingHandoffs(second.ctx, failed.storeId)
    expect(again.consumptions).toMatchObject([{ diagnosisId: 'd-dead', result: 'started' }])
    const replacement = (again.consumptions[0] as { sessionId: string }).sessionId
    expect(replacement).not.toBe('s-dead-supervisor')
    const rows = readFileSync(ledger, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(rows.filter(row => row.kind === 'settled' && row.sessionId === 's-dead-supervisor')).toMatchObject([
      expect.objectContaining({ status: 'interrupted' }),
    ])
    expect(rows.filter(row => row.kind === 'claim' && row.role === 'supervisor')).toHaveLength(2)
    expect(await readSupervisorHandoff(failed.storeId, 'd-dead')).toMatchObject({ sessionId: replacement })
    // The dead attempt's spent run is not refunded: two supervisor runs.
    expect(await countReviewAgentRuns(failed.storeId)).toBe(2)
  }, 60_000)
})

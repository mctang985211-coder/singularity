import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countReviewAgentRuns, readReviewerDelegation } from '../../agent-singularity/src/review-agent-ledger.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/**
 * K4: the reviewer's allowance is a fact of the ledger, not of the process.
 *
 * The review chain's only bound is the per-root-store count of review agents
 * already started (`review-agent-ledger.ts`, `$DSH_HOME/review-agents/
 * agents.jsonl`). That file is the reason a *restart* does not hand the tree a
 * fresh allowance: the count is read from the log on every call, so the review a
 * process started before it died still spends the store's allowance afterwards.
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
async function failedTask(stack: AssemblyStack): Promise<{ storeId: string; taskId: string }> {
  const storeId = stack.storeIdOf(ROOT_SESSION)
  await stack.seedLog(ROOT_SESSION, ['ship the release'])
  const root = await stack.runtime.intakeRootContract(storeId, ROOT_SESSION, {
    objective: 'ship the release',
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is delivered', command: 'true' }],
  })
  const batch = await stack.runtime.decomposeAndRun(storeId, root.taskId, root.runId, ROOT_SESSION, {
    reason: 'split the work',
    children: [{ objective: 'child that fails', acceptanceCriteria: [criterion('false')] }],
  } as never)
  const outcomes = await stack.runtime.awaitBatch(storeId, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
  return { storeId, taskId: outcomes[0]!.taskId }
}

describe('the review allowance survives a restart (K4)', () => {
  it('refuses a second review in a process that only reads the ledger the first one wrote', async () => {
    const first = await boot({ worker: async () => {} })
    const failed = await failedTask(first)
    const answer = await first.call(ROOT_SESSION, 'task_review_agent', { taskId: failed.taskId })
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

    const again = await second.call(ROOT_SESSION, 'task_review_agent', { taskId: failed.taskId })
    // Refused by the *store's* allowance, read from the ledger the previous
    // process wrote: the fresh process does not start counting at zero.
    expect(again.isError).toBe(false)
    expect(again.text).toContain('budget exhausted')
    expect(again.text).toContain('1/1')
    expect(again.text).toContain(failed.storeId)
    expect(again.text).toContain('no review agent spawned')
    expect(second.spawns).toEqual([])
    expect(await countReviewAgentRuns(failed.storeId)).toBe(1)
  }, 60_000)
})

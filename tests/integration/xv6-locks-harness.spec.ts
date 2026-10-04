/**
 * Default-suite integration: the xv6 locks harness runs the lab's real grader
 * through the real command verifier and reads the verdict out of the evidence
 * log. Not env-gated — it skips only when the pristine testbed is absent — so a
 * change to the verifier budget, the checkout tools or the grader wrapper is
 * caught by the ordinary suite instead of only by the opt-in live run.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DecomposeChildSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'
import {
  ensureXv6ToolchainOnPath,
  prepareXv6Checkout,
  XV6_PROTECTED_INPUTS,
  XV6_TESTBED,
  XV6_VERIFY_TIMEOUT_MS,
  xv6CheckoutTools,
  xv6TestbedPresent,
} from '../support/xv6-locks.ts'

const available = xv6TestbedPresent()
if (available) ensureXv6ToolchainOnPath()

afterEach(disposeScriptedLoops)

/** The root's own criterion is trivially settled; the child carries the real grader command. */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'Own the xv6 locks optimization and hand the buffer-cache stage to an independently verified child.',
  requiredCapabilities: ['coordinate-tasks'],
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the optimization effort is owned', command: 'true' }],
}

const CHILD: DecomposeChildSpec = {
  objective: 'Run the buffer-cache stage of the xv6 locks checker over the pristine lab and hand in its verdict.',
  requiredCapabilities: ['local-files'],
  acceptanceCriteria: [
    {
      criterionId: 'bcache-result',
      description: 'the bcache xv6 acceptance checker passes',
      command: 'bash checks/verify.sh bcache',
      protectedInputs: [...XV6_PROTECTED_INPUTS],
    },
  ],
}

it.skipIf(!available)(
  `grades the buffer-cache stage through the real verifier and records the contention verdict (testbed ${XV6_TESTBED})`,
  async () => {
    const h = await startScriptedLoop({
      capabilities: {
        'coordinate-tasks': { skills: ['task-coordination'] },
        'local-files': { skills: ['task-execution'], tools: ['filesystem'] },
      },
      verifyTimeoutMs: XV6_VERIFY_TIMEOUT_MS,
      script: (_sessionId, index): readonly ScriptEntry[] =>
        index === 0
          ? [
              {
                tool: 'task_decompose',
                args: { reason: 'the buffer-cache stage is independently checkable', children: [CHILD] },
              },
              { text: 'root: the checker owns the verdict' },
            ]
          : [{ tool: 'task_submit_result', args: { summary: 'ran the bcache stage' } }, { text: 'child: handed in' }],
      tools: xv6CheckoutTools(),
    })
    // Plumbing: the harness must carry the xv6 budget, not the 600_000 ms default.
    expect((h.ctx as unknown as { taskRuntime: { verifyTimeoutMs: number } }).taskRuntime.verifyTimeoutMs).toBe(
      XV6_VERIFY_TIMEOUT_MS,
    )
    prepareXv6Checkout(h.checkout)
    const root = await h.begin(ROOT_CONTRACT)
    const childTask = await vi.waitFor(
      async () => {
        const found = (await h.snapshot(root.storeId)).tasks.find(task => task.parentTaskId === root.taskId)
        expect(found).toBeDefined()
        return found!
      },
      { timeout: 90_000, interval: 100 },
    )
    // The pristine lab fails bcachetest test0 on lock contention, so the real
    // command verifier must record a `fail` — the harness is not a pass-through.
    // The window covers the checker's machine-wide grader lock: a sibling spec
    // (also qemu-heavy) may hold it for one full `verify.sh all` grade before this
    // short `bcache` grade runs.
    await vi.waitFor(async () => expect((await h.task.taskIn(root.storeId, childTask.taskId)).status).toBe('failed'), {
      timeout: 480_000,
      interval: 250,
    })
    const snapshot = await h.snapshot(root.storeId)
    const childRun = snapshot.runs.filter(run => run.taskId === childTask.taskId).at(-1)!
    const verdict = snapshot.evidence
      .filter(item => item.taskRunId === childRun.runId)
      .flatMap(item => item.verifierResults)
      .find(item => item.criterionId === 'bcache-result')!
    expect(verdict.verifierId).toBe('command')
    expect(verdict.status).toBe('fail')
    expect(verdict.exitCode).not.toBe(0)
    const log = readFileSync(join(h.workspace, 'evidence', verdict.logRef!), 'utf8')
    expect(log).toContain('test0: FAIL')
    expect(log).toContain('tot=')
  },
  // The bound covers a wait on the checker's machine-wide grader lock (see the
  // `bcache` verdict window above) on top of the grade itself.
  600_000,
)

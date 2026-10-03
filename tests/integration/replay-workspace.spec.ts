import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import type { ReplayRunOutcome, RootContractSpec } from '../../task-runtime/src/index.ts'
import { WorkspaceBusyError, WorkspaceRegistry } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, sha256Of, startRunStack, type RunStack, type ToolCallResult } from '../support/run-stack.ts'

/**
 * S4-E: a replay whose caller names the workspace it runs in (`ReplayTaskOptions
 * .workspace`). The two-sided evaluation this interface exists for builds two
 * independent workspaces from one initial snapshot and runs the baseline and the
 * candidate in them; every directory a run resolves against therefore has to
 * follow the named workspace, or the two sides are not isolated and a criterion's
 * protected identity describes bytes nobody judged.
 *
 * What this spec pins, on the real deployment (store, runtime, workspace
 * registry, `AgentRuntime.spawn`, verifier):
 *
 * 1. **The named workspace is where the run works.** The replayed worker's own
 *    cwd, the verifier's cwd, and the protected acceptance inputs' base all
 *    resolve there — a write the worker makes lands in the named directory and
 *    nowhere else, a verifier command that reads the worker's write and the
 *    workspace's copy of a protected input passes there and would fail in the
 *    caller's checkout, and the fixed digest of the declared input is the
 *    workspace's bytes.
 * 2. **Two named workspaces are two workspaces.** Each replay holds only its own
 *    directory (the marker file names it), the second does not wait for the first,
 *    and no byte of one appears in the other.
 * 3. **One workspace is still one writer.** A second replay into a workspace
 *    already held is refused with the unchanged {@link WorkspaceBusyError}, before
 *    anything persists.
 * 4. **Absent the option nothing moved.** A replay without `workspace` writes
 *    into, and is judged in, the caller's own checkout exactly as before.
 * 5. **Cancellation and stale markers.** A cancelled replay settles through the
 *    runtime's own settlement, releases its marker, and a marker a crashed process
 *    left is never taken over by a claim — only `reconcileAdopt`, on the named
 *    path like on any other.
 * 6. **A replayed worker may still decompose.** Its own `task_decompose` is
 *    admitted against the workspace it writes into, and the children it splits
 *    into run and are judged in the same workspace.
 *
 * The model loop is replaced by run-stack's worker hook; everything else is the
 * deployment's own.
 */

const ROOT = 's-root' as SessionId
/** The lineage tag every experiment carries; a replay task's objective is prefixed with it. */
const LINEAGE = 'evolution-replay:s4e'

afterEach(async () => {
  await disposeRunStacks()
})

/** A latch one test releases from outside a parked worker body. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** The directory one stack's runtime writes ownership markers into. */
function markersDirectory(h: RunStack): string {
  return join(h.home, 'singularity', 'run-bindings', 'workspace-owners')
}

/** One marker as the file on disk holds it — what a second process reads and what §3.4's admission compares. */
interface Marker {
  path: string
  pid: number
  owner: Record<string, unknown>
  since: string
}

function markers(h: RunStack): Marker[] {
  const directory = markersDirectory(h)
  if (!existsSync(directory)) return []
  return readdirSync(directory).map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')) as Marker)
}

/** The marker one workspace is currently held under, keyed the way the registry keys it (the normalized path). */
function markerFor(h: RunStack, workspace: string): Marker | undefined {
  return markers(h).find(marker => marker.path === workspace)
}

/** True for the replayed worker: a parentless task whose run descends from a champion run. */
async function isReplayedWorker(h: RunStack, sessionId: SessionId): Promise<boolean> {
  const { task, run } = await h.runtime.runForSession(sessionId)
  return task.parentTaskId === undefined && run.parentRunId !== undefined
}

/**
 * The root contract this spec's trees run under: one goal, one criterion a command
 * settles. The intake is real, so the contract is stated rather than defaulted.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

/**
 * Write one terminal champion task straight into the store — the record a replay
 * descends from — through the store's own service, so the replay's subject is the
 * historical shape, not a fixture invention.
 */
async function writeChampion(h: RunStack, storeId: string, criterion: AcceptanceCriterion): Promise<{ taskId: string; runId: string }> {
  const taskId = 't-champion'
  const runId = 'r-champion'
  await h.task.createTaskIn(storeId, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'champion work',
    depth: 0,
    acceptanceCriteria: [criterion],
    requestedCapabilities: ['execute-task'],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(storeId, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId,
    taskId,
    sessionId: 's-champion',
    capabilitySnapshot: ['execute-task'],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: criterion.criterionId, status: 'pass', verifierId: 'fake-verifier' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verified', 'tester')
  return { taskId, runId }
}

/** One command-settled criterion a champion's replay can be judged by. */
function championCriterion(command: string): AcceptanceCriterion {
  return { criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command }
}

/** A directory the caller prepares for one side of a comparison, plus the path ownership keys it by. */
async function prepareWorkspace(h: RunStack, name: string): Promise<{ directory: string; path: string }> {
  const directory = join(h.workspace, name)
  await mkdir(directory, { recursive: true })
  return { directory, path: await realpath(directory) }
}

/** The replayed task of one lineage tag, read back from the store. */
async function replayTaskOf(h: RunStack, storeId: string, lineage: string) {
  const snapshot = await h.snapshot(storeId)
  const found = snapshot.tasks.find(task => task.objective.startsWith(`[${lineage}]`))
  if (found === undefined) throw new Error(`the store holds no replay task tagged ${lineage}`)
  return found
}

describe('S4-E: a replay in a caller-named workspace', () => {
  it('runs the worker, the verifier and the protected inputs in the named workspace', async () => {
    let h!: RunStack
    const heldWhileRunning: Array<Marker | undefined> = []
    h = await startRunStack({
      roots: [ROOT],
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        // The worker writes where its own session works: the directory the spawn
        // gave it, which is what every relative path its tools resolve follows.
        await writeFile(join(agent.session.header.cwd, 'worker-marker.txt'), 'the replayed worker wrote here')
        heldWhileRunning.push(markerFor(h, agent.session.header.cwd))
      },
    })
    const first = await h.root(ROOT, rootContract('the first tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('true'))
    const checkoutPath = await realpath(h.checkout)
    const workspace = await prepareWorkspace(h, 'candidate-workspace')
    await writeFile(join(workspace.directory, 'input.txt'), 'the workspace copy')
    await writeFile(join(h.checkout, 'input.txt'), 'the caller checkout copy')

    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, {
      lineage: LINEAGE,
      contract: {
        objective: 'the candidate definition',
        acceptanceCriteria: [{
          criterionId: 'cand-1',
          description: 'the candidate holds where it was replayed',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'pwd > verifier-cwd.txt && test -f worker-marker.txt && grep -q "the workspace copy" input.txt',
          // The authoring form of a protected input: the replay fixes its byte
          // identity against the workspace it runs in.
          protectedInputs: ['input.txt'],
        } as unknown as AcceptanceCriterion],
        requiredCapabilities: ['execute-task'],
      },
      workspace: { path: workspace.directory },
    }, ROOT)

    // The candidate's criterion passed, which needed the worker's write and the
    // protected input's bytes to be where the verifier looked for them.
    expect(outcome.status).toBe('verified')
    expect(outcome.criteria?.map(item => item.verdict)).toEqual(['pass'])
    // The outcome names the workspace the run went through, normalized.
    expect(outcome.workspace).toBe(workspace.path)

    // The worker wrote in the named workspace and nowhere else.
    expect(readFileSync(join(workspace.directory, 'worker-marker.txt'), 'utf8')).toBe('the replayed worker wrote here')
    expect(existsSync(join(h.checkout, 'worker-marker.txt'))).toBe(false)
    // The worker's own session cwd is the named workspace — the spawn request the
    // real agent runtime received carried it, and the session header followed.
    expect(h.spawns[h.spawns.length - 1]!.cwd).toBe(workspace.path)

    // The verifier ran there: its own command wrote the directory it ran in, and it
    // failed the run if the workspace's copy of the input was not the one it read.
    expect(await realpath(readFileSync(join(workspace.directory, 'verifier-cwd.txt'), 'utf8').trim())).toBe(workspace.path)
    expect(existsSync(join(h.checkout, 'verifier-cwd.txt'))).toBe(false)

    // The fixed identity is the workspace's bytes, not the caller checkout's.
    const replayed = await replayTaskOf(h, first.storeId, LINEAGE)
    expect(replayed.acceptanceCriteria[0]!.protectedInputs).toEqual([{ path: 'input.txt', sha256: sha256Of('the workspace copy') }])
    expect(replayed.acceptanceCriteria[0]!.protectedInputs).not.toEqual([{ path: 'input.txt', sha256: sha256Of('the caller checkout copy') }])

    // While the replay ran, the named workspace was held by the replayed task;
    // after it settled the hold is gone — and the caller's own checkout hold is
    // exactly what it was.
    expect(heldWhileRunning).toHaveLength(1)
    expect(heldWhileRunning[0]?.path).toBe(workspace.path)
    expect(heldWhileRunning[0]?.owner).toMatchObject({ kind: 'run', storeId: first.storeId, taskId: replayed.taskId, runId: `replay-of-${champion.taskId}` })
    expect(markerFor(h, workspace.path)).toBeUndefined()
    expect(markerFor(h, checkoutPath)?.owner).toMatchObject({ taskId: first.taskId })
    expect(workspace.path).not.toBe(checkoutPath)
  })

  it('keeps two named workspaces independent: no shared bytes, no waiting on the other side', async () => {
    const parked = deferred()
    const started = deferred()
    let replayedWorkers = 0
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        replayedWorkers += 1
        const cwd = agent.session.header.cwd
        await writeFile(join(cwd, `${basename(cwd)}-worker.txt`), 'x')
        // The first side stays parked until this spec releases it, so the second
        // side's whole run happens while the first still holds its own workspace.
        if (replayedWorkers === 1) {
          started.resolve()
          await parked.promise
        }
      },
    })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('true'))
    const a = await prepareWorkspace(h, 'ws-a')
    const b = await prepareWorkspace(h, 'ws-b')

    const firstSide = h.runtime.replayTask(first.storeId, champion.taskId, { lineage: `${LINEAGE}:a`, workspace: { path: a.directory } }, ROOT)
    // The park is always released, even when an assertion below refuses the
    // answer: a worker left parked holds its driver, and a stack whose driver
    // never settles cannot be disposed.
    try {
      await started.promise
      // The parked replay holds its own workspace and nothing else.
      expect(markerFor(h, a.path)).toBeDefined()
      expect(markerFor(h, b.path)).toBeUndefined()

      // The second side runs to completion while the first still holds ws-a.
      const secondSide = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: `${LINEAGE}:b`, workspace: { path: b.directory } }, ROOT)
      expect(secondSide.status).toBe('verified')
      expect(secondSide.workspace).toBe(b.path)
    } finally {
      parked.resolve()
    }
    expect((await firstSide).status).toBe('verified')

    // Neither side's bytes reached the other directory, and no hold escaped.
    expect(readFileSync(join(a.directory, 'ws-a-worker.txt'), 'utf8')).toBe('x')
    expect(readFileSync(join(b.directory, 'ws-b-worker.txt'), 'utf8')).toBe('x')
    expect(existsSync(join(a.directory, 'ws-b-worker.txt'))).toBe(false)
    expect(existsSync(join(b.directory, 'ws-a-worker.txt'))).toBe(false)
    expect(markerFor(h, a.path)).toBeUndefined()
    expect(markerFor(h, b.path)).toBeUndefined()
  })

  it('refuses a second replay into a held workspace with the unchanged busy error, writing nothing', async () => {
    const parked = deferred()
    const started = deferred()
    let replayedWorkers = 0
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        replayedWorkers += 1
        await writeFile(join(agent.session.header.cwd, 'worker-marker.txt'), 'x')
        if (replayedWorkers > 1) return
        started.resolve()
        await parked.promise
      },
    })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('true'))
    const workspace = await prepareWorkspace(h, 'one-writer')

    const replaying = h.runtime.replayTask(first.storeId, champion.taskId, { lineage: `${LINEAGE}:one`, workspace: { path: workspace.directory } }, ROOT)
    try {
      await started.promise
      const before = await h.snapshot(first.storeId)

      await expect(h.runtime.replayTask(first.storeId, champion.taskId, { lineage: `${LINEAGE}:two`, workspace: { path: workspace.directory } }, ROOT))
        .rejects.toThrow(WorkspaceBusyError)
      const after = await h.snapshot(first.storeId)
      expect(after.tasks).toHaveLength(before.tasks.length)
      expect(after.runs).toHaveLength(before.runs.length)
      expect(h.spawns).toHaveLength(1)
      // The holder the refusal names is the parked replay's own layer, on the path
      // the caller named.
      const marker = markerFor(h, workspace.path)
      expect(marker?.owner).toMatchObject({ kind: 'run', taskId: before.tasks.find(task => task.objective.startsWith(`[${LINEAGE}:one]`))!.taskId })
    } finally {
      parked.resolve()
    }

    expect((await replaying).status).toBe('verified')
    expect(markerFor(h, workspace.path)).toBeUndefined()
  })

  it('leaves a replay without the option in the caller\u2019s own checkout, byte for byte', async () => {
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        await writeFile(join(agent.session.header.cwd, 'worker-marker.txt'), 'the replayed worker wrote here')
      },
    })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('test -f worker-marker.txt && pwd > verifier-cwd.txt'))
    const checkoutPath = await realpath(h.checkout)

    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: LINEAGE }, ROOT)

    expect(outcome.status).toBe('verified')
    // No workspace named: the outcome carries none, and the spawn inherits the
    // caller's cwd as every spawn always has.
    expect(outcome.workspace).toBeUndefined()
    expect(h.spawns[h.spawns.length - 1]!.cwd).toBeUndefined()
    // The worker wrote, and the verifier looked, in the caller's checkout.
    expect(existsSync(join(h.checkout, 'worker-marker.txt'))).toBe(true)
    expect(await realpath(readFileSync(join(h.checkout, 'verifier-cwd.txt'), 'utf8').trim())).toBe(checkoutPath)
    // The only ownership record is the caller's own hold on its checkout.
    expect(markers(h).map(marker => marker.path)).toEqual([checkoutPath])
  })

  it('settles a cancelled replay through the runtime\u2019s own settlement and releases its marker', async () => {
    const parked = deferred()
    const started = deferred()
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        await writeFile(join(agent.session.header.cwd, 'worker-marker.txt'), 'x')
        started.resolve()
        await parked.promise
      },
    })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('true'))
    const workspace = await prepareWorkspace(h, 'cancelled-workspace')

    const replaying = h.runtime.replayTask(first.storeId, champion.taskId, { lineage: LINEAGE, workspace: { path: workspace.directory } }, ROOT)
    let outcome: ReplayRunOutcome | undefined
    try {
      await started.promise
      expect(markerFor(h, workspace.path)).toBeDefined()
      await h.runtime.cancelGraph(first.storeId, 'graph removed')
      outcome = await replaying
    } finally {
      parked.resolve()
    }
    if (outcome === undefined) throw new Error('the cancelled replay settled no outcome')
    expect(outcome.status).toBe('cancelled')
    const run = (await h.snapshot(first.storeId)).runs.find(candidate => candidate.runId === outcome.runId)!
    expect(run.status).toBe('cancelled')
    const review = (await h.snapshot(first.storeId)).reviews.find(item => item.runId === outcome.runId)!
    expect(review.outcome).toBe('cancelled')
    expect(review.anomalies).toContain(LINEAGE)
    // The runtime's own settlement released the replay layer on the named path.
    expect(markerFor(h, workspace.path)).toBeUndefined()
  })

  it('never takes over a marker a crashed process left on the named path — only reconcileAdopt does', async () => {
    let h!: RunStack
    h = await startRunStack({ roots: [ROOT], worker: () => {} })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('true'))
    const workspace = await prepareWorkspace(h, 'stale-workspace')

    // What a crashed process leaves: a marker written for the named path by a pid
    // that cannot be alive.
    const crashed = new WorkspaceRegistry({ markerRoot: markersDirectory(h), pid: 2 ** 31 - 2 })
    await crashed.claim(workspace.path, {
      kind: 'run',
      storeId: first.storeId,
      taskId: 't-crashed',
      runId: 'r-crashed',
      since: new Date().toISOString(),
    })

    // A claim refuses it: a stale marker is never taken over by an ordinary claim.
    const busy = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: LINEAGE, workspace: { path: workspace.directory } }, ROOT)
      .then(() => undefined, (error: unknown) => error)
    expect(busy).toBeInstanceOf(WorkspaceBusyError)
    expect((busy as WorkspaceBusyError).message).toContain('reconcileAdopt')
    expect((busy as WorkspaceBusyError).workspace).toBe(workspace.path)

    // The recovery door takes it over, on the named path like on any other, and
    // then the same replay runs there.
    expect(await new WorkspaceRegistry({ markerRoot: markersDirectory(h) }).reconcileAdopt(workspace.path)).toEqual({ adopted: true })
    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: LINEAGE, workspace: { path: workspace.directory } }, ROOT)
    expect(outcome.status).toBe('verified')
    expect(markerFor(h, workspace.path)).toBeUndefined()
  })

  it('admits a replayed worker\u2019s own decomposition against the named workspace, and runs the child there', async () => {
    let h!: RunStack
    let decomposed: ToolCallResult | undefined
    h = await startRunStack({
      roots: [ROOT],
      tools: true,
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        await writeFile(join(agent.session.header.cwd, 'parent-worker.txt'), 'x')
        decomposed = await h.call(agent, 'task_decompose', {
          reason: 'the replayed work is not atomic',
          children: [{
            objective: 'the child of the replayed work', requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [{ description: 'the child holds', command: 'test -f parent-worker.txt && pwd > child-verifier-cwd.txt && true' }],
          }],
        })
      },
    })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('true'))
    const checkoutPath = await realpath(h.checkout)
    const workspace = await prepareWorkspace(h, 'decomposed-workspace')

    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: LINEAGE, workspace: { path: workspace.directory } }, ROOT)

    expect(decomposed?.text).toContain('into 1 children')
    expect(outcome.status).toBe('verified')
    // The whole subtree worked in the named workspace: the worker's own write, the
    // child's verification of it, and nothing in the caller's checkout.
    expect(existsSync(join(workspace.directory, 'parent-worker.txt'))).toBe(true)
    expect(existsSync(join(workspace.directory, 'child-verifier-cwd.txt'))).toBe(true)
    expect(existsSync(join(h.checkout, 'parent-worker.txt'))).toBe(false)
    expect(existsSync(join(h.checkout, 'child-verifier-cwd.txt'))).toBe(false)
    // Every layer the subtree held on the named workspace came off; the caller's
    // own hold on its checkout is untouched.
    expect(markerFor(h, workspace.path)).toBeUndefined()
    expect(markerFor(h, checkoutPath)).toBeDefined()
  })
})

describe('S4-E: the named workspace and the caller\u2019s graph env', () => {
  it('runs the verifier alone in the named workspace when the replay spawns no worker', async () => {
    // The deterministic criteria replay (the task_definition candidate) has no
    // worker at all: the verifier is the whole run, and the named workspace is
    // still the directory it judges in.
    const h = await startRunStack({ roots: [ROOT], worker: () => {} })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('pwd > verifier-cwd.txt && test -f input.txt'))
    const checkoutPath = await realpath(h.checkout)
    const workspace = await prepareWorkspace(h, 'criteria-workspace')
    await writeFile(join(workspace.directory, 'input.txt'), 'the workspace copy')
    await writeFile(join(h.checkout, 'input.txt'), 'the caller checkout copy')

    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, {
      lineage: LINEAGE,
      spawn: false,
      workspace: { path: workspace.directory },
    }, ROOT)

    expect(outcome.status).toBe('verified')
    expect(outcome.workspace).toBe(workspace.path)
    expect(outcome.criteria?.map(item => item.verdict)).toEqual(['pass'])
    expect(h.spawns).toHaveLength(0)
    expect(await realpath(readFileSync(join(workspace.directory, 'verifier-cwd.txt'), 'utf8').trim())).toBe(workspace.path)
    expect(existsSync(join(h.checkout, 'verifier-cwd.txt'))).toBe(false)
    // The claim came off with the run, and the caller keeps its own.
    expect(markerFor(h, workspace.path)).toBeUndefined()
    expect(markerFor(h, checkoutPath)).toBeDefined()
  })

  it('is the same directory when the caller names its own checkout', async () => {
    // Naming the caller's own checkout is the degenerate case of the option: the
    // replay is handed the layer its caller already holds, exactly as a replay
    // without the option is.
    let h!: RunStack
    h = await startRunStack({
      roots: [ROOT],
      worker: async (sessionId: SessionId, agent: Agent) => {
        if (!await isReplayedWorker(h, sessionId)) return
        await writeFile(join(agent.session.header.cwd, 'worker-marker.txt'), 'x')
      },
    })
    const first = await h.root(ROOT, rootContract('the tree'))
    const champion = await writeChampion(h, first.storeId, championCriterion('test -f worker-marker.txt'))
    const checkoutPath = await realpath(h.checkout)
    const before = markers(h)

    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: LINEAGE, workspace: { path: h.checkout } }, ROOT)

    expect(outcome.status).toBe('verified')
    expect(outcome.workspace).toBe(checkoutPath)
    expect(existsSync(join(h.checkout, 'worker-marker.txt'))).toBe(true)
    expect(markers(h)).toHaveLength(before.length)
    expect(markerFor(h, checkoutPath)?.owner).toMatchObject({ taskId: first.taskId, runId: first.runId })
  })
})

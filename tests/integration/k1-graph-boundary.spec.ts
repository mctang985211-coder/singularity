import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildEvidenceRef, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { canonicalize } from '../../task/src/contract.ts'
import type { CriterionSpec, DecomposeChildSpec, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { WorkspaceRegistry } from '../../task-runtime/src/workspace.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/**
 * The two acceptance results K1 could not reach on the old fixtures, reached on
 * the multi-graph deployment (`assembly-stack`: the real JSONL store, the real
 * `TaskService`/`TaskRuntime`/`VerifierRegistry`/`AgentRuntime`, the real tool
 * plane, the real workspace registry — the model loop is the only stand-in).
 *
 * - **K1-3, the cross-graph reference.** A parent's composite criterion may name
 *   the evidence its goal rests on; the reference is resolved against the
 *   *judging run's own store*, so a record of another graph cannot satisfy it —
 *   and the refusal names the member the entry reads. The positive control in
 *   the same boot shape (the same map naming the member's own criterion) passes,
 *   so the refusal is the reference's, not "everything fails here".
 * - **K1-4, the checkout that cannot be taken over.** A delegated parent whose
 *   child batch ended (its run is `active`, its accumulation holds the ended
 *   batch) is brought back by recovery only if the checkout is this process's to
 *   write into. When the ownership marker names a live pid the real
 *   `WorkspaceRegistry` refuses the adoption, and the recovery branch settles
 *   that run `failed` by name instead of resuming it into somebody else's
 *   checkout (`task-runtime/src/index.ts` `reconcileStore`, the
 *   `returnedParents` loop under the workspace gate).
 */

const stacks: AssemblyStack[] = []
const directories: string[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([stack.dispose({ remove: false }), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })])
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

/** One criterion a command settles. */
const criterion = (criterionId: string, command = 'true'): CriterionSpec => ({ criterionId, description: `${criterionId} holds`, command })

/** One child spec for a batch. */
function child(objective: string, criteria: readonly CriterionSpec[], extra: Partial<DecomposeChildSpec> = {}): DecomposeChildSpec {
  return { objective, acceptanceCriteria: criteria, ...extra }
}

/** One root contract: the goal's own check, plus the conjunction (with the map the case declares). */
function rootContract(objective: string, childEvidence?: readonly ChildEvidenceRef[]): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [
      { criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' },
      {
        criterionId: 'root-members',
        description: 'the goal rests on the members the run admitted',
        mode: 'composite',
        mandatory: true,
        ...(childEvidence === undefined ? {} : { childEvidence: [...childEvidence] }),
      },
    ],
  }
}

/** One criterion's verdict out of one store's evidence for one run — the store's record, never a return value. */
function verdictOf(snapshot: TaskSnapshot, runId: string, criterionId: string): { status: string; verifierId?: string; details?: string } {
  const bundle = snapshot.evidence.filter(item => item.taskRunId === runId)
  const verdict = bundle.flatMap(item => item.verifierResults).find(result => result.criterionId === criterionId)
  if (verdict === undefined) throw new Error(`run "${runId}" holds no verdict about "${criterionId}"`)
  return verdict
}

/** The one evidence bundle a task's verified run left in its store. */
function evidenceOf(snapshot: TaskSnapshot, taskId: string): TaskSnapshot['evidence'][number] {
  const found = snapshot.evidence.find(item => item.taskId === taskId)
  if (found === undefined) throw new Error(`store "${snapshot.id}" holds no evidence for task "${taskId}"`)
  return found
}

/** The task ids one snapshot holds, so a case can say "no other task appeared here". */
function taskIds(snapshot: TaskSnapshot): string[] {
  return snapshot.tasks.map(task => task.taskId)
}

/** The run one task holds, or a failure naming the task. */
function runOf(snapshot: TaskSnapshot, taskId: string): TaskRun {
  const run = snapshot.runs.find(candidate => candidate.taskId === taskId)
  if (run === undefined) throw new Error(`the store holds no run for task "${taskId}"`)
  return run
}

/** The workspace-owner markers one deployment's run-binding root holds. */
function markers(boot: AssemblyStack): string[] {
  try {
    return readdirSync(join(boot.home, 'run-bindings', 'workspace-owners'))
  } catch {
    return []
  }
}

/** The marker root one deployment writes its ownership markers under. */
function markerRoot(boot: AssemblyStack): string {
  return join(boot.home, 'run-bindings', 'workspace-owners')
}

/** One workspace-ownership marker as the real registry's own parser reads it. */
interface MarkerFile {
  readonly pid: number
  readonly path: string
  readonly owner: {
    readonly kind: 'run' | 'verifier' | 'batch'
    readonly storeId: string
    readonly taskId?: string
    readonly runId?: string
    readonly batchId?: string
    readonly since: string
  }
  readonly since: string
  readonly processStartedAt?: string
}

/** The one marker file a deployment holds, parsed — the bytes the real registry reads. */
function onlyMarker(boot: AssemblyStack): MarkerFile {
  const files = markers(boot)
  if (files.length !== 1) throw new Error(`expected exactly one workspace marker, found ${JSON.stringify(files)}`)
  return JSON.parse(readFileSync(join(markerRoot(boot), files[0]!), 'utf8')) as MarkerFile
}

/**
 * One graph's tree taken through the deployment's own entries: the root contract
 * is intaken (the checkout is claimed here), one batch of one command-settled
 * member is admitted and driven to its end by the real driver, and the member's
 * verified run leaves the store its own evidence. The parent's own submission is
 * the caller's (a case that judges the map submits with the map's contract; a
 * case that only needs the product leaves the run active).
 */
async function deliver(
  boot: AssemblyStack,
  graphRoot: string,
  contract: RootContractSpec,
  memberObjective: string,
): Promise<{ storeId: string; taskId: string; runId: string; memberTaskId: string; memberRunId: string; evidenceId: string }> {
  const storeId = boot.storeIdOf(graphRoot)
  await boot.seedLog(graphRoot, [contract.objective])
  const activated = await boot.runtime.intakeRootContract(storeId, graphRoot, contract)
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  const spec: DecomposeSpec = {
    reason: `delegate ${memberObjective}`,
    children: [child(memberObjective, [criterion('member-1')])],
  }
  const admitted = await boot.runtime.decomposeAndRun(storeId, activated.taskId, activated.runId, graphRoot, spec)
  if (admitted.status !== 'admitted') throw new Error(`the batch was not admitted: ${admitted.detail}`)
  const outcomes = await boot.runtime.awaitBatch(storeId, admitted.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  const memberTaskId = outcomes[0]!.taskId
  const memberRun = runOf(await boot.snapshot(storeId), memberTaskId)
  const evidenceId = evidenceOf(await boot.snapshot(storeId), memberTaskId).evidenceId
  return { storeId, taskId: activated.taskId, runId: activated.runId, memberTaskId, memberRunId: memberRun.runId, evidenceId }
}

/**
 * The two-graph boot this file's K1-3 cases share: one deployment, one checkout,
 * two graphs. The checkout is the deployment's own one-writer resource, so the
 * graphs use it one after the other — the first graph's tree is finished (its run
 * terminal, its claim released, its marker gone) before the second graph's root
 * claims it. That order is the deployment's rule, not the case's convenience:
 * the second root's intake would otherwise be refused by the real registry.
 */
async function twoGraphBoot(worker: (sessionId: string) => Promise<void> | void = async () => {}): Promise<{ stack: AssemblyStack; storeA: string; storeB: string }> {
  const stack = await boot({
    graphs: [{ id: 'g1', rootSessionId: 's-root' }, { id: 'g2', rootSessionId: 's-other' }],
    worker,
  })
  return { stack, storeA: stack.storeIdOf('s-root'), storeB: stack.storeIdOf('s-other') }
}

describe('K1-3: a parent cannot rest on another graph\'s record', () => {
  it('refuses a composite criterion naming the other graph\'s evidence, names the member, and consumes nothing there', async () => {
    const { stack, storeA, storeB } = await twoGraphBoot()
    // ── graph 2: a genuinely verified product through the real store/verifier ──
    const other = await deliver(stack, 's-other', rootContract('the other graph work'), 'the other graph member')
    expect(other.storeId).toBe(storeB)
    expect(storeB).not.toBe(storeA)
    // The record the cross-graph entry will name really exists: it is graph 2's
    // own evidence bundle, produced by the real command verifier over the member's
    // verified run — not an id a case made up.
    const foreign = evidenceOf(await stack.snapshot(storeB), other.memberTaskId)
    expect(foreign.evidenceId).toBe(other.evidenceId)
    expect(foreign.taskRunId).toBe(other.memberRunId)
    expect(runOf(await stack.snapshot(storeB), other.memberTaskId).status).toBe('verified')
    expect(foreign.verifierResults.map(result => result.status)).toContain('pass')
    // Graph 2's tree is settled: its root submitted and verified, which is what
    // releases the single checkout's claim.
    const settledOther = await stack.runtime.submitResult('s-other', { summary: 'the other graph delivered' })
    expect(settledOther.status).toBe('verified')
    const beforeB = canonicalize(await stack.snapshot(storeB))
    await vi.waitFor(() => expect(markers(stack)).toEqual([]))

    // ── graph 1: a root whose composite criterion names graph 2's evidence ────
    const mine = await deliver(
      stack,
      's-root',
      rootContract('ship the release', [{ childIndex: 0, evidenceRef: foreign.evidenceId }]),
      'our own member',
    )
    expect(mine.storeId).toBe(storeA)
    // The member verified on its own criterion — the criterion's own verdict is a
    // pass in graph 1's store — and the map's entry is what the parent's
    // acceptance rests on. That entry names a record this store does not hold.
    expect(verdictOf(await stack.snapshot(storeA), mine.memberRunId, 'member-1').status).toBe('pass')
    const memberInA = evidenceOf(await stack.snapshot(storeA), mine.memberTaskId)
    expect(memberInA.evidenceId).not.toBe(foreign.evidenceId)

    const submitted = await stack.runtime.submitResult('s-root', { summary: 'the goal rests on the other graph\'s record' })
    expect(submitted.status).toBe('failed')

    // The verdict is the real composite verifier's, read back off graph 1's store:
    // the entry did not resolve, and the refusal names the member it read.
    const after = await stack.snapshot(storeA)
    const verdict = verdictOf(after, mine.runId, 'root-members')
    expect(verdict).toMatchObject({ status: 'fail', verifierId: 'composite' })
    expect(verdict.details).toContain(`child #0 (${mine.memberTaskId})`)
    expect(verdict.details).toContain(`evidence does not contain "${foreign.evidenceId}"`)
    expect((await stack.task.taskIn(storeA, mine.taskId)).status).toBe('failed')

    // The same id the parent named is a real record of the deployment, readable
    // through the real read door in the graph that holds it — and refused by name
    // in the graph that does not. The reference never widens the caller's domain.
    const readThere = await stack.call('s-other', 'context_read', { kind: 'evidence', ref: foreign.evidenceId })
    expect(readThere.isError).toBe(false)
    expect(readThere.text).toContain(`evidence ${foreign.evidenceId}`)
    const readHere = await stack.call('s-root', 'context_read', { kind: 'evidence', ref: foreign.evidenceId })
    expect(readHere.text).toContain('not-found')
    expect(readHere.text).toContain('ids from another graph are not readable here')

    // Graph 2's records were not consumed by that reading: its store is exactly
    // what it was, and graph 1 holds no artifact or claim referencing the foreign
    // bundle — the only trace of the id in graph 1 is the refusal that names it.
    expect(canonicalize(await stack.snapshot(storeB))).toBe(beforeB)
    const artifacts = after.evidence.flatMap(item => item.artifacts.map(artifact => artifact.artifactId))
    const claims = after.evidence.flatMap(item => item.claims.flatMap(claim => claim.artifactRefs))
    expect(artifacts).not.toContain(foreign.evidenceId)
    expect(claims).not.toContain(foreign.evidenceId)
    expect(taskIds(after)).toEqual([mine.taskId, mine.memberTaskId])
  })

  it('passes the same map when it names the member\'s own criterion — the positive control', async () => {
    const { stack, storeB } = await twoGraphBoot()
    const other = await deliver(stack, 's-other', rootContract('the other graph work'), 'the other graph member')
    await stack.runtime.submitResult('s-other', { summary: 'the other graph delivered' })
    await vi.waitFor(() => expect(markers(stack)).toEqual([]))

    // The identical flow and boot shape; the only difference is that the entry
    // names this run's own member criterion instead of the other graph's record.
    const mine = await deliver(
      stack,
      's-root',
      rootContract('ship the release', [{ childIndex: 0, criterionId: 'member-1' }]),
      'our own member',
    )
    const submitted = await stack.runtime.submitResult('s-root', { summary: 'the member is the goal\'s own' })
    expect(submitted.status).toBe('verified')

    const after = await stack.snapshot(mine.storeId)
    const verdict = verdictOf(after, mine.runId, 'root-members')
    expect(verdict).toMatchObject({ status: 'pass', verifierId: 'composite' })
    expect(verdict.details).toContain(`child #0 (${mine.memberTaskId}) criterion "member-1" passed`)
    expect((await stack.task.taskIn(mine.storeId, mine.taskId)).status).toBe('verified')
    // The other graph's tree is untouched by this case too.
    expect(taskIds(await stack.snapshot(storeB))).toEqual([other.taskId, other.memberTaskId])
  })
})

/** Everything the K1-4 takeover cases read off the crashed deployment they booted. */
interface ReturnedParent {
  readonly first: AssemblyStack
  readonly dir: string
  readonly storeId: string
  readonly rootTaskId: string
  readonly rootRunId: string
  readonly middle: TaskRun
  readonly middleTaskId: string
  readonly middleSession: string
  readonly middleBatchId: string
  readonly endMessageId: string
  /** The ownership marker the crashed process left, as the next process reads it. */
  readonly leaving: MarkerFile
}

/**
 * Boot one deployment and drive it into the state the K1-4 branch is about,
 * through the deployment's own entries: the root intakes its contract (which
 * claims the checkout) and delegates a middle that may delegate further; the
 * middle's turn decomposes its own child through the real tool plane and then
 * stops acting, so its child's batch is driven to its end, the middle is handed
 * back `active` — an ended batch in its accumulation, its own result never
 * submitted — and its batch-end message has been stated to it. The process is
 * then killed: what the next process reads is the store plus the checkout's
 * ownership marker.
 */
async function returnedParent(): Promise<ReturnedParent> {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-k1-owner-'))
  directories.push(dir)
  /** The middle's own turn never returns: it has handed its child's batch in and must not submit its own result. */
  const parked = Promise.withResolvers<void>()
  const first = await boot({
    dir,
    worker: async sessionId => {
      const bound = await first.runtime.runForSession(sessionId).catch(() => undefined)
      if (bound === undefined || bound.task.depth !== 1) return
      await first.call(sessionId, 'task_decompose', {
        reason: 'the middle splits the work',
        children: [child('the middle child', [criterion('grandchild-1')])],
      })
      await parked.promise
    },
  })
  const storeId = first.storeIdOf('s-root')
  await first.seedLog('s-root', ['ship the release'])
  const activated = await first.runtime.intakeRootContract(storeId, 's-root', rootContract('ship the release'))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  const root = { taskId: activated.taskId, runId: activated.runId }
  // The root delegates a middle that may delegate further — the real entry the
  // root's own `task_decompose` call reaches.
  const rootSpec: DecomposeSpec = {
    reason: 'delegate to a middle',
    children: [child('the middle work', [criterion('middle-1')], { decomposable: true })],
  }
  const rootBatch = await first.runtime.decomposeAndRun(storeId, root.taskId, root.runId, 's-root', rootSpec)
  if (rootBatch.status !== 'admitted') throw new Error(`the root batch was not admitted: ${rootBatch.detail}`)
  const middleTaskId = rootBatch.childTaskIds[0]!

  // The middle's own batch (its child) ends while its turn stays parked: the run
  // sits `active`, its child batches ended, its own result unsubmitted. That is
  // the state recovery has to hand back — and the state this case crashes in.
  let middle!: TaskRun
  await vi.waitFor(async () => {
    const snapshot = await first.snapshot(storeId)
    middle = runOf(snapshot, middleTaskId)
    expect(middle.executionPhase).toBe('active')
    expect(middle.status).toBe('running')
    expect(middle.batches).toHaveLength(1)
    expect(middle.batchId).toBeUndefined()
    expect(middle.submission).toBeUndefined()
  })
  const middleSession = String(middle.sessionId)
  const middleBatchId = middle.batches![0]!.batchId
  const endMessageId = `m-batchend-${middleBatchId}`
  // The delegating root is the batch the middle is a member of: still in flight.
  expect(runOf(await first.snapshot(storeId), root.taskId).executionPhase).toBe('waiting_children')
  // Its batch end was stated to the live, unsubmitted parent — the positive half
  // of the "not woken" claim below, and the piece a stand-in loop cannot receive:
  // a spawned worker holds no durable log here, so the real delivery refuses by
  // name (`target-unreadable`) and what the case reads is the *statement* the
  // runtime made, observed at the relay it made it through.
  await vi.waitFor(() => expect(first.relayed.filter(intent => intent.messageId === endMessageId)).toHaveLength(1))
  const told = first.relayed.filter(intent => intent.messageId === endMessageId)[0]!
  expect(told.targetSessionId).toBe(middleSession)
  expect(told.text).toContain(`[task-batch-end ${middleBatchId}]`)
  expect(told.text).toContain('nothing was submitted on your behalf')
  expect(told.status).toContain('refused')

  // The process dies with its claim on disk: the marker the deployment's own
  // entries wrote is what the next process reads. Its holder is the returned
  // parent's own run — the run that was `active` and therefore held the checkout.
  await first.crash()
  const leaving = onlyMarker(first)
  expect(leaving.owner.storeId).toBe(storeId)
  expect(leaving.owner.runId).toBe(middle.runId)
  expect(leaving.path).toBe(realpathSync(first.checkout))
  return { first, dir, storeId, rootTaskId: root.taskId, rootRunId: root.runId, middle, middleTaskId, middleSession, middleBatchId, endMessageId, leaving }
}

/** The next process over the same workspace, holding the graph facts the crashed deployment left. */
async function recover(state: ReturnedParent, worker: (sessionId: string) => Promise<void> | void = async () => {}): Promise<AssemblyStack> {
  const sessions = (await state.first.snapshot(state.storeId)).runs.map(run => String(run.sessionId))
  return await boot({
    dir: state.dir,
    graphs: [{ id: 'g1', rootSessionId: 's-root', members: sessions }],
    worker,
  })
}

/** A pid that is alive and is not this process's: the stand-in for the writer that holds the checkout. */
function otherLivePid(): number {
  for (const pid of [process.ppid, 1]) {
    try {
      process.kill(pid, 0)
      return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return pid
    }
  }
  throw new Error('no live pid other than this process is available to stand in for the writer')
}

describe('K1-4: a returned parent whose checkout cannot be taken over is stopped by name', () => {
  it('settles the delegated parent failed by name, wakes nothing and resurrects nothing', async () => {
    const state = await returnedParent()
    const { storeId, middle, middleTaskId, middleSession, middleBatchId, endMessageId, rootTaskId } = state

    // ── the next process: the real recovery entry over the same store ─────────
    const second = await recover(state)
    // The marker names a live pid, so the checkout is somebody's — the real
    // registry's own reading of the bytes, not a stubbed verdict.
    const held = onlyMarker(second)
    expect(held.owner.storeId).toBe(storeId)
    expect(() => process.kill(held.pid, 0)).not.toThrow()
    await second.runtime.adoptRoot(storeId, 's-root')

    // The delegated parent is settled failed by name, with the workspace refusal
    // in its cause — read back off the store, never from the call's return.
    const after = await second.snapshot(storeId)
    const failedMiddle = runOf(after, middleTaskId)
    expect(failedMiddle.status).toBe('failed')
    expect(failedMiddle.submission).toBeUndefined()
    expect((await second.task.taskIn(storeId, middleTaskId)).status).toBe('failed')
    const middleReview = after.reviews.find(review => review.taskId === middleTaskId)!
    expect(middleReview.outcome).toBe('failed')
    expect(middleReview.runId).toBe(middle.runId)
    expect(middleReview.localizedCause).toContain(
      `recovery refused to bring run "${middle.runId}" back into its checkout: its child batches ended and it has to be told so, ` +
      'but the workspace cannot be taken over for recovery:',
    )
    expect(middleReview.localizedCause).toContain(`workspace ${held.path} still has a holder`)
    expect(middleReview.localizedCause).toContain(`the marker names this process's own pid ${held.pid}`)
    // The refused takeover left the claim exactly as the dead process wrote it:
    // the same bytes the next process read are still on disk.
    expect(onlyMarker(second)).toEqual(state.leaving)
    // The batch whose result the run cannot be told is on the record it was read
    // from: the run's accumulation names it, and nothing cleared it.
    expect(runOf(after, middleTaskId).batches!.map(batch => batch.batchId)).toEqual([middleBatchId])

    // Nothing woke the failed run and nothing was spawned for it: the deployment
    // never asked the model loop to bring the middle's session back, the recovery
    // process stated no batch-end message to it at all — the statement the first
    // process made is the one that stands — and the re-delivery the runtime can
    // re-derive from the store answers `skipped` (a terminal run is not woken).
    expect(second.mintedAgent(middleSession)).toBeUndefined()
    expect(second.spawns).toEqual([])
    expect(second.relayed.filter(intent => intent.messageId === endMessageId)).toEqual([])
    expect(second.relayed.filter(intent => intent.targetSessionId === middleSession)).toEqual([])
    await expect(second.runtime.redeliverBatchResult(storeId, middleBatchId)).resolves.toBe('skipped')

    // The terminal run is not resurrected: a second pass over the same store
    // changes nothing, starts nothing, and leaves the same run failed — the
    // delegation is not retried and no second run of that task appears.
    const startEventsBefore = (await second.events(storeId)).filter(event => event.kind === 'TaskStarted').length
    await second.runtime.reconcileStore(storeId)
    const settledAgain = await second.snapshot(storeId)
    expect(settledAgain.runs.filter(run => run.taskId === middleTaskId)).toHaveLength(1)
    expect(runOf(settledAgain, middleTaskId).runId).toBe(middle.runId)
    expect(runOf(settledAgain, middleTaskId).status).toBe('failed')
    expect((await second.events(storeId)).filter(event => event.kind === 'TaskStarted')).toHaveLength(startEventsBefore)
    expect(second.spawns).toEqual([])
    expect(second.mintedAgent(middleSession)).toBeUndefined()
    expect(second.relayed.filter(intent => intent.targetSessionId === middleSession)).toEqual([])
    // The run's own Session still resolves to that one failed run — no second run
    // took its place — and a submission for it is answered from the record rather
    // than reopening it.
    expect((await second.runtime.runForSession(middleSession)).run.runId).toBe(middle.runId)
    expect(settledAgain.runs.filter(run => String(run.sessionId) === middleSession)).toHaveLength(1)
    const late = await second.runtime.submitResult(middleSession, { summary: 'too late to hand this in' })
    expect(late.status).toBe('failed')
    expect(late.detail).toContain('already settled as "failed"')
    // The delegating root was stopped by the same gate, with its own named reason
    // (a batch of its own is what cannot be restarted into the checkout).
    const failedRoot = runOf(settledAgain, rootTaskId)
    expect(failedRoot.status).toBe('failed')
    const rootReview = settledAgain.reviews.find(review => review.taskId === rootTaskId)!
    expect(rootReview.localizedCause).toContain('the workspace cannot be taken over for recovery:')
  })

  it('refuses the same takeover when the holder is another live process, and stops the run the same way', async () => {
    const state = await returnedParent()
    const { storeId, middle, middleTaskId, middleSession, rootTaskId, rootRunId } = state
    // The deployment's own marker is replaced by the one a *second* process would
    // have written: the same registry class, the same marker root, an injected
    // live pid — which is the seam `WorkspaceRegistryOptions.pid` exists for. The
    // refusal below is then the other live owner's, not this process's own pid.
    for (const file of markers(state.first)) rmSync(join(markerRoot(state.first), file), { force: true })
    const holder = otherLivePid()
    expect(holder).not.toBe(process.pid)
    const writer = new WorkspaceRegistry({ markerRoot: markerRoot(state.first), pid: holder })
    await writer.claim(realpathSync(state.first.checkout), {
      kind: 'run',
      storeId,
      taskId: rootTaskId,
      runId: rootRunId,
      since: new Date().toISOString(),
    })

    const second = await recover(state)
    expect(onlyMarker(second).pid).toBe(holder)
    await second.runtime.adoptRoot(storeId, 's-root')

    const after = await second.snapshot(storeId)
    const middleReview = after.reviews.find(review => review.taskId === middleTaskId)!
    expect(runOf(after, middleTaskId).status).toBe('failed')
    expect(middleReview.localizedCause).toContain(
      `recovery refused to bring run "${middle.runId}" back into its checkout: its child batches ended and it has to be told so, ` +
      'but the workspace cannot be taken over for recovery:',
    )
    expect(middleReview.localizedCause).toContain(`the marker names pid ${holder}, which is alive`)
    expect(middleReview.localizedCause).toContain('a live owner is never taken over')

    // The same three facts as the case above: no wake, no worker, no resurrection.
    expect(second.mintedAgent(middleSession)).toBeUndefined()
    expect(second.spawns).toEqual([])
    expect(second.relayed.filter(intent => intent.targetSessionId === middleSession)).toEqual([])
    await second.runtime.reconcileStore(storeId)
    expect(runOf(await second.snapshot(storeId), middleTaskId).status).toBe('failed')
  })

  it('passes the workspace gate when the checkout is free — the marker is what stops the run', async () => {
    const state = await returnedParent()
    const { storeId, middle, middleTaskId, middleSession } = state
    // The same construction with one difference: no marker, so the checkout is
    // nobody's and the real registry adopts it. Recovery then takes the checkout
    // over (its own claim lands where the crashed process's was) and the returned
    // parent is handed to its Session's own door instead of being stopped by the
    // workspace's. That door refuses in *this* fixture — a spawned worker holds no
    // durable log here, so the real resume answers `session-unreadable` — and the
    // case says so rather than pretending the run came back. What it establishes
    // is the difference between the two stops: with the marker present the
    // workspace branch fires before that door is even reached.
    for (const file of markers(state.first)) rmSync(join(markerRoot(state.first), file), { force: true })
    const second = await recover(state)
    expect(markers(second)).toEqual([])

    await second.runtime.adoptRoot(storeId, 's-root')

    const after = await second.snapshot(storeId)
    const cause = after.reviews.find(review => review.taskId === middleTaskId)?.localizedCause ?? ''
    expect(runOf(after, middleTaskId).runId).toBe(middle.runId)
    expect(runOf(after, middleTaskId).status).toBe('failed')
    // Not the workspace refusal: this process adopted and claimed the checkout,
    // which is what the marker it wrote says.
    expect(cause).not.toContain('the workspace cannot be taken over for recovery')
    expect(markers(second)).toHaveLength(1)
    expect(onlyMarker(second)).not.toEqual(state.leaving)
    expect(onlyMarker(second).owner.storeId).toBe(storeId)
    // The stop is the Session's own door, named — the fixture boundary above.
    expect(cause).toContain(`its child batches ended (${state.middleBatchId}) and its Session "${middleSession}" could not be brought back under its own identity:`)
    expect(cause).toContain('session-unreadable')
  })
})

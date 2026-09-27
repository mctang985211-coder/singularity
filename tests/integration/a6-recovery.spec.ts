import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskInstance, TaskRun } from '../../task/src/index.ts'
import { rootTaskStoreId, runMemberTaskIds } from '../../task/src/index.ts'
import type { ScriptEntry } from '../support/scripted-loop.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'

/**
 * A6 acceptance (plan §F.4, EVO-3): a failed root task's **new attempt** — the
 * runtime opens a new root Run/Session in the same store, the ordinary K1 chain
 * drives it, a passed sibling's evidence is read instead of re-run, and the
 * **original** acceptance criteria judge the result.
 *
 * Everything here runs over the real deployment: the real DSH loop with a
 * scripted model, the real store, the real batch driver, the real verifier. The
 * only replaced piece is the model itself — every step a case asserts on is a
 * tool call the loop dispatched or a fact the store recorded.
 *
 * Two failure shapes, one per case:
 *
 * - **a failed member with a passed sibling** (a capability the first attempt
 *   lacked): the attempt reuses the passed member at its position in the
 *   original acceptance map and re-runs only the failed position.
 * - **a pure artifact gap** (a member that never started because the product its
 *   criterion required did not exist): no evolution proposal, no approval and no
 *   passed sibling — the attempt produces the product it needs, along the
 *   ordinary producer/dependency chain, and only then is the root accepted.
 *
 * The attempt is opened through the runtime's own service entry, from the store's
 * own facts — `recoverRootTask` in `task-runtime/src/index.ts`, which is what the
 * host composition layer calls. That it is not reachable as a model tool is not
 * asserted here; the tool surface belongs to the supervisor interface (④), and
 * the runtime's entry is the thing under test.
 */

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
})

/** One child spec carrying exactly the criteria a case is about. */
function child(objective: string, criteria: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { objective, acceptanceCriteria: criteria, ...extra }
}

function commandCriterion(criterionId: string, command = 'true', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { criterionId, description: `${criterionId} holds`, command, ...extra }
}

function batch(reason: string, children: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { reason, children }
}

/** The root contract both cases run under: the goal's own check and the map over the attempt's members. */
function rootContract(map: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    objective: 'ship the release',
    acceptanceCriteria: [
      commandCriterion('root-goal'),
      {
        criterionId: 'root-map',
        description: 'the members the map names passed',
        mode: 'composite',
        mandatory: true,
        childEvidence: map,
      },
    ],
  }
}

async function runOf(h: ScriptedLoop, storeId: string, runId: string): Promise<TaskRun> {
  return await h.task.runIn(storeId, runId)
}

async function taskOf(h: ScriptedLoop, storeId: string, taskId: string): Promise<TaskInstance> {
  return await h.task.taskIn(storeId, taskId)
}

/** One criterion's verdicts on one run, as the store recorded them. */
async function verdict(h: ScriptedLoop, storeId: string, runId: string, criterionId: string) {
  const bundle = (await h.snapshot(storeId)).evidence.filter(item => item.taskRunId === runId)
  return bundle.flatMap(item => item.verifierResults).find(item => item.criterionId === criterionId)
}

/** One batch's members, read from the store's own accumulation. */
async function members(h: ScriptedLoop, storeId: string, runId: string): Promise<string[]> {
  return (await h.task.runMembersIn(storeId, runId)).map(task => task.taskId)
}

/** Wait for one more spawn than `count` and answer with the newest spawn's session. */
async function nextSpawn(h: ScriptedLoop, count: number): Promise<string> {
  await vi.waitFor(() => expect(h.spawns.length).toBeGreaterThan(count), { timeout: 20_000, interval: 25 })
  return h.spawns[count]!.sessionId
}

describe('A6-1: a failed member is re-run while its passed sibling is read, and the original map is satisfied', () => {
  it('opens a new root run, reuses the passed sibling at its position, and lets the original acceptance verify the attempt', async () => {
    // The first attempt's members: `member-0` passes, `member-1` fails. The root
    // then hands its own result in and is judged by the original map — which
    // fails on the second position, exactly as the ticket's failure shape is.
    const attemptBatch = Promise.withResolvers<void>()
    const attemptSubmit = Promise.withResolvers<void>()
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          {
            tool: 'task_decompose',
            args: batch('first attempt: one member holds, one does not', [
              child('the member that holds', [commandCriterion('member-0', 'true')]),
              child('the member that does not', [commandCriterion('member-1', 'false')]),
            ]),
          },
          { text: 'root: the first attempt is running' },
          { waitFor: () => attemptBatch.promise },
          { tool: 'task_submit_result', args: { summary: 'the first attempt is handed in' } },
          { text: 'root: handed in' },
        ]
        // The first attempt's two members (spawns 1 and 2) hand their work in.
        : index === 1 || index === 2
          ? [
            { tool: 'task_submit_result', args: { summary: 'the delegated member is done' } },
            { text: 'member: handed in' },
          ]
          // The new attempt's own worker (spawn 3: it is spawned after the first
          // attempt's members): only the failed position is re-run.
          : index === 3
            ? [
              {
                tool: 'task_decompose',
                args: batch('second attempt: re-run the failed position only', [
                  child('the member that failed, again', [commandCriterion('member-1', 'true')]),
                ]),
              },
              { text: 'attempt: the replacement is running' },
              { waitFor: () => attemptSubmit.promise },
              { tool: 'task_submit_result', args: { summary: 'the original goal is met now' } },
              { text: 'attempt: handed in' },
            ]
            // The member the attempt itself delegates to (spawn 4).
            : [
              { tool: 'task_submit_result', args: { summary: 'the replacement holds' } },
              { text: 'replacement: handed in' },
            ],
    })
    const contract = rootContract([{ childIndex: 0, criterionId: 'member-0' }, { childIndex: 1, criterionId: 'member-1' }])
    const root = await h.begin(contract)
    const firstRunId = root.runId

    // ── the first attempt: one batch, two members, one verdict each ──────────
    const batchOne = await (async () => {
      await vi.waitFor(async () => expect((await runOf(h, STORE, firstRunId)).batches?.length).toBe(1))
      return (await runOf(h, STORE, firstRunId)).batches![0]!.batchId
    })()
    await h.runtime.awaitBatch(STORE, batchOne)
    const firstMembers = await members(h, STORE, firstRunId)
    expect(firstMembers).toHaveLength(2)
    const passed = firstMembers[0]!
    const failed = firstMembers[1]!
    expect((await taskOf(h, STORE, passed)).status).toBe('verified')
    expect((await taskOf(h, STORE, failed)).status).toBe('failed')
    const passedRun = (await h.snapshot(STORE)).runs.find(item => item.taskId === passed && item.status === 'verified')!
    const passedEvidence = (await h.snapshot(STORE)).evidence.find(item => item.taskRunId === passedRun.runId)!
    attemptBatch.resolve()

    // ── the root's own acceptance fails on the second position ────────────────
    await vi.waitFor(async () => expect((await taskOf(h, STORE, root.taskId)).status).toBe('failed'), { timeout: 20_000 })
    const failedRun = await runOf(h, STORE, firstRunId)
    expect(failedRun.status).toBe('failed')
    const failedMap = await verdict(h, STORE, firstRunId, 'root-map')
    expect(failedMap?.status).toBe('fail')
    expect(failedMap?.details).toContain(failed)

    // The failure's own diagnosis — the hand-off a recovery is asked for. Written
    // through the store's own entry: what the supervisor writes is its business,
    // and what this case is about starts from the record existing.
    await h.task.recordDiagnosisIn(STORE, {
      diagnosisId: 'd-1',
      taskId: root.taskId,
      observedFailure: 'the second member never verified',
      scope: 'the root goal of this store',
      localizedCause: 'the member that failed could not pass its criterion',
      evidenceRefs: [passedEvidence.evidenceId],
      reviewRefs: [],
      confidence: 'high',
      proposals: [],
    }, 'test')

    // ── the recovery attempt ─────────────────────────────────────────────────
    const spawnsBefore = h.spawns.length
    const outcome = await h.runtime.recoverRootTask(STORE, {
      sourceTaskId: root.taskId,
      sourceRunId: firstRunId,
      sourceDiagnosisId: 'd-1',
      requestKey: 'k-1',
      reuses: [{
        childIndex: 0,
        taskId: passed,
        sourceRunId: passedRun.runId,
        evidenceId: passedEvidence.evidenceId,
        criterionId: 'member-0',
      }],
    }, { sessionId: ROOT })
    expect(outcome.attempt).toBe('started')
    expect(outcome.runId).not.toBe(firstRunId)
    expect(outcome.sessionId).not.toBe(ROOT)
    expect(outcome.reusedMembers).toHaveLength(1)

    // The old attempt is intact and readable: its failed run, its verdicts, its
    // review — and the passed sibling still holds exactly the one run it had.
    const afterStart = await h.snapshot(STORE)
    expect(afterStart.runs.find(item => item.runId === firstRunId)?.status).toBe('failed')
    expect(afterStart.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: passedEvidence.evidenceId })]))
    expect(afterStart.reviews.some(review => review.taskId === root.taskId && review.runId === firstRunId && review.outcome === 'failed')).toBe(true)
    expect(afterStart.runs.filter(item => item.taskId === passed)).toHaveLength(1)

    // The attempt reads the passed sibling at its leading position, before any
    // member of its own batch: the sequence the original map's `childIndex` names.
    const attemptRun = await runOf(h, STORE, outcome.runId)
    expect(attemptRun.recovery?.sourceDiagnosisId).toBe('d-1')
    expect(attemptRun.recovery?.sourceRunId).toBe(firstRunId)
    expect(runMemberTaskIds(attemptRun)).toEqual([passed])

    // ── the attempt's own batch: only the failed position is re-run ──────────
    const attemptSession = await nextSpawn(h, spawnsBefore)
    expect(attemptSession).toBe(outcome.sessionId)
    await vi.waitFor(async () => expect((await runOf(h, STORE, outcome.runId)).batches?.length).toBe(1), { timeout: 20_000 })
    const attemptBatchId = (await runOf(h, STORE, outcome.runId)).batches![0]!.batchId
    await h.runtime.awaitBatch(STORE, attemptBatchId)
    const attemptMembers = await members(h, STORE, outcome.runId)
    expect(attemptMembers).toEqual([passed, expect.any(String)])
    const replacement = attemptMembers[1]!
    expect(replacement).not.toBe(failed)
    expect((await taskOf(h, STORE, replacement)).status).toBe('verified')

    // ── the attempt hands its own result in, judged by the original criteria ─
    attemptSubmit.resolve()
    await vi.waitFor(async () => expect((await runOf(h, STORE, outcome.runId)).status).toBe('verified'), { timeout: 20_000 })
    const mapVerdict = await verdict(h, STORE, outcome.runId, 'root-map')
    expect(mapVerdict?.status).toBe('pass')
    // The original map was satisfied *through the reuse*: position 0 is the passed
    // sibling's own verified evidence, position 1 the replacement's.
    expect(mapVerdict?.details).toContain('childEvidence satisfied')
    expect(mapVerdict?.details).toContain(`child #0 (${passed})`)
    expect(mapVerdict?.details).toContain(`child #1 (${replacement})`)
    expect((await taskOf(h, STORE, root.taskId)).status).toBe('verified')

    // The passed sibling was never re-run, and the failed one was not re-used.
    const final = await h.snapshot(STORE)
    expect(final.runs.filter(item => item.taskId === passed)).toHaveLength(1)
    expect(final.runs.filter(item => item.taskId === root.taskId)).toHaveLength(2)
    // The same key answers with the attempt the store already holds.
    const again = await h.runtime.recoverRootTask(STORE, {
      sourceTaskId: root.taskId,
      sourceRunId: firstRunId,
      sourceDiagnosisId: 'd-1',
      requestKey: 'k-1',
      reuses: [{
        childIndex: 0,
        taskId: passed,
        sourceRunId: passedRun.runId,
        evidenceId: passedEvidence.evidenceId,
        criterionId: 'member-0',
      }],
    }, { sessionId: ROOT })
    expect(again.attempt).toBe('existing')
    expect(again.runId).toBe(outcome.runId)
    expect((await h.snapshot(STORE)).runs).toHaveLength(final.runs.length)
  })
})

describe('A6-2: a pure artifact gap is closed by producing the product, with no proposal and no approval', () => {
  it('opens the attempt although the product does not exist yet, blocks the consumer that needs it, then produces and consumes it', async () => {
    // The first attempt's only member declares a required artifact nothing in the
    // store holds: the spawn gate refuses to start it, records the obligation and
    // settles it blocked. The root's own submission then fails the map — and the
    // product is still absent when the recovery is asked for, which is exactly the
    // case the ticket says must start anyway.
    const firstBatch = Promise.withResolvers<void>()
    const produced = Promise.withResolvers<void>()
    let productRef = ''
    const h = await startScriptedLoop({
      script: (_sessionId, index): readonly ScriptEntry[] => index === 0
        ? [
          {
            tool: 'task_decompose',
            args: batch('first attempt: the consumer cannot start without the product', [
              child('consume the product', [commandCriterion('consume-0', 'true', { requiresArtifact: ['report-from-producer'] })]),
            ]),
          },
          { text: 'root: the first attempt is running' },
          { waitFor: () => firstBatch.promise },
          { tool: 'task_submit_result', args: { summary: 'the first attempt is handed in' } },
          { text: 'root: handed in' },
        ]
        // The new attempt's worker: its member never spawned in the first attempt,
        // so the attempt is the first session the runtime spawns (index 1). It
        // produces the missing product, lets the spec read the product's identity
        // off the store, then consumes it in a second batch — the ordinary
        // producer/dependsOn path, with no recovery-specific step.
        : index === 1
          ? [
            {
              tool: 'task_decompose',
              args: batch('produce the product the goal needs', [
                child('produce it', [commandCriterion('produce-0', 'true')]),
              ]),
            },
            { text: 'attempt: the producer is running' },
            { waitFor: () => produced.promise },
            {
              tool: 'task_decompose',
              args: () => batch('consume what the producer delivered', [
                child('consume it', [commandCriterion('consume-0', 'true', { requiresArtifact: [productRef] })]),
              ]),
            },
            { text: 'attempt: the consumer is running' },
            { tool: 'task_submit_result', args: { summary: 'the product exists and was consumed' } },
            { text: 'attempt: handed in' },
          ]
          // The members the attempt delegates to: their contract is their own, and
          // doing it is handing it in.
          : [
            { tool: 'task_submit_result', args: { summary: 'the delegated work holds' } },
            { text: 'member: handed in' },
          ],
    })
    const contract = rootContract([{ childIndex: 1, criterionId: 'consume-0' }])
    const root = await h.begin(contract)
    const firstRunId = root.runId

    // ── the first attempt: the consumer is blocked, never started ─────────────
    await vi.waitFor(async () => expect((await runOf(h, STORE, firstRunId)).batches?.length).toBe(1), { timeout: 20_000 })
    const firstBatchId = (await runOf(h, STORE, firstRunId)).batches![0]!.batchId
    await h.runtime.awaitBatch(STORE, firstBatchId)
    const firstMembers = await members(h, STORE, firstRunId)
    expect(firstMembers).toHaveLength(1)
    const consumer = firstMembers[0]!
    expect((await taskOf(h, STORE, consumer)).status).toBe('blocked')
    expect((await h.snapshot(STORE)).runs.filter(item => item.taskId === consumer)).toHaveLength(0)
    // The gap and its source are on the record: an obligation names the missing
    // reference and the task that needed it — the "来源可核对" the entry rests on.
    const obligations = (await h.snapshot(STORE)).obligations
    expect(obligations.some(item => item.sourceTaskId === consumer && item.goal.includes('report-from-producer'))).toBe(true)
    expect((await h.snapshot(STORE)).evidence.flatMap(item => item.artifacts)).toEqual([])
    firstBatch.resolve()

    // ── the root fails on its own map ────────────────────────────────────────
    await vi.waitFor(async () => expect((await taskOf(h, STORE, root.taskId)).status).toBe('failed'), { timeout: 20_000 })
    expect((await verdict(h, STORE, firstRunId, 'root-map'))?.status).toBe('fail')
    await h.task.recordDiagnosisIn(STORE, {
      diagnosisId: 'd-artifact',
      taskId: root.taskId,
      observedFailure: 'the product the goal needs does not exist',
      scope: 'the root goal of this store',
      localizedCause: 'no producer had produced the required product',
      evidenceRefs: [obligations[0]!.obligationId],
      reviewRefs: [],
      confidence: 'high',
      proposals: [],
    }, 'test')

    // ── the recovery: no proposal, no approval, no reuse — and it starts ─────
    const capabilitiesBefore = h.runtime.listCapabilities()
    const reviewsBefore = (await h.snapshot(STORE)).reviews.length
    const outcome = await h.runtime.recoverRootTask(STORE, {
      sourceTaskId: root.taskId,
      sourceRunId: firstRunId,
      sourceDiagnosisId: 'd-artifact',
      requestKey: 'k-artifact',
    }, { sessionId: ROOT })
    expect(outcome.attempt).toBe('started')
    expect(outcome.reusedMembers).toEqual([])
    // Nothing about the deployment changed to open it: no capability row was
    // touched and no review decision was taken — a pure artifact gap needs
    // neither (the runtime never consults an evolution ledger).
    expect(h.runtime.listCapabilities()).toEqual(capabilitiesBefore)
    expect((await h.snapshot(STORE)).reviews.length).toBe(reviewsBefore)

    // ── the attempt produces the product, then consumes it ───────────────────
    await vi.waitFor(async () => expect((await runOf(h, STORE, outcome.runId)).batches?.length).toBe(1), { timeout: 20_000 })
    const producerBatch = (await runOf(h, STORE, outcome.runId)).batches![0]!.batchId
    await h.runtime.awaitBatch(STORE, producerBatch)
    const producer = (await members(h, STORE, outcome.runId))[0]!
    expect((await taskOf(h, STORE, producer)).status).toBe('verified')
    // The product the first attempt could not find is on the record now: the
    // producer's verified evidence, read off the store — the identity the
    // consumer's criterion is declared against.
    const producerRun = (await h.snapshot(STORE)).runs.find(item => item.taskId === producer && item.status === 'verified')!
    productRef = (await h.snapshot(STORE)).evidence.find(item => item.taskRunId === producerRun.runId)!.evidenceId
    produced.resolve()

    // ── the consumer runs against the product, at the position the map names ─
    await vi.waitFor(async () => expect((await runOf(h, STORE, outcome.runId)).batches?.length).toBe(2), { timeout: 20_000 })
    const consumerBatch = (await runOf(h, STORE, outcome.runId)).batches![1]!.batchId
    await h.runtime.awaitBatch(STORE, consumerBatch)
    const attemptMembers = await members(h, STORE, outcome.runId)
    expect(attemptMembers).toEqual([producer, expect.any(String)])
    const consumerAgain = attemptMembers[1]!
    // The replacement is a *new* task at the same position: the blocked member
    // stays blocked, and the position is refilled by a task that can start.
    expect(consumerAgain).not.toBe(consumer)
    expect((await taskOf(h, STORE, consumerAgain)).status).toBe('verified')

    // ── the attempt is judged by the original map, at the original position ──
    await vi.waitFor(async () => expect((await runOf(h, STORE, outcome.runId)).status).toBe('verified'), { timeout: 20_000 })
    const mapVerdict = await verdict(h, STORE, outcome.runId, 'root-map')
    expect(mapVerdict?.status).toBe('pass')
    expect(mapVerdict?.details).toContain(`child #1 (${consumerAgain})`)
    expect((await taskOf(h, STORE, root.taskId)).status).toBe('verified')
    // The first attempt's own facts are untouched: its blocked member, its run and
    // its failing verdict are all still readable exactly as they were.
    const final = await h.snapshot(STORE)
    expect(final.runs.find(item => item.runId === firstRunId)?.status).toBe('failed')
    expect(final.evidence.some(item => item.taskId === consumer)).toBe(false)
    expect(final.obligations.some(item => item.sourceTaskId === consumer)).toBe(true)
  })
})

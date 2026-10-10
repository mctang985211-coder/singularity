/**
 * The measurement slice, driven through its own command boundary over a real control store.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore } from '../src/control/session-store.ts'
import { digestOf } from '../src/protocol/envelope.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import type { AcceptanceCriterion } from '../src/task/contract.ts'
import { declareTaskProtocol, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf } from '../src/task/protocol.ts'
import {
  declareMeasureProtocol,
  MEASURE_KINDS,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type EvaluationMetric,
  type EvaluationState,
  type EvaluationWeights,
} from '../src/measure/protocol.ts'
import { createMeasureCommands, type MeasureCommands } from '../src/measure/commands.ts'
import { caliberDigestOf, caliberOf, projectEvaluation } from '../src/measure/view.ts'
import { asyncRefusalOf } from './fixtures.ts'

const TASK = 'task-measured'
const RUN = 'run-1'
const AGENT = 'agent-1'
const EVALUATION = 'eval-1'
const OTHER = 'eval-2'
const [THIRD, FOURTH, FIFTH, SIXTH, SEVENTH] = ['eval-3', 'eval-4', 'eval-5', 'eval-6', 'eval-7']
const RUN_SAME = 'run-same'
const RUN_MODEL = 'run-model'
const RUN_TOOLS = 'run-tools'
const RUN_BARE = 'run-bare'
const RUN_INPUTS = 'run-inputs'
const METER = 'meter'
const BOUNDS = 'bounds'
const METER_DIGEST = 'a'.repeat(64)
const BOUNDS_DIGEST = 'b'.repeat(64)
const UNHELD_DIGEST = 'c'.repeat(64)
const SCHEDULER = 'scheduler-1'
const METER_ACTOR = 'meter-service'
const BOUNDS_ACTOR = 'bounds-service'
const ARTIFACT = 'd'.repeat(64)
const REVISION = { environmentId: 'lib-1', revisionId: 'r0001', digest: 'e'.repeat(64) }
const OTHER_REVISION = { environmentId: 'lib-1', revisionId: 'r0002', digest: 'f'.repeat(64) }
const BUBBLE_INPUTS = [{ name: 'words.txt', digest: '1'.repeat(64) }]
/** A different dataset for the same task: the same question only if the inputs did not matter. */
const OTHER_INPUTS = [{ name: 'words.txt', digest: '2'.repeat(64) }]
/** The manifest a run declares: the model, each tool's content digest, and the conditions. */
const BUBBLE = { model: 'model-1', tools: [{ name: 'count', implementationDigest: METER_DIGEST, version: '1' }], conditions: ['no-network'] }
/** A run's declared manifest: the context members, plus a dataset a test may vary on its own. */
type Manifest = Partial<typeof BUBBLE> & { readonly inputs?: typeof BUBBLE_INPUTS }
const bubbleOf = (runId: string, overrides: Manifest) => ({
  runId, inputs: BUBBLE_INPUTS, workspace: { kind: 'dir', ref: '/tmp/workspace' }, ...BUBBLE, ...overrides,
})
/** The runs this log holds: two under one manifest, then another model, a rebuilt tool, no context. */
const RUNS: readonly (readonly [string, Manifest | null])[] = [
  [RUN, {}], [RUN_SAME, {}], [RUN_MODEL, { model: 'model-2' }],
  [RUN_TOOLS, { tools: [{ name: 'count', implementationDigest: UNHELD_DIGEST, version: '1' }] }], [RUN_BARE, null],
  [RUN_INPUTS, { inputs: OTHER_INPUTS }],
]
const CONTRACT = {
  goal: 'count the words',
  inputs: ['words.txt'],
  criteria: [{ criterionId: 'counted', statement: 'the count is right', verifierRef: METER, verifierVersion: '1', implementationDigest: METER_DIGEST }],
}

/** The store's role table: the identity the log resolves each declared emitter role to. */
function subjectsWith(meterIdentity: string, boundsIdentity = BOUNDS_ACTOR): Readonly<Record<string, string>> {
  return {
    scheduler: SCHEDULER,
    [verifierRoleOf({ verifierRef: METER, verifierVersion: '1' })]: meterIdentity,
    [verifierRoleOf({ verifierRef: BOUNDS, verifierVersion: '1' })]: boundsIdentity,
  }
}

const live: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const entry of live.splice(0)) {
    await entry.context.fiber.dispose()
    await rm(entry.root, { recursive: true, force: true })
  }
})

interface Live { readonly store: ControlSessionStore; readonly measure: MeasureCommands }

/** One deployment: a task whose run declared a bubble, and the two implementations a plan may name. */
async function openLive(meterIdentity = METER_ACTOR, boundsIdentity = BOUNDS_ACTOR, storeSubjects = subjectsWith(meterIdentity, boundsIdentity)): Promise<Live> {
  const root = await mkdtemp(join(tmpdir(), 'measure-slice-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  live.push({ context, root })

  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareMeasureProtocol(registry)
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence,
    controlId: 'measure-slice',
    registry,
    subjects: storeSubjects,
  })
  const facts: readonly { readonly kind: string; readonly payload: unknown }[] = [
    { kind: TASK_KINDS.admitted, payload: { contract: CONTRACT } },
    { kind: TASK_KINDS.assigned, payload: { agentId: AGENT, agentIdentity: SCHEDULER } },
    ...RUNS.flatMap(([runId, manifest]) => [
      { kind: TASK_KINDS.runStarted, payload: { runId, revision: REVISION } },
      ...(manifest === null ? [] : [{ kind: TASK_KINDS.bubbleOpened, payload: bubbleOf(runId, manifest) }]),
    ]),
  ]
  for (const [index, fact] of facts.entries())
    await store.emit({ commandId: `fixture-${index}`, protocol: TASK_PROTOCOL, version: TASK_VERSION, subject: TASK, ...fact })
  const measure = createMeasureCommands({
    store,
    registry,
    implementations: [
      { ref: METER, version: '1', implementationDigest: METER_DIGEST },
      { ref: BOUNDS, version: '1', implementationDigest: BOUNDS_DIGEST },
    ],
  })
  return { store, measure }
}

const metric = (digest = METER_DIGEST): EvaluationMetric => ({
  measured: { criterionId: 'quality', statement: 'the artifact is good', verifierRef: METER, verifierVersion: '1', implementationDigest: digest },
  unit: 'points', direction: 'higher',
})

const bounds = (criterionId = 'limits'): AcceptanceCriterion => ({
  criterionId, statement: 'the artifact stays under 1 MiB', verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST,
})

interface PlanOverrides {
  readonly commandId?: string; readonly evaluationId?: string; readonly trials?: number
  readonly metric?: EvaluationMetric; readonly judgement?: readonly AcceptanceCriterion[]
  readonly weights?: EvaluationWeights; readonly run?: { readonly taskId: string; readonly runId: string }
  readonly baseline?: typeof REVISION; readonly candidate?: typeof REVISION
}

/** Open one plan through the command boundary. A repeated plan needs a fresh command id. */
async function plan(instance: Live, overrides: PlanOverrides = {}): Promise<void> {
  const evaluationId = overrides.evaluationId ?? EVALUATION
  await instance.measure.openEvaluation({
    commandId: overrides.commandId ?? `open-${evaluationId}`,
    evaluationId,
    baseline: overrides.baseline ?? REVISION,
    candidate: overrides.candidate ?? OTHER_REVISION,
    run: overrides.run ?? { taskId: TASK, runId: RUN },
    metric: overrides.metric ?? metric(),
    weights: overrides.weights ?? { quality: 1, cost: 0.5 },
    trials: overrides.trials ?? 2,
    judgement: overrides.judgement ?? [bounds()],
  })
}

let commandCounter = 0
const nextCommand = (): string => `cmd-${(commandCounter += 1)}`

const trial = (overrides: Partial<Parameters<MeasureCommands['recordTrial']>[0]['trial']> = {}) => ({
  slot: 0, quality: 1, artifactDigest: ARTIFACT, inputDigests: BUBBLE_INPUTS, implementationDigest: METER_DIGEST, ...overrides,
})

const record = (instance: Live, overrides = {}, evaluationId = EVALUATION) =>
  instance.measure.recordTrial({ commandId: nextCommand(), evaluationId, trial: trial(overrides) })

const check = (instance: Live, met: boolean, criterionId = 'limits', artifactDigest = ARTIFACT) =>
  instance.measure.checkConstraint({ commandId: nextCommand(), evaluationId: EVALUATION, criterionId, met, artifactDigest, implementationDigest: BOUNDS_DIGEST })

const directEmit = (instance: Live, kind: string, payload: unknown) =>
  instance.store.emit({ commandId: nextCommand(), protocol: MEASURE_PROTOCOL, version: MEASURE_VERSION, kind, subject: EVALUATION, payload })

function stateOf(instance: Live, evaluationId = EVALUATION): EvaluationState {
  const state = instance.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
  if (state === undefined) throw new Error(`evaluation "${evaluationId}" was never opened`)
  return state
}

describe('the measurement slice', () => {
  it('does not let a missing repetition fill the denominator, or an unobserved cost become zero', async () => {
    const instance = await openLive()
    await plan(instance)
    await record(instance, { slot: 0, quality: 1 })
    // The frozen counterexample: trials=2, one observation, answered quality=1, incomplete=true.
    const view = projectEvaluation(stateOf(instance))
    expect(view).toMatchObject({ denominator: 2, observed: 1, quality: 0.5, admissible: false, cost: null })
    expect(view.missing.map(entry => entry.slot)).toEqual([1])
    expect([view.why?.includes('hard constraint "limits"'), view.why?.includes('slot 1')]).toEqual([true, true])
    // A second repetition with a cost does not make the unknown one known.
    await record(instance, { slot: 1, quality: 1, cost: 4 })
    expect(projectEvaluation(stateOf(instance))).toMatchObject({ observed: 2, quality: 1, cost: null })
  })

  it('keeps a high quality out of the admissible set when a hard constraint is unmet', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 1 })
    await record(instance, { quality: 0.99, cost: 1 })
    expect(projectEvaluation(stateOf(instance)).admissible).toBe(false)
    await check(instance, false)
    const view = projectEvaluation(stateOf(instance))
    expect(view).toMatchObject({ constraints: [{ criterionId: 'limits', met: false }], admissible: false, quality: 0.99 })
    expect(view.why).toContain('not met')
  })

  it('reports an evaluation that was never opened as inadmissible rather than throwing', async () => {
    const unopened: EvaluationState = { evaluationId: 'never-opened', observed: [], missed: [], checks: [] }
    const view = projectEvaluation(unopened)
    expect(view).toMatchObject({ denominator: 0, observed: 0, admissible: false, why: expect.stringContaining('no measurement plan was opened') })
    expect([caliberOf(unopened), caliberDigestOf(unopened)]).toEqual([undefined, undefined])
  })

  it('is admissible only when every slot is observed and every constraint is met', async () => {
    const instance = await openLive()
    await plan(instance)
    await record(instance, { slot: 0, quality: 0.5, cost: 3 })
    await instance.measure.missTrial({ commandId: nextCommand(), evaluationId: EVALUATION, slot: 1, reason: 'the program timed out twice' })
    await check(instance, true)
    // A declared miss is still a slot without an observation, with its own reason.
    expect(projectEvaluation(stateOf(instance))).toMatchObject({
      missing: [{ slot: 1, reason: 'the program timed out twice' }],
      admissible: false,
      cost: 3,
      why: expect.stringContaining('the program timed out twice'),
    })
    await plan(instance, { commandId: 'open-second', evaluationId: OTHER, trials: 1, judgement: [] })
    await record(instance, { quality: 0.2, cost: 0 }, OTHER)
    expect(projectEvaluation(stateOf(instance, OTHER))).toMatchObject({ admissible: true, why: null, denominator: 1, quality: 0.2, cost: 0 })
  })

  it('refuses a slot outside the plan, and a second outcome for one slot', async () => {
    const instance = await openLive()
    await plan(instance)
    const outside = await asyncRefusalOf(() => record(instance, { slot: 2 }))
    expect(outside).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('slots 0..1') })
    await record(instance, { slot: 0, quality: 1 })
    const twice = await asyncRefusalOf(() => record(instance, { slot: 0, quality: 0.1 }))
    expect(twice).toMatchObject({ code: 'evidence-conflict', detail: expect.stringContaining('one slot carries one observation') })
    await instance.measure.missTrial({ commandId: nextCommand(), evaluationId: EVALUATION, slot: 1, reason: 'no number was produced' })
    const afterMiss = await asyncRefusalOf(() => record(instance, { slot: 1, quality: 0.9 }))
    expect(afterMiss).toMatchObject({ code: 'evidence-conflict', detail: expect.stringContaining('already declared missed') })
  })

  it("refuses a trial that is not from the metric's implementation", async () => {
    const instance = await openLive()
    await plan(instance)
    // Straight through the log under the other role: the plan fills the role, not the caller.
    const role = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: BOUNDS, verifierVersion: '1' }))
    expect(role).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining('was emitted by verifier:bounds@1') })
    // The metric's own role, but not the bytes the metric names: the fold refuses that too.
    const content = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST }))
    expect(content).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining(BOUNDS_DIGEST.slice(0, 12)) })
    const digest = await asyncRefusalOf(() => record(instance, { implementationDigest: BOUNDS_DIGEST }))
    expect(digest).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining(BOUNDS_DIGEST.slice(0, 12)) })
    const unheld = await openLive()
    await plan(unheld, { trials: 1, metric: metric(UNHELD_DIGEST) })
    const notHeld = await asyncRefusalOf(() => record(unheld, { implementationDigest: UNHELD_DIGEST }))
    expect(notHeld).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining(UNHELD_DIGEST.slice(0, 12)) })
  })

  it('refuses inputs that are not the run declaration, and the executor as the reporter', async () => {
    const instance = await openLive()
    await plan(instance)
    const foreign = await asyncRefusalOf(() => record(instance, { inputDigests: [{ name: 'words.txt', digest: '9'.repeat(64) }] }))
    expect(foreign).toMatchObject({ code: 'evidence-input-mismatch', detail: expect.stringContaining('words.txt') })
    // The metric's role bound to the identity that ran the work: self-reported by construction.
    const selfReporting = await openLive(SCHEDULER)
    await plan(selfReporting)
    const refusal = await asyncRefusalOf(() => record(selfReporting))
    expect(refusal).toMatchObject({ code: 'self-reported-evidence', detail: expect.stringContaining(SCHEDULER) })
    const missByExecutor = await asyncRefusalOf(() => selfReporting.measure.missTrial({ commandId: nextCommand(), evaluationId: EVALUATION, slot: 0, reason: 'the executor says so' }))
    expect(missByExecutor.code).toBe('self-reported-evidence')
    // The fact that decides admissibility carries the rule too: "out of bounds is refused" must not
    // become "…unless the candidate checks itself".
    const certifying = await openLive(METER_ACTOR, SCHEDULER)
    await plan(certifying)
    const ownConstraint = await asyncRefusalOf(() => check(certifying, true))
    expect(ownConstraint.code).toBe('self-reported-evidence')
  })

  it("refuses a self-reported trial from the identity the store stamps, with no table to supply", async () => {
    // The review's A/B, against the shape that makes it hold: the service gets only the store.
    const attack = await openLive(SCHEDULER)
    await plan(attack)
    expect((await asyncRefusalOf(() => record(attack))).code).toBe('self-reported-evidence')
  })

  it('cannot be made to pass by a deployment table that leaves the role out', async () => {
    // The other half: with one table, an incomplete copy is unrepresentable and records nothing.
    const instance = await openLive(METER_ACTOR, BOUNDS_ACTOR, { scheduler: SCHEDULER })
    await plan(instance)
    expect((await asyncRefusalOf(() => record(instance))).code).toBe('unknown-emitter-role')
  })

  it('refuses a plan with no run, no context or an old version, a trial before a plan, a second plan, an undeclared member', async () => {
    const instance = await openLive()
    const noRun = await asyncRefusalOf(() => plan(instance, { run: { taskId: TASK, runId: 'run-never-started' } }))
    expect(noRun.code).toBe('unknown-run')
    const noContext = await asyncRefusalOf(() => plan(instance, { commandId: 'open-bare', run: { taskId: TASK, runId: RUN_BARE } }))
    expect(noContext).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('has not declared an execution context') })
    const oldVersion = await asyncRefusalOf(() => instance.store.emit({ commandId: nextCommand(), protocol: MEASURE_PROTOCOL, version: 1, kind: MEASURE_KINDS.evaluationOpened, subject: EVALUATION, payload: {} }))
    expect(oldVersion).toMatchObject({ code: 'version-mismatch', detail: expect.stringContaining(`declared at ${MEASURE_VERSION}`) })
    const beforePlan = await asyncRefusalOf(() => record(instance))
    expect(beforePlan).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('no measurement plan is open') })
    const unplanned = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1' }))
    expect(unplanned).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('carried a measurement plan') })
    await plan(instance)
    const twice = await asyncRefusalOf(() => plan(instance, { commandId: 'open-again' }))
    expect(twice).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('second measurement plan') })
    // An undeclared member, a wrong type and a non-digest are each refused by the fold.
    const extra = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', confidence: 0.9 }))
    expect(extra).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('confidence') })
    const wrongType = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', quality: '1' }))
    expect(wrongType.code).toBe('malformed-payload')
    const shortDigest = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', artifactDigest: 'short' }))
    expect(shortDigest.code).toBe('malformed-payload')
    // The trial's inputs are closed by the set the declaration names and hands to `inputList`, not by a
    // copy in the reader: one more member in an input entry is refused by name.
    const widenedInput = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', inputDigests: [{ ...BUBBLE_INPUTS[0], note: 'extra' }] }))
    expect(widenedInput).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('note') })
    // The plan's three shape members, each closed by the set the declaration hands its reader.
    const opened = { baseline: REVISION, candidate: OTHER_REVISION, run: { taskId: TASK, runId: RUN }, metric: metric(), weights: { quality: 1, cost: 0.5 }, context: digestOf(BUBBLE), trials: 2, judgement: [bounds()] }
    for (const widened of [{ metric: { ...metric(), note: 'x' } }, { weights: { quality: 1, cost: 0.5, note: 'x' } }, { run: { taskId: TASK, runId: RUN, note: 'x' } }])
      expect(await asyncRefusalOf(() => instance.store.emit({ commandId: nextCommand(), protocol: MEASURE_PROTOCOL, version: MEASURE_VERSION, kind: MEASURE_KINDS.evaluationOpened, subject: OTHER, payload: { ...opened, ...widened } }))).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('note') })
  })

  it('refuses a plan that judges its own metric, repeats a criterion, or has no slots or quality weight', async () => {
    const instance = await openLive()
    const sameId = await asyncRefusalOf(() => plan(instance, { judgement: [bounds('quality')] }))
    expect(sameId).toMatchObject({ code: 'malformed-contract', detail: expect.stringContaining('quality') })
    const repeated = await asyncRefusalOf(() => plan(instance, { judgement: [bounds(), bounds()] }))
    expect(repeated).toMatchObject({ code: 'malformed-contract', detail: expect.stringContaining('twice') })
    const noSlots = await asyncRefusalOf(() => plan(instance, { trials: 0 }))
    expect(noSlots).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('>= 1') })
    const noQuality = await asyncRefusalOf(() => plan(instance, { weights: { quality: 0, cost: 1 }, trials: 1, judgement: [] }))
    expect(noQuality).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('quality') })
  })

  it('refuses a constraint this evaluation does not judge, and checking one twice', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 1 })
    const unknown = await asyncRefusalOf(() => check(instance, true, 'not-judged'))
    expect(unknown).toMatchObject({ code: 'unknown-criterion', detail: expect.stringContaining('cannot check hard constraint') })
    // Straight through the log: an unjudged constraint and a non-boolean decision are refused.
    const undeclared = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.constraintChecked, { criterionId: 'not-judged', met: true, artifactDigest: ARTIFACT, verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST }))
    expect(undeclared.code).toBe('unknown-criterion')
    const unboolean = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.constraintChecked, { criterionId: 'limits', met: 'yes', artifactDigest: ARTIFACT, verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST }))
    expect(unboolean.code).toBe('malformed-payload')
    const foreignArtifact = await asyncRefusalOf(() => check(instance, true, 'limits', '9'.repeat(64)))
    expect(foreignArtifact).toMatchObject({ code: 'evidence-input-mismatch', detail: expect.stringContaining('no observation of this evaluation was formed on') })
    await record(instance)
    // A cited verdict is about the bytes this evaluation measured, or it is a citation of something else.
    const citedElsewhere = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.constraintChecked, {
      criterionId: 'limits', met: true, artifactDigest: ARTIFACT, verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST,
      verdict: { criterionId: 'quality', evidenceDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64) },
    }))
    expect(citedElsewhere).toMatchObject({ code: 'evidence-input-mismatch', detail: expect.stringContaining('cites verdict') })
    await check(instance, true)
    const twice = await asyncRefusalOf(() => check(instance, true))
    expect(twice).toMatchObject({ code: 'evidence-conflict', detail: expect.stringContaining('once') })
  })

  it('fills the implementation identity from the frozen plan, and compares evaluations by settings', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 1 })
    const envelope = await record(instance)
    await check(instance, true)
    // Each fact carries the identity the plan froze, not one a caller named.
    expect(envelope.payload).toMatchObject({ verifierRef: METER, verifierVersion: '1', implementationDigest: METER_DIGEST, inputDigests: BUBBLE_INPUTS })
    expect(stateOf(instance).checks[0]).toMatchObject({ verifierRef: BOUNDS, implementationDigest: BOUNDS_DIGEST })
  })

  it('takes comparability over the declared execution context, not over the run', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 2 })
    // Filled from the run's own bubble: a caller cannot declare its own context.
    expect(stateOf(instance).context).toBe(digestOf({ model: BUBBLE.model, tools: BUBBLE.tools, conditions: BUBBLE.conditions, inputs: BUBBLE_INPUTS }))
    const first = caliberDigestOf(stateOf(instance))
    await plan(instance, { commandId: 'open-mirrored', evaluationId: OTHER, trials: 2, baseline: OTHER_REVISION, candidate: REVISION })
    expect(caliberDigestOf(stateOf(instance, OTHER))).toBe(first)
    // A second candidate in its own run under the same manifest is comparable.
    await plan(instance, { commandId: 'open-same', evaluationId: THIRD, trials: 2, run: { taskId: TASK, runId: RUN_SAME } })
    expect(caliberDigestOf(stateOf(instance, THIRD))).toBe(first)
    // Another model, then a rebuilt tool behind the same name: each is another context.
    await plan(instance, { commandId: 'open-model', evaluationId: FOURTH, trials: 2, run: { taskId: TASK, runId: RUN_MODEL } })
    expect(caliberDigestOf(stateOf(instance, FOURTH))).not.toBe(first)
    await plan(instance, { commandId: 'open-tools', evaluationId: FIFTH, trials: 2, run: { taskId: TASK, runId: RUN_TOOLS } })
    expect(caliberDigestOf(stateOf(instance, FIFTH))).not.toBe(first)
    // The dataset is part of the question: other inputs, another caliber, so no pooling.
    await plan(instance, { commandId: 'open-inputs', evaluationId: SEVENTH, trials: 2, run: { taskId: TASK, runId: RUN_INPUTS } })
    expect(caliberDigestOf(stateOf(instance, SEVENTH))).not.toBe(first)
    await plan(instance, { commandId: 'open-trials', evaluationId: SIXTH, trials: 3 })
    expect(caliberDigestOf(stateOf(instance, SIXTH))).not.toBe(first)
  })
})

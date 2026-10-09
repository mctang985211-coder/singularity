/**
 * The measurement slice, driven through its own command boundary over a real control store.
 *
 * The subject is what the facts mean: the denominator is the plan's, an unknown cost stays unknown, a
 * hard constraint is not a number, and every cross-subject precondition refuses by name. Facts only a
 * reducer can refuse are emitted straight into the log — the fold is the authority. Real programs and
 * real processes are `measure-execution.spec.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore } from '../src/control/session-store.ts'
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
import { caliberDigestOf, caliberOf, projectEvaluation, type Caliber } from '../src/measure/view.ts'
import { asyncRefusalOf } from './fixtures.ts'

const TASK = 'task-measured'
const RUN = 'run-1'
const AGENT = 'agent-1'
const EVALUATION = 'eval-1'
const OTHER = 'eval-2'
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
const CONTRACT = {
  goal: 'count the words',
  inputs: ['words.txt'],
  criteria: [{ criterionId: 'counted', statement: 'the count is right', verifierRef: METER, verifierVersion: '1', implementationDigest: METER_DIGEST }],
}

/** The deployment's role table: the identity the log resolves each declared emitter role to. */
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

interface Live {
  readonly store: ControlSessionStore
  readonly measure: MeasureCommands
}

/** One deployment: a task whose run declared a bubble, and the two implementations a plan may name. */
async function openLive(meterIdentity = METER_ACTOR, boundsIdentity = BOUNDS_ACTOR): Promise<Live> {
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
    subjects: subjectsWith(meterIdentity),
  })
  const facts: readonly { readonly kind: string; readonly payload: unknown }[] = [
    { kind: TASK_KINDS.admitted, payload: { contract: CONTRACT } },
    { kind: TASK_KINDS.assigned, payload: { agentId: AGENT, agentIdentity: SCHEDULER } },
    { kind: TASK_KINDS.runStarted, payload: { runId: RUN, revision: REVISION } },
    {
      kind: TASK_KINDS.bubbleOpened,
      payload: {
        runId: RUN,
        inputs: BUBBLE_INPUTS,
        workspace: { kind: 'dir', ref: '/tmp/workspace' },
        model: 'model-1',
        tools: [{ name: 'count', implementationDigest: METER_DIGEST, version: '1' }],
        conditions: ['no-network'],
      },
    },
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
    subjects: subjectsWith(meterIdentity, boundsIdentity),
  })
  return { store, measure }
}

const metric = (digest = METER_DIGEST): EvaluationMetric => ({
  measured: { criterionId: 'quality', statement: 'the artifact is good', verifierRef: METER, verifierVersion: '1', implementationDigest: digest },
  unit: 'points',
  direction: 'higher',
})

const bounds = (criterionId = 'limits'): AcceptanceCriterion => ({
  criterionId,
  statement: 'the artifact stays under 1 MiB',
  verifierRef: BOUNDS,
  verifierVersion: '1',
  implementationDigest: BOUNDS_DIGEST,
})

interface PlanOverrides {
  readonly commandId?: string
  readonly evaluationId?: string
  readonly trials?: number
  readonly metric?: EvaluationMetric
  readonly judgement?: readonly AcceptanceCriterion[]
  readonly weights?: EvaluationWeights
  readonly run?: { readonly taskId: string; readonly runId: string }
  readonly baseline?: typeof REVISION
  readonly candidate?: typeof REVISION
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
  slot: 0,
  quality: 1,
  artifactDigest: ARTIFACT,
  inputDigests: BUBBLE_INPUTS,
  implementationDigest: METER_DIGEST,
  ...overrides,
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
    // The frozen counterexample: trials=2 with one observation answered quality=1, incomplete=true.
    const view = projectEvaluation(stateOf(instance))
    expect(view.denominator).toBe(2)
    expect(view.observed).toBe(1)
    expect(view.quality).toBe(0.5)
    expect(view.missing.map(entry => entry.slot)).toEqual([1])
    expect(view.admissible).toBe(false)
    expect(view.why).toContain('slot 1')
    expect(view.why).toContain('hard constraint "limits"')
    // One repetition reported no cost, so the total is unknown — 0 would be an invented measurement.
    expect(view.cost).toBeNull()
    await record(instance, { slot: 1, quality: 1, cost: 4 })
    // The second repetition reported a cost and the first did not: the total stays unknown, because
    // a sum over a term nobody observed is not a measurement.
    expect(projectEvaluation(stateOf(instance))).toMatchObject({ observed: 2, quality: 1, cost: null })
  })

  it('keeps a high quality out of the admissible set when a hard constraint is unmet', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 1 })
    await record(instance, { quality: 0.99, cost: 1 })
    expect(projectEvaluation(stateOf(instance)).admissible).toBe(false)
    await check(instance, false)
    const view = projectEvaluation(stateOf(instance))
    expect(view.constraints).toEqual([{ criterionId: 'limits', met: false }])
    expect(view.admissible).toBe(false)
    expect(view.why).toContain('not met')
    expect(view.quality).toBe(0.99)
  })

  it('reports an evaluation that was never opened as inadmissible rather than throwing', async () => {
    const unopened: EvaluationState = { evaluationId: 'never-opened', observed: [], missed: [], checks: [] }
    const view = projectEvaluation(unopened)
    expect(view).toMatchObject({ denominator: 0, observed: 0, admissible: false })
    expect(view.why).toContain('no measurement plan was opened')
    const caliber: Caliber | undefined = caliberOf(unopened)
    expect(caliber).toBeUndefined()
    expect(caliberDigestOf(unopened)).toBeUndefined()
  })

  it('is admissible only when every slot is observed and every constraint is met', async () => {
    const instance = await openLive()
    await plan(instance)
    await record(instance, { slot: 0, quality: 0.5, cost: 3 })
    await instance.measure.missTrial({ commandId: nextCommand(), evaluationId: EVALUATION, slot: 1, reason: 'the program timed out twice' })
    await check(instance, true)
    // A declared miss is still a slot without an observation, and it carries its own reason.
    const incomplete = projectEvaluation(stateOf(instance))
    expect(incomplete.missing).toEqual([{ slot: 1, reason: 'the program timed out twice' }])
    expect(incomplete.admissible).toBe(false)
    expect(incomplete.why).toContain('the program timed out twice')
    // Every observation reported a cost, so the total is the one that was measured.
    expect(incomplete.cost).toBe(3)
    await plan(instance, { commandId: 'open-second', evaluationId: OTHER, trials: 1, judgement: [] })
    await record(instance, { quality: 0.2, cost: 0 }, OTHER)
    expect(projectEvaluation(stateOf(instance, OTHER))).toMatchObject({ admissible: true, why: null, denominator: 1, quality: 0.2, cost: 0 })
  })

  it('refuses a slot outside the plan, and a second outcome for one slot', async () => {
    const instance = await openLive()
    await plan(instance)
    const outside = await asyncRefusalOf(() => record(instance, { slot: 2 }))
    expect(outside.code).toBe('illegal-transition')
    expect(outside.detail).toContain('slots 0..1')
    await record(instance, { slot: 0, quality: 1 })
    const twice = await asyncRefusalOf(() => record(instance, { slot: 0, quality: 0.1 }))
    expect(twice.code).toBe('evidence-conflict')
    expect(twice.detail).toContain('one slot carries one observation')
    await instance.measure.missTrial({ commandId: nextCommand(), evaluationId: EVALUATION, slot: 1, reason: 'no number was produced' })
    const afterMiss = await asyncRefusalOf(() => record(instance, { slot: 1, quality: 0.9 }))
    expect(afterMiss.code).toBe('evidence-conflict')
    expect(afterMiss.detail).toContain('already declared missed')
  })

  it("refuses a trial that is not from the metric's implementation", async () => {
    const instance = await openLive()
    await plan(instance)
    // Emitted straight through the log under the other held implementation's role: the command
    // fills the role from the plan, so only a caller talking around it can produce this.
    // Only the role differs here — the digest is still the metric's — so this pins the emitter rule.
    const role = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: BOUNDS, verifierVersion: '1' }))
    expect(role.code).toBe('wrong-verifier')
    expect(role.detail).toContain('was emitted by verifier:bounds@1')
    // The metric's own role, but not the bytes the metric names: the fold refuses that too.
    const content = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST }))
    expect(content.code).toBe('wrong-verifier')
    expect(content.detail).toContain(BOUNDS_DIGEST.slice(0, 12))
    const digest = await asyncRefusalOf(() => record(instance, { implementationDigest: BOUNDS_DIGEST }))
    expect(digest.code).toBe('wrong-verifier')
    expect(digest.detail).toContain(BOUNDS_DIGEST.slice(0, 12))
    const unheld = await openLive()
    await plan(unheld, { trials: 1, metric: metric(UNHELD_DIGEST) })
    const notHeld = await asyncRefusalOf(() => record(unheld, { implementationDigest: UNHELD_DIGEST }))
    expect(notHeld.code).toBe('unregistered-verifier')
    expect(notHeld.detail).toContain(UNHELD_DIGEST.slice(0, 12))
  })

  it('refuses inputs that are not the run declaration, and the executor as the reporter', async () => {
    const instance = await openLive()
    await plan(instance)
    const foreign = await asyncRefusalOf(() => record(instance, { inputDigests: [{ name: 'words.txt', digest: '9'.repeat(64) }] }))
    expect(foreign.code).toBe('evidence-input-mismatch')
    expect(foreign.detail).toContain('words.txt')
    // A deployment that binds the metric's role to the identity that ran the work: the log would
    // stamp the run's own actor, so the numbers would be self-reported.
    const selfReporting = await openLive(SCHEDULER)
    await plan(selfReporting)
    const refusal = await asyncRefusalOf(() => record(selfReporting))
    expect(refusal.code).toBe('self-reported-evidence')
    expect(refusal.detail).toContain(SCHEDULER)
    const missByExecutor = await asyncRefusalOf(() => selfReporting.measure.missTrial({ commandId: nextCommand(), evaluationId: EVALUATION, slot: 0, reason: 'the executor says so' }))
    expect(missByExecutor.code).toBe('self-reported-evidence')
    // The fact that decides admissibility carries the same rule: a candidate that ran the work may
    // not certify its own constraints, or "out of bounds is refused" becomes "…unless it checks".
    const certifying = await openLive(METER_ACTOR, SCHEDULER)
    await plan(certifying)
    const ownConstraint = await asyncRefusalOf(() => check(certifying, true))
    expect(ownConstraint.code).toBe('self-reported-evidence')
  })

  it('refuses a plan whose run does not exist, a trial before a plan, a second plan, an undeclared member', async () => {
    const instance = await openLive()
    const noRun = await asyncRefusalOf(() => plan(instance, { run: { taskId: TASK, runId: 'run-never-started' } }))
    expect(noRun.code).toBe('unknown-run')
    const beforePlan = await asyncRefusalOf(() => record(instance))
    expect(beforePlan.code).toBe('illegal-transition')
    expect(beforePlan.detail).toContain('no measurement plan is open')
    // Straight through the log, the fold is the authority: no plan is open for this evaluation.
    const unplanned = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1' }))
    expect(unplanned.code).toBe('illegal-transition')
    expect(unplanned.detail).toContain('carried a measurement plan')
    await plan(instance)
    const twice = await asyncRefusalOf(() => plan(instance, { commandId: 'open-again' }))
    expect(twice.code).toBe('illegal-transition')
    expect(twice.detail).toContain('second measurement plan')
    const extra = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', confidence: 0.9 }))
    expect(extra.code).toBe('malformed-payload')
    expect(extra.detail).toContain('confidence')

    const wrongType = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', quality: '1' }))
    expect(wrongType.code).toBe('malformed-payload')
    const shortDigest = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.trialRecorded, { ...trial(), verifierRef: METER, verifierVersion: '1', artifactDigest: 'short' }))
    expect(shortDigest.code).toBe('malformed-payload')
  })

  it('refuses a plan that judges its own metric, repeats a criterion, or has no slots or quality weight', async () => {
    const instance = await openLive()
    const sameId = await asyncRefusalOf(() => plan(instance, { judgement: [bounds('quality')] }))
    expect(sameId.code).toBe('malformed-contract')
    expect(sameId.detail).toContain('quality')
    const repeated = await asyncRefusalOf(() => plan(instance, { judgement: [bounds(), bounds()] }))
    expect(repeated.code).toBe('malformed-contract')
    expect(repeated.detail).toContain('twice')
    const noSlots = await asyncRefusalOf(() => plan(instance, { trials: 0 }))
    expect(noSlots.code).toBe('malformed-payload')
    expect(noSlots.detail).toContain('>= 1')
    const noQuality = await asyncRefusalOf(() => plan(instance, { weights: { quality: 0, cost: 1 }, trials: 1, judgement: [] }))
    expect(noQuality.code).toBe('malformed-payload')
    expect(noQuality.detail).toContain('quality')
  })

  it('refuses a constraint this evaluation does not judge, and checking one twice', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 1 })
    const unknown = await asyncRefusalOf(() => check(instance, true, 'not-judged'))
    expect(unknown.code).toBe('unknown-criterion')
    expect(unknown.detail).toContain('cannot check hard constraint')
    // Straight through the log: the fold refuses a constraint the plan does not judge, and a
    // decision that is not a boolean.
    const undeclared = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.constraintChecked, { criterionId: 'not-judged', met: true, artifactDigest: ARTIFACT, verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST }))
    expect(undeclared.code).toBe('unknown-criterion')
    const unboolean = await asyncRefusalOf(() => directEmit(instance, MEASURE_KINDS.constraintChecked, { criterionId: 'limits', met: 'yes', artifactDigest: ARTIFACT, verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: BOUNDS_DIGEST }))
    expect(unboolean.code).toBe('malformed-payload')
    const foreignArtifact = await asyncRefusalOf(() => check(instance, true, 'limits', '9'.repeat(64)))
    expect(foreignArtifact.code).toBe('evidence-input-mismatch')
    expect(foreignArtifact.detail).toContain('no observation of this evaluation was formed on')
    await record(instance)
    await check(instance, true)
    const twice = await asyncRefusalOf(() => check(instance, true))
    expect(twice.code).toBe('evidence-conflict')
    expect(twice.detail).toContain('once')
  })

  it('fills the implementation identity from the frozen plan, and compares evaluations by settings', async () => {
    const instance = await openLive()
    await plan(instance, { trials: 1 })
    const envelope = await record(instance)
    await check(instance, true)
    expect(envelope.payload).toMatchObject({ verifierRef: METER, verifierVersion: '1', implementationDigest: METER_DIGEST, inputDigests: BUBBLE_INPUTS })
    expect(stateOf(instance).checks[0]).toMatchObject({ verifierRef: BOUNDS, implementationDigest: BOUNDS_DIGEST })
    const first = caliberDigestOf(stateOf(instance))
    await plan(instance, { commandId: 'open-second', evaluationId: OTHER, trials: 1, baseline: OTHER_REVISION, candidate: REVISION })
    expect(first).toBeDefined()
    expect(caliberDigestOf(stateOf(instance, OTHER))).toBe(first)
    const recalibrated = await openLive()
    await plan(recalibrated, { trials: 3 })
    expect(caliberDigestOf(stateOf(recalibrated))).not.toBe(first)
  })
})

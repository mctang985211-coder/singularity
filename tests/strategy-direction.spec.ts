/**
 * The round's direction is the **measurement's**, not the plan's.
 *
 * The review's executed counterexample, kept as a test: a real `measure@3` evaluation declaring
 * `lower` (an error rate, where the *smaller* number is better) pooled by a round whose plan declared
 * `higher` — both legal, neither compared, and a real `round/decided` elected the candidate the
 * measurement's own metric calls worse. A round pools only candidates answering one caliber (§5.4),
 * and a caliber contains the metric, so the pooled direction is one value by construction.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore, type ControlReadCut } from '../src/control/session-store.ts'
import type { Envelope } from '../src/protocol/envelope.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { SCHEDULER_ROLE, verifierRoleOf, type RevisionRef } from '../src/task/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../src/measure/view.ts'
import {
  declareMeasureProtocol,
  MEASURE_KINDS,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type EvaluationState,
} from '../src/measure/protocol.ts'
import { createStrategyCommands, type StrategyCommands } from '../src/strategy/commands.ts'
import type { Calibration } from '../src/strategy/decision.ts'
import {
  declareStrategyProtocol,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_ROLE,
  STRATEGY_VERSION,
  type RoundState,
} from '../src/strategy/protocol.ts'
import { projectRound, type MeasureSlice, type RoundEvaluation } from '../src/strategy/view.ts'
import { asyncRefusalOf } from './fixtures.ts'

const METER = 'meter'
const METER_DIGEST = 'a'.repeat(64)
const ARTIFACT = 'd'.repeat(64)
const CONTEXT = 'c'.repeat(64)
const SUBJECTS: Readonly<Record<string, string>> = {
  [SCHEDULER_ROLE]: 'scheduler-service',
  [STRATEGY_ROLE]: 'strategy-service',
  [verifierRoleOf({ verifierRef: METER, verifierVersion: '1' })]: 'meter-service',
}
const INCUMBENT_QUALITY = 0.9
const WEIGHTS = { quality: 100, cost: 15 }
const rev = (revisionId: string, seed: string): RevisionRef => ({
  environmentId: 'library-1',
  revisionId,
  digest: seed.repeat(64),
})
const INCUMBENT = rev('r0001', 'a')
const CANDIDATE_A = rev('r0002', 'b')
const CANDIDATE_B = rev('r0003', 'c')
/** One round's noise basis, wide enough that the floor is not what these tests are about. */
const CALIBRATION: Calibration = { floor: 0.2, source: 'measured' }
let counter = 0
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`

/** The metric this deployment measures under: the review's error rate, smaller is better. */
const errorRate = (direction: 'higher' | 'lower') => ({
  measured: {
    criterionId: 'error-rate',
    statement: 'the error rate of the selection',
    verifierRef: METER,
    verifierVersion: '1',
    implementationDigest: METER_DIGEST,
  },
  unit: 'ratio',
  direction,
})

const live: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const entry of live.splice(0)) {
    await entry.context.fiber.dispose()
    await rm(entry.root, { recursive: true, force: true })
  }
})

interface Live {
  readonly store: ControlSessionStore
  readonly commands: StrategyCommands
}

/** One deployment: a store of real `measure@3` facts and the round commands that read them. */
async function deployment(): Promise<Live> {
  const root = await mkdtemp(join(tmpdir(), 'strategy-direction-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  live.push({ context, root })
  const registry = new ProtocolRegistry()
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence,
    controlId: 'direction',
    registry,
    subjects: SUBJECTS,
  })
  return { store, commands: createStrategyCommands({ store, calibration: CALIBRATION, measuresAt: sliceOf }) }
}

/** The measure slice as one round reads it: the real projection, at the cut it is handed. */
function sliceOf(cut: ControlReadCut): MeasureSlice {
  return {
    entries: cut.entries(),
    evaluationOf: evaluationId => {
      const state = cut.stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
      if (state === undefined || state.baseline === undefined || state.candidate === undefined) return undefined
      const caliberDigest = caliberDigestOf(state)
      if (caliberDigest === undefined) return undefined
      return {
        evaluationId,
        caliberDigest,
        baseline: state.baseline,
        candidate: state.candidate,
        ...projectEvaluation(state),
      } satisfies RoundEvaluation
    },
    incumbentBelow: (_revision, cutoff) => (cutoff > 0 ? { quality: INCUMBENT_QUALITY, cost: 10 } : null),
  }
}

const measureStateOf = (store: ControlSessionStore, evaluationId: string): EvaluationState => {
  const state = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
  if (state === undefined) throw new Error(`evaluation "${evaluationId}" was never opened`)
  return state
}
const roundStateOf = (store: ControlSessionStore, roundId: string): RoundState => {
  const state = store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)
  if (state === undefined) throw new Error(`round "${roundId}" was never opened`)
  return state
}
const winnerOf = (envelope: Envelope): number | null => (envelope.payload as { winner: number | null }).winner

/** Open one real evaluation, straight into the log: these tests are about the round. */
const openEvaluation = (
  live: Live,
  evaluationId: string,
  candidate: RevisionRef,
  direction: 'higher' | 'lower',
): Promise<Envelope> =>
  live.store.emit({
    commandId: nextId('open-eval'),
    protocol: MEASURE_PROTOCOL,
    version: MEASURE_VERSION,
    kind: MEASURE_KINDS.evaluationOpened,
    subject: evaluationId,
    payload: {
      baseline: INCUMBENT,
      candidate,
      run: { taskId: 'task-1', runId: `run-${evaluationId}` },
      context: CONTEXT,
      metric: errorRate(direction),
      weights: WEIGHTS,
      trials: 1,
      judgement: [],
    },
  })
const recordTrial = (live: Live, evaluationId: string, quality: number): Promise<Envelope> =>
  live.store.emit({
    commandId: nextId('trial'),
    protocol: MEASURE_PROTOCOL,
    version: MEASURE_VERSION,
    kind: MEASURE_KINDS.trialRecorded,
    subject: evaluationId,
    payload: {
      slot: 0,
      quality,
      cost: 10,
      artifactDigest: ARTIFACT,
      inputDigests: [],
      verifierRef: METER,
      verifierVersion: '1',
      implementationDigest: METER_DIGEST,
    },
  })

/** One round over the measured candidates, against the incumbent and the round's own caliber. */
async function round(instance: Live, sides: readonly (readonly [string, RevisionRef])[]): Promise<void> {
  const first = sides[0]
  if (first === undefined) throw new Error('a round needs at least one measured candidate')
  const caliber = caliberDigestOf(measureStateOf(instance.store, first[0]))
  if (caliber === undefined) throw new Error(`the measurement "${first[0]}" carries no caliber`)
  await instance.commands.openRound({
    campaignId: 'test-campaign',
    commandId: nextId('open'),
    roundId: 'round-1',
    round: 1,
    incumbent: INCUMBENT,
    candidates: sides.length,
    historyCutoff: instance.store.load().entries().length,
    caliber,
    weights: WEIGHTS,
  })
  for (const [slot, [evaluationId, revision]] of sides.entries())
    await instance.commands.submitCandidate({
      commandId: nextId('submit'),
      roundId: 'round-1',
      slot,
      revision,
      evaluationId,
      edits: [{ asset: 'skill', target: 'count' }],
    })
}

describe("the direction a round ranks in is the measurement's own", () => {
  it('elects the smaller error rate when the measurement declares "lower"', async () => {
    // 0.85 is the better error rate, 0.95 the worse: a round reading its own direction elected 1.
    const instance = await deployment()
    await openEvaluation(instance, 'e-better', CANDIDATE_A, 'lower')
    await recordTrial(instance, 'e-better', 0.85)
    await openEvaluation(instance, 'e-worse', CANDIDATE_B, 'lower')
    await recordTrial(instance, 'e-worse', 0.95)
    await round(instance, [
      ['e-better', CANDIDATE_A],
      ['e-worse', CANDIDATE_B],
    ])
    expect(winnerOf(await instance.commands.decideRound({ commandId: nextId('decide'), roundId: 'round-1' }))).toBe(0)
  })

  it('excludes a measurement with another direction without failing the round', async () => {
    const instance = await deployment()
    await openEvaluation(instance, 'e-lower', CANDIDATE_A, 'lower')
    await recordTrial(instance, 'e-lower', 0.85)
    await openEvaluation(instance, 'e-higher', CANDIDATE_B, 'higher')
    await recordTrial(instance, 'e-higher', 0.95)
    await round(instance, [
      ['e-lower', CANDIDATE_A],
      ['e-higher', CANDIDATE_B],
    ])
    const decision = await instance.commands.decideRound({ commandId: nextId('decide'), roundId: 'round-1' })
    expect(winnerOf(decision)).toBe(0)
    expect((decision.payload as { outcomes: { admitted: boolean; reason: string }[] }).outcomes[1]).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('measured under caliber'),
    })
  })

  it('has no member for a round to declare a direction of its own in', async () => {
    // The shape is the guarantee: a plan carrying a direction is refused by the closed payload.
    const instance = await deployment()
    const refusal = await asyncRefusalOf(() =>
      instance.store.emit({
        commandId: nextId('open'),
        protocol: STRATEGY_PROTOCOL,
        version: STRATEGY_VERSION,
        kind: STRATEGY_KINDS.roundOpened,
        subject: 'round-1',
        payload: {
          round: 1,
          incumbent: INCUMBENT,
          candidates: 1,
          historyCutoff: 0,
          caliber: 'f'.repeat(64),
          metric: { direction: 'higher' },
          weights: WEIGHTS,
        },
      }),
    )
    expect(refusal.code).toBe('malformed-payload')
  })

  it('refuses a measurement whose direction is unstated rather than reading one into it', async () => {
    // `null` is what an unopened plan projects, and an untyped caller can leave the member out.
    const instance = await deployment()
    await openEvaluation(instance, 'e-lower', CANDIDATE_A, 'lower')
    await recordTrial(instance, 'e-lower', 0.85)
    await round(instance, [['e-lower', CANDIDATE_A]])
    const slice = sliceOf(instance.store.load())
    const nameless: MeasureSlice = {
      ...slice,
      evaluationOf: id => {
        const found = slice.evaluationOf(id)
        return found === undefined ? undefined : { ...found, direction: null }
      },
    }
    expect(projectRound(roundStateOf(instance.store, 'round-1'), nameless, CALIBRATION).slots[0]?.reason).toContain(
      'does not declare a usable direction',
    )
  })

  it('names the floor it applied under "lower", not the incumbent less the band', async () => {
    // Incumbent 0.9, band 0.05 under `lower`: admissible up to 0.95, so 1.05 sits 0.1 above the
    // floor. The old message reported the incumbent *less* the band, 0.85.
    const instance = await deployment()
    await openEvaluation(instance, 'e-out', CANDIDATE_A, 'lower')
    await recordTrial(instance, 'e-out', 1.05)
    await openEvaluation(instance, 'e-in', CANDIDATE_B, 'lower')
    await recordTrial(instance, 'e-in', 0.9)
    await round(instance, [
      ['e-out', CANDIDATE_A],
      ['e-in', CANDIDATE_B],
    ])
    const decision = projectRound(roundStateOf(instance.store, 'round-1'), sliceOf(instance.store.load()), {
      floor: 0.05,
      source: 'measured',
    })
    const reason = decision.slots[0]?.reason ?? ''
    const clause = 'a cost saving does not buy a quality above the floor'
    expect([reason.includes('floor 0.9500'), reason.includes('sits 0.1000 above'), reason.includes(clause)]).toEqual([
      true,
      true,
      true,
    ])
  })

  it('refuses an in-band candidate with the in-band rule, which is what refuses it', async () => {
    // At a 0.1 band the floor sits at 1.0 under `lower`, so 0.95 clears it: `select` refuses it.
    const instance = await deployment()
    await openEvaluation(instance, 'e-in-band', CANDIDATE_A, 'lower')
    await recordTrial(instance, 'e-in-band', 0.95)
    await round(instance, [['e-in-band', CANDIDATE_A]])
    const decision = projectRound(roundStateOf(instance.store, 'round-1'), sliceOf(instance.store.load()), {
      floor: 0.1,
      source: 'measured',
    })
    expect([decision.outcomes[0]?.admitted, decision.outcomes[0]?.reason.includes('in-band candidate')]).toEqual([
      false,
      true,
    ])
  })
})

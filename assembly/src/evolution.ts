import type { ControlSessionStore } from '../../src/control/session-store.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import {
  contextDigestOf,
  MEASURE_KINDS,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type EvaluationMetric,
  type EvaluationState,
  type EvaluationWeights,
} from '../../src/measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../../src/measure/view.ts'
import { assertClosedKeys, type Envelope } from '../../src/protocol/envelope.ts'
import { foldSubject, foldSubjects } from '../../src/protocol/fold.ts'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import type { ProtocolRegistry } from '../../src/protocol/registry.ts'
import { createStrategyCommands } from '../../src/strategy/commands.ts'
import { type Calibration } from '../../src/strategy/decision.ts'
import { structuralEditsOf as contentEditsOf } from '../../src/strategy/edits.ts'
import {
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_VERSION,
  type RoundState,
  type StructuralEdit,
} from '../../src/strategy/protocol.ts'
import { projectRound, type MeasureSlice, type RoundDecision } from '../../src/strategy/view.ts'
import type { Bubble, BubbleInput } from '../../src/task/bubble.ts'
import type { VerifierCriterion } from '../../src/task/contract.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { sameRevision } from '../../src/task/shape.ts'
import type { MethodAssets } from './method.ts'
import type { EvaluationCostBasis } from './evaluation-cost.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { matrixOf, trialKey, type Suite, type TaskCase, type Split } from '../../src/measure/suite.ts'
import { calibrationFrom } from '../../src/measure/calibration.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import type { DomainMeasurementReport } from './domain-measurement.ts'

export interface SolveResult {
  readonly trajectory?: import('@deepseek-ai/dsh-attachment').FileAttachmentRef
  readonly taskId: string
  readonly runId: string
  readonly quality: number
  readonly met: boolean
  readonly cost: number | null
  readonly costBasis?: EvaluationCostBasis
  readonly artifactDigest: string
  readonly inputDigests: readonly BubbleInput[]
  readonly implementationDigest: string
  readonly acceptanceDigest: string
  readonly verdict?: { readonly criterionId: string; readonly evidenceDigest: string; readonly artifactDigest: string }
  readonly guardsMet?: boolean
  readonly criteria?: readonly { readonly criterionId: string; readonly verdict: string; readonly hardGuard: boolean }[]
  readonly measurement?: DomainMeasurementReport
}
export interface SolveFailure {
  readonly status: 'no-submission' | 'business-failure' | 'review-inconclusive' | 'infrastructure-failure'
  readonly taskId: string
  readonly runId: string
  readonly reason: string
  readonly cost: number | null
  readonly costBasis?: EvaluationCostBasis
  readonly trajectory?: import('@deepseek-ai/dsh-attachment').FileAttachmentRef
  /** A domain calculator may reject a submitted candidate independently of Task acceptance. */
  readonly measurementArtifact?: Pick<
    SolveResult,
    'artifactDigest' | 'inputDigests' | 'implementationDigest' | 'acceptanceDigest' | 'verdict'
  >
}
export type SolveObservation = SolveResult | SolveFailure

export interface EvolutionOptions {
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
  readonly criterion: VerifierCriterion
  readonly calibration: Calibration
  readonly metric: EvaluationMetric
  readonly weights: EvaluationWeights
  readonly trials: number
  readonly parallelism?: number
  readonly suite?: Suite
  readonly split?: Split
  readonly executionProfileDigest?: string
  readonly productionHead?: string
  readonly loadMethod: (revision: RevisionRef) => Promise<MethodAssets>
  readonly baseline: EvolutionOptions['solve']
  readonly solve: (input: {
    readonly revision: RevisionRef
    readonly operationId: string
    readonly case?: TaskCase
    readonly trialKey?: string
    readonly contract?: TaskContract
    readonly started: (run: { readonly taskId: string; readonly runId: string }) => Promise<void>
  }) => Promise<SolveObservation>
}

export interface EvolutionRound {
  readonly campaignId: string
  readonly roundId: string
  readonly round: number
  readonly incumbent: RevisionRef
  readonly candidates: readonly RevisionRef[]
}

export interface Evolution {
  runRound(input: EvolutionRound): Promise<RoundDecision>
  history(): readonly RoundDecision[]
}

/** Asset loading validates template shapes; this comparison counts content, never proposer claims. */
export function structuralEditsOf(baseline: MethodAssets, candidate: MethodAssets): readonly StructuralEdit[] {
  return contentEditsOf(baseline, candidate)
}

function measuresAt(entries: readonly Envelope[], registry: ProtocolRegistry): MeasureSlice {
  const states = foldSubjects<EvaluationState>(registry, entries, MEASURE_PROTOCOL, MEASURE_VERSION)
  return {
    entries,
    evaluationOf: evaluationId => {
      const state = states.get(evaluationId)
      if (state?.baseline === undefined || state.candidate === undefined) return undefined
      const caliberDigest = caliberDigestOf(state)
      if (caliberDigest === undefined) return undefined
      return {
        evaluationId,
        caliberDigest,
        baseline: state.baseline,
        candidate: state.candidate,
        ...projectEvaluation(state),
      }
    },
    incumbentBelow: (revision, cutoff, caliber) => {
      const prefix = entries.filter(entry => entry.seq < cutoff)
      const historical = foldSubjects<EvaluationState>(registry, prefix, MEASURE_PROTOCOL, MEASURE_VERSION)
      const latest = prefix
        .filter(
          entry =>
            entry.protocol === MEASURE_PROTOCOL &&
            entry.version === MEASURE_VERSION &&
            entry.kind === MEASURE_KINDS.evaluationOpened,
        )
        .map(entry => historical.get(entry.subject))
        .filter(
          state =>
            state?.candidate !== undefined &&
            sameRevision(state.candidate, revision) &&
            caliberDigestOf(state) === caliber,
        )
        .at(-1)
      if (latest === undefined) return null
      const view = projectEvaluation(latest)
      return view.quality !== null ? { quality: view.quality, cost: view.cost } : null
    },
  }
}

export function createEvolution(options: EvolutionOptions): Evolution {
  const { store, registry, criterion, metric, weights, trials } = options
  const parallelism = options.parallelism ?? 1
  if (!Number.isSafeInteger(parallelism) || parallelism < 1)
    refuse('malformed-declaration', 'evaluation parallelism must be a positive integer')
  const measure = createMeasureCommands({
    store,
    registry,
    implementations: [criterion, metric.measured].map(held => ({
      ref: held.verifierRef,
      version: held.verifierVersion,
      implementationDigest: held.implementationDigest,
    })),
  })

  function history(): readonly RoundDecision[] {
    const entries = store.load().entries()
    return entries
      .filter(
        entry =>
          entry.protocol === STRATEGY_PROTOCOL &&
          entry.version === STRATEGY_VERSION &&
          entry.kind === STRATEGY_KINDS.roundDecided,
      )
      .map(decision => {
        const prefix = entries.filter(entry => entry.seq <= decision.seq)
        const state = foldSubject<RoundState>(registry, prefix, STRATEGY_PROTOCOL, STRATEGY_VERSION, decision.subject)!
        return projectRound(state, measuresAt(prefix, registry), state.decision!.calibration)
      })
  }

  function checkContext(expected: EvaluationState, actual: Bubble, where: string): void {
    if (contextDigestOf(actual) === expected.context) return
    const frozen = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, expected.run!.taskId)!.runs[
      expected.run!.runId
    ]!.bubble!
    const differences = Object.fromEntries(
      (['model', 'tools', 'conditions', 'inputs'] as const)
        .filter(field => digestOf(frozen[field]) !== digestOf(actual[field]))
        .map(field => [field, { expected: frozen[field], actual: actual[field] }]),
    )
    refuse(
      'caliber-mismatch',
      `${where} changed the frozen execution context: ${JSON.stringify(differences)}. This candidate is excluded; keep the incumbent and root-bound tool identities unchanged for comparison.`,
    )
  }

  async function evaluate(
    incumbent: RevisionRef,
    revision: RevisionRef,
    operationId: string,
    ordering: {
      readonly expected?: EvaluationState
      readonly solve: EvolutionOptions['solve']
      readonly reuse?: EvaluationState
    },
  ): Promise<string> {
    const evaluationId = `${operationId}:evaluation`
    const matrix =
      options.suite === undefined
        ? undefined
        : matrixOf(
            options.suite,
            options.split ?? 'evolve',
            options.executionProfileDigest ??
              refuse('malformed-declaration', 'suite evaluation requires an execution profile'),
          )
    const count = matrix?.slots.length ?? trials
    const judgement = matrix === undefined ? [criterion] : []
    const existing = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
    if (
      existing !== undefined &&
      (digestOf(existing.matrix ?? null) !== digestOf(matrix ?? null) ||
        digestOf(existing.metric) !== digestOf(metric) ||
        digestOf(existing.weights) !== digestOf(weights) ||
        existing.trials !== count)
    )
      refuse('caliber-mismatch', 'evaluation recovery changed its frozen matrix, metric, weights or trial count')
    let opened!: () => void
    const ready = new Promise<void>(resolve => {
      opened = resolve
    })
    if (existing?.run !== undefined) opened()
    const evaluateSlot = async (slot: number): Promise<void> => {
      const prior = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
      if (
        prior?.observed.some(trial => trial.slot === slot) ||
        prior?.failed?.some(trial => trial.slot === slot) ||
        prior?.missed.some(trial => trial.slot === slot)
      )
        return
      const held = matrix?.slots[slot]
      const taskCase = held === undefined ? undefined : options.suite!.cases.find(c => c.caseId === held.caseId)!
      const key = held === undefined ? undefined : trialKey(matrix!, revision, held, operationId)
      const started: Parameters<EvolutionOptions['solve']>[0]['started'] = async run => {
        if (slot === 0) {
          await measure.openEvaluation({
            commandId: `${operationId}:open-evaluation`,
            evaluationId,
            baseline: incumbent,
            candidate: revision,
            run,
            metric,
            weights,
            trials: count,
            judgement,
            ...(matrix === undefined ? {} : { matrix }),
          })
        }
        const actual = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, run.taskId)!.runs[run.runId]!
        if (matrix === undefined) {
          const plan =
            ordering.expected ?? store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
          checkContext(plan, actual.bubble!, `${operationId} trial ${slot}`)
        } else if (ordering.expected !== undefined) {
          const reference =
            ordering.expected.observed.find(trial => trial.slot === slot)?.run ??
            ordering.expected.failed?.find(trial => trial.slot === slot)?.run
          if (reference === undefined) refuse('caliber-mismatch', 'baseline slot has no valid execution evidence')
          const baseline = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, reference.taskId)!.runs[
            reference.runId
          ]!.bubble!
          if (contextDigestOf(baseline) !== contextDigestOf(actual.bubble!))
            refuse('caliber-mismatch', 'case trial changed frozen execution context')
        }
        if (slot === 0) opened()
      }
      const cached = [...(ordering.reuse?.observed ?? []), ...(ordering.reuse?.failed ?? [])].find(t => t.slot === slot)
      let result: SolveObservation
      if (cached !== undefined) {
        result = JSON.parse(cached.detail!) as SolveObservation
        await started({ taskId: result.taskId, runId: result.runId })
      } else
        result = await ordering.solve({
          revision,
          operationId: key === undefined ? `${operationId}:trial:${slot}` : `trial:${key}`,
          ...(taskCase === undefined ? {} : { case: taskCase, contract: taskCase.contract, trialKey: key! }),
          started,
        })
      const detail = JSON.stringify({
        ...result,
        ...(cached === undefined ? {} : { reusedFrom: { evaluationId: ordering.reuse!.evaluationId, slot } }),
      })
      const ref = { taskId: result.taskId, runId: result.runId }
      if ('status' in result) {
        if (result.status === 'infrastructure-failure' || result.status === 'review-inconclusive') {
          await measure.missTrial({
            commandId: `${operationId}:trial:${slot}`,
            evaluationId,
            slot,
            reason: detail,
            ...(result.cost === null ? {} : { cost: result.cost }),
          })
        } else if (result.status === 'business-failure' && result.measurementArtifact !== undefined) {
          await measure.recordTrial({
            commandId: `${operationId}:trial:${slot}`,
            evaluationId,
            trial: {
              slot,
              quality: options.suite?.failureQuality ?? 0,
              run: ref,
              artifactDigest: result.measurementArtifact.artifactDigest,
              inputDigests: result.measurementArtifact.inputDigests,
              implementationDigest: result.measurementArtifact.implementationDigest,
              ...(result.cost === null ? {} : { cost: result.cost }),
              guardsMet: false,
              detail,
            },
          })
        } else {
          await measure.failTrial({
            commandId: `${operationId}:trial:${slot}`,
            evaluationId,
            trial: {
              slot,
              quality: options.suite?.failureQuality ?? 0,
              status: result.status,
              reason: result.reason,
              run: ref,
              implementationDigest: metric.measured.implementationDigest,
              ...(result.cost === null ? {} : { cost: result.cost }),
              detail,
              guardsMet: taskCase?.hardGuards.length === 0,
            },
          })
        }
        return
      }
      const actual = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, result.taskId)!.runs[result.runId]!
      const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
      if (
        options.suite?.scoring === 'criteria' &&
        (result.quality < 0 || result.quality > 1 || !Number.isFinite(result.quality))
      )
        refuse('caliber-mismatch', 'criteria quality must be a fraction in [0,1]')
      if (
        matrix !== undefined &&
        result.met &&
        (metric.direction === 'lower'
          ? result.quality > options.suite!.failureQuality
          : result.quality < options.suite!.failureQuality)
      )
        refuse(
          'caliber-mismatch',
          'suite failureQuality must be at least as bad as every successful observation under the declared metric direction',
        )
      if (slot === 0 && (plan.run!.taskId !== result.taskId || plan.run!.runId !== result.runId))
        refuse('evidence-input-mismatch', 'trial result names a different Run from started()')
      if (matrix === undefined) checkContext(plan, actual.bubble!, `${operationId} trial ${slot} result`)
      await measure.recordTrial({
        commandId: `${operationId}:trial:${slot}`,
        evaluationId,
        trial: {
          slot,
          quality:
            matrix !== undefined && !result.met && options.suite!.scoring !== 'criteria'
              ? options.suite!.failureQuality
              : result.quality,
          ...(result.cost === null ? {} : { cost: result.cost }),
          artifactDigest: result.artifactDigest,
          run: ref,
          inputDigests: result.inputDigests,
          implementationDigest: result.implementationDigest,
          guardsMet: matrix === undefined ? true : (result.guardsMet ?? taskCase!.hardGuards.length === 0),
          detail,
        },
      })
    }
    // Slot zero fixes the plan before other isolated trials start. Drain every in-flight trial
    // before propagating failure, so recovery cannot race writes from the previous invocation.
    let next = 0,
      failed = false
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(matrix === undefined ? 1 : parallelism, count) }, async () => {
        while (!failed && next < count) {
          const slot = next++
          try {
            if (slot !== 0) await ready
            if (failed) return
            await evaluateSlot(slot)
          } catch (error) {
            failed = true
            throw error
          } finally {
            if (slot === 0) opened()
          }
        }
      }),
    )
    for (const worker of workers) if (worker.status === 'rejected') throw worker.reason
    const state = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
    if (matrix === undefined && state.observed.length === count && !store.committedOf(`${operationId}:constraint`)) {
      const results = state.observed.map(trial => JSON.parse(trial.detail!) as SolveObservation)
      const witness = results.find(result => 'status' in result || !result.met) ?? results.at(-1)!
      const evidence = 'status' in witness ? witness.measurementArtifact! : witness
      await measure.checkConstraint({
        commandId: `${operationId}:constraint`,
        evaluationId,
        criterionId: criterion.criterionId,
        met: results.every(result => !('status' in result) && result.met),
        artifactDigest: evidence.artifactDigest,
        implementationDigest: evidence.acceptanceDigest,
        ...(evidence.verdict === undefined ? {} : { verdict: evidence.verdict }),
        detail: JSON.stringify({ results }),
      })
    }
    return evaluationId
  }

  return {
    history,
    runRound: async input => {
      assertClosedKeys(
        input as unknown as Record<string, unknown>,
        ['campaignId', 'roundId', 'round', 'incumbent', 'candidates'],
        'evaluation request',
        'malformed-declaration',
      )
      if (input.candidates.length === 0) refuse('malformed-declaration', 'evaluation requires at least one candidate')
      const prior = store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, input.roundId)
      if (
        prior?.plan !== undefined &&
        (prior.plan.campaignId !== input.campaignId ||
          prior.plan.round !== input.round ||
          !sameRevision(prior.plan.incumbent, input.incumbent) ||
          prior.plan.candidates !== input.candidates.length ||
          prior.submissions.some(candidate => !sameRevision(candidate.revision, input.candidates[candidate.slot]!)))
      )
        refuse('command-conflict', 'evaluation request differs from the frozen round')
      if (prior?.decision !== undefined) return history().find(round => round.roundId === input.roundId)!
      const baseline = await options.loadMethod(input.incumbent)
      const candidates: { readonly revision: RevisionRef; readonly edits: readonly StructuralEdit[] }[] = []
      for (const revision of input.candidates) {
        const assets = await options.loadMethod(revision)
        const edits = structuralEditsOf(baseline, assets)
        if (edits.length === 0)
          refuse('malformed-declaration', `candidate ${revision.revisionId} has no method changes`)
        if (candidates.some(candidate => candidate.revision.digest === revision.digest))
          refuse('malformed-declaration', `candidate ${revision.revisionId} repeats a method revision in this round`)
        candidates.push({ revision, edits })
      }
      // RRSI keeps the incumbent's measured evaluation. Reuse only committed evidence from this
      // search under the exact suite/profile/metric; no cross-search or private-split cache.
      const cut = store.load()
      const matrix =
        options.suite === undefined
          ? undefined
          : matrixOf(
              options.suite,
              options.split ?? 'evolve',
              options.executionProfileDigest ??
                refuse('malformed-declaration', 'suite evaluation requires an execution profile'),
            )
      const reusableIds = [...cut.statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
        .filter(r => r.plan?.campaignId === input.campaignId && r.decision !== undefined)
        .flatMap(r => [
          `${r.roundId}:bootstrap:evaluation`,
          ...r.submissions.filter(c => c.slot === r.decision!.winner).map(c => c.evaluationId),
        ])
      const reuse =
        matrix === undefined
          ? undefined
          : reusableIds
              .map(id => cut.stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, id))
              .findLast(
                e =>
                  e !== undefined &&
                  e.candidate !== undefined &&
                  sameRevision(e.candidate, input.incumbent) &&
                  digestOf(e.matrix ?? null) === digestOf(matrix) &&
                  digestOf(e.metric) === digestOf(metric) &&
                  digestOf(e.weights) === digestOf(weights) &&
                  projectEvaluation(e).missing.length === 0 &&
                  [...e.observed, ...(e.failed ?? [])].every(t => t.detail !== undefined),
              )
      const baselineId = await evaluate(input.incumbent, input.incumbent, `${input.roundId}:bootstrap`, {
        solve: options.baseline,
        ...(reuse === undefined ? {} : { reuse }),
      })
      const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, baselineId)!
      const strategy = createStrategyCommands({
        store,
        calibration: calibrationFrom(plan, options.calibration),
        measuresAt: cut => measuresAt(cut.entries(), registry),
      })
      if (prior?.plan === undefined)
        await strategy.openRound({
          commandId: `${input.roundId}:open`,
          roundId: input.roundId,
          campaignId: input.campaignId,
          round: input.round,
          incumbent: input.incumbent,
          candidates: candidates.length,
          historyCutoff: store.load().entries().length,
          ...(options.productionHead === undefined ? {} : { productionHead: options.productionHead }),
          caliber: caliberDigestOf(plan)!,
          weights,
        })
      const evaluations: string[] = []
      for (const [slot, candidate] of candidates.entries()) {
        const operationId = `${input.roundId}:${slot}:candidate`
        const evaluationId = `${operationId}:evaluation`
        try {
          evaluations[slot] = await evaluate(input.incumbent, candidate.revision, operationId, {
            expected: plan,
            solve: options.solve,
          })
        } catch (error) {
          if (!(error instanceof ProtocolRefusal) || error.refusal.code !== 'caliber-mismatch') throw error
          const state = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
          for (let trial = 0; trial < state.trials!; trial++) {
            if (
              state.observed.some(entry => entry.slot === trial) ||
              state.failed?.some(entry => entry.slot === trial) ||
              state.missed.some(entry => entry.slot === trial)
            )
              continue
            await measure.missTrial({
              commandId: `${operationId}:excluded:${trial}`,
              evaluationId,
              slot: trial,
              reason: error.refusal.detail,
            })
          }
          evaluations[slot] = evaluationId
        }
      }
      for (const [slot, candidate] of candidates.entries())
        await strategy.submitCandidate({
          commandId: `${input.roundId}:${slot}:submit`,
          roundId: input.roundId,
          slot,
          revision: candidate.revision,
          evaluationId: evaluations[slot]!,
          edits: candidate.edits,
        })
      await strategy.decideRound({ commandId: `${input.roundId}:decide`, roundId: input.roundId })
      return history().find(round => round.roundId === input.roundId)!
    },
  }
}

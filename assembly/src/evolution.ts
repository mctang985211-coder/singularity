import type { ControlSessionStore } from '../../src/control/session-store.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import { contextDigestOf, MEASURE_KINDS, MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationMetric, type EvaluationState, type EvaluationWeights } from '../../src/measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../../src/measure/view.ts'
import { assertClosedKeys, type Envelope } from '../../src/protocol/envelope.ts'
import { foldSubject, foldSubjects } from '../../src/protocol/fold.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { ProtocolRegistry } from '../../src/protocol/registry.ts'
import { createStrategyCommands } from '../../src/strategy/commands.ts'
import { type Calibration } from '../../src/strategy/decision.ts'
import { structuralEditsOf as contentEditsOf } from '../../src/strategy/edits.ts'
import { STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState, type StructuralEdit } from '../../src/strategy/protocol.ts'
import { projectRound, type MeasureSlice, type RoundDecision } from '../../src/strategy/view.ts'
import type { BubbleInput } from '../../src/task/bubble.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { revisionRef, REVISION_MEMBERS, sameRevision } from '../../src/task/shape.ts'
import type { MethodAssets } from './method.ts'
import type { EvaluationCostBasis, EvaluationCostSummary } from './evaluation-cost.ts'
import { list, record, text } from './shape.ts'

export interface SolveResult {
  readonly taskId: string
  readonly runId: string
  readonly quality: number
  readonly met: boolean
  readonly cost: number
  readonly costBasis?: EvaluationCostBasis
  readonly costSummary?: EvaluationCostSummary
  readonly artifactDigest: string
  readonly inputDigests: readonly BubbleInput[]
  readonly implementationDigest: string
  readonly acceptanceDigest: string
  readonly verdict?: { readonly criterionId: string; readonly evidenceDigest: string; readonly artifactDigest: string }
}

export interface EvolutionOptions {
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
  readonly criterion: AcceptanceCriterion
  readonly calibration: Calibration
  readonly metric: EvaluationMetric
  readonly weights: EvaluationWeights
  readonly trials: number
  readonly loadMethod: (revision: RevisionRef) => Promise<MethodAssets>
  readonly solve: (input: { readonly revision: RevisionRef; readonly operationId: string;
    readonly started: (run: { readonly taskId: string; readonly runId: string }) => Promise<void> }) => Promise<SolveResult>
}

export interface EvolutionRound {
  readonly roundId: string
  readonly round: number
  readonly incumbent: RevisionRef
  readonly candidates: readonly RevisionRef[]
}

export function readEvolutionRound(raw: unknown): EvolutionRound {
  const input = record(raw, 'evaluation request')
  assertClosedKeys(input, ['roundId', 'round', 'incumbent', 'candidates'], 'evaluation request', 'malformed-declaration')
  const round = input['round']
  if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 1)
    refuse('malformed-declaration', 'evaluation request.round must be a positive integer')
  const candidates = list(input['candidates'], 'evaluation request.candidates')
  if (candidates.length === 0) refuse('malformed-declaration', 'evaluation requires at least one candidate')
  return { roundId: text(input, 'roundId', 'evaluation request'), round,
    incumbent: revisionRef(input['incumbent'], 'evaluation request.incumbent', REVISION_MEMBERS),
    candidates: candidates.map((value, index) => revisionRef(value, `evaluation request.candidates[${index}]`, REVISION_MEMBERS)) }
}

export interface Evolution {
  runRound(input: EvolutionRound): Promise<RoundDecision>
  history(): readonly RoundDecision[]
}

/** Asset loading validates template shapes; this comparison counts content, never proposer claims. */
export function structuralEditsOf(baseline: MethodAssets, candidate: MethodAssets): readonly StructuralEdit[] {
  if (baseline.rootTemplate !== candidate.rootTemplate)
    refuse('malformed-declaration', 'method candidates must retain the deployment rootTemplate')
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
      return { evaluationId, caliberDigest, baseline: state.baseline, candidate: state.candidate, ...projectEvaluation(state) }
    },
    incumbentBelow: (revision, cutoff) => {
      const prefix = entries.filter(entry => entry.seq < cutoff)
      const historical = foldSubjects<EvaluationState>(registry, prefix, MEASURE_PROTOCOL, MEASURE_VERSION)
      const latest = prefix.filter(entry => entry.protocol === MEASURE_PROTOCOL && entry.version === MEASURE_VERSION && entry.kind === MEASURE_KINDS.evaluationOpened)
        .map(entry => historical.get(entry.subject)).filter(state => state?.candidate !== undefined && sameRevision(state.candidate, revision)).at(-1)
      if (latest === undefined) return null
      const view = projectEvaluation(latest)
      return view.missing.length === 0 ? { quality: view.quality, cost: view.cost } : null
    },
  }
}

export function createEvolution(options: EvolutionOptions): Evolution {
  const { store, registry, criterion, metric, weights, trials } = options
  const measure = createMeasureCommands({ store, registry,
    implementations: [criterion, metric.measured].map(held => ({ ref: held.verifierRef, version: held.verifierVersion, implementationDigest: held.implementationDigest })) })
  const strategy = createStrategyCommands({ store, calibration: options.calibration, measuresAt: cut => measuresAt(cut.entries(), registry) })

  function history(): readonly RoundDecision[] {
    const entries = store.load().entries()
    return entries.filter(entry => entry.protocol === STRATEGY_PROTOCOL && entry.version === STRATEGY_VERSION && entry.kind === STRATEGY_KINDS.roundDecided)
      .map(decision => {
        const prefix = entries.filter(entry => entry.seq <= decision.seq)
        const state = foldSubject<RoundState>(registry, prefix, STRATEGY_PROTOCOL, STRATEGY_VERSION, decision.subject)!
        return projectRound(state, measuresAt(prefix, registry), state.decision!.calibration)
      })
  }

  async function evaluate(incumbent: RevisionRef, revision: RevisionRef, operationId: string, ordering: {
    readonly expectedCaliber?: string
    readonly opened?: (caliber: string) => void
  } = {}): Promise<string> {
    const evaluationId = `${operationId}:evaluation`
    const results: SolveResult[] = []
    for (let slot = 0; slot < trials; slot++) {
      const recorded = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)?.observed.find(trial => trial.slot === slot)
      if (recorded !== undefined) {
        const detail = JSON.parse(recorded.detail!) as Pick<SolveResult, 'taskId' | 'runId' | 'met' | 'verdict' | 'costBasis' | 'costSummary'>
        results.push({ ...detail, quality: recorded.quality, cost: recorded.cost!, artifactDigest: recorded.artifactDigest,
          inputDigests: recorded.inputDigests, implementationDigest: recorded.implementationDigest, acceptanceDigest: criterion.implementationDigest })
        continue
      }
      const result = await options.solve({ revision, operationId: `${operationId}:trial:${slot}`, started: async run => {
        if (slot === 0) {
          await measure.openEvaluation({ commandId: `${operationId}:open-evaluation`, evaluationId, baseline: incumbent, candidate: revision,
            run, metric, weights, trials, judgement: [criterion] })
          const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
          const caliber = caliberDigestOf(plan)!
          if (ordering.expectedCaliber !== undefined && caliber !== ordering.expectedCaliber)
            refuse('caliber-mismatch', `${operationId} changed the round's frozen caliber`)
          ordering.opened?.(caliber)
        } else {
          const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
          const actual = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, run.taskId)!.runs[run.runId]!
          if (contextDigestOf(actual.bubble!) !== plan.context) refuse('caliber-mismatch', `${operationId} trial ${slot} changed its frozen context`)
        }
      } })
      const actual = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, result.taskId)!.runs[result.runId]!
      const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
      if ((slot === 0 && plan.run!.taskId !== result.taskId) || contextDigestOf(actual.bubble!) !== plan.context)
        refuse('caliber-mismatch', `${operationId} trial ${slot} result changed its frozen Task or execution context`)
      results.push(result)
      await measure.recordTrial({ commandId: `${operationId}:trial:${slot}`, evaluationId, trial: {
        slot, quality: result.quality, cost: result.cost, artifactDigest: result.artifactDigest,
        inputDigests: result.inputDigests, implementationDigest: result.implementationDigest,
        detail: JSON.stringify({ taskId: result.taskId, runId: result.runId, met: result.met, verdict: result.verdict, costBasis: result.costBasis, costSummary: result.costSummary }),
      } })
    }
    const witness = results.find(result => !result.met) ?? results.at(-1)!
    if (!store.committedOf(`${operationId}:constraint`)) await measure.checkConstraint({ commandId: `${operationId}:constraint`, evaluationId, criterionId: criterion.criterionId,
      met: results.every(result => result.met), artifactDigest: witness.artifactDigest, implementationDigest: witness.acceptanceDigest,
      ...(witness.verdict === undefined ? {} : { verdict: witness.verdict }),
      detail: JSON.stringify({ results: results.map(result => ({ taskId: result.taskId, runId: result.runId, met: result.met, verdict: result.verdict })) }),
    })
    return evaluationId
  }

  return {
    history,
    runRound: async input => {
      assertClosedKeys(input as unknown as Record<string, unknown>, ['roundId', 'round', 'incumbent', 'candidates'], 'evaluation request', 'malformed-declaration')
      if (input.candidates.length === 0) refuse('malformed-declaration', 'evaluation requires at least one candidate')
      const prior = store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, input.roundId)
      if (prior?.plan !== undefined && (prior.plan.round !== input.round || !sameRevision(prior.plan.incumbent, input.incumbent) ||
        prior.plan.candidates !== input.candidates.length || prior.submissions.some(candidate => !sameRevision(candidate.revision, input.candidates[candidate.slot]!))))
        refuse('command-conflict', 'evaluation request differs from the frozen round')
      if (prior?.decision !== undefined) return history().find(round => round.roundId === input.roundId)!
      const baseline = await options.loadMethod(input.incumbent)
      const candidates: { readonly revision: RevisionRef; readonly edits: readonly StructuralEdit[] }[] = []
      for (const revision of input.candidates) {
        const assets = await options.loadMethod(revision)
        const edits = structuralEditsOf(baseline, assets)
        if (edits.length === 0) refuse('malformed-declaration', `candidate ${revision.revisionId} has no method changes`)
        if (candidates.some(candidate => candidate.revision.digest === revision.digest))
          refuse('malformed-declaration', `candidate ${revision.revisionId} repeats a method revision in this round`)
        candidates.push({ revision, edits })
      }
      let opened!: (caliber: string) => void
      const planned = new Promise<string>(resolve => { opened = resolve })
      const bootstrap = evaluate(input.incumbent, input.incumbent, `${input.roundId}:bootstrap`, { opened }).then(async evaluationId => {
        const state = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
        const caliber = caliberDigestOf(state)!
        if (prior?.plan === undefined) await strategy.openRound({ commandId: `${input.roundId}:open`, roundId: input.roundId, round: input.round,
          incumbent: input.incumbent, candidates: candidates.length, historyCutoff: store.load().entries().length, caliber, weights })
        return caliber
      })
      const ready = Promise.race([planned, bootstrap])
      let nextSlot = 0
      const evaluations: string[] = []
      const evaluateCandidates = async (): Promise<void> => {
        const caliber = await ready
        while (nextSlot < candidates.length) {
          const slot = nextSlot++, candidate = candidates[slot]!
          evaluations[slot] = await evaluate(input.incumbent, candidate.revision, `${input.roundId}:${slot}:candidate`, { expectedCaliber: caliber })
        }
      }
      const settled = await Promise.allSettled([bootstrap.then(evaluateCandidates), evaluateCandidates()])
      const failures = [...new Set(settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []))]
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join('; '))
      for (const [slot, candidate] of candidates.entries()) await strategy.submitCandidate({
        commandId: `${input.roundId}:${slot}:submit`, roundId: input.roundId, slot,
        revision: candidate.revision, evaluationId: evaluations[slot]!, edits: candidate.edits,
      })
      await strategy.decideRound({ commandId: `${input.roundId}:decide`, roundId: input.roundId })
      return history().find(round => round.roundId === input.roundId)!
    },
  }
}

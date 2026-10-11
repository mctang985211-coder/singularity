import type { ControlSessionStore } from '../../src/control/session-store.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import { contextDigestOf, MEASURE_KINDS, MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationMetric, type EvaluationState, type EvaluationWeights } from '../../src/measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../../src/measure/view.ts'
import { digestOf, type Envelope } from '../../src/protocol/envelope.ts'
import { foldSubject, foldSubjects } from '../../src/protocol/fold.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { ProtocolRegistry } from '../../src/protocol/registry.ts'
import { createStrategyCommands } from '../../src/strategy/commands.ts'
import { editBudgetFor, type Calibration } from '../../src/strategy/decision.ts'
import { STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState, type StructuralEdit } from '../../src/strategy/protocol.ts'
import { projectRound, type MeasureSlice, type RoundDecision } from '../../src/strategy/view.ts'
import type { BubbleInput } from '../../src/task/bubble.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { sameRevision } from '../../src/task/shape.ts'
import type { MethodAssets } from './method.ts'

export interface SolveResult {
  readonly taskId: string
  readonly runId: string
  readonly quality: number
  readonly met: boolean
  readonly cost: number
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
  readonly rounds: number
  readonly firstBudget: number
  readonly minimumBudget: number
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
  readonly explorationSlots: number
}

export interface Evolution {
  runRound(input: EvolutionRound): Promise<RoundDecision>
  history(): readonly RoundDecision[]
}

/** Asset loading validates template shapes; this comparison counts content, never proposer claims. */
export function structuralEditsOf(baseline: MethodAssets, candidate: MethodAssets): readonly StructuralEdit[] {
  if (baseline.rootTemplate !== candidate.rootTemplate)
    refuse('malformed-declaration', 'method candidates must retain the deployment rootTemplate')
  const byId = (templates: readonly unknown[]) => new Map(templates.map(template => {
    const { id } = template as { readonly id: string }
    return [id, digestOf(template)] as const
  }))
  const before = byId(baseline.templates)
  const after = byId(candidate.templates)
  const edits: StructuralEdit[] = [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(id => before.get(id) !== after.get(id)).map(target => ({ asset: 'template', target }))
  if (baseline.skill !== candidate.skill) edits.push({ asset: 'skill', target: 'skill' })
  if (baseline.tool !== candidate.tool) edits.push({ asset: 'tool', target: 'tool' })
  return edits
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
  const strategy = createStrategyCommands({ store, rounds: options.rounds, firstBudget: options.firstBudget,
    minimumBudget: options.minimumBudget, calibration: options.calibration, measuresAt: cut => measuresAt(cut.entries(), registry) })

  function history(): readonly RoundDecision[] {
    const entries = store.load().entries()
    return entries.filter(entry => entry.protocol === STRATEGY_PROTOCOL && entry.version === STRATEGY_VERSION && entry.kind === STRATEGY_KINDS.roundDecided)
      .map(decision => {
        const prefix = entries.filter(entry => entry.seq <= decision.seq)
        const state = foldSubject<RoundState>(registry, prefix, STRATEGY_PROTOCOL, STRATEGY_VERSION, decision.subject)!
        return projectRound(state, measuresAt(prefix, registry), state.decision!.calibration)
      })
  }

  async function evaluate(incumbent: RevisionRef, revision: RevisionRef, operationId: string, expectedCaliber?: string): Promise<string> {
    const evaluationId = `${operationId}:evaluation`
    const results: SolveResult[] = []
    for (let slot = 0; slot < trials; slot++) {
      const result = await options.solve({ revision, operationId: `${operationId}:trial:${slot}`, started: async run => {
        if (slot === 0) {
          await measure.openEvaluation({ commandId: `${operationId}:open-evaluation`, evaluationId, baseline: incumbent, candidate: revision,
            run, metric, weights, trials, judgement: [criterion] })
          const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
          if (expectedCaliber !== undefined && caliberDigestOf(plan) !== expectedCaliber)
            refuse('caliber-mismatch', `${operationId} changed the round's frozen caliber`)
        } else {
          const plan = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)!
          const actual = store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, run.taskId)!.runs[run.runId]!
          if (contextDigestOf(actual.bubble!) !== plan.context) refuse('caliber-mismatch', `${operationId} trial ${slot} changed its frozen context`)
        }
      } })
      results.push(result)
      await measure.recordTrial({ commandId: `${operationId}:trial:${slot}`, evaluationId, trial: {
        slot, quality: result.quality, cost: result.cost, artifactDigest: result.artifactDigest,
        inputDigests: result.inputDigests, implementationDigest: result.implementationDigest,
        detail: JSON.stringify({ taskId: result.taskId, runId: result.runId, met: result.met, verdict: result.verdict }),
      } })
    }
    const witness = results.find(result => !result.met) ?? results.at(-1)!
    await measure.checkConstraint({ commandId: `${operationId}:constraint`, evaluationId, criterionId: criterion.criterionId,
      met: results.every(result => result.met), artifactDigest: witness.artifactDigest, implementationDigest: witness.acceptanceDigest,
      ...(witness.verdict === undefined ? {} : { verdict: witness.verdict }),
      detail: JSON.stringify(results.map(result => ({ taskId: result.taskId, runId: result.runId, met: result.met, verdict: result.verdict }))),
    })
    return evaluationId
  }

  return {
    history,
    runRound: async input => {
      if (input.candidates.length < 2) refuse('malformed-declaration', 'an evolution round requires at least two candidates')
      const baseline = await options.loadMethod(input.incumbent)
      const candidates: { readonly revision: RevisionRef; readonly edits: readonly StructuralEdit[] }[] = []
      const budget = editBudgetFor(input.round, options.rounds, options.firstBudget, options.minimumBudget)
      for (const revision of input.candidates) {
        const assets = await options.loadMethod(revision)
        const edits = structuralEditsOf(baseline, assets)
        if (edits.length > budget) refuse('budget-exhausted', `candidate ${revision.revisionId} changes ${edits.length} assets; round ${input.round} budget is ${budget}`)
        if (edits.length === 0) refuse('malformed-declaration', `candidate ${revision.revisionId} has no method changes`)
        if (candidates.some(candidate => candidate.revision.digest === revision.digest))
          refuse('malformed-declaration', `candidate ${revision.revisionId} repeats a method revision in this round`)
        candidates.push({ revision, edits })
      }

      // strategy compares with an incumbent aggregate frozen before the round opens. This explicit
      // bootstrap is separate from every subsequent paired baseline/candidate execution.
      const bootstrapId = await evaluate(input.incumbent, input.incumbent, `${input.roundId}:bootstrap`)
      const bootstrap = store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, bootstrapId)!
      const caliber = caliberDigestOf(bootstrap)!
      await strategy.openRound({ commandId: `${input.roundId}:open`, roundId: input.roundId, round: input.round,
        incumbent: input.incumbent, candidates: candidates.length, explorationSlots: input.explorationSlots,
        historyCutoff: store.load().entries().length, caliber, weights })
      for (const [slot, candidate] of candidates.entries()) {
        await evaluate(input.incumbent, input.incumbent, `${input.roundId}:${slot}:baseline`, caliber)
        const evaluationId = await evaluate(input.incumbent, candidate.revision, `${input.roundId}:${slot}:candidate`, caliber)
        await strategy.submitCandidate({ commandId: `${input.roundId}:${slot}:submit`, roundId: input.roundId, slot,
          revision: candidate.revision, evaluationId, edits: candidate.edits, exploratory: slot >= candidates.length - input.explorationSlots })
      }
      await strategy.decideRound({ commandId: `${input.roundId}:decide`, roundId: input.roundId })
      return history().find(round => round.roundId === input.roundId)!
    },
  }
}

/**
 * The trusted command boundary for measurement: the only surface through which a measurement fact
 * is produced, and the one place its cross-entity preconditions are decided.
 *
 * A measure reducer sees one subject — the evaluation — and that is correct. But a trial's inputs
 * must be the ones the *run's* bubble declared, the executor of that run must not report the numbers
 * — nor certify the hard constraints that decide admissibility, on facts it authored itself — and
 * the implementation that produced them must be one this deployment holds: the first two live in
 * another subject and the third in the deployment. Deciding them afterwards in a
 * projection is a diagnosis, not a check — by then the number is already in the log. So they run
 * here, as the `require` step handed to the append that produces the fact, which means they read
 * the store's committed cut at the moment they decide rather than a cut taken earlier.
 *
 * The identity an emitter role resolves to is asked of the store that stamps it (`identityOf`), never
 * carried by this service: a table a caller could supply is a second copy of the deployment's trust
 * decisions, free to leave a role out, and a comparison against a missing entry is silently false.
 * The check that a run's executor did not report its own numbers therefore compares the very identity
 * the append path is about to stamp, because there is only one place that identity comes from.
 *
 * That was executed, not argued: with a table handed to this service, one deployment's log accepted a
 * self-reported trial and a self-reported constraint check — the service's copy simply left the
 * metric's role out, the lookup returned nothing, and nothing compared the copy to the table the log
 * stamps from. So no table is an option here: a caller that has one has nothing to hand this module,
 * and a deployment that trusts no identity for a role records no fact under it at all.
 *
 * The command fills the parts a caller must not. `verifierRef` and `verifierVersion` are copied from
 * the metric the plan froze — the same discipline `recordVerdict` uses for a criterion — the
 * evaluation's `context` is read from the bubble the run declared, and the digest a producer reports
 * is checked here only for *availability*: whether this deployment holds that implementation at all,
 * which is a question about now and not about the fact. A caller supplies what it observed; it does
 * not supply who observed it, and it cannot point a trial at a different run than the plan's.
 *
 * What this module does not do is run anything. Measuring is `src/measure/execution.ts`, called by
 * the deployment *before* the fact is committed: a commit region that spawned a process would hold
 * the append path for as long as a real program takes.
 *
 * @module singularity-core/measure/commands
 */

import type { ControlReadCut, ControlSessionStore } from '../control/session-store.ts'
import { digestOf, type Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import { assertInputsBound, type Bubble } from '../task/bubble.ts'
import type { VerifierCriterion } from '../task/contract.ts'
import { TASK_PROTOCOL, TASK_VERSION, verifierRoleOf, type RevisionRef, type RunState, type TaskState,
} from '../task/protocol.ts'
import type { MeasuredTrial } from './execution.ts'
import {
  contextDigestOf,
  MEASURE_KINDS,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type EvaluationMetric,
  type EvaluationRun,
  type EvaluationState,
  type EvaluationWeights,
  type FailedTrial,
} from './protocol.ts'
import type { EvaluationMatrix } from './suite.ts'

/** One trial as its producer reports it. Who measured is filled from the metric, never passed. */
export interface TrialInput extends MeasuredTrial {
  readonly slot: number
  readonly run?: EvaluationRun
  readonly guardsMet?: boolean
}

/** One evaluation as the caller plans it. Every member is validated by the kind's own reducer. */
export interface EvaluationPlanInput {
  readonly commandId: string
  readonly evaluationId: string
  readonly baseline: RevisionRef
  readonly candidate: RevisionRef
  readonly run: EvaluationRun
  readonly metric: EvaluationMetric
  readonly weights: EvaluationWeights
  readonly trials: number
  readonly judgement: readonly VerifierCriterion[]
  readonly matrix?: EvaluationMatrix
}

export interface MeasureCommandOptions {
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
  /** The implementations this deployment holds, by the digest of their own bytes. */
  readonly implementations: readonly { readonly ref: string
    readonly version: string
    readonly implementationDigest: string }[]
}

export interface MeasureCommands {
  openEvaluation(input: EvaluationPlanInput): Promise<Envelope>
  recordTrial(input: { readonly commandId: string
    readonly evaluationId: string
    readonly trial: TrialInput }): Promise<Envelope>
  missTrial(input: { readonly commandId: string
    readonly evaluationId: string
    readonly slot: number
    readonly reason: string }): Promise<Envelope>
  failTrial(input: { readonly commandId: string; readonly evaluationId: string
    readonly trial: Omit<FailedTrial, 'verifierRef' | 'verifierVersion'> }): Promise<Envelope>
  checkConstraint(input: {
    readonly commandId: string
    readonly evaluationId: string
    readonly criterionId: string
    readonly met: boolean
    readonly artifactDigest: string
    readonly implementationDigest: string
    /**
     * The verdict this check rests on, when a task protocol recorded one. It is a citation and not a
     * second judgment: the fact carries the digest of the verdict, and the reducer refuses a citation
     * of a criterion other than this one or of bytes this evaluation did not measure.
     */
    readonly verdict?: { readonly criterionId: string
      readonly evidenceDigest: string
      readonly artifactDigest: string }
    readonly detail?: string
  }): Promise<Envelope>
}

/** Everything one command reads, taken from the committed cut at the moment its check runs. */
interface Cut {
  readonly evaluation: (evaluationId: string) => EvaluationState | undefined
  readonly task: (taskId: string) => TaskState | undefined
}

/** The plan a measurement fact must belong to, read from the evaluation's own state. */
interface OpenPlan {
  readonly run: EvaluationRun
  readonly metric: EvaluationMetric
  readonly judgement: readonly VerifierCriterion[]
  readonly matrix?: EvaluationMatrix
  readonly candidate?: RevisionRef
}

export function createMeasureCommands(options: MeasureCommandOptions): MeasureCommands {
  const commands: MeasureCommands = {
    openEvaluation: (input) => {
      const action = `open evaluation "${input.evaluationId}"`
      // The context is *read*, never supplied: a caller that could declare the context two candidates
      // are compared under could make them comparable by assertion. The bubble it comes from is
      // immutable once opened, so the value read here is the value the region below will see.
      const run = requireBubbledRun(cutOf(options), input.run, action)
      return emitRaw(
        options,
        input.commandId,
        MEASURE_KINDS.evaluationOpened,
        input.evaluationId,
        {
          baseline: input.baseline,
          candidate: input.candidate,
          run: input.run,
          context: contextDigestOf(run.bubble),
          metric: input.metric,
          weights: input.weights,
          trials: input.trials,
          judgement: input.judgement,
          ...(input.matrix === undefined ? {} : { matrix: input.matrix }),
        },
        () => {
          // Cross-subject, decided in the commit region: a plan whose run this log never started, or
          // whose run declared no execution context, can never produce a comparable measurement.
          requireBubbledRun(cutOf(options), input.run, action)
        },
      )
    },

    recordTrial: (input) => {
      // The metric is read before the payload is built and again inside the commit region. The two
      // reads cannot disagree: a second `evaluation/opened` is refused by the reducer, so a plan
      // that exists at all never changes - the same reason `recordVerdict` may fill its verifier
      // from the criterion it read.
      const action = `record trial slot ${input.trial.slot} of evaluation "${input.evaluationId}"`
      const plan = requireOpened(cutOf(options), input.evaluationId, action)
      return emitRaw(
        options,
        input.commandId,
        MEASURE_KINDS.trialRecorded,
        input.evaluationId,
        {
          slot: input.trial.slot,
          quality: input.trial.quality,
          ...(input.trial.cost === undefined ? {} : { cost: input.trial.cost }),
          artifactDigest: input.trial.artifactDigest,
          inputDigests: input.trial.inputDigests,
          verifierRef: plan.metric.measured.verifierRef,
          verifierVersion: plan.metric.measured.verifierVersion,
          implementationDigest: input.trial.implementationDigest,
          ...(input.trial.detail === undefined ? {} : { detail: input.trial.detail }),
          ...(input.trial.run === undefined ? {} : { run: input.trial.run }),
          ...(input.trial.guardsMet === undefined ? {} : { guardsMet: input.trial.guardsMet }),
        },
        () => {
          const now = requireOpened(cutOf(options), input.evaluationId, action)
          requireHeldImplementation(options, input.trial.implementationDigest, action)
          const run = requireTrialRun(options, now, input.trial.slot, input.trial.run, action)
          // Reuse, never a second copy: the binding between a trial and the run's declared inputs
          // is the bubble owner's rule, and it is decided here because the bubble is another
          // subject's fact.
          assertInputsBound(run.bubble, input.trial.inputDigests, action)
          requireNotExecutor(options, now.metric.measured, run, action)
        },
      )
    },

    failTrial: input => {
      const action = `record failed trial ${input.trial.slot}`
      const plan = requireOpened(cutOf(options), input.evaluationId, action)
      return emitRaw(options, input.commandId, MEASURE_KINDS.trialFailed, input.evaluationId, {
        ...input.trial, verifierRef: plan.metric.measured.verifierRef, verifierVersion: plan.metric.measured.verifierVersion,
      }, () => {
        const now = requireOpened(cutOf(options), input.evaluationId, action)
        const run = requireTrialRun(options, now, input.trial.slot, input.trial.run, action)
        if (run.status !== 'failed' || run.failureCause === 'runtime' || run.submission !== undefined)
          refuse('evidence-input-mismatch', 'a scored no-artifact failure requires a terminal business Run without a submission')
        requireHeldImplementation(options, input.trial.implementationDigest, action)
        requireNotExecutor(options, now.metric.measured, run, action)
      })
    },

    missTrial: (input) => {
      const action = `declare trial slot ${input.slot} of evaluation "${input.evaluationId}" missed`
      const plan = requireOpened(cutOf(options), input.evaluationId, action)
      return emitRaw(
        options,
        input.commandId,
        MEASURE_KINDS.trialMissed,
        input.evaluationId,
        {
          slot: input.slot,
          reason: input.reason,
          verifierRef: plan.metric.measured.verifierRef,
          verifierVersion: plan.metric.measured.verifierVersion,
        },
        () => {
          const now = requireOpened(cutOf(options), input.evaluationId, action)
          requireNotExecutor(options, now.metric.measured, requireRun(cutOf(options), now.run, action), action)
        },
      )
    },

    checkConstraint: (input) => {
      const action = `check hard constraint "${input.criterionId}" of evaluation "${input.evaluationId}"`
      const plan = requireOpened(cutOf(options), input.evaluationId, action)
      const criterion = requireJudged(plan, input.evaluationId, input.criterionId, action)
      return emitRaw(
        options,
        input.commandId,
        MEASURE_KINDS.constraintChecked,
        input.evaluationId,
        {
          criterionId: input.criterionId,
          met: input.met,
          artifactDigest: input.artifactDigest,
          verifierRef: criterion.verifierRef,
          verifierVersion: criterion.verifierVersion,
          implementationDigest: input.implementationDigest,
          ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        },
        () => {
          const now = requireOpened(cutOf(options), input.evaluationId, action)
          requireHeldImplementation(options, input.implementationDigest, action)
          // The same rule as a trial's numbers, on the fact that decides admissibility: a candidate
          // that measured its own run may not also certify that run's constraints. Without this the
          // non-compensating rule degrades to "…unless the candidate checks itself".
          const judged = now.judgement.find((entry) => entry.criterionId === input.criterionId)
          // Whether the plan judges that criterion at all is the reducer's rule; this lookup is only
          // to reach the implementation whose identity must not be the run's executor.
          if (judged !== undefined) requireNotExecutor(options, judged, requireRun(cutOf(options), now.run, action), action)
        },
      )
    },
  }

  return commands
}

/** The committed cut, as one command's check reads it. Taken once per use, so its members agree. */
function cutOf(options: MeasureCommandOptions): Cut {
  const cut: ControlReadCut = options.store.load()
  return {
    evaluation: (evaluationId) => cut.stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId),
    task: (taskId) => cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId),
  }
}

/** The open plan of one evaluation, or a refusal naming what is missing. */
function requireOpened(cut: Cut, evaluationId: string, action: string): OpenPlan {
  const state = cut.evaluation(evaluationId)
  const plan = state === undefined ? undefined : { run: state.run, metric: state.metric, judgement: state.judgement, matrix: state.matrix, candidate: state.candidate }
  if (plan === undefined || plan.run === undefined || plan.metric === undefined || plan.judgement === undefined)
    refuse('illegal-transition', `cannot ${action}: no measurement plan is open for evaluation "${evaluationId}"; open the evaluation before anything is measured in it`,
    )
  return { run: plan.run, metric: plan.metric, judgement: plan.judgement, ...(plan.matrix === undefined ? {} : { matrix: plan.matrix }), ...(plan.candidate === undefined ? {} : { candidate: plan.candidate }) }
}

function requireTrialRun(options: MeasureCommandOptions, plan: OpenPlan, slot: number, ref: EvaluationRun | undefined, action: string): RunState {
  const cut = cutOf(options)
  const actual = requireRun(cut, ref ?? plan.run, action)
  if (plan.matrix !== undefined) {
    if (ref === undefined) refuse('evidence-input-mismatch', 'matrix trial must name its actual Task/Run')
    const task = cut.task(ref.taskId)!, held = plan.matrix.slots[slot]
    if (held === undefined || digestOf(task.contract) !== held.contractDigest || digestOf(actual.revision) !== digestOf(plan.candidate))
      refuse('evidence-input-mismatch', 'trial differs from frozen case or candidate')
    const anchor = requireRun(cut, plan.run, action).bubble
    if (actual.bubble === undefined || anchor === undefined || digestOf({ model: actual.bubble.model, tools: actual.bubble.tools, conditions: actual.bubble.conditions }) !==
      digestOf({ model: anchor.model, tools: anchor.tools, conditions: anchor.conditions })) refuse('caliber-mismatch', 'matrix trial changed execution conditions')
  }
  return actual
}

/** The run a plan measures in, read from its own task subject. */
function requireRun(cut: Cut, run: EvaluationRun, action: string): RunState {
  const state = cut.task(run.taskId)?.runs[run.runId]
  if (state === undefined)
    refuse('unknown-run', `cannot ${action}: task "${run.taskId}" never started run "${run.runId}", so there is no execution context to measure in`,
    )
  return state
}

/** The run *and* the execution context it declared: without the bubble there is no context to freeze. */
function requireBubbledRun(cut: Cut, run: EvaluationRun, action: string): RunState & { readonly bubble: Bubble } {
  const state = requireRun(cut, run, action)
  if (state.bubble === undefined)
    refuse(
      'illegal-transition',
      `cannot ${action}: run "${run.runId}" has not declared an execution context (its bubble), so there is no model, tool set or condition set for this measurement to be comparable under; open the bubble first`,
    )
  return { ...state, bubble: state.bubble }
}

/** One hard constraint of the plan, or a refusal listing what the plan does declare. */
function requireJudged(plan: OpenPlan, evaluationId: string, criterionId: string, action: string): VerifierCriterion {
  const criterion = plan.judgement.find((entry) => entry.criterionId === criterionId)
  if (criterion === undefined)
    refuse(
      'unknown-criterion',
      `cannot ${action}: evaluation "${evaluationId}" does not declare hard constraint "${criterionId}" (declared: ${plan.judgement.map((entry) => entry.criterionId).join(', ') || 'none'})`,
    )
  return criterion
}

/**
 * Availability, which only the deployment can decide: is this implementation one it is holding?
 *
 * Whether the digest is the one the plan names is a comparison between the payload and the
 * evaluation's own frozen state, so the reducer owns it; this check is about *now*, and a fold
 * replaying last month's facts cannot answer it.
 */
function requireHeldImplementation(options: MeasureCommandOptions, implementationDigest: string, action: string): void {
  if (!options.implementations.some((entry) => entry.implementationDigest === implementationDigest))
    refuse('unregistered-verifier', `cannot ${action}: this deployment holds no implementation with digest ${implementationDigest.slice(0, 12)}…, so it cannot have produced this measurement`,
    )
}

/**
 * The executor of the run being measured never reports its numbers: the run's actor is refused.
 *
 * The identity a role resolves to is asked of the store, never carried here. A second table is free
 * to leave a role out, and a comparison against a missing entry is false — so the check would pass
 * exactly when it matters (a deployment that binds the metric's role to the identity that ran the
 * run), while the log stamped that identity on the fact and recorded it. Asking the store is what
 * makes the check read the table the stamp comes from: a role it does not resolve never reaches this
 * function, because the append path resolves the emitter role from the same table before it runs.
 */
function requireNotExecutor(options: MeasureCommandOptions, criterion: VerifierCriterion,
  run: RunState,
  action: string,
): void {
  const role = verifierRoleOf({ verifierRef: criterion.verifierRef, verifierVersion: criterion.verifierVersion })
  const actor = options.store.identityOf(role)
  if (actor === run.actor)
    refuse('self-reported-evidence', `cannot ${action}: "${actor}" (role ${role}) started run "${run.runId}" and cannot also measure its criterion "${criterion.criterionId}"`,
    )
}

/**
 * Produce one fact, with its cross-subject preconditions handed to the append path.
 *
 * They are not run here, immediately before the call, because command identity has to be decided
 * first: a re-delivered command was already decided, and deciding it again against a state that has
 * moved on turns "give me back the result I lost" into a refusal.
 */
async function emitRaw(
  options: MeasureCommandOptions,
  commandId: string,
  kind: string,
  subject: string,
  payload: unknown,
  require?: () => void,
): Promise<Envelope> {
  return options.store.emit({ commandId, protocol: MEASURE_PROTOCOL, version: MEASURE_VERSION, kind, subject, payload }, require,
  ) as Promise<Envelope>
}

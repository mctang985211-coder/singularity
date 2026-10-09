/**
 * The measurement protocol: one evaluation is one frozen plan, and every number in it comes from
 * the implementation that plan's metric names.
 *
 * **Why a plan of slots.** A trial count is a *repetition* count, not a count of whatever happened
 * to be recorded. `trials = k` fixes slots `0..k-1` before the first run, and a report is read
 * against those slots. The system this replaces aggregated the observations it had and reported
 * `quality = 1` for `trials = 2, missing = 1`: the absent slot filled nothing, so one lucky
 * repetition read as a complete measurement. Here the denominator is the plan's, a slot without an
 * observation is named by the projection, and `trial/missed` is a kind because absence is a fact
 * somebody recorded rather than a gap a reader has to notice.
 *
 * **Why the metric's implementation is also the emitter.** `metric.measured` is an
 * `AcceptanceCriterion`, whose `implementationDigest` is the content digest of the implementation
 * that decides it, and a trial is emitted by `verifier:<ref>@<version>` — the role discipline
 * `evidence/produced` already uses. A name a deployment can re-point is not an identity, so the
 * reducer refuses a trial whose emitter is not the metric's implementation and whose content digest
 * is not the metric's. The identity members travel *in the payload* (`verifierRef`,
 * `verifierVersion`, `implementationDigest`) for the same reason they do in `evidence/produced`: a
 * kind's emitter is a function of its own payload and of nothing else, so the role a fact must be
 * emitted under can only be derived from what the fact carries. The command layer fills them from
 * the frozen plan, so a producer supplies the numbers it observed and never who produced them.
 *
 * `trial/missed` carries the ref and version but **not** an `implementationDigest`, and the
 * asymmetry is deliberate rather than an oversight: a miss names no artifact and no number, so
 * there is no content whose digest could be bound, and inventing one would require an
 * implementation to have produced bytes it did not produce. The role is what must hold — a
 * deployment that cannot run the metric cannot report the gap either — and the digest check belongs
 * where a number exists.
 *
 * **Why hard constraints are a separate kind.** `constraint/checked` never touches `weights`.
 * Whether a constraint holds is decided by that criterion's own implementation, once per criterion,
 * and no score compensates for it — which is what makes "high score, out of bounds, rejected"
 * expressible at all.
 *
 * @module singularity-core/measure/protocol
 */

import { assertClosedKeys, type Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import { inputList, type BubbleInput } from '../task/bubble.ts'
import { assertCriterionShape, type AcceptanceCriterion } from '../task/contract.ts'
import { SCHEDULER_ROLE, verifierRoleOf, type RevisionRef } from '../task/protocol.ts'
import { digest, maybeText, record, text } from '../task/shape.ts'

export const MEASURE_PROTOCOL = 'measure'
/** Version 1. No earlier version exists, and there is no compatibility layer. */
export const MEASURE_VERSION = 1

export const MEASURE_KINDS = {
  evaluationOpened: 'evaluation/opened',
  trialRecorded: 'trial/recorded',
  trialMissed: 'trial/missed',
  constraintChecked: 'constraint/checked',
} as const

/** Where a measurement happens: the run whose declared bubble every trial is bound to. */
export interface EvaluationRun {
  readonly taskId: string
  readonly runId: string
}

/** What is measured, and which way a better number goes. */
export interface EvaluationMetric {
  /** The contract's criterion shape: a metric is an implementation a deployment holds, not a number an agent typed. */
  readonly measured: AcceptanceCriterion
  readonly unit: string
  readonly direction: 'higher' | 'lower'
}

/** How quality and cost trade off in a score. A hard constraint never passes through here. */
export interface EvaluationWeights {
  readonly quality: number
  readonly cost: number
}

/** One recorded observation of one planned slot. */
export interface TrialRecord {
  readonly slot: number
  readonly quality: number
  /** Absent means unknown. A cost nobody observed is not a zero. */
  readonly cost?: number
  readonly artifactDigest: string
  /** The named inputs the number was formed against: exactly the run's bubble, or the command refuses. */
  readonly inputDigests: readonly BubbleInput[]
  readonly verifierRef: string
  readonly verifierVersion: string
  /** The content digest of the implementation that actually produced the number. */
  readonly implementationDigest: string
  readonly detail?: string
}

/** One planned slot that produced no observation, with the reason it did not. */
export interface MissedTrial {
  readonly slot: number
  readonly reason: string
  readonly verifierRef: string
  readonly verifierVersion: string
}

/** One hard constraint's check. It carries no weight and no score: it is met, or it is not. */
export interface ConstraintCheck {
  readonly criterionId: string
  readonly met: boolean
  readonly artifactDigest: string
  readonly verifierRef: string
  readonly verifierVersion: string
  readonly implementationDigest: string
  readonly detail?: string
}

/** The folded state of one evaluation. `subject` in every envelope is this evaluation's id. */
export interface EvaluationState {
  readonly evaluationId: string
  readonly baseline?: RevisionRef
  readonly candidate?: RevisionRef
  readonly run?: EvaluationRun
  readonly metric?: EvaluationMetric
  readonly weights?: EvaluationWeights
  /** The plan's slot count k. It is the denominator, and it never comes from the observations. */
  readonly trials?: number
  /** The hard constraints, non-compensating. Empty means this evaluation declares none. */
  readonly judgement?: readonly AcceptanceCriterion[]
  readonly observed: readonly TrialRecord[]
  readonly missed: readonly MissedTrial[]
  readonly checks: readonly ConstraintCheck[]
}

const OPENED_MEMBERS = ['baseline', 'candidate', 'run', 'metric', 'weights', 'trials', 'judgement'] as const
const RECORDED_MEMBERS = ['slot', 'quality', 'cost', 'artifactDigest', 'inputDigests', 'verifierRef', 'verifierVersion', 'implementationDigest', 'detail'] as const
const MISSED_MEMBERS = ['slot', 'reason', 'verifierRef', 'verifierVersion'] as const
const CONSTRAINT_MEMBERS = ['criterionId', 'met', 'artifactDigest', 'verifierRef', 'verifierVersion', 'implementationDigest', 'detail'] as const

/** One revision pin: the environment it is unique in, the id, and the content it names. */
function revisionRef(raw: unknown, where: string): RevisionRef {
  const source = record(raw, where)
  assertClosedKeys(source, ['environmentId', 'revisionId', 'digest'], where)
  return { environmentId: text(source, 'environmentId', where), revisionId: text(source, 'revisionId', where), digest: digest(source, 'digest', where) }
}

/** A finite number: `NaN` and `Infinity` would not survive the digest a fact's identity is taken over. */
function finite(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    refuse('malformed-payload', `${where}.${key} must be a finite number, got ${String(value)}`)
  return value
}

/** An optional number: absent stays absent rather than becoming 0. */
function maybeFinite(source: Record<string, unknown>, key: string, where: string): number | undefined {
  return Object.hasOwn(source, key) ? finite(source, key, where) : undefined
}

function metricOf(raw: unknown, where: string): EvaluationMetric {
  const source = record(raw, where)
  assertClosedKeys(source, ['measured', 'unit', 'direction'], where)
  const direction = source['direction']
  if (direction !== 'higher' && direction !== 'lower')
    refuse('malformed-payload', `${where}.direction must be "higher" or "lower", got ${JSON.stringify(direction ?? null)}`)
  return { measured: assertCriterionShape(source['measured'], `${where}.measured`), unit: text(source, 'unit', where), direction }
}

function weightsOf(raw: unknown, where: string): EvaluationWeights {
  const source = record(raw, where)
  assertClosedKeys(source, ['quality', 'cost'], where)
  const quality = finite(source, 'quality', where)
  // A plan that weights quality at nothing cannot rank candidates by quality, so it measures nothing.
  if (quality <= 0) refuse('malformed-payload', `${where}.quality must be greater than 0, got ${String(quality)}`)
  return { quality, cost: finite(source, 'cost', where) }
}

/** One closed list of criteria with unique ids, read by the contract's own criterion reader. */
function criterionList(raw: unknown, where: string): readonly AcceptanceCriterion[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of acceptance criteria, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const criterion = assertCriterionShape(entry, `${where}[${index}]`)
    if (seen.has(criterion.criterionId)) refuse('malformed-contract', `${where} declares "${criterion.criterionId}" twice; a criterion id is stable and unique`)
    seen.add(criterion.criterionId)
    return criterion
  })
}

function trialOf(raw: unknown, where: string): TrialRecord {
  const source = record(raw, where)
  assertClosedKeys(source, RECORDED_MEMBERS, where)
  const cost = maybeFinite(source, 'cost', where)
  const detail = maybeText(source, 'detail', where)
  return {
    slot: finite(source, 'slot', where),
    quality: finite(source, 'quality', where),
    ...(cost === undefined ? {} : { cost }),
    artifactDigest: digest(source, 'artifactDigest', where),
    inputDigests: inputList(source['inputDigests'], `${where}.inputDigests`),
    verifierRef: text(source, 'verifierRef', where),
    verifierVersion: text(source, 'verifierVersion', where),
    implementationDigest: digest(source, 'implementationDigest', where),
    ...(detail === undefined ? {} : { detail }),
  }
}

function missedOf(raw: unknown, where: string): MissedTrial {
  const source = record(raw, where)
  assertClosedKeys(source, MISSED_MEMBERS, where)
  return {
    slot: finite(source, 'slot', where),
    reason: text(source, 'reason', where),
    verifierRef: text(source, 'verifierRef', where),
    verifierVersion: text(source, 'verifierVersion', where),
  }
}

function constraintOf(raw: unknown, where: string): ConstraintCheck {
  const source = record(raw, where)
  assertClosedKeys(source, CONSTRAINT_MEMBERS, where)
  const met = source['met']
  if (typeof met !== 'boolean') refuse('malformed-payload', `${where}.met must be a boolean, got ${met === null ? 'null' : typeof met}`)
  const detail = maybeText(source, 'detail', where)
  return {
    criterionId: text(source, 'criterionId', where),
    met,
    artifactDigest: digest(source, 'artifactDigest', where),
    verifierRef: text(source, 'verifierRef', where),
    verifierVersion: text(source, 'verifierVersion', where),
    implementationDigest: digest(source, 'implementationDigest', where),
    ...(detail === undefined ? {} : { detail }),
  }
}

/** The plan a fact must belong to. A trial is a repetition of a plan, so a fact without one fits nothing. */
interface Plan {
  readonly trials: number
  readonly metric: EvaluationMetric
  readonly judgement: readonly AcceptanceCriterion[]
}

function requirePlan(state: EvaluationState, where: string, evaluationId: string): Plan {
  const { trials, metric, judgement } = state
  if (trials === undefined || metric === undefined || judgement === undefined)
    refuse('illegal-transition', `${where} arrived before evaluation "${evaluationId}" carried a measurement plan; open the evaluation before anything is measured in it`)
  return { trials, metric, judgement }
}

function requireSlot(trials: number, slot: number, where: string): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= trials)
    refuse('illegal-transition', `${where} names trial slot ${String(slot)}, but the plan has slots 0..${trials - 1}; a run outside the frozen plan is not a repetition of it`)
}

function requireEmptySlot(state: EvaluationState, slot: number, where: string): void {
  const observation = state.observed.find(entry => entry.slot === slot)
  if (observation !== undefined)
    refuse('evidence-conflict', `${where} records trial slot ${slot} again; it already carries the observation ${String(observation.quality)} from ${observation.verifierRef}@${observation.verifierVersion}, and one slot carries one observation`)
  const miss = state.missed.find(entry => entry.slot === slot)
  if (miss !== undefined)
    refuse('evidence-conflict', `${where} records trial slot ${slot} again; it was already declared missed (${JSON.stringify(miss.reason)}), and one slot carries one outcome`)
}

/** The emitter half of "this came from the implementation the plan names". */
function requireEmitterRole(envelope: Envelope, criterion: AcceptanceCriterion, subject: string, where: string): void {
  const role = verifierRoleOf({ verifierRef: criterion.verifierRef, verifierVersion: criterion.verifierVersion })
  if (envelope.emitter !== role)
    refuse('wrong-verifier', `${where} was emitted by ${envelope.emitter}, but ${subject} names ${role}; a number is a measurement only when the implementation that criterion names produced it`)
}

/** The content half: a rebuilt implementation keeping its name does not inherit the numbers. */
function requireImplementationDigest(implementationDigest: string, criterion: AcceptanceCriterion, subject: string, where: string): void {
  if (implementationDigest !== criterion.implementationDigest)
    refuse('wrong-verifier', `${where} came from the implementation ${implementationDigest.slice(0, 12)}…, but ${subject} names ${criterion.implementationDigest.slice(0, 12)}…`)
}

/**
 * Declare the measurement protocol. Call once at load. Whether this deployment can run the metric
 * is a command-time question and is not decided here: what a deployment holds today is not a rule
 * about a plan recorded last month.
 */
export function declareMeasureProtocol(registry: ProtocolRegistry): void {
  registry.declare<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, {
    initialState: { evaluationId: '', observed: [], missed: [], checks: [] },
    kinds: {
      [MEASURE_KINDS.evaluationOpened]: defineKind<
        EvaluationState,
        { baseline: RevisionRef; candidate: RevisionRef; run: EvaluationRun; metric: EvaluationMetric; weights: EvaluationWeights; trials: number; judgement: readonly AcceptanceCriterion[] }
      >({
        guarantees: { appended: true },
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const where = `${MEASURE_KINDS.evaluationOpened} payload`
          const source = record(raw, where)
          assertClosedKeys(source, OPENED_MEMBERS, where)
          const trials = finite(source, 'trials', where)
          if (!Number.isInteger(trials) || trials < 1)
            refuse('malformed-payload', `${where}.trials must be an integer >= 1, got ${String(trials)}; a plan with no slots has no denominator, so nothing could be reported complete or missing`)
          const metric = metricOf(source['metric'], `${where}.metric`)
          const judgement = criterionList(source['judgement'], `${where}.judgement`)
          if (judgement.some(criterion => criterion.criterionId === metric.measured.criterionId))
            refuse('malformed-contract', `${where} judges "${metric.measured.criterionId}" as a hard constraint and measures it as the metric; a constraint nobody trades off and a number that is traded off are two criteria`)
          const run = record(source['run'], `${where}.run`)
          assertClosedKeys(run, ['taskId', 'runId'], `${where}.run`)
          return {
            baseline: revisionRef(source['baseline'], `${where}.baseline`),
            candidate: revisionRef(source['candidate'], `${where}.candidate`),
            run: { taskId: text(run, 'taskId', `${where}.run`), runId: text(run, 'runId', `${where}.run`) },
            metric,
            weights: weightsOf(source['weights'], `${where}.weights`),
            trials,
            judgement,
          }
        },
        reduce: (state, envelope, payload) => {
          const where = `${MEASURE_KINDS.evaluationOpened} #${envelope.seq}`
          if (state.trials !== undefined)
            refuse('illegal-transition', `${where} opens a second measurement plan for evaluation "${envelope.subject}"; a measurement has one frozen plan, so redrafting one is a new evaluation id`)
          return {
            ...state,
            evaluationId: envelope.subject,
            baseline: payload.baseline,
            candidate: payload.candidate,
            run: payload.run,
            metric: payload.metric,
            weights: payload.weights,
            trials: payload.trials,
            judgement: payload.judgement,
          }
        },
      }),

      [MEASURE_KINDS.trialRecorded]: defineKind<EvaluationState, TrialRecord>({
        guarantees: { appended: true },
        // The role *is* the implementation: a deployment must hold that verifier's identity to emit
        // its numbers, and the log refuses the fact when it does not.
        emitter: payload => verifierRoleOf(payload),
        parse: raw => trialOf(raw, `${MEASURE_KINDS.trialRecorded} payload`),
        reduce: (state, envelope, payload) => {
          const where = `${MEASURE_KINDS.trialRecorded} #${envelope.seq}`
          const plan = requirePlan(state, where, envelope.subject)
          requireSlot(plan.trials, payload.slot, where)
          requireEmptySlot(state, payload.slot, where)
          const subject = `the metric "${plan.metric.measured.criterionId}"`
          requireEmitterRole(envelope, plan.metric.measured, subject, where)
          requireImplementationDigest(payload.implementationDigest, plan.metric.measured, subject, where)
          return { ...state, observed: [...state.observed, payload] }
        },
      }),

      [MEASURE_KINDS.trialMissed]: defineKind<EvaluationState, MissedTrial>({
        guarantees: { appended: true },
        emitter: payload => verifierRoleOf(payload),
        parse: raw => missedOf(raw, `${MEASURE_KINDS.trialMissed} payload`),
        reduce: (state, envelope, payload) => {
          const where = `${MEASURE_KINDS.trialMissed} #${envelope.seq}`
          const plan = requirePlan(state, where, envelope.subject)
          requireSlot(plan.trials, payload.slot, where)
          requireEmptySlot(state, payload.slot, where)
          // A miss carries no number, so there is no content to bind: the identity that must hold is
          // the role, which is how a deployment that cannot run the metric cannot report the gap.
          requireEmitterRole(envelope, plan.metric.measured, `the metric "${plan.metric.measured.criterionId}"`, where)
          return { ...state, missed: [...state.missed, payload] }
        },
      }),

      [MEASURE_KINDS.constraintChecked]: defineKind<EvaluationState, ConstraintCheck>({
        guarantees: { appended: true },
        emitter: payload => verifierRoleOf(payload),
        parse: raw => constraintOf(raw, `${MEASURE_KINDS.constraintChecked} payload`),
        reduce: (state, envelope, payload) => {
          const where = `${MEASURE_KINDS.constraintChecked} #${envelope.seq}`
          const plan = requirePlan(state, where, envelope.subject)
          const criterion = plan.judgement.find(entry => entry.criterionId === payload.criterionId)
          if (criterion === undefined)
            refuse('unknown-criterion', `${where} checks hard constraint "${payload.criterionId}", which this evaluation's judgement does not declare (declared: ${plan.judgement.map(entry => entry.criterionId).join(', ') || 'none'})`)
          if (state.checks.some(entry => entry.criterionId === payload.criterionId))
            refuse('evidence-conflict', `${where} checks hard constraint "${payload.criterionId}" again; one constraint is checked once, and a re-check is a new evaluation id`)
          const subject = `hard constraint "${criterion.criterionId}"`
          requireEmitterRole(envelope, criterion, subject, where)
          requireImplementationDigest(payload.implementationDigest, criterion, subject, where)
          return { ...state, checks: [...state.checks, payload] }
        },
      }),
    },
  })
}

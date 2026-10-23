import type { Agent } from '@deepseek-ai/dsh-agent'
import { pairedReport } from '../../src/measure/paired.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import type { TaskState } from '../../src/task/protocol.ts'
import { taskStateOf } from './apparatus.ts'
import { createEvolution } from './evolution.ts'
import { executionProfile } from './execution-profile.ts'
import { releaseMethod } from './method-release.ts'
import { loadMethod } from './method.ts'
import { createNativeSolve } from './native-solve.ts'

import type { DriverRuntime } from './driver-runtime.ts'

export function createReleaseLifecycle(runtime: DriverRuntime) {
  const { apparatus, options, evaluation, measurement, parallelism, tasks, taskFact } = runtime
  const validateChampion = async (task: TaskState, parent: Agent, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const suite = apparatus.domain.suite
    const run = Object.values(task.runs).at(-1)
    if (suite === undefined || run?.purpose !== 'improve') return
    if (run.status !== 'running' || run.stage !== 'submitted') refuse('illegal-transition', 'validation requires a submitted RSI report')
    const rounds = [...apparatus.store.load().statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
      .filter(r => r.plan?.campaignId === task.taskId && r.decision !== undefined).sort((a, b) => a.plan!.round - b.plan!.round)
    const baseline = rounds[0]?.plan?.incumbent, last = rounds.at(-1)
    const champion = last?.submissions.find(s => s.slot === last.decision!.winner)?.revision ?? last?.plan?.incumbent
    if (baseline === undefined || champion === undefined || champion.digest === baseline.digest) return
    const identity = await executionProfile(parent, options.seams, apparatus.domain, parallelism)
    const profile = identity.digest
    const roundId = `${task.taskId}:validation`, suiteDigest = digestOf(suite)
    const fact = (suffix: string, kind: string, payload: unknown) => {
      signal.throwIfAborted()
      return taskFact(`transfer:${task.taskId}:${suffix}`, kind, task.taskId, payload, `agent:${task.responsibility!.agentId}`)
    }
    if (taskStateOf(apparatus, task.taskId).transfer === undefined)
      await fact('freeze', 'rsi/transfer-frozen', { baseline, champion, suiteDigest, executionProfileDigest: profile, roundId })
    const frozen = taskStateOf(apparatus, task.taskId).transfer!
    if (frozen.executionProfileDigest !== profile || frozen.suiteDigest !== suiteDigest) refuse('caliber-mismatch', 'validation execution profile changed after champion freeze')
    if (frozen.outcome === undefined) {
      let report: unknown, outcome: 'improved' | 'no-improvement' | 'insufficient-evidence' = 'insufficient-evidence'
      try {
        if (!frozen.consumed) await fact('consume', 'rsi/transfer-started', { suiteDigest })
        const privateCases = suite.cases.filter(c => c.split !== 'evolve')
        const priorEvaluations = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
        if ([...tasks().values()].some(t => t.taskId !== task.taskId && t.transfer?.consumed &&
          (t.transfer.suiteDigest === suiteDigest || [...priorEvaluations.values()].some(e =>
            ((e.matrix?.split === 'validation' && e.evaluationId.startsWith(`${t.transfer!.roundId}:`)) ||
              (e.matrix?.split === 'heldout' && e.evaluationId.startsWith(`${t.taskId}:heldout:`))) &&
            e.matrix.slots.some(slot => privateCases.some(c => c.familyId === slot.familyId || digestOf(c.contract) === slot.contractDigest))))))
          refuse('illegal-transition', 'this validation tranche was consumed by another campaign; use a new suite')
        if (!identity.complete) refuse('caliber-mismatch', `execution profile evidence missing: ${identity.missing.join(', ')}`)
        const native = createNativeSolve(apparatus, options.seams, parent, signal, measurement === undefined ? undefined
          : { digest: measurement.criterion.implementationDigest, measure: (source, signal, context) => measurement.measure(source, signal, context) })
        const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation, parallelism,
          productionHead: rounds[0]!.plan!.productionHead!,
          suite, split: 'validation', executionProfileDigest: profile, loadMethod: async revision => (await loadMethod(apparatus, revision)).assets,
          baseline: native, solve: native })
        const decision = await evolution.runRound({ campaignId: roundId, roundId, round: 1, incumbent: baseline, candidates: [champion] })
        signal.throwIfAborted()
        const states = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
        const pair = pairedReport(states.get(`${roundId}:bootstrap:evaluation`)!, states.get(`${roundId}:0:candidate:evaluation`)!)
        outcome = !identity.complete ? 'insufficient-evidence' : pair.status === 'improved' && decision.winner === 0 ? 'improved' : pair.status === 'insufficient-evidence' ? 'insufficient-evidence' : 'no-improvement'
        let heldout: unknown = null
        if (suite.cases.some(c => c.split === 'heldout')) {
          const finalId = `${task.taskId}:heldout`
          try {
            const final = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation, parallelism,
              productionHead: rounds[0]!.plan!.productionHead!, suite, split: 'heldout', executionProfileDigest: profile,
              loadMethod: async revision => (await loadMethod(apparatus, revision)).assets, baseline: native, solve: native })
            await final.runRound({ campaignId: finalId, roundId: finalId, round: 1, incumbent: baseline, candidates: [champion] })
            const measured = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
            heldout = pairedReport(measured.get(`${finalId}:bootstrap:evaluation`)!, measured.get(`${finalId}:0:candidate:evaluation`)!)
          } catch (error) {
            signal.throwIfAborted()
            if (!(error instanceof ProtocolRefusal) || error.refusal.code === 'write-not-durable') throw error
            heldout = { status: 'insufficient-evidence', reason: String(error) }
          }
        }
        report = { baseline, champion, suiteDigest, executionProfileDigest: profile, execution: identity, selection: decision, paired: pair, heldout,
          measuredAt: new Date().toISOString(),
          modelRevision: 'not independently attested', claim: 'paired validation under the recorded model route; no broad domain or novelty claim' }
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof ProtocolRefusal) || error.refusal.code === 'write-not-durable') throw error
        outcome = 'insufficient-evidence'
        report = { baseline, champion, suiteDigest, status: 'insufficient-evidence', reason: String(error) }
      }
      const attachment = await apparatus.attachments.saveFile({ name: 'transfer-report.json', data: Buffer.from(JSON.stringify(report)) })
      await fact('settled', 'rsi/transfer-settled', { outcome, report: attachment })
    }
    if (taskStateOf(apparatus, task.taskId).transfer!.outcome === 'improved')
      await releaseMethod(apparatus, options.seams, parent, `transfer:${task.taskId}:release`, { roundId }, signal)
  }
  return { validateChampion }
}
export type ReleaseLifecycle = ReturnType<typeof createReleaseLifecycle>

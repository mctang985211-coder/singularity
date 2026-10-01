/** The experiment runner: run or resume the two sides of one frozen experiment.
 * @module dsh-singularity-evolution/experiment/runner */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { ExperimentReport, FrozenSample } from '../replay.ts'
import { agentOptionsOf, EXPERIMENT_SIDES, frozenDigestOf } from '../replay.ts'
import type { ExperimentRequest, ExperimentSampleRecord, ExperimentSpec } from './spec.ts'
import { assertSampleRole, validateSpec } from './spec.ts'
import type { ExperimentResult } from './record.ts'
import {
  assertBudgetAllowsStart,
  assertRecordedRunOrigin,
  buildExperimentReport,
  costOf,
  directoryDigest,
  experimentIdOf,
  experimentLineage,
  experimentReportPath,
  experimentSampleKey,
  experimentSampleKeyOf,
  experimentStore,
  latestReview,
  recoveredSampleRecord,
  refusedBaselineRun,
  reportedTokensSpent,
  runFactsOf,
  sameKeyRefusal,
  sampleRecord,
  tokensOfRecord,
} from './record.ts'
import type { ExperimentSources, SampleProviders } from './freeze.ts'
import {
  experimentCandidate,
  freezeExperiment,
  frozenCapabilitySample,
  frozenProviderIdentity,
  frozenSampleOf,
} from './freeze.ts'
import { buildWorkspace } from './workspace.ts'

/** Run — or continue — the frozen two-sided experiment, and return the report the ledger records recompute to. */
export async function runExperiment(sources: ExperimentSources, request: ExperimentRequest): Promise<ExperimentResult> {
  const { spec, caller, actor } = request
  validateSpec(spec)
  const { sandbox, candidate, capability, overlay, proposal } = await experimentCandidate(sources, spec.proposalId)
  const { storeId, snapshot } = await experimentStore(sources, caller)
  // The judge vocabulary the criteria are frozen against, read before anything
  const vocabulary = await sources.verifierVocabulary?.()
  const samples: FrozenSample[] = []
  for (const sample of spec.samples) {
    const task = snapshot.tasks.find(item => item.taskId === sample.taskId)
    if (task === undefined) throw new Error(`unknown sample task "${sample.taskId}" in this graph's task store`)
    if (task.status !== 'verified' && task.status !== 'failed') {
      throw new Error(
        `sample "${sample.taskId}" is ${task.status}; only a terminal (verified or failed) sample can be evaluated`,
      )
    }
    const review = latestReview(snapshot, task)
    if (review === undefined) {
      throw new Error(`sample "${sample.taskId}" has no review record on its latest run; there is no case to reproduce`)
    }
    assertSampleRole(sample, task, review)
    // Before anything runs: what each side of this sample must bind, read
    const providers: SampleProviders =
      capability === undefined
        ? {
            provider: await frozenProviderIdentity({
              sources,
              caller,
              sampleTaskId: sample.taskId,
              required: task.requestedCapabilities,
              candidate: candidate!,
              where: `sample "${sample.taskId}"`,
            }),
          }
        : await frozenCapabilitySample({
            sources,
            caller,
            sampleTaskId: sample.taskId,
            required: task.requestedCapabilities,
            overlay: overlay!,
          })
    samples.push(frozenSampleOf(sample, task, review, providers, vocabulary))
  }
  const frozen = freezeExperiment({
    proposalId: spec.proposalId,
    spec,
    ...(candidate === undefined ? {} : { candidate }),
    ...(proposal.prepared?.skillBaseline == null ? {} : { productionBaseline: proposal.prepared.skillBaseline }),
    ...(capability === undefined ? {} : { capability }),
    sandbox,
    snapshotDigest: await directoryDigest(spec.snapshot.sourceDir),
    samples,
  })
  // The model selection, verbatim, as every side's `agentOptions` (S4-E §Q3): one read, shared by both sides.
  const agentOptions = agentOptionsOf(frozen.model) as ReplayTaskOptions['agentOptions']
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(spec.proposalId, frozenDigest)
  const sandboxRel = `${sandbox}/exp-${experimentId}`

  // One read of every experiment this proposal already has, before anything is started.
  const recorded = new Map<string, ExperimentSampleRecord>()
  for (const previous of await sources.evolution.experiments(spec.proposalId)) {
    for (const record of previous.samples) recorded.set(experimentSampleKey(record), record)
  }
  for (const sample of frozen.samples) {
    for (const side of EXPERIMENT_SIDES) {
      const key = experimentSampleKeyOf({ proposalId: spec.proposalId, frozen }, sample.taskId, side)
      const prior = recorded.get(experimentSampleKey(key))
      if (prior !== undefined && prior.experimentId !== experimentId) throw sameKeyRefusal(key, prior, experimentId)
    }
  }

  await sources.evolution.recordExperimentStart({
    formatVersion: 4,
    kind: 'experiment_started',
    proposalId: spec.proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: experimentReportPath(spec.proposalId, experimentId),
    storeId,
    actor,
    at: new Date().toISOString(),
  })
  const view = await sources.evolution.experiment(experimentId)

  // The frozen budget's one count, read off the ledger once (§F.2; the review's
  const budget = view.frozen.budget
  let spentTokens = reportedTokensSpent(view.samples)
  let settledSides = view.samples.length

  let started = 0
  try {
    sampleLoop: for (const sample of view.frozen.samples) {
      for (const side of EXPERIMENT_SIDES) {
        const key = experimentSampleKeyOf(view, sample.taskId, side)
        const lineage = experimentLineage(view.experimentId, sample.taskId, side)
        const workspace = resolve(sources.evolution.root, sandboxRel, sample.taskId, side)
        const prior = recorded.get(experimentSampleKey(key))
        if (prior !== undefined) {
          assertRecordedRunOrigin(snapshot, lineage, key, prior)
          continue
        }
        if (request.signal?.aborted) break sampleLoop
        const inFlight = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
        if (inFlight !== undefined) {
          const recovered = recoveredSampleRecord({ view, sample, side, task: inFlight, snapshot, workspace, actor })
          await sources.evolution.recordExperimentSample(recovered)
          recorded.set(experimentSampleKey(key), recovered)
          spentTokens += tokensOfRecord(recovered) ?? 0
          settledSides += 1
          continue
        }
        // Before this side spends anything: the whole-experiment budget, which must still leave room for this side.
        assertBudgetAllowsStart({
          experimentId: view.experimentId,
          budget,
          spentTokens,
          settledSides,
          where: `sample "${sample.taskId}" ${side} side`,
        })
        const real = await buildWorkspace(spec.snapshot.sourceDir, workspace, view.frozen.snapshot.digest)
        // A6: the frozen production configuration refuses this sample, so its baseline is recorded as not-admitted without a run.
        if (side === 'baseline' && sample.admission !== undefined) {
          const refusal = await refusedBaselineRun({
            sources,
            storeId,
            sample,
            lineage,
            workspace: real,
            agentOptions,
            caller,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          const admitted = sampleRecord({
            view,
            sample,
            side,
            outcome: 'not-admitted',
            criteria: [],
            evidenceRefs: [],
            workspace: real,
            cost: {
              status: 'unknown',
              reason: 'the runtime refused this side at admission, so no run exists and no cost was reported for it',
            },
            admission: {
              source: sample.admission.source,
              proposalId: view.proposalId,
              sourceRefs: [...(view.frozen.capability?.sourceRefs ?? [])],
              required: [...sample.admission.required],
              missing: [...sample.admission.missing],
              reason: refusal,
            },
            actor,
          })
          await sources.evolution.recordExperimentSample(admitted)
          recorded.set(experimentSampleKey(key), admitted)
          settledSides += 1
          continue
        }
        const outcome = await sources.taskRuntime.replayTask(
          storeId,
          sample.taskId,
          {
            lineage,
            workspace: { path: real },
            agentOptions: { ...agentOptions },
            ...(side === 'candidate'
              ? { overlay: overlay ?? { extraSkillRoots: [resolve(sources.evolution.root, sandbox, 'skills')] } }
              : {}),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
          caller,
        )
        if (outcome.workspace !== undefined && outcome.workspace !== real) {
          throw new Error(
            `the replay of "${sample.taskId}" reported workspace "${outcome.workspace}" but was given "${real}"; ` +
              "a side's frozen input and the directory its run went through must be the same directory",
          )
        }
        const after = await sources.task.openStore(storeId)
        const replayed = after.tasks.find(item => item.taskId === outcome.taskId)
        if (replayed === undefined) {
          throw new Error(
            `the replay of "${sample.taskId}" created task "${outcome.taskId}", which the store does not hold`,
          )
        }
        const facts = runFactsOf(after, replayed, outcome)
        const fresh = sampleRecord({
          view,
          sample,
          side,
          outcome: facts.outcome,
          ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
          ...(facts.runId === undefined ? {} : { runId: facts.runId }),
          ...(facts.review === undefined ? {} : { review: facts.review }),
          criteria: facts.criteria,
          evidenceRefs: facts.evidenceRefs,
          workspace: real,
          initialDigest: view.frozen.snapshot.digest,
          cost: costOf(facts.review),
          ...(facts.interruptedReason === undefined ? {} : { reason: facts.interruptedReason }),
          actor,
        })
        await sources.evolution.recordExperimentSample(fresh)
        recorded.set(experimentSampleKey(key), fresh)
        spentTokens += tokensOfRecord(fresh) ?? 0
        settledSides += 1
        started += 1
        // A run that settled cancelled is a stop somebody asked for: no further
        // side is started under it, and the settled ones stay recorded.
        if (facts.outcome === 'cancelled') break sampleLoop
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (started === 0) throw error instanceof Error ? error : new Error(message)
    throw new Error(
      `${message} (the experiment stopped; ${started} sample run(s) it started settled and stay in the ledger and the task store ` +
        `as evidence — resume experiment ${experimentId} to continue it)`,
    )
  }

  const finalView = await sources.evolution.experiment(experimentId)
  let report: ExperimentReport
  try {
    report = buildExperimentReport(finalView)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — resume experiment ${experimentId} to continue it`,
    )
  }
  const abs = resolve(sources.evolution.root, finalView.report)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { proposalId: finalView.proposalId, experimentId, report, reportPath: finalView.report, experiment: finalView }
}

/** Resume a frozen experiment by id: its specification *is* the frozen block, so the id alone is unambiguous. */
export async function resumeExperiment(
  sources: ExperimentSources,
  request: { experimentId: string; caller: SessionId; actor: string; signal?: AbortSignal },
): Promise<ExperimentResult> {
  const view = await sources.evolution.experiment(request.experimentId)
  const spec: ExperimentSpec = {
    proposalId: view.proposalId,
    samples: view.frozen.samples.map(sample => ({ taskId: sample.taskId, role: sample.role })),
    snapshot: { sourceDir: view.frozen.snapshot.sourceDir },
    model: view.frozen.model,
    budget: view.frozen.budget,
    repetition: view.frozen.repetition,
  }
  return runExperiment(sources, {
    spec,
    caller: request.caller,
    actor: request.actor,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
}

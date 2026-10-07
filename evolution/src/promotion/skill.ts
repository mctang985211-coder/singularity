/** The skill promotion evidence gate: one completed two-sided experiment, re-read from the ledger.
 * @module dsh-singularity-evolution/promotion/skill */

import type { RunProviderBinding, TaskRun } from '@dangosys/dsh-singularity-task'
import type { EvolutionProposal } from '../evolution.ts'
import type { ExperimentReport, FrozenSample } from '../replay.ts'
import type { SkillPromotionEvidence, SkillPromotionSources } from './shared.ts'
import { VERDICT_REFUSALS, identityLabel, sameIdentity, sampleVerdictLines } from './shared.ts'
import {
  assertCostWithinDeclaredBudget,
  assertExperimentCostWithinBudget,
  assertJudgeUnchanged,
  assertSampleInputsIntact,
  assertSideEvidence,
  assertSideModelBinding,
  assertSideProviderBinding,
  assertSidesAgree,
  experimentEvidence,
} from './binding.ts'

/** The whole skill promotion gate, as reads. Returns the experiment it validated and the report it recomputed. */
export async function assertSkillPromotionEvidence(
  sources: SkillPromotionSources,
  proposal: EvolutionProposal,
): Promise<SkillPromotionEvidence> {
  const prepared = proposal.prepared
  const candidate = prepared?.skillContent
  if (candidate === undefined) {
    throw new Error(
      `evolution: skill proposal "${proposal.proposalId}" records no candidate content identity — it was prepared before ` +
        'content binding; propose a new candidate and evaluate it (prepare records the SHA-256 of the materialized SKILL.md)',
    )
  }
  // 1.-3. The newest experiment, complete, with the report file that is its own records.
  const { view, report } = await experimentEvidence(sources, proposal)
  const experiment = view
  // 2. The frozen identities are the ones this proposal would promote —
  const frozen = report.frozen
  if (frozen.capability !== undefined) {
    throw new Error(
      `evolution: experiment "${experiment.experimentId}" froze a capability candidate, but proposal "${proposal.proposalId}" is a skill ` +
        'candidate — the evidence belongs to another kind of candidate, so nothing is promoted from it',
    )
  }
  if (frozen.candidate === undefined || !sameIdentity(frozen.candidate, candidate)) {
    throw new Error(
      `evolution: the experiment froze candidate ${frozen.candidate === undefined ? '(none)' : identityLabel(frozen.candidate)} but proposal ` +
        `"${proposal.proposalId}" now prepares ${identityLabel(candidate)} — the evidence belongs to different candidate ` +
        'bytes; propose a new candidate and evaluate it',
    )
  }
  const baseline = prepared?.skillBaseline
  const frozenBaseline = frozen.productionBaseline
  if (baseline == null || frozenBaseline === undefined || !sameIdentity(frozenBaseline, baseline)) {
    throw new Error(
      `evolution: the experiment's frozen production baseline (${frozenBaseline === undefined ? 'none' : identityLabel(frozenBaseline)}) ` +
        `is not the baseline prepare recorded for proposal "${proposal.proposalId}" ` +
        `(${baseline == null ? 'none' : identityLabel(baseline)}) — the candidate was evaluated against another production state`,
    )
  }
  // 4-5. Every side, and every sample's inputs and judge, re-read from the store.
  const storeId = experiment.storeId
  if (storeId === undefined) {
    throw new Error(
      `evolution: experiment "${experiment.experimentId}" records no task store, so the runs its sides cite cannot be re-read — ` +
        'run the two-sided experiment again so its evidence names the store it ran in',
    )
  }
  const snapshot = await sources.task.openStore(storeId)
  const vocabulary = await sources.verifierVocabulary()
  if (vocabulary === undefined) {
    throw new Error(
      "evolution: the verifier registry cannot be listed in this context, so the judges behind the experiment's verdicts cannot " +
        'be re-checked — the promotion is refused rather than granted on unverifiable evidence',
    )
  }
  for (const sample of report.samples) {
    const frozenSample = frozenSampleOf(report, sample.taskId)
    const sideRuns: Partial<Record<'baseline' | 'candidate', { run: TaskRun; binding: RunProviderBinding }>> = {}
    for (const side of ['baseline', 'candidate'] as const) {
      const detail = side === 'baseline' ? sample.baseline : sample.candidate
      const label = `sample "${sample.taskId}" ${side} side`
      const task = assertSideEvidence({
        sample: frozenSample,
        detail,
        experimentId: experiment.experimentId,
        snapshot,
        where: label,
        ...(frozen.objective === undefined ? {} : { objective: frozen.objective }),
      })
      assertJudgeUnchanged(frozenSample, detail, label, vocabulary)
      assertCostWithinDeclaredBudget(report, label, detail)
      if (detail.outcome === 'interrupted') continue
      if (detail.initialDigest !== frozen.snapshot.digest) {
        throw new Error(
          `evolution: the experiment report's ${label} ran from workspace digest ${detail.initialDigest}, not the frozen snapshot ` +
            `${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`,
        )
      }
      // 5a. What the side's runs really went through (S4-E §Q3), re-read from
      // the durable session logs of the side and its sub-executions.
      await assertSideModelBinding({ sources, detail, task, snapshot, selection: frozen.model, where: label })
      // 5b. And what they were bound to: the frozen production provider
      const run = detail.runId === undefined ? undefined : snapshot.runs.find(item => item.runId === detail.runId)
      if (run === undefined) {
        throw new Error(
          `evolution: the experiment report's ${label} cites run "${String(detail.runId)}", which the store no longer holds — its ` +
            'provider binding cannot be re-read, so the promotion is refused',
        )
      }
      await assertSideProviderBinding({ sample: frozenSample, detail, run, frozen, where: label })
      if (run.providerBinding !== undefined) sideRuns[side] = { run, binding: run.providerBinding }
    }
    if (sideRuns.baseline !== undefined && sideRuns.candidate !== undefined) {
      assertSidesAgree(frozen, candidate, sideRuns.baseline, sideRuns.candidate, `sample "${sample.taskId}"`)
    }
    await assertSampleInputsIntact({ sample: frozenSample, snapshot, productionWorkspace: frozen.snapshot.sourceDir })
  }
  // 6. The whole experiment's cost against the ceiling the freeze declared: the summed sides must fit it.
  assertExperimentCostWithinBudget(report)
  // 7. The model selection: the runs' own requests were checked above, and the deployment's current selection must still match the frozen one.
  const currentSelection = sources.modelSelection()
  if (
    currentSelection.provider !== frozen.model.provider ||
    currentSelection.model !== frozen.model.model ||
    currentSelection.reasoningEffort !== frozen.model.reasoningEffort ||
    currentSelection.maxTokens !== frozen.model.maxTokens
  ) {
    throw new Error(
      `evolution: the experiment froze model selection "${frozen.model.label}"` +
        `${frozen.model.reasoningEffort === undefined ? '' : ` (effort ${frozen.model.reasoningEffort})`}` +
        `${frozen.model.maxTokens === undefined ? '' : ` (maxTokens ${frozen.model.maxTokens})`}, but this deployment resolves ` +
        `"${currentSelection.label}"` +
        `${currentSelection.reasoningEffort === undefined ? '' : ` (effort ${currentSelection.reasoningEffort})`}` +
        `${currentSelection.maxTokens === undefined ? '' : ` (maxTokens ${currentSelection.maxTokens})`} now — the runs on record were ` +
        'not run under the selection this promotion would be judged against',
    )
  }
  // 8. The verdict.
  if (report.verdict !== (frozen.objective !== undefined ? 'improved' : 'fixed')) {
    throw new Error(
      `evolution: the two-sided experiment "${experiment.experimentId}" did not show a clean ${frozen.objective !== undefined ? 'improvement' : 'fix'} — ` +
        `${VERDICT_REFUSALS[report.verdict]}:\n${sampleVerdictLines(report.samples)
          .map(line => `- ${line}`)
          .join('\n')}`,
    )
  }
  return { experimentId: view.experimentId, report, reportPath: view.report }
}

/** The frozen sample one report sample was compared under. */
export function frozenSampleOf(report: ExperimentReport, taskId: string): FrozenSample {
  const sample = report.frozen.samples.find(item => item.taskId === taskId)
  if (sample === undefined) throw new Error(`evolution: the experiment report holds no frozen sample "${taskId}"`)
  return sample
}

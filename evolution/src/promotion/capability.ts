/** The capability promotion evidence gate: the skill gate's side checks plus the frozen row and admission binding.
 * @module dsh-singularity-evolution/promotion/capability */

import { SKILL_SIDECAR_FILE } from '@dangosys/dsh-singularity-task-runtime'
import type { RunProviderBinding, TaskRun } from '@dangosys/dsh-singularity-task'
import type { EvolutionProposal } from '../evolution.ts'
import {
  assertCapabilityCandidateAdmissible,
  capabilityRefusal,
  capabilityRowDigest,
  readPreparedCapability,
} from '../capability-candidate.ts'
import type { CapabilityRow, CapabilityRowIdentity, CapabilityStoreView } from '../capability-candidate.ts'
import { experimentLineage } from '../experiment/record.ts'
import type {
  ExperimentReport,
  ExperimentSideDetail,
  FrozenCapabilityRow,
  FrozenCapabilitySide,
  FrozenSample,
} from '../replay.ts'
import { canonicalJson } from '../replay.ts'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { SkillPromotionSources } from './shared.ts'
import { VERDICT_REFUSALS, identityLabel, sameIdentity, sampleVerdictLines } from './shared.ts'
import {
  assertCostWithinDeclaredBudget,
  assertExperimentCostWithinBudget,
  assertJudgeUnchanged,
  assertSampleInputsIntact,
  assertSideEvidence,
  assertSideModelBinding,
  experimentEvidence,
  readSideSnapshotFile,
} from './binding.ts'
import { frozenSampleOf } from './skill.ts'

/** What a capability promotion proved, for the caller to report. */
export interface CapabilityPromotionEvidence {
  readonly rowName: string
  readonly rowDigest: string
  /** The new execution skill the candidate installs, when it carries one. */
  readonly newSkill?: string
  /** The completed two-sided capability experiment the promotion rests on. */
  readonly experimentId: string
  readonly report: ExperimentReport
  readonly reportPath: string
}

/** The store a capability gate reads, resolved by the caller from its own context. */
export interface CapabilityPromotionSources extends SkillPromotionSources {
  /** The store as it stands right now — the effective capability table, the verifier vocabulary and every skill root. */
  store(): Promise<CapabilityStoreView>
  /** The row's own admission pre-check refusals (`precheckReplacedCapabilityRow`), one entry per refusal. */
  rowRefusals(row: CapabilityRow, sandboxSkillRoot: string | undefined): Promise<readonly string[]>
}

/** Whether one frozen capability identity is the row the candidate prepared: name, digest and canonical bytes must all agree. */
export function sameCapabilityRow(left: FrozenCapabilityRow, right: CapabilityRowIdentity): boolean {
  return (
    left.name === right.name && left.digest === right.digest && canonicalJson(left.entry) === canonicalJson(right.entry)
  )
}

/** Whether one recorded admission refusal is the refusal the experiment froze for this side. */
export function assertAdmissionMatchesFrozen(input: {
  sample: FrozenSample
  detail: ExperimentSideDetail
  where: string
  proposalId: string
}): void {
  const { sample, detail, where, proposalId } = input
  const frozen = sample.admission
  const recorded = detail.admission
  if (frozen === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} is not-admitted, but the frozen sample records no production refusal — a side ` +
        'that never ran needs the admission identity frozen before the experiment ran',
    )
  }
  if (recorded === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} is not-admitted without recording the runtime's own refusal`,
    )
  }
  if (recorded.source !== frozen.source) {
    throw new Error(
      `evolution: the experiment report's ${where} records an admission refusal from "${recorded.source}", but the experiment froze ` +
        `"${frozen.source}" — the side the evidence describes is not the side the experiment refused`,
    )
  }
  const same = (left: readonly string[], right: readonly string[]): boolean =>
    [...left].sort().join(', ') === [...right].sort().join(', ')
  if (!same(recorded.required, frozen.required) || !same(recorded.missing, frozen.missing)) {
    throw new Error(
      `evolution: the experiment report's ${where} records an admission refusal over rows [${recorded.required.join(', ')}] ` +
        `(missing: [${recorded.missing.join(', ')}]), but the frozen refusal is over [${frozen.required.join(', ')}] ` +
        `(missing: [${frozen.missing.join(', ')}]) — the record and the frozen admission identity disagree about what was refused`,
    )
  }
  if (recorded.proposalId !== proposalId) {
    throw new Error(
      `evolution: the experiment report's ${where} belongs the admission refusal to proposal "${recorded.proposalId}", not the ` +
        `proposal this promotion reads ("${proposalId}") — the gap a refusal stands for must be this candidate's own`,
    )
  }
  if (recorded.sourceRefs.length === 0) {
    throw new Error(
      `evolution: the experiment report's ${where} names no source refs for the refusal — the gap it stands for is untraceable`,
    )
  }
}

/** Whether one side's run binding is the identity the capability experiment froze for it. */
export async function assertCapabilitySideBinding(input: {
  sample: FrozenSample
  detail: ExperimentSideDetail
  run: TaskRun
  frozen: ExperimentReport['frozen']
  where: string
}): Promise<void> {
  const { sample, detail, run, frozen, where } = input
  const expected: FrozenCapabilitySide | undefined =
    detail.side === 'candidate' ? sample.candidateProvider : sample.provider
  if (expected === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} has no frozen provider identity for its ${detail.side} side — a capability sample ` +
        'freezes one for each side before it runs, and a side the freeze does not describe cannot be read as evidence',
    )
  }
  const binding: RunProviderBinding | undefined = run.providerBinding
  if (binding === undefined) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} records no provider binding — which rows, servers and skills it resolved ` +
        'against cannot be re-read, so the frozen provider identity cannot be compared and the promotion is refused',
    )
  }
  const rows = [...binding.capabilities].sort()
  if (rows.join(', ') !== [...expected.capabilities].sort().join(', ')) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound capabilities [${rows.join(', ') || 'none'}] but the experiment froze ` +
        `[${expected.capabilities.join(', ') || 'none'}] for the ${detail.side} side — the rows this side ran under are not the frozen ones`,
    )
  }
  if (binding.registryRevision !== expected.registryRevision) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound registry revision ${binding.registryRevision}, but the experiment froze ` +
        `${expected.registryRevision} for the ${detail.side} side — a row, a tool label or a provider contract moved since the freeze, ` +
        `so the ${detail.side} side did not run under the configuration the experiment froze for it`,
    )
  }
  const servers = [...binding.mcpServers].map(server => server.serverName).sort()
  if (servers.join(', ') !== [...expected.mcpServers].sort().join(', ')) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound MCP servers [${servers.join(', ') || 'none'}] but the experiment froze ` +
        `[${expected.mcpServers.join(', ') || 'none'}] — the granted server plane moved since the freeze`,
    )
  }
  for (const server of binding.mcpServers) {
    if (server.templateDigest === null) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound MCP server "${server.serverName}" with no resolvable template — the run ` +
          'recorded no identity for the server it was granted, so the frozen server plane cannot be compared',
      )
    }
  }
  if (expected.preset !== null && run.agentPreset !== expected.preset) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} ran under agent preset ${run.agentPreset === undefined ? '(none)' : `"${run.agentPreset}"`}, ` +
        `but the frozen provider identity declares "${expected.preset}" — the preset plane this side ran under is not the frozen one`,
    )
  }
  const frozenSkills = new Map(expected.skills.map(skill => [skill.name, skill]))
  const boundSkills = new Map(binding.skills.map(skill => [skill.name, skill]))
  for (const name of boundSkills.keys()) {
    if (!frozenSkills.has(name)) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}", which the frozen provider identity does not resolve ` +
          `(frozen: ${expected.skills.map(skill => skill.name).join(', ') || 'none'}) — content the freeze never admitted reached this run`,
      )
    }
  }
  for (const [name, frozenSkill] of frozenSkills) {
    const bound = boundSkills.get(name)
    if (bound === undefined) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound no skill "${name}", which the frozen provider identity resolves — the ` +
          'run under this side did not load content the freeze named',
      )
    }
    if (
      bound.role !== frozenSkill.role ||
      (bound.contractDigest ?? null) !== frozenSkill.contractDigest ||
      bound.contentDigest !== frozenSkill.contentDigest
    ) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}" as ${bound.role} declaration ` +
          `${bound.contractDigest ?? '(none)'} content ${bound.contentDigest}, but the frozen identity is ${frozenSkill.role} declaration ` +
          `${frozenSkill.contractDigest ?? '(none)'} content ${frozenSkill.contentDigest} — the provider this side loaded is not the one the ` +
          'experiment froze for it',
      )
    }
  }
  const candidate = frozen.candidate
  if (candidate === undefined || detail.side !== 'candidate') return
  const frozenFiles: readonly { file: string; sha256: string }[] = [
    { file: 'SKILL.md', sha256: candidate.sha256 },
    ...(candidate.contract === undefined ? [] : [{ file: SKILL_SIDECAR_FILE, sha256: candidate.contract.sha256 }]),
  ]
  if (binding.snapshotRoot === undefined) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound the new skill "${candidate.name}" but records no snapshot root — the bytes ` +
        'it loaded cannot be re-read, so the frozen content identity cannot be compared',
    )
  }
  for (const frozenFile of frozenFiles) {
    const bytes = await readSideSnapshotFile({
      snapshotRoot: binding.snapshotRoot,
      name: candidate.name,
      file: frozenFile.file,
      where,
      runId: run.runId,
      side: detail.side,
    })
    const digest = sha256Hex(bytes)
    if (digest !== frozenFile.sha256) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound the new skill "${candidate.name}" whose ${frozenFile.file} hashes to ` +
          `${digest}, but the experiment froze ${frozenFile.sha256} — the bytes this side ran are not the frozen ones`,
      )
    }
  }
}

/** The capability promotion gate (A6 §F.4 "候选支持范围固定"): the skill gate's checks over the frozen row and its side bindings. */
export async function assertCapabilityPromotionEvidence(
  sources: CapabilityPromotionSources,
  proposal: EvolutionProposal,
): Promise<CapabilityPromotionEvidence> {
  const prepared = await readPreparedCapability(sources.root, proposal)
  const store = await sources.store()
  const current = store.table[prepared.row.name] ?? null
  const currentDigest = current === null ? null : capabilityRowDigest(current)
  const baseline = proposal.prepared?.capabilityBaseline ?? null
  const preparedDigest = baseline === null ? null : baseline.digest
  if (currentDigest !== preparedDigest) {
    throw capabilityRefusal(
      'capability-registry-changed',
      `the capability registry row "${prepared.row.name}" reads ${currentDigest ?? 'no row'}, not the state prepare recorded ` +
        `(${preparedDigest ?? 'no row'}) — a row a third party moved is a conflict, so create a new candidate from the current registry ` +
        'state and re-evaluate it; nothing was promoted',
    )
  }
  await assertCapabilityCandidateAdmissible(
    store,
    { row: prepared.row, ...(prepared.skill === undefined ? {} : { skill: prepared.skill }) },
    current,
  )
  const refusals = await sources.rowRefusals(prepared.row, prepared.skillRoot)
  if (refusals.length > 0) {
    throw capabilityRefusal(
      'skill-candidate-invalid',
      `capability candidate "${proposal.proposalId}" grants providers this deployment refuses:\n` +
        `${refusals.map(line => `- ${line}`).join('\n')}`,
    )
  }
  // The row as prepare recorded it: the identity the evidence must be about.
  const preparedRow: CapabilityRowIdentity = { ...prepared.row, digest: proposal.prepared!.capabilityRow!.digest }
  // 5-8. The evaluation evidence: the experiment the candidate was evaluated
  // by, its report, and every fact that report rests on.
  const { view, report } = await experimentEvidence(sources, proposal)
  const frozen = report.frozen
  const capability = frozen.capability
  if (capability === undefined) {
    throw capabilityRefusal(
      'capability-evidence-absent',
      `experiment "${view.experimentId}" froze a ${frozen.candidate === undefined ? 'candidate with no capability identity' : 'skill object identity'} ` +
        `for proposal "${proposal.proposalId}", which is a capability candidate — the evidence belongs to another kind of candidate`,
    )
  }
  if (!sameCapabilityRow(capability.row, preparedRow)) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze row "${capability.row.name}" (${capability.row.digest}), but proposal ` +
        `"${proposal.proposalId}" now prepares row "${prepared.row.name}" (${proposal.prepared!.capabilityRow!.digest}) — the evidence ` +
        'belongs to different bytes; propose a new candidate and evaluate it',
    )
  }
  const recordedBaseline = baseline
  if ((capability.baseline === null) !== (recordedBaseline === null)) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze ${capability.baseline === null ? 'no baseline row' : `baseline row ${capability.baseline.digest}`} , ` +
        `but proposal "${proposal.proposalId}" was prepared against ` +
        `${recordedBaseline === null ? 'no row' : `row ${recordedBaseline.digest}`} — the candidate was evaluated against another registry state`,
    )
  }
  if (
    capability.baseline !== null &&
    recordedBaseline !== null &&
    !sameCapabilityRow(capability.baseline, recordedBaseline)
  ) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze baseline row ${capability.baseline.digest}, but prepare recorded ${recordedBaseline.digest} ` +
        '— the row this candidate would roll back to is not the row the experiment evaluated against',
    )
  }
  const preparedSkill = proposal.prepared?.skillContent
  if ((frozen.candidate === undefined) !== (preparedSkill === undefined)) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze ${frozen.candidate === undefined ? 'no new skill object' : `the new skill ${identityLabel(frozen.candidate)}`}, ` +
        `but proposal "${proposal.proposalId}" prepares ${preparedSkill === undefined ? 'no new skill object' : identityLabel(preparedSkill)} — the ` +
        'candidate the experiment evaluated is not the candidate this promotion would write',
    )
  }
  if (frozen.candidate !== undefined && preparedSkill !== undefined && !sameIdentity(frozen.candidate, preparedSkill)) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze candidate ${identityLabel(frozen.candidate)} but proposal "${proposal.proposalId}" now prepares ` +
        `${identityLabel(preparedSkill)} — the evidence belongs to different candidate bytes; propose a new candidate and evaluate it`,
    )
  }
  if (frozen.productionBaseline !== undefined) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze a production skill baseline, which a capability candidate never has — its production baseline ` +
        'is the registry row it moves',
    )
  }
  const sourceRefs = [...(proposal.sourceRefs ?? [])]
  if (canonicalJson([...capability.sourceRefs].sort()) !== canonicalJson([...sourceRefs].sort())) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `experiment "${view.experimentId}" froze the gap it came from as [${capability.sourceRefs.join(', ')}], but proposal ` +
        `"${proposal.proposalId}" records [${sourceRefs.join(', ')}] — the refusal the evidence rests on belongs to another proposal`,
    )
  }
  const storeId = view.storeId
  if (storeId === undefined) {
    throw capabilityRefusal(
      'capability-evidence-absent',
      `experiment "${view.experimentId}" records no task store, so the runs its sides cite cannot be re-read — run the two-sided ` +
        'experiment again so its evidence names the store it ran in',
    )
  }
  const snapshot = await sources.task.openStore(storeId)
  const vocabulary = await sources.verifierVocabulary()
  if (vocabulary === undefined) {
    throw capabilityRefusal(
      'capability-evidence-unverifiable',
      "the verifier registry cannot be listed in this context, so the judges behind the experiment's verdicts cannot be re-checked — " +
        'the promotion is refused rather than granted on unverifiable evidence',
    )
  }
  for (const sample of report.samples) {
    const frozenSample = frozenSampleOf(report, sample.taskId)
    const candidateLabel = `sample "${sample.taskId}" candidate side`
    // 7. The candidate side: a real run, verified, every frozen criterion passed.
    const candidateTask = assertSideEvidence({
      sample: frozenSample,
      detail: sample.candidate,
      experimentId: view.experimentId,
      snapshot,
      where: candidateLabel,
    })
    assertJudgeUnchanged(frozenSample, sample.candidate, candidateLabel, vocabulary)
    assertCostWithinDeclaredBudget(report, candidateLabel, sample.candidate)
    if (sample.candidate.outcome !== 'verified') {
      throw capabilityRefusal(
        'capability-candidate-not-verified',
        `the candidate side of ${candidateLabel} settled "${sample.candidate.outcome}" — a capability fix is a run that passed the ` +
          'frozen acceptance, never an admission that merely went through; the promotion is refused',
      )
    }
    const failed = sample.candidate.criteria.filter(criterion => criterion.verdict !== 'pass')
    if (failed.length > 0) {
      throw capabilityRefusal(
        'capability-candidate-not-verified',
        `the candidate side of ${candidateLabel} reports ${failed.map(criterion => `"${criterion.criterionId}" ${criterion.verdict}`).join(', ')} — ` +
          'every frozen criterion must pass on the candidate side before the candidate may be promoted',
      )
    }
    if (sample.candidate.initialDigest !== frozen.snapshot.digest) {
      throw capabilityRefusal(
        'capability-evidence-drifted',
        `the candidate side of ${candidateLabel} ran from workspace digest ${sample.candidate.initialDigest}, not the frozen snapshot ` +
          `${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`,
      )
    }
    await assertSideModelBinding({
      sources,
      detail: sample.candidate,
      task: candidateTask,
      snapshot,
      selection: frozen.model,
      where: candidateLabel,
    })
    const candidateRun =
      sample.candidate.runId === undefined
        ? undefined
        : snapshot.runs.find(item => item.runId === sample.candidate.runId)
    if (candidateRun === undefined) {
      throw capabilityRefusal(
        'capability-evidence-absent',
        `the experiment report's ${candidateLabel} cites run "${String(sample.candidate.runId)}", which the store no longer holds — its ` +
          'provider binding cannot be re-read, so the promotion is refused',
      )
    }
    await assertCapabilitySideBinding({
      sample: frozenSample,
      detail: sample.candidate,
      run: candidateRun,
      frozen,
      where: candidateLabel,
    })
    // 6. The baseline side: the frozen refusal, or a real run under production.
    const baselineLabel = `sample "${sample.taskId}" baseline side`
    if (frozenSample.admission !== undefined) {
      if (sample.baseline.outcome !== 'not-admitted') {
        throw capabilityRefusal(
          'capability-baseline-not-refused',
          `the experiment froze the production configuration's refusal of ${baselineLabel}, but the record settled ` +
            `"${sample.baseline.outcome}" — the baseline the candidate is compared against is not the refusal the experiment proved`,
        )
      }
      assertAdmissionMatchesFrozen({
        sample: frozenSample,
        detail: sample.baseline,
        where: baselineLabel,
        proposalId: proposal.proposalId,
      })
      const lineage = experimentLineage(view.experimentId, sample.taskId, 'baseline')
      const persisted = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
      if (persisted !== undefined) {
        throw capabilityRefusal(
          'capability-baseline-not-refused',
          `${baselineLabel} is recorded not-admitted, but the store holds replayed task "${persisted.taskId}" of this side's own lineage — ` +
            'a refused side produced no run, and a failure run standing in its place is not evidence',
        )
      }
    } else {
      if (sample.baseline.outcome === 'not-admitted') {
        throw capabilityRefusal(
          'capability-baseline-not-refused',
          `${baselineLabel} is recorded not-admitted, but the experiment froze the production configuration as admitting it — the record ` +
            'and the frozen identity disagree about whether the baseline ran',
        )
      }
      const baselineTask = assertSideEvidence({
        sample: frozenSample,
        detail: sample.baseline,
        experimentId: view.experimentId,
        snapshot,
        where: baselineLabel,
      })
      assertJudgeUnchanged(frozenSample, sample.baseline, baselineLabel, vocabulary)
      assertCostWithinDeclaredBudget(report, baselineLabel, sample.baseline)
      if (sample.baseline.initialDigest !== frozen.snapshot.digest) {
        throw capabilityRefusal(
          'capability-evidence-drifted',
          `the baseline side of ${baselineLabel} ran from workspace digest ${sample.baseline.initialDigest}, not the frozen snapshot ` +
            `${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`,
        )
      }
      await assertSideModelBinding({
        sources,
        detail: sample.baseline,
        task: baselineTask,
        snapshot,
        selection: frozen.model,
        where: baselineLabel,
      })
      const baselineRun =
        sample.baseline.runId === undefined
          ? undefined
          : snapshot.runs.find(item => item.runId === sample.baseline.runId)
      if (baselineRun === undefined) {
        throw capabilityRefusal(
          'capability-evidence-absent',
          `the experiment report's ${baselineLabel} cites run "${String(sample.baseline.runId)}", which the store no longer holds — its ` +
            'provider binding cannot be re-read, so the promotion is refused',
        )
      }
      await assertCapabilitySideBinding({
        sample: frozenSample,
        detail: sample.baseline,
        run: baselineRun,
        frozen,
        where: baselineLabel,
      })
    }
    await assertSampleInputsIntact({ sample: frozenSample, snapshot, productionWorkspace: frozen.snapshot.sourceDir })
  }
  assertExperimentCostWithinBudget(report)
  const currentSelection = sources.modelSelection()
  if (
    currentSelection.provider !== frozen.model.provider ||
    currentSelection.model !== frozen.model.model ||
    currentSelection.reasoningEffort !== frozen.model.reasoningEffort ||
    currentSelection.maxTokens !== frozen.model.maxTokens
  ) {
    throw capabilityRefusal(
      'capability-evidence-drifted',
      `the experiment froze model selection "${frozen.model.label}", but this deployment resolves "${currentSelection.label}" now — the runs ` +
        'on record were not run under the selection this promotion would be judged against',
    )
  }
  const degraded = report.samples.filter(sample => sample.verdict === 'regressed')
  if (report.verdict !== 'fixed') {
    throw capabilityRefusal(
      'capability-not-fixed',
      `the two-sided capability experiment "${view.experimentId}" did not show a clean fix — ` +
        `${VERDICT_REFUSALS[report.verdict]}:\n${sampleVerdictLines(report.samples)
          .map(line => `- ${line}`)
          .join('\n')}` +
        (degraded.length === 0 ? '' : ` — degraded sample(s): ${degraded.map(sample => sample.taskId).join(', ')}`),
    )
  }
  return {
    rowName: prepared.row.name,
    rowDigest: proposal.prepared!.capabilityRow!.digest,
    ...(prepared.skill === undefined ? {} : { newSkill: prepared.skill.name }),
    experimentId: view.experimentId,
    report,
    reportPath: view.report,
  }
}

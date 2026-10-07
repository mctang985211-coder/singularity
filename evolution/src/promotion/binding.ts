/** The per-side evidence checks: frozen inputs, judge, model and provider bindings, and cost within the declared budget.
 * @module dsh-singularity-evolution/promotion/binding */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SKILL_SIDECAR_FILE, skillContentDigest } from '@dangosys/dsh-singularity-task-runtime'
import type {
  ReviewCriterion,
  ReviewRecord,
  RunProviderBinding,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { EvolutionProposal } from '../evolution.ts'
import { costOf, experimentLineage, evidenceRefsOf } from '../experiment/record.ts'
import type { ExperimentView } from '../experiment/freeze.ts'
import { buildExperimentReport } from '../experiment/record.ts'
import type {
  ExperimentReport,
  ExperimentObjective,
  ExperimentSide,
  ExperimentSideDetail,
  FrozenCriterion,
  FrozenProviderIdentity,
  FrozenSample,
  ModelSelection,
  SkillContentIdentity,
} from '../replay.ts'
import { assertExperimentReport, canonicalJson, digestOf, protectedInputsDigest } from '../replay.ts'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { SkillPromotionSources, VerifierVocabulary } from './shared.ts'
import { identityLabel, noExperimentRefusal, reportBytes } from './shared.ts'
import { assertOutcomeEvidence } from '../experiment/outcome.ts'

/** Whether one report side's evidence exists in the store as the side says it does. */
export function assertSideEvidence(input: {
  sample: FrozenSample
  detail: ExperimentSideDetail
  experimentId: string
  snapshot: TaskSnapshot
  where: string
  objective?: ExperimentObjective
}): TaskInstance | undefined {
  const { sample, detail, experimentId, snapshot, where } = input
  if (detail.outcome === 'interrupted') return undefined
  const lineage = experimentLineage(experimentId, sample.taskId, detail.side)
  const task: TaskInstance | undefined = snapshot.tasks.find(item => item.objective?.startsWith(`[${lineage}] `))
  if (task === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} does not cite a replayed task this experiment created — the store holds no ` +
        `task of lineage "${lineage}" (${detail.taskId ?? 'no task'}/${detail.runId ?? 'no run'}); a side that is not one of this ` +
        "experiment's own runs is not a baseline, whatever the record says",
    )
  }
  if (detail.taskId !== task.taskId) {
    throw new Error(
      `evolution: the experiment report's ${where} names task "${String(detail.taskId)}" but the run it cites belongs to replayed ` +
        `task "${task.taskId}" of this experiment's own lineage — the identity a promotion reads must be the task the run ran as`,
    )
  }
  if (detail.runId === undefined || !task.runIds.includes(detail.runId)) {
    throw new Error(
      `evolution: the experiment report's ${where} cites run "${String(detail.runId)}", which no run of this experiment's own ` +
        `replay (lineage ${lineage}) created — the historical record locates the case and is never a baseline`,
    )
  }
  const runId = detail.runId
  const review: ReviewRecord | undefined = snapshot.reviews.find(item => item.runId === runId)
  if (review === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} cites run "${runId}", which the store settles with no review record — a side ` +
        'without a terminal review record is not a settled run',
    )
  }
  if (review.taskId !== task.taskId) {
    throw new Error(
      `evolution: the review record for run "${runId}" belongs to task "${review.taskId}", not the replayed task "${task.taskId}" ` +
        `the experiment report's ${where} cites`,
    )
  }
  if (review.outcome !== detail.outcome) {
    throw new Error(
      `evolution: the experiment report's ${where} reports outcome "${detail.outcome}" but the store's review record for run ` +
        `"${runId}" settled "${review.outcome}" — the report and the store disagree about what ran`,
    )
  }
  if (detail.reviewRef !== `${task.taskId}#${runId}`) {
    throw new Error(
      `evolution: the experiment report's ${where} cites review ref "${String(detail.reviewRef)}" but its run "${runId}" settles ` +
        `as "${task.taskId}#${runId}" — the reference a promotion reads must name the record that exists`,
    )
  }
  if (input.objective === 'tool-call-reduction' && canonicalJson(detail.cost) !== canonicalJson(costOf(review, snapshot))) {
    throw new Error(`evolution: the experiment report's ${where} cost disagrees with the executed Run subtree's review counters`)
  }
  const recorded: readonly ReviewCriterion[] = review.criteria ?? []
  const reported: readonly ReviewCriterion[] = detail.criteria
  if (recorded.length > 0) {
    const byId = new Map(recorded.map(criterion => [criterion.criterionId, criterion]))
    for (const criterion of reported) {
      const stored = byId.get(criterion.criterionId)
      if (stored === undefined) {
        throw new Error(
          `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}", which the store's review ` +
            `record for run "${runId}" does not carry`,
        )
      }
      if (
        stored.verdict !== criterion.verdict ||
        stored.verifierId !== criterion.verifierId ||
        stored.verifierVersion !== criterion.verifierVersion
      ) {
        throw new Error(
          `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" as ` +
            `${criterion.verdict}${criterion.verifierId === undefined ? '' : ` (${criterion.verifierId}${criterion.verifierVersion === undefined ? '' : `@${criterion.verifierVersion}`})`}, ` +
            `but run "${runId}" settled it as ${stored.verdict}${stored.verifierId === undefined ? '' : ` (${stored.verifierId}${stored.verifierVersion === undefined ? '' : `@${stored.verifierVersion}`})`} — ` +
            'the verdicts a promotion reads are the ones the store recorded',
        )
      }
    }
    if (reported.length !== recorded.length) {
      throw new Error(
        `evolution: the experiment report's ${where} carries ${reported.length} criterion verdicts while run "${runId}" settled ` +
          `${recorded.length} — a side must report exactly the criteria its review record carries`,
      )
    }
  }
  const expected = evidenceRefsOf(snapshot, runId, review)
  const reportedRefs = [...detail.evidenceRefs].sort()
  const storedRefs = [...expected].sort()
  if (reportedRefs.length !== storedRefs.length || reportedRefs.some((ref, index) => ref !== storedRefs[index])) {
    throw new Error(
      `evolution: the experiment report's ${where} cites evidence [${detail.evidenceRefs.join(', ')}] but run "${runId}" holds ` +
        `[${expected.join(', ')}] — the evidence a promotion reads must be the bundles that run produced`,
    )
  }
  for (const ref of detail.evidenceRefs) {
    const bundle = snapshot.evidence.find(item => item.evidenceId === ref)
    if (bundle === undefined) {
      throw new Error(
        `evolution: the experiment report's ${where} cites evidence "${ref}", which the store does not hold`,
      )
    }
    if (bundle.taskRunId !== runId) {
      throw new Error(
        `evolution: the experiment report's ${where} cites evidence "${ref}" of run "${String(bundle.taskRunId)}", not of its own ` +
          `run "${runId}" — evidence from another run cannot stand for this side`,
      )
    }
  }
  if (detail.initialDigest === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} settled a run and records no workspace digest — the frozen input the side ran ` +
        'from cannot be re-proved',
    )
  }
  return task
}

/** The store's contract of one sample, as the freeze derived its digest: objective, criteria, required capabilities. */
export function contractDigestOf(task: TaskInstance): string {
  return digestOf({
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    requiredCapabilities: task.requestedCapabilities,
  })
}

/** Whether one frozen sample still stands as it was frozen: the store's contract, protected inputs and judge must all still match. */
export async function assertSampleInputsIntact(input: {
  sample: FrozenSample
  snapshot: TaskSnapshot
  productionWorkspace: string
}): Promise<void> {
  const { sample, snapshot, productionWorkspace } = input
  const task = snapshot.tasks.find(item => item.taskId === sample.taskId)
  if (task === undefined) {
    throw new Error(
      `evolution: the experiment froze sample "${sample.taskId}", which this graph's task store no longer holds — the case the ` +
        'candidate was evaluated against cannot be re-read, so the evidence cannot be re-checked',
    )
  }
  const digest = contractDigestOf(task)
  if (digest !== sample.contractDigest) {
    throw new Error(
      `evolution: sample "${sample.taskId}" changed since the experiment froze it (contract digest ${digest} != ` +
        `${sample.contractDigest}) — the case, its acceptance or its required capabilities moved, so the runs on record were judged ` +
        'against a contract this proposal is no longer evaluated against',
    )
  }
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []
  for (const frozen of sample.criteria) {
    const criterion = criteria.find(item => item.criterionId === frozen.criterionId)
    if (criterion === undefined) {
      throw new Error(
        `evolution: sample "${sample.taskId}" no longer carries the frozen criterion "${frozen.criterionId}"`,
      )
    }
    assertFrozenCriterionIntact(sample.taskId, frozen, criterion)
    for (const protectedInput of criterion.protectedInputs ?? []) {
      await assertProtectedInputIntact(sample.taskId, protectedInput, productionWorkspace)
    }
  }
}

/** One criterion's frozen identity against the store's current one. */
export function assertFrozenCriterionIntact(
  taskId: string,
  frozen: FrozenCriterion,
  criterion: {
    verificationMode?: string
    command?: string
    protectedInputs?: readonly { path: string; sha256: string }[]
  },
): void {
  const currentDigest = protectedInputsDigest(criterion.protectedInputs ?? [])
  if (
    criterion.verificationMode !== frozen.verificationMode ||
    criterion.command !== frozen.command ||
    currentDigest !== frozen.protectedInputsDigest
  ) {
    throw new Error(
      `evolution: criterion "${frozen.criterionId}" of sample "${taskId}" changed since the experiment froze it ` +
        `(mode ${String(criterion.verificationMode)}/${frozen.verificationMode}, protected inputs ${currentDigest} != ` +
        `${frozen.protectedInputsDigest}) — the acceptance the two sides ran under is no longer the frozen one`,
    )
  }
}

/** One declared protected input, re-read where the criterion's judge would read it. */
export async function assertProtectedInputIntact(
  taskId: string,
  input: { path: string; sha256: string },
  productionWorkspace: string,
): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(resolve(productionWorkspace, input.path))
  } catch (error) {
    throw new Error(
      `evolution: the protected input "${input.path}" of sample "${taskId}" cannot be read in the production workspace ` +
        `"${productionWorkspace}" (${error instanceof Error ? error.message : String(error)}) — the input the acceptance rests on ` +
        "is gone, so the experiment's judging cannot be re-proved",
    )
  }
  const digest = sha256Hex(bytes)
  if (digest !== input.sha256) {
    throw new Error(
      `evolution: the protected input "${input.path}" of sample "${taskId}" changed since the experiment froze it ` +
        `(sha256 ${digest} != ${input.sha256}) — a criterion whose input moved is not the criterion the candidate was judged by`,
    )
  }
}

/** Whether every criterion verdict a report side carries was decided by the judge the freeze pinned, at the version it pinned. */
export function assertJudgeUnchanged(
  sample: FrozenSample,
  detail: ExperimentSideDetail,
  where: string,
  vocabulary: VerifierVocabulary,
): void {
  const frozenById = new Map(sample.criteria.map(criterion => [criterion.criterionId, criterion]))
  for (const criterion of detail.criteria) {
    const frozen = frozenById.get(criterion.criterionId)
    if (frozen === undefined) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" of sample "${sample.taskId}", ` +
          'which the frozen block does not carry — a verdict outside the frozen acceptance is not evidence this promotion may read',
      )
    }
    if (criterion.verifierId === undefined) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" without the verifier that ` +
          'decided it — a verdict nobody can be recalled against is not evidence a promotion may read',
      )
    }
    if (criterion.verifierId !== frozen.verifierRef) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by verifier ` +
          `"${criterion.verifierId}", but the frozen block pinned "${frozen.verifierRef}" (${frozen.verifierAnchor}) — the verdicts a ` +
          'promotion reads must be the ones the frozen judge produced',
      )
    }
    if (criterion.verifierVersion !== frozen.verifierVersion) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by "${frozen.verifierRef}" ` +
          `at version ${criterion.verifierVersion === undefined ? '(none declared)' : criterion.verifierVersion}, but the block froze it ` +
          `at ${frozen.verifierVersion} (${frozen.verifierAnchor}) — a verdict belongs to the instance that judged, so a judge that ` +
          'moved since the freeze invalidates the evidence',
      )
    }
    if (!vocabulary.ids.includes(criterion.verifierId)) {
      throw new Error(
        `evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}", which is no longer ` +
          `registered (registered: ${vocabulary.ids.length === 0 ? 'none' : vocabulary.ids.join(', ')}) — the judge moved, so the ` +
          'verdicts on record cannot be reproduced',
      )
    }
    const current = vocabulary.versions[criterion.verifierId]
    if (criterion.verifierVersion !== current) {
      throw new Error(
        `evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}" at version ` +
          `${criterion.verifierVersion === undefined ? '(none declared)' : criterion.verifierVersion}, but the registered instance ` +
          `declares ${current === undefined ? '(none)' : current} now — a verdict belongs to the instance that judged, so a ` +
          're-registered version invalidates the evidence',
      )
    }
  }
}

/** One `request/header` event's call configuration, as the request identity it is. */
export interface RequestIdentity {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

/** Every request identity one session's own log records, in order: one entry per `request/header` event. */
export function requestIdentities(events: readonly SessionEvent[]): RequestIdentity[] {
  const identities: RequestIdentity[] = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = (
      event.data as {
        header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown; maxTokens?: unknown } }
      }
    ).header?.config
    if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') continue
    identities.push({
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
    })
  }
  return identities
}

/** Whether one request identity is the frozen selection: the route exactly, and each declared option exactly. */
export function requestMatchesSelection(identity: RequestIdentity, selection: ModelSelection): boolean {
  if (identity.provider !== selection.provider || identity.model !== selection.model) return false
  if (selection.reasoningEffort !== undefined && identity.reasoningEffort !== selection.reasoningEffort) return false
  if (selection.maxTokens !== undefined && identity.maxTokens !== selection.maxTokens) return false
  return true
}

/** Whether one run is the runtime's own no-worker criteria replay — the one run a promotion accepts without a worker. */
export function isNoWorkerRun(run: TaskRun): boolean {
  return run.executionPhase === 'submitted' && run.submission?.origin === 'runtime'
}

/** The side's task and every task below it — the subtree whose runs are this side's execution. */
export function subtreeOf(snapshot: TaskSnapshot, rootTaskId: string): TaskInstance[] {
  const tasks = new Map(snapshot.tasks.map(task => [task.taskId, task]))
  const root = tasks.get(rootTaskId)
  if (root === undefined) return []
  const found: TaskInstance[] = []
  const pending = [root]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const task = pending.pop() as TaskInstance
    if (seen.has(task.taskId)) continue
    seen.add(task.taskId)
    found.push(task)
    for (const child of snapshot.tasks) if (child.parentTaskId === task.taskId) pending.push(child)
  }
  return found
}

/** The model half of the gate (S4-E §Q3): what the side's runs *really* went through, against the frozen selection. */
export async function assertSideModelBinding(input: {
  sources: SkillPromotionSources
  detail: ExperimentSideDetail
  task: TaskInstance | undefined
  snapshot: TaskSnapshot
  selection: ModelSelection
  where: string
}): Promise<void> {
  const { sources, detail, task, snapshot, selection, where } = input
  if (detail.outcome === 'interrupted' || task === undefined) return
  const runs: TaskRun[] = []
  for (const subtreeTask of subtreeOf(snapshot, task.taskId)) {
    for (const runId of subtreeTask.runIds) {
      const run = snapshot.runs.find(item => item.runId === runId)
      if (run === undefined) {
        throw new Error(
          `evolution: the experiment report's ${where} names task "${subtreeTask.taskId}" of this experiment, but the store holds ` +
            `no run "${runId}" of it — the execution this side rests on cannot be re-read`,
        )
      }
      runs.push(run)
    }
  }
  for (const run of runs) {
    if (isNoWorkerRun(run)) continue
    let events: readonly SessionEvent[] | undefined
    try {
      events = await sources.sessionLog(run.sessionId)
    } catch (error) {
      throw new Error(
        `evolution: the session log of run "${run.runId}" (session "${run.sessionId}") of the ${where} cannot be read ` +
          `(${error instanceof Error ? error.message : String(error)}) — the requests that run really made are the evidence this ` +
          'promotion compares against the frozen selection, so a run whose log is gone cannot be promoted on',
      )
    }
    if (events === undefined) {
      throw new Error(
        `evolution: this deployment cannot read session logs (sessionQuery.readSession is unavailable), so the requests of run ` +
          `"${run.runId}" of the ${where} cannot be compared against the frozen model selection "${selection.label}" — the promotion ` +
          'is refused rather than granted on an unverifiable model binding',
      )
    }
    const identities = requestIdentities(events)
    if (identities.length === 0) {
      throw new Error(
        `evolution: run "${run.runId}" (session "${run.sessionId}") of the ${where} recorded no request at all, so the frozen model ` +
          `selection "${selection.label}" cannot be shown to be what it ran under — a run with no request identity to check is refused ` +
          "(the runtime's own criteria replay, the one no-worker path, is exempt; this run records a worker)",
      )
    }
    for (const identity of identities) {
      if (requestMatchesSelection(identity, selection)) continue
      throw new Error(
        `evolution: run "${run.runId}" (session "${run.sessionId}") of the ${where} really made its requests on ` +
          `${identity.provider}/${identity.model}${identity.reasoningEffort === undefined ? '' : ` (effort ${identity.reasoningEffort})`}` +
          `${identity.maxTokens === undefined ? '' : ` (maxTokens ${identity.maxTokens})`}, not on the frozen selection ` +
          `"${selection.label}"${selection.reasoningEffort === undefined ? '' : ` (effort ${selection.reasoningEffort})`}` +
          `${selection.maxTokens === undefined ? '' : ` (maxTokens ${selection.maxTokens})`} — the runs a promotion reads must be the ` +
          'runs the frozen selection was fixed for',
      )
    }
  }
}

/** Whether one side's run binding is the provider identity the experiment froze for it. */
export async function assertSideProviderBinding(input: {
  sample: FrozenSample
  detail: ExperimentSideDetail
  run: TaskRun
  frozen: ExperimentReport['frozen']
  where: string
}): Promise<void> {
  const { sample, detail, run, frozen, where } = input
  if (detail.outcome === 'interrupted') return
  const expected: FrozenProviderIdentity | undefined = sample.provider
  const improved = frozen.candidate
  if (expected === undefined || improved === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} cites a run, but the frozen sample records no production provider identity or no ` +
        'candidate object to check it against — a skill experiment freezes both before its sides run',
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
        `[${expected.capabilities.join(', ') || 'none'}] — the rows this side ran under are not the frozen production configuration's`,
    )
  }
  const expectedRevision = detail.side === 'candidate' ? expected.candidateRegistryRevision : expected.registryRevision
  if (binding.registryRevision !== expectedRevision) {
    const expectation =
      detail.side === 'candidate'
        ? "the frozen provider list with the improved skill's own candidate declaration substituted"
        : 'the production configuration as it stood at the freeze'
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound registry revision ${binding.registryRevision}, but the experiment froze ` +
        `${expectedRevision} for the ${detail.side} side — a capability row, a tool label or a declared provider contract moved since ` +
        `the freeze, so the ${detail.side} side did not run under the configuration the experiment froze for it (its expectation is ` +
        `${expectation}, the revision that absorbs those declarations)`,
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
    if (server.templateDigest === null || expected.mcpBindings?.find(item => item.serverName === server.serverName)?.templateDigest !== server.templateDigest) {
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
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}", which the frozen production configuration does not ` +
          `resolve (frozen: ${expected.skills.map(skill => skill.name).join(', ') || 'none'}) — content the freeze never admitted reached this run`,
      )
    }
  }
  for (const [name, expectedSkill] of frozenSkills) {
    const bound = boundSkills.get(name)
    if (bound === undefined) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound no skill "${name}", which the frozen production configuration resolves ` +
          '— the run under this side did not load content the freeze named',
      )
    }
    if (bound.role !== expectedSkill.role) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}" as ${bound.role}, but the experiment froze it as ` +
          `${expectedSkill.role} — the role production resolved is the role both sides must keep (the frozen candidate replaced that ` +
          "object's bytes, never its kind); a candidate that turned the provider into another kind of object is refused rather than " +
          'promoted as something the experiment never evaluated',
      )
    }
    if (name !== improved.name) {
      // Every other provider: one production identity, both sides.
      if ((bound.contractDigest ?? null) !== expectedSkill.contractDigest) {
        throw new Error(
          `evolution: run "${run.runId}" of the ${where} bound skill "${name}" declaration ` +
            `${bound.contractDigest === null ? '(none)' : bound.contractDigest}, but the frozen identity is ` +
            `${expectedSkill.contractDigest === null ? '(none)' : expectedSkill.contractDigest} — the provider this side loaded is not ` +
            'the one the experiment froze',
        )
      }
      if (bound.contentDigest !== expectedSkill.contentDigest) {
        throw new Error(
          `evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production ` +
            `configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`,
        )
      }
      continue
    }
    // The promoted skill's own content: each side is compared against the object its frozen half records.
    const sideObject = detail.side === 'candidate' ? improved : frozen.productionBaseline
    if (sideObject === undefined) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound the improved skill "${name}", but the frozen block records no ` +
          "production baseline to compare the baseline side's object against — the evidence predates the two-file baseline and is " +
          'refused rather than promoted against a shape nobody froze',
      )
    }
    const expectedContract = sideObject.contract?.contractDigest ?? null
    // The object's own bytes as the run's binding records them: this build's
    const expectedContentDigest = skillContentDigest({ skillMdSha256: sideObject.sha256, resources: sideObject.resources ?? [] })
    if ((bound.contractDigest ?? null) !== expectedContract) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}" declaration ` +
          `${bound.contractDigest === null ? '(none)' : bound.contractDigest}, but the ${detail.side} side's frozen object declares ` +
          `${expectedContract === null ? '(none)' : expectedContract} (${identityLabel(sideObject)}) — the promoted skill's own sidecar is ` +
          'the one difference the candidate overlay is there to produce, and each side must bind the declaration of the object it loaded',
      )
    }
    if (bound.contentDigest !== expectedContentDigest) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the ${detail.side} ` +
          `side's frozen object hashes to ${sideObject.sha256} (content digest ${expectedContentDigest}) — the content this side loaded ` +
          'is not the frozen one',
      )
    }
  }
  // The promoted skill's own bytes: read from the snapshot the run bound, so the comparison is over the bytes it ran.
  const target = boundSkills.get(improved.name)
  if (target !== undefined) {
    const sideObject = detail.side === 'candidate' ? improved : frozen.productionBaseline
    if (sideObject === undefined) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound the improved skill "${improved.name}" but the frozen block ` +
          'records no production baseline — the bytes the baseline side loaded cannot be re-proved',
      )
    }
    if (binding.snapshotRoot === undefined) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${improved.name}" but records no snapshot root — ` +
          'the bytes it loaded cannot be re-read, so the frozen content identity cannot be compared',
      )
    }
    const frozenFiles: readonly { file: string; sha256: string }[] = [
      { file: 'SKILL.md', sha256: sideObject.sha256 },
      ...(sideObject.contract === undefined ? [] : [{ file: SKILL_SIDECAR_FILE, sha256: sideObject.contract.sha256 }]),
    ]
    for (const frozenFile of frozenFiles) {
      const bytes = await readSideSnapshotFile({
        snapshotRoot: binding.snapshotRoot,
        name: improved.name,
        file: frozenFile.file,
        where,
        runId: run.runId,
        side: detail.side,
      })
      const digest = sha256Hex(bytes)
      if (digest !== frozenFile.sha256) {
        throw new Error(
          `evolution: run "${run.runId}" of the ${where} bound skill "${improved.name}" whose ${frozenFile.file} hashes to ` +
            `${digest}, but the experiment froze ${frozenFile.sha256} for the ${detail.side} side — the bytes this side ran are not the ` +
            'frozen ones',
        )
      }
    }
    if (detail.side === 'candidate' && sideObject.sha256 === frozen.productionBaseline?.sha256) {
      throw new Error(
        `evolution: the candidate side of the ${where} loaded the production bytes ("${improved.name}" hashes to ` +
          `${sideObject.sha256}, the frozen production baseline) — the candidate was never really run, so the comparison proves nothing`,
      )
    }
  }
}

/** One frozen file of the improved skill, read where the run really loaded it: the snapshot directory its run recorded. */
export async function readSideSnapshotFile(input: {
  snapshotRoot: string
  name: string
  file: string
  where: string
  runId: string
  side: ExperimentSide
}): Promise<Buffer> {
  const { snapshotRoot, name, file, where, runId, side } = input
  try {
    return await readFile(join(snapshotRoot, name, file))
  } catch (error) {
    throw new Error(
      `evolution: the ${file} of skill "${name}" at the content run "${runId}" of the ${where} was bound to cannot be read ` +
        `(${error instanceof Error ? error.message : String(error)}) — the ${side} side's frozen bytes cannot be re-proved from the ` +
        'snapshot its run recorded, so the promotion is refused',
    )
  }
}

/** Whether the two sides' bindings agree everywhere the frozen block allows a binding to differ. */
export function assertSidesAgree(
  frozen: ExperimentReport['frozen'],
  improved: SkillContentIdentity,
  baseline: { run: TaskRun; binding: RunProviderBinding },
  candidate: { run: TaskRun; binding: RunProviderBinding },
  where: string,
): void {
  const comparable = (binding: RunProviderBinding) => ({
    capabilities: [...binding.capabilities].sort(),
    mcpServers: [...binding.mcpServers].sort((left, right) =>
      left.serverName < right.serverName ? -1 : left.serverName > right.serverName ? 1 : 0,
    ),
    skills: [...binding.skills]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map(skill => ({
        name: skill.name,
        role: skill.role,
        ...(skill.name === improved.name
          ? {}
          : { contractDigest: skill.contractDigest ?? null, contentDigest: skill.contentDigest }),
      })),
  })
  const left = JSON.stringify(comparable(baseline.binding))
  const right = JSON.stringify(comparable(candidate.binding))
  if (left !== right) {
    throw new Error(
      `evolution: the two sides of ${where} did not bind the same provider identity — apart from the promoted skill's own content ` +
        `and declaration, which the candidate overlay is what changes, every field must agree:\n- baseline: ${left}\n- candidate: ${right}`,
    )
  }
  if (baseline.run.agentPreset !== candidate.run.agentPreset) {
    throw new Error(
      `evolution: the two sides of ${where} ran under different agent presets ` +
        `(${baseline.run.agentPreset === undefined ? '(none)' : `"${baseline.run.agentPreset}"`} vs ` +
        `${candidate.run.agentPreset === undefined ? '(none)' : `"${candidate.run.agentPreset}"`}) — a preset that moved between the ` +
        'sides is not the frozen execution',
    )
  }
}

/** Whether one side's cost is known enough for a frozen budget that declares a token ceiling. */
export function assertCostWithinDeclaredBudget(
  report: ExperimentReport,
  where: string,
  detail: ExperimentSideDetail,
): void {
  const budget = report.frozen.budget
  if (budget.maxTokens === undefined) return
  if (detail.cost.status === 'unknown') {
    throw new Error(
      `evolution: the frozen budget declares a cost ceiling (maxTokens ${budget.maxTokens}) ` +
        `and the ${where} reports no cost (${detail.cost.reason}) — an unknown cost cannot be shown to fit a ceiling the frozen ` +
        'budget set, so the promotion is refused rather than inferred',
    )
  }
  tokenTotalOf(detail, where, budget.maxTokens)
}

/** The four token buckets one settled side reports, summed the way the runtime's counters add up. */
export function tokenTotalOf(detail: ExperimentSideDetail, where: string, ceiling: number): number {
  const tokens = detail.cost.status === 'reported' ? detail.cost.metrics.tokens : undefined
  if (tokens === undefined || typeof tokens !== 'object') {
    throw new Error(
      `evolution: the frozen budget declares maxTokens ${ceiling} for the whole experiment, and the ${where} reports cost metrics ` +
        'without the `tokens` projection (tool-call counters alone do not show tokens) — a ceiling this side cannot be measured ' +
        'against is not evidence the promotion may read',
    )
  }
  const buckets = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  const values = buckets.map(bucket => (tokens as unknown as Record<string, unknown>)[bucket])
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error(
      `evolution: the ${where} reports token usage that is not four readable counters ` +
        `(${buckets.map((bucket, index) => `${bucket}: ${String(values[index])}`).join(', ')}) — an unreadable total is not a total the ` +
        `frozen maxTokens ${ceiling} can be checked against, so the promotion is refused`,
    )
  }
  return (values as readonly number[]).reduce((sum, value) => sum + value, 0)
}

/** The whole experiment's cost against the frozen budget (S4-E §F.2; Q1 of the guide). */
export function assertExperimentCostWithinBudget(report: ExperimentReport): void {
  const budget = report.frozen.budget
  if (budget.maxTokens === undefined) return
  let spent = 0
  let sides = 0
  for (const sample of report.samples) {
    for (const detail of [sample.baseline, sample.candidate]) {
      spent += tokenTotalOf(detail, `sample "${sample.taskId}" ${detail.side} side`, budget.maxTokens)
      sides += 1
    }
  }
  if (spent > budget.maxTokens) {
    throw new Error(
      `evolution: the frozen budget declares maxTokens ${budget.maxTokens} for the whole experiment, but its ${sides} settled sides ` +
        `report ${spent} tokens together (${spent - budget.maxTokens} over the ceiling) — the budget bounds the experiment as a whole and ` +
        'not one side, and a total its own records place above the ceiling is refused rather than promoted',
    )
  }
}

/** The evidence both promotion gates read first (S4-E §F.2, A6): the proposal's newest completed experiment, its report recomputed. */
export async function experimentEvidence(
  sources: SkillPromotionSources,
  proposal: EvolutionProposal,
): Promise<{ view: ExperimentView; report: ExperimentReport }> {
  const [experiment] = await sources.experiments(proposal.proposalId)
  if (experiment === undefined) throw noExperimentRefusal(proposal)
  let report: ExperimentReport
  try {
    report = buildExperimentReport(experiment)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — a promotion reads a completed experiment only; ` +
        `resume experiment ${experiment.experimentId} (evolution_replay) or freeze a new one`,
    )
  }
  const reportPath = experiment.report
  let content: string
  try {
    content = await readFile(resolve(sources.root, reportPath), 'utf8')
  } catch (error) {
    throw new Error(
      `evolution: the experiment report "${reportPath}" of proposal "${proposal.proposalId}" cannot be read ` +
        `(${error instanceof Error ? error.message : String(error)}) — the ledger cites evidence the sandbox no longer holds`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(
      `evolution: the experiment report "${reportPath}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  assertExperimentReport(parsed)
  if (content !== reportBytes(report)) {
    throw new Error(
      `evolution: the experiment report "${reportPath}" is not the report its ledger records recompute to — it was changed after ` +
        "the experiment (a verdict, a cost or a criterion in it is not what ran); a promotion takes evidence from the experiment's " +
        'own records, never from an edited file',
    )
  }
  await assertOutcomeEvidence(sources.root, report)
  return { view: experiment, report }
}

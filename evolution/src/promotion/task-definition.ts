/** Task template promotion binds the fixed parent oracle, frozen child library and negative guard. */
import { resolve } from 'node:path'
import { canonicalize } from '@dangosys/dsh-singularity-task'
import type { EvolutionProposal } from '../types.ts'
import type { SkillPromotionSources } from './shared.ts'
import {
  experimentEvidence,
  assertSideEvidence,
  assertJudgeUnchanged,
  assertProtectedInputIntact,
  assertSampleInputsIntact,
  assertSideModelBinding,
  assertCostWithinDeclaredBudget,
  assertExperimentCostWithinBudget,
  isNoWorkerRun,
  subtreeOf,
} from './binding.ts'
import { assertCapabilitySideBinding } from './capability.ts'
import { criterionGuardContract, criterionGuardLineage } from '../experiment/task-definition.ts'
import { directoryDigest, latestReview } from '../experiment/record.ts'
import {
  independentOracleCriteria,
  oracleContractDigest,
  templateLibraryDigest,
  validateTaskDefinitionMutation,
} from '../task-definition.ts'

export async function assertTaskDefinitionPromotion(
  sources: SkillPromotionSources,
  proposal: EvolutionProposal,
): Promise<void> {
  const { view, report } = await experimentEvidence(sources, proposal)
  const frozen = report.frozen
  const definition = frozen.taskDefinition
  if (
    definition === undefined ||
    definition.candidate.digest !== proposal.prepared?.templateCandidate?.digest ||
    (definition.baseline?.digest ?? null) !== (proposal.prepared?.templateBaseline?.digest ?? null)
  )
    throw new Error('evolution: experiment did not evaluate the prepared TaskTemplate and its frozen baseline')
  if (report.verdict !== 'fixed' && report.verdict !== 'improved')
    throw new Error(
      `evolution: TaskTemplate promotion requires a clean independent parent result, got ${report.verdict}`,
    )
  if (view.storeId === undefined) throw new Error('evolution: template experiment has no task store')
  const snapshot = await sources.task.openStore(view.storeId)
  const vocabulary = await sources.verifierVocabulary()
  if (vocabulary === undefined) throw new Error('evolution: template oracle verifier registry unavailable')
  const sandbox = `sandbox/${proposal.proposalId}`
  for (const side of ['baseline', 'candidate'] as const) {
    if (
      (await templateLibraryDigest(resolve(sources.root, sandbox, 'task-templates', side))) !==
      definition.libraries[side]
    )
      throw new Error('evolution: evaluated template library changed')
  }
  let candidateBound = false
  for (const comparison of report.samples) {
    const sample = frozen.samples.find(item => item.taskId === comparison.taskId)!
    for (const side of ['baseline', 'candidate'] as const) {
      const detail = comparison[side]
      const where = `template sample ${comparison.taskId} ${side}`
      const task = assertSideEvidence({
        sample,
        detail,
        snapshot,
        experimentId: view.experimentId,
        where,
        ...(frozen.objective === undefined ? {} : { objective: frozen.objective }),
      })
      assertJudgeUnchanged(sample, detail, where, vocabulary)
      assertCostWithinDeclaredBudget(report, where, detail)
      if (detail.initialDigest !== frozen.snapshot.digest)
        throw new Error('evolution: template parent replay input was not frozen')
      await assertSideModelBinding({ sources, detail, task, snapshot, selection: frozen.model, where })
      const run = snapshot.runs.find(item => item.runId === detail.runId)
      if (run === undefined || run.taskTemplatesRoot !== resolve(sources.root, sandbox, 'task-templates', side))
        throw new Error('evolution: replay did not bind its own frozen template library')
      await assertCapabilitySideBinding({ sample, detail, run, frozen, where })
      if (task !== undefined) {
        const expected = side === 'candidate' ? definition.candidate : definition.baseline
        for (const descendant of subtreeOf(snapshot, task.taskId).filter(item => item.taskId !== task.taskId)) {
          if (expected === null) {
            if (descendant.templateRef?.id === definition.candidate.template.id)
              throw new Error('evolution: absent baseline created a child with the candidate template')
            continue
          }
          if (descendant.templateRef?.id !== expected.template.id) continue
          if (
            descendant.templateRef.digest !== expected.digest ||
            descendant.templateRef.version !== expected.template.version
          )
            throw new Error('evolution: new child used another template version')
          if (side === 'candidate') candidateBound = true
        }
      }
    }
    await assertSampleInputsIntact({ sample, snapshot, productionWorkspace: frozen.snapshot.sourceDir })
  }
  if (!candidateBound)
    throw new Error('evolution: candidate parent replay created no child bound to the new TaskTemplate')
  const repair = validateTaskDefinitionMutation(proposal.mutation).criterionRepair
  if ((repair === undefined) !== (definition.criterionRepair === undefined))
    throw new Error('evolution: criterion repair examples were not frozen')
  if (repair !== undefined && definition.criterionRepair !== undefined) {
    for (const label of ['positive', 'negative'] as const) {
      const example = definition.criterionRepair[label]
      if (
        canonicalize({ ...repair[label], sourceDir: resolve(repair[label].sourceDir) }) !==
        canonicalize({ taskId: example.taskId, sourceDir: example.sourceDir, parameters: example.parameters })
      )
        throw new Error('evolution: criterion repair evaluated other examples')
      const source = snapshot.tasks.find(task => task.taskId === example.taskId)
      if (
        source === undefined ||
        oracleContractDigest(source) !== example.contractDigest ||
        (await directoryDigest(example.sourceDir)) !== example.snapshotDigest
      )
        throw new Error('evolution: frozen criterion example changed')
      for (const oracle of [true, false]) {
        const lineage = criterionGuardLineage(view.experimentId, label, oracle)
        const task = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
        const review = task === undefined ? undefined : latestReview(snapshot, task)
        const run = snapshot.runs.find(item => item.runId === review?.runId)
        const expected = label === 'positive' ? 'verified' : 'failed'
        if (
          task === undefined ||
          task.status !== expected ||
          review?.outcome !== expected ||
          review.taskId !== task.taskId ||
          run?.taskId !== task.taskId ||
          run.status !== expected ||
          !isNoWorkerRun(run) ||
          !review.evidenceRefs?.length ||
          !review.criteria?.length ||
          review.criteria.some(criterion => criterion.verdict === 'inconclusive')
        )
          throw new Error(`evolution: ${label} criterion promotion guard has no definitive ${expected} evidence`)
        for (const ref of review.evidenceRefs) {
          const bundle = snapshot.evidence.find(item => item.evidenceId === ref)
          if (bundle?.taskRunId !== run.runId || bundle.taskId !== task.taskId)
            throw new Error('evolution: criterion guard evidence belongs to another Task or Run')
          for (const criterion of review.criteria) {
            if (!bundle.verifierResults.some(result =>
              result.criterionId === criterion.criterionId &&
              result.status === criterion.verdict &&
              result.verifierId === criterion.verifierId &&
              result.verifierVersion === criterion.verifierVersion,
            ))
              throw new Error('evolution: criterion guard verdict has no matching verifier evidence')
          }
        }
        const contract = oracle
          ? { acceptanceCriteria: independentOracleCriteria(source), requiredCapabilities: source.requestedCapabilities }
          : await criterionGuardContract(resolve(sources.root, sandbox, 'task-templates/candidate'), view, label)
        const actual = task.acceptanceCriteria.map(({ protectedInputs: _inputs, ...criterion }) => criterion)
        const wanted = contract.acceptanceCriteria.map(({ protectedInputs: _inputs, ...criterion }) => criterion)
        if (canonicalize(actual) !== canonicalize(wanted) ||
            canonicalize(task.requestedCapabilities) !== canonicalize(contract.requiredCapabilities ?? []))
          throw new Error('evolution: criterion guard judged a different contract')
        for (const criterion of contract.acceptanceCriteria) {
          const fixed = task.acceptanceCriteria.find(item => item.criterionId === criterion.criterionId)!
          const declared = (criterion.protectedInputs ?? []) as unknown as (string | { path: string; sha256: string })[]
          const paths = declared.map(input => typeof input === 'string' ? input : input.path)
          if (canonicalize(paths) !== canonicalize((fixed.protectedInputs ?? []).map(input => input.path)) ||
              (oracle && canonicalize(criterion.protectedInputs ?? []) !== canonicalize(fixed.protectedInputs ?? [])))
            throw new Error('evolution: criterion guard protected input binding changed')
          for (const input of fixed.protectedInputs ?? [])
            await assertProtectedInputIntact(task.taskId, input, example.sourceDir)
        }
        const required = contract.acceptanceCriteria.filter(criterion => criterion.mandatory)
        if (review.criteria.length !== wanted.length ||
            wanted.some(criterion => !review.criteria!.some(item => item.criterionId === criterion.criterionId)) ||
            (label === 'positive' && required.some(criterion =>
              review.criteria!.find(item => item.criterionId === criterion.criterionId)?.verdict !== 'pass')) ||
            (label === 'negative' && !required.some(criterion =>
              review.criteria!.find(item => item.criterionId === criterion.criterionId)?.verdict === 'fail')))
          throw new Error('evolution: criterion guard outcome disagrees with its mandatory criterion evidence')
        for (const criterion of review.criteria) {
          const version = criterion.verifierId === undefined ? undefined : vocabulary.versions[criterion.verifierId]
          if (
            version === undefined ||
            criterion.verifierVersion !== version ||
            definition.guardVerifierVersions?.[criterion.verifierId!] !== version
          )
            throw new Error('evolution: criterion guard verifier changed')
        }
      }
    }
  }
  assertExperimentCostWithinBudget(report)
  const current = sources.modelSelection()
  if (
    current.provider !== frozen.model.provider ||
    current.model !== frozen.model.model ||
    current.reasoningEffort !== frozen.model.reasoningEffort ||
    current.maxTokens !== frozen.model.maxTokens
  )
    throw new Error('evolution: deployment model changed since template evaluation')
}

/**
 * Decomposition admission: derived batches, capability manifests and prechecked admission.
 */

import type { TaskRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import type {
  CapabilityManifest,
  DependencyEdge,
  RunId,
  TaskId,
  TaskInstance,
  TaskProposal,
  TaskProposalBatchConsumption,
  TaskProposalDecomposition,
  TaskRun,
} from '@dangosys/dsh-singularity-task'
import { batchIdFor, blockingQuestionsOf, taskContractIdentity } from '@dangosys/dsh-singularity-task'
import { checkDecomposition } from '../admission.ts'
import { providerRefusals } from '../provider-precheck.ts'
import { checkBatchAdmission, hasRootLimits, resolveRootBudget } from '../root-budget.ts'
import { bindTaskTemplate } from '../task-template.ts'
import { normalizeDecomposition } from '../normalize.ts'
import type { DecompositionIdentityContext, NormalizedBatch } from '../normalize.ts'
import { fixSpecProtectedInputs } from '../protected-inputs.ts'
import { escalationHint } from '../orchestration/verify.ts'
import type {
  DecomposeSpec,
  CapabilityGap,
  DecompositionRefusal,
  DecompositionPrecheck,
  AdmitBatchRequest,
  CheckDerivedBatchRequest,
} from '../types.ts'
import { now } from '../helpers.ts'
import { isOpenProposal } from '../proposal.ts'

export async function deriveBatch(
  self: TaskRuntime,
  identity: DecompositionIdentityContext,
  spec: DecomposeSpec,
): Promise<{ ok: true; batch: NormalizedBatch; envPath?: string } | { ok: false; refusal: DecompositionRefusal }> {
  /**
   * The session's checkout, resolved once: the same directory the caller's
   * protected acceptance inputs are read against, the children's MCP servers
   */
  const envPath = await self.envPathForSession(identity.callerSessionId)
  let bound: DecomposeSpec
  try {
    bound = Array.isArray(spec?.children)
      ? { ...spec, children: await Promise.all(spec.children.map(child => bindTaskTemplate(self.config.taskTemplatesRoot, child))) }
      : spec
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    return { ok: false, refusal: { error: failure, reasons: [failure.message], gaps: [] } }
  }
  const fixed = await fixSpecProtectedInputs(bound, envPath)
  const normalized = normalizeDecomposition(fixed.spec, {
    ...identity,
    admissionContext: self.admissionContext(),
  })
  const reasons = [...fixed.reasons, ...(normalized.ok ? [] : normalized.reasons)]
  if (!normalized.ok || reasons.length > 0) {
    return { ok: false, refusal: { error: self.contractRefusal(identity.parentTaskId, reasons), reasons, gaps: [] } }
  }
  return { ok: true, batch: normalized.batch, ...(envPath === undefined ? {} : { envPath }) }
}

export function manifestsOf(self: TaskRuntime, batch: NormalizedBatch): CapabilityManifest[] {
  return batch.children.map(child => self.resolveCapabilities(child.contract.requiredCapabilities))
}

export function storedBatchOf(proposal: TaskProposal): NormalizedBatch {
  if (proposal.kind === 'root') {
    /**
     * An internal invariant rather than a caller's mistake: every call site knows
     * it is holding a decomposition proposal, and one that does not is a bug the
     */
    throw new Error(
      `task-runtime: proposal "${proposal.proposalId}" is a root contract; it holds one contract and no batch`,
    )
  }
  return {
    contractVersion: proposal.identity.contractVersion,
    reason: proposal.identity.reason,
    children: proposal.batch.map(child => ({
      contract: structuredClone(child.contract),
      dependsOn: [...child.dependsOn],
      decomposable: child.decomposable,
      requiresIndependentAcceptance: child.requiresIndependentAcceptance,
    })),
    admission: {
      proposalDigest: proposal.proposalDigest,
      context: structuredClone(proposal.admissionContext),
    },
  }
}

export async function assertDecomposableRun(
  self: TaskRuntime,
  storeId: string,
  parentTask: TaskInstance,
  parentRun: TaskRun,
  callerSessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const parentTaskId = parentTask.taskId
  if (parentRun.taskId !== parentTaskId) {
    throw new Error(
      `task-runtime: run "${parentRun.runId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`,
    )
  }
  if (parentRun.sessionId !== callerSessionId) {
    throw new Error(
      `task-runtime: run "${parentRun.runId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`,
    )
  }
  if (parentRun.executionPhase === undefined) {
    throw new Error(
      `task-runtime: run "${parentRun.runId}" predates coordination phases; it needs recovery ` +
        '(cancel this task tree and re-create it) before it can decompose',
    )
  }
  if (parentRun.executionPhase !== 'active') {
    throw new Error(
      `task-runtime: run "${parentRun.runId}" is in phase "${parentRun.executionPhase}"; only an active run may decompose ` +
        '(a run with an unfinished batch is handed back `active` when the batch ends; only then may it decompose again)',
    )
  }
  const openQuestions = blockingQuestionsOf(await self.context.task.snapshotIn(storeId), parentRun.runId)
  if (openQuestions.length > 0) {
    throw new Error(
      `task-runtime: run "${parentRun.runId}" is waiting on ${openQuestions.length === 1 ? 'an unresolved blocking question' : `${openQuestions.length} unresolved blocking questions`} ` +
        `(${openQuestions.map(question => question.questionId).join(', ')}); an answer releases the wait, and only then may the run delegate`,
    )
  }
  if (signal?.aborted === true) {
    throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`)
  }
}

export async function inFlightProposalsOf(
  self: TaskRuntime,
  storeId: string,
  parentRunId: RunId,
): Promise<TaskProposalDecomposition[]> {
  const index = (await self.context.task.snapshotIn(storeId)).proposals
  /**
   * An index this snapshot does not carry (a hand-built one) is not "no
   * proposal exists": the check is skipped rather than answered wrongly, and the
   */
  if (index === undefined) return []
  return index.all.filter(
    (proposal): proposal is TaskProposalDecomposition =>
      proposal.kind !== 'root' && proposal.identity.parentRunId === parentRunId && isOpenProposal(proposal),
  )
}

export async function checkDerivedBatch(
  self: TaskRuntime,
  request: CheckDerivedBatchRequest,
): Promise<DecompositionPrecheck> {
  const { identity, parentTask, batch } = request
  const parentTaskId = identity.parentTaskId
  const snapshot = await self.context.task.snapshotIn(identity.storeId)
  /**
   * A `leaf` child is the parent's prediction that the work fits one worker.
   * With the runtime-decomposition switch on, the node's own admission call
   */
  const leaf = parentTask.decompositionStatus === 'leaf'
  const verdict = checkDecomposition(
    {
      ...parentTask,
      decompositionPolicy: {
        allowed: !leaf || self.config.allowRuntimeDecomposition,
        leaf,
        maxDepth: self.config.maxDepth,
        maxChildren: self.config.maxChildren,
      },
    },
    batch.children.map(child => ({
      objective: child.contract.objective,
      acceptanceCriteria: child.contract.acceptanceCriteria,
      dependsOn: child.dependsOn,
      requiresIndependentAcceptance: child.requiresIndependentAcceptance,
    })),
    snapshot.edges,
  )
  if (!verdict.ok) {
    return {
      ok: false,
      refusal: {
        error: new Error(
          `task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join('\n- ')}`,
        ),
        reasons: verdict.reasons,
        gaps: [],
      },
    }
  }

  const manifests = manifestsOf(self, batch)
  const rejected = batch.children
    .map((child, index) => ({ child, index, manifest: manifests[index]! }))
    .filter(({ child, manifest }) => manifest.missing.length > 0 && !child.decomposable)
  if (rejected.length > 0) {
    const detail = rejected
      .map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(', ')}] and may not decompose`)
      .join('; ')
    const gaps: CapabilityGap[] = rejected.map(({ index, manifest }) => ({
      childIndex: index,
      objective: batch.children[index]!.contract.objective,
      missing: [...manifest.missing],
    }))
    /**
     * The gap is a fact the submission path records before it refuses: one
     * obligation per missing capability, raised on the parent (KISS §7 — a
     */
    const gapNames = [...new Set(rejected.flatMap(({ manifest }) => manifest.missing))]
    return {
      ok: false,
      refusal: {
        error: new Error(
          `task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}; ` +
            escalationHint(
              `capabilities [${gapNames.join(', ')}] are not granted by the capability registry`,
              "capability_list and the children's declared capabilities",
              'grant the capability in the registry, or mark the child decomposable',
            ),
        ),
        reasons: [detail],
        gaps,
      },
    }
  }

  /**
   * Provider pre-check (S1-C item 1): every skill the matched capabilities
   * grant must be discoverable from the viewpoint of the workers about to be
   */
  const precheck = await self.providerPrecheck(
    [...new Set(manifests.flatMap(manifest => Object.keys(manifest.capabilities)))],
    { ...(request.envPath === undefined ? {} : { cwd: request.envPath }) },
  )
  const refusals = providerRefusals(precheck)
  if (refusals.length > 0) {
    return {
      ok: false,
      refusal: {
        error: new Error(
          `task-runtime: provider pre-check rejected decomposition of "${parentTaskId}":\n- ${refusals.join('\n- ')}`,
        ),
        reasons: refusals,
        gaps: [],
      },
    }
  }

  try {
    await self.assertKnownVerifierRefs(
      batch.children.flatMap((child, childIndex) =>
        child.contract.acceptanceCriteria.map(criterion => ({ childIndex, criterion })),
      ),
      `decomposition of "${parentTaskId}"`,
    )
  } catch (error) {
    /**
     * A batch naming a judge this deployment cannot list is a *batch* defect,
     * so it travels as a refusal the caller may invalidate a proposal for. A
     */
    const failure = error instanceof Error ? error : new Error(String(error))
    return { ok: false, refusal: { error: failure, reasons: [failure.message], gaps: [] } }
  }

  return { ok: true, batch, manifests, providers: precheck }
}

export async function admitPrecheckedBatch(
  self: TaskRuntime,
  request: AdmitBatchRequest,
): Promise<{ batchId: string; childTaskIds: TaskId[] }> {
  const { proposal, parentTask, parentRun, batch, manifests, exec = {} } = request
  const providers = request.providers
  const storeId = proposal.identity.storeId
  const parentTaskId = parentTask.taskId
  const callerSessionId = proposal.identity.callerSessionId
  const actor = callerSessionId
  if (exec.signal?.aborted === true) {
    throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`)
  }
  const childTaskIds = batch.children.map(() => `t-${randomUUID()}`)
  const snapshot = await self.context.task.snapshotIn(storeId)

  /**
   * The root budget's batch reservation (§3.5): every child of this batch will
   * start a run, so a batch that would push the tree past `maxRuns` is refused
   */
  const budget = resolveRootBudget(snapshot, self.config.rootBudget ?? {})
  if (!budget.ok) {
    if (hasRootLimits(self.config.rootBudget)) {
      throw new Error(
        `task-runtime: decomposition of "${parentTaskId}" refused: the root budget cannot be resolved: ${budget.reason}`,
      )
    }
  } else {
    const reserved = checkBatchAdmission(snapshot, budget, batch.children.length)
    if (!reserved.allowed) {
      throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: ${reserved.reason}`)
    }
  }

  /**
   * Workspace ownership (§3.4): the parent run must be the writer that holds
   * the checkout, or an ancestor of it must be. Anything else is another live
   */
  const workspacePath = await self.workspacePathForSession(callerSessionId)
  if (workspacePath !== undefined) await self.assertWorkspaceHeldBy(workspacePath, storeId, parentTask, parentRun.runId)

  const children: TaskInstance[] = batch.children.map((child, index) => ({
    taskId: childTaskIds[index]!,
    ...taskContractIdentity(child.contract),
    parentTaskId,
    /**
     * The projections are generated from the contract, never written beside
     * it: the store refuses a TaskCreated whose fields disagree with the
     */
    objective: child.contract.objective,
    depth: parentTask.depth + 1,
    acceptanceCriteria: child.contract.acceptanceCriteria,
    requestedCapabilities: [...child.contract.requiredCapabilities],
    decompositionStatus: child.decomposable || manifests[index]!.missing.length > 0 ? 'decomposable' : 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract: child.contract,
    ...(child.requiresIndependentAcceptance ? { requiresIndependentAcceptance: true } : {}),
  }))
  const edges: DependencyEdge[] = batch.children.flatMap((child, to) =>
    child.dependsOn.map((from: number) => ({ from: childTaskIds[from]!, to: childTaskIds[to]! })),
  )
  /**
   * One commit (§1.3): the children, their admission, the dependency edges,
   * the parent's decomposition record, every child's capability manifest, the
   */
  const consumption: TaskProposalBatchConsumption = {
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    reviewContextDigest: proposal.reviewContextDigest,
    parentRunId: parentRun.runId,
    batchId: batchIdFor(parentRun.runId, proposal.proposalId),
    childTaskIds,
    admittedAt: now(),
  }
  const { batchId } = consumption
  await self.context.task.admitBatchIn(
    storeId,
    parentTaskId,
    parentRun.runId,
    children,
    actor,
    edges,
    batch.admission,
    manifests,
    consumption,
  )
  // The phase is committed, so the gate closes for this session now: from here
  // the parent may read, diagnose, ask or cancel, and nothing else (§3.3).
  self.executionGate.setPhase(callerSessionId, 'waiting_children')
  if (workspacePath !== undefined && self.workspaces !== undefined) {
    const held = self.workspaces.ownerOf(workspacePath)
    if (held !== undefined) {
      await self.workspaces.push(workspacePath, held, {
        kind: 'batch',
        storeId,
        taskId: parentTaskId,
        batchId,
        since: now(),
      })
    }
  }

  /**
   * Progress belongs to the runtime from here on (§3.7): the caller's signal
   * governed admission only, and this batch's own controller is what a
   */
  self.startBatchDriver({
    storeId,
    parentTaskId,
    parentRunId: parentRun.runId,
    batchId,
    callerSessionId,
    reason: batch.reason,
    providers,
    ...(exec.callId === undefined ? {} : { excludeCallId: exec.callId }),
  })
  return { batchId, childTaskIds }
}

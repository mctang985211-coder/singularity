import { parseMcpServerRegistry } from '../mcp-servers.ts'
import { taskContractIdentity } from '@dangosys/dsh-singularity-task'
/**
 * Replay: the replay entry and its workspace claim.
 */

import type { TaskRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import * as svcEnvironment from './environment.ts'
import type { TaskContract, TaskId, TaskInstance } from '@dangosys/dsh-singularity-task'
import { TASK_CONTRACT_VERSION } from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, resolvePreset } from '../capability.ts'
import { contractDefects, independentAcceptanceDefects } from '../admission.ts'
import { providerRefusals } from '../provider-precheck.ts'
import { checkRunStart, hasRootLimits, resolveRootBudget } from '../root-budget.ts'
import { fixCriteriaProtectedInputs } from '../protected-inputs.ts'
import { runReplayTask } from '../orchestration/replay.ts'
import type { ReplayReceiptReport, ReplayRunOutcome } from '../orchestration/types.ts'
import { WorkspaceBusyError, describeOwner, normalizeWorkspacePath, releaseLayer } from '../workspace.ts'
import type { WorkspaceOwner } from '../workspace.ts'
import type { ReplayTaskOptions } from '../types.ts'
import { message, now } from '../helpers.ts'
import { rebaseWorkspacePaths } from '../replay-paths.ts'
import * as svcDrivers from './drivers.ts'
import * as svcEnv from './env.ts'
import * as svcRootRecovery from './root-recovery.ts'
import * as svcSessions from './sessions.ts'

export async function replayTask(
  self: TaskRuntime,
  storeId: string,
  championTaskId: TaskId,
  options: ReplayTaskOptions,
  callerSessionId: string,
): Promise<ReplayRunOutcome> {
  const known = new Set(['lineage', 'overlay', 'contract', 'spawn', 'workspace', 'agentOptions', 'signal', 'trialCandidateRef'])
  const unknown = Object.keys(options).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`task-runtime: replayTask does not accept options [${unknown.join(', ')}]`)
  }
  await svcRootRecovery.assertRecoveryReady(self, storeId, 'a replay')
  const champion = await self.context.task.taskIn(storeId, championTaskId)
  if (champion.status !== 'verified' && champion.status !== 'failed') {
    throw new Error(
      `task-runtime: champion task "${championTaskId}" is ${champion.status}; only a terminal (verified or failed) task can be replayed`,
    )
  }
  // A verified/failed task always has at least one run; the latest is the
  // champion run the replay's own run descends from (execution lineage).
  const championRunId = champion.runIds[champion.runIds.length - 1]!
  /**
   * The immutable environment revision this replay binds: the candidate a
   * caller explicitly trials when it names one, else the active revision. An
   * overlay's own frozen library root still wins when a caller passes one.
   */
  const environment = await svcEnvironment.environmentLibraryForSession(self, callerSessionId)
  if (options.trialCandidateRef !== undefined && environment.revision === undefined) {
    throw new Error(`task-runtime: library "${environment.id}" holds no active revision to trial a candidate against`)
  }
  const revision = options.trialCandidateRef === undefined
    ? environment.revision
    : await svcEnvironment.revisionForManifest(self, environment.id, options.trialCandidateRef)
  let taskTemplatesRoot = options.overlay?.taskTemplatesRoot ?? await self.taskTemplatesRootFor(callerSessionId)
  const original = options.contract ?? {
    objective: champion.objective,
    acceptanceCriteria: champion.acceptanceCriteria,
    requiredCapabilities: champion.requestedCapabilities,
  }
  const named = options.workspace === undefined ? undefined : await normalizeWorkspacePath(options.workspace.path)
  const effective = options.workspace?.rebaseFrom === undefined ? original
    : rebaseWorkspacePaths(original, options.workspace.rebaseFrom, named!)
  const context = options.workspace?.rebaseFrom === undefined ? champion.contract
    : rebaseWorkspacePaths(champion.contract, options.workspace.rebaseFrom, named!)
  const table = { ...await self.capabilitiesForSession(callerSessionId), ...(options.overlay?.capabilityOverrides ?? {}) }
  const mcpRegistry = parseMcpServerRegistry({ ...self.config.mcpServers, ...options.overlay?.mcpServers })
  const manifest = resolveCapabilities(effective.requiredCapabilities, table, mcpRegistry)
  if (manifest.missing.length > 0) {
    throw new Error(
      `task-runtime: replay of "${championTaskId}" cannot run: capability gap [${manifest.missing.join(', ')}] under the overlay`,
    )
  }
  /**
   * The checkout this replay's everything resolves against: the workspace the
   * caller named, resolved to its real path first so the claim, the cwd and the
   */
  const envPath = named ?? (await self.envPathForSession(callerSessionId))
  /**
   * The same provider pre-check the ordinary decomposition runs (S1-C item 1),
   * from the replay's checkout and under the overlay's own capability
   */
  /**
   * A trial's providers must be judged against the candidate's own bytes: the
   * verdicts become the Run binding's content identity, and a revision that no
   * longer holds what was judged is refused rather than silently re-read.
   */
  const candidateRoots = revision !== undefined && options.trialCandidateRef !== undefined ? [revision.skillRoot] : []
  const precheck = await svcEnv.providerPrecheck(self, 
    Object.keys(manifest.capabilities),
    {
      ...(envPath === undefined ? {} : { cwd: envPath }),
      extraRoots: (await self.skillViewForSession(callerSessionId, candidateRoots)).extraRoots,
    },
    table,
    mcpRegistry,
    callerSessionId,
  )
  const refusals = providerRefusals(precheck, Object.keys(manifest.capabilities))
  if (refusals.length > 0) {
    throw new Error(
      `task-runtime: provider pre-check rejected replay of "${championTaskId}":\n- ${refusals.join('\n- ')}`,
    )
  }
  /**
   * The replay path shares the ordinary decomposition's rules: the contract's
   * own structure (T1) and the P4 parent-acceptance declarations (contract 8).
   */
  const label = `replay of "${championTaskId}"`
  /**
   * Protected acceptance inputs are fixed the same way the ordinary path
   * fixes them (S1-V slice 2), against the replay caller's checkout: the
   */
  const fixed = await fixCriteriaProtectedInputs(effective.acceptanceCriteria, envPath, label)
  const acceptanceDefects = [
    ...fixed.reasons,
    ...contractDefects(fixed.criteria, label),
    ...independentAcceptanceDefects(fixed.criteria, champion.requiresIndependentAcceptance, label),
  ]
  if (acceptanceDefects.length > 0) {
    throw new Error(`task-runtime: replay of "${championTaskId}" rejected:\n- ${acceptanceDefects.join('\n- ')}`)
  }
  await svcEnv.assertKnownVerifierRefs(self, 
    fixed.criteria.map(criterion => ({ childIndex: 0, criterion })),
    `replay of "${championTaskId}"`,
  )
  /**
   * The replayed task's contract: the lineage-tagged objective, the criteria
   * deep-copied (a candidate definition is the caller's object, not the
   */
  const contract: TaskContract = {
    contractVersion: TASK_CONTRACT_VERSION,
    objective: `[${options.lineage}] ${effective.objective}`,
    acceptanceCriteria: structuredClone([...fixed.criteria]),
    assumptions: [...(context?.assumptions ?? [])],
    constraints: [...(context?.constraints ?? [])],
    requiredCapabilities: [...effective.requiredCapabilities],
    ...(champion.contract?.templateScope === undefined ? {} : { templateScope: structuredClone(champion.contract.templateScope) }),
  }
  const task: TaskInstance = {
    taskId: `t-${randomUUID()}`,
    ...taskContractIdentity(contract),
    objective: contract.objective,
    depth: 0,
    acceptanceCriteria: contract.acceptanceCriteria,
    requestedCapabilities: [...contract.requiredCapabilities],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract,
    ...(champion.requiresIndependentAcceptance === true ? { requiresIndependentAcceptance: true } : {}),
  }
  if (options.overlay?.taskTemplatesRoot === undefined && revision !== undefined && self.sessionExecutionBindings.get(callerSessionId)?.taskTemplatesRoot === undefined) {
    taskTemplatesRoot = revision.taskTemplatesRoot
  }
  const spawn = options.spawn !== false
  /**
   * A replayed worker reads its context the way every task worker does (A2):
   * the replay task is parentless by design, so the store records no handoff
   */
  const replaySnapshot = await self.context.task.snapshotIn(storeId)
  const replayBudget = resolveRootBudget(replaySnapshot, self.config.rootBudget ?? {})
  if (!replayBudget.ok) {
    if (hasRootLimits(self.config.rootBudget)) {
      throw new Error(
        `task-runtime: replay of "${championTaskId}" refused: the root budget cannot be resolved: ${replayBudget.reason}`,
      )
    }
  } else {
    const startVerdict = checkRunStart(replaySnapshot, replayBudget)
    if (!startVerdict.allowed) {
      throw new Error(`task-runtime: replay of "${championTaskId}" refused: ${startVerdict.reason}`)
    }
  }
  const workspacePath = named ?? (await svcSessions.workspacePathForSession(self, callerSessionId))
  const workspaceOwner =
    workspacePath === undefined
      ? undefined
      : await claimReplayWorkspace(self, workspacePath, storeId, callerSessionId, championTaskId, task.taskId)
  self.replayLineage.set(task.taskId, options.lineage)
  const controller = new AbortController()
  const run = async (): Promise<ReplayRunOutcome> => {
    try {
      const outcome = await runReplayTask(
        await self.orchestrateEnv(callerSessionId, callerSessionId, named, {
          ...options.overlay, ...(taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot }),
        }),
        storeId,
        {
          task,
          manifest,
          // The pre-check this replay passed: the Run binding (S1-C item 4) records
          // what the replay resolved against without re-running discovery.
          providers: precheck,
          lineage: options.lineage,
          agentPreset: resolvePreset(manifest, self.config.defaultPreset),
          /**
           * The execution binding this run is placed under (S4-E §Q3): the caller's
           * frozen selection, forwarded verbatim — the orchestration carries it to
           */
          ...(options.agentOptions === undefined ? {} : { agentOptions: { ...options.agentOptions } }),
          ...(taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot }),
          ...(revision === undefined
            ? {}
            : { revision, environmentRevisionId: environment.revision?.manifest.revisionId ?? revision.manifest.revisionId }),
          ...(options.trialCandidateRef === undefined ? {} : { trialCandidateRef: options.trialCandidateRef }),
          spawn,
          championRunId,
        },
        {
          ...(options.signal === undefined ? {} : { admission: options.signal }),
          advance: controller.signal,
        },
      )
      /**
       * The receipt this replay sealed, read back rather than assumed: a consumer
       * of the replay (an experiment side, a comparison) must be able to tell
       * "sealed and complete" from "no receipt" before it reads any other fact.
       */
      let receiptReport: ReplayReceiptReport
      try {
        const sealed = await self.sealRunReceipt(storeId, outcome.taskId, outcome.runId)
        receiptReport = sealed.status === 'sealed' || sealed.status === 'already-sealed'
          ? {
              status: 'sealed',
              digest: sealed.receipt.digest,
              completeness: sealed.receipt.completeness.status,
              missing: sealed.receipt.completeness.missing.map(entry => entry.fact),
            }
          : { status: 'absent', reason: sealed.reason }
      } catch (error) {
        // A replay that settled is a replay; a receipt it could not write is
        // reported as absent and left queued, never turned into a replay failure.
        self.warn(`store ${storeId}: the receipt of replay run "${outcome.runId}" could not be sealed (${message(error)})`)
        receiptReport = { status: 'absent', reason: message(error) }
      }
      const withReceipt = { ...outcome, receipt: receiptReport }
      /**
       * A named workspace is what the outcome of this replay reports: the
       * comparison report names the directory each side's run went through. An
       */
      return named === undefined ? withReceipt : { ...withReceipt, workspace: named }
    } finally {
      if (workspacePath !== undefined && workspaceOwner !== undefined)
        await releaseReplayWorkspace(self, workspacePath, workspaceOwner)
    }
  }
  const promise = run()
  /**
   * A replay is a driver like a batch is: the runtime owns its progress, so a
   * cancellation or an unload stops it. Its own promise never rejects — the
   */
  const driverKey = `replay/${storeId}/${task.taskId}`
  svcDrivers.registerDriver(self, 
    driverKey,
    storeId,
    controller,
    promise.then(
      () => [],
      () => [],
    ),
  )
  return await promise
}

async function claimReplayWorkspace(
  self: TaskRuntime,
  workspace: string,
  storeId: string,
  callerSessionId: string,
  championTaskId: TaskId,
  replayTaskId: TaskId,
): Promise<WorkspaceOwner> {
  const registry = self.workspaces
  if (registry === undefined) throw new Error('task-runtime: the workspace registry is not initialized')
  const owner: WorkspaceOwner = {
    kind: 'run',
    storeId,
    taskId: replayTaskId,
    runId: `replay-of-${championTaskId}`,
    since: now(),
  }
  const top = registry.ownerOf(workspace)
  if (top === undefined) {
    await registry.claim(workspace, owner)
    return registry.ownerOf(workspace) ?? owner
  }
  const callerRunId = self.sessions.get(callerSessionId)?.runId
  const callerHolds = callerRunId !== undefined && top.storeId === storeId && top.runId === callerRunId
  if (!callerHolds) {
    throw new WorkspaceBusyError(
      workspace,
      top,
      top.since,
      `a replay from session ${callerSessionId} cannot write into a checkout held by ${top.kind} ${top.taskId ?? top.batchId ?? ''}`,
    )
  }
  await registry.push(workspace, top, owner)
  return owner
}

async function releaseReplayWorkspace(
  self: TaskRuntime,
  workspace: string,
  owner: WorkspaceOwner,
): Promise<void> {
  const registry = self.workspaces
  if (registry === undefined) return
  const { conflict } = await releaseLayer(
    registry,
    workspace,
    top => top.kind === owner.kind && top.runId === owner.runId && top.storeId === owner.storeId,
  )
  if (conflict !== undefined) {
    self.warn(
      `workspace ${workspace} was expected to hold the replay layer ${owner.runId ?? ''}, but holds ${describeOwner(conflict)}`,
    )
  }
}

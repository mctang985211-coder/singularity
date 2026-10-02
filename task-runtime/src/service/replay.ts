import { parseMcpServerRegistry } from '../mcp-servers.ts'
import { taskContractIdentity } from '@dangosys/dsh-singularity-task'
/**
 * Replay: the replay entry and its workspace claim.
 */

import type { TaskRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import type { TaskContract, TaskId, TaskInstance } from '@dangosys/dsh-singularity-task'
import { TASK_CONTRACT_VERSION } from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, resolvePreset } from '../capability.ts'
import { contractDefects, independentAcceptanceDefects } from '../admission.ts'
import { providerRefusals } from '../provider-precheck.ts'
import { checkRunStart, hasRootLimits, resolveRootBudget } from '../root-budget.ts'
import { fixCriteriaProtectedInputs } from '../protected-inputs.ts'
import { runReplayTask } from '../orchestration/replay.ts'
import type { ReplayRunOutcome } from '../orchestration/types.ts'
import { WorkspaceBusyError, describeOwner, normalizeWorkspacePath, releaseLayer } from '../workspace.ts'
import type { WorkspaceOwner } from '../workspace.ts'
import type { ReplayTaskOptions } from '../types.ts'
import { now } from '../helpers.ts'

export async function replayTask(
  self: TaskRuntime,
  storeId: string,
  championTaskId: TaskId,
  options: ReplayTaskOptions,
  callerSessionId: string,
): Promise<ReplayRunOutcome> {
  const known = new Set(['lineage', 'overlay', 'contract', 'spawn', 'workspace', 'agentOptions', 'signal'])
  const unknown = Object.keys(options).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`task-runtime: replayTask does not accept options [${unknown.join(', ')}]`)
  }
  await self.assertRecoveryReady(storeId, 'a replay')
  const champion = await self.context.task.taskIn(storeId, championTaskId)
  if (champion.status !== 'verified' && champion.status !== 'failed') {
    throw new Error(
      `task-runtime: champion task "${championTaskId}" is ${champion.status}; only a terminal (verified or failed) task can be replayed`,
    )
  }
  // A verified/failed task always has at least one run; the latest is the
  // champion run the replay's own run descends from (execution lineage).
  const championRunId = champion.runIds[champion.runIds.length - 1]!
  const effective = options.contract ?? {
    objective: champion.objective,
    acceptanceCriteria: champion.acceptanceCriteria,
    requiredCapabilities: champion.requestedCapabilities,
  }
  const table = { ...self.config.capabilities, ...(options.overlay?.capabilityOverrides ?? {}) }
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
  const named = options.workspace === undefined ? undefined : await normalizeWorkspacePath(options.workspace.path)
  const envPath = named ?? (await self.envPathForSession(callerSessionId))
  /**
   * The same provider pre-check the ordinary decomposition runs (S1-C item 1),
   * from the replay's checkout and under the overlay's own capability
   */
  const precheck = await self.providerPrecheck(
    Object.keys(manifest.capabilities),
    {
      ...(envPath === undefined ? {} : { cwd: envPath }),
      ...(options.overlay?.extraSkillRoots === undefined ? {} : { extraRoots: [...options.overlay.extraSkillRoots] }),
    },
    table,
    mcpRegistry,
  )
  const refusals = providerRefusals(precheck)
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
  await self.assertKnownVerifierRefs(
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
    assumptions: [...(champion.contract?.assumptions ?? [])],
    constraints: [...(champion.contract?.constraints ?? [])],
    requiredCapabilities: [...effective.requiredCapabilities],
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
  const workspacePath = named ?? (await self.workspacePathForSession(callerSessionId))
  const workspaceOwner =
    workspacePath === undefined
      ? undefined
      : await claimReplayWorkspace(self, workspacePath, storeId, callerSessionId, championTaskId, task.taskId)
  self.replayLineage.set(task.taskId, options.lineage)
  const controller = new AbortController()
  const run = async (): Promise<ReplayRunOutcome> => {
    try {
      const outcome = await runReplayTask(
        await self.orchestrateEnv(callerSessionId, callerSessionId, named, options.overlay ?? {}),
        storeId,
        {
          task,
          manifest,
          // The pre-check this replay passed: the Run binding (S1-C item 4) records
          // what the replay resolved against without re-running discovery.
          providers: precheck,
          lineage: options.lineage,
          agentPreset: options.overlay?.presetOverride ?? resolvePreset(manifest, self.config.defaultPreset),
          ...(options.overlay?.extraSkillRoots === undefined
            ? {}
            : { skillRoots: [...options.overlay.extraSkillRoots] }),
          /**
           * The execution binding this run is placed under (S4-E §Q3): the caller's
           * frozen selection, forwarded verbatim — the orchestration carries it to
           */
          ...(options.agentOptions === undefined ? {} : { agentOptions: { ...options.agentOptions } }),
          ...(options.overlay?.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: options.overlay.taskTemplatesRoot }),
          spawn,
          championRunId,
        },
        {
          ...(options.signal === undefined ? {} : { admission: options.signal }),
          advance: controller.signal,
        },
      )
      /**
       * A named workspace is what the outcome of this replay reports: the
       * comparison report names the directory each side's run went through. An
       */
      return named === undefined ? outcome : { ...outcome, workspace: named }
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
  const driverKey = `replay/${storeId}/${championTaskId}`
  self.registerDriver(
    driverKey,
    storeId,
    controller,
    promise.then(
      () => [],
      () => [],
    ),
  )
  try {
    return await promise
  } finally {
    self.drivers.delete(driverKey)
  }
}

export async function claimReplayWorkspace(
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

export async function releaseReplayWorkspace(
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

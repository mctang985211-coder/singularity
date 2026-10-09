/**
 * Worker spawn: grants, presets, MCP mounts and the adoption resume door.
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type { CapabilityManifest, RunProviderBinding, TaskRun } from '@dangosys/dsh-singularity-task'
import { resolvePermission, workerBaseline } from '../capability.ts'
import { manifestMcpServers, resolveMcpServerSpecs } from '../mcp-servers.ts'
import { message } from '../helpers.ts'
import type { AdoptedWorkerResume, OrchestrateEnv, TaskWorkerSpawn } from './types.ts'

/**
 * Rebuild the authorization a recovery pass has to state for one run, from the
 * store's own records, and hand it to the deployment's resume door.
 */
export async function resumeAdoptedWorker(
  env: OrchestrateEnv,
  storeId: string,
  run: TaskRun,
): Promise<AdoptedWorkerResume> {
  const resume = env.resumeWorkerSession
  if (resume === undefined) {
    return {
      status: 'refused',
      reason: 'this deployment wires no worker resume, so the Session of an adopted run cannot be brought back',
    }
  }
  let manifest: CapabilityManifest | undefined
  try {
    manifest = (await env.task.snapshotIn(storeId)).capabilities[run.taskId]
  } catch (error) {
    return { status: 'refused', reason: `the store could not be read for its manifest: ${message(error)}` }
  }
  if (manifest === undefined) {
    return {
      status: 'refused',
      reason: `the store holds no capability manifest for task "${run.taskId}", so the composition run "${run.runId}" was spawned in cannot be rebuilt`,
    }
  }
  let grant: WorkerGrant
  let permissionPreset: string | undefined
  try {
    grant = await authorizedGrant(env, manifest, skillRootsForRun(bubbleSkillRoots(env.workspacePath), run.providerBinding))
    permissionPreset = permissionFor(env, manifest)
  } catch (error) {
    return { status: 'refused', reason: `the run's authorization could not be rebuilt: ${message(error)}` }
  }
  return await resume({
    storeId,
    run,
    grant,
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    taskWorker: true,
  })
}

/**
 * The authorization one admitted child runs under, built from its manifest:
 * the tools and skills its matched capabilities declared (labels already
 */
function workerGrant(manifest: CapabilityManifest): WorkerGrant {
  return {
    capabilities: Object.entries(manifest.capabilities).map(([capability, entry]) => ({
      capability,
      tools: [...entry.tools],
      skills: [...entry.skills],
    })),
    baseline: workerBaseline(),
    keepPresetTools: Object.values(manifest.capabilities).some(entry => entry.preset !== undefined),
  }
}

/**
 * The full grant for one spawn: {@link workerGrant} plus the manifest's MCP
 * servers materialized against the run's env binding, plus the skill roots the
 */
export async function authorizedGrant(
  env: OrchestrateEnv,
  manifest: CapabilityManifest,
  skillRoots: readonly string[] = [],
): Promise<WorkerGrant> {
  const grant = { ...workerGrant(manifest), ...(skillRoots.length === 0 ? {} : { skillRoots: [...skillRoots] }) }
  if (manifestMcpServers(manifest).length === 0) return grant
  const binding = env.resolveMcpEnv === undefined ? undefined : await env.resolveMcpEnv()
  return { ...grant, mcpServers: resolveMcpServerSpecs(manifest, binding, env.mcpRegistry ?? {}) }
}

/**
 * The skill roots one worker's layer registers, in order: whatever the caller
 * passes first (a replay's candidate overlay, which must win a same-name
 */
export function skillRootsForRun(overlayRoots: readonly string[], binding: RunProviderBinding | undefined): string[] {
  return [...overlayRoots, ...(binding?.snapshotRoot === undefined ? [] : [binding.snapshotRoot])]
}

/** The bubble's method volume as an overlay skill root, when `workspace` is a bubble workspace; the environment's own libraries are hidden there. */
function bubbleSkillRoots(workspace: string | undefined): string[] {
  if (workspace === undefined) return []
  const root = join(workspace, '.bubble', 'method-volume')
  return existsSync(root) ? [root] : []
}

/**
 * Spawn one task worker (A2 §1.2, A6 §F.4): the composition every spawn builds
 * — the deployment's preset, the capability grant the manifest authorizes, the
 */
export async function spawnTaskWorker(env: OrchestrateEnv, request: TaskWorkerSpawn): Promise<AgentHandle> {
  await assertPresetUsable(env, request.manifest, request.agentPreset)
  const permissionPreset = permissionFor(env, request.manifest)
  const grant = await authorizedGrant(env, request.manifest, skillRootsForRun(bubbleSkillRoots(request.cwd), request.providerBinding))
  return await env.spawn({
    sessionId: request.sessionId,
    name: request.name,
    taskWorker: true,
    grant,
    ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
}

/**
 * Refuse a dangling preset before the spawn attempt: when the deployment
 * cannot mount the resolved preset, throw an error naming the preset and the
 */
export async function assertPresetUsable(
  env: OrchestrateEnv,
  manifest: CapabilityManifest,
  preset: string | undefined,
): Promise<void> {
  if (preset === undefined || env.assertPreset === undefined) return
  try {
    await env.assertPreset(preset)
  } catch (error) {
    const grantedBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) =>
      entry.preset === preset ? [name] : [],
    )
    throw new Error(
      `task-runtime: preset "${preset}"${grantedBy.length === 0 ? '' : ` granted by capabilities [${grantedBy.join(', ')}]`} is not mountable: ${message(error)}`,
    )
  }
}

/**
 * The strictest permission preset a manifest's capabilities declare. Unknown
 * names throw here (through the registry's resolve) so the spawn catch walks
 */
export function permissionFor(env: OrchestrateEnv, manifest: CapabilityManifest): string | undefined {
  if (Object.values(manifest.capabilities).every(entry => entry.permission === undefined)) return undefined
  if (env.resolvePermissionSpec === undefined) {
    return Object.values(manifest.capabilities).find(entry => entry.permission !== undefined)?.permission
  }
  try {
    return resolvePermission(manifest, env.resolvePermissionSpec)
  } catch (error) {
    const declaredBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) =>
      entry.permission === undefined ? [] : [name],
    )
    throw new Error(
      `task-runtime: permission declared by capabilities [${declaredBy.join(', ')}] is not usable: ${message(error)}`,
    )
  }
}

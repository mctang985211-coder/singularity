/**
 * The host plugin: one control store, one driver, one service.
 *
 * The member set is closed — schemastery validates types, not names, so an unknown key refuses here,
 * before anything opens. The tools belong to the agent face (`./agent`); this entry owns the store and
 * recovery, and registers nothing globally.
 *
 * @module @dangosys/dsh-singularity-next
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { loadDomain } from './domain.ts'
import { openDriver } from './driver.ts'
import { spawnProcess } from './submission.ts'

export const name = 'singularity-assembly'

/**
 * The one seam this plugin declares.
 *
 * The child-session services (`sessions`, `agents`, `agentLoop`, `agentPresets`) are deliberately **not**
 * listed. An `inject` name a profile does not provide makes the entire bundle skip silently — measured,
 * and it is the failure mode this repository has already paid for once. A deployment that mounts this
 * plugin and never schedules a sub-task needs none of them, and one that does schedule gets a named
 * refusal from {@link advance} rather than a package that quietly vanished. So the seams are read off the
 * context where they are used, and their absence is reported there.
 */
export const inject = ['sessionPersistence']

const CONFIG_MEMBERS = ['controlId', 'domainDir', 'workspaceRoot'] as const

export const Config = z.object({
  controlId: z.string().required(),
  domainDir: z.string().required(),
  workspaceRoot: z.string().required(),
})

export interface Config {
  /** The control id every task fact is written under. Minted once by a deployment, never derived. */
  readonly controlId: string
  /** The directory holding this deployment's `task.json` and the verifier its criteria name. */
  readonly domainDir: string
  /** Where task workspaces are built. Named by the deployment, never guessed from the cwd. */
  readonly workspaceRoot: string
}
export async function apply(ctx: Context, config: Config & Record<string, unknown>): Promise<void> {
  assertClosedKeys(config, CONFIG_MEMBERS, 'the singularity-assembly config')
  const domain = await loadDomain(config.domainDir, spawnProcess)
  const driver = await openDriver({
    controlId: config.controlId,
    workspaceRoot: config.workspaceRoot,
    domain,
    persistence: ctx.sessionPersistence,
    seams: ctx as ChildSessionSeams,
  })
  ctx.provide('singularity', {
    forCall: (exec: ToolRunContext) => driver.forCall(exec),
    read: () => driver.read(),
    advance: (parent: Agent | undefined) => driver.advance(parent),
  })
  ctx.effect(() => () => driver.close())
}

/**
 * The driver: the host's service, and the surface one call drives.
 *
 * `forCall(exec)` resolves the live caller into a surface that runs as *that* caller — its own key, its
 * own node, no field in any tool schema to claim one — and the store, with recovery, opens here first.
 * `read()` and the projection behind it live in `snapshot.ts`, where a reader with no call to make can
 * be told about them.
 *
 * @module @dangosys/dsh-singularity-next/driver
 */

import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { ReceiptView, TaskView } from '../../src/task/view.ts'
import { callerOf, openApparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import { repair } from './repair.ts'
import { createScheduler } from './scheduler.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import { decompose, propose, status, submitTo, type Submission } from './surfaces.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularity: TaskService
  }
}
/** The host service: per-call surfaces for the tools, and one read projection for everything else. */
export interface TaskService {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
}
export interface AgentTaskSurface {
  propose(input: { readonly goal: string }): Promise<Proposal>
  /** Declare a plan for a task the caller holds, then open what it made ready. */
  decompose(input: { readonly taskId: string; readonly children: readonly PlannedChild[] }): Promise<PlanRecord>
  submit(input: { readonly taskId: string; readonly program: string }): Promise<Submission>
  status(input: { readonly taskId: string }): Promise<Status>
}

/**
 * One sub-task as the caller plans it.
 *
 * `key` is a name local to the plan, and `goal` is what the sub-task is for; neither is an identity. The
 * task id is derived from the key, and the contract is assembled from this deployment's own criterion,
 * because what a sub-task is judged against is the domain's decision rather than the model's.
 */
export interface PlannedChild {
  readonly key: string
  readonly goal: string
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
}

export interface PlanRecord {
  readonly taskId: string
  /** The sub-tasks this call opened sessions for: the plan's own `ready` set at this cut. */
  readonly opened: readonly string[]
}

export interface Proposal {
  readonly taskId: string
  readonly workspace: string
  readonly criterionId: string
  readonly phase: TaskView['phase']
}

export interface Status {
  readonly phase: TaskView['phase']
  readonly runs: number
  /** Null while no attempt has settled: a receipt is what a terminal run leaves behind. */
  readonly receipt: ReceiptView | null
}

export interface DriverOptions {
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
}

export interface TaskDriver {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence)
  await repair(apparatus)
  const scheduler = createScheduler(apparatus, options.seams)
  return {
    forCall: exec => {
      const caller = callerOf(exec.agent)
      const callId = String(exec.callId)
      return {
        propose: async input => {
          // A live agent is what a child session needs to exist under, and this is the first moment one
          // exists after a mount — so the re-scan the design calls for happens here. A plan committed
          // before a restart has ready children and no sessions, and nothing else would ever open them:
          // `decompose` is over, and `settled` only re-scans for a parent this process has seen.
          await scheduler.advance(exec.agent)
          return await propose(apparatus, caller, input)
        },
        decompose: input => decompose(apparatus, scheduler, caller, exec.agent, input),
        submit: async input => {
          const answer = await submitTo(apparatus, caller, callId, input)
          // A run just settled, so the plan it belongs to may have made its dependents ready — only a
          // verified run satisfies a dependency, and this is the only moment that can become true. A
          // child that fails to start is reported by the scan itself and does not become this call's
          // outcome: the run settled, and the model must read nothing else from this answer.
          await scheduler.settled()
          return answer
        },
        status: input => status(apparatus, caller, input),
      }
    },
    read: async () => snapshotOf(apparatus),
    close: async () => {
      // The children go first: each holds a session write lease this process took, and the store's own
      // close would leave those leases with no owner if the process outlived them.
      await scheduler.close()
      await apparatus.store.close()
    },
  }
}

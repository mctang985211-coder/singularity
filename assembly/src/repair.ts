/**
 * Repair: every run the last process left in flight, settled by the next boot. One with a verdict is
 * settled as it stands, one whose frozen bytes are still there is judged again, and one whose bytes are
 * gone — or whose declaration this deployment no longer carries — settles failed by a name. A per-run
 * reason never leaves here as a throw: a host that would not boot because one old attempt cannot be
 * repeated turns one task's debris into an outage.
 *
 * @module @dangosys/dsh-singularity-next/repair
 */

import { join } from 'node:path'

import { refuse } from '../../src/protocol/refusal.ts'
import type { BubbleInput } from '../../src/task/bubble.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { declareCaller, type Apparatus } from './apparatus.ts'
import { digestOnDisk, judgeAndRecord, workspaceOf } from './submission.ts'

export async function repair(apparatus: Apparatus): Promise<void> {
  for (const [taskId, state] of apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)) {
    for (const run of Object.values(state.runs)) {
      if (run.status !== 'running') continue
      const agentId = state.responsibility?.agentId
      // Unreachable by construction: `run/started` refuses an attempt nobody is answerable for.
      if (agentId === undefined) refuse('not-responsible', `task "${taskId}" holds the running run "${run.runId}" with no responsible agent; the log cannot produce that`)
      const key = declareCaller(apparatus, agentId)
      if (run.evidence.some(entry => entry.criterionId === apparatus.domain.criterion.criterionId)) {
        await apparatus.tasks.settle({ commandId: `settle:${taskId}/${run.runId}`, taskId, runId: run.runId }, key)
        continue
      }
      const frozen = run.bubble?.inputs[0]
      const workspace = workspaceOf(apparatus, taskId)
      const failure = await unfrozen(apparatus, workspace, run.runId, frozen)
      if (failure !== undefined) {
        await apparatus.tasks.forAgent(agentId).failRun({ commandId: `fail:${taskId}/${run.runId}`, taskId, runId: run.runId, reason: failure })
        continue
      }
      await judgeAndRecord(apparatus, taskId, run.runId, workspace, frozen!)
      await apparatus.tasks.settle({ commandId: `settle:${taskId}/${run.runId}`, taskId, runId: run.runId }, key)
    }
  }
}
export async function unfrozen(apparatus: Apparatus, workspace: string, runId: string, declared: BubbleInput | undefined): Promise<string | undefined> {
  const { domain } = apparatus
  const expected = domain.inputs[0]
  if (declared === undefined) return `run "${runId}" declares no frozen input, so there is nothing for a judgement to be bound to`
  if (expected === undefined || declared.name !== expected.path)
    return `run "${runId}" was frozen against the input "${declared.name}", which this deployment no longer declares (it declares "${expected?.path ?? 'none'}"), so the judgement it was frozen for cannot be repeated`
  if ((await digestOnDisk(join(workspace, domain.artifact))) === undefined) return `the artifact of run "${runId}" is gone from ${workspace}, so the judgement it was frozen for cannot be repeated`
  const digest = await digestOnDisk(join(workspace, expected.path))
  if (digest === undefined) return `the input "${expected.path}" of run "${runId}" cannot be read from ${workspace}, so the bytes it declared cannot be read`
  if (digest !== declared.digest)
    return `the input "${expected.path}" of run "${runId}" no longer hashes to the digest the run declared (declared ${declared.digest.slice(0, 12)}…, found ${digest.slice(0, 12)}…), so the judgement it was frozen for cannot be repeated`
  return undefined
}

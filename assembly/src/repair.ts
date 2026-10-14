import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { assertPinnedRevision } from '../../src/environment/binding.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { declareCaller } from './apparatus.ts'
import { sealedBytes } from './sealed.ts'
import { sha256 } from './ids.ts'

export async function repair(
  apparatus: Apparatus,
  restoreJudgement: (taskId: string, run: RunState) => Promise<boolean>,
  sessionId?: string,
): Promise<void> {
  const cut = apparatus.store.load()
  for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
    if (sessionId !== undefined && task.responsibility?.agentId !== sessionId) continue
    const agentId = task.responsibility!.agentId
    declareCaller(apparatus, agentId)
    for (const run of Object.values(task.runs)) {
      if (run.status !== 'running') continue
      assertPinnedRevision(
        run.revision,
        cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION),
        'resume Run',
      )
      if (run.bubble === undefined) {
        await apparatus.tasks
          .forAgent(agentId)
          .failRun({
            commandId: `recover-unprepared:${task.taskId}/${run.runId}`,
            taskId: task.taskId,
            runId: run.runId,
            reason: 'execution preparation did not commit a snapshot',
          })
        continue
      }
      for (const input of run.bubble.inputs) {
        const bytes = await sealedBytes(apparatus, input.attachment!)
        if (sha256(bytes) !== input.digest) throw new Error('frozen input changed')
      }
      if (run.stage === 'submitted') {
        await sealedBytes(apparatus, run.submission!.files.artifact)
        if (await restoreJudgement(task.taskId, run))
          await apparatus.tasks.settle(
            { commandId: `settle:${task.taskId}/${run.runId}`, taskId: task.taskId, runId: run.runId },
            `agent:${agentId}`,
          )
      } else {
        for (const input of run.bubble.inputs)
          if (sha256(await readFile(join(run.bubble.workspace.ref, input.name))) !== input.digest)
            throw new Error('working input changed')
      }
    }
  }
}

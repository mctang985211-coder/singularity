import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { declareCaller, type Apparatus } from './apparatus.ts'
import { workspaceOf } from './attempt.ts'
import { sha256 } from './ids.ts'
import { judgeAndRecord } from './submission.ts'

export async function repair(apparatus: Apparatus): Promise<void> {
  for (const [taskId, state] of apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)) {
    for (const run of Object.values(state.runs)) {
      if (run.status !== 'running') continue
      const agentId = state.responsibility!.agentId
      const key = declareCaller(apparatus, agentId)
      const commands = apparatus.tasks.forAgent(agentId)
      const submission = run.submission
      if (submission?.executionFailure !== undefined) {
        await commands.failRun({ commandId: 'execution-failed:' + submission.requestId, taskId, runId: run.runId, reason: submission.executionFailure })
        continue
      }
      let failure: string | undefined
      if (run.stage === 'working') {
        if (run.bubble !== undefined) continue
        failure = 'incomplete-preparation: the Run started without a committed execution bubble'
      } else if (run.stage === 'submitting') {
        failure = 'interrupted-submission: execution did not reach its frozen submission; do not execute it again'
      } else {
        failure = await sealedFailure(apparatus, state, run)
      }
      if (failure !== undefined) {
        await commands.failRun({ commandId: 'repair-failed:' + taskId + '/' + run.runId, taskId, runId: run.runId, reason: failure })
        continue
      }
      if (run.evidence.length === 0) await judgeAndRecord(apparatus, taskId, run)
      await apparatus.tasks.settle({ commandId: 'settle:' + taskId + '/' + run.runId, taskId, runId: run.runId }, key)
    }
  }
}

async function sealedFailure(apparatus: Apparatus, state: TaskState, run: RunState): Promise<string | undefined> {
  const submission = run.submission!
  const { domain } = apparatus
  const workspace = workspaceOf(apparatus, state.taskId, run.runId)
  const expected: readonly { readonly name: string; readonly digest: string }[] = [
    { name: domain.file, digest: submission.programDigest },
    { name: domain.artifact, digest: submission.artifactDigest },
    ...submission.inputDigests,
  ]
  for (const input of submission.inputDigests)
    if (!domain.inputs.some(declared => declared.path === input.name && declared.digest === input.digest))
      return 'unrecoverable-submission: the deployment no longer declares the frozen input ' + input.name
  for (const file of expected) {
    let found: string
    try { found = sha256(await readFile(join(workspace, file.name))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return 'unrecoverable-submission: frozen file is missing: ' + file.name
    }
    if (found !== file.digest) return 'unrecoverable-submission: frozen file digest changed: ' + file.name
  }
  const criterion = state.contract!.criteria[0]!
  if (criterion.verifierRef !== domain.verifier.ref || criterion.verifierVersion !== domain.verifier.version ||
    criterion.implementationDigest !== sha256(await readFile(domain.verifier.program)))
    return 'unrecoverable-verifier: the original verifier implementation is no longer deployed'
  return undefined
}

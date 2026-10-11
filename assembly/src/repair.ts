import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRefusal } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { declareCaller, type Apparatus } from './apparatus.ts'
import { workspaceOf } from './attempt.ts'
import { sha256 } from './ids.ts'
import { assertTemplateContract } from './inputs.ts'
import { list, record, text } from './shape.ts'
import { judgeAndRecord } from './submission.ts'
import type { TaskTemplate } from './template.ts'

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
      if (run.stage === 'working' && run.bubble === undefined)
        failure = 'incomplete-preparation: the Run started without a committed execution bubble'
      else if (run.stage === 'submitting')
        failure = 'interrupted-submission: execution did not reach its frozen submission; do not execute it again'
      else failure = await frozenFailure(apparatus, state, run)
      if (failure !== undefined) {
        await commands.failRun({ commandId: 'repair-failed:' + taskId + '/' + run.runId, taskId, runId: run.runId, reason: failure })
        continue
      }
      if (run.stage === 'working') continue
      if (run.evidence.length === 0) await judgeAndRecord(apparatus, taskId, run)
      await apparatus.tasks.settle({ commandId: 'settle:' + taskId + '/' + run.runId, taskId, runId: run.runId }, key)
    }
  }
}

async function frozenFailure(apparatus: Apparatus, state: TaskState, run: RunState): Promise<string | undefined> {
  const contract = state.contract!
  const declaredInput = contract.inputs[0]
  if (declaredInput?.source.kind === 'protected') {
    const declared = declaredInput.source
    if (!apparatus.domain.inputs.some(input => input.ref === declared.ref && input.digest === declared.digest))
      return 'unrecoverable-submission: the deployment no longer declares the frozen input ' + declaredInput.name
  }
  let template: TaskTemplate
  try { template = assertTemplateContract(apparatus.domain, contract) } catch (error) {
    if (!(error instanceof ProtocolRefusal)) throw error
    return 'unrecoverable-template: ' + error.refusal.detail
  }
  let implementationDigest: string
  try { implementationDigest = sha256(await readFile(template.verifier.program)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return 'unrecoverable-verifier: the original verifier implementation is missing'
  }
  if (implementationDigest !== template.verifier.implementationDigest)
    return 'unrecoverable-verifier: the original verifier implementation is no longer deployed'
  const cut = apparatus.store.load()
  const revision = cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)?.revisions[run.revision.revisionId]
  if (revision?.contentDigest !== run.revision.digest)
    return 'unrecoverable-revision: the Run revision is missing or has a different content identity'
  try {
    const manifest = record(revision.manifest, 'Run revision')
    assertClosedKeys(manifest, ['task', 'taskTemplate', 'inputSources'], 'Run revision', 'malformed-declaration')
    if (manifest['task'] !== state.taskId || digestOf(manifest['taskTemplate']) !== digestOf(contract.template))
      return 'unrecoverable-revision: the revision belongs to a different Task or template'
    const sources = list(manifest['inputSources'], 'Run revision.inputSources')
    const frozen = run.bubble!.inputs[0]!
    if (sources.length !== 1) return 'unrecoverable-revision: the revision must bind this template input once'
    const input = record(sources[0], 'Run revision.inputSources[0]')
    assertClosedKeys(input, ['name', 'digest', 'source'], 'Run revision input', 'malformed-declaration')
    if (input['name'] !== frozen.name || input['digest'] !== frozen.digest)
      return 'unrecoverable-revision: the revision input differs from the Run bubble'
    const source = record(input['source'], 'Run revision input source')
    const declared = contract.inputs[0]!.source
    if (declared.kind === 'protected') {
      if (digestOf(source) !== digestOf(declared))
        return 'unrecoverable-revision: the protected source differs from the admitted Task input'
    } else {
      assertClosedKeys(source, ['kind', 'taskId', 'runId'], 'Run revision artifact source', 'malformed-declaration')
      if (source['kind'] !== 'artifact' || source['taskId'] !== declared.taskId || template.input.source.kind !== 'artifact')
        return 'unrecoverable-revision: the artifact source differs from the admitted Task input'
      const producer = cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, declared.taskId)
      const producerRun = producer?.runs[text(source, 'runId', 'Run revision artifact source')]
      if (producer?.contract?.template.id !== template.input.source.template || producerRun?.status !== 'verified' ||
        producerRun.submission?.artifactDigest !== frozen.digest)
        return 'unrecoverable-revision: the artifact source is not the exact verified sealed producer Run'
    }
  } catch (error) {
    if (!(error instanceof ProtocolRefusal)) throw error
    return 'unrecoverable-revision: ' + error.refusal.detail
  }
  const workspace = workspaceOf(apparatus, state.taskId, run.runId)
  if (run.bubble!.workspace.kind !== 'dir' || run.bubble!.workspace.ref !== workspace)
    return 'unrecoverable-revision: the bubble names a different Run workspace'
  const expected = [...run.bubble!.inputs, ...(run.submission === undefined ? [] : [
    { name: template.file, digest: run.submission.programDigest },
    { name: template.artifact, digest: run.submission.artifactDigest },
  ])]
  for (const file of expected) {
    let found: string
    try { found = sha256(await readFile(join(workspace, file.name))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return 'unrecoverable-submission: frozen file is missing: ' + file.name
    }
    if (found !== file.digest) return 'unrecoverable-submission: frozen file digest changed: ' + file.name
  }
  return undefined
}

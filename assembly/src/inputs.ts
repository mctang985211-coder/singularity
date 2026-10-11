import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { refuse } from '../../src/protocol/refusal.ts'
import { contractDigest, type TaskContract, type TaskInputSource } from '../../src/task/contract.ts'
import type { Apparatus } from './apparatus.ts'
import { taskStateOf } from './apparatus.ts'
import { templateOf, type Domain } from './domain.ts'
import { sha256 } from './ids.ts'
import type { TaskTemplate } from './template.ts'

export interface PreparedInput {
  readonly name: string
  readonly digest: string
  readonly source: Extract<TaskInputSource, { kind: 'protected' }> | { readonly kind: 'artifact'; readonly taskId: string; readonly runId: string }
  readonly bytes: Uint8Array
}

export function contractFor(domain: Domain, template: TaskTemplate, goal: string, producerTaskId?: string): TaskContract {
  const declared = template.input.source
  let source: TaskInputSource
  if (declared.kind === 'protected') {
    const input = domain.inputs.find(input => input.ref === declared.ref)!
    source = { kind: 'protected', ref: input.ref, digest: input.digest }
  } else {
    if (producerTaskId === undefined) refuse('malformed-declaration', 'the artifact input requires one matching producer Task')
    source = { kind: 'artifact', taskId: producerTaskId }
  }
  return { template: { id: template.id, digest: template.digest }, goal,
    inputs: [{ name: template.input.name, source }], criteria: [template.criterion] }
}

export function assertTemplateContract(domain: Domain, contract: TaskContract): TaskTemplate {
  const template = templateOf(domain, contract.template)
  const input = contract.inputs[0]
  if (input === undefined || input.source.kind !== template.input.source.kind)
    refuse('evidence-input-mismatch', 'the Task input does not match its frozen template')
  const expected = contractFor(domain, template, contract.goal, input.source.kind === 'artifact' ? input.source.taskId : undefined)
  if (contractDigest(contract) !== contractDigest(expected))
    refuse('evidence-input-mismatch', 'the Task input or criterion does not match its frozen template')
  return template
}

export async function resolveInputs(apparatus: Apparatus, contract: TaskContract): Promise<readonly PreparedInput[]> {
  const consumer = assertTemplateContract(apparatus.domain, contract)
  return await Promise.all(contract.inputs.map(async input => {
    const source = input.source
    if (source.kind === 'protected') {
      const protectedInput = apparatus.domain.inputs.find(input => input.ref === source.ref)
      if (protectedInput?.digest !== source.digest)
        refuse('evidence-input-mismatch', 'the deployment no longer declares the frozen input ' + input.name)
      return { name: input.name, digest: protectedInput.digest, bytes: protectedInput.bytes, source }
    }
    const producer = taskStateOf(apparatus, source.taskId)
    if (consumer.input.source.kind !== 'artifact' || producer.contract!.template.id !== consumer.input.source.template)
      refuse('evidence-input-mismatch', 'the producer Task does not match the input template: ' + source.taskId)
    const run = Object.values(producer.runs).findLast(run => run.status === 'verified')
    if (run?.submission === undefined) refuse('illegal-transition', 'the producer Task has no verified sealed artifact: ' + source.taskId)
    const template = templateOf(apparatus.domain, producer.contract!.template)
    const path = join(apparatus.workspaceRoot, 'tasks', source.taskId, 'runs', run.runId, template.artifact)
    let bytes: Uint8Array
    try { bytes = await readFile(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      refuse('evidence-input-mismatch', 'the producer artifact is missing: ' + source.taskId)
    }
    const digest = sha256(bytes)
    if (digest !== run.submission.artifactDigest) refuse('evidence-input-mismatch', 'the producer artifact changed: ' + source.taskId)
    return { name: input.name, digest, bytes, source: { kind: 'artifact' as const, taskId: source.taskId, runId: run.runId } }
  }))
}

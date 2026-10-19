import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { type TaskContract, type TaskInputSource } from '../../src/task/contract.ts'
import type { Apparatus } from './apparatus.ts'
import { taskStateOf } from './apparatus.ts'
import { templateOf, type Domain } from './domain.ts'
import { sealedBytes } from './sealed.ts'
import type { TaskTemplate } from './template.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'

interface ReviewFiles {
  readonly artifact?: FileAttachmentRef
  readonly inputs?: readonly { name: string; attachment: FileAttachmentRef }[]
}
export function reviewInputsOf(review: ReviewRun, files: ReviewFiles) {
  return [
    { name: 'subject.json', attachment: review.subject },
    ...(files.artifact === undefined ? [] : [{ name: 'submitted-artifact', attachment: files.artifact }]),
    ...(files.inputs ?? []).map(({ name, attachment }) => ({ name: `inputs/${name}`, attachment })),
  ].map(({ name, attachment }) => ({ name, attachment, source: {
    kind: 'protected' as const, ref: `${review.reviewId}:${name}`, digest: attachment.attachmentId.slice(7),
  } }))
}

export interface PreparedInput {
  readonly name: string
  readonly digest: string
  readonly source:
    | Extract<TaskInputSource, { kind: 'protected' }> | { readonly kind: 'artifact'; readonly taskId: string; readonly runId: string }
  read(): Promise<Uint8Array>
}

export function contractFor(domain: Domain, template: TaskTemplate, goal: string, producers: ReadonlyMap<string, string> = new Map(),
): TaskContract {
  const inputs = template.inputs.map(({ name, source: declared }) => {
    let source: TaskInputSource
    if (declared.kind === 'protected') {
      const input = domain.inputs.find((input) => input.ref === declared.ref)!
      source = { kind: 'protected', ref: input.ref, digest: input.digest }
    } else {
      const taskId = producers.get(declared.template)
      if (taskId === undefined) refuse('malformed-declaration', `the artifact input requires one matching producer Task for template ${declared.template}`)
      source = { kind: 'artifact', taskId }
    }
    return { name, source }
  })
  return { template: { id: template.id, digest: template.digest }, goal,
    artifact: template.artifact, inputs, criteria: template.criteria,
    skills: template.skills, capabilities: template.capabilities,
  }
}

export function assertTemplateContract(domain: Domain, contract: TaskContract): TaskTemplate | undefined {
  const template = contract.template === undefined ? undefined : templateOf(domain, contract.template)
  if (template !== undefined) {
    if (
      contract.artifact !== template.artifact ||
      template.criteria.some(standard => !contract.criteria.some(criterion => digestOf(criterion) === digestOf(standard))) ||
      contract.inputs.length !== template.inputs.length
    )
      refuse('evidence-input-mismatch', 'contract differs from its pinned template')
    for (const input of contract.inputs) {
      const source = input.source, expected = template.inputs.find(entry => entry.name === input.name)?.source
      if (
        expected === undefined || source.kind !== expected.kind ||
        (source.kind === 'protected' && expected.kind === 'protected' &&
          (source.ref !== expected.ref || source.digest !== domain.inputs.find(entry => entry.ref === expected.ref)!.digest))
      ) refuse('evidence-input-mismatch', 'contract source differs from its pinned template')
    }
  }
  return template
}

export async function protectedInputsOf(apparatus: Apparatus, scopeId: string, domain: Domain) {
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const reviews = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()]
  let ancestor = scopeId, review: ReviewRun | undefined
  while (true) {
    review = reviews.find((r) => r.reviewId === ancestor || r.children.some((c) => c.taskId === ancestor))
    if (review !== undefined) break
    const parent = [...tasks.values()].find((t) => t.decomposition?.children.some((c) => c.taskId === ancestor))
    if (parent === undefined) break
    ancestor = parent.taskId
  }
  const frozen = review === undefined ? [] : reviewInputsOf(review,
    JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as ReviewFiles)
  return [
    ...domain.inputs.map(({ ref, digest, bytes }) => ({ ref, digest, read: async () => bytes })),
    ...frozen.map(({ source, attachment }) => ({ ...source, read: () => sealedBytes(apparatus, attachment) })),
  ]
}

export function assertProtectedInputs(contract: TaskContract, available: readonly { ref: string; digest: string }[]): void {
  for (const { name, source } of contract.inputs) {
    if (source.kind === 'protected' && !available.some(input => input.ref === source.ref && input.digest === source.digest))
      refuse('evidence-input-mismatch', `input ${name} references an unavailable protected ref/digest (${source.ref}); copy a source from the current contract/template or Review evidenceInputs. Available: ${JSON.stringify(available.map(({ ref, digest }) => ({ ref, digest })))}`)
  }
}

export async function resolveInputs(apparatus: Apparatus, taskId: string, contract: TaskContract, domain: Domain,
): Promise<readonly PreparedInput[]> {
  const template = assertTemplateContract(domain, contract)
  if (template !== undefined) for (const input of contract.inputs) {
    const expected = template.inputs.find(entry => entry.name === input.name)!.source
    if (input.source.kind === 'artifact' && expected.kind === 'artifact' &&
      taskStateOf(apparatus, input.source.taskId).contract!.template?.id !== expected.template)
      refuse('evidence-input-mismatch', 'contract producer differs from its pinned template')
  }
  const available = await protectedInputsOf(apparatus, taskId, domain)
  assertProtectedInputs(contract, available)
  return contract.inputs.map((input) => {
    const source = input.source
    if (source.kind === 'protected') {
      const protectedInput = available.find((input) => input.ref === source.ref)!
      return { name: input.name, digest: protectedInput.digest, read: protectedInput.read, source }
    }
    const producer = taskStateOf(apparatus, source.taskId)
    const run = Object.values(producer.runs).findLast((run) => run.status === 'verified')
    if (run?.submission === undefined) refuse('illegal-transition', 'the producer Task has no verified sealed artifact: ' + source.taskId)
    const digest = run.submission.artifactDigest
    const ref = run.submission.files.artifact
    return { name: input.name, digest, read: () => sealedBytes(apparatus, ref), source: { kind: 'artifact' as const, taskId: source.taskId, runId: run.runId },
    }
  })
}

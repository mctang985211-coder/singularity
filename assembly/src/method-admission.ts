import { assertPinnedRevision } from '../../src/environment/binding.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { publishedMethod } from './method.ts'
import { templateDeclaration } from './read.ts'
import { sha256 } from './ids.ts'

export function assertMethodAdmitted(apparatus: Apparatus, revision: RevisionRef): void {
  const cut = apparatus.store.load()
  const environments = cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION)
  const target = assertPinnedRevision(revision, environments, 'admit asset Revision')
  if (publishedMethod(apparatus)?.digest === revision.digest) return
  const seed = { rootTemplate: apparatus.domain.rootTemplate,
    templates: [...apparatus.domain.templates.values()].map(templateDeclaration), skills: [], tools: [] }
  if (digestOf(seed) === revision.digest) return
  for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
    for (const run of Object.values(task.runs)) {
      if (run.status !== 'verified') continue
      const execution = assertPinnedRevision(run.revision, environments, 'read asset review')
      const manifest = execution.manifest as { purpose: string; context?: { inputs: { digest: string; content: string }[] } }
      if (manifest.purpose !== 'review') continue
      const input = manifest.context!.inputs.find(input => input.digest === run.bubble!.inputs[0]!.digest)!
      const bytes = Buffer.from(input.content, 'base64')
      if (sha256(bytes) !== input.digest) refuse('digest-mismatch', 'asset review frozen subject bytes changed')
      const subject = JSON.parse(bytes.toString('utf8')) as { revision?: RevisionRef; assets?: unknown }
      if (digestOf(subject.revision ?? null) === digestOf(revision) && digestOf(subject.assets ?? null) === target.contentDigest) return
    }
  }
  refuse('unapproved-revision', 'this asset Revision has no passing independent review')
}

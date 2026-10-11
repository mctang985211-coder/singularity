import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { DomainVerifier } from './domain.ts'
import { sha256 } from './ids.ts'
import { inside, nonEmpty, readBytes, record, text } from './shape.ts'
import { requireVerifier } from './verifiers.ts'

export interface TaskTemplate {
  readonly id: string
  readonly digest: string
  readonly goal: string
  readonly input: {
    readonly name: string
    readonly source: { readonly kind: 'protected'; readonly ref: string } | { readonly kind: 'artifact'; readonly template: string }
  }
  readonly submission: 'program' | 'source'
  readonly file: string
  readonly artifact: string
  readonly criterion: AcceptanceCriterion
  readonly verifier: DomainVerifier
  readonly initial?: { readonly bytes: Uint8Array }
}

export async function readTemplate(dir: string, raw: unknown, verifiers: readonly DomainVerifier[], at: string): Promise<TaskTemplate> {
  const declared = record(raw, at)
  assertClosedKeys(declared, ['id', 'goal', 'input', 'workspace', 'criterion'], at, 'malformed-declaration')
  const input = record(declared['input'], `${at}.input`)
  assertClosedKeys(input, ['name', 'source'], `${at}.input`, 'malformed-declaration')
  const name = text(input, 'name', `${at}.input`)
  const inputPath = inside(dir, name, `${at}.input.name`)
  const rawSource = record(input['source'], `${at}.input.source`)
  const kind = text(rawSource, 'kind', `${at}.input.source`)
  if (kind !== 'protected' && kind !== 'artifact') refuse('malformed-declaration', `${at}.input.source.kind must be protected or artifact`)
  assertClosedKeys(rawSource, kind === 'protected' ? ['kind', 'ref'] : ['kind', 'template'], `${at}.input.source`, 'malformed-declaration')
  const source: TaskTemplate['input']['source'] = kind === 'protected'
    ? { kind, ref: text(rawSource, 'ref', `${at}.input.source`) }
    : { kind, template: text(rawSource, 'template', `${at}.input.source`) }
  const workspace = record(declared['workspace'], `${at}.workspace`)
  assertClosedKeys(workspace, ['submission', 'file', 'artifact', 'initial'], `${at}.workspace`, 'malformed-declaration')
  const submission = text(workspace, 'submission', `${at}.workspace`)
  if (submission !== 'program' && submission !== 'source') refuse('malformed-declaration', `${at}.workspace.submission is ${JSON.stringify(submission)}; expected program or source`)
  const file = text(workspace, 'file', `${at}.workspace`)
  const artifact = text(workspace, 'artifact', `${at}.workspace`)
  const filePath = inside(dir, file, `${at}.workspace.file`)
  const artifactPath = inside(dir, artifact, `${at}.workspace.artifact`)
  if (filePath === inputPath || artifactPath === inputPath) refuse('malformed-declaration', `${at} would overwrite its protected Run input`)
  if (submission === 'program' && filePath === artifactPath) refuse('malformed-declaration', `${at} program output would overwrite its submitted source`)
  if (submission === 'source' && file !== artifact) refuse('malformed-declaration', `${at} source is judged as written; file and artifact must be the same path`)
  if (submission === 'program' && workspace['initial'] !== undefined) refuse('malformed-declaration', `${at} program cannot declare an initial source as a second writer`)
  const initial = workspace['initial'] === undefined ? undefined : {
    bytes: await readBytes(inside(dir, nonEmpty(workspace['initial'], `${at}.workspace.initial`), `${at}.workspace.initial`), 'the initial source'),
  }
  const criterion = record(declared['criterion'], `${at}.criterion`)
  assertClosedKeys(criterion, ['criterionId', 'statement', 'verifier'], `${at}.criterion`, 'malformed-declaration')
  const verifier = requireVerifier(verifiers, text(criterion, 'verifier', `${at}.criterion`), `${at}.criterion`)
  return {
    id: text(declared, 'id', at),
    digest: digestOf({ template: declared, verifier: { ref: verifier.ref, version: verifier.version,
      implementationDigest: verifier.implementationDigest, args: verifier.args }, ...(initial === undefined ? {} : { initialDigest: sha256(initial.bytes) }) }),
    goal: text(declared, 'goal', at), input: { name, source }, submission, file, artifact, verifier,
    criterion: { criterionId: text(criterion, 'criterionId', `${at}.criterion`), statement: text(criterion, 'statement', `${at}.criterion`),
      verifierRef: verifier.ref, verifierVersion: verifier.version, implementationDigest: verifier.implementationDigest },
    ...(initial === undefined ? {} : { initial }),
  }
}

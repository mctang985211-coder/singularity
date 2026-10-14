import type { AcceptanceCriterion, VerifierCriterion } from '../../src/task/contract.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { DomainVerifier } from './domain.ts'
import { sha256 } from './ids.ts'
import { list, inside, nonEmpty, readBytes, record, text } from './shape.ts'
import { requireVerifier } from './verifiers.ts'

export interface TemplateChild {
  readonly key: string
  readonly template: string
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
}

export interface TaskTemplate {
  readonly id: string
  readonly digest: string
  readonly goal: string
  readonly applicability?: string
  readonly decomposition?: { readonly children: readonly TemplateChild[] }
  readonly skills: readonly string[]
  readonly capabilities: readonly string[]
  readonly input: {
    readonly name: string
    readonly source: { readonly kind: 'protected'; readonly ref: string } | { readonly kind: 'artifact'; readonly template: string }
  }
  readonly artifact: string
  readonly criterion: AcceptanceCriterion
  readonly verifier?: DomainVerifier
  readonly check?: VerifierCriterion
  readonly initial?: { readonly bytes: Uint8Array }
}

export async function readTemplate(dir: string, raw: unknown, verifiers: readonly DomainVerifier[], at: string,
): Promise<TaskTemplate> {
  const declared = record(raw, at)
  assertClosedKeys(declared, ['id', 'goal', 'applicability', 'decomposition', 'input', 'workspace', 'criterion', 'skills', 'capabilities'], at, 'malformed-declaration',
  )
  let decomposition: TaskTemplate['decomposition']
  if (declared['decomposition'] !== undefined) {
    const plan = record(declared['decomposition'], `${at}.decomposition`)
    assertClosedKeys(plan, ['children'], `${at}.decomposition`, 'malformed-declaration')
    decomposition = { children: list(plan['children'], `${at}.decomposition.children`).map((raw, index) => {
      const where = `${at}.decomposition.children[${index}]`
      const child = record(raw, where)
      assertClosedKeys(child, ['key', 'template', 'dependsOn', 'supports', 'maxRuns'], where, 'malformed-declaration')
      const maxRuns = child['maxRuns']
      if (typeof maxRuns !== 'number' || !Number.isSafeInteger(maxRuns) || maxRuns < 1)
        refuse('malformed-declaration', `${where}.maxRuns must be a positive safe integer`)
      return { key: text(child, 'key', where), template: text(child, 'template', where), maxRuns,
        dependsOn: list(child['dependsOn'], `${where}.dependsOn`).map((value) =>
            nonEmpty(value, `${where}.dependsOn`),
          ),
        supports: list(child['supports'], `${where}.supports`).map((value) => nonEmpty(value, `${where}.supports`)),
        }
      }),
    }
  }
  const input = record(declared['input'], `${at}.input`)
  assertClosedKeys(input, ['name', 'source'], `${at}.input`, 'malformed-declaration')
  const name = text(input, 'name', `${at}.input`)
  const inputPath = inside(dir, name, `${at}.input.name`)
  const rawSource = record(input['source'], `${at}.input.source`)
  const kind = text(rawSource, 'kind', `${at}.input.source`)
  if (kind !== 'protected' && kind !== 'artifact') refuse('malformed-declaration', `${at}.input.source.kind must be protected or artifact`)
  assertClosedKeys(rawSource, kind === 'protected' ? ['kind', 'ref'] : ['kind', 'template'], `${at}.input.source`, 'malformed-declaration',
  )
  const source: TaskTemplate['input']['source'] = kind === 'protected'
    ? { kind, ref: text(rawSource, 'ref', `${at}.input.source`) }
    : { kind, template: text(rawSource, 'template', `${at}.input.source`) }
  const workspace = record(declared['workspace'], `${at}.workspace`)
  assertClosedKeys(workspace, ['artifact', 'initial', 'initialContent'], `${at}.workspace`, 'malformed-declaration')
  const artifact = text(workspace, 'artifact', `${at}.workspace`)
  const artifactPath = inside(dir, artifact, `${at}.workspace.artifact`)
  if (artifactPath === inputPath) refuse('malformed-declaration', 'artifact would overwrite its input')
  if (workspace['initial'] !== undefined && workspace['initialContent'] !== undefined) refuse('malformed-declaration', 'initial source has two declarations')
  const initial = workspace['initialContent'] !== undefined ? { bytes: Buffer.from(nonEmpty(workspace['initialContent'], `${at}.workspace.initialContent`)) } : workspace['initial'] === undefined ? undefined : {
    bytes: await readBytes(inside(dir, nonEmpty(workspace['initial'], `${at}.workspace.initial`), `${at}.workspace.initial`), 'the initial source',
            ),
  }
  const criterion = record(declared['criterion'], `${at}.criterion`)
  assertClosedKeys(criterion, ['criterionId', 'statement', 'verifier'], `${at}.criterion`, 'malformed-declaration')
  const verifier =
    criterion['verifier'] === undefined
      ? undefined
      : requireVerifier(verifiers, text(criterion, 'verifier', `${at}.criterion`), `${at}.criterion`)
  const standard = {
    criterionId: text(criterion, 'criterionId', `${at}.criterion`),
    statement: text(criterion, 'statement', `${at}.criterion`),
  }
  return {
    id: text(declared, 'id', at),
    digest: digestOf({ template: {
        ...declared,
        skills: declared['skills'] ?? [],
        capabilities: declared['capabilities'] ?? [],
        workspace: { artifact, ...(initial === undefined ? {} : { initialDigest: sha256(initial.bytes) }) },
      },
      verifier:
        verifier === undefined
          ? null
          : { ref: verifier.ref, version: verifier.version,
      implementationDigest: verifier.implementationDigest, args: verifier.args,
            }, ...(initial === undefined ? {} : { initialDigest: sha256(initial.bytes) }),
    }),
    skills: declared['skills'] === undefined ? [] : list(declared['skills'], `${at}.skills`).map((value) => nonEmpty(value, `${at}.skills`)),
    capabilities: declared['capabilities'] === undefined ? [] : list(declared['capabilities'], `${at}.capabilities`).map((value) => nonEmpty(value, `${at}.capabilities`)),
    goal: text(declared, 'goal', at), input: { name, source },
    artifact,
    ...(verifier === undefined
      ? {}
      : {
          verifier,
          check: {
            ...standard,
            verifierRef: verifier.ref,
            verifierVersion: verifier.version,
            implementationDigest: verifier.implementationDigest,
          },
        }),
    ...(declared['applicability'] === undefined ? {} : { applicability: text(declared, 'applicability', at) }),
    ...(decomposition === undefined ? {} : { decomposition }),
    criterion: standard,
    ...(initial === undefined ? {} : { initial }),
  }
}

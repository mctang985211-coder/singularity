import { assertContract, type TaskContract, type VerifierCriterion } from '../../src/task/contract.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import type { DomainVerifier } from './domain.ts'
import { sha256 } from './ids.ts'
import { list, inside, record, text, readBytes } from './shape.ts'
import { requireVerifier } from './verifiers.ts'

export interface TemplateChild {
  readonly key: string
  readonly template: string
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
  readonly requirement: 'required' | 'exploration'
}

export interface TemplateInput {
  readonly name: string
  readonly source:
    { readonly kind: 'protected'; readonly ref: string } | { readonly kind: 'artifact'; readonly template: string }
}

export interface TemplateCheck {
  readonly criterion: VerifierCriterion
  readonly verifier: DomainVerifier
  readonly input: string
}

/** A prefilled task declaration; the host binds source identities before admission. */
export interface TaskTemplate extends Omit<TaskContract, 'template' | 'inputs' | 'skills' | 'capabilities'> {
  readonly id: string
  readonly digest: string
  readonly inputs: readonly TemplateInput[]
  readonly skills: readonly string[]
  readonly capabilities: readonly string[]
  readonly guidance?: string
  readonly applicability?: string
  readonly decomposition?: { readonly children: readonly TemplateChild[] }
  readonly checks: readonly TemplateCheck[]
  readonly initial?: { readonly bytes: Uint8Array }
}

export function templateDeclaration(template: TaskTemplate) {
  return {
    id: template.id,
    goal: template.goal,
    artifact: template.artifact,
    inputs: template.inputs,
    criteria: template.criteria,
    skills: template.skills,
    capabilities: template.capabilities,
    ...(template.guidance === undefined ? {} : { guidance: template.guidance }),
    ...(template.applicability === undefined ? {} : { applicability: template.applicability }),
    ...(template.decomposition === undefined ? {} : { decomposition: template.decomposition }),
    checks: template.checks.map(({ criterion, verifier, input }) => ({
      criterionId: criterion.criterionId,
      verifier: verifier.ref,
      input,
    })),
    ...(template.initial === undefined
      ? {}
      : { initial: { content: Buffer.from(template.initial.bytes).toString('utf8') } }),
  }
}

export async function readTemplate(
  dir: string,
  raw: unknown,
  verifiers: readonly DomainVerifier[],
  at: string,
): Promise<TaskTemplate> {
  const declared = record(raw, at)
  assertClosedKeys(
    declared,
    [
      'id',
      'goal',
      'artifact',
      'inputs',
      'criteria',
      'skills',
      'capabilities',
      'guidance',
      'applicability',
      'decomposition',
      'checks',
      'initial',
    ],
    at,
    'malformed-declaration',
  )
  const inputs: TemplateInput[] = list(declared['inputs'], `${at}.inputs`).map((raw, index) => {
    const where = `${at}.inputs[${index}]`
    const input = record(raw, where)
    assertClosedKeys(input, ['name', 'source'], where, 'malformed-declaration')
    const source = record(input['source'], `${where}.source`)
    const kind = text(source, 'kind', `${where}.source`)
    if (kind !== 'protected' && kind !== 'artifact')
      refuse('malformed-declaration', `${where}.source.kind must be protected or artifact`)
    assertClosedKeys(
      source,
      kind === 'protected' ? ['kind', 'ref'] : ['kind', 'template'],
      `${where}.source`,
      'malformed-declaration',
    )
    return {
      name: text(input, 'name', where),
      source:
        kind === 'protected'
          ? { kind, ref: text(source, 'ref', `${where}.source`) }
          : { kind, template: text(source, 'template', `${where}.source`) },
    }
  })
  // The core owns the common contract shape, including paths, asset names and standards.
  let contract: TaskContract
  try {
    contract = assertContract(
      {
        goal: declared['goal'],
        artifact: declared['artifact'],
        criteria: declared['criteria'],
        skills: declared['skills'] === undefined ? [] : declared['skills'],
        capabilities: declared['capabilities'] === undefined ? [] : declared['capabilities'],
        inputs: inputs.map(({ name, source }) => ({
          name,
          source:
            source.kind === 'protected'
              ? { ...source, digest: '0'.repeat(64) }
              : { kind: 'artifact', taskId: source.template },
        })),
      },
      at,
    )
  } catch (error) {
    if (error instanceof ProtocolRefusal) refuse('malformed-declaration', error.refusal.detail)
    throw error
  }
  const checks: TemplateCheck[] = []
  for (const [index, rawCheck] of list(
    declared['checks'] === undefined ? [] : declared['checks'],
    `${at}.checks`,
  ).entries()) {
    const where = `${at}.checks[${index}]`
    const check = record(rawCheck, where)
    assertClosedKeys(check, ['criterionId', 'verifier', 'input'], where, 'malformed-declaration')
    const criterionId = text(check, 'criterionId', where)
    const standard = contract.criteria.find(criterion => criterion.criterionId === criterionId)
    if (standard === undefined) refuse('malformed-declaration', `${where} names absent criterion ${criterionId}`)
    if (checks.some(check => check.criterion.criterionId === criterionId))
      refuse('malformed-declaration', `${at}.checks repeats criterion ${criterionId}`)
    const input = text(check, 'input', where)
    if (!inputs.some(entry => entry.name === input))
      refuse('malformed-declaration', `${where} names absent input ${input}`)
    const verifier = requireVerifier(verifiers, text(check, 'verifier', where), where)
    checks.push({
      input,
      verifier,
      criterion: {
        ...standard,
        verifierRef: verifier.ref,
        verifierVersion: verifier.version,
        implementationDigest: verifier.implementationDigest,
      },
    })
  }
  let initial: TaskTemplate['initial']
  if (declared['initial'] !== undefined) {
    const source = record(declared['initial'], `${at}.initial`)
    assertClosedKeys(source, ['from', 'content'], `${at}.initial`, 'malformed-declaration')
    if ((source['from'] === undefined) === (source['content'] === undefined))
      refuse('malformed-declaration', `${at}.initial must declare exactly one of from or content`)
    if (source['from'] !== undefined)
      initial = {
        bytes: await readBytes(
          inside(dir, text(source, 'from', `${at}.initial`), `${at}.initial.from`),
          'the initial source',
        ),
      }
    else {
      if (typeof source['content'] !== 'string')
        refuse('malformed-declaration', `${at}.initial.content must be literal file contents`)
      initial = { bytes: Buffer.from(source['content']) }
    }
  }
  let decomposition: TaskTemplate['decomposition']
  if (declared['decomposition'] !== undefined) {
    const plan = record(declared['decomposition'], `${at}.decomposition`)
    assertClosedKeys(plan, ['children'], `${at}.decomposition`, 'malformed-declaration')
    decomposition = {
      children: list(plan['children'], `${at}.decomposition.children`).map((raw, index) => {
        const where = `${at}.decomposition.children[${index}]`
        const child = record(raw, where)
        assertClosedKeys(
          child,
          ['key', 'template', 'dependsOn', 'supports', 'maxRuns', 'requirement'],
          where,
          'malformed-declaration',
        )
        const maxRuns = child['maxRuns']
        if (typeof maxRuns !== 'number' || !Number.isSafeInteger(maxRuns) || maxRuns < 1)
          refuse('malformed-declaration', `${where}.maxRuns must be a positive safe integer`)
        const names = (key: string) =>
          list(child[key], `${where}.${key}`).map(value => {
            if (typeof value !== 'string' || value.length === 0)
              refuse('malformed-declaration', `${where}.${key} must contain names`)
            return value
          })
        const requirement = child['requirement']
        if (requirement !== 'required' && requirement !== 'exploration')
          refuse('malformed-declaration', `${where}.requirement must be required or exploration`)
        return {
          key: text(child, 'key', where),
          template: text(child, 'template', where),
          maxRuns,
          requirement,
          dependsOn: names('dependsOn'),
          supports: names('supports'),
        }
      }),
    }
  }
  const declaration = {
    id: text(declared, 'id', at),
    goal: contract.goal,
    artifact: contract.artifact,
    inputs,
    criteria: contract.criteria,
    skills: contract.skills!,
    capabilities: contract.capabilities!,
    ...(declared['guidance'] === undefined ? {} : { guidance: text(declared, 'guidance', at) }),
    ...(declared['applicability'] === undefined ? {} : { applicability: text(declared, 'applicability', at) }),
    ...(decomposition === undefined ? {} : { decomposition }),
  }
  return {
    ...declaration,
    checks,
    digest: digestOf({
      ...declaration,
      checks: checks.map(({ criterion, verifier, input }) => ({ criterion, input, args: verifier.args })),
      ...(initial === undefined ? {} : { initialDigest: sha256(initial.bytes) }),
    }),
    ...(initial === undefined ? {} : { initial }),
  }
}

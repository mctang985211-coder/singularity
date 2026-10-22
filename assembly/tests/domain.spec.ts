import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runVerifierSelftest } from '../../src/verifier/implementation.ts'
import { asyncRefusalOf, refusalOf } from '../../tests/fixtures.ts'
import { loadDomain, templateOf } from '../src/domain.ts'
import { templateDeclaration } from '../src/template.ts'
import { spawnProcess } from '../src/process.ts'

const REAL = fileURLToPath(new URL('../../domain/reference', import.meta.url))
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function declaration() {
  return {
    rootTemplate: 'root',
    inputs: [{ ref: 'material', from: 'pass.txt' }],
    templates: [{ id: 'root', goal: 'count the protected material', artifact: 'report.txt',
      inputs: [{ name: 'in/source.txt', source: { kind: 'protected', ref: 'material' } }],
      criteria: [{ criterionId: 'counted', statement: 'the report is the count' }],
      skills: [], capabilities: [], checks: [{ criterionId: 'counted', verifier: 'count', input: 'in/source.txt' }],
    }],
    verifiers: [{ ref: 'count', version: '1', program: 'verifier.mjs', args: ['{artifact}', '{input}'],
      selftest: [{ name: 'correct', expected: 'pass', artifact: 'pass.txt', argv: ['pass.txt', 'pass.txt'] },
        { name: 'wrong', expected: 'fail', artifact: 'fail.txt', argv: ['fail.txt', 'pass.txt'] }],
    }],
  }
}
async function fixture(declared: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'assembly-domain-'))
  scratch.push(dir)
  await writeFile(join(dir, 'verifier.mjs'), 'process.exit(0)\n')
  await writeFile(join(dir, 'pass.txt'), 'abc')
  await writeFile(join(dir, 'fail.txt'), 'abcd')
  await writeFile(join(dir, 'seed.txt'), 'seed source')
  await writeFile(join(dir, 'task.json'), JSON.stringify(declared))
  return dir
}
const sourced = (id: string, source: object) => ({ ...declaration().templates[0]!, id,
  inputs: [{ name: 'in/source.txt', source }] })

describe('the deployment domain', () => {
  it('exposes only explicitly declared shared references and resolves domain-relative paths', async () => {
    const dir = await fixture(declaration())
    expect((await loadDomain(dir, spawnProcess)).references).toEqual([])
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...declaration(), references: ['.', 'seed.txt', '/usr/share'] }))
    expect((await loadDomain(dir, spawnProcess)).references).toEqual([dir, join(dir, 'seed.txt'), '/usr/share'])
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...declaration(), references: ['../outside'] }))
    expect(await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).toMatchObject({ code: 'malformed-declaration' })
  })

  it('keeps verifier-only references out of worker references and rejects shared overlap', async () => {
    const dir = await fixture(declaration()), privateDir = await fixture(declaration())
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...declaration(), verifierReferences: [privateDir] }))
    const domain = await loadDomain(dir, spawnProcess)
    expect(domain.references).toEqual([])
    expect(domain.verifierReferences).toEqual([privateDir])
    for (const changed of [{ verifierReferences: ['.'] }, { verifierReferences: [privateDir], references: [privateDir] },
      { verifierReferences: [privateDir], references: [join(privateDir, 'pass.txt')] },
      { verifierReferences: [join(privateDir, 'missing')] }, { verifierReferences: [42] }, { verifierReferences: ['../outside'] }]) {
      await writeFile(join(dir, 'task.json'), JSON.stringify({ ...declaration(), ...changed }))
      expect(await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).toMatchObject({ code: 'malformed-declaration' })
    }
  })

  it('reads the shared contract fields and binds independent checks to their declared inputs', async () => {
    const declared = declaration(), dir = await fixture(declared)
    const domain = await loadDomain(dir, spawnProcess), root = domain.templates.get(domain.rootTemplate!)!
    expect([domain.rootTemplate, root.goal, root.inputs, root.artifact, root.criteria]).toEqual([
      'root', declared.templates[0]!.goal, declared.templates[0]!.inputs, 'report.txt', declared.templates[0]!.criteria,
    ])
    expect([root.checks[0]!.criterion.verifierRef, root.checks[0]!.criterion.implementationDigest, domain.inputs[0]!.digest])
      .toEqual(['count', sha256(await readFile(join(dir, 'verifier.mjs'))), sha256('abc')])
    expect(root.checks[0]!.input).toBe('in/source.txt')
  })

  it('changes template identity only with its own declaration, verifier or initial content', async () => {
    const declared = declaration(), dir = await fixture(declared)
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    declared.templates.push({ ...declared.templates[0]!, id: 'unrelated', goal: 'another task' })
    await writeFile(join(dir, 'task.json'), JSON.stringify(declared))
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).toBe(first.digest)
    declared.templates[0]!.goal = 'changed goal'
    await writeFile(join(dir, 'task.json'), JSON.stringify(declared))
    const changed = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    expect(changed.digest).not.toBe(first.digest)
    await writeFile(join(dir, 'verifier.mjs'), 'process.exit(1)\n')
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).not.toBe(changed.digest)
  })

  it.each(['version', 'args'] as const)('changes identity when its verifier %s changes', async (field) => {
    const declared = declaration(), dir = await fixture(declared)
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    if (field === 'version') declared.verifiers[0]!.version = '2'
    else declared.verifiers[0]!.args = ['{input}', '{artifact}']
    await writeFile(join(dir, 'task.json'), JSON.stringify(declared))
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).not.toBe(first.digest)
  })

  it('freezes initial bytes and serializes a declaration with the same content identity', async () => {
    const declared = declaration()
    const dir = await fixture({ ...declared, templates: [{ ...declared.templates[0]!, initial: { from: 'seed.txt' } }] })
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    expect(new TextDecoder().decode(first.initial!.bytes)).toBe('seed source')
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...declared, templates: [templateDeclaration(first)] }))
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).toBe(first.digest)
    await writeFile(join(dir, 'task.json'), JSON.stringify({ ...declared, templates: [{ ...declared.templates[0]!, initial: { from: 'seed.txt' } }] }))
    await writeFile(join(dir, 'seed.txt'), 'new starting bytes')
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).not.toBe(first.digest)
  })

  it('accepts several protected and upstream inputs with separate standards and check bindings', async () => {
    const declared = declaration(), base = declared.templates[0]!
    const dir = await fixture({ ...declared, inputs: [...declared.inputs, { ref: 'other', from: 'fail.txt' }],
      templates: [base, { ...base, id: 'dependent', inputs: [
        { name: 'first.txt', source: { kind: 'artifact', template: 'root' } },
        { name: 'second.txt', source: { kind: 'protected', ref: 'other' } },
      ], criteria: [...base.criteria, { criterionId: 'another', statement: 'a second standard' }],
      checks: [{ criterionId: 'counted', verifier: 'count', input: 'first.txt' }, { criterionId: 'another', verifier: 'count', input: 'second.txt' }] }],
    })
    const dependent = (await loadDomain(dir, spawnProcess)).templates.get('dependent')!
    expect(dependent.inputs).toHaveLength(2)
    expect(dependent.checks.map(check => [check.criterion.criterionId, check.input])).toEqual([['counted', 'first.txt'], ['another', 'second.txt']])
  })

  it('resolves only the exact admitted template identity', async () => {
    const domain = await loadDomain(await fixture(declaration()), spawnProcess), root = domain.templates.get('root')!
    expect(templateOf(domain, { id: root.id, digest: root.digest })).toBe(root)
    for (const reference of [{ id: 'absent', digest: root.digest }, { id: root.id, digest: '0'.repeat(64) }])
      expect(refusalOf(() => templateOf(domain, reference))).toMatchObject({ code: 'malformed-declaration' })
  })

  it('canonicalizes JSON object order', async () => {
    const declared = declaration(), dir = await fixture(declared)
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    declared.templates[0] = Object.fromEntries(Object.entries(declared.templates[0]!).reverse()) as typeof declared.templates[number]
    await writeFile(join(dir, 'task.json'), JSON.stringify(declared, null, 2))
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).toBe(first.digest)
  })

  it.each(['template', 'input', 'source', 'criterion', 'check', 'verifier', 'sample'] as const)('refuses an undeclared %s member', async boundary => {
    const declared = declaration(), template = declared.templates[0]!
    const records = { template, input: template.inputs[0]!, source: template.inputs[0]!.source, criterion: template.criteria[0]!,
      check: template.checks[0]!, verifier: declared.verifiers[0]!, sample: declared.verifiers[0]!.selftest[0]! }
    Object.assign(records[boundary], { invented: true })
    expect(await asyncRefusalOf(() => fixture(declared).then(dir => loadDomain(dir, spawnProcess))))
      .toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('invented') })
  })

  it.each([
    ['unknown root', { rootTemplate: 'missing' }],
    ['unknown protected source', { templates: [sourced('root', { kind: 'protected', ref: 'absent' })] }],
    ['unknown artifact source', { templates: [...declaration().templates, sourced('child', { kind: 'artifact', template: 'absent' })] }],
    ['artifact root', { templates: [sourced('root', { kind: 'artifact', template: 'root' })] }],
    ['template cycle', { templates: [...declaration().templates, sourced('a', { kind: 'artifact', template: 'b' }), sourced('b', { kind: 'artifact', template: 'a' })] }],
    ['duplicate template', { templates: [declaration().templates[0]!, declaration().templates[0]!] }],
    ['duplicate protected source', { inputs: [declaration().inputs[0]!, declaration().inputs[0]!] }],
    ['idle metric', { metric: {} }],
    ['old template fields', { templates: [{ ...declaration().templates[0]!, workspace: { artifact: 'report.txt' } }] }],
    ['escaping artifact', { templates: [{ ...declaration().templates[0]!, artifact: '../outside.txt' }] }],
    ['overlapping artifact', { templates: [{ ...declaration().templates[0]!, artifact: 'in/source.txt/nested' }] }],
    ['ambiguous initial', { templates: [{ ...declaration().templates[0]!, initial: { from: 'seed.txt', content: 'ambiguous' } }] }],
    ['absent initial', { templates: [{ ...declaration().templates[0]!, initial: {} }] }],
    ['unknown verifier', { templates: [{ ...declaration().templates[0]!, checks: [{ criterionId: 'counted', verifier: 'absent', input: 'in/source.txt' }] }] }],
    ['unknown checked standard', { templates: [{ ...declaration().templates[0]!, checks: [{ criterionId: 'absent', verifier: 'count', input: 'in/source.txt' }] }] }],
    ['unknown checked input', { templates: [{ ...declaration().templates[0]!, checks: [{ criterionId: 'counted', verifier: 'count', input: 'absent' }] }] }],
    ['duplicate check', { templates: [{ ...declaration().templates[0]!, checks: [...declaration().templates[0]!.checks, ...declaration().templates[0]!.checks] }] }],
    ['empty standards', { templates: [{ ...declaration().templates[0]!, criteria: [] }] }],
  ])('refuses %s before publishing a domain', async (_name, changed) => {
    expect(await asyncRefusalOf(() => fixture({ ...declaration(), ...changed }).then(dir => loadDomain(dir, spawnProcess))))
      .toMatchObject({ code: 'malformed-declaration' })
  })

  it('requires exactly one matching producer for every input in reusable decomposition', async () => {
    const declared = declaration(), root = declared.templates[0]!
    const recipe = { children: [{ key: 'dependent', template: 'dependent', dependsOn: [], supports: ['counted'], maxRuns: 1, requirement: 'required' as const }] }
    const changed = { ...declared, templates: [{ ...root, decomposition: recipe }, sourced('dependent', { kind: 'artifact', template: 'root' })] }
    expect(await asyncRefusalOf(() => fixture(changed).then(dir => loadDomain(dir, spawnProcess))))
      .toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('producer') })
  })

  it('refuses source paths outside the domain', async () => {
    const dir = await fixture({ ...declaration(), inputs: [{ ref: 'material', from: '../outside.txt' }] })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('outside')
  })

  it('refuses a sample whose artifact is not the command input', async () => {
    const declared = declaration()
    declared.verifiers[0]!.selftest[0]!.argv[0] = 'fail.txt'
    expect((await asyncRefusalOf(() => fixture(declared).then(dir => loadDomain(dir, spawnProcess)))).detail).toContain('correct')
  })

  it('refuses an unsupported command placeholder', async () => {
    const declared = declaration()
    declared.verifiers[0]!.args = ['{artifact}', '{artifactt}']
    expect((await asyncRefusalOf(() => fixture(declared).then(dir => loadDomain(dir, spawnProcess)))).detail).toContain('{artifactt}')
  })

  it.each(['letters', 'extract-letters'])('runs %s positive and negative samples through the independent verifier', async ref => {
    const domain = await loadDomain(REAL, spawnProcess)
    expect(await runVerifierSelftest(domain.verifiers.find(entry => entry.ref === ref)!)).toMatchObject({ ran: ref === 'letters' ? 2 : 5, failures: [] })
    expect(domain.templates.size).toBe(3)
  })

  it('counts only ASCII extractions with a decimal report and zero or one trailing LF', async () => {
    const domain = await loadDomain(REAL, spawnProcess)
    expect(await runVerifierSelftest(domain.templates.get('count-letters')!.checks[0]!.verifier)).toMatchObject({ ran: 8, failures: [] })
  })
})
